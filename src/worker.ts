/**
 * Cloudflare Workers entry point for the SuperOps.ai MCP Server.
 *
 * Serves the full MCP server over the Streamable HTTP transport using the SDK's
 * Web Standard transport (Request/Response), which runs natively on Workers.
 * It reuses the exact same `createMcpServer()` factory as the stdio / Node HTTP
 * entrypoints (see `mcp-server.ts`), so there is no second tool implementation
 * to maintain.
 *
 * Credentials are resolved per request from either gateway headers or Worker
 * secrets / vars, depending on AUTH_MODE.
 *
 * `process.env` is not populated on workerd, so even in env mode the resolved
 * credentials are propagated through the same AsyncLocalStorage store
 * (`runWithCredentials`) the Node HTTP transport uses. `nodejs_compat` provides
 * `async_hooks` on workerd.
 *
 * `tools/list` and `initialize` work without credentials; only `tools/call`
 * requires them.
 */

import {
  OAuthProvider,
  getOAuthApi,
  type AuthRequest,
  type ClientRegistrationCallbackOptions,
  type ClientRegistrationCallbackResult,
  type OAuthProviderOptions,
} from "@cloudflare/workers-oauth-provider";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { runWithCredentials } from "./client.js";
import {
  blockedToolNamesByCategory,
  chatGptDirectBlockedToolNames,
  createMcpServer,
  resolveGatewayCredentials,
} from "./mcp-server.js";
import { resumeApplyTriageOperation } from "./domains/tickets.js";
import type { SuperOpsCredentials } from "./types.js";
import {
  auditToolCall,
  requestIdFromHeaders,
  runWithAuditContext,
  runtimeFlagsFromEnv,
  toolAuditMetadata,
  type ToolCategory,
} from "./audit.js";
import { finishExecution, runWithExecutionConfig, runWithExecutionContext } from "./execution.js";
import { runWithContinuationScheduler } from "./continuation-scheduler.js";
import {
  envTenantOwnerHash,
  gatewayOwnerHash,
  runWithOperationStore,
  SuperOpsOperationLedger,
} from "./operation-store.js";
import { SuperOpsContinuationWorkflow } from "./continuation-workflow.js";
export { SuperOpsOperationLedger, SuperOpsContinuationWorkflow };

export interface Env {
  SUPEROPS_API_TOKEN?: string;
  SUPEROPS_SUBDOMAIN?: string;
  SUPEROPS_REGION?: string;
  AUTH_MODE?: string;
  LOG_LEVEL?: string;
  MCP_ENABLED?: string;
  ENABLE_WRITE_TOOLS?: string;
  ENABLE_CUSTOM_MUTATION?: string;
  OAUTH_KV?: unknown;
  OAUTH_PROVIDER?: unknown;
  SUPEROPS_OPERATION_LEDGER?: unknown;
  SUPEROPS_CONTINUATION_WORKFLOW?: {
    createBatch(options: Array<{ id: string; params: Record<string, unknown> }>): Promise<Array<{ id: string }>>;
  };
  SUPEROPS_CONTINUATION_SERVICE?: unknown;
  SUPEROPS_CONTINUATION_ENABLED?: string;
  SUPEROPS_DURABLE_RETRY_ENABLED?: string;
  SUPEROPS_INTERNAL_CONTINUATION_TOKEN?: string;
  SUPEROPS_PRIVATE_NOTE_ENCRYPTION_KEY?: string;
  CHATGPT_MCP_HOST?: string;
  CHATGPT_MCP_RESOURCE?: string;
  CHATGPT_OAUTH_SCOPES?: string;
  CHATGPT_AUTH_ALLOWED_EMAIL?: string;
  CHATGPT_AUTH_ACCESS_ISSUER?: string;
  CHATGPT_AUTH_ACCESS_AUD?: string;
  CHATGPT_DIRECT_ALLOW_MUTATING_TOOLS?: string;
  CHATGPT_DIRECT_ALLOW_TRIAGE_PLAN?: string;
  SUPEROPS_EXECUTION_SUBREQUEST_BUDGET?: string;
  SUPEROPS_EXECUTION_SUBREQUEST_SAFETY_MARGIN?: string;
  SUPEROPS_EXECUTION_MAX_ITEMS_PER_BATCH?: string;
  SUPEROPS_EXECUTION_MAX_PAGINATION_DEPTH?: string;
  SUPEROPS_EXECUTION_MAX_RETRY_ATTEMPTS?: string;
  SUPEROPS_EXECUTION_MAX_RETRY_DURATION_MS?: string;
  SUPEROPS_EXECUTION_MAX_SINGLE_DELAY_MS?: string;
  SUPEROPS_EXECUTION_BACKOFF_BASE_DELAY_MS?: string;
  SUPEROPS_EXECUTION_BACKOFF_JITTER_RATIO?: string;
  SUPEROPS_EXECUTION_SAFE_REMAINING_TIME_MS?: string;
  SUPEROPS_EXECUTION_MAX_DURATION_MS?: string;
  SUPEROPS_EXECUTION_REQUEST_TIMEOUT_MS?: string;
  SUPEROPS_EXECUTION_CPU_GUARD_MS?: string;
  SUPEROPS_EXECUTION_MAX_CONTINUATION_COUNT?: string;
  SUPEROPS_EXECUTION_MAX_DURABLE_RETRY_ATTEMPTS?: string;
  SUPEROPS_EXECUTION_MAX_DURABLE_RETRY_DURATION_MS?: string;
  SUPEROPS_EXECUTION_MAX_DURABLE_SINGLE_WAIT_MS?: string;
  SUPEROPS_EXECUTION_MAX_SCHEDULING_ATTEMPTS?: string;
  SUPEROPS_EXECUTION_VERIFICATION_MODE?: string;
  SUPEROPS_OPERATION_RETENTION_SECONDS?: string;
  SUPEROPS_OPERATION_MAX_LIFETIME_SECONDS?: string;
  SUPEROPS_EXECUTION_CONCURRENCY?: string;
}

