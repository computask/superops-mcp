import { AsyncLocalStorage } from "node:async_hooks";
import { recordSubrequestFinish, recordTypedSubrequestStart } from "./execution.js";

interface ServiceBinding {
  fetch(request: Request): Promise<Response>;
}

export interface ContinuationSchedulerEnv {
  SUPEROPS_CONTINUATION_SERVICE?: unknown;
  SUPEROPS_CONTINUATION_WORKFLOW?: unknown;
  SUPEROPS_INTERNAL_CONTINUATION_TOKEN?: string;
  SUPEROPS_CONTINUATION_ENABLED?: string;
  SUPEROPS_DURABLE_RETRY_ENABLED?: string;
}

export type ContinuationScheduleFailureCode =
  | "schedulerContextMissing"
  | "continuationFeatureDisabled"
  | "durableRetryDisabled"
  | "internalContinuationTokenMissing"
  | "serviceBindingMissing"
  | "bindingInvocationRejected"
  | "non2xxContinuationResponse"
  | "exceptionDuringScheduling";

export interface ContinuationScheduleDiagnostics {
  code: ContinuationScheduleFailureCode;
  message: string;
  continuationEnabled: boolean;
  durableRetryEnabled: boolean;
  serviceBindingPresent: boolean;
  serviceBindingFetchPresent: boolean;
  workflowBindingPresent: boolean;
  workflowCreateBatchPresent: boolean;
  internalTokenPresent: boolean;
}

export interface ContinuationScheduleResult {
  scheduled: boolean;
  status?: number;
  reason?: string;
  reasonCode?: ContinuationScheduleFailureCode;
  diagnostics?: ContinuationScheduleDiagnostics;
}

interface ContinuationScheduler {
  scheduleApplyTriage(operationId: string, ownerHash: string): Promise<ContinuationScheduleResult>;
}

interface ContinuationSchedulerContext {
  scheduler?: ContinuationScheduler;
  unavailable?: ContinuationScheduleResult;
}

const SCHEDULER_CONTEXT = new AsyncLocalStorage<ContinuationSchedulerContext | undefined>();

function isServiceBinding(value: unknown): value is ServiceBinding {
  return typeof value === "object" &&
    value !== null &&
    typeof (value as { fetch?: unknown }).fetch === "function";
}

function isWorkflowBinding(value: unknown): boolean {
  return typeof value === "object" &&
    value !== null &&
    typeof (value as { createBatch?: unknown }).createBatch === "function";
}

function schedulerDiagnostics(
  env: ContinuationSchedulerEnv,
  code: ContinuationScheduleFailureCode,
  message: string
): ContinuationScheduleDiagnostics {
  return {
    code,
    message,
    continuationEnabled: env.SUPEROPS_CONTINUATION_ENABLED === "true",
    durableRetryEnabled: env.SUPEROPS_DURABLE_RETRY_ENABLED === "true",
    serviceBindingPresent: env.SUPEROPS_CONTINUATION_SERVICE !== undefined &&
      env.SUPEROPS_CONTINUATION_SERVICE !== null,
    serviceBindingFetchPresent: isServiceBinding(env.SUPEROPS_CONTINUATION_SERVICE),
    workflowBindingPresent: env.SUPEROPS_CONTINUATION_WORKFLOW !== undefined &&
      env.SUPEROPS_CONTINUATION_WORKFLOW !== null,
    workflowCreateBatchPresent: isWorkflowBinding(env.SUPEROPS_CONTINUATION_WORKFLOW),
    internalTokenPresent: Boolean(env.SUPEROPS_INTERNAL_CONTINUATION_TOKEN?.trim()),
  };
}

function unavailableResult(
  env: ContinuationSchedulerEnv,
  code: ContinuationScheduleFailureCode,
  message: string
): ContinuationScheduleResult {
  return {
    scheduled: false,
    reason: message,
    reasonCode: code,
    diagnostics: schedulerDiagnostics(env, code, message),
  };
}

