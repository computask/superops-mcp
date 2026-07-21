import { AsyncLocalStorage } from "node:async_hooks";

export type SubrequestType =
  | "initialRead"
  | "paginationRead"
  | "metadataValidation"
  | "duplicateNoteCheck"
  | "write"
  | "fallbackWrite"
  | "verificationRead"
  | "retry"
  | "custom";

export interface ExecutionConfigInput {
  SUPEROPS_EXECUTION_SUBREQUEST_BUDGET?: string;
  SUPEROPS_EXECUTION_SUBREQUEST_SAFETY_MARGIN?: string;
  SUPEROPS_EXECUTION_MAX_ITEMS_PER_BATCH?: string;
  SUPEROPS_EXECUTION_MAX_PAGINATION_DEPTH?: string;
  SUPEROPS_EXECUTION_MAX_RETRY_ATTEMPTS?: string;
  SUPEROPS_EXECUTION_MAX_READ_RETRY_ATTEMPTS?: string;
  SUPEROPS_EXECUTION_MAX_WRITE_RETRY_ATTEMPTS?: string;
  SUPEROPS_EXECUTION_MAX_RETRY_DURATION_MS?: string;
  SUPEROPS_EXECUTION_MAX_SINGLE_DELAY_MS?: string;
  SUPEROPS_EXECUTION_BACKOFF_BASE_DELAY_MS?: string;
  SUPEROPS_EXECUTION_BACKOFF_JITTER_RATIO?: string;
  SUPEROPS_EXECUTION_SAFE_REMAINING_TIME_MS?: string;
  SUPEROPS_EXECUTION_MAX_DURATION_MS?: string;
  SUPEROPS_EXECUTION_REQUEST_TIMEOUT_MS?: string;
  SUPEROPS_EXECUTION_CPU_GUARD_MS?: string;
  SUPEROPS_EXECUTION_MAX_CONTINUATION_COUNT?: string;
  SUPEROPS_EXECUTION_MAX_DURABLE_RETRY_ATTEMPTS?: string;
  SUPEROPS_EXECUTION_MAX_DURABLE_RETRY_DURATION_MS?: string;
  SUPEROPS_EXECUTION_MAX_DURABLE_SINGLE_WAIT_MS?: string;
  SUPEROPS_EXECUTION_MAX_SCHEDULING_ATTEMPTS?: string;
  SUPEROPS_EXECUTION_VERIFICATION_MODE?: string;
  SUPEROPS_OPERATION_RETENTION_SECONDS?: string;
  SUPEROPS_OPERATION_MAX_LIFETIME_SECONDS?: string;
  SUPEROPS_EXECUTION_CONCURRENCY?: string;
}

export interface ExecutionConfig {
  subrequestBudget: number;
  subrequestSafetyMargin: number;
  maxItemsPerBatch: number;
  maxPaginationDepth: number;
  maxRetryAttempts: number;
  maxReadRetryAttempts: number;
  maxWriteRetryAttempts: number;
  maxRetryDurationMs: number;
  maxSingleDelayMs: number;
  backoffBaseDelayMs: number;
  backoffJitterRatio: number;
  safeRemainingTimeMs: number;
  maxDurationMs: number;
  requestTimeoutMs: number;
  cpuGuardMs: number;
  maxContinuationCount: number;
  maxDurableRetryAttempts: number;
  maxDurableRetryDurationMs: number;
  maxDurableSingleWaitMs: number;
  maxSchedulingAttempts: number;
  verificationMode: "mutationResponse" | "verifyReads";
  operationRetentionSeconds: number;
  operationMaxLifetimeSeconds: number;
  concurrency: number;
}

export interface SubrequestRecord {
  index: number;
  type: SubrequestType;
  operationType?: string;
  operationName?: string;
  itemKey?: string;
  status?: number | string;
  retryCount: number;
  durationMs?: number;
  ok?: boolean;
  endpoint?: string;
}

export interface RetryDelayRecord {
  attempt: number;
  source: "retry-after" | "backoff";
  retryAfterSupplied: boolean;
  suppliedDelayMs?: number;
  parsedDelayMs: number;
  cappedDelayMs: number;
  actualDelayMs: number;
  endpoint?: string;
  operationType?: string;
  operationName?: string;
  invocationId?: string;
  operationId?: string;
  itemKey?: string;
}

export interface ExecutionItemStats {
  itemKey: string;
  subrequests: number;
  writes: number;
  verificationFailures: number;
  partialWrites: number;
  stale: boolean;
}

