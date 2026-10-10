import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test'; // Independent Node harness, not a Vitest suite.

// Exercise the actual preserved production module, exposing internals only in
// this in-memory test module. No test route or export is shipped to production.
const source = readFileSync(new URL('./src/index.js', import.meta.url), 'utf8');
const testableSource = source.replace(/\nexport \{\s*TriageCoordinator,\s*index_default as default\s*\};\s*\/\/# sourceMappingURL=index\.js\.map\s*$/, '\n');
assert.notEqual(testableSource, source, 'The preserved production module export footer must be isolated for the in-memory test harness');
const {CoordinatorEngine, TriageCoordinator, createInitialState, loadConfig, registerCreatedNotification, createPendingTriggerScope, parseSafeMcpExecution, toolDefinition, applyIntentToolDefinition, parseTriageApplyIntentReport, handleTriageResultMcp, WorkspaceAgentTriggerClient, DurableObjectStore, storeTriageAgentCapture, listTriageAgentCaptures, listTriageAgentCaptureFailures, lookupTriageAgentCaptureTriggerId, pruneTriageAgentCaptures, buildAgentInput, refreshQueuedAttentionBlock, blockPendingIfAttentionOverlaps, widenTargetedEmailScopeForRecovery, scopeOverlapsAttention, normalizeState, coordinatorProgressFields, migrateLegacyAttentionBlockedQueue, currentBatchIsFrozen, listRelevantDispatchHistory, checkRunWriteLease, ensureAcceptedWriteLease} = await import(
  `data:text/javascript;base64,${Buffer.from(testableSource + '\nexport {CoordinatorEngine, TriageCoordinator, createInitialState, loadConfig, registerCreatedNotification, createPendingTriggerScope, parseSafeMcpExecution, toolDefinition, applyIntentToolDefinition, parseTriageApplyIntentReport, handleTriageResultMcp, WorkspaceAgentTriggerClient, DurableObjectStore, storeTriageAgentCapture, listTriageAgentCaptures, listTriageAgentCaptureFailures, lookupTriageAgentCaptureTriggerId, pruneTriageAgentCaptures, buildAgentInput, refreshQueuedAttentionBlock, blockPendingIfAttentionOverlaps, widenTargetedEmailScopeForRecovery, scopeOverlapsAttention, normalizeState, coordinatorProgressFields, migrateLegacyAttentionBlockedQueue, currentBatchIsFrozen, listRelevantDispatchHistory, checkRunWriteLease, ensureAcceptedWriteLease};').toString('base64')}`
);
const vars = JSON.parse(readFileSync(new URL('./wrangler.jsonc', import.meta.url), 'utf8')).vars;

test('channel cutover preserves the accepted run endpoint through durable state and polling',async()=>{
  const original='https://api.chatgpt.com/v1/workspace_agents/agtch_synthetic_original/trigger';
  const replacement='https://api.chatgpt.com/v1/workspace_agents/agtch_synthetic_replacement/trigger';
  const requested=[];
  const fetcher=async(url,init)=>{
    requested.push({url:String(url),method:init.method});
    return new Response(JSON.stringify(init.method==='POST'?{agent_trigger_run_id:'apirun_synthetic_cutover'}:{status:'completed'}),{status:init.method==='POST'?202:200});
  };
  const config={...loadConfig(vars),workspaceAgentTriggerUrl:original,workspaceAgentAccessToken:'synthetic-token'};
  const oldClient=new WorkspaceAgentTriggerClient(config,fetcher);
  const f=fixture('completed');
  const attempt=await oldClient.trigger('synthetic-cutover',f.scope,1,true);
  await f.engine.recordAttempt(f.state,attempt,'synthetic-cutover',f.scope,1,Date.parse('2026-10-05T10:00:00Z'));
  const restored=normalizeState(JSON.parse(JSON.stringify(f.state)));
  assert.equal(restored.lastAcceptedTrigger.triggerUrl,original);
  let pollArguments;
  f.engine.deps.agent.getRunDiagnostics=async(...args)=>{pollArguments=args;return {status:'in_progress',httpStatus:200};};
  f.setNow('2026-10-05T10:00:31Z');
  await f.engine.processAlarm();
  assert.deepEqual(pollArguments,[restored.lastAcceptedTrigger.runId,original]);
  const newClient=new WorkspaceAgentTriggerClient({...config,workspaceAgentTriggerUrl:replacement,workspaceAgentLegacyTriggerUrl:original},fetcher);
  assert.equal((await newClient.getRunDiagnostics(restored.lastAcceptedTrigger.runId,restored.lastAcceptedTrigger.triggerUrl)).status,'completed');
  assert.equal(requested.at(-1).url,original.replace('/trigger','/runs/apirun_synthetic_cutover'));
  const next=await newClient.trigger('synthetic-fresh',f.scope,1,true);
  assert.equal(next.triggerUrl,replacement);
  await newClient.getRunDiagnostics(next.runId,next.triggerUrl);
  assert.equal(requested.at(-1).url,replacement.replace('/trigger','/runs/apirun_synthetic_cutover'));
  await newClient.getRunDiagnostics('apirun_synthetic_legacy');
  assert.equal(requested.at(-1).url,original.replace('/trigger','/runs/apirun_synthetic_legacy'));
  assert.equal(requested.filter(r=>r.method==='POST').length,2);
});

test('stored run endpoint cannot forward the Agent credential to another origin',async()=>{
  let calls=0;
  const client=new WorkspaceAgentTriggerClient({workspaceAgentTriggerUrl:'https://api.chatgpt.com/v1/workspace_agents/agtch_synthetic/trigger',workspaceAgentAccessToken:'synthetic-token'},async()=>{calls++;return new Response('{}');});
  for(const endpoint of ['https://example.invalid/v1/workspace_agents/agtch_synthetic/trigger','https://api.chatgpt.com/v1/workspace_agents/agtch_synthetic/trigger?redirect=1','https://user@api.chatgpt.com/v1/workspace_agents/agtch_synthetic/trigger','https://api.chatgpt.com/wrong/trigger']) {
    assert.equal((await client.getRunDiagnostics('apirun_synthetic',endpoint)).status,'unavailable');
  }
  assert.equal(calls,0);
});

test('dispatch input requires an actual no-apply cause and preserves receipt diagnostics',()=>{
  assert(source.includes('apply_not_attempted describes an outcome, not a cause'));
  assert(source.includes('reason_unavailable if the cause genuinely cannot be established'));
  assert(source.includes('never invent HTTP 400/429/502'));
  assert(source.includes('Keep any observed denial terminal; do not retry or bypass it'));
});

test('Agent prompt requires exact MCP correlation and a report-only pre-apply capture',()=>{
  const triggerId='triage-81-60d4e73d-5c40-4a75-89b5-31ac48f25632';
  const prompt=buildAgentInput(triggerId,{mode:'new-email-tickets',source:'EMAIL',createdFrom:'2026-09-26T10:00:00.000Z',createdTo:'2026-09-26T10:01:00.000Z'},3,true);
  assert(prompt.includes('On every superops_* MCP call, include triageCapture'));
  assert(prompt.includes('triage_apply_intent_report'));
  assert(prompt.includes('exact copy of the complete argument object'));
  assert(prompt.includes('not approval and does not change or bypass'));
  assert(prompt.includes('diagnostic capture receipt, NOT an apply result'));
  assert(prompt.includes('no actual apply has been attempted and no denial has occurred'));
  assert(prompt.includes('capture receipt says nothing about earlier apply attempts'));
  assert(prompt.includes('Any observed denial remains terminal'));
  assert(prompt.includes(`Trigger ID: ${triggerId}`));
});

test('targeted prompt reuses explicit null metadata without weakening the stale fence',()=>{
  const prompt=buildAgentInput('triage-81-60d4e73d-5c40-4a75-89b5-31ac48f25632',
    {mode:'new-email-tickets',source:'EMAIL',createdFrom:'2026-09-26T10:00:00.000Z',createdTo:'2026-09-26T10:01:00.000Z'},1,true);
  assert(prompt.includes('Do not call get_safe just to confirm that same null field'));
  assert(prompt.includes('never infer null from absence'));
  assert(prompt.includes("MCP's mandatory live pre-write stale check"));
  assert(prompt.includes('a test label never justifies General Admin'));
  assert(prompt.includes('use the one bounded field-options lookup'));
});

test('preparation contract remains mandatory without diagnostic capture or callbacks',()=>{
  for (const scope of [{mode:'full-new-calls',reason:'regression'},
    {mode:'new-email-tickets',source:'EMAIL',createdFrom:'2026-10-04T10:00:00.000Z',createdTo:'2026-10-04T10:01:00.000Z'}]) {
    for (const callback of [false,true]) {
      const prompt=buildAgentInput('triage-preparation-regression',scope,1,callback,false);
      assert(prompt.includes('Policy contract version: 2026-10-04.1'));
      assert(prompt.includes('superops_tickets_prepare_triage_plan'));
      assert(prompt.includes('operationCreated:false'));
      assert(prompt.includes('After ANY actual apply response'));
      assert(!prompt.includes('Private diagnostic capture is enabled'));
    }
  }
});

test('apply intent parser preserves exact plan JSON and rejects credential-like fields',()=>{
  const triggerId='triage-81-60d4e73d-5c40-4a75-89b5-31ac48f25632';
  const applyArguments={policyMode:'email-new-calls-v2',expectedCandidateTicketNumbers:['62992'],actions:[{ticketNumber:'62992',action:'leave',note:'<strong>TRIAGE SUMMARY</strong><br><br>Customer-provided detail',target:{impact:'High',category:'Security'},allowWriteIfUpdatedTimeChanged:false}],verify:true,dedupeNotes:true,triageCapture:{triggerId,attempt:3}};
  const report={triggerId,attempt:3,applyArguments};
  assert.deepEqual(parseTriageApplyIntentReport(report),report);
  assert.equal(parseTriageApplyIntentReport({...report,applyArguments:{apiKey:'must-not-persist'}}),null);
  assert.equal(parseTriageApplyIntentReport({...report,applyArguments:{apiToken:'must-not-persist'}}),null);
  assert.equal(parseTriageApplyIntentReport({...report,applyArguments:{secret:'must-not-persist'}}),null);
  assert.equal(applyIntentToolDefinition().name,'triage_apply_intent_report');
});

test('apply-intent MCP tool lists, forwards exact plan, and does not return the plan payload',async()=>{
  const triggerId='triage-81-60d4e73d-5c40-4a75-89b5-31ac48f25632';
  const applyArguments={expectedCandidateTicketNumbers:['62992'],actions:[{ticketNumber:'62992',action:'leave',note:'private-note'}]};
  let forwarded;
  const sink={report:async()=>({status:'recorded'}),reportApplyIntent:async(value)=>{forwarded=value;return {status:'recorded',triggerId:value.triggerId,attempt:value.attempt};}};
  const listed=await handleTriageResultMcp(new Request('https://local/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})}),sink);
  const listBody=await listed.json();
  assert.deepEqual(listBody.result.tools.map(tool=>tool.name),['triage_result_report','triage_apply_intent_report']);
  const response=await handleTriageResultMcp(new Request('https://local/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'triage_apply_intent_report',arguments:{triggerId,attempt:1,applyArguments}}})}),sink);
  const body=await response.json();
  assert.deepEqual(forwarded,{triggerId,attempt:1,applyArguments});
  const receipt=body.result.structuredContent;
  assert.deepEqual({status:receipt.status,triggerId:receipt.triggerId,attempt:receipt.attempt},{status:'recorded',triggerId,attempt:1});
  assert.equal(receipt.receiptType,'diagnostic_capture_only');
  assert.equal(receipt.intentRecorded,true);
  assert.deepEqual(receipt.thisReporterCall,{invokedApply:false,superopsRequests:0});
  assert.equal(receipt.approvalGranted,false);
  assert.equal(receipt.earlierApplyState,'not_observed_by_reporter');
  assert(receipt.guidance.includes('No operation ID is expected'));
  assert(receipt.guidance.includes('no actual apply was attempted and no denial occurred'));
  assert(receipt.guidance.includes('Preserve no-blind-replay'));
  assert.equal(body.result.isError,false);
  assert.deepEqual(JSON.parse(body.result.content[0].text),receipt);
  assert(!JSON.stringify(body).includes('private-note'));
});

test('intent timing brackets storage, records failures and never logs plan contents',async(t)=>{
  const lines=[];
  t.mock.method(console,'log',value=>lines.push(JSON.parse(value)));
  const triggerId='triage-81-60d4e73d-5c40-4a75-89b5-31ac48f25632';
  const request=()=>new Request('https://local/mcp',{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'triage_apply_intent_report',arguments:{triggerId,attempt:1,applyArguments:{expectedCandidateTicketNumbers:['62992'],actions:[{note:'private-note'}]}}}})});
  for(const status of ['recorded','duplicate','conflict','capture_too_large','capture_capacity_reached','stale_or_unauthorized','unknown-private-status']) {
    lines.length=0;
    const response=await handleTriageResultMcp(request(),{reportApplyIntent:async()=>{
      assert.deepEqual(lines.map(e=>e.stage),['received']);
      return {status,triggerId,attempt:1};
    }});
    assert.deepEqual(lines.map(e=>e.stage),['received','response_ready']);
    assert.equal(lines[0].callId,lines[1].callId);
    assert.equal(lines[1].outcome,status==='unknown-private-status'?'error':status);
    assert(Date.parse(lines[1].timestamp)>=Date.parse(lines[0].timestamp));
    assert(!JSON.stringify(lines).includes('private-note'));
    const result=(await response.json()).result;
    const accepted=['recorded','duplicate'].includes(status);
    assert.equal(result.isError,!accepted);
    assert.equal(result.structuredContent.intentRecorded,accepted);
    assert.equal(result.structuredContent.approvalGranted,false);
    assert.equal(result.structuredContent.earlierApplyState,'not_observed_by_reporter');
    assert.deepEqual(result.structuredContent.thisReporterCall,{invokedApply:false,superopsRequests:0});
    if(!accepted) assert(result.structuredContent.guidance.includes('Do not call apply'));
    assert(!JSON.stringify(lines).includes('unknown-private-status'));
  }
  lines.length=0;
  await assert.rejects(()=>handleTriageResultMcp(request(),{reportApplyIntent:async()=>{throw Error('private failure');}}));
  assert.deepEqual(lines.map(e=>e.stage),['received','response_ready']);
  assert.equal(lines[1].outcome,'exception');
  assert(!JSON.stringify(lines).includes('private failure'));
});

test('trigger client captures the exact outgoing JSON body before sending without authorization',async()=>{
  const triggerId='triage-81-60d4e73d-5c40-4a75-89b5-31ac48f25632';
  const captures=[];
  let sentBody;
  const client=new WorkspaceAgentTriggerClient({workspaceAgentTriggerUrl:'https://agent.example/trigger',workspaceAgentAccessToken:'synthetic-token',triageCaptureReadToken:'synthetic-capture-read-token'},async(_url,init)=>{
    assert.equal(captures.length,1,'private capture is persisted before network dispatch');
    sentBody=init.body;
    assert.equal(init.headers.Authorization,'Bearer synthetic-token');
    return new Response(JSON.stringify({agent_trigger_run_id:'apirun_regression'}),{status:202});
  },{info(){},warn(){}},async(record)=>{captures.push(record);return {status:'recorded'};});
  const result=await client.trigger(triggerId,{mode:'new-email-tickets',source:'EMAIL',createdFrom:'2026-09-26T10:00:00.000Z',createdTo:'2026-09-26T10:01:00.000Z'},4,true);
  assert.equal(result.kind,'accepted');
  assert.equal(captures[0].kind,'agent_input');
  assert.equal(captures[0].payload.requestBody,sentBody);
  assert(JSON.parse(sentBody).input.includes('Trigger ID: '+triggerId));
  assert(!JSON.stringify(captures[0]).includes('synthetic-token'));
});

test('trigger capture stays disabled until its dedicated retrieval secret is configured',async()=>{
  let captureCalls=0;
  const client=new WorkspaceAgentTriggerClient({workspaceAgentTriggerUrl:'https://agent.example/trigger',workspaceAgentAccessToken:'synthetic-token'},async(_url,init)=>{
    assert(!JSON.parse(init.body).input.includes('Private diagnostic capture is enabled'));
    return new Response(JSON.stringify({agent_trigger_run_id:'apirun_capture_disabled'}),{status:202});
  },{info(){},warn(){}},async()=>{captureCalls+=1;return {status:'recorded'};});
  const result=await client.trigger('triage-82-60d4e73d-5c40-4a75-89b5-31ac48f25632',{mode:'new-email-tickets',source:'EMAIL',createdFrom:'2026-09-26T10:00:00.000Z',createdTo:'2026-09-26T10:01:00.000Z'});
  assert.equal(result.kind,'accepted');
  assert.equal(captureCalls,0);
});

function privateCaptureSqlStorage(seed){
  const rows=new Map();
  const failures=new Map();
  const state={value:structuredClone(seed),alarm:null};
  const key=(triggerId,attempt,kind)=>`${triggerId}\0${attempt}\0${kind}`;
  const sql={exec(query,...args){
    const normalized=query.replace(/\s+/g,' ').trim();
    if(normalized.startsWith('CREATE TABLE')||normalized.startsWith('CREATE INDEX')) return {toArray:()=>[],one:()=>({})};
    if(normalized.includes('SELECT payload_json, expires_at')) {const row=rows.get(key(args[0],args[1],args[2]));return {toArray:()=>row?[row]:[],one:()=>row??{}};}
    if(normalized.startsWith('SELECT trigger_id FROM ( SELECT trigger_id FROM triage_agent_private_captures')) {const pattern=args[0];const prefix=pattern.endsWith('*')?pattern.slice(0,-1):pattern;const attempt=args[1];const now=args[2];const matches=new Set([...rows.values(),...failures.values()].filter(row=>row.trigger_id.startsWith(prefix)&&row.attempt===attempt&&row.expires_at>now).map(row=>row.trigger_id));return {toArray:()=>[...matches].slice(0,2).map(trigger_id=>({trigger_id}))};}
    if(normalized.includes('FROM triage_agent_private_captures WHERE expires_at >')) {const active=[...rows.values()].filter(row=>row.expires_at>args[0]);return {toArray:()=>[],one:()=>({row_count:active.length,byte_count:active.reduce((sum,row)=>sum+row.payload_bytes,0)})};}
    if(normalized.startsWith('DELETE FROM triage_agent_private_capture_failures WHERE expires_at <=')) {const deleted=[];for(const [rowKey,row] of failures)if(row.expires_at<=args[0]){failures.delete(rowKey);deleted.push(row);}return {toArray:()=>deleted,one:()=>({})};}
    if(normalized.startsWith('DELETE FROM triage_agent_private_captures WHERE expires_at <=')) {const deleted=[];for(const [rowKey,row] of rows)if(row.expires_at<=args[0]){rows.delete(rowKey);deleted.push(row);}return {toArray:()=>deleted,one:()=>({})};}
    if(normalized.includes('SELECT COUNT(*) AS row_count FROM triage_agent_private_capture_failures')) {const active=[...failures.values()].filter(row=>row.expires_at>args[0]);return {toArray:()=>[],one:()=>({row_count:active.length})};}
    if(normalized.startsWith('INSERT INTO triage_agent_private_capture_failures')) {const row={failure_id:args[0],trigger_id:args[1],attempt:args[2],capture_kind:args[3],failed_at:args[4],reason:args[5],payload_bytes:args[6],expires_at:args[7]};failures.set(row.failure_id,row);return {toArray:()=>[],one:()=>({})};}
    if(normalized.includes('FROM triage_agent_private_capture_failures')&&normalized.includes('ORDER BY failed_at')) {const selected=[...failures.values()].filter(row=>row.trigger_id===args[0]&&row.attempt===args[1]&&row.expires_at>args[2]).sort((a,b)=>a.failed_at-b.failed_at||a.failure_id.localeCompare(b.failure_id));return {toArray:()=>selected,one:()=>selected[0]??{}};}
    if(normalized.startsWith('DELETE FROM triage_agent_private_captures WHERE trigger_id =')) {const deleted=rows.delete(key(args[0],args[1],args[2]));return {toArray:()=>deleted?[{}]:[],one:()=>({})};}
    if(normalized.startsWith('INSERT INTO triage_agent_private_captures')) {const row={trigger_id:args[0],attempt:args[1],capture_kind:args[2],created_at:args[3],expires_at:args[4],payload_bytes:args[5],payload_json:args[6]};rows.set(key(row.trigger_id,row.attempt,row.capture_kind),row);return {toArray:()=>[],one:()=>({})};}
    if(normalized.includes('SELECT capture_kind, created_at')) {const selected=[...rows.values()].filter(row=>row.trigger_id===args[0]&&row.attempt===args[1]&&row.expires_at>args[2]).sort((a,b)=>a.created_at-b.created_at||a.capture_kind.localeCompare(b.capture_kind));return {toArray:()=>selected,one:()=>selected[0]??{}};}
    throw new Error(`unhandled test SQL: ${normalized}`);
  }};
  return {rows,failures,state,storage:{sql,async get(k){return k==='coordinator-state'?structuredClone(state.value):undefined;},async put(k,v){if(k==='coordinator-state')state.value=structuredClone(v);},async delete(){return false;},async list(){return new Map();},async setAlarm(at){state.alarm=at;}}};
}

test('private capture storage is idempotent, conflict-safe, and expires at seven days',()=>{
  const {storage,rows,failures}=privateCaptureSqlStorage(createInitialState());
  const triggerId='triage-81-60d4e73d-5c40-4a75-89b5-31ac48f25632';
  const record={triggerId,attempt:2,kind:'agent_input',payload:{requestBody:'exact escaped JSON with customer detail'}};
  const now=Date.parse('2026-09-26T10:00:00.000Z');
  assert.equal(storeTriageAgentCapture(storage,record,now).status,'recorded');
  assert.equal(storeTriageAgentCapture(storage,record,now+1).status,'duplicate');
  assert.equal(storeTriageAgentCapture(storage,{...record,payload:{requestBody:'changed'}},now+2).status,'conflict');
  const listed=listTriageAgentCaptures(storage,triggerId,2,now+3);
  assert.equal(listed.length,1);
  assert.deepEqual(listed[0].payload,record.payload);
  assert.deepEqual(listTriageAgentCaptureFailures(storage,triggerId,2,now+3).map(item=>item.reason),['conflict']);
  const afterExpiry=now+7*24*60*60*1000+10;
  assert.equal(pruneTriageAgentCaptures(storage,afterExpiry),2);
  assert.equal(rows.size,0);
  assert.equal(failures.size,0);
});

test('private capture sequence lookup is exact, bounded, and rejects ambiguity',()=>{
  const {storage}=privateCaptureSqlStorage(createInitialState());
  const triggerId='triage-84-60d4e73d-5c40-4a75-89b5-31ac48f25632';
  const now=Date.parse('2026-09-26T10:00:00.000Z');
  storeTriageAgentCapture(storage,{triggerId,attempt:1,kind:'agent_input',payload:{requestBody:'synthetic only'}},now);
  assert.deepEqual(lookupTriageAgentCaptureTriggerId(storage,84,1,now+1),{status:'found',triggerId});
  const secondTriggerId='triage-84-60d4e73d-5c40-4a75-89b5-31ac48f25633';
  storeTriageAgentCapture(storage,{triggerId:secondTriggerId,attempt:1,kind:'agent_input',payload:{requestBody:'synthetic only'}},now+2);
  assert.deepEqual(lookupTriageAgentCaptureTriggerId(storage,84,1,now+3),{status:'ambiguous'});
  assert.deepEqual(lookupTriageAgentCaptureTriggerId(storage,84,2,now+3),{status:'not_found'});
});

test('coordinator accepts pre-apply intent only for the active trigger and exposes it privately',async()=>{
  const {storage,state}=privateCaptureSqlStorage(createInitialState());
  const triggerId='triage-83-60d4e73d-5c40-4a75-89b5-31ac48f25632';
  const applyArguments={policyMode:'email-new-calls-v2',expectedCandidateTicketNumbers:['62992'],actions:[{ticketNumber:'62992',action:'leave',note:'exact private intent'}],verify:true,dedupeNotes:true};
  state.value.pending=true;
  state.value.executionPhase='awaiting_result';
  state.value.pendingTriggerId=triggerId;
  state.value.dispatchAttempt=2;
  storeTriageAgentCapture(storage,{triggerId,attempt:2,kind:'agent_input',payload:{requestBody:'exact prompt body'}});
  await storage.put('coordinator-state',state.value);
  const coordinator=new TriageCoordinator({storage},{});
  const report=await coordinator.fetch(new Request('https://local/internal/triage-apply-intent',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({triggerId,attempt:2,applyArguments})}));
  assert.equal(report.status,200);
  const reportBody=await report.json();
  assert.deepEqual({status:reportBody.status,triggerId:reportBody.triggerId,attempt:reportBody.attempt},{status:'recorded',triggerId,attempt:2});
  assert(Date.parse(reportBody.expiresAt)>Date.now()+6*24*60*60*1000);
  const read=await coordinator.fetch(new Request(`https://local/internal/agent-capture?triggerId=${encodeURIComponent(triggerId)}&attempt=2`));
  const capture=await read.json();
  assert.equal(capture.complete,true);
  assert.equal(capture.captureFailureCount,0);
  assert.equal(capture.records.find(item=>item.kind==='apply_intent').payload.applyArguments.actions[0].note,'exact private intent');
  const sequenceRead=await coordinator.fetch(new Request('https://local/internal/agent-capture?batchSequence=83&attempt=2'));
  assert.equal(sequenceRead.status,200);
  const sequenceCapture=await sequenceRead.json();
  assert.equal(sequenceCapture.triggerId,triggerId);
  assert.equal(sequenceCapture.complete,true);
  assert.deepEqual(sequenceCapture.records.map(item=>item.kind),['agent_input','apply_intent']);
});

test('the single metadata lookup covers closure fields before a resolve plan',()=>{
  assert(source.includes('Plan the single field-options lookup after establishing'));
  assert(source.includes('include any missing cause and resolutionCode in that same lookup'));
  assert(source.includes('missing closure-only cause/resolutionCode is not a reason to stop'));
  assert(source.includes('Never invent option values, resolve an actionable ticket'));
});

test('email trigger directs the Agent to the email policy, never the scheduled policy',()=>{
  const prompt=buildAgentInput('email-triage:regression',{
    mode:'new-email-tickets',source:'EMAIL',createdFrom:'2026-09-24T06:00:00.000Z',createdTo:'2026-09-24T06:01:00.000Z'
  });
  assert(prompt.includes('policyMode "email-new-calls-v2"'));
  assert(prompt.includes('in email-new-calls-v2'));
  assert(!prompt.includes('scheduled-new-calls-v2'));
  assert(prompt.includes('do not call Ticket History MCP, Supabase'));
  assert(prompt.includes('resultState to degraded'));
  assert(prompt.includes('omit all history/emerging note sections'));
  assert(prompt.includes('always use action leave and omit target.status'));
});

function historyRow(entry) {
  const row={event_id:entry.eventId,occurred_at:entry.at,batch_sequence:entry.batchSequence??null,event_name:entry.event,
    scope_mode:entry.scopeMode??null,scope_created_from:entry.scopeCreatedFrom??null,scope_created_to:entry.scopeCreatedTo??null,
    failure_kind:entry.failureKind??null,error_type:entry.errorType??null,error_code:entry.errorCode??null,attempt:entry.attempt??null,
    agent_run_status:entry.agentRunStatus??null,agent_run_id_present:entry.agentRunIdPresent?1:0,
    failure_diagnostics_json:entry.failureDiagnostics?JSON.stringify(entry.failureDiagnostics):null,
    replay_of_event_id:entry.replayOfEventId??null,ticket_number:entry.ticketNumber??null,
    operator_confirmed_no_mcp_calls:entry.operatorConfirmedNoMcpCalls?1:0};
  return new Proxy(row,{get(target,key){return key in target?target[key]:null;}});
}
test('relevant history filters routine rows before LIMIT and resumes a frozen cursor',()=>{
  const relevant=[101,102,103].map(eventId=>({eventId,at:'2026-10-04T10:00:00Z',event:'batch_failed'}));
  let oldest=1;
  const sql={exec(query,...args){
    if(query.includes('MIN(event_id)')) return {one:()=>({oldest_event_id:oldest,newest_event_id:104})};
    if(query.includes('SELECT *')) {
      assert(query.indexOf('AND (')<query.indexOf('LIMIT'),'filter must precede limit');
      assert(query.includes('ORDER BY event_id ASC'));
      const rows=relevant.filter(row=>row.eventId>args[0]&&row.eventId<=args[1]).slice(0,args[2]).map(historyRow);
      return {toArray:()=>rows};
    }
    return {toArray:()=>[],one:()=>({})};
  }};
  const first=listRelevantDispatchHistory({sql},0,2,103);
  assert.deepEqual(first.events.map(row=>row.eventId),[101,102]); assert.equal(first.hasMore,true); assert.equal(first.coverage.complete,false);
  const second=listRelevantDispatchHistory({sql},first.nextAfterEventId,2,first.coverage.throughEventId);
  assert.deepEqual(second.events.map(row=>row.eventId),[103]); assert.equal(second.hasMore,false); assert.equal(second.coverage.complete,true);
  oldest=80;
  assert.equal(listRelevantDispatchHistory({sql},0,10,103).coverage.complete,false,'retention gap is never complete coverage');
});
function replayCoordinator(seed, archivedEvents=seed.dispatchHistory??[], envOverrides={}) {
  const storage={value:structuredClone(seed),alarm:null,
    async get(){return structuredClone(this.value);},
    async put(_key,value){this.value=structuredClone(value);},
    async setAlarm(value){this.alarm=value;},
    sql:{exec(query,...args){
      let rows=[];
      if(query.includes('SELECT * FROM triage_dispatch_history WHERE event_id = ?')) rows=archivedEvents.filter(event=>event.eventId===args[0]).map(historyRow);
      else if(query.includes("event_name = 'manual_replay_requested'")) rows=archivedEvents.filter(event=>event.event==='manual_replay_requested'&&event.replayOfEventId===args[0]&&event.ticketNumber===args[1]).map(()=>({found:1}));
      return {toArray(){return rows;},one(){return {event_id:0};}};
    }}
  };
  return {storage,coordinator:new TriageCoordinator({storage},{...vars,...envOverrides})};
}
const replaySourceScope={mode:'new-email-tickets',source:'EMAIL',createdFrom:'2026-09-25T10:17:01.406Z',createdTo:'2026-09-25T10:18:17.407Z'};
const replayFailureEvent={eventId:41,at:'2026-09-25T10:18:47.407Z',event:'orphan_recovered',batchSequence:24,
  scopeMode:'new-email-tickets',scopeCreatedFrom:replaySourceScope.createdFrom,scopeCreatedTo:replaySourceScope.createdTo,
  failureKind:'ambiguous',attempt:1,agentRunIdPresent:true,agentRunStatus:'failed',
  failureDiagnostics:[{stage:'agent_callback',errorType:'callback_contract',errorCode:'result_callback_missing',httpStatus:500,requestIndex:1,message:'Agent run reached a terminal state without calling triage_result_report.'}]};
test('manual replay schedules only one named ticket and preserves the attention fence',async()=>{
  const seed={...createInitialState(),dispatchHistorySequence:41,dispatchHistory:[replayFailureEvent],
    needsAttentionScope:replaySourceScope,needsAttentionScopes:[replaySourceScope],candidateAttentionFenceActive:true};
  const {storage,coordinator}=replayCoordinator(seed);
  const response=await coordinator.fetch(new Request('https://coordinator.internal/internal/admin/replay',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({sourceEventId:41,ticketNumber:'62966',confirmNoMcpCalls:true})}));
  const result=await response.json();
  assert.equal(response.status,202,JSON.stringify(result));
  assert.equal(result.status,'replay_scheduled');
  assert.equal(result.ticketNumber,'62966');
  assert.equal(storage.value.pending,true);
  assert.equal(storage.value.pendingTriggerScope.replayOfEventId,41);
  assert.deepEqual(storage.value.pendingTriggerScope.targetTicketNumbers,['62966']);
  assert.deepEqual(storage.value.pendingTriggerScope,{...replaySourceScope,targetTicketNumbers:['62966'],replayOfEventId:41});
  assert.deepEqual(storage.value.needsAttentionScopes,[replaySourceScope]);
  assert.equal(storage.value.dispatchHistory.at(-1).event,'manual_replay_requested');
  assert.equal(storage.value.dispatchHistory.at(-1).operatorConfirmedNoMcpCalls,true);
  assert.equal(storage.alarm,Date.parse(storage.value.dispatchHistory.at(-1).at));
  const prompt=buildAgentInput(result.triggerId,storage.value.pendingTriggerScope,1,true);
  assert(prompt.includes('only process ticket #62966'));
  assert(prompt.includes('Never widen this scope'));
  assert(prompt.includes('"targetTicketNumbers":["62966"]'));
});
test('manual replay resolves an older source event from durable history beyond the live-state ring',async()=>{
  const recent=Array.from({length:96},(_,index)=>({eventId:100+index,at:'2026-09-25T12:00:00.000Z',event:'maintenance_started'}));
  const seed={...createInitialState(),dispatchHistorySequence:195,dispatchHistory:recent,
    needsAttentionScope:replaySourceScope,needsAttentionScopes:[replaySourceScope],candidateAttentionFenceActive:true};
  const {storage,coordinator}=replayCoordinator(seed,[replayFailureEvent]);
  const response=await coordinator.fetch(new Request('https://coordinator.internal/internal/admin/replay',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({sourceEventId:41,ticketNumber:'62966',confirmNoMcpCalls:true})}));
  const result=await response.json();
  assert.equal(response.status,202,JSON.stringify(result));
  assert.equal(result.status,'replay_scheduled');
  assert.equal(storage.value.dispatchHistory.at(-1).replayOfEventId,41);
  assert.deepEqual(storage.value.pendingTriggerScope.targetTicketNumbers,['62966']);
});
test('manual replay rejects an unconfirmed call log or non-failed run and preserves other overlapping holds',async()=>{
  const request=body=>new Request('https://coordinator.internal/internal/admin/replay',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const seed={...createInitialState(),dispatchHistorySequence:41,dispatchHistory:[replayFailureEvent],
    needsAttentionScope:replaySourceScope,needsAttentionScopes:[replaySourceScope],candidateAttentionFenceActive:true};
  const a=replayCoordinator(seed);
  assert.equal((await a.coordinator.fetch(request({sourceEventId:41,ticketNumber:'62966',confirmNoMcpCalls:false}))).status,400);
  const failed={...replayFailureEvent,agentRunStatus:'completed'};
  const b=replayCoordinator({...seed,dispatchHistory:[failed]});
  assert.equal((await b.coordinator.fetch(request({sourceEventId:41,ticketNumber:'62966',confirmNoMcpCalls:true}))).status,409);
  const overlapping={mode:'new-email-tickets',source:'EMAIL',createdFrom:'2026-09-25T10:18:00.000Z',createdTo:'2026-09-25T10:18:30.000Z'};
  const c=replayCoordinator({...seed,needsAttentionScopes:[replaySourceScope,overlapping]});
  const overlapResponse=await c.coordinator.fetch(request({sourceEventId:41,ticketNumber:'62966',confirmNoMcpCalls:true}));
  assert.equal(overlapResponse.status,202);
  assert.deepEqual(c.storage.value.needsAttentionScopes,[replaySourceScope,overlapping]);
  assert.deepEqual(c.storage.value.pendingTriggerScope.targetTicketNumbers,['62966']);
});
test('manual replay can run through an attention-blocked queue without consuming it',async()=>{
  const heldQueue={mode:'new-email-tickets',source:'EMAIL',createdFrom:'2026-09-25T10:35:55.935Z',createdTo:'2026-09-25T10:37:11.936Z'};
  const blockedWindow={reason:'new_message',notificationWindowStartedAt:Date.parse('2026-09-25T10:35:55.935Z'),notificationWindowEndedAt:Date.parse('2026-09-25T10:37:11.936Z'),notificationLookbackMs:0,lastNotificationAt:Date.parse('2026-09-25T10:37:11.936Z'),debounceWindowStartedAt:Date.parse('2026-09-25T10:35:55.935Z'),unavailableRetryCount:0,lifecycleRecoveryRequested:false,lastLifecycleEvent:null};
  const queued={queuedPending:true,queuedBlockedByAttention:true,queuedReason:'new_message',queuedNotificationWindowStartedAt:Date.parse(heldQueue.createdFrom),queuedNotificationWindowEndedAt:Date.parse(heldQueue.createdTo),queuedNotificationLookbackMs:0,queuedLastNotificationAt:Date.parse(heldQueue.createdTo),queuedDebounceWindowStartedAt:Date.parse(heldQueue.createdFrom)};
  const seed={...createInitialState(),dispatchHistorySequence:41,dispatchHistory:[replayFailureEvent],needsAttentionScope:heldQueue,needsAttentionScopes:[replaySourceScope,heldQueue],attentionBlockedWindow:blockedWindow,candidateAttentionFenceActive:true,...queued};
  const {storage,coordinator}=replayCoordinator(seed);
  const response=await coordinator.fetch(new Request('https://coordinator.internal/internal/admin/replay',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sourceEventId:41,ticketNumber:'62966',confirmNoMcpCalls:true})}));
  assert.equal(response.status,202);
  assert.equal(storage.value.pending,true);
  assert.equal(storage.value.queuedPending,true);
  assert.equal(storage.value.queuedBlockedByAttention,true);
  assert.deepEqual(storage.value.needsAttentionScopes,[replaySourceScope,heldQueue]);
  assert.equal(storage.value.queuedNotificationWindowStartedAt,Date.parse(heldQueue.createdFrom));
});
test('manual replay is one-shot per failed history event and ticket',async()=>{
  const requested={eventId:42,at:'2026-09-25T10:20:00.000Z',event:'manual_replay_requested',batchSequence:25,
    scopeMode:'new-email-tickets',scopeCreatedFrom:replaySourceScope.createdFrom,scopeCreatedTo:replaySourceScope.createdTo,
    replayOfEventId:41,ticketNumber:'62966',operatorConfirmedNoMcpCalls:true};
  const state={...createInitialState(),dispatchHistorySequence:42,dispatchHistory:[replayFailureEvent,requested],
    needsAttentionScope:replaySourceScope,needsAttentionScopes:[replaySourceScope],candidateAttentionFenceActive:true};
  const {coordinator}=replayCoordinator(state);
  const response=await coordinator.fetch(new Request('https://coordinator.internal/internal/admin/replay',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({sourceEventId:41,ticketNumber:'62966',confirmNoMcpCalls:true})}));
  assert.equal(response.status,409);
  assert.equal((await response.json()).error,'replay_already_requested');
});
test('manual replay one-shot guard also sees requests archived beyond the live-state ring',async()=>{
  const seed={...createInitialState(),dispatchHistorySequence:195,dispatchHistory:[],
    needsAttentionScope:replaySourceScope,needsAttentionScopes:[replaySourceScope],candidateAttentionFenceActive:true};
  const archivedRequest={eventId:42,at:'2026-09-25T10:20:00.000Z',event:'manual_replay_requested',
    replayOfEventId:41,ticketNumber:'62966'};
  const {coordinator}=replayCoordinator(seed,[replayFailureEvent,archivedRequest]);
  const response=await coordinator.fetch(new Request('https://coordinator.internal/internal/admin/replay',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({sourceEventId:41,ticketNumber:'62966',confirmNoMcpCalls:true})}));
  assert.equal(response.status,409);
  assert.equal((await response.json()).error,'replay_already_requested');
});
test('an empty manual replay completes without widening the source window',async()=>{
  const f=fixture('completed');
  const targetScope={...f.scope,targetTicketNumbers:['62966'],replayOfEventId:41};
  f.seed({...f.state,pendingTriggerScope:targetScope,needsAttentionScope:f.scope,needsAttentionScopes:[f.scope],candidateAttentionFenceActive:true});
  const result=await f.engine.reportResult({triggerId:f.state.pendingTriggerId,attempt:1,status:'complete',
    metadata:{ticketsConsidered:0,ticketsCompleted:0,ticketsDeferred:0,ticketOutcomes:[]}});
  assert.equal(result.status,'complete');
  assert.deepEqual(f.state.needsAttentionScopes,[f.scope]);
  assert.equal(f.state.queuedPending,false);
  assert.equal(f.state.pendingTriggerScope,null);
  assert(!f.state.dispatchHistory.some(event=>event.event==='retry_scheduled'));
});

