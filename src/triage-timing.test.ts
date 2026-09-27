import { afterEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beginTriageTiming } from "./triage-timing.js";
import { timingRowsFromTail } from "./api-call-log-worker.js";
import { createMcpServer } from "./mcp-server.js";

const triggerId = "triage-2505-3a428787-f54a-428b-86a8-dc8c6e772f4d";
const args = { triageCapture: { triggerId, attempt: 2 }, expectedCandidateTicketNumbers: ["63007", "63007", "private@example.test"], note: "private-body" };
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
function collect() {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation(value => { lines.push(String(value)); });
  return lines;
}
function tail(lines: string[], scriptName = "superops-mcp", outcome = "ok") {
  return [{ scriptName, outcome, logs: [{ message: lines }] }];
}

it("records exact boundaries and safe correlation without any request content", () => {
  const lines = collect();
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-27T08:03:43.284Z"));
  const mark = beginTriageTiming("superops_tickets_apply_triage_plan", args, "invocation-1");
  vi.setSystemTime(new Date("2026-09-27T08:04:13.924Z")); mark("execution_finished", "success");
  vi.setSystemTime(new Date("2026-09-27T08:04:14.124Z")); mark("response_ready", "success");
  const rows = timingRowsFromTail(tail(lines));
  expect(rows).toHaveLength(3);
  expect(rows.map(r => r[4])).toEqual(["2026-09-27T08:03:43.284Z", "2026-09-27T08:04:13.924Z", "2026-09-27T08:04:14.124Z"]);
  expect(rows[0].slice(8, 11)).toEqual(["invocation-1", '["63007"]', 0]);
  expect(lines.join()).not.toMatch(/private-body|private@example/);
  expect(timingRowsFromTail(tail([...lines, ...lines]))).toHaveLength(3);
  expect(timingRowsFromTail(tail(lines.slice(0, 1), "superops-mcp", "exceededCpu"))[0][12]).toBe("exceededCpu");
});

it("rejects invalid context, unrelated producers, unknown tools and oversized metadata", () => {
  const lines = collect();
  beginTriageTiming("superops_tickets_field_options", {})("response_ready");
  beginTriageTiming("superops_custom_mutation", args)("response_ready");
  expect(lines).toEqual([]);
  beginTriageTiming("superops_tickets_field_options", args);
  expect(timingRowsFromTail(tail(lines, "other-worker"))).toEqual([]);
  expect(timingRowsFromTail(tail(lines, "support-triage-trigger"))).toEqual([]);
  for (const override of [{ attempt: 0 }, { timestamp: "invalid" }, { callId: "secret" }, { stage: "other" }]) {
    expect(timingRowsFromTail(tail([JSON.stringify({ ...JSON.parse(lines[0]), ...override })]))).toEqual([]);
  }
  expect(timingRowsFromTail(tail([JSON.stringify({ ...JSON.parse(lines[0]), payload: "x".repeat(4096) })]))).toEqual([]);
});

it("logs response-ready only after capture settles; blocked apply remains blocked with zero fetches", async () => {
  const lines = collect();
  const fetcher = vi.spyOn(globalThis, "fetch");
  const stages = () => lines.filter(l => l.startsWith('{"event":"triage.tool_timing"')).map(l => JSON.parse(l).stage);
  const server = createMcpServer({
    blockedToolNames: new Set(["superops_tickets_apply_triage_plan"]),
    triageAgentCapture: async () => {
      expect(stages()).toEqual(["received", "execution_finished"]);
      throw new Error("synthetic capture failure");
    },
  });
  const client = new Client({ name: "timing-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a); await client.connect(b);
    const result = await client.callTool({ name: "superops_tickets_apply_triage_plan", arguments: args });
    expect(result.isError).toBe(true);
    expect(stages()).toEqual(["received", "execution_finished", "response_ready"]);
    expect(fetcher).not.toHaveBeenCalled();
    expect(timingRowsFromTail(tail(lines))[2][11]).toBe("error");
  } finally { await client.close(); await server.close(); }
});

it("bounds ticket numbers and never lets logging failure change the execution", () => {
  const lines = collect();
  beginTriageTiming("superops_tickets_apply_triage_plan", { ...args, expectedCandidateTicketNumbers: Array.from({ length: 60 }, (_, n) => String(n)) });
  expect(JSON.parse(lines[0]).ticketNumbers).toHaveLength(50);
  expect(JSON.parse(lines[0]).ticketNumbersTruncated).toBe(true);
  vi.mocked(console.log).mockImplementation(() => { throw new Error("logger offline"); });
  expect(() => beginTriageTiming("superops_tickets_field_options", args)("response_ready", "success")).not.toThrow();
});

it("retains bounded intent-capture failure codes without accepting arbitrary error contents", () => {
  const event = {
    event: "triage.tool_timing", callId: "17c7303c-1790-4472-a574-13994763493c", triggerId, attempt: 1,
    timestamp: "2026-09-27T12:20:41.271Z", toolName: "triage_apply_intent_report", stage: "response_ready",
    ticketNumbers: ["63009"], outcome: "recorded",
  };
  for (const outcome of ["recorded", "duplicate", "conflict", "capture_too_large", "capture_capacity_reached", "stale_or_unauthorized"]) {
    const rows = timingRowsFromTail(tail([JSON.stringify({ ...event, outcome })], "support-triage-trigger"));
    expect(rows).toHaveLength(1);
    expect(rows[0][11]).toBe(outcome);
  }
  const rows = timingRowsFromTail(tail([JSON.stringify({ ...event, outcome: "private failure content" })], "support-triage-trigger"));
  expect(rows[0][11]).toBeNull();
  expect(JSON.stringify(rows)).not.toContain("private failure content");
});
