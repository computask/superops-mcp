import { afterEach, describe, expect, it, vi } from "vitest";
import { SuperOpsClient } from "./client.js";
import { runWithExecutionConfig, runWithExecutionContext } from "./execution.js";
import { rowsFromTail, persistRows } from "./api-call-log-worker.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

function capture() {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation(value => { lines.push(String(value)); });
  return lines;
}
function trace(lines: string[], outcome = "ok") {
  return [{ scriptName: "superops-mcp", outcome, logs: lines.map(line => ({ message: [line], level: "log", timestamp: Date.now() })) }];
}
const client = () => new SuperOpsClient({ apiToken: "secret-token-never-log", subdomain: "computaskltd" });
const response = (status = 200) => new Response(JSON.stringify({ data: { getTicket: { ticketId: "1234567890", displayId: "62521", subject: "private-content-never-log" } } }), { status });

describe("persistent API attempt metadata", () => {
  it("captures exact UTC times, IDs and safe ticket mapping without an execution context", async () => {
    const lines = capture();
    const now = Date.parse("2026-09-18T10:00:00.123Z");
    vi.useFakeTimers(); vi.setSystemTime(now);
    vi.stubGlobal("fetch", vi.fn(async () => { vi.setSystemTime(now + 217); return response(); }));
    await client().query("query getTicket { getTicket { ticketId displayId } }", { input: { ticketId: "1234567890" }, authorization: "secret-input-never-log" });
    const rows = rowsFromTail(trace(lines));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ started_at: "2026-09-18T10:00:00.123Z", completed_at: "2026-09-18T10:00:00.340Z", duration_ms: 217, ticket_number: "62521", ticket_id: "1234567890", http_status: 200, ok: 1, attempt: 1, tenant: "computaskltd" });
    expect(lines.join()).not.toMatch(/secret-token-never-log|secret-input-never-log|private-content-never-log|Authorization|subject/);
  });

  it("preserves a long Retry-After for the durable adapter instead of re-hitting upstream", async () => {
    const lines = capture();
    const fetcher = vi.fn(async () => new Response("private-error-never-log", { status: 429, headers: { "Retry-After": "60" } }));
    vi.stubGlobal("fetch", fetcher);
    await expect(runWithExecutionConfig({ SUPEROPS_EXECUTION_MAX_SINGLE_DELAY_MS: "1" }, () => runWithExecutionContext("superops_tickets_get", () => client().query("query getTicket { getTicket { ticketId } }")))).rejects.toThrow();
    const rows = rowsFromTail(trace(lines));
    expect(rows).toHaveLength(1);
    expect(new Set(rows.map(r => r.call_id)).size).toBe(1);
    expect(rows.map(r => r.attempt)).toEqual([1]);
    expect(rows[0]).toMatchObject({ outcome: "rate_limited", http_status: 429, retry_after_seconds: 60, rate_limited: 1, ok: 0, tool_name: "superops_tickets_get" });
    expect(lines.join()).not.toContain("private-error-never-log");
  });

  it.each([
    ["dispatcher_error", () => Promise.reject(new Error("credential-never-log")), null],
    ["request_timeout", () => Promise.reject(new DOMException("credential-never-log", "AbortError")), null],
    ["http_error", () => Promise.resolve(response(503)), 503],
    ["malformed_response", () => Promise.resolve(new Response("not-json-private", { status: 200 })), 200],
    ["rate_limited", () => Promise.resolve(new Response(JSON.stringify({ errors: [{ message: "private-error", extensions: { code: "rate_limit_exceeded", retryAfter: 42 } }] }))), 200],
    ["graphql_error", () => Promise.resolve(new Response(JSON.stringify({ errors: [{ message: "private-error", extensions: { code: "BAD_USER_INPUT" } }] }))), 200],
  ] as const)("records %s, including failed mutations, without retrying writes", async (outcome, factory, status) => {
    const lines = capture(); const fetcher = vi.fn(factory); vi.stubGlobal("fetch", fetcher);
    await expect(client().mutate("mutation updateTicket { updateTicket { ticketId } }", { input: { ticketId: "1234567890", note: "private-note-never-log" } })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(rowsFromTail(trace(lines))[0]).toMatchObject({ outcome, http_status: status, ok: 0, operation_type: "mutation" });
    expect(lines.join()).not.toMatch(/credential-never-log|private-note-never-log|private-error|not-json-private/);
  });

  it("records a started attempt as incomplete when a Worker terminates before finishing", async () => {
    const lines = capture(); vi.stubGlobal("fetch", vi.fn(async () => response()));
    await client().query("query getTicket { getTicket { ticketId } }");
    const starts = lines.filter(line => line.includes('"event":"superops.api_attempt_started"'));
    expect(rowsFromTail(trace(starts, "exceededCpu"))[0]).toMatchObject({ outcome: "incomplete", ok: null, completed_at: null, worker_outcome: "exceededCpu" });
  });

  it("does not invent a call when the execution budget prevents dispatch", async () => {
    const lines = capture(); const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(runWithExecutionConfig({ SUPEROPS_EXECUTION_SUBREQUEST_BUDGET: "1", SUPEROPS_EXECUTION_SUBREQUEST_SAFETY_MARGIN: "1" }, () => runWithExecutionContext("superops_tickets_get", () => client().query("query getTicket { getTicket { ticketId } }")))).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled(); expect(rowsFromTail(trace(lines))).toEqual([]);
  });
  it("persists receipt identity and pending state when the caller stops waiting", async () => {
    const lines=capture();
    vi.stubGlobal("fetch",vi.fn(async()=>Response.json({requestId:"receipt-a",status:"retry_wait"},{status:202,headers:{"Retry-After":"60"}})));
    await expect(runWithExecutionContext("superops_tickets_field_options",()=>client().query("query Fields { getFields { fieldId } }"))).rejects.toThrow();
    expect(rowsFromTail(trace(lines))[0]).toMatchObject({dispatcher_request_id:"receipt-a",dispatcher_state:"retry_wait",dispatcher_error_code:"pending",http_status:null,outcome:"dispatcher_error",error_class:"Dispatcher_pending"});
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("honours the existing audit switch", async () => {
    const lines = capture(); vi.stubGlobal("fetch", vi.fn(async () => response()));
    await runWithExecutionConfig({ SUPEROPS_EXECUTION_CALL_AUDIT_ENABLED: "false" }, () => client().query("query Test { ok }"));
    expect(rowsFromTail(trace(lines))).toEqual([]);
  });
  it("does not mislabel a pending GraphQL rate limit as network failure",async()=>{
    const lines=capture();
    vi.stubGlobal("fetch",vi.fn(async()=>Response.json({requestId:"receipt-throttle",status:"retry_wait",httpStatus:200,errorClassification:"RATE_LIMITED"},{status:202,headers:{"Retry-After":"60"}})));
    await expect(runWithExecutionContext("superops_tickets_field_options",()=>client().query("query Fields { getFields { fieldId } }"))).rejects.toMatchObject({rateLimited:true});
    expect(rowsFromTail(trace(lines))[0]).toMatchObject({dispatcher_state:"retry_wait",dispatcher_error_code:"RATE_LIMITED",http_status:200,outcome:"rate_limited",rate_limited:1,retry_after_seconds:60});
    const call = lines.map(line => { try { return JSON.parse(line); } catch { return undefined; } })
      .find(event => event?.event === "superops.api_call");
    expect(call).toMatchObject({dispatcherHttpStatus:202,upstreamHttpStatus:200});
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("ignores unrelated and raw logs and accepts only allowlisted columns", async () => {
    const lines = capture(); vi.stubGlobal("fetch", vi.fn(async () => response()));
    await client().query("query Test { ok }");
    const complete = JSON.parse(lines.find(l => l.includes('"event":"superops.api_attempt_finished"'))!);
    complete.headers = { Authorization: "never-log" }; complete.response = "customer-content";
    const rows = rowsFromTail(trace([JSON.stringify(complete), "raw-customer-content", '{"event":"superops.api_call","provider":"internal"}']));
    expect(rows).toHaveLength(1); expect(JSON.stringify(rows)).not.toMatch(/Authorization|customer-content|never-log/);
    expect(rowsFromTail(trace([JSON.stringify(complete)]).map(t => ({ ...t, scriptName: "unrelated" })))).toEqual([]);
  });

  it("uses idempotent bounded database batches", async () => {
    const lines = capture(); vi.stubGlobal("fetch", vi.fn(async () => response()));
    await client().query("query Test { ok }");
    const rows = rowsFromTail(trace(lines));
    const bind = vi.fn(); const prepare = vi.fn(() => ({ bind }));
    const batch = vi.fn(async (_statements: unknown[]) => [{ success: true }]);
    await persistRows({ prepare, batch }, Array.from({ length: 101 }, () => rows[0]));
    expect(batch.mock.calls.map(call => call[0].length)).toEqual([50, 50, 1]);
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("INSERT OR IGNORE"));
  });
});