function fixture(status, age = 120000, configOverrides = {}) {
  let now = Date.parse('2026-09-24T06:00:00Z');
  let agentStatus=status;
  const scope = {mode:'new-email-tickets', source:'EMAIL', createdFrom:new Date(now-60000).toISOString(), createdTo:new Date(now).toISOString()};
  let state = {...createInitialState(), pending:true, pendingReason:'new_message',
    pendingTriggerId:'email-triage:9001', pendingTriggerScope:scope,
    pendingNotificationWindowStartedAt:now-60000, pendingNotificationWindowEndedAt:now,
    pendingNotificationLookbackMs:60000, executionPhase:'awaiting_result', dispatchAttempt:1,
    lastAcceptedTrigger:{triggerId:'email-triage:9001', attempt:1, runId:'apirun_synthetic', acceptedAt:new Date(now-age).toISOString()},
    resultDeadlineAt:now+30000};
  const calls = [];
  const alarms = [];
  const config={...loadConfig({...vars,GRAPH_WEBHOOK_CLIENT_STATE:'synthetic-graph-state'}),...configOverrides};
  const engine = new CoordinatorEngine({config, now:()=>now,
    store:{load:async()=>structuredClone(state),save:async s=>{state=structuredClone(s);},setAlarm:async at=>alarms.push(at)},
    agent:{getRunDiagnostics:async()=>({status:agentStatus,httpStatus:200}),trigger:async(...args)=>{calls.push(args);return {kind:'accepted',runId:'apirun_retry'};}}});
  return {engine,calls,alarms,scope,config,get state(){return state;},seed:patch=>{state={...state,...patch};},setNow:value=>{now=Date.parse(value);},setRunStatus:value=>{agentStatus=value;},advance:()=>{now=state.dueAt ?? now+40000;},expire:()=>{now+=40000;}};
}

