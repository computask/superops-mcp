/**
 * SuperOps.ai GraphQL Client
 *
 * Lazy-loaded client for making GraphQL requests to the SuperOps.ai API.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { SuperOpsCredentials, GraphQLResponse } from "./types.js";
import { beginApiAttempt, endApiAttempt } from "./api-attempt-audit.js";
import { assertPageBounds } from "./pagination.js";
import { dispatcherIdempotencyKey } from "./dispatcher.js";
import { DISPATCHER_ORIGIN, DispatcherPendingError, dispatcherFetch, runWithDispatcher, dispatcherEnvironment, boundedJson } from "./dispatcher.js";
import {
  classifyGraphQLRequest,
  getExecutionConfig,
  hasExecutionBudgetFor,
  recordRetryDelay,
  recordSubrequestFinish,
  recordSubrequestStart,
} from "./execution.js";


/**
 * AsyncLocalStorage for per-request credential isolation in HTTP transport.
 * When running behind the MCP gateway, each request gets its own credentials
 * injected via headers — never stored in process.env or shared state.
 */
const credentialStore = new AsyncLocalStorage<SuperOpsCredentials>();

/**
 * Run a function with per-request credentials available via getCredentials()/getClient().
 */
export function runWithCredentials<T>(creds: SuperOpsCredentials, fn: () => T): T {
  return credentialStore.run(creds, () => runWithDispatcher(creds.dispatcher ?? dispatcherEnvironment(), fn));
}

export class SuperOpsClient {
  private readonly subdomain: string;
  private readonly endpoint: string;
  private readonly dispatcher;

  constructor(credentials: SuperOpsCredentials) {
    this.subdomain = credentials.subdomain;
    this.endpoint = `${DISPATCHER_ORIGIN}/graphql`;
    this.dispatcher = credentials.dispatcher;
  }