type WorkerExecutionContext = {
  props?: unknown;
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
};

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version, X-SuperOps-API-Token, X-SuperOps-Subdomain",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, WWW-Authenticate",
};

const DEFAULT_CHATGPT_MCP_HOST =
  "superops-mcp-chatgpt-direct.taskgroup.co.uk";

const DEFAULT_CHATGPT_MCP_RESOURCE = `https://${DEFAULT_CHATGPT_MCP_HOST}/mcp`;

const DEFAULT_CHATGPT_OAUTH_SCOPES = ["superops.read"];

const CHATGPT_REDIRECT_HOSTS = new Set(["chatgpt.com", "chat.openai.com"]);


const remoteJwksCache = new Map<
  string,
  ReturnType<typeof createRemoteJWKSet>
>();

function json(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

/**
 * Run the MCP request through a fresh server + Web Standard transport.
 * Stateless: a new server/transport pair is created per request.
 */
async function handleMcp(
  request: Request,
  blockedToolNames: ReadonlySet<string>
): Promise<Response> {
  const server = createMcpServer({ blockedToolNames });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);

  try {
    const response = await transport.handleRequest(request);
    return withCors(response);
  } finally {
    await transport.close();
    await server.close();
  }
}

function ensureExecutionContext(
  ctx: WorkerExecutionContext | undefined
): WorkerExecutionContext {
  return (
    ctx ?? {
      waitUntil() {
        // Unit tests call fetch directly without a Worker execution context.
      },
    }
  );
}

function userFromOAuthProps(props: unknown): string | undefined {
  if (typeof props !== "object" || props === null || Array.isArray(props)) {
    return undefined;
  }

  const email = (props as { email?: unknown }).email;
  return typeof email === "string" && email.trim() ? email.trim() : undefined;
}

export { gatewayOwnerHash };

async function workerOwnerHash(request: Request, env: Env): Promise<string | undefined> {
  if ((env.AUTH_MODE ?? "env") === "gateway") {
    const resolved = resolveGatewayCredentials(
      (name) => request.headers.get(name) ?? undefined
    );
    return resolved.creds ? gatewayOwnerHash(resolved.creds) : undefined;
  }
  if (!env.SUPEROPS_API_TOKEN || !env.SUPEROPS_SUBDOMAIN) return undefined;
  return envTenantOwnerHash({
    subdomain: env.SUPEROPS_SUBDOMAIN,
    region: env.SUPEROPS_REGION === "eu" ? "eu" : "us",
  });
}

