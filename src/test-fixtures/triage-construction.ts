// Synthetic, content-free evidence for the argument-construction regression.
export function constructionWorkflow() {
  return {conversationId:"00000000-0000-4000-8000-000000000001",complete:true,workflowStepCount:8,
    toolNames:["superops_tickets_query","superops_tickets_triage_evidence_recover","superops_tickets_field_options",
      "superops_tickets_prepare_triage_plan","superops_tickets_prepare_triage_plan","triage_result_report"],
    elicitationCount:0,denialObserved:false,preparationSchemaRejections:2,resultSchemaRejections:1,
    preparationErrorCode:"missing_action_ticket_number",rejectedReasonCode:"plan_validation_failed"};
}
export function constructionCaptures(triggerId = "triage-24-00000000-0000-4000-8000-000000000024", attempt = 1) {
  const createdFrom="2026-10-11T00:00:00.000Z",createdTo="2026-10-11T00:02:00.000Z";
  const bodies: Record<string, any>[] = [
    {records:[{ticketId:"1000000000000000001",displayId:"90101"}],pagination:{complete:true,truncated:false},errors:[]},
    {complete:true,requestedCount:1,recoveredCount:1},
    {impact:[],urgency:[],subcategory:[],cause:[],resolutionCode:[]},
  ];
  const inputs = [
    {createdFrom,createdTo,status:["New Calls"],sources:["EMAIL"],fieldProfile:"minimal"},
    {ticketIds:["1000000000000000001"]}, {fields:["impact","urgency","subcategory"]},
  ];
  const records = bodies.map((body,i)=>({captureId:`00000000-0000-4000-8000-00000000000${i+1}`,captureStatus:"complete",
    toolName:constructionWorkflow().toolNames[i],startedAt:`2026-10-11T00:03:0${i*2}.000Z`,completedAt:`2026-10-11T00:03:0${i*2+1}.000Z`,
    input:{...inputs[i],triageCapture:{triggerId,attempt}},output:{content:[{type:"text",text:JSON.stringify({...body,
      mcpExecution:{requestsByType:{verificationRead:1},requestTrace:[{index:1,type:"verificationRead",operationType:"query",operationName:"getTicket",ok:true}]}})}]}}));
  return {complete:true,hasMore:false,totalRecords:3,captureFailureCount:0,incompleteRecordCount:0,truncated:false,records};
}
