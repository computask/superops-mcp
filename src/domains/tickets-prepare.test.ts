import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../client.js", async importOriginal => ({
  ...await importOriginal<typeof import("../client.js")>(), getClient: vi.fn(),
  getCredentials: vi.fn(() => ({ apiToken: "synthetic", subdomain: "prepare-tests", region: "us" })),
}));
import { getClient, SuperOpsError } from "../client.js";
import { getTicketsTools, resetTicketFieldOptionsCacheForTests } from "./tickets.js";
import { currentOwnerHash, getOperationStore, stableHash } from "../operation-store.js";
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
    expect(mutate).not.toHaveBeenCalled();
    expect(await getOperationStore().get(proposal().batchId, currentOwnerHash())).toBeUndefined();
    const definition = getTicketsTools().tools.find(tool => tool.name === "superops_tickets_prepare_triage_plan")!;
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