function flagExactlyTrue(value: string | undefined): boolean {
  return value === "true";
}

function chatGptDirectReviewedTriagePlanAllowed(env: Env): boolean {
  return (
    flagExactlyTrue(env.CHATGPT_DIRECT_ALLOW_TRIAGE_PLAN) &&
    flagExactlyTrue(env.SUPEROPS_CONTINUATION_ENABLED) &&
    flagExactlyTrue(env.SUPEROPS_DURABLE_RETRY_ENABLED)
  );
}

async function blockedToolNamesForWorkerEnv(
  env: Env,
  chatGptDirect: boolean
): Promise<Set<string>> {
  if (chatGptDirect) {
    const directMutatingToolsAllowed = flagExactlyTrue(
      env.CHATGPT_DIRECT_ALLOW_MUTATING_TOOLS
    );
    return chatGptDirectBlockedToolNames({
      generalMutatingToolsAllowed:
        directMutatingToolsAllowed && flagExactlyTrue(env.ENABLE_WRITE_TOOLS),
      customMutationsAllowed:
        directMutatingToolsAllowed && flagExactlyTrue(env.ENABLE_CUSTOM_MUTATION),
      reviewedTriagePlanAllowed: chatGptDirectReviewedTriagePlanAllowed(env),
    });
  }

  const categories = new Set<ToolCategory>();

  if (!flagExactlyTrue(env.ENABLE_WRITE_TOOLS)) {
    categories.add("write");
  }
  if (!flagExactlyTrue(env.ENABLE_CUSTOM_MUTATION)) {
    categories.add("custom_mutation");
  }

  return blockedToolNamesByCategory(categories);
}

async function runWithWorkerAuditContext<T>(
  request: Request,
  env: Env,
  props: unknown,
  fn: () => T
): Promise<Awaited<T>> {
  const oauthUser = userFromOAuthProps(props);
  const ownerHash = oauthUser ? undefined : await workerOwnerHash(request, env);
  return await runWithAuditContext(
    {
      requestId: requestIdFromHeaders(request.headers),
      user: oauthUser,
      ownerHash,
      ownerIdentityRequired: true,
      ...runtimeFlagsFromEnv(env),
    },
    fn
  );
}

function parseScopes(
  value: string | undefined,
  fallback: string[]
): string[] {
  if (value === undefined) {
    return fallback;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }

  return trimmed.split(/[\s,]+/).filter(Boolean);
}

function getChatGptMcpHost(env: Env): string {
  return env.CHATGPT_MCP_HOST?.trim().toLowerCase() || DEFAULT_CHATGPT_MCP_HOST;
}

function getChatGptMcpResource(env: Env): string {
  return env.CHATGPT_MCP_RESOURCE?.trim() || DEFAULT_CHATGPT_MCP_RESOURCE;
}

function getChatGptScopes(env: Env): string[] {
  return parseScopes(env.CHATGPT_OAUTH_SCOPES, DEFAULT_CHATGPT_OAUTH_SCOPES);
}

function getChatGptAuthorizationServer(env: Env): string {
  return `https://${getChatGptMcpHost(env)}`;
}

function isChatGptDirectRequest(url: URL, env: Env): boolean {
  return url.hostname.toLowerCase() === getChatGptMcpHost(env);
}

function getRemoteJwks(jwksUrl: string): ReturnType<typeof createRemoteJWKSet> {
  const cached = remoteJwksCache.get(jwksUrl);
  if (cached) {
    return cached;
  }

  const jwks = createRemoteJWKSet(new URL(jwksUrl));
  remoteJwksCache.set(jwksUrl, jwks);
  return jwks;
}

