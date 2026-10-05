import { AsyncLocalStorage } from "node:async_hooks";
import { recordSubrequestFinish, recordTypedSubrequestStart } from "./execution.js";

export const TRIAGE_RUN_LEASE_PROTOCOL = "triage-run-lease-v1";
export interface TriageLeaseEnvironment {
  TRIAGE_RUN_WRITE_GUARD_ENABLED?: string;
  TRIAGE_RUN_COORDINATOR?: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(request: Request): Promise<Response> };
  };
}
const environments = new AsyncLocalStorage<TriageLeaseEnvironment>();
const runs = new AsyncLocalStorage<{ triggerId: string; attempt: number } | undefined>();
const AUTOMATIC_ID = /(?:^|:)(triage-\d+-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

export function runWithTriageLeaseEnvironment<T>(env: TriageLeaseEnvironment, fn: () => T): T {
  return environments.run(env, fn);
}
export function runWithTriageRunContext<T>(run: { triggerId: string; attempt: number } | undefined, fn: () => T): T {
  return runs.run(run, fn);
}
export function triageLeaseCapability(env: TriageLeaseEnvironment) {
  return { protocol: TRIAGE_RUN_LEASE_PROTOCOL, enforced: env.TRIAGE_RUN_WRITE_GUARD_ENABLED === "true" &&
    typeof env.TRIAGE_RUN_COORDINATOR?.idFromName === "function" && typeof env.TRIAGE_RUN_COORDINATOR?.get === "function" };
}

/** Permission to continue a correlated automatic run, never approval of a plan.
 * Call with live ticket metadata before mutation-start checkpoints, and again
 * without metadata immediately before every new dispatcher mutation POST.
 * Receipt GETs remain available for reconciliation after expiry. */
export async function assertTriageRunWriteLease(input: {
  operationId?: string; itemKey?: string; ticketCreatedTime?: string; ticketSource?: string;
} = {}): Promise<void> {
  const env = environments.getStore();
  if (env?.TRIAGE_RUN_WRITE_GUARD_ENABLED !== "true") return;
  const run = runs.getStore();
  const operationTrigger = input.operationId?.match(AUTOMATIC_ID)?.[1];
  if (!run && !operationTrigger) return; // Existing manual operations retain their authorization gates.
  if (run && operationTrigger && run.triggerId !== operationTrigger) throw new Error("Triage run correlation mismatch; no new mutation permitted.");
  if (run && input.operationId && !operationTrigger) throw new Error("Automatic triage requires its exact Trigger ID as batchId.");
  const triggerId = operationTrigger ?? run!.triggerId;
  if (!triageLeaseCapability(env).enforced) throw new Error("Triage run write guard unavailable; no new mutation permitted.");
  const counted = recordTypedSubrequestStart({ type: "custom", operationType: "durableObject", operationName: "triageRunLeaseCheck" });
  try {
    const stub = env.TRIAGE_RUN_COORDINATOR!.get(env.TRIAGE_RUN_COORDINATOR!.idFromName("supportdesk-global"));
    const response = await stub.fetch(new Request("https://coordinator.internal/internal/run-lease/check", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ triggerId, ...(run ? {attempt: run.attempt} : {}), ...input }),
      signal: AbortSignal.timeout(5000),
    }));
    const result = await response.json() as {protocol?: string; allowed?: boolean; expiresAt?: number};
    if (!response.ok || result.protocol !== TRIAGE_RUN_LEASE_PROTOCOL || result.allowed !== true ||
        typeof result.expiresAt !== "number" || result.expiresAt <= Date.now()) {
      throw new Error("Triage run lease expired, revoked or unavailable; no new mutation permitted. Reconcile existing receipts without replay.");
    }
    recordSubrequestFinish(counted, response.status, true);
  } catch (error) {
    recordSubrequestFinish(counted, "triageLeaseRejected", false);
    // Never propagate a dependency's body, headers, credential or customer data.
    throw new Error(error instanceof Error && error.message.startsWith("Triage run lease")
      ? error.message : "Triage run write guard unavailable; no new mutation permitted.");
  }
}
