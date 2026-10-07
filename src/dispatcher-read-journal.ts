import { AsyncLocalStorage } from "node:async_hooks";
import { getExecutionState, recordSubrequestFinish, recordTypedSubrequestStart } from "./execution.js";
import type { DispatcherReceipt } from "./dispatcher.js";

type Namespace = { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } };
type Storage = { get<T = unknown>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void> };
type TransactionalStorage = Storage & { transaction?<T>(fn: (txn: Storage) => Promise<T>): Promise<T> };
type Environment = { namespace: Namespace; owner: () => string };
type Scope = { workflow: string; automatic: boolean; ownerHash?: string; strictFresh?: boolean };
type ReadContext = Scope & { failure?: unknown };
const environments = new AsyncLocalStorage<Environment | undefined>();
const scopes = new AsyncLocalStorage<ReadContext>();
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const STATES = new Set(["submission_unknown", "unknown", "queued", "running", "retry_wait", "succeeded", "failed", "cancelled", "uncertain"]);
const MAX_SLOTS = 256; // Per owner/workflow/hash-prefix shard, not a global caller limit.
const MAX_HISTORY = 8;
export function dispatcherReadRecoveryState(state: string): {pending: boolean; terminal: boolean} {
  return {
    pending: ["submission_unknown", "unknown", "pending", "poll_limit", "queued", "running", "retry_wait", "request_timeout",
      "submission_or_status_unknown", "poll_budget_exhausted", "wait_budget_exhausted"].includes(state),
    terminal: ["succeeded", "failed", "cancelled", "uncertain"].includes(state),
  };
}

export interface DispatcherReadCheckpoint extends DispatcherReceipt {
  nextEligibleAt?: string;
  recoveryStartedAt?: string;
  recoveryDeadlineAt?: string;
  upstreamHttpStatus?: number;
  errorClassification?: string;
}
export interface DispatcherReadRecord {
  version: 1;
  ownerHash: string;
  workflowHash: string;
  payloadHash: string;
  generation: number;
  invocationId: string;
  idempotencyKey: string;
  requestId?: string;
  previousRequestId?: string;
  state: string;
  createdAt: string;
  updatedAt: string;
  delivered: boolean;
  nextEligibleAt?: string;
  recoveryStartedAt?: string;
  recoveryDeadlineAt?: string;
  upstreamHttpStatus?: number;
  errorClassification?: string;
  history: Array<{ requestId: string; generation: number; state: string; completedAt: string }>;
}
export class DispatcherReadJournalError extends Error {
  constructor(readonly code: string) { super(`Dispatcher read journal unavailable (${code}); no new read identity permitted.`); this.name = "DispatcherReadJournalError"; }
}
export function runWithDispatcherReadEnvironment<T>(env: { SUPEROPS_OPERATION_LEDGER?: unknown }, owner: () => string, fn: () => T): T {
  const value = env.SUPEROPS_OPERATION_LEDGER as Partial<Namespace> | undefined;
  const context = typeof value?.idFromName === "function" && typeof value?.get === "function"
    ? { namespace: value as Namespace, owner } : undefined;
  return environments.run(context, fn);
}
export function withDispatcherReadScope<T>(scope: Scope, fn: () => T): T { return scopes.run({...scope}, fn); }
/** Preserve server-owned read failures when a domain handler converts an error to a ToolResult. */
export function dispatcherReadFailure(): unknown { return scopes.getStore()?.failure; }
export function recordDispatcherReadFailure(error: unknown): void {
  const scope = scopes.getStore();
  if (scope) scope.failure = error;
}