function resolveSchedulerContext(env: ContinuationSchedulerEnv): ContinuationSchedulerContext {
  if (env.SUPEROPS_CONTINUATION_ENABLED !== "true") {
    return {
      unavailable: unavailableResult(
        env,
        "continuationFeatureDisabled",
        "Continuation scheduling disabled: SUPEROPS_CONTINUATION_ENABLED is not true."
      ),
    };
  }

  if (env.SUPEROPS_DURABLE_RETRY_ENABLED !== "true") {
    return {
      unavailable: unavailableResult(
        env,
        "durableRetryDisabled",
        "Continuation scheduling disabled: SUPEROPS_DURABLE_RETRY_ENABLED is not true."
      ),
    };
  }

  if (!env.SUPEROPS_INTERNAL_CONTINUATION_TOKEN?.trim()) {
    return {
      unavailable: unavailableResult(
        env,
        "internalContinuationTokenMissing",
        "Continuation scheduling unavailable: SUPEROPS_INTERNAL_CONTINUATION_TOKEN is missing."
      ),
    };
  }

  if (!isServiceBinding(env.SUPEROPS_CONTINUATION_SERVICE)) {
    return {
      unavailable: unavailableResult(
        env,
        "serviceBindingMissing",
        "Continuation scheduling unavailable: SUPEROPS_CONTINUATION_SERVICE binding is missing."
      ),
    };
  }

  return {
    scheduler: new ServiceBindingContinuationScheduler(
      env.SUPEROPS_CONTINUATION_SERVICE,
      env.SUPEROPS_INTERNAL_CONTINUATION_TOKEN.trim()
    ),
  };
}

class ServiceBindingContinuationScheduler implements ContinuationScheduler {
  constructor(
    private readonly service: ServiceBinding,
    private readonly token: string
  ) {}

  async scheduleApplyTriage(
    operationId: string,
    ownerHash: string
  ): Promise<ContinuationScheduleResult> {
    const started = recordTypedSubrequestStart({
      type: "custom",
      operationType: "serviceBinding",
      operationName: "applyTriageContinuation",
      allowSafetyMargin: true,
    });
    let response: Response;
    try {
      response = await this.service.fetch(
        new Request("https://superops-continuation.local/internal/operations/continue", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-SuperOps-Internal-Continuation": this.token,
          },
          body: JSON.stringify({
            toolName: "superops_tickets_apply_triage_plan",
            operationId,
            ownerHash,
          }),
        })
      );
    } catch (error) {
      recordSubrequestFinish(started, "serviceBindingError", false);
      const reason = error instanceof Error ? error.message : String(error);
      return {
        scheduled: false,
        reason: `Continuation service binding invocation failed: ${reason}`,
        reasonCode: "bindingInvocationRejected",
      };
    }
    recordSubrequestFinish(started, response.status, response.ok);
    const responseText = response.ok ? undefined : await response.text();
    return {
      scheduled: response.ok,
      status: response.status,
      reason: response.ok
        ? undefined
        : `Continuation service returned non-2xx status ${response.status}: ${responseText}`,
      reasonCode: response.ok ? undefined : "non2xxContinuationResponse",
    };
  }
}

export function runWithContinuationScheduler<T>(
  env: ContinuationSchedulerEnv,
  fn: () => T
): T {
  return SCHEDULER_CONTEXT.run(resolveSchedulerContext(env), fn);
}

export async function scheduleApplyTriageContinuation(
  operationId: string,
  ownerHash: string
): Promise<ContinuationScheduleResult> {
  const context = SCHEDULER_CONTEXT.getStore();
  if (!context) {
    return {
      scheduled: false,
      reason: "Continuation scheduling unavailable: scheduler context was not installed.",
      reasonCode: "schedulerContextMissing",
    };
  }
  if (!context.scheduler) {
    return context.unavailable ?? {
      scheduled: false,
      reason: "Continuation scheduling unavailable: scheduler was not configured.",
      reasonCode: "exceptionDuringScheduling",
    };
  }
  return context.scheduler.scheduleApplyTriage(operationId, ownerHash);
}

