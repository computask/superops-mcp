import type { ToolDefinition } from "./types.js";
import type { ToolResult } from "./audit.js";

/**
 * A deliberately isolated, read-only upstream rate-limit probe.
 *
 * This does not use SuperOpsClient.query(): the normal client deliberately
 * retries reads, which would hide the first upstream rejection. The probe
 * sends one minimal list query per attempt, records only bounded
 * response metadata, and never persists the response body.
 */

const PROBE_DURATION_MS = 30 * 60 * 1_000;
const PROBE_INTERVAL_MS = 10_000;
const PROBE_REQUEST_TIMEOUT_MS = 8_000;
const MAX_EVENTS_PER_RUN = 10_000;
const MAX_RESULTS_PAGE_SIZE = 200;

export type RateLimitProbeTask = "getClientList" | "getTicketList";

const DEFAULT_RATE_LIMIT_PROBE_TASK: RateLimitProbeTask = "getClientList";

const RATE_LIMIT_PROBE_QUERIES: Record<RateLimitProbeTask, string> = {
  getClientList: `
    query getClientList($input: ListInfoInput!) {
      getClientList(input: $input) {
        clients { accountId }
        listInfo { page pageSize hasMore totalCount }
      }
    }
  `,
  getTicketList: `
    query getTicketList($input: ListInfoInput!) {
      getTicketList(input: $input) {
        tickets { ticketId displayId }
        listInfo { page pageSize hasMore totalCount }
      }
    }
  `,
};

const RATE_LIMIT_PROBE_VARIABLES = {
  input: {
    page: 1,
    pageSize: 1,
  },
};

export const RATE_LIMIT_PROBE_TOOLS: ToolDefinition[] = [
  {
    name: "superops_rate_limit_probe_start",
    description:
      "Start one fixed 30-minute, read-only SuperOps API rate-limit probe for getClientList or getTicketList. It bypasses MCP read retries, records safe per-attempt outcomes, and never writes tickets or stores response content. Only one probe may run at a time. Defaults to getClientList.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          enum: ["getClientList", "getTicketList"],
          description: "The exact read operation to probe. Defaults to getClientList.",
        },
      },
    },
  },
  {
    name: "superops_rate_limit_probe_status",
    description:
      "Read the current or named rate-limit probe status and aggregate results. Does not call SuperOps.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Optional probe run ID." },
      },
    },
  },
  {
    name: "superops_rate_limit_probe_results",
    description:
      "Read a bounded page of redacted per-request rate-limit probe events. Does not call SuperOps.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Probe run ID." },
        cursor: {
          type: "integer",
          minimum: 0,
          description: "Zero-based event cursor returned by the previous page.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_RESULTS_PAGE_SIZE,
          description: "Maximum events to return (default 100, max 200).",
        },
      },
      required: ["runId"],
    },
  },
  {
    name: "superops_rate_limit_probe_stop",
    description:
      "Stop the active rate-limit probe early. Does not call SuperOps and does not delete captured diagnostics.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Exact active probe run ID." },
        reason: {
          type: "string",
          maxLength: 160,
          description: "Short operational reason; do not include secrets or customer content.",
        },
      },
      required: ["runId"],
    },
  },
];

type ProbeStatus = "running" | "completed" | "stopped" | "failed";
type ProbeOutcome =
  | "success"
  | "http_error"
  | "graphql_error"
  | "rate_limited"
  | "network_error"
  | "request_timeout"
  | "malformed_response";

interface ProbePhase {
  name: string;
  startSecond: number;
  endSecond: number;
  requestsPerMinute: number;
}

export const RATE_LIMIT_PROBE_PHASES: readonly ProbePhase[] = [
  { name: "steady_60_per_minute", startSecond: 0, endSecond: 300, requestsPerMinute: 60 },
  { name: "steady_90_per_minute", startSecond: 300, endSecond: 600, requestsPerMinute: 90 },
  { name: "steady_100_per_minute", startSecond: 600, endSecond: 900, requestsPerMinute: 100 },
  { name: "steady_120_per_minute", startSecond: 900, endSecond: 1_200, requestsPerMinute: 120 },
  { name: "steady_150_per_minute", startSecond: 1_200, endSecond: 1_500, requestsPerMinute: 150 },
  { name: "recovery_30_per_minute", startSecond: 1_500, endSecond: 1_800, requestsPerMinute: 30 },
];

