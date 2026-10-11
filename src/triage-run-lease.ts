import { AsyncLocalStorage } from "node:async_hooks";
import { getExecutionState, recordSubrequestFinish, recordTypedSubrequestStart } from "./execution.js";
import { currentOwnerHash } from "./operation-store.js";
import { authorizeDispatcherReadRenewals, renewableTerminalRead, TERMINAL_READ_RENEWAL_PROTOCOL, type TerminalReadRenewal } from "./dispatcher-read-journal.js";

export const TRIAGE_RUN_LEASE_PROTOCOL = "triage-run-lease-v1";
export const TRIAGE_RUN_START_PROTOCOL = "triage-run-start-v1";
export interface TriageLeaseEnvironment {
  TRIAGE_RUN_WRITE_GUARD_ENABLED?: string;
  TRIAGE_RUN_START_GUARD_ENABLED?: string;
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
export function automaticTriageRunActive(): boolean {
  return runs.getStore() !== undefined;
}
export function triageLeaseCapability(env: TriageLeaseEnvironment) {
  return { protocol: TRIAGE_RUN_LEASE_PROTOCOL, enforced: env.TRIAGE_RUN_WRITE_GUARD_ENABLED === "true" &&
    typeof env.TRIAGE_RUN_COORDINATOR?.idFromName === "function" && typeof env.TRIAGE_RUN_COORDINATOR?.get === "function",
    startProtocol: TRIAGE_RUN_START_PROTOCOL, startGuardEnforced: env.TRIAGE_RUN_START_GUARD_ENABLED === "true" &&
      env.TRIAGE_RUN_WRITE_GUARD_ENABLED === "true" && typeof env.TRIAGE_RUN_COORDINATOR?.get === "function" &&
      typeof env.TRIAGE_RUN_COORDINATOR?.idFromName === "function", terminalReadRenewalProtocol: TERMINAL_READ_RENEWAL_PROTOCOL };
}

/** Authoritative attempt activity, persisted before any correlated tool executes.
 * Diagnostic capture availability never decides whether this check is required. */
export async function assertTriageRunStart(input: {preparationInvocationId?: string; readRecoveryToolName?: string} = {}): Promise<void> {
  const env = environments.getStore(), run = runs.getStore();
  if (!run || env?.TRIAGE_RUN_START_GUARD_ENABLED !== "true") return;
  if (!triageLeaseCapability(env).startGuardEnforced) throw new Error("Triage run start guard unavailable; no tool executed.");
  const counted = recordTypedSubrequestStart({type: "custom", operationType: "durableObject", operationName: "triageRunStartCheck"});
  try {
    const stub = env.TRIAGE_RUN_COORDINATOR!.get(env.TRIAGE_RUN_COORDINATOR!.idFromName("supportdesk-global"));
    const response = await stub.fetch(new Request("https://coordinator.internal/internal/run-work/start", {
      method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({...run, ...input}), signal: AbortSignal.timeout(5000),
    }));
    const result = await response.json() as {protocol?: string; allowed?: boolean; expiresAt?: number; preparationInvocationId?: string; readRenewals?: TerminalReadRenewal[]};
    if (!response.ok || result.protocol !== TRIAGE_RUN_START_PROTOCOL || result.allowed !== true ||
        input.preparationInvocationId !== undefined && result.preparationInvocationId !== input.preparationInvocationId ||
        typeof result.expiresAt !== "number" || result.expiresAt <= Date.now()) throw Error("rejected");
    recordSubrequestFinish(counted, response.status, true);
    if (Array.isArray(result.readRenewals) && result.readRenewals.length <= 2) authorizeDispatcherReadRenewals(result.readRenewals);
  } catch {
    recordSubrequestFinish(counted, "triageStartRejected", false);
    throw new Error("Triage run start guard rejected or unavailable; no tool executed.");
  }
}

/** A typed failed READ is authoritative evidence; a callback's empty count is not.
 * This observation grants neither a new read nor a write. The coordinator decides
 * whether another attempt may receive an exact-receipt, bounded renewal grant. */
export async function recordTriageRunReadFailure(toolName: string, error: unknown): Promise<void> {
  const env = environments.getStore(), run = runs.getStore();
  if (!run || !triageLeaseCapability(env ?? {}).startGuardEnforced ||
      !["superops_tickets_query", "superops_tickets_triage_evidence_recover", "superops_tickets_field_options"].includes(toolName)) return;
  const failure = error as {state?: string; requestId?: string; upstreamHttpStatus?: number; errorClassification?: string;
    readRecovery?: {durable?: boolean; deadlineAt?: string; journalIdentity?: {workflowHash?: string; payloadHash?: string}}} | undefined;
  const journal = failure?.readRecovery?.journalIdentity;
  if (!failure || failure.readRecovery?.durable !== true || !renewableTerminalRead(failure.state ?? "", failure.errorClassification, failure.upstreamHttpStatus) ||
      !/^[A-Za-z0-9_-]{1,160}$/.test(failure.requestId ?? "") || !/^[a-f0-9]{64}$/.test(journal?.workflowHash ?? "") ||
      !/^[a-f0-9]{64}$/.test(journal?.payloadHash ?? "") || !failure.readRecovery.deadlineAt) return;
  let counted: ReturnType<typeof recordTypedSubrequestStart> | undefined;
  try {
    counted = recordTypedSubrequestStart({type: "custom", operationType: "durableObject", operationName: "triageRunReadFailureObservation", allowSafetyMargin: true});
    const stub = env!.TRIAGE_RUN_COORDINATOR!.get(env!.TRIAGE_RUN_COORDINATOR!.idFromName("supportdesk-global"));
    const response = await stub.fetch(new Request("https://coordinator.internal/internal/run-read-failure/observe", {
      method: "POST", headers: {"Content-Type": "application/json"}, signal: AbortSignal.timeout(5000),
      body: JSON.stringify({...run, toolName, requestId: failure.requestId, ownerHash: currentOwnerHash(),
        ...journal, deadlineAt: failure.readRecovery.deadlineAt, state: failure.state,
        httpStatus: failure.upstreamHttpStatus, errorClassification: failure.errorClassification}),
    }));
    recordSubrequestFinish(counted, response.status, response.ok);
  } catch { if (counted) recordSubrequestFinish(counted, "observationUnavailable", false); }
}

/** Only typed preparation state crosses this boundary. Starting each preparation
 * invalidates older failure evidence; the exact invocation must finish it. A lost
 * observation leaves in_progress and cannot synthesize a failure or permit replay. */
export async function recordTriageRunPreparation(args: Record<string, unknown>, result: unknown): Promise<void> {
  const env = environments.getStore(), run = runs.getStore();
  const invocationId = getExecutionState()?.invocationId;
  if (!run || !invocationId || env?.TRIAGE_RUN_START_GUARD_ENABLED !== "true" ||
      !triageLeaseCapability(env).startGuardEnforced || args.batchId !== run.triggerId) return;
  const value = result as Record<string, unknown> | undefined;
  const numbers = args.expectedCandidateTicketNumbers;
  if (!Array.isArray(numbers) || numbers.length === 0 || numbers.length > 50 ||
      !numbers.every((id): id is string => typeof id === "string" && /^\d{1,24}$/.test(id)) ||
      new Set(numbers).size !== numbers.length) return;
  const state = value?.preparationOnly === true && value.operationCreated === false &&
      value.ok === false && value.complete === false && value.preparationOutcome === "validation_failed"
    ? "validation_failed" : value?.preparationOnly === true && value.operationCreated === false &&
      value.ok === true && value.complete === true && value.preparationOutcome === "ready" ? "ready" : "unavailable";
  let counted: ReturnType<typeof recordTypedSubrequestStart> | undefined;
  try {
    counted = recordTypedSubrequestStart({type: "custom", operationType: "durableObject",
      operationName: "triageRunPreparationObservation", allowSafetyMargin: true});
    const stub = env.TRIAGE_RUN_COORDINATOR!.get(env.TRIAGE_RUN_COORDINATOR!.idFromName("supportdesk-global"));
    const response = await stub.fetch(new Request("https://coordinator.internal/internal/run-preparation/observe", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({...run, invocationId, state, ticketNumbers: numbers}), signal: AbortSignal.timeout(5000),
    }));
    recordSubrequestFinish(counted, response.status, response.ok);
  } catch { if (counted) recordSubrequestFinish(counted, "observationUnavailable", false); }
}