export interface ExecutionState {
  invocationId: string;
  operationId: string;
  toolName: string;
  startedAt: string;
  startedMs: number;
  startedHighResolutionMs: number;
  finishedAt?: string;
  finishReason?: string;
  subrequests: number;
  completedItems: number;
  remainingItems: number;
  partialWrites: number;
  staleItems: number;
  verificationFailures: number;
  terminationReason?: string;
  config: ExecutionConfig;
  itemKey?: string;
  perItem: Record<string, ExecutionItemStats>;
  requests: SubrequestRecord[];
  retryCount: number;
  retryDelaysMs: number[];
  retryDelayDetails: RetryDelayRecord[];
}

const DEFAULT_CONFIG: ExecutionConfig = {
  subrequestBudget: 45,
  subrequestSafetyMargin: 8,
  maxItemsPerBatch: 25,
  maxPaginationDepth: 50,
  maxRetryAttempts: 3,
  maxReadRetryAttempts: 3,
  maxWriteRetryAttempts: 1,
  maxRetryDurationMs: 15_000,
  maxSingleDelayMs: 2_000,
  backoffBaseDelayMs: 100,
  backoffJitterRatio: 0.2,
  safeRemainingTimeMs: 5_000,
  maxDurationMs: 25_000,
  requestTimeoutMs: 10_000,
  cpuGuardMs: 20_000,
  maxContinuationCount: 100,
  maxDurableRetryAttempts: 10,
  maxDurableRetryDurationMs: 3_600_000,
  maxDurableSingleWaitMs: 900_000,
  maxSchedulingAttempts: 8,
  verificationMode: "verifyReads",
  operationRetentionSeconds: 86_400,
  operationMaxLifetimeSeconds: 21_600,
  concurrency: 1,
};

const EXECUTION_STORE = new AsyncLocalStorage<ExecutionState>();
const CONFIG_STORE = new AsyncLocalStorage<ExecutionConfig>();

export class ExecutionBudgetExceededError extends Error {
  readonly operationId: string;
  readonly invocationId: string;
  readonly toolName: string;
  readonly subrequestsUsed: number;
  readonly subrequestBudget: number;
  readonly subrequestSafetyMargin: number;
  readonly estimatedRequired: number;
  readonly retrySafe: boolean;

  constructor(state: ExecutionState, estimatedRequired: number) {
    super(
      `Execution budget exhausted before next SuperOps request. Used ${state.subrequests}/${state.config.subrequestBudget} with safety margin ${state.config.subrequestSafetyMargin}.`
    );
    this.name = "ExecutionBudgetExceededError";
    this.operationId = state.operationId;
    this.invocationId = state.invocationId;
    this.toolName = state.toolName;
    this.subrequestsUsed = state.subrequests;
    this.subrequestBudget = state.config.subrequestBudget;
    this.subrequestSafetyMargin = state.config.subrequestSafetyMargin;
    this.estimatedRequired = estimatedRequired;
    this.retrySafe = true;
  }
}

export class ExecutionTimeoutBudgetExceededError extends Error {
  readonly operationId: string;
  readonly invocationId: string;
  readonly retrySafe = true;

  constructor(state: ExecutionState) {
    super(
      `Execution time budget exhausted before next SuperOps request. Elapsed ${Date.now() - state.startedMs}ms/${state.config.maxDurationMs}ms.`
    );
    this.name = "ExecutionTimeoutBudgetExceededError";
    this.operationId = state.operationId;
    this.invocationId = state.invocationId;
  }
}

export class ExecutionCpuBudgetExceededError extends Error {
  readonly operationId: string;
  readonly invocationId: string;
  readonly retrySafe = true;

  constructor(state: ExecutionState) {
    const elapsed = (globalThis.performance?.now?.() ?? Date.now()) - state.startedHighResolutionMs;
    super(`Cooperative CPU guard reached before next unit of work. Monotonic elapsed ${Math.round(elapsed)}ms/${state.config.cpuGuardMs}ms.`);
    this.name = "ExecutionCpuBudgetExceededError";
    this.operationId = state.operationId;
    this.invocationId = state.invocationId;
  }
}

