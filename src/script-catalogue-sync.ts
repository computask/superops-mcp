import { listSavedScriptMetadataPage, type Script } from "./domains/scripts.js";
import {
  getScriptCatalogueStore,
  mergeRecentRuns,
  type ScriptCatalogueObservedRecord,
  type ScriptCatalogueQueueItem,
  type ScriptCatalogueRecord,
  type ScriptCatalogueSafetyFlag,
  type ScriptCatalogueStatusRecord,
  type ScriptCatalogueSyncRun,
  type ScriptCatalogueStore,
} from "./script-catalogue-store.js";
import { loadInitialScriptCatalogue } from "./script-catalogue-seed.js";

const MAX_SYNC_PAGES = 100;
const PAGE_SIZE = 100;
const DEFAULT_SCRIPT_WEB_ORIGIN = "https://taskgroup.superops.ai";
const NO_DESCRIPTION_FROM_SUPEROPS = "No description supplied by SuperOps metadata.";
const NO_STRUCTURED_PREREQUISITES = "No script-specific prerequisites are supplied by SuperOps metadata.";
const NO_STRUCTURED_RISKS = "No structured risk data is supplied by SuperOps metadata; validate in SuperOps before separate execution approval.";
const AUTO_PUBLISHED_NEXT_STEP = "Confirm the target asset, platform, runtime values, warnings, and separate execution approval before any use; this recommendation does not execute the script.";

export interface ScriptCatalogueSyncOptions {
  scriptWebOrigin?: string;
}

export interface ScriptCataloguePullResult {
  complete: boolean;
  pagesFetched: number;
  upstreamTotalCount?: number;
  returnedCount: number;
  uniqueReturnedCount: number;
  records: ScriptCatalogueObservedRecord[];
  reason?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function safeDescription(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value
    .trim()
    .replace(/\b(password|passphrase|token|secret|api[_-]?key|activation(?:id)?|customerid|recovery\s+key)\b\s*[:=]\s*([^,;\n]+)/gi, "$1=[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .slice(0, 30_000);
}

function safeString(value: unknown, max = 1_000): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}

function safeTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tags = value.map((tag) => {
    if (typeof tag === "string") return tag.trim();
    if (typeof tag !== "object" || tag === null || Array.isArray(tag)) return "";
    const record = tag as Record<string, unknown>;
    for (const key of ["name", "label", "value", "tag"]) {
      if (typeof record[key] === "string" && record[key].trim()) return record[key].trim();
    }
    return "";
  }).filter(Boolean).map((tag) => tag.slice(0, 200));
  return tags.length > 0 ? tags.slice(0, 100) : undefined;
}

function safeRuntimeVariables(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && /^[%$A-Za-z_][%$A-Za-z0-9_.-]*$/.test(entry.trim()))
    .map((entry) => entry.trim())
    .slice(0, 100);
}