const startCapability={protocol:'triage-run-lease-v1',enforced:true,startProtocol:'triage-run-start-v1',startGuardEnforced:true};
function startupFixture(changes={},diagnostics={status:'failed',httpStatus:200,errorCode:'dispatch_failed'}) {
  const f=fixture('failed',120000,{startupRecoveryEnabled:true,runLeaseGuardService:{fetch:async()=>Response.json(startCapability)}});
  const triggerId='triage-9001-00000000-0000-4000-8000-000000009001';
  f.seed({pendingTriggerId:triggerId,lastAcceptedTrigger:{...f.state.lastAcceptedTrigger,triggerId}});
  const now=Date.parse('2026-09-24T06:00:00Z');
  f.seed({runWriteLeases:[{triggerId:f.state.pendingTriggerId,attempt:1,runId:'apirun_synthetic',scope:f.scope,
    issuedAt:now-120000,expiresAt:now+180000,revokedAt:null,authorizedItems:[],startGuardProtocol:'triage-run-start-v1',
    startupDeadlineAt:now+480000,startupRetryCount:0,...changes}]});
  f.engine.deps.agent.getRunDiagnostics=async()=>diagnostics;
  return f;
}
test('positively classified provider dispatch failure retries the original guarded scope after revocation',async()=>{
  const f=startupFixture();f.expire();
  const result=await f.engine.processAlarm();
  assert.equal(result.status,'retry_scheduled');assert.equal(f.calls.length,0);
  assert.equal(f.state.runWriteLeases[0].revokedAt,Date.parse('2026-09-24T06:00:40Z'));
  assert.equal(f.state.runWriteLeases[0].startupRetryCount,1);
  assert.deepEqual(f.state.pendingTriggerScope,f.scope);
  assert.equal(f.state.sharedRateLimitUntil,null);
  assert.equal(f.state.dueAt,Date.parse('2026-09-24T06:01:10Z'));
  f.advance();await f.engine.processAlarm();
  assert.equal(f.calls.length,1);assert.equal(f.calls[0][2],2);
  assert.deepEqual(f.calls[0][1],f.scope);
  assert.equal(f.state.runWriteLeases.at(-1).startupRetryCount,1);
  assert.equal(f.state.runWriteLeases.at(-1).startupDeadlineAt,Date.parse('2026-09-24T06:08:00Z'));
});
for(const blocker of [{mcpWorkStartedAt:0},{pendingRead:{}},{queryCompleted:true},{queryTicketNumbers:[]},
  {applyIntentObserved:true},{writeCheckObserved:true},{operationReference:{}},{rejectedCallbackUnsafe:true},
  {authorizedItems:['90101']},{startGuardProtocol:undefined},{revokedAt:1},{startupRetryCount:2},{startupDeadlineAt:1}]) {
  test('startup retry refuses '+Object.keys(blocker)[0],async()=>{
    const f=startupFixture(blocker);f.expire();await f.engine.processAlarm();
    assert.equal(f.calls.length,0);assert.equal(f.state.pending,false);
    assert(f.state.dispatchHistory.some(event=>event.event==='orphan_recovered'));
  });
}
test('the observed generic run_failed is never automatically retried from absent tools',async()=>{
  const f=startupFixture({}, {status:'failed',httpStatus:200,errorCode:'run_failed'});f.expire();await f.engine.processAlarm();
  assert.equal(f.calls.length,0);assert.equal(f.state.pending,false);
  assert(f.state.dispatchHistory.some(event=>event.event==='startup_recovery_blocked'&&event.failureDiagnostics[0].errorCode==='operator_startup_proof_required'));
});
test('startup retry refuses prior active execution and unavailable or disabled live guard',async()=>{
  for(const kind of ['in_progress','suspended','unavailable_guard','disabled_guard','changed_scope']) {
    const f=startupFixture();
    if (['in_progress','suspended'].includes(kind)) f.seed({dispatchHistory:[{eventId:1,event:'agent_run_status_checked',at:'2026-09-24T05:59:00.000Z',
      batchSequence:9001,attempt:1,agentRunStatus:kind}]});
    if (kind==='unavailable_guard') f.engine.deps.config.runLeaseGuardService=undefined;
    if (kind==='disabled_guard') f.engine.deps.config.runLeaseGuardService={fetch:async()=>Response.json({...startCapability,startGuardEnforced:false})};
    if (kind==='changed_scope') f.seed({pendingTriggerScope:{...f.scope,createdTo:'2026-09-24T06:01:00.000Z'}});
    f.expire();await f.engine.processAlarm();assert.equal(f.calls.length,0);assert.equal(f.state.pending,false,kind);
  }
});
test('startup recovery cap and original deadline survive both fresh accepted runs',async()=>{
  const f=startupFixture();
  f.expire();await f.engine.processAlarm();f.advance();await f.engine.processAlarm();
  f.expire();await f.engine.processAlarm();
  assert.equal(f.state.runWriteLeases.at(-1).startupRetryCount,2);
  assert.equal(f.state.dueAt,Date.parse('2026-09-24T06:02:50Z'));
  f.advance();await f.engine.processAlarm();f.expire();await f.engine.processAlarm();
  assert.equal(f.calls.length,2);assert.equal(f.state.pending,false);
  assert.equal(f.state.runWriteLeases.at(-1).startupDeadlineAt,Date.parse('2026-09-24T06:08:00Z'));
});
test('startup deadline prevents a delayed retry from dispatching after restart',async()=>{
  const f=startupFixture();f.expire();await f.engine.processAlarm();
  f.seed(normalizeState(JSON.parse(JSON.stringify(f.state))));f.setNow('2026-09-24T06:09:00Z');
  await f.engine.processAlarm();assert.equal(f.calls.length,0);assert.equal(f.state.pending,false);
});
test('startup deadline also protects a retry promoted from the fresh-work hold',async()=>{
  const f=startupFixture();f.expire();await f.engine.processAlarm();
  f.seed({executionPhase:'pending_dispatch',pendingDispatchWaitReason:'reconciliation_hold'});
  f.setNow('2026-09-24T06:09:00Z');await f.engine.processAlarm();
  assert.equal(f.calls.length,0);assert.equal(f.state.pending,false);
});

