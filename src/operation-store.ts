import { AsyncLocalStorage } from "node:async_hooks";
import { getAuditContext } from "./audit.js";
import { recordSubrequestFinish, recordTypedSubrequestStart } from "./execution.js";

export type OperationState =
  | "Running"
  | "ContinuationRequired"
  | "Rescheduled"
  | "Completed"
  | "Failed"
  | "Cancelled";

export type OperationItemStage =
  | "Pending"
  | "Validating"
  | "Validated"
  | "WriteNotStarted"
  | "WriteStarted"
  | "WriteAmbiguous"
  | "FieldsUpdated"
  | "StatusUpdated"
  | "NoteChecked"
  | "NoteAdded"
  | "Verifying"
  | "Completed"
  | "CompletedAfterRetry"
  | "CompletedAfterAmbiguousWriteVerification"
  | "AmbiguousWriteUnresolved"
  | "Stale"
  | "Skipped"
  | "FailedBeforeWrite"
  | "FailedAfterPartialWrite"
  | "RateLimited"
  | "RateLimitedRetrying"
  | "RateLimitedRescheduled"
  | "RateLimitExceeded"
  | "StaleAfterRateLimitWait"
  | "Rescheduled"
  | "Unattempted";

export type OperationErrorClass =
  | "SuperOpsRateLimit"
  | "CloudflareSubrequestBudget"
  | "CloudflareExecutionTimeout"
  | "CloudflareCpuLimit"
  | "UpstreamNetworkFailure"
  | "SuperOpsInternalError"
  | "SuperOpsGraphQLError"
  | "AuthenticationFailure"
  | "ValidationFailure"
  | "StaleData"
  | "VerificationMismatch"
  | "AmbiguousWrite"
  | "ContinuationFailure"
  | "OperationStoreFailure";

export interface OperationLease {
  leaseId: string;
  owner: string;
  expiresAt: string;
}

export interface OperationRateLimitState {
  endpoint?: string;
  operationName?: string;
  attempts: number;
  retryAfterSupplied: boolean;
  parsedDelayMs?: number;
  appliedDelayMs?: number;
  totalElapsedMs?: number;
  continuedInAnotherInvocation: boolean;
  writeAttempted: boolean;
  finalResult?: string;
}

export interface OperationItemState {
  itemKey: string;
  stage: OperationItemStage;
  outcome?: string;
  idempotencyKey: string;
  writeAttempted: boolean;
  writeMayHaveSucceeded: boolean;
  partialWrite: boolean;
  ambiguousWrite?: boolean;
  noteFingerprint?: string;
  verificationState?: "NotRequired" | "Pending" | "Verified" | "Failed";
  retryCount: number;
  attemptCount?: number;
  nextEligibleTime?: string;
  failureReason?: string;
  errorClass?: OperationErrorClass;
  updatedTimeExpectation?: string;
  targetFields?: Record<string, unknown>;
  originalMetadataExpectations?: Record<string, unknown>;
  rateLimit?: OperationRateLimitState;
  lease?: OperationLease;
  claimedAt?: string;
  completedAt?: string;
}

export interface OperationLedgerRecord {
  responseVersion: 1;
  operationId: string;
  toolName: string;
  ownerHash: string;
  tenantHash?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  originalRequestHash: string;
  operationRequest?: Record<string, unknown>;
  state: OperationState;
  expectedItems: string[];
  currentItem?: string;
  completedItems: string[];
  failedItems: string[];
  skippedItems: string[];
  unattemptedItems: string[];
  pendingItems: string[];
  itemStates: Record<string, OperationItemState>;
  summary: Record<string, unknown>;
  compactResults: unknown[];
  partialWriteCount: number;
  ambiguousWriteCount: number;
  rateLimitedItems: string[];
  continuationCount: number;
  nextEligibleTime?: string;
  terminalFailureReason?: string;
  currentLease?: OperationLease;
  workflowId?: string;
  lastInvocationId?: string;
  staleItems?: string[];
}

export interface OperationItemClaim {
  operationId: string;
  itemKey: string;
  lease: OperationLease;
  item: OperationItemState;
}

export interface OperationClaimNextParams {
  operationId: string;
  ownerHash: string;
  leaseOwner: string;
  leaseMs: number;
  now?: string;
}

export interface OperationCompleteItemParams {
  operationId: string;
  ownerHash: string;
  itemKey: string;
  leaseId?: string;
  patch: Partial<OperationItemState> & { stage: OperationItemStage };
  result?: unknown;
}

