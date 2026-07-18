import { describe, expect, it } from "vitest";
import {
  getOperationStore,
  operationResultView,
  runWithOperationStore,
  stableHash,
  SuperOpsOperationLedger,
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

describe("operation store", () => {
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

  it("returns a compact result view without sensitive operational internals", () => {
    const view = operationResultView(record());

    expect(view).toMatchObject({
      operationId: "op-1",
      state: "ContinuationRequired",
      completedCount: 1,
      unattemptedCount: 1,
      continuationCount: 1,
    });
    expect(JSON.stringify(view)).not.toContain("originalRequestHash");
    expect(JSON.stringify(view)).not.toContain("idempotencyKey");
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
});
