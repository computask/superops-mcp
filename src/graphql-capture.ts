import { AsyncLocalStorage } from "node:async_hooks";
import { getExecutionState, recordSubrequestFinish, recordTypedSubrequestStart } from "./execution.js";

export const GRAPHQL_CAPTURE_VERSION = 1;
export const GRAPHQL_CAPTURE_BODY_BYTES = 4 * 1024 * 1024;
export const GRAPHQL_CAPTURE_BATCH_BYTES = 8 * 1024 * 1024;
export const GRAPHQL_CAPTURE_MAX_EXCHANGES = 128;
const REDACTED = "[REDACTED]";
const credentialKey = /authorization|cookie|password|passwd|secret|token|api[-_]?key|private[-_]?key|cf[-_]access|customersubdomain|superops[-_]subdomain/i;

export interface CapturedBody {
  text?: string;
  bytes?: number;
  complete: boolean;
  reason?: string;
}
export interface GraphqlExchange {
  sequence: number;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  invocationId?: string;
  operationId?: string;
  toolName?: string;
  itemKey?: string;
  request: { url: string; method: string; headers: Record<string, string>; body?: CapturedBody };
  response?: { status: number; headers: Record<string, string>; body: CapturedBody };
  transportError?: string;
}
export interface GraphqlCapture {
  captureId: string;
  version: number;
  startedAt: string;
  completedAt: string;
  complete: boolean;
  omittedExchanges: number;
  exchanges: GraphqlExchange[];
}
interface Scope {
  capture: GraphqlCapture;
  pending: Promise<void>[];
  secrets: string[];
  reservedBytes: number;
  persistenceRequest?: ReturnType<typeof recordTypedSubrequestStart>;
  persistenceUnavailable?: boolean;
}
const context = new AsyncLocalStorage<Scope>();
const encoder = new TextEncoder();

/** Only private diagnostic records use this redactor. Never emit bodies to console. */
export function redactGraphqlText(text: string, secrets: readonly string[] = []): string {
  let result = text;
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) {
    for (const form of new Set([secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)])) {
      result = result.split(form).join(REDACTED);
    }
  }
  result = result
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED)
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED)
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, REDACTED)
    .replace(/((?:api[-_]?key|api[-_]?token|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|authorization|customerSubDomain|token|secret)["']?\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s,;}]+)/gi, `$1"${REDACTED}"`);
  // Preserve the exact original text/formatting unless a credential-key value needs removal.
  try {
    const parsed: unknown = JSON.parse(result);
    let changed = false;
    const visit = (value: unknown, depth: number): unknown => {
      if (depth > 64) { changed = true; return "[OMITTED: nesting limit]"; }
      if (Array.isArray(value)) return value.map(item => visit(item, depth + 1));
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => {
        if (credentialKey.test(key)) { changed = true; return [key, REDACTED]; }
        return [key, visit(item, depth + 1)];
      }));
      if (typeof value === "string") {
        const safe = redactEmbeddedText(value);
        if (safe !== value) changed = true;
        return safe;
      }
      return value;
    };
    const safe = visit(parsed, 0);
    if (changed) return JSON.stringify(safe);
  } catch { /* Non-JSON and malformed HTTP responses are diagnostic evidence too. */ }
  return result;
}

function redactEmbeddedText(value: string): string {
  return value.replace(/((?:api[-_]?key|api[-_]?token|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|authorization|customerSubDomain)\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s,;}]+)/gi, `$1"${REDACTED}"`);
}
function safeHeaders(headers: RequestInit["headers"], secrets: string[]): Record<string, string> {
  return Object.fromEntries([...new Headers(headers)].map(([key, value]) =>
    [key, credentialKey.test(key) ? REDACTED : redactGraphqlText(value, secrets)]));
}
function requestBody(body: RequestInit["body"], scope: Scope): CapturedBody | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body !== "string") return {complete: false, reason: "unsupported_request_body"};
  const bytes = encoder.encode(body).byteLength;
  if (bytes > GRAPHQL_CAPTURE_BODY_BYTES || bytes > GRAPHQL_CAPTURE_BATCH_BYTES - scope.reservedBytes) {
    return {complete: false, bytes, reason: "capture_size_limit"};
  }
  const text = redactGraphqlText(body, scope.secrets);
  scope.reservedBytes += encoder.encode(text).byteLength;
  return {complete: true, bytes, text};
}
async function responseBody(response: Response, maximum: number, secrets: string[]): Promise<CapturedBody> {
  if (!response.body) return {complete: true, bytes: 0, text: ""};
  const reader = response.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reason = "response_body_unreadable";
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reason = "capture_body_timeout"; reject(new Error(reason)); }, 5_000);
  });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await Promise.race([reader.read(), timeout]);
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maximum) return {complete: false, bytes, reason: "capture_size_limit"};
      chunks.push(part.value);
    }
    const joined = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
    return {complete: true, bytes, text: redactGraphqlText(new TextDecoder().decode(joined), secrets)};
  } catch {
    // Do not retain truncated text: a credential might straddle the cut.
    return {complete: false, bytes, reason};
  } finally {
    clearTimeout(timer);
    // A tee branch's cancel promise waits for the other consumer; never await it.
    void reader.cancel().catch(() => undefined);
  }
}