interface ProbeHeaders {
  rateLimitLimit?: number;
  rateLimitRemaining?: number;
  rateLimitResetSeconds?: number;
}

interface ProbeEvent {
  version: 1;
  runId: string;
  task: RateLimitProbeTask;
  sequence: number;
  phase: string;
  targetRequestsPerMinute: number;
  scheduledAt: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  tenant: string;
  endpointHost: "api.superops.ai" | "euapi.superops.ai";
  httpStatus?: number;
  ok: boolean;
  outcome: ProbeOutcome;
  errorClass?: string;
  graphqlCode?: string;
  rateLimited: boolean;
  retryAfterSeconds?: number;
  rateLimitLimit?: number;
  rateLimitRemaining?: number;
  rateLimitResetSeconds?: number;
}

interface ProbeRun {
  version: 1;
  runId: string;
  task: RateLimitProbeTask;
  status: ProbeStatus;
  startedAt: string;
  deadlineAt: string;
  finishedAt?: string;
  stoppedReason?: string;
  endpointHost: "api.superops.ai" | "euapi.superops.ai";
  tenant: string;
  nextSequence: number;
  fractionalBatch: number;
  totalAttempts: number;
  successfulAttempts: number;
  failedAttempts: number;
  rateLimitedAttempts: number;
  malformedAttempts: number;
  networkAttempts: number;
  firstRateLimitedAt?: string;
  firstRateLimitedPhase?: string;
  lastEventAt?: string;
  lastOutcome?: ProbeOutcome;
  lastHttpStatus?: number;
  lastPhase?: string;
  currentPhase?: string;
  currentTargetRequestsPerMinute?: number;
}

interface ProbeNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

