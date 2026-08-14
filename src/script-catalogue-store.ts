import { AsyncLocalStorage } from "node:async_hooks";

export type ScriptCatalogueStatus = "REVIEWED" | "UNREVIEWED" | "MISSING_RETIRED";
export type ScriptCatalogueQueueKind = "NEW" | "CHANGED" | "MISSING_RETIRED";
export type ScriptCatalogueSyncState = "NEVER" | "COMPLETE" | "INCOMPLETE" | "FAILED";
export type ScriptCatalogueSafetyFlag =
  | "TEST"
  | "DO_NOT_USE"
  | "LEGACY"
  | "PLACEHOLDER"
  | "CLIENT_SPECIFIC"
  | "DESTRUCTIVE"
  | "CREDENTIAL_BEARING"
  | "REBOOTING"
  | "FORCED_REBOOT";

export interface ScriptCatalogueRecord {
  version: 1;
  scriptId: string;
  name: string;
  url: string;
  reviewedDescription: string;
  platform?: string;
  language?: string;
  runAs?: string;
  runtimeVariables: string[];
  tags?: string[];
  timeOut?: number;
  favourite?: boolean;
  prerequisites: string[];
  risks: string[];
  alternatives: string[];
  confidence: "High" | "Medium" | "Low";
  ticketReadyNextStep: string;
  safetyFlags: ScriptCatalogueSafetyFlag[];
  status: "REVIEWED";
  sourceReviewedAt: string;
  observedMetadataHash?: string;
  lastObservedAt?: string;
}

export interface ScriptCatalogueObservedRecord {
  version: 1;
  scriptId: string;
  name?: string;
  description?: string;
  language?: string;
  runAs?: string;
  runtimeVariables: string[];
  runtimeVariablesKnown: boolean;
  timeOut?: number;
  tags?: string[];
  favourite?: boolean;
  platform?: string;
  observedAt: string;
  metadataHash: string;
}