function stableHash(value: unknown): string {
  const text = JSON.stringify(value) ?? "";
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function observedRecord(script: Script, observedAt: string): ScriptCatalogueObservedRecord {
  const record = {
    version: 1 as const,
    scriptId: script.scriptId,
    name: safeString(script.name),
    description: safeDescription(script.description),
    language: safeString(script.language, 200),
    runAs: safeString(script.runAs, 200),
    runtimeVariables: safeRuntimeVariables(script.runTimeVariables),
    runtimeVariablesKnown: Array.isArray(script.runTimeVariables),
    timeOut: typeof script.timeOut === "number" && Number.isFinite(script.timeOut) ? script.timeOut : undefined,
    tags: safeTags(script.tags),
    favourite: typeof script.favourite === "boolean" ? script.favourite : undefined,
    observedAt,
  };
  return {
    ...record,
    metadataHash: stableHash({
      scriptId: record.scriptId,
      name: record.name,
      description: record.description,
      language: record.language,
      runAs: record.runAs,
      runtimeVariables: record.runtimeVariables,
      timeOut: record.timeOut,
      tags: record.tags,
      favourite: record.favourite,
    }),
  };
}

function inferredSafetyFlags(name: string, description: string): ScriptCatalogueSafetyFlag[] {
  const text = `${name}\n${description}`;
  const flags = new Set<ScriptCatalogueSafetyFlag>();
  if (/\bDO\s+NOT\s+USE\b/i.test(text)) flags.add("DO_NOT_USE");
  if (/\bTEST(?:ING)?\b|one[- ]time\s+test/i.test(text)) flags.add("TEST");
  if (/placeholder|does not .*current form|opening .*marker/i.test(text)) flags.add("PLACEHOLDER");
  if (/\blegacy\b|obsolete|old\s+script/i.test(text)) flags.add("LEGACY");
  if (/password|passphrase|token|secret|credential|activation key|recovery key|wi-?fi password|hard-coded account/i.test(text)) flags.add("CREDENTIAL_BEARING");
  if (/force(?:d)?\s+(?:a\s+)?(?:re)?start|shutdown\s*\/r\s*\/f|restart\s+forcefully/i.test(text)) flags.add("FORCED_REBOOT");
  if (/\breboot\b|\brestart(?:s|ed|ing)?\b|sign[- ]out\/sign[- ]in/i.test(text)) flags.add("REBOOTING");
  if (/destructive|recursively deletes?|\buninstalls?\b|\bdeletes?\b|\bunjoins?\b|removes? .*agent|force[- ]installs?/i.test(text)) flags.add("DESTRUCTIVE");
  if (/client[- ]specific|do not apply to|specific to (?:the )?(?:client|tenant)|embedded .*tenant|hard-coded target/i.test(text)) flags.add("CLIENT_SPECIFIC");
  return [...flags];
}

function scriptWebOrigin(value?: string): string {
  const candidate = (value ?? DEFAULT_SCRIPT_WEB_ORIGIN).trim().replace(/\/+$/u, "");
  const parsed = new URL(candidate);
  if (parsed.protocol !== "https:" || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("scriptWebOrigin must be an HTTPS origin without a path, query, or fragment.");
  }
  return candidate;
}

function scriptUrl(scriptId: string, webOrigin?: string): string {
  return `${scriptWebOrigin(webOrigin)}/#/rmm/script/${encodeURIComponent(scriptId)}/detail`;
}

function publishedRecordFromObserved(
  observed: ScriptCatalogueObservedRecord,
  current: ScriptCatalogueRecord | undefined,
  observedAt: string,
  webOrigin?: string
): ScriptCatalogueRecord {
  const name = observed.name ?? current?.name;
  if (!name) throw new Error(`SuperOps returned no script name for exact scriptId ${observed.scriptId}.`);
  const description = observed.description ?? current?.reviewedDescription ?? NO_DESCRIPTION_FROM_SUPEROPS;
  const inferredFlags = inferredSafetyFlags(name, description);
  const safetyFlags = [...new Set([...(current?.safetyFlags ?? []), ...inferredFlags])];
  return {
    version: 1,
    scriptId: observed.scriptId,
    name,
    url: current?.url ?? scriptUrl(observed.scriptId, webOrigin),
    reviewedDescription: description,
    platform: current?.platform,
    language: observed.language ?? current?.language,
    runAs: observed.runAs ?? current?.runAs,
    runtimeVariables: observed.runtimeVariablesKnown
      ? observed.runtimeVariables
      : current?.runtimeVariables ?? [],
    tags: observed.tags ?? current?.tags,
    timeOut: observed.timeOut ?? current?.timeOut,
    favourite: observed.favourite ?? current?.favourite,
    prerequisites: current?.prerequisites ?? [NO_STRUCTURED_PREREQUISITES],
    risks: current?.risks ?? [NO_STRUCTURED_RISKS],
    alternatives: current?.alternatives ?? [],
    confidence: current?.confidence ?? "Medium",
    ticketReadyNextStep: current?.ticketReadyNextStep ?? AUTO_PUBLISHED_NEXT_STEP,
    safetyFlags,
    status: "REVIEWED",
    sourceReviewedAt: observedAt,
    observedMetadataHash: observed.metadataHash,
    lastObservedAt: observed.observedAt,
  };
}

export async function pullCompleteScriptCatalogue(): Promise<ScriptCataloguePullResult> {
  const observedAt = nowIso();
  const records = new Map<string, ScriptCatalogueObservedRecord>();
  let page = 1;
  let pagesFetched = 0;
  let upstreamTotalCount: number | undefined;
  let returnedCount = 0;

  while (pagesFetched < MAX_SYNC_PAGES) {
    const pageResult = await listSavedScriptMetadataPage({ page, max: PAGE_SIZE });
    pagesFetched += 1;
    const total = pageResult.listInfo.totalCount;
    if (total !== undefined) {
      if (!Number.isFinite(total) || total < 0) {
        return {
          complete: false,
          pagesFetched,
          returnedCount,
          uniqueReturnedCount: records.size,
          records: [...records.values()],
          reason: "SuperOps returned an invalid totalCount.",
        };
      }
      if (upstreamTotalCount === undefined) upstreamTotalCount = total;
      if (upstreamTotalCount !== total) {
        return {
          complete: false,
          pagesFetched,
          upstreamTotalCount,
          returnedCount,
          uniqueReturnedCount: records.size,
          records: [...records.values()],
          reason: "SuperOps totalCount changed during pagination.",
        };
      }
    }

    returnedCount += pageResult.scripts.length;
    for (const script of pageResult.scripts) {
      if (typeof script.scriptId !== "string" || !script.scriptId.trim()) {
        return {
          complete: false,
          pagesFetched,
          upstreamTotalCount,
          returnedCount,
          uniqueReturnedCount: records.size,
          records: [...records.values()],
          reason: "SuperOps returned a script without an exact scriptId.",
        };
      }
      if (typeof script.name !== "string" || !script.name.trim()) {
        return {
          complete: false,
          pagesFetched,
          upstreamTotalCount,
          returnedCount,
          uniqueReturnedCount: records.size,
          records: [...records.values()],
          reason: "SuperOps returned a script without an exact name.",
        };
      }
      records.set(script.scriptId, observedRecord(script, observedAt));
    }

    if (pageResult.listInfo.hasMore === true) {
      page += 1;
      continue;
    }

    if (pageResult.listInfo.hasMore !== false) {
      return {
        complete: false,
        pagesFetched,
        upstreamTotalCount,
        returnedCount,
        uniqueReturnedCount: records.size,
        records: [...records.values()],
        reason: "SuperOps did not provide an explicit final hasMore=false page.",
      };
    }

    const countMatches = upstreamTotalCount !== undefined &&
      returnedCount === upstreamTotalCount &&
      records.size === upstreamTotalCount;
    return {
      complete: countMatches,
      pagesFetched,
      upstreamTotalCount,
      returnedCount,
      uniqueReturnedCount: records.size,
      records: [...records.values()],
      reason: countMatches ? undefined : "SuperOps returned incomplete or duplicate pagination results.",
    };
  }

  return {
    complete: false,
    pagesFetched,
    upstreamTotalCount,
    returnedCount,
    uniqueReturnedCount: records.size,
    records: [...records.values()],
    reason: `Pagination exceeded the ${MAX_SYNC_PAGES}-page safety limit.`,
  };
}

function queueItemFor(
  kind: "NEW" | "CHANGED" | "MISSING_RETIRED",
  observed: ScriptCatalogueObservedRecord | undefined,
  published: ScriptCatalogueRecord | undefined,
  existing: ScriptCatalogueQueueItem | undefined,
  at: string,
  fields: string[]
): ScriptCatalogueQueueItem {
  return {
    version: 1,
    scriptId: observed?.scriptId ?? published!.scriptId,
    kind,
    status: kind === "MISSING_RETIRED" ? "MISSING_RETIRED" : "UNREVIEWED",
    name: observed?.name ?? published?.name,
    changedFields: fields,
    observed,
    published: published ? {
      scriptId: published.scriptId,
      name: published.name,
      url: published.url,
      sourceReviewedAt: published.sourceReviewedAt,
    } : undefined,
    firstSeenAt: existing?.firstSeenAt ?? at,
    lastSeenAt: at,
  };
}

function safeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(password|token|secret|api[_-]?key)\b\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/[A-Za-z]:\\[^\s]+/g, "[path redacted]")
    .slice(0, 1_000);
}