export function classifyCloudflarePlatformLimit(
  error: unknown
): "CloudflareSubrequestLimit" | "CloudflareCpuLimit" | undefined {
  const candidate = error as { name?: unknown; message?: unknown; code?: unknown } | null;
  const text = `${String(candidate?.name ?? "")} ${String(candidate?.code ?? "")} ${String(candidate?.message ?? error ?? "")}`;
  if (/too many subrequests|subrequest limit|subrequest quota/i.test(text)) {
    return "CloudflareSubrequestLimit";
  }
  if (/cpu time limit|exceeded cpu|cpu limit|error\s*1102/i.test(text)) {
    return "CloudflareCpuLimit";
  }
}
function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = value === undefined ? NaN : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function ratio(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? NaN : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(1, Math.max(0, parsed));
}

function readProcessEnv(name: keyof ExecutionConfigInput): string | undefined {
  return typeof process !== "undefined" ? process.env[name] : undefined;
}

export function executionConfigFromEnv(
  env: ExecutionConfigInput = {}
): ExecutionConfig {
  const merged = (key: keyof ExecutionConfigInput) => env[key] ?? readProcessEnv(key);
  const verificationMode =
    merged("SUPEROPS_EXECUTION_VERIFICATION_MODE") === "mutationResponse"
      ? "mutationResponse"
      : "verifyReads";

  return {
    subrequestBudget: integer(
      merged("SUPEROPS_EXECUTION_SUBREQUEST_BUDGET"),
      DEFAULT_CONFIG.subrequestBudget,
      1,
      1000
    ),
    subrequestSafetyMargin: integer(
      merged("SUPEROPS_EXECUTION_SUBREQUEST_SAFETY_MARGIN"),
      DEFAULT_CONFIG.subrequestSafetyMargin,
      0,
      250
    ),
    maxItemsPerBatch: integer(
      merged("SUPEROPS_EXECUTION_MAX_ITEMS_PER_BATCH"),
      DEFAULT_CONFIG.maxItemsPerBatch,
      1,
      500
    ),
    maxPaginationDepth: integer(
      merged("SUPEROPS_EXECUTION_MAX_PAGINATION_DEPTH"),
      DEFAULT_CONFIG.maxPaginationDepth,
      1,
      10000
    ),
    maxRetryAttempts: integer(
      merged("SUPEROPS_EXECUTION_MAX_RETRY_ATTEMPTS"),
      DEFAULT_CONFIG.maxRetryAttempts,
      1,
      20
    ),
    maxReadRetryAttempts: integer(
      merged("SUPEROPS_EXECUTION_MAX_READ_RETRY_ATTEMPTS") ??
        merged("SUPEROPS_EXECUTION_MAX_RETRY_ATTEMPTS"),
      DEFAULT_CONFIG.maxReadRetryAttempts,
      1,
      20
    ),
    maxWriteRetryAttempts: integer(
      merged("SUPEROPS_EXECUTION_MAX_WRITE_RETRY_ATTEMPTS"),
      DEFAULT_CONFIG.maxWriteRetryAttempts,
      1,
      5
    ),
    maxRetryDurationMs: integer(
      merged("SUPEROPS_EXECUTION_MAX_RETRY_DURATION_MS"),
      DEFAULT_CONFIG.maxRetryDurationMs,
      0,
      300_000
    ),
    maxSingleDelayMs: integer(
      merged("SUPEROPS_EXECUTION_MAX_SINGLE_DELAY_MS"),
      DEFAULT_CONFIG.maxSingleDelayMs,
      0,
      120_000
    ),
    backoffBaseDelayMs: integer(
      merged("SUPEROPS_EXECUTION_BACKOFF_BASE_DELAY_MS"),
      DEFAULT_CONFIG.backoffBaseDelayMs,
      0,
      60_000
    ),
    backoffJitterRatio: ratio(
      merged("SUPEROPS_EXECUTION_BACKOFF_JITTER_RATIO"),
      DEFAULT_CONFIG.backoffJitterRatio
    ),
    safeRemainingTimeMs: integer(
      merged("SUPEROPS_EXECUTION_SAFE_REMAINING_TIME_MS"),
      DEFAULT_CONFIG.safeRemainingTimeMs,
      0,
      120_000
    ),
    maxDurationMs: integer(
      merged("SUPEROPS_EXECUTION_MAX_DURATION_MS"),
      DEFAULT_CONFIG.maxDurationMs,
      1,
      300_000
    ),
    requestTimeoutMs: integer(
      merged("SUPEROPS_EXECUTION_REQUEST_TIMEOUT_MS"),
      DEFAULT_CONFIG.requestTimeoutMs,
      1,
      120_000
    ),
    cpuGuardMs: integer(
      merged("SUPEROPS_EXECUTION_CPU_GUARD_MS"), DEFAULT_CONFIG.cpuGuardMs, 1, 300_000
    ),
    maxContinuationCount: integer(
      merged("SUPEROPS_EXECUTION_MAX_CONTINUATION_COUNT"), DEFAULT_CONFIG.maxContinuationCount, 1, 10_000
    ),
    maxDurableRetryAttempts: integer(
      merged("SUPEROPS_EXECUTION_MAX_DURABLE_RETRY_ATTEMPTS"), DEFAULT_CONFIG.maxDurableRetryAttempts, 1, 1_000
    ),
    maxDurableRetryDurationMs: integer(
      merged("SUPEROPS_EXECUTION_MAX_DURABLE_RETRY_DURATION_MS"), DEFAULT_CONFIG.maxDurableRetryDurationMs, 1, 86_400_000
    ),
    maxDurableSingleWaitMs: integer(
      merged("SUPEROPS_EXECUTION_MAX_DURABLE_SINGLE_WAIT_MS"), DEFAULT_CONFIG.maxDurableSingleWaitMs, 1, 86_400_000
    ),
    maxSchedulingAttempts: integer(
      merged("SUPEROPS_EXECUTION_MAX_SCHEDULING_ATTEMPTS"), DEFAULT_CONFIG.maxSchedulingAttempts, 1, 100
    ),
    verificationMode,
    operationRetentionSeconds: integer(
      merged("SUPEROPS_OPERATION_RETENTION_SECONDS"),
      DEFAULT_CONFIG.operationRetentionSeconds,
      60,
      31_536_000
    ),
    operationMaxLifetimeSeconds: integer(
      merged("SUPEROPS_OPERATION_MAX_LIFETIME_SECONDS"),
      DEFAULT_CONFIG.operationMaxLifetimeSeconds,
      60,
      31_536_000
    ),
    concurrency: integer(
      merged("SUPEROPS_EXECUTION_CONCURRENCY"),
      DEFAULT_CONFIG.concurrency,
      1,
      16
    ),
  };
}

