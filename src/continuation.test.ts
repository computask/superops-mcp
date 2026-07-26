import { describe, expect, it } from "vitest";
import {
  ExecutionBudgetExceededError,
  getExecutionState,
  recordSubrequestFinish,
  recordTypedSubrequestStart,
  runWithExecutionConfig,
  runWithExecutionContext,
} from "./execution.js";
import { runOperationContinuation, type OperationContinuationAdapter } from "./continuation.js";
import {
  getOperationStore,
  runWithOperationStore,
  stableHash,
  type OperationItemState,
  type OperationLedgerRecord,
} from "./operation-store.js";

function ledgerRecord(params: {
  operationId: string;
  ownerHash: string;
  itemCount?: number;
  itemKeys?: string[];
}): OperationLedgerRecord {
  const expectedItems = params.itemKeys ?? Array.from({ length: params.itemCount ?? 3 }, (_, index) => `ticket-${index + 1}`);
  const itemStates = expectedItems.reduce<Record<string, OperationItemState>>((states, itemKey) => {
    states[itemKey] = {
      itemKey,
      stage: "Pending",
      idempotencyKey: stableHash({ operationId: params.operationId, itemKey }),
      writeAttempted: false,
      writeMayHaveSucceeded: false,
      partialWrite: false,
      verificationState: "Pending",
      retryCount: 0,
    };
    return states;
  }, {});

  return {
    responseVersion: 1,
    operationId: params.operationId,
    toolName: "test_batch_tool",
    ownerHash: params.ownerHash,
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z",
    expiresAt: "2026-07-19T00:00:00.000Z",
    originalRequestHash: stableHash({ operationId: params.operationId }),
    state: "Running",
    expectedItems,
    completedItems: [],
    failedItems: [],
    skippedItems: [],
    unattemptedItems: [],
    pendingItems: expectedItems,
    itemStates,
    summary: {},
    compactResults: [],
    partialWriteCount: 0,
    ambiguousWriteCount: 0,
    rateLimitedItems: [],
    continuationCount: 0,
  };
}

function countedRequest(type: "write" | "verificationRead" = "write"): void {
  const request = recordTypedSubrequestStart({
    type,
    operationType: type === "write" ? "mutation" : "query",
    operationName: type === "write" ? "testMutation" : "testVerify",
  });
  recordSubrequestFinish(request, 200, true);
}

function completingAdapter(processed: Map<string, number>): OperationContinuationAdapter {
  return {
    toolName: "test_batch_tool",
    estimateItemSubrequests: () => 2,
    async processItem({ claim }) {
      countedRequest("write");
      countedRequest("verificationRead");
      processed.set(claim.itemKey, (processed.get(claim.itemKey) ?? 0) + 1);
      return {
        stage: "Completed",
        outcome: "Updated",
        writeAttempted: true,
        writeMayHaveSucceeded: true,
        partialWrite: false,
        verified: true,
        result: {
          itemKey: claim.itemKey,
          finalOutcome: "Updated",
          writeAttempted: true,
          partialWrite: false,
          verified: true,
        },
      };
    },
  };
}

