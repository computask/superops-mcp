import {constructionCaptures} from "./triage-construction.js";
export function failedReadCaptures(triggerId="triage-24-00000000-0000-4000-8000-000000000024") {
  const first=constructionCaptures(triggerId),failure=(requestId:string)=>({requestsByType:{initialRead:1},requestTrace:[{
    index:1,type:"initialRead",operationType:"query",operationName:"getTicketList",ok:false,dispatcherState:"failed",httpStatus:401,dispatcherRequestId:requestId}]});
  const fields=first.records[2];
  Object.assign(fields.output,{isError:true,content:[{type:"text",text:JSON.stringify({mcpExecution:failure("00000000-0000-4000-8000-000000000081")})}]});
  return [first,...[2,3].map(attempt=>({...first,totalRecords:1,records:[{...first.records[0],
    captureId:`00000000-0000-4000-8000-00000000008${attempt}`,input:{...first.records[0].input,triageCapture:{triggerId,attempt}},
    output:{isError:true,content:[{type:"text",text:JSON.stringify({records:[],pagination:{complete:false,truncated:true},
      mcpExecution:failure("00000000-0000-4000-8000-000000000084")})}]}}]}))];
}
