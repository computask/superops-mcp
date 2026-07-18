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
});