async function rejectBlockedChatGptToolCall(
  request: Request,
  blockedToolNames: ReadonlySet<string>
): Promise<Response | undefined> {
  if (blockedToolNames.size === 0) {
    return undefined;
  }

  if (request.method !== "POST") {
    return undefined;
  }

  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return undefined;
  }

  if (
    !body ||
    Array.isArray(body) ||
    typeof body !== "object" ||
    (body as { method?: unknown }).method !== "tools/call"
  ) {
    return undefined;
  }

  const params = (body as { params?: unknown }).params;
  if (!params || typeof params !== "object") {
    return undefined;
  }

  const toolName = (params as { name?: unknown }).name;
  if (
    typeof toolName !== "string" ||
    !blockedToolNames.has(toolName)
  ) {
    return undefined;
  }

  const toolArgs = ((params as { arguments?: unknown }).arguments ??
    {}) as Record<string, unknown>;
  const message = `${toolName} is disabled by this MCP server configuration.`;
  auditToolCall({
    toolName,
    success: false,
    durationMs: 0,
    errorSummary: message,
    metadata: toolAuditMetadata(toolName, toolArgs),
  });

  const id = (body as { id?: unknown }).id ?? null;
  return json({
    jsonrpc: "2.0",
    id,
    result: {
      content: [
        {
          type: "text",
          text: message,
        },
      ],
      isError: true,
    },
  });
}

function normalizeOrigin(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    return new URL(trimmed).origin;
  } catch {
    return undefined;
  }
}

async function requireAllowedAccessUser(
  request: Request,
  env: Env
): Promise<{ email: string } | Response> {
  const allowedEmail = env.CHATGPT_AUTH_ALLOWED_EMAIL?.trim();
  const issuer = normalizeOrigin(env.CHATGPT_AUTH_ACCESS_ISSUER);
  const audience = env.CHATGPT_AUTH_ACCESS_AUD?.trim();

  if (!allowedEmail || !issuer || !audience) {
    return json(
      {
        error: "OAuth authorize not configured",
        message:
          "Set CHATGPT_AUTH_ALLOWED_EMAIL, CHATGPT_AUTH_ACCESS_ISSUER, and CHATGPT_AUTH_ACCESS_AUD.",
      },
      503
    );
  }

  const assertion = request.headers.get("CF-Access-Jwt-Assertion");
  if (!assertion) {
    return json(
      { error: "Forbidden", message: "Cloudflare Access identity required." },
      403
    );
  }

  try {
    const { payload } = await jwtVerify(
      assertion,
      getRemoteJwks(`${issuer}/cdn-cgi/access/certs`),
      {
        issuer,
        audience,
      }
    );
    const email = (payload as { email?: unknown }).email;

    if (email !== allowedEmail) {
      return json({ error: "Forbidden", message: "Unauthorized user." }, 403);
    }

    return { email };
  } catch {
    return json({ error: "Forbidden", message: "Invalid Access identity." }, 403);
  }
}

function isAllowedChatGptRedirectUri(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }

  try {
    const url = new URL(value);
    return url.protocol === "https:" && CHATGPT_REDIRECT_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

function validateClientRegistration({
  clientMetadata,
}: ClientRegistrationCallbackOptions): ClientRegistrationCallbackResult | void {
  const redirectUris = clientMetadata.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    return {
      code: "invalid_client_metadata",
      description: "At least one redirect URI is required.",
      status: 400,
    };
  }

  if (!redirectUris.every(isAllowedChatGptRedirectUri)) {
    return {
      code: "access_denied",
      description: "Client redirect URI is not allowed.",
      status: 403,
    };
  }
}

function authRequestResources(request: AuthRequest): string[] {
  if (!request.resource) {
    return [];
  }

  return Array.isArray(request.resource) ? request.resource : [request.resource];
}

function validateAuthorizationRequest(
  authRequest: AuthRequest,
  env: Env
): string | undefined {
  if (authRequest.responseType !== "code") {
    return "Only authorization code flow is supported.";
  }

  if (!isAllowedChatGptRedirectUri(authRequest.redirectUri)) {
    return "Redirect URI is not allowed.";
  }

  if (!authRequest.codeChallenge || authRequest.codeChallengeMethod !== "S256") {
    return "S256 PKCE is required.";
  }

  const supportedScopes = new Set(getChatGptScopes(env));
  const unsupportedScope = authRequest.scope.find(
    (scope) => !supportedScopes.has(scope)
  );
  if (unsupportedScope) {
    return "Requested scope is not supported.";
  }

  const resource = getChatGptMcpResource(env);
  const resources = authRequestResources(authRequest);
  if (resources.length > 0 && !resources.every((value) => value === resource)) {
    return "Requested resource is not supported.";
  }
}

