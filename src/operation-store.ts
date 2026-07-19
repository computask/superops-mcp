import { AsyncLocalStorage } from "node:async_hooks";
import { getAuditContext } from "./audit.js";
import { recordSubrequestFinish, recordTypedSubrequestStart } from "./execution.js";

export type OperationState =
  | "Running"
  | "ContinuationRequired"
  | "Rescheduled"
  | "Completed"
  | "CompletedWithFailures"
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
  | "ResolutionValidated"
  | "ResolutionWriteStarted"
  | "ResolutionWriteSucceeded"
  | "ResolutionWriteAmbiguous"
  | "ResolutionVerified"
  | "StatusUpdated"
  | "NoteChecked"
  | "NoteWriteStarted"
  | "NoteWriteAmbiguous"
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
  | "CloudflareConfiguredBudgetReached"
  | "CloudflareSubrequestLimit"
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
  | "RateLimitExceeded"
  | "ContinuationFailure"
  | "ContinuationSchedulingFailure"
  | "ContinuationExecutionFailure"
  | "OperationStoreFailure"
  | "MalformedStoredOperation";

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
  cappedDelayMs?: number;
  appliedDelayMs?: number;
  actualDelayMs?: number;
  scheduledAt?: string;
  firstThrottledAt?: string;
  totalRetryDurationMs?: number;
  totalElapsedMs?: number;
  nextEligibleAt?: string;
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
  mutationType?: "update" | "resolution" | "note" | "resolveFallback";
  reliableResponseReceived?: boolean;
  observedMutationResult?: "Accepted" | "Rejected" | "VerifiedApplied" | "Ambiguous";
  canonicalTargetHash?: string;
  noteFingerprint?: string;
  createdNoteId?: string;
  fallbackAllowed?: boolean;
  fallbackAttempted?: boolean;
  fallbackApplied?: boolean;
  fallbackVerified?: boolean;
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
  /** Hard deadline for processing; retained evidence may outlive this value. */
  maxOperationLifetimeAt?: string;
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
  /** Compact durable-wake metadata; no caller credentials or request content. */
  continuationMechanism?: "workflow";
  continuationInstanceId?: string;
  schedulingAttempted?: boolean;
  schedulingSucceeded?: boolean;
  schedulingError?: string;
  schedulingAttemptCount?: number;
  wakeAttemptCount?: number;
  wakeDeliveryCount?: number;
  lastWakeAttemptAt?: string;
  lastWakeSucceededAt?: string;
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

/** Persists a mutation boundary while retaining the active claim lease. */
export interface OperationCheckpointItemParams {
  operationId: string;
  ownerHash: string;
  itemKey: string;
  leaseId: string;
  patch: Partial<OperationItemState> & { stage: OperationItemStage };
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
  checkpointItem(params: OperationCheckpointItemParams): Promise<OperationLedgerRecord>;
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
    setAlarm?(scheduledTime: number | Date): Promise<void>;
    getAlarm?(): Promise<number | null>;
  };
}

interface DurableContinuationEnv {
  SUPEROPS_CONTINUATION_WORKFLOW?: {
    createBatch(options: Array<{ id: string; params: Record<string, unknown> }>): Promise<Array<{ id: string }>>;
  };
  SUPEROPS_CONTINUATION_ENABLED?: string;
  SUPEROPS_DURABLE_RETRY_ENABLED?: string;
  SUPEROPS_EXECUTION_MAX_SCHEDULING_ATTEMPTS?: string;
}

export interface OperationStoreEnv {
  SUPEROPS_OPERATION_LEDGER?: unknown;
}

const STORE_CONTEXT = new AsyncLocalStorage<OperationStore>();
const memoryRecords = new Map<string, OperationLedgerRecord>();
const MAX_OPERATION_ITEMS = 500;
const MAX_SERIALIZED_OPERATION_BYTES = 512 * 1024;

export class MalformedStoredOperationError extends Error {
  constructor(message = "Stored operation is malformed or exceeds configured bounds.") {
    super(message);
    this.name = "MalformedStoredOperationError";
  }
}

function serializedBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