  async query<T = unknown>(
    query: string,
    variables?: Record<string, unknown>
  ): Promise<T> {
    const operation = classifyGraphQLRequest(query);
    const isWrite = operation.operationType === "mutation";
    if (!isWrite) assertPageBounds(query, variables);
    const config = getExecutionConfig();
    const maxAttempts = isWrite
      ? config.maxWriteRetryAttempts
      : config.maxReadRetryAttempts;
    const startedMs = Date.now();
    let attempt = 0;
    let lastError: unknown;
    const idempotencyKey = await dispatcherIdempotencyKey(JSON.stringify({query, variables}), isWrite);

    while (attempt < maxAttempts) {
      attempt += 1;
      try {
        return await this.requestOnce<T>(query, variables, attempt - 1, idempotencyKey);
      } catch (error) {
        lastError = error;
        const retryable = shouldRetrySuperOpsRequest(error, isWrite);
        if (!retryable || attempt >= maxAttempts) {
          throw error;
        }

        const retryDelay = retryDelayInfo(error, attempt, config);
        const delayMs = retryDelay.actualDelayMs;
        const elapsedAfterDelay = Date.now() - startedMs + delayMs;
        if (
          elapsedAfterDelay > config.maxRetryDurationMs ||
          !hasExecutionBudgetFor(1) ||
          elapsedAfterDelay + config.safeRemainingTimeMs >= config.maxDurationMs
        ) {
          throw error;
        }

        recordRetryDelay({
          ...retryDelay,
          attempt,
          endpoint: this.endpoint,
          operationType: operation.operationType,
          operationName: operation.operationName,
        });
        await delay(delayMs);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async requestOnce<T = unknown>(
    query: string,
    variables: Record<string, unknown> | undefined,
    retryCount: number,
    idempotencyKey: string
  ): Promise<T> {
    const subrequest = recordSubrequestStart(query, retryCount, this.endpoint);
    // Serialize before recording dispatch: invalid input has made no API call.
    const body = JSON.stringify({ query, variables });
    const audit = beginApiAttempt(query, variables, this.subdomain, this.endpoint, retryCount + 1, subrequest.index);
    try {
      const result = await this.performRequest<T>(body, subrequest, idempotencyKey, classifyGraphQLRequest(query).operationType === "mutation");
      endApiAttempt(audit, subrequest.record, true, undefined, result);
      return result;
    } catch (error) {
      endApiAttempt(audit, subrequest.record, false,
        error instanceof SuperOpsError || error instanceof SuperOpsHttpError || error instanceof DispatcherPendingError ? error.retryAfter : undefined);
      throw error;
    }
  }

  private async performRequest<T>(
    body: string,
    subrequest: ReturnType<typeof recordSubrequestStart>,
    idempotencyKey: string,
    mutation: boolean
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new SuperOpsTimeoutError("SuperOps request timed out.")),
      getExecutionConfig().requestTimeoutMs
    );
    let response: Response;
    try {
      response = await dispatcherFetch(body, { idempotencyKey, signal: controller.signal, env: this.dispatcher, mutation,
        onReceipt: receipt => { if (subrequest.record) {
          subrequest.record.dispatcherRequestId = receipt.requestId;
          subrequest.record.dispatcherState = receipt.state;
        } },
      });
    } catch (error) {
      clearTimeout(timeout);
      if (error instanceof DispatcherPendingError && subrequest.record) {
        subrequest.record.dispatcherRequestId = error.requestId ?? subrequest.record.dispatcherRequestId;
        subrequest.record.dispatcherErrorCode = error.errorClassification ?? error.state;
      }
      if (error instanceof DispatcherPendingError && error.httpStatus !== undefined) {
        recordSubrequestFinish(subrequest, error.httpStatus, false, {
          outcome: error.rateLimited ? "rate_limited" : "http_error",
          errorClass: error.errorClassification ?? "DispatcherTerminalFailure",
          graphqlCode: error.errorClassification,
          httpStatus: error.httpStatus, rateLimited: error.rateLimited,
          retryAfterSupplied: error.retryAfter !== undefined,
        });
        throw error;
      }
      const timedOut = controller.signal.aborted ||
        (error instanceof DispatcherPendingError && error.state === "request_timeout") ||
        (error instanceof Error && error.name === "AbortError");
      recordSubrequestFinish(
        subrequest,
        timedOut ? "requestTimeout" : "networkError",
        false,
        {
          outcome: timedOut ? "request_timeout" : "network_error",
          errorClass: error instanceof DispatcherPendingError ? error.errorClassification ?? `Dispatcher_${error.state}` : timedOut ? "SuperOpsRequestTimeout" : "UpstreamNetworkFailure",
        }
      );
      if (error instanceof DispatcherPendingError) throw error;
      throw timedOut
        ? new SuperOpsTimeoutError(
            error instanceof Error ? error.message : "SuperOps request timed out."
          )
        : new SuperOpsNetworkError(
            error instanceof Error ? error.message : String(error)
          );
    }

    try {
      if (!response.ok) {
      const retryAfter = retryAfterFromHeaders(response.headers);
      const rateLimited = response.status === 429;
      recordSubrequestFinish(subrequest, response.status, false, {
        outcome: rateLimited ? "rate_limited" : "http_error",
        errorClass: rateLimited
          ? "SuperOpsRateLimit"
          : response.status >= 500 && response.status < 600
            ? "SuperOpsInternalError"
            : "SuperOpsHttpError",
        httpStatus: response.status,
        rateLimited,
        retryAfterSupplied: retryAfter !== undefined,
      });
      throw new SuperOpsHttpError(
        `HTTP error: ${response.status} ${response.statusText}`,
        response.status,
        response.statusText,
        retryAfter
      );
      }

      let result: GraphQLResponse<T>;
      try {
        result = (await boundedJson(response)) as GraphQLResponse<T>;
      } catch (error) {
        const timedOut = controller.signal.aborted ||
          (error instanceof Error && error.name === "AbortError");
        recordSubrequestFinish(subrequest, response.status, false, {
          outcome: timedOut ? "request_timeout" : "malformed_response",
          errorClass: timedOut ? "SuperOpsRequestTimeout" : "MalformedResponse",
          httpStatus: response.status,
        });
        if (timedOut) {
          throw new SuperOpsTimeoutError(
            error instanceof Error ? error.message : "SuperOps request timed out."
          );
        }
        throw new SuperOpsMalformedResponseError(
          error instanceof Error ? error.message : String(error)
        );
      }

      if (result.errors && result.errors.length > 0) {
        const error = result.errors[0];

      const message =
        error.message ||
        JSON.stringify(
          {
            message: error.message,
            path: error.path,
            locations: error.locations,
            extensions: error.extensions,
          },
          null,
          2
        );

      const graphQLError = new SuperOpsError(
        message,
        typeof error.extensions?.code === "string" ? error.extensions.code : undefined,
        retryAfterFromGraphQLError(error),
        error.extensions,
        {
          httpStatus: response.status,
          path: error.path,
          graphQLDataPresent: Object.prototype.hasOwnProperty.call(result, "data"),
          mutationPayloadReturned: mutationPayloadReturned(result.data, error.path),
        }
      );
      const rateLimited = isGraphQLRateLimit(graphQLError);
      recordSubrequestFinish(subrequest, response.status, false, {
        outcome: rateLimited ? "rate_limited" : "graphql_error",
        errorClass: rateLimited ? "SuperOpsRateLimit" : "SuperOpsGraphQLError",
        httpStatus: response.status,
        rateLimited,
        retryAfterSupplied: graphQLError.retryAfter !== undefined,
        responseHadData: Object.prototype.hasOwnProperty.call(result, "data"),
        graphqlCode: graphQLError.code,
      });
        throw graphQLError;
      }

      if (!result.data) {
        recordSubrequestFinish(subrequest, response.status, false, {
          outcome: "malformed_response",
          errorClass: "MalformedResponse",
          httpStatus: response.status,
          responseHadData: false,
        });
        throw new SuperOpsMalformedResponseError("No data returned from GraphQL query");
      }

      recordSubrequestFinish(subrequest, response.status, true, {
        outcome: "success",
        httpStatus: response.status,
        responseHadData: true,
      });
      return result.data;
    } finally {
      clearTimeout(timeout);
    }
  }

  async mutate<T = unknown>(
    mutation: string,
    variables?: Record<string, unknown>
  ): Promise<T> {
    return this.query<T>(mutation, variables);
  }
}

export class SuperOpsError extends Error {
  readonly code?: string;
  readonly retryAfter?: number;
  readonly extensions?: Record<string, unknown>;
  readonly httpStatus?: number;
  readonly graphQLPath?: Array<string | number>;
  readonly graphQLDataPresent?: boolean;
  readonly mutationPayloadReturned?: boolean;

