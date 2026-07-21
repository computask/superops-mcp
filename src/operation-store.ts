import { AsyncLocalStorage } from "node:async_hooks";
import { getAuditContext, sanitizeText } from "./audit.js";
import {
  ExecutionBudgetExceededError,
  ExecutionCpuBudgetExceededError,
  ExecutionTimeoutBudgetExceededError,
  getExecutionState,
  recordSubrequestFinish,
  recordTypedSubrequestStart,
} from "./execution.js";

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
  source?: "retry-after" | "backoff";
  attempts: number;
  suppliedDelayMs?: number;
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
  mutationStartStage?: "WriteStarted" | "ResolutionWriteStarted" | "NoteWriteStarted";
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
  wakeDeliveryError?: string;
  wakeDeliveryExhaustedAt?: string;
  lastInvocationId?: string;
  staleItems?: string[];
}

export interface ApprovedPrivateNoteContent {
  itemKey: string;
  fingerprint: string;
  content: string;
  privacyType: "PRIVATE";
}

export interface OperationPutOptions {
  approvedPrivateNotes?: ApprovedPrivateNoteContent[];
}

export interface OperationTerminalFailureParams {
  operationId: string;
  ownerHash: string;
  errorClass: "ContinuationSchedulingFailure" | "ContinuationExecutionFailure" | "OperationStoreFailure";
  outcome: "ContinuationSchedulingFailed" | "ContinuationDeliveryFailed" | "OperationStoreFailed";
  reason: string;
  schedulingFailure?: boolean;
  deliveryFailure?: boolean;
  now?: string;
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
  put(record: OperationLedgerRecord, options?: OperationPutOptions): Promise<void>;
  get(operationId: string, ownerHash?: string): Promise<OperationLedgerRecord | undefined>;
  list(ownerHash: string): Promise<Record<string, unknown>[]>;
  getApprovedPrivateNote(
    operationId: string,
    ownerHash: string,
    itemKey: string,
    fingerprint: string
  ): Promise<string | undefined>;
  update(
    operationId: string,
    ownerHash: string,
    updater: (record: OperationLedgerRecord) => OperationLedgerRecord
  ): Promise<OperationLedgerRecord>;
  claimNextItem(params: OperationClaimNextParams): Promise<OperationItemClaim | undefined>;
  completeItem(params: OperationCompleteItemParams): Promise<OperationLedgerRecord>;
  checkpointItem(params: OperationCheckpointItemParams): Promise<OperationLedgerRecord>;
  scheduleContinuation(params: OperationScheduleContinuationParams): Promise<OperationLedgerRecord>;
  terminalizeContinuationFailure(params: OperationTerminalFailureParams): Promise<OperationLedgerRecord>;
}

interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

interface DurableObjectStorage {
    get<T = unknown>(key: string): Promise<T | undefined>;
    put<T = unknown>(key: string, value: T): Promise<void>;
    delete(key: string): Promise<boolean>;
    list<T = unknown>(options?: { prefix?: string }): Promise<Map<string, T>>;
    setAlarm?(scheduledTime: number | Date): Promise<void>;
    getAlarm?(): Promise<number | null>;
}

interface DurableObjectState {
  storage: DurableObjectStorage;
}

interface DurableContinuationEnv {
  SUPEROPS_CONTINUATION_WORKFLOW?: {
    createBatch(options: Array<{ id: string; params: Record<string, unknown> }>): Promise<Array<{ id: string }>>;
  };
  SUPEROPS_CONTINUATION_ENABLED?: string;
  SUPEROPS_DURABLE_RETRY_ENABLED?: string;
  SUPEROPS_EXECUTION_MAX_SCHEDULING_ATTEMPTS?: string;
  SUPEROPS_INTERNAL_CONTINUATION_TOKEN?: string;
  SUPEROPS_PRIVATE_NOTE_ENCRYPTION_KEY?: string;
}

export interface OperationStoreEnv {
  SUPEROPS_OPERATION_LEDGER?: unknown;
}

const STORE_CONTEXT = new AsyncLocalStorage<OperationStore>();
const memoryRecords = new Map<string, OperationLedgerRecord>();
const memoryApprovedPrivateNotes = new Map<string, ApprovedPrivateNoteContent>();
const MAX_OPERATION_ITEMS = 500;
const MAX_SERIALIZED_OPERATION_BYTES = 512 * 1024;
const MAX_APPROVED_PRIVATE_NOTE_BYTES = 128 * 1024;
const MAX_RECENT_OPERATION_INDEX_ENTRIES = 50;
const MAX_RECENT_OPERATION_RESULTS = 20;
const MAX_RECENT_OPERATION_OUTPUT_BYTES = 128 * 1024;

interface RecentOperationIndexEntry {
  version: 1;
  operationId: string;
  ownerHash: string;
  updatedAt: string;
  expiresAt: string;
  state: OperationState;
}

interface StoredApprovedPrivateNote {
  version: 1;
  fingerprint: string;
  privacyType: "PRIVATE";
  iv: string;
  ciphertext: string;
}

export class MalformedStoredOperationError extends Error {
  constructor(message = "Stored operation is malformed or exceeds configured bounds.") {
    super(message);
    this.name = "MalformedStoredOperationError";
  }
}

class PrivateNoteEncryptionUnavailableError extends Error {
  constructor() {
    super("Secure approved private-note persistence is unavailable.");
    this.name = "PrivateNoteEncryptionUnavailableError";
  }
}

function serializedBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function approvedPrivateNoteKey(operationId: string, itemKey: string): string {
  return "private-note:" + operationId + ":" + itemKey;
}