async function digest(text: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2, "0")).join("");
}
function timestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
}
function receiptId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value); }
function hash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DispatcherReadJournalError("invalid_shape");
  return value as Record<string, unknown>;
}
function identity(value: Record<string, unknown>): void {
  if (typeof value.ownerHash !== "string" || !/^[a-f0-9]{8,64}$/.test(value.ownerHash) || !hash(value.workflowHash) || !hash(value.payloadHash)) {
    throw new DispatcherReadJournalError("invalid_identity");
  }
}
function record(value: unknown): DispatcherReadRecord {
  const v = object(value); identity(v);
  const fields = new Set(["version", "ownerHash", "workflowHash", "payloadHash", "generation", "invocationId", "idempotencyKey",
    "requestId", "previousRequestId", "state", "createdAt", "updatedAt", "delivered", "nextEligibleAt", "recoveryStartedAt",
    "recoveryDeadlineAt", "upstreamHttpStatus", "errorClassification", "history"]);
  if (Object.keys(v).some(key => !fields.has(key))) throw new DispatcherReadJournalError("unexpected_record_field");
  if (v.version !== 1 || !Number.isSafeInteger(v.generation) || Number(v.generation) < 1 || Number(v.generation) > 1_000_000 ||
    typeof v.invocationId !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/.test(v.invocationId) ||
    typeof v.idempotencyKey !== "string" || !/^superops-mcp:read:[a-f0-9-]{36}$/.test(v.idempotencyKey) ||
    typeof v.state !== "string" || !STATES.has(v.state) || !timestamp(v.createdAt) || !timestamp(v.updatedAt) ||
    typeof v.delivered !== "boolean" || (v.requestId !== undefined && !receiptId(v.requestId)) ||
    (v.previousRequestId !== undefined && !receiptId(v.previousRequestId)) || !Array.isArray(v.history) || v.history.length > MAX_HISTORY ||
    JSON.stringify(v).length > 8192) throw new DispatcherReadJournalError("invalid_record");
  for (const field of ["nextEligibleAt", "recoveryStartedAt", "recoveryDeadlineAt"]) if (v[field] !== undefined && !timestamp(v[field])) throw new DispatcherReadJournalError("invalid_timestamp");
  if (v.errorClassification !== undefined && (typeof v.errorClassification !== "string" || !/^[A-Z0-9_]{1,100}$/.test(v.errorClassification))) throw new DispatcherReadJournalError("invalid_classification");
  if (v.upstreamHttpStatus !== undefined && (!Number.isInteger(v.upstreamHttpStatus) || Number(v.upstreamHttpStatus) < 100 || Number(v.upstreamHttpStatus) > 599)) throw new DispatcherReadJournalError("invalid_status");
  for (const item of v.history as unknown[]) {
    const entry = object(item);
    if (Object.keys(entry).some(key => !["requestId", "generation", "state", "completedAt"].includes(key)) ||
      !receiptId(entry.requestId) || !Number.isSafeInteger(entry.generation) || Number(entry.generation) < 1 ||
      Number(entry.generation) >= Number(v.generation) || typeof entry.state !== "string" || !TERMINAL.has(entry.state) ||
      !timestamp(entry.completedAt)) throw new DispatcherReadJournalError("invalid_history");
  }
  return v as unknown as DispatcherReadRecord;
}

/** Content-free private journal in the existing operation-ledger namespace.
 * Atomic open persists identity before POST; uncertain/pending rows never renew.
 * Dispatcher receipts retain complete terminal history outside this bounded trail. */
export class DispatcherReadJournal {
  constructor(private readonly storage: TransactionalStorage) {}
  async fetch(request: Request): Promise<Response> {
    try {
      if (request.method !== "POST" || Number(request.headers.get("Content-Length") ?? 0) > 16_384) throw new DispatcherReadJournalError("invalid_request");
      const text = await request.text();
      if (text.length > 16_384) throw new DispatcherReadJournalError("request_too_large");
      const input = object(JSON.parse(text)); identity(input);
      const action = new URL(request.url).pathname.split("/").at(-1);
      if (!["open", "checkpoint", "delivered"].includes(action ?? "")) throw new DispatcherReadJournalError("invalid_action");
      if (typeof this.storage.transaction !== "function") throw new DispatcherReadJournalError("atomic_storage_unavailable");
      const result = await this.storage.transaction(async txn => {
        const key = `dispatcher-read:${input.payloadHash}`;
        const stored = await txn.get(key);
        let previous = stored === undefined ? undefined : record(stored);
        if (previous && (previous.ownerHash !== input.ownerHash || previous.workflowHash !== input.workflowHash || previous.payloadHash !== input.payloadHash)) throw new DispatcherReadJournalError("identity_conflict");
        const now = new Date().toISOString();
        if (action === "open") {
          if (typeof input.invocationId !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/.test(input.invocationId) || typeof input.automatic !== "boolean") throw new DispatcherReadJournalError("invalid_scope");
          const fresh = previous?.state === "succeeded" && previous.delivered ||
            previous && ["failed", "cancelled"].includes(previous.state) && input.automatic === false && input.invocationId !== previous.invocationId;
          if (previous && !fresh) return previous;
          const count = await txn.get<number>("dispatcher-read:slot-count") ?? 0;
          if (!previous && count >= MAX_SLOTS) throw new DispatcherReadJournalError("slot_limit");
          if (previous && previous.generation >= 1_000_000) throw new DispatcherReadJournalError("generation_limit");
          const next: DispatcherReadRecord = { version: 1, ownerHash: String(input.ownerHash), workflowHash: String(input.workflowHash), payloadHash: String(input.payloadHash),
            generation: (previous?.generation ?? 0) + 1, invocationId: input.invocationId,
            idempotencyKey: `superops-mcp:read:${crypto.randomUUID()}`, state: "submission_unknown", createdAt: now, updatedAt: now, delivered: false,
            previousRequestId: previous?.requestId, history: [...(previous?.history ?? []), ...(previous?.requestId ? [{requestId: previous.requestId, generation: previous.generation, state: previous.state, completedAt: previous.updatedAt}] : [])].slice(-MAX_HISTORY) };
          await txn.put(key, next);
          if (!previous) await txn.put("dispatcher-read:slot-count", count + 1);
          return next;
        }
        if (!previous || input.generation !== previous.generation || input.idempotencyKey !== previous.idempotencyKey) throw new DispatcherReadJournalError("stale_checkpoint");
        if (action === "delivered") {
          if (previous.state !== "succeeded" || !previous.requestId) throw new DispatcherReadJournalError("not_confirmed_success");
          previous = {...previous, delivered: true, updatedAt: now};
        } else {
          const patch = object(input.receipt);
          if (!receiptId(patch.requestId) || patch.idempotencyKey !== previous.idempotencyKey || typeof patch.state !== "string" || !STATES.has(patch.state)) throw new DispatcherReadJournalError("invalid_receipt");
          if (previous.requestId && previous.requestId !== patch.requestId) throw new DispatcherReadJournalError("receipt_conflict");
          if (TERMINAL.has(previous.state) && patch.state !== previous.state) return previous;
          if (previous.recoveryDeadlineAt && patch.recoveryDeadlineAt && previous.recoveryDeadlineAt !== patch.recoveryDeadlineAt) throw new DispatcherReadJournalError("deadline_changed");
          // Explicit projection rejects raw payloads/content from the stored record.
          previous = record({...previous, requestId: patch.requestId, state: patch.state, updatedAt: now,
            nextEligibleAt: TERMINAL.has(patch.state) ? undefined : patch.nextEligibleAt,
            recoveryStartedAt: previous.recoveryStartedAt ?? patch.recoveryStartedAt,
            recoveryDeadlineAt: previous.recoveryDeadlineAt ?? patch.recoveryDeadlineAt,
            upstreamHttpStatus: patch.upstreamHttpStatus ?? previous.upstreamHttpStatus,
            errorClassification: patch.errorClassification ?? previous.errorClassification });
        }
        await txn.put(key, previous);
        return previous;
      });
      return Response.json(result);
    } catch (error) {
      return Response.json({errorClass: "DispatcherReadJournal", code: error instanceof DispatcherReadJournalError ? error.code : "storage_failure"}, {status: 409});
    }
  }
}