export interface OperationScheduleContinuationParams {
  operationId: string;
  ownerHash: string;
  reason: string;
  nextEligibleTime?: string;
  workflowId?: string;
}

export interface OperationStore {
  put(record: OperationLedgerRecord): Promise<void>;
  get(operationId: string): Promise<OperationLedgerRecord | undefined>;
  list(ownerHash: string): Promise<OperationLedgerRecord[]>;
  update(
    operationId: string,
    ownerHash: string,
    updater: (record: OperationLedgerRecord) => OperationLedgerRecord
  ): Promise<OperationLedgerRecord>;
  claimNextItem(params: OperationClaimNextParams): Promise<OperationItemClaim | undefined>;
  completeItem(params: OperationCompleteItemParams): Promise<OperationLedgerRecord>;
  scheduleContinuation(params: OperationScheduleContinuationParams): Promise<OperationLedgerRecord>;
}

interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

interface DurableObjectState {
  storage: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    put<T = unknown>(key: string, value: T): Promise<void>;
    delete(key: string): Promise<boolean>;
    list<T = unknown>(options?: { prefix?: string }): Promise<Map<string, T>>;
  };
}

export interface OperationStoreEnv {
  SUPEROPS_OPERATION_LEDGER?: unknown;
}

const STORE_CONTEXT = new AsyncLocalStorage<OperationStore>();
const memoryRecords = new Map<string, OperationLedgerRecord>();

const TERMINAL_STAGES = new Set<OperationItemStage>([
  "Completed",
  "CompletedAfterRetry",
  "CompletedAfterAmbiguousWriteVerification",
  "AmbiguousWriteUnresolved",
  "Stale",
  "Skipped",
  "FailedBeforeWrite",
  "FailedAfterPartialWrite",
  "RateLimitExceeded",
  "StaleAfterRateLimitWait",
]);

const FAILED_STAGES = new Set<OperationItemStage>([
  "AmbiguousWriteUnresolved",
  "FailedBeforeWrite",
  "FailedAfterPartialWrite",
  "RateLimitExceeded",
]);

const SKIPPED_STAGES = new Set<OperationItemStage>([
  "Stale",
  "Skipped",
  "StaleAfterRateLimitWait",
]);

const RATE_LIMIT_STAGES = new Set<OperationItemStage>([
  "RateLimited",
  "RateLimitedRetrying",
  "RateLimitedRescheduled",
  "RateLimitExceeded",
]);

function isDurableObjectNamespace(value: unknown): value is DurableObjectNamespace {
  return typeof value === "object" &&
    value !== null &&
    typeof (value as { idFromName?: unknown }).idFromName === "function" &&
    typeof (value as { get?: unknown }).get === "function";
}