export interface RateLimitProbeAdapter {
  tools: ToolDefinition[];
  handleCall(name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

interface ProbeEnvironment {
  SUPEROPS_API_TOKEN?: string;
  SUPEROPS_SUBDOMAIN?: string;
  SUPEROPS_REGION?: string;
  SUPEROPS_RATE_LIMIT_PROBE_ENABLED?: string;
}

interface ProbeStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T = unknown>(options?: { prefix?: string }): Promise<Map<string, T>>;
  setAlarm?(scheduledTime: number | Date): Promise<void>;
  deleteAlarm?(): Promise<void>;
}

interface ProbeState {
  storage: ProbeStorage;
}

function uuid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `probe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

function safeToken(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const token = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(token) && !/^(sk-|eyJ|Bearer)/i.test(token)
    ? token
    : undefined;
}

function safeTenant(value: string): string {
  return /^[a-z0-9-]{1,63}$/.test(value) ? value : "unknown";
}

function safeReason(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const reason = value.trim().replace(/[\r\n]+/g, " ").slice(0, 160);
  return reason || undefined;
}

function parseProbeTask(value: unknown): RateLimitProbeTask {
  if (value === undefined || value === null || value === "") return DEFAULT_RATE_LIMIT_PROBE_TASK;
  if (value === "getClientList" || value === "getTicketList") return value;
  throw new Error("task must be getClientList or getTicketList.");
}

function endpointFor(region: string | undefined): "api.superops.ai" | "euapi.superops.ai" {
  return region === "eu" ? "euapi.superops.ai" : "api.superops.ai";
}

function parseNonNegativeNumber(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 86_400 ? parsed : undefined;
}

function retryAfterSeconds(headers: Headers): number | undefined {
  const value = headers.get("retry-after");
  if (value) {
    const seconds = parseNonNegativeNumber(value);
    if (seconds !== undefined) return seconds;
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1_000));
  }
  for (const name of ["x-ratelimit-reset", "ratelimit-reset", "x-rate-limit-reset"]) {
    const value = headers.get(name);
    const parsed = parseNonNegativeNumber(value);
    if (parsed === undefined) continue;
    // Reset headers are commonly epoch seconds; accept a relative value too.
    return parsed > 1_000_000_000 ? Math.max(0, Math.ceil(parsed - Date.now() / 1_000)) : parsed;
  }
  return undefined;
}

function rateLimitHeaders(headers: Headers): ProbeHeaders {
  const get = (names: string[]): number | undefined => {
    for (const name of names) {
      const parsed = parseNonNegativeNumber(headers.get(name));
      if (parsed !== undefined) return parsed;
    }
    return undefined;
  };
  const reset = get(["x-ratelimit-reset", "ratelimit-reset", "x-rate-limit-reset"]);
  return {
    rateLimitLimit: get(["x-ratelimit-limit", "ratelimit-limit", "x-rate-limit-limit"]),
    rateLimitRemaining: get(["x-ratelimit-remaining", "ratelimit-remaining", "x-rate-limit-remaining"]),
    rateLimitResetSeconds:
      reset === undefined ? undefined : reset > 1_000_000_000 ? Math.max(0, Math.ceil(reset - Date.now() / 1_000)) : reset,
  };
}

function phaseFor(startedAt: number, now = Date.now()): ProbePhase {
  const elapsedSecond = Math.max(0, (now - startedAt) / 1_000);
  return RATE_LIMIT_PROBE_PHASES.find((phase) => elapsedSecond < phase.endSecond)
    ?? RATE_LIMIT_PROBE_PHASES[RATE_LIMIT_PROBE_PHASES.length - 1];
}

function emitAttemptStarted(params: {
  callId: string;
  runId: string;
  task: RateLimitProbeTask;
  tenant: string;
  endpointHost: string;
  startedAt: string;
  sequence: number;
}): void {
  console.log(JSON.stringify({
    event: "superops.api_attempt_started",
    callId: params.callId,
    startedAt: params.startedAt,
    requestId: `rate-limit-probe-${params.runId}`,
    invocationId: `rate-limit-probe-${params.runId}`,
    executionTraceId: params.runId,
    toolName: "superops_rate_limit_probe",
    task: params.task,
    callIndex: params.sequence,
    tenant: safeTenant(params.tenant),
    endpointHost: params.endpointHost,
    endpointPath: "/msp",
    requestPurpose: "initialRead",
    operationType: "query",
    operationName: params.task,
    attempt: 1,
  }));
}

function emitAttemptFinished(event: ProbeEvent, callId: string): void {
  console.log(JSON.stringify({
    event: "superops.api_attempt_finished",
    callId,
    startedAt: event.startedAt,
    completedAt: event.completedAt,
    requestId: `rate-limit-probe-${event.runId}`,
    invocationId: `rate-limit-probe-${event.runId}`,
    executionTraceId: event.runId,
    toolName: "superops_rate_limit_probe",
    task: event.task,
    callIndex: event.sequence,
    tenant: safeTenant(event.tenant),
    endpointHost: event.endpointHost,
    endpointPath: "/msp",
    requestPurpose: "initialRead",
    operationType: "query",
    operationName: event.task,
    attempt: 1,
    durationMs: event.durationMs,
    ok: event.ok,
    httpStatus: event.httpStatus,
    outcome: event.outcome,
    errorClass: event.errorClass,
    graphqlCode: event.graphqlCode,
    rateLimited: event.rateLimited,
    retryAfterSeconds: event.retryAfterSeconds,
  }));
}

interface GraphqlErrorInfo {
  code?: string;
  rateLimited: boolean;
  retryAfterSeconds?: number;
}

function parseGraphqlRetryAfter(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 86_400) return value;
  if (typeof value !== "string") return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 86_400) return seconds;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1_000)) : undefined;
}

function graphqlErrorInfo(body: unknown): GraphqlErrorInfo {
  const info: GraphqlErrorInfo = { rateLimited: false };
  if (!body || typeof body !== "object" || Array.isArray(body)) return info;
  const errors = (body as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return info;
  for (const item of errors) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const message = typeof (item as { message?: unknown }).message === "string"
      ? (item as { message: string }).message
      : "";
    const extensions = (item as { extensions?: unknown }).extensions;
    const extensionRecord = extensions && typeof extensions === "object" && !Array.isArray(extensions)
      ? extensions as Record<string, unknown>
      : undefined;
    const code = safeToken(extensionRecord?.code);
    info.code ??= code;
    info.retryAfterSeconds ??= parseGraphqlRetryAfter(extensionRecord?.retryAfter) ??
      parseGraphqlRetryAfter(extensionRecord?.retry_after) ??
      parseGraphqlRetryAfter(extensionRecord?.retryAfterSeconds);
    const codeText = (code ?? "").toLowerCase();
    const extensionText = extensionRecord ? JSON.stringify(extensionRecord).toLowerCase() : "";
    const negative = /\bnot\s+(a\s+)?rate[-\s]?limit(?:ed|ing)?\b/i.test(message);
    if (!negative && (
      codeText.includes("rate") ||
      codeText.includes("thrott") ||
      codeText === "too_many_requests" ||
      codeText === "rate_limit_exceeded" ||
      extensionText.includes("rate_limit_exceeded") ||
      extensionText.includes("too_many_requests") ||
      extensionText.includes("throttl") ||
      /\b(rate[-\s]?limit(?:ed|ing)?|too many requests|throttl(?:e|ed|ing))\b/i.test(message)
    )) {
      info.rateLimited = true;
    }
  }
  return info;
}

function isGraphqlError(body: unknown): boolean {
  return Boolean(body && typeof body === "object" && !Array.isArray(body) &&
    Array.isArray((body as { errors?: unknown }).errors) &&
    ((body as { errors: unknown[] }).errors.length > 0));
}

function bodyHasData(body: unknown): boolean {
  return Boolean(body && typeof body === "object" && !Array.isArray(body) &&
    (body as { data?: unknown }).data);
}

async function performProbeAttempt(params: {
  run: ProbeRun;
  sequence: number;
  phase: ProbePhase;
  scheduledAt: string;
  apiToken: string;
}): Promise<ProbeEvent> {
  const endpointHost = params.run.endpointHost;
  const endpoint = `https://${endpointHost}/msp`;
  const task = params.run.task ?? DEFAULT_RATE_LIMIT_PROBE_TASK;
  const startedAt = new Date().toISOString();
  const callId = uuid();
  emitAttemptStarted({
    callId,
    runId: params.run.runId,
    task,
    tenant: params.run.tenant,
    endpointHost,
    startedAt,
    sequence: params.sequence,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_REQUEST_TIMEOUT_MS);
  let httpStatus: number | undefined;
  let outcome: ProbeOutcome = "network_error";
  let errorClass = "UpstreamNetworkFailure";
  let graphqlCode: string | undefined;
  let rateLimited = false;
  let retryAfter: number | undefined;
  let headers: ProbeHeaders = {};
  let ok = false;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.apiToken}`,
        CustomerSubDomain: params.run.tenant,
      },
      body: JSON.stringify({ query: RATE_LIMIT_PROBE_QUERIES[task], variables: RATE_LIMIT_PROBE_VARIABLES }),
      signal: controller.signal,
    });
    httpStatus = response.status;
    headers = rateLimitHeaders(response.headers);
    retryAfter = retryAfterSeconds(response.headers);
    if (response.status === 429) {
      outcome = "rate_limited";
      errorClass = "SuperOpsRateLimit";
      rateLimited = true;
    } else if (!response.ok) {
      outcome = "http_error";
      errorClass = response.status >= 500 ? "SuperOpsInternalError" : "SuperOpsHttpError";
    } else {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        outcome = "malformed_response";
        errorClass = "MalformedResponse";
        body = undefined;
      }
      if (body !== undefined) {
        const graphqlInfo = graphqlErrorInfo(body);
        graphqlCode = graphqlInfo.code;
        if (isGraphqlError(body)) {
          rateLimited = graphqlInfo.rateLimited;
          outcome = rateLimited ? "rate_limited" : "graphql_error";
          errorClass = rateLimited ? "SuperOpsRateLimit" : "SuperOpsGraphQLError";
          retryAfter = retryAfter ?? graphqlInfo.retryAfterSeconds;
        } else if (bodyHasData(body)) {
          outcome = "success";
          errorClass = "";
          ok = true;
        } else {
          outcome = "malformed_response";
          errorClass = "MalformedResponse";
        }
      }
    }
  } catch (error) {
    if (controller.signal.aborted) {
      outcome = "request_timeout";
      errorClass = "SuperOpsRequestTimeout";
    } else {
      outcome = "network_error";
      errorClass = "UpstreamNetworkFailure";
    }
    if (error instanceof Error && error.name === "AbortError") {
      outcome = "request_timeout";
      errorClass = "SuperOpsRequestTimeout";
    }
  } finally {
    clearTimeout(timer);
  }
  const completedAt = new Date().toISOString();
  const event: ProbeEvent = {
    version: 1,
    runId: params.run.runId,
    task,
    sequence: params.sequence,
    phase: params.phase.name,
    targetRequestsPerMinute: params.phase.requestsPerMinute,
    scheduledAt: params.scheduledAt,
    startedAt,
    completedAt,
    durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
    tenant: params.run.tenant,
    endpointHost,
    httpStatus,
    ok,
    outcome,
    errorClass: errorClass || undefined,
    graphqlCode,
    rateLimited,
    retryAfterSeconds: retryAfter,
    ...headers,
  };
  emitAttemptFinished(event, callId);
  return event;
}

function resultSummary(run: ProbeRun): Record<string, unknown> {
  const elapsedMs = Math.max(0, Date.parse(run.finishedAt ?? new Date().toISOString()) - Date.parse(run.startedAt));
  return {
    runId: run.runId,
    task: run.task ?? DEFAULT_RATE_LIMIT_PROBE_TASK,
    status: run.status,
    startedAt: run.startedAt,
    deadlineAt: run.deadlineAt,
    finishedAt: run.finishedAt,
    elapsedSeconds: Math.round(elapsedMs / 1_000),
    endpointHost: run.endpointHost,
    tenant: run.tenant,
    totalAttempts: run.totalAttempts,
    successfulAttempts: run.successfulAttempts,
    failedAttempts: run.failedAttempts,
    rateLimitedAttempts: run.rateLimitedAttempts,
    malformedAttempts: run.malformedAttempts,
    networkAttempts: run.networkAttempts,
    firstRateLimitedAt: run.firstRateLimitedAt,
    firstRateLimitedPhase: run.firstRateLimitedPhase,
    currentPhase: run.currentPhase,
    currentTargetRequestsPerMinute: run.currentTargetRequestsPerMinute,
    lastEventAt: run.lastEventAt,
    lastOutcome: run.lastOutcome,
    lastHttpStatus: run.lastHttpStatus,
    stoppedReason: run.stoppedReason,
    phases: RATE_LIMIT_PROBE_PHASES,
    interpretation: "Probe outcomes are attributable to this probe, but SuperOps limits may be tenant-wide; concurrent non-probe calls are a possible confounder.",
  };
}

export class SuperOpsRateLimitProbe {
  constructor(
    private readonly state: ProbeState,
    private readonly env: ProbeEnvironment
  ) {}

  private async activeRun(): Promise<ProbeRun | undefined> {
    return await this.state.storage.get<ProbeRun>("active");
  }

  private async persistRun(run: ProbeRun): Promise<void> {
    await this.state.storage.put("active", run);
    await this.state.storage.put(`run:${run.runId}`, run);
  }

  private async finishRun(run: ProbeRun, status: Extract<ProbeStatus, "completed" | "stopped" | "failed">, reason?: string): Promise<ProbeRun> {
    const finished: ProbeRun = {
      ...run,
      status,
      finishedAt: new Date().toISOString(),
      stoppedReason: reason,
    };
    await this.persistRun(finished);
    await this.state.storage.deleteAlarm?.();
    return finished;
  }

  private async start(taskInput?: unknown): Promise<Record<string, unknown>> {
    if (this.env.SUPEROPS_RATE_LIMIT_PROBE_ENABLED !== "true") {
      throw new Error("The rate-limit probe is disabled by SUPEROPS_RATE_LIMIT_PROBE_ENABLED.");
    }
    const token = this.env.SUPEROPS_API_TOKEN?.trim();
    const tenant = this.env.SUPEROPS_SUBDOMAIN?.trim().toLowerCase();
    if (!token || !tenant) throw new Error("Probe requires the configured SuperOps Worker credentials.");
    const task = parseProbeTask(taskInput);
    const existing = await this.activeRun();
    if (existing?.status === "running" && Date.parse(existing.deadlineAt) > Date.now()) {
      return { accepted: false, reason: "already_running", ...resultSummary(existing) };
    }
    const startedAt = new Date();
    const run: ProbeRun = {
      version: 1,
      runId: uuid(),
      task,
      status: "running",
      startedAt: startedAt.toISOString(),
      deadlineAt: new Date(startedAt.getTime() + PROBE_DURATION_MS).toISOString(),
      endpointHost: endpointFor(this.env.SUPEROPS_REGION),
      tenant: safeTenant(tenant),
      nextSequence: 1,
      fractionalBatch: 0,
      totalAttempts: 0,
      successfulAttempts: 0,
      failedAttempts: 0,
      rateLimitedAttempts: 0,
      malformedAttempts: 0,
      networkAttempts: 0,
    };
    await this.persistRun(run);
    if (this.state.storage.setAlarm) await this.state.storage.setAlarm(Date.now() + 100);
    return {
      accepted: true,
      ...resultSummary(run),
      task,
      schedule: "60/90/100/120/150/30 requests per minute, five minutes per phase, no automatic retries",
    };
  }

  private async status(runId?: string): Promise<Record<string, unknown>> {
    const run = runId
      ? await this.state.storage.get<ProbeRun>(`run:${runId}`)
      : await this.activeRun();
    if (!run) throw new Error("Probe run was not found.");
    return resultSummary(run);
  }

  private async results(runId: string, cursor: number, limit: number): Promise<Record<string, unknown>> {
    const run = await this.state.storage.get<ProbeRun>(`run:${runId}`);
    if (!run) throw new Error("Probe run was not found.");
    const entries = await this.state.storage.list<ProbeEvent>({ prefix: `event:${runId}:` });
    const events = [...entries.values()].sort((a, b) => a.sequence - b.sequence);
    const boundedCursor = Math.max(0, Math.min(cursor, events.length));
    const boundedLimit = Math.max(1, Math.min(limit, MAX_RESULTS_PAGE_SIZE));
    const page = events.slice(boundedCursor, boundedCursor + boundedLimit);
    const nextCursor = boundedCursor + page.length < events.length ? boundedCursor + page.length : undefined;
    return {
      runId,
      status: run.status,
      cursor: boundedCursor,
      limit: boundedLimit,
      events: page,
      nextCursor,
      totalEvents: events.length,
    };
  }

  private async stop(runId: string, reason?: string): Promise<Record<string, unknown>> {
    const run = await this.state.storage.get<ProbeRun>(`run:${runId}`);
    if (!run) throw new Error("Probe run was not found.");
    if (run.status === "running") await this.finishRun(run, "stopped", reason ?? "stopped_by_operator");
    const final = await this.state.storage.get<ProbeRun>(`run:${runId}`);
    return final ? resultSummary(final) : { runId, status: "stopped" };
  }

  async alarm(): Promise<void> {
    const run = await this.activeRun();
    const token = this.env.SUPEROPS_API_TOKEN?.trim();
    if (!run || run.status !== "running" || !token) return;
    const now = Date.now();
    const deadline = Date.parse(run.deadlineAt);
    if (!Number.isFinite(deadline) || now >= deadline) {
      await this.finishRun(run, "completed");
      return;
    }
    const phase = phaseFor(Date.parse(run.startedAt), now);
    const requestedBatch = phase.requestsPerMinute / (60_000 / PROBE_INTERVAL_MS) + run.fractionalBatch;
    const batchSize = Math.max(1, Math.min(25, Math.floor(requestedBatch)));
    const nextFractionalBatch = requestedBatch - batchSize;
    const scheduledAt = new Date(now).toISOString();
    const sequenceStart = run.nextSequence;
    const events = await Promise.all(Array.from({ length: batchSize }, (_, index) =>
      performProbeAttempt({
        run,
        sequence: sequenceStart + index,
        phase,
        scheduledAt,
        apiToken: token,
      })
    ));
    if (events.length > 0 && sequenceStart + events.length > MAX_EVENTS_PER_RUN) {
      await this.finishRun(run, "failed", "maximum_event_bound_reached");
      return;
    }
    const next: ProbeRun = { ...run, nextSequence: sequenceStart + events.length, fractionalBatch: nextFractionalBatch };
    for (const event of events) {
      await this.state.storage.put(`event:${run.runId}:${String(event.sequence).padStart(8, "0")}`, event);
      next.totalAttempts += 1;
      if (event.ok) next.successfulAttempts += 1;
      else next.failedAttempts += 1;
      if (event.rateLimited) {
        next.rateLimitedAttempts += 1;
        next.firstRateLimitedAt ??= event.startedAt;
        next.firstRateLimitedPhase ??= event.phase;
      }
      if (event.outcome === "malformed_response") next.malformedAttempts += 1;
      if (event.outcome === "network_error" || event.outcome === "request_timeout") next.networkAttempts += 1;
      next.lastEventAt = event.completedAt;
      next.lastOutcome = event.outcome;
      next.lastHttpStatus = event.httpStatus;
      next.lastPhase = event.phase;
    }
    next.currentPhase = phase.name;
    next.currentTargetRequestsPerMinute = phase.requestsPerMinute;
    await this.persistRun(next);
    const nextAlarm = Date.now() + PROBE_INTERVAL_MS;
    if (this.state.storage.setAlarm) {
      if (nextAlarm >= deadline) await this.state.storage.setAlarm(deadline);
      else await this.state.storage.setAlarm(nextAlarm);
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return jsonResponse({ error: "Method not allowed." }, 405);
    try {
      const body = await request.json() as Record<string, unknown>;
      const action = body.action;
      if (action === "start") return jsonResponse(await this.start(body.task));
      if (action === "status") return jsonResponse(await this.status(typeof body.runId === "string" ? body.runId : undefined));
      if (action === "results") {
        const runId = typeof body.runId === "string" ? body.runId : "";
        if (!runId) throw new Error("runId is required.");
        const cursor = typeof body.cursor === "number" && Number.isFinite(body.cursor) ? Math.trunc(body.cursor) : 0;
        const limit = typeof body.limit === "number" && Number.isFinite(body.limit) ? Math.trunc(body.limit) : 100;
        return jsonResponse(await this.results(runId, cursor, limit));
      }
      if (action === "stop") {
        const runId = typeof body.runId === "string" ? body.runId : "";
        if (!runId) throw new Error("runId is required.");
        return jsonResponse(await this.stop(runId, safeReason(body.reason)));
      }
      throw new Error("Unknown rate-limit probe action.");
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : "Rate-limit probe failed." }, 400);
    }
  }
}

function namespaceFromUnknown(value: unknown): ProbeNamespace | undefined {
  if (!value || typeof value !== "object") return undefined;
  const namespace = value as Partial<ProbeNamespace>;
  return typeof namespace.idFromName === "function" && typeof namespace.get === "function"
    ? namespace as ProbeNamespace
    : undefined;
}

function callProbe(namespace: ProbeNamespace, tenantKey: string, action: string, payload: Record<string, unknown> = {}): Promise<unknown> {
  const stub = namespace.get(namespace.idFromName(`tenant:${tenantKey}`));
  return stub.fetch(new Request("https://rate-limit-probe.local/state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...payload }),
  })).then(async (response) => {
    const body = await response.json() as { error?: unknown; [key: string]: unknown };
    if (!response.ok || typeof body.error === "string") throw new Error(typeof body.error === "string" ? body.error : `Probe storage request failed (${response.status}).`);
    return body;
  });
}

export function createRateLimitProbeAdapter(params: {
  namespace?: unknown;
  tenantKey: string;
  enabled: boolean;
}): RateLimitProbeAdapter | undefined {
  if (!params.enabled) return undefined;
  const namespace = namespaceFromUnknown(params.namespace);
  if (!namespace) return undefined;
  return {
    tools: RATE_LIMIT_PROBE_TOOLS,
    async handleCall(name, args) {
      try {
        switch (name) {
          case "superops_rate_limit_probe_start":
            return { content: [{ type: "text", text: JSON.stringify(await callProbe(namespace, params.tenantKey, "start", { task: args.task }), null, 2) }] };
          case "superops_rate_limit_probe_status":
            return { content: [{ type: "text", text: JSON.stringify(await callProbe(namespace, params.tenantKey, "status", { runId: typeof args.runId === "string" ? args.runId : undefined }), null, 2) }] };
          case "superops_rate_limit_probe_results": {
            const runId = typeof args.runId === "string" ? args.runId.trim() : "";
            if (!runId) return errorResult("runId is required.");
            return { content: [{ type: "text", text: JSON.stringify(await callProbe(namespace, params.tenantKey, "results", {
              runId,
              cursor: typeof args.cursor === "number" ? Math.trunc(args.cursor) : 0,
              limit: typeof args.limit === "number" ? Math.trunc(args.limit) : 100,
            }), null, 2) }] };
          }
          case "superops_rate_limit_probe_stop": {
            const runId = typeof args.runId === "string" ? args.runId.trim() : "";
            if (!runId) return errorResult("runId is required.");
            return { content: [{ type: "text", text: JSON.stringify(await callProbe(namespace, params.tenantKey, "stop", {
              runId,
              reason: safeReason(args.reason),
            }), null, 2) }] };
          }
          default:
            return errorResult(`Unknown rate-limit probe tool: ${name}`);
        }
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : "Rate-limit probe request failed.");
      }
    },
  };
}
