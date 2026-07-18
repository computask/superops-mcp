import { AsyncLocalStorage } from "node:async_hooks";
import { getAuditContext } from "./audit.js";
import { recordSubrequestFinish, recordTypedSubrequestStart } from "./execution.js";

export type OperationState =
  | "Running"
  | "ContinuationRequired"
  | "Completed"
  | "Failed"
  | "Cancelled";

export interface OperationItemState {
  itemKey: string;
  stage:
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
    | "Stale"
    | "Skipped"
    | "FailedBeforeWrite"
    | "FailedAfterPartialWrite"
    | "RateLimited"
    | "Rescheduled"
    | "Unattempted";
  outcome?: string;
  idempotencyKey: string;
  writeAttempted: boolean;
  writeMayHaveSucceeded: boolean;
  partialWrite: boolean;
  noteFingerprint?: string;
  verificationState?: "NotRequired" | "Pending" | "Verified" | "Failed";
  retryCount: number;
  nextEligibleTime?: string;
  failureReason?: string;
  updatedTimeExpectation?: string;
  targetFields?: Record<string, unknown>;
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
}

export interface OperationStore {
  put(record: OperationLedgerRecord): Promise<void>;
  get(operationId: string): Promise<OperationLedgerRecord | undefined>;
  list(ownerHash: string): Promise<OperationLedgerRecord[]>;
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

function isDurableObjectNamespace(value: unknown): value is DurableObjectNamespace {
  return typeof value === "object" &&
    value !== null &&
    typeof (value as { idFromName?: unknown }).idFromName === "function" &&
    typeof (value as { get?: unknown }).get === "function";
}

class MemoryOperationStore implements OperationStore {
  async put(record: OperationLedgerRecord): Promise<void> {
    memoryRecords.set(record.operationId, record);
  }

  async get(operationId: string): Promise<OperationLedgerRecord | undefined> {
    return memoryRecords.get(operationId);
  }

  async list(ownerHash: string): Promise<OperationLedgerRecord[]> {
    return [...memoryRecords.values()].filter(
      (record) => record.ownerHash === ownerHash
    );
  }
}

class DurableObjectOperationStore implements OperationStore {
  constructor(private readonly namespace: DurableObjectNamespace) {}

  private stub(operationId = "operations") {
    return this.namespace.get(this.namespace.idFromName(operationId));
  }

  async put(record: OperationLedgerRecord): Promise<void> {
    const started = recordOperationStoreSubrequest("operationStore.put");
    let response: Response;
    try {
      response = await this.stub(record.operationId).fetch(
        new Request(`https://operation.local/operations/${record.operationId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(record),
        })
      );
    } catch (error) {
      recordSubrequestFinish(started, "operationStoreError", false);
      throw error;
    }
    recordSubrequestFinish(started, response.status, response.ok);
    if (!response.ok) {
      throw new Error(`Operation store put failed: ${response.status}`);
    }
  }

  async get(operationId: string): Promise<OperationLedgerRecord | undefined> {
    const started = recordOperationStoreSubrequest("operationStore.get");
    let response: Response;
    try {
      response = await this.stub(operationId).fetch(
        new Request(`https://operation.local/operations/${operationId}`)
      );
    } catch (error) {
      recordSubrequestFinish(started, "operationStoreError", false);
      throw error;
    }
    recordSubrequestFinish(started, response.status, response.ok);
    if (response.status === 404) return undefined;
    if (!response.ok) {
      throw new Error(`Operation store get failed: ${response.status}`);
    }
    return (await response.json()) as OperationLedgerRecord;
  }

  async list(ownerHash: string): Promise<OperationLedgerRecord[]> {
    const started = recordOperationStoreSubrequest("operationStore.list");
    let response: Response;
    try {
      response = await this.stub("operations").fetch(
        new Request(`https://operation.local/operations?ownerHash=${ownerHash}`)
      );
    } catch (error) {
      recordSubrequestFinish(started, "operationStoreError", false);
      throw error;
    }
    recordSubrequestFinish(started, response.status, response.ok);
    if (!response.ok) {
      throw new Error(`Operation store list failed: ${response.status}`);
    }
    return (await response.json()) as OperationLedgerRecord[];
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
    rateLimitedItems: record.rateLimitedItems,
    nextEligibleTime: record.nextEligibleTime,
    continuationCount: record.continuationCount,
    terminalFailureReason: record.terminalFailureReason,
    summary: record.summary,
    results: record.compactResults,
  };
}

export class SuperOpsOperationLedger {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const operationMatch = url.pathname.match(/^\/operations\/([^/]+)$/);

    if (request.method === "PUT" && operationMatch) {
      const record = (await request.json()) as OperationLedgerRecord;
      await this.state.storage.put(`op:${operationMatch[1]}`, record);
      return json({ ok: true });
    }

    if (request.method === "GET" && operationMatch) {
      const record = await this.state.storage.get<OperationLedgerRecord>(
        `op:${operationMatch[1]}`
      );
      return record ? json(record) : json({ error: "Not found" }, 404);
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