  constructor(
    message: string,
    code?: string,
    retryAfter?: number,
    extensions?: Record<string, unknown>,
    metadata: {
      httpStatus?: number;
      path?: Array<string | number>;
      graphQLDataPresent?: boolean;
      mutationPayloadReturned?: boolean;
    } = {}
  ) {
    super(message);
    this.name = "SuperOpsError";
    this.code = code;
    this.retryAfter = retryAfter;
    this.extensions = extensions;
    this.httpStatus = metadata.httpStatus;
    this.graphQLPath = metadata.path;
    this.graphQLDataPresent = metadata.graphQLDataPresent;
    this.mutationPayloadReturned = metadata.mutationPayloadReturned;
  }
}

export class SuperOpsHttpError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly retryAfter?: number;

  constructor(
    message: string,
    status: number,
    statusText: string,
    retryAfter?: number
  ) {
    super(message);
    this.name = "SuperOpsHttpError";
    this.status = status;
    this.statusText = statusText;
    this.retryAfter = retryAfter;
  }
}

export class SuperOpsNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SuperOpsNetworkError";
  }
}

export class SuperOpsTimeoutError extends SuperOpsNetworkError {
  constructor(message: string) {
    super(message);
    this.name = "SuperOpsTimeoutError";
  }
}

export class SuperOpsMalformedResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SuperOpsMalformedResponseError";
  }
}

