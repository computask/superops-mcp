/** Sam-authorized historical recovery, corroborated by every retained MCP call.
 * Positive failed-read evidence is required; absence of writes alone is insufficient. */
const object = (v: unknown): v is Record<string, any> => Boolean(v && typeof v === "object" && !Array.isArray(v));
const uuid = (v: unknown) => typeof v === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
const readTools = new Set(["superops_tickets_query","superops_tickets_triage_evidence_recover","superops_tickets_field_options"]);
export interface HistoricalFailedReadProof {
  createdFrom: string; createdTo: string; ticketNumber: string; ticketId: string;
  captureIds: string[]; failedRequestIds: string[]; attempts: number[];
}
export function historicalFailedReadProof(pages: unknown[], triggerId: string, lastAttempt: number, ticketNumber: string): HistoricalFailedReadProof | undefined {
  if (!Number.isInteger(lastAttempt) || lastAttempt < 1 || lastAttempt > 3 || pages.length !== lastAttempt) return;
  const captureIds: string[] = [], failedRequestIds = new Set<string>();
  let candidate: {createdFrom: string; createdTo: string; ticketNumber: string; ticketId: string} | undefined;
  for (const [index,page] of pages.entries()) {
    if (!object(page) || page.complete !== true || page.hasMore !== false || page.captureFailureCount !== 0 ||
        page.incompleteRecordCount !== 0 || page.truncated === true || !Array.isArray(page.records) ||
        page.records.length < 1 || page.records.length > 5 || page.totalRecords !== page.records.length) return;
    let failedReadObserved = false;
    for (const capture of page.records) {
      if (!object(capture) || !readTools.has(capture.toolName) || capture.captureStatus !== "complete" || !uuid(capture.captureId) ||
          !object(capture.input) || capture.input.triageCapture?.triggerId !== triggerId || capture.input.triageCapture?.attempt !== index+1 ||
          !object(capture.output) || !Array.isArray(capture.output.content)) return;
      const parts = capture.output.content.map((part: any) => {try {return part.type === "text" ? JSON.parse(part.text) : undefined;} catch {return undefined;}}).filter(object);
      const execution = parts.find((part: any) => part.mcpExecution)?.mcpExecution;
      if (!object(execution) || !Array.isArray(execution.requestTrace) || execution.requestTrace.length < 1 || execution.requestTrace.length > 128 ||
          execution.requestTraceTruncated === true || (execution.requestsByType?.write ?? 0) !== 0 || (execution.requestsByType?.fallbackWrite ?? 0) !== 0 ||
          execution.requestTrace.some((trace: any) => !object(trace) || trace.operationType === "mutation" || ["write","fallbackWrite"].includes(trace.type)) ||
          parts.some((part: any) => part.operation || part.operationId && !part.mcpExecution || part.dispatcherPending === true)) return;
      for (const trace of execution.requestTrace) {
        if (trace.dispatcherState === "failed" && trace.ok === false && trace.httpStatus === 401 && uuid(trace.dispatcherRequestId)) {
          failedRequestIds.add(trace.dispatcherRequestId);failedReadObserved = true;
        }
      }
      const query = parts.find((part: any) => part.pagination);
      if (capture.toolName === "superops_tickets_query" && query?.pagination?.complete === true && capture.output.isError !== true &&
          Array.isArray(query.records) && query.records.length === 1 && query.records[0].displayId === ticketNumber &&
          typeof query.records[0].ticketId === "string" && /^\d{1,24}$/.test(query.records[0].ticketId)) {
        const args = capture.input;
        const single = (v: unknown, expected: string) => v === expected || Array.isArray(v) && v.length === 1 && v[0] === expected;
        if (!single(args.status,"New Calls") || !single(args.sources,"EMAIL") || args.fieldProfile !== "minimal" ||
            typeof args.createdFrom !== "string" || typeof args.createdTo !== "string" || !(Date.parse(args.createdFrom) < Date.parse(args.createdTo))) return;
        candidate = {createdFrom:args.createdFrom,createdTo:args.createdTo,ticketNumber,ticketId:query.records[0].ticketId};
      }
      captureIds.push(capture.captureId);
    }
    if (!failedReadObserved) return;
  }
  if (!candidate || new Set(captureIds).size !== captureIds.length || failedRequestIds.size < 1 || failedRequestIds.size > 3) return;
  return {...candidate,captureIds,failedRequestIds:[...failedRequestIds],attempts:pages.map((_,index)=>index+1)};
}