export class DispatcherReadSession {
  constructor(public record: DispatcherReadRecord, private readonly stub: {fetch(request: Request): Promise<Response>},
    readonly refreshBeforeUse = false) {}
  private async save(action: string, patch: Record<string, unknown>): Promise<void> {
    this.record = await journalFetch(this.stub, action, {...this.record, history: undefined, ...patch}, true);
  }
  async checkpoint(receipt: DispatcherReadCheckpoint): Promise<void> {
    const {nextEligibleAt, recoveryStartedAt, recoveryDeadlineAt, upstreamHttpStatus, errorClassification} = receipt;
    if (this.record.requestId === receipt.requestId && this.record.state === receipt.state &&
      this.record.nextEligibleAt === nextEligibleAt && this.record.recoveryDeadlineAt === recoveryDeadlineAt &&
      this.record.errorClassification === errorClassification && this.record.upstreamHttpStatus === upstreamHttpStatus) return;
    await this.save("checkpoint", {receipt: {requestId: receipt.requestId, idempotencyKey: receipt.idempotencyKey, state: receipt.state,
      nextEligibleAt, recoveryStartedAt, recoveryDeadlineAt, upstreamHttpStatus, errorClassification}});
  }
  async delivered(): Promise<void> { await this.save("delivered", {}); }
}
async function journalFetch(stub: {fetch(request: Request): Promise<Response>}, action: string, body: unknown, allowSafetyMargin: boolean): Promise<DispatcherReadRecord> {
  const counted = recordTypedSubrequestStart({type: "custom", operationType: "durableObject", operationName: `dispatcherRead.${action}`, allowSafetyMargin});
  try {
    const response = await stub.fetch(new Request(`https://ledger.internal/dispatcher-reads/${action}`, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)}));
    recordSubrequestFinish(counted, response.status, response.ok);
    if (!response.ok) throw new DispatcherReadJournalError("storage_rejected");
    return record(await response.json());
  } catch (error) {
    if (!(error instanceof DispatcherReadJournalError)) recordSubrequestFinish(counted, "dispatcherReadJournalError", false);
    throw error instanceof DispatcherReadJournalError ? error : new DispatcherReadJournalError("storage_failure");
  }
}
export async function prepareDispatcherRead(body: string): Promise<DispatcherReadSession | undefined> {
  const env = environments.getStore(), scope = scopes.getStore();
  if (!env || !scope) return undefined; // Node/unbound callers must retain the explicit receipt; no durability claim.
  const ownerHash = scope.ownerHash ?? env.owner();
  const workflowHash = await digest(scope.workflow), payloadHash = await digest(body);
  // Bounded independent shards avoid exhausting one owner's journal with many ticket reads.
  const stub = env.namespace.get(env.namespace.idFromName(`dispatcher-reads:${ownerHash}:${workflowHash}:${payloadHash.slice(0, 2)}`));
  const invocationId = getExecutionState()?.invocationId ?? crypto.randomUUID();
  const value = await journalFetch(stub, "open", {ownerHash, workflowHash, payloadHash,
    invocationId, automatic: scope.automatic}, false);
  if (value.ownerHash !== ownerHash || value.workflowHash !== workflowHash || value.payloadHash !== payloadHash) throw new DispatcherReadJournalError("response_identity_conflict");
  return new DispatcherReadSession(value, stub, scope.strictFresh === true && value.invocationId !== invocationId);
}
