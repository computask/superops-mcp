import {describe,expect,it} from "vitest";
import {constructionCaptureProof,inspectedConstructionProof} from "./triage-construction-recovery.js";
import {constructionCaptures,constructionWorkflow} from "./test-fixtures/triage-construction.js";
const triggerId="triage-24-00000000-0000-4000-8000-000000000024";
describe("inspected read-only construction recovery",()=>{
  it("projects exactly the three successful correlated reads without content",()=>{
    expect(inspectedConstructionProof(constructionWorkflow())).toBe(true);
    expect(constructionCaptureProof(constructionCaptures(),triggerId,1,"90101")).toEqual({
      createdFrom:"2026-10-11T00:00:00.000Z",createdTo:"2026-10-11T00:02:00.000Z",ticketNumber:"90101",ticketId:"1000000000000000001",
      captureIds:[1,2,3].map(i=>`00000000-0000-4000-8000-00000000000${i}`)});
  });
  it.each([{complete:false},{denialObserved:true},{elicitationCount:1},{workflowStepCount:4},{preparationSchemaRejections:1},
    {resultSchemaRejections:0},{preparationErrorCode:"unknown"},{rejectedReasonCode:"permission_denied"},{conversationId:"not-a-uuid"},
    {toolNames:[...constructionWorkflow().toolNames,"superops_tickets_apply_triage_plan"]},
    {toolNames:["superops_tickets_query","superops_tickets_triage_evidence_recover","superops_tickets_field_options","superops_tickets_apply_triage_plan","superops_tickets_prepare_triage_plan","triage_result_report"]},
    {extra:"synthetic unbounded text"}])("refuses incomplete, denied, changed or write workflows %j",change=>{
    expect(inspectedConstructionProof({...constructionWorkflow(),...change})).toBe(false);
  });
  it("also permits the same observed failure after just one rejected preparation",()=>{
    const proof=constructionWorkflow();proof.toolNames.splice(4,1);proof.preparationSchemaRejections=1;
    expect(inspectedConstructionProof(proof)).toBe(true);
  });
  it.each(["incomplete","gap","missing","more","truncated","other_tool","duplicate","uncorrelated","different_attempt","error_result",
    "write_count","write_trace","trace_gap","failed_read","pending","operation","two_candidates","different_ticket","different_identity",
    "partial_query","other_filter","partial_evidence","overlapping_calls"])("refuses %s corroboration",fault=>{
    const page=constructionCaptures();
    if(fault==="incomplete") page.complete=false;
    if(fault==="gap") page.captureFailureCount=1;
    if(fault==="missing") page.incompleteRecordCount=1;
    if(fault==="more") page.hasMore=true;
    if(fault==="truncated") page.truncated=true;
    if(fault==="other_tool") page.records[2].toolName="superops_tickets_apply_triage_plan";
    if(fault==="duplicate") page.records[2].captureId=page.records[1].captureId;
    if(fault==="uncorrelated") page.records[2].input.triageCapture.triggerId="different";
    if(fault==="different_attempt") page.records[2].input.triageCapture.attempt=2;
    if(fault==="error_result") Object.assign(page.records[2].output,{isError:true});
    if(fault==="overlapping_calls") page.records[1].startedAt=page.records[0].startedAt;
    if(fault==="other_filter") Object.assign(page.records[0].input,{clientId:"extra"});
    if(fault==="different_identity") Object.assign(page.records[1].input,{ticketIds:["1000000000000000002"]});
    const index=fault==="partial_evidence"?1:fault.includes("query")||fault.includes("candidate")||fault==="different_ticket"?0:2;
    const body=JSON.parse(page.records[index].output.content[0].text);
    if(fault==="write_count") body.mcpExecution.requestsByType.write=1;
    if(fault==="write_trace") body.mcpExecution.requestTrace[0].operationType="mutation";
    if(fault==="trace_gap") body.mcpExecution.requestTraceTruncated=true;
    if(fault==="failed_read") body.mcpExecution.requestTrace[0].ok=false;
    if(fault==="pending") body.dispatcherPending=true;
    if(fault==="operation") body.operationId="synthetic-operation";
    if(fault==="two_candidates") body.records.push({ticketId:"1000000000000000002",displayId:"90102"});
    if(fault==="different_ticket") body.records[0].displayId="90102";
    if(fault==="partial_query") body.pagination.complete=false;
    if(fault==="partial_evidence") body.complete=false;
    page.records[index].output.content[0].text=JSON.stringify(body);
    expect(constructionCaptureProof(page,triggerId,1,"90101")).toBeUndefined();
  });
});