const FORBIDDEN_PERSISTED_CONTENT_KEYS = new Set([
  "note",
  "content",
  "description",
  "conversation",
  "messagebody",
  "attachmentbody",
]);
const VALID_OPERATION_STATES = new Set<OperationState>([
  "Running",
  "ContinuationRequired",
  "Rescheduled",
  "Completed",
  "CompletedWithFailures",
  "Failed",
  "Cancelled",
]);
const VALID_OPERATION_ITEM_STAGES = new Set<OperationItemStage>([
  "Pending",
  "Validating",
  "Validated",
  "WriteNotStarted",
  "WriteStarted",
  "WriteAmbiguous",
  "FieldsUpdated",
  "ResolutionValidated",
  "ResolutionWriteStarted",
  "ResolutionWriteSucceeded",
  "ResolutionWriteAmbiguous",
  "ResolutionVerified",
  "StatusUpdated",
  "NoteChecked",
  "NoteWriteStarted",
  "NoteWriteAmbiguous",
  "NoteAdded",
  "Verifying",
  "Completed",
  "CompletedAfterRetry",
  "CompletedAfterAmbiguousWriteVerification",
  "AmbiguousWriteUnresolved",
  "Stale",
  "Skipped",
  "FailedBeforeWrite",
  "FailedAfterPartialWrite",
  "RateLimited",
  "RateLimitedRetrying",
  "RateLimitedRescheduled",
  "RateLimitExceeded",
  "StaleAfterRateLimitWait",
  "Rescheduled",
  "Unattempted",
]);

function containsForbiddenPersistedContent(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenPersistedContent);
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value as Record<string, unknown>).some(([key, child]) =>
    FORBIDDEN_PERSISTED_CONTENT_KEYS.has(key.toLowerCase()) ||
    containsForbiddenPersistedContent(child)
  );
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function assertStringArray(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry)) {
    throw new MalformedStoredOperationError(`Operation ${field} must contain nonempty strings.`);
  }
}

function assertOperationRecord(value: unknown): asserts value is OperationLedgerRecord {
  if (!isRecordObject(value)) throw new MalformedStoredOperationError();
  const record = value as Partial<OperationLedgerRecord>;
  if (
    record.responseVersion !== 1 ||
    typeof record.operationId !== "string" || !record.operationId ||
    typeof record.toolName !== "string" || !record.toolName ||
    typeof record.ownerHash !== "string" || !record.ownerHash ||
    typeof record.originalRequestHash !== "string" || !record.originalRequestHash ||
    !VALID_OPERATION_STATES.has(record.state as OperationState) ||
    !isRecordObject(record.itemStates) ||
    !isRecordObject(record.summary) ||
    !Array.isArray(record.compactResults)
  ) {
    throw new MalformedStoredOperationError();
  }

  for (const [field, candidate] of [
    ["expectedItems", record.expectedItems],
    ["completedItems", record.completedItems],
    ["failedItems", record.failedItems],
    ["skippedItems", record.skippedItems],
    ["unattemptedItems", record.unattemptedItems],
    ["pendingItems", record.pendingItems],
    ["rateLimitedItems", record.rateLimitedItems],
  ] as const) assertStringArray(candidate, field);

  for (const [field, candidate] of [
    ["createdAt", record.createdAt],
    ["updatedAt", record.updatedAt],
    ["expiresAt", record.expiresAt],
  ] as const) {
    if (typeof candidate !== "string" || !Number.isFinite(Date.parse(candidate))) {
      throw new MalformedStoredOperationError(`Operation ${field} is invalid.`);
    }
  }
  if (record.maxOperationLifetimeAt !== undefined &&
      (typeof record.maxOperationLifetimeAt !== "string" || !Number.isFinite(Date.parse(record.maxOperationLifetimeAt)))) {
    throw new MalformedStoredOperationError("Operation maxOperationLifetimeAt is invalid.");
  }

  const expectedItems = record.expectedItems as string[];
  if (expectedItems.length > MAX_OPERATION_ITEMS) {
    throw new MalformedStoredOperationError(`Operation exceeds the ${MAX_OPERATION_ITEMS}-item limit.`);
  }
  if (new Set(expectedItems).size !== expectedItems.length) {
    throw new MalformedStoredOperationError("Operation contains duplicate expected item IDs.");
  }
  if (record.compactResults.length > expectedItems.length) {
    throw new MalformedStoredOperationError("Operation contains too many compact results.");
  }

  const expected = new Set(expectedItems);
  const itemStateKeys = Object.keys(record.itemStates);
  if (itemStateKeys.length !== expected.size || itemStateKeys.some((itemKey) => !expected.has(itemKey))) {
    throw new MalformedStoredOperationError("Operation item states do not exactly cover expected items.");
  }
  for (const itemKey of expectedItems) {
    const item = record.itemStates[itemKey];
    if (
      !isRecordObject(item) ||
      item.itemKey !== itemKey ||
      typeof item.idempotencyKey !== "string" || !item.idempotencyKey ||
      !VALID_OPERATION_ITEM_STAGES.has(item.stage as OperationItemStage) ||
      typeof item.writeAttempted !== "boolean" ||
      typeof item.writeMayHaveSucceeded !== "boolean" ||
      typeof item.partialWrite !== "boolean" ||
      !isFiniteNonnegativeInteger(item.retryCount)
    ) {
      throw new MalformedStoredOperationError(`Operation item state is invalid: ${itemKey}.`);
    }
  }

  for (const [field, candidate] of [
    ["partialWriteCount", record.partialWriteCount],
    ["ambiguousWriteCount", record.ambiguousWriteCount],
    ["continuationCount", record.continuationCount],
  ] as const) {
    if (!isFiniteNonnegativeInteger(candidate)) {
      throw new MalformedStoredOperationError(`Operation ${field} is invalid.`);
    }
  }
  if (containsForbiddenPersistedContent(record)) {
    throw new MalformedStoredOperationError("Operation contains prohibited customer content.");
  }
  if (serializedBytes(record) > MAX_SERIALIZED_OPERATION_BYTES) {
    throw new MalformedStoredOperationError(
      `Operation exceeds the ${MAX_SERIALIZED_OPERATION_BYTES}-byte serialized limit.`
    );
  }
}
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