function existingNoteCompletion(outcome = 'skipped') {
  return {failureStage:'evidence_recovery',ticketsConsidered:1,ticketsCompleted:1,ticketsDeferred:0,
    ticketOutcomes:[{ticketNumber:'90101',outcome,stage:'evidence_recovery',reasonCode:'already_handled'}],
    mcpExecution:{executionTraceId:'synthetic-existing-note',invocationId:'synthetic-existing-note-invocation',
      operationId:'synthetic-existing-note',toolName:'superops_tickets_triage_evidence_recover',
      durationMs:5000,subrequestsUsed:24,subrequestBudget:45,subrequestSafetyMargin:8,retryCount:0,
      requestTraceTruncated:false,requestsByType:{duplicateNoteCheck:1,verificationRead:2,dispatcherPoll:4,custom:17}}};
}

test('verified existing-note completion accepts both callback outcome labels without another run',async()=>{
  for(const outcome of ['skipped','completed']) {
    const f=fixture('completed');
    f.seed({retryCount:2,emptyTargetedRecoveryPending:true});
    const scopeBefore=structuredClone(f.scope);
    const result=await f.engine.reportResult({triggerId:f.state.pendingTriggerId,attempt:1,status:'complete',
      metadata:existingNoteCompletion(outcome)});
    assert.equal(result.status,'complete',outcome);
    assert.equal(f.state.pending,false);
    assert.deepEqual(f.state.dispatchHistory.find(e=>e.event==='batch_completed').scopeCreatedFrom,scopeBefore.createdFrom);
    assert.equal(f.calls.length,0);
    assert(!f.state.dispatchHistory.some(e=>e.event==='retry_scheduled'));
  }
});

test('an already-handled label cannot replace existing-note verification proof',async()=>{
  for(const outcome of ['skipped','completed']) {
    for(const missing of ['telemetry','noteCheck','verificationRead','wrongTool','diagnostics','terminalOperation','reason']) {
      const f=fixture('completed');
      const metadata=existingNoteCompletion(outcome);
      if(missing==='telemetry') delete metadata.mcpExecution;
      if(missing==='noteCheck') metadata.mcpExecution.requestsByType.duplicateNoteCheck=0;
      if(missing==='verificationRead') metadata.mcpExecution.requestsByType.verificationRead=0;
      if(missing==='wrongTool') metadata.mcpExecution.toolName='superops_tickets_query';
      if(missing==='diagnostics') metadata.mcpExecution.failureDiagnostics=[{stage:'evidence_recovery',errorCode:'private_note_check_unavailable'}];
      if(missing==='terminalOperation') metadata.operationStatus={state:'CompletedWithFailures',failedCount:1};
      if(missing==='reason') metadata.ticketOutcomes[0].reasonCode='unknown';
      const result=await f.engine.reportResult({triggerId:f.state.pendingTriggerId,attempt:1,status:'complete',metadata});
      assert.notEqual(result.status,'complete',outcome+':'+missing);
      assert(!f.state.dispatchHistory.some(e=>e.event==='batch_completed'));
      assert.equal(f.calls.length,0);
    }
  }
});