export function runWithExecutionConfig<T>(
  env: ExecutionConfigInput,
  fn: () => T
): T {
  return CONFIG_STORE.run(executionConfigFromEnv(env), fn);
}

export function runWithExecutionContext<T>(
  toolName: string,
  fn: () => T,
  operationId?: string
): T {
  const config = CONFIG_STORE.getStore() ?? executionConfigFromEnv();
  const state: ExecutionState = {
    invocationId: globalThis.crypto?.randomUUID?.() ?? `inv-${Date.now()}`,
    operationId:
      operationId ?? globalThis.crypto?.randomUUID?.() ?? `op-${Date.now()}`,
    toolName,
    startedAt: new Date().toISOString(),
    startedMs: Date.now(),
    startedHighResolutionMs: globalThis.performance?.now?.() ?? Date.now(),
    subrequests: 0,
    completedItems: 0,
    remainingItems: 0,
    partialWrites: 0,
    staleItems: 0,
    verificationFailures: 0,
    config,
    perItem: {},
    requests: [],
    retryCount: 0,
    retryDelaysMs: [],
    retryDelayDetails: [],
  };
  return EXECUTION_STORE.run(state, fn);
}

export function getExecutionState(): ExecutionState | undefined {
  return EXECUTION_STORE.getStore();
}

export function getExecutionConfig(): ExecutionConfig {
  return CONFIG_STORE.getStore() ?? executionConfigFromEnv();
}

export function withExecutionItem<T>(itemKey: string, fn: () => T): T {
  const state = getExecutionState();
  if (!state) return fn();
  const previous = state.itemKey;
  state.itemKey = itemKey;
  state.perItem[itemKey] ??= {
    itemKey,
    subrequests: 0,
    writes: 0,
    verificationFailures: 0,
    partialWrites: 0,
    stale: false,
  };
  try {
    const result = fn();
    const maybePromise = result as unknown as { then?: unknown };
    if (
      typeof result === "object" &&
      result !== null &&
      typeof maybePromise.then === "function"
    ) {
      return Promise.resolve(result).finally(() => {
        state.itemKey = previous;
      }) as T;
    }
    state.itemKey = previous;
    return result;
  } catch (error) {
    state.itemKey = previous;
    throw error;
  }
}

