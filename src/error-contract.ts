import { SuperOpsError, SuperOpsHttpError } from "./client.js";
import { DispatcherPendingError } from "./dispatcher.js";
import { dispatcherReadRecoveryState } from "./dispatcher-read-journal.js";
import type { ToolResult } from "./audit.js";

const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MAX_PUBLIC_RETRY_AFTER_SECONDS = 86_400;

export type SafeRetryScope = "read" | "none";

export interface SafeToolErrorMetadata extends Record<string, unknown> {
  errorClass: string;
  rateLimited: boolean;
  retryable: boolean;
  retryScope: SafeRetryScope;
  retryAfterPresent: boolean;
  reasonCode: string;
  retryAfterSeconds?: number;
  attempts?: number;
  retried?: boolean;
  cacheEntryAvailable?: boolean;
  cacheEntryValid?: boolean;
  cacheReadFailed?: boolean;
  nativeCacheAvailable?: boolean;
  responseOmitted?: boolean;
  bytes?: number;
  maxBytes?: number;
  dispatcherRequestId?: string;
  dispatcherState?: string;
  dispatcherPending?: boolean;
  dispatcherTerminal?: boolean;
  resumeSameRequest?: boolean;
  readRecoveryDurable?: boolean;
  nextEligibleAt?: string;
  readRecoveryDeadlineAt?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeToken(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_TOKEN_PATTERN.test(value.trim())
    ? value.trim()
    : undefined;
}

function safeCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1_000
    ? value
    : undefined;
}

function safeRetryAfterSeconds(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(MAX_PUBLIC_RETRY_AFTER_SECONDS, value)
    : undefined;
}

/**
 * Project an internal error object onto the small, content-free public error
 * contract. Unknown fields (including raw reasons and bodies) are discarded.
 */
export function createSafeToolErrorMetadata(
  value: unknown = {}
): SafeToolErrorMetadata {
  const input = isRecord(value) ? value : {};
  const errorClass = safeToken(input.errorClass) ?? "McpToolError";
  const rateLimited = input.rateLimited === true;
  const retryAfterSeconds = safeRetryAfterSeconds(input.retryAfterSeconds);
  const retryAfterPresent = input.retryAfterPresent === true || retryAfterSeconds !== undefined;
  const retryScope: SafeRetryScope = input.retryScope === "read" ? "read" : "none";
  const retryable = input.retryable === true && retryScope === "read";
  const reasonCode = safeToken(input.reasonCode) ?? (
    rateLimited && retryable ? "superops_read_rate_limited" : "tool_error"
  );

  const output: SafeToolErrorMetadata = {
    errorClass,
    rateLimited,
    retryable,
    retryScope,
    retryAfterPresent,
    reasonCode,
  };

  if (retryAfterSeconds !== undefined) output.retryAfterSeconds = retryAfterSeconds;

  for (const key of ["attempts"] as const) {
    const count = safeCount(input[key]);
    if (count !== undefined) output[key] = count;
  }
  for (const key of ["bytes", "maxBytes"] as const) {
    const size = input[key];
    if (typeof size === "number" && Number.isSafeInteger(size) && size >= 0) output[key] = size;
  }

  for (const key of [
    "retried",
    "cacheEntryAvailable",
    "cacheEntryValid",
    "cacheReadFailed",
    "nativeCacheAvailable",
    "responseOmitted",
    "dispatcherPending", "dispatcherTerminal", "resumeSameRequest", "readRecoveryDurable",
  ] as const) {
    if (typeof input[key] === "boolean") output[key] = input[key];
  }

  if (typeof input.dispatcherRequestId === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(input.dispatcherRequestId)) output.dispatcherRequestId = input.dispatcherRequestId;
  if (typeof input.dispatcherState === "string" && /^[a-z_]{1,64}$/.test(input.dispatcherState)) output.dispatcherState = input.dispatcherState;
  for (const key of ["nextEligibleAt", "readRecoveryDeadlineAt"] as const) {
    if (typeof input[key] === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input[key]) && Number.isFinite(Date.parse(input[key]))) output[key] = input[key];
  }

  return output;
}

