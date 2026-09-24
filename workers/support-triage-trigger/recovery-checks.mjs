import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test'; // Independent Node harness, not a Vitest suite.

// Exercise the actual preserved production module, exposing internals only in
// this in-memory test module. No test route or export is shipped to production.
const source = readFileSync(new URL('./src/index.js', import.meta.url), 'utf8');
const {CoordinatorEngine, createInitialState, loadConfig} = await import(
  `data:text/javascript;base64,${Buffer.from(source + '\nexport {CoordinatorEngine, createInitialState, loadConfig};').toString('base64')}`
);
const vars = JSON.parse(readFileSync(new URL('./wrangler.jsonc', import.meta.url), 'utf8')).vars;

function fixture(status, age = 120000) {
  let now = Date.parse('2026-09-24T06:00:00Z');
  const scope = {mode:'new-email-tickets', createdFrom:new Date(now-60000).toISOString(), createdTo:new Date(now).toISOString()};
  let state = {...createInitialState(), pending:true, pendingReason:'new_message',
    pendingTriggerId:'email-triage:9001', pendingTriggerScope:scope,
    pendingNotificationWindowStartedAt:now-60000, pendingNotificationWindowEndedAt:now,
    pendingNotificationLookbackMs:60000, executionPhase:'awaiting_result', dispatchAttempt:1,
    lastAcceptedTrigger:{triggerId:'email-triage:9001', attempt:1, runId:'apirun_synthetic', acceptedAt:new Date(now-age).toISOString()},
    resultDeadlineAt:now+30000};
  const calls = [];
  const alarms = [];
  const engine = new CoordinatorEngine({config:loadConfig(vars), now:()=>now,
    store:{load:async()=>structuredClone(state),save:async s=>{state=structuredClone(s);},setAlarm:async at=>alarms.push(at)},
    agent:{getRunDiagnostics:async()=>({status,httpStatus:200}),trigger:async(...args)=>{calls.push(args);return {kind:'accepted',runId:'apirun_retry'};}}});
  return {engine,calls,alarms,scope,get state(){return state;},advance:()=>{now=state.dueAt ?? now+40000;},expire:()=>{now+=40000;}};
}
const metadata = {failureStage:'evidence_recovery',ticketsConsidered:1,ticketsCompleted:0,ticketsDeferred:1,
  failureDiagnostics:[{stage:'evidence_recovery',errorCode:'read_failed',message:'Synthetic no-write failure'}]};

for (const status of ['completed','failed']) for (const age of [120000,600000]) {
  test(`recorded no-write callback retries exact window after ${status}, age ${age}`, async()=>{
    const f=fixture(status,age);
    const result=await f.engine.reportResult({triggerId:f.state.pendingTriggerId,attempt:1,status:'terminal_failure',metadata});
    assert.equal(result.status,'retry_scheduled');
    f.advance();
    assert.equal((await f.engine.processAlarm()).status,'accepted');
    assert.equal(f.calls.length,1);
    assert.deepEqual(f.calls[0].slice(0,3),['email-triage:9001',f.scope,2]);
    assert.equal(f.state.needsAttentionScopes.length,0);
    assert(!f.state.dispatchHistory.some(e=>e.event==='orphan_recovered'||e.event==='stale_run_recovered'));
  });
}
for (const status of ['in_progress','queued','unavailable','suspended']) {
  test(`recorded callback does not overlap an ${status} run`,async()=>{
    const f=fixture(status,600000);
    await f.engine.reportResult({triggerId:f.state.pendingTriggerId,attempt:1,status:'terminal_failure',metadata});
    f.advance(); await f.engine.processAlarm();
    assert.equal(f.calls.length,0);
    assert.equal(f.state.pending,true);
    assert(f.alarms.length>0);
  });
}
test('a genuinely missing callback stays fenced, never blindly replayed',async()=>{
  const f=fixture('completed'); f.expire(); await f.engine.processAlarm();
  assert.equal(f.calls.length,0);
  assert.equal(f.state.needsAttentionScopes.length,1);
  assert(f.state.dispatchHistory.some(e=>e.event==='orphan_recovered'));
});
test('triage apply-not-attempted callback with complete diagnostics retries',async()=>{
  const f=fixture('completed');
  const report={...metadata,failureStage:'triage_apply',
    ticketOutcomes:[{ticketId:'100000000000001',ticketNumber:90001,outcome:'not_attempted',reasonCode:'apply_not_attempted'}],
    mcpExecution:{toolName:'superops_tickets_get_safe',requestsByType:{verificationRead:1},requestTrace:[],retryCount:0}};
  assert.equal((await f.engine.reportResult({triggerId:f.state.pendingTriggerId,attempt:1,status:'terminal_failure',metadata:report})).status,'retry_scheduled');
  f.advance(); assert.equal((await f.engine.processAlarm()).status,'accepted');
  assert.deepEqual(f.calls[0][1],f.scope);
});
test('rate-limit callback respects its delay then retries the same window',async()=>{
  const f=fixture('completed');
  await f.engine.reportResult({triggerId:f.state.pendingTriggerId,attempt:1,status:'retryable_rate_limit',retryAfterSeconds:120,metadata});
  await f.engine.processAlarm(); assert.equal(f.calls.length,0);
  f.advance(); assert.equal((await f.engine.processAlarm()).status,'accepted');
  assert.deepEqual(f.calls[0][1],f.scope);
});
test('unclassified possible-write failure is not retried',async()=>{
  const f=fixture('completed');
  await f.engine.reportResult({triggerId:f.state.pendingTriggerId,attempt:1,status:'terminal_failure',metadata:{...metadata,failureStage:'triage_apply'}});
  f.advance(); await f.engine.processAlarm(); assert.equal(f.calls.length,0);
});
