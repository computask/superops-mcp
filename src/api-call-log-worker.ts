// Pure metadata projection shared by the private Tail Worker and offline tests.
const COLUMNS = [
  "call_id", "started_at", "completed_at", "duration_ms", "tenant", "endpoint_host", "endpoint_path",
  "ticket_number", "ticket_id", "item_key", "request_id", "invocation_id", "execution_trace_id",
  "tool_name", "call_index", "request_purpose", "operation_type", "operation_name", "attempt",
  "http_status", "ok", "outcome", "error_class", "graphql_code", "rate_limited", "retry_after_seconds", "worker_outcome",
  "dispatcher_request_id", "dispatcher_state", "dispatcher_error_code",
] as const;
export const INSERT_API_CALL = `INSERT OR IGNORE INTO superops_api_calls (${COLUMNS.join(",")}) VALUES (${COLUMNS.map(() => "?").join(",")})`;
type Cell = string | number | null;
type SafeRow = Record<typeof COLUMNS[number], Cell>;
export interface AuditTrace { scriptName: string | null; logs: { message: unknown[] }[]; outcome: string }
interface AuditDatabase<Statement> {
  prepare(sql: string): { bind(...values: Cell[]): Statement };
  batch(statements: Statement[]): Promise<{ success: boolean }[]>;
}
const OUTCOMES = new Set(["success", "http_error", "graphql_error", "rate_limited", "network_error", "request_timeout", "malformed_response", "internal_error"]);
const PURPOSES = new Set(["initialRead", "paginationRead", "metadataValidation", "duplicateNoteCheck", "write", "fallbackWrite", "verificationRead", "retry", "custom"]);
const WORKER_OUTCOMES = new Set(["unknown", "ok", "exception", "exceededCpu", "exceededMemory", "scriptNotFound", "canceled", "responseStreamDisconnected"]);

function token(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)
    && !/^(sk-|eyJ|Bearer)/i.test(value) ? value : null;
}
function timestamp(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) ? value : null;
}
function number(value: unknown, max = Number.MAX_SAFE_INTEGER): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? value : null;
}
function id(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length <= max && /^\d+$/.test(value) ? value : null;
}

export function rowsFromTail(events: readonly AuditTrace[]): SafeRow[] {
  const rows = new Map<string, SafeRow>();
  for (const trace of events) {
    if (trace.scriptName !== "superops-mcp") continue;
    for (const log of trace.logs) {
      // Never inspect or persist trace.event (request headers) or exceptions.
      for (const message of log.message) {
        if (typeof message !== "string" || message.length > 8192 || !message.startsWith('{"event":"superops.api_attempt_')) continue;
        let e: Record<string, unknown>;
        try { e = JSON.parse(message) as Record<string, unknown>; } catch { continue; }
        const finished = e.event === "superops.api_attempt_finished";
        if (!finished && e.event !== "superops.api_attempt_started") continue;
        if (typeof e.callId !== "string" || !/^[0-9a-f-]{36}$/.test(e.callId)) continue;
        const startedAt = timestamp(e.startedAt);
        if (!startedAt || !["api.superops.ai", "euapi.superops.ai", "superops-api-dispatcher.taskgroup.co.uk"].includes(String(e.endpointHost))) continue;
        if (rows.get(e.callId)?.completed_at) continue;
        const completedAt = finished ? timestamp(e.completedAt) : null;
        const outcome = completedAt && OUTCOMES.has(String(e.outcome)) ? String(e.outcome) : "incomplete";
        rows.set(e.callId, {
          call_id: e.callId, started_at: startedAt, completed_at: completedAt,
          duration_ms: completedAt ? number(e.durationMs) : null,
          tenant: typeof e.tenant === "string" && /^[a-z0-9-]{1,63}$/.test(e.tenant) ? e.tenant : null,
          endpoint_host: String(e.endpointHost), endpoint_path: e.endpointHost === "superops-api-dispatcher.taskgroup.co.uk" ? "/graphql" : "/msp",
          ticket_number: id(e.ticketNumber, 12),
          ticket_id: id(e.ticketId, 30) ?? (typeof e.ticketId === "string" && /^[a-f0-9-]{36}$/i.test(e.ticketId) ? e.ticketId : null),
          item_key: token(e.itemKey), request_id: token(e.requestId), invocation_id: token(e.invocationId),
          execution_trace_id: token(e.executionTraceId), tool_name: token(e.toolName),
          call_index: number(e.callIndex), request_purpose: PURPOSES.has(String(e.requestPurpose)) ? String(e.requestPurpose) : null,
          operation_type: ["query", "mutation", "subscription"].includes(String(e.operationType)) ? String(e.operationType) : null,
          operation_name: token(e.operationName), attempt: number(e.attempt, 1000) ?? 1,
          http_status: number(e.httpStatus, 599), ok: completedAt && typeof e.ok === "boolean" ? Number(e.ok) : null,
          outcome, error_class: token(e.errorClass), graphql_code: token(e.graphqlCode),
          rate_limited: e.rateLimited === true ? 1 : 0, retry_after_seconds: number(e.retryAfterSeconds),
          worker_outcome: WORKER_OUTCOMES.has(trace.outcome) ? trace.outcome : "unknown",
          dispatcher_request_id: token(e.dispatcherRequestId),
          dispatcher_state: token(e.dispatcherState),
          dispatcher_error_code: token(e.dispatcherErrorCode),
        });
      }
    }
  }
  return [...rows.values()];
}

