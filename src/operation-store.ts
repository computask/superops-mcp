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
import { canonicalizeNoteText } from "./utils/note-canonicalization.js";

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
  | "PreflightValidated"
  | "WriteNotStarted"
  | "WriteStarted"
  | "WriteAmbiguous"
  | "FieldsUpdated"
  | "ClassificationWriteStarted"
  | "ClassificationWriteSucceeded"
  | "ClassificationVerified"
  | "ResolutionValidated"
  | "ResolutionWriteStarted"
  | "ResolutionWriteSucceeded"
  | "ResolutionWriteAmbiguous"
  | "ResolutionVerified"
  | "StatusWriteStarted"
  | "StatusWriteSucceeded"
  | "StatusVerified"
  | "StatusUpdated"
  | "NoteChecked"
  | "NoteDedupeChecked"
  | "NoteWriteStarted"
  | "NoteWriteAmbiguous"
  | "NoteAdded"
  | "NoteVerified"
  | "RecoveryWriteStarted"
  | "RecoveryWriteAmbiguous"
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

export type OperationMutationType =
  | "update"
  | "classification"
  | "resolution"
  | "status"
  | "note"
  | "resolveFallback";

export type ReconciliationDisposition =
  | "VerifiedSuccess"
  | "ConfirmedPartialWrite"
  | "ConfirmedNotApplied"
  | "AmbiguousUnresolved";

export interface OperationItemState {
  itemKey: string;
  stage: OperationItemStage;
  outcome?: string;
  idempotencyKey: string;
  writeAttempted: boolean;
  writeMayHaveSucceeded: boolean;
  partialWrite: boolean;
  ambiguousWrite?: boolean;
  ambiguityEncountered?: boolean;
  mutationType?: OperationMutationType;
  mutationStartStage?: "WriteStarted" | "ClassificationWriteStarted" | "ResolutionWriteStarted" | "StatusWriteStarted" | "NoteWriteStarted";
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
  /** Legacy active expectation retained for stored-record compatibility. */
  updatedTimeExpectation?: string;
  targetFields?: Record<string, unknown>;
  originalMetadataExpectations?: Record<string, unknown>;
  expectedTicketId?: string;
  preMutationUpdatedTime?: string;
  preMutationState?: Record<string, unknown>;
  reconciliationMutationType?: OperationMutationType;
  reconciliationPass?: number;
  reconciliationPassReadAttempts?: number;
  reconciliationReadAttempts?: number;
  reconciliationDisposition?: ReconciliationDisposition;
  reconciliationUpdatedTimes?: string[];
  recoveryRetryCount?: number;
  recoveryRetryCounts?: Partial<Record<OperationMutationType, number>>;
  recoveryMutationStage?: OperationMutationType;
  recoveryWriteStarted?: boolean;
  originalMutationEvidence?: {
    reliableResponseReceived: boolean;
    mutationResult: "Rejected" | "Accepted" | "VerifiedApplied" | "Ambiguous";
    responseHadMutationPayload?: boolean | null;
    errorClass?: string;
    failureReason?: string;
  };
  acceptedPhysicalWrites?: Array<{
    mutationType: OperationMutationType;
    method: string;
    outcome: "Accepted" | "VerifiedApplied";
    recovery: boolean;
  }>;
  observedRequestedEffects?: string[];
  missingRequestedEffects?: string[];
  conflictingEffects?: string[];
  schemaDependencyFields?: string[];
  recoveryHistory?: Array<{
    pass: number;
    event: string;
    outcome?: string;
  }>;
  recoveryRetryOutcome?: string;
  replaySafetyReason?: string;
  rateLimit?: OperationRateLimitState;
  initialFailureReason?: string;
  initialErrorClass?: OperationErrorClass;
  terminalFailureReason?: string;
  terminalErrorClass?: OperationErrorClass;
  stageHistory?: OperationItemStage[];
  failureHistory?: Array<{
    stage: OperationItemStage;
    reason?: string;
    errorClass?: OperationErrorClass;
    retryCount: number;
  }>;
  replaySafe?: boolean;
  humanReconciliationRequired?: boolean;
  lease?: OperationLease;
  claimedAt?: string;
  completedAt?: string;
  /** Frozen updatedTime from the approved snapshot; retained for audit. */
  originalSnapshotUpdatedTime?: string;
  /** Last updatedTime returned by a verified mutation made by this operation. */
  expectedCurrentUpdatedTime?: string;
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
  /** Hard deadline for active processing; durable eligibility waits extend it. */
  maxOperationLifetimeAt?: string;
  /** Total durable waiting time excluded from the active-processing lifetime. */
  pausedLifetimeMs?: number;
  /** Furthest eligibility instant already credited to pausedLifetimeMs. */
  lifetimePausedUntil?: string;
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
  /** Current nonterminal pause/reschedule reason. */
  currentPauseReason?: string;
  terminalFailureReason?: string;
  currentLease?: OperationLease;
  workflowId?: string;
  /** Compact durable-wake metadata; no caller credentials or request content. */
  continuationMechanism?: "workflow";
  continuationInstanceId?: string;
  schedulingAttempted?: boolean;
  schedulingSucceeded?: boolean;
  schedulingError?: string;
  /** Backward-compatible lifetime scheduling-attempt total. */
  schedulingAttemptCount?: number;
  /** Attempts used for the most recent distinct scheduling boundary. */
  currentSchedulingAttemptCount?: number;
  /** Lifetime scheduling attempts across all continuation boundaries. */
  totalSchedulingAttemptCount?: number;
  wakeAttemptCount?: number;
  wakeDeliveryCount?: number;
  lastWakeAttemptAt?: string;
  lastWakeSucceededAt?: string;
  wakeDeliveryError?: string;
  wakeDeliveryExhaustedAt?: string;
  watchdogWakeCount?: number;
  lastWatchdogWakeAt?: string;
  manualResumeCount?: number;
  lastManualResumeAt?: string;
  cancelledAt?: string;
  cancellationReason?: string;
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
  /** Internal optimistic-concurrency guard for Durable Object metadata updates. */
  expectedRecordHash?: string;
}

export interface OperationTerminalFailureParams {
  operationId: string;
  ownerHash: string;
  errorClass: "ContinuationSchedulingFailure" | "ContinuationExecutionFailure" | "OperationStoreFailure";
  outcome: "ContinuationSchedulingFailed" | "ContinuationDeliveryFailed" |
    "ContinuationWatchdogExhausted" | "OperationStoreFailed";
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

export interface OperationCancelParams {
  operationId: string;
  ownerHash: string;
  expectedUpdatedAt: string;
  reason?: string;
  now?: string;
}

export type EmergingIssueEvidenceStrength = "weak" | "moderate" | "strong";
export type EmergingIssueSignalState = "active" | "expired" | "resolved";
export type EmergingIssueSignalOutcome = "created" | "updated" | "unchanged" | "expired" | "resolved";

export interface EmergingIssueObservation {
  issueFingerprint: string;
  summary: string;
  firstSeen: string;
  lastSeen: string;
  affectedClientCount: number;
  affectedRequesterCount?: number;
  affectedTicketNumbers: string[];
  representativeTicketNumbers: string[];
  evidenceStrength: EmergingIssueEvidenceStrength;
  signalState: "active" | "resolved";
  currentRelatedTicketNumbers: string[];
}

export interface EmergingIssueSignal {
  issueFingerprint: string;
  summary: string;
  firstSeen: string;
  lastSeen: string;
  affectedClientCount: number;
  affectedRequesterCount?: number;
  affectedTicketNumbers: string[];
  representativeTicketNumbers: string[];
  evidenceStrength: EmergingIssueEvidenceStrength;
  signalState: EmergingIssueSignalState;
  currentRelatedTicketNumbers: string[];
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  expiredAt?: string;
}

export interface EmergingIssueUpsertParams {
  ownerHash: string;
  operationId: string;
  observation: EmergingIssueObservation;
  quietPeriodMs: number;
  now?: string;
}

export interface EmergingIssueUpsertResult {
  outcome: EmergingIssueSignalOutcome;
  signal: EmergingIssueSignal;
  operationId: string;
  acceptedStage: "SignalPersisted";
  updatedAt: string;
  continuationRequired: false;
  ambiguityReconciled: true;
  finalVerification: { performed: true; verified: true };
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
  cancel(params: OperationCancelParams): Promise<OperationLedgerRecord>;
  terminalizeContinuationFailure(params: OperationTerminalFailureParams): Promise<OperationLedgerRecord>;
  getEmergingIssue(issueFingerprint: string, ownerHash: string): Promise<EmergingIssueSignal | undefined>;
  upsertEmergingIssue(params: EmergingIssueUpsertParams): Promise<EmergingIssueUpsertResult>;
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
const memoryEmergingIssueSignals = new Map<string, StoredEmergingIssueSignal>();
const MAX_OPERATION_ITEMS = 500;
const MAX_SERIALIZED_OPERATION_BYTES = 512 * 1024;
const MAX_APPROVED_PRIVATE_NOTE_BYTES = 128 * 1024;
const MAX_RECENT_OPERATION_INDEX_ENTRIES = 50;
const MAX_RECENT_OPERATION_RESULTS = 20;
const MAX_RECENT_OPERATION_OUTPUT_BYTES = 128 * 1024;
const OPERATION_STORE_RATE_LIMIT_MAX_ATTEMPTS = 3;
const OPERATION_STORE_RATE_LIMIT_BACKOFF_MS = [25, 75];
const OPERATION_STORE_CONFLICT_MAX_ATTEMPTS = 5;
const UNATTEMPTED_RUNNING_STALL_MS = 5 * 60 * 1000;
const RESCHEDULED_STALL_GRACE_MS = 2 * 60 * 1000;
export const EMERGING_ISSUE_QUIET_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_EMERGING_ISSUE_TICKETS = 50;
export const MAX_EMERGING_ISSUE_REPRESENTATIVES = 10;
export const MAX_EMERGING_ISSUE_CURRENT_TICKETS = 50;
export const MAX_EMERGING_ISSUE_SUMMARY_LENGTH = 240;
export const MAX_WATCHDOG_WAKE_COUNT = 3;
export const MAX_MANUAL_RESUME_COUNT = 3;

interface StoredEmergingIssueSignal extends EmergingIssueSignal {
  ownerHash: string;
}

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

class OperationStoreRateLimitError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "OperationStoreRateLimitError";
  }
}

class OperationStoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationStoreConflictError";
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
      !noteFingerprintMatchesContent(note.content, note.fingerprint) ||
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
    return noteFingerprintMatchesContent(content, stored.fingerprint) ? content : undefined;
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
const VALID_OPERATION_MUTATION_TYPES = new Set<OperationMutationType>([
  "update",
  "classification",
  "resolution",
  "status",
  "note",
  "resolveFallback",
]);
const VALID_RECONCILIATION_DISPOSITIONS = new Set<ReconciliationDisposition>([
  "VerifiedSuccess",
  "ConfirmedPartialWrite",
  "ConfirmedNotApplied",
  "AmbiguousUnresolved",
]);
const VALID_OPERATION_ITEM_STAGES = new Set<OperationItemStage>([  "Pending",
  "Validating",
  "Validated",
  "PreflightValidated",
  "WriteNotStarted",
  "WriteStarted",
  "WriteAmbiguous",
  "FieldsUpdated",
  "ClassificationWriteStarted",
  "ClassificationWriteSucceeded",
  "ClassificationVerified",
  "ResolutionValidated",
  "ResolutionWriteStarted",
  "ResolutionWriteSucceeded",
  "ResolutionWriteAmbiguous",
  "ResolutionVerified",
  "StatusWriteStarted",
  "StatusWriteSucceeded",
  "StatusVerified",
  "StatusUpdated",
  "NoteChecked",
  "NoteDedupeChecked",
  "NoteWriteStarted",
  "NoteWriteAmbiguous",
  "NoteAdded",
  "NoteVerified",
  "RecoveryWriteStarted",
  "RecoveryWriteAmbiguous",
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

function boundedUniqueSignalStrings(value: unknown, max: number, field: string): string[] {
  if (!Array.isArray(value) || value.length > max) {
    throw new MalformedStoredOperationError(`${field} exceeds its bounded collection limit.`);
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim() || entry.length > 40 || /[\r\n<>]/.test(entry)) {
      throw new MalformedStoredOperationError(`${field} contains an invalid bounded identifier.`);
    }
    const normalized = entry.trim();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

export function assertEmergingIssueObservation(
  value: unknown
): asserts value is EmergingIssueObservation {
  if (!isRecordObject(value)) {
    throw new MalformedStoredOperationError("Emerging issue observation must be an object.");
  }
  const observation = value as Partial<EmergingIssueObservation>;
  if (typeof observation.issueFingerprint !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(observation.issueFingerprint)) {
    throw new MalformedStoredOperationError("issueFingerprint must be a stable bounded identifier.");
  }
  if (typeof observation.summary !== "string" ||
      !observation.summary.trim() || observation.summary.length > MAX_EMERGING_ISSUE_SUMMARY_LENGTH ||
      /[\r\n<>]/.test(observation.summary) ||
      sanitizeText(observation.summary) !== observation.summary ||
      containsForbiddenPersistedContent({ summary: observation.summary })) {
    throw new MalformedStoredOperationError("summary must be bounded plain text without customer-content fields or markup.");
  }
  if (typeof observation.firstSeen !== "string" || !Number.isFinite(Date.parse(observation.firstSeen)) ||
      typeof observation.lastSeen !== "string" || !Number.isFinite(Date.parse(observation.lastSeen)) ||
      Date.parse(observation.firstSeen) > Date.parse(observation.lastSeen)) {
    throw new MalformedStoredOperationError("firstSeen and lastSeen must be ordered ISO timestamps.");
  }
  if (!isFiniteNonnegativeInteger(observation.affectedClientCount) || observation.affectedClientCount < 2 ||
      observation.affectedClientCount > 10000) {
    throw new MalformedStoredOperationError("affectedClientCount must be an integer from 2 through 10000.");
  }
  if (observation.affectedRequesterCount !== undefined &&
      (!isFiniteNonnegativeInteger(observation.affectedRequesterCount) || observation.affectedRequesterCount > 10000)) {
    throw new MalformedStoredOperationError("affectedRequesterCount is outside its bounded range.");
  }
  boundedUniqueSignalStrings(observation.affectedTicketNumbers, MAX_EMERGING_ISSUE_TICKETS, "affectedTicketNumbers");
  boundedUniqueSignalStrings(observation.representativeTicketNumbers, MAX_EMERGING_ISSUE_REPRESENTATIVES, "representativeTicketNumbers");
  boundedUniqueSignalStrings(observation.currentRelatedTicketNumbers, MAX_EMERGING_ISSUE_CURRENT_TICKETS, "currentRelatedTicketNumbers");
  if (observation.evidenceStrength !== "weak" && observation.evidenceStrength !== "moderate" &&
      observation.evidenceStrength !== "strong") {
    throw new MalformedStoredOperationError("evidenceStrength is invalid.");
  }
  if (observation.signalState !== "active" && observation.signalState !== "resolved") {
    throw new MalformedStoredOperationError("signalState must be active or resolved.");
  }
}

function emergingIssueSignalKey(ownerHash: string, issueFingerprint: string): string {
  return `signal:${stableHash({ version: 1, ownerHash, issueFingerprint })}`;
}

function cloneEmergingIssueSignal(signal: StoredEmergingIssueSignal): StoredEmergingIssueSignal {
  return JSON.parse(JSON.stringify(signal)) as StoredEmergingIssueSignal;
}

function publicEmergingIssueSignal(signal: StoredEmergingIssueSignal): EmergingIssueSignal {
  const { ownerHash: _ownerHash, ...publicSignal } = cloneEmergingIssueSignal(signal);
  return publicSignal;
}

function evidenceStrengthRank(value: EmergingIssueEvidenceStrength): number {
  return value === "strong" ? 3 : value === "moderate" ? 2 : 1;
}

function mergeSignalStrings(
  existing: string[],
  incoming: string[],
  max: number
): string[] {
  return [...new Set([...existing, ...incoming])].slice(0, max);
}

function expireEmergingIssueSignal(
  signal: StoredEmergingIssueSignal,
  now: string
): StoredEmergingIssueSignal {
  if (signal.signalState !== "active" || Date.parse(signal.expiresAt) > Date.parse(now)) return signal;
  return {
    ...signal,
    signalState: "expired",
    expiredAt: signal.expiredAt ?? now,
    updatedAt: now,
  };
}

function upsertEmergingIssueSignalRecord(
  existing: StoredEmergingIssueSignal | undefined,
  params: EmergingIssueUpsertParams
): { record: StoredEmergingIssueSignal; outcome: EmergingIssueSignalOutcome } {
  assertEmergingIssueObservation(params.observation);
  if (!params.ownerHash || !params.operationId ||
      !Number.isSafeInteger(params.quietPeriodMs) || params.quietPeriodMs <= 0 ||
      params.quietPeriodMs > 31 * 24 * 60 * 60 * 1000) {
    throw new MalformedStoredOperationError("Emerging issue durability parameters are invalid.");
  }
  const now = params.now ?? nowIso();
  if (!Number.isFinite(Date.parse(now))) {
    throw new MalformedStoredOperationError("Emerging issue update time is invalid.");
  }
  const observation = params.observation;
  const current = existing ? expireEmergingIssueSignal(existing, now) : undefined;
  const observationLastSeen = Date.parse(observation.lastSeen);
  const currentLastSeen = current ? Date.parse(current.lastSeen) : Number.NaN;
  const freshObservation = !current || observationLastSeen > currentLastSeen;
  const firstSeen = current && Date.parse(current.firstSeen) <= Date.parse(observation.firstSeen)
    ? current.firstSeen
    : observation.firstSeen;
  const lastSeen = current && currentLastSeen >= observationLastSeen
    ? current.lastSeen
    : observation.lastSeen;
  const activeObservation = observation.signalState === "active" &&
    observationLastSeen + params.quietPeriodMs > Date.parse(now);
  const preserveExplicitResolution = current?.signalState === "resolved" && !freshObservation;
  const signalState: EmergingIssueSignalState = observation.signalState === "resolved"
    ? "resolved"
    : preserveExplicitResolution
      ? "resolved"
      : activeObservation
        ? "active"
        : "expired";
  const record: StoredEmergingIssueSignal = {
    ownerHash: params.ownerHash,
    issueFingerprint: observation.issueFingerprint,
    summary: freshObservation || !current ? observation.summary.trim() : current!.summary,
    firstSeen,
    lastSeen,
    affectedClientCount: Math.max(current?.affectedClientCount ?? 0, observation.affectedClientCount),
    affectedRequesterCount: observation.affectedRequesterCount === undefined
      ? current?.affectedRequesterCount
      : Math.max(current?.affectedRequesterCount ?? 0, observation.affectedRequesterCount),
    affectedTicketNumbers: mergeSignalStrings(
      current?.affectedTicketNumbers ?? [],
      observation.affectedTicketNumbers,
      MAX_EMERGING_ISSUE_TICKETS
    ),
    representativeTicketNumbers: mergeSignalStrings(
      current?.representativeTicketNumbers ?? [],
      observation.representativeTicketNumbers,
      MAX_EMERGING_ISSUE_REPRESENTATIVES
    ),
    evidenceStrength: current && evidenceStrengthRank(current.evidenceStrength) >= evidenceStrengthRank(observation.evidenceStrength)
      ? current.evidenceStrength
      : observation.evidenceStrength,
    signalState,
    currentRelatedTicketNumbers: mergeSignalStrings(
      current?.currentRelatedTicketNumbers ?? [],
      observation.currentRelatedTicketNumbers,
      MAX_EMERGING_ISSUE_CURRENT_TICKETS
    ),
    createdAt: current?.createdAt ?? now,
    updatedAt: current?.updatedAt ?? now,
    expiresAt: new Date(Math.max(Date.parse(lastSeen) + params.quietPeriodMs, Date.parse(now))).toISOString(),
    expiredAt: signalState === "expired" ? current?.expiredAt ?? now : undefined,
  };
  const comparable = (value: StoredEmergingIssueSignal) => stableHash({
    issueFingerprint: value.issueFingerprint,
    summary: value.summary,
    firstSeen: value.firstSeen,
    lastSeen: value.lastSeen,
    affectedClientCount: value.affectedClientCount,
    affectedRequesterCount: value.affectedRequesterCount,
    affectedTicketNumbers: value.affectedTicketNumbers,
    representativeTicketNumbers: value.representativeTicketNumbers,
    evidenceStrength: value.evidenceStrength,
    signalState: value.signalState,
    currentRelatedTicketNumbers: value.currentRelatedTicketNumbers,
    expiresAt: value.expiresAt,
  });
  const changed = !current || comparable(current) !== comparable(record);
  if (changed) record.updatedAt = now;
  else record.updatedAt = current!.updatedAt;
  const outcome: EmergingIssueSignalOutcome = !current
    ? "created"
    : record.signalState === "resolved" && current.signalState !== "resolved"
      ? "resolved"
      : record.signalState === "expired" && !freshObservation
        ? "expired"
        : changed
          ? "updated"
          : "unchanged";
  return { record, outcome };
}

function emergingIssueUpsertResult(
  record: StoredEmergingIssueSignal,
  params: EmergingIssueUpsertParams,
  outcome: EmergingIssueSignalOutcome
): EmergingIssueUpsertResult {
  const signal = publicEmergingIssueSignal(record);
  return {
    outcome,
    signal,
    operationId: params.operationId,
    acceptedStage: "SignalPersisted",
    updatedAt: signal.updatedAt,
    continuationRequired: false,
    ambiguityReconciled: true,
    finalVerification: { performed: true, verified: true },
  };
}

function assertStoredEmergingIssueSignal(value: unknown): asserts value is StoredEmergingIssueSignal {
  if (!isRecordObject(value) || typeof value.ownerHash !== "string") {
    throw new MalformedStoredOperationError("Stored emerging issue signal is malformed.");
  }
  const signal = value as Partial<StoredEmergingIssueSignal>;
  if (typeof signal.issueFingerprint !== "string" ||
      typeof signal.summary !== "string" || signal.summary.length > MAX_EMERGING_ISSUE_SUMMARY_LENGTH ||
      /[\r\n<>]/.test(signal.summary) ||
      typeof signal.firstSeen !== "string" || !Number.isFinite(Date.parse(signal.firstSeen)) ||
      typeof signal.lastSeen !== "string" || !Number.isFinite(Date.parse(signal.lastSeen)) ||
      Date.parse(signal.firstSeen) > Date.parse(signal.lastSeen) ||
      typeof signal.affectedClientCount !== "number" ||
      !Number.isSafeInteger(signal.affectedClientCount) || signal.affectedClientCount < 2 ||
      (signal.affectedRequesterCount !== undefined &&
        (!Number.isSafeInteger(signal.affectedRequesterCount) || signal.affectedRequesterCount < 0)) ||
      !["weak", "moderate", "strong"].includes(String(signal.evidenceStrength)) ||
      !["active", "expired", "resolved"].includes(String(signal.signalState)) ||
      typeof signal.createdAt !== "string" || !Number.isFinite(Date.parse(signal.createdAt)) ||
      typeof signal.updatedAt !== "string" || !Number.isFinite(Date.parse(signal.updatedAt)) ||
      typeof signal.expiresAt !== "string" || !Number.isFinite(Date.parse(signal.expiresAt)) ||
      signal.expiredAt !== undefined &&
        (typeof signal.expiredAt !== "string" || !Number.isFinite(Date.parse(signal.expiredAt)))) {
    throw new MalformedStoredOperationError("Stored emerging issue signal has invalid fields.");
  }
  boundedUniqueSignalStrings(signal.affectedTicketNumbers, MAX_EMERGING_ISSUE_TICKETS, "affectedTicketNumbers");
  boundedUniqueSignalStrings(signal.representativeTicketNumbers, MAX_EMERGING_ISSUE_REPRESENTATIVES, "representativeTicketNumbers");
  boundedUniqueSignalStrings(signal.currentRelatedTicketNumbers, MAX_EMERGING_ISSUE_CURRENT_TICKETS, "currentRelatedTicketNumbers");
}

function assertStringArray(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry)) {
    throw new MalformedStoredOperationError(`Operation ${field} must contain nonempty strings.`);
  }
}

function validOptionalRecoveryMetadata(item: Record<string, unknown>): boolean {
  for (const field of [
    "updatedTimeExpectation",
    "originalSnapshotUpdatedTime",
    "expectedCurrentUpdatedTime",
  ] as const) {
    const value = item[field];
    if (value !== undefined && (typeof value !== "string" || !value)) return false;
  }
  for (const field of ["mutationType", "reconciliationMutationType", "recoveryMutationStage"] as const) {
    const value = item[field];
    if (value !== undefined && !VALID_OPERATION_MUTATION_TYPES.has(value as OperationMutationType)) return false;
  }
  if (item.reconciliationDisposition !== undefined &&
      !VALID_RECONCILIATION_DISPOSITIONS.has(item.reconciliationDisposition as ReconciliationDisposition)) {
    return false;
  }
  if (item.expectedTicketId !== undefined &&
      (typeof item.expectedTicketId !== "string" || !item.expectedTicketId)) return false;
  if (item.recoveryRetryCount !== undefined &&
      (!isFiniteNonnegativeInteger(item.recoveryRetryCount) || item.recoveryRetryCount > 1)) return false;
  if (item.reconciliationPass !== undefined &&
      (!isFiniteNonnegativeInteger(item.reconciliationPass) || item.reconciliationPass < 1 || item.reconciliationPass > 2)) {
    return false;
  }
  if ((item.stage === "RecoveryWriteStarted" || item.stage === "RecoveryWriteAmbiguous" ||
       item.recoveryWriteStarted === true) &&
      (item.recoveryRetryCount !== 1 ||
       !VALID_OPERATION_MUTATION_TYPES.has(item.recoveryMutationStage as OperationMutationType))) {
    return false;
  }
  if (item.recoveryRetryCounts !== undefined) {
    if (!isRecordObject(item.recoveryRetryCounts)) return false;
    for (const [mutationType, count] of Object.entries(item.recoveryRetryCounts)) {
      if (!VALID_OPERATION_MUTATION_TYPES.has(mutationType as OperationMutationType) ||
          !isFiniteNonnegativeInteger(count) || count > 1) return false;
    }
  }
  for (const field of [
    "observedRequestedEffects",
    "missingRequestedEffects",
    "conflictingEffects",
    "schemaDependencyFields",
    "reconciliationUpdatedTimes",
  ] as const) {
    const value = item[field];
    if (value !== undefined &&
        (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry))) return false;
  }
  if (item.acceptedPhysicalWrites !== undefined && (
    !Array.isArray(item.acceptedPhysicalWrites) ||
    item.acceptedPhysicalWrites.some((write) =>
      !isRecordObject(write) ||
      !VALID_OPERATION_MUTATION_TYPES.has(write.mutationType as OperationMutationType) ||
      typeof write.method !== "string" || !write.method ||
      !["Accepted", "VerifiedApplied"].includes(String(write.outcome)) ||
      typeof write.recovery !== "boolean"
    )
  )) return false;
  if (item.originalMutationEvidence !== undefined && (
    !isRecordObject(item.originalMutationEvidence) ||
    typeof item.originalMutationEvidence.reliableResponseReceived !== "boolean" ||
    !["Rejected", "Accepted", "VerifiedApplied", "Ambiguous"]
      .includes(String(item.originalMutationEvidence.mutationResult)) ||
    item.originalMutationEvidence.responseHadMutationPayload !== undefined &&
      item.originalMutationEvidence.responseHadMutationPayload !== null &&
      typeof item.originalMutationEvidence.responseHadMutationPayload !== "boolean" ||
    item.originalMutationEvidence.errorClass !== undefined &&
      (typeof item.originalMutationEvidence.errorClass !== "string" || !item.originalMutationEvidence.errorClass) ||
    item.originalMutationEvidence.failureReason !== undefined &&
      (typeof item.originalMutationEvidence.failureReason !== "string" || !item.originalMutationEvidence.failureReason)
  )) return false;
  if (item.recoveryHistory !== undefined && (
    !Array.isArray(item.recoveryHistory) ||
    item.recoveryHistory.some((entry) =>
      !isRecordObject(entry) ||
      !isFiniteNonnegativeInteger(entry.pass) ||
      typeof entry.event !== "string" || !entry.event ||
      entry.outcome !== undefined && typeof entry.outcome !== "string"
    )
  )) return false;
  return true;
}

