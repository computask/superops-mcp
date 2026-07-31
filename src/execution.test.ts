import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertExecutionBudget,
  classifyCloudflarePlatformLimit,
  executionConfigFromEnv,
  ExecutionCpuBudgetExceededError,
  runWithExecutionConfig,
  runWithExecutionContext,
} from "./execution.js";

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
