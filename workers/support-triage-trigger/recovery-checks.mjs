import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test'; // Independent Node harness, not a Vitest suite.

// Exercise the actual preserved production module, exposing internals only in
// this in-memory test module. No test route or export is shipped to production.
const source = readFileSync(new URL('./src/index.js', import.meta.url), 'utf8');
const {CoordinatorEngine, createInitialState, loadConfig, registerCreatedNotification, createPendingTriggerScope, parseSafeMcpExecution, toolDefinition, refreshQueuedAttentionBlock, blockPendingIfAttentionOverlaps, widenTargetedEmailScopeForRecovery, scopeOverlapsAttention, normalizeState} = await import(
  `data:text/javascript;base64,${Buffer.from(source + '\nexport {CoordinatorEngine, createInitialState, loadConfig, registerCreatedNotification, createPendingTriggerScope, parseSafeMcpExecution, toolDefinition, refreshQueuedAttentionBlock, blockPendingIfAttentionOverlaps, widenTargetedEmailScopeForRecovery, scopeOverlapsAttention, normalizeState};').toString('base64')}`
);
const vars = JSON.parse(readFileSync(new URL('./wrangler.jsonc', import.meta.url), 'utf8')).vars;

test('dispatch input requires an actual no-apply cause and preserves receipt diagnostics',()=>{
  assert(source.includes('apply_not_attempted describes an outcome, not a cause'));
  assert(source.includes('reason_unavailable if the cause genuinely cannot be established'));
  assert(source.includes('never invent HTTP 400/429/502'));
  assert(source.includes('Keep any observed denial terminal; do not retry or bypass it'));
});

test('the single metadata lookup covers closure fields before a resolve plan',()=>{
  assert(source.includes('Plan the single field-options lookup after establishing'));
  assert(source.includes('include any missing cause and resolutionCode in that same lookup'));
  assert(source.includes('missing closure-only cause/resolutionCode is not a reason to stop'));
  assert(source.includes('Never invent option values, resolve an actionable ticket'));
});

function fixture(status, age = 120000) {
  let now = Date.parse('2026-09-24T06:00:00Z');
  const scope = {mode:'new-email-tickets', source:'EMAIL', createdFrom:new Date(now-60000).toISOString(), createdTo:new Date(now).toISOString()};
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
  return {engine,calls,alarms,scope,get state(){return state;},seed:patch=>{state={...state,...patch};},setNow:value=>{now=Date.parse(value);},advance:()=>{now=state.dueAt ?? now+40000;},expire:()=>{now+=40000;}};
}

