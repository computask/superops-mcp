import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
const source=readFileSync(new URL('./src/index.js',import.meta.url),'utf8');
const stripped=source.replace(/\nexport \{\s*TriageCoordinator,\s*index_default as default\s*\};\s*\/\/# sourceMappingURL=index\.js\.map\s*$/,'\n');
assert.notEqual(source,stripped);
const {CoordinatorEngine,createInitialState,loadConfig,checkRunWriteLease,buildAgentInput}=await import(
  `data:text/javascript;base64,${Buffer.from(stripped+'\nexport {CoordinatorEngine,createInitialState,loadConfig,checkRunWriteLease,buildAgentInput};').toString('base64')}`);
const vars=JSON.parse(readFileSync(new URL('./wrangler.jsonc',import.meta.url),'utf8')).vars;
const protocol='triage-prewrite-reassessment-v1';
const triggerId='triage-88-00000000-0000-4000-8000-000000000088';
const invocation='00000000-0000-4000-8000-000000000089';
function fixture(enabled=true) {
  let now=Date.now(),state;
  const scope={mode:'new-email-tickets',source:'EMAIL',createdFrom:new Date(now-180000).toISOString(),createdTo:new Date(now-120000).toISOString()};
  const config=loadConfig({...vars,TRIAGE_PREWRITE_REASSESSMENT_ENABLED:String(enabled),GRAPH_WEBHOOK_CLIENT_STATE:'synthetic'});
  const capability={protocol:'triage-run-lease-v1',enforced:true,startProtocol:'triage-run-start-v1',startGuardEnforced:true,reassessmentProtocol:protocol};
  const guardCalls=[],agentCalls=[];
  config.runLeaseGuardService={fetch:async request=>{guardCalls.push(request);return Response.json(capability);}};
  state={...createInitialState(),pending:true,pendingReason:'new_message',executionPhase:'awaiting_result',pendingTriggerId:triggerId,
    pendingTriggerScope:scope,dispatchAttempt:1,resultDeadlineAt:now-1,pendingNotificationWindowStartedAt:Date.parse(scope.createdFrom),
    pendingNotificationWindowEndedAt:Date.parse(scope.createdTo),pendingNotificationLookbackMs:0,
    lastAcceptedTrigger:{triggerId,attempt:1,runId:'apirun_synthetic',acceptedAt:new Date(now-120000).toISOString()},
    runWriteLeases:[{triggerId,attempt:1,runId:'apirun_synthetic',scope,issuedAt:now-120000,expiresAt:now+180000,revokedAt:null,
      authorizedItems:[],queryCompleted:true,queryTicketNumbers:['90001'],queryInvocationId:invocation,
      startGuardProtocol:'triage-run-start-v1',mcpWorkStartedAt:now-100000,assessmentTrackingProtocol:protocol,assessmentOnly:true,
      nonReadWorkObserved:true,preparationObservation:{invocationId:invocation,state:'ready',ticketNumbers:['90001']}}]};
  const store={load:async()=>structuredClone(state),save:async value=>{state=structuredClone(value);},setAlarm:async()=>{}};
  const engine=new CoordinatorEngine({config,now:()=>now,store,agent:{getRunDiagnostics:async()=>({status:'failed',httpStatus:200,errorCode:'run_failed',runId:state.lastAcceptedTrigger.runId}),
    trigger:async(...args)=>{agentCalls.push(args);return {kind:'accepted',runId:'apirun_next'+agentCalls.length};}}});
  return {engine,config,scope,capability,guardCalls,agentCalls,get state(){return state;},get now(){return now;},seed:patch=>{state={...state,...patch};},advance:()=>{now=state.dueAt??now+30000;}};
}
test('post-preparation provider failure fences the old attempt and schedules a fresh bounded assessment without writes',async()=>{
  const f=fixture();
  assert.equal((await f.engine.processAlarm()).status,'retry_scheduled');
  const first=f.state.runWriteLeases[0],deadline=first.prewriteReassessmentDeadlineAt;
  assert.equal(first.revokedAt,f.now);assert.equal(first.prewriteReassessmentCount,1);
  assert.equal(deadline,first.issuedAt+600000);assert.deepEqual(f.state.pendingTriggerScope,f.scope);
  assert.equal(f.agentCalls.length,0);assert.equal(f.state.runWriteLeases[0].authorizedItems.length,0);
  const late=checkRunWriteLease(f.state,f.config,{triggerId,attempt:1},f.now);
  assert.equal(late.allowed,false);
  f.advance();assert.equal((await f.engine.processAlarm()).status,'accepted');
  assert.equal(f.agentCalls.length,1);assert.deepEqual(f.agentCalls[0].slice(0,3),[triggerId,f.scope,2]);
  assert.deepEqual(f.agentCalls[0][4],{generation:1});
  const next=f.state.runWriteLeases.at(-1);
  assert.equal(next.prewriteReassessmentDeadlineAt,deadline);assert.deepEqual(next.queryTicketNumbers,['90001']);
  assert.equal(next.preparationObservation,undefined,'old preparation is never re-used as a new approval');
  assert(f.state.dispatchHistory.some(e=>e.event==='prewrite_reassessment_scheduled'));
  assert(f.guardCalls.every(r=>r.method==='GET'));
});
test('two assessments share an immutable deadline and exhaustion quarantines without another Agent',async()=>{
  const f=fixture();let deadline;
  for(let count=1;count<=2;count++) {
    assert.equal((await f.engine.processAlarm()).status,'retry_scheduled');
    deadline??=f.state.runWriteLeases.at(-1).prewriteReassessmentDeadlineAt;
    assert.equal(f.state.runWriteLeases.at(-1).prewriteReassessmentDeadlineAt,deadline);
    f.advance();assert.equal((await f.engine.processAlarm()).status,'accepted');
    const leases=f.state.runWriteLeases;
    Object.assign(leases.at(-1),{startGuardProtocol:'triage-run-start-v1',mcpWorkStartedAt:f.now,
      preparationObservation:{invocationId:invocation,state:'ready',ticketNumbers:['90001']}});
    f.seed({runWriteLeases:leases,resultDeadlineAt:f.now-1});
  }
  await f.engine.processAlarm();assert.equal(f.agentCalls.length,2);
  assert(f.state.needsAttentionScopes.length>0);
});
test('the immutable reassessment deadline also caps the next attempt write and work lease',async()=>{
  const f=fixture(),leases=f.state.runWriteLeases,deadline=f.now+31000;
  leases[0].prewriteReassessmentDeadlineAt=deadline;f.seed({runWriteLeases:leases});
  assert.equal((await f.engine.processAlarm()).status,'retry_scheduled');
  f.advance();assert.equal((await f.engine.processAlarm()).status,'accepted');
  assert.equal(f.state.runWriteLeases.at(-1).expiresAt,deadline);
  assert.equal(checkRunWriteLease(f.state,f.config,{triggerId,attempt:2},deadline).allowed,false);
});
for(const blocker of ['disabled','legacy','unknown_work','intent','unsettled_intent','write_check','operation','other_attempt_write',
  'pending_read','unsafe_callback','explicit_denial','preparation_pending','preparation_failed','wrong_candidate','wrong_run',
  'wrong_scope','missing_query_proof','retry_cap','deadline','capability','active_provider']) {
  test('fresh assessment refuses '+blocker,async()=>{
    const f=fixture(blocker!=='disabled'),leases=f.state.runWriteLeases,l=leases[0];
    if(blocker==='legacy')delete l.assessmentTrackingProtocol;
    if(blocker==='unknown_work')l.assessmentOnly=false;
    if(blocker==='intent')l.applyIntentObserved=true;
    if(blocker==='unsettled_intent')l.intentUnsettled=true;
    if(blocker==='write_check')l.writeCheckObserved=true;
    if(blocker==='operation')l.operationReferences=[{operationId:triggerId,ownerHash:'12345678'}];
    if(blocker==='other_attempt_write')leases.push({...l,attempt:0,writeCheckObserved:true});
    if(blocker==='pending_read')l.pendingRead={requestId:'synthetic'};
    if(blocker==='unsafe_callback')l.rejectedCallbackUnsafe=true;
    if(blocker==='preparation_pending')l.preparationObservation.state='in_progress';
    if(blocker==='preparation_failed')l.preparationObservation.state='validation_failed';
    if(blocker==='wrong_candidate')l.preparationObservation.ticketNumbers=['90002'];
    if(blocker==='wrong_scope')l.scope={...l.scope,createdTo:new Date(f.now+60000).toISOString()};
    if(blocker==='missing_query_proof')delete l.queryInvocationId;
    if(blocker==='deadline')l.prewriteReassessmentDeadlineAt=f.now+1000;
    if(blocker==='capability')delete f.capability.reassessmentProtocol;
    f.seed({runWriteLeases:leases,...(blocker==='retry_cap'?{retryCount:f.config.resultMaxRetries}:{}),
      ...(blocker==='explicit_denial'?{dispatchHistory:[{eventId:1,event:'result_callback_rejected',batchSequence:88,at:new Date(f.now).toISOString(),failureDiagnostics:[{stage:'triage_apply',errorCode:'unacceptable_risk'}]}]}:{})});
    if(blocker==='wrong_run')f.engine.deps.agent.getRunDiagnostics=async()=>({status:'failed',httpStatus:200,errorCode:'run_failed',runId:'apirun_other'});
    if(blocker==='active_provider')f.engine.deps.agent.getRunDiagnostics=async()=>({status:'in_progress',httpStatus:200,runId:l.runId});
    await f.engine.processAlarm();assert.equal(f.agentCalls.length,0);
    assert(!f.state.dispatchHistory.some(e=>e.event==='prewrite_reassessment_scheduled'));
  });
}
test('a write racing capability verification invalidates proof rather than being overwritten',async()=>{
  const f=fixture();f.config.runLeaseGuardService.fetch=async()=>{
    const leases=f.state.runWriteLeases;leases[0].writeCheckObserved=true;f.seed({runWriteLeases:leases});
    return Response.json(f.capability);
  };
  await f.engine.processAlarm();assert.equal(f.agentCalls.length,0);
  assert(!f.state.dispatchHistory.some(e=>e.event==='prewrite_reassessment_scheduled'));
  assert.equal(f.state.runWriteLeases[0].writeCheckObserved,true);
});
test('reassessment instructions require current evidence, staff protection and normal action review',()=>{
  const f=fixture(),text=buildAgentInput(triggerId,f.scope,2,true,true,{generation:1});
  assert.match(text,/FRESH PRE-WRITE REASSESSMENT 1/);assert.match(text,/fresh evidence checkpoint/);
  assert.match(text,/If staff changed/);assert.match(text,/normal action review/);assert.match(text,/Never replay a prior mutation/);
});
