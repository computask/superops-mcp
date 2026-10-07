/** Real client, dispatcher transport, triage adapter and durable continuation;
 * only network I/O is mocked. All tickets/content/credentials are synthetic. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { runWithCredentials } from "./client.js";
import { runWithExecutionConfig, runWithExecutionContext } from "./execution.js";
import { getOperationStore, runWithOperationStore, type OperationLedgerRecord } from "./operation-store.js";
import { runWithContinuationScheduler } from "./continuation-scheduler.js";
import { getTicketsTools, resumeApplyTriageOperation } from "./domains/tickets.js";
import { DISPATCHER_ORIGIN } from "./dispatcher.js";

const INITIAL_TIME = "2026-09-27T12:00:00.000Z";
const NOTE = "<strong>Triage</strong><br><br>Synthetic private test note.";
const TARGET = { impact: "Low", urgency: "Low", category: "7. Sales call", subcategory: "No Action Needed" };
type Fault = "notApplied" | "alreadyApplied" | "queued" | "recoveryUncertain" | "concurrentEdit" | "noteUncertain";
type Ticket = {
  ticketId: string; displayId: string; subject: string; status: string;
  priority: string; updatedTime: string; client: { accountId: string; name?: string } | null;
};

async function exercise(fault: Fault, unassigned = false) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(INITIAL_TIME));
  const tickets: Ticket[] = ["71001", "71002"].map(displayId => ({
    ticketId: `synthetic-${displayId}`, displayId, subject: "Synthetic recovery test",
    status: "New Calls", priority: "High", updatedTime: INITIAL_TIME,
    client: unassigned ? null : { accountId: "synthetic-client", name: "TaskGroup" },
  }));
  const notes = new Map<string, Array<{ noteId: string; content: string; privacyType: string }>>();
  const calls: Array<{ method: string; url: string; at: number; query?: string; input?: Record<string, unknown>; key?: string }> = [];
  const mutationKeys = new Map<string, { receipt: string; uncertain: boolean }>();
  const updateAttempts: Array<{ ticketId: string; key: string; input: Record<string, unknown>; at: number }> = [];
  let primaryReadsAfterWrite = 0;
  let firstRecoveryCheckpoint: OperationLedgerRecord | undefined;
  const graph = (data: unknown, requestId: string = crypto.randomUUID()) => Response.json({ data }, {
    headers: { "X-Dispatcher-Status": "succeeded", "X-Dispatcher-Request-Id": requestId },
  });
  const uncertain = (requestId: string) => Response.json({
    requestId, status: "uncertain", source: "superops-mcp", type: "mutation", fingerprint: "f".repeat(64), attemptCount: 1, uncertain: true, httpStatus: 200,
    errorClassification: "GRAPHQL_ERROR", response: {
      data: { updateTicket: null }, errors: [{ message: "Internal server error", extensions: { code: "INTERNAL_SERVER_ERROR" } }],
    },
  }, { headers: { "X-Dispatcher-Status": "uncertain", "X-Dispatcher-Request-Id": requestId } });

  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    expect(url.startsWith(DISPATCHER_ORIGIN + "/")).toBe(true);
    const method = init?.method ?? "GET";
    const parsed = method === "POST" ? JSON.parse(String(init?.body)) : {};
    const query = String(parsed.query ?? "");
    const input = (parsed.variables?.input ?? {}) as Record<string, unknown>;
    const key = new Headers(init?.headers).get("Idempotency-Key") ?? "";
    calls.push({ method, url, query, input, key, at: Date.now() });
    if (url.endsWith("/diagnostics")) return Response.json({}, { status: 404 });
    if (method === "GET") {
      expect(url).toBe(`${DISPATCHER_ORIGIN}/v1/requests/original-update`);
      return uncertain("original-update");
    }
    if (url.endsWith("/verify")) {
      const applied = fault === "alreadyApplied";
      const requestId = url.split("/").at(-2)!;
      const evidenceHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(parsed)))), byte => byte.toString(16).padStart(2, "0")).join("");
      return Response.json({requestId, source: "superops-mcp", fingerprint: parsed.mutationFingerprint, attemptCount: 1,
        status: applied ? "succeeded" : "uncertain", uncertain: !applied,
        verification: {schemaVersion: 1, requestId, mutationFingerprint: parsed.mutationFingerprint, attemptCount: 1,
          evidenceHash, outcome: applied ? "applied" : "not_observed", reasonCode: applied ? "complete_target_observed" : "target_not_observed",
          partial: false, checkedFields: Object.keys(TARGET), readRequestIds: parsed.readRequestIds, replayAllowed: false, verifiedAt: new Date().toISOString()},
      });
    }
    if (query.includes("getTicketList")) {
      const value = String((input.condition as { value: unknown }).value);
      const found = tickets.filter(ticket => ticket.displayId === value);
      return graph({ getTicketList: { tickets: found, listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: found.length } } });
    }
    if (query.includes("getFields")) return graph({ getFields: Object.entries(TARGET).map(([columnName, value]) => ({
      id: `${columnName}-field`, module: "TICKET", columnName, label: columnName,
      options: [{ id: `${columnName}-${value}`, value,
        ...(columnName === "subcategory" ? { parentOption: { id: `category-${TARGET.category}`, value: TARGET.category } } : {}),
      }],
      ...(columnName === "subcategory" ? { parentField: { id: "category-field", columnName: "category" } } : {}),
    })) });
    const ticketId = String(input.ticketId ?? (input.ticket as { ticketId?: string })?.ticketId ?? "");
    const ticket = tickets.find(item => item.ticketId === ticketId);
    if (!ticket) throw new Error(`Unexpected synthetic request: ${query.slice(0, 100)}`);
    if (query.includes("getTicketNoteList")) return graph({ getTicketNoteList: notes.get(ticketId) ?? [] });
    if (query.includes("mutation")) {
      const prior = mutationKeys.get(key);
      // Model actual dispatcher idempotency: same key never executes again.
      if (prior?.uncertain) return uncertain(prior.receipt);
      if (prior) throw new Error("Duplicate accepted mutation submission");
      if (query.includes("createTicketNote")) {
        const receipt = `note-${ticket.displayId}`;
        const isUncertain = fault === "noteUncertain" && ticket === tickets[0];
        mutationKeys.set(key, { receipt, uncertain: isUncertain });
        if (isUncertain) return uncertain(receipt);
        const note = { noteId: receipt, content: String(input.content), privacyType: "PRIVATE" };
        notes.set(ticketId, [...(notes.get(ticketId) ?? []), note]);
        return graph({ createTicketNote: note }, receipt);
      }
      const previousUpdates = updateAttempts.filter(item => item.ticketId === ticketId).length;
      const fail = ticket === tickets[0] && fault !== "noteUncertain" && (previousUpdates === 0 || fault === "recoveryUncertain");
      const receipt = ticket === tickets[0] ? previousUpdates === 0 ? "original-update" : "recovery-update" : "other-update";
      mutationKeys.set(key, { receipt, uncertain: fail });
      updateAttempts.push({ ticketId, key, input, at: Date.now() });
      if (fail && fault !== "alreadyApplied") {
        if (fault === "queued" && previousUpdates === 0) return Response.json({ requestId: receipt, status: "queued", source: "superops-mcp" }, {
          status: 202, headers: { "Retry-After": "60", "X-Dispatcher-Request-Id": receipt },
        });
        return uncertain(receipt);
      }
      Object.assign(ticket, input, { updatedTime: new Date(Date.now() + 1).toISOString() });
      if (input.client) ticket.client = { ...(input.client as { accountId: string }), name: "TaskGroup" };
      if (fail) return uncertain(receipt);
      return graph({ updateTicket: { ...ticket } }, receipt);
    }
    if (query.includes("getTicket")) {
      if (ticket === tickets[0] && updateAttempts.length > 0) primaryReadsAfterWrite++;
      return graph({ getTicket: { ...ticket } });
    }
    throw new Error("Unrecognised synthetic query");
  }));

  return runWithOperationStore({}, async () => {
    const store = getOperationStore();
    const checkpoint = store.checkpointItem.bind(store);
    store.checkpointItem = async params => {
      const saved = await checkpoint(params);
      if (params.patch.stage === "RecoveryWriteStarted") firstRecoveryCheckpoint = structuredClone(saved);
      return saved;
    };
    try {
      const run = <T>(fn: () => T) => runWithCredentials({ apiToken: "synthetic-unused", subdomain: "synthetic" }, () =>
        runWithExecutionConfig({ SUPEROPS_EXECUTION_SUBREQUEST_BUDGET: "200", SUPEROPS_EXECUTION_SUBREQUEST_SAFETY_MARGIN: "8",
          SUPEROPS_EXECUTION_SAFE_REMAINING_TIME_MS: "0" }, () =>
          runWithExecutionContext("superops_tickets_apply_triage_plan", fn)));
      const initial = await run(() => runWithContinuationScheduler({
        SUPEROPS_CONTINUATION_ENABLED: "true", SUPEROPS_DURABLE_RETRY_ENABLED: "true",
        SUPEROPS_INTERNAL_CONTINUATION_TOKEN: "synthetic-internal",
        SUPEROPS_CONTINUATION_SERVICE: { fetch: async () => Response.json({ ok: true }) },
      }, () => getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
        expectedCandidateTicketNumbers: tickets.map(ticket => ticket.displayId), verify: true, dedupeNotes: true,
        actions: tickets.map(ticket => ({
          ticketNumber: ticket.displayId, expectedTicketId: ticket.ticketId,
          expectedSubject: ticket.subject, expectedStatus: "New Calls", expectedUpdatedTime: INITIAL_TIME,
          contentVerified: true, action: "leave", target: { ...TARGET, clientId: "synthetic-client", clientName: "TaskGroup" },
          note: NOTE, isPublicNote: false,
        })),
      })));
      expect(initial.isError, initial.content[0].text).not.toBe(true);
      const parsed = JSON.parse(initial.content[0].text);
      const operationId = parsed.operation?.operationId;
      expect(operationId, JSON.stringify(parsed)).toBeTypeOf("string");
      const initialRecord = structuredClone((await store.get(operationId))!);
      if (fault === "concurrentEdit") Object.assign(tickets[0], { status: "Worked on", updatedTime: "2026-09-27T12:00:05.000Z" });
      let record = initialRecord;
      let resumes = 0;
      while (record.pendingItems.length && resumes < 12) {
        resumes++;
        const nextTime = Math.max(Date.now() + 1000, Date.parse(record.nextEligibleTime ?? INITIAL_TIME) + 1,
          ...record.pendingItems.map(item => Date.parse(record.itemStates[item].nextEligibleTime ?? INITIAL_TIME) + 1));
        vi.setSystemTime(nextTime);
        await run(() => resumeApplyTriageOperation({ operationId, ownerHash: record.ownerHash, leaseOwner: `test-${resumes}`, now: new Date().toISOString() }));
        record = (await store.get(operationId))!;
      }
      expect(record.pendingItems).toEqual([]);
      return { record, initialRecord, calls, tickets, notes, updateAttempts, primaryReadsAfterWrite, firstRecoveryCheckpoint };
    } finally { store.checkpointItem = checkpoint; }
  });
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("dispatcher uncertain triage recovery", () => {
  it.each([false, true])("retains uncertainty after unchanged reads, with no recovery write (unassigned=%s)", async unassigned => {
    const result = await exercise("notApplied", unassigned);
    expect(result.record.completedItems).toContain("71002");
    expect(result.record.failedItems).toContain("71001");
    expect(result.record.itemStates["71001"]).toMatchObject({stage: "AmbiguousWriteUnresolved", recoveryRetryCount: 0, replaySafe: false, humanReconciliationRequired: true});
    const attempts = result.updateAttempts.filter(call => call.ticketId === "synthetic-71001");
    expect(attempts).toHaveLength(1);
    expect(result.firstRecoveryCheckpoint).toBeUndefined();
    expect(result.primaryReadsAfterWrite).toBeGreaterThanOrEqual(4);
    expect(result.notes.get("synthetic-71001")).toBeUndefined();
    if (unassigned) expect(attempts[0].input.client).toEqual({accountId: "synthetic-client"});
    else expect(attempts[0].input).not.toHaveProperty("client");
    expect(result.record.itemStates["71001"].dispatcherReceipt?.verification?.outcome).toBe("not_observed");
  });

  it("does not resend a mutation that actually applied despite its uncertain response", async () => {
    const result = await exercise("alreadyApplied");
    expect(result.record.state).toBe("Completed");
    expect(result.updateAttempts.filter(call => call.ticketId === "synthetic-71001")).toHaveLength(1);
    expect(result.notes.get("synthetic-71001")).toHaveLength(1);
  });

  it("polls an accepted receipt before reconciling uncertain, preserving its mutation checkpoint", async () => {
    const result = await exercise("queued");
    expect(result.initialRecord.itemStates["71001"].stage).not.toBe("RateLimitedRescheduled");
    expect(result.calls.filter(call => call.method === "GET" && !call.url.endsWith("/diagnostics")).length).toBeGreaterThanOrEqual(1);
    expect(result.record.state).toBe("CompletedWithFailures");
    expect(result.updateAttempts.filter(call => call.ticketId === "synthetic-71001")).toHaveLength(1);
  });

  it("never submits a recovery mutation while the original remains uncertain", async () => {
    const result = await exercise("recoveryUncertain");
    expect(result.record.itemStates["71001"].stage).toBe("AmbiguousWriteUnresolved");
    expect(result.record.completedItems).toContain("71002");
    expect(result.updateAttempts.filter(call => call.ticketId === "synthetic-71001")).toHaveLength(1);
  });

  it("does not retry over a concurrent engineer change", async () => {
    const result = await exercise("concurrentEdit");
    expect(result.record.failedItems).toContain("71001");
    expect(result.record.completedItems).toContain("71002");
    expect(result.updateAttempts.filter(call => call.ticketId === "synthetic-71001")).toHaveLength(1);
    expect(result.tickets[0].status).toBe("Worked on");
  });

  it("never replays an ambiguous private note", async () => {
    const result = await exercise("noteUncertain");
    expect(result.record.failedItems).toContain("71001");
    expect(result.record.completedItems).toContain("71002");
    expect(result.calls.filter(call => call.query?.includes("createTicketNote") &&
      (call.input?.ticket as { ticketId?: string })?.ticketId === "synthetic-71001")).toHaveLength(1);
    expect(result.notes.get("synthetic-71001")).toBeUndefined();
  });
});
