import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test'; // Independent Node harness, not a Vitest suite.

// Exercise the actual preserved production module, exposing internals only in
// this in-memory test module. No test route or export is shipped to production.
const source = readFileSync(new URL('./src/index.js', import.meta.url), 'utf8');
const {CoordinatorEngine, createInitialState, loadConfig, registerCreatedNotification, createPendingTriggerScope, parseSafeMcpExecution, toolDefinition} = await import(
  `data:text/javascript;base64,${Buffer.from(source + '\nexport {CoordinatorEngine, createInitialState, loadConfig, registerCreatedNotification, createPendingTriggerScope, parseSafeMcpExecution, toolDefinition};').toString('base64')}`
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
test('five notification burst gives the final arrival its full ingestion grace',()=>{
  const config=loadConfig(vars), state=createInitialState();
  const start=Date.parse('2026-09-24T06:17:39.852Z');
  for(const offset of [0,1798,2433,2895,12438]) registerCreatedNotification(state,config,start+offset,60000);
  assert.equal(state.dueAt,start+12438+16000);
  assert.equal(state.queuedPending,false);
  const scope=createPendingTriggerScope(state,config,state.dueAt);
  assert(Date.parse(scope.createdTo)>Date.parse('2026-09-24T06:17:58.517Z'));
});
test('sustained arrivals spill into next window without starving or widening the first',()=>{
  const config=loadConfig(vars), state=createInitialState(), start=Date.parse('2026-09-24T06:00:00Z');
  registerCreatedNotification(state,config,start,60000);
  registerCreatedNotification(state,config,start+29000,60000);
  const firstDue=state.dueAt, firstEnd=state.pendingNotificationWindowEndedAt;
  registerCreatedNotification(state,config,start+30000,60000);
  assert.equal(state.dueAt,firstDue);
  assert.equal(state.pendingNotificationWindowEndedAt,firstEnd);
  assert.equal(state.queuedPending,true);
  assert.equal(state.queuedLastNotificationAt,start+30000);
  assert(state.queuedDueAt>=start+30000+16000);
});
test('notifications during a frozen run preserve its exact scope',()=>{
  const config=loadConfig(vars), state=createInitialState(), start=Date.parse('2026-09-24T06:00:00Z');
  registerCreatedNotification(state,config,start,60000);
  const scope=createPendingTriggerScope(state,config,state.dueAt);
  state.pendingTriggerScope=scope;
  registerCreatedNotification(state,config,start+20000,60000);
  assert.deepEqual(state.pendingTriggerScope,scope);
  assert.equal(state.queuedPending,true);
});
const dispatcherTrace={index:1,provider:'dispatcher',type:'paginationRead',operationType:'query',
  operationName:'getTicketList',status:200,retryCount:0,startedAt:'2026-09-24T06:00:00.000Z',
  completedAt:'2026-09-24T06:00:01.000Z',endpointHost:'superops-api-dispatcher.taskgroup.co.uk',
  httpStatus:200,outcome:'success',dispatcherRequestId:'synthetic-request-1',dispatcherState:'succeeded',
  responseHadData:true,rateLimited:false,retryAfterSupplied:false,durationMs:1000,ok:true};
test('dispatcher transport and poll telemetry survive the callback parser exactly',()=>{
  const execution={toolName:'superops_tickets_query',subrequestsUsed:2,
    requestsByType:{paginationRead:1,dispatcherPoll:1},requestTrace:[dispatcherTrace,
      {...dispatcherTrace,index:2,type:'dispatcherPoll',operationName:'dispatcherStatus'}]};
  assert.deepEqual(parseSafeMcpExecution(execution),execution);
  const schema=toolDefinition().inputSchema.properties.metadata.properties.mcpExecution;
  assert.equal(schema.additionalProperties,false);
  assert(schema.properties.requestsByType.properties.dispatcherPoll);
  const traceSchema=schema.properties.requestTrace.items;
  assert.equal(traceSchema.additionalProperties,false);
  assert(traceSchema.properties.type.enum.includes('dispatcherPoll'));
  for(const key of Object.keys(dispatcherTrace)) assert(traceSchema.properties[key],key);
});
test('legacy traces remain valid and unsafe or malformed telemetry is rejected',()=>{
  const legacy={requestTrace:[{index:1,type:'initialRead',status:200,ok:true}]};
  assert.deepEqual(parseSafeMcpExecution(legacy),legacy);
  for(const invalid of [{headers:{Authorization:'synthetic'}},{endpointHost:'https://host/path?token=synthetic'},
    {provider:'unknown'},{startedAt:'invalid'},{rateLimited:'false'},{httpStatus:999},
    {dispatcherRequestId:'Bearer synthetic'},{errorClass:'customer text'}]) {
    assert.equal(parseSafeMcpExecution({requestTrace:[{...dispatcherTrace,...invalid}]}),null);
  }
});
