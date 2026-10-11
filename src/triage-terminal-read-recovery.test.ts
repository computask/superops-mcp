import {describe,it,expect} from "vitest";
import {historicalFailedReadProof} from "./triage-terminal-read-recovery.js";
import {failedReadCaptures} from "./test-fixtures/triage-failed-reads.js";
const triggerId="triage-24-00000000-0000-4000-8000-000000000024";
describe("inspected historical failed-read recovery",()=>{
  it("requires positive 401 evidence in every read-only attempt and projects only fixed identity, scope and audit references",()=>{
    const proof=historicalFailedReadProof(failedReadCaptures(),triggerId,3,"90101");
    expect(proof).toMatchObject({ticketNumber:"90101",ticketId:"1000000000000000001",attempts:[1,2,3],
      failedRequestIds:["00000000-0000-4000-8000-000000000081","00000000-0000-4000-8000-000000000084"]});
    expect(proof?.captureIds).toHaveLength(5);expect(JSON.stringify(proof)).not.toMatch(/requestTrace|mcpExecution|content|note|credential/);
  });
  it.each(["gap","incomplete","missing_attempt","missing_capture","more","write_tool","mutation","partial_query","other_ticket","foreign_attempt",
    "unproven_failure","unknown_reply","duplicate_capture","trace_gap"])("refuses %s evidence",fault=>{
    const pages=failedReadCaptures();
    if(fault==="gap")pages[1].captureFailureCount=1;
    if(fault==="incomplete")pages[1].incompleteRecordCount=1;
    if(fault==="missing_attempt")pages.pop();
    if(fault==="missing_capture")pages[0].records.pop();
    if(fault==="more")pages[2].hasMore=true;
    if(fault==="write_tool")pages[0].records[1].toolName="superops_tickets_apply_triage_plan";
    if(fault==="foreign_attempt")pages[2].records[0].input.triageCapture.attempt=1;
    if(fault==="duplicate_capture")pages[2].records[0].captureId=pages[1].records[0].captureId;
    if(["mutation","unproven_failure","unknown_reply","trace_gap"].includes(fault)) {
      const body=JSON.parse(pages[2].records[0].output.content[0].text);
      if(fault==="mutation")body.mcpExecution.requestTrace[0].operationType="mutation";
      if(fault==="unproven_failure")body.mcpExecution.requestTrace[0].dispatcherState="uncertain";
      if(fault==="unknown_reply")delete body.mcpExecution.requestTrace[0].httpStatus;
      if(fault==="trace_gap")body.mcpExecution.requestTraceTruncated=true;
      pages[2].records[0].output.content[0].text=JSON.stringify(body);
    }
    if(["partial_query","other_ticket"].includes(fault)) {
      const body=JSON.parse(pages[0].records[0].output.content[0].text);
      if(fault==="partial_query")body.pagination.complete=false;
      else body.records[0].displayId="90102";
      pages[0].records[0].output.content[0].text=JSON.stringify(body);
    }
    expect(historicalFailedReadProof(pages,triggerId,3,"90101")).toBeUndefined();
  });
});
