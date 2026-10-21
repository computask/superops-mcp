import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
const source=readFileSync(new URL('./src/index.js',import.meta.url),'utf8');
const stripped=source.replace(/\nexport \{\s*TriageCoordinator,\s*index_default as default\s*\};\s*\/\/# sourceMappingURL=index\.js\.map\s*$/,'\n');
assert.notEqual(source,stripped);
const {CoordinatorEngine,createInitialState,loadConfig,checkRunWriteLease,ensureAcceptedWriteLease,subsetOperationId}=await import(
  `data:text/javascript;base64,${Buffer.from(stripped+'\nexport {CoordinatorEngine,createInitialState,loadConfig,checkRunWriteLease,ensureAcceptedWriteLease,subsetOperationId};').toString('base64')}`);
const vars=JSON.parse(readFileSync(new URL('./wrangler.jsonc',import.meta.url),'utf8')).vars;
const triggerId='triage-88-00000000-0000-4000-8000-000000000088',ownerHash='12345678';
function fixture() {
  let now=Date.now(),state;
  const config=loadConfig({...vars,GRAPH_WEBHOOK_CLIENT_STATE:'synthetic-state'});
  const scope={mode:'new-email-tickets',source:'EMAIL',createdFrom:new Date(now-60000).toISOString(),createdTo:new Date(now).toISOString()};
  const ref=numbers=>({operationId:subsetOperationId(triggerId,numbers),ownerHash,ticketNumbers:numbers});
  const first=ref(['90001']);
  state={...createInitialState(),pending:true,pendingReason:'new_message',executionPhase:'awaiting_result',
    pendingTriggerId:triggerId,pendingTriggerScope:scope,dispatchAttempt:1,resultDeadlineAt:now-1,
    pendingNotificationWindowStartedAt:now-60000,pendingNotificationWindowEndedAt:now,pendingNotificationLookbackMs:60000,
    lastAcceptedTrigger:{triggerId,attempt:1,runId:'apirun_synthetic',acceptedAt:new Date(now-30000).toISOString()},
    runWriteLeases:[{triggerId,attempt:1,scope,issuedAt:now-30000,expiresAt:now+570000,revokedAt:null,
      authorizedItems:['90001'],queryCompleted:true,queryTicketNumbers:['90001','90002'],
      startGuardProtocol:'triage-run-start-v1',mcpWorkStartedAt:now-20000,subsetProtocol:'triage-subset-operations-v1',
      operationReference:first,operationReferences:[first],intentUnsettled:false}]};
  const records=new Map([[first.operationId,{operationId:first.operationId,ownerHash,toolName:'superops_tickets_apply_triage_plan',
    state:'Completed',expectedItems:['90001'],itemStates:{'90001':{stage:'Completed',verificationState:'Verified'}}}]]);
  const ledgerCalls=[],agentCalls=[];
  config.operationLedger={idFromName:name=>{assert.equal(name,'owner:'+ownerHash);return name;},get:()=>({fetch:async request=>{
    ledgerCalls.push(request);assert.equal(request.method,'GET');const id=new URL(request.url).pathname.split('/').at(-1);
    return records.has(id)?Response.json(records.get(id)):Response.json({error:'not_found'},{status:404});
  }})};
  const engine=new CoordinatorEngine({config,now:()=>now,store:{load:async()=>structuredClone(state),save:async value=>{state=structuredClone(value);},setAlarm:async()=>{}},
    agent:{getRunDiagnostics:async()=>({status:'completed',httpStatus:200}),trigger:async(...args)=>{agentCalls.push(args);return {kind:'accepted',runId:'apirun_next'};}}});
  return {engine,config,scope,ref,records,ledgerCalls,agentCalls,get state(){return state;},get now(){return now;},
    seed:patch=>{state={...state,...patch};},advance:()=>{now=state.dueAt??now+40000;}};
}
test('subset identities are deterministic and order independent, with the parent trigger retained',()=>{
  assert.equal(subsetOperationId(triggerId,['90002','90001']),subsetOperationId(triggerId,['90001','90002']));
  assert.notEqual(subsetOperationId(triggerId,['90001']),subsetOperationId(triggerId,['90002']));
  assert(subsetOperationId(triggerId,['90001']).endsWith(':'+triggerId));
});
test('the private write guard permits disjoint approved subsets and refuses overlap, scope changes, wrong owners and hash collisions',()=>{
  const f=fixture(),state=f.state;
  const check=(numbers,patch={})=>checkRunWriteLease(state,f.config,{triggerId,attempt:1,expectedTicketNumbers:numbers,
    operationReference:f.ref(numbers),...patch},f.now);
  assert.equal(check(['90002']).allowed,true);
  assert.equal(check(['90002']).allowed,true);
  assert.equal(check(['90001','90002']).allowed,false);
  assert.equal(check(['99000']).allowed,false);
  assert.equal(check(['90002'],{operationReference:{...f.ref(['90002']),ownerHash:'87654321'}}).allowed,false);
  assert.equal(check(['90001'],{operationReference:f.ref(['90002'])}).allowed,false);
  assert.equal(checkRunWriteLease(state,f.config,{triggerId,attempt:1,itemKey:'90001',operationReference:f.ref(['90002'])},f.now).allowed,false);
  assert.equal(state.runWriteLeases[0].operationReferences.length,2);
});
test('new attempts retain frozen query candidates and linked operation identities',()=>{
  const f=fixture(),state=f.state;
  state.dispatchAttempt=2;state.lastAcceptedTrigger={...state.lastAcceptedTrigger,attempt:2,acceptedAt:new Date(f.now).toISOString()};
  ensureAcceptedWriteLease(state,f.config);
  assert.deepEqual(state.runWriteLeases[1].queryTicketNumbers,['90001','90002']);
  assert.deepEqual(state.runWriteLeases[1].operationReferences,state.runWriteLeases[0].operationReferences);
  assert.equal(state.runWriteLeases[1].revokedAt,null);
});

function emptyIngestionRetry() {
  const f=fixture(),state=f.state;
  const originalScope={...f.scope,createdFrom:new Date(f.now-180000).toISOString(),createdTo:new Date(f.now-120000).toISOString()};
  state.pendingTriggerScope={...originalScope,createdFrom:new Date(f.now-240000).toISOString(),createdTo:new Date(f.now-60000).toISOString()};
  state.emptyTargetedRecoveryPending=true;state.dispatchAttempt=2;
  state.lastAcceptedTrigger={...state.lastAcceptedTrigger,attempt:2,acceptedAt:new Date(f.now).toISOString()};
  state.runWriteLeases=[{triggerId,attempt:1,scope:originalScope,issuedAt:f.now-120000,expiresAt:f.now+180000,revokedAt:null,
    authorizedItems:[],queryCompleted:true,queryTicketNumbers:[],queryInvocationId:'00000000-0000-4000-8000-000000000088',
    startupRetryCount:1,startupDeadlineAt:f.now+300000,readRenewals:1,readFailureDeadlineAt:f.now+600000}];
  return {...f,state};
}

test('an authorised wider ingestion retry gets a fresh query while preserving its original empty snapshot and recovery limits',()=>{
  const f=emptyIngestionRetry(),original=structuredClone(f.state.runWriteLeases[0]);
  ensureAcceptedWriteLease(f.state,f.config);
  const next=f.state.runWriteLeases.at(-1);
  assert.equal(next.queryCompleted,undefined);assert.equal(next.queryTicketNumbers,undefined);assert.equal(next.queryInvocationId,undefined);
  assert.deepEqual(f.state.runWriteLeases[0],original);
  assert.notEqual(next.scope,f.state.pendingTriggerScope,'later pending-scope changes cannot alter the recorded lease scope');
  for(const field of ['startupRetryCount','startupDeadlineAt','readRenewals','readFailureDeadlineAt']) assert.equal(next[field],original[field]);
  assert.equal(checkRunWriteLease(f.state,f.config,{triggerId,attempt:2,operationReference:f.ref(['90001']),expectedTicketNumbers:['90001']},f.now).allowed,false,
    'new candidates cannot be written before the wider query completes');
});

for(const [name,block] of Object.entries({
  same_scope:f=>{f.state.pendingTriggerScope={...f.state.runWriteLeases[0].scope};},
  unauthorised_retry:f=>{f.state.emptyTargetedRecoveryPending=false;},
  disabled_fast_mode:f=>{f.config.fastTargetedModeEnabled=false;},
  nonempty_snapshot:f=>{f.state.runWriteLeases[0].queryTicketNumbers=['90002'];},
  incomplete_query:f=>{f.state.runWriteLeases[0].queryCompleted=false;},
  missing_observation:f=>{delete f.state.runWriteLeases[0].queryInvocationId;},
  narrowed_scope:f=>{f.state.pendingTriggerScope.createdFrom=new Date(f.now-150000).toISOString();},
  changed_source:f=>{f.state.pendingTriggerScope.source='PHONE';},
  named_ticket_replay:f=>{f.state.pendingTriggerScope.targetTicketNumbers=['90001'];},
  pending_read:f=>{f.state.runWriteLeases[0].pendingRead={requestId:'synthetic-original-receipt'};},
  operation:f=>{f.state.runWriteLeases[0].operationReference=f.ref(['90001']);},
  child_operations:f=>{f.state.runWriteLeases[0].operationReferences=[f.ref(['90001'])];},
  unsettled_intent:f=>{f.state.runWriteLeases[0].intentUnsettled=true;},
  apply_intent:f=>{f.state.runWriteLeases[0].applyIntentObserved=true;},
  write_check:f=>{f.state.runWriteLeases[0].writeCheckObserved=true;},
  preparation:f=>{f.state.runWriteLeases[0].preparationObservation={state:'ready'};},
  unknown_work:f=>{f.state.runWriteLeases[0].nonReadWorkObserved=true;},
  unsafe_callback:f=>{f.state.runWriteLeases[0].rejectedCallbackUnsafe=true;},
  authorised_item:f=>{f.state.runWriteLeases[0].authorizedItems=['90001'];},
  earlier_write:f=>{f.state.runWriteLeases.unshift({...f.state.runWriteLeases[0],attempt:0,writeCheckObserved:true});}
})) {
  test('empty-query handoff retains the existing candidate fence for '+name,()=>{
    const f=emptyIngestionRetry();block(f);
    const previous=f.state.runWriteLeases.at(-1),snapshot=structuredClone(previous);
    ensureAcceptedWriteLease(f.state,f.config);
    const next=f.state.runWriteLeases.at(-1);
    for(const field of ['queryCompleted','queryTicketNumbers','queryInvocationId','pendingRead','operationReference','operationReferences','intentUnsettled'])
      assert.deepEqual(next[field],snapshot[field]);
    assert.deepEqual(previous,snapshot);
  });
}
test('a lost callback reconciles verified subset progress and retries only the unfinished original batch',async()=>{
  const f=fixture();
  assert.equal((await f.engine.processAlarm()).status,'retry_scheduled');
  assert.equal(f.state.lastResultReport.metadata.ticketsCompleted,1);
  assert.equal(f.state.lastResultReport.metadata.ticketsDeferred,1);
  assert.equal(f.state.lastResultReport.status,'retryable_read_pending');
  assert.equal(f.state.runWriteLeases[0].revokedAt!==null,true);
  assert.equal(f.agentCalls.length,0);
  f.advance();assert.equal((await f.engine.processAlarm()).status,'accepted');
  assert.equal(f.agentCalls.length,1);assert.deepEqual(f.agentCalls[0][1],f.scope);
  assert.deepEqual(f.state.runWriteLeases.at(-1).queryTicketNumbers,['90001','90002']);
  const second=f.ref(['90002']);
  const lease=f.state.runWriteLeases.at(-1);
  lease.operationReferences.push(second);
  f.records.set(second.operationId,{operationId:second.operationId,ownerHash,toolName:'superops_tickets_apply_triage_plan',state:'Completed',
    expectedItems:['90002'],itemStates:{'90002':{stage:'CompletedAfterRetry',verificationState:'Verified'}}});
  f.seed({runWriteLeases:f.state.runWriteLeases,resultDeadlineAt:f.now-1});
  assert.equal((await f.engine.processAlarm()).status,'complete');
  assert.equal(f.state.lastResultReport.metadata.ticketsCompleted,2);
  assert.equal(f.state.lastResultReport.metadata.ticketsDeferred,0);
  assert.equal(f.agentCalls.length,1);
  assert(f.ledgerCalls.every(request=>request.method==='GET'));
});
for(const unsafe of ['missing_record','ambiguous_write','unsettled_intent','unsafe_callback','failed_operation','unknown_candidate']) {
  test('lost-callback subset reconciliation fails closed for '+unsafe,async()=>{
    const f=fixture(),lease=f.state.runWriteLeases[0],record=[...f.records.values()][0];
    if(unsafe==='missing_record') f.records.clear();
    if(unsafe==='ambiguous_write') record.itemStates['90001'].ambiguousWrite=true;
    if(unsafe==='unsettled_intent') lease.intentUnsettled=true;
    if(unsafe==='unsafe_callback') lease.rejectedCallbackUnsafe=true;
    if(unsafe==='failed_operation') record.state='CompletedWithFailures';
    if(unsafe==='unknown_candidate') lease.queryTicketNumbers=['90002'];
    await f.engine.processAlarm();
    assert.equal(f.agentCalls.length,0);
    assert(!f.state.dispatchHistory.some(event=>event.event==='batch_completed'));
    assert(!f.state.dispatchHistory.some(event=>event.event==='retry_scheduled'));
  });
}
test('a callback is reconciled against every completed child rather than treated as an uncorrelated continuation',async()=>{
  const f=fixture(),second=f.ref(['90002']),lease=f.state.runWriteLeases[0];lease.operationReferences.push(second);
  f.records.set(second.operationId,{operationId:second.operationId,ownerHash,toolName:'superops_tickets_apply_triage_plan',state:'Completed',
    expectedItems:['90002'],itemStates:{'90002':{stage:'Completed',verificationState:'Verified'}}});
  const result=await f.engine.reportResult({triggerId,attempt:1,status:'terminal_failure',metadata:{failureStage:'triage_apply'}});
  assert.equal(result.status,'complete');assert.equal(f.state.lastResultReport.metadata.ticketsCompleted,2);
  assert.equal(f.state.pending,false);assert.equal(f.agentCalls.length,0);
});
test('an explicit platform denial remains terminal even when a previous subset completed',async()=>{
  const f=fixture();
  const result=await f.engine.reportResult({triggerId,attempt:1,status:'terminal_failure',metadata:{failureStage:'triage_apply',
    failureDiagnostics:[{stage:'triage_apply',errorType:'risk_gate',errorCode:'unacceptable_risk'}]}});
  assert.equal(result.status,'terminal_failure');assert.equal(f.agentCalls.length,0);
  assert(!f.state.dispatchHistory.some(event=>event.event==='batch_completed'));
});
