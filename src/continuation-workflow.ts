import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { getOperationStore, runWithOperationStore, type OperationStoreEnv } from "./operation-store.js";

export interface ContinuationWorkflowParams {
  operationId: string;
  ownerHash: string;
  nextEligibleTime: string;
  scheduleIdentity: string;
}

interface ContinuationWorkflowEnv extends OperationStoreEnv {
  SUPEROPS_CONTINUATION_SERVICE?: { fetch(request: Request): Promise<Response> };
  SUPEROPS_INTERNAL_CONTINUATION_TOKEN?: string;
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

    await step.sleepUntil("wait-until-next-eligible", new Date(params.nextEligibleTime));
    try {
      await step.do(
        "deliver-checked-continuation",
        { retries: { limit: 8, delay: "1 second", backoff: "exponential" }, timeout: "30 seconds" },
        async () => {
        const service = this.env.SUPEROPS_CONTINUATION_SERVICE;
        const token = this.env.SUPEROPS_INTERNAL_CONTINUATION_TOKEN?.trim();
        if (!service || !token) throw new Error("Continuation service binding or token is unavailable.");

        await runWithOperationStore(this.env, async () => {
          const store = getOperationStore();
          const record = await store.get(params.operationId, params.ownerHash);
          if (!record || record.ownerHash !== params.ownerHash) return;
          await store.update(params.operationId, params.ownerHash, (current) => ({
            ...current,
            wakeAttemptCount: (current.wakeAttemptCount ?? 0) + 1,
            lastWakeAttemptAt: new Date().toISOString(),
          }));
        });

        const response = await service.fetch(new Request(
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
          if (!record || record.ownerHash !== params.ownerHash) return;
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
            const record = await store.get(params.operationId, params.ownerHash);
            if (!record || record.ownerHash !== params.ownerHash) return;
            await store.terminalizeContinuationFailure({
              operationId: params.operationId,
              ownerHash: params.ownerHash,
              errorClass: "ContinuationExecutionFailure",
              outcome: "ContinuationDeliveryFailed",
              reason,
              deliveryFailure: true,
            });
          });
        }
      );
      return { operationId: params.operationId, delivered: false };
    }

    return { operationId: params.operationId, delivered: true };
  }
}
