import {
  getExecutionConfig,
  hasExecutionBudgetFor,
  recordSubrequestFinish,
  recordTypedSubrequestStart,
} from "./execution.js";

const SAFE_RECEIPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_DISPATCHER_STATES = new Set(["queued", "running", "retry_wait", "succeeded", "failed", "cancelled", "uncertain"]);
const SAFE_RESPONSE_STATES = new Set(["no_response", "unparseable", "invalid_shape", "missing_data", "null_data", "data", "partial_data", "no_data", "unknown"]);
const SAFE_RETRY_DECISIONS = new Set(["scheduled", "not_scheduled", "unknown"]);
const SAFE_RETRY_REASONS = new Set(["success", "retryable_read", "configured_safe_mutation", "verified_rate_limit_rejection", "attempt_limit_reached", "ambiguous_mutation_requires_reconciliation", "non_retryable"]);

export interface SafeDispatcherDiagnostics {
  schemaVersion: 1;
  status: string;
  attemptCount: number;
  upstreamHttpStatus?: number;
  errorClassification?: string;
  uncertain: boolean;
  attempts: Array<{
    attemptId: number;
    attemptNumber: number;
    startedAt?: string;
    completedAt?: string;
    upstreamHttpStatus?: number;
    classification: string;
    responseState: string;
    responseHadData?: boolean;
    graphqlErrors: Array<{code?: string; path?: Array<string | number>}>;
    uncertain: boolean;
    retryDecision: string;
    nextRetryAt?: string;
    retryReason?: string;
    retryAfterMs?: number;
  }>;
  attemptsTruncated: boolean;
}
export interface DispatcherDiagnosticRetrieval { status: "failed"; category: string; dispatcherHttpStatus?: number }
export type DispatcherDiagnosticResult = {
  requestId: string;
  diagnostics?: SafeDispatcherDiagnostics;
  retrieval?: DispatcherDiagnosticRetrieval;
};
export interface DispatcherDiagnosticEnvironment {
  DISPATCHER_TOKEN?: string;
  CF_ACCESS_CLIENT_ID?: string;
  CF_ACCESS_CLIENT_SECRET?: string;
}

