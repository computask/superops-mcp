import { afterEach, describe, expect, it, vi } from "vitest";
import { DISPATCHER_ORIGIN, dispatcherDiagnostics, runWithDispatcher } from "./dispatcher.js";
import { runWithExecutionContext } from "./execution.js";

const env = {
  DISPATCHER_TOKEN: "synthetic-producer-secret",
  CF_ACCESS_CLIENT_ID: "synthetic-access-id",
  CF_ACCESS_CLIENT_SECRET: "synthetic-access-secret",
};
const requestId = "93af6168-727b-41a0-81f1-bfd546a7f972";

afterEach(() => { vi.unstubAllGlobals(); });

describe("dispatcher receipt diagnostics", () => {
  it("uses authenticated fixed-host GET and returns only bounded safe attempt metadata", async () => {
    const fetcher = vi.fn(async (_input: string | URL, _init?: RequestInit) => Response.json({
      requestId,
      source: "superops-mcp",
      state: "failed",
      httpStatus: 200,
      errorClassification: "GRAPHQL_ERROR",
      attempts: [{
        attempt: 1,
        startedAt: "2026-09-25T07:11:34.919Z",
        completedAt: "2026-09-25T07:11:36.198Z",
        httpStatus: 200,
        graphqlCode: "INTERNAL_SERVER_ERROR",
        message: "private customer text",
        response: {data: {note: "private note body"}},
        headers: {authorization: "Bearer not-for-output"},
      }],
      requestBody: "private GraphQL and ticket payload",
      idempotencyKey: "must-not-be-returned",
    }));
    vi.stubGlobal("fetch", fetcher);

    const result = await runWithExecutionContext("dispatcher-diagnostics", () =>
      runWithDispatcher(env, () => dispatcherDiagnostics(requestId)));

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe(`${DISPATCHER_ORIGIN}/v1/requests/${requestId}/diagnostics`);
    expect(fetcher.mock.calls[0][1]).toMatchObject({method: "GET", redirect: "manual"});
    expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: `Bearer ${env.DISPATCHER_TOKEN}`,
      "X-Source": "superops-mcp",
      "CF-Access-Client-Id": env.CF_ACCESS_CLIENT_ID,
      "CF-Access-Client-Secret": env.CF_ACCESS_CLIENT_SECRET,
    });
    expect(result).toEqual({requestId, diagnostics: {
      requestId,
      source: "superops-mcp",
      state: "failed",
      httpStatus: 200,
      errorClassification: "GRAPHQL_ERROR",
      attempts: [{attempt: 1, startedAt: "2026-09-25T07:11:34.919Z", completedAt: "2026-09-25T07:11:36.198Z", httpStatus: 200, graphqlCode: "INTERNAL_SERVER_ERROR"}],
    }});
    expect(JSON.stringify(result)).not.toMatch(/private customer text|private note body|Bearer|idempotency|requestBody|headers/);
  });

  it("rejects malformed receipt IDs before making a request", async () => {
    const fetcher = vi.fn(async (_input: string | URL, _init?: RequestInit) => Response.json({}));
    vi.stubGlobal("fetch", fetcher);
    await expect(dispatcherDiagnostics("https://example.invalid/" , env)).rejects.toThrow("valid dispatcher receipt ID");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects redirects without following them", async () => {
    const fetcher = vi.fn(async (_input: string | URL, _init?: RequestInit) => new Response(null, {status: 302, headers: {Location: "https://example.invalid/"}}));
    vi.stubGlobal("fetch", fetcher);
    await expect(runWithDispatcher(env, () => dispatcherDiagnostics(requestId))).rejects.toThrow("no receipt details were exposed");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]?.redirect).toBe("manual");
  });
});
