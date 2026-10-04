import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
const version=read('src/triage-contract.ts').match(/TRIAGE_POLICY_CONTRACT_VERSION = "([^"]+)"/)[1];
const instructions=read('agent/superops-triage-instructions.md');
assert(instructions.includes('Policy contract version: '+version));
assert(read('workers/support-triage-trigger/src/index.js').includes('Policy contract version: '+version));
for(const requirement of ['superops_tickets_prepare_triage_plan','operationCreated:false','preparationFingerprint','Do not retry apply after ANY response','TaskGroup','2993553194649526272','history remains paused']) assert(instructions.includes(requirement),requirement);
console.log(JSON.stringify({policyContractVersion:version,instructionsSha256:createHash('sha256').update(instructions).digest('hex')}));
// Optional supported-UI readback exports: do not assume publication synchronizes a channel.
for(const path of process.argv.slice(2)) {
  const readback=readFileSync(path,'utf8');
  assert.equal(readback.replace(/\r\n/g,'\n').trim(),instructions.replace(/\r\n/g,'\n').trim(),`Live instruction drift: ${path}`);
}