class InvalidDiagnosticsResponseError extends Error {
  constructor() {
    super("Dispatcher diagnostics response is invalid");
    this.name = "InvalidDiagnosticsResponseError";
  }
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
}
function validPath(value: unknown): value is Array<string | number> {
  return Array.isArray(value) && value.length <= 16 && value.every(part =>
    typeof part === "string" ? /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(part) : Number.isSafeInteger(part) && part >= 0 && part <= 10_000);
}
function safeDispatcherDiagnostics(value: unknown, expectedRequestId: string): SafeDispatcherDiagnostics | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const body = value as Record<string, unknown>;
  if (body.schema_version !== 1 || body.request_id !== expectedRequestId || body.source !== "superops-mcp" ||
      typeof body.status !== "string" || !SAFE_DISPATCHER_STATES.has(body.status) ||
      !Number.isInteger(body.attempt_count) || (body.attempt_count as number) < 0 || (body.attempt_count as number) > 1000 ||
      typeof body.uncertain !== "boolean" || typeof body.attempts_truncated !== "boolean" ||
      !Array.isArray(body.attempts) || body.attempts.length > 20) return undefined;
  for (const key of ["created_at", "updated_at", "started_at", "completed_at", "next_retry_at"]) {
    if (body[key] !== null && body[key] !== undefined && !validTimestamp(body[key])) return undefined;
  }
  const topStatus = body.upstream_http_status;
  if (topStatus !== null && topStatus !== undefined && (!Number.isInteger(topStatus) || (topStatus as number) < 100 || (topStatus as number) > 599)) return undefined;
  const errorClassification = body.error_classification;
  if (errorClassification !== null && errorClassification !== undefined &&
      (typeof errorClassification !== "string" || !/^[A-Z][A-Z0-9_]{0,79}$/.test(errorClassification))) return undefined;
  const attempts: SafeDispatcherDiagnostics["attempts"] = [];
  for (const raw of body.attempts) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const item = raw as Record<string, unknown>;
    if (!Number.isSafeInteger(item.id) || (item.id as number) < 1 || !Number.isInteger(item.attempt_number) || (item.attempt_number as number) < 1 ||
        typeof item.classification !== "string" || !/^[A-Z][A-Z0-9_]{0,79}$/.test(item.classification) ||
        typeof item.response_state !== "string" || !SAFE_RESPONSE_STATES.has(item.response_state) ||
        typeof item.uncertain !== "boolean" || typeof item.retry_decision !== "string" || !SAFE_RETRY_DECISIONS.has(item.retry_decision) ||
        !Array.isArray(item.graphql_errors) || item.graphql_errors.length > 20) return undefined;
    for (const key of ["started_at", "completed_at", "retry_next_at"]) {
      if (item[key] !== null && item[key] !== undefined && !validTimestamp(item[key])) return undefined;
    }
    for (const key of ["response_status", "retry_after_ms"]) {
      const number = item[key];
      if (number !== null && number !== undefined && (!Number.isSafeInteger(number) || (number as number) < 0 ||
          (key === "response_status" ? (number as number) < 100 || (number as number) > 599 : (number as number) > 86_400_000))) return undefined;
    }
    if (item.response_had_data !== null && item.response_had_data !== undefined && typeof item.response_had_data !== "boolean") return undefined;
    if (item.retry_reason !== null && item.retry_reason !== undefined && (typeof item.retry_reason !== "string" || !SAFE_RETRY_REASONS.has(item.retry_reason))) return undefined;
    const graphqlErrors: SafeDispatcherDiagnostics["attempts"][number]["graphqlErrors"] = [];
    for (const graphError of item.graphql_errors) {
      if (!graphError || typeof graphError !== "object" || Array.isArray(graphError)) return undefined;
      const entry = graphError as Record<string, unknown>;
      if (Object.keys(entry).some(key => key !== "code" && key !== "path") ||
          (entry.code !== undefined && (typeof entry.code !== "string" || !/^[A-Z][A-Z0-9_]{0,79}$/.test(entry.code))) ||
          (entry.path !== undefined && !validPath(entry.path)) || (entry.code === undefined && entry.path === undefined)) return undefined;
      graphqlErrors.push({ ...(entry.code === undefined ? {} : {code: entry.code as string}), ...(entry.path === undefined ? {} : {path: entry.path as Array<string | number>}) });
    }
    attempts.push({
      attemptId: item.id as number,
      attemptNumber: item.attempt_number as number,
      ...(validTimestamp(item.started_at) ? {startedAt: item.started_at} : {}),
      ...(validTimestamp(item.completed_at) ? {completedAt: item.completed_at} : {}),
      ...(Number.isInteger(item.response_status) ? {upstreamHttpStatus: item.response_status as number} : {}),
      classification: item.classification,
      responseState: item.response_state,
      ...(typeof item.response_had_data === "boolean" ? {responseHadData: item.response_had_data} : {}),
      graphqlErrors,
      uncertain: item.uncertain,
      retryDecision: item.retry_decision,
      ...(validTimestamp(item.retry_next_at) ? {nextRetryAt: item.retry_next_at} : {}),
      ...(typeof item.retry_reason === "string" ? {retryReason: item.retry_reason} : {}),
      ...(Number.isInteger(item.retry_after_ms) ? {retryAfterMs: item.retry_after_ms as number} : {}),
    });
  }
  return {
    schemaVersion: 1,
    status: body.status,
    attemptCount: body.attempt_count as number,
    ...(Number.isInteger(topStatus) ? {upstreamHttpStatus: topStatus as number} : {}),
    ...(typeof errorClassification === "string" ? {errorClassification} : {}),
    uncertain: body.uncertain,
    attempts,
    attemptsTruncated: body.attempts_truncated,
  };
}