function assertOperationRecord(value: unknown): asserts value is OperationLedgerRecord {  if (!isRecordObject(value)) throw new MalformedStoredOperationError();
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
  if (record.pausedLifetimeMs !== undefined && !isFiniteNonnegativeInteger(record.pausedLifetimeMs)) {
    throw new MalformedStoredOperationError("Operation pausedLifetimeMs is invalid.");
  }
  if (record.lifetimePausedUntil !== undefined &&
      (typeof record.lifetimePausedUntil !== "string" || !Number.isFinite(Date.parse(record.lifetimePausedUntil)))) {
    throw new MalformedStoredOperationError("Operation lifetimePausedUntil is invalid.");
  }
  for (const [field, candidate] of [
    ["schedulingAttemptCount", record.schedulingAttemptCount],
    ["currentSchedulingAttemptCount", record.currentSchedulingAttemptCount],
    ["totalSchedulingAttemptCount", record.totalSchedulingAttemptCount],
    ["wakeAttemptCount", record.wakeAttemptCount],
    ["wakeDeliveryCount", record.wakeDeliveryCount],
    ["watchdogWakeCount", record.watchdogWakeCount],
    ["manualResumeCount", record.manualResumeCount],
  ] as const) {
    if (candidate !== undefined && !isFiniteNonnegativeInteger(candidate)) {
      throw new MalformedStoredOperationError(`Operation ${field} is invalid.`);
    }
  }
  if ((record.manualResumeCount ?? 0) > MAX_MANUAL_RESUME_COUNT) {
    throw new MalformedStoredOperationError("Operation manualResumeCount exceeds its durable limit.");
  }
  if ((record.watchdogWakeCount ?? 0) > MAX_WATCHDOG_WAKE_COUNT) {
    throw new MalformedStoredOperationError("Operation watchdogWakeCount exceeds its durable limit.");
  }
  if (record.lastWatchdogWakeAt !== undefined &&
      (typeof record.lastWatchdogWakeAt !== "string" || !Number.isFinite(Date.parse(record.lastWatchdogWakeAt)))) {
    throw new MalformedStoredOperationError("Operation lastWatchdogWakeAt is invalid.");
  }
  if (record.lastManualResumeAt !== undefined &&
      (typeof record.lastManualResumeAt !== "string" || !Number.isFinite(Date.parse(record.lastManualResumeAt)))) {
    throw new MalformedStoredOperationError("Operation lastManualResumeAt is invalid.");
  }
  if (record.cancelledAt !== undefined &&
      (typeof record.cancelledAt !== "string" || !Number.isFinite(Date.parse(record.cancelledAt)))) {
    throw new MalformedStoredOperationError("Operation cancelledAt is invalid.");
  }
  if (record.cancellationReason !== undefined &&
      (typeof record.cancellationReason !== "string" || record.cancellationReason.length > 240)) {
    throw new MalformedStoredOperationError("Operation cancellationReason is invalid.");
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
      !isFiniteNonnegativeInteger(item.retryCount) ||
      (item.recoveryRetryCount !== undefined && !isFiniteNonnegativeInteger(item.recoveryRetryCount)) ||
      (item.reconciliationPass !== undefined && !isFiniteNonnegativeInteger(item.reconciliationPass)) ||
      (item.reconciliationPassReadAttempts !== undefined && !isFiniteNonnegativeInteger(item.reconciliationPassReadAttempts)) ||
      (item.reconciliationReadAttempts !== undefined && !isFiniteNonnegativeInteger(item.reconciliationReadAttempts)) ||
      !validOptionalRecoveryMetadata(item)
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
    const lifetimeReason = "Operation maximum lifetime exceeded before the item reached a terminal state.";
    const lifetimePatch: Partial<OperationItemState> & { stage: OperationItemStage } = {
      stage: item.writeMayHaveSucceeded ? "AmbiguousWriteUnresolved" : "FailedBeforeWrite",
      ambiguousWrite: item.writeMayHaveSucceeded || item.ambiguousWrite,
      partialWrite: item.partialWrite,
      errorClass: item.errorClass ?? "ContinuationFailure",
      failureReason: item.failureReason ?? lifetimeReason,
      terminalFailureReason: lifetimeReason,
      terminalErrorClass: "ContinuationFailure",
    };
    next.itemStates[itemKey] = {
      ...item,
      ...lifetimePatch,
      ...diagnosticItemFields(item, lifetimePatch),
      terminalFailureReason: lifetimeReason,
      terminalErrorClass: "ContinuationFailure",
      lease: undefined,
    };
  }
  next.currentLease = undefined;
  next.nextEligibleTime = undefined;
  next.currentPauseReason = undefined;
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
    const terminalPatch: Partial<OperationItemState> & { stage: OperationItemStage } = {
      stage: possibleWrite ? "AmbiguousWriteUnresolved" : "FailedBeforeWrite",
      outcome: possibleWrite ? "AmbiguousWriteRequiresReconciliation" : params.outcome,
      ambiguousWrite: possibleWrite || item.ambiguousWrite,
      partialWrite: item.partialWrite,
      errorClass: item.errorClass ?? params.errorClass,
      failureReason: item.failureReason ?? params.reason,
      terminalFailureReason: params.reason,
      terminalErrorClass: params.errorClass,
    };
    next.itemStates[itemKey] = {
      ...item,
      ...terminalPatch,
      ...diagnosticItemFields(item, terminalPatch),
      terminalFailureReason: params.reason,
      terminalErrorClass: params.errorClass,
      lease: undefined,
      completedAt: now,
    };
  }
  next.currentLease = undefined;
  next.nextEligibleTime = undefined;
  next.currentPauseReason = undefined;
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

