import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const wranglerRequire=createRequire(require.resolve('wrangler/package.json'));
const {Miniflare}=wranglerRequire('miniflare');
const code=readFileSync(new URL('./src/index.js',import.meta.url));
assert.equal(createHash('sha256').update(code).digest('hex'),'ce233232d6266ffd2cd4eb0c9d2ad3b0aac20548dd6d6bac1e4834faa067b48c','Reviewed production module must match the provenance record');
const config=JSON.parse(readFileSync(new URL('./wrangler.jsonc',import.meta.url),'utf8'));
assert.equal(config.name,'support-triage-trigger');
assert.equal(config.no_bundle,true);
assert.equal(config.vars.TRIAGE_TRIGGER_SCOPE_MODE,'new-email-tickets');
assert.equal(config.vars.TRIAGE_RECONCILIATION_ELIGIBILITY_SEPARATION_ENABLED,'true');
assert.equal(config.vars.TRIAGE_ATTENTION_TAIL_ISOLATION_ENABLED,'true');
assert.deepEqual(config.durable_objects.bindings,[{name:'TRIAGE_COORDINATOR',class_name:'TriageCoordinator'},
  {name:'SUPEROPS_OPERATION_LEDGER',class_name:'SuperOpsOperationLedger',script_name:'superops-mcp'}]);
