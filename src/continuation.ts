import {
  ExecutionBudgetExceededError,
  ExecutionTimeoutBudgetExceededError,
  hasExecutionBudgetFor,
  markExecutionItem,
  withExecutionItem,
} from "./execution.js";
import {
  getOperationStore,
  operationResultView,
  type OperationCompleteItemParams,
  type OperationItemClaim,
  type OperationItemStage,
  type OperationLedgerRecord,
} from "./operation-store.js";

export interface ContinuationItemContext {
  record: OperationLedgerRecord;
  claim: OperationItemClaim;
  checkpoint(patch: OperationCompleteItemParams["patch"]): Promise<OperationLedgerRecord>;
}

export interface ContinuationItemOutcome {
  stage: OperationItemStage;
  outcome: string;
  writeAttempted: boolean;
  writeMayHaveSucceeded: boolean;
  partialWrite: boolean;
  verified?: boolean;
  verificationFailed?: boolean;
  stale?: boolean;
  failureReason?: string;
  retryCount?: number;
  nextEligibleTime?: string;
  result?: unknown;
  rateLimited?: boolean;
  errorClass?: OperationCompleteItemParams["patch"]["errorClass"];
}

export interface OperationContinuationAdapter {
  toolName: string;
  estimateItemSubrequests(record: OperationLedgerRecord, itemKey: string): number;
  processItem(context: ContinuationItemContext): Promise<ContinuationItemOutcome>;
}

export interface RunOperationContinuationParams {
  operationId: string;
  ownerHash: string;
  adapter: OperationContinuationAdapter;
  leaseOwner: string;
  leaseMs?: number;
  now?: string;
}

export interface RunOperationContinuationResult {
  operationId: string;
  state: string;
  completedItems: number;
  pendingItems: number;
  failedItems: number;
  skippedItems: number;
  unattemptedItems: number;
  continuationRequired: boolean;
  stopReason?: string;
  view: Record<string, unknown>;
}

const DEFAULT_LEASE_MS = 60_000;