export interface ScriptCatalogueQueueItem {
  version: 1;
  scriptId: string;
  kind: ScriptCatalogueQueueKind;
  status: "UNREVIEWED" | "MISSING_RETIRED";
  name?: string;
  changedFields: string[];
  observed?: ScriptCatalogueObservedRecord;
  published?: Pick<ScriptCatalogueRecord, "scriptId" | "name" | "url" | "sourceReviewedAt">;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface ScriptCatalogueSyncRun {
  runId: string;
  startedAt: string;
  finishedAt: string;
  outcome: "COMPLETE" | "INCOMPLETE" | "FAILED";
  pagesFetched: number;
  upstreamTotalCount?: number;
  returnedCount?: number;
  uniqueReturnedCount?: number;
  publishedCount: number;
  queueCount: number;
  error?: string;
}

export interface ScriptCatalogueStatusRecord {
  version: 1;
  syncState: ScriptCatalogueSyncState;
  lastAttemptAt?: string;
  lastSuccessfulSyncAt?: string;
  activeObservedRunId?: string;
  upstreamTotalCount?: number;
  observedCount?: number;
  publishedCount: number;
  queueCount: number;
  queueByKind: Record<ScriptCatalogueQueueKind, number>;
  lastRun?: ScriptCatalogueSyncRun;
  recentRuns: ScriptCatalogueSyncRun[];
}

export interface ScriptCatalogueSyncCommit {
  runId: string;
  observed: ScriptCatalogueObservedRecord[];
  published: ScriptCatalogueRecord[];
  queue: ScriptCatalogueQueueItem[];
  status: ScriptCatalogueStatusRecord;
  run: ScriptCatalogueSyncRun;
}

export interface ScriptCatalogueAttempt {
  status: ScriptCatalogueStatusRecord;
  run: ScriptCatalogueSyncRun;
}

export interface ScriptCatalogueStore {
  listPublished(): Promise<ScriptCatalogueRecord[]>;
  getPublished(scriptId: string): Promise<ScriptCatalogueRecord | undefined>;
  getObserved(scriptId: string): Promise<ScriptCatalogueObservedRecord | undefined>;
  getStatus(): Promise<ScriptCatalogueStatusRecord>;
  listQueue(): Promise<ScriptCatalogueQueueItem[]>;
  seedPublished(records: ScriptCatalogueRecord[]): Promise<{ seeded: boolean; count: number }>;
  commitSync(commit: ScriptCatalogueSyncCommit): Promise<void>;
  recordAttempt(attempt: ScriptCatalogueAttempt): Promise<void>;
  publishReviewed(record: ScriptCatalogueRecord): Promise<void>;
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
}

interface DurableObjectState {
  storage: DurableObjectStorage;
}

const STORE_CONTEXT = new AsyncLocalStorage<ScriptCatalogueStore>();
const memoryPublished = new Map<string, ScriptCatalogueRecord>();
const memoryObserved = new Map<string, ScriptCatalogueObservedRecord>();
const memoryQueue = new Map<string, ScriptCatalogueQueueItem>();
let memoryStatus: ScriptCatalogueStatusRecord = emptyStatus();

const MAX_RECORDS = 2_000;
const MAX_DESCRIPTION_LENGTH = 30_000;
const MAX_QUEUE_ITEMS = 2_000;
const MAX_RECENT_RUNS = 20;

function emptyStatus(): ScriptCatalogueStatusRecord {
  return {
    version: 1,
    syncState: "NEVER",
    publishedCount: 0,
    queueCount: 0,
    queueByKind: { NEW: 0, CHANGED: 0, MISSING_RETIRED: 0 },
    recentRuns: [],
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function boundedText(value: unknown, field: string, max = MAX_DESCRIPTION_LENGTH): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  const text = value.trim();
  if (text.length > max) throw new Error(`${field} exceeds the configured length limit.`);
  return text;
}

function boundedStringArray(value: unknown, field: string, maxItems = 100): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  if (value.length > maxItems) throw new Error(`${field} has too many entries.`);
  return value.map((entry, index) => boundedText(entry, `${field}[${index}]`, 2_000));
}

function validScriptId(value: unknown): string {
  const id = boundedText(value, "scriptId", 200);
  if (!/^[A-Za-z0-9._:-]+$/.test(id)) throw new Error("scriptId contains unsupported characters.");
  return id;
}

function validUrl(value: unknown): string {
  const url = boundedText(value, "url", 1_000);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("url must be an absolute URL.");
  }
  if (parsed.protocol !== "https:") throw new Error("url must use HTTPS.");
  if (/bearer|token|secret|password|api[_-]?key/i.test(url)) {
    throw new Error("url must not contain credentials or secret-like query data.");
  }
  return url;
}

function assertSafeRecord(record: ScriptCatalogueRecord): void {
  if (record.version !== 1 || record.status !== "REVIEWED") {
    throw new Error("Only version 1 REVIEWED catalogue records can be published.");
  }
  validScriptId(record.scriptId);
  boundedText(record.name, "name", 1_000);
  validUrl(record.url);
  boundedText(record.reviewedDescription, "reviewedDescription");
  boundedStringArray(record.runtimeVariables, "runtimeVariables");
  if (record.tags !== undefined) boundedStringArray(record.tags, "tags", 100);
  if (record.timeOut !== undefined && (!Number.isFinite(record.timeOut) || record.timeOut < 0)) {
    throw new Error("timeOut must be a non-negative finite number.");
  }
  boundedStringArray(record.prerequisites, "prerequisites");
  boundedStringArray(record.risks, "risks");
  boundedStringArray(record.alternatives, "alternatives");
  boundedText(record.ticketReadyNextStep, "ticketReadyNextStep", 4_000);
  boundedStringArray(record.safetyFlags, "safetyFlags", 20);
  if (!Number.isFinite(Date.parse(record.sourceReviewedAt))) {
    throw new Error("sourceReviewedAt must be a valid timestamp.");
  }
}

