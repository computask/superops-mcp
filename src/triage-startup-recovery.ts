/** Corroboration only: the Sam-only route also requires inspected provider proof.
 * Empty captures alone cannot authorize recovery of a generic failed run. */
export function emptyStartupCaptures(page: unknown): boolean {
  if (!page || typeof page !== "object") return false;
  const value = page as Record<string, unknown>;
  return value.complete === true && value.hasMore === false && value.totalRecords === 0 &&
    value.captureFailureCount === 0 && value.incompleteRecordCount === 0 &&
    value.truncated !== true && Array.isArray(value.records) && value.records.length === 0;
}

export function inspectedStartupProof(proof: unknown): boolean {
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) return false;
  const value = proof as Record<string, unknown>;
  const keys = ["conversationId", "complete", "workflowStepCount", "toolCallCount", "elicitationCount",
    "denialObserved", "providerErrorCode", "providerErrorSubcode", "providerCanRetry"];
  return Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key)) &&
    typeof value.conversationId === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.conversationId) &&
    value.complete === true && value.workflowStepCount === 0 && value.toolCallCount === 0 &&
    value.elicitationCount === 0 && value.denialObserved === false &&
    value.providerErrorCode === "hermes_gpt_run_failed" && value.providerErrorSubcode === "failed_during_run" &&
    value.providerCanRetry === true;
}