export function hasExecutionBudgetFor(estimatedRequired = 1): boolean {
  const state = getExecutionState();
  if (!state) return true;
  const effectiveLimit = state.config.subrequestBudget - state.config.subrequestSafetyMargin;
  if (state.subrequests + estimatedRequired > effectiveLimit) return false;
  const elapsed = Date.now() - state.startedMs;
  const monotonicElapsed = (globalThis.performance?.now?.() ?? Date.now()) - state.startedHighResolutionMs;
  return elapsed + state.config.safeRemainingTimeMs < state.config.maxDurationMs &&
    monotonicElapsed < state.config.cpuGuardMs;
}

export function assertExecutionBudget(estimatedRequired = 1): void {
  const state = getExecutionState();
  if (!state) return;
  const effectiveLimit = state.config.subrequestBudget - state.config.subrequestSafetyMargin;
  const monotonicElapsed = (globalThis.performance?.now?.() ?? Date.now()) - state.startedHighResolutionMs;
  if (monotonicElapsed >= state.config.cpuGuardMs) {
    state.terminationReason = "cooperativeCpuGuard";
    throw new ExecutionCpuBudgetExceededError(state);
  }
  if (state.subrequests + estimatedRequired > effectiveLimit) {
    state.terminationReason = "subrequestBudget";
    throw new ExecutionBudgetExceededError(state, estimatedRequired);
  }
  const elapsed = Date.now() - state.startedMs;
  if (elapsed + state.config.safeRemainingTimeMs >= state.config.maxDurationMs) {
    state.terminationReason = "executionTimeBudget";
    throw new ExecutionTimeoutBudgetExceededError(state);
  }
}

