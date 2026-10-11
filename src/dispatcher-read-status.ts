import { boundedJson, DISPATCHER_ORIGIN, type DispatcherEnvironment } from "./dispatcher.js";

/** One content-free, read-only readiness check. This is private coordinator
 * bookkeeping, not a GraphQL submission, response delivery or replay permission. */
export async function readDispatcherReceiptStatus(requestId: string, env: DispatcherEnvironment): Promise<{
  requestId: string; state: string; nextEligibleAt?: string; errorClassification?: string;
}> {
  const unavailable = () => ({requestId, state: "unavailable"});
  if (!env.DISPATCHER_TOKEN?.trim() || Boolean(env.CF_ACCESS_CLIENT_ID) !== Boolean(env.CF_ACCESS_CLIENT_SECRET)) return unavailable();
  const headers: Record<string, string> = {Authorization: `Bearer ${env.DISPATCHER_TOKEN}`, "X-Source": "superops-mcp", Accept: "application/json"};
  if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
    headers["CF-Access-Client-Id"] = env.CF_ACCESS_CLIENT_ID;
    headers["CF-Access-Client-Secret"] = env.CF_ACCESS_CLIENT_SECRET;
  }
  try {
    const response = await fetch(`${DISPATCHER_ORIGIN}/v1/requests/${requestId}`, {
      method: "GET", headers, redirect: "manual", signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) { await response.body?.cancel(); return unavailable(); }
    const value = await boundedJson(response) as Record<string, unknown>;
    if (!value || value.requestId !== requestId || value.source !== "superops-mcp" || value.type !== "read" ||
        !["queued", "running", "retry_wait", "succeeded", "failed", "cancelled", "uncertain"].includes(String(value.status))) return unavailable();
    const state = value.uncertain === true ? "uncertain" : String(value.status);
    if (state === "succeeded" && (typeof value.httpStatus !== "number" || !Number.isInteger(value.httpStatus) || value.httpStatus < 200 || value.httpStatus >= 300 || value.errorClassification)) return unavailable();
    const retryAt = typeof value.nextRetryAt === "string" ? Date.parse(value.nextRetryAt) : NaN;
    const retry = Number(response.headers.get("Retry-After"));
    const nextAt = Math.max(Date.now() + (Number.isFinite(retry) ? Math.max(0, retry) * 1000 : 0), Number.isFinite(retryAt) ? retryAt : 0);
    return {requestId, state,
      ...(["queued", "running", "retry_wait"].includes(state) ? {nextEligibleAt: new Date(Math.min(Date.now() + 900_000, nextAt)).toISOString()} : {}),
      ...(typeof value.errorClassification === "string" && /^[A-Z0-9_]{1,100}$/.test(value.errorClassification) ? {errorClassification: value.errorClassification} : {}),
    };
  } catch { return unavailable(); }
}