test('a zero-width tail never becomes a dispatchable Agent scope', () => {
  const f = fixture('completed');
  const now = Date.parse('2026-09-24T06:00:00Z');
  f.seed({ pendingNotificationWindowStartedAt: now, pendingNotificationWindowEndedAt: now,
    pendingNotificationLookbackMs: 0 });
  assert.equal(createPendingTriggerScope(f.state, f.config, now), null);
});

function withCorrelatedOperation(f, recordOverrides = {}, candidates = ['90101']) {
  const ownerHash = '12345678';
  const operationId = f.state.pendingTriggerId;
  const record = {operationId, ownerHash, toolName:'superops_tickets_apply_triage_plan', state:'Completed', expectedItems:['90101'],
    continuationCount:2, itemStates:{'90101':{stage:'Completed',verificationState:'Verified',partialWrite:false}}, ...recordOverrides};
  f.seed({runWriteLeases:[{triggerId:operationId,attempt:1,issuedAt:0,expiresAt:Date.parse('2026-09-25T06:00:00Z'),revokedAt:null,scope:f.scope,
    authorizedItems:['90101'],queryTicketNumbers:candidates,operationReference:{operationId,ownerHash}}]});
  const reads=[];
  f.config.operationLedger={idFromName:name=>{assert.equal(name,'owner:'+ownerHash);return name;},get:()=>({fetch:async request=>{
    reads.push(request); assert.equal(request.method,'GET'); return Response.json(record);
  }})};
  return {reads,record};
}
test('a missing callback recovers verified durable success without another Agent or write', async()=>{
  const f=fixture('completed'); const {reads}=withCorrelatedOperation(f); f.expire();
  assert.equal((await f.engine.processAlarm()).status,'complete');
  assert.equal(reads.length,1); assert.equal(f.calls.length,0);
  assert(f.state.dispatchHistory.some(event=>event.event==='operation_status_recovered'));
  assert(!f.state.dispatchHistory.some(event=>event.event==='orphan_recovered'));
});
test('a contradictory failure callback hands off an acknowledged partial continuation', async()=>{
  const f=fixture('in_progress');withCorrelatedOperation(f,{state:'Rescheduled',schedulingSucceeded:true,
    itemStates:{'90101':{stage:'NoteAdded',verificationState:'Pending',partialWrite:true}}});
  assert.equal((await f.engine.reportResult({triggerId:f.state.pendingTriggerId,attempt:1,status:'terminal_failure',
    metadata:{operationId:f.state.pendingTriggerId,operationStatus:{state:'CompletedWithFailures'},failureStage:'triage_apply'}})).status,'complete');
  assert.equal(f.state.lastResultReport.metadata.operationStatus.pendingCount,1);
  assert.equal(f.calls.length,0);
});

test('a claimed completion cannot hide an unscheduled or terminal durable failure',async()=>{
  for(const state of ['ContinuationRequired','CompletedWithFailures']) {
    const f=fixture('completed');withCorrelatedOperation(f,{state,schedulingSucceeded:false,
      itemStates:{'90101':{stage:state==='ContinuationRequired'?'NoteAdded':'FailedAfterPartialWrite',
        verificationState:'Pending',partialWrite:true}}});
    const result=await f.engine.reportResult({triggerId:f.state.pendingTriggerId,attempt:1,status:'complete',
      metadata:{failureStage:'operation_continuation',operationId:f.state.pendingTriggerId,
        ticketsConsidered:1,ticketsCompleted:1,ticketsDeferred:0,
        operationStatus:{state:'Completed',pendingCount:0,failedCount:0}}});
    assert.equal(result.status,'terminal_failure',state);
    assert.equal(f.calls.length,0);assert.equal(f.state.needsAttentionScopes.length,1);
    assert.equal(f.state.lastResultReport.metadata.operationStatus.state,state);
  }
});
test('unresolved ambiguity and an unaccounted subset remain quarantined', async()=>{
  for(const variant of ['ambiguous','subset','owner']) {
    const f=fixture('completed');const {record}=withCorrelatedOperation(f,{},variant==='subset'?['90101','90102']:['90101']);
    if(variant==='ambiguous') record.itemStates['90101']={stage:'AmbiguousWriteUnresolved',humanReconciliationRequired:true,partialWrite:true};
    if(variant==='owner')record.ownerHash='87654321';
    f.expire();await f.engine.processAlarm();
    assert(f.state.dispatchHistory.some(event=>event.event==='orphan_recovered'));
    assert.equal(f.calls.length,0);
  }
});

test('an invalid persisted targeted window stops before any Agent dispatch or retry', async () => {
  const f = fixture('completed');
  const now = Date.parse('2026-09-24T06:00:00Z');
  f.seed({ executionPhase: null, lastAcceptedTrigger: null, lastResultReport: null,
    resultDeadlineAt: null, dueAt: now, cooldownUntil: 0,
    pendingTriggerScope: {...f.scope, createdFrom: f.scope.createdTo},
    pendingNotificationWindowStartedAt: now, pendingNotificationWindowEndedAt: now,
    pendingNotificationLookbackMs: 0 });
  await f.engine.processAlarm();
  assert.equal(f.calls.length, 0);
  assert.equal(f.state.pending, false);
  assert(!f.state.dispatchHistory.some(e => e.event === 'retry_scheduled'));
  assert(f.state.dispatchHistory.some(e => e.errorCode === 'invalid_created_window'));
});

test('write lease binds the live ticket to its exact half-open window and cannot be renewed by checking it',()=>{
  const f=fixture('in_progress');
  const state=normalizeState(f.state), now=Date.parse('2026-09-24T06:00:00Z');
  ensureAcceptedWriteLease(state,f.config);
  const input={triggerId:state.pendingTriggerId,attempt:1,itemKey:'90001',ticketCreatedTime:f.scope.createdFrom,ticketSource:'EMAIL'};
  assert.equal(checkRunWriteLease(state,f.config,input,now).allowed,true);
  const deadline=state.runWriteLeases[0].expiresAt;
  assert.equal(checkRunWriteLease(state,f.config,{triggerId:input.triggerId,itemKey:'90001'},now).allowed,true);
  assert.equal(checkRunWriteLease(state,f.config,{...input,ticketCreatedTime:f.scope.createdTo},now).allowed,false);
  assert.equal(checkRunWriteLease(state,f.config,{...input,ticketSource:'PHONE'},now).allowed,false);
  assert.equal(checkRunWriteLease(state,f.config,{...input,attempt:2},now).allowed,false);
  assert.equal(checkRunWriteLease(state,f.config,{triggerId:input.triggerId,itemKey:'90002'},now).allowed,false);
  assert.equal(checkRunWriteLease(state,f.config,input,deadline).allowed,false);
  const restored=normalizeState(JSON.parse(JSON.stringify(state)));
  assert.equal(checkRunWriteLease(restored,f.config,input,deadline+1).allowed,false);
  assert.equal(restored.runWriteLeases[0].expiresAt,deadline);
});

test('an expired Agent lease permits only a claimed item in its existing approved continuation',async()=>{
  for(const previouslyCorrelated of [false,true]) {
    const now=Date.now(), triggerId='triage-91-00000000-0000-4000-8000-000000000091', ownerHash='12345678';
    const reference={operationId:triggerId,ownerHash};
    const lease={triggerId,attempt:1,issuedAt:now-600000,expiresAt:now-300000,revokedAt:null,
      scope:replaySourceScope,authorizedItems:['90101'],...(previouslyCorrelated?{operationReference:reference}:{})};
    const record={...reference,toolName:'superops_tickets_apply_triage_plan',state:'Running',
      expectedItems:['90101'],operationRequest:{approved:true},maxOperationLifetimeAt:new Date(now+600000).toISOString(),
      itemStates:{'90101':{stage:'NoteDedupeChecked',lease:{expiresAt:new Date(now+60000).toISOString()}}}};
    let reads=0;
    const ledger={idFromName:name=>{assert.equal(name,'owner:'+ownerHash);return name;},get:()=>({fetch:async request=>{
      reads++;assert.equal(request.method,'GET');return Response.json(record);
    }})};
    const {storage,coordinator}=replayCoordinator({...createInitialState(),runWriteLeases:[lease]},[],{SUPEROPS_OPERATION_LEDGER:ledger});
    const response=await coordinator.fetch(new Request('https://coordinator.internal/internal/run-lease/check',{method:'POST',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({triggerId,itemKey:'90101',operationReference:reference})}));
    const result=await response.json();
    assert.equal(response.status,200,JSON.stringify(result));assert.equal(result.allowed,true);assert.equal(reads,1);
    assert(result.expiresAt>now&&result.expiresAt<=Date.now()+30000);
    assert.equal(storage.value.runWriteLeases[0].expiresAt,lease.expiresAt,'the expired Agent permission is never renewed');
    assert.deepEqual(storage.value.runWriteLeases[0].operationReference,reference);
  }
});

test('expired continuation permission fails closed for unapproved, unclaimed or revoked work',async()=>{
  for(const variant of ['agent_attempt','revoked','wrong_owner','unclaimed','unknown_item','expired_operation','unapproved','terminal','forged_deadline']) {
    const now=Date.now(),triggerId='triage-92-00000000-0000-4000-8000-000000000092',ownerHash='12345678';
    const reference={operationId:triggerId,ownerHash};
    const lease={triggerId,attempt:1,issuedAt:now-600000,expiresAt:now-300000,revokedAt:null,
      scope:replaySourceScope,authorizedItems:['90101'],operationReference:reference};
    const record={...reference,toolName:'superops_tickets_apply_triage_plan',state:'Running',expectedItems:['90101'],
      operationRequest:{approved:true},maxOperationLifetimeAt:new Date(now+600000).toISOString(),
      itemStates:{'90101':{stage:'NoteDedupeChecked',lease:{expiresAt:new Date(now+60000).toISOString()}}}};
    const body={triggerId,itemKey:'90101',operationReference:reference};
    if(variant==='agent_attempt')body.attempt=1;
    if(variant==='revoked')lease.revokedAt=now-1000;
    if(variant==='wrong_owner')body.operationReference={...reference,ownerHash:'87654321'};
    if(variant==='unclaimed')delete record.itemStates['90101'].lease;
    if(variant==='unknown_item')record.expectedItems=['90102'];
    if(variant==='expired_operation')record.maxOperationLifetimeAt=new Date(now-1000).toISOString();
    if(variant==='unapproved')delete record.operationRequest;
    if(variant==='terminal')record.state='Completed';
    if(variant==='forged_deadline'){body.validatedContinuationLeaseUntil=now+60000;record.itemStates['90101'].lease.expiresAt=new Date(now-1000).toISOString();}
    const ledger={idFromName:name=>name,get:()=>({fetch:async()=>Response.json(record)})};
    const {coordinator}=replayCoordinator({...createInitialState(),runWriteLeases:[lease]},[],{SUPEROPS_OPERATION_LEDGER:ledger});
    const response=await coordinator.fetch(new Request('https://coordinator.internal/internal/run-lease/check',{method:'POST',
      headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}));
    assert.equal(response.status,409,variant);assert.equal((await response.json()).allowed,false,variant);
  }
});

for(const status of ['in_progress','queued','suspended','unavailable']) {
  test(`expired ${status} run is fenced before a disjoint queue is promoted; late callback cannot disturb it`,async()=>{
    const f=fixture(status,360000,{runLeaseExpiryEnabled:true,runLeaseGuardService:{fetch:async()=>Response.json({protocol:'triage-run-lease-v1',enforced:true})}});
    const oldId=f.state.pendingTriggerId;
    const fresh=emailScope('2026-09-24T06:00:00Z','2026-09-24T06:01:00Z');
    f.seed({queuedPending:true,queuedReason:'new_message',queuedNotificationWindowStartedAt:Date.parse(fresh.createdFrom),
      queuedNotificationWindowEndedAt:Date.parse(fresh.createdTo),queuedNotificationLookbackMs:0,
      queuedLastNotificationAt:Date.parse(fresh.createdTo),queuedDueAt:Date.parse(fresh.createdTo)});
    const saved=[];
    const originalSave=f.engine.deps.store.save;
    f.engine.deps.store.save=async state=>{saved.push(structuredClone(state));await originalSave(state);};
    assert.equal((await f.engine.processAlarm()).status,'expired_run_quarantined');
    assert.equal(saved[0].pendingTriggerId,oldId);
    assert.equal(saved[0].runWriteLeases[0].revokedAt,Date.parse('2026-09-24T06:00:00Z'));
    assert.deepEqual(f.state.needsAttentionScopes,[f.scope]);
    assert.equal(f.calls.length,0,'recovery does not dispatch or replay inside the revocation transaction');
    const afterRecovery=f.state.pendingTriggerId;
    assert.notEqual(afterRecovery,oldId);
    const late=await f.engine.reportResult({triggerId:oldId,attempt:1,status:'complete',metadata:{ticketsConsidered:0,ticketsCompleted:0,ticketsDeferred:0}});
    assert.equal(late.status,'stale_or_unauthorized');
    assert.equal(f.state.pendingTriggerId,afterRecovery);
    assert.equal(checkRunWriteLease(normalizeState(f.state),f.config,{triggerId:oldId},Date.parse('2026-09-24T06:00:00Z')).allowed,false);
    f.advance(); await f.engine.processAlarm();
    assert.equal(f.calls.length,1);
    assert(Date.parse(f.calls[0][1].createdFrom)>=Date.parse(f.scope.createdTo));
  });
}
test('expiry never releases a lease without a live deployed write guard handshake',async()=>{
  for(const capability of [undefined,{protocol:'triage-run-lease-v1',enforced:false},{protocol:'different',enforced:true}]) {
    const f=fixture('in_progress',360000,{runLeaseExpiryEnabled:true,runLeaseGuardService:capability?{fetch:async()=>Response.json(capability)}:undefined});
    f.expire();
    await f.engine.processAlarm();
    assert.equal(f.state.executionPhase,'awaiting_result');
    assert.equal(f.state.needsAttentionScopes.length,0);
    assert.equal(f.calls.length,0);
  }
});

