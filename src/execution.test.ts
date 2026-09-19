import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertExecutionBudget,
  classifyCloudflarePlatformLimit,
  executionConfigFromEnv,
  ExecutionCpuBudgetExceededError,
  getExecutionState,
  logExecutionDiagnostics,
  recordRetryDelay,
  recordSubrequestFinish,
  recordTypedSubrequestStart,
  runWithExecutionConfig,
  runWithExecutionContext,
  withExecutionItem,
} from "./execution.js";
import { runWithAuditContext } from "./audit.js";

describe("execution safety limits", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("parses durable retry, continuation, request timeout, and CPU guard ceilings", () => {
    expect(executionConfigFromEnv({
      SUPEROPS_EXECUTION_REQUEST_TIMEOUT_MS: "1234",
      SUPEROPS_EXECUTION_CPU_GUARD_MS: "4321",
      SUPEROPS_EXECUTION_MAX_CONTINUATION_COUNT: "7",
      SUPEROPS_EXECUTION_MAX_DURABLE_RETRY_ATTEMPTS: "4",
      SUPEROPS_EXECUTION_MAX_DURABLE_RETRY_DURATION_MS: "60000",
      SUPEROPS_EXECUTION_MAX_DURABLE_SINGLE_WAIT_MS: "30000",
      SUPEROPS_EXECUTION_DURABLE_BACKOFF_BASE_DELAY_MS: "12000",
      SUPEROPS_EXECUTION_MAX_SCHEDULING_ATTEMPTS: "3",
    })).toMatchObject({
      requestTimeoutMs: 1234,
      cpuGuardMs: 4321,
      maxContinuationCount: 7,
      maxDurableRetryAttempts: 4,
      maxDurableRetryDurationMs: 60000,
      maxDurableSingleWaitMs: 30000,
      durableBackoffBaseDelayMs: 12000,
      maxSchedulingAttempts: 3,
    });
  });

  it("allows the redacted per-attempt call audit to be disabled", () => {
    expect(executionConfigFromEnv({
      SUPEROPS_EXECUTION_CALL_AUDIT_ENABLED: "false",
    }).callAuditEnabled).toBe(false);
    expect(executionConfigFromEnv({
      SUPEROPS_EXECUTION_CALL_AUDIT_ENABLED: "true",
    }).callAuditEnabled).toBe(true);
  });

  it("emits only safe call and retry metadata", () => {
    const lines: string[] = [];
    let requestRecord: unknown;
    const log = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      lines.push(String(value));
    });

    try {
      runWithAuditContext(
        { requestId: "cf-ray-123" },
        () => runWithExecutionConfig(
          { SUPEROPS_EXECUTION_CALL_AUDIT_ENABLED: "true" },
          () => runWithExecutionContext(
            "superops_tickets_apply_triage_plan",
            () => withExecutionItem("61595", () => {
              const started = recordTypedSubrequestStart({
                type: "initialRead",
                operationType: "query",
                operationName: "getTicketList",
                endpoint: "https://api.superops.ai/msp?apiToken=secret-token",
              });
              recordSubrequestFinish(started, 429, false, {
                outcome: "rate_limited",
                errorClass: "SuperOpsRateLimit",
                httpStatus: 429,
                rateLimited: true,
                retryAfterSupplied: true,
              });
              recordRetryDelay({
                attempt: 1,
                source: "retry-after",
                retryCause: "rate_limit",
                retryAfterSupplied: true,
                suppliedDelayMs: 60_000,
                parsedDelayMs: 60_000,
                cappedDelayMs: 2_000,
                actualDelayMs: 2_000,
                endpoint: "https://api.superops.ai/msp?apiToken=secret-token",
                operationType: "query",
                operationName: "getTicketList",
              });
              requestRecord = getExecutionState()?.requests[0];
            })
          )
        )
      );

      const call = JSON.parse(lines.find((line) => line.includes('"event":"superops.api_call"')) ?? "{}");
      const retry = JSON.parse(lines.find((line) => line.includes('"event":"superops.api_retry"')) ?? "{}");
      expect(call).toMatchObject({
        event: "superops.api_call",
        provider: "superops",
        requestPurpose: "initialRead",
        operationName: "getTicketList",
        itemKey: "61595",
        status: 429,
        outcome: "rate_limited",
        errorClass: "SuperOpsRateLimit",
        rateLimited: true,
        retryAfterSupplied: true,
        endpointHost: "api.superops.ai",
      });
      expect(retry).toMatchObject({
        event: "superops.api_retry",
        retryCause: "rate_limit",
        source: "retry-after",
        actualDelayMs: 2_000,
        endpointHost: "api.superops.ai",
      });
      expect(JSON.stringify({ call, retry })).not.toContain("secret-token");
      expect(JSON.stringify({ call, retry })).not.toContain("apiToken");
      expect(JSON.stringify({ call, retry })).not.toContain("msp?apiToken");
      expect(requestRecord).toMatchObject({
        outcome: "rate_limited",
        errorClass: "SuperOpsRateLimit",
        endpoint: "api.superops.ai",
      });
    } finally {
      log.mockRestore();
    }
  });

  it("suppresses per-call records when the audit rollback flag is disabled", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      runWithExecutionConfig(
        { SUPEROPS_EXECUTION_CALL_AUDIT_ENABLED: "false" },
        () => runWithExecutionContext("superops_tickets_list", () => {
          const started = recordTypedSubrequestStart({
            type: "initialRead",
            operationType: "query",
            operationName: "getTicketList",
            endpoint: "https://api.superops.ai/msp",
          });
          recordSubrequestFinish(started, 200, true, {
            outcome: "success",
            httpStatus: 200,
            responseHadData: true,
          });
          logExecutionDiagnostics(true);
        })
      );

      expect(log).not.toHaveBeenCalledWith(expect.stringContaining('"event":"superops.api_call"'));
      const execution = JSON.parse(
        String(log.mock.calls.find(([value]) => String(value).includes('"event":"mcp.execution"'))?.[0] ?? "{}")
      );
      expect(execution.requests).toEqual([]);
    } finally {
      log.mockRestore();
    }
  });

  it("stops cooperatively before the configured CPU guard", () => {
    let monotonic = 0;
    vi.stubGlobal("performance", { now: () => monotonic });
    expect(() => runWithExecutionConfig(
      { SUPEROPS_EXECUTION_CPU_GUARD_MS: "1" },
      () => runWithExecutionContext("cpu-test", () => {
        monotonic = 2;
        assertExecutionBudget();
      })
    )).toThrow(ExecutionCpuBudgetExceededError);
  });

  it("distinguishes platform hard limits from configured proactive budgets", () => {
    expect(classifyCloudflarePlatformLimit(new Error("Too many subrequests: subrequest limit exceeded")))
      .toBe("CloudflareSubrequestLimit");
    expect(classifyCloudflarePlatformLimit(new Error("Worker exceeded CPU time limit error 1102")))
      .toBe("CloudflareCpuLimit");
    expect(classifyCloudflarePlatformLimit(new Error("ordinary network failure"))).toBeUndefined();
  });
});