function isTerminalOperation(record: OperationLedgerRecord): boolean {
  return record.state === "Completed" ||
    record.state === "CompletedWithFailures" ||
    record.state === "Failed" ||
    record.state === "Cancelled";
}

/**
 * Retention applies only after an operation has reached a terminal state. In
 * particular, an overdue non-terminal record is retained so that a possible
 * write is never discarded before it can be reconciled by the continuation
 * adapter. While an operation is active, `expiresAt` preserves the configured
 * retention duration. The expiry is restarted when the operation first
 * becomes terminal so a long-running operation cannot immediately lose its
 * final or possible-write evidence.
 */
function isExpiredTerminalOperation(record: OperationLedgerRecord, now = nowIso()): boolean {
  return isTerminalOperation(record) &&
    Number.isFinite(Date.parse(record.expiresAt)) &&
    Date.parse(record.expiresAt) <= Date.parse(now);
}

const DEFAULT_TERMINAL_RETENTION_MS = 86_400_000;
const MIN_TERMINAL_RETENTION_MS = 60_000;
const MAX_TERMINAL_RETENTION_MS = 31_536_000_000;

function terminalRetentionDurationMs(record: OperationLedgerRecord): number {
  const configuredDuration = Date.parse(record.expiresAt) - Date.parse(record.createdAt);
  if (!Number.isFinite(configuredDuration) || configuredDuration <= 0) {
    return DEFAULT_TERMINAL_RETENTION_MS;
  }
  return Math.min(
    MAX_TERMINAL_RETENTION_MS,
    Math.max(MIN_TERMINAL_RETENTION_MS, configuredDuration)
  );
}

function startTerminalRetention(
  previous: OperationLedgerRecord,
  next: OperationLedgerRecord,
  now = nowIso()
): OperationLedgerRecord {
  if (isTerminalOperation(previous) || !isTerminalOperation(next)) return next;
  return {
    ...next,
    expiresAt: new Date(
      Date.parse(now) + terminalRetentionDurationMs(previous)
    ).toISOString(),
  };
}

/** A retained operation is not necessarily still authorised to write. */
function expireOperationLifetime(record: OperationLedgerRecord, now: string): OperationLedgerRecord {
  if (isTerminalOperation(record) || !record.maxOperationLifetimeAt || record.maxOperationLifetimeAt > now) return record;
  const next = cloneRecord(record);
  for (const itemKey of next.expectedItems) {
    const item = next.itemStates[itemKey];
    if (!item || TERMINAL_STAGES.has(item.stage)) continue;
    next.itemStates[itemKey] = {
      ...item,
      stage: item.writeMayHaveSucceeded ? "AmbiguousWriteUnresolved" : "FailedBeforeWrite",
      ambiguousWrite: item.writeMayHaveSucceeded || item.ambiguousWrite,
      partialWrite: item.partialWrite || item.writeMayHaveSucceeded,
      errorClass: "ContinuationFailure",
      failureReason: "Operation maximum lifetime exceeded before the item reached a terminal state.",
      lease: undefined,
    };
  }
  next.currentLease = undefined;
  next.nextEligibleTime = undefined;
  next.terminalFailureReason = "Operation maximum lifetime exceeded.";
  next.updatedAt = now;
  return normalizeOperationRecord(next);
}