const emailScope=(from,to)=>({mode:'new-email-tickets',source:'EMAIL',createdFrom:from,createdTo:to});
const terminalValidationMetadata = {failureStage:'triage_apply',ticketsConsidered:1,ticketsCompleted:0,ticketsDeferred:1,
  operationId:'synthetic-terminal-operation',operationStatus:{state:'CompletedWithFailures',continuationRequired:false,
    failedCount:1,pendingCount:0,replaySafe:true,humanReconciliationRequired:false,ambiguousWriteCount:0,partialWriteCount:0},
  ticketOutcomes:[{ticketNumber:'90101',outcome:'failed',reasonCode:'validation'}],
  mcpExecution:{toolName:'superops_tickets_apply_triage_plan',requestsByType:{metadataValidation:1},requestTrace:[],retryCount:0}};
for (const stage of ['triage_apply','operation_continuation']) for (const retries of [0,6]) {
  test(`terminal validation stops at ${stage}, retry count ${retries}`,async()=>{
    const f=fixture('completed'); f.seed({retryCount:retries});
    const result=await f.engine.reportResult({triggerId:f.state.pendingTriggerId,attempt:1,status:'terminal_failure',metadata:{...terminalValidationMetadata,failureStage:stage}});
    assert.equal(result.status,'terminal_failure'); assert.equal(f.calls.length,0);
    assert.equal(f.state.needsAttentionScopes.length,1); f.advance(); await f.engine.processAlarm(); assert.equal(f.calls.length,0);
  });
}
for (const failureStage of ['configuration','bounded_query','evidence_recovery','triage_apply']) {
  test(`retry exhaustion fences ${failureStage} rather than scheduling again`,async()=>{
    const f=fixture('completed'); f.seed({retryCount:f.config.resultMaxRetries});
    const result=await f.engine.reportResult({triggerId:f.state.pendingTriggerId,attempt:1,status:'terminal_failure',
      metadata:{failureStage,ticketsConsidered:1,ticketsCompleted:0,ticketsDeferred:1}});
    assert.equal(result.status,'terminal_failure'); assert.equal(f.state.needsAttentionScopes.length,1);
    f.advance(); await f.engine.processAlarm(); assert.equal(f.calls.length,0);
  });
}
test('rate-limit exhaustion retains the scope without another dispatch',async()=>{
  const f=fixture('completed'); f.seed({retryCount:f.config.resultMaxRetries});
  const result=await f.engine.reportResult({triggerId:f.state.pendingTriggerId,attempt:1,status:'retryable_rate_limit',retryAfterSeconds:120,
    metadata:{failureStage:'bounded_query',ticketsConsidered:0,ticketsCompleted:0,ticketsDeferred:0}});
  assert.equal(result.status,'terminal_failure'); assert.equal(f.calls.length,0); assert.equal(f.state.needsAttentionScopes.length,1);
});
test('persisted terminal retry from the old coordinator is fenced after restart',async()=>{
  const f=fixture('completed'); f.seed({executionPhase:'retry_wait',retryCount:6,dispatchAttempt:7,dueAt:0,
    lastResultReport:{triggerId:f.state.pendingTriggerId,attempt:7,status:'terminal_failure',metadata:terminalValidationMetadata}});
  assert.equal((await f.engine.processAlarm()).status,'terminal_failure'); assert.equal(f.calls.length,0); assert.equal(f.state.needsAttentionScopes.length,1);
});
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

