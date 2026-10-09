import { afterEach, describe, expect, it, vi } from "vitest";
import { SuperOpsClient, runWithCredentials } from "./client.js";
import { DispatcherPendingError, reconcileCurrentDispatcherReceipt, withDispatcherOperation } from "./dispatcher.js";
import { DispatcherReadJournal, type DispatcherReadRecord, withDispatcherReadScope } from "./dispatcher-read-journal.js";
import { SuperOpsOperationLedger, runWithOperationStore } from "./operation-store.js";
import { runWithAuditContext } from "./audit.js";
import { runWithExecutionConfig, runWithExecutionContext } from "./execution.js";
import { safeSuperOpsErrorMetadata } from "./error-contract.js";
import { createMcpServer } from "./mcp-server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createRequire } from "node:module";
import { runWithTriageLeaseEnvironment } from "./triage-run-lease.js";

const START = Date.parse("2026-10-07T12:00:00.000Z");
const ID = "9714f5f6-e9c5-4e03-95b8-de82d37b7bac";
const QUERY = "query SyntheticJournalRead($id: ID!) { getTicket(ticketId: $id) { ticketId status } }";
const VARIABLES = {id: "synthetic-ticket"};
const credentials = {apiToken: "unused-synthetic", subdomain: "synthetic", dispatcher: {DISPATCHER_TOKEN: "synthetic-dispatcher"}};