describe("durable continuation runner", () => {
  it("continues a 250-item operation across fresh invocation budgets without duplicate writes", async () => {
    const ownerHash = stableHash("owner@example.com");
    const processed = new Map<string, number>();
    const adapter = completingAdapter(processed);
    const subrequestsByInvocation: number[] = [];
    let resultState = "";
    let continuationRequired = true;
    let continuations = 0;

    await runWithOperationStore({}, async () => {
      await getOperationStore().put(
        ledgerRecord({ operationId: "op-250", ownerHash, itemCount: 250 })
      );

      while (continuationRequired && continuations < 100) {
        continuations += 1;
        await runWithExecutionConfig(
          {
            SUPEROPS_EXECUTION_SUBREQUEST_BUDGET: "12",
            SUPEROPS_EXECUTION_SUBREQUEST_SAFETY_MARGIN: "2",
            SUPEROPS_EXECUTION_MAX_DURATION_MS: "25000",
            SUPEROPS_EXECUTION_SAFE_REMAINING_TIME_MS: "0",
          },
          async () => {
            await runWithExecutionContext("test_batch_tool", async () => {
              const result = await runOperationContinuation({
                operationId: "op-250",
                ownerHash,
                adapter,
                leaseOwner: `invocation-${continuations}`,
                leaseMs: 60_000,
                now: `2026-07-18T00:${String(continuations).padStart(2, "0")}:00.000Z`,
              });
              resultState = result.state;
              continuationRequired = result.continuationRequired;
              subrequestsByInvocation.push(getExecutionState()?.subrequests ?? 0);
            });
          }
        );
      }

      const finalRecord = await getOperationStore().get("op-250");
      expect(finalRecord).toMatchObject({
        state: "Completed",
        completedItems: expect.arrayContaining(["ticket-1", "ticket-250"]),
        pendingItems: [],
      });
    });

    expect(resultState).toBe("Completed");
    expect(continuations).toBeGreaterThan(1);
    expect(Math.max(...subrequestsByInvocation)).toBeLessThanOrEqual(10);
    expect(processed.size).toBe(250);
    expect([...processed.values()].filter((count) => count !== 1)).toHaveLength(0);
  });

  it("yields without terminalizing when a newer continuation owns the item lease", async () => {
    const ownerHash = stableHash("owner@example.com");
    let replacementLeaseId: string | undefined;
    const adapter: OperationContinuationAdapter = {
      toolName: "test_batch_tool",
      estimateItemSubrequests: () => 1,
      async processItem({ claim, checkpoint }) {
        const replacement = await getOperationStore().claimNextItem({
          operationId: claim.operationId,
          ownerHash,
          leaseOwner: "newer-continuation",
          leaseMs: 60_000,
          now: "2026-07-18T00:00:01.000Z",
        });
        replacementLeaseId = replacement?.lease.leaseId;
        await checkpoint({
          stage: "Validating",
          writeAttempted: false,
          writeMayHaveSucceeded: false,
          partialWrite: false,
          verificationState: "Pending",
        });
        throw new Error("obsolete continuation checkpoint unexpectedly succeeded");
      },
    };

    await runWithOperationStore({}, async () => {
      const store = getOperationStore();
      await store.put(ledgerRecord({
        operationId: "op-lease-handoff",
        ownerHash,
        itemKeys: ["ticket-lease"],
      }));

      const result = await runWithExecutionConfig({}, () =>
        runWithExecutionContext("test_batch_tool", () =>
          runOperationContinuation({
            operationId: "op-lease-handoff",
            ownerHash,
            adapter,
            leaseOwner: "obsolete-continuation",
            leaseMs: 1,
            now: "2026-07-18T00:00:00.000Z",
          })
        )
      );

      expect(result).toMatchObject({
        state: "Running",
        continuationRequired: true,
        stopReason: "OperationItemLeaseLost",
      });
      const stored = await store.get("op-lease-handoff", ownerHash);
      expect(stored?.terminalFailureReason).toBeUndefined();
      expect(stored).toMatchObject({
        state: "Running",
        failedItems: [],
        pendingItems: ["ticket-lease"],
        itemStates: {
          "ticket-lease": {
            stage: "Pending",
            lease: {
              leaseId: replacementLeaseId,
              owner: "newer-continuation",
            },
          },
        },
      });
    });
  });
  it("reschedules a long Retry-After item and resumes only after it is eligible", async () => {
    const ownerHash = stableHash("owner@example.com");
    const attempts = new Map<string, number>();
    const adapter: OperationContinuationAdapter = {
      toolName: "test_batch_tool",
      estimateItemSubrequests: () => 1,
      async processItem({ claim }) {
        countedRequest("write");
        const attempt = (attempts.get(claim.itemKey) ?? 0) + 1;
        attempts.set(claim.itemKey, attempt);
        if (claim.itemKey === "ticket-rate" && attempt === 1) {
          return {
            stage: "RateLimitedRescheduled",
            outcome: "RateLimitedRescheduled",
            writeAttempted: false,
            writeMayHaveSucceeded: false,
            partialWrite: false,
            nextEligibleTime: "2026-07-18T00:10:00.000Z",
            retryCount: 1,
            rateLimited: true,
            errorClass: "SuperOpsRateLimit",
          };
        }
        return {
          stage: "CompletedAfterRetry",
          outcome: "CompletedAfterRetry",
          writeAttempted: true,
          writeMayHaveSucceeded: true,
          partialWrite: false,
          verified: true,
        };
      },
    };

    await runWithOperationStore({}, async () => {
      await getOperationStore().put(
        ledgerRecord({ operationId: "op-rate", ownerHash, itemKeys: ["ticket-rate"] })
      );

      await runWithExecutionConfig({}, async () => {
        await runWithExecutionContext("test_batch_tool", async () => {
          const first = await runOperationContinuation({
            operationId: "op-rate",
            ownerHash,
            adapter,
            leaseOwner: "invocation-1",
            now: "2026-07-18T00:00:00.000Z",
          });
          expect(first).toMatchObject({
            state: "Rescheduled",
            continuationRequired: true,
            stopReason: "RateLimitedRescheduled",
          });
        });
      });

      await runWithExecutionConfig({}, async () => {
        await runWithExecutionContext("test_batch_tool", async () => {
          const tooEarly = await runOperationContinuation({
            operationId: "op-rate",
            ownerHash,
            adapter,
            leaseOwner: "invocation-2",
            now: "2026-07-18T00:05:00.000Z",
          });
          expect(tooEarly.stopReason).toBe("NotEligibleYet");
        });
      });

      await runWithExecutionConfig({}, async () => {
        await runWithExecutionContext("test_batch_tool", async () => {
          const resumed = await runOperationContinuation({
            operationId: "op-rate",
            ownerHash,
            adapter,
            leaseOwner: "invocation-3",
            now: "2026-07-18T00:11:00.000Z",
          });
          expect(resumed.state).toBe("Completed");
        });
      });
    });

    expect(attempts.get("ticket-rate")).toBe(2);
  });

  it("preserves same-invocation write checkpoints across repeated reliable throttles", async () => {
    const ownerHash = stableHash("owner@example.com");
    let attempts = 0;
    let acceptedWrites = 0;
    const adapter: OperationContinuationAdapter = {
      toolName: "test_batch_tool",
      estimateItemSubrequests: () => 1,
      async processItem({ checkpoint }) {
        attempts += 1;
        if (attempts === 1) {
          await checkpoint({
            stage: "WriteStarted",
            outcome: "WriteStarted",
            mutationType: "update",
            mutationStartStage: "WriteStarted",
            writeAttempted: true,
            writeMayHaveSucceeded: true,
            reliableResponseReceived: false,
            observedMutationResult: "Ambiguous",
            partialWrite: true,
            verificationState: "Pending",
          });
          await checkpoint({
            stage: "RateLimitedRescheduled",
            outcome: "SuperOpsRateLimitRescheduled",
            mutationType: "update",
            writeAttempted: true,
            writeMayHaveSucceeded: false,
            reliableResponseReceived: true,
            observedMutationResult: "Rejected",
            partialWrite: false,
            verificationState: "Pending",
          });
        }
        if (attempts <= 2) {
          return {
            stage: "RateLimitedRescheduled",
            outcome: "SuperOpsRateLimitRescheduled",
            writeAttempted: false,
            writeMayHaveSucceeded: false,
            reliableResponseReceived: true,
            observedMutationResult: "Rejected" as const,
            partialWrite: false,
            nextEligibleTime: new Date(Date.now() + 10).toISOString(),
            rateLimited: true,
            errorClass: "SuperOpsRateLimit" as const,
            result: {
              itemKey: "ticket-rate-history",
              finalOutcome: "SuperOpsRateLimitRescheduled",
              writeAttempted: false,
              writeMayHaveSucceeded: false,
              partialWrite: false,
            },
          };
        }
        acceptedWrites += 1;
        return {
          stage: "CompletedAfterRetry",
          outcome: "CompletedAfterRetry",
          writeAttempted: true,
          writeMayHaveSucceeded: true,
          partialWrite: false,
          verified: true,
        };
      },
    };

    await runWithOperationStore({}, async () => {
      await getOperationStore().put(ledgerRecord({
        operationId: "op-rate-write-history",
        ownerHash,
        itemKeys: ["ticket-rate-history"],
      }));

      for (let invocation = 1; invocation <= 3; invocation += 1) {
        await runWithExecutionConfig({}, () => runWithExecutionContext(
          "test_batch_tool",
          () => runOperationContinuation({
            operationId: "op-rate-write-history",
            ownerHash,
            adapter,
            leaseOwner: `rate-history-${invocation}`,
            now: new Date(Date.now() + invocation * 1_000).toISOString(),
          })
        ));
        const current = await getOperationStore().get("op-rate-write-history");
        if (invocation < 3) {
          expect(current).toMatchObject({
            state: "Rescheduled",
            itemStates: {
              "ticket-rate-history": {
                stage: "RateLimitedRescheduled",
                writeAttempted: true,
                writeMayHaveSucceeded: false,
                observedMutationResult: "Rejected",
              },
            },
          });
        }
      }

      await expect(getOperationStore().get("op-rate-write-history")).resolves.toMatchObject({
        state: "Completed",
        itemStates: {
          "ticket-rate-history": {
            stage: "CompletedAfterRetry",
            writeAttempted: true,
            writeMayHaveSucceeded: true,
            verificationState: "Verified",
          },
        },
      });
    });

    expect(attempts).toBe(3);
    expect(acceptedWrites).toBe(1);
  });

  it("keeps ambiguous accepted writes terminal and unrepeated", async () => {
    const ownerHash = stableHash("owner@example.com");
    let writeAttempts = 0;
    const adapter: OperationContinuationAdapter = {
      toolName: "test_batch_tool",
      estimateItemSubrequests: () => 2,
      async processItem() {
        writeAttempts += 1;
        countedRequest("write");
        countedRequest("verificationRead");
        return {
          stage: "CompletedAfterAmbiguousWriteVerification",
          outcome: "CompletedAfterAmbiguousWriteVerification",
          writeAttempted: true,
          writeMayHaveSucceeded: true,
          partialWrite: false,
          verified: true,
        };
      },
    };

    await runWithOperationStore({}, async () => {
      await getOperationStore().put(
        ledgerRecord({ operationId: "op-ambiguous", ownerHash, itemKeys: ["ticket-a"] })
      );
      await runWithExecutionConfig({}, async () => {
        await runWithExecutionContext("test_batch_tool", async () => {
          await runOperationContinuation({
            operationId: "op-ambiguous",
            ownerHash,
            adapter,
            leaseOwner: "invocation-1",
          });
          await runOperationContinuation({
            operationId: "op-ambiguous",
            ownerHash,
            adapter,
            leaseOwner: "invocation-duplicate",
          });
        });
      });
    });

    expect(writeAttempts).toBe(1);
  });

  it("retains an ambiguous write boundary when a fresh invocation cannot fund reconciliation", async () => {
    const ownerHash = stableHash("owner@example.com");
    let processed = 0;
    const adapter: OperationContinuationAdapter = {
      toolName: "test_batch_tool",
      // Two requests permit claiming; this three-request recovery unit must
      // defer without clearing the persisted ambiguity boundary.
      estimateItemSubrequests: () => 3,
      async processItem() {
        processed += 1;
        throw new Error("an unfunded recovery unit must not execute");
      },
    };

    await runWithOperationStore({}, async () => {
      const store = getOperationStore();
      await store.put(ledgerRecord({
        operationId: "op-ambiguous-before-budget", ownerHash, itemKeys: ["ticket-checkpoint"],
      }));
      const initialClaim = await store.claimNextItem({
        operationId: "op-ambiguous-before-budget", ownerHash, leaseOwner: "checkpoint-owner",
        leaseMs: 60_000, now: "2026-07-18T00:00:00.000Z",
      });
      if (!initialClaim) throw new Error("expected checkpoint claim");
      await store.checkpointItem({
        operationId: "op-ambiguous-before-budget", ownerHash, itemKey: "ticket-checkpoint",
        leaseId: initialClaim.lease.leaseId,
        patch: {
          stage: "WriteStarted", writeAttempted: true, writeMayHaveSucceeded: true,
          partialWrite: false, verificationState: "Pending",
        },
      });
      await store.completeItem({
        operationId: "op-ambiguous-before-budget", ownerHash, itemKey: "ticket-checkpoint",
        leaseId: initialClaim.lease.leaseId,
        patch: {
          stage: "WriteAmbiguous", writeAttempted: true, writeMayHaveSucceeded: true,
          partialWrite: true, verificationState: "Pending",
        },
      });

      await runWithExecutionConfig({
        SUPEROPS_EXECUTION_SUBREQUEST_BUDGET: "4",
        SUPEROPS_EXECUTION_SUBREQUEST_SAFETY_MARGIN: "2",
        SUPEROPS_EXECUTION_SAFE_REMAINING_TIME_MS: "0",
      }, async () => {
        await runWithExecutionContext("test_batch_tool", async () => {
          await runOperationContinuation({
            operationId: "op-ambiguous-before-budget", ownerHash, adapter,
            leaseOwner: "unfunded-recovery",
          });
        });
      });

      await expect(store.get("op-ambiguous-before-budget")).resolves.toMatchObject({
        itemStates: {
          "ticket-checkpoint": {
            stage: "WriteAmbiguous", writeAttempted: true,
            writeMayHaveSucceeded: true, partialWrite: true,
          },
        },
      });
    });

    expect(processed).toBe(0);
  });

  it("preserves a write-start checkpoint when the execution budget stops the item", async () => {
    const ownerHash = stableHash("owner@example.com");
    let resumedItems = 0;
    const checkpointThenStop: OperationContinuationAdapter = {
      toolName: "test_batch_tool",
      estimateItemSubrequests: () => 1,
      async processItem({ checkpoint }) {
        await checkpoint({
          stage: "WriteStarted",
          writeAttempted: true,
          writeMayHaveSucceeded: true,
          partialWrite: false,
          verificationState: "Pending",
        });
        const state = getExecutionState();
        if (!state) throw new Error("missing execution state");
        throw new ExecutionBudgetExceededError(state, 1);
      },
    };
    const reconcileOnly: OperationContinuationAdapter = {
      toolName: "test_batch_tool",
      estimateItemSubrequests: () => 1,
      async processItem({ claim }) {
        resumedItems += 1;
        expect(claim.item.stage).toBe("WriteAmbiguous");
        expect(claim.item.writeMayHaveSucceeded).toBe(true);
        return {
          stage: "CompletedAfterAmbiguousWriteVerification",
          outcome: "CompletedAfterAmbiguousWriteVerification",
          writeAttempted: true,
          writeMayHaveSucceeded: true,
          partialWrite: false,
          verified: true,
        };
      },
    };

    await runWithOperationStore({}, async () => {
      await getOperationStore().put(ledgerRecord({
        operationId: "op-checkpoint-budget", ownerHash, itemKeys: ["ticket-checkpoint"],
      }));
      await runWithExecutionConfig({}, async () => {
        await runWithExecutionContext("test_batch_tool", async () => {
          await runOperationContinuation({
            operationId: "op-checkpoint-budget", ownerHash, adapter: checkpointThenStop,
            leaseOwner: "first-invocation",
          });
        });
      });
      await expect(getOperationStore().get("op-checkpoint-budget")).resolves.toMatchObject({
        itemStates: {
          "ticket-checkpoint": {
            stage: "WriteAmbiguous", writeAttempted: true,
            writeMayHaveSucceeded: true, partialWrite: true,
          },
        },
      });
      await runWithExecutionConfig({}, async () => {
        await runWithExecutionContext("test_batch_tool", async () => {
          await runOperationContinuation({
            operationId: "op-checkpoint-budget", ownerHash, adapter: reconcileOnly,
            leaseOwner: "reconciliation-invocation",
          });
        });
      });
    });

    expect(resumedItems).toBe(1);
  });

  it("terminates repeated durable throttling as RateLimitExceeded at the configured ceiling", async () => {
    const ownerHash = stableHash("rate-limit-owner");
    let attempts = 0;
    const adapter: OperationContinuationAdapter = {
      toolName: "test_batch_tool",
      estimateItemSubrequests: () => 1,
      async processItem() {
        attempts += 1;
        countedRequest("write");
        return {
          stage: "RateLimitedRescheduled",
          outcome: "SuperOpsRateLimitRescheduled",
          writeAttempted: true,
          writeMayHaveSucceeded: true,
          reliableResponseReceived: true,
          observedMutationResult: "Rejected",
          partialWrite: false,
          rateLimited: true,
          nextEligibleTime: new Date(Date.now() + 1).toISOString(),
          retryCount: attempts - 1,
          errorClass: "SuperOpsRateLimit",
        };
      },
    };

    await runWithOperationStore({}, async () => {
      await getOperationStore().put(ledgerRecord({
        operationId: "op-rate-exhausted", ownerHash, itemKeys: ["ticket-rate"],
      }));
      for (let invocation = 0; invocation < 3; invocation += 1) {
        await runWithExecutionConfig({
          SUPEROPS_EXECUTION_MAX_DURABLE_RETRY_ATTEMPTS: "2",
          SUPEROPS_EXECUTION_MAX_DURABLE_RETRY_DURATION_MS: "60000",
          SUPEROPS_EXECUTION_MAX_DURABLE_SINGLE_WAIT_MS: "10",
        }, async () => runWithExecutionContext("test_batch_tool", () =>
          runOperationContinuation({
            operationId: "op-rate-exhausted", ownerHash, adapter,
            leaseOwner: `rate-${invocation}`, now: "2999-01-01T00:00:00.000Z",
          })
        ));
      }
      await expect(getOperationStore().get("op-rate-exhausted")).resolves.toMatchObject({
        state: "CompletedWithFailures",
        itemStates: {
          "ticket-rate": {
            stage: "RateLimitExceeded", errorClass: "RateLimitExceeded",
            writeAttempted: true, writeMayHaveSucceeded: true,
            rateLimit: { attempts: 3, firstThrottledAt: expect.any(String), actualDelayMs: expect.any(Number) },
          },
        },
      });
    });
    expect(attempts).toBe(3);
  });
});
