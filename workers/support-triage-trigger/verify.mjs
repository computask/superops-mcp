import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const wranglerRequire=createRequire(require.resolve('wrangler/package.json'));
const {Miniflare}=wranglerRequire('miniflare');
const code=readFileSync(new URL('./src/index.js',import.meta.url));
assert.equal(createHash('sha256').update(code).digest('hex'),'9c0196e17d1ceac67879bd967698dfe94ab30b3cab10f3664e8d001b3ba0f2e7','Reviewed production module must match the provenance record');
const config=JSON.parse(readFileSync(new URL('./wrangler.jsonc',import.meta.url),'utf8'));
assert.equal(config.name,'support-triage-trigger');
assert.equal(config.no_bundle,true);
assert.equal(config.vars.TRIAGE_TRIGGER_SCOPE_MODE,'new-email-tickets');
assert.equal(config.vars.TRIAGE_RECONCILIATION_ELIGIBILITY_SEPARATION_ENABLED,'true');
assert.equal(config.vars.TRIAGE_ATTENTION_TAIL_ISOLATION_ENABLED,'true');
assert.deepEqual(config.durable_objects.bindings,[{name:'TRIAGE_COORDINATOR',class_name:'TriageCoordinator'}]);
assert.deepEqual(config.migrations,[{tag:'v1',new_sqlite_classes:['TriageCoordinator']}]);
assert.equal(config.compatibility_date,'2026-08-14');
assert(!/https:\/\/(?:eu)?api\.superops\.ai/.test(code.toString()));
for(const name of ['GRAPH_CLIENT_ID','GRAPH_CLIENT_SECRET','GRAPH_TENANT_ID','GRAPH_WEBHOOK_CLIENT_STATE','WORKSPACE_AGENT_ACCESS_TOKEN','TRIAGE_HISTORY_RESET_TOKEN']) assert(!(name in config.vars),'Secret must not be committed: '+name);
let outbound=0;
const mf=new Miniflare({modules:true,scriptPath:fileURLToPath(new URL('./src/index.js',import.meta.url)),
  // Pinned Wrangler's local workerd is older than production's preserved date.
  compatibilityDate:'2026-07-01', bindings:{...config.vars,AUTOMATED_TRIAGE_TRIGGER_ENABLED:'false'},
  durableObjects:{TRIAGE_COORDINATOR:{className:'TriageCoordinator',useSQLite:true}},
  outboundService:()=>{outbound++;throw Error('Local test must not make external requests');},
});
try {
  const health=await (await mf.dispatchFetch('http://local/health')).json();
  assert.equal(health.ok,true);assert.equal(health.automatedTriageTriggerEnabled,false);
  assert.equal(health.triageAttentionTailIsolationEnabled,true);
  assert.equal(health.callsSuperOpsDirectly,false);assert.equal(health.consumesEmailBodies,false);
  assert.equal((await mf.dispatchFetch('http://local/admin/history/reset',{method:'POST'})).status,401);
  assert.equal((await mf.dispatchFetch('http://local/history?beforeEventId=1')).status,400);
  const validation=await mf.dispatchFetch('http://local/graph/notifications?validationToken=synthetic-validation',{method:'POST'});
  assert.equal(validation.status,200);assert.equal(await validation.text(),'synthetic-validation');
  assert.equal(outbound,0);
  console.log('PASS: exact production module, deployment identity, config/secret boundaries, workerd health, history guard, admin auth and Graph validation; zero external calls.');
} finally {await mf.dispose();}