function retryAfterFromHeaders(headers: Headers): number | undefined {
  return (
    parseRetryAfter(headers.get("Retry-After")) ??
    parseRateLimitReset(headers.get("X-RateLimit-Reset")) ??
    parseRateLimitReset(headers.get("RateLimit-Reset")) ??
    parseRateLimitReset(headers.get("X-Rate-Limit-Reset"))
  );
}

function parseRateLimitReset(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;

  const now = Date.now();
  if (parsed > 1_000_000_000_000) {
    return Math.max(0, Math.ceil((parsed - now) / 1000));
  }
  if (parsed > 1_000_000_000) {
    return Math.max(0, Math.ceil(parsed - now / 1000));
  }
  return parsed;
}

function retryAfterFromGraphQLError(error: {
  extensions?: Record<string, unknown>;
}): number | undefined {
  const extensions = error.extensions;
  if (!extensions) return undefined;
  return (
    parseRetryAfterValue(extensions.retryAfter) ??
    parseRetryAfterValue(extensions.retry_after) ??
    parseRetryAfterValue(extensions.retryAfterSeconds) ??
    parseRateLimitResetValue(extensions.rateLimitReset) ??
    parseRateLimitResetValue(extensions.rate_limit_reset) ??
    parseRateLimitResetValue(extensions.resetAt)
  );
}

function parseRetryAfterValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string") return parseRetryAfter(value);
  return undefined;
}

function parseRateLimitResetValue(value: unknown): number | undefined {
  if (typeof value === "number") return parseRateLimitReset(String(value));
  if (typeof value === "string") return parseRateLimitReset(value);
  return undefined;
}
function shouldRetrySuperOpsRequest(error: unknown, isWrite: boolean): boolean {
  if (isWrite) return false;
  if (error instanceof DispatcherPendingError) return !error.requestId && ["submission_or_status_unknown", "request_timeout"].includes(error.state);
  if (error instanceof SuperOpsHttpError) {
    return error.status === 429 || (error.status >= 500 && error.status < 600);
  }
  if (error instanceof SuperOpsError) {
    return isGraphQLRateLimit(error) || isRetryableGraphQLServerError(error);
  }
  return error instanceof SuperOpsNetworkError;
}

function isGraphQLRateLimit(error: SuperOpsError): boolean {
  const code = (error.code ?? "").toLowerCase();
  const message = error.message.toLowerCase();
  const extensions = error.extensions
    ? JSON.stringify(error.extensions).toLowerCase()
    : "";
  if (/\bnot\s+(a\s+)?rate[-\s]?limit(?:ed|ing)?\b/.test(message)) {
    return false;
  }
  return (
    code.includes("rate") ||
    code.includes("thrott") ||
    code === "too_many_requests" ||
    code === "rate_limit_exceeded" ||
    extensions.includes("rate_limit_exceeded") ||
    extensions.includes("too_many_requests") ||
    extensions.includes("throttl") ||
    /\b(rate[-\s]?limit(?:ed|ing)?|too many requests|throttl(?:e|ed|ing))\b/i.test(
      error.message
    )
  );
}

function isRetryableGraphQLServerError(error: SuperOpsError): boolean {
  const code = (error.code ?? "").toLowerCase();
  const message = error.message.toLowerCase();
  return (
    code.includes("timeout") ||
    code.includes("temporar") ||
    code.includes("internal") ||
    message.includes("temporarily unavailable") ||
    message.includes("service unavailable")
  );
}

interface RetryDelayInfo {
  source: "retry-after" | "backoff";
  retryCause: "rate_limit" | "server_error" | "network";
  retryAfterSupplied: boolean;
  suppliedDelayMs?: number;
  parsedDelayMs: number;
  cappedDelayMs: number;
  actualDelayMs: number;
}

