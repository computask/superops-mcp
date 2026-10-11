import { afterEach, describe, expect, it, vi } from "vitest";
import { assertTriageRunStart, assertTriageRunWriteLease, recordTriageRunQuery, recordTriageRunPreparation, runWithTriageLeaseEnvironment, runWithTriageRunContext, triageLeaseCapability } from "./triage-run-lease.js";
import { dispatcherFetch, withDispatcherOperation } from "./dispatcher.js";
import { runWithExecutionContext, executionDiagnostics, getExecutionState } from "./execution.js";

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
  it("persists independent work-start acknowledgement before executing a correlated tool", async () => {
    const {env,fetcher} = environment();
    fetcher.mockImplementation(async()=>Response.json({protocol:"triage-run-start-v1",allowed:true,expiresAt:Date.now()+60000}));
    let executed = false;
    await runWithTriageLeaseEnvironment({...env,TRIAGE_RUN_START_GUARD_ENABLED:"true"}, () =>
      runWithTriageRunContext({triggerId,attempt:2}, () => runWithExecutionContext("test",async()=>{
        await assertTriageRunStart();
        executed = true;
        expect(executionDiagnostics()?.subrequests).toMatchObject({used:1});
      })));
    expect(executed).toBe(true);
    expect(await fetcher.mock.calls[0][0].json()).toEqual({triggerId,attempt:2});
    expect(fetcher.mock.calls[0][0].url).toContain("/internal/run-work/start");
  });
  it.each(["missing","revoked","network","wrong_protocol","expired"])("never executes work when the start guard is %s",async kind=>{
    const {env,fetcher} = environment();
    fetcher.mockImplementation(async()=>Response.json({protocol:kind==="wrong_protocol"?"unknown":"triage-run-start-v1",
      allowed:kind!=="revoked",expiresAt:Date.now()+(kind==="expired"?-1:60000)}));
    if (kind==="network") fetcher.mockRejectedValue(Error("synthetic private dependency body"));
    let executed = false;
    const selected = kind==="missing"?{TRIAGE_RUN_START_GUARD_ENABLED:"true"}:{...env,TRIAGE_RUN_START_GUARD_ENABLED:"true"};
    await expect(runWithTriageLeaseEnvironment(selected,()=>runWithTriageRunContext({triggerId,attempt:1},async()=>{
      await assertTriageRunStart();executed=true;
    }))).rejects.toThrow("no tool executed");
    expect(executed).toBe(false);
  });
  it("keeps manual tools independent of the automatic start guard",async()=>{
    const {env,fetcher} = environment();
    await runWithTriageLeaseEnvironment({...env,TRIAGE_RUN_START_GUARD_ENABLED:"true"},()=>assertTriageRunStart());
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("binds preparation begin and its typed outcome to the same invocation without retaining plan content",async()=>{
    const {env,fetcher}=environment();
    fetcher.mockImplementation(async request=>Response.json(new URL(request.url).pathname.endsWith("/start")
      ? {protocol:"triage-run-start-v1",allowed:true,expiresAt:Date.now()+60000,
        preparationInvocationId:(await request.clone().json() as {preparationInvocationId:string}).preparationInvocationId}:{observed:true}));
    await runWithTriageLeaseEnvironment({...env,TRIAGE_RUN_START_GUARD_ENABLED:"true"},()=>
      runWithTriageRunContext({triggerId,attempt:1},()=>runWithExecutionContext("superops_tickets_prepare_triage_plan",async()=>{
        const args={batchId:triggerId,expectedCandidateTicketNumbers:["90007"],actions:[{note:"synthetic private body"}]};
        await assertTriageRunStart({preparationInvocationId:getExecutionState()!.invocationId});
        await recordTriageRunPreparation(args,{ok:false,complete:false,preparationOnly:true,operationCreated:false,
          preparationOutcome:"validation_failed",error:"synthetic private diagnostic"});
      })));
    const start=await fetcher.mock.calls[0][0].json() as {preparationInvocationId:string},observation=await fetcher.mock.calls[1][0].json();
    expect(observation).toEqual({triggerId,attempt:1,invocationId:start.preparationInvocationId,state:"validation_failed",ticketNumbers:["90007"]});
    expect(JSON.stringify(observation)).not.toMatch(/private|note|error|actions/);
  });
  it("marks an untyped preparation error unavailable instead of fabricating a validation cause",async()=>{
    const {env,fetcher}=environment();
    await runWithTriageLeaseEnvironment({...env,TRIAGE_RUN_START_GUARD_ENABLED:"true"},()=>
      runWithTriageRunContext({triggerId,attempt:1},()=>runWithExecutionContext("prepare",async()=>{
        await recordTriageRunPreparation({batchId:triggerId,expectedCandidateTicketNumbers:["90007"]},{error:"missing ticket number"});
        await recordTriageRunPreparation({batchId:"other",expectedCandidateTicketNumbers:["90007"]},{preparationOutcome:"validation_failed"});
      })));
    expect(fetcher).toHaveBeenCalledTimes(1);expect(await fetcher.mock.calls[0][0].json()).toMatchObject({state:"unavailable"});
  });
  it("requires acknowledgement of the exact preparation invocation before execution",async()=>{
    const {env,fetcher}=environment();
    fetcher.mockImplementation(async()=>Response.json({protocol:"triage-run-start-v1",allowed:true,expiresAt:Date.now()+60000}));
    await expect(runWithTriageLeaseEnvironment({...env,TRIAGE_RUN_START_GUARD_ENABLED:"true"},()=>
      runWithTriageRunContext({triggerId,attempt:1},()=>assertTriageRunStart({preparationInvocationId:"00000000-0000-4000-8000-000000000111"}))))
      .rejects.toThrow("no tool executed");
  });
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
  it("records only complete exact-window query numbers and associates server-owned operation identity", async () => {
    const {env, fetcher} = environment();
    const args = {createdFrom: "2026-10-08T09:00:00.000Z", createdTo: "2026-10-08T09:02:00.000Z",
      status: ["New Calls"], sources: ["EMAIL"], fieldProfile: "minimal"};
    const result = {records: [{displayId: "90007", subject: "private synthetic text"}], pagination: {complete: true}, errors: []};
    await runWithTriageLeaseEnvironment(env, () => runWithTriageRunContext({triggerId, attempt: 1}, async () => {
      await recordTriageRunQuery(args, {...result, pagination: {complete: false}});
      await recordTriageRunQuery({...args, clientId: "filtered"}, result);
      expect(fetcher).not.toHaveBeenCalled();
      await recordTriageRunQuery(args, result);
      await assertTriageRunWriteLease({operationId: triggerId});
    }));
    expect(await fetcher.mock.calls[0][0].json()).toEqual({triggerId, attempt: 1,
      createdFrom: args.createdFrom, createdTo: args.createdTo, ticketNumbers: ["90007"]});
    expect(await fetcher.mock.calls[1][0].json()).toMatchObject({operationReference: {operationId: triggerId, ownerHash: expect.stringMatching(/^[a-f0-9]{8}$/)}});
  });
  it("observes only a server-owned durable pending first read and retains no result body", async () => {
    const {env,fetcher} = environment();
    const args = {createdFrom: "2026-10-09T10:00:00.000Z", createdTo: "2026-10-09T10:02:00.000Z",
      status: ["New Calls"], sources: ["EMAIL"], fieldProfile: "minimal"};
    const result = {records: [], pagination: {complete: false}, errors: [{message: "synthetic private body"}]};
    const failure = {errorClass: "DispatcherReadPending", dispatcherPending: true, readRecoveryDurable: true,
      resumeSameRequest: true, dispatcherRequestId: "synthetic-read", nextEligibleAt: "2026-10-09T10:01:00.000Z",
      readRecoveryDeadlineAt: "2026-10-09T10:15:00.000Z", idempotencyKey: "synthetic-private-key"};
    await runWithTriageLeaseEnvironment(env, () => runWithTriageRunContext({triggerId, attempt: 1}, async () => {
      for (const change of [{readRecoveryDurable: false}, {dispatcherPending: false}, {resumeSameRequest: false}, {errorClass: "NetworkError"}]) {
        await recordTriageRunQuery(args,result,{...failure,...change});
      }
      await recordTriageRunQuery(args,{...result,records:[{displayId:"90007"}]},failure);
      expect(fetcher).not.toHaveBeenCalled();
      await recordTriageRunQuery(args,result,failure);
    }));
    const observed = await fetcher.mock.calls[0][0].json();
    expect(observed).toMatchObject({triggerId, attempt: 1, pendingRead: {requestId: "synthetic-read", ownerHash: expect.stringMatching(/^[a-f0-9]{8}$/)}});
    expect(JSON.stringify(observed)).not.toMatch(/private|message|errorClass|idempotencyKey/);
  });
  it("correlates a successful query with the server invocation without copying its body", async () => {
    const {env, fetcher} = environment();
    const args = {createdFrom: "2026-10-11T09:00:00.000Z", createdTo: "2026-10-11T09:02:00.000Z",
      status: ["New Calls"], sources: ["EMAIL"], fieldProfile: "minimal"};
    let invocationId: string | undefined;
    await runWithExecutionContext("superops_tickets_query", () => runWithTriageLeaseEnvironment(env,
      () => runWithTriageRunContext({triggerId, attempt: 1}, async () => {
        invocationId = getExecutionState()?.invocationId;
        await recordTriageRunQuery(args, {records: [{displayId: "90007", subject: "synthetic private text"}],
          pagination: {complete: true}, errors: []});
      })));
    const observed = await fetcher.mock.calls[0][0].json();
    expect(observed).toMatchObject({invocationId, ticketNumbers: ["90007"]});
    expect(invocationId).toMatch(/^[a-f0-9-]{36}$/);
    expect(JSON.stringify(observed)).not.toMatch(/private|subject/);
  });
  it("projects only validated private journal identity into a pending-query observation", async () => {
    const {env, fetcher} = environment();
    const args = {createdFrom: "2026-10-11T09:00:00.000Z", createdTo: "2026-10-11T09:02:00.000Z",
      status: ["New Calls"], sources: ["EMAIL"], fieldProfile: "minimal"};
    const failure = {errorClass: "DispatcherReadPending", dispatcherPending: true, readRecoveryDurable: true,
      resumeSameRequest: true, dispatcherRequestId: "synthetic-read", nextEligibleAt: "2026-10-11T09:01:00.000Z",
      readRecoveryDeadlineAt: "2026-10-11T09:15:00.000Z"};
    await runWithTriageLeaseEnvironment(env, () => runWithTriageRunContext({triggerId, attempt: 1}, async () => {
      for (const payloadHash of ["b".repeat(64), "invalid"]) {
        await recordTriageRunQuery(args, {records: [], pagination: {complete: false}}, failure,
          {readRecovery: {journalIdentity: {workflowHash: "a".repeat(64), payloadHash}}, message: "synthetic private text"});
      }
    }));
    const first = await fetcher.mock.calls[0][0].json() as {pendingRead: {journal?: unknown}};
    expect(first.pendingRead.journal).toEqual({workflowHash: "a".repeat(64), payloadHash: "b".repeat(64)});
    const second = await fetcher.mock.calls[1][0].json() as {pendingRead: {journal?: unknown}};
    expect(second.pendingRead.journal).toBeUndefined();
    expect(JSON.stringify(first)).not.toMatch(/private|message|readRecovery|idempotency/);
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
  it("uses the approved record owner during internal continuation without an interactive audit identity", async () => {
    const {env,fetcher} = environment();
    await runWithTriageLeaseEnvironment(env, () => assertTriageRunWriteLease({operationId:triggerId,ownerHash:'12345678',itemKey:'90007'}));
    expect(await fetcher.mock.calls[0][0].json()).toMatchObject({operationReference:{operationId:triggerId,ownerHash:'12345678'}});
  });
});
