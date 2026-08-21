import {
  ExecutionBudgetExceededError,
  ExecutionTimeoutBudgetExceededError,
  ExecutionCpuBudgetExceededError,
  classifyCloudflarePlatformLimit,
  getExecutionConfig,
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
  type OperationItemState,
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
  verificationNotRequired?: boolean;
  stale?: boolean;
  failureReason?: string;
  retryCount?: number;
  nextEligibleTime?: string;
  result?: unknown;
  rateLimited?: boolean;
  errorClass?: OperationCompleteItemParams["patch"]["errorClass"];
  reliableResponseReceived?: boolean;
  observedMutationResult?: "Accepted" | "Rejected" | "VerifiedApplied" | "Ambiguous";
  retryDelaySource?: "retry-after" | "backoff";
  retryAfterSupplied?: boolean;
  suppliedDelayMs?: number;
  retryOperationName?: string;
  retryEndpoint?: string;
  durablePatch?: Partial<Omit<OperationItemState, "itemKey" | "idempotencyKey" | "lease" | "stage">>;
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

const DEFAULT_LEASE_MS = 180_000;

function isOperationItemLeaseMismatch(error: Error): boolean {
  return /Operation item lease mismatch:/.test(error.message);
}

export async function runOperationContinuation(
  params: RunOperationContinuationParams
): Promise<RunOperationContinuationResult> {
  const store = getOperationStore();
  let record = await store.get(params.operationId, params.ownerHash);
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

  const continuationConfig = getExecutionConfig();
  if (record.continuationCount >= continuationConfig.maxContinuationCount && record.pendingItems.length > 0) {
    record = await store.update(params.operationId, params.ownerHash, (current) => {
      const next = { ...current, itemStates: { ...current.itemStates } };
      for (const itemKey of current.pendingItems) {
        const item = current.itemStates[itemKey];
        if (!item) continue;
        const possibleWrite = item.writeMayHaveSucceeded && item.observedMutationResult !== "Rejected";
        const terminalReason = "Maximum continuation count reached.";
        const terminalStage: OperationItemStage = possibleWrite ? "AmbiguousWriteUnresolved" : "FailedBeforeWrite";
        next.itemStates[itemKey] = {
          ...item,
          stage: terminalStage,
          outcome: possibleWrite ? "AmbiguousWriteRequiresReconciliation" : "ContinuationLimitExceeded",
          ambiguousWrite: possibleWrite || item.ambiguousWrite,
          partialWrite: item.partialWrite,
          initialFailureReason: item.initialFailureReason ?? item.failureReason ?? terminalReason,
          initialErrorClass: item.initialErrorClass ?? item.errorClass ?? "ContinuationFailure",
          terminalFailureReason: terminalReason,
          terminalErrorClass: "ContinuationFailure",
          stageHistory: [...new Set([...(item.stageHistory ?? [item.stage]), terminalStage])],
          failureHistory: [
            ...(item.failureHistory ?? []),
            { stage: terminalStage, reason: terminalReason, errorClass: "ContinuationFailure" as const, retryCount: item.retryCount },
          ].slice(-8),
          replaySafe: !possibleWrite,
          humanReconciliationRequired: possibleWrite,
          errorClass: item.errorClass ?? "ContinuationFailure",
          failureReason: item.failureReason ?? terminalReason,
          lease: undefined,
        };
      }
      next.state = "CompletedWithFailures";
      next.nextEligibleTime = undefined;
      next.currentLease = undefined;
      next.terminalFailureReason = "Maximum continuation count reached.";
      return next;
    });
    return continuationResult(record, false, "ContinuationLimitExceeded");
  }

  const eligibilityNow = params.now ?? new Date().toISOString();
  if (record.nextEligibleTime && record.nextEligibleTime > eligibilityNow) {
    return continuationResult(record, true, "NotEligibleYet");
  }

  let processedThisInvocation = 0;
  let deferredNextEligibleTime: string | undefined;
  let deferredScheduleReason: string | undefined;
  let deferredRateLimitScheduleReason: string | undefined;
  for (;;) {
    if (record.pendingItems.length === 0) {
      return continuationResult(record, false);
    }
    if (processedThisInvocation >= getExecutionConfig().maxItemsPerBatch) {
      const batchRecord = record;
      if (!batchRecord) {
        throw new Error(`Operation disappeared before continuation batch boundary: ${params.operationId}`);
      }
      const pendingRateLimitItem = batchRecord.pendingItems
        .map((itemKey) => batchRecord.itemStates[itemKey])
        .find((item) => item?.stage === "RateLimitedRescheduled" || item?.rateLimit?.nextEligibleAt);
      const batchNextEligibleTime = deferredNextEligibleTime ??
        pendingRateLimitItem?.nextEligibleTime ?? pendingRateLimitItem?.rateLimit?.nextEligibleAt;
      const batchScheduleReason = deferredRateLimitScheduleReason ??
        (pendingRateLimitItem ? "SuperOpsRateLimitRescheduled" : deferredScheduleReason);
      record = await store.scheduleContinuation({
        operationId: params.operationId,
        ownerHash: params.ownerHash,
        reason: batchNextEligibleTime
          ? batchScheduleReason ?? "ContinuationRequiredWaitingForItem"
          : "ContinuationRequiredMaxItemsPerBatch",
        nextEligibleTime: batchNextEligibleTime,
      });
      return continuationResult(
        record,
        true,
        batchNextEligibleTime ? "ContinuationRequiredWaitingForItem" : "ContinuationRequiredMaxItemsPerBatch"
      );
    }
    if (!hasExecutionBudgetFor(2)) {
      const budgetRecord = record;
      if (!budgetRecord) {
        throw new Error(`Operation disappeared before continuation budget boundary: ${params.operationId}`);
      }
      const pendingRateLimitItem = budgetRecord.pendingItems
        .map((itemKey) => budgetRecord.itemStates[itemKey])
        .find((item) => item?.stage === "RateLimitedRescheduled" || item?.rateLimit?.nextEligibleAt);
      const budgetNextEligibleTime = deferredNextEligibleTime ??
        pendingRateLimitItem?.nextEligibleTime ?? pendingRateLimitItem?.rateLimit?.nextEligibleAt;
      const budgetScheduleReason = deferredRateLimitScheduleReason ??
        (pendingRateLimitItem ? "SuperOpsRateLimitRescheduled" : deferredScheduleReason);
      record = await store.scheduleContinuation({
        operationId: params.operationId,
        ownerHash: params.ownerHash,
        reason: budgetNextEligibleTime
          ? budgetScheduleReason ?? "ContinuationRequiredWaitingForItem"
          : "ContinuationRequiredBeforeClaim",
        nextEligibleTime: budgetNextEligibleTime,
      });
      return continuationResult(
        record,
        true,
        budgetNextEligibleTime ? "ContinuationRequiredWaitingForItem" : "ContinuationRequiredBeforeClaim"
      );
    }

    const claim = await store.claimNextItem({
      operationId: params.operationId,
      ownerHash: params.ownerHash,
      leaseOwner: params.leaseOwner,
      leaseMs: params.leaseMs ?? DEFAULT_LEASE_MS,
      // Injected test clocks remain fixed. Production claims use the current
      // time so later items do not inherit a lease expiry from invocation start.
      now: params.now ?? new Date().toISOString(),
    });
    if (!claim) {
      const currentRecord = (await store.get(params.operationId, params.ownerHash)) ?? record;
      if (!currentRecord) {
        throw new Error(`Operation disappeared while checking continuation eligibility: ${params.operationId}`);
      }
      record = currentRecord;
      const eligibilityTimes = currentRecord.pendingItems
        .map((itemKey) => currentRecord.itemStates[itemKey]?.nextEligibleTime)
        .filter((value): value is string => typeof value === "string")
        .sort();
      const nextEligibleTime = eligibilityTimes[0];
      if (nextEligibleTime) {
        record = await store.scheduleContinuation({
          operationId: params.operationId,
          ownerHash: params.ownerHash,
          reason: "ContinuationRequiredWaitingForItem",
          nextEligibleTime,
        });
        return continuationResult(record, true, "ContinuationRequiredWaitingForItem");
      }
      return continuationResult(record, currentRecord.pendingItems.length > 0, "NoEligibleItem");
    }

    record = (await store.get(params.operationId, params.ownerHash)) ?? record;
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
      const resolutionWrite = claim.item.stage === "ResolutionWriteStarted" ||
        claim.item.stage === "ResolutionWriteAmbiguous";
      const stagedWrite = claim.item.stage === "ClassificationWriteStarted" ||
        claim.item.stage === "StatusWriteStarted";
      const recoveryWrite = claim.item.stage === "RecoveryWriteStarted" ||
        claim.item.stage === "RecoveryWriteAmbiguous";
      const mutationBoundary = claim.item.stage === "WriteStarted" ||
        claim.item.stage === "WriteAmbiguous" || resolutionWrite || noteWrite || stagedWrite || recoveryWrite;
      // Only an in-flight mutation boundary becomes explicitly ambiguous.
      // A later durable stage (for example FieldsUpdated) already records a
      // reliable response and must retain that exact progress instead.
      const stage = mutationBoundary
        ? recoveryWrite
          ? "RecoveryWriteAmbiguous"
          : noteWrite
            ? "NoteWriteAmbiguous"
            : resolutionWrite
              ? "ResolutionWriteAmbiguous"
              : "WriteAmbiguous"
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
          errorClass: mutationBoundary ? "CloudflareConfiguredBudgetReached" : undefined,
          failureReason: mutationBoundary
            ? "Execution budget was insufficient to reconcile a possible write."
            : undefined,
        },
        result: mutationBoundary
          ? {
              itemKey: claim.itemKey,
              finalOutcome: "AmbiguousWriteRequiresVerification",
              writeAttempted: true,
              partialWrite: claim.item.partialWrite === true,
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
      let latestDurableItem = claim.item;
      const outcome = await withExecutionItem(claim.itemKey, () =>
        params.adapter.processItem({
          record: currentRecord,
          claim,
          checkpoint: async (patch) => {
            const checkpointed = await store.checkpointItem({
              operationId: params.operationId,
              ownerHash: params.ownerHash,
              itemKey: claim.itemKey,
              leaseId: claim.lease.leaseId,
              patch,
            });
            latestDurableItem = checkpointed.itemStates[claim.itemKey] ?? latestDurableItem;
            return checkpointed;
          },
        })
      );
      const config = getExecutionConfig();
      const priorRate = claim.item.rateLimit;
      const rateAttempts = outcome.rateLimited ? (priorRate?.attempts ?? 0) + 1 : 0;
      const rateObservedAtMs = Date.parse(params.now ?? new Date().toISOString());
      const rateObservedAt = new Date(rateObservedAtMs).toISOString();
      const firstThrottledAt = priorRate?.firstThrottledAt ?? (outcome.rateLimited ? rateObservedAt : undefined);
      const previousActualDelayMs = priorRate?.scheduledAt
        ? Math.max(0, rateObservedAtMs - Date.parse(priorRate.scheduledAt))
        : priorRate?.actualDelayMs;
      const adapterRequestedDelayMs = outcome.nextEligibleTime
        ? Math.max(0, Date.parse(outcome.nextEligibleTime) - rateObservedAtMs)
        : 0;
      const durableBackoffDelayMs = outcome.rateLimited && outcome.retryAfterSupplied !== true
        ? Math.min(
            config.maxDurableRetryDurationMs,
            config.durableBackoffBaseDelayMs * 2 ** Math.max(0, rateAttempts - 1)
          )
        : 0;
      // Adapter timestamps can be consumed by checkpoint persistence before
      // the continuation reaches this durable scheduling boundary. Rebase the
      // wait on the observation time and enforce a durable backoff floor when
      // SuperOps supplied no usable Retry-After value.
      const requestedDelayMs = outcome.rateLimited
        ? Math.max(adapterRequestedDelayMs, durableBackoffDelayMs)
        : adapterRequestedDelayMs;
      const cappedDelayMs = Math.min(requestedDelayMs, config.maxDurableSingleWaitMs);
      const totalRetryDurationMs = (priorRate?.totalRetryDurationMs ?? 0) + cappedDelayMs;
      const durableRetryExhausted = outcome.rateLimited && (
        rateAttempts > config.maxDurableRetryAttempts ||
        totalRetryDurationMs > config.maxDurableRetryDurationMs ||
        record.continuationCount >= config.maxContinuationCount
      );
      const adapterOutcome: ContinuationItemOutcome = durableRetryExhausted
        ? {
            ...outcome,
            stage: "RateLimitExceeded",
            outcome: "RateLimitExceeded",
            nextEligibleTime: undefined,
            rateLimited: false,
            errorClass: "RateLimitExceeded",
            failureReason: "Durable rate-limit retry ceiling was reached.",
          }
        : outcome;
      const writeAttempted = latestDurableItem.writeAttempted || adapterOutcome.writeAttempted;
      const conclusiveRejection = adapterOutcome.reliableResponseReceived === true &&
        adapterOutcome.observedMutationResult === "Rejected" &&
        adapterOutcome.partialWrite !== true;
      const writeMayHaveSucceeded = conclusiveRejection
        ? adapterOutcome.writeMayHaveSucceeded
        : latestDurableItem.writeMayHaveSucceeded || adapterOutcome.writeMayHaveSucceeded;
      const effectiveOutcome: ContinuationItemOutcome = {
        ...adapterOutcome,
        // writeAttempted is durable history and cannot be erased by a fresh
        // adapter result. writeMayHaveSucceeded can clear only when the current
        // outcome proves a reliable rejection.
        writeAttempted,
        writeMayHaveSucceeded,
        result: typeof adapterOutcome.result === "object" && adapterOutcome.result !== null &&
            !Array.isArray(adapterOutcome.result)
          ? { ...adapterOutcome.result as Record<string, unknown>, writeAttempted, writeMayHaveSucceeded }
          : adapterOutcome.result,
      };
      if (outcome.rateLimited) {
        effectiveOutcome.nextEligibleTime = new Date(rateObservedAtMs + cappedDelayMs).toISOString();
      }
      try {
        record = await store.completeItem({
          operationId: params.operationId,
          ownerHash: params.ownerHash,
          itemKey: claim.itemKey,
          leaseId: claim.lease.leaseId,
          patch: {
            ...effectiveOutcome.durablePatch,
            stage: effectiveOutcome.stage,
            outcome: effectiveOutcome.outcome,
            writeAttempted: effectiveOutcome.writeAttempted,
            writeMayHaveSucceeded: effectiveOutcome.writeMayHaveSucceeded,
            partialWrite: effectiveOutcome.partialWrite,
            verificationState: effectiveOutcome.verified
              ? "Verified"
              : effectiveOutcome.verificationFailed
                ? "Failed"
                : effectiveOutcome.verificationNotRequired ||
                    (
                      effectiveOutcome.stage === "Completed" &&
                      !effectiveOutcome.writeAttempted &&
                      !effectiveOutcome.writeMayHaveSucceeded &&
                      !effectiveOutcome.partialWrite
                    )
                  ? "NotRequired"
                  : undefined,
            retryCount: effectiveOutcome.retryCount,
            nextEligibleTime: effectiveOutcome.nextEligibleTime,
            failureReason: effectiveOutcome.failureReason,
            errorClass: effectiveOutcome.errorClass,
            reliableResponseReceived: effectiveOutcome.reliableResponseReceived,
            observedMutationResult: effectiveOutcome.observedMutationResult,
            rateLimit: outcome.rateLimited
              ? {
                  endpoint: effectiveOutcome.retryEndpoint ?? "SuperOps GraphQL /msp",
                  operationName: effectiveOutcome.retryOperationName ?? (claim.item.mutationType === "note" ? "CreateTicketNote" : "UpdateTicket"),
                  source: effectiveOutcome.retryDelaySource ?? (effectiveOutcome.retryAfterSupplied ? "retry-after" : "backoff"),
                  attempts: rateAttempts,
                  suppliedDelayMs: effectiveOutcome.suppliedDelayMs,
                  parsedDelayMs: requestedDelayMs,
                  cappedDelayMs,
                  appliedDelayMs: cappedDelayMs,
                  actualDelayMs: previousActualDelayMs,
                  scheduledAt: rateObservedAt,
                  firstThrottledAt,
                  totalRetryDurationMs,
                  totalElapsedMs: firstThrottledAt ? rateObservedAtMs - Date.parse(firstThrottledAt) : undefined,
                  nextEligibleAt: effectiveOutcome.nextEligibleTime,
                  retryAfterSupplied: effectiveOutcome.retryAfterSupplied === true,
                  continuedInAnotherInvocation: effectiveOutcome.stage === "RateLimitedRescheduled",
                  writeAttempted: effectiveOutcome.writeAttempted,
                  finalResult: effectiveOutcome.outcome,
                }
              : priorRate
                ? {
                    ...priorRate,
                    actualDelayMs: previousActualDelayMs,
                    totalElapsedMs: priorRate.firstThrottledAt
                      ? rateObservedAtMs - Date.parse(priorRate.firstThrottledAt)
                      : priorRate.totalElapsedMs,
                    continuedInAnotherInvocation: true,
                    finalResult: effectiveOutcome.outcome,
                  }
                : undefined,
          },
          result: effectiveOutcome.result ?? {
            itemKey: claim.itemKey,
            finalOutcome: effectiveOutcome.outcome,
            writeAttempted: effectiveOutcome.writeAttempted,
            partialWrite: effectiveOutcome.partialWrite,
            verified: Boolean(effectiveOutcome.verified),
          },
        });
      } catch (error) {
        if (typeof error === "object" && error !== null) {
          (error as { conservativeOutcome?: ContinuationItemOutcome }).conservativeOutcome = effectiveOutcome;
        }
        throw error;
      }
      const completedRecord = record;
      if (!completedRecord) {
        throw new Error(`Operation disappeared after completing item: ${params.operationId}`);
      }
      processedThisInvocation += 1;
      markExecutionItem({
        completed: effectiveOutcome.stage.startsWith("Completed") || effectiveOutcome.stage === "Completed" ||
          effectiveOutcome.stage === "RateLimitExceeded",
        remainingItems: completedRecord.pendingItems.length + completedRecord.unattemptedItems.length,
        partialWrite: effectiveOutcome.partialWrite,
        stale: effectiveOutcome.stale,
        verificationFailure: effectiveOutcome.verificationFailed,
      });

      if (effectiveOutcome.stage === "RateLimitedRescheduled" || effectiveOutcome.nextEligibleTime) {
        const otherPendingItem = completedRecord.pendingItems.some((itemKey) =>
          itemKey !== claim.itemKey && ![
            "Completed", "CompletedAfterRetry", "CompletedAfterAmbiguousWriteVerification",
            "FailedBeforeWrite", "FailedAfterPartialWrite", "AmbiguousWriteUnresolved",
            "RateLimitExceeded", "Stale", "StaleAfterRateLimitWait", "Skipped",
          ].includes(completedRecord.itemStates[itemKey]?.stage ?? "")
        );
        if (otherPendingItem) {
          // A delayed item carries its own eligibility checkpoint. Continue
          // with other candidates in this batch before setting the operation-
          // level wake time, so one ambiguous note does not block unrelated
          // read/write-safe candidates.
          if (effectiveOutcome.nextEligibleTime && (
            !deferredNextEligibleTime || effectiveOutcome.nextEligibleTime < deferredNextEligibleTime
          )) {
            deferredNextEligibleTime = effectiveOutcome.nextEligibleTime;
            deferredScheduleReason = effectiveOutcome.outcome;
          }
          if (effectiveOutcome.stage === "RateLimitedRescheduled") {
            deferredRateLimitScheduleReason = effectiveOutcome.outcome;
          }
          continue;
        }
        record = await store.scheduleContinuation({
          operationId: params.operationId,
          ownerHash: params.ownerHash,
          reason: effectiveOutcome.outcome,
          nextEligibleTime: effectiveOutcome.nextEligibleTime,
        });
        return continuationResult(record, true, effectiveOutcome.outcome);
      }
    } catch (error) {
      const caughtError = error instanceof Error ? error : new Error(String(error));
      if (isOperationItemLeaseMismatch(caughtError)) {
        // A newer continuation owns this item. This invocation must not
        // terminalize or overwrite its durable progress.
        record = (await store.get(params.operationId, params.ownerHash)) ?? record;
        return continuationResult(
          record,
          record.pendingItems.length > 0,
          "OperationItemLeaseLost"
        );
      }
      const platformLimit = classifyCloudflarePlatformLimit(caughtError);
      if (
        caughtError instanceof ExecutionBudgetExceededError ||
        caughtError instanceof ExecutionTimeoutBudgetExceededError ||
        caughtError instanceof ExecutionCpuBudgetExceededError ||
        platformLimit !== undefined
      ) {
        // The adapter may have durably crossed a mutation-start boundary before
        // a later read or write consumed the last available subrequest. Read
        // the current state rather than trusting the original claim: completing
        // that item as an ordinary reschedule would both erase the checkpoint
        // and permit a duplicate write on the next invocation.
        const currentItem = (await store.get(params.operationId, params.ownerHash))?.itemStates[claim.itemKey];
        const hasPriorWrite = currentItem?.writeAttempted === true ||
          currentItem?.writeMayHaveSucceeded === true;

        const noteWrite = currentItem?.stage === "NoteWriteStarted" ||
          currentItem?.stage === "NoteWriteAmbiguous";
        const resolutionWrite = currentItem?.stage === "ResolutionWriteStarted" ||
          currentItem?.stage === "ResolutionWriteAmbiguous";
        const stagedWrite = currentItem?.stage === "ClassificationWriteStarted" ||
          currentItem?.stage === "StatusWriteStarted";
        const recoveryWrite = currentItem?.stage === "RecoveryWriteStarted" ||
          currentItem?.stage === "RecoveryWriteAmbiguous";
        const mutationBoundary = currentItem?.stage === "WriteStarted" ||
          currentItem?.stage === "WriteAmbiguous" || resolutionWrite || noteWrite || stagedWrite || recoveryWrite;
        const preservedStage = currentItem?.stage ?? "Rescheduled";
        record = await store.completeItem({
          operationId: params.operationId,
          ownerHash: params.ownerHash,
          itemKey: claim.itemKey,
          leaseId: claim.lease.leaseId,
          patch: {
            stage: mutationBoundary
              ? recoveryWrite
                ? "RecoveryWriteAmbiguous"
                : noteWrite
                  ? "NoteWriteAmbiguous"
                  : resolutionWrite
                    ? "ResolutionWriteAmbiguous"
                    : "WriteAmbiguous"
              : hasPriorWrite ? preservedStage : "Rescheduled",
            outcome: mutationBoundary
              ? "AmbiguousWriteRequiresVerification"
              : caughtError instanceof ExecutionBudgetExceededError
                ? "CloudflareSubrequestBudgetReached"
                : caughtError instanceof ExecutionCpuBudgetExceededError
                  ? "CloudflareCpuLimit"
                  : platformLimit ?? "CloudflareExecutionTimeout",
            writeAttempted: currentItem?.writeAttempted === true,
            writeMayHaveSucceeded: currentItem?.writeMayHaveSucceeded === true,
            partialWrite: currentItem?.partialWrite === true,
            verificationState: "Pending",
            errorClass: caughtError instanceof ExecutionBudgetExceededError
              ? "CloudflareConfiguredBudgetReached"
              : caughtError instanceof ExecutionCpuBudgetExceededError
                ? "CloudflareCpuLimit"
                : platformLimit ?? "CloudflareExecutionTimeout",
            failureReason: mutationBoundary
              ? `Execution stopped after a mutation-start checkpoint: ${caughtError.message}`
              : caughtError.message,
          },
          result: mutationBoundary
            ? {
                itemKey: claim.itemKey,
                finalOutcome: "AmbiguousWriteRequiresVerification",
                writeAttempted: true,
                partialWrite: currentItem?.partialWrite === true,
              }
            : undefined,
        });
        record = await store.scheduleContinuation({
          operationId: params.operationId,
          ownerHash: params.ownerHash,
          reason: caughtError.name,
        });
        return continuationResult(record, true, caughtError.name);
      }
      if (caughtError.name === "DurableCheckpointError" || caughtError.message.startsWith("Durable checkpoint failed")) {
        let currentItem = claim.item;
        try {
          currentItem = (await store.get(params.operationId, params.ownerHash))?.itemStates[claim.itemKey] ?? claim.item;
        } catch {
          currentItem = claim.item;
        }
        const checkpointProgressPersisted = currentItem.stage !== claim.item.stage ||
          currentItem.writeAttempted !== claim.item.writeAttempted ||
          currentItem.writeMayHaveSucceeded !== claim.item.writeMayHaveSucceeded ||
          currentItem.partialWrite !== claim.item.partialWrite ||
          currentItem.observedMutationResult !== claim.item.observedMutationResult ||
          currentItem.retryCount !== claim.item.retryCount;
        if (checkpointProgressPersisted) {
          throw error;
        }
        const possibleWrite = currentItem.writeMayHaveSucceeded === true &&
          currentItem.observedMutationResult !== "Rejected";
        const failureReason = caughtError.message +
          " This operation was terminalized because a required durable checkpoint could not be persisted; submit a fresh operation after the code defect or durable-store failure is corrected.";
        const conservativeOutcome: ContinuationItemOutcome = {
          stage: possibleWrite ? "AmbiguousWriteUnresolved" : "FailedBeforeWrite",
          outcome: possibleWrite ? "AmbiguousWriteRequiresReconciliation" : "OperationStoreFailure",
          writeAttempted: currentItem.writeAttempted === true,
          writeMayHaveSucceeded: currentItem.writeMayHaveSucceeded === true,
          partialWrite: currentItem.partialWrite === true,
          failureReason,
          errorClass: "OperationStoreFailure",
          result: {
            itemKey: claim.itemKey,
            finalOutcome: possibleWrite ? "AmbiguousWriteRequiresReconciliation" : "OperationStoreFailure",
            writeAttempted: currentItem.writeAttempted === true,
            writeMayHaveSucceeded: currentItem.writeMayHaveSucceeded === true,
            partialWrite: currentItem.partialWrite === true,
            failureReason,
          },
        };
        (caughtError as { conservativeOutcome?: ContinuationItemOutcome }).conservativeOutcome = conservativeOutcome;
        record = await store.terminalizeContinuationFailure({
          operationId: params.operationId,
          ownerHash: params.ownerHash,
          errorClass: "OperationStoreFailure",
          outcome: "OperationStoreFailed",
          reason: failureReason,
        });
        return continuationResult(record, false, "OperationStoreFailure");
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
