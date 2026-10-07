import { AsyncLocalStorage } from "node:async_hooks";
import { assertTriageRunWriteLease } from "./triage-run-lease.js";
import { capturedDispatcherFetch } from "./graphql-capture.js";
import { getExecutionConfig, hasExecutionBudgetFor, recordSubrequestFinish, recordTypedSubrequestStart, withExecutionItem } from "./execution.js";
import { fetchSafeDispatcherDiagnostics, type DispatcherDiagnosticResult, type DispatcherDiagnosticRetrieval, type SafeDispatcherDiagnostics } from "./dispatcher-diagnostics.js";
import { validDispatcherVerification, type DispatcherVerification } from "./dispatcher-verification.js";

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
  mutationFingerprint?: string;
  attemptCount?: number;
  verification?: DispatcherVerification;
  diagnostics?: SafeDispatcherDiagnostics | DispatcherDiagnosticRetrieval;
}
const operation = new AsyncLocalStorage<{operationId: string; itemKey: string; checkpoint?: (receipt: DispatcherReceipt) => Promise<void>; receipt?: DispatcherReceipt; readRequestIds: string[]}>();
export function withDispatcherOperation<T>(operationId: string, itemKey: string, fn: () => T,
  checkpoint?: (receipt: DispatcherReceipt) => Promise<void>, receipt?: DispatcherReceipt): T {
  return operation.run({operationId, itemKey, checkpoint, receipt, readRequestIds: []}, () => withExecutionItem(itemKey, fn));
}
export async function dispatcherIdempotencyKey(body: string, mutation: boolean): Promise<string> {
  const scope = mutation ? operation.getStore() : undefined;
  if (!scope) return `superops-mcp:${crypto.randomUUID()}`;
  // Durable operation and item identity already exist before I/O. Payload hash
  // distinguishes note/update stages without storing content or credentials.
  const identity = [scope.operationId, scope.itemKey, body];
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(identity)));
  return `superops-mcp:${Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
export async function checkpointDispatcherDiagnostics(requestId: string, diagnostics: SafeDispatcherDiagnostics | DispatcherDiagnosticRetrieval): Promise<void> {
  const scope = operation.getStore();
  if (!scope?.checkpoint || scope.receipt?.requestId !== requestId) return;
  await scope.checkpoint({...scope.receipt, diagnostics});
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
    readonly upstreamHttpStatus?: number, readonly errorClassification?: string,
    readonly dispatcherHttpStatus?: number) {
    // Durable operations already persist/reconstruct the key. Avoid repeating
    // it in every compact per-item failure/result projection in the 512-KiB
    // ledger. Standalone callers still receive the key needed for recovery.
    super(operation.getStore()?.checkpoint
      ? `Dispatcher ${state}; receipt=${requestId ?? "unknown"}. Reconcile; no replay.`
      : `Dispatcher ${state}${errorClassification ? ` (${errorClassification})` : ""}; requestId=${requestId ?? "unknown"}; idempotencyKey=${idempotencyKey}. Recover this receipt; do not submit a new mutation.`);
    this.name = "DispatcherPendingError";
  }
  get httpStatus(): number | undefined { return this.upstreamHttpStatus; }
  get rateLimited(): boolean { return this.upstreamHttpStatus === 429 || /RATE_LIMIT|THROTTL/.test(this.errorClassification ?? ""); }
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
export async function boundedJson(response: Response, maximumBytes = 4 * 1024 * 1024): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Dispatcher response is empty");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximumBytes) throw new Error("Dispatcher response-size limit exceeded");
      chunks.push(part.value);
    }
  } catch (error) { try { await reader.cancel(); } catch { /* Preserve the original read failure. */ } throw error; }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

/**
 * Read versioned, producer-scoped attempt diagnostics. The Dispatcher derives
 * producer identity from the bearer token and returns no stored response data.
 */
export async function dispatcherDiagnostics(requestId: string, env = dispatcherEnvironment()): Promise<DispatcherDiagnosticResult> {
  return fetchSafeDispatcherDiagnostics(requestId, env, DISPATCHER_ORIGIN);
}
function publishReceipt(receipt: DispatcherReceipt, options: {mutation?: boolean; onReceipt?: (receipt: DispatcherReceipt) => void}, body = ""): void {
  const scope = operation.getStore();
  if (scope && options.mutation) scope.receipt = receipt;
  if (scope && !options.mutation && receipt.state === "succeeded" && /\b(?:getTicket|getTicketNoteList|getAlertList)\s*\(/.test(body)) {
    scope.readRequestIds = [...scope.readRequestIds.filter(id => id !== receipt.requestId), receipt.requestId].slice(-8);
  }
  options.onReceipt?.(receipt);
}
function producerHeaders(env: DispatcherEnvironment): Record<string, string> {
  if (!dispatcherConfigured(env)) throw new Error("Dispatcher producer credentials are not configured; direct SuperOps access is disabled.");
  if (Boolean(env.CF_ACCESS_CLIENT_ID) !== Boolean(env.CF_ACCESS_CLIENT_SECRET)) throw new Error("Both Cloudflare Access credentials must be configured.");
  return {
    Authorization: `Bearer ${env.DISPATCHER_TOKEN}`, "X-Source": "superops-mcp", "Content-Type": "application/json", Accept: "application/json",
    ...(env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET ? {"CF-Access-Client-Id": env.CF_ACCESS_CLIENT_ID, "CF-Access-Client-Secret": env.CF_ACCESS_CLIENT_SECRET} : {}),
  };
}
function receiptMetadata(value: Record<string, unknown>, receipt: DispatcherReceipt): DispatcherReceipt {
  return {...receipt,
    ...(typeof value.fingerprint === "string" && /^[a-f0-9]{64}$/.test(value.fingerprint) ? {mutationFingerprint: value.fingerprint} : {}),
    ...(Number.isInteger(value.attemptCount) && (value.attemptCount as number) >= 1 && (value.attemptCount as number) <= 1000 ? {attemptCount: value.attemptCount as number} : {}),
    ...(validDispatcherVerification(value.verification) && value.verification.requestId === receipt.requestId ? {verification: value.verification} : {}),
  };
}
/** Settle only the original uncertain receipt, using existing dispatcher reads.
 * Failure, missing fields, or negative observation never authorizes a replay. */
export async function reconcileCurrentDispatcherReceipt(requireApplied = false): Promise<DispatcherVerification | undefined> {
  const scope = operation.getStore();
  let receipt = scope?.receipt;
  if (!scope || !receipt || receipt.state !== "uncertain") return receipt?.verification;
  const hold = (state: string) => new DispatcherPendingError(receipt?.requestId, receipt!.idempotencyKey, state);
  const headers = producerHeaders(dispatcherEnvironment());
  const request = async (suffix: string, body?: string) => {
    if (!hasExecutionBudgetFor(1)) throw hold("verification_budget_exhausted");
    const url = `${DISPATCHER_ORIGIN}/v1/requests/${receipt!.requestId}${suffix}`;
    const counted = recordTypedSubrequestStart({type: "dispatcherVerification", endpoint: url, operationName: suffix ? "verifyMutationTarget" : "mutationIntentStatus"});
    let response: Response | undefined;
    try {
      response = await capturedDispatcherFetch(url, {method: body ? "POST" : "GET", body, headers, redirect: "manual", signal: AbortSignal.timeout(getExecutionConfig().requestTimeoutMs)});
      if (!response.ok) { await response.body?.cancel(); throw hold("verification_unavailable"); }
      const value = object(await boundedJson(response, 64 * 1024));
      recordSubrequestFinish(counted, response.status, true, {dispatcherHttpStatus: response.status});
      return value;
    } catch (error) {
      recordSubrequestFinish(counted, response?.status ?? "dispatcherVerificationUnknown", false, {outcome: "dispatcher_error", errorClass: "DispatcherVerificationUnavailable", dispatcherHttpStatus: response?.status});
      if (error instanceof DispatcherPendingError) throw error;
      throw hold("verification_unavailable");
    }
  };
  // Recover a settlement whose acknowledgement or local checkpoint was lost.
  {
    const value = await request("");
    if (value.requestId !== receipt.requestId || value.source !== "superops-mcp" || value.type !== "mutation" || !["uncertain", "succeeded"].includes(String(value.status))) throw hold("invalid_verification_identity");
    if ((receipt.mutationFingerprint && value.fingerprint !== receipt.mutationFingerprint) || (receipt.attemptCount && value.attemptCount !== receipt.attemptCount)) throw hold("invalid_verification_identity");
    receipt = receiptMetadata(value, receipt);
    if (!receipt.mutationFingerprint || !receipt.attemptCount) throw hold("verification_intent_unavailable");
    if (value.status === "succeeded") {
      if (value.errorClassification !== "RECONCILED_APPLIED" || receipt.verification?.outcome !== "applied" || receipt.verification.mutationFingerprint !== receipt.mutationFingerprint || receipt.verification.attemptCount !== receipt.attemptCount) throw hold("invalid_verification_identity");
      receipt = {...receipt, state: "succeeded"};
      await scope.checkpoint?.(receipt); scope.receipt = receipt;
      return receipt.verification;
    }
    await scope.checkpoint?.(receipt); scope.receipt = receipt;
  }
  const readRequestIds = [...scope.readRequestIds].sort();
  if (!readRequestIds.length) { if (requireApplied) throw hold("verification_evidence_unavailable"); return undefined; }
  const body = {schemaVersion: 1, mutationFingerprint: receipt.mutationFingerprint, expectedAttemptCount: receipt.attemptCount, readRequestIds};
  const evidenceHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(body)))), byte => byte.toString(16).padStart(2, "0")).join("");
  const value = await request("/verify", JSON.stringify(body));
  const proof = value.verification;
  if (value.requestId !== receipt.requestId || value.source !== "superops-mcp" || value.fingerprint !== receipt.mutationFingerprint || value.attemptCount !== receipt.attemptCount || !validDispatcherVerification(proof) ||
      proof.requestId !== receipt.requestId || proof.mutationFingerprint !== receipt.mutationFingerprint || proof.attemptCount !== receipt.attemptCount || proof.evidenceHash !== evidenceHash || JSON.stringify(proof.readRequestIds) !== JSON.stringify(readRequestIds) ||
      value.status !== (proof.outcome === "applied" ? "succeeded" : "uncertain") || value.uncertain !== (proof.outcome !== "applied")) throw hold("invalid_verification_identity");
  receipt = {...receipt, state: proof.outcome === "applied" ? "succeeded" : "uncertain", verification: proof};
  await scope.checkpoint?.(receipt); scope.receipt = receipt;
  if (requireApplied && proof.outcome !== "applied") throw hold("verification_unresolved");
  return proof;
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
  const prior = options.mutation ? operation.getStore()?.receipt : undefined;
  if (!requestId && prior && !["succeeded", "failed", "cancelled"].includes(prior.state)) {
    if (prior.idempotencyKey === options.idempotencyKey) requestId = prior.requestId;
    else throw new DispatcherPendingError(prior.requestId, prior.idempotencyKey, "unresolved_prior_mutation");
  }
  let observedHttpStatus: number | undefined;
  let observedDispatcherHttpStatus: number | undefined;
  let observedErrorClassification: string | undefined;
  let observedRetryAfter: number | undefined;
  const deadline = Date.now() + getExecutionConfig().requestTimeoutMs;
  for (let poll = 0; poll < 20; poll++) {
    if (requestId && !/^[A-Za-z0-9_-]{1,160}$/.test(requestId)) throw new DispatcherPendingError(undefined, options.idempotencyKey, "invalid_receipt");
    if (options.signal?.aborted || Date.now() >= deadline || !hasExecutionBudgetFor(requestId ? 1 : 0)) {
      throw new DispatcherPendingError(requestId, options.idempotencyKey, "pending", observedRetryAfter, observedHttpStatus, observedErrorClassification, observedDispatcherHttpStatus);
    }
    const polling = Boolean(requestId);
    // Expiry prevents NEW submissions only. Existing receipts must still be
    // polled with their original IDs, including after revocation.
    if (!polling && options.mutation) await assertTriageRunWriteLease({
      operationId: operation.getStore()?.operationId, itemKey: operation.getStore()?.itemKey,
    });
    const url = `${DISPATCHER_ORIGIN}${polling ? `/v1/requests/${requestId}` : "/graphql"}`;
    const counted = polling ? recordTypedSubrequestStart({type: "dispatcherPoll", endpoint: url, operationName: "dispatcherStatus"}) : undefined;
    let response: Response | undefined;
    let value: Record<string, unknown>;
    try {
      response = await capturedDispatcherFetch(url, {method: polling ? "GET" : "POST", headers,
        // workerd supports manual/follow, not Node's redirect:"error".
        // Never follow redirects with producer or Access credentials attached.
        body: polling ? undefined : body, redirect: "manual",
        signal: options.signal ?? AbortSignal.timeout(Math.max(1, deadline - Date.now()))});
      observedDispatcherHttpStatus = response.status;
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        if (counted) recordSubrequestFinish(counted, response.status, false, {outcome: "dispatcher_error", dispatcherHttpStatus: response.status});
        throw new DispatcherPendingError(requestId, options.idempotencyKey, "redirect_rejected", undefined, observedHttpStatus, observedErrorClassification, response.status);
      }
      // Preserve an acknowledged receipt even if parsing its body subsequently
      // times out. It is evidence of accepted work, never replay permission.
      const headerReceipt = response.headers.get("X-Dispatcher-Request-Id");
      if (!polling && (response.status === 202 || response.status === 504) && headerReceipt && /^[A-Za-z0-9_-]{1,160}$/.test(headerReceipt)) {
        requestId = headerReceipt;
        const receipt = {requestId, idempotencyKey: options.idempotencyKey, state: "queued"};
        publishReceipt(receipt, options, body);
        if (options.mutation) await operation.getStore()?.checkpoint?.(receipt);
      }
      if (!polling && response.status !== 202 && response.status !== 504 &&
          !pending.has(response.headers.get("X-Dispatcher-Status") ?? "") &&
          response.headers.get("X-Dispatcher-Uncertain") !== "true" &&
          response.headers.get("X-Dispatcher-Status") !== "uncertain") {
        const syncId = response.headers.get("X-Dispatcher-Request-Id");
        if (syncId && /^[A-Za-z0-9_-]{1,160}$/.test(syncId)) {
          const receipt = {requestId: syncId, idempotencyKey: options.idempotencyKey, state: response.headers.get("X-Dispatcher-Status") ?? "unknown"};
          publishReceipt(receipt, options, body);
          if (options.mutation) await operation.getStore()?.checkpoint?.(receipt);
        }
        return response;
      }
      value = object(await boundedJson(response));
      if (counted) recordSubrequestFinish(counted, response.status, response.ok, {dispatcherHttpStatus: response.status});
    } catch (error) {
      if (error instanceof DispatcherPendingError) throw error;
      if (counted) recordSubrequestFinish(counted, response?.status ?? "dispatcherTransportUnknown", false, {
        outcome: response ? "dispatcher_error" : "network_error",
        errorClass: response ? "DispatcherStatusBodyUnreadable" : "DispatcherTransportUnknown",
        dispatcherHttpStatus: response?.status,
      });
      throw new DispatcherPendingError(requestId, options.idempotencyKey,
        options.signal?.aborted || (error instanceof Error && error.name === "AbortError") ? "request_timeout" : "submission_or_status_unknown",
        observedRetryAfter, observedHttpStatus, observedErrorClassification, response?.status);
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
    if (requestId) {
      const parsedReceipt: DispatcherReceipt = receiptMetadata(value, {
        requestId,
        idempotencyKey: options.idempotencyKey,
        state: state || "queued",
        ...(pending.has(state) ? {retryAfter: seconds} : {}),
      });
      publishReceipt(parsedReceipt, options, body);
      if (options.mutation) await operation.getStore()?.checkpoint?.({...parsedReceipt, retryAfter: seconds});
    }
    if (state === "uncertain" || response.headers.get("X-Dispatcher-Uncertain") === "true" || value.uncertain === true) {
      throw new DispatcherPendingError(requestId, options.idempotencyKey, "uncertain", observedRetryAfter, observedHttpStatus, observedErrorClassification, response.status);
    }
    if (polling && terminal.has(state)) {
      if (state === "succeeded" && value.errorClassification === "RECONCILED_APPLIED" && validDispatcherVerification(value.verification) && value.verification.outcome === "applied" && value.verification.requestId === requestId) {
        throw new DispatcherPendingError(requestId, options.idempotencyKey, "reconciled_applied");
      }
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
          response.headers.has("Retry-After") ? seconds : undefined, status, code, response.status);
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
    if (Date.now() + seconds * 1000 >= deadline) throw new DispatcherPendingError(requestId, options.idempotencyKey, "pending", seconds, observedHttpStatus, observedErrorClassification, response.status);
    await new Promise(resolve => setTimeout(resolve, seconds * 1000));
  }
  throw new DispatcherPendingError(requestId, options.idempotencyKey, "poll_limit", observedRetryAfter, observedHttpStatus, observedErrorClassification, observedDispatcherHttpStatus);
}
