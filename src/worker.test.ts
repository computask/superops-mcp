/**
 * Tests for the Cloudflare Workers entrypoint.
 *
 * Drives the exported `fetch` handler directly with Web Standard Request objects
 * (available natively in Node 18+), exercising the same WebStandardStreamableHTTP
 * transport the Worker uses in production.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import worker, { gatewayOwnerHash, type Env } from "./worker.js";
import { chatGptDirectBlockedToolNames } from "./mcp-server.js";
import { MUTATING_TOOL_NAMES, READ_ONLY_TOOL_NAMES } from "./tool-catalogue.js";
import { getOperationStore, runWithOperationStore, stableHash, type OperationLedgerRecord } from "./operation-store.js";

const MCP_HEADERS = {
  Accept: "application/json, text/event-stream",
  "Content-Type": "application/json",
};

const DIRECT_HOST = "superops-mcp-chatgpt-direct.taskgroup.co.uk";
const INTERNAL_HOST = "superops-mcp-tg110626.taskgroup.co.uk";
const MCP_RESOURCE = `https://${DIRECT_HOST}/mcp`;
const AUTH_SERVER = `https://${DIRECT_HOST}`;
const ACCESS_ISSUER = "https://computask.cloudflareaccess.test";
const ACCESS_AUD = "test-access-aud";
const ALLOWED_EMAIL = "sam@computask.co.uk";
const ADDITIONAL_ALLOWED_EMAIL = "user-b@example.com";
const CHATGPT_REDIRECT_URI = "https://chatgpt.com/connector/oauth/callback";

type MemoryKvEntry = {
  value: string;
  expiresAt?: number;
};

type MemoryKvGetOptions = {
  type?: "text" | "json" | "arrayBuffer";
};

type MemoryKvPutOptions = {
  expiration?: number;
  expirationTtl?: number;
};

type MemoryKvListOptions = {
  prefix?: string;
  limit?: number;
  cursor?: string;
};

function createMemoryKv() {
  const store = new Map<string, MemoryKvEntry>();
  const now = () => Math.floor(Date.now() / 1000);

  function getLiveEntry(key: string): MemoryKvEntry | undefined {
    const entry = store.get(key);
    if (!entry) {
      return undefined;
    }

    if (entry.expiresAt !== undefined && entry.expiresAt <= now()) {
      store.delete(key);
      return undefined;
    }

    return entry;
  }

  return {
    async get(key: string, options?: MemoryKvGetOptions): Promise<unknown> {
      const entry = getLiveEntry(key);
      if (!entry) {
        return null;
      }

      if (options?.type === "json") {
        return JSON.parse(entry.value);
      }
      if (options?.type === "arrayBuffer") {
        return new TextEncoder().encode(entry.value).buffer;
      }
      return entry.value;
    },

    async put(
      key: string,
      value: string | ArrayBuffer,
      options?: MemoryKvPutOptions
    ): Promise<void> {
      const text =
        typeof value === "string"
          ? value
          : new TextDecoder().decode(new Uint8Array(value));

      const expiresAt =
        typeof options?.expiration === "number"
          ? options.expiration
          : typeof options?.expirationTtl === "number"
            ? now() + options.expirationTtl
            : undefined;

      store.set(key, { value: text, expiresAt });
    },

    async delete(key: string): Promise<void> {
      store.delete(key);
    },

    async list(options?: MemoryKvListOptions): Promise<{
      keys: { name: string }[];
      list_complete: boolean;
      cursor?: string;
    }> {
      for (const key of [...store.keys()]) {
        getLiveEntry(key);
      }

      const prefix = options?.prefix ?? "";
      const limit = options?.limit ?? 1000;
      const start = options?.cursor ? Number(options.cursor) : 0;
      const names = [...store.keys()]
        .filter((key) => key.startsWith(prefix))
        .sort();
      const page = names.slice(start, start + limit);
      const next = start + limit < names.length ? String(start + limit) : "";

      return {
        keys: page.map((name) => ({ name })),
        list_complete: !next,
        ...(next ? { cursor: next } : {}),
      };
    },
  };
}

function chatGptEnv(overrides: Partial<Env> = {}): Env {
  return {
    AUTH_MODE: "env",
    CHATGPT_MCP_HOST: DIRECT_HOST,
    CHATGPT_MCP_RESOURCE: MCP_RESOURCE,
    CHATGPT_OAUTH_SCOPES: "superops.read",
    CHATGPT_AUTH_ALLOWED_EMAIL: ALLOWED_EMAIL,
    CHATGPT_AUTH_ACCESS_ISSUER: ACCESS_ISSUER,
    CHATGPT_AUTH_ACCESS_AUD: ACCESS_AUD,
    CHATGPT_DIRECT_ALLOW_MUTATING_TOOLS: "false",
    CHATGPT_DIRECT_ALLOW_TRIAGE_PLAN: "false",
    CHATGPT_DIRECT_ALLOW_SCRIPT_EXECUTION: "false",
    OAUTH_KV: createMemoryKv(),
    ...overrides,
  };
}

let accessKeyPair: Awaited<ReturnType<typeof generateKeyPair>>;
let originalFetch: typeof globalThis.fetch;

async function mcp(
  body: unknown,
  env: Env = {},
  extraHeaders: Record<string, string> = {},
  url = "http://worker.local/mcp"
): Promise<Response> {
  return worker.fetch(
    new Request(url, {
      method: "POST",
      headers: { ...MCP_HEADERS, ...extraHeaders },
      body: JSON.stringify(body),
    }),
    env
  );
}

function auditRecords(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls
    .map(([line]) => {
      try {
        return JSON.parse(String(line)) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    })
    .filter(
      (record): record is Record<string, unknown> =>
        record?.event === "mcp.tool_call"
    );
}

function internalBudgetStopRecord(
  operationId: string,
  ownerHash: string
): OperationLedgerRecord {
  const ticketNumber = "59021";
  const target = {
    status: "Awaiting Engineer",
    impact: "High",
    urgency: "High",
    category: "3. Security Incident",
    subcategory: "Security alert",
    cause: "Security Event",
  };
  return {
    responseVersion: 1,
    operationId,
    toolName: "superops_tickets_apply_triage_plan",
    ownerHash,
    createdAt: "2026-07-26T09:49:07.577Z",
    updatedAt: "2026-07-26T09:49:16.249Z",
    expiresAt: "2999-07-27T00:00:00.000Z",
    originalRequestHash: stableHash({ operationId }),
    operationRequest: {
      kind: "applyTriagePlan",
      schemaVersion: 1,
      expectedCandidateTicketNumbers: [ticketNumber],
      actions: [{
        ticketNumber,
        expectedTicketId: "447747060408930304",
        expectedSubjectHash: stableHash("Huntress escalation"),
        expectedStatus: "New Calls",
        expectedUpdatedTime: "2026-07-26T01:33:27.195",
        contentVerified: true,
        action: "update",
        target,
      }],
      dryRun: false,
      verify: true,
      dedupeNotes: true,
      stopOnFirstFailure: false,
      allowResolveFullFallbackToUpdate: false,
      allowWriteIfUpdatedTimeChanged: false,
      allowWriteWithoutVerifiedContent: false,
    },
    state: "ContinuationRequired",
    expectedItems: [ticketNumber],
    currentItem: ticketNumber,
    completedItems: [],
    failedItems: [],
    skippedItems: [],
    unattemptedItems: [ticketNumber],
    pendingItems: [ticketNumber],
    itemStates: {
      [ticketNumber]: {
        itemKey: ticketNumber,
        stage: "Unattempted",
        idempotencyKey: stableHash({ operationId, ticketNumber }),
        mutationType: "update",
        canonicalTargetHash: stableHash({ action: "update", target, ticketNumber }),
        targetFields: target,
        writeAttempted: false,
        writeMayHaveSucceeded: false,
        partialWrite: false,
        verificationState: "NotRequired",
        retryCount: 0,
      },
    },
    summary: {},
    compactResults: [],
    partialWriteCount: 0,
    ambiguousWriteCount: 0,
    rateLimitedItems: [],
    continuationCount: 2,
    terminalFailureReason: "ContinuationRequiredBeforeItem",
  };
}


type ToolSafetyAnnotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

type PublishedTool = {
  name: string;
  description?: string;
  annotations?: ToolSafetyAnnotations;
};

const EXPECTED_READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const EXPECTED_MUTATING_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

const READ_ONLY_DESCRIPTION_PREFIX = "Read-only. Does not modify SuperOps data.";

function toolsByName(tools: PublishedTool[]): Map<string, PublishedTool> {
  return new Map(tools.map((tool) => [tool.name, tool]));
}

async function listPublishedTools(
  env: Env = {},
  extraHeaders: Record<string, string> = {},
  url = "http://worker.local/mcp"
): Promise<PublishedTool[]> {
  const res = await mcp(
    { jsonrpc: "2.0", id: 900, method: "tools/list", params: {} },
    env,
    extraHeaders,
    url
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result?: { tools?: PublishedTool[] } };
  return body.result?.tools ?? [];
}

async function cloudflareAccessJwt(email = ALLOWED_EMAIL): Promise<string> {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: "RS256", kid: "access-test-key" })
    .setIssuer(ACCESS_ISSUER)
    .setAudience(ACCESS_AUD)
    .setSubject(email)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(accessKeyPair.privateKey);
}

function base64Url(buffer: ArrayBuffer): string {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier)
  );
  return base64Url(digest);
}

async function registerChatGptClient(env: Env): Promise<string> {
  const res = await worker.fetch(
    new Request(`${AUTH_SERVER}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "ChatGPT",
        redirect_uris: [CHATGPT_REDIRECT_URI],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    }),
    env
  );

  expect(res.status).toBe(201);
  const body = (await res.json()) as {
    client_id?: string;
    client_secret?: string;
    token_endpoint_auth_method?: string;
  };
  expect(body.client_id).toBeTruthy();
  expect(body.client_secret).toBeUndefined();
  expect(body.token_endpoint_auth_method).toBe("none");
  return body.client_id!;
}

async function getOAuthAccessToken(
  env: Env,
  {
    clientId,
    email = ALLOWED_EMAIL,
  }: { clientId?: string; email?: string } = {}
): Promise<string> {
  const resolvedClientId = clientId ?? (await registerChatGptClient(env));
  const verifier = "test-verifier-abcdefghijklmnopqrstuvwxyz0123456789";
  const challenge = await pkceChallenge(verifier);

  const authorizeUrl = new URL(`${AUTH_SERVER}/authorize`);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", resolvedClientId);
  authorizeUrl.searchParams.set("redirect_uri", CHATGPT_REDIRECT_URI);
  authorizeUrl.searchParams.set("scope", "superops.read");
  authorizeUrl.searchParams.set("state", "test-state");
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("resource", MCP_RESOURCE);

  const authorizeRes = await worker.fetch(
    new Request(authorizeUrl, {
      headers: {
        "CF-Access-Jwt-Assertion": await cloudflareAccessJwt(email),
      },
      redirect: "manual",
    }),
    env
  );

  expect(authorizeRes.status).toBe(302);
  const location = authorizeRes.headers.get("Location");
  expect(location).toBeTruthy();

  const callbackUrl = new URL(location!);
  const code = callbackUrl.searchParams.get("code");
  expect(callbackUrl.searchParams.get("state")).toBe("test-state");
  expect(code).toBeTruthy();

  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: resolvedClientId,
    code: code!,
    redirect_uri: CHATGPT_REDIRECT_URI,
    code_verifier: verifier,
    resource: MCP_RESOURCE,
  });

  const tokenRes = await worker.fetch(
    new Request(`${AUTH_SERVER}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
    }),
    env
  );

  expect(tokenRes.status).toBe(200);
  const tokenJson = (await tokenRes.json()) as {
    access_token?: string;
    token_type?: string;
    scope?: string;
    resource?: string;
  };
  expect(tokenJson.access_token).toBeTruthy();
  expect(tokenJson.token_type).toBe("bearer");
  expect(tokenJson.scope).toBe("superops.read");
  expect(tokenJson.resource).toBe(MCP_RESOURCE);
  return tokenJson.access_token!;
}

async function requestToolsWithOAuthAccessToken(
  env: Env,
  accessToken: string
): Promise<Response> {
  return mcp(
    { jsonrpc: "2.0", id: 901, method: "tools/list", params: {} },
    env,
    { Authorization: `Bearer ${accessToken}` },
    `${AUTH_SERVER}/mcp`
  );
}

describe("ChatGPT direct mutation policy", () => {
  it("derives direct-route blocks from the registry while preserving reads", async () => {
    const blocked = await chatGptDirectBlockedToolNames();
    expect([...blocked].sort()).toEqual([
      "superops_alerts_create",
      "superops_alerts_resolve",
      "superops_custom_mutation",
      "superops_custom_query",
      "superops_operations_cancel",
      "superops_scripts_execute_on_asset",
      "superops_tickets_add_note",
      "superops_tickets_apply_triage_plan",
      "superops_tickets_create",
      "superops_tickets_log_time",
      "superops_tickets_resolve_full",
      "superops_tickets_update",
    ]);

    expect(blocked.has("superops_operations_get")).toBe(false);
  });


  it("only exempts script execution when the dedicated script flag is allowed", async () => {
    const blocked = await chatGptDirectBlockedToolNames({
      reviewedTriagePlanAllowed: true,
      scriptExecutionAllowed: true,
    });

    expect(blocked.has("superops_scripts_execute_on_asset")).toBe(false);
    expect(blocked.has("superops_tickets_apply_triage_plan")).toBe(false);
    expect(blocked.has("superops_custom_mutation")).toBe(true);
    expect(blocked.has("superops_custom_query")).toBe(true);
  });
  it("only exempts the reviewed durable triage plan when explicitly allowed", async () => {
    const blocked = await chatGptDirectBlockedToolNames({
      reviewedTriagePlanAllowed: true,
    });

    expect(blocked.has("superops_tickets_apply_triage_plan")).toBe(false);
    expect(blocked.has("superops_tickets_add_note")).toBe(true);
    expect(blocked.has("superops_custom_mutation")).toBe(true);
    expect(blocked.has("superops_custom_query")).toBe(true);
    expect(blocked.has("superops_scripts_execute_on_asset")).toBe(true);
    expect(blocked.has("superops_operations_results")).toBe(false);
  });

  it("keeps the reviewed ChatGPT direct mutating surface to durable triage controls only", async () => {
    const blocked = await chatGptDirectBlockedToolNames({
      reviewedTriagePlanAllowed: true,
    });
    const allowedMutating = [...MUTATING_TOOL_NAMES]
      .filter((toolName) => !blocked.has(toolName))
      .sort();

    expect(allowedMutating).toEqual([
      "superops_operations_cancel",
      "superops_tickets_apply_triage_plan",
    ]);
  });
});

describe("Cloudflare Worker entrypoint", () => {
  beforeAll(async () => {
    accessKeyPair = await generateKeyPair("RS256", { extractable: true });
    const publicJwk = await exportJWK(accessKeyPair.publicKey);
    publicJwk.kid = "access-test-key";
    publicJwk.alg = "RS256";

    originalFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;

        if (url === `${ACCESS_ISSUER}/cdn-cgi/access/certs`) {
          return new Response(JSON.stringify({ keys: [publicJwk] }), {
            headers: { "Content-Type": "application/json" },
          });
        }

        return originalFetch(input, init);
      }
    );
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("serves a shallow health probe", async () => {
    const res = await worker.fetch(
      new Request("http://worker.local/health"),
      {}
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status?: string };
    expect(body.status).toBe("ok");
  });

  it("answers CORS preflight", async () => {
    const res = await worker.fetch(
      new Request("http://worker.local/mcp", { method: "OPTIONS" }),
      {}
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("404s unknown paths", async () => {
    const res = await worker.fetch(new Request("http://worker.local/nope"), {});
    expect(res.status).toBe(404);
  });

  it("handles MCP initialize", async () => {
    const res = await mcp({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "vitest", version: "0" },
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result?: { serverInfo?: { name?: string } };
    };
    expect(body.result?.serverInfo?.name).toBe("superops-mcp");
  });

  it("lists all tools without credentials on the existing path when write flags are enabled", async () => {
    const res = await mcp(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      },
      { ENABLE_WRITE_TOOLS: "true", ENABLE_CUSTOM_MUTATION: "true" }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result?: { tools?: { name: string }[] };
    };
    const names = (body.result?.tools ?? []).map((t) => t.name);
    expect(names).toContain("superops_navigate");
    expect(names).toContain("superops_status");
    expect(names).toContain("superops_operations_get");
    expect(names).toContain("superops_operations_results");
    expect(names).toContain("superops_tickets_list");
    expect(names).toContain("superops_alerts_list");
    expect(names).toContain("superops_alerts_create");
    expect(names).toContain("superops_scripts_list");
    expect(names).not.toContain("superops_scripts_execute_on_asset");
    expect(names.length).toBeGreaterThan(10);
  });


  it("publishes explicit MCP safety annotations on the final tools/list response", async () => {
    const tools = await listPublishedTools({
      ENABLE_WRITE_TOOLS: "true",
      ENABLE_CUSTOM_MUTATION: "true",
      CHATGPT_DIRECT_ALLOW_SCRIPT_EXECUTION: "true",
    });
    const byName = toolsByName(tools);

    expect(byName.get("superops_tickets_triage_snapshot")?.annotations).toEqual(
      EXPECTED_READ_ONLY_ANNOTATIONS
    );
    expect(byName.get("superops_tickets_get_safe_by_number")?.annotations).toEqual(
      EXPECTED_READ_ONLY_ANNOTATIONS
    );
    expect(byName.get("superops_operations_get")?.annotations).toEqual(
      EXPECTED_READ_ONLY_ANNOTATIONS
    );
    expect(byName.get("superops_tickets_apply_triage_plan")?.annotations).toEqual(
      EXPECTED_MUTATING_ANNOTATIONS
    );
    expect(byName.get("superops_scripts_execute_on_asset")?.annotations).toEqual(
      EXPECTED_MUTATING_ANNOTATIONS
    );

    for (const name of READ_ONLY_TOOL_NAMES) {
      const tool = byName.get(name);
      expect(tool, `${name} should be published in the full catalogue`).toBeDefined();
      expect(tool?.annotations).toEqual(EXPECTED_READ_ONLY_ANNOTATIONS);
      expect(tool?.description?.startsWith(READ_ONLY_DESCRIPTION_PREFIX)).toBe(true);
    }

    for (const name of MUTATING_TOOL_NAMES) {
      const tool = byName.get(name);
      expect(tool, `${name} should be published in the full catalogue`).toBeDefined();
      expect(tool?.annotations?.readOnlyHint).toBe(false);
      expect(tool?.annotations?.destructiveHint).toBe(true);
    }

    for (const tool of tools) {
      if (MUTATING_TOOL_NAMES.has(tool.name)) {
        expect(tool.annotations?.readOnlyHint).toBe(false);
      } else {
        expect(READ_ONLY_TOOL_NAMES.has(tool.name)).toBe(true);
        expect(tool.annotations?.readOnlyHint).toBe(true);
      }
    }
  });

  it("fails closed for owner-scoped operation status without a trustworthy identity", async () => {
    const record: OperationLedgerRecord = {
      responseVersion: 1,
      operationId: "worker-op-1",
      toolName: "superops_tickets_apply_triage_plan",
      ownerHash: stableHash("anonymous"),
      createdAt: "2026-07-18T00:00:00.000Z",
      updatedAt: "2026-07-18T00:00:01.000Z",
      expiresAt: "2026-07-19T00:00:00.000Z",
      originalRequestHash: stableHash({ batchId: "batch-1" }),
      state: "ContinuationRequired",
      expectedItems: ["57400"],
      completedItems: [],
      failedItems: [],
      skippedItems: [],
      unattemptedItems: ["57400"],
      pendingItems: ["57400"],
      itemStates: {
        "57400": {
          itemKey: "57400",
          stage: "Unattempted",
          outcome: "NotAttemptedExecutionStopped",
          idempotencyKey: "worker-item-57400",
          writeAttempted: false,
          writeMayHaveSucceeded: false,
          partialWrite: false,
          verificationState: "Pending",
          retryCount: 0,
        },
      },
      summary: { unattempted: 1 },
      compactResults: [{ ticketNumber: "57400", finalOutcome: "NotAttemptedExecutionStopped" }],
      partialWriteCount: 0,
      ambiguousWriteCount: 0,
      rateLimitedItems: [],
      continuationCount: 1,
    };
    await runWithOperationStore({}, () => getOperationStore().put(record));

    const res = await mcp({
      jsonrpc: "2.0",
      id: 23,
      method: "tools/call",
      params: {
        name: "superops_operations_get",
        arguments: { operationId: "worker-op-1" },
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result?: { isError?: boolean; content?: { text?: string }[] };
    };
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain("Authenticated owner identity is unavailable");
  });

  it("uses a stable gateway caller owner and rejects a different credential", async () => {
    const caller = { apiToken: "gateway-token-a", subdomain: "acme", region: "us" as const };
    const otherCaller = { apiToken: "gateway-token-b", subdomain: "acme", region: "us" as const };
    const ownerHash = await gatewayOwnerHash(caller);
    expect(await gatewayOwnerHash(caller)).toBe(ownerHash);
    expect(await gatewayOwnerHash(otherCaller)).not.toBe(ownerHash);
    const record: OperationLedgerRecord = {
      responseVersion: 1,
      operationId: "gateway-owned-operation",
      toolName: "superops_tickets_apply_triage_plan",
      ownerHash,
      createdAt: "2026-07-18T00:00:00.000Z",
      updatedAt: "2026-07-18T00:00:01.000Z",
      expiresAt: "2026-07-19T00:00:00.000Z",
      originalRequestHash: stableHash({ batchId: "gateway-owner" }),
      state: "ContinuationRequired",
      expectedItems: ["57400"],
      completedItems: [],
      failedItems: [],
      skippedItems: [],
      unattemptedItems: ["57400"],
      pendingItems: ["57400"],
      itemStates: { "57400": {
        itemKey: "57400", stage: "Unattempted", idempotencyKey: "gateway-item",
        writeAttempted: false, writeMayHaveSucceeded: false, partialWrite: false, retryCount: 0,
      } },
      summary: {},
      compactResults: [],
      partialWriteCount: 0,
      ambiguousWriteCount: 0,
      rateLimitedItems: [],
      continuationCount: 0,
    };
    await runWithOperationStore({}, () => getOperationStore().put(record));
    const call = (apiToken: string, subdomain = "acme") => mcp(
      {
        jsonrpc: "2.0", id: 24, method: "tools/call",
        params: { name: "superops_operations_get", arguments: { operationId: record.operationId } },
      },
      { AUTH_MODE: "gateway" },
      { "X-SuperOps-API-Token": apiToken, "X-SuperOps-Subdomain": subdomain }
    );

    const same = await call(caller.apiToken);
    const sameBody = await same.json() as { result?: { isError?: boolean; content?: { text?: string }[] } };
    expect(sameBody.result?.isError).toBeUndefined();
    const sameText = sameBody.result?.content?.[0]?.text ?? "";
    expect(JSON.parse(sameText)).toMatchObject({ operationId: record.operationId });
    expect(JSON.stringify(sameBody)).not.toContain(caller.apiToken);
    expect(JSON.stringify(await getOperationStore().get(record.operationId))).not.toContain(caller.apiToken);

    const different = await call(otherCaller.apiToken);
    const differentBody = await different.json() as { result?: { isError?: boolean; content?: { text?: string }[] } };
    expect(differentBody.result?.isError).toBe(true);
    expect(differentBody.result?.content?.[0]?.text).toContain("not found or is not visible");

    const missingIdentity = await mcp(
      {
        jsonrpc: "2.0", id: 25, method: "tools/call",
        params: { name: "superops_operations_get", arguments: { operationId: record.operationId } },
      },
      { AUTH_MODE: "gateway" },
      { "X-SuperOps-API-Token": caller.apiToken }
    );
    expect(missingIdentity.status).toBe(401);
  });
  it("keeps internal continuation disabled by default and requires the internal token", async () => {
    const disabled = await worker.fetch(
      new Request(`https://${INTERNAL_HOST}/internal/operations/continue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          toolName: "superops_tickets_apply_triage_plan",
          operationId: "op-disabled",
          ownerHash: stableHash("anonymous"),
        }),
      }),
      {
        SUPEROPS_API_TOKEN: "test-token",
        SUPEROPS_SUBDOMAIN: "computaskltd",
      } as Env
    );
    expect(disabled.status).toBe(403);
    await expect(disabled.json()).resolves.toMatchObject({ error: "Continuation disabled" });

    const forbidden = await worker.fetch(
      new Request(`https://${INTERNAL_HOST}/internal/operations/continue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          toolName: "superops_tickets_apply_triage_plan",
          operationId: "op-forbidden",
          ownerHash: stableHash("anonymous"),
        }),
      }),
      {
        SUPEROPS_API_TOKEN: "test-token",
        SUPEROPS_SUBDOMAIN: "computaskltd",
        SUPEROPS_CONTINUATION_ENABLED: "true",
        SUPEROPS_INTERNAL_CONTINUATION_TOKEN: "secret-token",
        SUPEROPS_PRIVATE_NOTE_ENCRYPTION_KEY: "distinct-private-note-key",
      } as Env
    );
    expect(forbidden.status).toBe(403);
    await expect(forbidden.json()).resolves.toMatchObject({ error: "Forbidden" });

    const invalidNonempty = await worker.fetch(
      new Request(`https://${INTERNAL_HOST}/internal/operations/continue`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-SuperOps-Internal-Continuation": "distinct-private-note-key",
        },
        body: JSON.stringify({
          toolName: "superops_tickets_apply_triage_plan",
          operationId: "op-forbidden",
          ownerHash: stableHash("anonymous"),
        }),
      }),
      {
        SUPEROPS_API_TOKEN: "test-token",
        SUPEROPS_SUBDOMAIN: "computaskltd",
        SUPEROPS_CONTINUATION_ENABLED: "true",
        SUPEROPS_INTERNAL_CONTINUATION_TOKEN: "secret-token",
        SUPEROPS_PRIVATE_NOTE_ENCRYPTION_KEY: "distinct-private-note-key",
      } as Env
    );
    expect(invalidNonempty.status).toBe(403);
    await expect(invalidNonempty.json()).resolves.toMatchObject({ error: "Forbidden" });
  });

  it("runs a correct-token continuation through the real internal dispatch", async () => {
    const ownerHash = stableHash("workflow-owner");
    await runWithOperationStore({}, async () => {
      await getOperationStore().put({
        responseVersion: 1,
        operationId: "op-correct-token",
        toolName: "superops_tickets_apply_triage_plan",
        ownerHash,
        createdAt: "2026-07-18T00:00:00.000Z",
        updatedAt: "2026-07-18T00:00:01.000Z",
        expiresAt: "2999-07-19T00:00:00.000Z",
        originalRequestHash: stableHash({ operationId: "op-correct-token" }),
        operationRequest: { kind: "malformed-test-payload" },
        state: "Running",
        expectedItems: ["57400"], currentItem: "57400",
        completedItems: [], failedItems: [], skippedItems: [],
        unattemptedItems: ["57400"], pendingItems: ["57400"],
        itemStates: {
          "57400": {
            itemKey: "57400", stage: "Pending",
            idempotencyKey: "item-57400", writeAttempted: false,
            writeMayHaveSucceeded: false, partialWrite: false, retryCount: 0,
          },
        },
        summary: {}, compactResults: [], partialWriteCount: 0, ambiguousWriteCount: 0,
        rateLimitedItems: [], continuationCount: 0,
      });
    });

    const response = await worker.fetch(
      new Request(`https://${INTERNAL_HOST}/internal/operations/continue`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-SuperOps-Internal-Continuation": "secret-token",
        },
        body: JSON.stringify({
          toolName: "superops_tickets_apply_triage_plan",
          operationId: "op-correct-token",
          ownerHash,
        }),
      }),
      {
        SUPEROPS_API_TOKEN: "test-token",
        SUPEROPS_SUBDOMAIN: "computaskltd",
        SUPEROPS_CONTINUATION_ENABLED: "true",
        SUPEROPS_INTERNAL_CONTINUATION_TOKEN: "secret-token",
        SUPEROPS_PRIVATE_NOTE_ENCRYPTION_KEY: "distinct-private-note-key",
      } as Env
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      result: { operationId: "op-correct-token", continuationRequired: false },
    });
    await runWithOperationStore({}, async () => {
      await expect(getOperationStore().get("op-correct-token")).resolves.toMatchObject({
        state: "CompletedWithFailures",
        itemStates: { "57400": {
          stage: "FailedBeforeWrite", writeAttempted: false, writeMayHaveSucceeded: false,
        } },
      });
    });
  });

  it("returns retryable Too Early when a Workflow wake precedes durable eligibility", async () => {
    const operationId = "op-internal-too-early";
    const ownerHash = stableHash("internal-too-early-owner");
    const nextEligibleTime = "2999-07-26T11:42:39.040Z";
    const stored = internalBudgetStopRecord(operationId, ownerHash);
    stored.state = "Rescheduled";
    stored.nextEligibleTime = nextEligibleTime;
    stored.rateLimitedItems = ["59021"];
    stored.itemStates["59021"] = {
      ...stored.itemStates["59021"],
      stage: "RateLimitedRescheduled",
      observedMutationResult: "Rejected",
      writeAttempted: true,
      writeMayHaveSucceeded: false,
      nextEligibleTime,
    };
    await runWithOperationStore({}, () => getOperationStore().put(stored));

    const response = await worker.fetch(
      new Request(`https://${INTERNAL_HOST}/internal/operations/continue`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-SuperOps-Internal-Continuation": "secret-token",
        },
        body: JSON.stringify({
          toolName: "superops_tickets_apply_triage_plan",
          operationId,
          ownerHash,
        }),
      }),
      {
        SUPEROPS_API_TOKEN: "test-token",
        SUPEROPS_SUBDOMAIN: "computaskltd",
        SUPEROPS_CONTINUATION_ENABLED: "true",
        SUPEROPS_DURABLE_RETRY_ENABLED: "true",
        SUPEROPS_INTERNAL_CONTINUATION_TOKEN: "secret-token",
      } as Env
    );

    expect(response.status).toBe(425);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      retryable: true,
      result: {
        operationId,
        state: "Rescheduled",
        continuationRequired: true,
        stopReason: "NotEligibleYet",
      },
    });
    await runWithOperationStore({}, async () => {
      await expect(getOperationStore().get(operationId, ownerHash)).resolves.toMatchObject({
        state: "Rescheduled",
        nextEligibleTime,
        itemStates: {
          "59021": {
            stage: "RateLimitedRescheduled",
            writeAttempted: true,
            writeMayHaveSucceeded: false,
          },
        },
      });
    });
  });
  it("schedules another internal hop after ContinuationRequiredBeforeItem", async () => {
    const operationId = "op-internal-before-item";
    const ownerHash = stableHash("internal-before-item-owner");
    await runWithOperationStore({}, () =>
      getOperationStore().put(internalBudgetStopRecord(operationId, ownerHash))
    );

    const serviceRequests: Request[] = [];
    const waitUntilPromises: Promise<unknown>[] = [];
    const response = await worker.fetch(
      new Request(`https://${INTERNAL_HOST}/internal/operations/continue`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-SuperOps-Internal-Continuation": "secret-token",
        },
        body: JSON.stringify({
          toolName: "superops_tickets_apply_triage_plan",
          operationId,
          ownerHash,
        }),
      }),
      {
        SUPEROPS_API_TOKEN: "test-token",
        SUPEROPS_SUBDOMAIN: "computaskltd",
        SUPEROPS_CONTINUATION_ENABLED: "true",
        SUPEROPS_DURABLE_RETRY_ENABLED: "true",
        SUPEROPS_INTERNAL_CONTINUATION_TOKEN: "secret-token",
        SUPEROPS_EXECUTION_SUBREQUEST_BUDGET: "3",
        SUPEROPS_EXECUTION_SUBREQUEST_SAFETY_MARGIN: "0",
        SUPEROPS_EXECUTION_SAFE_REMAINING_TIME_MS: "0",
        SUPEROPS_CONTINUATION_SERVICE: {
          fetch: async (request: Request) => {
            serviceRequests.push(request);
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          },
        },
      } as Env,
      {
        props: undefined,
        waitUntil: (promise: Promise<unknown>) => waitUntilPromises.push(promise),
      }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      result: {
        operationId,
        continuationRequired: true,
        stopReason: "ContinuationRequiredBeforeItem",
        continuationScheduling: {
          attempted: true,
          queued: true,
          mechanism: "serviceBinding",
        },
      },
    });
    expect(waitUntilPromises).toHaveLength(1);
    await Promise.all(waitUntilPromises);
    expect(serviceRequests).toHaveLength(1);
    await expect(serviceRequests[0].json()).resolves.toEqual({
      toolName: "superops_tickets_apply_triage_plan",
      operationId,
      ownerHash,
    });
    await runWithOperationStore({}, async () => {
      await expect(getOperationStore().get(operationId, ownerHash)).resolves.toMatchObject({
        state: "ContinuationRequired",
        continuationCount: 3,
        schedulingAttempted: true,
        schedulingSucceeded: true,
        currentPauseReason: "ContinuationRequiredBeforeItem",
        pendingItems: ["59021"],
        itemStates: {
          "59021": {
            stage: "Rescheduled",
            writeAttempted: false,
            writeMayHaveSucceeded: false,
          },
        },
      });
    });
  });

  it("terminalizes an internal continuation when the next hop is rejected", async () => {
    const operationId = "op-internal-schedule-rejected";
    const ownerHash = stableHash("internal-schedule-rejected-owner");
    await runWithOperationStore({}, () =>
      getOperationStore().put(internalBudgetStopRecord(operationId, ownerHash))
    );

    const response = await worker.fetch(
      new Request(`https://${INTERNAL_HOST}/internal/operations/continue`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-SuperOps-Internal-Continuation": "secret-token",
        },
        body: JSON.stringify({
          toolName: "superops_tickets_apply_triage_plan",
          operationId,
          ownerHash,
        }),
      }),
      {
        SUPEROPS_API_TOKEN: "test-token",
        SUPEROPS_SUBDOMAIN: "computaskltd",
        SUPEROPS_CONTINUATION_ENABLED: "true",
        SUPEROPS_DURABLE_RETRY_ENABLED: "true",
        SUPEROPS_INTERNAL_CONTINUATION_TOKEN: "secret-token",
        SUPEROPS_EXECUTION_SUBREQUEST_BUDGET: "3",
        SUPEROPS_EXECUTION_SUBREQUEST_SAFETY_MARGIN: "0",
        SUPEROPS_EXECUTION_SAFE_REMAINING_TIME_MS: "0",
        SUPEROPS_CONTINUATION_SERVICE: {
          fetch: async () => new Response("unavailable", { status: 503 }),
        },
      } as Env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      result: {
        operationId,
        continuationRequired: true,
        stopReason: "ContinuationRequiredBeforeItem",
        continuationScheduling: {
          attempted: true,
          scheduled: false,
          status: 503,
          terminalized: true,
        },
      },
    });
    await runWithOperationStore({}, async () => {
      await expect(getOperationStore().get(operationId, ownerHash)).resolves.toMatchObject({
        state: "CompletedWithFailures",
        schedulingAttempted: true,
        schedulingSucceeded: false,
        terminalFailureReason: "Immediate continuation delivery failed with status 503.",
        pendingItems: [],
        itemStates: {
          "59021": {
            stage: "FailedBeforeWrite",
            writeAttempted: false,
            writeMayHaveSucceeded: false,
            errorClass: "ContinuationSchedulingFailure",
          },
        },
      });
    });
  });

  it("returns a graceful error for a credential-requiring tool when unconfigured", async () => {
    const res = await mcp({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "superops_tickets_list", arguments: {} },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result?: { isError?: boolean; content?: { text?: string }[] };
    };
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toMatch(/credential/i);
  });

  it("rejects hidden tools in the MCP call handler before domain execution", async () => {
    const superOpsCalls: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (url.startsWith("https://api.superops.ai/")) {
          superOpsCalls.push(url);
          return new Response("unexpected SuperOps request", { status: 500 });
        }
        return originalFetch(input, init);
      }
    );

    try {
      const res = await mcp(
        {
          jsonrpc: "2.0",
          id: 37,
          method: "tools/call",
          params: {
            name: "superops_tickets_create",
            arguments: { subject: "Test", clientId: "client-1" },
          },
        },
        {
          SUPEROPS_API_TOKEN: "test-token",
          SUPEROPS_SUBDOMAIN: "computaskltd",
          ENABLE_WRITE_TOOLS: "false",
        }
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result?: { isError?: boolean; content?: { text?: string }[] };
      };
      expect(body.result?.isError).toBe(true);
      expect(body.result?.content?.[0]?.text).toContain("disabled");
      expect(superOpsCalls).toEqual([]);
    } finally {
      fetchSpy.mockRestore();
    }
  });
  it("emits a safe structured audit log for a successful tool call", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const res = await mcp(
        {
          jsonrpc: "2.0",
          id: 31,
          method: "tools/call",
          params: { name: "superops_status", arguments: {} },
        },
        {
          SUPEROPS_API_TOKEN: "test-token",
          SUPEROPS_SUBDOMAIN: "computaskltd",
          SUPEROPS_REGION: "us",
        },
        { "X-Request-Id": "audit-success-1" }
      );

      expect(res.status).toBe(200);
      const records = auditRecords(logSpy);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        event: "mcp.tool_call",
        requestId: "audit-success-1",
        toolName: "superops_status",
        toolCategory: "read",
        highRisk: false,
        success: true,
      });
      expect(records[0].timestamp).toEqual(expect.any(String));
      expect(records[0].durationMs).toEqual(expect.any(Number));
      expect(JSON.stringify(records[0])).not.toContain("test-token");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("emits a safe audit log and sanitized response for a failed tool call", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const res = await mcp(
        {
          jsonrpc: "2.0",
          id: 32,
          method: "tools/call",
          params: { name: "superops_tickets_list", arguments: {} },
        },
        {},
        { "X-Request-Id": "audit-failure-1" }
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result?: { isError?: boolean; content?: { text?: string }[] };
      };
      expect(body.result?.isError).toBe(true);
      expect(body.result?.content?.[0]?.text).toContain("credentials");
      expect(body.result?.content?.[0]?.text).not.toContain("SUPEROPS_API_TOKEN");
      expect(body.result?.content?.[0]?.text).not.toContain(" at ");

      const records = auditRecords(logSpy);
      expect(records[0]).toMatchObject({
        requestId: "audit-failure-1",
        toolName: "superops_tickets_list",
        success: false,
      });
      expect(String(records[0].errorSummary)).toContain("credentials");
      expect(JSON.stringify(records[0])).not.toContain("SUPEROPS_API_TOKEN");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("marks write-capable tools as high-risk when they are blocked by flag", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const res = await mcp(
        {
          jsonrpc: "2.0",
          id: 33,
          method: "tools/call",
          params: {
            name: "superops_tickets_create",
            arguments: { subject: "Test", clientId: "client-1" },
          },
        },
        { ENABLE_WRITE_TOOLS: "false" },
        { "X-Request-Id": "audit-write-blocked-1" }
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result?: { isError?: boolean; content?: { text?: string }[] };
      };
      expect(body.result?.isError).toBe(true);
      expect(body.result?.content?.[0]?.text).toContain("disabled");

      const records = auditRecords(logSpy);
      expect(records[0]).toMatchObject({
        toolName: "superops_tickets_create",
        toolCategory: "write",
        highRisk: true,
        success: false,
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  it("marks superops_tickets_resolve_full as a high-risk write tool", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const res = await mcp(
        {
          jsonrpc: "2.0",
          id: 331,
          method: "tools/call",
          params: {
            name: "superops_tickets_resolve_full",
            arguments: { ticketId: "ticket-57100" },
          },
        },
        { ENABLE_WRITE_TOOLS: "false" },
        { "X-Request-Id": "audit-resolve-blocked-1" }
      );

      expect(res.status).toBe(200);
      const records = auditRecords(logSpy);
      expect(records[0]).toMatchObject({
        toolName: "superops_tickets_resolve_full",
        toolCategory: "write",
        highRisk: true,
        success: false,
      });
      expect(records[0].changedFields).toEqual(["ticketId"]);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("marks alert create and resolve tools as high-risk write tools", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await mcp(
        {
          jsonrpc: "2.0",
          id: 334,
          method: "tools/call",
          params: {
            name: "superops_alerts_create",
            arguments: {
              assetId: "asset-1",
              message: "Disk alert",
              description: "Raw alert description that must not be logged",
              dryRun: false,
            },
          },
        },
        { ENABLE_WRITE_TOOLS: "false" },
        { "X-Request-Id": "audit-alert-create-blocked-1" }
      );

      await mcp(
        {
          jsonrpc: "2.0",
          id: 335,
          method: "tools/call",
          params: {
            name: "superops_alerts_resolve",
            arguments: { alertIds: ["alert-1"], dryRun: false },
          },
        },
        { ENABLE_WRITE_TOOLS: "false" },
        { "X-Request-Id": "audit-alert-resolve-blocked-1" }
      );

      const records = auditRecords(logSpy);
      expect(records[0]).toMatchObject({
        toolName: "superops_alerts_create",
        toolCategory: "write",
        highRisk: true,
        success: false,
        changedFields: ["assetId", "message", "dryRun"],
      });
      expect(records[1]).toMatchObject({
        toolName: "superops_alerts_resolve",
        toolCategory: "write",
        highRisk: true,
        success: false,
        changedFields: ["alertIds", "dryRun"],
      });
      const serialized = JSON.stringify(records);
      expect(serialized).not.toContain("Raw alert description");
      expect(serialized).not.toContain("Disk alert");
      expect(serialized).not.toContain("alert-1");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("audits resolve_full note presence without logging note content", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await mcp(
        {
          jsonrpc: "2.0",
          id: 332,
          method: "tools/call",
          params: {
            name: "superops_tickets_resolve_full",
            arguments: {
              ticketId: "ticket-57100",
              note: "Sensitive internal note body",
            },
          },
        },
        { ENABLE_WRITE_TOOLS: "false" },
        { "X-Request-Id": "audit-resolve-note-blocked-1" }
      );

      const recordText = JSON.stringify(auditRecords(logSpy)[0]);
      expect(recordText).toContain('"note"');
      expect(recordText).not.toContain("Sensitive internal note body");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("audits safe ticket retrieval as read-only without logging raw arguments", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const res = await mcp(
        {
          jsonrpc: "2.0",
          id: 333,
          method: "tools/call",
          params: {
            name: "superops_tickets_get_safe_by_number",
            arguments: {
              ticketNumber: "55841",
              includeConversations: true,
              maxTotalChars: 20000,
            },
          },
        },
        {},
        { "X-Request-Id": "audit-safe-ticket-1" }
      );

      expect(res.status).toBe(200);
      const records = auditRecords(logSpy);
      expect(records[0]).toMatchObject({
        requestId: "audit-safe-ticket-1",
        toolName: "superops_tickets_get_safe_by_number",
        toolCategory: "read",
        highRisk: false,
        success: false,
      });
      const serialized = JSON.stringify(records[0]);
      expect(serialized).not.toContain("55841");
      expect(serialized).not.toContain("maxTotalChars");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("audits triage snapshot as read-only with safe metadata only", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const res = await mcp(
        {
          jsonrpc: "2.0",
          id: 334,
          method: "tools/call",
          params: {
            name: "superops_tickets_triage_snapshot",
            arguments: {
              status: ["New Calls"],
              max: 50,
              page: 1,
              includeConversations: true,
              includeNotes: true,
              maxContentCharsPerTicket: 3000,
            },
          },
        },
        {},
        { "X-Request-Id": "audit-triage-snapshot-1" }
      );

      expect(res.status).toBe(200);
      const records = auditRecords(logSpy);
      expect(records[0]).toMatchObject({
        requestId: "audit-triage-snapshot-1",
        toolName: "superops_tickets_triage_snapshot",
        toolCategory: "read",
        highRisk: false,
        success: false,
        triageSnapshot: {
          status: ["New Calls"],
          page: 1,
          max: 50,
          safeRead: true,
        },
      });
      const serialized = JSON.stringify(records[0]);
      expect(serialized).not.toContain("maxContentCharsPerTicket");
      expect(serialized).not.toContain("plainText");
      expect(serialized).not.toContain("safeSummary");
    } finally {
      logSpy.mockRestore();
    }
  });
  it("audits approved triage plan as high-risk write without note content", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const res = await mcp(
        {
          jsonrpc: "2.0",
          id: 335,
          method: "tools/call",
          params: {
            name: "superops_tickets_apply_triage_plan",
            arguments: {
              batchId: "batch-1",
              policyMode: "scheduled-new-calls-v1",
              expectedCandidateTicketNumbers: ["57400"],
              dryRun: false,
              verify: true,
              allowResolveFullFallbackToUpdate: true,
              actions: [
                {
                  ticketNumber: "57400",
                  action: "addNote",
                  policyDisposition: "resolve_no_action",
                  note: "Sensitive approved note body",
                  contentVerified: true,
                },
              ],
            },
          },
        },
        {},
        { "X-Request-Id": "audit-apply-triage-1" }
      );

      expect(res.status).toBe(200);
      const records = auditRecords(logSpy);
      expect(records[0]).toMatchObject({
        requestId: "audit-apply-triage-1",
        toolName: "superops_tickets_apply_triage_plan",
        toolCategory: "write",
        highRisk: true,
        success: false,
        triagePlan: {
          batchId: "batch-1",
          candidateCount: 1,
          ticketNumbers: ["57400"],
          actionTypes: ["addNote"],
          policyMode: "scheduled-new-calls-v1",
          policyDispositions: ["resolve_no_action"],
          dryRun: false,
          verify: true,
          fallbackAllowed: true,
        },
      });
      const serialized = JSON.stringify(records[0]);
      expect(serialized).not.toContain("Sensitive approved note body");
    } finally {
      logSpy.mockRestore();
    }
  });
  it("does not audit full custom mutation bodies or variable values", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const res = await mcp(
        {
          jsonrpc: "2.0",
          id: 34,
          method: "tools/call",
          params: {
            name: "superops_custom_mutation",
            arguments: {
              mutation:
                "mutation RotateToken($secretValue: String!) { rotateToken(secretValue: $secretValue) { id } }",
              variables: {
                secretValue: "do-not-log-this-value",
                ticketId: "ticket-1",
              },
            },
          },
        },
        { ENABLE_CUSTOM_MUTATION: "false" },
        { "X-Request-Id": "audit-custom-blocked-1" }
      );

      expect(res.status).toBe(200);
      const records = auditRecords(logSpy);
      const serialized = JSON.stringify(records[0]);
      expect(records[0]).toMatchObject({
        toolName: "superops_custom_mutation",
        toolCategory: "custom_mutation",
        highRisk: true,
        success: false,
        customGraphql: {
          operationType: "mutation",
          operationName: "RotateToken",
          variableKeys: ["secretValue", "ticketId"],
        },
      });
      expect(serialized).not.toContain("rotateToken(secretValue");
      expect(serialized).not.toContain("do-not-log-this-value");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("preserves tool execution by default but blocks it when MCP_ENABLED is false", async () => {
    const defaultRes = await mcp({
      jsonrpc: "2.0",
      id: 35,
      method: "tools/call",
      params: { name: "superops_status", arguments: {} },
    });
    const defaultBody = (await defaultRes.json()) as {
      result?: { isError?: boolean; content?: { text?: string }[] };
    };
    expect(defaultBody.result?.isError).toBeUndefined();

    const disabledRes = await mcp(
      {
        jsonrpc: "2.0",
        id: 36,
        method: "tools/call",
        params: { name: "superops_status", arguments: {} },
      },
      { MCP_ENABLED: "false" }
    );
    const disabledBody = (await disabledRes.json()) as {
      result?: { isError?: boolean; content?: { text?: string }[] };
    };
    expect(disabledBody.result?.isError).toBe(true);
    expect(disabledBody.result?.content?.[0]?.text).toContain("MCP_ENABLED=false");
  });

  it("rejects /mcp in gateway mode without credential headers", async () => {
    const res = await mcp(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "superops_tickets_list", arguments: {} },
      },
      { AUTH_MODE: "gateway" }
    );
    expect(res.status).toBe(401);
  });

  it("accepts /mcp in gateway mode with credential headers", async () => {
    const res = await mcp(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/list",
        params: {},
      },
      { AUTH_MODE: "gateway" },
      {
        "X-SuperOps-API-Token": "test-token",
        "X-SuperOps-Subdomain": "acme",
      }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result?: { tools?: { name: string }[] };
    };
    expect((body.result?.tools ?? []).length).toBeGreaterThan(10);
  });

  it("serves OAuth discovery metadata on the ChatGPT direct hostname", async () => {
    const env = chatGptEnv();
    const protectedResourceRes = await worker.fetch(
      new Request(`${AUTH_SERVER}/.well-known/oauth-protected-resource`),
      env
    );
    expect(protectedResourceRes.status).toBe(200);
    const protectedResource = (await protectedResourceRes.json()) as {
      resource?: string;
      authorization_servers?: string[];
      scopes_supported?: string[];
    };
    expect(protectedResource.resource).toBe(MCP_RESOURCE);
    expect(protectedResource.authorization_servers).toEqual([AUTH_SERVER]);
    expect(protectedResource.scopes_supported).toEqual(["superops.read"]);

    const authServerRes = await worker.fetch(
      new Request(`${AUTH_SERVER}/.well-known/oauth-authorization-server`),
      env
    );
    expect(authServerRes.status).toBe(200);
    const authServerMetadata = (await authServerRes.json()) as {
      authorization_endpoint?: string;
      token_endpoint?: string;
      registration_endpoint?: string;
      code_challenge_methods_supported?: string[];
    };
    expect(authServerMetadata.authorization_endpoint).toBe(
      `${AUTH_SERVER}/authorize`
    );
    expect(authServerMetadata.token_endpoint).toBe(`${AUTH_SERVER}/token`);
    expect(authServerMetadata.registration_endpoint).toBe(
      `${AUTH_SERVER}/register`
    );
    expect(authServerMetadata.code_challenge_methods_supported).toEqual([
      "S256",
    ]);
  });

  it("rejects the ChatGPT direct /mcp route without an OAuth access token", async () => {
    const res = await mcp(
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/list",
        params: {},
      },
      chatGptEnv(),
      {},
      `${AUTH_SERVER}/mcp`
    );

    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain(
      "/.well-known/oauth-protected-resource/mcp"
    );
  });

  it("rejects /authorize without Cloudflare Access identity", async () => {
    const env = chatGptEnv();
    const clientId = await registerChatGptClient(env);
    const authorizeUrl = new URL(`${AUTH_SERVER}/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", CHATGPT_REDIRECT_URI);
    authorizeUrl.searchParams.set("code_challenge", "test-challenge");
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    const res = await worker.fetch(new Request(authorizeUrl), env);
    expect(res.status).toBe(403);
  });

  it("rejects /authorize for a non-allowed Access user", async () => {
    const env = chatGptEnv();
    const clientId = await registerChatGptClient(env);
    const authorizeUrl = new URL(`${AUTH_SERVER}/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", CHATGPT_REDIRECT_URI);
    authorizeUrl.searchParams.set("code_challenge", "test-challenge");
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    const res = await worker.fetch(
      new Request(authorizeUrl, {
        headers: {
          "CF-Access-Jwt-Assertion": await cloudflareAccessJwt(
            "not-sam@example.com"
          ),
        },
      }),
      env
    );
    expect(res.status).toBe(403);
  });

  it("keeps CHATGPT_AUTH_ALLOWED_EMAIL working with normalized comparison and userId", async () => {
    const env = chatGptEnv({
      CHATGPT_AUTH_ALLOWED_EMAIL: `  ${ALLOWED_EMAIL.toUpperCase()}  `,
      CHATGPT_AUTH_ALLOWED_EMAILS: undefined,
    });

    const token = await getOAuthAccessToken(env, {
      email: "Sam@Computask.Co.Uk",
    });

    expect(token.split(":")[0]).toBe(ALLOWED_EMAIL);
    expect((await requestToolsWithOAuthAccessToken(env, token)).status).toBe(200);
  });

  it("allows additional users from CHATGPT_AUTH_ALLOWED_EMAILS", async () => {
    const env = chatGptEnv({
      CHATGPT_AUTH_ALLOWED_EMAIL: undefined,
      CHATGPT_AUTH_ALLOWED_EMAILS:
        ` , ${ADDITIONAL_ALLOWED_EMAIL.toUpperCase()} , , `,
    });

    const token = await getOAuthAccessToken(env, {
      email: "User-B@Example.Com",
    });

    expect(token.split(":")[0]).toBe(ADDITIONAL_ALLOWED_EMAIL);
    expect((await requestToolsWithOAuthAccessToken(env, token)).status).toBe(200);
  });

  it("combines CHATGPT_AUTH_ALLOWED_EMAIL and CHATGPT_AUTH_ALLOWED_EMAILS", async () => {
    const env = chatGptEnv({
      CHATGPT_AUTH_ALLOWED_EMAILS: ADDITIONAL_ALLOWED_EMAIL,
    });

    const legacyToken = await getOAuthAccessToken(env);
    const additionalToken = await getOAuthAccessToken(env, {
      email: ADDITIONAL_ALLOWED_EMAIL,
    });

    expect((await requestToolsWithOAuthAccessToken(env, legacyToken)).status).toBe(
      200
    );
    expect(
      (await requestToolsWithOAuthAccessToken(env, additionalToken)).status
    ).toBe(200);
  });

  it("uses different normalized OAuth userIds for different allowed emails", async () => {
    const env = chatGptEnv({
      CHATGPT_AUTH_ALLOWED_EMAILS: ADDITIONAL_ALLOWED_EMAIL,
    });
    const clientId = await registerChatGptClient(env);

    const legacyToken = await getOAuthAccessToken(env, { clientId });
    const additionalToken = await getOAuthAccessToken(env, {
      clientId,
      email: ADDITIONAL_ALLOWED_EMAIL.toUpperCase(),
    });

    expect(legacyToken.split(":")[0]).toBe(ALLOWED_EMAIL);
    expect(additionalToken.split(":")[0]).toBe(ADDITIONAL_ALLOWED_EMAIL);
    expect(additionalToken.split(":")[0]).not.toBe(legacyToken.split(":")[0]);
  });

  it("keeps user A's existing token valid when user B is added and authorized", async () => {
    const env = chatGptEnv({ CHATGPT_AUTH_ALLOWED_EMAILS: undefined });
    const clientId = await registerChatGptClient(env);
    const userAToken = await getOAuthAccessToken(env, { clientId });

    env.CHATGPT_AUTH_ALLOWED_EMAILS = ADDITIONAL_ALLOWED_EMAIL;
    const userBToken = await getOAuthAccessToken(env, {
      clientId,
      email: ADDITIONAL_ALLOWED_EMAIL,
    });

    expect(
      (await requestToolsWithOAuthAccessToken(env, userAToken)).status
    ).toBe(200);
    expect(
      (await requestToolsWithOAuthAccessToken(env, userBToken)).status
    ).toBe(200);
  });

  it("keeps user B's token valid when user A reauthorizes", async () => {
    const env = chatGptEnv({
      CHATGPT_AUTH_ALLOWED_EMAILS: ADDITIONAL_ALLOWED_EMAIL,
    });
    const clientId = await registerChatGptClient(env);
    const originalUserAToken = await getOAuthAccessToken(env, { clientId });
    const userBToken = await getOAuthAccessToken(env, {
      clientId,
      email: ADDITIONAL_ALLOWED_EMAIL,
    });
    const reauthorizedUserAToken = await getOAuthAccessToken(env, { clientId });

    expect(
      (await requestToolsWithOAuthAccessToken(env, userBToken)).status
    ).toBe(200);
    expect(
      (await requestToolsWithOAuthAccessToken(env, reauthorizedUserAToken))
        .status
    ).toBe(200);
    expect(
      (await requestToolsWithOAuthAccessToken(env, originalUserAToken)).status
    ).toBe(401);
  });

  it("rejects dynamic client registration for non-ChatGPT redirect URIs", async () => {
    const res = await worker.fetch(
      new Request(`${AUTH_SERVER}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "Untrusted",
          redirect_uris: ["https://example.test/oauth/callback"],
          grant_types: ["authorization_code"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      }),
      chatGptEnv()
    );
    expect(res.status).toBe(403);
  });

  it("hides and blocks apply_triage_plan when the dedicated direct flag is false", async () => {
    const env = chatGptEnv({
      CHATGPT_DIRECT_ALLOW_TRIAGE_PLAN: "false",
      SUPEROPS_CONTINUATION_ENABLED: "true",
      SUPEROPS_DURABLE_RETRY_ENABLED: "true",
    });
    const token = await getOAuthAccessToken(env);

    const list = await mcp(
      { jsonrpc: "2.0", id: 7, method: "tools/list", params: {} },
      env,
      { Authorization: `Bearer ${token}` },
      `${AUTH_SERVER}/mcp`
    );
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      result?: { tools?: PublishedTool[] };
    };
    const tools = listBody.result?.tools ?? [];
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("superops_tickets_apply_triage_plan");
    expect(toolsByName(tools).get("superops_tickets_triage_snapshot")?.annotations).toEqual(
      EXPECTED_READ_ONLY_ANNOTATIONS
    );

    const call = await mcp(
      {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: { name: "superops_tickets_apply_triage_plan", arguments: {} },
      },
      env,
      { Authorization: `Bearer ${token}` },
      `${AUTH_SERVER}/mcp`
    );
    const callBody = (await call.json()) as {
      result?: { isError?: boolean; content?: { text?: string }[] };
    };
    expect(callBody.result?.isError).toBe(true);
    expect(callBody.result?.content?.[0]?.text).toMatch(/disabled/i);
  });

  it("exposes only apply_triage_plan on ChatGPT direct when the dedicated triage gates are true", async () => {
    const env = chatGptEnv({
      SUPEROPS_API_TOKEN: "test-token",
      SUPEROPS_SUBDOMAIN: "acme",
      CHATGPT_DIRECT_ALLOW_TRIAGE_PLAN: "true",
      SUPEROPS_CONTINUATION_ENABLED: "true",
      SUPEROPS_DURABLE_RETRY_ENABLED: "true",
    });
    const token = await getOAuthAccessToken(env);

    const list = await mcp(
      { jsonrpc: "2.0", id: 71, method: "tools/list", params: {} },
      env,
      { Authorization: `Bearer ${token}` },
      `${AUTH_SERVER}/mcp`
    );
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      result?: { tools?: PublishedTool[] };
    };
    const tools = listBody.result?.tools ?? [];
    const names = tools.map((t) => t.name);
    expect(names).toContain("superops_tickets_apply_triage_plan");
    expect(toolsByName(tools).get("superops_tickets_apply_triage_plan")?.annotations).toEqual(
      EXPECTED_MUTATING_ANNOTATIONS
    );
    for (const hidden of [
      "superops_tickets_add_note",
      "superops_tickets_update",
      "superops_tickets_create",
      "superops_tickets_log_time",
      "superops_tickets_resolve_full",
      "superops_alerts_create",
      "superops_alerts_resolve",
      "superops_custom_mutation",
      "superops_custom_query",
      "superops_scripts_execute_on_asset",
    ]) {
      expect(names).not.toContain(hidden);
    }
    expect(names).toContain("superops_clients_list");
    expect(names).toContain("superops_tickets_list");
    expect(names).toContain("superops_operations_get");
    expect(names).toContain("superops_operations_results");

    const call = await mcp(
      {
        jsonrpc: "2.0",
        id: 72,
        method: "tools/call",
        params: { name: "superops_tickets_apply_triage_plan", arguments: {} },
      },
      env,
      { Authorization: `Bearer ${token}` },
      `${AUTH_SERVER}/mcp`
    );
    const callBody = (await call.json()) as {
      result?: { isError?: boolean; content?: { text?: string }[] };
    };
    expect(callBody.result?.isError).toBe(true);
    expect(callBody.result?.content?.[0]?.text).toContain(
      "expectedCandidateTicketNumbers is required"
    );
    expect(callBody.result?.content?.[0]?.text).not.toMatch(/disabled/i);
  });

  it("propagates continuation scheduler bindings through the ChatGPT direct MCP route", async () => {
    const serviceRequests: Request[] = [];
    const env = chatGptEnv({
      SUPEROPS_API_TOKEN: "test-token",
      SUPEROPS_SUBDOMAIN: "acme",
      CHATGPT_DIRECT_ALLOW_TRIAGE_PLAN: "true",
      SUPEROPS_CONTINUATION_ENABLED: "true",
      SUPEROPS_DURABLE_RETRY_ENABLED: "true",
      SUPEROPS_INTERNAL_CONTINUATION_TOKEN: "direct-internal-token",
      SUPEROPS_EXECUTION_MAX_ITEMS_PER_BATCH: "1",
      SUPEROPS_CONTINUATION_SERVICE: {
        fetch: async (request: Request) => {
          serviceRequests.push(request);
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      },
    });
    const token = await getOAuthAccessToken(env);

    const call = await mcp(
      {
        jsonrpc: "2.0",
        id: 721,
        method: "tools/call",
        params: {
          name: "superops_tickets_apply_triage_plan",
          arguments: {
            batchId: "direct-route-continuation",
            expectedCandidateTicketNumbers: ["57400", "57401"],
            actions: [],
          },
        },
      },
      env,
      { Authorization: `Bearer ${token}` },
      `${AUTH_SERVER}/mcp`
    );

    const callBody = (await call.json()) as {
      result?: { content?: { text?: string }[]; isError?: boolean };
    };
    expect(callBody.result?.isError).not.toBe(true);
    const parsed = JSON.parse(callBody.result?.content?.[0]?.text ?? "{}");
    expect(parsed.operation).toMatchObject({
      operationId: "direct-route-continuation",
      complete: false,
      continuationRequired: true,
      continuationScheduling: {
        attempted: true,
        scheduled: true,
        mechanism: "serviceBinding",
      },
    });
    expect(serviceRequests).toHaveLength(1);
    expect(serviceRequests[0].headers.get("X-SuperOps-Internal-Continuation")).toBe("direct-internal-token");
    await expect(serviceRequests[0].json()).resolves.toMatchObject({
      toolName: "superops_tickets_apply_triage_plan",
      operationId: "direct-route-continuation",
    });
  });

  it("does not schedule continuation for a completed single-ticket direct triage operation", async () => {
    const serviceRequests: Request[] = [];
    const env = chatGptEnv({
      SUPEROPS_API_TOKEN: "test-token",
      SUPEROPS_SUBDOMAIN: "acme",
      CHATGPT_DIRECT_ALLOW_TRIAGE_PLAN: "true",
      SUPEROPS_CONTINUATION_ENABLED: "true",
      SUPEROPS_DURABLE_RETRY_ENABLED: "true",
      SUPEROPS_INTERNAL_CONTINUATION_TOKEN: "direct-internal-token",
      SUPEROPS_EXECUTION_MAX_ITEMS_PER_BATCH: "25",
      SUPEROPS_CONTINUATION_SERVICE: {
        fetch: async (request: Request) => {
          serviceRequests.push(request);
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      },
    });
    const token = await getOAuthAccessToken(env);

    const call = await mcp(
      {
        jsonrpc: "2.0",
        id: 722,
        method: "tools/call",
        params: {
          name: "superops_tickets_apply_triage_plan",
          arguments: {
            batchId: "direct-route-single-ticket",
            expectedCandidateTicketNumbers: ["57400"],
            actions: [],
          },
        },
      },
      env,
      { Authorization: `Bearer ${token}` },
      `${AUTH_SERVER}/mcp`
    );

    const callBody = (await call.json()) as {
      result?: { content?: { text?: string }[]; isError?: boolean };
    };
    expect(callBody.result?.isError).not.toBe(true);
    const parsed = JSON.parse(callBody.result?.content?.[0]?.text ?? "{}");
    expect(parsed.operation).toMatchObject({
      operationId: "direct-route-single-ticket",
      complete: true,
      continuationRequired: false,
      state: "Completed",
    });
    expect(parsed.operation.continuationScheduling).toBeUndefined();
    expect(serviceRequests).toHaveLength(0);
  });

  it("keeps all other direct mutation and custom tools blocked when triage is allowed", async () => {
    const env = chatGptEnv({
      SUPEROPS_API_TOKEN: "test-token",
      SUPEROPS_SUBDOMAIN: "acme",
      CHATGPT_DIRECT_ALLOW_TRIAGE_PLAN: "true",
      SUPEROPS_CONTINUATION_ENABLED: "true",
      SUPEROPS_DURABLE_RETRY_ENABLED: "true",
    });
    const token = await getOAuthAccessToken(env);

    for (const name of [
      "superops_tickets_add_note",
      "superops_alerts_create",
      "superops_custom_mutation",
      "superops_custom_query",
      "superops_scripts_execute_on_asset",
    ]) {
      const res = await mcp(
        {
          jsonrpc: "2.0",
          id: 73,
          method: "tools/call",
          params: { name, arguments: {} },
        },
        env,
        { Authorization: `Bearer ${token}` },
        `${AUTH_SERVER}/mcp`
      );
      const body = (await res.json()) as {
        result?: { isError?: boolean; content?: { text?: string }[] };
      };
      expect(body.result?.isError).toBe(true);
      expect(body.result?.content?.[0]?.text).toMatch(/disabled/i);
    }
  });

  it("requires both continuation prerequisites before exposing apply_triage_plan", async () => {
    for (const overrides of [
      { SUPEROPS_CONTINUATION_ENABLED: "false", SUPEROPS_DURABLE_RETRY_ENABLED: "true" },
      { SUPEROPS_CONTINUATION_ENABLED: "true", SUPEROPS_DURABLE_RETRY_ENABLED: "false" },
    ]) {
      const env = chatGptEnv({
        CHATGPT_DIRECT_ALLOW_TRIAGE_PLAN: "true",
        ...overrides,
      });
      const token = await getOAuthAccessToken(env);

      const list = await mcp(
        { jsonrpc: "2.0", id: 74, method: "tools/list", params: {} },
        env,
        { Authorization: `Bearer ${token}` },
        `${AUTH_SERVER}/mcp`
      );
      const listBody = (await list.json()) as {
        result?: { tools?: { name: string }[] };
      };
      const names = (listBody.result?.tools ?? []).map((t) => t.name);
      expect(names).not.toContain("superops_tickets_apply_triage_plan");

      const call = await mcp(
        {
          jsonrpc: "2.0",
          id: 75,
          method: "tools/call",
          params: { name: "superops_tickets_apply_triage_plan", arguments: {} },
        },
        env,
        { Authorization: `Bearer ${token}` },
        `${AUTH_SERVER}/mcp`
      );
      const callBody = (await call.json()) as {
        result?: { isError?: boolean; content?: { text?: string }[] };
      };
      expect(callBody.result?.isError).toBe(true);
      expect(callBody.result?.content?.[0]?.text).toMatch(/disabled/i);
    }
  });

  it("keeps custom query hidden on ChatGPT direct even when legacy mutation flags are true", async () => {
    const env = chatGptEnv({
      ENABLE_WRITE_TOOLS: "true",
      ENABLE_CUSTOM_MUTATION: "true",
      CHATGPT_DIRECT_ALLOW_MUTATING_TOOLS: "true",
    });
    const token = await getOAuthAccessToken(env);

    const res = await mcp(
      { jsonrpc: "2.0", id: 76, method: "tools/list", params: {} },
      env,
      { Authorization: `Bearer ${token}` },
      `${AUTH_SERVER}/mcp`
    );
    const body = (await res.json()) as {
      result?: { tools?: { name: string }[] };
    };
    const names = (body.result?.tools ?? []).map((t) => t.name);
    expect(names).toContain("superops_tickets_create");
    expect(names).toContain("superops_custom_mutation");
    expect(names).not.toContain("superops_tickets_apply_triage_plan");
    expect(names).not.toContain("superops_custom_query");
    expect(names).not.toContain("superops_scripts_execute_on_asset");
  });


  it("hides script execution by default while publishing read-only script tools on ChatGPT direct", async () => {
    const env = chatGptEnv({
      SUPEROPS_API_TOKEN: "test-token",
      SUPEROPS_SUBDOMAIN: "acme",
    });
    const token = await getOAuthAccessToken(env);

    const list = await mcp(
      { jsonrpc: "2.0", id: 761, method: "tools/list", params: {} },
      env,
      { Authorization: `Bearer ${token}` },
      `${AUTH_SERVER}/mcp`
    );
    const listBody = (await list.json()) as { result?: { tools?: PublishedTool[] } };
    const tools = listBody.result?.tools ?? [];
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("superops_scripts_list");
    expect(names).toContain("superops_scripts_execution_get");
    expect(names).not.toContain("superops_scripts_execute_on_asset");
    expect(toolsByName(tools).get("superops_scripts_list")?.annotations).toEqual(
      EXPECTED_READ_ONLY_ANNOTATIONS
    );

    const call = await mcp(
      {
        jsonrpc: "2.0",
        id: 762,
        method: "tools/call",
        params: { name: "superops_scripts_execute_on_asset", arguments: {} },
      },
      env,
      { Authorization: `Bearer ${token}` },
      `${AUTH_SERVER}/mcp`
    );
    const callBody = (await call.json()) as { result?: { isError?: boolean; content?: { text?: string }[] } };
    expect(callBody.result?.isError).toBe(true);
    expect(callBody.result?.content?.[0]?.text).toMatch(/disabled/i);
  });

  it("exposes script execution only with the dedicated script flag", async () => {
    const env = chatGptEnv({
      SUPEROPS_API_TOKEN: "test-token",
      SUPEROPS_SUBDOMAIN: "acme",
      CHATGPT_DIRECT_ALLOW_SCRIPT_EXECUTION: "true",
    });
    const token = await getOAuthAccessToken(env);

    const list = await mcp(
      { jsonrpc: "2.0", id: 763, method: "tools/list", params: {} },
      env,
      { Authorization: `Bearer ${token}` },
      `${AUTH_SERVER}/mcp`
    );
    const listBody = (await list.json()) as { result?: { tools?: PublishedTool[] } };
    const tools = listBody.result?.tools ?? [];
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("superops_scripts_execute_on_asset");
    expect(toolsByName(tools).get("superops_scripts_execute_on_asset")?.annotations).toEqual(
      EXPECTED_MUTATING_ANNOTATIONS
    );
    expect(names).not.toContain("superops_tickets_apply_triage_plan");
    expect(names).not.toContain("superops_custom_mutation");
    expect(names).not.toContain("superops_custom_query");

    const call = await mcp(
      {
        jsonrpc: "2.0",
        id: 764,
        method: "tools/call",
        params: { name: "superops_scripts_execute_on_asset", arguments: {} },
      },
      env,
      { Authorization: `Bearer ${token}` },
      `${AUTH_SERVER}/mcp`
    );
    const callBody = (await call.json()) as { result?: { isError?: boolean; content?: { text?: string }[] } };
    expect(callBody.result?.isError).toBe(true);
    expect(callBody.result?.content?.[0]?.text).toContain("scriptId is required");
    expect(callBody.result?.content?.[0]?.text).not.toMatch(/disabled/i);
  });
  it("does not execute blocked direct-route tools when credentials are present", async () => {
    const env = chatGptEnv({
      SUPEROPS_API_TOKEN: "test-token",
      SUPEROPS_SUBDOMAIN: "acme",
      CHATGPT_DIRECT_ALLOW_TRIAGE_PLAN: "false",
      SUPEROPS_CONTINUATION_ENABLED: "true",
      SUPEROPS_DURABLE_RETRY_ENABLED: "true",
    });
    const token = await getOAuthAccessToken(env);
    const superOpsCalls: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (url.startsWith("https://api.superops.ai/")) {
          superOpsCalls.push(url);
          return new Response("blocked test request", { status: 500 });
        }
        return originalFetch(input, init);
      }
    );

    try {
      for (const name of [
        "superops_custom_query",
        "superops_tickets_apply_triage_plan",
        "superops_scripts_execute_on_asset",
      ]) {
        const res = await mcp(
          {
            jsonrpc: "2.0",
            id: 10,
            method: "tools/call",
            params: { name, arguments: {} },
          },
          env,
          { Authorization: `Bearer ${token}` },
          `${AUTH_SERVER}/mcp`
        );

        const body = (await res.json()) as {
          result?: { isError?: boolean; content?: { text?: string }[] };
        };
        expect(body.result?.content?.[0]?.text).toMatch(/disabled/i);
      }
      expect(superOpsCalls).toEqual([]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("allows permitted direct-route tools without SuperOps credentials", async () => {
    const env = chatGptEnv();
    const token = await getOAuthAccessToken(env);
    const res = await mcp(
      {
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: { name: "superops_status", arguments: {} },
      },
      env,
      { Authorization: `Bearer ${token}` },
      `${AUTH_SERVER}/mcp`
    );

    const body = (await res.json()) as {
      result?: { isError?: boolean; content?: { text?: string }[] };
    };
    expect(body.result?.isError).toBeUndefined();
    expect(body.result?.content?.[0]?.text).not.toMatch(/disabled/i);
  });

  it("does not let the ChatGPT direct triage flag change internal /mcp write filtering", async () => {
    const env = chatGptEnv({
      CHATGPT_DIRECT_ALLOW_TRIAGE_PLAN: "true",
      SUPEROPS_CONTINUATION_ENABLED: "true",
      SUPEROPS_DURABLE_RETRY_ENABLED: "true",
      ENABLE_WRITE_TOOLS: "false",
    });

    const list = await mcp(
      { jsonrpc: "2.0", id: 77, method: "tools/list", params: {} },
      env,
      {},
      `https://${INTERNAL_HOST}/mcp`
    );
    const listBody = (await list.json()) as {
      result?: { tools?: PublishedTool[] };
    };
    const tools = listBody.result?.tools ?? [];
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("superops_tickets_apply_triage_plan");
    expect(toolsByName(tools).get("superops_tickets_triage_snapshot")?.annotations).toEqual(
      EXPECTED_READ_ONLY_ANNOTATIONS
    );
    expect(names).toContain("superops_operations_get");

    const call = await mcp(
      {
        jsonrpc: "2.0",
        id: 78,
        method: "tools/call",
        params: { name: "superops_tickets_apply_triage_plan", arguments: {} },
      },
      env,
      {},
      `https://${INTERNAL_HOST}/mcp`
    );
    const callBody = (await call.json()) as {
      result?: { isError?: boolean; content?: { text?: string }[] };
    };
    expect(callBody.result?.isError).toBe(true);
    expect(callBody.result?.content?.[0]?.text).toMatch(/disabled/i);
  });
  it("keeps the internal hostname on the existing /mcp behavior", async () => {
    const res = await mcp(
      {
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "superops_custom_query", arguments: {} },
      },
      chatGptEnv(),
      {},
      `https://${INTERNAL_HOST}/mcp`
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result?: { isError?: boolean; content?: { text?: string }[] };
    };
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain(
      "SuperOps API credentials are not configured."
    );
  });
});