function graphqlRateLimit(error: SuperOpsError): boolean {
  const code = (error.code ?? "").toLowerCase();
  const message = error.message.toLowerCase();
  let extensions = "";
  try {
    extensions = JSON.stringify(error.extensions ?? {}).toLowerCase();
  } catch {
    extensions = "";
  }

  if (/\bnot\s+(a\s+)?rate[-\s]?limit(?:ed|ing)?\b/.test(message)) return false;
  return code === "rate_limited" ||
    code === "throttled" ||
    code === "too_many_requests" ||
    code === "rate_limit_exceeded" ||
    extensions.includes("rate_limit_exceeded") ||
    extensions.includes("too_many_requests") ||
    extensions.includes("throttl") ||
    /\b(rate[-\s]?limit(?:ed|ing)?|too many requests|throttl(?:e|ed|ing))\b/i.test(message);
}

function metadataForSuperOpsError(
  errorClass: string,
  rateLimited: boolean,
  retryAfterSeconds: number | undefined,
  allowReadRetry: boolean
): SafeToolErrorMetadata {
  const retryable = rateLimited && allowReadRetry;
  return createSafeToolErrorMetadata({
    errorClass,
    rateLimited,
    retryable,
    retryScope: retryable ? "read" : "none",
    retryAfterPresent: retryAfterSeconds !== undefined,
    retryAfterSeconds,
    reasonCode: rateLimited
      ? retryable ? "superops_read_rate_limited" : "superops_write_rate_limited"
      : "superops_request_failed",
  });
}

/**
 * Classify only server-owned SuperOps errors. This deliberately does not
 * inspect connector wrapper errors such as INVALID_ARGUMENT.
 */
export function safeSuperOpsErrorMetadata(
  error: unknown,
  allowReadRetry: boolean
): SafeToolErrorMetadata | undefined {
  if (error instanceof DispatcherPendingError) {
    if (allowReadRetry && error.readRecovery?.durable) {
      const {pending, terminal} = dispatcherReadRecoveryState(error.state);
      return createSafeToolErrorMetadata({errorClass: pending ? "DispatcherReadPending" : terminal ? "DispatcherReadTerminal" : "DispatcherReadRecoveryError", retryable: pending,
        retryScope: pending ? "read" : "none", reasonCode: error.errorClassification === "READ_RECOVERY_EXPIRED" ? "dispatcher_read_recovery_expired"
          : terminal ? "dispatcher_read_terminal" : pending ? "dispatcher_read_pending" : "dispatcher_read_recovery_requires_review",
        rateLimited: error.rateLimited, retryAfterSeconds: safeRetryAfterSeconds(error.retryAfter),
        dispatcherRequestId: error.requestId, dispatcherState: error.state, dispatcherPending: pending,
        dispatcherTerminal: terminal, resumeSameRequest: pending, readRecoveryDurable: true,
        nextEligibleAt: error.readRecovery.nextEligibleAt, readRecoveryDeadlineAt: error.readRecovery.deadlineAt});
    }
    return createSafeToolErrorMetadata({ errorClass: "DispatcherPending", retryable: false,
      retryScope: "none", reasonCode: "dispatcher_receipt_requires_same_request", rateLimited: false });
  }
  if (error instanceof SuperOpsHttpError) {
    const rateLimited = error.status === 429;
    return metadataForSuperOpsError(
      rateLimited ? "SuperOpsRateLimit" : "SuperOpsHttpError",
      rateLimited,
      safeRetryAfterSeconds(error.retryAfter),
      allowReadRetry
    );
  }

  if (error instanceof SuperOpsError) {
    const rateLimited = graphqlRateLimit(error);
    return metadataForSuperOpsError(
      rateLimited ? "SuperOpsRateLimit" : "SuperOpsGraphQLError",
      rateLimited,
      safeRetryAfterSeconds(error.retryAfter),
      allowReadRetry
    );
  }

  return undefined;
}

/**
 * Keep only the structured error fields that this server owns and can safely
 * pass through the MCP response. In particular, finalReason is never copied.
 */
export function safeStructuredErrorMetadata(value: unknown): SafeToolErrorMetadata {
  return createSafeToolErrorMetadata(value);
}

/** Preserve existing per-item results; expose identical bounded metadata to clients using either channel. */
export function attachSafeErrorContract(result: ToolResult): ToolResult {
  if (!result.isError) return result;
  const metadata = safeStructuredErrorMetadata(result.structuredContent);
  return { ...result, structuredContent: metadata,
    content: [...result.content, { type: "text", text: JSON.stringify(metadata) }] };
}
