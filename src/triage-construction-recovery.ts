/** Content-free corroboration for one inspected, completed Agent workflow whose
 * preparation and callback were rejected by argument schemas before apply.
 * This is an operator recovery gate, not automatic replay or write approval. */
const READ_TOOLS = ["superops_tickets_query", "superops_tickets_triage_evidence_recover", "superops_tickets_field_options"];
const PREPARE = "superops_tickets_prepare_triage_plan";
const REPORT = "triage_result_report";
const object = (v: unknown): v is Record<string, any> => Boolean(v && typeof v === "object" && !Array.isArray(v));
const uuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);

export function inspectedConstructionProof(proof: unknown): boolean {
  if (!object(proof)) return false;
  const keys = ["conversationId", "complete", "workflowStepCount", "toolNames", "elicitationCount", "denialObserved",
    "preparationSchemaRejections", "resultSchemaRejections", "preparationErrorCode", "rejectedReasonCode"];
  if (Object.keys(proof).length !== keys.length || Object.keys(proof).some(key => !keys.includes(key)) ||
      !uuid(proof.conversationId) || proof.complete !== true || proof.elicitationCount !== 0 || proof.denialObserved !== false ||
      !Number.isInteger(proof.workflowStepCount) || proof.workflowStepCount < 5 || proof.workflowStepCount > 32 ||
      !Array.isArray(proof.toolNames) || ![5, 6].includes(proof.toolNames.length) ||
      proof.workflowStepCount < proof.toolNames.length || proof.preparationSchemaRejections !== proof.toolNames.length - 4 ||
      proof.resultSchemaRejections !== 1 || proof.preparationErrorCode !== "missing_action_ticket_number" ||
      proof.rejectedReasonCode !== "plan_validation_failed") return false;
  return proof.toolNames.every((name: unknown, i: number) =>
    name === (i < 3 ? READ_TOOLS[i] : i === proof.toolNames.length - 1 ? REPORT : PREPARE));
}

export function constructionCaptureProof(page: unknown, triggerId: string, attempt: number, ticketNumber: string): {
  createdFrom: string; createdTo: string; ticketNumber: string; ticketId: string; captureIds: string[];
} | undefined {
  if (!object(page) || page.complete !== true || page.hasMore !== false || page.totalRecords !== 3 ||
      page.captureFailureCount !== 0 || page.incompleteRecordCount !== 0 || page.truncated === true ||
      !Array.isArray(page.records) || page.records.length !== 3) return;
  const records = [...page.records].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  const primary: Record<string, any>[] = [], captureIds: string[] = [];
  for (const [i, record] of records.entries()) {
    if (!object(record) || record.toolName !== READ_TOOLS[i] || record.captureStatus !== "complete" || !uuid(record.captureId) ||
        !Number.isFinite(Date.parse(record.startedAt)) || !Number.isFinite(Date.parse(record.completedAt)) ||
        Date.parse(record.completedAt) < Date.parse(record.startedAt) ||
        i > 0 && Date.parse(record.startedAt) < Date.parse(records[i - 1].completedAt) ||
        !object(record.input) || record.input.triageCapture?.triggerId !== triggerId || record.input.triageCapture?.attempt !== attempt ||
        !object(record.output) || record.output.isError === true || !Array.isArray(record.output.content)) return;
    const parts = record.output.content.filter((p: any) => p?.type === "text").map((p: any) => {
      try { return JSON.parse(p.text); } catch { return undefined; }
    });
    if (!parts.length || parts.some((p: unknown) => !object(p))) return;
    const execution = parts.find((p: any) => p.mcpExecution)?.mcpExecution;
    if (!object(execution) || !Array.isArray(execution.requestTrace) || !execution.requestTrace.length ||
        execution.requestTrace.length > 128 || execution.requestTraceTruncated === true ||
        (execution.requestsByType?.write ?? 0) !== 0 || (execution.requestsByType?.fallbackWrite ?? 0) !== 0 ||
        execution.requestTrace.some((t: any) => !object(t) || t.operationType === "mutation" ||
          ["write", "fallbackWrite"].includes(t.type) || t.ok === false) ||
        (execution.failureDiagnostics?.length ?? 0) !== 0 || parts.some((p: any) => p.dispatcherPending === true || p.operation || p.operationId)) return;
    primary.push(parts[0]); captureIds.push(record.captureId);
  }
  if (new Set(captureIds).size !== 3) return;
  const args = records[0].input;
  const keys = ["triageCapture", "createdFrom", "createdTo", "status", "sources", "fieldProfile", "sortOrder", "maxPages", "maxRecords"];
  const single = (v: unknown, expected: string) => v === expected || Array.isArray(v) && v.length === 1 && v[0] === expected;
  const timestamp = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v));
  const query = primary[0];
  if (Object.keys(args).some(key => !keys.includes(key)) || !single(args.status, "New Calls") || !single(args.sources, "EMAIL") ||
      args.fieldProfile !== "minimal" || args.sortOrder && args.sortOrder !== "DESC" || !timestamp(args.createdFrom) ||
      !timestamp(args.createdTo) || Date.parse(args.createdFrom) >= Date.parse(args.createdTo) ||
      query.pagination?.complete !== true || query.pagination.truncated !== false || !Array.isArray(query.errors) || query.errors.length ||
      !Array.isArray(query.records) || query.records.length !== 1 || String(query.records[0].displayId) !== ticketNumber ||
      typeof query.records[0].ticketId !== "string" || !/^\d{1,24}$/.test(query.records[0].ticketId)) return;
  const ticketId = query.records[0].ticketId;
  if (!Array.isArray(records[1].input.ticketIds) || records[1].input.ticketIds.length !== 1 || records[1].input.ticketIds[0] !== ticketId ||
      primary[1].complete !== true || primary[1].requestedCount !== 1 || primary[1].recoveredCount !== 1) return;
  return {createdFrom: args.createdFrom, createdTo: args.createdTo, ticketNumber, ticketId, captureIds};
}