class Storage {
  values = new Map<string, unknown>();
  private tail: Promise<unknown> = Promise.resolve();
  async get<T = unknown>(key: string): Promise<T | undefined> { return structuredClone(this.values.get(key)) as T | undefined; }
  async put(key: string, value: unknown) { this.values.set(key, structuredClone(value)); }
  transaction<T>(fn: (txn: Storage) => Promise<T>): Promise<T> {
    const next = this.tail.then(() => fn(this)); this.tail = next.catch(() => undefined); return next;
  }
}
function namespace() {
  const objects = new Map<string, Storage>();
  return {objects, idFromName: (name: string) => name, get(id: unknown) {
    const name = String(id), storage = objects.get(name) ?? new Storage(); objects.set(name, storage);
    return {fetch(request: Request) {
      // New object instance on every request: only durable storage survives.
      return new SuperOpsOperationLedger({storage} as unknown as ConstructorParameters<typeof SuperOpsOperationLedger>[0]).fetch(request);
    }};
  }};
}
function records(ns: ReturnType<typeof namespace>): DispatcherReadRecord[] {
  return [...ns.objects.values()].flatMap(s => [...s.values.entries()].filter(([k]) => k !== "dispatcher-read:slot-count").map(([,v]) => v as DispatcherReadRecord));
}
function pending(n = 1, responseStatus = 200, deadline = START + 900_000) {
  return Response.json({requestId: ID, source: "superops-mcp", status: "retry_wait", httpStatus: 200, errorClassification: "RATE_LIMITED",
    nextRetryAt: new Date(Date.now() + 60_000).toISOString(), readRecovery: {startedAt: new Date(START).toISOString(), deadlineAt: new Date(deadline).toISOString(), throttleCount: n}},
    {status: responseStatus, headers: {"X-Dispatcher-Request-Id": ID, "X-Dispatcher-Status": "retry_wait", "Retry-After": "60"}});
}
function success(id = ID) {
  return Response.json({requestId: id, source: "superops-mcp", status: "succeeded", httpStatus: 200, response: {data: {getTicket: {ticketId: "synthetic-ticket", status: "New Calls"}}}},
    {headers: {"X-Dispatcher-Request-Id": id, "X-Dispatcher-Status": "succeeded"}});
}
function call(ns: ReturnType<typeof namespace>, owner = "synthetic-reader", automatic = true, workflow = "synthetic-triage-read", fn?: () => Promise<unknown>) {
  return runWithAuditContext({requestId: crypto.randomUUID(), user: owner, mcpEnabled: true, writeToolsEnabled: true, customMutationEnabled: false, scriptExecutionEnabled: false},
    () => runWithExecutionConfig({SUPEROPS_EXECUTION_REQUEST_TIMEOUT_MS: "10", SUPEROPS_EXECUTION_MAX_DURATION_MS: "20000", SUPEROPS_EXECUTION_MAX_READ_RETRY_ATTEMPTS: "1", SUPEROPS_EXECUTION_CALL_AUDIT_ENABLED: "false"},
      () => runWithOperationStore({SUPEROPS_OPERATION_LEDGER: ns}, () => runWithExecutionContext("synthetic_read", () =>
        withDispatcherReadScope({workflow, automatic}, () => runWithCredentials(credentials, () => fn ? fn() : new SuperOpsClient(credentials).query(QUERY, VARIABLES)))))));
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("durable dispatcher read receipts", () => {
  it.each([194_012, 91_207])("hands a partial first query through the real Reporter contract and resumes after %i ms", async delay => {
    vi.useFakeTimers(); vi.setSystemTime(START);
    const ns = namespace(), methods: string[] = [], observations: Record<string, unknown>[] = [];
    const triggerId = "triage-9-00000000-0000-4000-8000-000000000009";
    const args = {createdFrom: new Date(START - 60_000).toISOString(), createdTo: new Date(START + 60_000).toISOString(),
      status: ["New Calls"], sources: ["EMAIL"], fieldProfile: "minimal", maxPages: 1, maxRecords: 50};
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      methods.push(init?.method ?? "GET");
      if (init?.method === "POST") {
        const payload = JSON.parse(String(init.body));
        expect(payload.variables.input.pageSize).toBe(100);
        return Response.json({requestId: ID, source: "superops-mcp", status: "queued",
          nextRetryAt: new Date(START + delay).toISOString()},
          {status: 202, headers: {"X-Dispatcher-Request-Id": ID, "X-Dispatcher-Status": "queued"}});
      }
      expect(url.endsWith(`/v1/requests/${ID}`)).toBe(true);
      return Response.json({requestId: ID, source: "superops-mcp", status: "succeeded", httpStatus: 200,
        response: {data: {getTicketList: {tickets: [{ticketId: "900000000000001", displayId: "90101", status: "New Calls",
          createdTime: new Date(START).toISOString(), updatedTime: new Date(START).toISOString(), source: "EMAIL"}],
          listInfo: {page: 1, pageSize: 100, hasMore: false, totalCount: 1}}}}});
    }));
    const env = {TRIAGE_RUN_WRITE_GUARD_ENABLED: "true", TRIAGE_RUN_COORDINATOR: {
      idFromName: (name: string) => name, get: () => ({fetch: async (request: Request) => {
        observations.push(await request.json() as Record<string, unknown>); return Response.json({observed: true});
      }}),
    }};
    async function rpc(attempt: number) {
      const server = createMcpServer(), client = new Client({name: "pending-query-regression", version: "1"});
      const [a,b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
      try { return await runWithTriageLeaseEnvironment(env, () => call(ns, "synthetic-reader", true, "outer", () =>
        client.callTool({name: "superops_tickets_query", arguments: {...args, triageCapture: {triggerId, attempt}}})));
      } finally {await client.close(); await server.close();}
    }
    const first = await rpc(1) as {isError?: boolean; structuredContent?: unknown; content: Array<{text: string}>};
    expect(first.isError).toBe(true);
    const primary = JSON.parse(first.content[0].text);
    expect(primary).toMatchObject({records: [], pagination: {complete: false, truncated: true}, errorClass: "DispatcherReadPending",
      readRecoveryDurable: true, dispatcherPending: true, resumeSameRequest: true, dispatcherRequestId: ID, rateLimited: false});
    expect(first.structuredContent).toMatchObject({dispatcherRequestId: ID, retryScope: "read"});
    expect(primary.mcpExecution.failureDiagnostics.length).toBeGreaterThan(0);
    expect(observations[0]).toMatchObject({triggerId, attempt: 1, pendingRead: {requestId: ID, deadlineAt: new Date(START + 900_000).toISOString()}});
    const source = readFileSync("workers/support-triage-trigger/src/index.js", "utf8");
    const executable = source.replace(/\nexport \{[\s\S]*$/, "");
    const reporter = runInNewContext(executable + ";({parseSafeMcpExecution,toolDefinition})", {crypto, Request, Response, URL, Date, TextEncoder, TextDecoder, console});
    const accepted = reporter.parseSafeMcpExecution(primary.mcpExecution);
    expect(accepted).not.toBeNull();
    expect(JSON.parse(JSON.stringify(accepted))).toEqual(primary.mcpExecution);
    const require = createRequire(import.meta.url), Ajv = require("ajv");
    const validate = new Ajv({strict: false, validateFormats: false}).compile(reporter.toolDefinition().inputSchema);
    const callback = {triggerId, attempt: 1, status: "retryable_read_pending", metadata: {
      failureStage: "bounded_query", ticketsConsidered: 0, ticketsCompleted: 0, ticketsDeferred: 0, mcpExecution: primary.mcpExecution}};
    expect(validate(callback), JSON.stringify(validate.errors)).toBe(true);
    expect(JSON.stringify(first)).not.toContain(records(ns)[0].idempotencyKey);
    vi.advanceTimersByTime(delay + 1000);
    const second = await rpc(2) as {isError?: boolean; content: Array<{text: string}>};
    expect(second.isError).not.toBe(true);
    expect(JSON.parse(second.content[0].text)).toMatchObject({records: [{displayId: "90101"}], pagination: {complete: true}});
    expect(methods).toEqual(["POST", "GET"]);
    expect(observations[1]).toMatchObject({triggerId, attempt: 2, ticketNumbers: ["90101"]});
    expect(records(ns)[0]).toMatchObject({generation: 1, requestId: ID, delivered: true});
  });
  it("resumes one receipt through six throttles and fresh execution/object instances without another POST", async () => {
    vi.useFakeTimers(); vi.setSystemTime(START);
    const ns = namespace(), network: Array<{method: string; body?: string; key: string; url: string}> = [];
    let ready = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      network.push({url, method: init?.method ?? "GET", body: init?.body as string | undefined, key: new Headers(init?.headers).get("Idempotency-Key") ?? ""});
      expect(records(ns)).toHaveLength(1); // Identity exists before network I/O.
      return ready ? success() : pending(network.length, init?.method === "POST" ? 202 : 200);
    }));
    for (let n = 0; n < 6; n++) {
      await expect(call(ns)).rejects.toMatchObject({requestId: ID, readRecovery: {durable: true, deadlineAt: new Date(START + 900_000).toISOString()}});
      const row = records(ns)[0]; expect(row.requestId).toBe(ID); expect(row.delivered).toBe(false);
      vi.advanceTimersByTime(61_000);
    }
    ready = true;
    await expect(call(ns)).resolves.toMatchObject({getTicket: {ticketId: "synthetic-ticket"}});
    expect(network.filter(r => r.method === "POST")).toHaveLength(1);
    expect(network.slice(1).every(r => r.url.endsWith(`/v1/requests/${ID}`) && r.body === undefined)).toBe(true);
    expect(new Set(network.map(r => r.key)).size).toBe(1);
    expect(network[0].body).toBe(JSON.stringify({query: QUERY, variables: VARIABLES}));
    expect(records(ns)[0]).toMatchObject({state: "succeeded", delivered: true, generation: 1});
    expect(JSON.stringify(records(ns))).not.toContain("getTicket(");
    expect(JSON.stringify(records(ns))).not.toContain("synthetic-ticket");
  });

  it("waits until the saved eligibility time across repeated tool calls without issuing polls or replacement reads", async () => {
    vi.useFakeTimers(); vi.setSystemTime(START); const ns = namespace();
    const fetch = vi.fn(async () => pending(1, 202)); vi.stubGlobal("fetch", fetch);
    await expect(call(ns)).rejects.toBeInstanceOf(DispatcherPendingError);
    for (let n = 0; n < 6; n++) await expect(call(ns)).rejects.toMatchObject({requestId: ID, retryAfter: 60, state: "retry_wait"});
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("recovers a lost acknowledgement using the pre-persisted original key and exact payload", async () => {
    vi.useFakeTimers(); vi.setSystemTime(START); const ns = namespace();
    const submissions: Array<{key: string; body: string}> = []; let lost = true;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        submissions.push({key: new Headers(init.headers).get("Idempotency-Key")!, body: String(init.body)});
        if (lost) {lost = false; throw new Error("Synthetic acknowledgement lost");}
        return pending(1, 202);
      }
      return success();
    }));
    await expect(call(ns)).rejects.toMatchObject({requestId: undefined});
    await expect(call(ns)).rejects.toMatchObject({requestId: ID});
    expect(submissions).toHaveLength(2); expect(submissions[1]).toEqual(submissions[0]);
    vi.advanceTimersByTime(61_000);
    await expect(call(ns)).resolves.toHaveProperty("getTicket");
    expect(submissions).toHaveLength(2);
  });

  it("persists a 504 header receipt even when its response body is unreadable", async () => {
    vi.useFakeTimers(); vi.setSystemTime(START); const ns = namespace(); let posts = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") { posts++; return new Response("{invalid synthetic json", {status: 504, headers: {"X-Dispatcher-Request-Id": ID}}); }
      return success();
    }));
    await expect(call(ns)).rejects.toMatchObject({requestId: ID});
    await expect(call(ns)).resolves.toHaveProperty("getTicket");
    expect(posts).toBe(1);
  });

  it("keeps automatic terminal failures on their original receipt and links deliberate manual renewal", async () => {
    vi.useFakeTimers(); vi.setSystemTime(START); const ns = namespace(); let posts = 0, fail = true;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {posts++; return pending(1, 202);}
      return fail ? Response.json({requestId: ID, source: "superops-mcp", status: "failed", httpStatus: 200, errorClassification: "READ_RECOVERY_EXPIRED"}) : success();
    }));
    await expect(call(ns)).rejects.toMatchObject({requestId: ID}); vi.advanceTimersByTime(61_000);
    for (let n = 0; n < 2; n++) await expect(call(ns)).rejects.toMatchObject({requestId: ID, state: "failed", errorClassification: "READ_RECOVERY_EXPIRED"});
    expect(posts).toBe(1); expect(records(ns)[0].generation).toBe(1);
    await expect(call(ns, "synthetic-reader", false)).rejects.toMatchObject({requestId: ID});
    expect(posts).toBe(2); expect(records(ns)[0]).toMatchObject({generation: 2, previousRequestId: ID, history: [{requestId: ID, state: "failed"}]});
    fail = false;
  });

  it("isolates owners, payloads and workflow identities and refuses an inconsistent receipt", async () => {
    vi.useFakeTimers(); vi.setSystemTime(START); const ns = namespace(); let wrong = false;
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => init?.method === "POST" ? pending(1, 202) : success(wrong ? "other-receipt" : ID));
    vi.stubGlobal("fetch", fetch);
    await expect(call(ns)).rejects.toMatchObject({requestId: ID});
    await expect(call(ns, "synthetic-other-owner")).rejects.toMatchObject({requestId: ID});
    await expect(call(ns, "synthetic-reader", true, "synthetic-other-workflow")).rejects.toMatchObject({requestId: ID});
    expect(records(ns)).toHaveLength(3);
    vi.advanceTimersByTime(61_000); wrong = true;
    await expect(call(ns)).rejects.toMatchObject({state: "invalid_receipt"});
    expect(records(ns).every(r => r.requestId === ID)).toBe(true);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(3);
  });

  it("does not journal mutations or change their original deterministic identity and receipt checkpoint", async () => {
    vi.useFakeTimers(); vi.setSystemTime(START); const ns = namespace(), saved: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({data: {updateTicket: {ticketId: "synthetic-ticket"}}}, {headers: {"X-Dispatcher-Status": "succeeded", "X-Dispatcher-Request-Id": ID}})));
    await expect(call(ns, "synthetic-reader", true, "synthetic-read-scope", () => withDispatcherOperation("synthetic-write-operation", "synthetic-item", () =>
      new SuperOpsClient(credentials).query("mutation { updateTicket(input: {ticketId: \"synthetic-ticket\"}) { ticketId } }"), async r => {saved.push(r);}))).resolves.toHaveProperty("updateTicket");
    expect(ns.objects.size).toBe(0); expect(saved).toHaveLength(1);
  });

  it("fails before dispatch when the journal is unavailable and bounds per-shard records", async () => {
    vi.useFakeTimers(); vi.setSystemTime(START); const ns = namespace();
    ns.get = () => ({fetch: async () => Response.json({}, {status: 503})}); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(call(ns)).rejects.toMatchObject({name: "DispatcherReadJournalError"}); expect(fetch).not.toHaveBeenCalled();
    const storage = new Storage(), journal = new DispatcherReadJournal(storage);
    for (let n = 0; n < 257; n++) {
      const response = await journal.fetch(new Request("https://ledger.internal/dispatcher-reads/open", {method: "POST", body: JSON.stringify({
        ownerHash: "12345678", workflowHash: "a".repeat(64), payloadHash: n.toString(16).padStart(64, "0"), invocationId: `synthetic-${n}`, automatic: true})}));
      expect(response.status).toBe(n < 256 ? 200 : 409);
    }
    expect(storage.values.size).toBe(257);
  });

  it("keeps the original ambiguous mutation receipt while its durable read is used for settlement", async () => {
    vi.useFakeTimers(); vi.setSystemTime(START);
    const ns = namespace(), saved: unknown[] = [], methods: string[] = [];
    const mutationId = "12859cd6-c31c-434f-8cb5-29309c77c6a5", fingerprint = "a".repeat(64);
    const base = {requestId: mutationId, source: "superops-mcp", type: "mutation", status: "uncertain", fingerprint, attemptCount: 1};
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      methods.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/verify")) {
        const body = String(init?.body), input = JSON.parse(body);
        const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)))].map(b => b.toString(16).padStart(2,"0")).join("");
        return Response.json({...base, uncertain: true, verification: {schemaVersion: 1, requestId: mutationId,
          mutationFingerprint: fingerprint, attemptCount: 1, evidenceHash: hash, outcome: "unknown", reasonCode: "stale_or_unavailable_evidence",
          partial: false, checkedFields: [], readRequestIds: input.readRequestIds, replayAllowed: false, verifiedAt: new Date(START).toISOString()}});
      }
      if (url.endsWith(`/v1/requests/${mutationId}`)) return Response.json(base);
      if (String(init?.body).includes("mutation")) return Response.json(base, {status: 202,
        headers: {"X-Dispatcher-Request-Id": mutationId, "X-Dispatcher-Uncertain": "true"}});
      return Response.json({data: {getTicket: {ticketId: "synthetic-ticket", status: "Awaiting Engineer"}}},
        {headers: {"X-Dispatcher-Request-Id": ID, "X-Dispatcher-Status": "succeeded"}});
    }));
    const proof = await call(ns, "synthetic-reader", true, "synthetic-settlement", () => withDispatcherOperation("synthetic-operation", "synthetic-item", async () => {
      const client = new SuperOpsClient(credentials);
      await expect(client.query("mutation { updateTicket(input: {ticketId: \"synthetic-ticket\"}) { ticketId } }")).rejects.toMatchObject({requestId: mutationId});
      await client.query(QUERY, VARIABLES);
      return reconcileCurrentDispatcherReceipt();
    }, async receipt => {saved.push(receipt);}));
    expect(proof).toMatchObject({requestId: mutationId, readRequestIds: [ID], replayAllowed: false});
    expect(saved.at(-1)).toMatchObject({requestId: mutationId, state: "uncertain"});
    expect(records(ns)).toHaveLength(1);
    expect(records(ns)[0]).toMatchObject({requestId: ID, delivered: true});
    expect(methods.filter(m => m.endsWith("/graphql"))).toHaveLength(2);
  });

  it("recovers an earlier operation read but uses a new authoritative read for the resumed pre-write stale check", async () => {
    vi.useFakeTimers(); vi.setSystemTime(START); const ns = namespace(), methods: string[] = [], keys: string[] = [];
    const freshId = "309d3071-9a3f-477b-86a7-d88e59e0e2b0";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      methods.push(init?.method ?? "GET"); keys.push(String((init?.headers as Record<string,string>)?.["Idempotency-Key"] ?? ""));
      if (methods.length === 1) return pending(1,202);
      if (init?.method === "GET") return Response.json({requestId: ID, source: "superops-mcp", status: "succeeded", httpStatus: 200,
        response: {data: {getTicket: {ticketId: "synthetic-ticket", updatedTime: "synthetic-original-snapshot"}}}});
      return Response.json({data: {getTicket: {ticketId: "synthetic-ticket", updatedTime: "synthetic-newer-change"}}},
        {headers: {"X-Dispatcher-Request-Id": freshId, "X-Dispatcher-Status": "succeeded"}});
    }));
    const operationRead = () => call(ns, "synthetic-reader", true, "outer", () => withDispatcherOperation("synthetic-operation", "synthetic-item", () => new SuperOpsClient(credentials).query(QUERY,VARIABLES)));
    await expect(operationRead()).rejects.toMatchObject({requestId: ID});
    vi.advanceTimersByTime(61_000);
    await expect(operationRead()).resolves.toMatchObject({getTicket: {updatedTime: "synthetic-newer-change"}});
    expect(methods).toEqual(["POST","GET","POST"]);
    expect(keys[0]).toBe(keys[1]); expect(keys[2]).not.toBe(keys[0]);
    expect(records(ns)[0]).toMatchObject({generation: 2, previousRequestId: ID, requestId: freshId, delivered: true});
  });

  it("exposes durable same-receipt pending and terminal states without granting write replay", async () => {
    const error = new DispatcherPendingError(ID, "synthetic-private-key", "retry_wait", 60, 200, "RATE_LIMITED");
    error.readRecovery = {durable: true, nextEligibleAt: new Date(START + 60_000).toISOString(), deadlineAt: new Date(START + 900_000).toISOString()};
    expect(safeSuperOpsErrorMetadata(error, true)).toMatchObject({dispatcherRequestId: ID, dispatcherPending: true, dispatcherTerminal: false,
      resumeSameRequest: true, retryScope: "read", retryable: true, readRecoveryDurable: true});
    expect(JSON.stringify(safeSuperOpsErrorMetadata(error, true))).not.toContain("private-key");
    expect(safeSuperOpsErrorMetadata(error, false)).toMatchObject({retryable: false, retryScope: "none"});
    const terminal = new DispatcherPendingError(ID, "synthetic-private-key", "failed", undefined, 200, "READ_RECOVERY_EXPIRED");
    terminal.readRecovery = {durable: true};
    expect(safeSuperOpsErrorMetadata(terminal, true)).toMatchObject({dispatcherTerminal: true, dispatcherPending: false, retryable: false, resumeSameRequest: false});
    const invalid = new DispatcherPendingError(ID, "synthetic-private-key", "invalid_status_identity");
    invalid.readRecovery = {durable: true};
    expect(safeSuperOpsErrorMetadata(invalid, true)).toMatchObject({dispatcherTerminal: false, dispatcherPending: false, retryable: false, resumeSameRequest: false});
    expect(safeSuperOpsErrorMetadata(new DispatcherPendingError(ID, "synthetic-private-key", "queued"), true)).toMatchObject({retryable: false});
    const expiredPending = new DispatcherPendingError(ID,"synthetic-private-key","queued",undefined,undefined,"READ_RECOVERY_EXPIRED");
    expiredPending.readRecovery={durable:true,deadlineAt:new Date(START+900_000).toISOString()};
    expect(safeSuperOpsErrorMetadata(expiredPending,true)).toMatchObject({errorClass:"DispatcherReadRecoveryExpired",
      dispatcherPending:true,dispatcherTerminal:false,retryable:false,retryScope:"none",resumeSameRequest:true});
  });

  it("keeps a failed synchronous acknowledgement terminal on the first call and later automatic execution", async () => {
    vi.useFakeTimers(); vi.setSystemTime(START); const ns = namespace();
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => init?.method === "POST"
      ? Response.json({errors: [{message: "synthetic rejected read"}]}, {status: 400,
        headers: {"X-Dispatcher-Request-Id": ID, "X-Dispatcher-Status": "failed"}})
      : Response.json({requestId: ID, source: "superops-mcp", status: "failed", httpStatus: 400, errorClassification: "UPSTREAM_REJECTED"}));
    vi.stubGlobal("fetch", fetch);
    for (let n = 0; n < 2; n++) await expect(call(ns)).rejects.toMatchObject({state: "failed", requestId: ID, readRecovery: {durable: true}});
    expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual(["POST", "GET"]);
    expect(records(ns)[0].generation).toBe(1);
  });

  it("atomically reuses an open identity, refuses a changed deadline and rejects a stale generation checkpoint", async () => {
    vi.useFakeTimers(); vi.setSystemTime(START);
    const storage = new Storage(), journal = new DispatcherReadJournal(storage);
    const identity = {ownerHash: "12345678", workflowHash: "a".repeat(64), payloadHash: "b".repeat(64), invocationId: "synthetic-1", automatic: true};
    const rpc = (action: string, body: unknown) => journal.fetch(new Request(`https://ledger.internal/dispatcher-reads/${action}`, {method: "POST", body: JSON.stringify(body)}));
    const [first, second] = await Promise.all([rpc("open", identity), rpc("open", identity)]);
    const row = await first.json() as DispatcherReadRecord;
    expect(await second.json()).toEqual(row);
    const checkpoint = (state: string, deadline = new Date(START + 900_000).toISOString()) => rpc("checkpoint", {...identity, generation: row.generation,
      idempotencyKey: row.idempotencyKey, receipt: {requestId: ID, idempotencyKey: row.idempotencyKey, state, recoveryDeadlineAt: deadline,
        rawPayload: "synthetic-content-must-be-discarded"}});
    expect((await checkpoint("retry_wait")).status).toBe(200);
    expect((await checkpoint("retry_wait", new Date(START + 1_800_000).toISOString())).status).toBe(409);
    expect((await checkpoint("failed")).status).toBe(200);
    const renewed = await (await rpc("open", {...identity, invocationId: "synthetic-2", automatic: false})).json() as DispatcherReadRecord;
    expect(renewed).toMatchObject({generation: 2, previousRequestId: ID});
    expect((await checkpoint("succeeded")).status).toBe(409);
    expect(JSON.stringify([...storage.values.values()])).not.toContain("synthetic-content-must-be-discarded");
  });

  it("checks expiry on the original receipt even when an upstream cooldown outlives the recovery deadline", async () => {
    vi.useFakeTimers(); vi.setSystemTime(START); const ns = namespace(); let polls = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const value = await pending(1, 202).json() as Record<string, unknown>; value.nextRetryAt = new Date(START + 86_400_000).toISOString();
        return Response.json(value, {status: 202, headers: {"X-Dispatcher-Request-Id": ID, "Retry-After": "86400"}});
      }
      polls++;
      return Response.json({requestId: ID, source: "superops-mcp", status: "failed", errorClassification: "READ_RECOVERY_EXPIRED"});
    }));
    await expect(call(ns)).rejects.toMatchObject({requestId: ID});
    vi.advanceTimersByTime(900_001);
    await expect(call(ns)).rejects.toMatchObject({requestId: ID, state: "failed"});
    expect(polls).toBe(1);
  });

  it("automatically resumes a correlated Agent read through fresh MCP servers and changed dispatch attempts", async () => {
    vi.useFakeTimers(); vi.setSystemTime(START); const ns = namespace(), methods: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      methods.push(init?.method ?? "GET"); return init?.method === "POST" ? pending(1, 202) : success();
    }));
    async function rpc(attempt: number) {
      const server = createMcpServer(), client = new Client({name: "synthetic-agent", version: "1"});
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport); await client.connect(clientTransport);
      try { return await call(ns, "synthetic-reader", true, "outer-test-scope", () => client.callTool({
        name: "superops_custom_query", arguments: {query: QUERY, variables: VARIABLES,
          triageCapture: {triggerId: "triage-42-c00471b5-49f5-416d-bbda-62c1bce033c9", attempt}},
      })); } finally {await client.close(); await server.close();}
    }
    const first = await rpc(1);
    expect(first).toMatchObject({isError: true});
    expect(JSON.stringify(first)).toContain('"resumeSameRequest":true');
    expect(JSON.stringify(first)).not.toContain(records(ns)[0].idempotencyKey);
    vi.advanceTimersByTime(61_000);
    const second = await rpc(2);
    expect((second as {isError?: boolean}).isError).not.toBe(true);
    expect(methods).toEqual(["POST", "GET"]);
    expect(records(ns)[0]).toMatchObject({requestId: ID, generation: 1, delivered: true});
  });
});