export async function runOperationContinuation(
  params: RunOperationContinuationParams
): Promise<RunOperationContinuationResult> {
  const store = getOperationStore();
  let record = await store.get(params.operationId);
  if (!record) {
    throw new Error(`Operation not found: ${params.operationId}`);
  }
  if (record.ownerHash !== params.ownerHash) {
    throw new Error("Operation was not found or is not visible to this caller.");
  }
  if (record.toolName !== params.adapter.toolName) {
    throw new Error(
      `Continuation adapter mismatch: ${params.adapter.toolName} cannot resume ${record.toolName}.`
    );
  }

  const now = params.now ?? new Date().toISOString();
  if (record.nextEligibleTime && record.nextEligibleTime > now) {
    return continuationResult(record, true, "NotEligibleYet");
  }

  for (;;) {
    if (!hasExecutionBudgetFor(2)) {
      record = await store.scheduleContinuation({
        operationId: params.operationId,
        ownerHash: params.ownerHash,
        reason: "ContinuationRequiredBeforeClaim",
      });
      return continuationResult(record, true, "ContinuationRequiredBeforeClaim");
    }

    const claim = await store.claimNextItem({
      operationId: params.operationId,
      ownerHash: params.ownerHash,
      leaseOwner: params.leaseOwner,
      leaseMs: params.leaseMs ?? DEFAULT_LEASE_MS,
      now,
    });
    if (!claim) {
      record = (await store.get(params.operationId)) ?? record;
      return continuationResult(record, record.pendingItems.length > 0, "NoEligibleItem");
    }

    record = (await store.get(params.operationId)) ?? record;
    const estimated = params.adapter.estimateItemSubrequests(record, claim.itemKey);
    if (!hasExecutionBudgetFor(estimated)) {
      // A resumed item may already be across a durable mutation boundary. Do
      // not turn it into an ordinary reschedule just because this invocation
      // cannot fund its reconciliation unit: that would lose the ambiguity
      // marker and could permit a duplicate mutation on a later invocation.
      const hasPriorWrite = claim.item.writeAttempted === true ||
        claim.item.writeMayHaveSucceeded === true;
      const noteWrite = claim.item.stage === "NoteWriteStarted" ||
        claim.item.stage === "NoteWriteAmbiguous";
      const mutationBoundary = claim.item.stage === "WriteStarted" ||
        claim.item.stage === "WriteAmbiguous" || noteWrite;
      // Only an in-flight mutation boundary becomes explicitly ambiguous.
      // A later durable stage (for example FieldsUpdated) already records a
      // reliable response and must retain that exact progress instead.
      const stage = mutationBoundary
        ? noteWrite ? "NoteWriteAmbiguous" : "WriteAmbiguous"
        : hasPriorWrite ? claim.item.stage : "Rescheduled";
      record = await store.completeItem({
        operationId: params.operationId,
        ownerHash: params.ownerHash,
        itemKey: claim.itemKey,
        leaseId: claim.lease.leaseId,
        patch: {
          stage,
          outcome: mutationBoundary
            ? "AmbiguousWriteRequiresVerification"
            : "NotAttemptedExecutionBudget",
          writeAttempted: claim.item.writeAttempted,
          writeMayHaveSucceeded: claim.item.writeMayHaveSucceeded,
          partialWrite: claim.item.partialWrite === true,
          verificationState: "Pending",
          errorClass: mutationBoundary ? "CloudflareSubrequestBudget" : undefined,
          failureReason: mutationBoundary
            ? "Execution budget was insufficient to reconcile a possible write."
            : undefined,
        },
        result: mutationBoundary
          ? {
              itemKey: claim.itemKey,
              finalOutcome: "AmbiguousWriteRequiresVerification",
              writeAttempted: true,
              partialWrite: true,
            }
          : {
              itemKey: claim.itemKey,
              finalOutcome: "NotAttemptedExecutionBudget",
              writeAttempted: false,
              partialWrite: false,
            },
      });
      record = await store.scheduleContinuation({
        operationId: params.operationId,
        ownerHash: params.ownerHash,
        reason: "ContinuationRequiredBeforeItem",
      });
      return continuationResult(record, true, "ContinuationRequiredBeforeItem");
    }

    try {
      const currentRecord = record;
      const outcome = await withExecutionItem(claim.itemKey, () =>
        params.adapter.processItem({
          record: currentRecord,
          claim,
          checkpoint: (patch) => store.checkpointItem({
            operationId: params.operationId,
            ownerHash: params.ownerHash,
            itemKey: claim.itemKey,
            leaseId: claim.lease.leaseId,
            patch,
          }),
        })
      );
      record = await store.completeItem({
        operationId: params.operationId,
        ownerHash: params.ownerHash,
        itemKey: claim.itemKey,
        leaseId: claim.lease.leaseId,
        patch: {
          stage: outcome.stage,
          outcome: outcome.outcome,
          writeAttempted: outcome.writeAttempted,
          writeMayHaveSucceeded: outcome.writeMayHaveSucceeded,
          partialWrite: outcome.partialWrite,
          verificationState: outcome.verified
            ? "Verified"
            : outcome.verificationFailed
              ? "Failed"
              : undefined,
          retryCount: outcome.retryCount,
          nextEligibleTime: outcome.nextEligibleTime,
          failureReason: outcome.failureReason,
          errorClass: outcome.errorClass,
          rateLimit: outcome.rateLimited
            ? {
                attempts: Math.max(1, outcome.retryCount ?? 1),
                retryAfterSupplied: Boolean(outcome.nextEligibleTime),
                continuedInAnotherInvocation: outcome.stage === "RateLimitedRescheduled",
                writeAttempted: outcome.writeAttempted,
                finalResult: outcome.outcome,
              }
            : undefined,
        },
        result: outcome.result ?? {
          itemKey: claim.itemKey,
          finalOutcome: outcome.outcome,
          writeAttempted: outcome.writeAttempted,
          partialWrite: outcome.partialWrite,
          verified: Boolean(outcome.verified),
        },
      });
      markExecutionItem({
        completed: outcome.stage.startsWith("Completed") || outcome.stage === "Completed",
        remainingItems: record.pendingItems.length + record.unattemptedItems.length,
        partialWrite: outcome.partialWrite,
        stale: outcome.stale,
        verificationFailure: outcome.verificationFailed,
      });

      if (outcome.stage === "RateLimitedRescheduled" || outcome.nextEligibleTime) {
        record = await store.scheduleContinuation({
          operationId: params.operationId,
          ownerHash: params.ownerHash,
          reason: outcome.outcome,
          nextEligibleTime: outcome.nextEligibleTime,
        });
        return continuationResult(record, true, outcome.outcome);
      }
    } catch (error) {
      if (
        error instanceof ExecutionBudgetExceededError ||
        error instanceof ExecutionTimeoutBudgetExceededError
      ) {
        // The adapter may have durably crossed a mutation-start boundary before
        // a later read or write consumed the last available subrequest. Read
        // the current state rather than trusting the original claim: completing
        // that item as an ordinary reschedule would both erase the checkpoint
        // and permit a duplicate write on the next invocation.
        const currentItem = (await store.get(params.operationId))?.itemStates[claim.itemKey];
        const possibleWrite = currentItem?.writeAttempted === true ||
          currentItem?.writeMayHaveSucceeded === true;
        const noteWrite = currentItem?.stage === "NoteWriteStarted" ||
          currentItem?.stage === "NoteWriteAmbiguous";
        record = await store.completeItem({
          operationId: params.operationId,
          ownerHash: params.ownerHash,
          itemKey: claim.itemKey,
          leaseId: claim.lease.leaseId,
          patch: {
            stage: possibleWrite
              ? noteWrite ? "NoteWriteAmbiguous" : "WriteAmbiguous"
              : "Rescheduled",
            outcome: possibleWrite
              ? "AmbiguousWriteRequiresVerification"
              : error instanceof ExecutionBudgetExceededError
                ? "CloudflareSubrequestBudgetReached"
                : "CloudflareExecutionTimeout",
            writeAttempted: possibleWrite || currentItem?.writeAttempted === true,
            writeMayHaveSucceeded: possibleWrite || currentItem?.writeMayHaveSucceeded === true,
            partialWrite: possibleWrite || currentItem?.partialWrite === true,
            verificationState: "Pending",
            errorClass: error instanceof ExecutionBudgetExceededError
              ? "CloudflareSubrequestBudget"
              : "CloudflareExecutionTimeout",
            failureReason: possibleWrite
              ? `Execution stopped after a mutation-start checkpoint: ${error.message}`
              : error.message,
          },
          result: possibleWrite
            ? {
                itemKey: claim.itemKey,
                finalOutcome: "AmbiguousWriteRequiresVerification",
                writeAttempted: true,
                partialWrite: true,
              }
            : undefined,
        });
        record = await store.scheduleContinuation({
          operationId: params.operationId,
          ownerHash: params.ownerHash,
          reason: error.name,
        });
        return continuationResult(record, true, error.name);
      }
      throw error;
    }
  }
}

function continuationResult(
  record: OperationLedgerRecord,
  continuationRequired: boolean,
  stopReason?: string
): RunOperationContinuationResult {
  return {
    operationId: record.operationId,
    state: record.state,
    completedItems: record.completedItems.length,
    pendingItems: record.pendingItems.length,
    failedItems: record.failedItems.length,
    skippedItems: record.skippedItems.length,
    unattemptedItems: record.unattemptedItems.length,
    continuationRequired,
    stopReason,
    view: operationResultView(record),
  };
}