function assertRecordOwner(record: OperationLedgerRecord, ownerHash: string): void {
  if (record.ownerHash !== ownerHash) {
    throw new Error("Operation was not found or is not visible to this caller.");
  }
}
const EXPLICIT_STAGE_TRANSITIONS: Partial<Record<OperationItemStage, ReadonlySet<OperationItemStage>>> = {
  Pending: new Set(["Validating", "Validated", "WriteNotStarted", "NoteChecked", "Rescheduled", "RateLimitedRescheduled"]),
  Unattempted: new Set(["Validating", "Validated", "WriteNotStarted", "NoteChecked", "Rescheduled", "RateLimitedRescheduled"]),
  Validating: new Set(["Validated", "WriteNotStarted"]),
  Validated: new Set(["WriteNotStarted", "WriteStarted", "ResolutionValidated", "ResolutionWriteStarted", "Verifying"]),
  WriteNotStarted: new Set(["WriteStarted", "Verifying"]),
  WriteStarted: new Set(["FieldsUpdated", "StatusUpdated", "ResolutionValidated", "ResolutionWriteStarted", "NoteChecked", "NoteWriteStarted", "Verifying", "WriteAmbiguous", "RateLimitedRescheduled"]),
  WriteAmbiguous: new Set(["Verifying"]),
  FieldsUpdated: new Set(["StatusUpdated", "ResolutionValidated", "ResolutionWriteStarted", "NoteChecked", "Verifying"]),
  ResolutionValidated: new Set(["ResolutionWriteStarted", "Verifying"]),
  ResolutionWriteStarted: new Set(["ResolutionWriteSucceeded", "ResolutionWriteAmbiguous", "ResolutionVerified", "RateLimitedRescheduled"]),
  ResolutionWriteSucceeded: new Set(["ResolutionVerified", "NoteChecked", "NoteWriteStarted", "Verifying"]),
  ResolutionWriteAmbiguous: new Set(["ResolutionVerified", "Verifying"]),
  ResolutionVerified: new Set(["NoteChecked", "NoteWriteStarted", "Verifying"]),
  StatusUpdated: new Set(["NoteChecked", "Verifying"]),
  NoteChecked: new Set(["NoteWriteStarted", "NoteAdded", "Verifying"]),
  NoteWriteStarted: new Set(["NoteAdded", "NoteWriteAmbiguous", "Verifying", "RateLimitedRescheduled"]),
  NoteWriteAmbiguous: new Set(["Verifying"]),
  NoteAdded: new Set(["Verifying"]),
  Verifying: new Set(["NoteChecked"]),
  RateLimited: new Set(["RateLimitedRetrying", "RateLimitedRescheduled"]),
  RateLimitedRetrying: new Set(["RateLimitedRescheduled"]),
  RateLimitedRescheduled: new Set(["Validating", "Validated", "WriteNotStarted", "WriteStarted", "WriteAmbiguous", "ResolutionValidated", "ResolutionWriteStarted", "NoteChecked", "NoteWriteStarted", "Verifying"]),
  Rescheduled: new Set(["Validating", "Validated", "WriteNotStarted", "WriteStarted", "WriteAmbiguous", "NoteChecked", "Verifying"]),
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

/**
 * A mutation-start checkpoint is the one deliberately narrow exception to the
 * normal lifecycle graph. A continuation can be resumed before it has stored
 * its local validation milestones, but it still must make the possible-write
 * boundary durable before it sends the mutation. Keep this exception confined
 * to the leased checkpoint API: completing an item cannot skip ahead to
 * WriteStarted and release its lease.
 */
function assertCheckpointTransition(current: OperationItemStage, next: OperationItemStage): void {
  if ((current === "Pending" || current === "Unattempted") && next === "WriteStarted") {
    return;
  }
  assertTransition(current, next);
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
    if (item.ambiguousWrite || item.stage === "WriteAmbiguous" || item.stage === "ResolutionWriteAmbiguous" || item.stage === "AmbiguousWriteUnresolved") {
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
      // A terminal ledger is successful only when every item ended without a
      // failure-class outcome. Scheduling/wake completion alone is never a
      // success signal.
      const hasFailureClassOutcome = failed.length > 0 || stale.length > 0 ||
        partialWriteCount > 0 || ambiguousWriteCount > 0;
      next.state = hasFailureClassOutcome ? "CompletedWithFailures" : "Completed";
      delete next.nextEligibleTime;
      delete next.currentLease;
    } else if (next.state === "Completed" || next.state === "CompletedWithFailures") {
      next.state = next.nextEligibleTime ? "Rescheduled" : "Running";
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
  record = expireOperationLifetime(record, now);
  if (isTerminalOperation(record)) return { record };
  if (Object.values(record.itemStates).some((item) => isLeaseActive(item.lease, now))) {
    return { record: normalizeOperationRecord(record) };
  }
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
  const definedPatch = Object.fromEntries(
    Object.entries(params.patch).filter(([, value]) => value !== undefined)
  ) as typeof params.patch;
  const item: OperationItemState = {
    ...current,
    ...definedPatch,
    itemKey: current.itemKey,
    idempotencyKey: current.idempotencyKey,
    completedAt: TERMINAL_STAGES.has(params.patch.stage) ? nowIso() : current.completedAt,
  };
  delete item.lease;
  record.itemStates[params.itemKey] = item;
  if (record.currentLease?.leaseId === current.lease?.leaseId) {
    record.currentLease = undefined;
  }

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

function applyItemCheckpoint(
  record: OperationLedgerRecord,
  params: OperationCheckpointItemParams
): OperationLedgerRecord {
  const current = record.itemStates[params.itemKey];
  if (!current) throw new Error(`Operation item not found: ${params.itemKey}`);
  if (current.lease?.leaseId !== params.leaseId) {
    throw new Error(`Operation item lease mismatch: ${params.itemKey}`);
  }
  assertCheckpointTransition(current.stage, params.patch.stage);
  if (current.writeAttempted && params.patch.writeAttempted === false) {
    throw new Error(`Operation item writeAttempted cannot be reset: ${params.itemKey}`);
  }
  if (current.writeMayHaveSucceeded && params.patch.writeMayHaveSucceeded === false) {
    throw new Error(`Operation item writeMayHaveSucceeded cannot be reset: ${params.itemKey}`);
  }
  const definedPatch = Object.fromEntries(
    Object.entries(params.patch).filter(([, value]) => value !== undefined)
  ) as typeof params.patch;
  record.itemStates[params.itemKey] = {
    ...current, ...definedPatch, itemKey: current.itemKey,
    idempotencyKey: current.idempotencyKey, lease: current.lease,
  };
  record.currentItem = params.itemKey;
  record.updatedAt = nowIso();
  return normalizeOperationRecord(record);
}

class MemoryOperationStore implements OperationStore {
  async put(record: OperationLedgerRecord): Promise<void> {
    assertOperationRecord(record);
    const normalized = startTerminalRetention(record, normalizeOperationRecord(record));
    assertOperationRecord(normalized);
    memoryRecords.set(record.operationId, normalized);
  }

  async get(operationId: string): Promise<OperationLedgerRecord | undefined> {
    const record = memoryRecords.get(operationId);
    if (record && isExpiredTerminalOperation(record)) {
      memoryRecords.delete(operationId);
      return undefined;
    }
    return record ? cloneRecord(record) : undefined;
  }

  async list(ownerHash: string): Promise<OperationLedgerRecord[]> {
    for (const [operationId, record] of memoryRecords) {
      if (isExpiredTerminalOperation(record)) memoryRecords.delete(operationId);
    }
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
    const existing = await this.get(operationId);
    if (!existing) throw new Error(`Operation not found: ${operationId}`);
    assertRecordOwner(existing, ownerHash);
    const updated = startTerminalRetention(
      existing,
      normalizeOperationRecord(updater(cloneRecord(existing)))
    );
    updated.updatedAt = nowIso();
    assertOperationRecord(updated);
    memoryRecords.set(operationId, updated);
    return cloneRecord(updated);
  }

  async claimNextItem(params: OperationClaimNextParams): Promise<OperationItemClaim | undefined> {
    const existing = await this.get(params.operationId);
    if (!existing) return undefined;
    assertRecordOwner(existing, params.ownerHash);
    const { record, claim } = claimNextItemInRecord(cloneRecord(existing), params);
    const retainedRecord = startTerminalRetention(existing, record);
    memoryRecords.set(params.operationId, retainedRecord);
    return claim;
  }

  async completeItem(params: OperationCompleteItemParams): Promise<OperationLedgerRecord> {
    return this.update(params.operationId, params.ownerHash, (record) => applyItemPatch(record, params));
  }

  async checkpointItem(params: OperationCheckpointItemParams): Promise<OperationLedgerRecord> {
    return this.update(params.operationId, params.ownerHash, (record) => applyItemCheckpoint(record, params));
  }
  async scheduleContinuation(params: OperationScheduleContinuationParams): Promise<OperationLedgerRecord> {
    return this.update(params.operationId, params.ownerHash, (record) => {
      const alreadyScheduledFor = record.nextEligibleTime === params.nextEligibleTime &&
        record.schedulingSucceeded === true;
      record.state = params.nextEligibleTime ? "Rescheduled" : "ContinuationRequired";
      record.nextEligibleTime = params.nextEligibleTime;
      record.workflowId = params.workflowId ?? record.workflowId;
      record.terminalFailureReason = params.reason;
      // Re-delivery of the same scheduling request is expected. It must not
      // manufacture another continuation identity or inflate retry limits.
      if (!alreadyScheduledFor) record.continuationCount += 1;
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
    assertOperationRecord(record);
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
    const record = await response.json();
    assertOperationRecord(record);
    return record;
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
    const records = await response.json();
    if (!Array.isArray(records)) throw new MalformedStoredOperationError();
    records.forEach(assertOperationRecord);
    return records;
  }

  async update(
    operationId: string,
    ownerHash: string,
    updater: (record: OperationLedgerRecord) => OperationLedgerRecord
  ): Promise<OperationLedgerRecord> {
    const existing = await this.get(operationId);
    if (!existing) throw new Error(`Operation not found: ${operationId}`);
    assertRecordOwner(existing, ownerHash);
    const updated = startTerminalRetention(
      existing,
      normalizeOperationRecord(updater(existing))
    );
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

  async checkpointItem(params: OperationCheckpointItemParams): Promise<OperationLedgerRecord> {
    const response = await operationStoreFetch(
      "operationStore.checkpointItem",
      this.stub(params.operationId),
      new Request(`https://operation.local/operations/${params.operationId}/checkpoint-item`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      })
    );
    if (!response.ok) throw new Error(`Operation store checkpoint failed: ${response.status}`);
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
  return stableHash(
    value.normalize("NFKC").replace(/\r\n?/g, "\n").trim().replace(/\s+/gu, " ").toLowerCase()
  );
}

/**
 * Build the public operation totals from the authoritative per-item ledger.
 * `summary` is an initial response convenience only and must never determine
 * whether a durable operation is complete or successful.
 */
export function operationTotals(record: OperationLedgerRecord): Record<string, number> {
  const totals = {
    expected: record.expectedItems.length,
    completed: 0,
    updated: 0,
    resolved: 0,
    noteOnly: 0,
    completedAfterRetry: 0,
    completedAfterAmbiguousVerification: 0,
    skipped: 0,
    validationFailed: 0,
    stale: 0,
    failed: 0,
    partialWrite: 0,
    ambiguousUnresolved: 0,
    pending: 0,
    unattempted: 0,
    waitingForRateLimit: 0,
    rateLimitExceeded: 0,
  };

  for (const itemKey of record.expectedItems) {
    const item = record.itemStates[itemKey];
    if (!item) {
      totals.pending += 1;
      continue;
    }
    if (item.partialWrite) totals.partialWrite += 1;
    if (item.outcome === "Updated") totals.updated += 1;
    if (item.outcome === "Resolved") totals.resolved += 1;
    if (item.outcome === "Updated" && item.mutationType === "note") totals.noteOnly += 1;
    if (item.stage === "CompletedAfterRetry") totals.completedAfterRetry += 1;
    if (item.stage === "CompletedAfterAmbiguousWriteVerification") {
      totals.completedAfterAmbiguousVerification += 1;
    }
    if (item.stage === "AmbiguousWriteUnresolved") totals.ambiguousUnresolved += 1;
    if (item.stage === "RateLimitExceeded") totals.rateLimitExceeded += 1;
    if (RATE_LIMIT_STAGES.has(item.stage) && item.stage !== "RateLimitExceeded") {
      totals.waitingForRateLimit += 1;
    }
    if (item.stage === "Unattempted") {
      totals.unattempted += 1;
      totals.pending += 1;
    } else if (item.stage === "Stale" || item.stage === "StaleAfterRateLimitWait") {
      totals.stale += 1;
    } else if (SKIPPED_STAGES.has(item.stage)) {
      totals.skipped += 1;
    } else if (FAILED_STAGES.has(item.stage)) {
      totals.failed += 1;
      if (item.errorClass === "ValidationFailure") totals.validationFailed += 1;
    } else if (TERMINAL_STAGES.has(item.stage)) {
      totals.completed += 1;
    } else {
      totals.pending += 1;
    }
  }
  return totals;
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
    waitingForRateLimitCount: record.rateLimitedItems.length,
    rateLimitedItems: record.rateLimitedItems,
    nextEligibleTime: record.nextEligibleTime,
    continuationCount: record.continuationCount,
    terminalFailureReason: record.terminalFailureReason,
    workflowId: record.workflowId,
    totals: operationTotals(record),
    summary: record.summary,
    results: record.compactResults,
  };
}

export class SuperOpsOperationLedger {
  constructor(private readonly state: DurableObjectState, private readonly env: DurableContinuationEnv = {}) {}

  private workflowEnabled(): boolean {
    return this.env.SUPEROPS_CONTINUATION_ENABLED === "true" &&
      this.env.SUPEROPS_DURABLE_RETRY_ENABLED === "true" &&
      typeof this.env.SUPEROPS_CONTINUATION_WORKFLOW?.createBatch === "function";
  }

  private maxSchedulingAttempts(): number {
    const parsed = Number(this.env.SUPEROPS_EXECUTION_MAX_SCHEDULING_ATTEMPTS);
    return Number.isFinite(parsed) ? Math.min(100, Math.max(1, Math.trunc(parsed))) : 8;
  }

  private async setRecordAlarm(record: OperationLedgerRecord): Promise<void> {
    // Alarms are reserved for retention cleanup. Long continuation waits use
    // Cloudflare Workflows in the pinned runtime, never an alarm wake callback.
    if (typeof this.state.storage.setAlarm !== "function" || !isTerminalOperation(record)) return;
    const expiry = Date.parse(record.expiresAt);
    if (Number.isFinite(expiry)) await this.state.storage.setAlarm(expiry);
  }

  private terminalizeSchedulingFailure(
    record: OperationLedgerRecord,
    reason: string,
    now: string
  ): OperationLedgerRecord {
    const next = cloneRecord(record);
    for (const itemKey of next.expectedItems) {
      const item = next.itemStates[itemKey];
      if (!item || TERMINAL_STAGES.has(item.stage)) continue;
      const possibleWrite = item.writeMayHaveSucceeded && item.observedMutationResult !== "Rejected";
      next.itemStates[itemKey] = {
        ...item,
        stage: possibleWrite ? "AmbiguousWriteUnresolved" : "FailedBeforeWrite",
        outcome: possibleWrite ? "AmbiguousWriteRequiresReconciliation" : "ContinuationSchedulingFailed",
        ambiguousWrite: possibleWrite || item.ambiguousWrite,
        partialWrite: possibleWrite || item.partialWrite,
        errorClass: "ContinuationSchedulingFailure",
        failureReason: reason,
        lease: undefined,
      };
    }
    next.currentLease = undefined;
    next.nextEligibleTime = undefined;
    next.schedulingAttempted = true;
    next.schedulingSucceeded = false;
    next.schedulingError = reason;
    next.terminalFailureReason = reason;
    next.updatedAt = now;
    return normalizeOperationRecord(next);
  }

  private async scheduleDurableWake(record: OperationLedgerRecord): Promise<OperationLedgerRecord> {
    if (!record.nextEligibleTime) return record;
    const now = new Date().toISOString();
    const wakeAt = Date.parse(record.nextEligibleTime);
    if (!Number.isFinite(wakeAt)) {
      return this.terminalizeSchedulingFailure(record, "Invalid durable continuation wake time.", now);
    }
    if (!this.workflowEnabled()) {
      return this.terminalizeSchedulingFailure(
        record,
        "Durable continuation Workflow is disabled or unavailable.",
        now
      );
    }

    const scheduleIdentity = `wf-${stableHash({
      operationId: record.operationId,
      continuationCount: record.continuationCount,
      nextEligibleTime: record.nextEligibleTime,
    })}`;
    if (
      record.continuationMechanism === "workflow" &&
      record.continuationInstanceId === scheduleIdentity &&
      record.schedulingSucceeded === true
    ) return record;

    let attempt = record.schedulingAttemptCount ?? 0;
    let lastError = "Workflow scheduling failed.";
    while (attempt < this.maxSchedulingAttempts()) {
      attempt += 1;
      try {
        await this.env.SUPEROPS_CONTINUATION_WORKFLOW!.createBatch([{
          id: scheduleIdentity,
          params: {
            operationId: record.operationId,
            ownerHash: record.ownerHash,
            nextEligibleTime: record.nextEligibleTime,
            scheduleIdentity,
          },
        }]);
        return {
          ...record,
          workflowId: scheduleIdentity,
          continuationMechanism: "workflow",
          continuationInstanceId: scheduleIdentity,
          schedulingAttempted: true,
          schedulingSucceeded: true,
          schedulingError: undefined,
          schedulingAttemptCount: attempt,
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : lastError;
        if (attempt < this.maxSchedulingAttempts()) {
          const backoffMs = Math.min(500, 25 * (2 ** (attempt - 1)));
          await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));
        }
      }
    }
    return this.terminalizeSchedulingFailure(
      { ...record, schedulingAttemptCount: attempt },
      `Workflow scheduling exhausted: ${lastError}`,
      now
    );
  }

  async alarm(): Promise<void> {
    const records = await this.state.storage.list<OperationLedgerRecord>({ prefix: "op:" });
    const now = new Date().toISOString();
    for (const [key, record] of records) {
      if (isExpiredTerminalOperation(record, now)) {
        await this.state.storage.delete(key);
      } else if (isTerminalOperation(record)) {
        await this.setRecordAlarm(record);
      }
    }
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const operationMatch = url.pathname.match(/^\/operations\/([^/]+)$/);
    const operationActionMatch = url.pathname.match(/^\/operations\/([^/]+)\/(claim-next|complete-item|checkpoint-item|schedule-continuation)$/);

    if (request.method === "PUT" && operationMatch) {
      try {
        const candidate = await request.json();
        assertOperationRecord(candidate);
        if (candidate.operationId !== operationMatch[1]) {
          throw new MalformedStoredOperationError("Operation ID does not match its storage key.");
        }
        const record = startTerminalRetention(candidate, normalizeOperationRecord(candidate));
        assertOperationRecord(record);
        await this.state.storage.put(`op:${operationMatch[1]}`, record);
        await this.setRecordAlarm(record);
        return json({ ok: true });
      } catch (error) {
        if (error instanceof MalformedStoredOperationError) {
          return json({ errorClass: "MalformedStoredOperation", error: error.message }, 422);
        }
        throw error;
      }
    }

    if (request.method === "GET" && operationMatch) {
      const key = `op:${operationMatch[1]}`;
      const record = await this.state.storage.get<OperationLedgerRecord>(key);
      if (record) {
        try {
          assertOperationRecord(record);
        } catch (error) {
          return json({
            errorClass: "MalformedStoredOperation",
            error: error instanceof Error ? error.message : "Stored operation is malformed.",
          }, 500);
        }
      }
      if (record && isExpiredTerminalOperation(record)) {
        await this.state.storage.delete(key);
        return json({ error: "Not found" }, 404);
      }
      return record ? json(record) : json({ error: "Not found" }, 404);
    }

    if (request.method === "POST" && operationActionMatch) {
      const [, operationId, action] = operationActionMatch;
      const key = `op:${operationId}`;
      const record = await this.state.storage.get<OperationLedgerRecord>(key);
      if (!record) return json({ error: "Not found" }, 404);
      try {
        assertOperationRecord(record);
      } catch (error) {
        return json({
          errorClass: "MalformedStoredOperation",
          error: error instanceof Error ? error.message : "Stored operation is malformed.",
        }, 500);
      }
      if (isExpiredTerminalOperation(record)) {
        await this.state.storage.delete(key);
        return json({ error: "Not found" }, 404);
      }

      if (action === "claim-next") {
        const params = (await request.json()) as OperationClaimNextParams;
        assertRecordOwner(record, params.ownerHash);
        const claimed = claimNextItemInRecord(cloneRecord(record), params);
        const retainedRecord = startTerminalRetention(record, claimed.record);
        await this.state.storage.put(key, retainedRecord);
        await this.setRecordAlarm(retainedRecord);
        return claimed.claim ? json(claimed.claim) : new Response(null, { status: 204 });
      }

      if (action === "complete-item") {
        const params = (await request.json()) as OperationCompleteItemParams;
        assertRecordOwner(record, params.ownerHash);
        const updated = startTerminalRetention(
          record,
          applyItemPatch(cloneRecord(record), params)
        );
        await this.state.storage.put(key, updated);
        await this.setRecordAlarm(updated);
        return json(updated);
      }

      if (action === "checkpoint-item") {
        const params = (await request.json()) as OperationCheckpointItemParams;
        assertRecordOwner(record, params.ownerHash);
        const updated = startTerminalRetention(
          record,
          applyItemCheckpoint(cloneRecord(record), params)
        );
        await this.state.storage.put(key, updated);
        await this.setRecordAlarm(updated);
        return json(updated);
      }

      if (action === "schedule-continuation") {
        const params = (await request.json()) as OperationScheduleContinuationParams;
        assertRecordOwner(record, params.ownerHash);
        const alreadyScheduledFor = record.nextEligibleTime === params.nextEligibleTime &&
          record.schedulingSucceeded === true;
        const updated = normalizeOperationRecord({
          ...cloneRecord(record),
          state: params.nextEligibleTime ? "Rescheduled" : "ContinuationRequired",
          nextEligibleTime: params.nextEligibleTime,
          workflowId: params.workflowId ?? record.workflowId,
          terminalFailureReason: params.reason,
          continuationCount: alreadyScheduledFor ? record.continuationCount : record.continuationCount + 1,
          updatedAt: nowIso(),
        });
        const scheduled = startTerminalRetention(
          record,
          await this.scheduleDurableWake(updated)
        );
        await this.state.storage.put(key, scheduled);
        await this.setRecordAlarm(scheduled);
        return json(scheduled);
      }
    }

    if (request.method === "GET" && url.pathname === "/operations") {
      const ownerHash = url.searchParams.get("ownerHash");
      const records = await this.state.storage.list<OperationLedgerRecord>({
        prefix: "op:",
      });
      const retained: OperationLedgerRecord[] = [];
      for (const [key, record] of records) {
        try {
          assertOperationRecord(record);
        } catch {
          continue;
        }
        if (isExpiredTerminalOperation(record)) {
          await this.state.storage.delete(key);
        } else {
          retained.push(record);
        }
      }
      const filtered = retained.filter((record) => !ownerHash || record.ownerHash === ownerHash);
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