function recentOperationKey(operationId: string): string {
  return "recent:" + operationId;
}

function recentOperationEntry(record: OperationLedgerRecord): RecentOperationIndexEntry {
  return {
    version: 1,
    operationId: record.operationId,
    ownerHash: record.ownerHash,
    updatedAt: record.updatedAt,
    expiresAt: record.expiresAt,
    state: record.state,
  };
}

function isRecentOperationIndexEntry(value: unknown): value is RecentOperationIndexEntry {
  if (!isRecordObject(value)) return false;
  return value.version === 1 &&
    typeof value.operationId === "string" && Boolean(value.operationId) &&
    typeof value.ownerHash === "string" && Boolean(value.ownerHash) &&
    typeof value.updatedAt === "string" && Number.isFinite(Date.parse(value.updatedAt)) &&
    typeof value.expiresAt === "string" && Number.isFinite(Date.parse(value.expiresAt)) &&
    VALID_OPERATION_STATES.has(value.state as OperationState) &&
    serializedBytes(value) <= 1024;
}

function validateApprovedPrivateNotes(
  record: OperationLedgerRecord,
  notes: ApprovedPrivateNoteContent[] | undefined
): ApprovedPrivateNoteContent[] {
  if (!notes || notes.length === 0) return [];
  if (notes.length > record.expectedItems.length) {
    throw new MalformedStoredOperationError("Too many approved private-note payloads.");
  }
  const seen = new Set<string>();
  return notes.map((note) => {
    if (
      note.privacyType !== "PRIVATE" ||
      !record.expectedItems.includes(note.itemKey) ||
      seen.has(note.itemKey) ||
      !note.content.trim() ||
      new TextEncoder().encode(note.content).byteLength > MAX_APPROVED_PRIVATE_NOTE_BYTES ||
      normalizedNoteFingerprint(note.content) !== note.fingerprint ||
      record.itemStates[note.itemKey]?.noteFingerprint !== note.fingerprint
    ) {
      throw new MalformedStoredOperationError("Approved private-note payload is invalid.");
    }
    seen.add(note.itemKey);
    return { ...note };
  });
}

function bytesToBase64(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}

function base64ToBytes(value: string): Uint8Array {
  const decoded = atob(value);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

async function approvedPrivateNoteKeyMaterial(secret: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode("superops-approved-private-note:v1:" + secret)
  );
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function approvedPrivateNoteAdditionalData(
  operationId: string,
  itemKey: string,
  fingerprint: string
): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ operationId, itemKey, fingerprint, privacyType: "PRIVATE" })
  );
}