function counts(queue: ScriptCatalogueQueueItem[]) {
  return queue.reduce<Record<"NEW" | "CHANGED" | "MISSING_RETIRED", number>>((result, item) => {
    result[item.kind] += 1;
    return result;
  }, { NEW: 0, CHANGED: 0, MISSING_RETIRED: 0 });
}

async function baseStatus(store: ScriptCatalogueStore): Promise<ScriptCatalogueStatusRecord> {
  const status = await store.getStatus();
  const published = await store.listPublished();
  const queue = await store.listQueue();
  return {
    ...status,
    publishedCount: published.length,
    queueCount: queue.length,
    queueByKind: counts(queue),
  };
}

export async function ensureInitialScriptCatalogueSeed(
  store = getScriptCatalogueStore()
): Promise<{ seeded: boolean; count: number }> {
  return store.seedPublished(await loadInitialScriptCatalogue());
}

export async function syncScriptCatalogue(
  store = getScriptCatalogueStore(),
  options: ScriptCatalogueSyncOptions = {}
): Promise<ScriptCatalogueSyncRun> {
  const startedAt = nowIso();
  const runId = globalThis.crypto?.randomUUID?.() ?? `catalogue-${Date.now()}`;
  await ensureInitialScriptCatalogueSeed(store);

  let pull: ScriptCataloguePullResult;
  try {
    pull = await pullCompleteScriptCatalogue();
  } catch (error) {
    const finishedAt = nowIso();
    const base = await baseStatus(store);
    const run: ScriptCatalogueSyncRun = {
      runId,
      startedAt,
      finishedAt,
      outcome: "FAILED",
      pagesFetched: 0,
      publishedCount: base.publishedCount,
      queueCount: base.queueCount,
      error: safeError(error),
    };
    await store.recordAttempt({
      run,
      status: mergeRecentRuns({ ...base, syncState: "FAILED", lastAttemptAt: finishedAt }, run),
    });
    return run;
  }

  const finishedAt = nowIso();
  if (!pull.complete) {
    const base = await baseStatus(store);
    const run: ScriptCatalogueSyncRun = {
      runId,
      startedAt,
      finishedAt,
      outcome: "INCOMPLETE",
      pagesFetched: pull.pagesFetched,
      upstreamTotalCount: pull.upstreamTotalCount,
      returnedCount: pull.returnedCount,
      uniqueReturnedCount: pull.uniqueReturnedCount,
      publishedCount: base.publishedCount,
      queueCount: base.queueCount,
      error: pull.reason,
    };
    const status = mergeRecentRuns({
      ...base,
      syncState: "INCOMPLETE",
      lastAttemptAt: finishedAt,
      upstreamTotalCount: pull.upstreamTotalCount,
    }, run);
    await store.recordAttempt({ run, status });
    return run;
  }

  const published = await store.listPublished();
  const existingQueue = await store.listQueue();
  const publishedById = new Map(published.map((record) => [record.scriptId, record]));
  const existingQueueById = new Map(existingQueue.map((item) => [item.scriptId, item]));
  const observedById = new Map(pull.records.map((record) => [record.scriptId, record]));
  const nextPublished = pull.records.map((observed) => publishedRecordFromObserved(
    observed,
    publishedById.get(observed.scriptId),
    finishedAt,
    options.scriptWebOrigin
  ));
  const queue: ScriptCatalogueQueueItem[] = [];

  for (const current of published) {
    if (!observedById.has(current.scriptId)) {
      queue.push(queueItemFor("MISSING_RETIRED", undefined, current, existingQueueById.get(current.scriptId), finishedAt, ["missingFromCompletePull"]));
    }
  }

  const run: ScriptCatalogueSyncRun = {
    runId,
    startedAt,
    finishedAt,
    outcome: "COMPLETE",
    pagesFetched: pull.pagesFetched,
    upstreamTotalCount: pull.upstreamTotalCount,
    returnedCount: pull.returnedCount,
    uniqueReturnedCount: pull.uniqueReturnedCount,
    publishedCount: nextPublished.length,
    queueCount: queue.length,
  };
  const previous = await store.getStatus();
  const status = mergeRecentRuns({
    ...previous,
    syncState: "COMPLETE",
    lastAttemptAt: finishedAt,
    lastSuccessfulSyncAt: finishedAt,
    activeObservedRunId: runId,
    upstreamTotalCount: pull.upstreamTotalCount,
    observedCount: pull.uniqueReturnedCount,
    publishedCount: nextPublished.length,
    queueCount: queue.length,
    queueByKind: counts(queue),
  }, run);
  await store.commitSync({ runId, observed: pull.records, published: nextPublished, queue, status, run });
  return run;
}
