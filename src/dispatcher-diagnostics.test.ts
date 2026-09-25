import { afterEach, describe, expect, it, vi } from "vitest";
import { DISPATCHER_ORIGIN, dispatcherDiagnostics, runWithDispatcher } from "./dispatcher.js";
import { runWithExecutionContext } from "./execution.js";

const env = {
  DISPATCHER_TOKEN: "synthetic-producer-secret",
  CF_ACCESS_CLIENT_ID: "synthetic-access-id",
  CF_ACCESS_CLIENT_SECRET: "synthetic-access-secret",
};
const requestId = "93af6168-727b-41a0-81f1-bfd546a7f972";
const snakeCaseDiagnostics = {
  schema_version: 1,
  request_id: requestId,
  source: "superops-mcp",
  status: "uncertain",
  attempt_count: 1,
  created_at: "2026-09-25T07:11:34.919Z",
  updated_at: "2026-09-25T07:11:36.198Z",
  started_at: "2026-09-25T07:11:34.919Z",
  completed_at: "2026-09-25T07:11:36.198Z",
  next_retry_at: null,
  upstream_http_status: 200,
  error_classification: "GRAPHQL_ERROR",
  uncertain: true,
  attempts_truncated: false,
  attempts: [{
    id: 7,
    attempt_number: 1,
    started_at: "2026-09-25T07:11:34.919Z",
    completed_at: "2026-09-25T07:11:36.198Z",
    classification: "GRAPHQL_ERROR",
    response_status: 200,
    response_state: "partial_data",
    response_had_data: true,
    graphql_errors: [{code: "INTERNAL_SERVER_ERROR", path: ["updateTicket", "ticket", 0]}],
    uncertain: true,
    retry_decision: "not_scheduled",
    retry_next_at: null,
    retry_reason: "ambiguous_mutation_requires_reconciliation",
    retry_after_ms: 0,
  }],
  request_payload: "private GraphQL variables",
  idempotency_key: "must-not-be-returned",
};

afterEach(() => { vi.unstubAllGlobals(); });

describe("producer-scoped versioned dispatcher diagnostics", () => {
  it("maps actual snake_case attempt records to a bounded safe summary", async () => {
    const fetcher = vi.fn(async (_input: string | URL, _init?: RequestInit) => Response.json(snakeCaseDiagnostics));
    vi.stubGlobal("fetch", fetcher);
    const result = await runWithExecutionContext("dispatcher-diagnostics", () =>
      runWithDispatcher(env, () => dispatcherDiagnostics(requestId)));

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe(DISPATCHER_ORIGIN + "/v1/requests/" + requestId + "/safe-diagnostics");
    expect(fetcher.mock.calls[0][1]).toMatchObject({method: "GET", redirect: "manual"});
    expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: "Bearer " + env.DISPATCHER_TOKEN,
      "CF-Access-Client-Id": env.CF_ACCESS_CLIENT_ID,
      "CF-Access-Client-Secret": env.CF_ACCESS_CLIENT_SECRET,
    });
    expect(fetcher.mock.calls[0][1]?.headers).not.toHaveProperty("X-Source");
    expect(result).toEqual({requestId, diagnostics: {
      schemaVersion: 1,
      status: "uncertain",
      attemptCount: 1,
      upstreamHttpStatus: 200,
      errorClassification: "GRAPHQL_ERROR",
      uncertain: true,
      attempts: [{
        attemptId: 7,
        attemptNumber: 1,
        startedAt: "2026-09-25T07:11:34.919Z",
        completedAt: "2026-09-25T07:11:36.198Z",
        upstreamHttpStatus: 200,
        classification: "GRAPHQL_ERROR",
        responseState: "partial_data",
        responseHadData: true,
        graphqlErrors: [{code: "INTERNAL_SERVER_ERROR", path: ["updateTicket", "ticket", 0]}],
        uncertain: true,
        retryDecision: "not_scheduled",
        retryReason: "ambiguous_mutation_requires_reconciliation",
        retryAfterMs: 0,
      }],
      attemptsTruncated: false,
    }});
    expect(JSON.stringify(result)).not.toMatch(/private GraphQL|idempotency|payload|headers|Bearer/);
  });

  it("rejects malformed receipt IDs before making a request", async () => {
    const fetcher = vi.fn(async (_input: string | URL, _init?: RequestInit) => Response.json({}));
    vi.stubGlobal("fetch", fetcher);
    await expect(dispatcherDiagnostics("https://example.invalid/", env)).rejects.toThrow("valid dispatcher receipt ID");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([401, 403])("records producer HTTP %i denial separately and does not expose the response body", async status => {
    const fetcher = vi.fn(async () => new Response("private denial detail", {status}));
    vi.stubGlobal("fetch", fetcher);
    const result = await dispatcherDiagnostics(requestId, env);
    expect(result).toEqual({requestId, retrieval: {status: "failed", category: "http_" + status, dispatcherHttpStatus: status}});
    expect(JSON.stringify(result)).not.toContain("private denial detail");
  });

  it("bounds malformed and oversized diagnostic responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({schema_version: 2, request_payload: "secret"})));
    expect(await dispatcherDiagnostics(requestId, env)).toEqual({requestId, retrieval: {status: "failed", category: "invalid_response", dispatcherHttpStatus: 200}});
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{not-json")));
    expect(await dispatcherDiagnostics(requestId, env)).toEqual({requestId, retrieval: {status: "failed", category: "invalid_response", dispatcherHttpStatus: 200}});
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x".repeat(128 * 1024 + 1))));
    expect(await dispatcherDiagnostics(requestId, env)).toEqual({requestId, retrieval: {status: "failed", category: "oversized_response", dispatcherHttpStatus: 200}});
  });

  it("records diagnostics timeouts without replacing the original result", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("timeout", "TimeoutError"); }));
    expect(await dispatcherDiagnostics(requestId, env)).toEqual({requestId, retrieval: {status: "failed", category: "timeout"}});
  });

  it("does not follow redirects or send producer source hints as authorization", async () => {
    const fetcher = vi.fn(async () => new Response(null, {status: 302, headers: {Location: "https://example.invalid/"}}));
    vi.stubGlobal("fetch", fetcher);
    expect(await dispatcherDiagnostics(requestId, env)).toEqual({requestId, retrieval: {status: "failed", category: "redirect", dispatcherHttpStatus: 302}});
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