/** Content-free proof of a complete or durably pending first query. Losing this optional
 * observation leaves the coordinator conservative; it never grants writes. */
export async function recordTriageRunQuery(args: Record<string, unknown>, result: unknown, readFailure?: unknown, internalFailure?: unknown): Promise<void> {
  const env = environments.getStore(), run = runs.getStore();
  if (!run || !triageLeaseCapability(env ?? {}).enforced || !result || typeof result !== "object") return;
  const value = result as {records?: Array<{displayId?: unknown}>; pagination?: {complete?: boolean}; errors?: unknown[]};
  const single = (value: unknown, expected: string) => value === expected || Array.isArray(value) && value.length === 1 && value[0] === expected;
  const permitted = new Set(["createdFrom", "createdTo", "status", "sources", "fieldProfile", "sortOrder", "timeField", "page", "pageOffset", "maxPages", "maxRecords", "fields"]);
  if (!Array.isArray(value.records) || value.records.length > 50 ||
      args.fieldProfile !== "minimal" || !single(args.status, "New Calls") || !single(args.sources, "EMAIL") ||
      args.page !== undefined && args.page !== 1 || args.pageOffset !== undefined && args.pageOffset !== 0 ||
      Object.keys(args).some(key => !permitted.has(key)) || args.sortOrder && args.sortOrder !== "DESC") return;
  const ticketNumbers = value.records.map(item => item.displayId);
  if (!ticketNumbers.every((id): id is string => typeof id === "string" && /^\d{1,24}$/.test(id)) || new Set(ticketNumbers).size !== ticketNumbers.length) return;
  const complete = value.pagination?.complete === true && !value.errors?.length;
  const failure = readFailure as Record<string, unknown> | undefined;
  const timestamp = (value: unknown): value is string => typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
  const pending = !complete && value.pagination?.complete === false && ticketNumbers.length === 0 &&
    failure?.errorClass === "DispatcherReadPending" && failure.dispatcherPending === true &&
    failure.readRecoveryDurable === true && failure.resumeSameRequest === true &&
    typeof failure.dispatcherRequestId === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(failure.dispatcherRequestId) &&
    timestamp(failure.nextEligibleAt) && timestamp(failure.readRecoveryDeadlineAt);
  if (!complete && !pending) return;
  const journal = (internalFailure as {readRecovery?: {journalIdentity?: {workflowHash?: string; payloadHash?: string}}} | undefined)?.readRecovery?.journalIdentity;
  const pendingRead = pending ? {requestId: failure!.dispatcherRequestId, ownerHash: currentOwnerHash(),
    nextEligibleAt: failure!.nextEligibleAt, deadlineAt: failure!.readRecoveryDeadlineAt,
    ...(journal && /^[a-f0-9]{64}$/.test(journal.workflowHash ?? "") && /^[a-f0-9]{64}$/.test(journal.payloadHash ?? "")
      ? {journal: {workflowHash: journal.workflowHash, payloadHash: journal.payloadHash}} : {})} : undefined;
  let counted: ReturnType<typeof recordTypedSubrequestStart> | undefined;
  try {
    counted = recordTypedSubrequestStart({type: "custom", operationType: "durableObject", operationName: "triageRunQueryObservation", allowSafetyMargin: true});
    const stub = env!.TRIAGE_RUN_COORDINATOR!.get(env!.TRIAGE_RUN_COORDINATOR!.idFromName("supportdesk-global"));
    const response = await stub.fetch(new Request("https://coordinator.internal/internal/run-query/observe", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({...run, createdFrom: args.createdFrom, createdTo: args.createdTo,
        ...(pendingRead ? {pendingRead} : {ticketNumbers, invocationId: getExecutionState()?.invocationId})}), signal: AbortSignal.timeout(5000),
    }));
    recordSubrequestFinish(counted, response.status, response.ok);
  } catch { if (counted) recordSubrequestFinish(counted, "observationUnavailable", false); }
}