function assertSafeObserved(record: ScriptCatalogueObservedRecord): void {
  if (record.version !== 1) throw new Error("Unsupported observed catalogue record version.");
  validScriptId(record.scriptId);
  if (record.name !== undefined) boundedText(record.name, "observed.name", 1_000);
  if (record.description !== undefined) boundedText(record.description, "observed.description");
  if (record.language !== undefined) boundedText(record.language, "observed.language", 200);
  if (record.runAs !== undefined) boundedText(record.runAs, "observed.runAs", 200);
  boundedStringArray(record.runtimeVariables, "observed.runtimeVariables");
  if (typeof record.runtimeVariablesKnown !== "boolean") {
    throw new Error("observed.runtimeVariablesKnown must be a boolean.");
  }
  if (record.tags !== undefined) boundedStringArray(record.tags, "observed.tags", 100);
  if (!Number.isFinite(Date.parse(record.observedAt))) throw new Error("observedAt must be a valid timestamp.");
  boundedText(record.metadataHash, "observed.metadataHash", 200);
}

function assertSafeQueueItem(item: ScriptCatalogueQueueItem): void {
  if (item.version !== 1) throw new Error("Unsupported review queue item version.");
  validScriptId(item.scriptId);
  boundedStringArray(item.changedFields, "queue.changedFields", 30);
  if (item.name !== undefined) boundedText(item.name, "queue.name", 1_000);
  if (item.observed) assertSafeObserved(item.observed);
  if (item.published) {
    validScriptId(item.published.scriptId);
    boundedText(item.published.name, "queue.published.name", 1_000);
    validUrl(item.published.url);
  }
}

function assertSafeStatus(status: ScriptCatalogueStatusRecord): void {
  if (status.version !== 1) throw new Error("Unsupported catalogue status version.");
  if (status.publishedCount < 0 || status.queueCount < 0 || status.observedCount !== undefined && status.observedCount < 0) {
    throw new Error("Catalogue status counts are invalid.");
  }
  if (status.recentRuns.length > MAX_RECENT_RUNS) throw new Error("Too many recent catalogue runs.");
}

class MemoryScriptCatalogueStore implements ScriptCatalogueStore {
  async listPublished(): Promise<ScriptCatalogueRecord[]> {
    return [...memoryPublished.values()].map(clone);
  }

  async getPublished(scriptId: string): Promise<ScriptCatalogueRecord | undefined> {
    const record = memoryPublished.get(scriptId);
    return record ? clone(record) : undefined;
  }

  async getObserved(scriptId: string): Promise<ScriptCatalogueObservedRecord | undefined> {
    const record = memoryObserved.get(scriptId);
    return record ? clone(record) : undefined;
  }

  async getStatus(): Promise<ScriptCatalogueStatusRecord> {
    return clone(memoryStatus);
  }

  async listQueue(): Promise<ScriptCatalogueQueueItem[]> {
    return [...memoryQueue.values()].map(clone);
  }

  async seedPublished(records: ScriptCatalogueRecord[]): Promise<{ seeded: boolean; count: number }> {
    if (memoryPublished.size > 0) return { seeded: false, count: memoryPublished.size };
    if (records.length > MAX_RECORDS) throw new Error("Initial catalogue is too large.");
    for (const record of records) {
      assertSafeRecord(record);
      memoryPublished.set(record.scriptId, clone(record));
    }
    memoryStatus = { ...memoryStatus, publishedCount: memoryPublished.size };
    return { seeded: true, count: memoryPublished.size };
  }

  async commitSync(commit: ScriptCatalogueSyncCommit): Promise<void> {
    if (commit.observed.length > MAX_RECORDS || commit.published.length > MAX_RECORDS || commit.queue.length > MAX_QUEUE_ITEMS) {
      throw new Error("Catalogue sync exceeds configured bounds.");
    }
    for (const record of commit.observed) {
      assertSafeObserved(record);
    }
    for (const record of commit.published) {
      assertSafeRecord(record);
    }
    for (const item of commit.queue) {
      assertSafeQueueItem(item);
    }
    assertSafeStatus(commit.status);
    for (const record of commit.observed) memoryObserved.set(record.scriptId, clone(record));
    memoryPublished.clear();
    for (const record of commit.published) memoryPublished.set(record.scriptId, clone(record));
    memoryQueue.clear();
    for (const item of commit.queue) memoryQueue.set(item.scriptId, clone(item));
    memoryStatus = clone(commit.status);
  }