const emailScope=(from,to)=>({mode:'new-email-tickets',source:'EMAIL',createdFrom:from,createdTo:to});
const failedScope=emailScope('2026-09-24T09:28:12.295Z','2026-09-24T09:29:45.946Z');
function overlappingQueue() {
  return {...createInitialState(),needsAttentionScope:failedScope,needsAttentionScopes:[failedScope],candidateAttentionFenceActive:true,
    queuedPending:true,queuedReason:'new_message',queuedNotificationWindowStartedAt:Date.parse('2026-09-24T09:30:12.964Z'),
    queuedNotificationWindowEndedAt:Date.parse('2026-09-24T09:32:34.626Z'),queuedNotificationLookbackMs:60000,
    queuedLastNotificationAt:Date.parse('2026-09-24T09:31:47.626Z'),queuedDueAt:Date.parse('2026-09-24T09:32:03.626Z')};
}
test('exact overlapping-lookback regression releases later ticket after ambiguous callback',async()=>{
  const f=fixture('completed');
  f.setNow('2026-09-24T09:32:16.410Z');
  f.seed({...overlappingQueue(),pending:true,pendingReason:'new_message',pendingTriggerId:'email-triage:9001',
    pendingTriggerScope:failedScope,pendingNotificationWindowStartedAt:Date.parse('2026-09-24T09:29:12.295Z'),
    pendingNotificationWindowEndedAt:Date.parse(failedScope.createdTo),pendingNotificationLookbackMs:60000,
    executionPhase:'awaiting_result',dispatchAttempt:1,
    lastAcceptedTrigger:{triggerId:'email-triage:9001',attempt:1,runId:'apirun_synthetic',acceptedAt:'2026-09-24T09:29:45.946Z'}});
  await f.engine.reportResult({triggerId:f.state.pendingTriggerId,attempt:1,status:'terminal_failure',metadata:{failureStage:'triage_apply'}});
  f.advance();
  assert.equal((await f.engine.processAlarm()).status,'accepted');
  assert.equal(f.calls.length,1);
  const dispatched=f.calls[0][1];
  assert.equal(dispatched.createdFrom,failedScope.createdTo);
  assert.equal(dispatched.createdTo,'2026-09-24T09:32:16.410Z');
  assert(Date.parse(dispatched.createdFrom)<=Date.parse('2026-09-24T09:30:06Z'));
  assert.deepEqual(f.state.needsAttentionScopes,[failedScope]);
  assert.equal(f.state.attentionBlockedWindow.notificationWindowEndedAt,Date.parse(failedScope.createdTo));
  assert(!scopeOverlapsAttention(f.state,loadConfig(vars),dispatched));
  assert(f.state.dispatchHistory.some(e=>e.event==='attention_tail_released'));
  // Persisted state/restart retains both the exact hold and released run.
  const restored=normalizeState(JSON.parse(JSON.stringify(f.state)));
  assert.deepEqual(restored.pendingTriggerScope,dispatched);
  assert.deepEqual(restored.needsAttentionScopes,[failedScope]);
});
test('tail release respects every comparable fence and never releases a legacy aggregate gap',()=>{
  const s=overlappingQueue(), config=loadConfig(vars);
  s.needsAttentionScopes.push(emailScope('2026-09-24T09:30:20Z','2026-09-24T09:30:40Z'));
  s.attentionBlockedWindow={reason:'new_message',notificationWindowStartedAt:Date.parse('2026-09-15T13:00:00Z'),
    notificationWindowEndedAt:Date.parse('2026-09-24T09:31:00Z'),notificationLookbackMs:60000,
    lastNotificationAt:null,debounceWindowStartedAt:null,unavailableRetryCount:0,lifecycleRecoveryRequested:false,lastLifecycleEvent:null};
  refreshQueuedAttentionBlock(s,config,Date.parse('2026-09-24T09:32:16Z'));
  assert.equal(s.queuedNotificationWindowStartedAt,Date.parse('2026-09-24T09:31:00Z'));
  assert.equal(s.queuedNotificationLookbackMs,0);
  assert.equal(s.attentionBlockedWindow.notificationWindowEndedAt,Date.parse('2026-09-24T09:31:00Z'));
});
for(const variant of ['fully-overlapping','rollback']) {
  test(`${variant} retains the entire blocked window`,()=>{
    const s=overlappingQueue(), config=loadConfig(vars);
    if(variant==='fully-overlapping') s.queuedNotificationWindowEndedAt=Date.parse('2026-09-24T09:29:40Z');
    if(variant==='rollback') config.attentionTailIsolationEnabled=false;
    refreshQueuedAttentionBlock(s,config);
    assert.equal(s.queuedNotificationWindowStartedAt,null);
    assert(s.attentionBlockedWindow);
    assert(!s.dispatchHistory.some(e=>e.event==='attention_tail_released'));
  });
}
test('opaque full-queue fence cannot block a time-bounded safe email tail',()=>{
  const s=overlappingQueue(),config=loadConfig(vars);
  s.needsAttentionAt=Date.parse(failedScope.createdTo);
  s.needsAttentionScopes.push({mode:'full-new-calls',reason:'legacy-aggregate'});
  s.needsAttentionScopes.push({...failedScope,createdTo:'invalid'});
  refreshQueuedAttentionBlock(s,config,Date.parse('2026-09-24T09:32:16Z'));
  assert.equal(s.queuedNotificationWindowStartedAt,Date.parse('2026-09-24T09:30:12.964Z'));
  assert.equal(s.queuedNotificationLookbackMs,
    Date.parse('2026-09-24T09:30:12.964Z')-Date.parse(failedScope.createdTo));
  assert(!scopeOverlapsAttention(s,config,{mode:'new-email-tickets',source:'EMAIL',
    createdFrom:failedScope.createdTo,createdTo:'2026-09-24T09:32:34.626Z'}));
  assert.equal(s.needsAttentionScopes.at(-2).mode,'full-new-calls');
  assert.equal(s.needsAttentionScopes.at(-1).createdTo,'invalid');
  assert(s.attentionBlockedWindow,'the uncertain prefix remains durably held');
});
test('opaque fences release later email from the persisted incident-time boundary',()=>{
  const s=createInitialState(),config=loadConfig(vars);
  s.needsAttentionScopes=[{mode:'full-new-calls',reason:'legacy-aggregate'}];
  s.needsAttentionScope=s.needsAttentionScopes[0];s.candidateAttentionFenceActive=true;
  s.needsAttentionAt=Date.parse('2026-09-24T09:31:00Z');
  const candidate=emailScope('2026-09-24T09:31:00Z','2026-09-24T09:32:00Z');
  assert(!scopeOverlapsAttention(s,config,candidate),'events at or after the incident boundary are independent');
  Object.assign(s,{queuedPending:true,queuedReason:'new_message',
    queuedNotificationWindowStartedAt:Date.parse('2026-09-24T09:30:00Z'),
    queuedNotificationWindowEndedAt:Date.parse(candidate.createdTo),queuedNotificationLookbackMs:60000,
    queuedLastNotificationAt:Date.parse(candidate.createdTo),queuedDueAt:Date.parse(candidate.createdTo)});
  refreshQueuedAttentionBlock(s,config,Date.parse(candidate.createdTo));
  assert.equal(s.queuedNotificationWindowStartedAt,Date.parse(candidate.createdFrom));
  assert.equal(s.queuedNotificationLookbackMs,0);
  assert(s.attentionBlockedWindow,'the uncertain prefix remains durably held');
});
test('missing incident time uses the current queue evaluation time rather than starving future tickets',()=>{
  const s=createInitialState(),config=loadConfig(vars);
  s.needsAttentionScopes=[{mode:'full-new-calls',reason:'legacy-aggregate'}];
  s.needsAttentionScope=s.needsAttentionScopes[0];s.candidateAttentionFenceActive=true;
  const candidate=emailScope('2026-09-24T09:30:00Z','2026-09-24T09:32:00Z');
  Object.assign(s,{queuedPending:true,queuedReason:'new_message',
    queuedNotificationWindowStartedAt:Date.parse(candidate.createdFrom),
    queuedNotificationWindowEndedAt:Date.parse(candidate.createdTo),queuedNotificationLookbackMs:0,
    queuedLastNotificationAt:Date.parse(candidate.createdTo),queuedDueAt:Date.parse(candidate.createdTo)});
  refreshQueuedAttentionBlock(s,config,Date.parse('2026-09-24T09:31:00Z'));
  assert.equal(s.queuedNotificationWindowStartedAt,Date.parse('2026-09-24T09:31:00Z'));
  assert(s.attentionBlockedWindow,'the pre-cutoff candidate prefix remains quarantined');
});
test('reconciliation mode without any attention record does not invent a blocker',()=>{
  const s=createInitialState(),config=loadConfig(vars),candidate=emailScope('2026-09-24T09:30:00Z','2026-09-24T09:32:00Z');
  Object.assign(s,{queuedPending:true,queuedReason:'new_message',
    queuedNotificationWindowStartedAt:Date.parse(candidate.createdFrom),
    queuedNotificationWindowEndedAt:Date.parse(candidate.createdTo),queuedNotificationLookbackMs:0,
    queuedLastNotificationAt:Date.parse(candidate.createdTo),queuedDueAt:Date.parse(candidate.createdTo)});
  assert.equal(scopeOverlapsAttention(s,config,candidate),false);
  refreshQueuedAttentionBlock(s,config,Date.parse('2026-09-24T09:31:00Z'));
  assert.equal(s.queuedNotificationWindowStartedAt,Date.parse(candidate.createdFrom));
  assert.equal(s.queuedBlockedByAttention,false);
});
test('pending unaccepted tail is released without changing its delay or admitting the protected ticket',()=>{
  const s=createInitialState(),config=loadConfig(vars),at=Date.parse('2026-09-24T09:30:12.964Z');
  s.needsAttentionScope=failedScope;s.needsAttentionScopes=[failedScope];
  registerCreatedNotification(s,config,at,60000);
  const due=s.dueAt;
  blockPendingIfAttentionOverlaps(s,config,at);
  assert.equal(s.dueAt,due);
  assert.equal(s.pendingNotificationWindowStartedAt,at,'retain original notification timing');
  assert.equal(s.pendingNotificationWindowStartedAt-s.pendingNotificationLookbackMs,Date.parse(failedScope.createdTo));
  s.pendingTriggerScope=createPendingTriggerScope(s,config,due);
  assert.equal(s.pendingTriggerScope.createdFrom,failedScope.createdTo);
  widenTargetedEmailScopeForRecovery(s,config);
  assert.equal(s.pendingTriggerScope.createdFrom,failedScope.createdTo,'empty recovery must not undo the fence');
});
test('a frozen scope is never clipped into a new replayable scope',()=>{
  const s=createInitialState(), config=loadConfig(vars),at=Date.parse('2026-09-24T09:30:12.964Z');
  s.needsAttentionScope=failedScope;s.needsAttentionScopes=[failedScope];
  registerCreatedNotification(s,config,at,60000);
  s.pendingTriggerScope=createPendingTriggerScope(s,config,s.dueAt);s.dispatchAttempt=1;
  blockPendingIfAttentionOverlaps(s,config,at);
  assert.equal(s.pending,false);
  assert(!s.dispatchHistory.some(e=>e.event==='attention_tail_released'));
});
test('queued tail cannot dispatch while an accepted run remains active',async()=>{
  const f=fixture('in_progress');
  f.seed({...overlappingQueue(),pending:true,pendingReason:'new_message',pendingTriggerId:'email-triage:9001',
    pendingTriggerScope:failedScope,executionPhase:'awaiting_result',dispatchAttempt:1,
    lastAcceptedTrigger:{triggerId:'email-triage:9001',attempt:1,runId:'apirun_synthetic',acceptedAt:'2026-09-24T05:59:00Z'},
    resultDeadlineAt:Date.parse('2026-09-24T06:00:30Z')});
  f.expire();await f.engine.processAlarm();
  assert.equal(f.calls.length,0);
  assert.deepEqual(f.state.pendingTriggerScope,failedScope);
});
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
for(const errorCode of ['unacceptable_risk','apply_rejected','permission_denied','access_denied']) {
  test(`a ${errorCode} denial is never retried despite valid no-write telemetry`,async()=>{
    const f=fixture('completed');
    const report={...metadata,failureStage:'triage_apply',
      ticketOutcomes:[{ticketNumber:'90001',outcome:'failed',stage:'triage_apply',reasonCode:'validation'}],
      failureDiagnostics:[{stage:'triage_apply',errorType:'agent_action',errorCode}],
      mcpExecution:{toolName:'superops_tickets_field_options',subrequestsUsed:2,requestsByType:{metadataValidation:1,dispatcherPoll:1}}};
    const outcome=await f.engine.reportResult({triggerId:f.state.pendingTriggerId,attempt:1,status:'terminal_failure',metadata:report});
    assert.equal(outcome.status,'terminal_failure',JSON.stringify(outcome));
    assert.equal(f.state.needsAttentionScopes.length,1,JSON.stringify(f.state));
    f.advance(); await f.engine.processAlarm();
    assert.equal(f.calls.length,0);
    assert.equal(f.state.needsAttentionScopes.length,1);
  });
}
for(const status of ['completed','in_progress']) {
  test(`persisted denied retry is ${status==='completed'?'fenced':'held until terminal'} without redispatch`,async()=>{
    const f=fixture(status);
    f.seed({executionPhase:'retry_wait',retryCount:1,dueAt:Date.parse('2026-09-24T06:00:00Z'),
      lastResultReport:{triggerId:f.state.pendingTriggerId,attempt:1,status:'terminal_failure',
        metadata:{failureStage:'triage_apply',failureDiagnostics:[{stage:'triage_apply',errorType:'risk_gate',errorCode:'unacceptable_risk'}]}}});
    await f.engine.processAlarm();
    assert.equal(f.calls.length,0);
    assert.equal(f.state.needsAttentionScopes.length,status==='completed'?1:0);
    assert.equal(f.state.pending,status!=='completed');
  });
}
test('a held denied window does not block a disjoint new email',async()=>{
  const f=fixture('completed');
  await f.engine.reportResult({triggerId:f.state.pendingTriggerId,attempt:1,status:'terminal_failure',
    metadata:{failureStage:'triage_apply',failureDiagnostics:[{stage:'triage_apply',errorType:'risk_gate',errorCode:'unacceptable_risk'}]}});
  const next=structuredClone(f.state);
  registerCreatedNotification(next,loadConfig(vars),Date.parse('2026-09-24T06:02:00Z'),60000);
  f.seed(next);f.advance();
  assert.equal((await f.engine.processAlarm()).status,'accepted');
  assert.equal(f.calls.length,1);
  assert(Date.parse(f.calls[0][1].createdFrom)>=Date.parse(f.scope.createdTo));
  assert.equal(f.state.needsAttentionScopes.length,1);
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
