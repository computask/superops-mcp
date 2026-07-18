import { AsyncLocalStorage } from "node:async_hooks";
import { recordSubrequestFinish, recordTypedSubrequestStart } from "./execution.js";

interface ServiceBinding {
  fetch(request: Request): Promise<Response>;
}

export interface ContinuationSchedulerEnv {
  SUPEROPS_CONTINUATION_SERVICE?: unknown;
  SUPEROPS_INTERNAL_CONTINUATION_TOKEN?: string;
  SUPEROPS_CONTINUATION_ENABLED?: string;
}

export interface ContinuationScheduleResult {
  scheduled: boolean;
  status?: number;
  reason?: string;
}

interface ContinuationScheduler {
  scheduleApplyTriage(operationId: string, ownerHash: string): Promise<ContinuationScheduleResult>;
}

const SCHEDULER_CONTEXT = new AsyncLocalStorage<ContinuationScheduler | undefined>();

function isServiceBinding(value: unknown): value is ServiceBinding {
  return typeof value === "object" &&
    value !== null &&
    typeof (value as { fetch?: unknown }).fetch === "function";
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
      return {
        scheduled: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    recordSubrequestFinish(started, response.status, response.ok);
    return {
      scheduled: response.ok,
      status: response.status,
      reason: response.ok ? undefined : await response.text(),
    };
  }
}

export function runWithContinuationScheduler<T>(
  env: ContinuationSchedulerEnv,
  fn: () => T
): T {
  const enabled = env.SUPEROPS_CONTINUATION_ENABLED === "true";
  const token = env.SUPEROPS_INTERNAL_CONTINUATION_TOKEN?.trim();
  const scheduler = enabled && token && isServiceBinding(env.SUPEROPS_CONTINUATION_SERVICE)
    ? new ServiceBindingContinuationScheduler(env.SUPEROPS_CONTINUATION_SERVICE, token)
    : undefined;
  return SCHEDULER_CONTEXT.run(scheduler, fn);
}

export async function scheduleApplyTriageContinuation(
  operationId: string,
  ownerHash: string
): Promise<ContinuationScheduleResult> {
  const scheduler = SCHEDULER_CONTEXT.getStore();
  if (!scheduler) {
    return { scheduled: false, reason: "Continuation scheduling is disabled or not configured." };
  }
  return scheduler.scheduleApplyTriage(operationId, ownerHash);
}

