import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  type ExecutionConfigInput,
  finishExecution,
  recordSubrequestFinish,
  recordTypedSubrequestStart,
  runWithExecutionConfig,
  runWithExecutionContext,
} from "./execution.js";
import {
  getOperationStore,
  runWithOperationStore,
  type OperationLedgerRecord,
  type OperationStoreEnv,
} from "./operation-store.js";

export interface ContinuationWorkflowParams {
  operationId: string;
  ownerHash: string;
  nextEligibleTime: string;
  scheduleIdentity: string;
}

interface ContinuationWorkflowEnv extends OperationStoreEnv, ExecutionConfigInput {
  SUPEROPS_CONTINUATION_SERVICE?: { fetch(request: Request): Promise<Response> };
  SUPEROPS_INTERNAL_CONTINUATION_TOKEN?: string;
}

const TERMINAL_OPERATION_STATES = new Set(["Completed", "CompletedWithFailures", "Failed", "Cancelled"]);

function durableProgressSignature(record: OperationLedgerRecord): string {
  return JSON.stringify({
    state: record.state,
    currentItem: record.currentItem,
    completedItems: record.completedItems,
    failedItems: record.failedItems,
    skippedItems: record.skippedItems,
    pendingItems: record.pendingItems,
    nextEligibleTime: record.nextEligibleTime,
    continuationCount: record.continuationCount,
    lastInvocationId: record.lastInvocationId,
    itemStages: record.expectedItems.map((itemKey) => [
      itemKey,
      record.itemStates[itemKey]?.stage,
      record.itemStates[itemKey]?.attemptCount,
      record.itemStates[itemKey]?.retryCount,
    ]),
  });
}

export class SuperOpsContinuationWorkflow extends WorkflowEntrypoint<
  ContinuationWorkflowEnv,
  ContinuationWorkflowParams
> {
  async run(
    event: WorkflowEvent<ContinuationWorkflowParams>,
    step: WorkflowStep
  ): Promise<{ operationId: string; delivered: boolean }> {
    const params = event.payload;
    if (!params.operationId || !params.ownerHash || !params.nextEligibleTime || !params.scheduleIdentity) {
      throw new Error("Malformed continuation workflow payload.");
    }

    return runWithExecutionConfig(this.env, () =>
      runWithExecutionContext(
        "superops_continuation_workflow",
        async () => {
          try {
            const result = await this.deliver(params, step);
            finishExecution(result.delivered ? "delivered" : "deliveryFailed");
            return result;
          } catch (error) {
            finishExecution("failed");
            throw error;
          }
        },
        params.operationId
      )
    );
  }

  private async deliver(
    params: ContinuationWorkflowParams,
    step: WorkflowStep
  ): Promise<{ operationId: string; delivered: boolean }> {
    await step.sleepUntil("wait-until-next-eligible", new Date(params.nextEligibleTime));
    try {
      await step.do(
        "deliver-checked-continuation",
        { retries: { limit: 8, delay: "1 second", backoff: "exponential" }, timeout: "30 seconds" },
        async () => {
          const service = this.env.SUPEROPS_CONTINUATION_SERVICE;
          const token = this.env.SUPEROPS_INTERNAL_CONTINUATION_TOKEN?.trim();
          if (!service || !token) throw new Error("Continuation service binding or token is unavailable.");

          let progressBefore: string | undefined;
          let alreadyTerminal = false;
          await runWithOperationStore(this.env, async () => {
            const store = getOperationStore();
            const record = await store.get(params.operationId, params.ownerHash);
            if (!record || record.ownerHash !== params.ownerHash) {
              throw new Error("Continuation operation is unavailable to the workflow owner.");
            }
            alreadyTerminal = TERMINAL_OPERATION_STATES.has(record.state);
            progressBefore = durableProgressSignature(record);
            if (alreadyTerminal) return;
            await store.update(params.operationId, params.ownerHash, (current) => ({
              ...current,
              wakeAttemptCount: (current.wakeAttemptCount ?? 0) + 1,
              lastWakeAttemptAt: new Date().toISOString(),
            }));
          });
          if (alreadyTerminal) return;

          const response = await fetchContinuationService(service, new Request(
            "https://superops-continuation.local/internal/operations/continue",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-SuperOps-Internal-Continuation": token,
              },
              body: JSON.stringify({
                toolName: "superops_tickets_apply_triage_plan",
                operationId: params.operationId,
                ownerHash: params.ownerHash,
              }),
            }
          ));
          if (!response.ok) {
            throw new Error(`Continuation service rejected workflow wake with status ${response.status}.`);
          }

          await runWithOperationStore(this.env, async () => {
            const store = getOperationStore();
            const record = await store.get(params.operationId, params.ownerHash);
            if (!record || record.ownerHash !== params.ownerHash) {
              throw new Error("Continuation operation disappeared after workflow delivery.");
            }
            if (!TERMINAL_OPERATION_STATES.has(record.state) &&
                durableProgressSignature(record) === progressBefore) {
              throw new Error("Continuation service returned success without durable operation progress.");
            }
            await store.update(params.operationId, params.ownerHash, (current) => ({
              ...current,
              wakeDeliveryCount: (current.wakeDeliveryCount ?? 0) + 1,
              lastWakeSucceededAt: new Date().toISOString(),
            }));
          });
        }
      );
    } catch {
      const reason = "Workflow continuation delivery retry limit exhausted.";
      await step.do(
        "record-delivery-exhaustion",
        { retries: { limit: 3, delay: "1 second", backoff: "exponential" }, timeout: "15 seconds" },
        async () => {
          await runWithOperationStore(this.env, async () => {
            const store = getOperationStore();
            try {
              await store.terminalizeContinuationFailure({
                operationId: params.operationId,
                ownerHash: params.ownerHash,
                errorClass: "ContinuationExecutionFailure",
                outcome: "ContinuationDeliveryFailed",
                reason,
                deliveryFailure: true,
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              if (!/not found|404/i.test(message)) throw error;
            }
          });
        }
      );
      return { operationId: params.operationId, delivered: false };
    }

    return { operationId: params.operationId, delivered: true };
  }
}

async function fetchContinuationService(
  service: { fetch(request: Request): Promise<Response> },
  request: Request
): Promise<Response> {
  const started = recordTypedSubrequestStart({
    type: "custom",
    operationType: "serviceBinding",
    operationName: "workflowContinuationDelivery",
  });
  try {
    const response = await service.fetch(request);
    recordSubrequestFinish(started, response.status, response.ok);
    return response;
  } catch (error) {
    recordSubrequestFinish(started, "serviceBindingError", false);
    throw error;
  }
}
