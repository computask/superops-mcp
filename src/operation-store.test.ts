import { afterEach, describe, expect, it, vi } from "vitest";
import stalledRateLimitFixture from "./test-fixtures/operation-13a1584b-rate-limit-running.json" with { type: "json" };
import { getExecutionState, runWithExecutionConfig, runWithExecutionContext } from "./execution.js";
import {
  getOperationStore,
  MalformedStoredOperationError,
  normalizedNoteFingerprint,
  operationResultView,
  operationTotals,
  runWithOperationStore,
  stableHash,
  SuperOpsOperationLedger,
  type OperationItemState,
  type OperationLedgerRecord,
} from "./operation-store.js";

function record(overrides: Partial<OperationLedgerRecord> = {}): OperationLedgerRecord {
  return {
    responseVersion: 1,
    operationId: "op-1",
    toolName: "superops_tickets_apply_triage_plan",
    ownerHash: stableHash("owner@example.com"),
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:01.000Z",
    expiresAt: "2026-07-19T00:00:00.000Z",
    originalRequestHash: stableHash({ batchId: "batch-1" }),
    state: "ContinuationRequired",
    expectedItems: ["57400", "57401"],
    currentItem: "57401",
    completedItems: ["57400"],
    failedItems: [],
    skippedItems: [],
    unattemptedItems: ["57401"],
    pendingItems: ["57401"],
    itemStates: {
      "57400": {
        itemKey: "57400",
        stage: "Completed",
        outcome: "Updated",
        idempotencyKey: "item-57400",
        writeAttempted: true,
        writeMayHaveSucceeded: true,
        partialWrite: false,
        verificationState: "Verified",
        retryCount: 0,
      },
      "57401": {
        itemKey: "57401",
        stage: "Unattempted",
        outcome: "NotAttemptedExecutionStopped",
        idempotencyKey: "item-57401",
        writeAttempted: false,
        writeMayHaveSucceeded: false,
        partialWrite: false,
        verificationState: "Pending",
        retryCount: 0,
      },
    },
    summary: { updated: 1, unattempted: 1 },
    compactResults: [
      { ticketNumber: "57400", finalOutcome: "Updated", partialWrite: false },
      { ticketNumber: "57401", finalOutcome: "NotAttemptedExecutionStopped" },
    ],
    partialWriteCount: 0,
    ambiguousWriteCount: 0,
    rateLimitedItems: [],
    continuationCount: 1,
    ...overrides,
  };
}

function ownerScopedDurableNamespace(options: {
  failStoragePut?: (params: { ownerName: string; key: string; opKeyPutCount: number }) => boolean;
} = {}) {
  let opKeyPutCount = 0;
  const valuesByName = new Map<string, Map<string, unknown>>();
  const ledgers = new Map<string, SuperOpsOperationLedger>();
  const valuesFor = (name: string) => {
    let values = valuesByName.get(name);
    if (!values) {
      values = new Map<string, unknown>();
      valuesByName.set(name, values);
    }
    return values;
  };
  const namespace = {
    idFromName: (name: string) => name,
    get: (id: unknown) => {
      const name = String(id);
      let ledger = ledgers.get(name);
      if (!ledger) {
        const values = valuesFor(name);
        ledger = new SuperOpsOperationLedger({
          storage: {
            get: async <T = unknown>(key: string) => values.get(key) as T | undefined,
            put: async (key: string | Record<string, unknown>, value?: unknown) => {
              const entries = typeof key === "string" ? [[key, value] as const] : Object.entries(key);
              for (const [entryKey, entryValue] of entries) {
                const nextOpKeyPutCount = entryKey.startsWith("op:") ? opKeyPutCount + 1 : opKeyPutCount;
                if (options.failStoragePut?.({ ownerName: name, key: entryKey, opKeyPutCount: nextOpKeyPutCount })) {
                  throw new Error("rate_limit_exceeded");
                }
                if (entryKey.startsWith("op:")) opKeyPutCount = nextOpKeyPutCount;
                values.set(entryKey, entryValue);
              }
            },
            delete: async (key: string) => values.delete(key),
            list: async <T = unknown>(options?: { prefix?: string }) => new Map(
              [...values.entries()].filter(([key]) => !options?.prefix || key.startsWith(options.prefix))
            ) as Map<string, T>,
          },
        });
        ledgers.set(name, ledger);
      }
      return { fetch: (request: Request) => ledger!.fetch(request) };
    },
  };
  return { namespace, valuesFor, opKeyPutCount: () => opKeyPutCount };
}