  async recordAttempt(attempt: ScriptCatalogueAttempt): Promise<void> {
    assertSafeStatus(attempt.status);
    memoryStatus = clone(attempt.status);
  }

  async publishReviewed(record: ScriptCatalogueRecord): Promise<void> {
    assertSafeRecord(record);
    memoryPublished.set(record.scriptId, clone(record));
    memoryQueue.delete(record.scriptId);
    memoryStatus = {
      ...memoryStatus,
      publishedCount: memoryPublished.size,
      queueCount: memoryQueue.size,
      queueByKind: queueCounts([...memoryQueue.values()]),
    };
  }
}

class DurableScriptCatalogueStore implements ScriptCatalogueStore {
  private readonly stub: { fetch(request: Request): Promise<Response> };

  constructor(namespace: DurableObjectNamespace, tenantKey: string) {
    this.stub = namespace.get(namespace.idFromName(`tenant:${tenantKey}`));
  }

  private async call<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
    const response = await this.stub.fetch(new Request("https://script-catalogue.local/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...payload }),
    }));
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `Script catalogue storage request failed with HTTP ${response.status}.`);
    }
    return await response.json() as T;
  }

  listPublished() { return this.call<ScriptCatalogueRecord[]>("listPublished"); }
  getPublished(scriptId: string) { return this.call<ScriptCatalogueRecord | undefined>("getPublished", { scriptId }); }
  getObserved(scriptId: string) { return this.call<ScriptCatalogueObservedRecord | undefined>("getObserved", { scriptId }); }
  getStatus() { return this.call<ScriptCatalogueStatusRecord>("getStatus"); }
  listQueue() { return this.call<ScriptCatalogueQueueItem[]>("listQueue"); }
  async seedPublished(records: ScriptCatalogueRecord[]): Promise<{ seeded: boolean; count: number }> {
    // Avoid sending the bundled 434-record seed to the Durable Object on every
    // user request. A small status read establishes whether first seeding is
    // still needed; the DO remains authoritative for the race-safe write.
    const current = await this.getStatus();
    if (current.publishedCount > 0) return { seeded: false, count: current.publishedCount };
    return this.call<{ seeded: boolean; count: number }>("seedPublished", { records });
  }
  commitSync(commit: ScriptCatalogueSyncCommit) { return this.call<void>("commitSync", { commit }); }
  recordAttempt(attempt: ScriptCatalogueAttempt) { return this.call<void>("recordAttempt", { attempt }); }
  publishReviewed(record: ScriptCatalogueRecord) { return this.call<void>("publishReviewed", { record }); }
}