function grantedScopes(authRequest: AuthRequest, env: Env): string[] {
  const requested = authRequest.scope;
  if (requested.length > 0) {
    return requested;
  }

  return getChatGptScopes(env);
}

async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const accessUser = await requireAllowedAccessUser(request, env);
  if (accessUser instanceof Response) {
    return accessUser;
  }

  const oauthApi = getOAuthApi(getChatGptOAuthOptions(env), env);
  let authRequest: AuthRequest;
  try {
    authRequest = await oauthApi.parseAuthRequest(request);
  } catch {
    return json(
      { error: "invalid_request", message: "Invalid authorization request." },
      400
    );
  }

  const policyError = validateAuthorizationRequest(authRequest, env);
  if (policyError) {
    return json({ error: "invalid_request", message: policyError }, 400);
  }

  try {
    const { redirectTo } = await oauthApi.completeAuthorization({
      request: authRequest,
      userId: accessUser.email,
      metadata: { email: accessUser.email },
      scope: grantedScopes(authRequest, env),
      props: { email: accessUser.email },
      revokeExistingGrants: true,
    });

    return Response.redirect(redirectTo, 302);
  } catch {
    return json(
      { error: "invalid_request", message: "Authorization failed." },
      400
    );
  }
}

async function handleInternalContinuation(
  request: Request,
  env: Env
): Promise<Response> {
  if (env.SUPEROPS_CONTINUATION_ENABLED !== "true") {
    return json({ error: "Continuation disabled" }, 403);
  }
  const expectedToken = env.SUPEROPS_INTERNAL_CONTINUATION_TOKEN?.trim();
  if (!expectedToken || request.headers.get("X-SuperOps-Internal-Continuation") !== expectedToken) {
    return json({ error: "Forbidden" }, 403);
  }
  if (!env.SUPEROPS_API_TOKEN || !env.SUPEROPS_SUBDOMAIN) {
    return json({ error: "Continuation requires env-mode SuperOps credentials" }, 503);
  }

  let body: { toolName?: unknown; operationId?: unknown; ownerHash?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return json({ error: "Invalid continuation request" }, 400);
  }
  if (
    body.toolName !== "superops_tickets_apply_triage_plan" ||
    typeof body.operationId !== "string" ||
    typeof body.ownerHash !== "string"
  ) {
    return json({ error: "Unsupported continuation request" }, 400);
  }

  const creds: SuperOpsCredentials = {
    apiToken: env.SUPEROPS_API_TOKEN,
    subdomain: env.SUPEROPS_SUBDOMAIN,
    region: env.SUPEROPS_REGION === "eu" ? "eu" : "us",
  };

  const result = await runWithContinuationScheduler(env, () =>
    runWithOperationStore(env, () =>
      runWithExecutionConfig(env, () =>
        runWithCredentials(creds, () =>
          runWithExecutionContext("superops_tickets_apply_triage_plan", async () => {
            const continuation = await resumeApplyTriageOperation({
              operationId: body.operationId as string,
              ownerHash: body.ownerHash as string,
              leaseOwner: globalThis.crypto?.randomUUID?.() ?? `worker-${Date.now()}`,
            });
            finishExecution(continuation.continuationRequired ? "continuationRequired" : "completed");
            return continuation;
          })
        )
      )
    )
  );

  return json({ ok: true, result });
}
async function handleBaseWorkerFetch(
  request: Request,
  env: Env,
  props?: unknown,
  auditContextApplied = false,
  blockedToolNames?: ReadonlySet<string>
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/internal/operations/continue") {
    return handleInternalContinuation(request, env);
  }

  // CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // Shallow, unauthenticated liveness probe.
  if (url.pathname === "/health" || url.pathname === "/healthz") {
    return json({
      status: "ok",
      transport: "http",
      authMode: env.AUTH_MODE === "gateway" ? "gateway" : "env",
      timestamp: new Date().toISOString(),
    });
  }

  if (url.pathname === "/mcp") {
    const mcpBlockedToolNames =
      blockedToolNames ?? (await blockedToolNamesForWorkerEnv(env, false));
    const runMcpRequest = async (): Promise<Response> => {
    const isGatewayMode = (env.AUTH_MODE ?? "env") === "gateway";

    let creds: SuperOpsCredentials | undefined;
    if (isGatewayMode) {
      const resolved = resolveGatewayCredentials(
        (name) => request.headers.get(name) ?? undefined
      );
      if (resolved.error) {
        return json(
          {
            error: "Missing credentials",
            message: resolved.error,
            required: ["X-SuperOps-API-Token", "X-SuperOps-Subdomain"],
          },
          401
        );
      }
      creds = resolved.creds;
    } else if (env.SUPEROPS_API_TOKEN && env.SUPEROPS_SUBDOMAIN) {
      // Env mode may still omit creds for initialize and tools/list.
      creds = {
        apiToken: env.SUPEROPS_API_TOKEN,
        subdomain: env.SUPEROPS_SUBDOMAIN,
        region: env.SUPEROPS_REGION === "eu" ? "eu" : ("us" as "us" | "eu"),
      };
    }

    // Propagate credentials through AsyncLocalStorage so getCredentials()/
    // getClient() resolve them (process.env is unavailable on workerd).
    if (creds) {
      return runWithCredentials(creds, () => handleMcp(request, mcpBlockedToolNames));
    }
    return handleMcp(request, mcpBlockedToolNames);
    };

    const runConfiguredMcpRequest = () =>
      runWithOperationStore(env, () =>
        runWithExecutionConfig(env, runMcpRequest)
      );

    if (auditContextApplied) {
      return runConfiguredMcpRequest();
    }

    return runWithWorkerAuditContext(request, env, props, runConfiguredMcpRequest);
  }

  return json({ error: "Not found", endpoints: ["/mcp", "/health"] }, 404);
}

