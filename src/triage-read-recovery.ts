/** Project private diagnostic captures into bounded, content-free evidence for
 * a Sam-authorized recovery of an already quarantined first-read-only run. */
export function firstReadRecoveryProof(page: unknown): {
  requestId: string; createdFrom: string; createdTo: string; captureIds: string[];
} | undefined {
  const object = (v: unknown): v is Record<string, any> => Boolean(v && typeof v === "object" && !Array.isArray(v));
  if (!object(page) || page.complete !== true || page.hasMore !== false || page.captureFailureCount !== 0 ||
      !Array.isArray(page.records) || page.records.length < 1 || page.records.length > 5) return;
  const receiptIds = new Set<string>(), windows = new Set<string>(), captureIds: string[] = [];
  const permitted = new Set(["triageCapture", "createdFrom", "createdTo", "status", "sources", "fieldProfile", "sortOrder", "maxPages", "maxRecords"]);
  const single = (v: unknown, expected: string) => v === expected || Array.isArray(v) && v.length === 1 && v[0] === expected;
  for (const capture of page.records) {
    if (!object(capture) || capture.captureStatus !== "complete" || capture.toolName !== "superops_tickets_query" ||
        typeof capture.captureId !== "string" || !/^[a-f0-9-]{36}$/.test(capture.captureId) ||
        !object(capture.input) || !object(capture.output)) return;
    const args = capture.input;
    if (Object.keys(args).some(key => !permitted.has(key)) || args.fieldProfile !== "minimal" ||
        !single(args.status,"New Calls") || !single(args.sources,"EMAIL") || args.sortOrder && args.sortOrder !== "DESC" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(args.createdFrom ?? "") ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(args.createdTo ?? "") ||
        !Number.isFinite(Date.parse(args.createdFrom)) || !(Date.parse(args.createdFrom) < Date.parse(args.createdTo))) return;
    windows.add(JSON.stringify([args.createdFrom,args.createdTo]));
    const parts = (capture.output.content ?? []).map((p: unknown) => {
      try { return object(p) && p.type === "text" ? JSON.parse(p.text) : {}; } catch { return {}; }
    });
    const primary = parts.find((p: unknown) => object(p) && p.pagination);
    const execution = parts.find((p: unknown) => object(p) && p.mcpExecution)?.mcpExecution;
    if (!primary || primary.pagination.complete !== false || primary.pagination.stopReason !== "fetchError" ||
        !Array.isArray(primary.records) || primary.records.length !== 0 || !object(execution) ||
        !Array.isArray(execution.requestTrace) || execution.requestTrace.length > 128 ||
        execution.requestTraceTruncated === true || (execution.requestsByType?.write ?? 0) > 0 ||
        (execution.requestsByType?.fallbackWrite ?? 0) > 0) return;
    let pending = false;
    for (const trace of execution.requestTrace) {
      if (!object(trace) || trace.operationType === "mutation") return;
      if (trace.operationName === "getTicketList" && trace.ok === false &&
          ["queued","running","retry_wait","request_timeout"].includes(trace.dispatcherState) &&
          ["Dispatcher_pending","Dispatcher_request_timeout"].includes(trace.errorClass) &&
          /^[A-Za-z0-9_-]{1,160}$/.test(trace.dispatcherRequestId ?? "")) {
        receiptIds.add(trace.dispatcherRequestId); pending = true;
      }
    }
    if (!pending) return;
    captureIds.push(capture.captureId);
  }
  if (receiptIds.size !== 1 || windows.size !== 1) return;
  const [createdFrom,createdTo] = JSON.parse([...windows][0]) as [string,string];
  return {requestId: [...receiptIds][0],createdFrom,createdTo,captureIds};
}
