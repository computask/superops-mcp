import { getAuditContext } from "./audit.js";
import { classifyGraphQLRequest, getExecutionConfig, getExecutionState, type SubrequestRecord } from "./execution.js";

// Only this explicit metadata projection leaves the client. Never serialize
// credentials, variables, query text, responses or error messages to the log.
export function beginApiAttempt(
  query: string,
  variables: Record<string, unknown> | undefined,
  tenant: string,
  endpoint: string,
  attempt: number,
  callIndex: number
) {
  if (!getExecutionConfig().callAuditEnabled) return undefined;
  const state = getExecutionState();
  const operation = classifyGraphQLRequest(query, attempt - 1);
  const input = object(variables?.input);
  const condition = object(input?.condition);
  const row = {
    callId: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
    requestId: token(getAuditContext().requestId),
    invocationId: token(state?.invocationId),
    executionTraceId: token(state?.operationId),
    toolName: token(state?.toolName),
    callIndex,
    tenant: /^[a-z0-9-]{1,63}$/.test(tenant) ? tenant : undefined,
    endpointHost: new URL(endpoint).hostname,
    endpointPath: "/msp",
    requestPurpose: operation.type,
    operationType: token(operation.operationType),
    operationName: token(operation.operationName),
    itemKey: token(state?.itemKey),
    ticketId: identifier(input?.ticketId ?? variables?.ticketId),
    ticketNumber: numberId(input?.displayId ?? variables?.displayId ?? variables?.ticketNumber
      ?? (condition?.attribute === "displayId" && condition?.operator === "is" ? condition.value : undefined)),
    attempt,
  };
  console.log(JSON.stringify({ event: "superops.api_attempt_started", ...row }));
  return row;
}

export function endApiAttempt(
  started: ReturnType<typeof beginApiAttempt>,
  record: SubrequestRecord | undefined,
  ok: boolean,
  retryAfterSeconds?: number,
  data?: unknown
): void {
  if (!started) return;
  const completedAt = new Date().toISOString();
  const ticket = object(object(data)?.getTicket);
  console.log(JSON.stringify({
    event: "superops.api_attempt_finished",
    ...started,
    completedAt,
    durationMs: Date.parse(completedAt) - Date.parse(started.startedAt),
    ticketId: identifier(ticket?.ticketId) ?? started.ticketId,
    ticketNumber: numberId(ticket?.displayId) ?? started.ticketNumber,
    ok,
    httpStatus: record?.httpStatus,
    outcome: record?.outcome ?? (ok ? "success" : "internal_error"),
    errorClass: token(record?.errorClass),
    graphqlCode: token(record?.graphqlCode),
    rateLimited: record?.rateLimited === true,
    retryAfterSeconds: typeof retryAfterSeconds === "number" && Number.isFinite(retryAfterSeconds)
      && retryAfterSeconds >= 0 ? retryAfterSeconds : undefined,
  }));
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function token(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)
    && !/^(sk-|eyJ|Bearer)/i.test(value) ? value : undefined;
}
function numberId(value: unknown): string | undefined {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  return typeof text === "string" && /^\d{1,12}$/.test(text) ? text : undefined;
}
function identifier(value: unknown): string | undefined {
  return typeof value === "string" && /^(?:\d{1,30}|[a-f0-9-]{36})$/i.test(value) ? value : undefined;
}
