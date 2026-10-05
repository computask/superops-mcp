import { afterEach, describe, expect, it, vi } from "vitest";
import { assertTriageRunWriteLease, runWithTriageLeaseEnvironment, runWithTriageRunContext, triageLeaseCapability } from "./triage-run-lease.js";
import { dispatcherFetch, withDispatcherOperation } from "./dispatcher.js";
import { runWithExecutionContext, executionDiagnostics } from "./execution.js";

const triggerId = "triage-7-00000000-0000-4000-8000-000000000007";
const scope = {operationId: `synthetic-owner:${triggerId}`, itemKey: "90007"};
function environment(allowed = true, expiresAt = Date.now() + 60000) {
  const fetcher = vi.fn(async (_request: Request) => Response.json({protocol: "triage-run-lease-v1", allowed, expiresAt}, {status: allowed ? 200 : 409}));
  return {env: {TRIAGE_RUN_WRITE_GUARD_ENABLED: "true", TRIAGE_RUN_COORDINATOR: {
    idFromName: vi.fn((name: string) => name), get: vi.fn(() => ({fetch: fetcher})),
  }}, fetcher};
}
afterEach(() => { vi.unstubAllGlobals(); });
describe("automatic triage write leases", () => {
  it("counts the independent guard check and binds its request to the global coordinator and live ticket metadata", async () => {
    const {env, fetcher} = environment();
    await runWithTriageLeaseEnvironment(env, () => runWithExecutionContext("test", async () => {
      await assertTriageRunWriteLease({...scope, ticketCreatedTime: "2026-10-05T10:00:00Z", ticketSource: "EMAIL"});
      expect(executionDiagnostics()?.subrequests).toMatchObject({used: 1});
    }));
    expect(env.TRIAGE_RUN_COORDINATOR.idFromName).toHaveBeenCalledWith("supportdesk-global");
    expect(await fetcher.mock.calls[0][0].json()).toMatchObject({triggerId, itemKey: "90007", ticketSource: "EMAIL"});
  });
  it.each(["missing", "expired", "denied", "wrong_protocol", "network"])("fails closed for %s", async kind => {
    const {env, fetcher} = environment(kind !== "denied", kind === "expired" ? Date.now() - 1 : Date.now() + 60000);
    if (kind === "wrong_protocol") fetcher.mockImplementation(async () => Response.json({protocol: "unknown", allowed: true, expiresAt: Date.now() + 60000}));
    if (kind === "network") fetcher.mockRejectedValue(Error("private upstream body must never escape"));
    const selected = kind === "missing" ? {TRIAGE_RUN_WRITE_GUARD_ENABLED: "true"} : env;
    await expect(runWithTriageLeaseEnvironment(selected, () => assertTriageRunWriteLease(scope))).rejects.toThrow(/no new mutation permitted/);
  });
  it("rejects correlation mismatches and preserves manual operations", async () => {
    const {env, fetcher} = environment();
    await runWithTriageLeaseEnvironment(env, async () => {
      await assertTriageRunWriteLease({operationId: "manual-operation"});
      await expect(runWithTriageRunContext({triggerId, attempt: 1}, () => assertTriageRunWriteLease({operationId: "manual-operation"}))).rejects.toThrow("exact Trigger ID");
      await expect(runWithTriageRunContext({triggerId: triggerId.replace("triage-7-", "triage-8-"), attempt: 1}, () => assertTriageRunWriteLease(scope))).rejects.toThrow("correlation mismatch");
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(triageLeaseCapability(env).enforced).toBe(true);
    expect(triageLeaseCapability({TRIAGE_RUN_WRITE_GUARD_ENABLED: "true"}).enforced).toBe(false);
  });
  it("blocks a continuation's new POST after expiry while permitting same-receipt GET reconciliation", async () => {
    const {env, fetcher: guard} = environment(false);
    const upstream = vi.fn(async (_url: string, _init: RequestInit) => Response.json({source: "superops-mcp", status: "succeeded", requestId: "synthetic-receipt", httpStatus: 200, response: {data: {ok: true}}}));
    vi.stubGlobal("fetch", upstream);
    await runWithTriageLeaseEnvironment(env, () => withDispatcherOperation(scope.operationId, scope.itemKey, async () => {
      await expect(dispatcherFetch("{}", {env: {DISPATCHER_TOKEN: "synthetic-token"}, mutation: true, idempotencyKey: "synthetic-key"})).rejects.toThrow("lease expired");
      expect(upstream).not.toHaveBeenCalled();
      await dispatcherFetch("", {env: {DISPATCHER_TOKEN: "synthetic-token"}, mutation: true, requestId: "synthetic-receipt", idempotencyKey: "synthetic-key"});
    }));
    expect(guard).toHaveBeenCalledTimes(1);
    expect(upstream.mock.calls.map(call => call[1].method)).toEqual(["GET"]);
  });
});
