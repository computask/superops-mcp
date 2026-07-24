/**
 * Fixed-seed, no-network continuation acceptance harness.  It deliberately
 * uses the public apply-triage entry point and resume adapter, with only the
 * SuperOps transport mocked.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { runWithCredentials } from "./client.js";
import { getExecutionState, runWithExecutionConfig, runWithExecutionContext } from "./execution.js";
import { getOperationStore, operationTotals, runWithOperationStore } from "./operation-store.js";
import { getTicketsTools, resumeApplyTriageOperation } from "./domains/tickets.js";
import { runWithContinuationScheduler } from "./continuation-scheduler.js";

const SEED = 0x5eed250;
const EXPECTED = 250;
const MAX_HARNESS_CONTINUATION_INVOCATIONS = EXPECTED * 4;
const LARGE_HARNESS_TIMEOUT_MS = 120_000;
const UPDATED = "2026-07-18T10:01:00.000Z";

const HARNESS_CREDS = { apiToken: "harness-token", subdomain: "harness" };

function graphQlData(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function graphQlThrottle(retryAfter: number): Response {
  return new Response(JSON.stringify({
    errors: [{ message: "GraphQL throttled", extensions: { code: "THROTTLED", retryAfter } }],
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonBody(init?: RequestInit): { query: string; variables?: { input?: Record<string, unknown> } } {
  if (typeof init?.body !== "string") throw new Error("missing mocked GraphQL body");
  return JSON.parse(init.body) as { query: string; variables?: { input?: Record<string, unknown> } };
}

function runWithHarnessCredentials<T>(fn: () => T): T {
  return runWithCredentials(HARNESS_CREDS, fn);
}
async function deliverInternalContinuation(operationId: string, ownerHash: string): Promise<Response> {
  const worker = (await import("./worker.js")).default;
  return worker.fetch(
    new Request("http://worker.local/internal/operations/continue", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-SuperOps-Internal-Continuation": "harness-internal-token",
      },
      body: JSON.stringify({
        toolName: "superops_tickets_apply_triage_plan",
        operationId,
        ownerHash,
      }),
    }),
    {
      SUPEROPS_CONTINUATION_ENABLED: "true",
      SUPEROPS_DURABLE_RETRY_ENABLED: "true",
      SUPEROPS_INTERNAL_CONTINUATION_TOKEN: "harness-internal-token",
      SUPEROPS_API_TOKEN: HARNESS_CREDS.apiToken,
      SUPEROPS_SUBDOMAIN: HARNESS_CREDS.subdomain,
      SUPEROPS_EXECUTION_SUBREQUEST_BUDGET: "14",
      SUPEROPS_EXECUTION_SUBREQUEST_SAFETY_MARGIN: "2",
      SUPEROPS_EXECUTION_SAFE_REMAINING_TIME_MS: "0",
      SUPEROPS_EXECUTION_MAX_CONTINUATION_COUNT: "1000",
    }
  );
}
function withSuccessfulContinuationScheduling<T>(fn: () => T): T {
  return runWithContinuationScheduler({
    SUPEROPS_CONTINUATION_ENABLED: "true",
    SUPEROPS_DURABLE_RETRY_ENABLED: "true",
    SUPEROPS_INTERNAL_CONTINUATION_TOKEN: "harness-internal-token",
    SUPEROPS_CONTINUATION_SERVICE: {
      fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    },
  }, fn);
}

const resolutionTarget = {
  status: "Resolved", priority: "Very Low", impact: "Low", urgency: "Low",
  category: "7. Sales call", subcategory: "No Action Needed", cause: "No Fault Found",
  resolutionCode: "Permanent Fix",
};

function fields() {
  const options = (columnName: string, values: string[], parent?: { columnName: string; value: string }) => ({
    id: `${columnName}-field`, module: "TICKET", columnName, label: columnName,
    options: values.map((value) => ({ id: `${columnName}-${value}`, value, parentOption: parent ? { id: `${parent.columnName}-${parent.value}`, value: parent.value } : undefined })),
    parentField: parent ? { id: `${parent.columnName}-field`, columnName: parent.columnName } : undefined,
  });
  return [
    options("priority", ["Very Low"]), options("impact", ["Low"]), options("urgency", ["Low"]),
    options("category", ["7. Sales call"]), options("subcategory", ["No Action Needed"], { columnName: "category", value: "7. Sales call" }),
    options("resolutionCode", ["Permanent Fix"]), options("cause", ["No Fault Found"]),
  ];
}

class Seeded {
  constructor(private value: number) {}
  next() { this.value = (Math.imul(this.value, 1664525) + 1013904223) >>> 0; return this.value; }
}

type TicketState = { ticketId: string; displayId: string; status: string; updatedTime: string; notes: Array<{ noteId: string; content: string; privacyType: string }> };

const TERMINAL_ITEM_STAGES = new Set([
  "Completed",
  "CompletedAfterRetry",
  "CompletedAfterAmbiguousWriteVerification",
  "AmbiguousWriteUnresolved",
  "Stale",
  "Skipped",
  "FailedBeforeWrite",
  "FailedAfterPartialWrite",
  "RateLimitExceeded",
  "StaleAfterRateLimitWait",
]);

const MUTATION_START_STAGES = new Set([
  "WriteStarted",
  "ResolutionWriteStarted",
  "NoteWriteStarted",
]);

describe("fixed-seed mixed-fault 250-item apply-triage continuation harness", () => {
  afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

  it("accounts for every item through the real adapter without duplicate mutations", async () => {
    const random = new Seeded(SEED);
    const numbers = Array.from({ length: EXPECTED }, (_, index) => String(70000 + index));
    const tickets = new Map<string, TicketState>(numbers.map((displayId) => [displayId, {
      ticketId: `ticket-${displayId}`, displayId, status: "New Calls", updatedTime: "2026-07-18T10:00:00.000Z", notes: [],
    }]));
    const faults = new Map<string, "lostUpdate" | "lostResolution" | "lostNote" | "rateLimit" | "graphqlThrottle" | "fiveHundred" | "network">();
    const mutationCounts = new Map<string, number>();
    const successfulUpdates = new Map<string, number>();
    const successfulResolutions = new Map<string, number>();
    const successfulNotes = new Map<string, number>();
    const checkpointStages = new Map<string, Set<string>>();
    const actions: Array<Record<string, unknown>> = [];

    for (let index = 0; index < EXPECTED; index += 1) {
      const ticketNumber = numbers[index];
      const common = { ticketNumber, expectedStatus: "New Calls", expectedUpdatedTime: "2026-07-18T10:00:00.000Z", contentVerified: true };
      if (index === 0) {
        actions.push({ ...common, action: "addNote", note: `private harness note ${ticketNumber}`, isPublicNote: false });
      } else if (index === 1) {
        continue; // intentional no-approved-action terminal outcome
      } else if (index === 2) {
        actions.push({ ...common, action: "addNote", note: `private harness note ${ticketNumber}`, isPublicNote: false });
      } else if (index === 37) {
        actions.push({ ...common, action: "skip" });
      } else if (index % 29 === 0) {
        actions.push({ ...common, action: "update", target: { impact: "not-a-live-option" } });
      } else if (index % 31 === 0) {
        tickets.get(ticketNumber)!.updatedTime = "2026-07-18T10:00:01.000Z";
        actions.push({ ...common, action: "update", target: { status: "Awaiting Engineer" } });
      } else if (index % 7 === 0) {
        actions.push({ ...common, action: "resolve", target: resolutionTarget });
      } else if (index % 5 === 0) {
        actions.push({ ...common, action: "addNote", note: `private harness note ${ticketNumber}`, isPublicNote: false });
      } else {
        actions.push({ ...common, action: "update", target: { status: "Awaiting Engineer" } });
      }
    }
    // Deterministic representative injected transport faults, selected after
    // action construction so each maps to an actual mutation-capable item.
    const mutationCandidates = actions.filter((action) => action.action !== "update" || (action.target as { impact?: string }).impact !== "not-a-live-option")
      .filter((action) => tickets.get(String(action.ticketNumber))!.updatedTime.endsWith("00.000Z"));
    const updateCandidate = mutationCandidates.find((action) => action.action === "update")!;
    const resolveCandidate = mutationCandidates.find((action) => action.action === "resolve")!;
    const noteCandidate = mutationCandidates.find((action) => action.ticketNumber === numbers[0])!;
    faults.set(String(updateCandidate.ticketNumber), "lostUpdate");
    faults.set(String(resolveCandidate.ticketNumber), "lostResolution");
    faults.set(String(noteCandidate.ticketNumber), "lostNote");
    const remainingUpdates = mutationCandidates.filter((action) => action.action === "update" &&
      !faults.has(String(action.ticketNumber)));
    // The seed fixes which representative ordinary updates receive reliable
    // throttling and ambiguous 5xx/network failures; all fault keys are distinct.
    const chooseUpdate = () => remainingUpdates.splice(random.next() % remainingUpdates.length, 1)[0]!;
    const rateLimitCandidate = chooseUpdate();
    const graphQlThrottleCandidate = chooseUpdate();
    const fiveHundredCandidate = chooseUpdate();
    const networkCandidate = chooseUpdate();
    faults.set(String(rateLimitCandidate.ticketNumber), "rateLimit");
    faults.set(String(graphQlThrottleCandidate.ticketNumber), "graphqlThrottle");
    faults.set(String(fiveHundredCandidate.ticketNumber), "fiveHundred");
    faults.set(String(networkCandidate.ticketNumber), "network");
    const staleDuringWaitCandidate = [...remainingUpdates]
      .reverse().find((action) => Number(action.ticketNumber) > Number(rateLimitCandidate.ticketNumber)) ?? remainingUpdates.at(-1)!;
    const checkpointFailureCandidate = remainingUpdates.find((action) => !faults.has(String(action.ticketNumber)))!;
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const { query, variables } = jsonBody(init);
      const input = variables?.input ?? {};
      if (query.includes("getTicketList")) {
        const condition = input.condition as { value?: string } | undefined;
        const ticket = tickets.get(String(condition?.value ?? ""));
        return graphQlData({ getTicketList: { tickets: ticket ? [{ ticketId: ticket.ticketId, displayId: ticket.displayId }] : [], listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: ticket ? 1 : 0 } } });
      }
      if (query.includes("getTicketNoteList")) {
        const ticket = [...tickets.values()].find((item) => item.ticketId === input.ticketId);
        return graphQlData({ getTicketNoteList: ticket?.notes ?? [] });
      }
      if (query.includes("getFields")) return graphQlData({ getFields: fields() });
      if (query.includes("mutation")) {
        const ticketId = String((input.ticket as { ticketId?: string } | undefined)?.ticketId ?? input.ticketId ?? "");
        const ticket = [...tickets.values()].find((item) => item.ticketId === ticketId);
        if (!ticket) throw new Error("missing ticket");
        const isNote = query.includes("createTicketNote");
        const fault = faults.get(ticket.displayId);
        const count = (mutationCounts.get(ticket.displayId) ?? 0) + 1;
        mutationCounts.set(ticket.displayId, count);
        if (fault === "rateLimit" && count === 1) {
          return new Response("rate limited", { status: 429, statusText: "Too Many Requests", headers: { "Retry-After": "3600" } });
        }
        if (fault === "graphqlThrottle" && count === 1) return graphQlThrottle(3600);
        if (fault === "fiveHundred" && count === 1) {
          return new Response("server error", { status: 500, statusText: "Internal Server Error" });
        }
        if (fault === "network" && count === 1) throw new Error("network timeout");
        if (isNote) {
          const noteId = `note-${ticket.displayId}`;
          ticket.notes.push({ noteId, content: String(input.content ?? ""), privacyType: "PRIVATE" });
          successfulNotes.set(ticket.displayId, (successfulNotes.get(ticket.displayId) ?? 0) + 1);
          if (fault === "lostNote" && count === 1) throw new Error("network response lost after accepted private note");
          return graphQlData({ createTicketNote: { noteId, content: input.content, privacyType: "PRIVATE" } });
        }
        Object.assign(ticket, input, { updatedTime: UPDATED });
        const resolved = String(input.status ?? "") === "Resolved";
        (resolved ? successfulResolutions : successfulUpdates).set(ticket.displayId, ((resolved ? successfulResolutions : successfulUpdates).get(ticket.displayId) ?? 0) + 1);
        if ((fault === "lostUpdate" || fault === "lostResolution") && count === 1) throw new Error("network response lost after accepted mutation");
        return graphQlData({ updateTicket: { ticketId, status: ticket.status } });
      }
      const ticket = [...tickets.values()].find((item) => item.ticketId === input.ticketId);
      if (!ticket) throw new Error("missing ticket");
      return graphQlData({ getTicket: { ...ticket } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await runWithOperationStore({}, async () => {
      const domain = getTicketsTools();
      const store = getOperationStore();
      const callsByInvocation: Array<{ calls: number; effectiveBudget: number; phase: "initial" | "continuation" }> = [];
      let rateLimitRescheduled = 0;
      let schedulingFailures = 0;
      let storeFailures = 0;
      const checkpointItem = store.checkpointItem.bind(store);
      const scheduleContinuation = store.scheduleContinuation.bind(store);
      let failStoreOnce = true;
      let failSchedulingOnce = true;
      // Install the observer before the initial one-item batch: that batch can
      // perform the representative lost-response update through the real path.
      const observeCheckpoint = async (params: Parameters<typeof checkpointItem>[0]) => {
        const next = await checkpointItem(params);
        const stages = checkpointStages.get(params.itemKey) ?? new Set<string>();
        stages.add(params.patch.stage);
        checkpointStages.set(params.itemKey, stages);
        // Model acknowledgement loss after the real durable mutation-start
        // checkpoint. Failing before WriteStarted would fabricate an
        // Unattempted-to-ambiguity path that production correctly rejects.
        if (failStoreOnce && params.itemKey === String(checkpointFailureCandidate.ticketNumber) && params.patch.stage === "WriteStarted") {
          failStoreOnce = false;
          throw new Error("injected operation-store checkpoint acknowledgement loss");
        }
        return next;
      };
      store.checkpointItem = observeCheckpoint;
      store.scheduleContinuation = async (params) => {
        if (params.nextEligibleTime && failSchedulingOnce) {
          failSchedulingOnce = false;
          throw new Error("injected continuation scheduling failure");
        }
        return scheduleContinuation(params);
      };

      let initial!: Awaited<ReturnType<typeof domain.handleCall>>;
      await runWithExecutionConfig({ SUPEROPS_EXECUTION_MAX_ITEMS_PER_BATCH: "4", SUPEROPS_EXECUTION_SUBREQUEST_BUDGET: "45", SUPEROPS_EXECUTION_SUBREQUEST_SAFETY_MARGIN: "8" }, async () => {
        await runWithExecutionContext("superops_tickets_apply_triage_plan", async () => {
          initial = await runWithHarnessCredentials(() => withSuccessfulContinuationScheduling(() =>
            domain.handleCall("superops_tickets_apply_triage_plan", {
              expectedCandidateTicketNumbers: numbers, actions,
            })
          ));
          callsByInvocation.push({ calls: getExecutionState()?.subrequests ?? 0, effectiveBudget: 37, phase: "initial" });
        });
      });
      const initialParsed = JSON.parse(initial.content[0].text);
      const operationId = initialParsed.operation.operationId as string;
      expect(initialParsed.operation).toMatchObject({
        complete: false,
        continuationRequired: true,
        continuationScheduling: { attempted: true, scheduled: true, mechanism: "serviceBinding" },
      });
      const record = await store.get(operationId);
      if (!record) throw new Error("missing harness operation");
      expect(record.schedulingSucceeded).toBe(true);
      expect(record.pendingItems.length).toBeGreaterThan(0);

      const fetchCallsBeforeWrongOwner = fetchMock.mock.calls.length;
      await expect(runWithHarnessCredentials(() =>
        resumeApplyTriageOperation({ operationId, ownerHash: "wrong-owner", leaseOwner: "attacker" })
      )).rejects.toThrow("not found");
      expect(fetchMock).toHaveBeenCalledTimes(fetchCallsBeforeWrongOwner);
      const expired = await store.claimNextItem({ operationId, ownerHash: record.ownerHash, leaseOwner: "expired", leaseMs: 1, now: "2026-07-18T10:00:00.000Z" });
      expect(expired).toBeDefined();
      await expect(store.claimNextItem({
        operationId, ownerHash: record.ownerHash, leaseOwner: "duplicate-wake", leaseMs: 1,
        now: "2026-07-18T10:00:00.000Z",
      })).resolves.toBeUndefined();
      const reclaimed = await store.claimNextItem({
        operationId, ownerHash: record.ownerHash, leaseOwner: "new-owner", leaseMs: 1,
        now: "2026-07-18T10:00:00.002Z",
      });
      expect(reclaimed?.itemKey).toBe(expired?.itemKey);
      await expect(store.completeItem({
        operationId, ownerHash: record.ownerHash, itemKey: expired!.itemKey,
        leaseId: expired!.lease.leaseId,
        patch: { stage: "Skipped", outcome: "stale-claim-must-not-commit" },
      })).rejects.toThrow(/lease mismatch/);

      let malformedStoredOperations = 0;
      try {
        await store.put({ ...record, operationId: "malformed-harness", operationRequest: { note: "forbidden" } });
      } catch {
        malformedStoredOperations += 1;
      }
      let continuationRequired = true;
      let continuationInvocations = 0;
      let durableWaits = 0;
      let maxDurableWaitMs = 0;
      let staleChangedDuringWait = false;
      for (let invocation = 0; continuationRequired && invocation < MAX_HARNESS_CONTINUATION_INVOCATIONS; invocation += 1) {
        continuationInvocations += 1;
        await runWithExecutionConfig({ SUPEROPS_EXECUTION_SUBREQUEST_BUDGET: "14", SUPEROPS_EXECUTION_SUBREQUEST_SAFETY_MARGIN: "2", SUPEROPS_EXECUTION_SAFE_REMAINING_TIME_MS: "0", SUPEROPS_EXECUTION_MAX_CONTINUATION_COUNT: "1000" }, async () => {
          await runWithExecutionContext("superops_tickets_apply_triage_plan", async () => {
            try {
              const now = new Date(Date.parse("2026-07-18T11:00:00.000Z") + invocation * 1000).toISOString();
              const result = await runWithHarnessCredentials(() => resumeApplyTriageOperation({ operationId, ownerHash: record.ownerHash, leaseOwner: `seed-${invocation}`, now, leaseMs: 1 }));
              continuationRequired = result.continuationRequired;
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              if (message.includes("operation-store")) {
                storeFailures += 1;
                store.checkpointItem = observeCheckpoint;
              } else if (message.includes("continuation scheduling")) {
                schedulingFailures += 1;
                store.scheduleContinuation = scheduleContinuation;
                const waiting = await store.get(operationId);
                const nextEligibleTime = waiting?.nextEligibleTime ??
                  Object.values(waiting?.itemStates ?? {})
                    .map((item) => item.nextEligibleTime)
                    .filter((value): value is string => typeof value === "string")
                    .sort()[0];
                if (nextEligibleTime) {
                  await store.scheduleContinuation({
                    operationId,
                    ownerHash: record.ownerHash,
                    reason: "recovered scheduling delivery",
                    nextEligibleTime,
                  });
                }
              } else {
                throw error;
              }
            }
            callsByInvocation.push({ calls: getExecutionState()?.subrequests ?? 0, effectiveBudget: 12, phase: "continuation" });
          }, operationId);
        });
        const current = await store.get(operationId);
        if (current?.nextEligibleTime) {
          rateLimitRescheduled += 1;
          durableWaits += 1;
          maxDurableWaitMs = Math.max(maxDurableWaitMs, Date.parse(current.nextEligibleTime) - Date.now());
          if (!staleChangedDuringWait) {
            tickets.get(String(staleDuringWaitCandidate.ticketNumber))!.updatedTime = "2026-07-18T10:00:02.000Z";
            staleChangedDuringWait = true;
          }
          await store.update(operationId, record.ownerHash, (value) => ({ ...value, nextEligibleTime: "2026-07-18T09:00:00.000Z", itemStates: Object.fromEntries(Object.entries(value.itemStates).map(([key, item]) => [key, item.nextEligibleTime ? { ...item, nextEligibleTime: "2026-07-18T09:00:00.000Z" } : item])) }));
        }
      }

      const finalRecord = await store.get(operationId);
      if (!finalRecord) throw new Error("missing final harness operation");
      expect(continuationRequired, `harness exhausted ${MAX_HARNESS_CONTINUATION_INVOCATIONS} invocations`).toBe(false);
      const successfulWritesBeforeDuplicateDelivery = [...successfulUpdates.values(), ...successfulResolutions.values(), ...successfulNotes.values()]
        .reduce((sum, count) => sum + count, 0);
      const duplicateDeliveryResponses = await Promise.all([
        deliverInternalContinuation(operationId, record.ownerHash),
        deliverInternalContinuation(operationId, record.ownerHash),
      ]);
      expect(duplicateDeliveryResponses.map((response) => response.status)).toEqual([200, 200]);
      const successfulWritesAfterDuplicateDelivery = [...successfulUpdates.values(), ...successfulResolutions.values(), ...successfulNotes.values()]
        .reduce((sum, count) => sum + count, 0);
      expect(successfulWritesAfterDuplicateDelivery).toBe(successfulWritesBeforeDuplicateDelivery);

      const states = Object.values(finalRecord.itemStates);
      const terminal = new Set(["Completed", "CompletedAfterRetry", "CompletedAfterAmbiguousWriteVerification", "AmbiguousWriteUnresolved", "Stale", "Skipped", "FailedBeforeWrite", "FailedAfterPartialWrite", "RateLimitExceeded", "StaleAfterRateLimitWait"]);
      const totals = operationTotals(finalRecord);
      const rateLimitTelemetry = states.map((item) => item.rateLimit).filter(Boolean);
      const terminalCount = states.filter((item) => terminal.has(item.stage)).length;
      const totalRetries = states.reduce((sum, item) => sum + Math.max(0, (item.attemptCount ?? 0) - 1), 0);
      const counters = {
        seed: SEED,
        itemsExpected: numbers.length,
        // Stale is an authoritative terminal partition, separate from failed/skipped.
        itemsAccounted: totals.completed + totals.failed + totals.skipped + totals.stale,
        terminalCount,
        unaccounted: numbers.length - terminalCount,
        updated: totals.updated,
        resolved: totals.resolved,
        noteOnly: totals.noteOnly,
        skipped: totals.skipped,
        completed: totals.completed,
        failed: totals.failed,
        stale: totals.stale,
        validationFailed: totals.validationFailed,
        ambiguousUnresolved: totals.ambiguousUnresolved,
        partialWrite: totals.partialWrite,
        rateLimitRescheduled,
        totalRetries,
        continuationInvocations,
        durableWaits,
        maxDurableWaitMs,
        maximumCallsPerInvocation: Math.max(...callsByInvocation.map((invocation) => invocation.calls)),
        duplicateUpdates: [...successfulUpdates.values()].filter((count) => count > 1).length,
        duplicateResolutions: [...successfulResolutions.values()].filter((count) => count > 1).length,
        duplicatePrivateNotes: [...successfulNotes.values()].filter((count) => count > 1).length,
        invocationsOverBudget: callsByInvocation.filter((invocation) => invocation.calls > invocation.effectiveBudget).length,
        schedulingFailures,
        storeFailures,
        malformedStoredOperations,
        duplicateInternalDeliveries: duplicateDeliveryResponses.length,
      };
      expect(counters.itemsExpected).toBe(250);
      expect(counters.itemsAccounted).toBe(250);
      expect(counters.terminalCount).toBe(250);
      expect(counters.unaccounted).toBe(0);
      expect(counters.updated).toBeGreaterThan(0);
      expect(counters.resolved).toBeGreaterThan(0);
      expect(counters.noteOnly).toBeGreaterThan(0);
      expect(counters.skipped).toBeGreaterThan(0);
      expect(counters.duplicateUpdates).toBe(0);
      expect(counters.duplicateResolutions).toBe(0);
      expect(counters.duplicatePrivateNotes).toBe(0);
      expect(counters.invocationsOverBudget).toBe(0);
      expect(counters.maximumCallsPerInvocation).toBeLessThanOrEqual(37);
      expect(counters.totalRetries).toBeGreaterThanOrEqual(2);
      expect(counters.continuationInvocations).toBeGreaterThan(1);
      expect(counters.durableWaits).toBeGreaterThan(0);
      expect(counters.maxDurableWaitMs).toBeGreaterThan(25_000);
      expect(staleChangedDuringWait).toBe(true);
      expect(rateLimitRescheduled).toBeGreaterThan(0);
      expect(rateLimitTelemetry).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "retry-after",
            retryAfterSupplied: true,
            suppliedDelayMs: 3_600_000,
            parsedDelayMs: expect.any(Number),
            cappedDelayMs: 900_000,
            endpoint: "SuperOps GraphQL /msp",
          }),
        ])
      );
      expect(schedulingFailures).toBe(1);
      expect(storeFailures).toBe(1);
      expect(malformedStoredOperations).toBe(1);
      expect(counters.duplicateInternalDeliveries).toBe(2);
      expect(states.every((item) => terminal.has(item.stage))).toBe(true);
      expect(mutationCounts.get(String(updateCandidate.ticketNumber))).toBe(1);
      expect(mutationCounts.get(String(resolveCandidate.ticketNumber))).toBe(1);
      expect(mutationCounts.get(String(noteCandidate.ticketNumber))).toBe(1);
      expect(mutationCounts.get(String(rateLimitCandidate.ticketNumber))).toBe(2);
      expect(mutationCounts.get(String(graphQlThrottleCandidate.ticketNumber))).toBe(2);
      // Unobserved possible writes are verified once and then retained as
      // unresolved; neither a 5xx nor a network loss is blindly replayed.
      expect(mutationCounts.get(String(fiveHundredCandidate.ticketNumber))).toBe(1);
      expect(mutationCounts.get(String(networkCandidate.ticketNumber))).toBe(1);
      const itemFor = (action: Record<string, unknown>) => finalRecord.itemStates[String(action.ticketNumber)];
      for (const action of [
        updateCandidate, resolveCandidate, noteCandidate, rateLimitCandidate,
        graphQlThrottleCandidate, fiveHundredCandidate, networkCandidate,
      ]) {
        const item = itemFor(action);
        const actualMutations = mutationCounts.get(String(action.ticketNumber)) ?? 0;
        expect(item.attemptCount ?? 0).toBe(actualMutations);
        expect(item.writeAttempted).toBe(actualMutations > 0);
        expect(item.writeMayHaveSucceeded).toBe(actualMutations > 0 && item.observedMutationResult !== "Rejected");
      }
      expect(itemFor(rateLimitCandidate).retryCount).toBe(1);
      expect(itemFor(graphQlThrottleCandidate).retryCount).toBe(1);
      expect(itemFor(rateLimitCandidate).rateLimit?.attempts).toBe(1);
      expect(itemFor(graphQlThrottleCandidate).rateLimit?.attempts).toBe(1);
      expect(itemFor(fiveHundredCandidate).stage).toBe("AmbiguousWriteUnresolved");
      expect(itemFor(networkCandidate).stage).toBe("AmbiguousWriteUnresolved");
      expect(itemFor(staleDuringWaitCandidate).stage).toBe("Stale");
      expect(mutationCounts.get(String(staleDuringWaitCandidate.ticketNumber))).toBeUndefined();
      expect(tickets.get(String(noteCandidate.ticketNumber))?.notes).toHaveLength(1);
      expect(checkpointStages.get(String(updateCandidate.ticketNumber))).toContain("WriteStarted");
      expect(checkpointStages.get(String(resolveCandidate.ticketNumber))).toContain("ResolutionWriteStarted");
      expect(checkpointStages.get(String(noteCandidate.ticketNumber))).toContain("NoteWriteStarted");
      const allCheckpointStages = new Set([...checkpointStages.values()].flatMap((value) => [...value]));
      for (const requiredStage of [
        "Validated", "WriteNotStarted", "WriteStarted", "FieldsUpdated",
        "ResolutionValidated", "ResolutionWriteStarted", "ResolutionWriteSucceeded", "ResolutionVerified",
        "NoteChecked", "NoteWriteStarted", "NoteAdded",
      ]) {
        expect(allCheckpointStages).toContain(requiredStage);
      }
    });
  }, LARGE_HARNESS_TIMEOUT_MS);

  it("restarts before and after every real update, resolution, and note checkpoint through the production adapter", async () => {
    const checkpointLifecycles = {
      update: [
        ["Validated", "Unattempted"],
        ["WriteNotStarted", "Validated"],
        ["WriteStarted", "WriteNotStarted"],
        ["FieldsUpdated", "WriteStarted"],
        ["Verifying", "FieldsUpdated"],
      ],
      resolve: [
        ["Validated", "Unattempted"],
        ["ResolutionValidated", "Validated"],
        ["ResolutionWriteStarted", "ResolutionValidated"],
        ["ResolutionWriteSucceeded", "ResolutionWriteStarted"],
        ["ResolutionVerified", "ResolutionWriteSucceeded"],
      ],
      addNote: [
        ["NoteChecked", "Unattempted"],
        ["NoteWriteStarted", "NoteChecked"],
        ["NoteAdded", "NoteWriteStarted"],
        ["Verifying", "NoteAdded"],
      ],
    } as const;

    let scenarioIndex = 0;
    await runWithOperationStore({}, async () => {
      const domain = getTicketsTools();
      const store = getOperationStore();
      const originalCheckpoint = store.checkpointItem.bind(store);

      for (const [actionType, lifecycle] of Object.entries(checkpointLifecycles) as Array<
        [keyof typeof checkpointLifecycles, ReadonlyArray<readonly [string, string]>]
      >) {
        for (const [checkpointStage, priorStage] of lifecycle) {
          for (const timing of ["before", "after"] as const) {
            scenarioIndex += 1;
            const ticketNumber = String(81000 + scenarioIndex);
            const ticket: TicketState = {
              ticketId: `ticket-${ticketNumber}`,
              displayId: ticketNumber,
              status: "New Calls",
              updatedTime: "2026-07-18T10:00:00.000Z",
              notes: [],
            };
            let mutationCount = 0;
            let verificationReadCount = 0;
            const applyExternalMutation = (input: Record<string, unknown>) => {
              mutationCount += 1;
              if (actionType === "addNote") {
                const noteId = `note-${ticketNumber}-${mutationCount}`;
                ticket.notes.push({ noteId, content: String(input.content ?? ""), privacyType: "PRIVATE" });
                return graphQlData({ createTicketNote: { noteId, privacyType: "PRIVATE" } });
              }
              Object.assign(ticket, input, { updatedTime: UPDATED });
              return graphQlData({ updateTicket: { ticketId: ticket.ticketId, status: ticket.status } });
            };
            vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
              const { query, variables } = jsonBody(init);
              const input = variables?.input ?? {};
              if (query.includes("getTicketList")) {
                return graphQlData({ getTicketList: { tickets: [{ ticketId: ticket.ticketId, displayId: ticket.displayId }], listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 } } });
              }
              if (query.includes("getTicketNoteList")) return graphQlData({ getTicketNoteList: ticket.notes });
              if (query.includes("getFields")) return graphQlData({ getFields: fields() });
              if (query.includes("mutation")) return applyExternalMutation(input);
              verificationReadCount += 1;
              return graphQlData({ getTicket: { ...ticket } });
            }));

            let injected = false;
            store.checkpointItem = async (params) => {
              if (!injected && params.itemKey === ticketNumber && params.patch.stage === checkpointStage) {
                injected = true;
                if (timing === "before") {
                  throw new Error(`crash-boundary before ${actionType}:${checkpointStage}`);
                }
                await originalCheckpoint(params);
                if (MUTATION_START_STAGES.has(checkpointStage)) {
                  const mutationInput = actionType === "addNote"
                    ? { ticketId: ticket.ticketId, content: `checkpoint note ${ticketNumber}` }
                    : actionType === "resolve"
                      ? { ticket: { ticketId: ticket.ticketId }, ...resolutionTarget }
                      : { ticket: { ticketId: ticket.ticketId }, status: "Awaiting Engineer" };
                  applyExternalMutation(mutationInput);
                }
                throw new Error(`crash-boundary after ${actionType}:${checkpointStage}`);
              }
              return originalCheckpoint(params);
            };

            const common = {
              ticketNumber,
              expectedStatus: "New Calls",
              expectedUpdatedTime: "2026-07-18T10:00:00.000Z",
              contentVerified: true,
            };
            const action = actionType === "update"
              ? { ...common, action: "update", target: { status: "Awaiting Engineer" } }
              : actionType === "resolve"
                ? { ...common, action: "resolve", target: resolutionTarget }
                : { ...common, action: "addNote", note: `checkpoint note ${ticketNumber}`, isPublicNote: false };
            const operationId = `checkpoint-crash-${actionType}-${checkpointStage}-${timing}`;

            await runWithExecutionConfig({ SUPEROPS_EXECUTION_MAX_ITEMS_PER_BATCH: "1" }, async () => {
              await runWithExecutionContext("superops_tickets_apply_triage_plan", () =>
                runWithHarnessCredentials(() => withSuccessfulContinuationScheduling(() =>
                  domain.handleCall("superops_tickets_apply_triage_plan", {
                    batchId: operationId,
                    expectedCandidateTicketNumbers: [ticketNumber],
                    actions: [action],
                  })
                )), operationId
              );
            });

            const crashedRecord = await store.get(operationId);
            expect(injected, `${actionType}:${checkpointStage}:${timing} was not reached`).toBe(true);
            const crashedItem = crashedRecord?.itemStates[ticketNumber];
            expect(crashedItem?.stage).toBe(timing === "after" ? checkpointStage : priorStage);
            expect(crashedItem?.writeAttempted).toBe(Boolean(
              crashedItem?.writeAttempted || MUTATION_START_STAGES.has(crashedItem?.stage ?? "")
            ));
            expect(crashedItem?.writeMayHaveSucceeded).toBe(Boolean(
              crashedItem?.writeMayHaveSucceeded || MUTATION_START_STAGES.has(crashedItem?.stage ?? "")
            ));
            expect(mutationCount).toBe((crashedItem?.attemptCount ?? 0));

            store.checkpointItem = originalCheckpoint;
            const preRestartMutationCount = mutationCount;
            const preRestartVerificationReads = verificationReadCount;
            const preRestartNotes = ticket.notes.length;

const existingLeaseExpiry =
  crashedItem?.lease?.expiresAt ??
  crashedRecord?.currentLease?.expiresAt;

const claimAtMs = existingLeaseExpiry
  ? Date.parse(existingLeaseExpiry) + 1
  : Date.parse(crashedRecord!.updatedAt) + 1;

expect(Number.isFinite(claimAtMs)).toBe(true);

if (crashedRecord?.maxOperationLifetimeAt) {
  expect(claimAtMs).toBeLessThan(
    Date.parse(crashedRecord.maxOperationLifetimeAt)
  );
}

const claimAt = new Date(claimAtMs).toISOString();
const duplicateLeaseMs = 10;
const duplicateDeliveryAt = new Date(claimAtMs + 1).toISOString();
const restartBaseMs = claimAtMs + duplicateLeaseMs + 1;

if (crashedRecord?.maxOperationLifetimeAt) {
  expect(restartBaseMs + 3_000).toBeLessThan(
    Date.parse(crashedRecord.maxOperationLifetimeAt)
  );
}
const activeLease = await store.claimNextItem({
  operationId,
  ownerHash: crashedRecord!.ownerHash,
  leaseOwner: `active-${scenarioIndex}`,
leaseMs: duplicateLeaseMs,
  now: claimAt,
});

expect(activeLease?.itemKey).toBe(ticketNumber);

await runWithExecutionConfig(
  {
    SUPEROPS_EXECUTION_SUBREQUEST_BUDGET: "40",
    SUPEROPS_EXECUTION_SUBREQUEST_SAFETY_MARGIN: "4",
  },
  async () => {
    await runWithExecutionContext(
      "superops_tickets_apply_triage_plan",
      () =>
        runWithHarnessCredentials(() =>
          resumeApplyTriageOperation({
            operationId,
            ownerHash: crashedRecord!.ownerHash,
            leaseOwner: `duplicate-active-${scenarioIndex}`,
            leaseMs: 1,
            now: duplicateDeliveryAt,
          })
        ),
      operationId
    );
  }
);
            expect(mutationCount).toBe(preRestartMutationCount);
            expect(ticket.notes.length).toBe(preRestartNotes);

            let continuationRequired = true;
            for (let resumeIndex = 0; continuationRequired && resumeIndex < 4; resumeIndex += 1) {
              await runWithExecutionConfig({ SUPEROPS_EXECUTION_SUBREQUEST_BUDGET: "40", SUPEROPS_EXECUTION_SUBREQUEST_SAFETY_MARGIN: "4" }, async () => {
                await runWithExecutionContext("superops_tickets_apply_triage_plan", async () => {
                  const result = await runWithHarnessCredentials(() => resumeApplyTriageOperation({
                    operationId,
                    ownerHash: crashedRecord!.ownerHash,
                    leaseOwner: `restart-${scenarioIndex}-${resumeIndex}`,
                    leaseMs: 1,
now: new Date(
  restartBaseMs + resumeIndex * 1000
).toISOString(),                  }));
                  continuationRequired = result.continuationRequired;
                }, operationId);
              });
              const reloaded = await store.get(operationId);
              const item = reloaded?.itemStates[ticketNumber];
              if (continuationRequired) {
                expect(reloaded?.nextEligibleTime ?? item?.nextEligibleTime, `${operationId} stranded without a scheduled continuation`).toBeDefined();
              }
            }

            const terminalRecord = await store.get(operationId);
            const terminalItem = terminalRecord?.itemStates[ticketNumber];
            if (!terminalRecord || !terminalItem) throw new Error(`missing terminal item for ${operationId}`);
            expect(continuationRequired, `${operationId} did not reach a terminal state`).toBe(false);
            expect(TERMINAL_ITEM_STAGES.has(terminalItem.stage)).toBe(true);
const expectedTerminalState = "Completed";

if (terminalRecord.state !== expectedTerminalState) {
  throw new Error(
    `Unexpected terminal state:\n${JSON.stringify(
      {
        operationId,
        actionType,
        checkpointStage,
        timing,
        expectedTerminalState,
        terminalState: terminalRecord.state,
        terminalItem,
        failedItems: terminalRecord.failedItems,
        summary: terminalRecord.summary,
      },
      null,
      2
    )}`
  );
}            expect(terminalRecord.state).toBe(actionType === "resolve" ? "Completed" : "Completed");
            expect(terminalRecord.pendingItems).toEqual([]);
            expect(terminalRecord.unattemptedItems).toEqual([]);
            expect(terminalRecord.nextEligibleTime).toBeUndefined();
            expect(terminalItem.writeAttempted).toBe((crashedItem?.writeAttempted ?? false) || mutationCount > 0);
            expect(terminalItem.writeMayHaveSucceeded).toBe((crashedItem?.writeMayHaveSucceeded ?? false) || mutationCount > 0);
            expect(terminalItem.attemptCount ?? 0).toBe(mutationCount);
            expect(verificationReadCount).toBeGreaterThan(preRestartVerificationReads);
            expect(terminalItem.verificationState).toBe("Verified");
            expect(terminalItem.observedMutationResult).toBe("VerifiedApplied");
            expect(terminalItem.stage).toBe(
              preRestartMutationCount > 0
                ? "CompletedAfterAmbiguousWriteVerification"
                : "Completed"
            );
            expect(terminalItem.outcome).toBe(actionType === "resolve" ? "Resolved" : "Updated");
            if (actionType === "addNote") expect(ticket.notes).toHaveLength(1);

            const mutationCountBeforeTerminalDuplicates = mutationCount;
            const notesBeforeTerminalDuplicates = ticket.notes.length;
            await runWithExecutionConfig({ SUPEROPS_EXECUTION_SUBREQUEST_BUDGET: "40", SUPEROPS_EXECUTION_SUBREQUEST_SAFETY_MARGIN: "4" }, async () => {
              await runWithExecutionContext("superops_tickets_apply_triage_plan", async () => {
                await Promise.all([
                  runWithHarnessCredentials(() => resumeApplyTriageOperation({
                    operationId,
                    ownerHash: crashedRecord!.ownerHash,
                    leaseOwner: `terminal-duplicate-a-${scenarioIndex}`,
                    leaseMs: 1,
                    now: "2099-01-01T00:03:00.000Z",
                  })),
                  runWithHarnessCredentials(() => resumeApplyTriageOperation({
                    operationId,
                    ownerHash: crashedRecord!.ownerHash,
                    leaseOwner: `terminal-duplicate-b-${scenarioIndex}`,
                    leaseMs: 1,
                    now: "2099-01-01T00:03:00.000Z",
                  })),
                ]);
              }, operationId);
            });
            const afterDuplicateRecord = await store.get(operationId);
            expect(afterDuplicateRecord?.itemStates[ticketNumber].stage).toBe(terminalItem.stage);
            expect(mutationCount).toBe(mutationCountBeforeTerminalDuplicates);
            expect(ticket.notes.length).toBe(notesBeforeTerminalDuplicates);
          }
        }
      }

      store.checkpointItem = originalCheckpoint;
    });
    expect(scenarioIndex).toBe(28);
  });
});
