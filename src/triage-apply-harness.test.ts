/**
 * Deterministic, no-network acceptance harness for the complete staged
 * superops_tickets_apply_triage_plan workflow. The production client, public
 * handler, continuation adapter, Durable Object client, and ledger run here;
 * only transport, storage, scheduling, and time are faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runWithCredentials } from "./client.js";
import { runWithExecutionConfig, runWithExecutionContext, type ExecutionConfigInput } from "./execution.js";
import {
  currentOwnerHash,
  getOperationStore,
  runWithOperationStore,
  SuperOpsOperationLedger,
  type OperationItemStage,
  type OperationLedgerRecord,
} from "./operation-store.js";
import { getTicketsTools, resetTicketFieldOptionsCacheForTests, resumeApplyTriageOperation } from "./domains/tickets.js";
import { runWithContinuationScheduler } from "./continuation-scheduler.js";
import { chatGptDirectBlockedToolNames } from "./mcp-server.js";
import { MUTATING_TOOL_NAMES } from "./tool-catalogue.js";

const TICKET_NUMBER = "59005";
const TICKET_ID = "2691030162477215744";
const CLIENT_ID = "2993553194649526272";
const INITIAL_UPDATED_TIME = "2026-07-24T17:39:08.827";
const NOTE_CREATED_TIME = "2026-07-25T16:18:03.579";
const HARNESS_CREDS = { apiToken: "deterministic-harness-token", subdomain: "deterministic-harness" };
const PRIVATE_NOTE_KEY = Buffer.alloc(32, 7).toString("base64");

const CLASSIFICATION = {
  impact: "Low",
  urgency: "Low",
  category: "7. Sales call",
  subcategory: "No Action Needed",
  cause: "Unknown",
  resolutionCode: "Permanent Fix",
} as const;

const RESOLVE_TARGET = {
  status: "Resolved",
  ...CLASSIFICATION,
  clientName: "TaskGroup",
  clientId: CLIENT_ID,
  suppressCloseNotification: true,
} as const;

const SCHEDULED_TRIAGE_NOTE = [
  "TRIAGE SUMMARY",
  "Ticket goal: Close an unsolicited sales message with no customer action required.",
  "What needs to be known: JUNK: the message is an unsolicited sales approach.",
  "Next step: Resolve without customer contact or close notification.",
  "When: Now; no further action unless new evidence is received.",
].join("\n");

const CANONICAL_PRIVATE_JUNK = {
  id: "8656361040688640000",
  type: "note",
  direction: "internal",
  isInternal: true,
  plainText: "JUNK",
  createdTime: NOTE_CREATED_TIME,
} as const;

const RAW_GRAPHQL_PRIVATE_JUNK = {
  noteId: "8656361040688640000",
  addedOn: NOTE_CREATED_TIME,
  addedBy: { userId: "158888810903851008", name: "Sam Godfrey" },
  content: "<html>JUNK</html>",
  attachments: [],
  privacyType: "PRIVATE",
} as const;

const RAW_GRAPHQL_PUBLIC_JUNK = {
  noteId: "public-junk",
  addedOn: NOTE_CREATED_TIME,
  content: "<html>JUNK</html>",
  privacyType: "PUBLIC",
} as const;

const BASE_EXECUTION_CONFIG: ExecutionConfigInput = {
  SUPEROPS_EXECUTION_SUBREQUEST_BUDGET: "200",
  SUPEROPS_EXECUTION_SUBREQUEST_SAFETY_MARGIN: "4",
  SUPEROPS_EXECUTION_MAX_ITEMS_PER_BATCH: "10",
  SUPEROPS_EXECUTION_MAX_READ_RETRY_ATTEMPTS: "1",
  SUPEROPS_EXECUTION_MAX_WRITE_RETRY_ATTEMPTS: "1",
  SUPEROPS_EXECUTION_BACKOFF_BASE_DELAY_MS: "0",
  SUPEROPS_EXECUTION_BACKOFF_JITTER_RATIO: "0",
  SUPEROPS_EXECUTION_SAFE_REMAINING_TIME_MS: "0",
  SUPEROPS_EXECUTION_MAX_DURATION_MS: "300000",
  SUPEROPS_EXECUTION_REQUEST_TIMEOUT_MS: "120000",
  SUPEROPS_EXECUTION_MAX_CONTINUATION_COUNT: "100",
  SUPEROPS_EXECUTION_MAX_DURABLE_RETRY_ATTEMPTS: "3",
};

type HistoryEvent = { sequence: number; kind: string; details?: Record<string, unknown> };

class History {
  readonly events: HistoryEvent[] = [];

  add(kind: string, details?: Record<string, unknown>): void {
    this.events.push({ sequence: this.events.length + 1, kind, details });
  }

  kinds(prefix?: string): string[] {
    return this.events.filter((event) => !prefix || event.kind.startsWith(prefix)).map((event) => event.kind);
  }

  count(kind: string): number {
    return this.events.filter((event) => event.kind === kind).length;
  }

  first(kind: string): number {
    return this.events.find((event) => event.kind === kind)?.sequence ?? Number.POSITIVE_INFINITY;
  }
}

class FakeClock {
  private readonly startMs = Date.parse("2026-07-25T16:00:00.000Z");
  private readonly realSetTimeout = globalThis.setTimeout;
  private monotonicMs = 0;

  constructor(private readonly history: History) {}

  install(): void {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(this.startMs));
    vi.stubGlobal("performance", { now: () => this.monotonicMs });
  }

  advanceTo(iso: string): void {
    const next = Date.parse(iso);
    const delayMs = Math.max(0, next - Date.now());
    this.monotonicMs += delayMs;
    vi.setSystemTime(new Date(next));
    this.history.add("clock.advance", { delayMs, now: iso });
  }

  async settle<T>(promise: Promise<T>): Promise<T> {
    let settled = false;
    void promise.finally(() => { settled = true; });
    for (let turn = 0; turn < 1000 && !settled; turn += 1) {
      await new Promise<void>((resolve) => this.realSetTimeout(resolve, 0));
      await Promise.resolve();
      if (!settled && vi.getTimerCount() > 0) {
        this.history.add("clock.delay");
        await vi.advanceTimersToNextTimerAsync();
      }
    }
    if (!settled) {
      throw new Error(
        `Harness promise did not settle; timers=${vi.getTimerCount()}, history=${this.history.kinds().slice(-10).join(",")}`
      );
    }
    return promise;
  }
}

type StoreRateLimitMode = "none" | "transient" | "persistent";

class FakeDurableLedger {
  readonly namespace: {
    idFromName(name: string): string;
    get(id: unknown): { fetch(request: Request): Promise<Response> };
  };
  private readonly ledgers = new Map<string, SuperOpsOperationLedger>();
  private remainingPreflightRateLimits = 0;
  private persistentPreflightRateLimit = false;

  constructor(private readonly history: History) {
    this.namespace = {
      idFromName: (name: string) => name,
      get: (id: unknown) => ({ fetch: (request: Request) => this.fetch(String(id), request) }),
    };
  }

  setPreflightRateLimit(mode: StoreRateLimitMode): void {
    this.remainingPreflightRateLimits = mode === "transient" ? 2 : 0;
    this.persistentPreflightRateLimit = mode === "persistent";
  }

  private ledger(name: string): SuperOpsOperationLedger {
    let ledger = this.ledgers.get(name);
    if (ledger) return ledger;
    const values = new Map<string, unknown>();
    const storage = {
      get: async <T = unknown>(key: string) => values.get(key) as T | undefined,
      put: async (key: string | Record<string, unknown>, value?: unknown) => {
        if (typeof key === "string") values.set(key, value);
        else for (const [entryKey, entryValue] of Object.entries(key)) values.set(entryKey, entryValue);
      },
      delete: async (key: string) => values.delete(key),
      list: async <T = unknown>(options?: { prefix?: string }) => new Map(
        [...values.entries()].filter(([key]) => !options?.prefix || key.startsWith(options.prefix))
      ) as Map<string, T>,
      setAlarm: async (_scheduledTime: number | Date) => undefined,
      getAlarm: async () => null,
    };
    ledger = new SuperOpsOperationLedger({ storage } as never, {
      SUPEROPS_PRIVATE_NOTE_ENCRYPTION_KEY: PRIVATE_NOTE_KEY,
      SUPEROPS_CONTINUATION_ENABLED: "true",
      SUPEROPS_DURABLE_RETRY_ENABLED: "true",
      SUPEROPS_CONTINUATION_WORKFLOW: {
        createBatch: async (requests) => {
          this.history.add("scheduler.workflow", { count: requests.length });
          return requests.map((request) => ({ id: request.id }));
        },
      },
    });
    this.ledgers.set(name, ledger);
    return ledger;
  }

  private async requestBody(request: Request): Promise<Record<string, unknown>> {
    if (request.method === "GET" || request.method === "DELETE") return {};
    try { return await request.clone().json() as Record<string, unknown>; }
    catch { return {}; }
  }

  private async fetch(name: string, request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = await this.requestBody(request);
    const patch = body.patch as Record<string, unknown> | undefined;
    const stage = typeof patch?.stage === "string" ? patch.stage : undefined;
    const action = url.pathname.split("/").at(-1) ?? "";
    const kind = request.method === "PUT" ? "ledger.put"
      : action === "checkpoint-item" ? "ledger.checkpoint"
      : action === "complete-item" ? "ledger.complete"
      : action === "claim-next" ? "ledger.claim"
      : action === "schedule-continuation" ? "ledger.schedule"
      : action === "terminalize-continuation" ? "ledger.terminalize"
      : request.method === "GET" ? "ledger.get" : "ledger.request";

    if (kind === "ledger.checkpoint" && stage === "PreflightValidated" &&
        (this.persistentPreflightRateLimit || this.remainingPreflightRateLimits > 0)) {
      if (this.remainingPreflightRateLimits > 0) this.remainingPreflightRateLimits -= 1;
      this.history.add("ledger.rate-limit", { stage });
      return new Response(JSON.stringify({ errorClass: "OperationStoreRateLimit", error: "rate_limit_exceeded" }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "0.025" },
      });
    }

    const response = await this.ledger(name).fetch(request);
    this.history.add(kind, { path: url.pathname, stage, status: response.status });
    return response;
  }
}
type MutationFault = "accepted" | "graphqlReject" | "graphqlPartial" | "timeoutApply" | "timeoutNoApply" | "rateLimit";

type FakeSuperOpsOptions = {
  classified?: boolean;
  resolved?: boolean;
  initialNotes?: unknown[];
  noteReadsRequireInternalId?: boolean;
  canonicalTicketReadRateLimits?: number;
  noteReadUnavailable?: boolean;
  unsupportedNoteEnvelope?: boolean;
  noteVisibilityMisses?: number;
  classificationFault?: MutationFault;
  classificationFaults?: MutationFault[];
  noteFault?: MutationFault;
  statusFault?: MutationFault;
  noteChangesUpdatedTime?: boolean;
  unrelatedChangeOnTicketRead?: number;
};

type FakeTicket = {
  ticketId: string;
  displayId: string;
  subject: string;
  status: string;
  client: null | { accountId: string; name: string };
  priority?: string;
  impact?: string;
  urgency?: string;
  category?: string;
  subcategory?: string;
  cause?: string;
  resolutionCode?: string;
  updatedTime: string;
};

function graphQlData(data: unknown): Response {
  return new Response(JSON.stringify({ data }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function graphQlError(operation: string, code = "VALIDATION_ERROR"): Response {
  return new Response(JSON.stringify({
    data: { [operation]: null },
    errors: [{ message: `${operation} rejected by deterministic transport`, path: [operation], extensions: { code } }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function graphQlReadRateLimit(operation: string): Response {
  return new Response(JSON.stringify({
    data: { [operation]: null },
    errors: [{
      message: null,
      extensions: {
        clientError: [{ code: "rate_limit_exceeded", param: null }],
        classification: "DataFetchingException",
      },
    }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function ticketFields() {
  const field = (columnName: string, values: string[], parent?: { columnName: string; value: string }) => ({
    id: `${columnName}-field`,
    module: "TICKET",
    columnName,
    label: columnName,
    options: values.map((value) => ({
      id: `${columnName}-${value}`,
      value,
      parentOption: parent ? { id: `${parent.columnName}-${parent.value}`, value: parent.value } : undefined,
    })),
    parentField: parent ? { id: `${parent.columnName}-field`, columnName: parent.columnName } : undefined,
  });
  return [
    field("impact", ["Low", "Medium", "High"]),
    field("urgency", ["Low", "Medium", "High"]),
    field("resolutionCode", ["Permanent Fix"]),
    field("cause", ["Unknown", "User Request"]),
    field("subcategory", ["No Action Needed"], { columnName: "category", value: "7. Sales call" }),
  ];
}

class FakeSuperOps {
  readonly ticket: FakeTicket;
  readonly visibleNotes: unknown[];
  private pendingNote: Record<string, unknown> | undefined;
  private remainingVisibilityMisses: number;
  private remainingCanonicalTicketReadRateLimits: number;
  private readonly classificationFaults: MutationFault[];
  private updatedSequence = 0;
  private ticketReadCount = 0;

  constructor(private readonly history: History, private readonly options: FakeSuperOpsOptions = {}) {
    this.ticket = {
      ticketId: TICKET_ID,
      displayId: TICKET_NUMBER,
      subject: "Anonymised junk call",
      status: options.resolved ? "Resolved" : "New Calls",
      client: null,
      updatedTime: INITIAL_UPDATED_TIME,
    };
    this.visibleNotes = [...(options.initialNotes ?? [])];
    this.remainingVisibilityMisses = options.noteVisibilityMisses ?? 0;
    this.remainingCanonicalTicketReadRateLimits = options.canonicalTicketReadRateLimits ?? 0;
    this.classificationFaults = [...(options.classificationFaults ?? [])];
    if (options.classified) this.setClassified();
  }

  install(): void {
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request, init?: RequestInit) => this.fetch(input, init)));
  }

  setClassified(): void {
    Object.assign(this.ticket, {
      client: { accountId: CLIENT_ID, name: "TaskGroup" },
      ...CLASSIFICATION,
      priority: "Very Low",
    });
  }

  setResolved(): void {
    this.setClassified();
    this.ticket.status = "Resolved";
  }

  addCanonicalPrivateJunk(): void {
    if (!this.hasPrivateJunk()) this.visibleNotes.push({ ...CANONICAL_PRIVATE_JUNK });
  }

  private hasPrivateJunk(): boolean {
    return this.visibleNotes.some((value) => {
      const note = value as Record<string, unknown>;
      const text = typeof note.plainText === "string"
        ? note.plainText
        : typeof note.content === "string"
          ? note.content.replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ")
          : "";
      return (note.privacyType === "PRIVATE" ||
        (note.type === "note" && note.isInternal === true && note.direction === "internal")) &&
        text.trim() === "JUNK";
    });
  }

  private nextUpdatedTime(): string {
    this.updatedSequence += 1;
    return new Date(Date.parse(INITIAL_UPDATED_TIME) + this.updatedSequence * 1000).toISOString();
  }

  private notesForRead(): unknown[] {
    if (this.pendingNote) {
      if (this.remainingVisibilityMisses > 0) {
        if (Number.isFinite(this.remainingVisibilityMisses)) this.remainingVisibilityMisses -= 1;
      } else {
        this.visibleNotes.push(this.pendingNote);
        this.pendingNote = undefined;
      }
    }
    return this.visibleNotes.map((note) => ({ ...(note as Record<string, unknown>) }));
  }

  private requestBody(init?: RequestInit): { query: string; variables?: { input?: Record<string, unknown> } } {
    if (typeof init?.body !== "string") throw new Error("Unexpected transport request without a JSON body.");
    return JSON.parse(init.body) as { query: string; variables?: { input?: Record<string, unknown> } };
  }

  private rateLimitResponse(): Response {
    return new Response("rate limited", { status: 429, statusText: "Too Many Requests", headers: { "Retry-After": "0" } });
  }

  private async fetch(_request: string | URL | Request, init?: RequestInit): Promise<Response> {
    const { query, variables } = this.requestBody(init);
    const input = variables?.input ?? {};

    if (query.includes("getTicketList")) {
      this.history.add("superops.read.ticket-list", { input });
      return graphQlData({ getTicketList: {
        tickets: [{ ticketId: TICKET_ID, displayId: TICKET_NUMBER }],
        listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 },
      } });
    }
    if (query.includes("getFields")) {
      this.history.add("superops.read.fields");
      return graphQlData({ getFields: ticketFields() });
    }
    if (query.includes("getClientList")) {
      this.history.add("superops.read.clients");
      return graphQlData({ getClientList: {
        clients: [{ accountId: CLIENT_ID, name: "TaskGroup" }],
        listInfo: { hasMore: false, totalCount: 1 },
      } });
    }
    if (query.includes("getTicketNoteList")) {
      this.history.add("superops.read.notes", { ticketId: input.ticketId });
      if (this.options.noteReadUnavailable) {
        return new Response("notes unavailable", { status: 503, statusText: "Service Unavailable" });
      }
      if (this.options.unsupportedNoteEnvelope) {
        return graphQlData({ getTicketNoteList: { unexpectedItems: [] } });
      }
      if (this.options.noteReadsRequireInternalId && input.ticketId !== TICKET_ID) {
        return graphQlData({ getTicketNoteList: [] });
      }
      return graphQlData({ getTicketNoteList: this.notesForRead() });
    }
    if (query.includes("createTicketNote")) {
      this.history.add("superops.write.note", { input: structuredClone(input) });
      const fault = this.options.noteFault ?? "accepted";
      if (fault === "rateLimit") return this.rateLimitResponse();
      if (fault === "graphqlReject") return graphQlError("createTicketNote");
      if (fault !== "timeoutNoApply") {
        const content = typeof input.content === "string" ? input.content : "";
        this.pendingNote = { ...RAW_GRAPHQL_PRIVATE_JUNK, content: `<html>${content}</html>` };
        if (this.options.noteChangesUpdatedTime) this.ticket.updatedTime = this.nextUpdatedTime();
      }
      if (fault === "timeoutApply" || fault === "timeoutNoApply") {
        throw new Error("deterministic transport timeout after note submission");
      }
      return graphQlData({ createTicketNote: { noteId: RAW_GRAPHQL_PRIVATE_JUNK.noteId, privacyType: "PRIVATE" } });
    }
    if (query.includes("mutation updateTicket")) {
      const isStatusOnly = input.status === "Resolved";
      const kind = isStatusOnly ? "status" : "classification";
      this.history.add(`superops.write.${kind}`, { input: structuredClone(input) });
      const fault = isStatusOnly
        ? this.options.statusFault ?? "accepted"
        : this.classificationFaults.shift() ?? this.options.classificationFault ?? "accepted";
      if (fault === "rateLimit") return this.rateLimitResponse();
      if (fault === "graphqlReject") return graphQlError("updateTicket");
      if (fault === "graphqlPartial") {
        this.ticket.impact = String(input.impact ?? "Low");
        this.ticket.updatedTime = this.nextUpdatedTime();
        return graphQlError("updateTicket");
      }
      if (fault !== "timeoutNoApply") {
        if (isStatusOnly) {
          this.ticket.status = "Resolved";
        } else {
          this.setClassified();
        }
        this.ticket.updatedTime = this.nextUpdatedTime();
      }
      if (fault === "timeoutApply" || fault === "timeoutNoApply") {
        throw new Error(`deterministic transport timeout after ${kind} submission`);
      }
      return graphQlData({ updateTicket: { ticketId: TICKET_ID, status: this.ticket.status } });
    }
    if (query.includes("getTicket")) {
      this.ticketReadCount += 1;
      if (this.remainingCanonicalTicketReadRateLimits > 0) {
        this.remainingCanonicalTicketReadRateLimits -= 1;
        this.history.add("superops.read.ticket", {
          ticketId: input.ticketId,
          read: this.ticketReadCount,
          rateLimited: true,
        });
        return graphQlReadRateLimit("getTicket");
      }
      if (this.options.unrelatedChangeOnTicketRead === this.ticketReadCount) {
        this.ticket.cause = "User Request";
        this.ticket.updatedTime = this.nextUpdatedTime();
      }
      this.history.add("superops.read.ticket", { ticketId: input.ticketId, read: this.ticketReadCount });
      return graphQlData({ getTicket: structuredClone(this.ticket) });
    }

    throw new Error("Unexpected GraphQL operation in deterministic harness.");
  }
}
type ToolResponse = { content: Array<{ type: string; text: string }>; isError?: boolean };

type ParsedApplyResponse = {
  operation: Record<string, unknown>;
  results: Array<Record<string, unknown>>;
  summary?: Record<string, unknown>;
};

function resolveAction() {
  return {
    ticketNumber: TICKET_NUMBER,
    expectedTicketId: TICKET_ID,
    expectedStatus: "New Calls",
    expectedUpdatedTime: INITIAL_UPDATED_TIME,
    contentVerified: true,
    action: "resolve",
    note: "JUNK",
    target: { ...RESOLVE_TARGET },
  };
}

function scheduledResolveAction() {
  return {
    ...resolveAction(),
    expectedSubject: "Anonymised junk call",
    policyDisposition: "resolve_no_action",
    note: SCHEDULED_TRIAGE_NOTE,
    isPublicNote: false,
  };
}

class TriageHarness {
  readonly history = new History();
  readonly clock = new FakeClock(this.history);
  readonly ledger = new FakeDurableLedger(this.history);
  readonly superops: FakeSuperOps;
  readonly operationId: string;

  constructor(label: string, options: FakeSuperOpsOptions = {}) {
    this.operationId = `triage-harness-${label}`;
    this.superops = new FakeSuperOps(this.history, options);
    this.clock.install();
    this.superops.install();
  }

  private runContext<T>(fn: () => T, config: ExecutionConfigInput = {}): Promise<Awaited<T>> {
    const value = runWithOperationStore(
      { SUPEROPS_OPERATION_LEDGER: this.ledger.namespace },
      () => runWithContinuationScheduler({
        SUPEROPS_CONTINUATION_ENABLED: "true",
        SUPEROPS_DURABLE_RETRY_ENABLED: "true",
        SUPEROPS_INTERNAL_CONTINUATION_TOKEN: "deterministic-internal-token",
        SUPEROPS_CONTINUATION_SERVICE: {
          fetch: async () => {
            this.history.add("scheduler.continuation");
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          },
        },
      }, () => runWithExecutionConfig(
        { ...BASE_EXECUTION_CONFIG, ...config },
        () => runWithExecutionContext(
          "superops_tickets_apply_triage_plan",
          () => runWithCredentials(HARNESS_CREDS, fn),
          this.operationId
        )
      ))
    );
    return this.clock.settle(Promise.resolve(value)) as Promise<Awaited<T>>;
  }

  async invoke(params: Record<string, unknown> = {}, config: ExecutionConfigInput = {}): Promise<{
    response: ToolResponse;
    parsed: ParsedApplyResponse;
  }> {
    const response = await this.runContext(
      () => getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
        batchId: this.operationId,
        expectedCandidateTicketNumbers: [TICKET_NUMBER],
        actions: [resolveAction()],
        ...params,
      }),
      config
    ) as ToolResponse;
    return {
      response,
      parsed: JSON.parse(response.content[0].text) as ParsedApplyResponse,
    };
  }

  async record(): Promise<OperationLedgerRecord> {
    const record = await this.runContext(() => getOperationStore().get(this.operationId, currentOwnerHash()));
    if (!record) throw new Error(`Missing operation ${this.operationId}.`);
    return record;
  }

  async updateRecord(
    updater: (record: OperationLedgerRecord) => OperationLedgerRecord
  ): Promise<OperationLedgerRecord> {
    return this.runContext(() => getOperationStore().update(
      this.operationId,
      currentOwnerHash(),
      updater
    ));
  }

  async resume(now?: string): Promise<void> {
    const resumeNumber = this.history.count("continuation.resume") + 1;
    this.history.add("continuation.resume", { now, resumeNumber });
    await this.runContext(() => resumeApplyTriageOperation({
      operationId: this.operationId,
      ownerHash: currentOwnerHash(),
      leaseOwner: `harness-resume-${resumeNumber}`,
      leaseMs: 1000,
      now,
    }));
  }

  async resumeUntilTerminal(maxContinuations = 6): Promise<OperationLedgerRecord> {
    for (let attempt = 0; attempt < maxContinuations; attempt += 1) {
      const record = await this.record();
      if (!["Running", "ContinuationRequired", "Rescheduled"].includes(record.state)) return record;
      if (record.nextEligibleTime) this.clock.advanceTo(record.nextEligibleTime);
      await this.resume(record.nextEligibleTime);
    }
    const final = await this.record();
    if (["Running", "ContinuationRequired", "Rescheduled"].includes(final.state)) {
      throw new Error(`Operation remained non-terminal after ${maxContinuations} deterministic continuations.`);
    }
    return final;
  }

  async seedCheckpoint(stage: OperationItemStage): Promise<OperationLedgerRecord> {
    await this.invoke({
      expectedCandidateTicketNumbers: ["control-no-action", TICKET_NUMBER],
      actions: [resolveAction()],
    }, {
      SUPEROPS_EXECUTION_MAX_ITEMS_PER_BATCH: "1",
    });

    const stages = [
      "PreflightValidated",
      "ClassificationWriteStarted",
      "ClassificationVerified",
      "NoteDedupeChecked",
      "NoteWriteStarted",
      "NoteAdded",
      "NoteVerified",
      "StatusWriteStarted",
      "StatusWriteSucceeded",
      "StatusVerified",
    ] as const;
    const index = stages.indexOf(stage as typeof stages[number]);
    if (index < 0) throw new Error(`Unsupported seeded checkpoint ${stage}.`);

    if (index >= 1) this.superops.setClassified();
    if (index >= 4) this.superops.addCanonicalPrivateJunk();
    if (index >= 7) this.superops.setResolved();

    return this.updateRecord((record) => {
      const item = record.itemStates[TICKET_NUMBER];
      const classificationStarted = index >= 1;
      const noteStarted = index >= 4;
      const statusStarted = index >= 7;
      record.state = "ContinuationRequired";
      record.pendingItems = [TICKET_NUMBER];
      record.nextEligibleTime = undefined;
      record.currentLease = undefined;
      record.terminalFailureReason = `Seeded deterministic continuation at ${stage}.`;
      record.itemStates[TICKET_NUMBER] = {
        ...item,
        stage,
        writeAttempted: classificationStarted,
        writeMayHaveSucceeded: classificationStarted,
        partialWrite: classificationStarted && stage !== "StatusVerified",
        mutationType: statusStarted ? "status" : noteStarted ? "note" : "classification",
        mutationStartStage: stage === "ClassificationWriteStarted" || stage === "NoteWriteStarted" || stage === "StatusWriteStarted"
          ? stage
          : undefined,
        reliableResponseReceived: classificationStarted && !["ClassificationWriteStarted", "NoteWriteStarted", "StatusWriteStarted"].includes(stage),
        observedMutationResult: !classificationStarted
          ? undefined
          : ["ClassificationWriteStarted", "NoteWriteStarted", "StatusWriteStarted"].includes(stage)
            ? "Ambiguous"
            : "VerifiedApplied",
        verificationState: stage === "ClassificationWriteStarted" || stage === "NoteWriteStarted" || stage === "StatusWriteStarted"
          ? "Pending"
          : classificationStarted ? "Verified" : "Pending",
        attemptCount: statusStarted ? 3 : noteStarted ? 2 : classificationStarted ? 1 : 0,
        createdNoteId: noteStarted ? CANONICAL_PRIVATE_JUNK.id : undefined,
        lease: undefined,
      };
      return record;
    });
  }

  assertGlobalInvariants(record?: OperationLedgerRecord): void {
    const writes = this.history.events.filter((event) => event.kind.startsWith("superops.write."));
    const classifications = writes.filter((event) => event.kind === "superops.write.classification");
    const notes = writes.filter((event) => event.kind === "superops.write.note");
    const statuses = writes.filter((event) => event.kind === "superops.write.status");

    expect(classifications.length).toBeLessThanOrEqual(1);
    expect(notes.length).toBeLessThanOrEqual(1);
    expect(statuses.length).toBeLessThanOrEqual(1);

    for (const event of classifications) {
      const input = event.details?.input as Record<string, unknown>;
      expect(input).not.toHaveProperty("priority");
      expect(input).not.toHaveProperty("status");
      expect(input).not.toHaveProperty("technician");
      expect(input).not.toHaveProperty("techGroup");
      expect(input).not.toHaveProperty("suppressCloseNotification");
    }
    for (const event of notes) {
      const input = event.details?.input as Record<string, unknown>;
      expect(input.privacyType).toBe("PRIVATE");
      expect(input).not.toHaveProperty("isPublic");
      expect(input).not.toHaveProperty("toUsers");
      expect(input).not.toHaveProperty("email");
    }
    for (const event of statuses) {
      const input = event.details?.input as Record<string, unknown>;
      expect(input).toEqual({
        ticketId: TICKET_ID,
        status: "Resolved",
        suppressCloseNotification: true,
      });
    }
    if (record) {
      expect(record.state).not.toBe("Running");
      expect(record.pendingItems).toEqual([]);
      expect(record.itemStates[TICKET_NUMBER]?.stage).toMatch(
        /Completed|Unresolved|Failed|Stale|Skipped|RateLimit/
      );
    }
  }
}
function firstResult(parsed: ParsedApplyResponse): Record<string, unknown> {
  const result = parsed.results[0];
  if (!result) throw new Error("Harness response omitted the ticket result.");
  return result;
}

function itemResult(record: OperationLedgerRecord): Record<string, unknown> {
  const result = record.compactResults.find((value) =>
    typeof value === "object" && value !== null &&
    (value as Record<string, unknown>).ticketNumber === TICKET_NUMBER
  );
  if (!result) throw new Error("Harness ledger omitted the compact ticket result.");
  return result as Record<string, unknown>;
}

describe("deterministic end-to-end apply-triage harness", () => {
  beforeEach(() => {
    resetTicketFieldOptionsCacheForTests();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("keeps the public ChatGPT mutation surface limited to apply_triage_plan", async () => {
    const blocked = await chatGptDirectBlockedToolNames({ reviewedTriagePlanAllowed: true });
    const exposedMutations = [...MUTATING_TOOL_NAMES].filter((name) => !blocked.has(name));
    expect(exposedMutations).toEqual(["superops_tickets_apply_triage_plan"]);
  });

  it("A: resolves a clean junk ticket through every staged write exactly once", async () => {
    const harness = new TriageHarness("clean", { noteChangesUpdatedTime: true });
    const { response, parsed } = await harness.invoke();
    const result = firstResult(parsed);
    const record = await harness.record();

    expect(response.isError).not.toBe(true);
    expect(result).toMatchObject({
      finalOutcome: "Resolved",
      workflowMode: "staged",
      classificationWriteOutcome: "Accepted",
      noteAdded: true,
      noteDeduped: false,
      noteDedupeChecked: true,
      statusWriteMethod: "updateTicket.statusOnly",
      suppressCloseNotificationIncluded: true,
      finalVerificationState: "Verified",
      verified: true,
    });
    expect(result.completedStages).toEqual(expect.arrayContaining([
      "PreflightValidated",
      "ClassificationVerified",
      "NoteDedupeChecked",
      "NoteVerified",
      "StatusVerified",
    ]));
    expect(harness.history.kinds("superops.")).toEqual([
      "superops.read.ticket-list",
      "superops.read.ticket",
      "superops.read.fields",
      "superops.write.classification",
      "superops.read.ticket",
      "superops.read.notes",
      "superops.read.notes",
      "superops.write.note",
      "superops.read.notes",
      "superops.read.ticket",
      "superops.write.status",
      "superops.read.ticket",
      "superops.read.notes",
    ]);
    const durablePreflight = harness.history.events.find((event) =>
      event.kind === "ledger.checkpoint" && event.details?.stage === "PreflightValidated"
    );
    expect(durablePreflight?.sequence).toBeLessThan(harness.history.first("superops.write.classification"));
    expect(harness.superops.ticket).toMatchObject({
      status: "Resolved",
      client: { accountId: CLIENT_ID, name: "TaskGroup" },
      priority: "Very Low",
      ...CLASSIFICATION,
    });
    harness.assertGlobalInvariants(record);
  });

  it("scheduled policy survives delayed visibility continuation without duplicating any write", async () => {
    const harness = new TriageHarness("scheduled-policy", { noteVisibilityMisses: 2 });
    const initial = await harness.invoke({
      policyMode: "scheduled-new-calls-v1",
      actions: [scheduledResolveAction()],
    });
    const stored = await harness.record();

    expect(firstResult(initial.parsed)).toMatchObject({
      finalOutcome: "NoteVisibilityPending",
      continuationRequired: true,
    });
    expect(stored.operationRequest).toMatchObject({
      policyMode: "scheduled-new-calls-v1",
      actions: [{ policyDisposition: "resolve_no_action", isPublicNote: false }],
    });

    const terminal = await harness.resumeUntilTerminal();
    expect(terminal.state).toBe("Completed");
    expect(itemResult(terminal)).toMatchObject({
      finalOutcome: "Resolved",
      noteVerifiedAfterDelay: true,
      finalVerificationState: "Verified",
    });
    expect(harness.superops.ticket).toMatchObject({
      status: "Resolved",
      client: { accountId: CLIENT_ID, name: "TaskGroup" },
      ...CLASSIFICATION,
    });
    expect(harness.history.count("superops.write.classification")).toBe(1);
    expect(harness.history.count("superops.write.note")).toBe(1);
    expect(harness.history.count("superops.write.status")).toBe(1);
    harness.assertGlobalInvariants(terminal);
  });

  it("scheduled policy blocks a null-client ticket unless the exact TaskGroup target is supplied", async () => {
    const harness = new TriageHarness("scheduled-client-guard");
    const scheduled = scheduledResolveAction();
    const action = { ...scheduled, target: { ...scheduled.target, clientId: "wrong-client" } };
    const { parsed } = await harness.invoke({
      policyMode: "scheduled-new-calls-v1",
      actions: [action],
    });
    const record = await harness.record();

    expect(firstResult(parsed)).toMatchObject({
      finalOutcome: "Blocked",
      failureStage: "clientAssignment",
      writeAttempted: false,
    });
    expect(harness.history.kinds("superops.write.")).toEqual([]);
    harness.assertGlobalInvariants(record);
  });

  it("B: recovers ticket 59005 from the exact raw GraphQL private-note shape with one status write", async () => {
    const harness = new TriageHarness("recovery", {
      classified: true,
      initialNotes: [{ ...RAW_GRAPHQL_PRIVATE_JUNK }],
      noteReadsRequireInternalId: true,
    });
    const { parsed } = await harness.invoke();
    const result = firstResult(parsed);
    const record = await harness.record();

    expect(result).toMatchObject({
      classificationWriteOutcome: "NotRequired",
      noteDedupeChecked: true,
      noteDeduped: true,
      noteAdded: false,
      statusWriteMethod: "updateTicket.statusOnly",
      suppressCloseNotificationIncluded: true,
      finalOutcome: "Resolved",
      finalVerificationState: "Verified",
      verified: true,
    });
    expect(result.physicalWrites).toEqual([
      { method: "updateTicket.statusOnly", outcome: "Accepted" },
    ]);
    expect(harness.history.kinds("superops.")).toEqual([
      "superops.read.ticket-list",
      "superops.read.ticket",
      "superops.read.fields",
      "superops.read.ticket",
      "superops.read.notes",
      "superops.read.notes",
      "superops.read.ticket",
      "superops.write.status",
      "superops.read.ticket",
      "superops.read.notes",
    ]);
    expect(harness.history.first("superops.read.notes")).toBeLessThan(harness.history.first("superops.write.status"));
    const noteReadTicketIds = harness.history.events
      .filter((event) => event.kind === "superops.read.notes")
      .map((event) => event.details?.ticketId);
    expect(noteReadTicketIds).toEqual([TICKET_ID, TICKET_ID, TICKET_ID]);
    expect(harness.history.count("superops.write.note")).toBe(0);
    expect(harness.history.count("superops.write.status")).toBe(1);
    expect(harness.superops.ticket.status).toBe("Resolved");
    harness.assertGlobalInvariants(record);
  });

  it("normalizes the exact canonical safe-note representation through the same collector", async () => {
    const harness = new TriageHarness("canonical-private-note", {
      classified: true,
      initialNotes: [{ ...CANONICAL_PRIVATE_JUNK }],
    });
    const { parsed } = await harness.invoke();
    const record = await harness.record();

    expect(firstResult(parsed)).toMatchObject({ noteDeduped: true, noteAdded: false, finalOutcome: "Resolved" });
    expect(harness.history.count("superops.write.note")).toBe(0);
    harness.assertGlobalInvariants(record);
  });

  it("C: a public JUNK note does not dedupe the required private note", async () => {
    const harness = new TriageHarness("public-note", {
      classified: true,
      initialNotes: [{ ...RAW_GRAPHQL_PUBLIC_JUNK }],
    });
    const { parsed } = await harness.invoke();
    const record = await harness.record();

    expect(firstResult(parsed)).toMatchObject({
      finalOutcome: "Resolved",
      noteAdded: true,
      noteDeduped: false,
      finalVerificationState: "Verified",
    });
    expect(harness.history.count("superops.write.note")).toBe(1);
    expect(harness.superops.visibleNotes).toHaveLength(2);
    harness.assertGlobalInvariants(record);
  });

  it("D: unavailable note retrieval stops before note creation and status close", async () => {
    const harness = new TriageHarness("note-read-unavailable", {
      classified: true,
      noteReadUnavailable: true,
    });
    const { parsed } = await harness.invoke();
    const result = firstResult(parsed);
    const record = await harness.record();

    expect(result).toMatchObject({
      finalOutcome: "Failed",
      failureStage: "noteCheck",
      terminalReason: "NoteCheckFailed",
      noteDedupeChecked: false,
    });
    expect(String(result.failureReason)).toContain("Notes could not be fetched");
    expect(harness.history.kinds("superops.write.")).toEqual([]);
    harness.assertGlobalInvariants(record);
  });

  it("fails closed on an unsupported note privacy shape", async () => {
    const harness = new TriageHarness("unknown-note-shape", {
      classified: true,
      initialNotes: [{ id: "unknown", type: "note", plainText: "JUNK" }],
    });
    const { parsed } = await harness.invoke();
    const record = await harness.record();

    expect(firstResult(parsed)).toMatchObject({ failureStage: "noteCheck", terminalReason: "NoteCheckFailed" });
    expect(harness.history.kinds("superops.write.")).toEqual([]);
    harness.assertGlobalInvariants(record);
  });

  it("fails closed on an unsupported note collection envelope", async () => {
    const harness = new TriageHarness("unknown-note-envelope", {
      classified: true,
      unsupportedNoteEnvelope: true,
    });
    const { parsed } = await harness.invoke();
    const record = await harness.record();

    expect(firstResult(parsed)).toMatchObject({ failureStage: "noteCheck", terminalReason: "NoteCheckFailed" });
    expect(harness.history.kinds("superops.write.")).toEqual([]);
    harness.assertGlobalInvariants(record);
  });

  it("E: accepted note visibility delay reconciles by read without replay", async () => {
    const harness = new TriageHarness("delayed-note", { noteVisibilityMisses: 2 });
    const initial = await harness.invoke();

    expect(firstResult(initial.parsed)).toMatchObject({
      finalOutcome: "NoteVisibilityPending",
      continuationRequired: true,
      noteVerificationAttempts: 1,
    });
    expect(harness.history.count("superops.write.note")).toBe(1);
    expect(harness.history.count("superops.write.status")).toBe(0);

    const record = await harness.resumeUntilTerminal();
    expect(record.state).toBe("Completed");
    expect(itemResult(record)).toMatchObject({
      finalOutcome: "Resolved",
      noteWriteOutcome: "NoteVerifiedAfterDelay",
      noteVerificationAttempts: 2,
      noteVerifiedAfterDelay: true,
      finalVerificationState: "Verified",
    });
    expect(harness.history.count("superops.write.note")).toBe(1);
    expect(harness.history.count("superops.write.status")).toBe(1);
    expect(harness.history.first("continuation.resume")).toBeGreaterThan(harness.history.first("superops.read.notes"));
    harness.assertGlobalInvariants(record);
  });

  it("F: a permanently invisible accepted note terminates without closing or replay", async () => {
    const harness = new TriageHarness("invisible-note", { noteVisibilityMisses: Number.POSITIVE_INFINITY });
    await harness.invoke();
    const record = await harness.resumeUntilTerminal();
    const result = itemResult(record);

    expect(record.state).toBe("CompletedWithFailures");
    expect(record.itemStates[TICKET_NUMBER]).toMatchObject({
      stage: "AmbiguousWriteUnresolved",
      outcome: "NoteVisibilityUnresolved",
      writeAttempted: true,
      writeMayHaveSucceeded: true,
      partialWrite: true,
    });
    expect(result).toMatchObject({
      terminalReason: "NoteVisibilityUnresolved",
      noteVerificationAttempts: 4,
      continuationRequired: false,
    });
    expect(harness.history.count("superops.write.note")).toBe(1);
    expect(harness.history.count("superops.write.status")).toBe(0);
    expect(result.physicalWrites).toEqual(expect.arrayContaining([
      { method: "updateTicket.classification", outcome: "Accepted" },
      { method: "createTicketNote", outcome: "Accepted" },
    ]));
    harness.assertGlobalInvariants(record);
  });
  it("G: transient durable-store rate limiting retries with bounded fake-clock backoff before any write", async () => {
    const harness = new TriageHarness("store-rate-limit-recovery");
    harness.ledger.setPreflightRateLimit("transient");
    const { parsed } = await harness.invoke();
    const record = await harness.record();

    expect(firstResult(parsed)).toMatchObject({ finalOutcome: "Resolved", finalVerificationState: "Verified" });
    expect(harness.history.count("ledger.rate-limit")).toBe(2);
    expect(harness.history.count("clock.delay")).toBe(2);
    const durablePreflight = harness.history.events.find((event) =>
      event.kind === "ledger.checkpoint" && event.details?.stage === "PreflightValidated"
    );
    expect(durablePreflight?.sequence).toBeLessThan(harness.history.first("superops.write.classification"));
    harness.assertGlobalInvariants(record);
  });

  it("reschedules the exact pre-write getTicket DataFetchingException and completes 59005 in a fresh continuation", async () => {
    const harness = new TriageHarness("preflight-ticket-rate-limit", {
      classified: true,
      initialNotes: [{ ...CANONICAL_PRIVATE_JUNK }],
      canonicalTicketReadRateLimits: 3,
    });
    const { parsed } = await harness.invoke({}, {
      SUPEROPS_EXECUTION_MAX_READ_RETRY_ATTEMPTS: "3",
    });
    const rescheduled = await harness.record();

    expect(parsed.operation).toMatchObject({
      complete: false,
      continuationRequired: true,
      state: "Rescheduled",
      writeAttempted: false,
      writeMayHaveSucceeded: false,
    });
    expect(rescheduled.itemStates[TICKET_NUMBER]).toMatchObject({
      stage: "RateLimitedRescheduled",
      writeAttempted: false,
      writeMayHaveSucceeded: false,
      errorClass: "SuperOpsRateLimit",
      rateLimit: {
        operationName: "getTicket",
        writeAttempted: false,
      },
    });
    expect(rescheduled.itemStates[TICKET_NUMBER]?.attemptCount ?? 0).toBe(0);
    expect(harness.history.count("superops.read.ticket")).toBe(3);
    expect(harness.history.events.filter((event) => event.kind.startsWith("superops.write."))).toHaveLength(0);

    const record = await harness.resumeUntilTerminal();
    const result = itemResult(record);
    expect(result).toMatchObject({
      ticketNumber: TICKET_NUMBER,
      classificationWriteOutcome: "NotRequired",
      noteDedupeChecked: true,
      noteDeduped: true,
      noteAdded: false,
      statusWriteMethod: "updateTicket.statusOnly",
      suppressCloseNotificationIncluded: true,
      finalOutcome: "Resolved",
      finalVerificationState: "Verified",
      verified: true,
    });
    expect(harness.history.first("continuation.resume")).toBeLessThan(harness.history.first("superops.write.status"));
    expect(harness.history.count("superops.write.classification")).toBe(0);
    expect(harness.history.count("superops.write.note")).toBe(0);
    expect(harness.history.count("superops.write.status")).toBe(1);
    harness.assertGlobalInvariants(record);
  });

  it("reschedules a budget-deferred item when its resumed metadata read is rate-limited", async () => {
    const harness = new TriageHarness("rescheduled-read-rate-limit", {
      canonicalTicketReadRateLimits: 3,
    });
    await harness.invoke({
      expectedCandidateTicketNumbers: ["control-no-action", TICKET_NUMBER],
      actions: [resolveAction()],
    }, {
      SUPEROPS_EXECUTION_MAX_ITEMS_PER_BATCH: "1",
      SUPEROPS_EXECUTION_MAX_READ_RETRY_ATTEMPTS: "3",
    });
    await harness.updateRecord((record) => {
      const item = record.itemStates[TICKET_NUMBER];
      record.state = "ContinuationRequired";
      record.pendingItems = [TICKET_NUMBER];
      record.nextEligibleTime = undefined;
      record.currentLease = undefined;
      record.terminalFailureReason = "Seeded deterministic budget continuation.";
      record.itemStates[TICKET_NUMBER] = {
        ...item,
        stage: "Rescheduled",
        outcome: "NotAttemptedExecutionBudget",
        writeAttempted: false,
        writeMayHaveSucceeded: false,
        partialWrite: false,
        verificationState: "Pending",
        lease: undefined,
      };
      return record;
    });

    await harness.resume();
    const throttled = await harness.record();
    expect(throttled).toMatchObject({
      state: "Rescheduled",
      itemStates: {
        [TICKET_NUMBER]: {
          stage: "RateLimitedRescheduled",
          outcome: "SuperOpsRateLimitRescheduled",
          writeAttempted: false,
          writeMayHaveSucceeded: false,
          partialWrite: false,
          errorClass: "SuperOpsRateLimit",
        },
      },
    });
    expect(harness.history.events.filter((event) => event.kind.startsWith("superops.write."))).toHaveLength(0);

    const terminal = await harness.resumeUntilTerminal();
    expect(terminal.state).toBe("Completed");
    expect(itemResult(terminal)).toMatchObject({
      finalOutcome: "Resolved",
      finalVerificationState: "Verified",
      verified: true,
    });
    expect(harness.history.count("superops.write.classification")).toBe(1);
    expect(harness.history.count("superops.write.note")).toBe(1);
    expect(harness.history.count("superops.write.status")).toBe(1);
    harness.assertGlobalInvariants(terminal);
  });

  it("retries consecutive reliable classification throttles and applies each staged write once", async () => {
    const harness = new TriageHarness("repeated-classification-rate-limit", {
      classificationFaults: ["rateLimit", "rateLimit", "accepted"],
    });
    await harness.invoke();

    const firstThrottle = await harness.record();
    expect(firstThrottle).toMatchObject({
      state: "Rescheduled",
      itemStates: {
        [TICKET_NUMBER]: {
          stage: "RateLimitedRescheduled",
          writeAttempted: true,
          writeMayHaveSucceeded: false,
          observedMutationResult: "Rejected",
          partialWrite: false,
          errorClass: "SuperOpsRateLimit",
        },
      },
    });

    const terminal = await harness.resumeUntilTerminal();
    const result = itemResult(terminal);
    expect(terminal.state).toBe("Completed");
    expect(result).toMatchObject({
      classificationWriteOutcome: "Accepted",
      noteAdded: true,
      noteDeduped: false,
      statusWriteMethod: "updateTicket.statusOnly",
      suppressCloseNotificationIncluded: true,
      finalOutcome: "Resolved",
      finalVerificationState: "Verified",
      verified: true,
    });
    expect(result.physicalWrites).toEqual([
      { method: "updateTicket.classification", outcome: "Accepted" },
      { method: "createTicketNote", outcome: "Accepted" },
      { method: "updateTicket.statusOnly", outcome: "Accepted" },
    ]);
    expect(harness.history.count("superops.write.classification")).toBe(3);
    expect(harness.history.count("superops.write.note")).toBe(1);
    expect(harness.history.count("superops.write.status")).toBe(1);
    expect(harness.history.count("continuation.resume")).toBe(2);
  });

  it("terminalizes persistent pre-write getTicket throttling at the durable ceiling without any write", async () => {
    const harness = new TriageHarness("persistent-preflight-ticket-rate-limit", {
      classified: true,
      initialNotes: [{ ...CANONICAL_PRIVATE_JUNK }],
      canonicalTicketReadRateLimits: Number.POSITIVE_INFINITY,
    });
    await harness.invoke();
    const record = await harness.resumeUntilTerminal();

    expect(record.state).toBe("CompletedWithFailures");
    expect(record.itemStates[TICKET_NUMBER]).toMatchObject({
      stage: "RateLimitExceeded",
      writeAttempted: false,
      writeMayHaveSucceeded: false,
      partialWrite: false,
      errorClass: "RateLimitExceeded",
      rateLimit: {
        operationName: "getTicket",
        attempts: 4,
        writeAttempted: false,
        finalResult: "RateLimitExceeded",
      },
    });
    expect(harness.history.count("continuation.resume")).toBe(3);
    expect(harness.history.events.filter((event) => event.kind.startsWith("superops.write."))).toHaveLength(0);
    harness.assertGlobalInvariants(record);
  });

  it("H: persistent durable-store rate limiting terminalizes with no write or false continuation", async () => {
    const harness = new TriageHarness("store-rate-limit-terminal");
    harness.ledger.setPreflightRateLimit("persistent");
    const { response, parsed } = await harness.invoke();
    const record = await harness.record();

    expect(response.isError).toBe(true);
    expect(parsed.operation).toMatchObject({
      state: "CompletedWithFailures",
      complete: true,
      continuationRequired: false,
      errorClass: "OperationStoreFailure",
      writeAttempted: false,
      writeMayHaveSucceeded: false,
    });
    expect(record.itemStates[TICKET_NUMBER]).toMatchObject({
      stage: "FailedBeforeWrite",
      errorClass: "OperationStoreFailure",
      writeAttempted: false,
      writeMayHaveSucceeded: false,
      partialWrite: false,
    });
    expect(harness.history.count("ledger.rate-limit")).toBe(3);
    expect(harness.history.count("scheduler.continuation")).toBe(0);
    expect(harness.history.kinds("superops.write.")).toEqual([]);
    harness.assertGlobalInvariants(record);
  });

  it("I: classification partial write is read back exactly and never replayed", async () => {
    const harness = new TriageHarness("classification-partial", { classificationFault: "graphqlPartial" });
    const { parsed } = await harness.invoke();
    const result = firstResult(parsed);
    const record = await harness.record();

    expect(result).toMatchObject({
      finalOutcome: "Failed",
      failureStage: "classificationVerification",
      terminalReason: "PartialClassificationObserved",
      partialWrite: true,
      writeMayHaveSucceeded: true,
    });
    expect(result.partialFieldsObserved).toEqual({ impact: "Low" });
    expect(harness.history.count("superops.write.classification")).toBe(1);
    expect(harness.history.count("superops.write.note")).toBe(0);
    expect(harness.history.count("superops.write.status")).toBe(0);
    harness.assertGlobalInvariants(record);
  });

  it("J: ambiguous note write is read before any later action and is never replayed", async () => {
    const harness = new TriageHarness("ambiguous-note", { classified: true, noteFault: "timeoutApply" });
    const { parsed } = await harness.invoke();
    const result = firstResult(parsed);
    const record = await harness.record();

    expect(result).toMatchObject({ finalOutcome: "Resolved", noteDeduped: true, finalVerificationState: "Verified" });
    expect(harness.history.count("superops.write.note")).toBe(1);
    expect(harness.history.count("superops.write.status")).toBe(1);
    const noteWrite = harness.history.first("superops.write.note");
    const noteReadAfterWrite = harness.history.events.find((event) =>
      event.kind === "superops.read.notes" && event.sequence > noteWrite
    );
    expect(noteReadAfterWrite?.sequence).toBeLessThan(harness.history.first("superops.write.status"));
    harness.assertGlobalInvariants(record);
  });

  it("K1: visible resolved state reconciles an ambiguous status write without replay", async () => {
    const harness = new TriageHarness("ambiguous-status-visible", {
      classified: true,
      initialNotes: [{ ...CANONICAL_PRIVATE_JUNK }],
      statusFault: "timeoutApply",
    });
    const { parsed } = await harness.invoke();
    const record = await harness.record();

    expect(firstResult(parsed)).toMatchObject({
      finalOutcome: "Resolved",
      statusWriteOutcome: "Ambiguous",
      finalVerificationState: "Verified",
    });
    expect(harness.history.count("superops.write.status")).toBe(1);
    expect(harness.history.events.find((event) =>
      event.kind === "superops.read.ticket" && event.sequence > harness.history.first("superops.write.status")
    )).toBeDefined();
    harness.assertGlobalInvariants(record);
  });

  it("K2: unresolved ambiguous status terminates safely without replay", async () => {
    const harness = new TriageHarness("ambiguous-status-unresolved", {
      classified: true,
      initialNotes: [{ ...CANONICAL_PRIVATE_JUNK }],
      statusFault: "timeoutNoApply",
    });
    const { parsed } = await harness.invoke();
    const result = firstResult(parsed);
    const record = await harness.record();

    expect(result).toMatchObject({
      finalOutcome: "Failed",
      terminalReason: "AmbiguousStatusCloseUnresolved",
      statusWriteOutcome: "Ambiguous",
      finalVerificationState: "Pending",
    });
    expect(harness.history.count("superops.write.status")).toBe(1);
    harness.assertGlobalInvariants(record);
  });

  it("L1: workflow-owned updatedTime changes do not look like concurrent modification", async () => {
    const harness = new TriageHarness("owned-updated-time", { noteChangesUpdatedTime: true });
    const { parsed } = await harness.invoke();
    const record = await harness.record();

    expect(firstResult(parsed)).toMatchObject({ finalOutcome: "Resolved", finalVerificationState: "Verified" });
    expect(harness.history.count("superops.write.status")).toBe(1);
    harness.assertGlobalInvariants(record);
  });

  it("L2: unrelated changes before close stop the workflow", async () => {
    const harness = new TriageHarness("concurrent-change", { unrelatedChangeOnTicketRead: 3 });
    const { parsed } = await harness.invoke();
    const result = firstResult(parsed);
    const record = await harness.record();

    expect(result).toMatchObject({
      finalOutcome: "Failed",
      failureStage: "concurrencyRecheck",
      terminalReason: "ConcurrentModificationDetected",
    });
    expect(harness.history.count("superops.write.classification")).toBe(1);
    expect(harness.history.count("superops.write.note")).toBe(1);
    expect(harness.history.count("superops.write.status")).toBe(0);
    harness.assertGlobalInvariants(record);
  });

  it("scripted reliable rejection is terminal and non-replayed", async () => {
    const harness = new TriageHarness("reliable-note-rejection", { classified: true, noteFault: "graphqlReject" });
    const { parsed } = await harness.invoke();
    const record = await harness.record();

    expect(firstResult(parsed)).toMatchObject({ terminalReason: "NoteCreationRejected", writeMayHaveSucceeded: false });
    expect(harness.history.count("superops.write.note")).toBe(1);
    expect(harness.history.count("superops.write.status")).toBe(0);
    harness.assertGlobalInvariants(record);
  });

  it("scripted stale state stops before every write", async () => {
    const harness = new TriageHarness("stale-ticket");
    const action = { ...resolveAction(), expectedUpdatedTime: "2026-07-24T17:39:00.000" };
    const { parsed } = await harness.invoke({ actions: [action] });
    const record = await harness.record();

    expect(firstResult(parsed)).toMatchObject({ finalOutcome: "SkippedChangedSinceSnapshot", writeAttempted: false });
    expect(harness.history.kinds("superops.write.")).toEqual([]);
    harness.assertGlobalInvariants(record);
  });

  const checkpoints = [
    ["PreflightValidated", 1, 1, 1],
    ["ClassificationWriteStarted", 0, 1, 1],
    ["ClassificationVerified", 0, 1, 1],
    ["NoteDedupeChecked", 0, 1, 1],
    ["NoteWriteStarted", 0, 0, 1],
    ["NoteAdded", 0, 0, 1],
    ["NoteVerified", 0, 0, 1],
    ["StatusWriteStarted", 0, 0, 0],
    ["StatusWriteSucceeded", 0, 0, 0],
    ["StatusVerified", 0, 0, 0],
  ] as const;

  it.each(checkpoints)(
    "M: resumes from %s without repeating earlier writes",
    async (stage, classificationWrites, noteWrites, statusWrites) => {
      const harness = new TriageHarness(`checkpoint-${stage}`);
      const seeded = await harness.seedCheckpoint(stage);
      const seededAttempts = seeded.itemStates[TICKET_NUMBER].attemptCount ?? 0;
      harness.history.add("checkpoint.seeded", { stage, attemptCount: seededAttempts });

      await harness.resume();
      const record = await harness.resumeUntilTerminal();

      expect(record.state).toBe("Completed");
      expect(itemResult(record)).toMatchObject({ finalOutcome: "Resolved", finalVerificationState: "Verified" });
      expect(harness.history.count("superops.write.classification")).toBe(classificationWrites);
      expect(harness.history.count("superops.write.note")).toBe(noteWrites);
      expect(harness.history.count("superops.write.status")).toBe(statusWrites);
      expect(record.itemStates[TICKET_NUMBER].attemptCount ?? 0).toBeGreaterThanOrEqual(seededAttempts);
      expect(harness.history.events.find((event) =>
        event.kind === "checkpoint.seeded" && event.details?.stage === stage
      )).toBeDefined();
      harness.assertGlobalInvariants(record);
    }
  );
});