async function encryptApprovedPrivateNote(
  secret: string,
  operationId: string,
  note: ApprovedPrivateNoteContent
): Promise<StoredApprovedPrivateNote> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: approvedPrivateNoteAdditionalData(
        operationId,
        note.itemKey,
        note.fingerprint
      ),
    },
    await approvedPrivateNoteKeyMaterial(secret),
    new TextEncoder().encode(note.content)
  );
  return {
    version: 1,
    fingerprint: note.fingerprint,
    privacyType: "PRIVATE",
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

async function decryptApprovedPrivateNote(
  secret: string,
  operationId: string,
  itemKey: string,
  stored: StoredApprovedPrivateNote
): Promise<string | undefined> {
  if (stored.version !== 1 || stored.privacyType !== "PRIVATE") return undefined;
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64ToBytes(stored.iv),
        additionalData: approvedPrivateNoteAdditionalData(
          operationId,
          itemKey,
          stored.fingerprint
        ),
      },
      await approvedPrivateNoteKeyMaterial(secret),
      base64ToBytes(stored.ciphertext)
    );
    const content = new TextDecoder().decode(plaintext);
    return normalizedNoteFingerprint(content) === stored.fingerprint ? content : undefined;
  } catch {
    return undefined;
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

const TERMINAL_CONTINUATION_ERROR_CLASSES = new Set<OperationErrorClass>([
  "ContinuationFailure",
  "ContinuationSchedulingFailure",
  "ContinuationExecutionFailure",
  "OperationStoreFailure",
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

function isTerminalOperationState(state: OperationState): boolean {
  return state === "Completed" || state === "CompletedWithFailures" ||
    state === "Failed" || state === "Cancelled";
}

function isTerminalOperation(record: OperationLedgerRecord): boolean {
  return isTerminalOperationState(record.state);
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

function terminalizeContinuationFailureInRecord(
  record: OperationLedgerRecord,
  params: OperationTerminalFailureParams
): OperationLedgerRecord {
  assertRecordOwner(record, params.ownerHash);
  const now = params.now ?? nowIso();
  if (isTerminalOperation(record)) {
    return params.deliveryFailure
      ? {
          ...cloneRecord(record),
          wakeDeliveryError: params.reason,
          wakeDeliveryExhaustedAt: now,
          updatedAt: now,
        }
      : cloneRecord(record);
  }
  const next = cloneRecord(record);
  for (const itemKey of next.expectedItems) {
    const item = next.itemStates[itemKey];
    if (!item || TERMINAL_STAGES.has(item.stage)) continue;
    const possibleWrite = item.writeMayHaveSucceeded && item.observedMutationResult !== "Rejected";
    next.itemStates[itemKey] = {
      ...item,
      stage: possibleWrite ? "AmbiguousWriteUnresolved" : "FailedBeforeWrite",
      outcome: possibleWrite ? "AmbiguousWriteRequiresReconciliation" : params.outcome,
      ambiguousWrite: possibleWrite || item.ambiguousWrite,
      partialWrite: possibleWrite || item.partialWrite,
      errorClass: item.errorClass ?? params.errorClass,
      failureReason: item.failureReason ?? params.reason,
      lease: undefined,
      completedAt: now,
    };
  }
  next.currentLease = undefined;
  next.nextEligibleTime = undefined;
  next.terminalFailureReason = params.reason;
  if (params.schedulingFailure) {
    next.schedulingAttempted = true;
    next.schedulingSucceeded = false;
    next.schedulingError = params.reason;
  }
  if (params.deliveryFailure) {
    next.wakeDeliveryError = params.reason;
    next.wakeDeliveryExhaustedAt = now;
  }
  next.updatedAt = now;
  return normalizeOperationRecord(next);
}

function deleteMemoryApprovedPrivateNotes(operationId: string): void {
  const prefix = approvedPrivateNoteKey(operationId, "");
  for (const key of memoryApprovedPrivateNotes.keys()) {
    if (key.startsWith(prefix)) memoryApprovedPrivateNotes.delete(key);
  }
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

function isConclusiveRejectedWritePatch(
  patch: OperationCompleteItemParams["patch"]
): boolean {
  return patch.reliableResponseReceived === true &&
    patch.observedMutationResult === "Rejected" &&
    patch.partialWrite !== true;
}

function itemResultKey(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const candidate = record.itemKey ?? record.ticketNumber ?? record.ticketId ?? record.displayId ?? record.alertId;
  return typeof candidate === "string" || typeof candidate === "number"
    ? String(candidate)
    : undefined;
}

function stringField(record: Record<string, unknown> | undefined, field: string): string | undefined {
  const value = record?.[field];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function compactResultForItem(
  record: OperationLedgerRecord,
  itemKey: string
): Record<string, unknown> | undefined {
  const result = record.compactResults.find((entry) => itemResultKey(entry) === itemKey);
  return isRecordObject(result) ? result : undefined;
}

function itemTerminalFailureReason(
  record: OperationLedgerRecord,
  itemKey: string
): string | undefined {
  const item = record.itemStates[itemKey];
  if (!item) return undefined;
  const compactResult = compactResultForItem(record, itemKey);
  return item.failureReason ??
    stringField(compactResult, "failureReason") ??
    stringField(compactResult, "finalReason") ??
    item.outcome ??
    stringField(compactResult, "finalOutcome") ??
    item.errorClass ??
    item.stage;
}

function hasTerminalContinuationFailure(record: OperationLedgerRecord): boolean {
  return record.expectedItems.some((itemKey) => {
    const item = record.itemStates[itemKey];
    return Boolean(
      item &&
      TERMINAL_STAGES.has(item.stage) &&
      item.errorClass &&
      TERMINAL_CONTINUATION_ERROR_CLASSES.has(item.errorClass)
    );
  });
}

function deriveTerminalFailureReason(record: OperationLedgerRecord): string | undefined {
  if (record.terminalFailureReason && hasTerminalContinuationFailure(record)) {
    return record.terminalFailureReason;
  }
  for (const itemKey of record.expectedItems) {
    const item = record.itemStates[itemKey];
    if (item && FAILED_STAGES.has(item.stage)) {
      return itemTerminalFailureReason(record, itemKey);
    }
  }
  for (const itemKey of record.expectedItems) {
    const item = record.itemStates[itemKey];
    if (item && SKIPPED_STAGES.has(item.stage)) {
      return itemTerminalFailureReason(record, itemKey);
    }
  }
  for (const itemKey of record.expectedItems) {
    const item = record.itemStates[itemKey];
    if (item?.partialWrite || item?.ambiguousWrite) {
      return itemTerminalFailureReason(record, itemKey);
    }
  }
  return record.terminalFailureReason;
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
      if (next.state === "Completed") {
        delete next.terminalFailureReason;
      } else {
        next.terminalFailureReason = deriveTerminalFailureReason(next);
      }
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
  record.lastInvocationId = getExecutionState()?.invocationId ?? params.leaseOwner;
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
  if (current.writeMayHaveSucceeded && params.patch.writeMayHaveSucceeded === false &&
      !isConclusiveRejectedWritePatch(params.patch)) {
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
  if (current.writeMayHaveSucceeded && params.patch.writeMayHaveSucceeded === false &&
      !isConclusiveRejectedWritePatch(params.patch)) {
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
  async put(record: OperationLedgerRecord, options?: OperationPutOptions): Promise<void> {
    assertOperationRecord(record);
    const approvedPrivateNotes = validateApprovedPrivateNotes(
      record,
      options?.approvedPrivateNotes
    );
    const normalized = startTerminalRetention(record, normalizeOperationRecord(record));
    assertOperationRecord(normalized);
    memoryRecords.set(record.operationId, normalized);
    if (isTerminalOperation(normalized)) {
      deleteMemoryApprovedPrivateNotes(record.operationId);
    } else {
      for (const note of approvedPrivateNotes) {
        memoryApprovedPrivateNotes.set(
          approvedPrivateNoteKey(record.operationId, note.itemKey),
          { ...note }
        );
      }
    }
  }

  async get(operationId: string, ownerHash?: string): Promise<OperationLedgerRecord | undefined> {
    const record = memoryRecords.get(operationId);
    if (record && isExpiredTerminalOperation(record)) {
      memoryRecords.delete(operationId);
      deleteMemoryApprovedPrivateNotes(operationId);
      return undefined;
    }
    if (record && ownerHash && record.ownerHash !== ownerHash) return undefined;
    return record ? cloneRecord(record) : undefined;
  }

  async list(ownerHash: string): Promise<Record<string, unknown>[]> {
    for (const [operationId, record] of memoryRecords) {
      if (isExpiredTerminalOperation(record)) {
        memoryRecords.delete(operationId);
        deleteMemoryApprovedPrivateNotes(operationId);
      }
    }
    return [...memoryRecords.values()]
      .filter((record) => record.ownerHash === ownerHash)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, MAX_RECENT_OPERATION_RESULTS)
      .map(operationRecentView);
  }

  async getApprovedPrivateNote(
    operationId: string,
    ownerHash: string,
    itemKey: string,
    fingerprint: string
  ): Promise<string | undefined> {
    const record = await this.get(operationId, ownerHash);
    if (!record) return undefined;
    assertRecordOwner(record, ownerHash);
    if (record.itemStates[itemKey]?.noteFingerprint !== fingerprint) return undefined;
    const note = memoryApprovedPrivateNotes.get(approvedPrivateNoteKey(operationId, itemKey));
    if (
      !note ||
      note.privacyType !== "PRIVATE" ||
      note.fingerprint !== fingerprint ||
      normalizedNoteFingerprint(note.content) !== fingerprint
    ) return undefined;
    return note.content;
  }

  async update(
    operationId: string,
    ownerHash: string,
    updater: (record: OperationLedgerRecord) => OperationLedgerRecord
  ): Promise<OperationLedgerRecord> {
    const existing = await this.get(operationId, ownerHash);
    if (!existing) {
      throw new Error("Operation was not found or is not visible to this caller.");
    }
    assertRecordOwner(existing, ownerHash);
    const updated = startTerminalRetention(
      existing,
      normalizeOperationRecord(updater(cloneRecord(existing)))
    );
    updated.updatedAt = nowIso();
    assertOperationRecord(updated);
    memoryRecords.set(operationId, updated);
    if (isTerminalOperation(updated)) deleteMemoryApprovedPrivateNotes(operationId);
    return cloneRecord(updated);
  }

  async claimNextItem(params: OperationClaimNextParams): Promise<OperationItemClaim | undefined> {
    const existing = await this.get(params.operationId, params.ownerHash);
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

  async terminalizeContinuationFailure(
    params: OperationTerminalFailureParams
  ): Promise<OperationLedgerRecord> {
    return this.update(params.operationId, params.ownerHash, (record) =>
      terminalizeContinuationFailureInRecord(record, params)
    );
  }
}

class DurableObjectOperationStore implements OperationStore {
  private readonly legacyOperationIds = new Set<string>();

  constructor(private readonly namespace: DurableObjectNamespace) {}

  private stub(ownerHash: string) {
    return this.namespace.get(this.namespace.idFromName("owner:" + ownerHash));
  }

  private legacyStub(operationId: string) {
    return this.namespace.get(this.namespace.idFromName(operationId));
  }

  private operationStub(operationId: string, ownerHash: string) {
    return this.legacyOperationIds.has(operationId)
      ? this.legacyStub(operationId)
      : this.stub(ownerHash);
  }

  async put(record: OperationLedgerRecord, options?: OperationPutOptions): Promise<void> {
    assertOperationRecord(record);
    validateApprovedPrivateNotes(record, options?.approvedPrivateNotes);
    const response = await operationStoreFetch(
      "operationStore.put",
      this.operationStub(record.operationId, record.ownerHash),
      new Request(`https://operation.local/operations/${record.operationId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          record,
          approvedPrivateNotes: options?.approvedPrivateNotes,
        }),
      })
    );
    if (!response.ok) {
      throw await operationStoreFailure(response, "Operation store put failed");
    }
  }

  async get(operationId: string, ownerHash?: string): Promise<OperationLedgerRecord | undefined> {
    let response = await operationStoreFetch(
      "operationStore.get",
      ownerHash ? this.stub(ownerHash) : this.legacyStub(operationId),
      new Request(`https://operation.local/operations/${operationId}`)
    );
    // Existing operation-derived records remain readable and continue in their
    // original instance. New records are always owner-scoped.
    if (response.status === 404 && ownerHash) {
      response = await operationStoreFetch(
        "operationStore.getLegacy",
        this.legacyStub(operationId),
        new Request(`https://operation.local/operations/${operationId}`)
      );
      if (response.ok) this.legacyOperationIds.add(operationId);
    }
    if (response.status === 404) return undefined;
    if (!response.ok) {
      throw await operationStoreFailure(response, "Operation store get failed");
    }
    const record = await response.json();
    assertOperationRecord(record);
    if (ownerHash && record.ownerHash !== ownerHash) return undefined;
    return record;
  }

  async list(ownerHash: string): Promise<Record<string, unknown>[]> {
    const response = await operationStoreFetch(
      "operationStore.list",
      this.stub(ownerHash),
      new Request(`https://operation.local/operations?ownerHash=${ownerHash}`)
    );
    if (!response.ok) {
      throw await operationStoreFailure(response, "Operation store list failed");
    }
    const results = await response.json();
    if (!Array.isArray(results) || serializedBytes(results) > MAX_RECENT_OPERATION_OUTPUT_BYTES) {
      throw new MalformedStoredOperationError("Recent operation results are malformed or exceed bounds.");
    }
    if (results.some((result) => !isRecordObject(result) || "ownerHash" in result)) {
      throw new MalformedStoredOperationError("Recent operation results are not redacted.");
    }
    return results as Record<string, unknown>[];
  }

  async update(
    operationId: string,
    ownerHash: string,
    updater: (record: OperationLedgerRecord) => OperationLedgerRecord
  ): Promise<OperationLedgerRecord> {
    const existing = await this.get(operationId, ownerHash);
    if (!existing) {
      throw new Error("Operation was not found or is not visible to this caller.");
    }
    assertRecordOwner(existing, ownerHash);
    const updated = startTerminalRetention(
      existing,
      normalizeOperationRecord(updater(existing))
    );
    await this.put(updated);
    return updated;
  }

  async getApprovedPrivateNote(
    operationId: string,
    ownerHash: string,
    itemKey: string,
    fingerprint: string
  ): Promise<string | undefined> {
    let response = await operationStoreFetch(
      "operationStore.getApprovedPrivateNote",
      this.operationStub(operationId, ownerHash),
      new Request(
        "https://operation.local/operations/" + operationId +
          "/approved-private-note/" + encodeURIComponent(itemKey),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ownerHash, fingerprint }),
        }
      )
    );
    if (response.status === 404) {
      response = await operationStoreFetch(
        "operationStore.getApprovedPrivateNoteLegacy",
        this.legacyStub(operationId),
        new Request(
          "https://operation.local/operations/" + operationId +
            "/approved-private-note/" + encodeURIComponent(itemKey),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ownerHash, fingerprint }),
          }
        )
      );
    }
    if (response.status === 404) return undefined;
    if (!response.ok) {
      throw await operationStoreFailure(response, "Approved private-note recovery failed");
    }
    const recovered = await response.json() as { content?: unknown };
    return typeof recovered.content === "string" ? recovered.content : undefined;
  }

  async claimNextItem(params: OperationClaimNextParams): Promise<OperationItemClaim | undefined> {
    const response = await operationStoreFetch(
      "operationStore.claimNextItem",
      this.operationStub(params.operationId, params.ownerHash),
      new Request(`https://operation.local/operations/${params.operationId}/claim-next`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      })
    );
    if (response.status === 204 || response.status === 404) return undefined;
    if (!response.ok) throw await operationStoreFailure(response, "Operation store claim failed");
    return (await response.json()) as OperationItemClaim;
  }

  async completeItem(params: OperationCompleteItemParams): Promise<OperationLedgerRecord> {
    const response = await operationStoreFetch(
      "operationStore.completeItem",
      this.operationStub(params.operationId, params.ownerHash),
      new Request(`https://operation.local/operations/${params.operationId}/complete-item`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      })
    );
    if (!response.ok) throw await operationStoreFailure(response, "Operation store complete failed");
    return (await response.json()) as OperationLedgerRecord;
  }

  async checkpointItem(params: OperationCheckpointItemParams): Promise<OperationLedgerRecord> {
    const response = await operationStoreFetch(
      "operationStore.checkpointItem",
      this.operationStub(params.operationId, params.ownerHash),
      new Request(`https://operation.local/operations/${params.operationId}/checkpoint-item`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      })
    );
    if (!response.ok) throw await operationStoreFailure(response, "Operation store checkpoint failed");
    return (await response.json()) as OperationLedgerRecord;
  }

  async scheduleContinuation(params: OperationScheduleContinuationParams): Promise<OperationLedgerRecord> {
    const response = await operationStoreFetch(
      "operationStore.scheduleContinuation",
      this.operationStub(params.operationId, params.ownerHash),
      new Request(`https://operation.local/operations/${params.operationId}/schedule-continuation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      })
    );
    if (!response.ok) throw await operationStoreFailure(response, "Operation store schedule failed");
    return (await response.json()) as OperationLedgerRecord;
  }

  async terminalizeContinuationFailure(
    params: OperationTerminalFailureParams
  ): Promise<OperationLedgerRecord> {
    const response = await operationStoreFetch(
      "operationStore.terminalizeContinuationFailure",
      this.operationStub(params.operationId, params.ownerHash),
      new Request(
        "https://operation.local/operations/" + params.operationId + "/terminalize-continuation",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params),
        }
      )
    );
    if (!response.ok) {
      throw await operationStoreFailure(response, "Operation store terminalisation failed");
    }
    return (await response.json()) as OperationLedgerRecord;
  }
}

async function operationStoreFailure(response: Response, message: string): Promise<Error> {
  try {
    const body = await response.clone().json();
    if (isRecordObject(body) && body.errorClass === "MalformedStoredOperation") {
      return new MalformedStoredOperationError(
        typeof body.error === "string" ? body.error : undefined
      );
    }
  } catch {
    // Fall through to the stable status-based error below.
  }
  return new Error(`${message}: ${response.status}`);
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

function recordWorkflowSchedulingSubrequest() {
  return recordTypedSubrequestStart({
    type: "custom",
    operationType: "workflow",
    operationName: "continuationCreateBatch",
  });
}

function isExecutionBudgetError(error: unknown): boolean {
  return error instanceof ExecutionBudgetExceededError ||
    error instanceof ExecutionTimeoutBudgetExceededError ||
    error instanceof ExecutionCpuBudgetExceededError;
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
  // Preserve the established direct-OAuth identity derivation.
  if (context.user) return stableHash(context.user);
  if (context.ownerHash) return context.ownerHash;
  if (context.ownerIdentityRequired) {
    throw new Error("Authenticated owner identity is unavailable.");
  }
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

async function cryptographicOwnerHash(value: Record<string, unknown>): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value))
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function gatewayOwnerHash(credentials: {
  apiToken: string;
  subdomain: string;
  region?: "us" | "eu";
}): Promise<string> {
  const credentialFingerprint = await cryptographicOwnerHash({
    version: 1,
    apiToken: credentials.apiToken,
  });
  return cryptographicOwnerHash({
    version: 1,
    authMode: "gateway",
    region: credentials.region ?? "us",
    tenant: credentials.subdomain.trim().toLowerCase(),
    credentialFingerprint,
  });
}

export function envTenantOwnerHash(credentials: {
  subdomain: string;
  region?: "us" | "eu";
}): Promise<string> {
  return cryptographicOwnerHash({
    version: 1,
    authMode: "env",
    region: credentials.region ?? "us",
    tenant: credentials.subdomain.trim().toLowerCase(),
  });
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
    if (isTerminalSuccessfulItem(item) && completedAfterDurableRetry(item)) {
      totals.completedAfterRetry += 1;
    }
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

function isTerminalSuccessfulItem(item: OperationItemState): boolean {
  return TERMINAL_STAGES.has(item.stage) &&
    !FAILED_STAGES.has(item.stage) &&
    !SKIPPED_STAGES.has(item.stage);
}

function completedAfterDurableRetry(item: OperationItemState): boolean {
  return item.stage === "CompletedAfterRetry" ||
    (item.attemptCount ?? 0) > 1 ||
    (item.retryCount > 0 && item.observedMutationResult !== "Rejected");
}

export function operationResultView(record: OperationLedgerRecord): Record<string, unknown> {
  return redactPublicOperationValue({
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
    lastInvocationId: record.lastInvocationId,
    totals: operationTotals(record),
    summary: record.summary,
    items: operationItemTelemetry(record),
    results: record.compactResults,
  }) as Record<string, unknown>;
}

function operationItemTelemetry(record: OperationLedgerRecord): Record<string, unknown>[] {
  const now = new Date().toISOString();
  return record.expectedItems.map((itemKey) => {
    const item = record.itemStates[itemKey];
    const retryEligible = Boolean(
      item &&
      !TERMINAL_STAGES.has(item.stage) &&
      (
        item.observedMutationResult === "Rejected" ||
        item.stage === "RateLimitedRescheduled" ||
        item.stage === "RateLimitedRetrying" ||
        item.stage === "Rescheduled" ||
        item.stage === "Unattempted"
      ) &&
      (!item.nextEligibleTime || item.nextEligibleTime <= now)
    );
    return {
      operationId: record.operationId,
      invocationId: record.lastInvocationId,
      itemId: itemKey,
      stage: item?.stage ?? "Unattempted",
      finalErrorClass: item?.errorClass,
      attemptCount: item?.attemptCount ?? 0,
      retryEligible,
      writeAttempted: item?.writeAttempted ?? false,
      writeMayHaveSucceeded: item?.writeMayHaveSucceeded ?? false,
      verificationState: item?.verificationState,
      finalReason: item?.failureReason ?? item?.outcome,
    };
  });
}

function redactPublicOperationValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[redacted]";
  if (typeof value === "string") return sanitizeText(value);
  if (Array.isArray(value)) {
    return value.slice(0, MAX_OPERATION_ITEMS).map((entry) =>
      redactPublicOperationValue(entry, depth + 1)
    );
  }
  if (!isRecordObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !FORBIDDEN_PERSISTED_CONTENT_KEYS.has(key.toLowerCase()))
      .map(([key, child]) => [key, redactPublicOperationValue(child, depth + 1)])
  );
}

function operationRecentView(record: OperationLedgerRecord): Record<string, unknown> {
  return {
    operationId: sanitizeText(record.operationId),
    toolName: sanitizeText(record.toolName),
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
    nextEligibleTime: record.nextEligibleTime,
    continuationCount: record.continuationCount,
    totals: operationTotals(record),
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
    // Alarms remain cleanup-only: active records wake only to enforce their
    // maximum processing lifetime, never to execute a SuperOps continuation.
    if (typeof this.state.storage.setAlarm !== "function") return;
    const alarmAt = Date.parse(
      isTerminalOperation(record)
        ? record.expiresAt
        : record.maxOperationLifetimeAt ?? ""
    );
    if (Number.isFinite(alarmAt)) await this.state.storage.setAlarm(alarmAt);
  }

  private async deleteApprovedPrivateNotes(
    storage: DurableObjectStorage,
    operationId: string
  ): Promise<void> {
    const prefix = approvedPrivateNoteKey(operationId, "");
    const notes = await storage.list<StoredApprovedPrivateNote>({ prefix });
    for (const key of notes.keys()) {
      if (key.startsWith(prefix)) await storage.delete(key);
    }
  }

  private async maintainRecentIndex(record: OperationLedgerRecord): Promise<void> {
    const indexKey = recentOperationKey(record.operationId);
    if (isExpiredTerminalOperation(record)) {
      await this.state.storage.delete(indexKey);
    } else {
      await this.state.storage.put(indexKey, recentOperationEntry(record));
    }

    const indexed = await this.state.storage.list<RecentOperationIndexEntry>({
      prefix: "recent:",
    });
    const retained: Array<[string, RecentOperationIndexEntry]> = [];
    for (const [key, entry] of indexed) {
      if (!key.startsWith("recent:")) continue;
      if (!isRecentOperationIndexEntry(entry) ||
          (isTerminalOperationState(entry.state) && Date.parse(entry.expiresAt) <= Date.now())) {
        await this.state.storage.delete(key);
      } else {
        retained.push([key, entry]);
      }
    }
    retained.sort((a, b) => b[1].updatedAt.localeCompare(a[1].updatedAt));
    for (const [key] of retained.slice(MAX_RECENT_OPERATION_INDEX_ENTRIES)) {
      await this.state.storage.delete(key);
    }
  }

  private async persistRecord(
    record: OperationLedgerRecord,
    approvedPrivateNotes: ApprovedPrivateNoteContent[] = []
  ): Promise<void> {
    if (approvedPrivateNotes.length === 0) {
      await this.state.storage.put("op:" + record.operationId, record);
    } else {
      const secret = this.env.SUPEROPS_PRIVATE_NOTE_ENCRYPTION_KEY?.trim();
      if (!secret) {
        throw new PrivateNoteEncryptionUnavailableError();
      }
      const encrypted = await Promise.all(approvedPrivateNotes.map(async (note) => ({
        key: approvedPrivateNoteKey(record.operationId, note.itemKey),
        value: await encryptApprovedPrivateNote(secret, record.operationId, note),
      })));
      const entries: Record<string, unknown> = {
        ["op:" + record.operationId]: record,
      };
      for (const note of encrypted) entries[note.key] = note.value;
      const atomicPut = this.state.storage.put as unknown as (
        values: Record<string, unknown>
      ) => Promise<void>;
      await atomicPut.call(this.state.storage, entries);
    }
    await this.maintainRecentIndex(record);
  }

  private terminalizeSchedulingFailure(
    record: OperationLedgerRecord,
    reason: string,
    now: string
  ): OperationLedgerRecord {
    return terminalizeContinuationFailureInRecord(record, {
      operationId: record.operationId,
      ownerHash: record.ownerHash,
      errorClass: "ContinuationSchedulingFailure",
      outcome: "ContinuationSchedulingFailed",
      reason,
      schedulingFailure: true,
      now,
    });
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
      let started: ReturnType<typeof recordWorkflowSchedulingSubrequest> | undefined;
      try {
        started = recordWorkflowSchedulingSubrequest();
        await this.env.SUPEROPS_CONTINUATION_WORKFLOW!.createBatch([{
          id: scheduleIdentity,
          params: {
            operationId: record.operationId,
            ownerHash: record.ownerHash,
            nextEligibleTime: record.nextEligibleTime,
            scheduleIdentity,
          },
        }]);
        recordSubrequestFinish(started, "workflowCreated", true);
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
        if (started) recordSubrequestFinish(started, "workflowCreateBatchError", false);
        lastError = error instanceof Error ? error.message : lastError;
        if (isExecutionBudgetError(error)) {
          return this.terminalizeSchedulingFailure(
            {
              ...record,
              schedulingAttempted: started !== undefined || record.schedulingAttempted,
              schedulingSucceeded: false,
              schedulingAttemptCount: started ? attempt : Math.max(0, attempt - 1),
            },
            `Workflow scheduling budget exhausted: ${lastError}`,
            now
          );
        }
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
    let nextAlarmAt: number | undefined;
    for (const [key, record] of records) {
      if (!key.startsWith("op:")) continue;
      if (isExpiredTerminalOperation(record, now)) {
        await this.state.storage.delete(key);
        await this.state.storage.delete(recentOperationKey(record.operationId));
        await this.deleteApprovedPrivateNotes(this.state.storage, record.operationId);
      } else if (!isTerminalOperation(record)) {
        const normalized = startTerminalRetention(
          record,
          expireOperationLifetime(record, now),
          now
        );
        if (isTerminalOperation(normalized)) {
          await this.persistRecord(normalized);
          await this.deleteApprovedPrivateNotes(this.state.storage, record.operationId);
        }
        const alarmAt = Date.parse(
          isTerminalOperation(normalized)
            ? normalized.expiresAt
            : normalized.maxOperationLifetimeAt ?? ""
        );
        if (Number.isFinite(alarmAt)) {
          nextAlarmAt = nextAlarmAt === undefined ? alarmAt : Math.min(nextAlarmAt, alarmAt);
        }
      } else {
        const alarmAt = Date.parse(record.expiresAt);
        if (Number.isFinite(alarmAt)) {
          nextAlarmAt = nextAlarmAt === undefined ? alarmAt : Math.min(nextAlarmAt, alarmAt);
        }
      }
    }
    if (nextAlarmAt !== undefined && typeof this.state.storage.setAlarm === "function") {
      await this.state.storage.setAlarm(nextAlarmAt);
    }
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathParts = url.pathname.split("/").filter(Boolean);
    const approvedPrivateNoteMatch = pathParts.length === 4 &&
      pathParts[0] === "operations" && pathParts[2] === "approved-private-note"
      ? { operationId: pathParts[1], itemKey: decodeURIComponent(pathParts[3]) }
      : undefined;
    const terminalActionMatch = pathParts.length === 3 &&
      pathParts[0] === "operations" && pathParts[2] === "terminalize-continuation"
      ? ["", pathParts[1], pathParts[2]]
      : undefined;
    const operationMatch = url.pathname.match(/^\/operations\/([^/]+)$/);
    const operationActionMatch = url.pathname.match(/^\/operations\/([^/]+)\/(claim-next|complete-item|checkpoint-item|schedule-continuation)$/);

    if (request.method === "PUT" && operationMatch) {
      try {
        const payload = await request.json();
        const wrapped = isRecordObject(payload) && isRecordObject(payload.record);
        const candidate = wrapped ? payload.record : payload;
        assertOperationRecord(candidate);
        if (candidate.operationId !== operationMatch[1]) {
          throw new MalformedStoredOperationError("Operation ID does not match its storage key.");
        }
        const record = startTerminalRetention(candidate, normalizeOperationRecord(candidate));
        assertOperationRecord(record);
        const approvedPrivateNotes = validateApprovedPrivateNotes(
          record,
          wrapped && Array.isArray(payload.approvedPrivateNotes)
            ? payload.approvedPrivateNotes as ApprovedPrivateNoteContent[]
            : undefined
        );
        await this.persistRecord(record, approvedPrivateNotes);
        if (isTerminalOperation(record)) {
          await this.deleteApprovedPrivateNotes(this.state.storage, record.operationId);
        }
        await this.setRecordAlarm(record);
        return json({ ok: true });
      } catch (error) {
        if (error instanceof MalformedStoredOperationError) {
          return json({ errorClass: "MalformedStoredOperation", error: error.message }, 422);
        }
        if (error instanceof PrivateNoteEncryptionUnavailableError) {
          return json({
            errorClass: "PrivateNoteEncryptionUnavailable",
            error: "Secure approved private-note persistence is unavailable.",
          }, 503);
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
        await this.state.storage.delete(recentOperationKey(record.operationId));
        await this.deleteApprovedPrivateNotes(this.state.storage, record.operationId);
        return json({ error: "Not found" }, 404);
      }
      return record ? json(record) : json({ error: "Not found" }, 404);
    }

    if (request.method === "POST" && approvedPrivateNoteMatch) {
      const { operationId, itemKey } = approvedPrivateNoteMatch;
      const record = await this.state.storage.get<OperationLedgerRecord>("op:" + operationId);
      if (!record) return json({ error: "Not found" }, 404);
      assertOperationRecord(record);
      const params = await request.json() as { ownerHash?: unknown; fingerprint?: unknown };
      if (typeof params.ownerHash !== "string" || typeof params.fingerprint !== "string") {
        return json({ error: "Invalid approved private-note recovery request." }, 400);
      }
      assertRecordOwner(record, params.ownerHash);
      if (record.itemStates[itemKey]?.noteFingerprint !== params.fingerprint) {
        return json({ error: "Not found" }, 404);
      }
      const stored = await this.state.storage.get<StoredApprovedPrivateNote>(
        approvedPrivateNoteKey(operationId, itemKey)
      );
      const secret = this.env.SUPEROPS_PRIVATE_NOTE_ENCRYPTION_KEY?.trim();
      if (!stored || !secret || stored.fingerprint !== params.fingerprint) {
        return json({ error: "Not found" }, 404);
      }
      const content = await decryptApprovedPrivateNote(secret, operationId, itemKey, stored);
      return content === undefined ? json({ error: "Not found" }, 404) : json({ content });
    }

    if (request.method === "POST" && (operationActionMatch || terminalActionMatch)) {
      const [, operationId, action] = operationActionMatch ?? terminalActionMatch!;
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
        await this.state.storage.delete(recentOperationKey(record.operationId));
        await this.deleteApprovedPrivateNotes(this.state.storage, record.operationId);
        return json({ error: "Not found" }, 404);
      }

      if (action === "claim-next") {
        const params = (await request.json()) as OperationClaimNextParams;
        assertRecordOwner(record, params.ownerHash);
        const claimed = claimNextItemInRecord(cloneRecord(record), params);
        const retainedRecord = startTerminalRetention(record, claimed.record);
        await this.persistRecord(retainedRecord);
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
        await this.persistRecord(updated);
        if (isTerminalOperation(updated)) {
          await this.deleteApprovedPrivateNotes(this.state.storage, operationId);
        }
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
        await this.persistRecord(updated);
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
        await this.persistRecord(scheduled);
        if (isTerminalOperation(scheduled)) {
          await this.deleteApprovedPrivateNotes(this.state.storage, operationId);
        }
        await this.setRecordAlarm(scheduled);
        return json(scheduled);
      }

      if (action === "terminalize-continuation") {
        const params = await request.json() as OperationTerminalFailureParams;
        assertRecordOwner(record, params.ownerHash);
        const terminal = startTerminalRetention(
          record,
          terminalizeContinuationFailureInRecord(cloneRecord(record), params),
          params.now ?? nowIso()
        );
        await this.persistRecord(terminal);
        await this.deleteApprovedPrivateNotes(this.state.storage, operationId);
        await this.setRecordAlarm(terminal);
        return json(terminal);
      }
    }

    if (request.method === "GET" && url.pathname === "/operations") {
      const ownerHash = url.searchParams.get("ownerHash");
      if (!ownerHash) return json({ error: "ownerHash is required" }, 400);
      const indexed = await this.state.storage.list<RecentOperationIndexEntry>({
        prefix: "recent:",
      });
      const retained: OperationLedgerRecord[] = [];
      for (const [indexKey, entry] of indexed) {
        if (!indexKey.startsWith("recent:")) continue;
        if (!isRecentOperationIndexEntry(entry)) {
          await this.state.storage.delete(indexKey);
          continue;
        }
        if (entry.ownerHash !== ownerHash) continue;
        const key = "op:" + entry.operationId;
        const record = await this.state.storage.get<OperationLedgerRecord>(key);
        if (!record) {
          await this.state.storage.delete(indexKey);
          continue;
        }
        try {
          assertOperationRecord(record);
        } catch {
          continue;
        }
        if (record.ownerHash !== ownerHash) continue;
        if (isExpiredTerminalOperation(record)) {
          await this.state.storage.delete(key);
          await this.state.storage.delete(indexKey);
          await this.deleteApprovedPrivateNotes(this.state.storage, record.operationId);
        } else {
          retained.push(record);
        }
      }
      retained.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const results = retained.slice(0, MAX_RECENT_OPERATION_RESULTS).map(operationRecentView);
      while (results.length > 0 && serializedBytes(results) > MAX_RECENT_OPERATION_OUTPUT_BYTES) {
        results.pop();
      }
      return json(results);
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
