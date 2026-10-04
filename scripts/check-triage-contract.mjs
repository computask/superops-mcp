import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {normalizeBuilderPolicy, normalizePolicyParagraphs} from './triage-policy-text.mjs';

const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
const version=read('src/triage-contract.ts').match(/TRIAGE_POLICY_CONTRACT_VERSION = "([^"]+)"/)[1];
const instructions=read('agent/superops-triage-instructions.md');
assert(instructions.includes('Policy contract version: '+version));
assert(read('workers/support-triage-trigger/src/index.js').includes('Policy contract version: '+version));
for(const requirement of ['superops_tickets_prepare_triage_plan','operationCreated:false','preparationFingerprint','Do not retry apply after ANY response','TaskGroup','2993553194649526272','history remains paused']) assert(instructions.includes(requirement),requirement);
const sha256=text=>createHash('sha256').update(text).digest('hex');
const canonicalText=normalizePolicyParagraphs(instructions);
console.log(JSON.stringify({policyContractVersion:version,instructionsSha256:sha256(instructions),policyTextSha256:sha256(canonicalText)}));
// Optional supported-UI readback exports: do not assume publication synchronizes a channel.
for(const path of process.argv.slice(2)) {
  const readback=readFileSync(path,'utf8');
  assert(normalizeBuilderPolicy(readback)===canonicalText,`Live instruction drift: ${path}`);
  console.log(JSON.stringify({readbackPath:path,rawSha256:sha256(readback),policyTextSha256:sha256(normalizeBuilderPolicy(readback)),matches:true}));
}