const chatGptMcpApiHandler = {
  async fetch(
    request: Request,
    env: Env,
    ctx?: WorkerExecutionContext
  ): Promise<Response> {
    return runWithWorkerAuditContext(request, env, ctx?.props, async () => {
      const blockedToolNames = await blockedToolNamesForWorkerEnv(env, true);
      const blockedToolCall = await rejectBlockedChatGptToolCall(request, blockedToolNames);
      if (blockedToolCall) {
        return blockedToolCall;
      }

      return handleBaseWorkerFetch(request, env, ctx?.props, true, blockedToolNames);
    });
  },
};

const chatGptDefaultHandler = {
  async fetch(
    request: Request,
    env: Env,
    ctx?: WorkerExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/authorize") {
      return handleAuthorize(request, env);
    }

    return handleBaseWorkerFetch(request, env, ctx?.props);
  },
};

function getChatGptOAuthOptions(env: Env): OAuthProviderOptions<Env> {
  const resource = getChatGptMcpResource(env);
  const authServer = getChatGptAuthorizationServer(env);
  const scopes = getChatGptScopes(env);

  return {
    apiRoute: "/mcp",
    apiHandler: chatGptMcpApiHandler as never,
    defaultHandler: chatGptDefaultHandler as never,
    authorizeEndpoint: `${authServer}/authorize`,
    tokenEndpoint: `${authServer}/token`,
    clientRegistrationEndpoint: `${authServer}/register`,
    scopesSupported: scopes,
    allowPlainPKCE: false,
    resourceMetadata: {
      resource,
      authorization_servers: [authServer],
      scopes_supported: scopes,
      bearer_methods_supported: ["header"],
      resource_name: "SuperOps MCP",
    },
    clientRegistrationCallback: validateClientRegistration,
    onError: () => undefined,
  };
}

function getChatGptOAuthProvider(env: Env): OAuthProvider<Env> {
  return new OAuthProvider<Env>(getChatGptOAuthOptions(env));
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx?: WorkerExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    if (isChatGptDirectRequest(url, env)) {
      return getChatGptOAuthProvider(env).fetch(
        request,
        env,
        ensureExecutionContext(ctx) as never
      );
    }

    return handleBaseWorkerFetch(request, env, ctx?.props);
  },
};
