/**
 * SuperOps Client Tests
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { getCredentials, resetClient, SuperOpsClient } from "./client.js";
import {
  executionDiagnostics,
  runWithExecutionConfig,
  runWithExecutionContext,
} from "./execution.js";

describe("getCredentials", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    resetClient();
  });

  it("returns null when SUPEROPS_API_TOKEN is not set", () => {
    vi.stubEnv("SUPEROPS_API_TOKEN", "");
    vi.stubEnv("SUPEROPS_SUBDOMAIN", "testcompany");

    const creds = getCredentials();
    expect(creds).toBeNull();
  });

  it("returns null when SUPEROPS_SUBDOMAIN is not set", () => {
    vi.stubEnv("SUPEROPS_API_TOKEN", "test-token");
    vi.stubEnv("SUPEROPS_SUBDOMAIN", "");

    const creds = getCredentials();
    expect(creds).toBeNull();
  });

  it("returns credentials when both are set", () => {
    vi.stubEnv("SUPEROPS_API_TOKEN", "test-token");
    vi.stubEnv("SUPEROPS_SUBDOMAIN", "testcompany");

    const creds = getCredentials();
    expect(creds).toEqual({
      apiToken: "test-token",
      subdomain: "testcompany",
      region: undefined,
    });
  });

  it("includes region when SUPEROPS_REGION is set", () => {
    vi.stubEnv("SUPEROPS_API_TOKEN", "test-token");
    vi.stubEnv("SUPEROPS_SUBDOMAIN", "testcompany");
    vi.stubEnv("SUPEROPS_REGION", "eu");

    const creds = getCredentials();
    expect(creds).toEqual({
      apiToken: "test-token",
      subdomain: "testcompany",
      region: "eu",
    });
  });
});

describe("SuperOpsClient execution instrumentation", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("counts successful GraphQL calls without logging credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { ok: true } }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new SuperOpsClient({ apiToken: "secret-token", subdomain: "example" });

    let diagnostics: ReturnType<typeof executionDiagnostics> | undefined;
    const result = await runWithExecutionConfig(
      { SUPEROPS_EXECUTION_SUBREQUEST_BUDGET: "5", SUPEROPS_EXECUTION_SUBREQUEST_SAFETY_MARGIN: "1" },
      () =>
        runWithExecutionContext("superops_custom_query", async () => {
          const value = await client.query("query Test { ok }");
          diagnostics = executionDiagnostics();
          return value;
        })
    );

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(diagnostics?.subrequests).toMatchObject({ used: 1, budget: 5, safetyMargin: 1 });
    expect(JSON.stringify(diagnostics)).not.toContain("secret-token");
  });

  it("throws before fetching when the invocation budget is exhausted", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = new SuperOpsClient({ apiToken: "secret-token", subdomain: "example" });

    await expect(
      runWithExecutionConfig(
        { SUPEROPS_EXECUTION_SUBREQUEST_BUDGET: "1", SUPEROPS_EXECUTION_SUBREQUEST_SAFETY_MARGIN: "1" },
        () => runWithExecutionContext("superops_custom_query", () => client.query("query Test { ok }"))
      )
    ).rejects.toThrow("Execution budget exhausted");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
describe("SuperOpsClient rate-limit handling", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("retries read requests after HTTP 429 Retry-After seconds within budget", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "rate limited" }), {
          status: 429,
          headers: { "Retry-After": "1" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { ok: true } }), { status: 200 })
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = new SuperOpsClient({ apiToken: "secret-token", subdomain: "example" });

    let diagnostics: ReturnType<typeof executionDiagnostics> | undefined;
    const result = await runWithExecutionConfig(
      {
        SUPEROPS_EXECUTION_SUBREQUEST_BUDGET: "10",
        SUPEROPS_EXECUTION_SUBREQUEST_SAFETY_MARGIN: "1",
        SUPEROPS_EXECUTION_MAX_SINGLE_DELAY_MS: "1",
        SUPEROPS_EXECUTION_BACKOFF_JITTER_RATIO: "0",
      },
      () =>
        runWithExecutionContext("superops_custom_query", async () => {
          const value = await client.query("query Test { ok }");
          diagnostics = executionDiagnostics();
          return value;
        })
    );

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(diagnostics?.retries).toMatchObject({ count: 1, delaysMs: [1] });
    expect(diagnostics?.subrequests).toMatchObject({ used: 2 });
  });

  it("retries read requests after Retry-After HTTP date", async () => {
    const retryDate = new Date(Date.now() + 1_000).toUTCString();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "rate limited" }), {
          status: 429,
          headers: { "Retry-After": retryDate },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { ok: true } }), { status: 200 })
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = new SuperOpsClient({ apiToken: "secret-token", subdomain: "example" });

    const result = await runWithExecutionConfig(
      {
        SUPEROPS_EXECUTION_SUBREQUEST_BUDGET: "10",
        SUPEROPS_EXECUTION_SUBREQUEST_SAFETY_MARGIN: "1",
        SUPEROPS_EXECUTION_MAX_SINGLE_DELAY_MS: "1",
        SUPEROPS_EXECUTION_BACKOFF_JITTER_RATIO: "0",
      },
      () => runWithExecutionContext("superops_custom_query", () => client.query("query Test { ok }"))
    );

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries structured GraphQL throttling for reads only", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            errors: [
              {
                message: "Throttled by upstream API",
                extensions: { code: "THROTTLED", retryAfter: 0 },
              },
            ],
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { ok: true } }), { status: 200 })
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = new SuperOpsClient({ apiToken: "secret-token", subdomain: "example" });

    const result = await runWithExecutionConfig(
      { SUPEROPS_EXECUTION_BACKOFF_JITTER_RATIO: "0" },
      () => runWithExecutionContext("superops_custom_query", () => client.query("query Test { ok }"))
    );

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not classify unrelated GraphQL validation errors as throttling", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          errors: [
            {
              message: "This is not a rate limit problem",
              extensions: { code: "BAD_USER_INPUT" },
            },
          ],
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new SuperOpsClient({ apiToken: "secret-token", subdomain: "example" });

    await expect(
      runWithExecutionConfig(
        { SUPEROPS_EXECUTION_MAX_READ_RETRY_ATTEMPTS: "3" },
        () => runWithExecutionContext("superops_custom_query", () => client.query("query Test { ok }"))
      )
    ).rejects.toThrow("not a rate limit");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not blindly retry writes after HTTP 429", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "rate limited" }), { status: 429 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new SuperOpsClient({ apiToken: "secret-token", subdomain: "example" });

    await expect(
      runWithExecutionConfig(
        { SUPEROPS_EXECUTION_MAX_WRITE_RETRY_ATTEMPTS: "3" },
        () => runWithExecutionContext("superops_custom_mutation", () => client.mutate("mutation Test { ok }"))
      )
    ).rejects.toThrow("HTTP error: 429");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("retries reset-header throttling, 5xx, network failure, and timeout with bounded diagnostics", async () => {
    const failureCases: Array<{ name: string; response: Response | Error }> = [
      { name: "reset header", response: new Response("slow down", { status: 429, headers: { "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 10) } }) },
      { name: "5xx", response: new Response("unavailable", { status: 503 }) },
      { name: "network", response: new Error("network unavailable") },
      { name: "timeout", response: Object.assign(new Error("request timeout"), { name: "AbortError" }) },
    ];

    for (const testCase of failureCases) {
      const fetchMock = vi.fn()
        .mockImplementationOnce(() => testCase.response instanceof Response ? Promise.resolve(testCase.response) : Promise.reject(testCase.response))
        .mockResolvedValueOnce(new Response(JSON.stringify({ data: { ok: true } }), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const client = new SuperOpsClient({ apiToken: "secret-token", subdomain: "example" });
      let diagnostics: ReturnType<typeof executionDiagnostics> | undefined;
      await runWithExecutionConfig(
        { SUPEROPS_EXECUTION_BACKOFF_JITTER_RATIO: "0", SUPEROPS_EXECUTION_MAX_SINGLE_DELAY_MS: "0" },
        () => runWithExecutionContext("superops_custom_query", async () => {
          await expect(client.query("query Test { ok }")).resolves.toEqual({ ok: true });
          diagnostics = executionDiagnostics();
        })
      );
      expect(fetchMock, testCase.name).toHaveBeenCalledTimes(2);
      expect(diagnostics?.retries).toMatchObject({ count: 1, delaysMs: [0] });
    }
  });

  it("stops deterministically on retry exhaustion and leaves a long Retry-After for the durable adapter", async () => {
    const exhaustedFetch = vi.fn().mockResolvedValue(
      new Response("unavailable", { status: 503 })
    );
    vi.stubGlobal("fetch", exhaustedFetch);
    const client = new SuperOpsClient({ apiToken: "secret-token", subdomain: "example" });
    await expect(
      runWithExecutionConfig(
        { SUPEROPS_EXECUTION_MAX_READ_RETRY_ATTEMPTS: "2", SUPEROPS_EXECUTION_BACKOFF_JITTER_RATIO: "0", SUPEROPS_EXECUTION_MAX_SINGLE_DELAY_MS: "0" },
        () => runWithExecutionContext("superops_custom_query", () => client.query("query Test { ok }"))
      )
    ).rejects.toThrow("HTTP error: 503");
    expect(exhaustedFetch).toHaveBeenCalledTimes(2);

    const delayedFetch = vi.fn().mockResolvedValue(
      new Response("slow down", { status: 429, headers: { "Retry-After": "60" } })
    );
    vi.stubGlobal("fetch", delayedFetch);
    await expect(
      runWithExecutionConfig(
        { SUPEROPS_EXECUTION_MAX_RETRY_DURATION_MS: "10", SUPEROPS_EXECUTION_MAX_SINGLE_DELAY_MS: "60000" },
        () => runWithExecutionContext("superops_custom_query", () => client.query("query Test { ok }"))
      )
    ).rejects.toMatchObject({ name: "SuperOpsHttpError", retryAfter: 60 });
    expect(delayedFetch).toHaveBeenCalledTimes(1);
  });
});
