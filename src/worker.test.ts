/**
 * Tests for the Cloudflare Workers entrypoint.
 *
 * Drives the exported `fetch` handler directly with Web Standard Request objects
 * (available natively in Node 18+), exercising the same WebStandardStreamableHTTP
 * transport the Worker uses in production.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import worker, { type Env } from "./worker.js";

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

async function getOAuthAccessToken(env: Env): Promise<string> {
  const clientId = await registerChatGptClient(env);
  const verifier = "test-verifier-abcdefghijklmnopqrstuvwxyz0123456789";
  const challenge = await pkceChallenge(verifier);

  const authorizeUrl = new URL(`${AUTH_SERVER}/authorize`);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", CHATGPT_REDIRECT_URI);
  authorizeUrl.searchParams.set("scope", "superops.read");
  authorizeUrl.searchParams.set("state", "test-state");
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("resource", MCP_RESOURCE);

  const authorizeRes = await worker.fetch(
    new Request(authorizeUrl, {
      headers: {
        "CF-Access-Jwt-Assertion": await cloudflareAccessJwt(),
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
    client_id: clientId,
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

  it("lists all tools without credentials on the existing path", async () => {
    const res = await mcp({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result?: { tools?: { name: string }[] };
    };
    const names = (body.result?.tools ?? []).map((t) => t.name);
    expect(names).toContain("superops_navigate");
    expect(names).toContain("superops_status");
    expect(names).toContain("superops_tickets_list");
    expect(names).toContain("superops_alerts_list");
    expect(names).toContain("superops_alerts_create");
    expect(names.length).toBeGreaterThan(10);
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
      expect(body.result?.content?.[0]?.text).toContain("ENABLE_WRITE_TOOLS=false");

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

  it("completes the ChatGPT direct OAuth flow and lists tools", async () => {
    const env = chatGptEnv();
    const token = await getOAuthAccessToken(env);

    const res = await mcp(
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/list",
        params: {},
      },
      env,
      { Authorization: `Bearer ${token}` },
      `${AUTH_SERVER}/mcp`
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result?: { tools?: { name: string }[] };
    };
    const names = (body.result?.tools ?? []).map((t) => t.name);
    expect(names).toContain("superops_navigate");
    expect(names).toContain("superops_tickets_create");
  });

  it("blocks write and broad-query tools on the ChatGPT direct route by default", async () => {
    const env = chatGptEnv();
    const token = await getOAuthAccessToken(env);
    const res = await mcp(
      {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: { name: "superops_custom_query", arguments: {} },
      },
      env,
      { Authorization: `Bearer ${token}` },
      `${AUTH_SERVER}/mcp`
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result?: { isError?: boolean; content?: { text?: string }[] };
    };
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toMatch(/disabled/i);
  });

  it("keeps the internal hostname on the existing /mcp behavior", async () => {
    const res = await mcp(
      {
        jsonrpc: "2.0",
        id: 9,
        method: "tools/list",
        params: {},
      },
      chatGptEnv(),
      {},
      `https://${INTERNAL_HOST}/mcp`
    );

    expect(res.status).toBe(200);
  });
});