function cancelOperationInRecord(
  record: OperationLedgerRecord,
  params: OperationCancelParams
): OperationLedgerRecord {
  assertRecordOwner(record, params.ownerHash);
  const now = params.now ?? nowIso();
  if (record.updatedAt !== params.expectedUpdatedAt) {
    throw new Error("Operation changed after it was inspected; read current status before cancelling.");
  }
  if (isTerminalOperation(record)) {
    throw new Error("A terminal operation cannot be cancelled.");
  }
  if (Object.values(record.itemStates).some((item) => isLeaseActive(item.lease, now))) {
    throw new Error("Operation has an active item lease and cannot be cancelled until that lease is released or expires.");
  }

  const reason = sanitizeText(params.reason?.trim() || "Cancelled by the authenticated operation owner.").slice(0, 240);
  const next = cloneRecord(record);
  for (const itemKey of next.expectedItems) {
    const item = next.itemStates[itemKey];
    if (!item || TERMINAL_STAGES.has(item.stage)) continue;
    const possibleWrite = item.writeMayHaveSucceeded && item.observedMutationResult !== "Rejected";
    const acceptedOrObserved = (item.acceptedPhysicalWrites?.length ?? 0) > 0 ||
      (item.observedRequestedEffects?.length ?? 0) > 0 || item.partialWrite;
    const stage: OperationItemStage = possibleWrite
      ? "AmbiguousWriteUnresolved"
      : acceptedOrObserved
        ? "FailedAfterPartialWrite"
        : "Skipped";
    const outcome = possibleWrite
      ? "CancelledWithAmbiguousWrite"
      : acceptedOrObserved
        ? "CancelledAfterPartialWrite"
        : "CancelledBeforeWrite";
    next.itemStates[itemKey] = {
      ...item,
      stage,
      outcome,
      ambiguousWrite: possibleWrite || item.ambiguousWrite,
      partialWrite: acceptedOrObserved,
      terminalFailureReason: possibleWrite || acceptedOrObserved ? reason : undefined,
      terminalErrorClass: possibleWrite ? "AmbiguousWrite" : acceptedOrObserved ? "ContinuationFailure" : undefined,
      replaySafe: !possibleWrite,
      humanReconciliationRequired: possibleWrite || acceptedOrObserved,
      stageHistory: [...new Set([...(item.stageHistory ?? [item.stage]), stage])],
      completedAt: now,
      lease: undefined,
      nextEligibleTime: undefined,
    };
  }
  next.state = "Cancelled";
  next.currentLease = undefined;
  next.nextEligibleTime = undefined;
  next.currentPauseReason = undefined;
  next.terminalFailureReason = undefined;
  next.cancelledAt = now;
  next.cancellationReason = reason;
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
  Pending: new Set(["Validating", "Validated", "PreflightValidated", "WriteNotStarted", "NoteChecked", "NoteDedupeChecked", "Rescheduled", "RateLimitedRescheduled"]),
  Unattempted: new Set(["Validating", "Validated", "PreflightValidated", "WriteNotStarted", "NoteChecked", "NoteDedupeChecked", "Rescheduled", "RateLimitedRescheduled"]),
  Validating: new Set(["Validated", "PreflightValidated", "WriteNotStarted"]),
  Validated: new Set(["PreflightValidated", "WriteNotStarted", "WriteStarted", "ClassificationWriteStarted", "ResolutionValidated", "ResolutionWriteStarted", "Verifying"]),
  PreflightValidated: new Set(["ClassificationWriteStarted", "ClassificationVerified", "NoteDedupeChecked", "StatusWriteStarted", "Verifying"]),
  WriteNotStarted: new Set(["WriteStarted", "Verifying"]),
  WriteStarted: new Set(["FieldsUpdated", "StatusUpdated", "ResolutionValidated", "ResolutionWriteStarted", "NoteChecked", "NoteWriteStarted", "Verifying", "WriteAmbiguous", "RateLimitedRescheduled"]),
  WriteAmbiguous: new Set(["Verifying"]),
  FieldsUpdated: new Set(["StatusUpdated", "ResolutionValidated", "ResolutionWriteStarted", "NoteChecked", "Verifying"]),
  ClassificationWriteStarted: new Set(["ClassificationWriteSucceeded", "ClassificationVerified", "RateLimitedRescheduled"]),
  ClassificationWriteSucceeded: new Set(["ClassificationVerified", "NoteDedupeChecked", "StatusWriteStarted", "Verifying"]),
  ClassificationVerified: new Set(["NoteDedupeChecked", "NoteWriteStarted", "NoteVerified", "StatusWriteStarted", "StatusVerified", "Verifying"]),
  ResolutionValidated: new Set(["ResolutionWriteStarted", "Verifying"]),
  ResolutionWriteStarted: new Set(["ResolutionWriteSucceeded", "ResolutionWriteAmbiguous", "ResolutionVerified", "RateLimitedRescheduled"]),
  ResolutionWriteSucceeded: new Set(["ResolutionVerified", "NoteChecked", "NoteWriteStarted", "Verifying"]),
  ResolutionWriteAmbiguous: new Set(["ResolutionVerified", "Verifying"]),
  ResolutionVerified: new Set(["NoteChecked", "NoteDedupeChecked", "NoteWriteStarted", "Verifying"]),
  StatusWriteStarted: new Set(["StatusWriteSucceeded", "StatusVerified", "RateLimitedRescheduled"]),
  StatusWriteSucceeded: new Set(["StatusVerified", "Verifying"]),
  StatusVerified: new Set(["Verifying"]),
  StatusUpdated: new Set(["NoteChecked", "Verifying"]),
  NoteChecked: new Set(["Validated", "WriteNotStarted", "WriteStarted", "ResolutionValidated", "ResolutionWriteStarted", "NoteWriteStarted", "NoteAdded", "Verifying"]),
  NoteDedupeChecked: new Set(["NoteWriteStarted", "NoteAdded", "NoteVerified", "StatusWriteStarted", "Verifying"]),
  NoteWriteStarted: new Set(["NoteAdded", "NoteWriteAmbiguous", "NoteVerified", "Verifying", "RateLimitedRescheduled"]),
  NoteWriteAmbiguous: new Set(["Verifying"]),
  NoteAdded: new Set(["NoteVerified", "Verifying", "StatusWriteStarted"]),
  NoteVerified: new Set(["StatusWriteStarted", "StatusVerified", "Verifying"]),
  RecoveryWriteStarted: new Set(["FieldsUpdated", "ClassificationWriteSucceeded", "ClassificationVerified", "ResolutionWriteSucceeded", "ResolutionVerified", "StatusWriteSucceeded", "StatusVerified", "NoteAdded", "RecoveryWriteAmbiguous", "RateLimitedRescheduled", "Verifying"]),
  RecoveryWriteAmbiguous: new Set(["ClassificationVerified", "ResolutionVerified", "StatusVerified", "Verifying"]),
  Verifying: new Set(["NoteChecked", "NoteDedupeChecked"]),
  RateLimited: new Set(["RateLimitedRetrying", "RateLimitedRescheduled"]),
  RateLimitedRetrying: new Set(["RateLimitedRescheduled"]),
  RateLimitedRescheduled: new Set(["Validating", "Validated", "PreflightValidated", "WriteNotStarted", "WriteStarted", "WriteAmbiguous", "ClassificationWriteStarted", "ResolutionValidated", "ResolutionWriteStarted", "StatusWriteStarted", "NoteChecked", "NoteDedupeChecked", "NoteWriteStarted", "Verifying"]),
  Rescheduled: new Set(["Validating", "Validated", "PreflightValidated", "WriteNotStarted", "WriteStarted", "WriteAmbiguous", "ClassificationWriteStarted", "NoteChecked", "NoteDedupeChecked", "StatusWriteStarted", "RecoveryWriteStarted", "RecoveryWriteAmbiguous", "Verifying", "RateLimitedRescheduled"]),
};