function queueCounts(queue: ScriptCatalogueQueueItem[]): Record<ScriptCatalogueQueueKind, number> {
  return queue.reduce<Record<ScriptCatalogueQueueKind, number>>((counts, item) => {
    counts[item.kind] += 1;
    return counts;
  }, { NEW: 0, CHANGED: 0, MISSING_RETIRED: 0 });
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function storageNowStatus(status: ScriptCatalogueStatusRecord, publishedCount: number, queue: ScriptCatalogueQueueItem[]): ScriptCatalogueStatusRecord {
  return {
    ...status,
    publishedCount,
    queueCount: queue.length,
    queueByKind: queueCounts(queue),
    recentRuns: status.recentRuns.slice(0, MAX_RECENT_RUNS),
  };
}

export class SuperOpsScriptCatalogue {
  constructor(private readonly state: DurableObjectState) {}

  private async listPublishedRecords(): Promise<ScriptCatalogueRecord[]> {
    const entries = await this.state.storage.list<ScriptCatalogueRecord>({ prefix: "published:" });
    return [...entries.entries()]
      .filter(([key]) => key.startsWith("published:") && !key.endsWith("index"))
      .map(([, value]) => {
        assertSafeRecord(value);
        return value;
      });
  }

  private async listQueueItems(): Promise<ScriptCatalogueQueueItem[]> {
    const entries = await this.state.storage.list<ScriptCatalogueQueueItem>({ prefix: "queue:" });
    return [...entries.values()].map((value) => {
      assertSafeQueueItem(value);
      return value;
    });
  }

  private async listObservedRecords(): Promise<ScriptCatalogueObservedRecord[]> {
    const activeRunId = await this.state.storage.get<string>("meta:activeObservedRunId");
    if (!activeRunId) return [];
    const entries = await this.state.storage.list<ScriptCatalogueObservedRecord>({ prefix: `observed:${activeRunId}:` });
    return [...entries.values()].map((value) => {
      assertSafeObserved(value);
      return value;
    });
  }

  private async status(): Promise<ScriptCatalogueStatusRecord> {
    const stored = await this.state.storage.get<ScriptCatalogueStatusRecord>("meta:status");
    const status = stored ? clone(stored) : emptyStatus();
    const published = await this.listPublishedRecords();
    const queue = await this.listQueueItems();
    return storageNowStatus(status, published.length, queue);
  }

  private async commitSync(commit: ScriptCatalogueSyncCommit): Promise<void> {
    if (commit.observed.length > MAX_RECORDS || commit.published.length > MAX_RECORDS || commit.queue.length > MAX_QUEUE_ITEMS) {
      throw new Error("Catalogue sync exceeds configured bounds.");
    }
    for (const record of commit.observed) {
      assertSafeObserved(record);
    }
    for (const record of commit.published) assertSafeRecord(record);
    for (const item of commit.queue) assertSafeQueueItem(item);
    assertSafeStatus(commit.status);
    for (const record of commit.observed) {
      await this.state.storage.put(`observed:${commit.runId}:${record.scriptId}`, record);
    }
    await this.state.storage.put(`observed-index:${commit.runId}`, commit.observed.map((record) => record.scriptId));
    const nextPublishedIds = new Set(commit.published.map((record) => record.scriptId));
    const existingPublished = await this.state.storage.list<ScriptCatalogueRecord>({ prefix: "published:" });
    for (const [key] of existingPublished) {
      const scriptId = key.slice("published:".length);
      if (!key.endsWith("index") && !nextPublishedIds.has(scriptId)) {
        await this.state.storage.delete(key);
      }
    }
    for (const record of commit.published) {
      await this.state.storage.put(`published:${record.scriptId}`, record);
    }
    for (const item of commit.queue) {
      await this.state.storage.put(`queue:${item.scriptId}`, item);
    }
    const existingQueue = await this.state.storage.list<ScriptCatalogueQueueItem>({ prefix: "queue:" });
    const keep = new Set(commit.queue.map((item) => item.scriptId));
    for (const [key] of existingQueue) {
      const scriptId = key.slice("queue:".length);
      if (!keep.has(scriptId)) await this.state.storage.delete(key);
    }
    const published = await this.listPublishedRecords();
    const status = storageNowStatus(commit.status, published.length, commit.queue);
    await this.state.storage.put("meta:activeObservedRunId", commit.runId);
    await this.state.storage.put("meta:status", status);
  }

  private async recordAttempt(attempt: ScriptCatalogueAttempt): Promise<void> {
    const published = await this.listPublishedRecords();
    const queue = await this.listQueueItems();
    const status = storageNowStatus(attempt.status, published.length, queue);
    assertSafeStatus(status);
    await this.state.storage.put("meta:status", status);
  }

  private async seedPublished(records: ScriptCatalogueRecord[]): Promise<{ seeded: boolean; count: number }> {
    const existing = await this.listPublishedRecords();
    if (existing.length > 0) return { seeded: false, count: existing.length };
    if (records.length > MAX_RECORDS) throw new Error("Initial catalogue is too large.");
    for (const record of records) {
      assertSafeRecord(record);
      await this.state.storage.put(`published:${record.scriptId}`, record);
    }
    const status = await this.status();
    await this.state.storage.put("meta:status", { ...status, publishedCount: records.length });
    return { seeded: true, count: records.length };
  }

  private async publishReviewed(record: ScriptCatalogueRecord): Promise<void> {
    assertSafeRecord(record);
    const observed = await this.getObserved(record.scriptId);
    if (!observed && !record.observedMetadataHash) {
      throw new Error("A reviewed record must correspond to an observed script or include an observedMetadataHash.");
    }
    await this.state.storage.put(`published:${record.scriptId}`, record);
    await this.state.storage.delete(`queue:${record.scriptId}`);
    const status = await this.status();
    await this.state.storage.put("meta:status", status);
  }

  private async getObserved(scriptId: string): Promise<ScriptCatalogueObservedRecord | undefined> {
    const activeRunId = await this.state.storage.get<string>("meta:activeObservedRunId");
    if (!activeRunId) return undefined;
    const record = await this.state.storage.get<ScriptCatalogueObservedRecord>(`observed:${activeRunId}:${scriptId}`);
    if (record) assertSafeObserved(record);
    return record;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return jsonResponse({ error: "Method not allowed." }, 405);
    try {
      const body = await request.json() as { action?: unknown; [key: string]: unknown };
      const action = body.action;
      switch (action) {
        case "listPublished": return jsonResponse(await this.listPublishedRecords());
        case "getPublished": return jsonResponse(await this.state.storage.get(`published:${validScriptId(body.scriptId)}`));
        case "getObserved": return jsonResponse(await this.getObserved(validScriptId(body.scriptId)));
        case "getStatus": return jsonResponse(await this.status());
        case "listQueue": return jsonResponse(await this.listQueueItems());
        case "seedPublished": return jsonResponse(await this.seedPublished(body.records as ScriptCatalogueRecord[]));
        case "commitSync": await this.commitSync(body.commit as ScriptCatalogueSyncCommit); return jsonResponse({ ok: true });
        case "recordAttempt": await this.recordAttempt(body.attempt as ScriptCatalogueAttempt); return jsonResponse({ ok: true });
        case "publishReviewed": await this.publishReviewed(body.record as ScriptCatalogueRecord); return jsonResponse({ ok: true });
        default: return jsonResponse({ error: "Unknown catalogue storage action." }, 400);
      }
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }
}

export function runWithScriptCatalogueStore<T>(params: {
  namespace?: unknown;
  tenantKey?: string;
  fn: () => T;
}): T {
  const namespace = params.namespace as DurableObjectNamespace | undefined;
  const store = namespace && typeof namespace.idFromName === "function" && typeof namespace.get === "function"
    ? new DurableScriptCatalogueStore(namespace, params.tenantKey ?? "default")
    : new MemoryScriptCatalogueStore();
  return STORE_CONTEXT.run(store, params.fn);
}

export function getScriptCatalogueStore(): ScriptCatalogueStore {
  return STORE_CONTEXT.getStore() ?? new MemoryScriptCatalogueStore();
}

export function mergeRecentRuns(
  status: ScriptCatalogueStatusRecord,
  run: ScriptCatalogueSyncRun
): ScriptCatalogueStatusRecord {
  return {
    ...status,
    lastRun: run,
    recentRuns: [run, ...status.recentRuns.filter((entry) => entry.runId !== run.runId)].slice(0, MAX_RECENT_RUNS),
  };
}

/** Test-only reset for the process-local fallback store. */
export function resetMemoryScriptCatalogueForTests(): void {
  memoryPublished.clear();
  memoryObserved.clear();
  memoryQueue.clear();
  memoryStatus = emptyStatus();
}