export async function runWithGraphqlCapture<T>(options: {
  secrets: string[];
  persist: (capture: GraphqlCapture) => Promise<void>;
  waitUntil?: (work: Promise<void>) => void;
}, fn: () => Promise<T>): Promise<T> {
  const startedAt = new Date().toISOString();
  const scope: Scope = {secrets: options.secrets, reservedBytes: 0, pending: [], capture: {
    captureId: crypto.randomUUID(), version: GRAPHQL_CAPTURE_VERSION, startedAt,
    completedAt: startedAt, complete: true, omittedExchanges: 0, exchanges: [],
  }};
  return context.run(scope, async () => {
    try { return await fn(); }
    finally {
      if (scope.capture.exchanges.length || scope.capture.omittedExchanges) {
        const persist = (async () => {
          await Promise.all(scope.pending);
          scope.capture.completedAt = new Date().toISOString();
          scope.capture.complete = scope.capture.omittedExchanges === 0 && scope.capture.exchanges.every(exchange =>
            exchange.request.body?.complete !== false && exchange.response?.body.complete !== false);
          if (scope.persistenceUnavailable) throw new Error("capture_budget_unavailable");
          await options.persist(scope.capture);
          if (scope.persistenceRequest) recordSubrequestFinish(scope.persistenceRequest, "stored", true);
          console.info(JSON.stringify({event: "graphql_capture_stored", captureId: scope.capture.captureId,
            date: startedAt.slice(0, 10), complete: scope.capture.complete, exchanges: scope.capture.exchanges.length,
            invocationIds: [...new Set(scope.capture.exchanges.map(exchange => exchange.invocationId).filter(Boolean))]}));
        })().catch((error: unknown) => {
          if (scope.persistenceRequest) recordSubrequestFinish(scope.persistenceRequest, "capture_failed", false);
          console.error(JSON.stringify({event: "graphql_capture_store_failed", captureId: scope.capture.captureId,
            date: startedAt.slice(0, 10), reason: error instanceof Error && /^(capture_store_http_\d{3}|capture_budget_unavailable|graphql_capture_binding_unavailable)$/.test(error.message)
              ? error.message : "capture_storage_or_processing_failure"}));
        });
        if (options.waitUntil) options.waitUntil(persist); else await persist;
      }
    }
  });
}

/** Observes the same physical request, including polls. No extra dispatcher/SuperOps calls. */
export async function capturedDispatcherFetch(url: string, init: RequestInit): Promise<Response> {
  const scope = context.getStore();
  if (!scope || scope.capture.exchanges.length >= GRAPHQL_CAPTURE_MAX_EXCHANGES) {
    if (scope) scope.capture.omittedExchanges++;
    return fetch(url, init);
  }
  const state = getExecutionState();
  if (scope.capture.exchanges.length === 0 && !scope.persistenceRequest) {
    if (state && state.subrequests >= state.config.subrequestBudget) scope.persistenceUnavailable = true;
    else scope.persistenceRequest = recordTypedSubrequestStart({type: "custom", operationName: "graphqlCapturePersist", allowSafetyMargin: true});
  }
  const start = Date.now();
  const exchange: GraphqlExchange = {
    sequence: scope.capture.exchanges.length + 1, startedAt: new Date(start).toISOString(),
    invocationId: state?.invocationId, operationId: state?.operationId, toolName: state?.toolName, itemKey: state?.itemKey,
    request: {url: redactGraphqlText(url, scope.secrets), method: init.method ?? "GET",
      headers: safeHeaders(init.headers, scope.secrets), body: requestBody(init.body, scope)},
  };
  scope.capture.exchanges.push(exchange);
  try {
    const response = await fetch(url, init);
    exchange.durationMs = Date.now() - start;
    const maximum = Math.max(0, Math.min(GRAPHQL_CAPTURE_BODY_BYTES, GRAPHQL_CAPTURE_BATCH_BYTES - scope.reservedBytes));
    scope.reservedBytes += maximum; // Reserve before awaiting so parallel captures cannot exceed the batch bound.
    try {
      const pending = responseBody(response.clone(), maximum, scope.secrets).then(body => {
        scope.reservedBytes -= maximum;
        scope.reservedBytes += encoder.encode(body.text ?? "").byteLength;
        exchange.response = {status: response.status, headers: safeHeaders(response.headers, scope.secrets), body};
        exchange.completedAt = new Date().toISOString();
      });
      scope.pending.push(pending);
    } catch {
      scope.reservedBytes -= maximum;
      exchange.response = {status: response.status, headers: {}, body: {complete: false, reason: "capture_clone_failed"}};
      exchange.completedAt = new Date().toISOString();
    }
    return response;
  } catch (error) {
    exchange.durationMs = Date.now() - start;
    exchange.completedAt = new Date().toISOString();
    exchange.transportError = redactGraphqlText(error instanceof Error ? `${error.name}: ${error.message}` : "Unknown transport error", scope.secrets);
    throw error; // Exact original failure. Capture cannot authorize a replay.
  }
}
