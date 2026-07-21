import { describe, expect, it } from "vitest";

import {
  runWithContinuationScheduler,
  scheduleApplyTriageContinuation,
} from "./continuation-scheduler.js";
import { runWithExecutionConfig, runWithExecutionContext } from "./execution.js";

describe("continuation scheduler diagnostics", () => {
  it("reports a precise disabled flag reason", async () => {
    await runWithExecutionConfig({}, async () => {
      await runWithExecutionContext("scheduler-disabled-test", async () => {
        const result = await runWithContinuationScheduler({
          SUPEROPS_CONTINUATION_ENABLED: "false",
          SUPEROPS_DURABLE_RETRY_ENABLED: "true",
          SUPEROPS_INTERNAL_CONTINUATION_TOKEN: "token",
          SUPEROPS_CONTINUATION_SERVICE: { fetch: async () => new Response(null, { status: 200 }) },
        }, () => scheduleApplyTriageContinuation("op-disabled", "owner"));

        expect(result).toMatchObject({
          scheduled: false,
          reasonCode: "continuationFeatureDisabled",
          diagnostics: {
            continuationEnabled: false,
            durableRetryEnabled: true,
            serviceBindingFetchPresent: true,
            internalTokenPresent: true,
          },
        });
      });
    });
  });

  it("reports missing token and service binding as distinct reasons", async () => {
    await runWithExecutionConfig({}, async () => {
      await runWithExecutionContext("scheduler-prerequisite-test", async () => {
        const missingToken = await runWithContinuationScheduler({
          SUPEROPS_CONTINUATION_ENABLED: "true",
          SUPEROPS_DURABLE_RETRY_ENABLED: "true",
          SUPEROPS_CONTINUATION_SERVICE: { fetch: async () => new Response(null, { status: 200 }) },
        }, () => scheduleApplyTriageContinuation("op-token", "owner"));
        const missingService = await runWithContinuationScheduler({
          SUPEROPS_CONTINUATION_ENABLED: "true",
          SUPEROPS_DURABLE_RETRY_ENABLED: "true",
          SUPEROPS_INTERNAL_CONTINUATION_TOKEN: "token",
        }, () => scheduleApplyTriageContinuation("op-service", "owner"));

        expect(missingToken.reasonCode).toBe("internalContinuationTokenMissing");
        expect(missingService).toMatchObject({
          reasonCode: "serviceBindingMissing",
          diagnostics: {
            serviceBindingPresent: false,
            serviceBindingFetchPresent: false,
            internalTokenPresent: true,
          },
        });
      });
    });
  });

  it("distinguishes rejected binding calls from non-2xx continuation responses", async () => {
    await runWithExecutionConfig({ SUPEROPS_EXECUTION_SUBREQUEST_BUDGET: "4", SUPEROPS_EXECUTION_SUBREQUEST_SAFETY_MARGIN: "0" }, async () => {
      await runWithExecutionContext("scheduler-service-failure-test", async () => {
        const rejected = await runWithContinuationScheduler({
          SUPEROPS_CONTINUATION_ENABLED: "true",
          SUPEROPS_DURABLE_RETRY_ENABLED: "true",
          SUPEROPS_INTERNAL_CONTINUATION_TOKEN: "token",
          SUPEROPS_CONTINUATION_SERVICE: { fetch: async () => { throw new Error("binding rejected"); } },
        }, () => scheduleApplyTriageContinuation("op-rejected", "owner"));
        const non2xx = await runWithContinuationScheduler({
          SUPEROPS_CONTINUATION_ENABLED: "true",
          SUPEROPS_DURABLE_RETRY_ENABLED: "true",
          SUPEROPS_INTERNAL_CONTINUATION_TOKEN: "token",
          SUPEROPS_CONTINUATION_SERVICE: { fetch: async () => new Response("Forbidden", { status: 403 }) },
        }, () => scheduleApplyTriageContinuation("op-non2xx", "owner"));

        expect(rejected).toMatchObject({
          scheduled: false,
          reasonCode: "bindingInvocationRejected",
        });
        expect(non2xx).toMatchObject({
          scheduled: false,
          status: 403,
          reasonCode: "non2xxContinuationResponse",
        });
      });
    });
  });

  it("delivers a service-binding continuation request without exposing the token", async () => {
    let delivered: Request | undefined;
    await runWithExecutionConfig({ SUPEROPS_EXECUTION_SUBREQUEST_BUDGET: "3", SUPEROPS_EXECUTION_SUBREQUEST_SAFETY_MARGIN: "0" }, async () => {
      await runWithExecutionContext("scheduler-success-test", async () => {
        const result = await runWithContinuationScheduler({
          SUPEROPS_CONTINUATION_ENABLED: "true",
          SUPEROPS_DURABLE_RETRY_ENABLED: "true",
          SUPEROPS_INTERNAL_CONTINUATION_TOKEN: "secret-token",
          SUPEROPS_CONTINUATION_WORKFLOW: { createBatch: async () => [] },
          SUPEROPS_CONTINUATION_SERVICE: {
            fetch: async (request: Request) => {
              delivered = request;
              return new Response(JSON.stringify({ ok: true }), { status: 200 });
            },
          },
        }, () => scheduleApplyTriageContinuation("op-ok", "owner-hash"));

        expect(result).toEqual({ scheduled: true, status: 200, reason: undefined, reasonCode: undefined });
      });
    });

    expect(delivered?.url).toBe("https://superops-continuation.local/internal/operations/continue");
    expect(await delivered?.json()).toEqual({
      toolName: "superops_tickets_apply_triage_plan",
      operationId: "op-ok",
      ownerHash: "owner-hash",
    });
  });
});
