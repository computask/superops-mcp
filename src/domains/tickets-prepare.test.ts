import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
vi.mock("../client.js", async importOriginal => ({
  ...await importOriginal<typeof import("../client.js")>(), getClient: vi.fn(),
  getCredentials: vi.fn(() => ({ apiToken: "synthetic", subdomain: "prepare-tests", region: "us" })),
}));
import { getClient, SuperOpsError } from "../client.js";
import { getTicketsTools, resetTicketFieldOptionsCacheForTests } from "./tickets.js";
import { currentOwnerHash, getOperationStore, runWithOperationStore, stableHash } from "../operation-store.js";
import { runWithExecutionContext, runWithExecutionConfig, recordTypedSubrequestStart } from "../execution.js";
import { publishToolDefinition } from "../tool-catalogue.js";

const query = vi.fn(); const mutate = vi.fn();
const original = { ticketId: "synthetic-ticket-90101", displayId: "90101", subject: "Synthetic access request",
  status: "New Calls", updatedTime: "2026-10-04T09:00:00Z", client: { accountId: "synthetic-client", name: "Synthetic Client" } };
const note = "<strong>TRIAGE SUMMARY</strong><br><br><strong>Ticket goal:</strong> Restore access.<br><br><strong>What needs to be known:</strong> Verified synthetic request.<br><br><strong>Next step:</strong> Engineer investigation.<br><br><strong>When:</strong> Next available slot.";
function proposal() { return { batchId: "synthetic-preparation-90101", policyMode: "scheduled-new-calls-v1",
  expectedCandidateTicketNumbers: ["90101"], actions: [{ ticketNumber: "90101", expectedTicketId: original.ticketId,
    expectedSubject: original.subject, expectedStatus: original.status, expectedUpdatedTime: original.updatedTime,
    expectedClient: original.client.name, expectedClientHash: "2993553194649526272", contentVerified: true,
    action: "leave", policyDisposition: "customer_request", policyReason: "customer_or_requester_work",
    contentEvidenceState: "meaningful", note, isPublicNote: false,
    target: { impact: "Low", urgency: "Low", category: "1. Support request", subcategory: "Network" } }] }; }
function fields() { return ["impact", "urgency", "subcategory"].map(columnName => ({ id: columnName, columnName,
  options: [{ id: columnName, value: columnName === "subcategory" ? "Network" : "Low",
    ...(columnName === "subcategory" ? { parentOption: { id: "support", value: "1. Support request" } } : {}) }],
  ...(columnName === "subcategory" ? { parentField: { id: "category", columnName: "category" } } : {}) })); }
