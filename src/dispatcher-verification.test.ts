import { afterEach, expect, it, vi } from "vitest";
import { dispatcherFetch, reconcileCurrentDispatcherReceipt, runWithDispatcher, withDispatcherOperation, type DispatcherReceipt } from "./dispatcher.js";
import { executionDiagnostics, runWithExecutionConfig, runWithExecutionContext } from "./execution.js";
import type { DispatcherVerification } from "./dispatcher-verification.js";
const env = {DISPATCHER_TOKEN: "synthetic-mcp", CF_ACCESS_CLIENT_ID: "synthetic-access", CF_ACCESS_CLIENT_SECRET: "synthetic-secret"};
const mutationId = "10000000-0000-4000-8000-000000000001";
const readId = "10000000-0000-4000-8000-000000000002";
const prior: DispatcherReceipt = {requestId: mutationId, idempotencyKey: "superops-mcp:original", state: "uncertain", mutationFingerprint: "f".repeat(64), attemptCount: 1};
const readBody = JSON.stringify({query: "query Read($input: TicketIdentifierInput!) {getTicket(input: $input) {ticketId status}}", variables: {input: {ticketId: "synthetic-ticket"}}});
const row = (proof?: DispatcherVerification) => ({requestId: mutationId, source: "superops-mcp", type: "mutation", fingerprint: prior.mutationFingerprint, attemptCount: 1,
  status: proof?.outcome === "applied" ? "succeeded" : "uncertain", uncertain: proof?.outcome !== "applied", errorClassification: proof?.outcome === "applied" ? "RECONCILED_APPLIED" : "GRAPHQL_ERROR", verification: proof});