/** Permission to continue a correlated automatic run, never approval of a plan.
 * Call with live ticket metadata before mutation-start checkpoints, and again
 * without metadata immediately before every new dispatcher mutation POST.
 * Receipt GETs remain available for reconciliation after expiry. */
export async function assertTriageRunWriteLease(input: {
  operationId?: string; ownerHash?: string; itemKey?: string; ticketCreatedTime?: string; ticketSource?: string;
} = {}): Promise<void> {
  const env = environments.getStore();
  if (env?.TRIAGE_RUN_WRITE_GUARD_ENABLED !== "true") return;
  const run = runs.getStore();
  const operationTrigger = input.operationId?.match(AUTOMATIC_ID)?.[1];
  if (!run && !operationTrigger) return; // Existing manual operations retain their authorization gates.
  if (run && operationTrigger && run.triggerId !== operationTrigger) throw new Error("Triage run correlation mismatch; no new mutation permitted.");
  if (run && input.operationId && !operationTrigger) throw new Error("Automatic triage requires its exact Trigger ID as batchId.");
  const triggerId = operationTrigger ?? run!.triggerId;
  const ownerPrefix = operationTrigger && input.operationId?.endsWith(`:${operationTrigger}`)
    ? input.operationId.slice(0, -(operationTrigger.length + 1)) : undefined;
  const ownerHash = input.ownerHash ?? (ownerPrefix && /^[a-f0-9]{8}(?:[a-f0-9]{56})?$/.test(ownerPrefix)
    ? ownerPrefix : currentOwnerHash());
  if (!triageLeaseCapability(env).enforced) throw new Error("Triage run write guard unavailable; no new mutation permitted.");
  const counted = recordTypedSubrequestStart({ type: "custom", operationType: "durableObject", operationName: "triageRunLeaseCheck" });
  try {
    const stub = env.TRIAGE_RUN_COORDINATOR!.get(env.TRIAGE_RUN_COORDINATOR!.idFromName("supportdesk-global"));
    const response = await stub.fetch(new Request("https://coordinator.internal/internal/run-lease/check", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ triggerId, ...(run ? {attempt: run.attempt} : {}), ...input,
        ...(operationTrigger ? {operationReference: {operationId: operationTrigger, ownerHash}} : {}) }),
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
