import { describe, expect, it, vi } from "vitest";
import { auditToolCall, errorSummaryFromResult, sanitizeToolResult, type ToolResult } from "./audit.js";

const validationResult = (): ToolResult => ({ isError: true, content: [{ type: "text", text: JSON.stringify({
  ok: false, complete: false, preparationOnly: true, operationCreated: false,
  results: Array.from({length: 4}, (_, i) => ({ticketNumber: String(70000 + i),
    subject: "Synthetic private subject ".repeat(50), client: "Synthetic private client", note: "Synthetic private note",
    finalOutcome: "Blocked", failureStage: "preparationValidation",
    failureReason: "Invalid synthetic subcategory dependency; no writes performed."})),
  credentials: {access_token: "synthetic-secret-value", apiToken: "synthetic-token-value"},
}) }] });

describe("structured MCP validation errors", () => {
  it("keeps parseable complete preparation failures beyond the old 800-character cutoff", () => {
    const result = sanitizeToolResult(validationResult());
    const parsed = JSON.parse(result.content[0].text);
    expect(result.isError).toBe(true);
    expect(parsed).toMatchObject({complete: false, preparationOnly: true, operationCreated: false});
    expect(parsed.results).toHaveLength(4);
    expect(parsed.results.at(-1).failureReason).toBe("Invalid synthetic subcategory dependency; no writes performed.");
    expect(parsed.results[0].subject.length).toBeLessThanOrEqual(803);
    expect(parsed.credentials).toEqual({access_token: "[redacted]", apiToken: "[redacted]"});
    expect(result.content[0].text).not.toContain("synthetic-secret-value");
    expect(result.content[0].text).not.toContain("synthetic-token-value");
  });

  it("projects only classifications into routine logs, never the serialized result", () => {
    const result = sanitizeToolResult(validationResult());
    const summary = errorSummaryFromResult(result);
    expect(summary).toContain("preparationValidation");
    for (const privateText of ["Synthetic private subject", "Synthetic private client", "Synthetic private note", "Invalid synthetic subcategory"]) {
      expect(summary).not.toContain(privateText);
    }
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      auditToolCall({toolName:"superops_tickets_prepare_triage_plan",success:false,durationMs:1,errorSummary:summary});
      expect(String(log.mock.calls[0][0])).toContain("preparationValidation");
      expect(String(log.mock.calls[0][0])).not.toContain("Synthetic private");
    } finally { log.mockRestore(); }
  });

  it("omits malformed structured error payloads from audit summaries", () => {
    expect(errorSummaryFromResult({isError:true,content:[{type:"text",text:'{"subject":"Synthetic private subject",'}]}))
      .toBe("Structured tool error (details omitted)");
  });

  it("preserves the existing bounded plain-error redaction", () => {
    const result=sanitizeToolResult({isError:true,content:[{type:"text",text:"Error: Bearer synthetic-token at synthetic (C:\\private\\file.ts:9)"}]});
    expect(result.content[0].text).toContain("[redacted]");
    expect(result.content[0].text).not.toContain("synthetic-token");
    expect(errorSummaryFromResult(result)).toContain("Error:");
  });
});
