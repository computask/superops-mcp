/**
 * SuperOps.ai GraphQL Client
 *
 * Lazy-loaded client for making GraphQL requests to the SuperOps.ai API.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { SuperOpsCredentials, GraphQLResponse } from "./types.js";
import {
  classifyGraphQLRequest,
  getExecutionConfig,
  hasExecutionBudgetFor,
  recordRetryDelay,
  recordSubrequestFinish,
  recordSubrequestStart,
} from "./execution.js";

const API_ENDPOINTS = {
  us: "https://api.superops.ai/msp",
  eu: "https://euapi.superops.ai/msp",
} as const;

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
  return credentialStore.run(creds, fn);
}

export class SuperOpsClient {
  private readonly apiToken: string;
  private readonly subdomain: string;
  private readonly endpoint: string;

  constructor(credentials: SuperOpsCredentials) {
    this.apiToken = credentials.apiToken;
    this.subdomain = credentials.subdomain;
    this.endpoint = API_ENDPOINTS[credentials.region ?? "us"];
  }

  async query<T = unknown>(
    query: string,
    variables?: Record<string, unknown>
  ): Promise<T> {
    const operation = classifyGraphQLRequest(query);
    const isWrite = operation.operationType === "mutation";
    const config = getExecutionConfig();
    const maxAttempts = isWrite
      ? config.maxWriteRetryAttempts
      : config.maxReadRetryAttempts;
    const startedMs = Date.now();
    let attempt = 0;
    let lastError: unknown;

    while (attempt < maxAttempts) {
      attempt += 1;
      try {
        return await this.requestOnce<T>(query, variables, attempt - 1);
      } catch (error) {
        lastError = error;
        const retryable = shouldRetrySuperOpsRequest(error, isWrite);
        if (!retryable || attempt >= maxAttempts) {
          throw error;
        }

        const delayMs = retryDelayMs(error, attempt, config);
        const elapsedAfterDelay = Date.now() - startedMs + delayMs;
        if (
          elapsedAfterDelay > config.maxRetryDurationMs ||
          !hasExecutionBudgetFor(1) ||
          elapsedAfterDelay + config.safeRemainingTimeMs >= config.maxDurationMs
        ) {
          throw error;
        }

        recordRetryDelay(delayMs);
        await delay(delayMs);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async requestOnce<T = unknown>(
    query: string,
    variables: Record<string, unknown> | undefined,
    retryCount: number
  ): Promise<T> {
    const subrequest = recordSubrequestStart(query, retryCount);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new SuperOpsTimeoutError("SuperOps request timed out.")),
      getExecutionConfig().requestTimeoutMs
    );
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiToken}`,
          CustomerSubDomain: this.subdomain,
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
    } catch (error) {
      const timedOut = controller.signal.aborted ||
        (error instanceof Error && error.name === "AbortError");
      recordSubrequestFinish(subrequest, timedOut ? "requestTimeout" : "networkError", false);
      throw timedOut
        ? new SuperOpsTimeoutError(
            error instanceof Error ? error.message : "SuperOps request timed out."
          )
        : new SuperOpsNetworkError(
            error instanceof Error ? error.message : String(error)
          );
    } finally {
      clearTimeout(timeout);
    }

    recordSubrequestFinish(subrequest, response.status, response.ok);

    if (!response.ok) {
      throw new SuperOpsHttpError(
        `HTTP error: ${response.status} ${response.statusText}`,
        response.status,
        response.statusText,
        retryAfterFromHeaders(response.headers)
      );
    }

    let result: GraphQLResponse<T>;
    try {
      result = (await response.json()) as GraphQLResponse<T>;
    } catch (error) {
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

      throw new SuperOpsError(
        message,
        error.extensions?.code,
        error.extensions?.retryAfter
      );
    }

    if (!result.data) {
      throw new SuperOpsMalformedResponseError("No data returned from GraphQL query");
    }

    return result.data;
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

  constructor(message: string, code?: string, retryAfter?: number) {
    super(message);
    this.name = "SuperOpsError";
    this.code = code;
    this.retryAfter = retryAfter;
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

function shouldRetrySuperOpsRequest(error: unknown, isWrite: boolean): boolean {
  if (isWrite) return false;
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
  if (/\bnot\s+(a\s+)?rate[-\s]?limit(?:ed|ing)?\b/.test(message)) {
    return false;
  }
  return (
    code.includes("rate") ||
    code.includes("thrott") ||
    code === "too_many_requests" ||
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

function retryDelayMs(
  error: unknown,
  attempt: number,
  config: ReturnType<typeof getExecutionConfig>
): number {
  const retryAfterSeconds =
    error instanceof SuperOpsHttpError || error instanceof SuperOpsError
      ? error.retryAfter
      : undefined;
  if (typeof retryAfterSeconds === "number") {
    return Math.min(
      config.maxSingleDelayMs,
      Math.max(0, Math.ceil(retryAfterSeconds * 1000))
    );
  }

  const base = config.backoffBaseDelayMs * 2 ** Math.max(0, attempt - 1);
  const jitter =
    config.backoffJitterRatio <= 0
      ? 0
      : base * config.backoffJitterRatio * Math.random();
  return Math.min(config.maxSingleDelayMs, Math.ceil(base + jitter));
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const apiToken = process.env.SUPEROPS_API_TOKEN;
  const subdomain = process.env.SUPEROPS_SUBDOMAIN;
  const region = process.env.SUPEROPS_REGION as "us" | "eu" | undefined;

  if (!apiToken || !subdomain) {
    return null;
  }

  return { apiToken, subdomain, region };
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
        "SuperOps credentials not configured. Set the required SuperOps API token and subdomain configuration."
      );
    }
    _client = new SuperOpsClient(creds);
  }
  return _client;
}

export function resetClient(): void {
  _client = null;
}