export function classifyGraphQLRequest(
  query: string,
  retryCount = 0
): { type: SubrequestType; operationType?: string; operationName?: string } {
  const withoutComments = query.replace(/#[^\r\n]*/g, " ");
  const match = withoutComments.match(
    /\b(query|mutation|subscription)\b\s*([_A-Za-z][_0-9A-Za-z]*)?/
  );
  const operationType = match?.[1];
  const operationName = match?.[2];
  if (retryCount > 0) return { type: "retry", operationType, operationName };
  if (operationType === "mutation") return { type: "write", operationType, operationName };
  if (/NoteList/i.test(operationName ?? query)) {
    return { type: "duplicateNoteCheck", operationType, operationName };
  }
  if (/getFields|getTechnicianGroupList|getClientList/i.test(operationName ?? query)) {
    return { type: "metadataValidation", operationType, operationName };
  }
  if (/getTicketList|getAssetList|getAlertList|getAlertsForAsset|getTechnicianList|SoftwareList|PatchDetails/i.test(operationName ?? query)) {
    return { type: "paginationRead", operationType, operationName };
  }
  if (/getTicket|getAsset|getClient/i.test(operationName ?? query)) {
    return { type: "verificationRead", operationType, operationName };
  }
  return { type: "initialRead", operationType, operationName };
}

export function recordSubrequestStart(
  query: string,
  retryCount = 0,
  endpoint?: string
): { index: number; startedMs: number; record?: SubrequestRecord } {
  const classified = classifyGraphQLRequest(query, retryCount);
  return recordTypedSubrequestStart({
    type: classified.type,
    operationType: classified.operationType,
    operationName: classified.operationName,
    retryCount,
    endpoint,
  });
}

export function recordTypedSubrequestStart(params: {
  type: SubrequestType;
  operationType?: string;
  operationName?: string;
  retryCount?: number;
  allowSafetyMargin?: boolean;
  endpoint?: string;
}): { index: number; startedMs: number; record?: SubrequestRecord } {
  const state = getExecutionState();
  if (!state) return { index: 0, startedMs: Date.now() };
  const effectiveLimit =
    state.config.subrequestBudget -
    (params.allowSafetyMargin ? 0 : state.config.subrequestSafetyMargin);
  if (state.subrequests + 1 > effectiveLimit) {
    state.terminationReason = "subrequestBudget";
    throw new ExecutionBudgetExceededError(state, 1);
  }
  const monotonicElapsed = (globalThis.performance?.now?.() ?? Date.now()) - state.startedHighResolutionMs;
  if (monotonicElapsed >= state.config.cpuGuardMs) {
    state.terminationReason = "cooperativeCpuGuard";
    throw new ExecutionCpuBudgetExceededError(state);
  }
  const elapsed = Date.now() - state.startedMs;
  if (elapsed + state.config.safeRemainingTimeMs >= state.config.maxDurationMs) {
    state.terminationReason = "executionTimeBudget";
    throw new ExecutionTimeoutBudgetExceededError(state);
  }
  state.subrequests += 1;
  const record: SubrequestRecord = {
    index: state.subrequests,
    type: params.type,
    operationType: params.operationType,
    operationName: params.operationName,
    itemKey: state.itemKey,
    retryCount: params.retryCount ?? 0,
    endpoint: params.endpoint,
  };
  state.requests.push(record);
  if (state.itemKey) {
    const item = state.perItem[state.itemKey];
    if (item) {
      item.subrequests += 1;
      if (record.type === "write" || record.type === "fallbackWrite") {
        item.writes += 1;
      }
    }
  }
  return { index: record.index, startedMs: Date.now(), record };
}

export function recordSubrequestFinish(
  started: { startedMs: number; record?: SubrequestRecord },
  status: number | string,
  ok: boolean
): void {
  if (!started.record) return;
  started.record.status = status;
  started.record.ok = ok;
  started.record.durationMs = Date.now() - started.startedMs;
}

export function markExecutionItem(params: {
  completed?: boolean;
  remainingItems?: number;
  partialWrite?: boolean;
  stale?: boolean;
  verificationFailure?: boolean;
}): void {
  const state = getExecutionState();
  if (!state) return;
  if (params.completed) state.completedItems += 1;
  if (typeof params.remainingItems === "number") {
    state.remainingItems = Math.max(0, params.remainingItems);
  }
  const item = state.itemKey ? state.perItem[state.itemKey] : undefined;
  if (params.partialWrite) {
    state.partialWrites += 1;
    if (item) item.partialWrites += 1;
  }
  if (params.stale) {
    state.staleItems += 1;
    if (item) item.stale = true;
  }
  if (params.verificationFailure) {
    state.verificationFailures += 1;
    if (item) item.verificationFailures += 1;
  }
}

export function recordRetryDelay(
  delay: number | Omit<RetryDelayRecord, "invocationId" | "operationId" | "itemKey">
): void {
  const state = getExecutionState();
  if (!state) return;
  const actualDelayMs = typeof delay === "number" ? delay : delay.actualDelayMs;
  state.retryCount += 1;
  state.retryDelaysMs.push(actualDelayMs);
  state.retryDelayDetails.push(typeof delay === "number"
    ? {
        attempt: state.retryCount,
        source: "backoff",
        retryAfterSupplied: false,
        parsedDelayMs: actualDelayMs,
        cappedDelayMs: actualDelayMs,
        actualDelayMs,
        invocationId: state.invocationId,
        operationId: state.operationId,
        itemKey: state.itemKey,
      }
    : {
        ...delay,
        invocationId: state.invocationId,
        operationId: state.operationId,
        itemKey: state.itemKey,
      });
}

export function finishExecution(reason: string): void {
  const state = getExecutionState();
  if (!state) return;
  state.finishedAt = new Date().toISOString();
  state.finishReason = reason;
}

export function executionDiagnostics(): Record<string, unknown> | undefined {
  const state = getExecutionState();
  if (!state) return undefined;
  return {
    invocationId: state.invocationId,
    operationId: state.operationId,
    toolName: state.toolName,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    finishReason: state.finishReason,
    terminationReason: state.terminationReason,
    durationMs: Date.now() - state.startedMs,
    subrequests: {
      used: state.subrequests,
      budget: state.config.subrequestBudget,
      safetyMargin: state.config.subrequestSafetyMargin,
      remainingBeforeMargin: Math.max(
        0,
        state.config.subrequestBudget - state.config.subrequestSafetyMargin - state.subrequests
      ),
    },
    items: {
      completed: state.completedItems,
      remaining: state.remainingItems,
      partialWrites: state.partialWrites,
      stale: state.staleItems,
      verificationFailures: state.verificationFailures,
      perItem: Object.values(state.perItem),
    },
    retries: {
      count: state.retryCount,
      delaysMs: state.retryDelaysMs,
      details: state.retryDelayDetails,
    },
    requestsByType: state.requests.reduce<Record<string, number>>((counts, request) => {
      counts[request.type] = (counts[request.type] ?? 0) + 1;
      return counts;
    }, {}),
  };
}

export function logExecutionDiagnostics(success: boolean, errorSummary?: string): void {
  const diagnostics = executionDiagnostics();
  if (!diagnostics) return;
  console.log(
    JSON.stringify({
      event: "mcp.execution",
      timestamp: new Date().toISOString(),
      success,
      errorSummary,
      ...diagnostics,
    })
  );
}