function assertTransition(current: OperationItemStage, next: OperationItemStage): void {
  if (current === next) return;
  if (TERMINAL_STAGES.has(current)) {
    throw new Error(`Invalid operation item transition from ${current} to ${next}.`);
  }
  // A required read can be throttled at every unfinished checkpoint. The
  // continuation retains mutation history separately and revalidates before
  // advancing from this scheduling state.
  if (next === "RateLimitedRescheduled") return;
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
  if ((current === "Pending" || current === "Unattempted") && ["WriteStarted", "ClassificationWriteStarted", "ResolutionWriteStarted", "StatusWriteStarted", "NoteWriteStarted"].includes(next)) {
    return;
  }
  // RecoveryWriteStarted is deliberately reachable only through the leased
  // checkpoint API. The durable retry counter and mutation boundary therefore
  // become visible atomically before the one permitted recovery call.
  if (next === "RecoveryWriteStarted" && !TERMINAL_STAGES.has(current)) {
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

function mergeArrayHistory(previous: unknown, next: unknown): unknown[] | undefined {
  const values = [
    ...(Array.isArray(previous) ? previous : []),
    ...(Array.isArray(next) ? next : []),
  ];
  if (values.length === 0) return undefined;
  const seen = new Set<string>();
  const merged: unknown[] = [];
  for (const value of values) {
    const key = typeof value === "object" && value !== null
      ? JSON.stringify(value)
      : String(value);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(value);
  }
  return merged;
}

function mergeCompactResultHistory(previous: unknown, next: unknown): unknown {
  if (!isRecordObject(previous) || !isRecordObject(next)) return next;
  const shouldMergeStagedHistory = previous.workflowMode === "staged" ||
    next.workflowMode === "staged" ||
    Array.isArray(previous.completedStages) ||
    Array.isArray(next.completedStages) ||
    previous.ambiguityEncountered === true ||
    next.ambiguityEncountered === true ||
    Array.isArray(previous.recoveryHistory) ||
    Array.isArray(next.recoveryHistory);
  if (!shouldMergeStagedHistory) return next;
  const merged: Record<string, unknown> = { ...previous, ...next };
  for (const field of ["physicalWrites", "completedStages", "recoveryHistory"] as const) {
    const history = mergeArrayHistory(previous[field], next[field]);
    if (history) merged[field] = history;
  }
  for (const field of ["noteAdded", "noteDeduped", "noteDedupeChecked"] as const) {
    if (previous[field] === true || next[field] === true) merged[field] = true;
  }
  for (const field of [
    "classificationWriteMethod",
    "classificationWriteOutcome",
    "noteWriteOutcome",
    "statusWriteMethod",
    "statusWriteOutcome",
    "suppressCloseNotificationRequested",
    "suppressCloseNotificationIncluded",
    "initialFailureReason",
    "initialFailureClass",
    "terminalFailureReason",
    "terminalFailureClass",
    "replaySafe",
    "humanReconciliationRequired",
  ] as const) {
    // Explicit null/false values clear current diagnostic state after a
    // successful recovery. Only an omitted field inherits durable history.
    if (merged[field] === undefined && previous[field] !== undefined) {
      merged[field] = previous[field];
    }
  }
  return merged;
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
      (
        (item.errorClass && TERMINAL_CONTINUATION_ERROR_CLASSES.has(item.errorClass)) ||
        (item.terminalErrorClass && TERMINAL_CONTINUATION_ERROR_CLASSES.has(item.terminalErrorClass))
      )
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

function itemHasUnresolvedAmbiguity(item: OperationItemState): boolean {
  if (item.reconciliationDisposition === "VerifiedSuccess" ||
      (TERMINAL_STAGES.has(item.stage) && item.stage !== "AmbiguousWriteUnresolved")) {
    return false;
  }
  if (item.reconciliationDisposition === "AmbiguousUnresolved" ||
      item.reconciliationDisposition === "ConfirmedNotApplied" ||
      item.reconciliationDisposition === "ConfirmedPartialWrite") {
    return true;
  }
  return item.ambiguousWrite === true ||
    item.stage === "WriteAmbiguous" ||
    item.stage === "ResolutionWriteAmbiguous" ||
    item.stage === "NoteWriteAmbiguous" ||
    item.stage === "RecoveryWriteStarted" ||
    item.stage === "RecoveryWriteAmbiguous" ||
    item.stage === "AmbiguousWriteUnresolved" ||
    (
      item.observedMutationResult === "Ambiguous" &&
      item.writeMayHaveSucceeded &&
      item.verificationState !== "Verified"
    );
}

function itemIsWaitingForRateLimit(item: OperationItemState): boolean {
  if (TERMINAL_STAGES.has(item.stage)) return false;
  return RATE_LIMIT_STAGES.has(item.stage) ||
    (item.errorClass === "SuperOpsRateLimit" && Boolean(item.nextEligibleTime || item.rateLimit?.nextEligibleAt));
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
    if (itemHasUnresolvedAmbiguity(item)) ambiguousWriteCount += 1;
    if (itemIsWaitingForRateLimit(item)) rateLimited.push(itemKey);
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

  next.compactResults = next.compactResults.map((entry) => {
    if (!isRecordObject(entry)) return entry;
    const itemKey = itemResultKey(entry);
    const item = itemKey ? next.itemStates[itemKey] : undefined;
    if (!item) return entry;
    const physicalWrites = item.acceptedPhysicalWrites ?? (Array.isArray(entry.physicalWrites)
      ? entry.physicalWrites.filter((write) => isRecordObject(write) &&
          ["Accepted", "AcceptedAndVerified", "VerifiedApplied", "VerifiedAppliedAfterAmbiguous"]
            .includes(String(write.outcome ?? "")))
      : []);
    const completedStages = Array.isArray(entry.completedStages)
      ? entry.completedStages.filter((stage): stage is string => typeof stage === "string")
      : [];
    const stagesCompleted = [...new Set([...completedStages, ...(item.stageHistory ?? [])])];
    const exposeDiagnostics = Boolean(
      item.initialFailureReason || item.initialErrorClass || item.failureHistory?.length ||
      item.terminalFailureReason || item.partialWrite || itemHasUnresolvedAmbiguity(item) ||
      FAILED_STAGES.has(item.stage) || SKIPPED_STAGES.has(item.stage)
    );
    if (!exposeDiagnostics) return entry;
    return {
      ...entry,
      initialFailureReason: item.initialFailureReason ?? entry.initialFailureReason,
      initialFailureClass: item.initialErrorClass ?? entry.initialFailureClass,
      continuationHistory: item.failureHistory,
      retryCount: item.retryCount,
      terminalFailureReason: item.terminalFailureReason ?? entry.terminalFailureReason,
      terminalFailureClass: item.terminalErrorClass ?? entry.terminalFailureClass,
      stagesCompleted,
      acceptedPhysicalWrites: physicalWrites,
      replaySafe: item.replaySafe ?? entry.replaySafe,
      humanReconciliationRequired: item.humanReconciliationRequired ?? entry.humanReconciliationRequired,
    };
  });

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
      delete next.currentPauseReason;
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

function creditDurableWaitToOperationLifetime(
  record: OperationLedgerRecord,
  nextEligibleTime: string | undefined,
  scheduledAt: string
): OperationLedgerRecord {
  if (!nextEligibleTime || !record.maxOperationLifetimeAt) return record;
  const scheduledAtMs = Date.parse(scheduledAt);
  const nextEligibleMs = Date.parse(nextEligibleTime);
  const previousPauseUntilMs = record.lifetimePausedUntil
    ? Date.parse(record.lifetimePausedUntil)
    : scheduledAtMs;
  if (![scheduledAtMs, nextEligibleMs, previousPauseUntilMs].every(Number.isFinite) ||
      nextEligibleMs <= scheduledAtMs) {
    return record;
  }
  const uncreditedWaitStartsAt = Math.max(scheduledAtMs, previousPauseUntilMs);
  const additionalPausedMs = Math.max(0, nextEligibleMs - uncreditedWaitStartsAt);
  if (additionalPausedMs === 0) return record;
  const currentLifetimeAtMs = Date.parse(record.maxOperationLifetimeAt);
  if (!Number.isFinite(currentLifetimeAtMs)) return record;
  record.pausedLifetimeMs = (record.pausedLifetimeMs ?? 0) + additionalPausedMs;
  record.lifetimePausedUntil = nextEligibleTime;
  record.maxOperationLifetimeAt = new Date(currentLifetimeAtMs + additionalPausedMs).toISOString();
  return record;
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
  record.currentPauseReason = undefined;
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
function diagnosticItemFields(
  current: OperationItemState,
  patch: Partial<OperationItemState> & { stage: OperationItemStage }
): Partial<OperationItemState> {
  const shouldTrackStages = Boolean(
    current.stageHistory || current.failureReason || current.errorClass ||
    patch.failureReason || patch.errorClass || patch.partialWrite ||
    patch.observedMutationResult === "Ambiguous" || FAILED_STAGES.has(patch.stage) || SKIPPED_STAGES.has(patch.stage)
  );
  const stageHistory = shouldTrackStages
    ? [...new Set([...(current.stageHistory ?? [current.stage]), patch.stage])].slice(-16)
    : undefined;
  const failureReason = patch.failureReason ?? current.failureReason;
  const errorClass = patch.errorClass ?? current.errorClass;
  const retryCount = patch.retryCount ?? current.retryCount;
  const previousHistory = current.failureHistory ?? [];
  const nextFailure = patch.failureReason || patch.errorClass
    ? [{ stage: patch.stage, reason: patch.failureReason, errorClass: patch.errorClass, retryCount }]
    : [];
  const failureHistory = [...previousHistory, ...nextFailure]
    .filter((entry, index, entries) => index === 0 || JSON.stringify(entry) !== JSON.stringify(entries[index - 1]))
    .slice(-8);
  const possibleWrite = (patch.writeMayHaveSucceeded ?? current.writeMayHaveSucceeded) &&
    (patch.observedMutationResult ?? current.observedMutationResult) !== "Rejected";
  const terminal = TERMINAL_STAGES.has(patch.stage);
  const terminalSuccess = terminal &&
    !FAILED_STAGES.has(patch.stage) && !SKIPPED_STAGES.has(patch.stage);
  return {
    failureReason: terminalSuccess ? undefined : failureReason,
    errorClass: terminalSuccess ? undefined : errorClass,
    stageHistory,
    failureHistory: failureHistory.length > 0 ? failureHistory : undefined,
    initialFailureReason: current.initialFailureReason ?? current.failureReason ?? patch.failureReason,
    initialErrorClass: current.initialErrorClass ?? current.errorClass ?? patch.errorClass,
    terminalFailureReason: terminal ? terminalSuccess ? undefined : failureReason : current.terminalFailureReason,
    terminalErrorClass: terminal ? terminalSuccess ? undefined : errorClass : current.terminalErrorClass,
    replaySafe: terminal ? !possibleWrite : current.replaySafe,
    humanReconciliationRequired: terminal
      ? terminalSuccess ? false : patch.stage === "AmbiguousWriteUnresolved" ||
        (possibleWrite && patch.verificationState !== "Verified")
      : current.humanReconciliationRequired,
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
    ...diagnosticItemFields(current, definedPatch),
    itemKey: current.itemKey,
    idempotencyKey: current.idempotencyKey,
    completedAt: TERMINAL_STAGES.has(params.patch.stage) ? nowIso() : current.completedAt,
  };
  delete item.lease;
  if (TERMINAL_STAGES.has(item.stage)) {
    delete item.nextEligibleTime;
  }
  if (isTerminalSuccessfulItem(item) && item.ambiguityEncountered !== true) {
    delete item.expectedTicketId;
    delete item.preMutationUpdatedTime;
    delete item.preMutationState;
    delete item.reconciliationMutationType;
    delete item.reconciliationPass;
    delete item.reconciliationPassReadAttempts;
    delete item.reconciliationReadAttempts;
    delete item.reconciliationUpdatedTimes;
    delete item.reconciliationDisposition;
    delete item.originalMutationEvidence;
    delete item.recoveryMutationStage;
    delete item.recoveryWriteStarted;
    delete item.stageHistory;
    delete item.mutationStartStage;
    delete item.replaySafe;
    if (item.humanReconciliationRequired !== true) delete item.humanReconciliationRequired;
  }
  record.itemStates[params.itemKey] = item;
  if (record.currentLease?.leaseId === current.lease?.leaseId) {
    record.currentLease = undefined;
  }

  if (params.result !== undefined) {
    const resultForStorage = isTerminalSuccessfulItem(item) && isRecordObject(params.result)
      ? {
          ...params.result,
          failureStage: null,
          failureReason: null,
          finalReason: null,
          terminalFailure: null,
          terminalFailureReason: null,
          terminalFailureClass: null,
          humanReconciliationRequired: false,
        }
      : params.result;
    const compactKey = itemResultKey(resultForStorage) ?? params.itemKey;
    const previousResult = record.compactResults.find(
      (result) => (itemResultKey(result) ?? "") === compactKey
    );
    record.compactResults = record.compactResults.filter(
      (result) => (itemResultKey(result) ?? "") !== compactKey
    );
    record.compactResults.push(mergeCompactResultHistory(previousResult, resultForStorage));
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
    ...current,
    ...definedPatch,
    ...diagnosticItemFields(current, definedPatch),
    itemKey: current.itemKey,
    idempotencyKey: current.idempotencyKey,
    lease: current.lease,
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
      !noteFingerprintMatchesContent(note.content, fingerprint)
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
      const scheduledAt = nowIso();
      const alreadyScheduledFor = record.nextEligibleTime === params.nextEligibleTime &&
        record.schedulingSucceeded === true;
      creditDurableWaitToOperationLifetime(record, params.nextEligibleTime, scheduledAt);
      record.state = params.nextEligibleTime ? "Rescheduled" : "ContinuationRequired";
      record.nextEligibleTime = params.nextEligibleTime;
      record.workflowId = params.workflowId ?? record.workflowId;
      record.currentPauseReason = params.reason;
      delete record.terminalFailureReason;
      // Re-delivery of the same scheduling request is expected. It must not
      // manufacture another continuation identity or inflate retry limits.
      if (!alreadyScheduledFor) record.continuationCount += 1;
      record.updatedAt = scheduledAt;
      return record;
    });
  }

  async cancel(params: OperationCancelParams): Promise<OperationLedgerRecord> {
    const cancelled = await this.update(params.operationId, params.ownerHash, (record) =>
      cancelOperationInRecord(record, params)
    );
    deleteMemoryApprovedPrivateNotes(params.operationId);
    return cancelled;
  }

  async terminalizeContinuationFailure(
    params: OperationTerminalFailureParams
  ): Promise<OperationLedgerRecord> {
    return this.update(params.operationId, params.ownerHash, (record) =>
      terminalizeContinuationFailureInRecord(record, params)
    );
  }

  async getEmergingIssue(
    issueFingerprint: string,
    ownerHash: string
  ): Promise<EmergingIssueSignal | undefined> {
    const key = emergingIssueSignalKey(ownerHash, issueFingerprint);
    const stored = memoryEmergingIssueSignals.get(key);
    if (!stored || stored.ownerHash !== ownerHash) return undefined;
    const expired = expireEmergingIssueSignal(stored, nowIso());
    if (expired !== stored) memoryEmergingIssueSignals.set(key, expired);
    assertStoredEmergingIssueSignal(expired);
    return publicEmergingIssueSignal(expired);
  }

  async upsertEmergingIssue(
    params: EmergingIssueUpsertParams
  ): Promise<EmergingIssueUpsertResult> {
    const key = emergingIssueSignalKey(params.ownerHash, params.observation.issueFingerprint);
    const existing = memoryEmergingIssueSignals.get(key);
    const merged = upsertEmergingIssueSignalRecord(existing, params);
    assertStoredEmergingIssueSignal(merged.record);
    memoryEmergingIssueSignals.set(key, cloneEmergingIssueSignal(merged.record));
    return emergingIssueUpsertResult(merged.record, params, merged.outcome);
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
          expectedRecordHash: options?.expectedRecordHash,
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
    let lastConflict: OperationStoreConflictError | undefined;
    for (let attempt = 1; attempt <= OPERATION_STORE_CONFLICT_MAX_ATTEMPTS; attempt += 1) {
      const existing = await this.get(operationId, ownerHash);
      if (!existing) {
        throw new Error("Operation was not found or is not visible to this caller.");
      }
      assertRecordOwner(existing, ownerHash);
      const expectedRecordHash = stableHash(existing);
      const updated = startTerminalRetention(
        existing,
        normalizeOperationRecord(updater(cloneRecord(existing)))
      );
      updated.updatedAt = nowIso();
      try {
        await this.put(updated, { expectedRecordHash });
        return updated;
      } catch (error) {
        if (!(error instanceof OperationStoreConflictError) ||
            attempt >= OPERATION_STORE_CONFLICT_MAX_ATTEMPTS) {
          throw error;
        }
        lastConflict = error;
      }
    }
    throw lastConflict ?? new OperationStoreConflictError(
      "Operation store update conflict retry limit reached."
    );
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

  async cancel(params: OperationCancelParams): Promise<OperationLedgerRecord> {
    const response = await operationStoreFetch(
      "operationStore.cancel",
      this.operationStub(params.operationId, params.ownerHash),
      new Request(`https://operation.local/operations/${params.operationId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      })
    );
    if (!response.ok) throw await operationStoreFailure(response, "Operation store cancel failed");
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

  async getEmergingIssue(
    issueFingerprint: string,
    ownerHash: string
  ): Promise<EmergingIssueSignal | undefined> {
    const response = await operationStoreFetch(
      "operationStore.getEmergingIssue",
      this.stub(ownerHash),
      new Request(
        `https://operation.local/signals/emerging-issue/${encodeURIComponent(issueFingerprint)}?ownerHash=${encodeURIComponent(ownerHash)}`
      )
    );
    if (response.status === 404) return undefined;
    if (!response.ok) throw await operationStoreFailure(response, "Emerging issue signal lookup failed");
    const signal = await response.json();
    if (!isRecordObject(signal) || "ownerHash" in signal) {
      throw new MalformedStoredOperationError("Emerging issue signal lookup was not redacted.");
    }
    assertStoredEmergingIssueSignal({ ...signal, ownerHash });
    return signal as unknown as EmergingIssueSignal;
  }

  async upsertEmergingIssue(
    params: EmergingIssueUpsertParams
  ): Promise<EmergingIssueUpsertResult> {
    assertEmergingIssueObservation(params.observation);
    const response = await operationStoreFetch(
      "operationStore.upsertEmergingIssue",
      this.stub(params.ownerHash),
      new Request("https://operation.local/signals/emerging-issue/upsert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      })
    );
    if (!response.ok) throw await operationStoreFailure(response, "Emerging issue signal upsert failed");
    const result = await response.json() as EmergingIssueUpsertResult;
    if (!isRecordObject(result) || !isRecordObject(result.signal) ||
        result.continuationRequired !== false || result.ambiguityReconciled !== true ||
        !isRecordObject(result.finalVerification) || result.finalVerification.verified !== true) {
      throw new MalformedStoredOperationError("Emerging issue signal upsert result is malformed.");
    }
    return result;
  }
}

function textMentionsOperationStoreRateLimit(value: unknown): boolean {
  return typeof value === "string" && /rate[_ -]?limit|too_many_requests|throttl/i.test(value);
}

async function operationStoreResponseRateLimited(response: Response): Promise<boolean> {
  if (response.status === 429) return true;
  try {
    const body = await response.clone().json();
    if (!isRecordObject(body)) return false;
    return [body.errorClass, body.error, body.code, body.reason, body.message].some(
      textMentionsOperationStoreRateLimit
    );
  } catch {
    return false;
  }
}

function operationStoreExceptionRateLimited(error: unknown): boolean {
  if (error instanceof OperationStoreRateLimitError) return true;
  return error instanceof Error && textMentionsOperationStoreRateLimit(error.message);
}

function operationStoreRetryDelayMs(attempt: number, response?: Response): number {
  const retryAfter = response?.headers.get("Retry-After");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(1_000, seconds * 1_000);
    const dateDelay = Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(dateDelay) && dateDelay >= 0) return Math.min(1_000, dateDelay);
  }
  return OPERATION_STORE_RATE_LIMIT_BACKOFF_MS[Math.max(0, attempt - 1)] ??
    OPERATION_STORE_RATE_LIMIT_BACKOFF_MS[OPERATION_STORE_RATE_LIMIT_BACKOFF_MS.length - 1] ?? 25;
}

async function waitForOperationStoreRetry(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

async function operationStoreFailure(response: Response, message: string): Promise<Error> {
  let rateLimited = response.status === 429;
  try {
    const body = await response.clone().json();
    if (isRecordObject(body)) {
      if (body.errorClass === "OperationStoreConflict") {
        return new OperationStoreConflictError(
          typeof body.error === "string" ? body.error : `${message}: concurrent update`
        );
      }
      if (body.errorClass === "MalformedStoredOperation") {
        return new MalformedStoredOperationError(
          typeof body.error === "string" ? body.error : undefined
        );
      }
      rateLimited ||= [body.errorClass, body.error, body.code, body.reason, body.message].some(
        textMentionsOperationStoreRateLimit
      );
    }
  } catch {
    // Fall through to the stable status-based error below.
  }
  if (rateLimited) {
    return new OperationStoreRateLimitError(`${message}: rate_limit_exceeded (HTTP ${response.status})`, response.status);
  }
  return new Error(`${message}: ${response.status}`);
}
async function operationStoreFetch(
  operationName: string,
  stub: { fetch(request: Request): Promise<Response> },
  request: Request
): Promise<Response> {
  let lastRateLimitError: unknown;
  for (let attempt = 1; attempt <= OPERATION_STORE_RATE_LIMIT_MAX_ATTEMPTS; attempt += 1) {
    const started = recordOperationStoreSubrequest(operationName);
    try {
      const response = await stub.fetch(request.clone());
      const rateLimited = await operationStoreResponseRateLimited(response);
      recordSubrequestFinish(started, rateLimited ? "operationStoreRateLimited" : response.status, response.ok && !rateLimited);
      if (!rateLimited || attempt >= OPERATION_STORE_RATE_LIMIT_MAX_ATTEMPTS) return response;
      lastRateLimitError = await operationStoreFailure(response, `${operationName} rate limited`);
      await waitForOperationStoreRetry(operationStoreRetryDelayMs(attempt, response));
    } catch (error) {
      recordSubrequestFinish(started, "operationStoreError", false);
      if (!operationStoreExceptionRateLimited(error) || attempt >= OPERATION_STORE_RATE_LIMIT_MAX_ATTEMPTS) {
        throw error;
      }
      lastRateLimitError = error;
      await waitForOperationStoreRetry(operationStoreRetryDelayMs(attempt));
    }
  }
  throw lastRateLimitError instanceof Error ? lastRateLimitError : new OperationStoreRateLimitError(`${operationName}: rate_limit_exceeded`);
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

function legacyNormalizedNoteFingerprint(value: string | undefined): string | undefined {
  if (!value || !value.trim()) return undefined;
  return stableHash(
    value.normalize("NFKC").replace(/\r\n?/g, "\n").trim().replace(/\s+/gu, " ").toLowerCase()
  );
}

export function normalizedNoteFingerprint(value: string | undefined): string | undefined {
  const canonical = canonicalizeNoteText(value);
  // Preserve the existing exact-after-normalisation, case-insensitive note
  // identity contract while making HTML/plain-text representations converge.
  return canonical === undefined ? undefined : stableHash(canonical.toLowerCase());
}

/**
 * Match new canonical fingerprints while retaining read-only compatibility
 * with durable records created before HTML note canonicalisation was added.
 */
export function noteFingerprintMatchesContent(
  value: string | undefined,
  fingerprint: string | undefined
): boolean {
  if (!fingerprint) return false;
  return normalizedNoteFingerprint(value) === fingerprint ||
    legacyNormalizedNoteFingerprint(value) === fingerprint;
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
    successfulVerified: 0,
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
    acceptedPhysicalWrites: 0,
    humanReconciliationRequired: 0,
    noWriteFailures: 0,
  };

  for (const itemKey of record.expectedItems) {
    const item = record.itemStates[itemKey];
    if (!item) {
      totals.pending += 1;
      continue;
    }
    if (item.partialWrite) totals.partialWrite += 1;
    totals.acceptedPhysicalWrites += item.acceptedPhysicalWrites?.length ?? 0;
    if (item.humanReconciliationRequired === true && TERMINAL_STAGES.has(item.stage)) {
      totals.humanReconciliationRequired += 1;
    }
    if (FAILED_STAGES.has(item.stage) && !item.partialWrite &&
        (item.acceptedPhysicalWrites?.length ?? 0) === 0 &&
        (item.observedRequestedEffects?.length ?? 0) === 0) {
      totals.noWriteFailures += 1;
    }
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
    if (itemIsWaitingForRateLimit(item)) totals.waitingForRateLimit += 1;
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
      if (item.verificationState === "Verified" || item.verificationState === "NotRequired") {
        totals.successfulVerified += 1;
      }
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

function derivedUnattemptedStall(record: OperationLedgerRecord): Record<string, unknown> | undefined {
  if (record.state !== "Running" || record.continuationCount !== 0 || record.nextEligibleTime) return undefined;
  if (record.expectedItems.length === 0) return undefined;
  const items = record.expectedItems.map((itemKey) => record.itemStates[itemKey]);
  if (items.some((item) => !item || item.stage !== "Unattempted")) return undefined;
  if (items.some((item) => item.writeAttempted || item.writeMayHaveSucceeded || item.partialWrite)) return undefined;
  const updatedAtMs = Date.parse(record.updatedAt);
  if (!Number.isFinite(updatedAtMs) || Date.now() - updatedAtMs < UNATTEMPTED_RUNNING_STALL_MS) return undefined;
  return {
    derivedState: "Stalled",
    stalled: true,
    stalledReason: "Operation is still Running with only Unattempted items, zero continuation progress, and no durable next stage beyond the allowed interval; submit a fresh operation.",
    allowedStallMs: UNATTEMPTED_RUNNING_STALL_MS,
    writeAttempted: false,
    writeMayHaveSucceeded: false,
  };
}

function derivedRescheduledStall(record: OperationLedgerRecord): Record<string, unknown> | undefined {
  if (record.state !== "Rescheduled" || !record.nextEligibleTime || record.pendingItems.length === 0) {
    return undefined;
  }
  const eligibleAtMs = Date.parse(record.nextEligibleTime);
  if (!Number.isFinite(eligibleAtMs) || Date.now() - eligibleAtMs < RESCHEDULED_STALL_GRACE_MS) {
    return undefined;
  }
  const stalledReason = (record.wakeAttemptCount ?? 0) === 0
    ? "The durable eligibility time passed but no Workflow wake attempt was recorded."
    : (record.wakeDeliveryCount ?? 0) === 0
      ? "The Workflow wake was attempted but no successful continuation delivery was recorded."
      : "The Workflow delivered a continuation after eligibility, but the operation remained Rescheduled.";
  const items = Object.values(record.itemStates);
  return {
    derivedState: "Stalled",
    stalled: true,
    stalledReason,
    allowedStallMs: RESCHEDULED_STALL_GRACE_MS,
    writeAttempted: items.some((item) => item.writeAttempted),
    writeMayHaveSucceeded: items.some((item) => item.writeMayHaveSucceeded),
  };
}

function derivedOperationStall(record: OperationLedgerRecord): Record<string, unknown> | undefined {
  return derivedUnattemptedStall(record) ?? derivedRescheduledStall(record);
}

export function operationManualResumeEligibility(
  record: OperationLedgerRecord,
  now = new Date().toISOString()
): { allowed: boolean; reason: string } {
  if (isTerminalOperation(record) || record.pendingItems.length === 0) {
    return { allowed: false, reason: "The operation is terminal or has no pending items." };
  }
  if ((record.manualResumeCount ?? 0) >= MAX_MANUAL_RESUME_COUNT) {
    return { allowed: false, reason: "The bounded same-operation manual-resume limit has been reached." };
  }
  if (Object.values(record.itemStates).some((item) => isLeaseActive(item.lease, now))) {
    return { allowed: false, reason: "An item lease is active." };
  }
  const nowMs = Date.parse(now);
  if (record.state === "Rescheduled" && record.nextEligibleTime) {
    const eligibleMs = Date.parse(record.nextEligibleTime);
    return Number.isFinite(nowMs) && Number.isFinite(eligibleMs) &&
      nowMs - eligibleMs >= RESCHEDULED_STALL_GRACE_MS
      ? { allowed: true, reason: "The durable eligibility time passed without progress." }
      : { allowed: false, reason: "The operation is not yet beyond its durable eligibility grace period." };
  }
  if (record.state === "ContinuationRequired" || record.state === "Running") {
    const updatedMs = Date.parse(record.updatedAt);
    return Number.isFinite(nowMs) && Number.isFinite(updatedMs) &&
      nowMs - updatedMs >= RESCHEDULED_STALL_GRACE_MS
      ? { allowed: true, reason: "The operation has required continuation without progress beyond the grace period." }
      : { allowed: false, reason: "The operation has not been idle beyond the manual-resume grace period." };
  }
  return { allowed: false, reason: `Operation state ${record.state} is not resumable.` };
}

export function operationResultView(record: OperationLedgerRecord): Record<string, unknown> {
  const stalled = derivedOperationStall(record);
  const manualResume = operationManualResumeEligibility(record);
  return redactPublicOperationValue({
    operationId: record.operationId,
    durableOperationId: record.operationId,
    toolName: record.toolName,
    state: record.state,
    derivedState: stalled?.derivedState,
    stalled: stalled?.stalled,
    stalledReason: stalled?.stalledReason,
    stalledAllowedMs: stalled?.allowedStallMs,
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
    pausedLifetimeMs: record.pausedLifetimeMs ?? 0,
    lifetimePausedUntil: record.lifetimePausedUntil,
    maxOperationLifetimeAt: record.maxOperationLifetimeAt,
    continuationCount: record.continuationCount,
    currentPauseReason: record.currentPauseReason ??
      (!isTerminalOperation(record) ? record.terminalFailureReason : undefined),
    terminalFailureReason: isTerminalOperation(record) ? record.terminalFailureReason : undefined,
    workflowId: record.workflowId,
    continuationMechanism: record.continuationMechanism,
    continuationInstanceId: record.continuationInstanceId,
    schedulingAttempted: record.schedulingAttempted,
    schedulingSucceeded: record.schedulingSucceeded,
    schedulingError: record.schedulingError,
    schedulingAttemptCount: record.schedulingAttemptCount,
    currentSchedulingAttemptCount: record.currentSchedulingAttemptCount,
    totalSchedulingAttemptCount: record.totalSchedulingAttemptCount ?? record.schedulingAttemptCount,
    wakeAttemptCount: record.wakeAttemptCount,
    wakeDeliveryCount: record.wakeDeliveryCount,
    lastWakeAttemptAt: record.lastWakeAttemptAt,
    lastWakeSucceededAt: record.lastWakeSucceededAt,
    wakeDeliveryError: record.wakeDeliveryError,
    wakeDeliveryExhaustedAt: record.wakeDeliveryExhaustedAt,
    watchdogWakeCount: record.watchdogWakeCount ?? 0,
    watchdogWakeLimit: MAX_WATCHDOG_WAKE_COUNT,
    lastWatchdogWakeAt: record.lastWatchdogWakeAt,
    manualResumeCount: record.manualResumeCount ?? 0,
    manualResumeLimit: MAX_MANUAL_RESUME_COUNT,
    manualResumeAllowed: manualResume.allowed,
    manualResumeReason: manualResume.reason,
    lastManualResumeAt: record.lastManualResumeAt,
    cancelledAt: record.cancelledAt,
    cancellationReason: record.cancellationReason,
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
    const compact = compactResultForItem(record, itemKey);
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
      initialFailureReason: item?.initialFailureReason,
      initialFailureClass: item?.initialErrorClass,
      continuationHistory: item?.failureHistory,
      terminalFailureReason: item?.terminalFailureReason,
      terminalFailureClass: item?.terminalErrorClass,
      stagesCompleted: [...new Set([
        ...((compact?.completedStages as unknown[] | undefined) ?? [])
          .filter((stage): stage is string => typeof stage === "string"),
        ...(item?.stageHistory ?? []),
      ])],
      acceptedPhysicalWrites: compact?.acceptedPhysicalWrites,
      replaySafe: item?.replaySafe,
      humanReconciliationRequired: item?.humanReconciliationRequired,
      finalReason: item?.terminalFailureReason ?? item?.failureReason ?? item?.outcome,
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
  const stalled = derivedOperationStall(record);
  return {
    operationId: sanitizeText(record.operationId),
    toolName: sanitizeText(record.toolName),
    state: record.state,
    derivedState: stalled?.derivedState,
    stalled: stalled?.stalled,
    stalledReason: stalled?.stalledReason,
    stalledAllowedMs: stalled?.allowedStallMs,
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
    pausedLifetimeMs: record.pausedLifetimeMs ?? 0,
    lifetimePausedUntil: record.lifetimePausedUntil,
    maxOperationLifetimeAt: record.maxOperationLifetimeAt,
    continuationCount: record.continuationCount,
    totals: operationTotals(record),
  };
}

export class SuperOpsOperationLedger {
  constructor(private readonly state: DurableObjectState, private readonly env: DurableContinuationEnv = {}) {}

  private workflowUnavailableReason(): string | undefined {
    if (this.env.SUPEROPS_CONTINUATION_ENABLED !== "true") {
      return "Durable continuation Workflow disabled: SUPEROPS_CONTINUATION_ENABLED is not true.";
    }
    if (this.env.SUPEROPS_DURABLE_RETRY_ENABLED !== "true") {
      return "Durable continuation Workflow disabled: SUPEROPS_DURABLE_RETRY_ENABLED is not true.";
    }
    if (typeof this.env.SUPEROPS_CONTINUATION_WORKFLOW?.createBatch !== "function") {
      return "Durable continuation Workflow unavailable: SUPEROPS_CONTINUATION_WORKFLOW binding is missing.";
    }
    return undefined;
  }

  private maxSchedulingAttempts(): number {
    const parsed = Number(this.env.SUPEROPS_EXECUTION_MAX_SCHEDULING_ATTEMPTS);
    return Number.isFinite(parsed) ? Math.min(100, Math.max(1, Math.trunc(parsed))) : 8;
  }

  private async setRecordAlarm(record: OperationLedgerRecord): Promise<void> {
    if (typeof this.state.storage.setAlarm !== "function") return;
    const candidates = isTerminalOperation(record)
      ? [Date.parse(record.expiresAt)]
      : [
          Date.parse(record.maxOperationLifetimeAt ?? ""),
          this.watchdogAlarmAt(record),
        ];
    const alarmAt = candidates
      .filter((candidate): candidate is number => Number.isFinite(candidate))
      .reduce<number | undefined>(
        (earliest, candidate) => earliest === undefined ? candidate : Math.min(earliest, candidate),
        undefined
      );
    if (alarmAt === undefined) return;
    const existingAlarm = await this.state.storage.getAlarm?.();
    if (existingAlarm === null || existingAlarm === undefined || alarmAt < existingAlarm) {
      await this.state.storage.setAlarm(alarmAt);
    }
  }

  private async setEmergingIssueAlarm(signal: StoredEmergingIssueSignal): Promise<void> {
    if (signal.signalState !== "active" || typeof this.state.storage.setAlarm !== "function") return;
    const expiresAt = Date.parse(signal.expiresAt);
    if (!Number.isFinite(expiresAt)) return;
    const existingAlarm = await this.state.storage.getAlarm?.();
    if (existingAlarm === null || existingAlarm === undefined || expiresAt < existingAlarm) {
      await this.state.storage.setAlarm(expiresAt);
    }
  }

  private watchdogAlarmAt(record: OperationLedgerRecord): number {
    if (record.state !== "Rescheduled" || !record.nextEligibleTime ||
        record.continuationMechanism !== "workflow" || record.schedulingSucceeded !== true) {
      return Number.NaN;
    }
    const eligibleAt = Date.parse(record.nextEligibleTime);
    if (!Number.isFinite(eligibleAt)) return Number.NaN;
    const activeLeaseExpiry = Object.values(record.itemStates)
      .map((item) => Date.parse(item.lease?.expiresAt ?? ""))
      .filter((expiry) => Number.isFinite(expiry) && expiry > Date.now())
      .reduce<number | undefined>(
        (latest, expiry) => latest === undefined ? expiry : Math.max(latest, expiry),
        undefined
      );
    return Math.max(
      eligibleAt + RESCHEDULED_STALL_GRACE_MS,
      activeLeaseExpiry === undefined ? 0 : activeLeaseExpiry + 1_000
    );
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
    const workflowUnavailableReason = this.workflowUnavailableReason();
    if (workflowUnavailableReason) {
      return this.terminalizeSchedulingFailure(
        record,
        workflowUnavailableReason,
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

    // The retry ceiling applies to this distinct workflow-creation boundary,
    // not to the lifetime number of successful reschedules for the operation.
    let attempt = 0;
    const priorTotalAttempts = record.totalSchedulingAttemptCount ??
      record.schedulingAttemptCount ?? 0;
    let lastError = "Workflow scheduling failed.";
    while (attempt < this.maxSchedulingAttempts()) {
      attempt += 1;
      let started: ReturnType<typeof recordWorkflowSchedulingSubrequest> | undefined;
      try {
        started = recordWorkflowSchedulingSubrequest();
        const created = await this.env.SUPEROPS_CONTINUATION_WORKFLOW!.createBatch([{
          id: scheduleIdentity,
          params: {
            operationId: record.operationId,
            ownerHash: record.ownerHash,
            nextEligibleTime: record.nextEligibleTime,
            scheduleIdentity,
          },
        }]);
        const acknowledged = Array.isArray(created) && created.some((instance) =>
          instance && instance.id === scheduleIdentity
        );
        if (!acknowledged) {
          throw new Error(`Workflow createBatch did not acknowledge ${scheduleIdentity}.`);
        }
        recordSubrequestFinish(started, "workflowCreated", true);
        return {
          ...record,
          workflowId: scheduleIdentity,
          continuationMechanism: "workflow",
          continuationInstanceId: scheduleIdentity,
          schedulingAttempted: true,
          schedulingSucceeded: true,
          schedulingError: undefined,
          currentSchedulingAttemptCount: attempt,
          totalSchedulingAttemptCount: priorTotalAttempts + attempt,
          schedulingAttemptCount: priorTotalAttempts + attempt,
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
              currentSchedulingAttemptCount: started ? attempt : Math.max(0, attempt - 1),
              totalSchedulingAttemptCount: priorTotalAttempts +
                (started ? attempt : Math.max(0, attempt - 1)),
              schedulingAttemptCount: priorTotalAttempts +
                (started ? attempt : Math.max(0, attempt - 1)),
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
      {
        ...record,
        currentSchedulingAttemptCount: attempt,
        totalSchedulingAttemptCount: priorTotalAttempts + attempt,
        schedulingAttemptCount: priorTotalAttempts + attempt,
      },
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
        let normalized = startTerminalRetention(
          record,
          expireOperationLifetime(record, now),
          now
        );
        const watchdogAt = this.watchdogAlarmAt(normalized);
        const activeLease = Object.values(normalized.itemStates).some((item) => isLeaseActive(item.lease, now));
        if (!isTerminalOperation(normalized) && Number.isFinite(watchdogAt) &&
            watchdogAt <= Date.parse(now) && !activeLease) {
          if ((normalized.watchdogWakeCount ?? 0) >= MAX_WATCHDOG_WAKE_COUNT) {
            normalized = startTerminalRetention(record, terminalizeContinuationFailureInRecord(
              normalized,
              {
                operationId: normalized.operationId,
                ownerHash: normalized.ownerHash,
                errorClass: "ContinuationExecutionFailure",
                outcome: "ContinuationWatchdogExhausted",
                reason: "Durable continuation watchdog wake limit exhausted without operation progress.",
                now,
              }
            ), now);
          } else {
            normalized = startTerminalRetention(record, await this.scheduleDurableWake(normalizeOperationRecord({
              ...normalized,
              state: "Rescheduled",
              nextEligibleTime: now,
              continuationCount: normalized.continuationCount + 1,
              schedulingSucceeded: false,
              currentPauseReason: "ContinuationWatchdogRescheduled",
              watchdogWakeCount: (normalized.watchdogWakeCount ?? 0) + 1,
              lastWatchdogWakeAt: now,
              updatedAt: now,
            })), now);
          }
        }
        if (isTerminalOperation(normalized)) {
          await this.persistRecord(normalized);
          await this.deleteApprovedPrivateNotes(this.state.storage, record.operationId);
        } else if (normalized !== record) {
          await this.persistRecord(normalized);
        }
        const alarmCandidates = isTerminalOperation(normalized)
          ? [Date.parse(normalized.expiresAt)]
          : [Date.parse(normalized.maxOperationLifetimeAt ?? ""), this.watchdogAlarmAt(normalized)];
        for (const alarmAt of alarmCandidates) {
          if (Number.isFinite(alarmAt)) {
            nextAlarmAt = nextAlarmAt === undefined ? alarmAt : Math.min(nextAlarmAt, alarmAt);
          }
        }
      } else {
        const alarmAt = Date.parse(record.expiresAt);
        if (Number.isFinite(alarmAt)) {
          nextAlarmAt = nextAlarmAt === undefined ? alarmAt : Math.min(nextAlarmAt, alarmAt);
        }
      }
    }
    const signals = await this.state.storage.list<StoredEmergingIssueSignal>({ prefix: "signal:" });
    for (const [key, signal] of signals) {
      if (!key.startsWith("signal:")) continue;
      try {
        assertStoredEmergingIssueSignal(signal);
      } catch {
        await this.state.storage.delete(key);
        continue;
      }
      const normalized = expireEmergingIssueSignal(signal, now);
      if (normalized !== signal) {
        await this.state.storage.put(key, normalized);
      }
      if (normalized.signalState === "active") {
        const expiresAt = Date.parse(normalized.expiresAt);
        if (Number.isFinite(expiresAt)) {
          nextAlarmAt = nextAlarmAt === undefined ? expiresAt : Math.min(nextAlarmAt, expiresAt);
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
    const operationActionMatch = url.pathname.match(/^\/operations\/([^/]+)\/(claim-next|complete-item|checkpoint-item|schedule-continuation|cancel)$/);
    const emergingIssueSignalMatch = url.pathname.match(/^\/signals\/emerging-issue\/([^/]+)$/);

    if (request.method === "POST" && url.pathname === "/signals/emerging-issue/upsert") {
      try {
        const payload = await request.json();
        if (!isRecordObject(payload) || typeof payload.ownerHash !== "string" ||
            typeof payload.operationId !== "string" || !isRecordObject(payload.observation)) {
          return json({ errorClass: "MalformedStoredOperation", error: "Emerging issue upsert parameters are invalid." }, 422);
        }
        const params = payload as unknown as EmergingIssueUpsertParams;
        assertEmergingIssueObservation(params.observation);
        const key = emergingIssueSignalKey(params.ownerHash, params.observation.issueFingerprint);
        const existing = await this.state.storage.get<StoredEmergingIssueSignal>(key);
        if (existing) assertStoredEmergingIssueSignal(existing);
        const merged = upsertEmergingIssueSignalRecord(existing, params);
        assertStoredEmergingIssueSignal(merged.record);
        await this.state.storage.put(key, merged.record);
        await this.setEmergingIssueAlarm(merged.record);
        return json(emergingIssueUpsertResult(merged.record, params, merged.outcome));
      } catch (error) {
        if (error instanceof MalformedStoredOperationError) {
          return json({ errorClass: "MalformedStoredOperation", error: error.message }, 422);
        }
        throw error;
      }
    }

    if (request.method === "GET" && emergingIssueSignalMatch) {
      const ownerHash = url.searchParams.get("ownerHash") ?? "";
      if (!ownerHash) return json({ error: "ownerHash is required" }, 400);
      const issueFingerprint = decodeURIComponent(emergingIssueSignalMatch[1]);
      const key = emergingIssueSignalKey(ownerHash, issueFingerprint);
      const stored = await this.state.storage.get<StoredEmergingIssueSignal>(key);
      if (!stored) return json({ error: "Not found" }, 404);
      assertStoredEmergingIssueSignal(stored);
      const normalized = expireEmergingIssueSignal(stored, nowIso());
      if (normalized !== stored) {
        await this.state.storage.put(key, normalized);
      }
      await this.setEmergingIssueAlarm(normalized);
      return json(publicEmergingIssueSignal(normalized));
    }

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
        const expectedRecordHash = wrapped ? payload.expectedRecordHash : undefined;
        if (expectedRecordHash !== undefined && typeof expectedRecordHash !== "string") {
          throw new MalformedStoredOperationError("Expected operation record hash is invalid.");
        }
        if (typeof expectedRecordHash === "string") {
          const current = await this.state.storage.get<OperationLedgerRecord>(
            "op:" + record.operationId
          );
          if (!current || stableHash(current) !== expectedRecordHash) {
            return json({
              errorClass: "OperationStoreConflict",
              error: "Operation changed during metadata update.",
            }, 409);
          }
        }
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
        const scheduledAt = nowIso();
        const creditedRecord = creditDurableWaitToOperationLifetime(
          cloneRecord(record),
          params.nextEligibleTime,
          scheduledAt
        );
        const updated = normalizeOperationRecord({
          ...creditedRecord,
          state: params.nextEligibleTime ? "Rescheduled" : "ContinuationRequired",
          nextEligibleTime: params.nextEligibleTime,
          workflowId: params.workflowId ?? record.workflowId,
          currentPauseReason: params.reason,
          terminalFailureReason: undefined,
          continuationCount: alreadyScheduledFor ? record.continuationCount : record.continuationCount + 1,
          updatedAt: scheduledAt,
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

      if (action === "cancel") {
        const params = await request.json() as OperationCancelParams;
        const cancelled = startTerminalRetention(
          record,
          cancelOperationInRecord(cloneRecord(record), params),
          params.now ?? nowIso()
        );
        await this.persistRecord(cancelled);
        await this.deleteApprovedPrivateNotes(this.state.storage, operationId);
        await this.setRecordAlarm(cancelled);
        return json(cancelled);
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
