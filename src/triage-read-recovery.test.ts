import {describe,expect,it} from "vitest";
import {firstReadRecoveryProof} from "./triage-read-recovery.js";

function page() {
  const args={createdFrom:"2026-10-09T04:00:00.000Z",createdTo:"2026-10-09T04:02:00.000Z",
    status:["New Calls"],sources:["EMAIL"],fieldProfile:"minimal"};
  const output={content:[{type:"text",text:JSON.stringify({records:[],pagination:{complete:false,stopReason:"fetchError"},
    mcpExecution:{requestsByType:{paginationRead:1},requestTrace:[{operationName:"getTicketList",operationType:"query",ok:false,
      dispatcherState:"queued",errorClass:"Dispatcher_pending",dispatcherRequestId:"synthetic-read"}]}})}]};
  return {complete:true,hasMore:false,captureFailureCount:0,records:[{captureId:"00000000-0000-4000-8000-000000000001",
    captureStatus:"complete",toolName:"superops_tickets_query",input:args,output}]};
}
describe("operator first-read-only recovery proof",()=>{
  it("projects an old partial query into only its exact scope, receipt and capture identity",()=>{
    const evidence=page();
    expect(firstReadRecoveryProof(evidence)).toEqual({requestId:"synthetic-read",createdFrom:evidence.records[0].input.createdFrom,
      createdTo:evidence.records[0].input.createdTo,captureIds:[evidence.records[0].captureId]});
  });
  it.each(["incomplete","gap","more","other_tool","partial_records","writes","different_scope","different_receipt","other_filter"])("refuses %s",fault=>{
    const evidence=page();
    if(fault==="incomplete") evidence.complete=false;
    if(fault==="gap") evidence.captureFailureCount=1;
    if(fault==="more") evidence.hasMore=true;
    if(fault==="other_tool") evidence.records[0].toolName="superops_tickets_apply_triage_plan";
    if(fault==="other_filter") Object.assign(evidence.records[0].input,{clientId:"synthetic-client"});
    if(fault==="different_scope" || fault==="different_receipt") {
      evidence.records.push(structuredClone(evidence.records[0]));
      if(fault==="different_scope") evidence.records[1].input.createdFrom="2026-10-09T04:01:00.000Z";
    }
    const index=fault==="different_receipt"?1:0;
    const output=JSON.parse(evidence.records[index].output.content[0].text);
    if(fault==="partial_records") output.records=[{displayId:"90101"}];
    if(fault==="writes") output.mcpExecution.requestsByType.write=1;
    if(fault==="different_receipt") output.mcpExecution.requestTrace[0].dispatcherRequestId="other-read";
    evidence.records[index].output.content[0].text=JSON.stringify(output);
    expect(firstReadRecoveryProof(evidence)).toBeUndefined();
  });
});