async function prepare(input = proposal()) {
  const response = await getTicketsTools().handleCall("superops_tickets_prepare_triage_plan", input);
  return { response, data: JSON.parse(response.content[0].text) };
}
function pausedHistoryFromInstructions() {
  const text = readFileSync(new URL("../../agent/superops-triage-instructions.md", import.meta.url), "utf8");
  const example = text.match(/While history is paused use exactly: ([^.]+)\./)![1];
  return Object.fromEntries(example.split(", ").map(pair => pair.split(" ")));
}
describe("read-only complete triage preparation", () => {
  beforeEach(() => { vi.clearAllMocks(); resetTicketFieldOptionsCacheForTests();
    vi.mocked(getClient).mockReturnValue({ query, mutate } as never);
    query.mockImplementation(async (document: string) => {
      if (document.includes("getFields")) return { getFields: fields() };
      if (document.includes("getClientList")) return { getClientList: { clients: [{ accountId: "2993553194649526272", name: "TaskGroup" }], listInfo: { hasMore: false } } };
      return { getTicket: structuredClone(original) };
    });
  });
  it("derives the canonical hash without a mutation or durable operation", async () => {
    const { data } = await prepare();
    expect(data.complete).toBe(true);
    expect(data.preparedPlan.actions[0].expectedClientHash).toBe(stableHash(original.client.name));
    expect(data.preparedPlan.preparationFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(data.preparedPlan).toMatchObject({ dryRun: false, stopOnFirstFailure: false,
      allowResolveFullFallbackToUpdate: false, allowWriteIfUpdatedTimeChanged: false,
      allowWriteWithoutVerifiedContent: false });
    expect(mutate).not.toHaveBeenCalled();
    expect(await getOperationStore().get(proposal().batchId, currentOwnerHash())).toBeUndefined();
    const definition = getTicketsTools().tools.find(tool => tool.name === "superops_tickets_prepare_triage_plan")!;
    const schema = definition.inputSchema.properties.actions as { items: { properties: { target: { properties: Record<string, unknown> } } } };
    expect(schema.items.properties.target.properties).not.toHaveProperty("techGroupName");
    expect(publishToolDefinition(definition).annotations?.readOnlyHint).toBe(true);
  });
  it("fills both fixed fallback fields for an explicit null client", async () => {
    query.mockImplementation(async (document: string) => document.includes("getFields") ? { getFields: fields() } :
      document.includes("getClientList") ? { getClientList: { clients: [{ name: "TaskGroup", accountId: "2993553194649526272" }], listInfo: { hasMore: false } } } : { getTicket: { ...original, client: null } });
    const { data } = await prepare();
    expect(data.complete).toBe(true);
    expect(data.preparedPlan.actions[0].target).toMatchObject({ clientName: "TaskGroup", clientId: "2993553194649526272" });
    expect(mutate).not.toHaveBeenCalled();
  });

  it("accepts non-empty HTML section bodies after a label line break", async () => {
    const input = { ...proposal(), policyMode: "email-new-calls-v2" };
    Object.assign(input.actions[0], { historyAssessment: pausedHistoryFromInstructions(),
      note: note.replace(/<\/strong>(?!<br><br>)/g, "</strong><br>") });
    const { data } = await prepare(input);
    expect(data.complete).toBe(true); expect(data.operationCreated).toBe(false);
    expect(data.preparedPlan.actions[0].note).toBe(input.actions[0].note);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("rejects an empty HTML section without borrowing the next label or its body", async () => {
    const input = { ...proposal(), policyMode: "email-new-calls-v2" };
    Object.assign(input.actions[0], { historyAssessment: pausedHistoryFromInstructions(),
      note: note.replace("</strong> Restore access.", "</strong><br>") });
    const { data } = await prepare(input);
    expect(data.complete).toBe(false); expect(data.error).toContain("non-empty Ticket goal:");
    expect(data.preparedPlan).toBeUndefined(); expect(query).not.toHaveBeenCalled(); expect(mutate).not.toHaveBeenCalled();
  });
  for (const [label, change] of [
    ["unknown client", { client: undefined }], ["changed timestamp", { updatedTime: "2026-10-04T09:01:00Z" }],
    ["changed immutable identity", { ticketId: "different" }], ["changed client", { client: { accountId: "other", name: "Other" } }],
  ] as const) it(`rejects ${label} without returning a prepared plan`, async () => {
    query.mockResolvedValue({ getTicket: { ...original, ...change } });
    const { data } = await prepare(); expect(data.complete).toBe(false); expect(data.preparedPlan).toBeUndefined(); expect(mutate).not.toHaveBeenCalled();
  });
  it("rejects the wrong category parent before any operation exists", async () => {
    const input = proposal(); input.actions[0].target.category = "5. Non-technical query";
    const { data } = await prepare(input);
    expect(data.complete).toBe(false); expect(data.results[0].failureReason).toContain("belongs under category");
    expect(data.preparedPlan).toBeUndefined(); expect(mutate).not.toHaveBeenCalled();
  });
  it("accounts for a bad candidate separately and requires a new complete preparation for the eligible subset", async () => {
    const input = proposal();
    input.expectedCandidateTicketNumbers.push("90102");
    input.actions.push({...structuredClone(input.actions[0]), ticketNumber: "90102", expectedTicketId: "synthetic-ticket-90102"});
    query.mockImplementation(async (document: string, variables: {ticketId?: string}) => document.includes("getFields") ? {getFields: fields()} :
      {getTicket: variables?.ticketId === "synthetic-ticket-90102" ? {...original, ticketId: "synthetic-ticket-90102", displayId: "90102", client: undefined} : structuredClone(original)});
    const {data} = await prepare(input);
    expect(data.complete).toBe(false); expect(data.operationCreated).toBe(false); expect(data.preparedPlan).toBeUndefined();
    expect(data.eligibleCandidateTicketNumbers).toEqual(["90101"]);
    expect(data.deferredCandidateTicketNumbers).toEqual(["90102"]);
    const preparedSubset = await prepare(proposal());
    expect(preparedSubset.data.complete).toBe(true); expect(preparedSubset.data.preparedPlan.expectedCandidateTicketNumbers).toEqual(["90101"]);
    expect(mutate).not.toHaveBeenCalled();
  });
  it("rejects unsafe policy overrides and public notes before reads", async () => {
    const input = proposal(); input.actions[0].isPublicNote = true;
    expect((await prepare(input)).response.isError).toBe(true); expect(query).not.toHaveBeenCalled();
  });
  it("does not silently return a prepared subset when the execution budget stops", async () => {
    query.mockImplementation(async () => { recordTypedSubrequestStart({ type: "verificationRead" }); return { getTicket: original }; });
    const input = proposal(); input.expectedCandidateTicketNumbers.push("90102");
    input.actions.push({ ...input.actions[0], ticketNumber: "90102", expectedTicketId: "synthetic-90102" });
    const { data } = await runWithExecutionConfig({ SUPEROPS_EXECUTION_SUBREQUEST_BUDGET: "2", SUPEROPS_EXECUTION_SUBREQUEST_SAFETY_MARGIN: "1" },
      () => runWithExecutionContext("superops_tickets_prepare_triage_plan", () => prepare(input)));
    expect(data.complete).toBe(false); expect(data.preparedPlan).toBeUndefined(); expect(data.results).toHaveLength(2); expect(mutate).not.toHaveBeenCalled();
  });
  it("rejects accidental prepared-plan changes or version drift before ledger creation", async () => {
    const { data } = await prepare(); query.mockClear();
    for (const plan of [{ ...data.preparedPlan, batchId: "changed" }, { ...data.preparedPlan, policyContractVersion: "old" }]) {
      expect((await getTicketsTools().handleCall("superops_tickets_apply_triage_plan", plan)).isError).toBe(true);
    }
    expect(query).not.toHaveBeenCalled(); expect(mutate).not.toHaveBeenCalled();
  });
  it("accepts equivalent disabled overrides but still blocks an engineer edit after preparation", async () => {
    await runWithOperationStore({}, async () => {
      const { data } = await prepare({ ...proposal(), batchId: "synthetic-prepared-stale" }); query.mockClear();
      query.mockResolvedValue({ getTicket: { ...original, updatedTime: "2026-10-04T09:01:00Z" } });
      const plan = { ...data.preparedPlan };
      delete plan.allowResolveFullFallbackToUpdate; delete plan.allowWriteIfUpdatedTimeChanged;
      delete plan.allowWriteWithoutVerifiedContent;
      const response = await getTicketsTools().handleCall("superops_tickets_apply_triage_plan", plan);
      expect(response.content[0].text).not.toContain("checksum does not match");
      expect(JSON.parse(response.content[0].text).results[0]).toMatchObject({ finalOutcome: "SkippedChangedSinceSnapshot" });
      expect(query).toHaveBeenCalled(); expect(mutate).not.toHaveBeenCalled();
    });
  });
  for (const change of [
    { status: "Awaiting Engineer", updatedTime: "2026-10-04T09:01:00Z" },
    { client: { accountId: "other", name: "Other" }, updatedTime: "2026-10-04T09:01:00Z" },
    { subject: "An engineer changed the subject", updatedTime: "2026-10-04T09:01:00Z" },
  ]) it("accounts for a staff edit as a protected stale skip before any write", async () => {
    await runWithOperationStore({}, async () => {
      const { data } = await prepare({ ...proposal(), batchId: "synthetic-prepared-staff-change" });
      query.mockResolvedValue({ getTicket: { ...original, ...change } });
      const response = await getTicketsTools().handleCall("superops_tickets_apply_triage_plan", data.preparedPlan);
      const result = JSON.parse(response.content[0].text).results[0];
      expect(result).toMatchObject({ finalOutcome: "SkippedChangedSinceSnapshot", writeAttempted: false });
      expect(mutate).not.toHaveBeenCalled();
    });
  });
  it("applies one complete prepared proposal and returns the stored result for duplicate calls", async () => {
    await runWithOperationStore({}, async () => {
      const ticket: Record<string, unknown> = structuredClone(original);
      const notes: Array<Record<string, unknown>> = [];
      query.mockImplementation(async (document: string) => {
        if (document.includes("getFields")) return { getFields: fields() };
        if (document.includes("getTicketNoteList")) return { getTicketNoteList: structuredClone(notes) };
        return { getTicket: structuredClone(ticket) };
      });
      mutate.mockImplementation(async (document: string, variables: { input: Record<string, unknown> }) => {
        if (document.includes("createTicketNote")) {
          notes.push({ noteId: "synthetic-prepared-note", content: variables.input.content, privacyType: "PRIVATE" });
          return { createTicketNote: { noteId: "synthetic-prepared-note", privacyType: "PRIVATE" } };
        }
        Object.assign(ticket, variables.input, { updatedTime: "2026-10-04T09:01:00Z" });
        return { updateTicket: { ticketId: original.ticketId } };
      });
      const { data } = await prepare({ ...proposal(), batchId: "synthetic-prepared-duplicate" });
      const first = await getTicketsTools().handleCall("superops_tickets_apply_triage_plan", data.preparedPlan);
      expect(JSON.parse(first.content[0].text).results[0]).toMatchObject({ finalOutcome: "Left", verified: true });
      expect(JSON.parse(first.content[0].text).operation.state).toBe("Completed");
      const writes = mutate.mock.calls.length;
      expect(writes).toBeGreaterThan(0); expect(notes).toHaveLength(1);
      query.mockClear();
      const duplicate = { ...data.preparedPlan };
      delete duplicate.allowResolveFullFallbackToUpdate; delete duplicate.allowWriteIfUpdatedTimeChanged;
      delete duplicate.allowWriteWithoutVerifiedContent;
      const second = await getTicketsTools().handleCall("superops_tickets_apply_triage_plan", duplicate);
      expect(JSON.parse(second.content[0].text).operation.state).toBe("Completed");
      expect(mutate).toHaveBeenCalledTimes(writes); expect(query).not.toHaveBeenCalled();
      expect(notes).toHaveLength(1);
    });
  });
  it("reports central-client attempts without an outer retry or raw provider reason", async () => {
    query.mockImplementation(async () => {
      for (let attempt = 0; attempt < 3; attempt++) recordTypedSubrequestStart({ type: "metadataValidation", operationName: "getFields", retryCount: attempt });
      throw new SuperOpsError("private provider detail", "rate_limit_exceeded", 120);
    });
    const result = await runWithExecutionContext("superops_tickets_field_options", () =>
      getTicketsTools().handleCall("superops_tickets_field_options", { fields: ["impact"] }));
    expect(JSON.parse(result.content[0].text)).toMatchObject({ attempts: 3, retried: true, rateLimited: true, retryScope: "read" });
    expect(query).toHaveBeenCalledTimes(1); expect(result.content[0].text).not.toContain("private provider detail");
  });
});