async function proof(body: string, outcome: DispatcherVerification["outcome"] = "applied"): Promise<DispatcherVerification> {
  const parsed = JSON.parse(body);
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))), b => b.toString(16).padStart(2, "0")).join("");
  return {schemaVersion: 1, requestId: mutationId, mutationFingerprint: parsed.mutationFingerprint, attemptCount: 1, evidenceHash: hash, outcome,
    reasonCode: outcome === "applied" ? "complete_target_observed" : "target_not_observed", partial: false, checkedFields: ["status"], readRequestIds: parsed.readRequestIds, replayAllowed: false, verifiedAt: new Date().toISOString()};
}
function transport(transform?: (value: ReturnType<typeof row>) => unknown, outcome: DispatcherVerification["outcome"] = "applied") {
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/graphql")) return Response.json({data: {getTicket: {ticketId: "synthetic-ticket", status: "Resolved"}}}, {headers: {"X-Dispatcher-Request-Id": readId, "X-Dispatcher-Status": "succeeded"}});
    if (init?.method === "GET") return Response.json(row());
    const value = row(await proof(String(init?.body), outcome));
    return Response.json(transform ? transform(value) : value);
  }); vi.stubGlobal("fetch", mock); return mock;
}
const scope = <T>(fn: () => T, save = async (_r: DispatcherReceipt) => {}) => runWithDispatcher(env, () => withDispatcherOperation("owner:operation", "synthetic-ticket", fn, save, {...prior}));
const read = () => dispatcherFetch(readBody, {idempotencyKey: "superops-mcp:read"});
afterEach(() => {vi.unstubAllGlobals();});
it("retains the mutation receipt through verification reads and checkpoints verified settlement before advancing", async () => {
  const mock = transport(); const saved: DispatcherReceipt[] = [];
  await runWithExecutionContext("verification", () => scope(async () => {
    await (await read()).body?.cancel();
    await reconcileCurrentDispatcherReceipt(true);
    expect(saved.at(-1)).toMatchObject({requestId: mutationId, state: "succeeded", verification: {outcome: "applied", replayAllowed: false}});
    expect(executionDiagnostics()?.subrequests).toMatchObject({used: 2});
  }, async r => {saved.push(r);}));
  const verification = mock.mock.calls.find(([url]) => url.endsWith("/verify"))!;
  expect(JSON.parse(String(verification[1]?.body))).toEqual({schemaVersion: 1, mutationFingerprint: prior.mutationFingerprint, expectedAttemptCount: 1, readRequestIds: [readId]});
  expect(verification[1]).toMatchObject({method: "POST", redirect: "manual", headers: {Authorization: "Bearer synthetic-mcp", "X-Source": "superops-mcp", "CF-Access-Client-Id": "synthetic-access"}});
  expect(saved.every(r => r.requestId === mutationId)).toBe(true);
});
it.each(["not_observed", "unknown"] as const)("%s retains uncertainty and blocks the next stage", async outcome => {
  const mock = transport(undefined, outcome); const saved: DispatcherReceipt[] = [];
  await scope(async () => {
    await (await read()).body?.cancel();
    expect((await reconcileCurrentDispatcherReceipt())?.outcome).toBe(outcome);
    await expect(dispatcherFetch("next mutation", {mutation: true, idempotencyKey: "superops-mcp:next"})).rejects.toMatchObject({requestId: mutationId, state: "unresolved_prior_mutation"});
  }, async r => {saved.push(r);});
  expect(saved.at(-1)?.state).toBe("uncertain"); expect(mock.mock.calls.filter(([url]) => url.endsWith("/graphql"))).toHaveLength(1);
});
it.each(["source", "fingerprint", "attempts", "hash", "replay", "read", "customerField"])("rejects mismatched or unsafe %s settlement without allowing a new write", async field => {
  const mock = transport(value => {
    if (field === "source") value.source = "other";
    if (field === "fingerprint") value.fingerprint = "0".repeat(64);
    if (field === "attempts") value.attemptCount = 2;
    if (field === "hash") value.verification!.evidenceHash = "0".repeat(64);
    if (field === "replay") Object.assign(value.verification!, {replayAllowed: true});
    if (field === "read") value.verification!.readRequestIds = [mutationId];
    if (field === "customerField") value.verification!.checkedFields = ["synthetic-private-content"];
    return value;
  });
  await scope(async () => {
    await (await read()).body?.cancel();
    await expect(reconcileCurrentDispatcherReceipt(true)).rejects.toMatchObject({state: "invalid_verification_identity"});
    await expect(dispatcherFetch("mutation next", {mutation: true, idempotencyKey: "superops-mcp:next"})).rejects.toMatchObject({state: "unresolved_prior_mutation"});
  });
  expect(mock.mock.calls).toHaveLength(3);
});
it.each([503, 302])("HTTP %s settlement failure holds the original receipt without replay", async status => {
  const mock = transport(); mock.mockImplementationOnce(async () => new Response(null, {status}));
  await expect(scope(() => reconcileCurrentDispatcherReceipt(true))).rejects.toMatchObject({requestId: mutationId, state: "verification_unavailable"});
  expect(mock).toHaveBeenCalledTimes(1);
});
it("exhausted verification budget makes no request and cannot advance", async () => {
  const mock = transport();
  await runWithExecutionConfig({SUPEROPS_EXECUTION_SUBREQUEST_BUDGET: "1", SUPEROPS_EXECUTION_SUBREQUEST_SAFETY_MARGIN: "1"}, () => runWithExecutionContext("verification", async () => {
    await expect(scope(() => reconcileCurrentDispatcherReceipt(true))).rejects.toMatchObject({state: "verification_budget_exhausted"});
  })); expect(mock).not.toHaveBeenCalled();
});
it("recovers an applied settlement after acknowledgement loss by polling its original receipt", async () => {
  let settled: DispatcherVerification | undefined;
  const mock = transport(); mock.mockImplementation(async (url, init) => {
    if (url.endsWith("/graphql")) return Response.json({data: {getTicket: {ticketId: "synthetic-ticket", status: "Resolved"}}}, {headers: {"X-Dispatcher-Request-Id": readId, "X-Dispatcher-Status": "succeeded"}});
    if (init?.method === "GET") return Response.json(row(settled));
    settled = await proof(String(init?.body)); throw new Error("synthetic lost verification acknowledgement");
  });
  await scope(async () => {
    await (await read()).body?.cancel(); await expect(reconcileCurrentDispatcherReceipt(true)).rejects.toMatchObject({state: "verification_unavailable"});
  });
  const saved: DispatcherReceipt[] = [];
  expect((await scope(() => reconcileCurrentDispatcherReceipt(true), async r => {saved.push(r);}))?.outcome).toBe("applied");
  expect(saved.at(-1)?.state).toBe("succeeded"); expect(mock.mock.calls.filter(([url]) => url.endsWith("/verify"))).toHaveLength(1);
});