assert.deepEqual(config.migrations,[{tag:'v1',new_sqlite_classes:['TriageCoordinator']}]);
assert.equal(config.compatibility_date,'2026-08-14');
assert(!/https:\/\/(?:eu)?api\.superops\.ai/.test(code.toString()));
for(const name of ['GRAPH_CLIENT_ID','GRAPH_CLIENT_SECRET','GRAPH_TENANT_ID','GRAPH_WEBHOOK_CLIENT_STATE','WORKSPACE_AGENT_ACCESS_TOKEN','TRIAGE_HISTORY_RESET_TOKEN','TRIAGE_REPLAY_ADMIN_TOKEN','TRIAGE_CAPTURE_READ_TOKEN']) assert(!(name in config.vars),'Secret must not be committed: '+name);
let outbound=0;
const mf=new Miniflare({modules:true,scriptPath:fileURLToPath(new URL('./src/index.js',import.meta.url)),
  // Pinned Wrangler's local workerd is older than production's preserved date.
  compatibilityDate:'2026-07-01', bindings:{...config.vars,AUTOMATED_TRIAGE_TRIGGER_ENABLED:'false',TRIAGE_REPLAY_ADMIN_TOKEN:'synthetic-replay-admin-token',TRIAGE_CAPTURE_READ_TOKEN:'synthetic-capture-read-token'},
  durableObjects:{TRIAGE_COORDINATOR:{className:'TriageCoordinator',useSQLite:true}},
  outboundService:()=>{outbound++;throw Error('Local test must not make external requests');},
});
try {
  const health=await (await mf.dispatchFetch('http://local/health')).json();
  assert.equal(health.ok,true);assert.equal(health.automatedTriageTriggerEnabled,false);
  assert.equal(health.triageAgentCaptureEnabled,true);
  assert.equal(health.triageAttentionTailIsolationEnabled,true);
  assert.equal(health.callsSuperOpsDirectly,false);assert.equal(health.consumesEmailBodies,false);
  assert.equal((await mf.dispatchFetch('http://local/admin/history/reset',{method:'POST'})).status,401);
  assert.equal((await mf.dispatchFetch('http://local/admin/replay',{method:'POST'})).status,401);
  assert.equal((await mf.dispatchFetch('http://local/admin/run/recover',{method:'POST'})).status,401);
  assert.equal((await mf.dispatchFetch('http://local/internal/run-lease/check',{method:'POST',body:'{}'})).status,404);
  assert.equal((await mf.dispatchFetch('http://local/internal/run-query/observe',{method:'POST',body:'{}'})).status,404);
  assert.equal((await mf.dispatchFetch('http://local/internal/run-work/start',{method:'POST',body:'{}'})).status,404);
  assert.equal((await mf.dispatchFetch('http://local/internal/admin/startup-recovery',{method:'POST',body:'{}'})).status,404);
  assert.equal((await mf.dispatchFetch('http://local/admin/run/recover',{method:'POST',headers:{Authorization:'Bearer synthetic-replay-admin-token','Content-Type':'application/json'},body:'{}'})).status,409);
  assert.equal((await mf.dispatchFetch('http://local/admin/replay',{method:'POST',headers:{Authorization:'Bearer wrong-token'},body:'{}'})).status,401);
  assert.equal((await mf.dispatchFetch('http://local/admin/replay',{method:'POST',headers:{Authorization:'Bearer synthetic-replay-admin-token','Content-Type':'application/json'},body:'{}'})).status,400);
  const captureUrl='http://local/admin/agent-capture?triggerId=triage-1-00000000-0000-4000-8000-000000000001&attempt=1';
  assert.equal((await mf.dispatchFetch(captureUrl)).status,401);
  assert.equal((await mf.dispatchFetch(captureUrl,{headers:{Authorization:'Bearer wrong-token'}})).status,401);
  const capture=await mf.dispatchFetch(captureUrl,{headers:{Authorization:'Bearer synthetic-capture-read-token'}});
  assert.equal(capture.status,200);assert.equal(capture.headers.get('Cache-Control'),'no-store, private');
  assert.deepEqual(await capture.json(),{triggerId:'triage-1-00000000-0000-4000-8000-000000000001',attempt:1,retentionDays:7,records:[],captureFailures:[],captureFailureCount:0,presentKinds:[],missingKinds:['agent_input'],optionalKinds:['apply_intent'],complete:false,truncated:true,truncationReason:'requiredCaptureMissing'});
  const sequenceCaptureUrl='http://local/admin/agent-capture?batchSequence=1&attempt=1';
  assert.equal((await mf.dispatchFetch(sequenceCaptureUrl)).status,401);
  assert.equal((await mf.dispatchFetch(sequenceCaptureUrl,{headers:{Authorization:'Bearer wrong-token'}})).status,401);
  const sequenceCapture=await mf.dispatchFetch(sequenceCaptureUrl,{headers:{Authorization:'Bearer synthetic-capture-read-token'}});
  assert.equal(sequenceCapture.status,404);assert.deepEqual(await sequenceCapture.json(),{error:'capture_not_found'});
  assert.equal((await mf.dispatchFetch('http://local/admin/agent-capture?triggerId=triage-1-00000000-0000-4000-8000-000000000001&batchSequence=1&attempt=1',{headers:{Authorization:'Bearer synthetic-capture-read-token'}})).status,400);
  const toolList=await mf.dispatchFetch('http://local/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});
  assert.deepEqual((await toolList.json()).result.tools.map(tool=>tool.name),['triage_result_report','triage_apply_intent_report']);
  const staleIntent=await mf.dispatchFetch('http://local/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'triage_apply_intent_report',arguments:{triggerId:'triage-1-00000000-0000-4000-8000-000000000001',attempt:1,applyArguments:{expectedCandidateTicketNumbers:['62992'],actions:[]}}}})});
  assert.equal(staleIntent.status,200);assert.equal((await staleIntent.json()).result.isError,true);
  assert.equal((await mf.dispatchFetch('http://local/history?beforeEventId=1')).status,400);
  const history=await mf.dispatchFetch('http://local/history?limit=5');
  assert.equal(history.status,200);assert.deepEqual((await history.json()).events,[]);
  const validation=await mf.dispatchFetch('http://local/graph/notifications?validationToken=synthetic-validation',{method:'POST'});
  assert.equal(validation.status,200);assert.equal(await validation.text(),'synthetic-validation');
  assert.equal(outbound,0);
  console.log('PASS: exact production module, deployment identity, config/secret boundaries, workerd health, history guard, admin auth and Graph validation; zero external calls.');
} finally {await mf.dispose();}
