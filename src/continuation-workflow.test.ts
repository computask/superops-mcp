import { describe, expect, it, vi } from "vitest";
import { getExecutionState } from "./execution.js";
import { SuperOpsContinuationWorkflow } from "./continuation-workflow.js";
import {
  getOperationStore,
  runWithOperationStore,
  stableHash,
  SuperOpsOperationLedger,
} from "./operation-store.js";

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

function activeRecord() {
  return {
    ...terminalRecord(),
    operationId: "workflow-exhausted-op",
    state: "ContinuationRequired" as const,
    completedItems: [],
    failedItems: [],
    pendingItems: ["57400"],
    unattemptedItems: ["57400"],
    compactResults: [],
    itemStates: {
      "57400": {
        ...terminalRecord().itemStates["57400"],
        stage: "Unattempted" as const,
        outcome: "NotAttemptedExecutionStopped",
        writeAttempted: false,
        writeMayHaveSucceeded: false,
        partialWrite: false,
      },
    },
  };
}

function ownerScopedDurableNamespace() {
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
              if (typeof key === "string") values.set(key, value);
              else for (const [entryKey, entryValue] of Object.entries(key)) values.set(entryKey, entryValue);
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
  return { namespace };
}

function workflowStep(afterDo?: (name: string) => void) {
  return {
    sleepUntil: vi.fn(async () => undefined),
    do: vi.fn(async (
      name: string,
      configOrCallback: unknown,
      maybeCallback?: () => Promise<unknown>
    ) => {
      const callback = typeof configOrCallback === "function"
        ? configOrCallback as () => Promise<unknown>
        : maybeCallback!;
      const result = await callback();
      afterDo?.(name);
      return result;
    }),
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

  it("retries a Too Early internal wake and records only the successful delivery", async () => {
    const initial = activeRecord();
    await runWithOperationStore({}, () => getOperationStore().put(initial));
    let calls = 0;
    const workflow = new SuperOpsContinuationWorkflow(undefined, {
      SUPEROPS_CONTINUATION_SERVICE: {
        fetch: vi.fn(async () => {
          calls += 1;
          return calls === 1
            ? new Response(JSON.stringify({ ok: false, retryable: true }), { status: 425 })
            : new Response(JSON.stringify({ ok: true }), { status: 200 });
        }),
      },
      SUPEROPS_INTERNAL_CONTINUATION_TOKEN: "internal-token",
    });
    const step = {
      sleepUntil: vi.fn(async () => undefined),
      do: vi.fn(async (
        name: string,
        configOrCallback: unknown,
        maybeCallback?: () => Promise<unknown>
      ) => {
        const callback = typeof configOrCallback === "function"
          ? configOrCallback as () => Promise<unknown>
          : maybeCallback!;
        if (name !== "deliver-checked-continuation") return callback();
        try {
          return await callback();
        } catch {
          return callback();
        }
      }),
    };

    await expect(workflow.run({
      payload: {
        operationId: initial.operationId,
        ownerHash: initial.ownerHash,
        nextEligibleTime: "2026-07-18T00:05:00.000Z",
        scheduleIdentity: "wf-too-early",
      },
      timestamp: new Date(),
      instanceId: "wf-too-early",
      workflowName: "test",
    }, step)).resolves.toEqual({ operationId: initial.operationId, delivered: true });

    expect(calls).toBe(2);
    await expect(getOperationStore().get(initial.operationId)).resolves.toMatchObject({
      wakeAttemptCount: 2,
      wakeDeliveryCount: 1,
      lastWakeAttemptAt: expect.any(String),
      lastWakeSucceededAt: expect.any(String),
    });
  });
  it("creates a fresh accounting context for each Workflow delivery", async () => {
    const firstRecord = { ...terminalRecord(), operationId: "workflow-fresh-1", originalRequestHash: stableHash("workflow-fresh-1") };
    const secondRecord = { ...terminalRecord(), operationId: "workflow-fresh-2", originalRequestHash: stableHash("workflow-fresh-2") };
    await runWithOperationStore({}, async () => {
      await getOperationStore().put(firstRecord);
      await getOperationStore().put(secondRecord);
    });

    const snapshots: Array<{ invocationId?: string; operationId?: string; subrequests: number }> = [];
    const service = { fetch: vi.fn(async () => {
      const state = getExecutionState();
      snapshots.push({
        invocationId: state?.invocationId,
        operationId: state?.operationId,
        subrequests: state?.subrequests ?? 0,
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) };
    const workflow = new SuperOpsContinuationWorkflow(undefined, {
      SUPEROPS_CONTINUATION_SERVICE: service,
      SUPEROPS_INTERNAL_CONTINUATION_TOKEN: "internal-token",
    });

    for (const record of [firstRecord, secondRecord]) {
      await workflow.run({
        payload: {
          operationId: record.operationId,
          ownerHash: record.ownerHash,
          nextEligibleTime: "2026-07-18T00:05:00.000Z",
          scheduleIdentity: `wf-${record.operationId}`,
        },
        timestamp: new Date(),
        instanceId: `wf-${record.operationId}`,
        workflowName: "test",
      }, workflowStep());
    }

    expect(service.fetch).toHaveBeenCalledTimes(2);
    expect(snapshots).toEqual([
      expect.objectContaining({ operationId: "workflow-fresh-1", subrequests: 1 }),
      expect.objectContaining({ operationId: "workflow-fresh-2", subrequests: 1 }),
    ]);
    expect(snapshots[0].invocationId).toBeTruthy();
    expect(snapshots[1].invocationId).toBeTruthy();
    expect(snapshots[0].invocationId).not.toBe(snapshots[1].invocationId);
  });

  it("counts Durable Object store and service-binding calls during Workflow delivery", async () => {
    const durable = ownerScopedDurableNamespace();
    await runWithOperationStore({ SUPEROPS_OPERATION_LEDGER: durable.namespace }, () =>
      getOperationStore().put(terminalRecord())
    );

    const workflow = new SuperOpsContinuationWorkflow(undefined, {
      SUPEROPS_OPERATION_LEDGER: durable.namespace,
      SUPEROPS_CONTINUATION_SERVICE: {
        fetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
      },
      SUPEROPS_INTERNAL_CONTINUATION_TOKEN: "internal-token",
    });
    const snapshots: Array<{ subrequests: number; durableObjectCalls: number; serviceBindingCalls: number }> = [];

    await workflow.run({
      payload: {
        operationId: "workflow-op",
        ownerHash: stableHash("workflow-owner"),
        nextEligibleTime: "2026-07-18T00:05:00.000Z",
        scheduleIdentity: "wf-123",
      },
      timestamp: new Date(),
      instanceId: "wf-123",
      workflowName: "test",
    }, workflowStep((name) => {
      if (name !== "deliver-checked-continuation") return;
      const state = getExecutionState();
      snapshots.push({
        subrequests: state?.subrequests ?? 0,
        durableObjectCalls: state?.requests.filter((request) => request.operationType === "durableObject").length ?? 0,
        serviceBindingCalls: state?.requests.filter((request) => request.operationType === "serviceBinding").length ?? 0,
      });
    }));

    expect(snapshots).toEqual([{ subrequests: 7, durableObjectCalls: 6, serviceBindingCalls: 1 }]);
  });
  it("records exhausted Workflow delivery as a durable terminal failure", async () => {
    const initial = activeRecord();
    await runWithOperationStore({}, () => getOperationStore().put(initial));
    const workflow = new SuperOpsContinuationWorkflow(undefined, {
      SUPEROPS_CONTINUATION_SERVICE: {
        fetch: vi.fn(async () => new Response("unavailable", { status: 503 })),
      },
      SUPEROPS_INTERNAL_CONTINUATION_TOKEN: "internal-token",
    });
    const step = {
      sleepUntil: vi.fn(async () => undefined),
      do: vi.fn(async (
        _name: string,
        configOrCallback: unknown,
        maybeCallback?: () => Promise<unknown>
      ) => {
        const callback = typeof configOrCallback === "function"
          ? configOrCallback as () => Promise<unknown>
          : maybeCallback!;
        return callback();
      }),
    };

    await expect(workflow.run({
      payload: {
        operationId: initial.operationId,
        ownerHash: initial.ownerHash,
        nextEligibleTime: "2026-07-18T00:05:00.000Z",
        scheduleIdentity: "wf-exhausted",
      },
      timestamp: new Date(),
      instanceId: "wf-exhausted",
      workflowName: "test",
    }, step)).resolves.toEqual({
      operationId: initial.operationId,
      delivered: false,
    });

    const stored = await getOperationStore().get(initial.operationId);
    expect(stored).toMatchObject({
      state: "CompletedWithFailures",
      wakeDeliveryError: "Workflow continuation delivery retry limit exhausted.",
      itemStates: {
        "57400": {
          stage: "FailedBeforeWrite",
          outcome: "ContinuationDeliveryFailed",
          errorClass: "ContinuationExecutionFailure",
          writeAttempted: false,
        },
      },
    });
  });
});
