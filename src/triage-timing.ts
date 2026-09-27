import { parseTriageAgentCaptureContext } from "./triage-agent-capture.js";

export const TRIAGE_TIMING_TOOLS = new Set([
  "superops_tickets_query", "superops_tickets_triage_snapshot",
  "superops_tickets_triage_evidence_recover", "superops_tickets_get_safe",
  "superops_tickets_get_safe_by_number", "superops_tickets_field_options",
  "superops_tickets_apply_triage_plan",
]);
export type TriageTimingStage = "received" | "execution_finished" | "response_ready";

// Server-observed boundaries only. No new I/O, business decisions or raw args.
export function beginTriageTiming(toolName: string, args: Record<string, unknown>, invocationId?: string) {
  const context = parseTriageAgentCaptureContext(args.triageCapture);
  if (!context || !TRIAGE_TIMING_TOOLS.has(toolName)) return () => {};
  const callId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const numbers = Array.isArray(args.expectedCandidateTicketNumbers)
    ? args.expectedCandidateTicketNumbers.filter((n): n is string => typeof n === "string" && /^\d{1,12}$/.test(n)) : [];
  const ticketNumbers = [...new Set(numbers)].slice(0, 50);
  const mark = (stage: TriageTimingStage, outcome?: "success" | "error"): void => {
    try {
      console.log(JSON.stringify({
        event: "triage.tool_timing", callId, ...context, toolName, stage,
        timestamp: stage === "received" ? startedAt : new Date().toISOString(),
        invocationId, ticketNumbers, ticketNumbersTruncated: numbers.length > 50,
        outcome: outcome ?? null,
      }));
    } catch { /* Diagnostic logging must never change a tool result or replay a write. */ }
  };
  mark("received");
  return mark;
}