function firstReadLease(f, change = {}) {
  const accepted=f.state.lastAcceptedTrigger, issuedAt=Date.parse(accepted.acceptedAt);
  return {triggerId:accepted.triggerId,attempt:1,runId:accepted.runId,scope:f.scope,
    issuedAt,expiresAt:issuedAt+f.config.acceptedRunMaxAgeMs,revokedAt:null,authorizedItems:[],
    pendingRead:{requestId:'synthetic-first-read',ownerHash:'12345678',
      nextEligibleAt:'2026-09-24T06:01:00.000Z',deadlineAt:'2026-09-24T06:10:00.000Z'},...change};
}
test('a missing callback after a trusted pending first read resumes the same exact window after revocation',async()=>{
  const f=fixture('completed');f.seed({runWriteLeases:[firstReadLease(f)],lastResultReport:{triggerId:'prior-unrelated-run',attempt:1,status:'terminal_failure',
    metadata:{operationId:'prior-operation',operationStatus:{state:'Failed'}}}});f.expire();
  assert.equal((await f.engine.processAlarm()).status,'retry_scheduled');
  assert.equal(f.calls.length,0);
  assert.equal(f.state.runWriteLeases[0].revokedAt!==null,true);
  assert.equal(f.state.sharedRateLimitUntil,null,'a queued read is not an account rate-limit assertion');
  assert.deepEqual(f.state.pendingTriggerScope,f.scope);
  assert.equal(f.state.needsAttentionScopes.length,0);
  assert(f.state.dispatchHistory.some(event=>event.event==='read_pending_recovered'));
  f.advance();assert.equal((await f.engine.processAlarm()).status,'accepted');
  assert.deepEqual(f.calls[0].slice(0,3),['email-triage:9001',f.scope,2]);
  const latest=f.state.runWriteLeases.at(-1);
  assert.equal(latest.pendingRead.requestId,'synthetic-first-read');
  assert.equal(latest.pendingRead.deadlineAt,'2026-09-24T06:10:00.000Z');
  const state=structuredClone(f.state);
  assert.equal(checkRunWriteLease(state,f.config,{triggerId:'email-triage:9001',attempt:1},Date.parse('2026-09-24T06:02:00Z')).allowed,false);
});
for(const blocker of [
  {queryCompleted:true}, {applyIntentObserved:true}, {writeCheckObserved:true}, {rejectedCallbackUnsafe:true},
  {operationReference:{operationId:'email-triage:9001',ownerHash:'12345678'}}, {authorizedItems:['90101']},
  {pendingRead:{requestId:'synthetic-first-read',ownerHash:'12345678',nextEligibleAt:'2026-09-24T06:01:00.000Z',deadlineAt:'2026-09-24T05:59:00.000Z'}}
]) test('missing-callback read recovery refuses '+Object.keys(blocker)[0],async()=>{
  const f=fixture('completed');f.seed({runWriteLeases:[firstReadLease(f,blocker)]});f.expire();
  await f.engine.processAlarm();assert.equal(f.calls.length,0);assert.equal(f.state.needsAttentionScopes.length,1);
  assert(!f.state.dispatchHistory.some(event=>event.event==='read_pending_recovered'));
});
test('pending first-read recovery stops at the configured retry cap',async()=>{
  const f=fixture('completed');f.seed({runWriteLeases:[firstReadLease(f)],retryCount:f.config.resultMaxRetries});f.expire();
  await f.engine.processAlarm();assert.equal(f.calls.length,0);assert.equal(f.state.needsAttentionScopes.length,1);
});
test('an accepted pending-read callback cannot dispatch again after the fixed journal deadline',async()=>{
  const f=fixture('completed');f.seed({runWriteLeases:[firstReadLease(f)]});
  await f.engine.reportResult({triggerId:f.state.pendingTriggerId,attempt:1,status:'retryable_read_pending',metadata:{failureStage:'bounded_query'}});
  f.setNow('2026-09-24T06:10:00.001Z');
  await f.engine.processAlarm();assert.equal(f.calls.length,0);assert.equal(f.state.needsAttentionScopes.length,1);
  assert(f.state.dispatchHistory.some(event=>event.event==='batch_failed'&&event.failureDiagnostics?.some(d=>d.errorCode==='dispatcher_read_recovery_expired')));
});
for(const status of ['in_progress','queued','suspended','failed','unavailable']) test('pending-read proof cannot replay a '+status+' run',async()=>{
  const f=fixture(status);f.seed({runWriteLeases:[firstReadLease(f)]});f.expire();await f.engine.processAlarm();
  assert.equal(f.calls.length,0);assert(!f.state.dispatchHistory.some(event=>event.event==='read_pending_recovered'));
});
test('pending observations are exact-scope, owner/receipt/deadline stable, and successful queries permanently end first-read recovery',async()=>{
  const now=Date.now(),scope={mode:'new-email-tickets',source:'EMAIL',createdFrom:new Date(now-60000).toISOString(),createdTo:new Date(now).toISOString()};
  const triggerId='triage-44-00000000-0000-4000-8000-000000000044';
  const lease={triggerId,attempt:1,scope,issuedAt:now-30000,expiresAt:now+270000,revokedAt:null,authorizedItems:[]};
  const seed={...createInitialState(),pending:true,executionPhase:'awaiting_result',pendingTriggerId:triggerId,pendingTriggerScope:scope,dispatchAttempt:1,runWriteLeases:[lease]};
  const {coordinator,storage}=replayCoordinator(seed);
  const pendingRead={requestId:'synthetic-pending',ownerHash:'12345678',nextEligibleAt:new Date(now+60000).toISOString(),deadlineAt:new Date(now+900000).toISOString()};
  const observe=body=>coordinator.fetch(new Request('https://coordinator.internal/internal/run-query/observe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({triggerId,attempt:1,createdFrom:scope.createdFrom,createdTo:scope.createdTo,...body})}));
  assert.equal((await observe({pendingRead})).status,200);
  for(const changes of [{requestId:'other'},{ownerHash:'87654321'},{deadlineAt:new Date(now+800000).toISOString()}]){
    assert.equal((await observe({pendingRead:{...pendingRead,...changes}})).status,409);
  }
  assert.equal((await observe({createdTo:new Date(now+1).toISOString(),pendingRead})).status,409);
  assert.equal((await observe({ticketNumbers:['90101']})).status,200);
  assert.equal(storage.value.runWriteLeases[0].queryCompleted,true);
  assert.equal((await observe({pendingRead})).status,409);
});
test('fixed journal labels and all emitted internal statuses satisfy the same callback schema and parser',()=>{
  const schema=toolDefinition().inputSchema.properties.metadata.properties.mcpExecution.properties.requestTrace.items;
  const statuses=schema.properties.status.oneOf[1].enum;
  for(const operationName of ['dispatcherRead.open','dispatcherRead.checkpoint','dispatcherRead.delivered']) {
    assert(new RegExp(schema.properties.operationName.pattern).test(operationName));
    for(const status of statuses) assert(parseSafeMcpExecution({requestTrace:[{index:1,type:'custom',operationType:'durableObject',operationName,status,ok:false}]}));
  }
  for(const operationName of ['dispatcherRead.customer-body','unbounded.other','dispatcherRead.open.secret']) {
    assert.equal(parseSafeMcpExecution({requestTrace:[{index:1,type:'custom',operationName}]}),null);
  }
});
test('rejected callback diagnostics retain only fixed field paths and never raw arguments',async()=>{
  const observations=[];
  const result=await handleTriageResultMcp(new Request('http://local/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'triage_result_report',arguments:{triggerId:'synthetic-trigger',attempt:1,status:'retryable_read_pending',metadata:{mcpExecution:{requestTrace:[{index:1,type:'custom',operationName:'private customer body'}]}}}}})}),{reportRejected:async value=>observations.push(value),report:async()=>{throw Error('Invalid callback must never reach report');}});
  assert.equal((await result.json()).result.isError,true);
  assert.deepEqual(observations[0].validationFields,['metadata.mcpExecution.requestTrace[0]']);
  assert(!JSON.stringify(observations).includes('private customer body'));
});
function operatorReadRecovery(change={}) {
  const triggerId='triage-24-00000000-0000-4000-8000-000000000024';
  const source={...replayFailureEvent,agentRunStatus:'completed',attempt:1};
  const lease={triggerId,attempt:1,runId:'apirun_old',scope:replaySourceScope,issuedAt:1,expiresAt:2,revokedAt:null,authorizedItems:[],...change};
  const seed={...createInitialState(),dispatchHistorySequence:41,dispatchHistory:[source],runWriteLeases:[lease],
    needsAttentionScope:replaySourceScope,needsAttentionScopes:[replaySourceScope],candidateAttentionFenceActive:true};
  const f=replayCoordinator(seed,[source],{TRIAGE_WRITE_GUARD_SERVICE:{fetch:async()=>Response.json({protocol:'triage-run-lease-v1',enforced:true})}});
  const body={triggerId,attempt:1,sourceEventId:41,ticketNumber:'90101',dryRun:true,proof:{requestId:'synthetic-read',
    createdFrom:replaySourceScope.createdFrom,createdTo:replaySourceScope.createdTo,captureIds:['00000000-0000-4000-8000-000000000024']}};
  const request=patch=>f.coordinator.fetch(new Request('https://coordinator.internal/internal/admin/read-recovery',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,...patch})}));
  return {...f,body,request};
}

function operatorStartupRecovery(change={}) {
  const triggerId='triage-24-00000000-0000-4000-8000-000000000024';
  const conversationId='00000000-0000-4000-8000-000000000024';
  const triggerUrl='https://api.chatgpt.com/v1/workspace_agents/agtch_synthetic/trigger';
  const lease={triggerId,attempt:1,runId:'apirun_synthetic',triggerUrl,conversationUrl:`https://chatgpt.com/c/${conversationId}`,
    scope:replaySourceScope,issuedAt:1,expiresAt:2,revokedAt:null,authorizedItems:[],...change};
  const seed={...createInitialState(),triggerSequence:24,dispatchHistorySequence:41,dispatchHistory:[replayFailureEvent],runWriteLeases:[lease],
    needsAttentionScope:replaySourceScope,needsAttentionScopes:[replaySourceScope],candidateAttentionFenceActive:true};
  const f=replayCoordinator(seed,[replayFailureEvent],{TRIAGE_STARTUP_RECOVERY_ENABLED:'true',WORKSPACE_AGENT_ACCESS_TOKEN:'synthetic-access-token',
    TRIAGE_WRITE_GUARD_SERVICE:{fetch:async()=>Response.json(startCapability)}});
  const proof={conversationId,complete:true,workflowStepCount:0,toolCallCount:0,elicitationCount:0,denialObserved:false,
    providerErrorCode:'hermes_gpt_run_failed',providerErrorSubcode:'failed_during_run',providerCanRetry:true};
  const body={triggerId,attempt:1,sourceEventId:41,ticketNumber:'90101',dryRun:true,proof};
  const request=async(patch={})=>{
    const original=globalThis.fetch;
    globalThis.fetch=async()=>Response.json({status:'failed',conversation_url:`https://chatgpt.com/c/${conversationId}`,error:{code:'run_failed'}});
    try { return await f.coordinator.fetch(new Request('https://coordinator.internal/internal/admin/startup-recovery',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,...patch})})); }
    finally { globalThis.fetch=original; }
  };
  return {...f,body,request};
}
test('inspected historical startup failure previews without writes and schedules one reviewed exact ticket',async()=>{
  const f=operatorStartupRecovery(),before=structuredClone(f.storage.value);
  const preview=await f.request();assert.equal(preview.status,200,JSON.stringify(await preview.json()));
  assert.deepEqual(f.storage.value,before);
  const response=await f.request({dryRun:false});assert.equal(response.status,200,JSON.stringify(await response.json()));
  assert.notEqual(f.storage.value.pendingTriggerId,f.body.triggerId);
  assert.deepEqual(f.storage.value.pendingTriggerScope,{...replaySourceScope,targetTicketNumbers:['90101'],replayOfEventId:41});
  assert.deepEqual(f.storage.value.needsAttentionScopes,[replaySourceScope]);
  assert(f.storage.value.runWriteLeases[0].revokedAt!==null);
  assert.equal(f.storage.value.runWriteLeases[0].manualStartupRecoveryRequested,true);
  assert.equal((await f.request({dryRun:false})).status,409);
  f.storage.value.pending=false;
  assert.equal((await f.request({dryRun:false})).status,409,'repeat recovery stays blocked even after a later idle restart');
});
test('legacy accepted record without attempt correlates only by the exact stored provider run ID',async()=>{
  const f=operatorStartupRecovery({triggerUrl:undefined,conversationUrl:undefined});
  f.storage.value.lastAcceptedTrigger={triggerId:f.body.triggerId,runId:'apirun_synthetic',
    triggerUrl:'https://api.chatgpt.com/v1/workspace_agents/agtch_synthetic/trigger',
    conversationUrl:`https://chatgpt.com/c/${f.body.proof.conversationId}`};
  assert.equal((await f.request()).status,200);
  f.storage.value.lastAcceptedTrigger.runId='apirun_other_attempt';
  assert.equal((await f.request({dryRun:false})).status,409);
  assert.equal(f.storage.value.pending,false);
});
for(const blocker of [{mcpWorkStartedAt:1},{pendingRead:{}},{queryCompleted:true},{queryTicketNumbers:[]},{authorizedItems:['90101']},
  {operationReference:{}},{applyIntentObserved:true},{writeCheckObserved:true},{rejectedCallbackUnsafe:true},{manualStartupRecoveryRequested:true}]) {
  test('inspected startup recovery refuses '+Object.keys(blocker)[0],async()=>{
    const f=operatorStartupRecovery(blocker);assert.equal((await f.request({dryRun:false})).status,409);assert.equal(f.storage.value.pending,false);
  });
}
test('inspected startup recovery refuses denial, incomplete workflow, wrong conversation and missing guard',async()=>{
  for(const proofChange of [{denialObserved:true},{complete:false},{workflowStepCount:1},{toolCallCount:1},{elicitationCount:1},
    {providerCanRetry:false},{conversationId:'00000000-0000-4000-8000-000000000025'}]) {
    const f=operatorStartupRecovery();assert([400,409].includes((await f.request({dryRun:false,proof:{...f.body.proof,...proofChange}})).status));
    assert.equal(f.storage.value.pending,false);
  }
  const f=operatorStartupRecovery();f.coordinator.env.TRIAGE_WRITE_GUARD_SERVICE=undefined;
  assert.equal((await f.request({dryRun:false})).status,409);
});
test('work-start acknowledgement persists before execution and rejects late revoked and wrong-attempt calls',async()=>{
  const f=operatorStartupRecovery({issuedAt:Date.now()-1000,expiresAt:Date.now()+60000});
  Object.assign(f.storage.value,{pending:true,pendingTriggerId:f.body.triggerId,pendingTriggerScope:replaySourceScope,
    executionPhase:'awaiting_result',dispatchAttempt:1});
  const request=body=>f.coordinator.fetch(new Request('https://coordinator.internal/internal/run-work/start',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}));
  assert.equal((await request({triggerId:f.body.triggerId,attempt:1})).status,200);
  assert(Number.isFinite(f.storage.value.runWriteLeases[0].mcpWorkStartedAt));
  assert.equal(f.storage.value.dispatchHistory.filter(event=>event.event==='run_work_started').length,1);
  await request({triggerId:f.body.triggerId,attempt:1});
  assert.equal(f.storage.value.dispatchHistory.filter(event=>event.event==='run_work_started').length,1);
  assert.equal((await request({triggerId:f.body.triggerId,attempt:2})).status,409);
  f.storage.value.runWriteLeases[0].revokedAt=Date.now();
  assert.equal((await request({triggerId:f.body.triggerId,attempt:1})).status,409);
});
test('authenticated operator recovery previews without dispatch and schedules one exact ticket using the original read identity',async()=>{
  const f=operatorReadRecovery();const before=structuredClone(f.storage.value);
  const preview=await f.request({});const previewBody=await preview.json();
  assert.equal(preview.status,200,JSON.stringify(previewBody));
  assert.deepEqual(f.storage.value,before);
  const response=await f.request({dryRun:false});assert.equal(response.status,200);
  assert.equal((await response.json()).originalReadIdentityPreserved,true);
  assert.equal(f.storage.value.pendingTriggerId,f.body.triggerId);
  assert.equal(f.storage.value.dispatchAttempt,1,'next dispatch increments the attempt instead of resetting it');
  assert.deepEqual(f.storage.value.pendingTriggerScope,{...replaySourceScope,targetTicketNumbers:['90101'],replayOfEventId:41});
  assert.deepEqual(f.storage.value.needsAttentionScopes,[replaySourceScope]);
  assert(f.storage.value.runWriteLeases[0].revokedAt!==null);
  assert.equal((await f.request({dryRun:false})).status,409);
});
for(const blocker of [{queryCompleted:true},{queryTicketNumbers:[]},{authorizedItems:['90101']},{operationReference:{operationId:'old'}},
  {applyIntentObserved:true},{writeCheckObserved:true},{rejectedCallbackUnsafe:true},{manualReadRecoveryRequested:true}]) {
  test('operator recovery refuses '+Object.keys(blocker)[0],async()=>{
    const f=operatorReadRecovery(blocker);assert.equal((await f.request({dryRun:false})).status,409);assert.equal(f.storage.value.pending,false);
  });
}
test('operator recovery refuses a changed scope or missing live guard',async()=>{
  const f=operatorReadRecovery();assert.equal((await f.request({proof:{...f.body.proof,createdTo:'2026-09-25T11:00:00.000Z'}})).status,409);
  f.coordinator.env.TRIAGE_WRITE_GUARD_SERVICE=undefined;
  assert.equal((await f.request({dryRun:false})).status,409);
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

test('a pending durable read retries its exact window without creating a shared throttle gate',async()=>{
  const f=fixture('completed');
  assert(toolDefinition().inputSchema.properties.status.enum.includes('retryable_read_pending'));
  const result=await f.engine.reportResult({triggerId:f.state.pendingTriggerId,attempt:1,
    status:'retryable_read_pending',retryAfterSeconds:15,metadata});
  assert.equal(result.status,'retry_scheduled');
  assert.equal(f.state.sharedRateLimitUntil,null);
  f.advance();assert.equal((await f.engine.processAlarm()).status,'accepted');
  assert.deepEqual(f.calls[0][1],f.scope);
  assert.equal(f.state.dispatchHistory.find(e=>e.event==='retry_scheduled').resultStatus,'retryable_read_pending');
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

test('100 terminal-failure and duplicate-notification scenarios preserve later dispatch',async()=>{
  for(let i=0;i<100;i++) {
    const f=fixture(i%2===0?'completed':'failed',120000,{graphWebhookClientState:'synthetic-graph-state'});
    const errorCode=i%2===0?'apply_rejected':'ambiguous_write';
    await f.engine.reportResult({triggerId:f.state.pendingTriggerId,attempt:1,status:'terminal_failure',
      metadata:{failureStage:'triage_apply',failureDiagnostics:[{stage:'triage_apply',errorType:'agent_action',errorCode}]}});
    const held=structuredClone(f.state.needsAttentionScopes);
    assert(held.length>0,`failed scope must remain protected in scenario ${i}`);
    const arrivals=Date.parse(f.scope.createdTo)+120000+i*173;
    for(let n=0;n<5;n++) {
      f.setNow(new Date(arrivals+n*137).toISOString());
      const notification={value:[{clientState:'synthetic-graph-state',changeType:'created',resourceData:{id:`synthetic-${i}-${n}`}}]};
      await f.engine.accept(notification);
      await f.engine.accept(notification); // Graph redelivery must not create extra work.
    }
    f.advance();
    assert.equal((await f.engine.processAlarm()).status,'accepted',`fresh work must dispatch in scenario ${i}`);
    assert.equal(f.calls.length,1,`one batch for the burst and redeliveries in scenario ${i}`);
    assert(Date.parse(f.calls[0][1].createdFrom)>=Date.parse(f.scope.createdTo));
    assert.deepEqual(f.state.needsAttentionScopes,held,'never erase/replay an ambiguous or denied old scope');
    assert.equal(f.state.queuedBlockedByAttention,false);
  }
});
test('attention fencing cannot erase an accepted Agent run or create a scope-less global lock',()=>{
  const config=loadConfig(vars),active={...createInitialState(),needsAttentionScope:failedScope,
    needsAttentionScopes:[failedScope],candidateAttentionFenceActive:true,pending:true,pendingReason:'new_message',
    pendingTriggerId:'triage-4-60d4e73d-5c40-4a75-89b5-31ac48f25632',pendingTriggerScope:failedScope,
    pendingNotificationWindowStartedAt:Date.parse(failedScope.createdFrom),pendingNotificationWindowEndedAt:Date.parse(failedScope.createdTo),
    executionPhase:'awaiting_result',dispatchAttempt:1,lastAcceptedTrigger:{triggerId:'triage-4-60d4e73d-5c40-4a75-89b5-31ac48f25632',runId:'apirun_active'}};
  blockPendingIfAttentionOverlaps(active,config,Date.parse(failedScope.createdTo));
  assert.equal(active.pending,true);
  assert.equal(active.executionPhase,'awaiting_result');
  assert.deepEqual(active.pendingTriggerScope,failedScope);
  const lifecycle={...createInitialState(),needsAttentionScope:failedScope,needsAttentionScopes:[failedScope],
    candidateAttentionFenceActive:true,pending:true,pendingReason:'lifecycle',pendingTriggerId:'triage-5-60d4e73d-5c40-4a75-89b5-31ac48f25632',executionPhase:'pending_dispatch'};
  blockPendingIfAttentionOverlaps(lifecycle,config,Date.parse(failedScope.createdTo));
  assert.equal(lifecycle.pending,true);
  assert.equal(lifecycle.queuedPending,false);
  assert.equal(lifecycle.queuedBlockedByAttention,false);
  assert.equal(currentBatchIsFrozen(lifecycle),false,'scope-less lifecycle state cannot freeze a future email');
  const legacyLifecycle={...createInitialState(),needsAttentionScope:failedScope,needsAttentionScopes:[failedScope],
    attentionBlockedWindow:{reason:'new_message',notificationWindowStartedAt:Date.parse(failedScope.createdFrom),
      notificationWindowEndedAt:Date.parse(failedScope.createdTo),notificationLookbackMs:0,lastNotificationAt:Date.parse(failedScope.createdTo),
      debounceWindowStartedAt:null,unavailableRetryCount:0,lifecycleRecoveryRequested:false,lastLifecycleEvent:null},
    queuedPending:true,queuedBlockedByAttention:true,queuedReason:'new_message',queuedLifecycleRecoveryRequested:true,queuedLastLifecycleEvent:'missed'};
  migrateLegacyAttentionBlockedQueue(legacyLifecycle);
  assert.equal(legacyLifecycle.queuedPending,false);
  assert.equal(legacyLifecycle.queuedBlockedByAttention,false);
  assert.equal(legacyLifecycle.lifecycleRecoveryRequested,true,'legacy lifecycle recovery is preserved');
  assert.equal(legacyLifecycle.lastLifecycleEvent,'missed');
});
test('legacy attention-only queue marker migrates away and a new email dispatches',async()=>{
  const f=fixture('completed',120000,{graphWebhookClientState:'synthetic-graph-state'});
  const oldStart=Date.parse('2026-09-15T13:41:12.228Z'),oldEnd=Date.parse('2026-09-25T15:01:45.995Z');
  const fence={reason:'new_message',notificationWindowStartedAt:oldStart,notificationWindowEndedAt:oldEnd,
    notificationLookbackMs:0,lastNotificationAt:oldEnd,debounceWindowStartedAt:null,unavailableRetryCount:0,
    lifecycleRecoveryRequested:false,lastLifecycleEvent:null};
  f.seed({...createInitialState(),attentionBlockedWindow:fence,needsAttentionScope:failedScope,
    needsAttentionScopes:[failedScope],needsAttentionAt:Date.parse('2026-09-26T22:16:35.897Z'),
    queuedPending:true,queuedBlockedByAttention:true,queuedReason:'new_message',queuedDueAt:Date.parse('2026-09-26T22:16:28.232Z')});
  const migrated=structuredClone(f.state);
  migrateLegacyAttentionBlockedQueue(migrated);
  assert.equal(coordinatorProgressFields(migrated).currentAction,'attention_quarantine');
  assert.equal(migrated.queuedPending,false);
  assert.equal(migrated.queuedBlockedByAttention,false);
  f.setNow('2026-09-27T06:30:00Z');
  await f.engine.accept({value:[{clientState:'synthetic-graph-state',changeType:'created',resourceData:{id:'mail-after-attention-fence'}}]});
  assert.equal(f.state.queuedPending,false,'empty legacy queue sentinel is cleared');
  assert.equal(f.state.queuedDueAt,null);
  assert(f.state.attentionBlockedWindow,'the old failed window remains durably fenced');
  assert.equal(f.state.pending,true,'new disjoint email becomes the active pending batch');
  assert.equal(coordinatorProgressFields(f.state).currentAction,'pending_dispatch');
  f.advance();
  assert.equal((await f.engine.processAlarm()).status,'accepted');
  assert.equal(f.calls.length,1);
  assert(f.state.attentionBlockedWindow,'dispatch does not clear the old quarantine');
});
test('an unavailable-trigger retry window does not freeze a disjoint new notification',async()=>{
  const f=fixture('completed',120000,{graphWebhookClientState:'synthetic-graph-state'});
  f.setNow('2026-09-24T09:32:16.410Z');
  const retryAt=Date.parse('2026-09-24T10:00:00Z');
  f.seed({...createInitialState(),unavailableRetryWindow:{scope:failedScope,
    notificationWindowStartedAt:Date.parse(failedScope.createdFrom),notificationWindowEndedAt:Date.parse(failedScope.createdTo),
    notificationLookbackMs:60000,lastNotificationAt:Date.parse(failedScope.createdTo),debounceWindowStartedAt:null,
    retryCount:2,dueAt:retryAt}});
  await f.engine.accept({value:[{clientState:'synthetic-graph-state',changeType:'created',resourceData:{id:'fresh-after-unavailable'}}]});
  assert.equal(f.state.pending,true);
  assert.equal(f.state.queuedPending,false);
  f.advance();
  assert.equal((await f.engine.processAlarm()).status,'accepted');
  assert.equal(f.calls.length,1);
  assert.equal(f.state.unavailableRetryWindow.dueAt,retryAt,'the old retry remains persisted');
});
test('eligible queued email is promoted before a future unavailable retry',async()=>{
  const f=fixture('completed');
  const queueStart=Date.parse('2026-09-24T09:32:00Z'),queueEnd=Date.parse('2026-09-24T09:32:30Z');
  f.setNow('2026-09-24T09:33:00Z');
  f.seed({...createInitialState(),queuedPending:true,queuedReason:'new_message',
    queuedNotificationWindowStartedAt:queueStart,queuedNotificationWindowEndedAt:queueEnd,
    queuedNotificationLookbackMs:0,queuedLastNotificationAt:queueEnd,queuedDebounceWindowStartedAt:queueStart,
    queuedDueAt:Date.parse('2026-09-24T09:32:16Z'),unavailableRetryWindow:{scope:failedScope,
      notificationWindowStartedAt:Date.parse(failedScope.createdFrom),notificationWindowEndedAt:Date.parse(failedScope.createdTo),
      notificationLookbackMs:60000,lastNotificationAt:Date.parse(failedScope.createdTo),debounceWindowStartedAt:null,
      retryCount:2,dueAt:Date.parse('2026-09-24T10:00:00Z')}});
  assert.equal((await f.engine.processAlarm()).status,'accepted');
  assert.equal(f.calls.length,1);
  assert.equal(f.state.unavailableRetryWindow.dueAt,Date.parse('2026-09-24T10:00:00Z'));
  assert.equal(f.state.queuedPending,false);
});
test('retry_wait yields its exact retry to fresh disjoint work, then keeps the retry held',async()=>{
  const f=fixture('completed',120000,{graphWebhookClientState:'synthetic-graph-state'});
  const callback={failureStage:'evidence_recovery',ticketsConsidered:1,ticketsCompleted:0,ticketsDeferred:1,
    failureDiagnostics:[{stage:'evidence_recovery',errorCode:'read_failed',message:'Synthetic no-write failure'}]};
  assert.equal((await f.engine.reportResult({triggerId:f.state.pendingTriggerId,attempt:1,status:'terminal_failure',metadata:callback})).status,'retry_scheduled');
  f.setNow('2026-09-24T06:02:00Z');
  await f.engine.accept({value:[{clientState:'synthetic-graph-state',changeType:'created',resourceData:{id:'fresh-during-retry-wait'}}]});
  assert.equal(f.state.pending,true);
  assert.equal(f.state.executionPhase,'pending_dispatch');
  assert.deepEqual(f.state.reconciliationHold.scope,f.scope,'the original retry keeps its exact scope');
  assert.equal(f.state.queuedPending,false);
  assert(f.state.dispatchHistory.some(event=>event.event==='retry_yielded_to_fresh_work'));
  f.advance();
  assert.equal((await f.engine.processAlarm()).status,'accepted');
  assert.equal(f.calls.length,1);
  assert(Date.parse(f.calls[0][1].createdFrom)>=Date.parse(f.scope.createdTo));
  assert.deepEqual(f.state.reconciliationHold.scope,f.scope);
});
test('retry_wait with an active Agent run waits for drain, then releases fresh work',async()=>{
  const f=fixture('in_progress',120000,{graphWebhookClientState:'synthetic-graph-state'});
  const callback={failureStage:'evidence_recovery',ticketsConsidered:1,ticketsCompleted:0,ticketsDeferred:1,
    failureDiagnostics:[{stage:'evidence_recovery',errorCode:'read_failed',message:'Synthetic no-write failure'}]};
  assert.equal((await f.engine.reportResult({triggerId:f.state.pendingTriggerId,attempt:1,status:'terminal_failure',metadata:callback})).status,'retry_scheduled');
  f.setNow('2026-09-24T06:02:00Z');
  await f.engine.accept({value:[{clientState:'synthetic-graph-state',changeType:'created',resourceData:{id:'fresh-during-active-retry-run'}}]});
  f.setNow(new Date(f.state.queuedDueAt).toISOString());
  assert.equal((await f.engine.processAlarm()).status,'awaiting_result');
  assert.equal(f.calls.length,0,'one-active-run rule is preserved');
  f.setRunStatus('completed');
  f.setNow(new Date(f.alarms.at(-1)).toISOString());
  assert.equal((await f.engine.processAlarm()).status,'fresh_work_promoted');
  assert.equal(f.calls.length,0);
  assert.equal((await f.engine.processAlarm()).status,'accepted');
  assert.equal(f.calls.length,1);
  assert.deepEqual(f.state.reconciliationHold.scope,f.scope);
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
const dispatcherFailureTrace={index:3,provider:'dispatcher',type:'write',operationType:'mutation',
  operationName:'updateTicket',itemKey:'62966',status:'dispatcherUncertain',retryCount:0,
  startedAt:'2026-09-24T06:00:02.000Z',completedAt:'2026-09-24T06:00:04.000Z',
  endpointHost:'superops-api-dispatcher.taskgroup.co.uk',outcome:'dispatcher_uncertain',ok:false,
  dispatcherRequestId:'synthetic-request-uncertain',dispatcherState:'uncertain',
  dispatcherHttpStatus:200,upstreamHttpStatus:200,dispatcherErrorCode:'GRAPHQL_ERROR',
  dispatcherDiagnostics:{schemaVersion:1,status:'uncertain',attemptCount:1,upstreamHttpStatus:200,
    errorClassification:'GRAPHQL_ERROR',uncertain:true,attemptsTruncated:false,
    attempts:[{attemptId:7,attemptNumber:1,startedAt:'2026-09-24T06:00:03.000Z',
      completedAt:'2026-09-24T06:00:04.000Z',upstreamHttpStatus:200,classification:'GRAPHQL_ERROR',
      responseState:'partial_data',responseHadData:true,
      graphqlErrors:[{code:'INTERNAL_SERVER_ERROR',path:['updateTicket','ticket',0]}],
      uncertain:true,retryDecision:'not_scheduled',retryReason:'ambiguous_mutation_requires_reconciliation',retryAfterMs:0}]},
  dispatcherDiagnosticRetrieval:{status:'failed',category:'http_403',dispatcherHttpStatus:403}};
test('dispatcher transport, failure, attempt, and poll telemetry survive the callback parser exactly',()=>{
  const execution={toolName:'superops_tickets_query',subrequestsUsed:2,
    requestsByType:{paginationRead:1,dispatcherPoll:1,write:1},requestTrace:[dispatcherTrace,
      dispatcherFailureTrace,
      {...dispatcherTrace,index:2,type:'dispatcherPoll',operationName:'dispatcherStatus'}]};
  assert.deepEqual(parseSafeMcpExecution(execution),execution);
  const schema=toolDefinition().inputSchema.properties.metadata.properties.mcpExecution;
  assert.equal(schema.additionalProperties,false);
  assert(schema.properties.requestsByType.properties.dispatcherPoll);
  const traceSchema=schema.properties.requestTrace.items;
  assert.equal(traceSchema.additionalProperties,false);
  assert(traceSchema.properties.type.enum.includes('dispatcherPoll'));
  for(const key of Object.keys(dispatcherTrace)) assert(traceSchema.properties[key],key);
  for(const key of Object.keys(dispatcherFailureTrace)) assert(traceSchema.properties[key],key);
  assert.equal(traceSchema.properties.dispatcherDiagnostics.properties.schemaVersion.enum[0],1);
  assert.equal(traceSchema.properties.dispatcherDiagnosticRetrieval.properties.status.enum[0],'failed');
  for(const invalid of [
    {dispatcherDiagnostics:{...dispatcherFailureTrace.dispatcherDiagnostics,requestBody:'private'}},
    {dispatcherDiagnostics:{...dispatcherFailureTrace.dispatcherDiagnostics,attempts:[{...dispatcherFailureTrace.dispatcherDiagnostics.attempts[0],graphqlErrors:[{message:'customer text'}]}]}},
    {dispatcherDiagnosticRetrieval:{status:'failed',category:'http_403',headers:{authorization:'secret'}}}
  ]) assert.equal(parseSafeMcpExecution({requestTrace:[{...dispatcherFailureTrace,...invalid}]}),null);
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
