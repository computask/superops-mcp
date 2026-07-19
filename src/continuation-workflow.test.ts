import { describe, expect, it, vi } from "vitest";
import { SuperOpsContinuationWorkflow } from "./continuation-workflow.js";
import { getOperationStore, runWithOperationStore, stableHash } from "./operation-store.js";

function terminalRecord() {
  return {
    responseVersion: 1 as const,
    operationId: "workflow-op",
    toolName: "superops_tickets_apply_triage_plan",
    ownerHash: stableHash("workflow-owner"),
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:01.000Z",
    expiresAt: "2999-01-01T00:00:00.000Z",
    originalRequestHash: stableHash("workflow-op"),
    state: "Completed" as const,
    expectedItems: ["57400"], currentItem: "57400",
    completedItems: ["57400"], failedItems: [], skippedItems: [], unattemptedItems: [], pendingItems: [],
    itemStates: { "57400": {
      itemKey: "57400", stage: "Completed" as const, outcome: "Updated",
      idempotencyKey: "item-57400", writeAttempted: true, writeMayHaveSucceeded: true,
      partialWrite: false, retryCount: 0,
    } },
    summary: { updated: 1 }, compactResults: [{ ticketNumber: "57400", finalOutcome: "Updated" }],
    partialWriteCount: 0, ambiguousWriteCount: 0, rateLimitedItems: [], continuationCount: 1,
  };
}

describe("SuperOps continuation Workflow", () => {
  it("durably sleeps then calls the guarded real continuation route with compact identity", async () => {
    await runWithOperationStore({}, () => getOperationStore().put(terminalRecord()));
    const requests: Request[] = [];
    const service = { fetch: vi.fn(async (request: Request) => {
      requests.push(request);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) };
    const workflow = new SuperOpsContinuationWorkflow(undefined, {
      SUPEROPS_CONTINUATION_SERVICE: service,
      SUPEROPS_INTERNAL_CONTINUATION_TOKEN: "internal-token",
    });
    const sleeps: number[] = [];
    const step = {
      sleepUntil: vi.fn(async (_name: string, timestamp: Date | number) => {
        sleeps.push(Number(timestamp));
      }),
      do: vi.fn(async (_name: string, configOrCallback: unknown, maybeCallback?: () => Promise<unknown>) => {
        const callback = typeof configOrCallback === "function"
          ? configOrCallback as () => Promise<unknown>
          : maybeCallback!;
        return callback();
      }),
    };
    const payload = {
      operationId: "workflow-op",
      ownerHash: stableHash("workflow-owner"),
      nextEligibleTime: "2026-07-18T00:05:00.000Z",
      scheduleIdentity: "wf-123",
    };
    await workflow.run({
      payload, timestamp: new Date(), instanceId: "wf-123", workflowName: "test",
    }, step);
    expect(sleeps).toEqual([Date.parse(payload.nextEligibleTime)]);
    expect(requests).toHaveLength(1);
    expect(requests[0].headers.get("X-SuperOps-Internal-Continuation")).toBe("internal-token");
    await expect(requests[0].json()).resolves.toEqual({
      toolName: "superops_tickets_apply_triage_plan",
      operationId: "workflow-op",
      ownerHash: stableHash("workflow-owner"),
    });
    const record = await getOperationStore().get("workflow-op");
    expect(record).toMatchObject({ wakeAttemptCount: 1, wakeDeliveryCount: 1 });
    expect(JSON.stringify(requests)).not.toContain("note");
  });
});