function retryDelayInfo(
  error: unknown,
  attempt: number,
  config: ReturnType<typeof getExecutionConfig>
): RetryDelayInfo {
  const retryAfterSeconds =
    error instanceof SuperOpsHttpError || error instanceof SuperOpsError
      ? error.retryAfter
      : undefined;
  if (typeof retryAfterSeconds === "number") {
    const suppliedDelayMs = Math.max(0, Math.ceil(retryAfterSeconds * 1000));
    return {
      source: "retry-after",
      retryCause: retryCauseFor(error),
      retryAfterSupplied: true,
      suppliedDelayMs,
      parsedDelayMs: suppliedDelayMs,
      // Retry-After is an upstream scheduling instruction. Do not shorten it
      // to the inline MCP retry cap: doing so re-hits SuperOps while it is
      // still asking us to wait. query() will reject a delay that does not fit
      // the current execution budget, allowing the durable trigger to retry
      // outside this invocation instead.
      cappedDelayMs: suppliedDelayMs,
      actualDelayMs: suppliedDelayMs,
    };
  }

  const base = config.backoffBaseDelayMs * 2 ** Math.max(0, attempt - 1);
  const jitter =
    config.backoffJitterRatio <= 0
      ? 0
      : base * config.backoffJitterRatio * Math.random();
  const parsedDelayMs = Math.ceil(base + jitter);
  const cappedDelayMs = Math.min(config.maxSingleDelayMs, parsedDelayMs);
  return {
    source: "backoff",
    retryCause: retryCauseFor(error),
    retryAfterSupplied: false,
    parsedDelayMs,
    cappedDelayMs,
    actualDelayMs: cappedDelayMs,
  };
}

function retryCauseFor(error: unknown): "rate_limit" | "server_error" | "network" {
  if (error instanceof SuperOpsHttpError) {
    return error.status === 429 ? "rate_limit" : "server_error";
  }
  if (error instanceof SuperOpsError) {
    return isGraphQLRateLimit(error) ? "rate_limit" : "server_error";
  }
  return "network";
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mutationPayloadReturned(
  data: unknown,
  path: Array<string | number> | undefined
): boolean {
  const topLevel = path?.[0];
  if (typeof topLevel !== "string" || typeof data !== "object" || data === null || Array.isArray(data)) {
    return false;
  }
  const payload = (data as Record<string, unknown>)[topLevel];
  return payload !== null && payload !== undefined;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds;
  }

  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, Math.ceil((dateMs - Date.now()) / 1000));
  }

  return undefined;
}

// Lazy-loaded singleton client
let _client: SuperOpsClient | null = null;

export function getCredentials(): SuperOpsCredentials | null {
  // Per-request credentials from AsyncLocalStorage take priority (HTTP/gateway mode)
  const requestCreds = credentialStore.getStore();
  if (requestCreds) {
    return requestCreds;
  }

  // Fall back to environment variables (stdio mode)
  const apiToken = process.env.DISPATCHER_TOKEN;
  const subdomain = process.env.SUPEROPS_SUBDOMAIN;
  const region = process.env.SUPEROPS_REGION as "us" | "eu" | undefined;

  if (!apiToken || !subdomain) {
    return null;
  }

  return { apiToken, subdomain, region, dispatcher: dispatcherEnvironment() };
}

export function getClient(): SuperOpsClient {
  // Per-request credentials: always create a fresh client (no shared state)
  const requestCreds = credentialStore.getStore();
  if (requestCreds) {
    return new SuperOpsClient(requestCreds);
  }

  // Stdio mode: use cached singleton
  if (!_client) {
    const creds = getCredentials();
    if (!creds) {
      throw new Error(
        "Dispatcher producer credentials and operation-owner identity are not configured. Direct SuperOps access is disabled."
      );
    }
    _client = new SuperOpsClient(creds);
  }
  return _client;
}

export function resetClient(): void {
  _client = null;
}