export async function persistRows<Statement>(db: AuditDatabase<Statement>, rows: SafeRow[]): Promise<void> {
  return persistCells(db, INSERT_API_CALL, rows.map(row => COLUMNS.map(key => row[key])));
}

export const INSERT_TRIAGE_INVOCATION = "INSERT OR IGNORE INTO triage_mcp_invocations (invocation_id,completed_at,execution_trace_id,tool_name,success,duration_ms,subrequests_used,dispatcher_submissions,mutation_submissions,failure_codes_json) VALUES (?,?,?,?,?,?,?,?,?,?)";
export function invocationRowsFromTail(events: readonly AuditTrace[]): Cell[][] {
  const rows = new Map<string, Cell[]>();
  for (const trace of events) {
    if (trace.scriptName !== "superops-mcp") continue;
    for (const log of trace.logs) for (const message of log.message) {
      if (typeof message !== "string" || message.length > 16384 || !message.startsWith('{"event":"mcp.triage_execution_finished"')) continue;
      let e: Record<string, unknown>;
      try { e = JSON.parse(message) as Record<string, unknown>; } catch { continue; }
      const invocation = token(e.invocationId), at = timestamp(e.timestamp), tool = token(e.toolName);
      if (!invocation || !at || !tool || typeof e.success !== "boolean") continue;
      const codes = Array.isArray(e.failureCodes) ? e.failureCodes.slice(0,32).map(value => {
        const d = value && typeof value === "object" ? value as Record<string, unknown> : {};
        return {stage:token(d.stage),errorType:token(d.errorType),errorCode:token(d.errorCode),requestIndex:number(d.requestIndex,1000)};
      }) : [];
      rows.set(invocation, [invocation,at,token(e.executionTraceId),tool,Number(e.success),number(e.durationMs),
        number(e.subrequestsUsed,1000),number(e.dispatcherSubmissions,1000),number(e.mutationSubmissions,1000),JSON.stringify(codes)]);
    }
  }
  return [...rows.values()];
}
export async function persistInvocations<Statement>(db: AuditDatabase<Statement>, rows: Cell[][]): Promise<void> {
  return persistCells(db, INSERT_TRIAGE_INVOCATION, rows);
}
async function persistCells<Statement>(db: AuditDatabase<Statement>, sql: string, rows: Cell[][]): Promise<void> {
  // Bound each write batch; idempotent call IDs make uncertain D1 retries safe.
  for (let offset = 0; offset < rows.length; offset += 50) {
    const batch = rows.slice(offset, offset + 50);
    let persisted = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await db.batch(batch.map(row => db.prepare(sql).bind(...row)));
        if (result.some(r => !r.success)) throw new Error("D1 batch not successful");
        persisted = true;
        break;
      } catch {
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 200));
      }
    }
    if (!persisted) {
      console.error(JSON.stringify({ event: "superops.api_log_persistence_failed", rows: batch.length }));
      throw new Error("API attempt log persistence failed");
    }
  }
}