function cloneRecord(record: OperationLedgerRecord): OperationLedgerRecord {
  return JSON.parse(JSON.stringify(record)) as OperationLedgerRecord;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isLeaseActive(lease: OperationLease | undefined, now: string): boolean {
  return Boolean(lease && lease.expiresAt > now);
}

function assertRecordOwner(record: OperationLedgerRecord, ownerHash: string): void {
  if (record.ownerHash !== ownerHash) {
    throw new Error("Operation was not found or is not visible to this caller.");
  }
}

const EXPLICIT_STAGE_TRANSITIONS: Partial<Record<OperationItemStage, ReadonlySet<OperationItemStage>>> = {
  Pending: new Set(["Validating", "Validated", "WriteNotStarted", "Rescheduled", "RateLimitedRescheduled"]),
  Unattempted: new Set(["Validating", "Validated", "WriteNotStarted", "Rescheduled", "RateLimitedRescheduled"]),
  Validating: new Set(["Validated", "WriteNotStarted"]),
  Validated: new Set(["WriteNotStarted", "WriteStarted", "Verifying"]),
  WriteNotStarted: new Set(["WriteStarted", "Verifying"]),
  WriteStarted: new Set(["FieldsUpdated", "StatusUpdated", "NoteChecked", "Verifying", "WriteAmbiguous"]),
  WriteAmbiguous: new Set(["FieldsUpdated", "StatusUpdated", "NoteChecked", "Verifying"]),
  FieldsUpdated: new Set(["StatusUpdated", "NoteChecked", "Verifying"]),
  StatusUpdated: new Set(["NoteChecked", "Verifying"]),
  NoteChecked: new Set(["NoteAdded", "Verifying"]),
  NoteAdded: new Set(["Verifying"]),
  Verifying: new Set(),
  RateLimited: new Set(["RateLimitedRetrying", "RateLimitedRescheduled"]),
  RateLimitedRetrying: new Set(["RateLimitedRescheduled"]),
  RateLimitedRescheduled: new Set(["Validating", "Validated", "WriteNotStarted", "WriteStarted", "WriteAmbiguous", "Verifying"]),
  Rescheduled: new Set(["Validating", "Validated", "WriteNotStarted", "WriteStarted", "WriteAmbiguous", "Verifying"]),
};

function assertTransition(current: OperationItemStage, next: OperationItemStage): void {
  if (current === next) return;
  if (TERMINAL_STAGES.has(current)) {
    throw new Error(`Invalid operation item transition from ${current} to ${next}.`);
  }
  // Any unfinished stage may finish in an explicit terminal outcome. Non-terminal
  // transitions must follow the persisted processing lifecycle, never claim state.
  if (TERMINAL_STAGES.has(next)) return;
  if (!EXPLICIT_STAGE_TRANSITIONS[current]?.has(next)) {
    throw new Error(`Invalid operation item transition from ${current} to ${next}.`);
  }
}

function itemResultKey(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const candidate = record.itemKey ?? record.ticketNumber ?? record.ticketId ?? record.displayId ?? record.alertId;
  return typeof candidate === "string" || typeof candidate === "number"
    ? String(candidate)
    : undefined;
}

function normalizeOperationRecord(record: OperationLedgerRecord): OperationLedgerRecord {
  const next = cloneRecord(record);
  const completed: string[] = [];
  const failed: string[] = [];
  const skipped: string[] = [];
  const unattempted: string[] = [];
  const pending: string[] = [];
  const stale: string[] = [];
  const rateLimited: string[] = [];
  let partialWriteCount = 0;
  let ambiguousWriteCount = 0;

  for (const itemKey of next.expectedItems) {
    const item = next.itemStates[itemKey];
    if (!item) {
      pending.push(itemKey);
      continue;
    }
    if (item.partialWrite) partialWriteCount += 1;
    if (item.ambiguousWrite || item.stage === "WriteAmbiguous" || item.stage === "AmbiguousWriteUnresolved") {
      ambiguousWriteCount += 1;
    }
    if (RATE_LIMIT_STAGES.has(item.stage)) rateLimited.push(itemKey);
    if (item.stage === "Stale" || item.stage === "StaleAfterRateLimitWait") stale.push(itemKey);
    if (item.stage === "Unattempted") {
      unattempted.push(itemKey);
      pending.push(itemKey);
    } else if (FAILED_STAGES.has(item.stage)) {
      failed.push(itemKey);
    } else if (SKIPPED_STAGES.has(item.stage)) {
      skipped.push(itemKey);
    } else if (TERMINAL_STAGES.has(item.stage)) {
      completed.push(itemKey);
    } else {
      pending.push(itemKey);
    }
  }

  next.completedItems = completed;
  next.failedItems = failed;
  next.skippedItems = skipped;
  next.unattemptedItems = unattempted;
  next.pendingItems = pending;
  next.staleItems = stale;
  next.rateLimitedItems = rateLimited;
  next.partialWriteCount = partialWriteCount;
  next.ambiguousWriteCount = ambiguousWriteCount;

  if (next.state !== "Cancelled" && next.state !== "Failed") {
    const hasOutstanding = pending.length > 0;
    if (!hasOutstanding) {
      next.state = "Completed";
      delete next.nextEligibleTime;
      delete next.currentLease;
    }
  }

  return next;
}

function claimNextItemInRecord(
  record: OperationLedgerRecord,
  params: OperationClaimNextParams
): { record: OperationLedgerRecord; claim?: OperationItemClaim } {
  assertRecordOwner(record, params.ownerHash);
  const now = params.now ?? nowIso();
  const itemKey = record.expectedItems.find((key) => {
    const item = record.itemStates[key];
    if (!item || TERMINAL_STAGES.has(item.stage)) return false;
    if (item.nextEligibleTime && item.nextEligibleTime > now) return false;
    return !isLeaseActive(item.lease, now);
  });
  if (!itemKey) {
    return { record: normalizeOperationRecord(record) };
  }

  const lease: OperationLease = {
    leaseId: globalThis.crypto?.randomUUID?.() ?? `lease-${Date.now()}`,
    owner: params.leaseOwner,
    expiresAt: new Date(Date.parse(now) + Math.max(1, params.leaseMs)).toISOString(),
  };
  const item = record.itemStates[itemKey];
  const claimedItem: OperationItemState = {
    ...item,
    // A lease is independent from processing progress. Preserve the exact stage so
    // resumed work can resolve an ambiguous mutation before considering a replay.
    stage: item.stage,
    lease,
    claimedAt: now,
  };
  record.itemStates[itemKey] = claimedItem;
  record.currentItem = itemKey;
  record.currentLease = lease;
  record.state = "Running";
  record.updatedAt = now;
  const normalized = normalizeOperationRecord(record);

  return {
    record: normalized,
    claim: {
      operationId: params.operationId,
      itemKey,
      lease,
      item: cloneRecord({ ...normalized, itemStates: { [itemKey]: claimedItem } }).itemStates[itemKey],
    },
  };
}
function applyItemPatch(
  record: OperationLedgerRecord,
  params: OperationCompleteItemParams
): OperationLedgerRecord {
  const current = record.itemStates[params.itemKey];
  if (!current) {
    throw new Error(`Operation item not found: ${params.itemKey}`);
  }
  if (params.leaseId && current.lease?.leaseId !== params.leaseId) {
    throw new Error(`Operation item lease mismatch: ${params.itemKey}`);
  }
  assertTransition(current.stage, params.patch.stage);

  if (current.writeAttempted && params.patch.writeAttempted === false) {
    throw new Error(`Operation item writeAttempted cannot be reset: ${params.itemKey}`);
  }
  if (current.writeMayHaveSucceeded && params.patch.writeMayHaveSucceeded === false) {
    throw new Error(`Operation item writeMayHaveSucceeded cannot be reset without verification: ${params.itemKey}`);
  }
  const item: OperationItemState = {
    ...current,
    ...params.patch,
    itemKey: current.itemKey,
    idempotencyKey: current.idempotencyKey,
    completedAt: TERMINAL_STAGES.has(params.patch.stage) ? nowIso() : current.completedAt,
  };
  delete item.lease;
  record.itemStates[params.itemKey] = item;

  if (params.result !== undefined) {
    const compactKey = itemResultKey(params.result) ?? params.itemKey;
    record.compactResults = record.compactResults.filter(
      (result) => (itemResultKey(result) ?? "") !== compactKey
    );
    record.compactResults.push(params.result);
  }

  record.currentItem = params.itemKey;
  record.updatedAt = nowIso();
  return normalizeOperationRecord(record);
}

class MemoryOperationStore implements OperationStore {
  async put(record: OperationLedgerRecord): Promise<void> {
    memoryRecords.set(record.operationId, normalizeOperationRecord(record));
  }

  async get(operationId: string): Promise<OperationLedgerRecord | undefined> {
    const record = memoryRecords.get(operationId);
    return record ? cloneRecord(record) : undefined;
  }

  async list(ownerHash: string): Promise<OperationLedgerRecord[]> {
    return [...memoryRecords.values()]
      .filter((record) => record.ownerHash === ownerHash)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(cloneRecord);
  }

  async update(
    operationId: string,
    ownerHash: string,
    updater: (record: OperationLedgerRecord) => OperationLedgerRecord
  ): Promise<OperationLedgerRecord> {
    const existing = memoryRecords.get(operationId);
    if (!existing) throw new Error(`Operation not found: ${operationId}`);
    assertRecordOwner(existing, ownerHash);
    const updated = normalizeOperationRecord(updater(cloneRecord(existing)));
    updated.updatedAt = nowIso();
    memoryRecords.set(operationId, updated);
    return cloneRecord(updated);
  }

  async claimNextItem(params: OperationClaimNextParams): Promise<OperationItemClaim | undefined> {
    const existing = memoryRecords.get(params.operationId);
    if (!existing) return undefined;
    assertRecordOwner(existing, params.ownerHash);
    const { record, claim } = claimNextItemInRecord(cloneRecord(existing), params);
    memoryRecords.set(params.operationId, record);
    return claim;
  }

  async completeItem(params: OperationCompleteItemParams): Promise<OperationLedgerRecord> {
    return this.update(params.operationId, params.ownerHash, (record) => applyItemPatch(record, params));
  }

  async scheduleContinuation(params: OperationScheduleContinuationParams): Promise<OperationLedgerRecord> {
    return this.update(params.operationId, params.ownerHash, (record) => {
      record.state = params.nextEligibleTime ? "Rescheduled" : "ContinuationRequired";
      record.nextEligibleTime = params.nextEligibleTime;
      record.workflowId = params.workflowId ?? record.workflowId;
      record.terminalFailureReason = params.reason;
      record.continuationCount += 1;
      record.updatedAt = nowIso();
      return record;
    });
  }
}

class DurableObjectOperationStore implements OperationStore {
  constructor(private readonly namespace: DurableObjectNamespace) {}

  private stub(operationId = "operations") {
    return this.namespace.get(this.namespace.idFromName(operationId));
  }

  async put(record: OperationLedgerRecord): Promise<void> {
    const response = await operationStoreFetch(
      "operationStore.put",
      this.stub(record.operationId),
      new Request(`https://operation.local/operations/${record.operationId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(record),
      })
    );
    if (!response.ok) {
      throw new Error(`Operation store put failed: ${response.status}`);
    }
  }

  async get(operationId: string): Promise<OperationLedgerRecord | undefined> {
    const response = await operationStoreFetch(
      "operationStore.get",
      this.stub(operationId),
      new Request(`https://operation.local/operations/${operationId}`)
    );
    if (response.status === 404) return undefined;
    if (!response.ok) {
      throw new Error(`Operation store get failed: ${response.status}`);
    }
    return (await response.json()) as OperationLedgerRecord;
  }

  async list(ownerHash: string): Promise<OperationLedgerRecord[]> {
    const response = await operationStoreFetch(
      "operationStore.list",
      this.stub("operations"),
      new Request(`https://operation.local/operations?ownerHash=${ownerHash}`)
    );
    if (!response.ok) {
      throw new Error(`Operation store list failed: ${response.status}`);
    }
    return (await response.json()) as OperationLedgerRecord[];
  }

  async update(
    operationId: string,
    ownerHash: string,
    updater: (record: OperationLedgerRecord) => OperationLedgerRecord
  ): Promise<OperationLedgerRecord> {
    const existing = await this.get(operationId);
    if (!existing) throw new Error(`Operation not found: ${operationId}`);
    assertRecordOwner(existing, ownerHash);
    const updated = normalizeOperationRecord(updater(existing));
    await this.put(updated);
    return updated;
  }

  async claimNextItem(params: OperationClaimNextParams): Promise<OperationItemClaim | undefined> {
    const response = await operationStoreFetch(
      "operationStore.claimNextItem",
      this.stub(params.operationId),
      new Request(`https://operation.local/operations/${params.operationId}/claim-next`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      })
    );
    if (response.status === 204 || response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Operation store claim failed: ${response.status}`);
    return (await response.json()) as OperationItemClaim;
  }

  async completeItem(params: OperationCompleteItemParams): Promise<OperationLedgerRecord> {
    const response = await operationStoreFetch(
      "operationStore.completeItem",
      this.stub(params.operationId),
      new Request(`https://operation.local/operations/${params.operationId}/complete-item`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      })
    );
    if (!response.ok) throw new Error(`Operation store complete failed: ${response.status}`);
    return (await response.json()) as OperationLedgerRecord;
  }

  async scheduleContinuation(params: OperationScheduleContinuationParams): Promise<OperationLedgerRecord> {
    const response = await operationStoreFetch(
      "operationStore.scheduleContinuation",
      this.stub(params.operationId),
      new Request(`https://operation.local/operations/${params.operationId}/schedule-continuation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      })
    );
    if (!response.ok) throw new Error(`Operation store schedule failed: ${response.status}`);
    return (await response.json()) as OperationLedgerRecord;
  }
}

async function operationStoreFetch(
  operationName: string,
  stub: { fetch(request: Request): Promise<Response> },
  request: Request
): Promise<Response> {
  const started = recordOperationStoreSubrequest(operationName);
  try {
    const response = await stub.fetch(request);
    recordSubrequestFinish(started, response.status, response.ok);
    return response;
  } catch (error) {
    recordSubrequestFinish(started, "operationStoreError", false);
    throw error;
  }
}

function recordOperationStoreSubrequest(operationName: string) {
  return recordTypedSubrequestStart({
    type: "custom",
    operationType: "durableObject",
    operationName,
    allowSafetyMargin: true,
  });
}

export function runWithOperationStore<T>(
  env: OperationStoreEnv,
  fn: () => T
): T {
  const store = isDurableObjectNamespace(env.SUPEROPS_OPERATION_LEDGER)
    ? new DurableObjectOperationStore(env.SUPEROPS_OPERATION_LEDGER)
    : new MemoryOperationStore();
  return STORE_CONTEXT.run(store, fn);
}

export function getOperationStore(): OperationStore {
  return STORE_CONTEXT.getStore() ?? new MemoryOperationStore();
}

export function currentOwnerHash(): string {
  const context = getAuditContext();
  return stableHash(context.user ?? "anonymous");
}

export function stableHash(value: unknown): string {
  const text = JSON.stringify(value) ?? "";
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function normalizedNoteFingerprint(value: string | undefined): string | undefined {
  if (!value || !value.trim()) return undefined;
  return stableHash(value.trim().replace(/\s+/g, " ").toLowerCase());
}

export function operationResultView(record: OperationLedgerRecord): Record<string, unknown> {
  return {
    operationId: record.operationId,
    toolName: record.toolName,
    state: record.state,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    completedCount: record.completedItems.length,
    pendingCount: record.pendingItems.length,
    failedCount: record.failedItems.length,
    skippedCount: record.skippedItems.length,
    unattemptedCount: record.unattemptedItems.length,
    partialWriteCount: record.partialWriteCount,
    ambiguousWriteCount: record.ambiguousWriteCount,
    staleCount: record.staleItems?.length ?? 0,
    rateLimitedItems: record.rateLimitedItems,
    nextEligibleTime: record.nextEligibleTime,
    continuationCount: record.continuationCount,
    terminalFailureReason: record.terminalFailureReason,
    workflowId: record.workflowId,
    summary: record.summary,
    results: record.compactResults,
  };
}

export class SuperOpsOperationLedger {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const operationMatch = url.pathname.match(/^\/operations\/([^/]+)$/);
    const operationActionMatch = url.pathname.match(/^\/operations\/([^/]+)\/(claim-next|complete-item|schedule-continuation)$/);

    if (request.method === "PUT" && operationMatch) {
      const record = normalizeOperationRecord((await request.json()) as OperationLedgerRecord);
      await this.state.storage.put(`op:${operationMatch[1]}`, record);
      return json({ ok: true });
    }

    if (request.method === "GET" && operationMatch) {
      const record = await this.state.storage.get<OperationLedgerRecord>(
        `op:${operationMatch[1]}`
      );
      return record ? json(record) : json({ error: "Not found" }, 404);
    }

    if (request.method === "POST" && operationActionMatch) {
      const [, operationId, action] = operationActionMatch;
      const key = `op:${operationId}`;
      const record = await this.state.storage.get<OperationLedgerRecord>(key);
      if (!record) return json({ error: "Not found" }, 404);

      if (action === "claim-next") {
        const params = (await request.json()) as OperationClaimNextParams;
        assertRecordOwner(record, params.ownerHash);
        const claimed = claimNextItemInRecord(cloneRecord(record), params);
        await this.state.storage.put(key, claimed.record);
        return claimed.claim ? json(claimed.claim) : new Response(null, { status: 204 });
      }

      if (action === "complete-item") {
        const params = (await request.json()) as OperationCompleteItemParams;
        assertRecordOwner(record, params.ownerHash);
        const updated = applyItemPatch(cloneRecord(record), params);
        await this.state.storage.put(key, updated);
        return json(updated);
      }

      if (action === "schedule-continuation") {
        const params = (await request.json()) as OperationScheduleContinuationParams;
        assertRecordOwner(record, params.ownerHash);
        const updated = normalizeOperationRecord({
          ...cloneRecord(record),
          state: params.nextEligibleTime ? "Rescheduled" : "ContinuationRequired",
          nextEligibleTime: params.nextEligibleTime,
          workflowId: params.workflowId ?? record.workflowId,
          terminalFailureReason: params.reason,
          continuationCount: record.continuationCount + 1,
          updatedAt: nowIso(),
        });
        await this.state.storage.put(key, updated);
        return json(updated);
      }
    }

    if (request.method === "GET" && url.pathname === "/operations") {
      const ownerHash = url.searchParams.get("ownerHash");
      const records = await this.state.storage.list<OperationLedgerRecord>({
        prefix: "op:",
      });
      const filtered = [...records.values()].filter(
        (record) => !ownerHash || record.ownerHash === ownerHash
      );
      filtered.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return json(filtered.slice(0, 50));
    }

    return json({ error: "Not found" }, 404);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
