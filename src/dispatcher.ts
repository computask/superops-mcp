import { AsyncLocalStorage } from "node:async_hooks";
import { getExecutionConfig, hasExecutionBudgetFor, recordSubrequestFinish, recordTypedSubrequestStart, withExecutionItem } from "./execution.js";

export const DISPATCHER_ORIGIN = "https://superops-api-dispatcher.taskgroup.co.uk";
export interface DispatcherEnvironment {
  DISPATCHER_TOKEN?: string;
  CF_ACCESS_CLIENT_ID?: string;
  CF_ACCESS_CLIENT_SECRET?: string;
}
const environment = new AsyncLocalStorage<DispatcherEnvironment>();
export interface DispatcherReceipt {
  requestId: string;
  idempotencyKey: string;
  state: string;
  retryAfter?: number;
}
const operation = new AsyncLocalStorage<{operationId: string; itemKey: string; checkpoint?: (receipt: DispatcherReceipt) => Promise<void>}>();
export function withDispatcherOperation<T>(operationId: string, itemKey: string, fn: () => T,
  checkpoint?: (receipt: DispatcherReceipt) => Promise<void>): T {
  return operation.run({operationId, itemKey, checkpoint}, () => withExecutionItem(itemKey, fn));
}
export async function dispatcherIdempotencyKey(body: string, mutation: boolean): Promise<string> {
  const scope = mutation ? operation.getStore() : undefined;
  if (!scope) return `superops-mcp:${crypto.randomUUID()}`;
  // Durable operation and item identity already exist before I/O. Payload hash
  // distinguishes note/update stages without storing content or credentials.
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([scope.operationId, scope.itemKey, body])));
  return `superops-mcp:${Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
export function runWithDispatcher<T>(env: DispatcherEnvironment, fn: () => T): T {
  return environment.run(env, fn);
}
export function dispatcherEnvironment(): DispatcherEnvironment {
  return environment.getStore() ?? process.env;
}
export function dispatcherConfigured(env = dispatcherEnvironment()): boolean {
  return Boolean(env.DISPATCHER_TOKEN?.trim());
}

/** A receipt represents live or uncertain work, NOT permission to replay it. */
export class DispatcherPendingError extends Error {
  constructor(readonly requestId: string | undefined, readonly idempotencyKey: string,
    readonly state: string, readonly retryAfter?: number,
    readonly httpStatus?: number, readonly errorClassification?: string) {
    // Durable operations already persist/reconstruct the key. Avoid repeating
    // it in every compact per-item failure/result projection in the 512-KiB
    // ledger. Standalone callers still receive the key needed for recovery.
    super(operation.getStore()?.checkpoint
      ? `Dispatcher ${state}; receipt=${requestId ?? "unknown"}. Reconcile; no replay.`
      : `Dispatcher ${state}${errorClassification ? ` (${errorClassification})` : ""}; requestId=${requestId ?? "unknown"}; idempotencyKey=${idempotencyKey}. Recover this receipt; do not submit a new mutation.`);
    this.name = "DispatcherPendingError";
  }
  get rateLimited(): boolean { return this.httpStatus === 429 || /RATE_LIMIT|THROTTL/.test(this.errorClassification ?? ""); }
}
const pending = new Set(["queued", "running", "retry_wait"]);
const terminal = new Set(["succeeded", "failed", "cancelled", "uncertain"]);
function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function retrySeconds(headers: Headers): number {
  const raw = headers.get("Retry-After");
  if (!raw) return 1;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : Math.max(1, (Date.parse(raw) - Date.now()) / 1000 || 1);
}
export async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Dispatcher response is empty");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 4 * 1024 * 1024) throw new Error("Dispatcher response-size limit exceeded");
      chunks.push(part.value);
    }
  } catch (error) { try { await reader.cancel(); } catch { /* Preserve the original read failure. */ } throw error; }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** POST is sent once. After any receipt (including 504), only GET is used.
 * A caller recovering a lost acknowledgement must supply the original key and
 * exact payload. The dispatcher owns durable idempotency and upstream retries.
 * Never accept a returned statusUrl, redirect, or arbitrary upstream hostname.
 */
export async function dispatcherFetch(body: string, options: {
  idempotencyKey: string;
  signal?: AbortSignal;
  requestId?: string;
  env?: DispatcherEnvironment;
  mutation?: boolean;
  onReceipt?: (receipt: DispatcherReceipt) => void;
}): Promise<Response> {
  const env = options.env ?? dispatcherEnvironment();
  if (!dispatcherConfigured(env)) throw new Error("Dispatcher producer credentials are not configured; direct SuperOps access is disabled.");
  if (Boolean(env.CF_ACCESS_CLIENT_ID) !== Boolean(env.CF_ACCESS_CLIENT_SECRET)) throw new Error("Both Cloudflare Access credentials must be configured.");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.DISPATCHER_TOKEN}`,
    "X-Source": "superops-mcp", "Content-Type": "application/json", Accept: "application/json",
    "Idempotency-Key": options.idempotencyKey,
    Prefer: "respond-async",
  };
  if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
    headers["CF-Access-Client-Id"] = env.CF_ACCESS_CLIENT_ID;
    headers["CF-Access-Client-Secret"] = env.CF_ACCESS_CLIENT_SECRET;
  }
  let requestId = options.requestId;
  let observedHttpStatus: number | undefined;
  let observedErrorClassification: string | undefined;
  let observedRetryAfter: number | undefined;
  const deadline = Date.now() + getExecutionConfig().requestTimeoutMs;
  for (let poll = 0; poll < 20; poll++) {
    if (requestId && !/^[A-Za-z0-9_-]{1,160}$/.test(requestId)) throw new DispatcherPendingError(undefined, options.idempotencyKey, "invalid_receipt");
    if (options.signal?.aborted || Date.now() >= deadline || !hasExecutionBudgetFor(requestId ? 1 : 0)) {
      throw new DispatcherPendingError(requestId, options.idempotencyKey, "pending", observedRetryAfter, observedHttpStatus, observedErrorClassification);
    }
    const polling = Boolean(requestId);
    const url = `${DISPATCHER_ORIGIN}${polling ? `/v1/requests/${requestId}` : "/graphql"}`;
    const counted = polling ? recordTypedSubrequestStart({type: "dispatcherPoll", endpoint: url, operationName: "dispatcherStatus"}) : undefined;
    let response: Response;
    let value: Record<string, unknown>;
    try {
      response = await fetch(url, {method: polling ? "GET" : "POST", headers,
        // workerd supports manual/follow, not Node's redirect:"error".
        // Never follow redirects with producer or Access credentials attached.
        body: polling ? undefined : body, redirect: "manual",
        signal: options.signal ?? AbortSignal.timeout(Math.max(1, deadline - Date.now()))});
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        if (counted) recordSubrequestFinish(counted, response.status, false);
        throw new DispatcherPendingError(requestId, options.idempotencyKey, "redirect_rejected");
      }
      // Preserve an acknowledged receipt even if parsing its body subsequently
      // times out. It is evidence of accepted work, never replay permission.
      const headerReceipt = response.headers.get("X-Dispatcher-Request-Id");
      if (!polling && (response.status === 202 || response.status === 504) && headerReceipt && /^[A-Za-z0-9_-]{1,160}$/.test(headerReceipt)) {
        requestId = headerReceipt;
        const receipt = {requestId, idempotencyKey: options.idempotencyKey, state: "queued"};
        options.onReceipt?.(receipt);
        if (options.mutation) await operation.getStore()?.checkpoint?.(receipt);
      }
      if (!polling && response.status !== 202 && response.status !== 504 &&
          !pending.has(response.headers.get("X-Dispatcher-Status") ?? "") &&
          response.headers.get("X-Dispatcher-Uncertain") !== "true" &&
          response.headers.get("X-Dispatcher-Status") !== "uncertain") {
        const syncId = response.headers.get("X-Dispatcher-Request-Id");
        if (syncId && /^[A-Za-z0-9_-]{1,160}$/.test(syncId)) {
          const receipt = {requestId: syncId, idempotencyKey: options.idempotencyKey, state: response.headers.get("X-Dispatcher-Status") ?? "unknown"};
          options.onReceipt?.(receipt);
          if (options.mutation) await operation.getStore()?.checkpoint?.(receipt);
        }
        return response;
      }
      value = object(await boundedJson(response));
      if (counted) recordSubrequestFinish(counted, response.status, response.ok);
    } catch (error) {
      if (error instanceof DispatcherPendingError) throw error;
      if (counted) recordSubrequestFinish(counted, "networkError", false);
      throw new DispatcherPendingError(requestId, options.idempotencyKey,
        options.signal?.aborted || (error instanceof Error && error.name === "AbortError") ? "request_timeout" : "submission_or_status_unknown",
        observedRetryAfter, observedHttpStatus, observedErrorClassification);
    }
    const receipt = value.requestId ?? response.headers.get("X-Dispatcher-Request-Id");
    if (receipt !== undefined && receipt !== null) {
      if (typeof receipt !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(receipt) || (requestId && receipt !== requestId)) {
        throw new DispatcherPendingError(requestId, options.idempotencyKey, "invalid_receipt");
      }
      requestId = receipt;
    }
    if (polling && (value.requestId !== requestId || value.source !== "superops-mcp") && response.ok) {
      throw new DispatcherPendingError(requestId, options.idempotencyKey, "invalid_status_identity");
    }
    const state = response.headers.get("X-Dispatcher-Uncertain") === "true" || value.uncertain === true
      ? "uncertain" : String(response.headers.get("X-Dispatcher-Status") ?? value.status ?? "");
    const retryAt = typeof value.nextRetryAt === "string" ? Date.parse(value.nextRetryAt) : NaN;
    const seconds = Math.max(retrySeconds(response.headers), Number.isFinite(retryAt) ? Math.max(0, Math.ceil((retryAt - Date.now()) / 1000)) : 0);
    // Status HTTP 200 acknowledges a poll, not upstream success. Preserve the
    // receipt's last upstream classification when the caller must stop waiting.
    observedHttpStatus = typeof value.httpStatus === "number" && Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599 ? value.httpStatus : undefined;
    observedErrorClassification = typeof value.errorClassification === "string" && /^[A-Z0-9_]{1,100}$/.test(value.errorClassification) ? value.errorClassification : undefined;
    observedRetryAfter = pending.has(state) ? seconds : undefined;
    if (requestId) options.onReceipt?.({requestId, idempotencyKey: options.idempotencyKey, state: state || "queued"});
    if (requestId && options.mutation) await operation.getStore()?.checkpoint?.({requestId, idempotencyKey: options.idempotencyKey, state: state || "queued", retryAfter: seconds});
    if (state === "uncertain" || response.headers.get("X-Dispatcher-Uncertain") === "true" || value.uncertain === true) {
      throw new DispatcherPendingError(requestId, options.idempotencyKey, "uncertain");
    }
    if (polling && terminal.has(state)) {
      const status = typeof value.httpStatus === "number" && Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599 ? value.httpStatus : undefined;
      if (state === "succeeded" && (status === undefined || status < 200 || status >= 300 || value.errorClassification)) {
        throw new DispatcherPendingError(requestId, options.idempotencyKey, "invalid_success");
      }
      if (!value.response || status === undefined || state === "cancelled") {
        // The status contract intentionally omits failed response bodies. Keep
        // safe classification, never lastError/customer data, and do not POST
        // again: dispatcher retries have already finished for this receipt.
        const code = typeof value.errorClassification === "string" && /^[A-Z0-9_]{1,100}$/.test(value.errorClassification)
          ? value.errorClassification : undefined;
        throw new DispatcherPendingError(requestId, options.idempotencyKey, state,
          response.headers.has("Retry-After") ? seconds : undefined, status, code);
      }
      const resultHeaders = new Headers({"Content-Type": "application/json", "X-Dispatcher-Status": state, "X-Dispatcher-Request-Id": requestId!});
      const retry = response.headers.get("Retry-After");
      if (retry) resultHeaders.set("Retry-After", retry);
      return new Response(JSON.stringify(value.response), {status, headers: resultHeaders});
    }
    if (!polling && !pending.has(state) && response.status !== 202 && !(response.status === 504 && requestId)) {
      // Synchronous proxy preserves upstream GraphQL and HTTP error semantics.
      return new Response(JSON.stringify(value), {status: response.status, headers: response.headers});
    }
    if (!requestId) throw new DispatcherPendingError(undefined, options.idempotencyKey, "missing_receipt");
    if (polling && response.ok && !pending.has(state)) throw new DispatcherPendingError(requestId, options.idempotencyKey, "invalid_status");
    if (Date.now() + seconds * 1000 >= deadline) throw new DispatcherPendingError(requestId, options.idempotencyKey, "pending", seconds, observedHttpStatus, observedErrorClassification);
    await new Promise(resolve => setTimeout(resolve, seconds * 1000));
  }
  throw new DispatcherPendingError(requestId, options.idempotencyKey, "poll_limit", observedRetryAfter, observedHttpStatus, observedErrorClassification);
}