describe("operation store", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("persists and lists operation records in the local store", async () => {
    await runWithOperationStore({}, async () => {
      const store = getOperationStore();
      await store.put(record());

      await expect(store.get("op-1")).resolves.toMatchObject({
        operationId: "op-1",
        state: "ContinuationRequired",
      });
      await expect(store.list(stableHash("owner@example.com"))).resolves.toHaveLength(1);
      await expect(store.list(stableHash("other@example.com"))).resolves.toHaveLength(0);
    });
  });

  it("lists real owner-scoped Durable Object operations through a bounded redacted index", async () => {
    const durable = ownerScopedDurableNamespace();
    const ownerHash = stableHash("owner@example.com");
    const otherOwnerHash = stableHash("other@example.com");
    await runWithOperationStore({ SUPEROPS_OPERATION_LEDGER: durable.namespace }, async () => {
      const store = getOperationStore();
      await store.put(record({
        operationId: "recent-a-1",
        ownerHash,
        updatedAt: "2026-07-18T00:00:02.000Z",
        summary: { failureReason: "Authorization: Bearer secret-owner-token" },
      }));
      await store.put(record({
        operationId: "recent-a-2",
        ownerHash,
        updatedAt: "2026-07-18T00:00:03.000Z",
      }));
      await store.put(record({ operationId: "recent-b-1", ownerHash: otherOwnerHash }));

      const recent = await store.list(ownerHash);
      expect(recent.map((entry) => entry.operationId)).toEqual(["recent-a-2", "recent-a-1"]);
      expect(await store.list(otherOwnerHash)).toEqual([
        expect.objectContaining({ operationId: "recent-b-1" }),
      ]);
      const serialized = JSON.stringify(recent);
      expect(serialized).not.toContain("ownerHash");
      expect(serialized).not.toContain("secret-owner-token");
      expect(serialized).not.toContain("summary");
      expect(serialized).not.toContain("results");
      await expect(store.get("recent-a-1", ownerHash)).resolves.toMatchObject({
        operationId: "recent-a-1",
      });
      await expect(store.get("recent-a-1", otherOwnerHash)).resolves.toBeUndefined();

      await store.put(record({
        operationId: "recent-expired",
        ownerHash,
        state: "Completed",
        expiresAt: "2000-01-01T00:00:00.000Z",
        itemStates: {
          "57400": record().itemStates["57400"],
          "57401": {
            ...record().itemStates["57401"],
            stage: "Completed",
            outcome: "Updated",
            writeAttempted: true,
            writeMayHaveSucceeded: true,
            verificationState: "Verified",
          },
        },
      }));
      await store.put(record({ operationId: "recent-deleted", ownerHash }));
      durable.valuesFor("owner:" + ownerHash).delete("op:recent-deleted");
      const retained = await store.list(ownerHash);
      expect(retained.map((entry) => entry.operationId)).not.toContain("recent-expired");
      expect(retained.map((entry) => entry.operationId)).not.toContain("recent-deleted");

      for (let index = 0; index < 55; index += 1) {
        await store.put(record({
          operationId: `bounded-${index}`,
          ownerHash,
          updatedAt: new Date(Date.parse("2026-07-18T01:00:00.000Z") + index).toISOString(),
        }));
      }
      const ownerValues = durable.valuesFor("owner:" + ownerHash);
      const indexEntries = [...ownerValues.entries()].filter(([key]) => key.startsWith("recent:"));
      expect(indexEntries).toHaveLength(50);
      expect(new TextEncoder().encode(JSON.stringify(indexEntries)).byteLength).toBeLessThanOrEqual(50 * 1024);
      const boundedResults = await store.list(ownerHash);
      expect(boundedResults.length).toBeLessThanOrEqual(20);
      expect(new TextEncoder().encode(JSON.stringify(boundedResults)).byteLength).toBeLessThanOrEqual(128 * 1024);

      const duplicate = record({
        operationId: "bounded-54",
        ownerHash,
        updatedAt: "2026-07-18T02:00:00.000Z",
      });
      await store.put(duplicate);
      await store.put(duplicate);
      expect([...ownerValues.keys()].filter((key) => key === "recent:bounded-54")).toHaveLength(1);
    });
  });

  it("returns safe continuation scheduling and wake telemetry", () => {
    const view = operationResultView(record({
      terminalFailureReason: "Authorization: Bearer public-result-secret",
      continuationMechanism: "workflow",
      continuationInstanceId: "wf-status",
      schedulingAttempted: true,
      schedulingSucceeded: true,
      schedulingAttemptCount: 2,
      wakeAttemptCount: 1,
      wakeDeliveryCount: 1,
      lastWakeAttemptAt: "2026-07-18T00:05:00.000Z",
      lastWakeSucceededAt: "2026-07-18T00:05:01.000Z",
    }));

    expect(view).toMatchObject({
      operationId: "op-1",
      state: "ContinuationRequired",
      completedCount: 1,
      unattemptedCount: 1,
      continuationCount: 1,
      continuationMechanism: "workflow",
      continuationInstanceId: "wf-status",
      schedulingAttempted: true,
      schedulingSucceeded: true,
      schedulingAttemptCount: 2,
      wakeAttemptCount: 1,
      wakeDeliveryCount: 1,
      lastWakeAttemptAt: "2026-07-18T00:05:00.000Z",
      lastWakeSucceededAt: "2026-07-18T00:05:01.000Z",
    });
    expect(JSON.stringify(view)).not.toContain("originalRequestHash");
    expect(JSON.stringify(view)).not.toContain("idempotencyKey");
    expect(JSON.stringify(view)).not.toContain("public-result-secret");
  });

  it("derives an overdue Workflow wait as stalled without mutating the ledger", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T00:07:01.000Z"));
    const stored = record({
      state: "Rescheduled",
      nextEligibleTime: "2026-07-18T00:05:00.000Z",
      continuationMechanism: "workflow",
      continuationInstanceId: "wf-overdue",
      schedulingAttempted: true,
      schedulingSucceeded: true,
      wakeAttemptCount: 0,
      wakeDeliveryCount: 0,
    });

    expect(operationResultView(stored)).toMatchObject({
      state: "Rescheduled",
      derivedState: "Stalled",
      stalled: true,
      stalledReason: expect.stringContaining("no Workflow wake attempt"),
      nextEligibleTime: "2026-07-18T00:05:00.000Z",
      continuationInstanceId: "wf-overdue",
    });
    expect(stored.state).toBe("Rescheduled");
    expect(stored.nextEligibleTime).toBe("2026-07-18T00:05:00.000Z");
  });
  it("retries a transient Durable Object checkpoint rate limit without counting mutation attempts", async () => {
    let checkpointPutAttempts = 0;
    let failedOnce = false;
    const ownerHash = stableHash("owner@example.com");
    const durable = ownerScopedDurableNamespace({
      failStoragePut: ({ key, opKeyPutCount }) => {
        if (key !== "op:checkpoint-rate-limit-retry" || opKeyPutCount !== 3) return false;
        checkpointPutAttempts += 1;
        if (!failedOnce) {
          failedOnce = true;
          return true;
        }
        return false;
      },
    });

    await runWithExecutionConfig({}, () => runWithExecutionContext("operation-store-rate-limit", () =>
      runWithOperationStore({ SUPEROPS_OPERATION_LEDGER: durable.namespace }, async () => {
        const store = getOperationStore();
        await store.put(record({
          operationId: "checkpoint-rate-limit-retry",
          ownerHash,
          expectedItems: ["57401"],
          completedItems: [],
          pendingItems: ["57401"],
          unattemptedItems: ["57401"],
          itemStates: {
            "57401": {
              ...record().itemStates["57401"],
              stage: "Unattempted",
              attemptCount: 0,
            },
          },
          compactResults: [],
        }));
        const claim = await store.claimNextItem({
          operationId: "checkpoint-rate-limit-retry",
          ownerHash,
          leaseOwner: "test",
          leaseMs: 60_000,
          now: "2026-07-18T00:00:00.000Z",
        });
        if (!claim) throw new Error("claim missing");

        const before = getExecutionState()?.requests.filter((request) => request.type === "write").length ?? 0;
        const updated = await store.checkpointItem({
          operationId: "checkpoint-rate-limit-retry",
          ownerHash,
          itemKey: "57401",
          leaseId: claim.lease.leaseId,
          patch: {
            stage: "PreflightValidated",
            writeAttempted: false,
            writeMayHaveSucceeded: false,
            partialWrite: false,
            verificationState: "Pending",
            attemptCount: 0,
          },
        });
        const after = getExecutionState()?.requests.filter((request) => request.type === "write").length ?? 0;

        expect(failedOnce).toBe(true);
        expect(checkpointPutAttempts).toBe(2);
        expect(after).toBe(before);
        expect(updated.itemStates["57401"]).toMatchObject({
          stage: "PreflightValidated",
          attemptCount: 0,
          writeAttempted: false,
          writeMayHaveSucceeded: false,
        });
      })
    ));
  });

  it("marks the 13a1584b rate-limit fixture as derived stalled without mutating it", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T08:10:01.000Z"));
    const fixture = stalledRateLimitFixture as unknown as OperationLedgerRecord;
    const view = operationResultView(fixture);

    expect(view).toMatchObject({
      operationId: "13a1584b-72b0-4d6c-ac82-4073be1ea4ce",
      state: "Running",
      derivedState: "Stalled",
      stalled: true,
      continuationCount: 0,
      unattemptedCount: 1,
    });
    expect(view.items).toContainEqual(expect.objectContaining({
      itemId: "fixture-ticket",
      stage: "Unattempted",
      attemptCount: 0,
      writeAttempted: false,
      writeMayHaveSucceeded: false,
    }));
    expect(fixture.state).toBe("Running");
  });
  it("derives public category totals from item states rather than a caller summary", () => {
    const totals = operationTotals(record({
      summary: { updated: 9999 },
      itemStates: {
        "57400": {
          ...record().itemStates["57400"],
          stage: "CompletedAfterAmbiguousWriteVerification",
          outcome: "Updated",
        },
        "57401": {
          ...record().itemStates["57401"],
          stage: "RateLimitedRescheduled",
          outcome: "SuperOpsRateLimitRescheduled",
        },
      },
    }));

    expect(totals).toMatchObject({
      expected: 2,
      updated: 1,
      completedAfterAmbiguousVerification: 1,
      waitingForRateLimit: 1,
      pending: 1,
    });
  });

  it("clears stale continuation failure text only after clean completion", async () => {
    await runWithOperationStore({}, async () => {
      const store = getOperationStore();
      const staleReason = "Continuation required before all expected items were processed.";
      await store.put(record({
        operationId: "op-clean-complete",
        state: "ContinuationRequired",
        expectedItems: ["57400"],
        completedItems: [],
        failedItems: [],
        skippedItems: [],
        unattemptedItems: [],
        pendingItems: ["57400"],
        itemStates: { "57400": record().itemStates["57400"] },
        compactResults: [{ ticketNumber: "57400", finalOutcome: "Updated" }],
        terminalFailureReason: staleReason,
      }));
      await expect(store.get("op-clean-complete")).resolves.toMatchObject({
        state: "Completed",
        pendingItems: [],
      });
      const completed = await store.get("op-clean-complete");
      expect(completed?.terminalFailureReason).toBeUndefined();

      await store.put(record({
        operationId: "op-still-incomplete",
        terminalFailureReason: staleReason,
      }));
      await expect(store.get("op-still-incomplete")).resolves.toMatchObject({
        state: "ContinuationRequired",
        pendingItems: ["57401"],
        terminalFailureReason: staleReason,
      });

      await store.put(record({
        operationId: "op-terminal-failed",
        state: "Failed",
        expiresAt: "2999-01-01T00:00:00.000Z",
        terminalFailureReason: "Immediate continuation delivery failed or is not configured.",
      }));
      await expect(store.get("op-terminal-failed")).resolves.toMatchObject({
        state: "Failed",
        terminalFailureReason: "Immediate continuation delivery failed or is not configured.",
      });
    });
  });

  it("clears or replaces provisional continuation reasons when durable operations complete", async () => {
    const durable = ownerScopedDurableNamespace();
    const ownerHash = stableHash("owner@example.com");
    const staleReason = "Continuation required before all expected items were processed.";
    const validationReason = "Expected status \"New Calls\", got \"Awaiting Engineer\".";

    await runWithOperationStore({ SUPEROPS_OPERATION_LEDGER: durable.namespace }, async () => {
      const store = getOperationStore();
      await store.put(record({
        operationId: "op-durable-clean-complete",
        state: "ContinuationRequired",
        expectedItems: ["57400"],
        completedItems: [],
        failedItems: [],
        skippedItems: [],
        unattemptedItems: [],
        pendingItems: ["57400"],
        itemStates: { "57400": record().itemStates["57400"] },
        compactResults: [{ ticketNumber: "57400", finalOutcome: "Updated" }],
        terminalFailureReason: staleReason,
      }));
      const completed = await store.get("op-durable-clean-complete", ownerHash);
      expect(completed).toMatchObject({ state: "Completed", pendingItems: [] });
      expect(completed?.terminalFailureReason).toBeUndefined();

      await store.put(record({
        operationId: "op-durable-validation-failure",
        state: "ContinuationRequired",
        expectedItems: ["57401"],
        completedItems: [],
        failedItems: [],
        skippedItems: [],
        unattemptedItems: [],
        pendingItems: ["57401"],
        itemStates: {
          "57401": {
            ...record().itemStates["57401"],
            stage: "FailedBeforeWrite",
            outcome: "Blocked",
            writeAttempted: false,
            writeMayHaveSucceeded: false,
            partialWrite: false,
            verificationState: "NotRequired",
            errorClass: "ValidationFailure",
            failureReason: validationReason,
          },
        },
        compactResults: [{
          ticketNumber: "57401",
          finalOutcome: "Blocked",
          failureReason: validationReason,
          writeAttempted: false,
        }],
        terminalFailureReason: staleReason,
      }));
      const failed = await store.get("op-durable-validation-failure", ownerHash);
      expect(failed).toMatchObject({
        state: "CompletedWithFailures",
        terminalFailureReason: validationReason,
        itemStates: {
          "57401": {
            stage: "FailedBeforeWrite",
            writeAttempted: false,
            failureReason: validationReason,
          },
        },
      });
      expect(failed?.itemStates["57401"].writeAttempted).toBe(false);
      expect(operationResultView(failed!).items).toEqual([
        expect.objectContaining({
          itemId: "57401",
          stage: "FailedBeforeWrite",
          finalErrorClass: "ValidationFailure",
          finalReason: validationReason,
          writeAttempted: false,
        }),
      ]);

      await store.put(record({
        operationId: "op-durable-still-incomplete",
        terminalFailureReason: staleReason,
      }));
      await expect(store.get("op-durable-still-incomplete", ownerHash)).resolves.toMatchObject({
        state: "ContinuationRequired",
        pendingItems: ["57401"],
        terminalFailureReason: staleReason,
      });

      await store.put(record({ operationId: "op-durable-terminal-continuation" }));
      await expect(store.terminalizeContinuationFailure({
        operationId: "op-durable-terminal-continuation",
        ownerHash,
        errorClass: "ContinuationExecutionFailure",
        outcome: "ContinuationDeliveryFailed",
        reason: "Workflow continuation delivery retry limit exhausted.",
      })).resolves.toMatchObject({
        state: "CompletedWithFailures",
        terminalFailureReason: "Workflow continuation delivery retry limit exhausted.",
        itemStates: {
          "57401": {
            stage: "FailedBeforeWrite",
            writeAttempted: false,
            errorClass: "ContinuationExecutionFailure",
          },
        },
      });
    });
  });
  it("derives operation status totals from reloaded durable item states", async () => {
    const durable = ownerScopedDurableNamespace();
    const ownerHash = stableHash("owner@example.com");
    const base = record().itemStates["57400"];
    const item = (
      itemKey: string,
      overrides: Partial<OperationItemState>
    ): OperationItemState => ({
      ...base,
      itemKey,
      idempotencyKey: "item-" + itemKey,
      stage: "Completed",
      outcome: "Updated",
      writeAttempted: true,
      writeMayHaveSucceeded: true,
      partialWrite: false,
      verificationState: "Verified",
      retryCount: 0,
      ...overrides,
    });
    const itemStates: Record<string, OperationItemState> = {
      first: item("first", { attemptCount: 1 }),
      retry: item("retry", { attemptCount: 2, retryCount: 1, observedMutationResult: "VerifiedApplied" }),
      validation: item("validation", {
        stage: "FailedBeforeWrite", outcome: "Blocked", writeAttempted: false,
        writeMayHaveSucceeded: false, verificationState: "NotRequired", errorClass: "ValidationFailure",
      }),
      stale: item("stale", {
        stage: "Stale", outcome: "SkippedChangedSinceSnapshot", writeAttempted: false,
        writeMayHaveSucceeded: false, verificationState: "NotRequired", errorClass: "StaleData",
      }),
      ambiguous: item("ambiguous", {
        stage: "AmbiguousWriteUnresolved", outcome: "AmbiguousWriteRequiresReconciliation",
        partialWrite: true, ambiguousWrite: true, errorClass: "AmbiguousWrite",
      }),
      verify: item("verify", {
        stage: "FailedAfterPartialWrite", outcome: "Failed", partialWrite: true,
        verificationState: "Failed", errorClass: "VerificationMismatch",
      }),
      exhausted: item("exhausted", {
        stage: "RateLimitExceeded", outcome: "RateLimitExceeded", writeAttempted: false,
        writeMayHaveSucceeded: false, verificationState: "Pending", errorClass: "RateLimitExceeded",
      }),
      waiting: item("waiting", {
        stage: "RateLimitedRescheduled", outcome: "SuperOpsRateLimitRescheduled",
        writeMayHaveSucceeded: false, nextEligibleTime: "2026-07-18T00:05:00.000Z",
        errorClass: "SuperOpsRateLimit",
      }),
      unattempted: item("unattempted", {
        stage: "Unattempted", outcome: "NotAttemptedExecutionStopped", writeAttempted: false,
        writeMayHaveSucceeded: false, verificationState: "Pending",
      }),
    };
    const expectedItems = Object.keys(itemStates);

    await runWithOperationStore({ SUPEROPS_OPERATION_LEDGER: durable.namespace }, async () => {
      const store = getOperationStore();
      await store.put(record({
        operationId: "op-durable-totals",
        ownerHash,
        expectedItems,
        itemStates,
        summary: { updated: 999, validationFailed: 999, completedAfterRetry: 999 },
        completedItems: [], failedItems: [], skippedItems: [], unattemptedItems: [], pendingItems: [],
      }));

      const reloaded = await store.get("op-durable-totals", ownerHash);
      if (!reloaded) throw new Error("expected reloaded operation");
      expect(operationResultView(reloaded).totals).toMatchObject({
        expected: 9,
        completed: 2,
        updated: 2,
        completedAfterRetry: 1,
        validationFailed: 1,
        stale: 1,
        failed: 4,
        partialWrite: 2,
        ambiguousUnresolved: 1,
        pending: 2,
        unattempted: 1,
        waitingForRateLimit: 1,
        rateLimitExceeded: 1,
      });
    });
  });

  it("serves operation records through the Durable Object fetch API", async () => {
    const values = new Map<string, unknown>();
    const durableObject = new SuperOpsOperationLedger({
      storage: {
        get: async <T = unknown>(key: string) => values.get(key) as T | undefined,
        put: async (key: string, value: unknown) => {
          values.set(key, value);
        },
        delete: async (key: string) => values.delete(key),
        list: async <T = unknown>() => values as Map<string, T>,
      },
    });

    const put = await durableObject.fetch(
      new Request("https://operation.local/operations/op-1", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(record()),
      })
    );
    expect(put.status).toBe(200);

    const get = await durableObject.fetch(
      new Request("https://operation.local/operations/op-1")
    );
    await expect(get.json()).resolves.toMatchObject({ operationId: "op-1" });

    const list = await durableObject.fetch(
      new Request(
        `https://operation.local/operations?ownerHash=${stableHash("owner@example.com")}`
      )
    );
    await expect(list.json()).resolves.toHaveLength(1);
  });

  it("preserves MalformedStoredOperation through the Durable Object operation-store wrapper", async () => {
    const durable = ownerScopedDurableNamespace();
    const ownerHash = stableHash("owner@example.com");
    const malformed = record({ operationId: "op-malformed-wrapper", ownerHash });
    malformed.itemStates["57401"] = {
      ...malformed.itemStates["57401"],
      retryCount: "bad" as unknown as number,
    };
    durable.valuesFor("owner:" + ownerHash).set("op:op-malformed-wrapper", malformed);

    await runWithOperationStore({ SUPEROPS_OPERATION_LEDGER: durable.namespace }, async () => {
      await expect(getOperationStore().get("op-malformed-wrapper", ownerHash)).rejects.toBeInstanceOf(
        MalformedStoredOperationError
      );
    });
  });

  it("uses only the dedicated key for approved private-note encryption and recovery", async () => {
    const values = new Map<string, unknown>();
    const storage = {
      get: async <T = unknown>(key: string) => values.get(key) as T | undefined,
      put: async (key: string | Record<string, unknown>, value?: unknown) => {
        if (typeof key === "string") {
          values.set(key, value);
        } else {
          for (const [entryKey, entryValue] of Object.entries(key)) {
            values.set(entryKey, entryValue);
          }
        }
      },
      delete: async (key: string) => values.delete(key),
      list: async <T = unknown>(options?: { prefix?: string }) =>
        new Map(
          [...values.entries()].filter(([key]) => !options?.prefix || key.startsWith(options.prefix))
        ) as Map<string, T>,
    };
    const internalContinuationToken = "internal-continuation-auth-test-token";
    const privateNoteEncryptionKey = "dedicated-private-note-encryption-test-key";
    const durableObject = new SuperOpsOperationLedger({ storage }, {
      SUPEROPS_INTERNAL_CONTINUATION_TOKEN: internalContinuationToken,
      SUPEROPS_PRIVATE_NOTE_ENCRYPTION_KEY: privateNoteEncryptionKey,
    });
    const noteBody = "Approved durable private note";
    const fingerprint = normalizedNoteFingerprint(noteBody);
    if (!fingerprint) throw new Error("expected note fingerprint");
    const candidate = record({ operationId: "op-private-note" });
    candidate.itemStates["57401"] = {
      ...candidate.itemStates["57401"],
      noteFingerprint: fingerprint,
    };

    const put = await durableObject.fetch(
      new Request("https://operation.local/operations/op-private-note", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          record: candidate,
          approvedPrivateNotes: [{
            itemKey: "57401",
            fingerprint,
            content: noteBody,
            privacyType: "PRIVATE",
          }],
        }),
      })
    );
    const putResponseText = await put.clone().text();
    expect(put.status, putResponseText).toBe(200);
    expect(putResponseText).not.toContain(internalContinuationToken);
    expect(putResponseText).not.toContain(privateNoteEncryptionKey);
    expect(JSON.stringify([...values.entries()])).not.toContain(noteBody);

    const publicRecord = await durableObject.fetch(
      new Request("https://operation.local/operations/op-private-note")
    );
    const publicRecordText = await publicRecord.clone().text();
    expect(publicRecordText).not.toContain(noteBody);
    expect(publicRecordText).not.toContain(internalContinuationToken);
    expect(publicRecordText).not.toContain(privateNoteEncryptionKey);

    const recoveryRequest = () =>
      new Request(
        "https://operation.local/operations/op-private-note/approved-private-note/57401",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ownerHash: candidate.ownerHash,
            fingerprint,
          }),
        }
      );
    const recovered = await durableObject.fetch(recoveryRequest());
    const recoveredBody = await recovered.json();
    expect(recoveredBody).toEqual({ content: noteBody });
    expect(JSON.stringify(recoveredBody)).not.toContain(internalContinuationToken);
    expect(JSON.stringify(recoveredBody)).not.toContain(privateNoteEncryptionKey);

    const internalTokenAsEncryptionKey = new SuperOpsOperationLedger({ storage }, {
      SUPEROPS_INTERNAL_CONTINUATION_TOKEN: internalContinuationToken,
      SUPEROPS_PRIVATE_NOTE_ENCRYPTION_KEY: internalContinuationToken,
    });
    const wrongKeyRecovery = await internalTokenAsEncryptionKey.fetch(recoveryRequest());
    expect(wrongKeyRecovery.status).toBe(404);
    const wrongKeyRecoveryText = await wrongKeyRecovery.text();
    expect(JSON.parse(wrongKeyRecoveryText)).toEqual({ error: "Not found" });
    expect(wrongKeyRecoveryText).not.toContain(internalContinuationToken);
    expect(wrongKeyRecoveryText).not.toContain(privateNoteEncryptionKey);

    const missingKeyLedger = new SuperOpsOperationLedger({ storage }, {
      SUPEROPS_INTERNAL_CONTINUATION_TOKEN: internalContinuationToken,
    });
    const missingKeyRecovery = await missingKeyLedger.fetch(recoveryRequest());
    expect(missingKeyRecovery.status).toBe(404);
    const missingKeyRecoveryText = await missingKeyRecovery.text();
    expect(JSON.parse(missingKeyRecoveryText)).toEqual({ error: "Not found" });
    expect(missingKeyRecoveryText).not.toContain(internalContinuationToken);
    expect(missingKeyRecoveryText).not.toContain(privateNoteEncryptionKey);
  });

  it("fails private-note persistence safely when the dedicated key is missing", async () => {
    const values = new Map<string, unknown>();
    const storage = {
      get: async <T = unknown>(key: string) => values.get(key) as T | undefined,
      put: async (key: string | Record<string, unknown>, value?: unknown) => {
        if (typeof key === "string") {
          values.set(key, value);
        } else {
          for (const [entryKey, entryValue] of Object.entries(key)) {
            values.set(entryKey, entryValue);
          }
        }
      },
      delete: async (key: string) => values.delete(key),
      list: async <T = unknown>() => values as Map<string, T>,
    };
    const internalContinuationToken = "internal-continuation-auth-test-token";
    const noteBody = "Approved note must never be stored as plaintext";
    const fingerprint = normalizedNoteFingerprint(noteBody);
    if (!fingerprint) throw new Error("expected note fingerprint");
    const candidate = record({ operationId: "op-missing-private-note-key" });
    candidate.itemStates["57401"] = {
      ...candidate.itemStates["57401"],
      noteFingerprint: fingerprint,
    };
    const durableObject = new SuperOpsOperationLedger({ storage }, {
      SUPEROPS_INTERNAL_CONTINUATION_TOKEN: internalContinuationToken,
    });

    const response = await durableObject.fetch(
      new Request("https://operation.local/operations/op-missing-private-note-key", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          record: candidate,
          approvedPrivateNotes: [{
            itemKey: "57401",
            fingerprint,
            content: noteBody,
            privacyType: "PRIVATE",
          }],
        }),
      })
    );

    expect(response.status).toBe(503);
    const responseText = await response.text();
    expect(responseText).toContain("PrivateNoteEncryptionUnavailable");
    expect(responseText).not.toContain(noteBody);
    expect(responseText).not.toContain(internalContinuationToken);
    expect(JSON.stringify([...values.entries()])).not.toContain(noteBody);
    expect(values.size).toBe(0);
  });

  it("claims one unfinished item at a time and rejects terminal rewrites", async () => {
    await runWithOperationStore({}, async () => {
      const store = getOperationStore();
      const ownerHash = stableHash("owner@example.com");
      await store.put(record({ operationId: "op-claim" }));

      const claim = await store.claimNextItem({
        operationId: "op-claim",
        ownerHash,
        leaseOwner: "invocation-1",
        leaseMs: 60_000,
        now: "2026-07-18T00:00:02.000Z",
      });
      expect(claim).toMatchObject({ itemKey: "57401" });
      expect(claim?.item).toMatchObject({ stage: "Unattempted" });

      await expect(
        store.claimNextItem({
          operationId: "op-claim",
          ownerHash,
          leaseOwner: "invocation-2",
          leaseMs: 60_000,
          now: "2026-07-18T00:00:03.000Z",
        })
      ).resolves.toBeUndefined();

      const completed = await store.completeItem({
        operationId: "op-claim",
        ownerHash,
        itemKey: "57401",
        leaseId: claim?.lease.leaseId,
        patch: {
          stage: "Completed",
          outcome: "Updated",
          writeAttempted: true,
          writeMayHaveSucceeded: true,
          verificationState: "Verified",
        },
        result: { itemKey: "57401", finalOutcome: "Updated", verified: true },
      });

      expect(completed).toMatchObject({
        state: "Completed",
        completedItems: ["57400", "57401"],
        pendingItems: [],
        unattemptedItems: [],
      });
      expect(Date.parse(completed.expiresAt)).toBeGreaterThan(Date.now());
      expect(completed.compactResults).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ itemKey: "57401", finalOutcome: "Updated" }),
        ])
      );

      await expect(
        store.completeItem({
          operationId: "op-claim",
          ownerHash,
          itemKey: "57401",
          patch: { stage: "WriteStarted" },
        })
      ).rejects.toThrow(/Invalid operation item transition/);
    });
  });

  it("starts the configured retention window when an active operation becomes terminal", async () => {
    await runWithOperationStore({}, async () => {
      const store = getOperationStore();
      const ownerHash = stableHash("owner@example.com");
      const initial = record({
        operationId: "op-terminal-retention",
        createdAt: "2000-01-01T00:00:00.000Z",
        updatedAt: "2000-01-01T00:00:01.000Z",
        expiresAt: "2000-01-02T00:00:00.000Z",
      });
      await store.put(initial);
      const claim = await store.claimNextItem({
        operationId: initial.operationId,
        ownerHash,
        leaseOwner: "terminal-retention",
        leaseMs: 60_000,
      });
      if (!claim) throw new Error("expected terminal-retention claim");

      const completed = await store.completeItem({
        operationId: initial.operationId,
        ownerHash,
        itemKey: claim.itemKey,
        leaseId: claim.lease.leaseId,
        patch: {
          stage: "Completed",
          outcome: "Updated",
          writeAttempted: true,
          writeMayHaveSucceeded: true,
          verificationState: "Verified",
        },
      });

      expect(completed.state).toBe("Completed");
      expect(Date.parse(completed.expiresAt)).toBeGreaterThan(Date.now());
      await expect(store.get(initial.operationId)).resolves.toMatchObject({
        operationId: initial.operationId,
        state: "Completed",
      });
    });
  });

  it("rejects backward mutation transitions and write-state resets", async () => {
    await runWithOperationStore({}, async () => {
      const store = getOperationStore();
      const ownerHash = stableHash("owner@example.com");
      const initial = record({ operationId: "op-transitions" });
      initial.itemStates["57401"] = {
        ...initial.itemStates["57401"],
        stage: "WriteStarted",
        writeAttempted: true,
        writeMayHaveSucceeded: true,
      };
      await store.put(initial);
      const claim = await store.claimNextItem({
        operationId: "op-transitions", ownerHash, leaseOwner: "worker", leaseMs: 60_000,
      });
      await expect(store.completeItem({
        operationId: "op-transitions", ownerHash, itemKey: "57401", leaseId: claim?.lease.leaseId,
        patch: { stage: "Validating" },
      })).rejects.toThrow(/Invalid operation item transition/);
      await expect(store.completeItem({
        operationId: "op-transitions", ownerHash, itemKey: "57401", leaseId: claim?.lease.leaseId,
        patch: { stage: "Completed", writeAttempted: false, writeMayHaveSucceeded: false },
      })).rejects.toThrow(/writeAttempted cannot be reset/);
    });
  });

  it("allows an unfinished rescheduled item to persist a later read rate limit", async () => {
    await runWithOperationStore({}, async () => {
      const store = getOperationStore();
      const ownerHash = stableHash("owner@example.com");
      const initial = record({ operationId: "op-rescheduled-rate-limit" });
      initial.itemStates["57401"] = {
        ...initial.itemStates["57401"],
        stage: "Rescheduled",
        outcome: "NotAttemptedExecutionBudget",
      };
      await store.put(initial);
      const claim = await store.claimNextItem({
        operationId: initial.operationId,
        ownerHash,
        leaseOwner: "rate-limit-resume",
        leaseMs: 60_000,
      });
      if (!claim) throw new Error("expected rate-limit-resume claim");

      const rescheduled = await store.completeItem({
        operationId: initial.operationId,
        ownerHash,
        itemKey: claim.itemKey,
        leaseId: claim.lease.leaseId,
        patch: {
          stage: "RateLimitedRescheduled",
          outcome: "SuperOpsRateLimitRescheduled",
          writeAttempted: false,
          writeMayHaveSucceeded: false,
          partialWrite: false,
          verificationState: "Pending",
          errorClass: "SuperOpsRateLimit",
          nextEligibleTime: "2026-07-18T00:05:00.000Z",
        },
      });

      expect(rescheduled).toMatchObject({
        itemStates: {
          "57401": {
            stage: "RateLimitedRescheduled",
            outcome: "SuperOpsRateLimitRescheduled",
            writeAttempted: false,
            writeMayHaveSucceeded: false,
            partialWrite: false,
          },
        },
      });
    });
  });

  it("requires preflight before no-write staged classification verification", async () => {
    await runWithOperationStore({}, async () => {
      const store = getOperationStore();
      const ownerHash = stableHash("owner@example.com");
      await store.put(record({ operationId: "op-staged-noop-classification" }));
      const claim = await store.claimNextItem({
        operationId: "op-staged-noop-classification",
        ownerHash,
        leaseOwner: "noop-classification",
        leaseMs: 60_000,
      });
      if (!claim) throw new Error("expected noop-classification claim");

      await expect(store.checkpointItem({
        operationId: "op-staged-noop-classification",
        ownerHash,
        itemKey: "57401",
        leaseId: claim.lease.leaseId,
        patch: {
          stage: "ClassificationVerified",
          mutationType: "classification",
          writeAttempted: false,
          writeMayHaveSucceeded: false,
          partialWrite: false,
          verificationState: "Verified",
        },
      })).rejects.toThrow(/Invalid operation item transition from Unattempted to ClassificationVerified/);

      await expect(store.checkpointItem({
        operationId: "op-staged-noop-classification",
        ownerHash,
        itemKey: "57401",
        leaseId: claim.lease.leaseId,
        patch: {
          stage: "PreflightValidated",
          mutationType: "classification",
          writeAttempted: false,
          writeMayHaveSucceeded: false,
          partialWrite: false,
          verificationState: "Pending",
        },
      })).resolves.toMatchObject({
        itemStates: { "57401": { stage: "PreflightValidated" } },
      });
      await expect(store.checkpointItem({
        operationId: "op-staged-noop-classification",
        ownerHash,
        itemKey: "57401",
        leaseId: claim.lease.leaseId,
        patch: {
          stage: "ClassificationVerified",
          mutationType: "classification",
          writeAttempted: false,
          writeMayHaveSucceeded: false,
          partialWrite: false,
          verificationState: "Verified",
        },
      })).resolves.toMatchObject({
        itemStates: { "57401": { stage: "ClassificationVerified" } },
      });
    });
  });
  it("allows a verified resolution readback from the ambiguous resolution stage without opening backward transitions", async () => {
    await runWithOperationStore({}, async () => {
      const store = getOperationStore();
      const ownerHash = stableHash("owner@example.com");
      const initial = record({ operationId: "op-resolution-readback" });
      initial.itemStates["57401"] = {
        ...initial.itemStates["57401"],
        stage: "ResolutionWriteAmbiguous",
        mutationType: "resolution",
        writeAttempted: true,
        writeMayHaveSucceeded: true,
        partialWrite: true,
        verificationState: "Pending",
      };
      await store.put(initial);
      const claim = await store.claimNextItem({
        operationId: "op-resolution-readback",
        ownerHash,
        leaseOwner: "resolution-recovery",
        leaseMs: 60_000,
      });
      if (!claim) throw new Error("expected claim");

      const verified = await store.checkpointItem({
        operationId: "op-resolution-readback",
        ownerHash,
        itemKey: "57401",
        leaseId: claim.lease.leaseId,
        patch: {
          stage: "ResolutionVerified",
          mutationType: "resolution",
          writeAttempted: true,
          writeMayHaveSucceeded: true,
          partialWrite: false,
          verificationState: "Verified",
          observedMutationResult: "VerifiedApplied",
        },
      });
      expect(verified.itemStates["57401"]).toMatchObject({
        stage: "ResolutionVerified",
        writeAttempted: true,
        writeMayHaveSucceeded: true,
        partialWrite: false,
        verificationState: "Verified",
        observedMutationResult: "VerifiedApplied",
      });

      await expect(store.checkpointItem({
        operationId: "op-resolution-readback",
        ownerHash,
        itemKey: "57401",
        leaseId: claim.lease.leaseId,
        patch: { stage: "ResolutionValidated" },
      })).rejects.toThrow(/Invalid operation item transition/);
    });
  });
  it("keeps a mutation checkpoint leased and recoverable after a crash boundary", async () => {
    await runWithOperationStore({}, async () => {
      const store = getOperationStore();
      const ownerHash = stableHash("owner@example.com");
      await store.put(record({ operationId: "op-checkpoint" }));
      const claim = await store.claimNextItem({
        operationId: "op-checkpoint", ownerHash, leaseOwner: "worker", leaseMs: 1,
        now: "2026-07-18T00:00:00.000Z",
      });
      if (!claim) throw new Error("expected claim");
      const checkpointed = await store.checkpointItem({
        operationId: "op-checkpoint", ownerHash, itemKey: "57401", leaseId: claim.lease.leaseId,
        patch: {
          stage: "WriteStarted", writeAttempted: true, writeMayHaveSucceeded: true,
          verificationState: "Pending", attemptCount: 1,
        },
      });
      expect(checkpointed.itemStates["57401"]).toMatchObject({
        stage: "WriteStarted", writeAttempted: true, writeMayHaveSucceeded: true,
        lease: { leaseId: claim.lease.leaseId },
      });
      const recovered = await store.claimNextItem({
        operationId: "op-checkpoint", ownerHash, leaseOwner: "recovery", leaseMs: 60_000,
        now: "2026-07-18T00:00:02.000Z",
      });
      expect(recovered?.item).toMatchObject({
        stage: "WriteStarted", writeAttempted: true, writeMayHaveSucceeded: true,
      });
    });
  });
  it("prevents a duplicate wake from claiming a different item while the operation lease is active", async () => {
    await runWithOperationStore({}, async () => {
      const store = getOperationStore();
      const ownerHash = stableHash("owner@example.com");
      const pending = record({
        operationId: "op-operation-lease",
        itemStates: {
          "57400": {
            ...record().itemStates["57400"],
            stage: "Unattempted",
            outcome: "NotAttemptedExecutionStopped",
            writeAttempted: false,
            writeMayHaveSucceeded: false,
            verificationState: "Pending",
          },
          "57401": record().itemStates["57401"],
        },
        compactResults: [],
      });
      await store.put(pending);

      const first = await store.claimNextItem({
        operationId: "op-operation-lease", ownerHash, leaseOwner: "workflow-1",
        leaseMs: 60_000, now: "2026-07-18T00:00:02.000Z",
      });
      expect(first?.itemKey).toBe("57400");
      await expect(store.claimNextItem({
        operationId: "op-operation-lease", ownerHash, leaseOwner: "duplicate-wake",
        leaseMs: 60_000, now: "2026-07-18T00:00:03.000Z",
      })).resolves.toBeUndefined();

      const reclaimed = await store.claimNextItem({
        operationId: "op-operation-lease", ownerHash, leaseOwner: "workflow-2",
        leaseMs: 60_000, now: "2026-07-18T00:01:03.000Z",
      });
      expect(reclaimed?.itemKey).toBe("57400");
    });
  });

  it("preserves an ambiguous write stage across an expired lease recovery", async () => {
    await runWithOperationStore({}, async () => {
      const store = getOperationStore();
      const ownerHash = stableHash("owner@example.com");
      const initial = record({ operationId: "op-stage" });
      initial.itemStates["57401"] = {
        ...initial.itemStates["57401"],
        stage: "WriteStarted",
        writeAttempted: true,
        writeMayHaveSucceeded: true,
      };
      await store.put(initial);

      const first = await store.claimNextItem({
        operationId: "op-stage", ownerHash, leaseOwner: "first", leaseMs: 1,
        now: "2026-07-18T00:00:02.000Z",
      });
      expect(first?.item.stage).toBe("WriteStarted");

      const recovered = await store.claimNextItem({
        operationId: "op-stage", ownerHash, leaseOwner: "second", leaseMs: 60_000,
        now: "2026-07-18T00:00:03.000Z",
      });
      expect(recovered?.item).toMatchObject({
        stage: "WriteStarted", writeAttempted: true, writeMayHaveSucceeded: true,
      });
      await expect(store.completeItem({
        operationId: "op-stage", ownerHash, itemKey: "57401",
        leaseId: first?.lease.leaseId, patch: { stage: "Completed" },
      })).rejects.toThrow(/lease mismatch/);
    });
  });

  it("persists continuation schedules with owner enforcement", async () => {
    await runWithOperationStore({}, async () => {
      const store = getOperationStore();
      const ownerHash = stableHash("owner@example.com");
      await store.put(record({ operationId: "op-schedule" }));

      const scheduled = await store.scheduleContinuation({
        operationId: "op-schedule",
        ownerHash,
        reason: "RateLimitedRescheduled",
        nextEligibleTime: "2026-07-18T00:05:00.000Z",
        workflowId: "workflow-1",
      });

      expect(scheduled).toMatchObject({
        state: "Rescheduled",
        nextEligibleTime: "2026-07-18T00:05:00.000Z",
        workflowId: "workflow-1",
        continuationCount: 2,
      });

      await expect(
        store.scheduleContinuation({
          operationId: "op-schedule",
          ownerHash: stableHash("other@example.com"),
          reason: "wrong owner",
        })
      ).rejects.toThrow(/not visible/);
      await expect(
        store.scheduleContinuation({
          operationId: "missing-schedule",
          ownerHash,
          reason: "missing operation",
        })
      ).rejects.toThrow(/not visible/);
    });
  });

  it("serves atomic claim and complete actions through the Durable Object fetch API", async () => {
    const values = new Map<string, unknown>();
    const durableObject = new SuperOpsOperationLedger({
      storage: {
        get: async <T = unknown>(key: string) => values.get(key) as T | undefined,
        put: async (key: string, value: unknown) => {
          values.set(key, value);
        },
        delete: async (key: string) => values.delete(key),
        list: async <T = unknown>() => values as Map<string, T>,
      },
    });
    await durableObject.fetch(
      new Request("https://operation.local/operations/op-do-claim", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(record({ operationId: "op-do-claim" })),
      })
    );

    const claimResponse = await durableObject.fetch(
      new Request("https://operation.local/operations/op-do-claim/claim-next", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operationId: "op-do-claim",
          ownerHash: stableHash("owner@example.com"),
          leaseOwner: "workflow-1",
          leaseMs: 60_000,
          now: "2026-07-18T00:00:02.000Z",
        }),
      })
    );
    expect(claimResponse.status).toBe(200);
    const claim = (await claimResponse.json()) as { itemKey: string; lease: { leaseId: string } };
    expect(claim.itemKey).toBe("57401");

    const duplicateClaim = await durableObject.fetch(
      new Request("https://operation.local/operations/op-do-claim/claim-next", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operationId: "op-do-claim",
          ownerHash: stableHash("owner@example.com"),
          leaseOwner: "workflow-2",
          leaseMs: 60_000,
          now: "2026-07-18T00:00:03.000Z",
        }),
      })
    );
    expect(duplicateClaim.status).toBe(204);

    const complete = await durableObject.fetch(
      new Request("https://operation.local/operations/op-do-claim/complete-item", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operationId: "op-do-claim",
          ownerHash: stableHash("owner@example.com"),
          itemKey: "57401",
          leaseId: claim.lease.leaseId,
          patch: { stage: "Completed", outcome: "Updated", verificationState: "Verified" },
          result: { itemKey: "57401", finalOutcome: "Updated" },
        }),
      })
    );
    await expect(complete.json()).resolves.toMatchObject({
      state: "Completed",
      completedItems: ["57400", "57401"],
    });
  });

  it("counts Durable Object store calls through the central execution context", async () => {
    const durable = ownerScopedDurableNamespace();
    let subrequests = 0;
    let durableObjectCalls = 0;

    await runWithOperationStore({ SUPEROPS_OPERATION_LEDGER: durable.namespace }, async () => {
      await runWithExecutionConfig(
        { SUPEROPS_EXECUTION_SUBREQUEST_BUDGET: "5", SUPEROPS_EXECUTION_SUBREQUEST_SAFETY_MARGIN: "1" },
        async () => {
          await runWithExecutionContext("operation_store_accounting_test", async () => {
            await getOperationStore().put(record({ operationId: "op-do-accounting" }));
            const state = getExecutionState();
            subrequests = state?.subrequests ?? 0;
            durableObjectCalls = state?.requests.filter(
              (request) => request.operationType === "durableObject"
            ).length ?? 0;
          });
        }
      );
    });

    expect(subrequests).toBe(1);
    expect(durableObjectCalls).toBe(1);
  });

  it.each([
    {
      name: "continuation flag disabled",
      env: {},
      reason: "Durable continuation Workflow disabled: SUPEROPS_CONTINUATION_ENABLED is not true.",
    },
    {
      name: "durable retry flag disabled",
      env: { SUPEROPS_CONTINUATION_ENABLED: "true", SUPEROPS_DURABLE_RETRY_ENABLED: "false" },
      reason: "Durable continuation Workflow disabled: SUPEROPS_DURABLE_RETRY_ENABLED is not true.",
    },
    {
      name: "Workflow binding missing",
      env: { SUPEROPS_CONTINUATION_ENABLED: "true", SUPEROPS_DURABLE_RETRY_ENABLED: "true" },
      reason: "Durable continuation Workflow unavailable: SUPEROPS_CONTINUATION_WORKFLOW binding is missing.",
    },
  ])("reports precise durable Workflow scheduling diagnostics for $name", async ({ env, reason }) => {
    const values = new Map<string, unknown>();
    const durableObject = new SuperOpsOperationLedger({
      storage: {
        get: async <T = unknown>(key: string) => values.get(key) as T | undefined,
        put: async (key: string, value: unknown) => { values.set(key, value); },
        delete: async (key: string) => values.delete(key),
        list: async <T = unknown>() => values as Map<string, T>,
      },
    }, env);
    const operationId = `op-workflow-diagnostic-${stableHash(reason)}`;
    await durableObject.fetch(new Request(`https://operation.local/operations/${operationId}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record({ operationId })),
    }));

    const response = await durableObject.fetch(new Request(`https://operation.local/operations/${operationId}/schedule-continuation`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operationId, ownerHash: stableHash("owner@example.com"),
        reason: "RateLimitedRescheduled", nextEligibleTime: "2026-07-18T00:05:00.000Z",
      }),
    }));

    await expect(response.json()).resolves.toMatchObject({
      state: "CompletedWithFailures",
      schedulingAttempted: true,
      schedulingSucceeded: false,
      schedulingError: reason,
      terminalFailureReason: reason,
    });
  });

  it("counts Workflow createBatch scheduling calls in the central execution context", async () => {
    const values = new Map<string, unknown>();
    const batches: Array<Array<{ id: string; params: Record<string, unknown> }>> = [];
    const durableObject = new SuperOpsOperationLedger({
      storage: {
        get: async <T = unknown>(key: string) => values.get(key) as T | undefined,
        put: async (key: string, value: unknown) => { values.set(key, value); },
        delete: async (key: string) => values.delete(key),
        list: async <T = unknown>() => values as Map<string, T>,
      },
    }, {
      SUPEROPS_CONTINUATION_ENABLED: "true",
      SUPEROPS_DURABLE_RETRY_ENABLED: "true",
      SUPEROPS_CONTINUATION_WORKFLOW: {
        createBatch: async (batch) => { batches.push(batch); return batch.map(({ id }) => ({ id })); },
      },
    });
    await durableObject.fetch(new Request("https://operation.local/operations/op-workflow-accounting", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record({ operationId: "op-workflow-accounting" })),
    }));

    let subrequests = 0;
    let workflowCalls = 0;
    await runWithExecutionConfig(
      { SUPEROPS_EXECUTION_SUBREQUEST_BUDGET: "5", SUPEROPS_EXECUTION_SUBREQUEST_SAFETY_MARGIN: "1" },
      async () => {
        await runWithExecutionContext("workflow_create_batch_accounting_test", async () => {
          const response = await durableObject.fetch(new Request("https://operation.local/operations/op-workflow-accounting/schedule-continuation", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              operationId: "op-workflow-accounting", ownerHash: stableHash("owner@example.com"),
              reason: "RateLimitedRescheduled", nextEligibleTime: "2026-07-18T00:05:00.000Z",
            }),
          }));
          expect(response.ok).toBe(true);
          const state = getExecutionState();
          subrequests = state?.subrequests ?? 0;
          workflowCalls = state?.requests.filter(
            (request) => request.operationType === "workflow" && request.operationName === "continuationCreateBatch"
          ).length ?? 0;
        });
      }
    );

    expect(batches).toHaveLength(1);
    expect(subrequests).toBe(1);
    expect(workflowCalls).toBe(1);
  });

  it("fails closed when Workflow creation does not acknowledge the requested instance", async () => {
    const values = new Map<string, unknown>();
    const durableObject = new SuperOpsOperationLedger({
      storage: {
        get: async <T = unknown>(key: string) => values.get(key) as T | undefined,
        put: async (key: string, value: unknown) => { values.set(key, value); },
        delete: async (key: string) => values.delete(key),
        list: async <T = unknown>() => values as Map<string, T>,
      },
    }, {
      SUPEROPS_CONTINUATION_ENABLED: "true",
      SUPEROPS_DURABLE_RETRY_ENABLED: "true",
      SUPEROPS_EXECUTION_MAX_SCHEDULING_ATTEMPTS: "1",
      SUPEROPS_CONTINUATION_WORKFLOW: {
        createBatch: async () => [],
      },
    });
    await durableObject.fetch(new Request("https://operation.local/operations/op-workflow-no-ack", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record({ operationId: "op-workflow-no-ack" })),
    }));

    const response = await durableObject.fetch(new Request(
      "https://operation.local/operations/op-workflow-no-ack/schedule-continuation",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operationId: "op-workflow-no-ack",
          ownerHash: stableHash("owner@example.com"),
          reason: "RateLimitedRescheduled",
          nextEligibleTime: "2026-07-18T00:05:00.000Z",
        }),
      }
    ));

    await expect(response.json()).resolves.toMatchObject({
      state: "CompletedWithFailures",
      schedulingAttempted: true,
      schedulingSucceeded: false,
      schedulingAttemptCount: 1,
      schedulingError: expect.stringContaining("did not acknowledge"),
      terminalFailureReason: expect.stringContaining("did not acknowledge"),
    });
  });
  it("counts one failed Workflow scheduling attempt and stops at the invocation limit", async () => {
    const values = new Map<string, unknown>();
    let attempts = 0;
    const durableObject = new SuperOpsOperationLedger({
      storage: {
        get: async <T = unknown>(key: string) => values.get(key) as T | undefined,
        put: async (key: string, value: unknown) => { values.set(key, value); },
        delete: async (key: string) => values.delete(key),
        list: async <T = unknown>() => values as Map<string, T>,
      },
    }, {
      SUPEROPS_CONTINUATION_ENABLED: "true",
      SUPEROPS_DURABLE_RETRY_ENABLED: "true",
      SUPEROPS_EXECUTION_MAX_SCHEDULING_ATTEMPTS: "3",
      SUPEROPS_CONTINUATION_WORKFLOW: {
        createBatch: async () => { attempts += 1; throw new Error("workflow unavailable"); },
      },
    });
    await durableObject.fetch(new Request("https://operation.local/operations/op-workflow-budget", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record({ operationId: "op-workflow-budget" })),
    }));

    let subrequests = 0;
    let workflowCalls = 0;
    let failedWorkflowCalls = 0;
    let body: unknown;
    await runWithExecutionConfig(
      { SUPEROPS_EXECUTION_SUBREQUEST_BUDGET: "1", SUPEROPS_EXECUTION_SUBREQUEST_SAFETY_MARGIN: "0" },
      async () => {
        await runWithExecutionContext("workflow_create_batch_limit_test", async () => {
          const response = await durableObject.fetch(new Request("https://operation.local/operations/op-workflow-budget/schedule-continuation", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              operationId: "op-workflow-budget", ownerHash: stableHash("owner@example.com"),
              reason: "RateLimitedRescheduled", nextEligibleTime: "2026-07-18T00:05:00.000Z",
            }),
          }));
          body = await response.json();
          const state = getExecutionState();
          subrequests = state?.subrequests ?? 0;
          const workflowRequests = state?.requests.filter(
            (request) => request.operationType === "workflow" && request.operationName === "continuationCreateBatch"
          ) ?? [];
          workflowCalls = workflowRequests.length;
          failedWorkflowCalls = workflowRequests.filter((request) => request.ok === false).length;
        });
      }
    );

    expect(attempts).toBe(1);
    expect(subrequests).toBe(1);
    expect(workflowCalls).toBe(1);
    expect(failedWorkflowCalls).toBe(1);
    expect(body).toMatchObject({
      state: "CompletedWithFailures",
      schedulingAttempted: true,
      schedulingSucceeded: false,
      schedulingAttemptCount: 1,
    });
  });
  it("schedules one idempotent Workflow instance per durable wait", async () => {
    const values = new Map<string, unknown>();
    const batches: Array<Array<{ id: string; params: Record<string, unknown> }>> = [];
    const durableObject = new SuperOpsOperationLedger({
      storage: {
        get: async <T = unknown>(key: string) => values.get(key) as T | undefined,
        put: async (key: string, value: unknown) => { values.set(key, value); },
        delete: async (key: string) => values.delete(key),
        list: async <T = unknown>() => values as Map<string, T>,
        setAlarm: async () => undefined,
      },
    }, {
      SUPEROPS_CONTINUATION_ENABLED: "true",
      SUPEROPS_DURABLE_RETRY_ENABLED: "true",
      SUPEROPS_CONTINUATION_WORKFLOW: {
        createBatch: async (batch) => { batches.push(batch); return batch.map(({ id }) => ({ id })); },
      },
    });
    await durableObject.fetch(new Request("https://operation.local/operations/op-workflow", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record({ operationId: "op-workflow" })),
    }));
    const schedule = () => durableObject.fetch(new Request("https://operation.local/operations/op-workflow/schedule-continuation", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operationId: "op-workflow", ownerHash: stableHash("owner@example.com"),
        reason: "RateLimitedRescheduled", nextEligibleTime: "2026-07-18T00:05:00.000Z",
      }),
    }));
    const first = await schedule();
    const second = await schedule();
    await expect(first.json()).resolves.toMatchObject({
      continuationMechanism: "workflow", schedulingSucceeded: true, continuationCount: 2,
    });
    await expect(second.json()).resolves.toMatchObject({ continuationCount: 2 });
    expect(batches).toHaveLength(1);
    expect(batches[0][0].params).toEqual(expect.objectContaining({
      operationId: "op-workflow", ownerHash: stableHash("owner@example.com"),
      nextEligibleTime: "2026-07-18T00:05:00.000Z",
    }));
    expect(JSON.stringify(batches)).not.toContain("note");
  });

  it("retries Workflow creation with bounded backoff and one deterministic identity", async () => {
    const values = new Map<string, unknown>();
    const identities: string[] = [];
    let attempts = 0;
    const durableObject = new SuperOpsOperationLedger({
      storage: {
        get: async <T = unknown>(key: string) => values.get(key) as T | undefined,
        put: async (key: string, value: unknown) => { values.set(key, value); },
        delete: async (key: string) => values.delete(key),
        list: async <T = unknown>() => values as Map<string, T>,
      },
    }, {
      SUPEROPS_CONTINUATION_ENABLED: "true",
      SUPEROPS_DURABLE_RETRY_ENABLED: "true",
      SUPEROPS_EXECUTION_MAX_SCHEDULING_ATTEMPTS: "3",
      SUPEROPS_CONTINUATION_WORKFLOW: {
        createBatch: async (batch) => {
          attempts += 1;
          identities.push(batch[0].id);
          if (attempts < 3) throw new Error("transient workflow failure");
          return batch.map(({ id }) => ({ id }));
        },
      },
    });
    await durableObject.fetch(new Request("https://operation.local/operations/op-workflow-retry", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record({ operationId: "op-workflow-retry" })),
    }));
    const response = await durableObject.fetch(new Request(
      "https://operation.local/operations/op-workflow-retry/schedule-continuation", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operationId: "op-workflow-retry", ownerHash: stableHash("owner@example.com"),
          reason: "RateLimitedRescheduled", nextEligibleTime: "2026-07-18T00:05:00.000Z",
        }),
      }
    ));
    await expect(response.json()).resolves.toMatchObject({
      schedulingSucceeded: true, schedulingAttemptCount: 3, continuationMechanism: "workflow",
    });
    expect(attempts).toBe(3);
    expect(new Set(identities).size).toBe(1);
  });

  it("terminalizes a bounded Workflow scheduling failure without losing possible-write truth", async () => {
    const values = new Map<string, unknown>();
    const durableObject = new SuperOpsOperationLedger({
      storage: {
        get: async <T = unknown>(key: string) => values.get(key) as T | undefined,
        put: async (key: string, value: unknown) => { values.set(key, value); },
        delete: async (key: string) => values.delete(key),
        list: async <T = unknown>() => values as Map<string, T>,
        setAlarm: async () => undefined,
      },
    }, {
      SUPEROPS_CONTINUATION_ENABLED: "true",
      SUPEROPS_DURABLE_RETRY_ENABLED: "true",
      SUPEROPS_EXECUTION_MAX_SCHEDULING_ATTEMPTS: "3",
      SUPEROPS_CONTINUATION_WORKFLOW: {
        createBatch: async () => { throw new Error("workflow unavailable"); },
      },
    });
    const possible = record({
      operationId: "op-workflow-failure",
      itemStates: {
        ...record().itemStates,
        "57401": {
          ...record().itemStates["57401"], stage: "WriteStarted",
          writeAttempted: true, writeMayHaveSucceeded: true,
        },
      },
    });
    await durableObject.fetch(new Request("https://operation.local/operations/op-workflow-failure", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(possible),
    }));
    const response = await durableObject.fetch(new Request("https://operation.local/operations/op-workflow-failure/schedule-continuation", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operationId: "op-workflow-failure", ownerHash: stableHash("owner@example.com"),
        reason: "RateLimitedRescheduled", nextEligibleTime: "2026-07-18T00:05:00.000Z",
      }),
    }));
    await expect(response.json()).resolves.toMatchObject({
      state: "CompletedWithFailures", schedulingAttempted: true, schedulingSucceeded: false,
      schedulingAttemptCount: 3,
      itemStates: { "57401": { stage: "AmbiguousWriteUnresolved", writeMayHaveSucceeded: true } },
    });
  });

  it("restarts retention through the Durable Object completion dispatch path", async () => {
    const values = new Map<string, unknown>();
    const alarms: number[] = [];
    const durableObject = new SuperOpsOperationLedger({
      storage: {
        get: async <T = unknown>(key: string) => values.get(key) as T | undefined,
        put: async (key: string, value: unknown) => { values.set(key, value); },
        delete: async (key: string) => values.delete(key),
        list: async <T = unknown>() => values as Map<string, T>,
        setAlarm: async (time: number | Date) => { alarms.push(Number(time)); },
      },
    });
    const ownerHash = stableHash("owner@example.com");
    const lease = {
      leaseId: "terminal-retention-lease",
      owner: "terminal-retention",
      expiresAt: "2999-01-01T00:00:00.000Z",
    };
    const active = record({
      operationId: "op-do-terminal-retention",
      createdAt: "2000-01-01T00:00:00.000Z",
      updatedAt: "2000-01-01T00:00:01.000Z",
      expiresAt: "2000-01-02T00:00:00.000Z",
      state: "Running",
      expectedItems: ["57401"],
      itemStates: {
        "57401": {
          ...record().itemStates["57401"],
          stage: "WriteStarted",
          writeAttempted: true,
          writeMayHaveSucceeded: true,
          lease,
        },
      },
      compactResults: [],
      currentLease: lease,
    });
    const put = await durableObject.fetch(new Request(
      "https://operation.local/operations/op-do-terminal-retention",
      { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(active) }
    ));
    expect(put.status, await put.clone().text()).toBe(200);

    const completed = await durableObject.fetch(new Request(
      "https://operation.local/operations/op-do-terminal-retention/complete-item",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operationId: active.operationId,
          ownerHash,
          itemKey: "57401",
          leaseId: lease.leaseId,
          patch: {
            stage: "Completed",
            outcome: "Updated",
            writeAttempted: true,
            writeMayHaveSucceeded: true,
            verificationState: "Verified",
          },
        }),
      }
    ));
    expect(completed.status).toBe(200);
    const completedRecord = await completed.json() as OperationLedgerRecord;
    expect(completedRecord.state).toBe("Completed");
    expect(Date.parse(completedRecord.expiresAt)).toBeGreaterThan(Date.now());
    expect(alarms.at(-1)).toBe(Date.parse(completedRecord.expiresAt));
  });

  it("cleans expired terminal records from an alarm independently of reads", async () => {
    const values = new Map<string, unknown>();
    const alarms: number[] = [];
    const durableObject = new SuperOpsOperationLedger({
      storage: {
        get: async <T = unknown>(key: string) => values.get(key) as T | undefined,
        put: async (key: string, value: unknown) => { values.set(key, value); },
        delete: async (key: string) => values.delete(key),
        list: async <T = unknown>() => values as Map<string, T>,
        setAlarm: async (time: number | Date) => { alarms.push(Number(time)); },
      },
    });
    values.set("op:expired", record({
      operationId: "expired", state: "Completed", expiresAt: "2000-01-01T00:00:00.000Z",
      expectedItems: ["57400"], itemStates: { "57400": record().itemStates["57400"] },
    }));
    values.set("op:retained", record({
      operationId: "retained", state: "Completed", expiresAt: "2999-01-01T00:00:00.000Z",
      expectedItems: ["57400"], itemStates: { "57400": record().itemStates["57400"] },
    }));
    await durableObject.alarm();
    expect(values.has("op:expired")).toBe(false);
    expect(values.has("op:retained")).toBe(true);
    expect(alarms).toEqual([Date.parse("2999-01-01T00:00:00.000Z")]);
  });

  it("normalizes abandoned operations at maximum lifetime without losing possible-write evidence", async () => {
    const values = new Map<string, unknown>();
    const alarms: number[] = [];
    const durableObject = new SuperOpsOperationLedger({
      storage: {
        get: async <T = unknown>(key: string) => values.get(key) as T | undefined,
        put: async (key: string, value: unknown) => { values.set(key, value); },
        delete: async (key: string) => values.delete(key),
        list: async <T = unknown>() => values as Map<string, T>,
        setAlarm: async (time: number | Date) => { alarms.push(Number(time)); },
      },
    });
    const abandoned = record({
      operationId: "abandoned-lifetime",
      maxOperationLifetimeAt: "2000-01-01T00:00:00.000Z",
      expiresAt: "2999-01-01T00:00:00.000Z",
      itemStates: {
        ...record().itemStates,
        "57401": {
          ...record().itemStates["57401"],
          stage: "WriteStarted",
          writeAttempted: true,
          writeMayHaveSucceeded: true,
          ambiguousWrite: true,
          partialWrite: true,
          verificationState: "Pending",
        },
      },
    });
    values.set("op:abandoned-lifetime", abandoned);

    await durableObject.alarm();

    expect(values.get("op:abandoned-lifetime")).toMatchObject({
      state: "CompletedWithFailures",
      terminalFailureReason: "Operation maximum lifetime exceeded.",
      ambiguousWriteCount: 1,
      partialWriteCount: 1,
      itemStates: {
        "57401": {
          stage: "AmbiguousWriteUnresolved",
          writeAttempted: true,
          writeMayHaveSucceeded: true,
          ambiguousWrite: true,
          partialWrite: true,
        },
      },
    });
    expect(alarms.at(-1)).toBeGreaterThan(Date.now());
  });

  it("retains active operations but removes terminal records only after retention expires", async () => {
    await runWithOperationStore({}, async () => {
      const store = getOperationStore();
      await store.put(record({
        operationId: "op-expired-terminal",
        state: "Completed",
        expiresAt: "2000-01-01T00:00:00.000Z",
        expectedItems: ["57400"],
        itemStates: { "57400": record().itemStates["57400"] },
        compactResults: [{ ticketNumber: "57400", finalOutcome: "Updated" }],
      }));
      await store.put(record({
        operationId: "op-expired-active",
        expiresAt: "2000-01-01T00:00:00.000Z",
      }));

      await expect(store.get("op-expired-terminal")).resolves.toBeUndefined();
      await expect(store.get("op-expired-active")).resolves.toMatchObject({
        operationId: "op-expired-active",
        state: "ContinuationRequired",
      });
      await expect(store.list(stableHash("owner@example.com"))).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ operationId: "op-expired-active" })])
      );
    });
  });
  it("marks terminal stale and partial-write outcomes as completed with failures", async () => {
    await runWithOperationStore({}, async () => {
      const store = getOperationStore();
      const staleItem = {
        ...record().itemStates["57401"],
        stage: "Stale" as const,
        outcome: "SkippedChangedSinceSnapshot",
      };
      await store.put(record({
        itemStates: { "57400": record().itemStates["57400"], "57401": staleItem },
      }));
      await expect(store.get("op-1")).resolves.toMatchObject({
        state: "CompletedWithFailures",
        staleItems: ["57401"],
      });
    });
  });

  it("stops an overdue non-terminal operation without discarding possible-write evidence", async () => {
    await runWithOperationStore({}, async () => {
      const store = getOperationStore();
      const ownerHash = stableHash("owner@example.com");
      const initial = record({ operationId: "op-lifetime", maxOperationLifetimeAt: "2026-07-18T00:00:01.000Z" });
      initial.itemStates["57401"] = {
        ...initial.itemStates["57401"], stage: "WriteStarted", writeAttempted: true,
        writeMayHaveSucceeded: true, verificationState: "Pending",
      };
      await store.put(initial);
      await expect(store.claimNextItem({
        operationId: "op-lifetime", ownerHash, leaseOwner: "late-worker", leaseMs: 60_000,
        now: "2026-07-18T00:00:02.000Z",
      })).resolves.toBeUndefined();
      await expect(store.get("op-lifetime")).resolves.toMatchObject({
        state: "CompletedWithFailures", terminalFailureReason: "Operation maximum lifetime exceeded.",
        itemStates: { "57401": { stage: "AmbiguousWriteUnresolved", writeMayHaveSucceeded: true, partialWrite: true } },
      });
    });
  });

  it("counts note-only outcomes from the authoritative mutation type", () => {
    const noteItem = {
      ...record().itemStates["57400"],
      mutationType: "note" as const,
      outcome: "Updated",
    };
    expect(operationTotals(record({
      expectedItems: ["57400"],
      itemStates: { "57400": noteItem },
    }))).toMatchObject({ expected: 1, updated: 1, noteOnly: 1, completed: 1 });
  });

  it("rejects note bodies, oversized item sets, and oversized serialized records", async () => {
    await runWithOperationStore({}, async () => {
      const store = getOperationStore();
      await expect(store.put(record({
        operationId: "op-note-body",
        operationRequest: { actions: [{ ticketNumber: "1", note: "customer content" }] },
      }))).rejects.toThrow(/prohibited customer content/);

      const expectedItems = Array.from({ length: 501 }, (_, index) => String(index));
      await expect(store.put(record({
        operationId: "op-too-many", expectedItems,
      }))).rejects.toThrow(/500-item limit/);

      await expect(store.put(record({
        operationId: "op-too-large", summary: { padding: "x".repeat(600 * 1024) },
      }))).rejects.toThrow(/serialized limit/);
    });
  });

  it("preserves malformed stored operation classification through the durable store client", async () => {
    const durable = ownerScopedDurableNamespace();
    const ownerHash = stableHash("owner@example.com");
    durable.valuesFor("owner:" + ownerHash).set("op:malformed-client", { operationId: "malformed-client" });

    await runWithOperationStore({ SUPEROPS_OPERATION_LEDGER: durable.namespace }, async () => {
      const store = getOperationStore();
      await expect(store.get("malformed-client", ownerHash)).rejects.toMatchObject({
        name: "MalformedStoredOperationError",
      });
    });
  });
  it("returns a stable malformed-operation error without fabricating state", async () => {
    const values = new Map<string, unknown>([["op:malformed", { operationId: "malformed" }]]);
    const durableObject = new SuperOpsOperationLedger({
      storage: {
        get: async <T = unknown>(key: string) => values.get(key) as T | undefined,
        put: async (key: string, value: unknown) => { values.set(key, value); },
        delete: async (key: string) => values.delete(key),
        list: async <T = unknown>() => values as Map<string, T>,
      },
    });
    const response = await durableObject.fetch(
      new Request("https://operation.local/operations/malformed")
    );
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ errorClass: "MalformedStoredOperation" });
    expect(values.get("op:malformed")).toEqual({ operationId: "malformed" });
  });
});