async function boundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new InvalidDiagnosticsResponseError();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximumBytes) throw new Error("Dispatcher diagnostics response exceeded its size limit");
      chunks.push(part.value);
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* Keep the first bounded-read failure. */ }
    throw error;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new InvalidDiagnosticsResponseError();
  }
}

export async function fetchSafeDispatcherDiagnostics(
  requestId: string,
  env: DispatcherDiagnosticEnvironment,
  origin: string,
): Promise<DispatcherDiagnosticResult> {
  if (!SAFE_RECEIPT_ID.test(requestId)) throw new Error("A valid dispatcher receipt ID is required.");
  if (!env.DISPATCHER_TOKEN?.trim()) return {requestId, retrieval: {status: "failed", category: "credentials_unavailable"}};
  if (Boolean(env.CF_ACCESS_CLIENT_ID) !== Boolean(env.CF_ACCESS_CLIENT_SECRET)) {
    return {requestId, retrieval: {status: "failed", category: "access_configuration"}};
  }
  const url = origin + "/v1/requests/" + requestId + "/safe-diagnostics";
  if (!hasExecutionBudgetFor(1)) return {requestId, retrieval: {status: "failed", category: "budget_exhausted"}};
  const counted = recordTypedSubrequestStart({type: "dispatcherPoll", endpoint: url, operationName: "dispatcherSafeDiagnostics"});
  const headers: Record<string, string> = {Authorization: "Bearer " + env.DISPATCHER_TOKEN, Accept: "application/json"};
  if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
    headers["CF-Access-Client-Id"] = env.CF_ACCESS_CLIENT_ID;
    headers["CF-Access-Client-Secret"] = env.CF_ACCESS_CLIENT_SECRET;
  }
  let response: Response | undefined;
  let body: unknown;
  try {
    response = await fetch(url, {
      method: "GET", headers, redirect: "manual",
      signal: AbortSignal.timeout(getExecutionConfig().requestTimeoutMs),
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      recordSubrequestFinish(counted, response.status, false, {
        outcome: "dispatcher_error", errorClass: "DiagnosticsRedirect", dispatcherHttpStatus: response.status,
      });
      return {requestId, retrieval: {status: "failed", category: "redirect", dispatcherHttpStatus: response.status}};
    }
    if (!response.ok) {
      await response.body?.cancel();
      recordSubrequestFinish(counted, response.status, false, {
        outcome: "dispatcher_error", errorClass: "DiagnosticsHttp" + response.status, dispatcherHttpStatus: response.status,
      });
      return {requestId, retrieval: {status: "failed", category: "http_" + response.status, dispatcherHttpStatus: response.status}};
    }
    body = await boundedJson(response, 128 * 1024);
  } catch (error) {
    const oversized = error instanceof Error && error.message.includes("size limit");
    const invalidResponse = error instanceof InvalidDiagnosticsResponseError;
    const timedOut = error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name);
    const category = oversized ? "oversized_response" : invalidResponse ? "invalid_response" : timedOut ? "timeout" : "network_error";
    recordSubrequestFinish(counted, timedOut ? "requestTimeout" : "networkError", false, {
      outcome: timedOut ? "request_timeout" : "dispatcher_error",
      errorClass: "Diagnostics_" + category,
      dispatcherHttpStatus: response?.status,
    });
    return {requestId, retrieval: {status: "failed", category, ...(response?.status ? {dispatcherHttpStatus: response.status} : {})}};
  }
  if (!response) return {requestId, retrieval: {status: "failed", category: "network_error"}};
  recordSubrequestFinish(counted, response.status, true, {dispatcherHttpStatus: response.status});
  const diagnostics = safeDispatcherDiagnostics(body, requestId);
  if (!diagnostics) return {requestId, retrieval: {status: "failed", category: "invalid_response", dispatcherHttpStatus: response.status}};
  return {requestId, diagnostics};
}
