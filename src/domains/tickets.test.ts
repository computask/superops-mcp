/**
 * Tickets Domain Tests
 *
 * Tests for service ticket management tools.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

vi.mock("../client.js", () => ({
  getClient: vi.fn(() => ({
    query: vi.fn(),
    mutate: vi.fn(),
  })),
  SuperOpsError: class SuperOpsError extends Error {
    code?: string;
    retryAfter?: number;
    constructor(message: string, code?: string, retryAfter?: number) {
      super(message);
      this.code = code;
      this.retryAfter = retryAfter;
    }
  },
  SuperOpsHttpError: class SuperOpsHttpError extends Error {
    status: number;
    statusText: string;
    retryAfter?: number;
    constructor(message: string, status: number, statusText: string, retryAfter?: number) {
      super(message);
      this.status = status;
      this.statusText = statusText;
      this.retryAfter = retryAfter;
    }
  },
}));

import { getClient, SuperOpsError, SuperOpsHttpError } from "../client.js";
import { getTicketsTools, resumeApplyTriageOperation } from "./tickets.js";
import {
  getExecutionState,
  recordSubrequestFinish,
  recordTypedSubrequestStart,
  runWithExecutionConfig,
  runWithExecutionContext,
} from "../execution.js";
import { getOperationStore, operationResultView, runWithOperationStore, stableHash } from "../operation-store.js";
import { runWithContinuationScheduler } from "../continuation-scheduler.js";

function withSuccessfulContinuationScheduling<T>(fn: () => T): T {
  return runWithContinuationScheduler({
    SUPEROPS_CONTINUATION_ENABLED: "true",
    SUPEROPS_INTERNAL_CONTINUATION_TOKEN: "test-internal-token",
    SUPEROPS_CONTINUATION_SERVICE: {
      fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    },
  }, fn);
}

const VALID_TICKET_STATUSES = [
  "Worked on",
  "Awaiting Customer Reply",
  "Awaiting Engineer",
  "Escalated Tickets",
  "Resolved",
  "Awaiting 2nd Line Engineer",
  "Setup Info",
  "Worked on Setups",
  "Awaiting Quote",
  "Waiting on third party",
  "Ticket on Hold",
  "Closed",
  "Awaiting Approval",
  "For Sam's Attention",
  "Adhoc",
  "New Calls",
  "Rewst",
];

const VALID_TICKET_CATEGORIES = [
  "1. Support request",
  "2. Change request",
  "3. Security Incident",
  "4. New setup",
  "5. Non-technical query",
  "6. New enquiry",
  "7. Sales call",
  "8. Rewst",
];

const RESOLVED_OPTION_FIELDS = [
  ticketField("priority", ["Very Low", "Low", "Medium", "High"]),
  ticketField("impact", ["Low", "Medium", "High"]),
  ticketField("urgency", ["Low", "Medium", "High"]),
  ticketField("resolutionCode", [
    "Exception",
    "Permanent Fix",
    "Resolved by Requester",
    "Workaround",
  ]),
  ticketField("cause", ["No Fault Found", "User Request", "Unknown"]),
  ticketField("subcategory", ["No Action Needed", "To Escalate", "Quote Wanted"], {
    columnName: "category",
    value: "7. Sales call",
  }),
];

const RESOLVED_CLASSIFICATION = {
  priority: "Very Low",
  impact: "Low",
  urgency: "Low",
  category: "7. Sales call",
  subcategory: "No Action Needed",
  cause: "No Fault Found",
  resolutionCode: "Permanent Fix",
};

function ticketField(
  columnName: string,
  values: string[],
  parentField?: { columnName: string; value: string }
) {
  return {
    id: `${columnName}-field`,
    module: "TICKET",
    columnName,
    label: columnName,
    options: values.map((value) => ({
      id: `${columnName}-${value}`,
      value,
      parentOption: parentField
        ? { id: `${parentField.columnName}-${parentField.value}`, value: parentField.value }
        : undefined,
    })),
    parentField: parentField
      ? { id: `${parentField.columnName}-field`, columnName: parentField.columnName }
      : undefined,
  };
}

describe("Tickets Domain", () => {
  let mockClient: { query: ReturnType<typeof vi.fn>; mutate: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockClient = {
      query: vi.fn(),
      mutate: vi.fn(),
    };
    vi.mocked(getClient).mockReturnValue(mockClient as unknown as ReturnType<typeof getClient>);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns the expected public tools", () => {
    const domain = getTicketsTools();

    expect(domain.tools.map((tool) => tool.name)).toEqual([
      "superops_tickets_list",
      "superops_tickets_recent",
      "superops_tickets_query",
      "superops_tickets_created_between",
      "superops_tickets_report",
      "superops_tickets_get",
      "superops_tickets_get_by_number",
      "superops_tickets_get_safe_by_number",
      "superops_tickets_triage_snapshot",
      "superops_tickets_apply_triage_plan",
      "superops_tickets_conversation_list",
      "superops_tickets_notes_list",
      "superops_tickets_field_options",
      "superops_tickets_create",
      "superops_tickets_resolve_full",
      "superops_tickets_update",
      "superops_tickets_add_note",
      "superops_tickets_log_time",
    ]);
  });

  it("publishes the complete approved triage action item schema", () => {
    const domain = getTicketsTools();
    const tool = domain.tools.find((candidate) => candidate.name === "superops_tickets_apply_triage_plan");
    type TargetSchema = {
      properties: Record<string, { enum?: string[] }>;
      anyOf?: Array<{ required: string[] }>;
      required?: string[];
    };
    type ActionSchemaVariant = {
      properties: Record<string, unknown> & {
        action: { const: string };
        target: TargetSchema;
      };
      required?: string[];
    };
    const actions = tool?.inputSchema.properties.actions as {
      type?: string;
      items?: { oneOf?: ActionSchemaVariant[] };
    };

    expect(actions.type).toBe("array");
    expect(actions.items).toBeDefined();
    expect(actions.items).not.toEqual({});

    const variants = actions.items?.oneOf ?? [];
    expect(variants.map((variant) => variant.properties.action.const)).toEqual([
      "update", "resolve", "addNote", "leave", "skip",
    ]);

    const update = variants.find((variant) => variant.properties.action.const === "update");
    expect(update?.required).toEqual(
      expect.arrayContaining(["ticketNumber", "expectedUpdatedTime", "contentVerified", "action", "target"])
    );
    expect(update?.properties.target.properties.status.enum).toContain("Awaiting Engineer");
    expect(update?.properties.target.anyOf).toContainEqual({ required: ["status"] });
    expect(update?.properties.target.properties).toEqual(
      expect.objectContaining({
        status: expect.any(Object),
        priority: expect.any(Object),
        impact: expect.any(Object),
        urgency: expect.any(Object),
        category: expect.any(Object),
        subcategory: expect.any(Object),
        cause: expect.any(Object),
        resolutionCode: expect.any(Object),
        techGroupName: expect.any(Object),
        clientName: expect.any(Object),
        clientId: expect.any(Object),
        suppressCloseNotification: expect.any(Object),
      })
    );

    const resolve = variants.find((variant) => variant.properties.action.const === "resolve");
    expect(resolve?.properties.target.required).toEqual([
      "category", "priority", "impact", "subcategory", "cause", "resolutionCode",
    ]);

    const addNote = variants.find((variant) => variant.properties.action.const === "addNote");
    expect(addNote?.required).toEqual(
      expect.arrayContaining(["ticketNumber", "expectedUpdatedTime", "contentVerified", "action", "note"])
    );
  });

  it("uses server-side status condition and returns New Calls tickets", async () => {
    mockClient.query.mockResolvedValue({
      getTicketList: {
        tickets: [
          {
            ticketId: "1",
            displayId: "062822-0001",
            subject: "New ticket",
            status: "New Calls",
          },
        ],
        listInfo: { page: 1, pageSize: 50, hasMore: true, totalCount: 15 },
      },
    });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_list", {
      status: ["New Calls"],
      max: 50,
      page: 1,
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining("getTicketList"),
      {
        input: {
          page: 1,
          pageSize: 50,
          condition: {
            attribute: "status",
            operator: "is",
            value: "New Calls",
          },
        },
      }
    );
    expect(mockClient.query.mock.calls[0][1].input).not.toHaveProperty("first");
    expect(mockClient.query.mock.calls[0][1].input).not.toHaveProperty("filter");
    expect(parsed.tickets).toEqual([
      expect.objectContaining({ ticketId: "1", status: "New Calls" }),
    ]);
    expect(parsed.listInfo).toEqual({
      page: 1,
      pageSize: 50,
      hasMore: true,
      totalCount: 15,
    });
  });

  it("uses an in condition for multiple status display names", async () => {
    mockClient.query.mockResolvedValue({
      getTicketList: {
        tickets: [],
        listInfo: { page: 1, pageSize: 100, hasMore: false, totalCount: 0 },
      },
    });

    const domain = getTicketsTools();
    await domain.handleCall("superops_tickets_list", {
      status: ["New Calls", "Worked on"],
      max: 100,
      page: 1,
    });

    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining("getTicketList"),
      {
        input: {
          page: 1,
          pageSize: 100,
          condition: {
            attribute: "status",
            operator: "in",
            value: ["New Calls", "Worked on"],
          },
        },
      }
    );
  });

  it("does not return unrelated unfiltered totalCount after local post-filtering", async () => {
    mockClient.query.mockResolvedValue({
      getTicketList: {
        tickets: [
          {
            ticketId: "1",
            displayId: "062822-0001",
            subject: "High priority",
            status: "New Calls",
            priority: "High",
          },
          {
            ticketId: "2",
            displayId: "062822-0002",
            subject: "Low priority",
            status: "New Calls",
            priority: "Low",
          },
        ],
        listInfo: { page: 1, pageSize: 50, hasMore: true, totalCount: 28604 },
      },
    });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_list", {
      status: ["New Calls"],
      priority: ["High"],
      max: 50,
      page: 1,
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.tickets).toEqual([
      expect.objectContaining({ ticketId: "1", priority: "High" }),
    ]);
    expect(parsed.listInfo).toEqual({ page: 1, pageSize: 50 });
    expect(parsed.listInfo.totalCount).toBeUndefined();
    expect(parsed.listInfo.hasMore).toBeUndefined();
  });

  it("returns structured validation for invalid status names", async () => {
    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_list", {
      status: ["Not a status"],
      max: 50,
      page: 1,
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(parsed).toMatchObject({
      ok: false,
      message: "Tickets were not queried because validation failed.",
      invalidFields: {
        status: "Invalid ticket status(es): Not a status",
      },
    });
    expect(parsed.validOptions.status).toContain("New Calls");
    expect(mockClient.query).not.toHaveBeenCalled();
  });

  it("lists tickets without status using page/pageSize only", async () => {
    mockClient.query.mockResolvedValue({
      getTicketList: {
        tickets: [
          { ticketId: "1", displayId: "062822-0001", subject: "Any ticket" },
        ],
        listInfo: { page: 2, pageSize: 75, hasMore: false, totalCount: 1 },
      },
    });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_list", {
      max: 75,
      page: 2,
    });

    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining("getTicketList"),
      { input: { page: 2, pageSize: 75 } }
    );
    expect(result.content[0].text).toContain("Any ticket");
  });

  it("lists recent tickets with default count and createdTime descending sort", async () => {
    mockClient.query.mockResolvedValue({
      getTicketList: {
        tickets: [
          {
            ticketId: "ticket-2",
            displayId: "57072",
            subject: "Most recent",
            createdTime: "2026-06-25T10:00:00",
          },
        ],
        listInfo: { page: 1, pageSize: 10, hasMore: false, totalCount: 1 },
      },
    });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_recent", {});

    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining("getTicketList"),
      {
        input: {
          page: 1,
          pageSize: 10,
          sort: [{ attribute: "createdTime", order: "DESC" }],
        },
      }
    );
    expect(result.content[0].text).toContain("Most recent");
    expect(result.content[0].text).toContain("listInfo");
  });

  it("clamps recent ticket count to 1..50", async () => {
    mockClient.query.mockResolvedValue({
      getTicketList: {
        tickets: [],
        listInfo: { page: 1, pageSize: 1, hasMore: false, totalCount: 0 },
      },
    });

    const domain = getTicketsTools();
    await domain.handleCall("superops_tickets_recent", { count: 0 });
    expect(mockClient.query.mock.calls[0][1].input.pageSize).toBe(1);

    await domain.handleCall("superops_tickets_recent", { count: 500 });
    expect(mockClient.query.mock.calls[1][1].input.pageSize).toBe(50);
  });

  it("returns an error if SuperOps rejects recent createdTime sorting", async () => {
    mockClient.query.mockRejectedValue(new Error("Cannot sort by createdTime"));

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_recent", { count: 5 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("createdTime sort was rejected");
    expect(result.content[0].text).toContain("Cannot sort by createdTime");
  });

  it("rejects recent ticket content fetches above 10 tickets", async () => {
    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_recent", {
      count: 11,
      includeContent: true,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("includeContent is limited to 10 tickets");
    expect(mockClient.query).not.toHaveBeenCalled();
  });


  it("queries historical tickets with createdTime DESC pages and safe field selection", async () => {
    mockClient.query.mockResolvedValue({
      getTicketList: {
        tickets: [
          { ticketId: "2", displayId: "57002", subject: "Inside", createdTime: "2026-07-01T10:00:00Z", status: "New Calls", source: "Email" },
          { ticketId: "1", displayId: "57001", subject: "Lower boundary", createdTime: "2026-07-01T00:00:00Z", status: "New Calls", source: "Email" },
          { ticketId: "old", displayId: "56999", subject: "Old", createdTime: "2026-06-30T23:59:59Z", status: "New Calls" },
        ],
        listInfo: { page: 1, pageSize: 100, hasMore: true, totalCount: 29291 },
      },
    });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_query", {
      createdFrom: "2026-07-01T00:00:00Z",
      createdTo: "2026-07-02T00:00:00Z",
      status: ["New Calls"],
      fieldProfile: "minimal",
    });
    const parsed = JSON.parse(result.content[0].text);
    const [query, variables] = mockClient.query.mock.calls[0];

    expect(query).toContain("getTicketList");
    expect(query).toContain("ticketId");
    expect(query).toContain("displayId");
    expect(query).toContain("createdTime");
    expect(query).not.toContain("conversation");
    expect(query).not.toContain("notes");
    expect(query).not.toContain("content");
    expect(variables.input).toEqual({
      page: 1,
      pageSize: 100,
      sort: [{ attribute: "createdTime", order: "DESC" }],
      condition: { attribute: "status", operator: "is", value: "New Calls" },
    });
    expect(parsed.records.map((ticket: { ticketId: string }) => ticket.ticketId)).toEqual(["2", "1"]);
    expect(parsed.pagination).toMatchObject({ complete: true, stopReason: "crossedCreatedFromBoundary", recordsExamined: 3, recordsMatched: 2, recordsReturned: 2 });
    expect(parsed.filterExecution).toEqual({ status: "server" });
  });

  it("excludes createdTo, ignores newer records, dedupes pages, and can return chronological order", async () => {
    mockClient.query.mockResolvedValueOnce({ getTicketList: { tickets: [{ ticketId: "new", displayId: "57004", subject: "Too new", createdTime: "2026-07-02T00:00:00Z" }, { ticketId: "2", displayId: "57002", subject: "Inside", createdTime: "2026-07-01T10:00:00Z" }], listInfo: { page: 1, pageSize: 100, hasMore: true, totalCount: 4 } } }).mockResolvedValueOnce({ getTicketList: { tickets: [{ ticketId: "2", displayId: "57002", subject: "Duplicate", createdTime: "2026-07-01T10:00:00Z" }, { ticketId: "1", displayId: "57001", subject: "Boundary", createdTime: "2026-07-01T00:00:00Z" }, { ticketId: "old", displayId: "56999", subject: "Old", createdTime: "2026-06-30T23:59:59Z" }], listInfo: { page: 2, pageSize: 100, hasMore: false, totalCount: 4 } } });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_created_between", { createdFrom: "2026-07-01T00:00:00Z", createdTo: "2026-07-02T00:00:00Z", sortOrder: "ASC" });
    const parsed = JSON.parse(result.content[0].text);

    expect(mockClient.query).toHaveBeenCalledTimes(2);
    expect(parsed.records.map((ticket: { ticketId: string }) => ticket.ticketId)).toEqual(["1", "2"]);
    expect(parsed.pagination.duplicateRecordsRemoved).toBe(1);
    expect(parsed.pagination.recordsExamined).toBe(5);
  });

  it("marks historical queries incomplete for repeated pages, maxPages, maxRecords, and retry exhaustion", async () => {
    const domain = getTicketsTools();
    mockClient.query.mockResolvedValue({ getTicketList: { tickets: [{ ticketId: "1", displayId: "1", subject: "Loop", createdTime: "2026-07-01T10:00:00Z" }], listInfo: { page: 1, pageSize: 100, hasMore: true, totalCount: 10 } } });
    let result = await domain.handleCall("superops_tickets_query", { createdFrom: "2026-07-01T00:00:00Z", createdTo: "2026-07-02T00:00:00Z", maxPages: 3 });
    let parsed = JSON.parse(result.content[0].text);
    expect(parsed.pagination).toMatchObject({ complete: false, truncated: true, stopReason: "repeatedPageLoop" });

    mockClient.query.mockReset();
    mockClient.query.mockResolvedValue({ getTicketList: { tickets: [{ ticketId: "1", displayId: "1", subject: "Page", createdTime: "2026-07-01T10:00:00Z" }], listInfo: { page: 1, pageSize: 100, hasMore: true, totalCount: 10 } } });
    result = await domain.handleCall("superops_tickets_query", { createdFrom: "2026-07-01T00:00:00Z", createdTo: "2026-07-02T00:00:00Z", maxPages: 1 });
    parsed = JSON.parse(result.content[0].text);
    expect(parsed.pagination).toMatchObject({ complete: false, truncated: true, nextPage: 2, stopReason: "maxPagesReached" });

    mockClient.query.mockReset();
    mockClient.query.mockResolvedValue({ getTicketList: { tickets: [{ ticketId: "1", displayId: "1", subject: "One", createdTime: "2026-07-01T10:00:00Z" }, { ticketId: "2", displayId: "2", subject: "Two", createdTime: "2026-07-01T09:00:00Z" }], listInfo: { page: 1, pageSize: 100, hasMore: true, totalCount: 10 } } });
    result = await domain.handleCall("superops_tickets_query", { createdFrom: "2026-07-01T00:00:00Z", createdTo: "2026-07-02T00:00:00Z", maxRecords: 1 });
    parsed = JSON.parse(result.content[0].text);
    expect(parsed.pagination).toMatchObject({ complete: false, truncated: true, stopReason: "maxRecordsReached", recordsReturned: 1 });

    mockClient.query.mockReset();
    mockClient.query.mockRejectedValue({ status: 429, retryAfter: 0 });
    result = await domain.handleCall("superops_tickets_query", { createdFrom: "2026-07-01T00:00:00Z", createdTo: "2026-07-02T00:00:00Z" });
    parsed = JSON.parse(result.content[0].text);
    expect(parsed.pagination).toMatchObject({ complete: false, truncated: true, stopReason: "fetchError" });
    expect(parsed.errors[0]).toMatchObject({ errorType: "rateLimit", retryable: true, attempts: 1 });
    expect(parsed.retryDiagnostics.retries).toBe(0);
    expect(mockClient.query).toHaveBeenCalledTimes(1);
  });

  it("returns partial historical records when execution budget stops pagination", async () => {
    const domain = getTicketsTools();
    mockClient.query.mockImplementation(async () => {
      const started = recordTypedSubrequestStart({ type: "paginationRead" });
      recordSubrequestFinish(started, 200, true);
      return {
        getTicketList: {
          tickets: [
            {
              ticketId: "1",
              displayId: "1",
              subject: "Inside",
              createdTime: "2026-07-01T10:00:00Z",
            },
          ],
          listInfo: { page: 1, pageSize: 100, hasMore: true, totalCount: 10 },
        },
      };
    });

    const result = await runWithExecutionConfig(
      {
        SUPEROPS_EXECUTION_SUBREQUEST_BUDGET: "2",
        SUPEROPS_EXECUTION_SUBREQUEST_SAFETY_MARGIN: "1",
        SUPEROPS_EXECUTION_SAFE_REMAINING_TIME_MS: "0",
      },
      () =>
        runWithExecutionContext("superops_tickets_query", () =>
          domain.handleCall("superops_tickets_query", {
            createdFrom: "2026-07-01T00:00:00Z",
            createdTo: "2026-07-02T00:00:00Z",
          })
        )
    );
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).not.toBe(true);
    expect(parsed.records.map((ticket: { ticketId: string }) => ticket.ticketId)).toEqual(["1"]);
    expect(parsed.pagination).toMatchObject({
      complete: false,
      truncated: true,
      nextPage: 2,
      stopReason: "executionBudgetExhausted",
      recordsReturned: 1,
    });
    expect(parsed.errors[0]).toMatchObject({ errorType: "budget", retryable: true, attempts: 0 });
    expect(mockClient.query).toHaveBeenCalledTimes(1);
  });

  it("applies confirmed server filters separately from local reporting filters", async () => {
    mockClient.query.mockResolvedValue({ getTicketList: { tickets: [{ ticketId: "1", displayId: "1", subject: "Email", createdTime: "2026-07-01T10:00:00Z", status: "New Calls", source: "Email", category: "1. Support request", requestType: "Incident", priority: "High", client: { accountId: "c1", name: "Example" }, technician: { userId: "t1", name: "Engineer" } }, { ticketId: "2", displayId: "2", subject: "Portal", createdTime: "2026-07-01T09:00:00Z", status: "New Calls", source: "Portal", category: "2. Change request", requestType: "Service Request", priority: "Low", client: { accountId: "c2", name: "Other" }, technician: { userId: "t2", name: "Other Engineer" } }, { ticketId: "old", displayId: "old", subject: "Old", createdTime: "2026-06-30T23:00:00Z", status: "New Calls" }], listInfo: { page: 1, pageSize: 100, hasMore: false, totalCount: 3 } } });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_query", { createdFrom: "2026-07-01T00:00:00Z", createdTo: "2026-07-02T00:00:00Z", status: ["New Calls"], sources: ["Email"], categories: ["1. Support request"], requestTypes: ["Incident"], priorities: ["High"], clientNames: ["Example"], technicianIds: ["t1"] });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0]).toMatchObject({ ticketId: "1", source: "Email", category: "1. Support request" });
    expect(parsed.filterExecution).toMatchObject({ status: "server", sources: "local", categories: "local", requestTypes: "local", priorities: "local", clientNames: "local", technicianIds: "local" });
  });

  it("rejects unsupported first-version range fields, timeField, and unknown output fields", async () => {
    const domain = getTicketsTools();
    for (const unsupported of ["updatedFrom", "updatedTo", "resolvedFrom", "resolvedTo"] as const) {
      const result = await domain.handleCall("superops_tickets_query", { createdFrom: "2026-07-01T00:00:00Z", createdTo: "2026-07-02T00:00:00Z", [unsupported]: "2026-07-01T00:00:00Z" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Unsupported first-version ticket reporting input");
    }
    let result = await domain.handleCall("superops_tickets_report", { createdFrom: "2026-07-01T00:00:00Z", createdTo: "2026-07-02T00:00:00Z", timezone: "Europe/London", timeField: "resolutionTime" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("only createdTime is supported");
    result = await domain.handleCall("superops_tickets_query", { createdFrom: "2026-07-01T00:00:00Z", createdTo: "2026-07-02T00:00:00Z", fields: ["ticketId", "conversations"] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unsupported ticket reporting field");
    expect(mockClient.query).not.toHaveBeenCalled();
  });

  it("builds compact createdTime reports with timezone buckets, topN breakdowns, rows, samples, and current assignee semantics", async () => {
    mockClient.query.mockResolvedValue({ getTicketList: { tickets: [{ ticketId: "1", displayId: "1", subject: "A", createdTime: "2026-07-16T08:15:00Z", client: { accountId: "c1", name: "Example" }, technician: { userId: "t1", name: "Engineer" }, source: "Email", status: "New Calls", category: "1. Support request", priority: "High", requestType: "Incident" }, { ticketId: "2", displayId: "2", subject: "B", createdTime: "2026-07-16T08:45:00Z", client: { accountId: "c1", name: "Example" }, technician: { userId: "t1", name: "Engineer" }, source: "Portal", status: "New Calls", category: "1. Support request", priority: "Low", requestType: "Incident" }, { ticketId: "3", displayId: "3", subject: "C", createdTime: "2026-07-16T09:15:00Z", client: { accountId: "c2", name: "Other" }, technician: null, source: "Email", status: "Resolved", category: "2. Change request", priority: "Low", requestType: "Service Request" }, { ticketId: "old", displayId: "old", subject: "Old", createdTime: "2026-07-15T22:59:59Z" }], listInfo: { page: 1, pageSize: 100, hasMore: false, totalCount: 4 } } });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_report", { createdFrom: "2026-07-16T00:00:00+01:00", createdTo: "2026-07-17T00:00:00+01:00", timezone: "Europe/London", interval: "hour", groupBy: ["client", "source"], topN: 1, includeSampleTickets: true, sampleSizePerGroup: 3 });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.records).toBeUndefined();
    expect(parsed.totals.tickets).toBe(3);
    expect(parsed.series).toEqual([{ bucketStart: "2026-07-16T09:00:00+01:00", bucketEnd: "2026-07-16T10:00:00+01:00", count: 2 }, { bucketStart: "2026-07-16T10:00:00+01:00", bucketEnd: "2026-07-16T11:00:00+01:00", count: 1 }]);
    expect(parsed.breakdowns.client).toEqual([{ key: "Example", count: 2, percentage: 66.67 }]);
    expect(parsed.rows).toEqual(expect.arrayContaining([expect.objectContaining({ bucketStart: "2026-07-16T09:00:00+01:00", client: "Example", source: "Email", count: 1 })]));
    expect(parsed.samples.client[0].tickets[0]).toEqual(expect.objectContaining({ displayId: "1", subject: "A", client: "Example", technician: "Engineer" }));
    expect(parsed.technicianSemantics).toBe("currentAssigneeAtQueryTime");
    expect(parsed.pagination).toMatchObject({ complete: true, recordsAnalysed: 3 });
  });

  it("handles GMT, BST, day, week, month, empty page, and incomplete report diagnostics", async () => {
    const domain = getTicketsTools();
    mockClient.query.mockResolvedValueOnce({ getTicketList: { tickets: [], listInfo: { page: 1, pageSize: 100, hasMore: false, totalCount: 0 } } });
    let result = await domain.handleCall("superops_tickets_query", { createdFrom: "2026-01-01T00:00:00Z", createdTo: "2026-01-02T00:00:00Z" });
    let parsed = JSON.parse(result.content[0].text);
    expect(parsed.pagination).toMatchObject({ complete: true, stopReason: "emptyPage" });

    mockClient.query.mockReset();
    mockClient.query.mockResolvedValue({ getTicketList: { tickets: [{ ticketId: "gmt", displayId: "gmt", subject: "GMT", createdTime: "2026-01-01T10:00:00Z" }, { ticketId: "old", displayId: "old", subject: "Old", createdTime: "2025-12-31T23:59:59Z" }], listInfo: { page: 1, pageSize: 100, hasMore: false, totalCount: 2 } } });
    result = await domain.handleCall("superops_tickets_report", { createdFrom: "2026-01-01T00:00:00Z", createdTo: "2026-01-02T00:00:00Z", timezone: "Europe/London", interval: "day" });
    parsed = JSON.parse(result.content[0].text);
    expect(parsed.series[0]).toMatchObject({ bucketStart: "2026-01-01T00:00:00+00:00", bucketEnd: "2026-01-02T00:00:00+00:00", count: 1 });

    mockClient.query.mockReset();
    mockClient.query.mockResolvedValue({ getTicketList: { tickets: [{ ticketId: "week", displayId: "week", subject: "Week", createdTime: "2026-07-16T10:00:00Z" }, { ticketId: "old", displayId: "old", subject: "Old", createdTime: "2026-07-01T00:00:00Z" }], listInfo: { page: 1, pageSize: 100, hasMore: false, totalCount: 2 } } });
    result = await domain.handleCall("superops_tickets_report", { createdFrom: "2026-07-13T00:00:00+01:00", createdTo: "2026-07-20T00:00:00+01:00", timezone: "Europe/London", interval: "week" });
    parsed = JSON.parse(result.content[0].text);
    expect(parsed.series[0]).toMatchObject({ bucketStart: "2026-07-13T00:00:00+01:00", count: 1 });

    mockClient.query.mockReset();
    mockClient.query.mockResolvedValue({ getTicketList: { tickets: [{ ticketId: "month", displayId: "month", subject: "Month", createdTime: "2026-07-16T10:00:00Z" }], listInfo: { page: 1, pageSize: 100, hasMore: true, totalCount: 200 } } });
    result = await domain.handleCall("superops_tickets_report", { createdFrom: "2026-07-01T00:00:00+01:00", createdTo: "2026-08-01T00:00:00+01:00", timezone: "Europe/London", interval: "month", maxPages: 1 });
    parsed = JSON.parse(result.content[0].text);
    expect(parsed.series[0]).toMatchObject({ bucketStart: "2026-07-01T00:00:00+01:00", count: 1 });
    expect(parsed.pagination).toMatchObject({ complete: false, truncated: true, stopReason: "maxPagesReached", recordsAnalysed: 1 });
  });
  it("exposes tenant-specific status and category enums", () => {
    const domain = getTicketsTools();
    const listTool = domain.tools.find((tool) => tool.name === "superops_tickets_list");
    const createTool = domain.tools.find((tool) => tool.name === "superops_tickets_create");
    const resolveTool = domain.tools.find(
      (tool) => tool.name === "superops_tickets_resolve_full"
    );
    const updateTool = domain.tools.find((tool) => tool.name === "superops_tickets_update");
    const fieldOptionsTool = domain.tools.find(
      (tool) => tool.name === "superops_tickets_field_options"
    );

    const listStatus = listTool?.inputSchema.properties.status as {
      items?: { enum?: string[] };
    };
    const createCategory = createTool?.inputSchema.properties.categoryName as {
      enum?: string[];
    };
    const updateStatus = updateTool?.inputSchema.properties.status as {
      enum?: string[];
    };
    const updateCategory = updateTool?.inputSchema.properties.category as {
      enum?: string[];
    };
    const fieldOptionsFields = fieldOptionsTool?.inputSchema.properties.fields as {
      items: { enum: string[] };
    };

    expect(listStatus.items?.enum).toEqual(VALID_TICKET_STATUSES);
    expect(updateStatus.enum).toEqual(VALID_TICKET_STATUSES);
    expect(createCategory.enum).toEqual(VALID_TICKET_CATEGORIES);
    expect(updateCategory.enum).toEqual(VALID_TICKET_CATEGORIES);
    expect(resolveTool?.inputSchema.properties.urgency).toBeDefined();
    expect(updateTool?.inputSchema.properties.impact).toBeDefined();
    expect(updateTool?.inputSchema.properties.urgency).toBeDefined();
    expect(updateTool?.inputSchema.properties.resolutionCode).toBeDefined();
    expect(updateTool?.inputSchema.properties.cause).toBeDefined();
    expect(updateTool?.inputSchema.properties.subcategory).toBeDefined();
    expect(fieldOptionsFields.items.enum).toContain("urgency");
  });

  it("returns urgency in ticket field option discovery", async () => {
    mockClient.query.mockResolvedValue({
      getFields: [
        ticketField("priority", ["Very Low"]),
        ticketField("impact", ["Low"]),
        ticketField("urgency", ["Low"]),
      ],
    });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_field_options", {});
    const parsed = JSON.parse(result.content[0].text);

    expect(mockClient.query).toHaveBeenCalledWith(expect.stringContaining("getFields"), {
      input: [
        { module: "TICKET", columnName: "priority" },
        { module: "TICKET", columnName: "impact" },
        { module: "TICKET", columnName: "urgency" },
        { module: "TICKET", columnName: "resolutionCode" },
        { module: "TICKET", columnName: "cause" },
        { module: "TICKET", columnName: "subcategory" },
      ],
    });
    expect(parsed.urgency.options[0].value).toBe("Low");
  });

  it("uses documented ticket fields in list and get queries", async () => {
    mockClient.query.mockResolvedValueOnce({
      getTicketList: {
        tickets: [],
        listInfo: { page: 1, pageSize: 50, hasMore: false, totalCount: 0 },
      },
    });
    mockClient.query.mockResolvedValueOnce({
      getTicket: { ticketId: "ticket-123", displayId: "062822-0001", subject: "Test" },
    });

    const domain = getTicketsTools();
    await domain.handleCall("superops_tickets_list", { page: 1 });
    await domain.handleCall("superops_tickets_get", { ticketId: "ticket-123" });

    const listQuery = mockClient.query.mock.calls[0][0];
    const getQuery = mockClient.query.mock.calls[1][0];
    expect(listQuery).toContain("displayId");
    expect(listQuery).toContain("technician");
    expect(listQuery).not.toContain("ticketNumber");
    expect(listQuery).not.toContain("hasNextPage");
    expect(getQuery).toContain("updatedTime");
    expect(getQuery).toContain("customFields");
    expect(getQuery).not.toContain("description");
    expect(getQuery).not.toContain("assignee");
  });

  it("gets a ticket by documented TicketIdentifierInput", async () => {
    mockClient.query.mockResolvedValue({
      getTicket: {
        ticketId: "ticket-123",
        subject: "Test Issue",
      },
    });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_get", {
      ticketId: "ticket-123",
    });

    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining("getTicket"),
      { input: { ticketId: "ticket-123" } }
    );
    expect(result.content[0].text).toContain("Test Issue");
  });

  it("gets tickets by number after normalising number, string, and hash-prefixed input", async () => {
    const inputs: Array<string | number> = [57072, "57072", "#57072"];
    const domain = getTicketsTools();

    for (const ticketNumber of inputs) {
      mockClient.query
        .mockResolvedValueOnce({
          getTicketList: {
            tickets: [
              {
                ticketId: "ticket-57072",
                displayId: "57072",
                subject: "Lookup ticket",
              },
            ],
            listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 },
          },
        })
        .mockResolvedValueOnce({
          getTicket: {
            ticketId: "ticket-57072",
            displayId: "57072",
            subject: "Lookup ticket detail",
          },
        });

      const result = await domain.handleCall("superops_tickets_get_by_number", {
        ticketNumber,
      });

      expect(mockClient.query.mock.calls[0][0]).toContain("getTicketList");
      expect(mockClient.query.mock.calls[0][1]).toEqual({
        input: {
          page: 1,
          pageSize: 5,
          condition: {
            attribute: "displayId",
            operator: "is",
            value: "57072",
          },
        },
      });
      expect(mockClient.query.mock.calls[1][0]).toContain("getTicket");
      expect(mockClient.query.mock.calls[1][1]).toEqual({
        input: { ticketId: "ticket-57072" },
      });
      expect(result.content[0].text).toContain("Lookup ticket detail");

      mockClient.query.mockClear();
    }
  });

  it("returns an error when ticket number lookup finds no match", async () => {
    mockClient.query.mockResolvedValue({
      getTicketList: {
        tickets: [],
        listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 0 },
      },
    });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_get_by_number", {
      ticketNumber: "#57072",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("No ticket was found");
    expect(result.content[0].text).toContain("57072");
  });

  it("returns an error when ticket number lookup is not unique", async () => {
    mockClient.query.mockResolvedValue({
      getTicketList: {
        tickets: [
          { ticketId: "ticket-1", displayId: "57072", subject: "First match" },
          { ticketId: "ticket-2", displayId: "57072", subject: "Second match" },
        ],
        listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 2 },
      },
    });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_get_by_number", {
      ticketNumber: "57072",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not unique");
    expect(result.content[0].text).toContain("ticket-1");
    expect(result.content[0].text).toContain("ticket-2");
  });

  it("includes conversations and notes when getting a ticket by number with content", async () => {
    mockClient.query
      .mockResolvedValueOnce({
        getTicketList: {
          tickets: [
            {
              ticketId: "ticket-57072",
              displayId: "57072",
              subject: "Lookup ticket",
            },
          ],
          listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 },
        },
      })
      .mockResolvedValueOnce({
        getTicket: {
          ticketId: "ticket-57072",
          displayId: "57072",
          subject: "Lookup ticket detail",
        },
      })
      .mockResolvedValueOnce({
        getTicketConversationList: [
          {
            conversationId: "conversation-1",
            content: "Customer message",
            time: "2026-06-25T10:00:00",
            type: "REQ_REPLY",
          },
        ],
      })
      .mockResolvedValueOnce({
        getTicketNoteList: [
          {
            noteId: "note-1",
            addedOn: "2026-06-25T10:05:00",
            content: "Internal note",
          },
        ],
      });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_get_by_number", {
      ticketNumber: "#57072",
      includeContent: true,
    });

    expect(mockClient.query.mock.calls[2][0]).toContain("getTicketConversationList");
    expect(mockClient.query.mock.calls[2][1]).toEqual({
      input: { ticketId: "ticket-57072" },
    });
    expect(mockClient.query.mock.calls[3][0]).toContain("getTicketNoteList");
    expect(mockClient.query.mock.calls[3][1]).toEqual({
      input: { ticketId: "ticket-57072" },
    });
    expect(result.content[0].text).toContain("conversations");
    expect(result.content[0].text).toContain("notes");
    expect(result.content[0].text).toContain("Customer message");
    expect(result.content[0].text).toContain("Internal note");
  });

  it("safely gets a ticket by number with metadata and sanitized plain text", async () => {
    const base64Blob = "QUJD".repeat(40);
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0LXVzZXIifQ.signaturevalue123";

    mockClient.query
      .mockResolvedValueOnce({
        getTicketList: {
          tickets: [
            { ticketId: "ticket-55841", displayId: "55841", subject: "Unsafe" },
          ],
          listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 },
        },
      })
      .mockResolvedValueOnce({
        getTicket: {
          ticketId: "ticket-55841",
          displayId: "55841",
          subject: "Unsafe",
          client: { name: "TaskGroup" },
          site: { name: "HQ" },
          requester: { name: "Alex Requester", email: "alex@example.test" },
          status: "New Calls",
          priority: "High",
          impact: "High",
          urgency: "High",
          category: "1. Support request",
          subcategory: "Wireless",
          cause: "Unknown",
          resolutionCode: "Permanent Fix",
          createdTime: "2026-06-25T09:00:00",
          updatedTime: "2026-06-25T10:00:00",
        },
      })
      .mockResolvedValueOnce({
        getTicketConversationList: [
          {
            conversationId: "conversation-1",
            content:
              "<html><body><p>User reports VMware internal inconsistency errors when opening the VM.</p><script>alert('bad')</script>Authorization: Bearer abc.def.ghi<img src=\"cid:trackingimage\"></body></html>\r\nReceived: by mx.example\r\nDKIM-Signature: abc\r\n MIME-Version: 1.0\r\n<p>Hello <b>team</b><img src=\"cid:image001\"></p> password=secret123 data:image/png;base64,AAAA " +
              base64Blob,
            time: "2026-06-25T10:00:00",
            type: "REQ_REPLY",
            user: { name: "Alex Requester", email: "alex@example.test" },
            attachments: [
              {
                fileName: "stored-1",
                originalFileName: "invoice.html",
                fileSize: "34821",
                content: "<html>raw attachment body</html>",
              },
            ],
          },
          {
            conversationId: "conversation-2",
            content:
              "<object>bad</object><embed src='bad'><svg>bad</svg><form><input value='secret'><button>bad</button></form> Technician reply " +
              jwt,
            time: "2026-06-25T10:05:00",
            type: "TECH_REPLY",
            user: { name: "Tech User" },
          },
        ],
      })
      .mockResolvedValueOnce({
        getTicketNoteList: [
          {
            noteId: "note-1",
            addedBy: { name: "Internal Tech" },
            addedOn: "2026-06-25T10:10:00",
            content:
              "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\nInternal note",
            privacyType: "PRIVATE",
            attachments: [
              {
                fileName: "debug.log",
                originalFileName: "debug.log",
                fileSize: "100",
                body: "raw attachment body",
              },
            ],
          },
        ],
      });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_get_safe_by_number", {
      ticketNumber: "55841",
    });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    const serialized = JSON.stringify(parsed);

    expect(mockClient.mutate).not.toHaveBeenCalled();
    expect(parsed).toMatchObject({
      ticketNumber: "55841",
      ticketId: "ticket-55841",
      subject: "Unsafe",
      client: "TaskGroup",
      site: "HQ",
      requesterName: "Alex Requester",
      requesterEmail: "alex@example.test",
      status: "New Calls",
    });
    expect(mockClient.query.mock.calls[1][0]).toContain("getTicket");
    expect(mockClient.query.mock.calls[1][0]).not.toContain("description");
    expect(parsed.safeContent.items.length).toBeGreaterThan(0);
    expect(parsed.contentAvailability).toMatchObject({
      ticketBody: {
        requested: true,
        available: false,
        source: "notAvailableInLiveSchema",
      },
      conversations: { requested: true, available: true, count: 2 },
      notes: { requested: true, available: true, count: 1 },
      degraded: false,
    });
    expect(serialized).toContain(
      "User reports VMware internal inconsistency errors when opening the VM."
    );
    expect(serialized).toContain("Hello team");
    expect(serialized).toContain("[removed embedded image]");
    expect(serialized).toContain("[removed base64 content]");
    expect(serialized).toContain("[redacted credential/token]");
    expect(serialized).not.toContain("alert('bad')");
    expect(serialized).not.toContain("Authorization:");
    expect(serialized).not.toContain("abc.def.ghi");
    expect(serialized).not.toContain("cid:trackingimage");
    expect(serialized).not.toContain("<html");
    expect(serialized).not.toContain("<body");
    expect(serialized).not.toContain("<script");
    expect(serialized).not.toContain("<style");
    expect(serialized).not.toContain("<iframe");
    expect(serialized).not.toContain("<object");
    expect(serialized).not.toContain("<embed");
    expect(serialized).not.toContain("<svg");
    expect(serialized).not.toContain("<form");
    expect(serialized).not.toContain("<input");
    expect(serialized).not.toContain("<button");
    expect(serialized).not.toContain("Received:");
    expect(serialized).not.toContain("DKIM-Signature");
    expect(serialized).not.toContain("secret123");
    expect(serialized).not.toContain(jwt);
    expect(serialized).not.toContain("PRIVATE KEY");
    expect(serialized).not.toContain("raw attachment body");
    expect(parsed.attachments).toEqual([
      { filename: "invoice.html", size: "34821" },
      { filename: "debug.log", size: "100" },
    ]);
    expect(parsed.latestCustomerMessage.id).toBe("conversation-1");
    expect(parsed.latestInternalNote.id).toBe("note-1");
    expect(parsed.latestTechnicianReply.id).toBe("conversation-2");
    expect(parsed.sanitization).toMatchObject({
      htmlStripped: true,
      headersRemoved: true,
      credentialsRedacted: true,
      base64Removed: true,
      attachmentsMetadataOnly: true,
      itemsReturned: 3,
    });
  });

  it("truncates safe ticket items, respects total limits, and orders oldest first when requested", async () => {
    mockClient.query
      .mockResolvedValueOnce({
        getTicketList: {
          tickets: [{ ticketId: "ticket-55841", displayId: "55841", subject: "Long" }],
          listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 },
        },
      })
      .mockResolvedValueOnce({
        getTicket: { ticketId: "ticket-55841", displayId: "55841", subject: "Long" },
      })
      .mockResolvedValueOnce({
        getTicketConversationList: [
          {
            conversationId: "conversation-old",
            content: "Old " + Array(80).fill("visible").join(" "),
            time: "2026-06-25T09:00:00",
            type: "REQ_REPLY",
          },
          {
            conversationId: "conversation-new",
            content: "New " + Array(80).fill("visible").join(" "),
            time: "2026-06-25T10:00:00",
            type: "REQ_REPLY",
          },
        ],
      })
      .mockResolvedValueOnce({
        getTicketNoteList: [
          {
            noteId: "note-newer",
            addedOn: "2026-06-25T11:00:00",
            content: "Note " + Array(80).fill("visible").join(" "),
            privacyType: "PRIVATE",
          },
        ],
      });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_get_safe_by_number", {
      ticketNumber: 55841,
      latestFirst: false,
      maxItems: 50,
      maxCharsPerItem: 120,
      maxTotalChars: 150,
      attachments: "none",
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.safeContent.items[0].id).toBe("conversation-old");
    expect(parsed.safeContent.items[0].plainText).toContain(
      "[... content truncated by safe retrieval ...]"
    );
    expect(
      parsed.safeContent.items.reduce(
        (total: number, item: { plainText: string }) => total + item.plainText.length,
        0
      )
    ).toBeLessThanOrEqual(150);
    expect(parsed.safeContent.items.length).toBeLessThan(3);
    expect(parsed.attachments).toEqual([]);
    expect(parsed.sanitization.truncated).toBe(true);
    expect(parsed.sanitization.itemsOmittedByLimit).toBeGreaterThan(0);
  });

  it("returns safe metadata with content errors if note or conversation fetches fail", async () => {
    mockClient.query
      .mockResolvedValueOnce({
        getTicketList: {
          tickets: [{ ticketId: "ticket-55841", displayId: "55841", subject: "Partial" }],
          listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 },
        },
      })
      .mockResolvedValueOnce({
        getTicket: {
          ticketId: "ticket-55841",
          displayId: "55841",
          subject: "Partial",
        },
      })
      .mockRejectedValueOnce(
        new Error("Received: bad\r\nAuthorization: Bearer secret-token raw failure")
      )
      .mockResolvedValueOnce({
        getTicketNoteList: [
          {
            noteId: "note-available",
            addedOn: "2026-06-25T10:05:00",
            content: "<p>Technician found useful diagnostic details.</p>",
            privacyType: "PRIVATE",
          },
        ],
      });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_get_safe_by_number", {
      ticketNumber: "55841",
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.ticketId).toBe("ticket-55841");
    expect(parsed.safeContent.contentWarnings[0]).toContain(
      "Conversations could not be fetched safely"
    );
    expect(parsed.safeContent.contentWarnings[0]).not.toContain("secret-token");
    expect(parsed.safeContent.contentWarnings[0]).not.toContain("Received:");
    expect(parsed.safeContent.items).toEqual([
      expect.objectContaining({
        id: "note-available",
        plainText: "Technician found useful diagnostic details.",
      }),
    ]);
    expect(parsed.contentAvailability).toMatchObject({
      conversations: { requested: true, available: false, count: 0 },
      notes: { requested: true, available: true, count: 1 },
      degraded: false,
    });
  });

  it("creates a read-only New Calls triage snapshot from a frozen candidate list", async () => {
    const base64Blob = "QUJD".repeat(40);
    mockClient.query
      .mockResolvedValueOnce({
        getTicketList: {
          tickets: [
            {
              ticketId: "ticket-57400",
              displayId: "57400",
              subject: "Sales call",
              status: "New Calls",
            },
            {
              ticketId: "ticket-57401",
              displayId: "57401",
              subject: "No content",
              status: "New Calls",
            },
          ],
          listInfo: { page: 1, pageSize: 50, hasMore: false, totalCount: 2 },
        },
      })
      .mockResolvedValueOnce({
        getTicket: {
          ticketId: "ticket-57400",
          displayId: "57400",
          subject: "Sales call",
          client: { name: "TaskGroup" },
          site: { name: "HQ" },
          requester: { name: "Alex", email: "alex@example.test" },
          status: "New Calls",
          priority: "High",
          impact: "High",
          urgency: "High",
          category: "7. Sales call",
          createdTime: "2026-06-25T09:00:00",
          updatedTime: "2026-06-25T10:00:00",
        },
      })
      .mockResolvedValueOnce({
        getTicketConversationList: [
          {
            conversationId: "description-1",
            type: "DESCRIPTION",
            time: "2026-06-25T09:00:00",
            user: { name: "Alex" },
            content:
              "<p>Original body</p><img src=\"https://cdn.example.test/image.png?token=secret\">\r\nReceived: by mx\r\nAuthorization: Bearer abc.def.ghi\r\npassword=secret " +
              base64Blob,
            attachments: [
              {
                fileName: "stored-1",
                originalFileName: "call.html",
                fileSize: "123",
                body: "raw attachment body",
              },
            ],
          },
        ],
      })
      .mockResolvedValueOnce({
        getTicketNoteList: [
          {
            noteId: "note-1",
            addedOn: "2026-06-25T09:10:00",
            addedBy: { name: "Tech" },
            privacyType: "PRIVATE",
            content:
              "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\nUseful note",
            attachments: [
              {
                fileName: "debug.txt",
                originalFileName: "debug.txt",
                fileSize: "50",
                content: "raw attachment body",
              },
            ],
          },
        ],
      })
      .mockResolvedValueOnce({
        getTicket: {
          ticketId: "ticket-57401",
          displayId: "57401",
          subject: "No content",
          status: "New Calls",
        },
      })
      .mockResolvedValueOnce({ getTicketConversationList: [] })
      .mockResolvedValueOnce({ getTicketNoteList: [] });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_triage_snapshot", {
      status: ["New Calls"],
      max: 50,
      page: 1,
      safeRead: false,
      includeNotes: true,
      includeConversations: true,
      includeAttachments: "metadataOnly",
      maxContentCharsPerTicket: 220,
      maxItemsPerTicket: 8,
      latestFirst: true,
      storeBatch: true,
    });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    const serialized = JSON.stringify(parsed);

    expect(mockClient.query.mock.calls[0][0]).toContain("getTicketList");
    expect(mockClient.query.mock.calls[0][1]).toEqual({
      input: {
        page: 1,
        pageSize: 50,
        condition: { attribute: "status", operator: "is", value: "New Calls" },
      },
    });
    expect(mockClient.query.mock.calls.map((call) => call[0]).join("\n")).not.toContain(
      "getFields"
    );
    expect(mockClient.query.mock.calls.map((call) => call[0]).join("\n")).not.toContain(
      "description"
    );
    expect(mockClient.query.mock.calls[0][1].input).not.toHaveProperty("sort");
    expect(mockClient.mutate).not.toHaveBeenCalled();
    expect(parsed.source).toEqual({ status: ["New Calls"], page: 1, max: 50 });
    expect(parsed.initialCandidateCount).toBe(2);
    expect(parsed.candidateTicketNumbers).toEqual(["57400", "57401"]);
    expect(parsed.tickets).toHaveLength(2);
    expect(parsed.safety).toEqual({
      safeReadUsed: true,
      rawHtmlReturned: false,
      attachmentBodiesReturned: false,
    });
    expect(parsed.tickets[0]).toMatchObject({
      ticketNumber: "57400",
      ticketId: "ticket-57400",
      subject: "Sales call",
      client: "TaskGroup",
      processingState: "SnapshotRead",
      contentAvailability: {
        metadata: "available",
        descriptionField: "notAvailableInSchema",
        conversations: "available",
        notes: "available",
        attachments: "metadataOnly",
      },
    });
    expect(parsed.tickets[0].safeContentItems).toEqual([
      expect.objectContaining({ type: "internal_note", plainText: expect.any(String) }),
      expect.objectContaining({ type: "description", plainText: expect.any(String) }),
    ]);
    expect(parsed.tickets[0].attachments).toEqual([
      { filename: "call.html", size: "123" },
      { filename: "debug.txt", size: "50" },
    ]);
    expect(parsed.tickets[0].contentSourceNotes[0]).toContain(
      "DESCRIPTION items"
    );
    expect(parsed.tickets[0].warnings).toEqual([]);
    expect(parsed.tickets[1]).toMatchObject({
      ticketNumber: "57401",
      processingState: "MetadataOnly",
      safeContentItems: [],
      contentAvailability: {
        conversations: "unavailable",
        notes: "unavailable",
      },
    });
    expect(serialized).toContain("Original body");
    expect(serialized).toContain("Useful note");
    expect(serialized).toContain("[removed base64 content]");
    expect(serialized).toContain("[redacted credential/token]");
    expect(serialized).not.toContain("<p>");
    expect(serialized).not.toContain("Received:");
    expect(serialized).not.toContain("Authorization:");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("PRIVATE KEY");
    expect(serialized).not.toContain("raw attachment body");
    expect(parsed.tickets[0].safeContentItems[1].plainText.length).toBeLessThanOrEqual(
      220
    );
  });

  it("keeps DESCRIPTION evidence in triage snapshots when canonical ticket content includes a newer acknowledgement", async () => {
    const automatedAcknowledgement = {
      conversationId: "conversation-ack",
      type: "TECH_REPLY",
      time: "2026-07-21T10:05:00Z",
      user: { name: "Task Group" },
      content: "Task Group automated acknowledgement: we have received your request.",
    };
    const customerDescription = {
      conversationId: "description-request",
      type: "DESCRIPTION",
      time: "2026-07-21T10:00:00Z",
      user: { name: "Catherine Cooper" },
      content:
        "Please could Catherine Cooper have access to the Twelve Trees SharePoint page as soon as possible.",
    };

    mockClient.query.mockImplementation(
      async (query: string, variables?: { input?: { ticketId?: string } }) => {
        if (query.includes("getTicketList")) {
          return {
            getTicketList: {
              tickets: [
                {
                  ticketId: "candidate-58744",
                  displayId: "58744",
                  subject: "SharePoint access",
                  status: "New Calls",
                },
              ],
              listInfo: { page: 1, pageSize: 20, hasMore: false, totalCount: 1 },
            },
          };
        }

        if (query.includes("getTicket(input")) {
          return {
            getTicket: {
              ticketId: "ticket-58744",
              displayId: "58744",
              subject: "SharePoint access",
              status: "New Calls",
              createdTime: "2026-07-21T10:00:00Z",
              updatedTime: "2026-07-21T10:06:00Z",
            },
          };
        }

        if (query.includes("getTicketConversationList")) {
          return {
            getTicketConversationList:
              variables?.input?.ticketId === "ticket-58744"
                ? [automatedAcknowledgement, customerDescription]
                : [automatedAcknowledgement],
          };
        }

        if (query.includes("getTicketNoteList")) {
          return { getTicketNoteList: [] };
        }

        throw new Error(`Unexpected query: ${query}`);
      }
    );

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_triage_snapshot", {
      status: ["New Calls"],
      max: 20,
      page: 1,
      safeRead: true,
      includeNotes: true,
      includeConversations: true,
      includeAttachments: "metadataOnly",
      maxContentCharsPerTicket: 2500,
      maxItemsPerTicket: 6,
      latestFirst: true,
      storeBatch: false,
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    const contentReadCall = mockClient.query.mock.calls.find((call) =>
      call[0].includes("getTicketConversationList")
    );

    expect(contentReadCall?.[1]).toEqual({ input: { ticketId: "ticket-58744" } });
    expect(mockClient.mutate).not.toHaveBeenCalled();
    expect(parsed.tickets[0].safeContentItems).toEqual([
      expect.objectContaining({
        type: "technician_reply",
        plainText: expect.stringContaining("automated acknowledgement"),
      }),
      expect.objectContaining({
        type: "description",
        plainText: expect.stringContaining(
          "Please could Catherine Cooper have access to the Twelve Trees SharePoint page"
        ),
      }),
    ]);
    expect(parsed.tickets[0].safeSummary).toContain("automated acknowledgement");
    expect(parsed.tickets[0].safeSummary).toContain(
      "Please could Catherine Cooper have access to the Twelve Trees SharePoint page"
    );
  });

  it("applies triage snapshot item-count limits after ordering safe content", async () => {
    mockClient.query
      .mockResolvedValueOnce({
        getTicketList: {
          tickets: [
            {
              ticketId: "ticket-limits",
              displayId: "58745",
              subject: "Limited evidence",
              status: "New Calls",
            },
          ],
          listInfo: { page: 1, pageSize: 20, hasMore: false, totalCount: 1 },
        },
      })
      .mockResolvedValueOnce({
        getTicket: {
          ticketId: "ticket-limits",
          displayId: "58745",
          subject: "Limited evidence",
          status: "New Calls",
        },
      })
      .mockResolvedValueOnce({
        getTicketConversationList: [
          {
            conversationId: "conversation-newest",
            type: "TECH_REPLY",
            time: "2026-07-21T10:05:00Z",
            content: "Newest acknowledgement retained by latest-first ordering.",
          },
          {
            conversationId: "description-original",
            type: "DESCRIPTION",
            time: "2026-07-21T10:00:00Z",
            content: "Original customer request that should be omitted only by item limit.",
          },
        ],
      })
      .mockResolvedValueOnce({ getTicketNoteList: [] });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_triage_snapshot", {
      status: ["New Calls"],
      max: 20,
      page: 1,
      includeNotes: true,
      includeConversations: true,
      maxContentCharsPerTicket: 2500,
      maxItemsPerTicket: 1,
      latestFirst: true,
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.tickets[0].safeContentItems).toEqual([
      expect.objectContaining({
        type: "technician_reply",
        plainText: "Newest acknowledgement retained by latest-first ordering.",
      }),
    ]);
    expect(JSON.stringify(parsed.tickets[0].safeContentItems)).not.toContain(
      "Original customer request"
    );
  });

  it("applies triage snapshot character limits to safe content", async () => {
    mockClient.query
      .mockResolvedValueOnce({
        getTicketList: {
          tickets: [
            {
              ticketId: "ticket-char-limit",
              displayId: "58746",
              subject: "Character limited evidence",
              status: "New Calls",
            },
          ],
          listInfo: { page: 1, pageSize: 20, hasMore: false, totalCount: 1 },
        },
      })
      .mockResolvedValueOnce({
        getTicket: {
          ticketId: "ticket-char-limit",
          displayId: "58746",
          subject: "Character limited evidence",
          status: "New Calls",
        },
      })
      .mockResolvedValueOnce({
        getTicketConversationList: [
          {
            conversationId: "conversation-short",
            type: "TECH_REPLY",
            time: "2026-07-21T10:05:00Z",
            content: "Short acknowledgement.",
          },
          {
            conversationId: "description-too-long",
            type: "DESCRIPTION",
            time: "2026-07-21T10:00:00Z",
            content:
              "Original customer request with more detail than this snapshot character budget can include.",
          },
        ],
      })
      .mockResolvedValueOnce({ getTicketNoteList: [] });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_triage_snapshot", {
      status: ["New Calls"],
      max: 20,
      page: 1,
      includeNotes: true,
      includeConversations: true,
      maxContentCharsPerTicket: 35,
      maxItemsPerTicket: 6,
      latestFirst: true,
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.tickets[0].safeContentItems).toEqual([
      expect.objectContaining({
        type: "technician_reply",
        plainText: "Short acknowledgement.",
      }),
    ]);
    expect(JSON.stringify(parsed.tickets[0].safeContentItems)).not.toContain(
      "Original customer request"
    );
  });
  it("returns every triage snapshot candidate when safe content is unavailable", async () => {
    mockClient.query
      .mockResolvedValueOnce({
        getTicketList: {
          tickets: [
            {
              ticketId: "ticket-57402",
              displayId: "57402",
              subject: "Partial",
              status: "New Calls",
            },
          ],
          listInfo: { page: 1, pageSize: 50, hasMore: false, totalCount: 1 },
        },
      })
      .mockRejectedValueOnce(new Error("metadata failed"))
      .mockRejectedValueOnce(new Error("conversation failed"))
      .mockRejectedValueOnce(new Error("notes failed"));

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_triage_snapshot", {});
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.candidateTicketNumbers).toEqual(["57402"]);
    expect(parsed.tickets).toEqual([
      expect.objectContaining({
        ticketNumber: "57402",
        ticketId: "ticket-57402",
        processingState: "Failed",
        warnings: expect.arrayContaining([
          expect.stringContaining("Metadata could not be fetched safely"),
          expect.stringContaining("Conversations could not be fetched safely"),
          expect.stringContaining("Notes could not be fetched safely"),
        ]),
      }),
    ]);
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });
  it("keeps normal get_by_number content behaviour unchanged", async () => {
    mockClient.query
      .mockResolvedValueOnce({
        getTicketList: {
          tickets: [{ ticketId: "ticket-57072", displayId: "57072", subject: "Raw" }],
          listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 },
        },
      })
      .mockResolvedValueOnce({
        getTicket: { ticketId: "ticket-57072", displayId: "57072", subject: "Raw" },
      })
      .mockResolvedValueOnce({
        getTicketConversationList: [
          {
            conversationId: "conversation-raw",
            content: "<script>alert('still raw')</script>",
            time: "2026-06-25T10:00:00",
            type: "REQ_REPLY",
          },
        ],
      })
      .mockResolvedValueOnce({ getTicketNoteList: [] });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_get_by_number", {
      ticketNumber: "57072",
      includeContent: true,
    });

    expect(result.content[0].text).toContain("<script>alert('still raw')</script>");
  });

  it("lists ticket conversations using documented TicketIdentifierInput", async () => {
    mockClient.query.mockResolvedValue({
      getTicketConversationList: [
        {
          conversationId: "conversation-123",
          content: "Customer reply",
          time: "2026-06-25T10:00:00",
          user: { userId: "requester-1", name: "Requester" },
          toUsers: [{ user: { email: "support@example.com" } }],
          ccUsers: [],
          bccUsers: [],
          attachments: [
            {
              fileName: "log.txt",
              originalFileName: "log.txt",
              fileSize: "128",
            },
          ],
          type: "REQ_REPLY",
        },
      ],
    });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_conversation_list", {
      ticketId: "ticket-123",
    });

    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining("getTicketConversationList"),
      { input: { ticketId: "ticket-123" } }
    );
    expect(mockClient.query.mock.calls[0][0]).toContain("TicketIdentifierInput");
    expect(mockClient.query.mock.calls[0][0]).toContain("conversationId");
    expect(mockClient.query.mock.calls[0][0]).toContain("toUsers");
    expect(mockClient.query.mock.calls[0][0]).toContain("fileName");
    expect(result.content[0].text).toContain("Customer reply");
    expect(result.content[0].text).toContain("log.txt");
  });

  it("lists ticket notes using documented TicketIdentifierInput", async () => {
    mockClient.query.mockResolvedValue({
      getTicketNoteList: [
        {
          noteId: "note-123",
          addedBy: { userId: "tech-1", name: "Technician" },
          addedOn: "2026-06-25T10:05:00",
          content: "Internal update",
          attachments: [
            {
              fileName: "screenshot.png",
              originalFileName: "screenshot.png",
              fileSize: "2048",
            },
          ],
          privacyType: "PRIVATE",
        },
      ],
    });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_notes_list", {
      ticketId: "ticket-123",
    });

    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining("getTicketNoteList"),
      { input: { ticketId: "ticket-123" } }
    );
    expect(mockClient.query.mock.calls[0][0]).toContain("TicketIdentifierInput");
    expect(mockClient.query.mock.calls[0][0]).toContain("noteId");
    expect(mockClient.query.mock.calls[0][0]).toContain("privacyType");
    expect(mockClient.query.mock.calls[0][0]).toContain("fileName");
    expect(result.content[0].text).toContain("Internal update");
    expect(result.content[0].text).toContain("screenshot.png");
  });

  it("creates tickets with tenant default status and configured category", async () => {
    mockClient.mutate.mockResolvedValue({
      createTicket: {
        ticketId: "created-ticket",
        displayId: "062822-0005",
        subject: "Tenant Issue",
      },
    });
    mockClient.query.mockResolvedValue({
      getTicket: {
        ticketId: "created-ticket",
        displayId: "062822-0005",
        subject: "Tenant Issue",
        status: "New Calls",
        category: "1. Support request",
      },
    });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_create", {
      subject: "Tenant Issue",
      clientId: "client-123",
      description: "Detailed description",
      requesterEmail: "user@example.com",
      techGroupName: "Support Team",
      categoryName: "1. Support request",
    });

    expect(mockClient.mutate).toHaveBeenCalledWith(
      expect.stringContaining("createTicket"),
      {
        input: {
          subject: "Tenant Issue",
          client: { accountId: "client-123" },
          status: "New Calls",
          requestType: "Incident",
          source: "FORM",
          description: "Detailed description",
          category: "1. Support request",
        },
      }
    );
    expect(mockClient.mutate.mock.calls[0][0]).toContain("displayId");
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining("getTicket"),
      { input: { ticketId: "created-ticket" } }
    );
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      result: { ticketId: "created-ticket" },
      finalOutcome: "Created",
      verification: {
        performed: true,
        possible: true,
        verified: true,
        result: { ticketId: "created-ticket", status: "New Calls" },
      },
      writeAttempted: true,
      writeMayHaveSucceeded: true,
      reliableResponseReceived: true,
      replaySafe: false,
    });
    expect(mockClient.mutate.mock.calls[0][1].input).not.toHaveProperty("priority");
  });

  it("returns structured validation and does not add a note or update when resolve priority is missing", async () => {
    mockClient.query
      .mockResolvedValueOnce({
        getTicketList: {
          tickets: [
            {
              ticketId: "ticket-57100",
              displayId: "57100",
              subject: "Sales email",
            },
          ],
          listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 },
        },
      })
      .mockResolvedValueOnce({
        getTicket: {
          ticketId: "ticket-57100",
          displayId: "57100",
          subject: "Sales email",
          status: "New Calls",
        },
      })
      .mockResolvedValueOnce({
        getFields: RESOLVED_OPTION_FIELDS,
      });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_resolve_full", {
      ticketNumber: "57100",
      impact: "Low",
      urgency: "Low",
      note: "Internal note that must not be added",
      verify: false,
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(parsed).toEqual({
      ok: false,
      message: "Ticket was not updated because validation failed.",
      missingFields: [
        "category",
        "priority",
        "subcategory",
        "cause",
        "resolutionCode",
      ],
      invalidFields: {},
      validOptions: {
        priority: ["Very Low", "Low", "Medium", "High"],
        impact: ["Low", "Medium", "High"],
        subcategory: ["No Action Needed", "To Escalate", "Quote Wanted"],
        cause: ["No Fault Found", "User Request", "Unknown"],
        resolutionCode: [
          "Exception",
          "Permanent Fix",
          "Resolved by Requester",
          "Workaround",
        ],
        category: VALID_TICKET_CATEGORIES,
      },
    });
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });

  it("returns all missing required resolved-ticket fields with useful options", async () => {
    mockClient.query
      .mockResolvedValueOnce({
        getTicket: {
          ticketId: "ticket-57100",
          displayId: "57100",
          subject: "Sales email",
        },
      })
      .mockResolvedValueOnce({
        getFields: RESOLVED_OPTION_FIELDS,
      });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_resolve_full", {
      ticketId: "ticket-57100",
      note: "Internal note that must not be added",
      verify: false,
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(parsed.missingFields).toEqual([
      "category",
      "priority",
      "impact",
      "subcategory",
      "cause",
      "resolutionCode",
    ]);
    expect(parsed.validOptions.priority).toEqual([
      "Very Low",
      "Low",
      "Medium",
      "High",
    ]);
    expect(parsed.validOptions.impact).toEqual(["Low", "Medium", "High"]);
    expect(parsed.validOptions.subcategory).toEqual([
      "No Action Needed",
      "To Escalate",
      "Quote Wanted",
    ]);
    expect(parsed.validOptions.cause).toEqual([
      "No Fault Found",
      "User Request",
      "Unknown",
    ]);
    expect(parsed.validOptions.resolutionCode).toContain("Permanent Fix");
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });

  it.each([
    "impact",
    "subcategory",
    "cause",
  ] as const)(
    "does not add a note when resolved-ticket %s is missing",
    async (missingField) => {
      mockClient.query
        .mockResolvedValueOnce({
          getTicket: {
            ticketId: "ticket-57100",
            displayId: "57100",
            subject: "Sales email",
          },
        })
        .mockResolvedValueOnce({
          getFields: RESOLVED_OPTION_FIELDS,
        });

      const args = {
        ticketId: "ticket-57100",
        ...RESOLVED_CLASSIFICATION,
        note: "Internal note that must not be added",
        verify: false,
      };
      delete (args as Record<string, unknown>)[missingField];

      const domain = getTicketsTools();
      const result = await domain.handleCall("superops_tickets_resolve_full", args);
      const parsed = JSON.parse(result.content[0].text);

      expect(result.isError).toBe(true);
      expect(parsed.missingFields).toContain(missingField);
      expect(mockClient.mutate).not.toHaveBeenCalled();
    }
  );

  it("does not add a note when resolved-ticket resolutionCode is invalid", async () => {
    mockClient.query.mockResolvedValue({
      getFields: RESOLVED_OPTION_FIELDS,
    });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_resolve_full", {
      ticketId: "ticket-57100",
      ...RESOLVED_CLASSIFICATION,
      resolutionCode: "No action needed",
      note: "Internal note that must not be added",
      verify: false,
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(parsed.invalidFields.resolutionCode).toContain("Invalid resolution code");
    expect(parsed.invalidFields.resolutionCode).toContain('"Permanent Fix"');
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });

  it("does not add a note when techGroupName is invalid", async () => {
    mockClient.query.mockResolvedValue({
      getTechnicianGroupList: [{ groupId: "level-1", name: "Level 1 Support" }],
    });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_resolve_full", {
      ticketId: "ticket-57100",
      ...RESOLVED_CLASSIFICATION,
      techGroupName: "Unknown Team",
      note: "Internal note that must not be added",
      verify: false,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("No technician group matched");
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });

  it("resolves a ticket by ticket number with validated priority, impact, and urgency", async () => {
    mockClient.query
      .mockResolvedValueOnce({
        getTicketList: {
          tickets: [
            {
              ticketId: "ticket-57100",
              displayId: "57100",
              subject: "Sales email",
            },
          ],
          listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 },
        },
      })
      .mockResolvedValueOnce({
        getFields: RESOLVED_OPTION_FIELDS,
      });
    mockClient.mutate.mockResolvedValue({
      updateTicket: {
        ticketId: "ticket-57100",
        displayId: "57100",
        status: "Resolved",
      },
    });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_resolve_full", {
      ticketNumber: "57100",
      clientId: "2993553194649526272",
      ...RESOLVED_CLASSIFICATION,
      verify: false,
    });

    expect(mockClient.query.mock.calls[0][0]).toContain("getTicketList");
    expect(mockClient.query.mock.calls[0][1]).toEqual({
      input: {
        page: 1,
        pageSize: 5,
        condition: {
          attribute: "displayId",
          operator: "is",
          value: "57100",
        },
      },
    });
    expect(mockClient.query.mock.calls[1][0]).toContain("getFields");
    expect(mockClient.mutate).toHaveBeenCalledWith(
      expect.stringContaining("updateTicket"),
      {
        input: {
          ticketId: "ticket-57100",
          status: "Resolved",
          suppressCloseNotification: true,
          client: { accountId: "2993553194649526272" },
          priority: "Very Low",
          impact: "Low",
          urgency: "Low",
          category: "7. Sales call",
          subcategory: "No Action Needed",
          cause: "No Fault Found",
          resolutionCode: "Permanent Fix",
        },
      }
    );
    expect(result.content[0].text).toContain("ticket-57100");
  });

  it("resolves a ticket directly by ticketId and verifies the final state", async () => {
    mockClient.query
      .mockResolvedValueOnce({
        getFields: RESOLVED_OPTION_FIELDS,
      })
      .mockResolvedValueOnce({
        getTicket: {
          ticketId: "ticket-57100",
          displayId: "57100",
          subject: "Sales email",
          status: "Resolved",
          priority: "Very Low",
          impact: "Low",
          urgency: "Low",
          category: "7. Sales call",
          subcategory: "No Action Needed",
          cause: "No Fault Found",
          resolutionCode: "Permanent Fix",
        },
      });
    mockClient.mutate.mockResolvedValue({
      updateTicket: { ticketId: "ticket-57100", status: "Resolved" },
    });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_resolve_full", {
      ticketId: "ticket-57100",
      ...RESOLVED_CLASSIFICATION,
    });

    expect(mockClient.mutate).toHaveBeenCalledWith(
      expect.stringContaining("updateTicket"),
      {
        input: {
          ticketId: "ticket-57100",
          status: "Resolved",
          suppressCloseNotification: true,
          ...RESOLVED_CLASSIFICATION,
        },
      }
    );
    expect(mockClient.query.mock.calls[1][0]).toContain("getTicket");
    expect(result.content[0].text).toContain('"displayId": "57100"');
  });

  it("reports partial write when resolve_full verification does not match the requested target", async () => {
    mockClient.query
      .mockResolvedValueOnce({ getFields: RESOLVED_OPTION_FIELDS })
      .mockResolvedValueOnce({
        getTicket: {
          ticketId: "ticket-57100",
          displayId: "57100",
          subject: "Sales email",
          status: "New Calls",
          priority: "Very Low",
          impact: "Low",
          urgency: "Low",
          category: "7. Sales call",
          subcategory: "No Action Needed",
          cause: "No Fault Found",
          resolutionCode: "Permanent Fix",
        },
      });
    mockClient.mutate.mockResolvedValue({
      updateTicket: { ticketId: "ticket-57100", status: "Resolved" },
    });

    const result = await getTicketsTools().handleCall("superops_tickets_resolve_full", {
      ticketId: "ticket-57100",
      ...RESOLVED_CLASSIFICATION,
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(parsed).toMatchObject({
      finalOutcome: "VerificationFailed",
      partialWrite: true,
      writeAttempted: true,
      writeMayHaveSucceeded: true,
    });
    expect(parsed.verification.update.mismatches).toEqual([
      { field: "status", expected: "Resolved", observed: "New Calls" },
    ]);
  });
  it("can reuse valid existing resolved-ticket classification values when omitted", async () => {
    mockClient.query
      .mockResolvedValueOnce({
        getTicket: {
          ticketId: "ticket-57100",
          displayId: "57100",
          subject: "Sales email",
          ...RESOLVED_CLASSIFICATION,
        },
      })
      .mockResolvedValueOnce({
        getFields: RESOLVED_OPTION_FIELDS,
      });
    mockClient.mutate.mockResolvedValue({
      updateTicket: { ticketId: "ticket-57100", status: "Resolved" },
    });

    const domain = getTicketsTools();
    await domain.handleCall("superops_tickets_resolve_full", {
      ticketId: "ticket-57100",
      verify: false,
    });

    const { urgency: _urgency, ...requiredClassification } =
      RESOLVED_CLASSIFICATION;
    expect(mockClient.mutate).toHaveBeenCalledWith(
      expect.stringContaining("updateTicket"),
      {
        input: {
          ticketId: "ticket-57100",
          status: "Resolved",
          suppressCloseNotification: true,
          ...requiredClassification,
        },
      }
    );
  });

  it("does not reuse invalid existing resolved-ticket values", async () => {
    mockClient.query
      .mockResolvedValueOnce({
        getTicket: {
          ticketId: "ticket-57100",
          displayId: "57100",
          subject: "Sales email",
          ...RESOLVED_CLASSIFICATION,
          cause: "Unsupported Cause",
        },
      })
      .mockResolvedValueOnce({
        getFields: RESOLVED_OPTION_FIELDS,
      });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_resolve_full", {
      ticketId: "ticket-57100",
      note: "Internal note that must not be added",
      verify: false,
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(parsed.invalidFields.cause).toContain("Invalid cause");
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });

  it("validates subcategory against the selected category", async () => {
    mockClient.query.mockResolvedValue({
      getFields: RESOLVED_OPTION_FIELDS,
    });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_resolve_full", {
      ticketId: "ticket-57100",
      ...RESOLVED_CLASSIFICATION,
      category: "1. Support request",
      note: "Internal note that must not be added",
      verify: false,
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(parsed.invalidFields.subcategory).toContain("belongs under category");
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });

  it("resolves client aliases for resolve_full via client lookup", async () => {
    mockClient.query
      .mockResolvedValueOnce({
        getClientList: {
          clients: [{ accountId: "2993553194649526272", name: "TaskGroup" }],
          listInfo: { page: 1, pageSize: 200, hasMore: false, totalCount: 1 },
        },
      })
      .mockResolvedValueOnce({
        getTicket: {
          ticketId: "ticket-57100",
          status: "New Calls",
          ...RESOLVED_CLASSIFICATION,
        },
      })
      .mockResolvedValueOnce({
        getFields: RESOLVED_OPTION_FIELDS,
      });
    mockClient.mutate.mockResolvedValue({
      updateTicket: { ticketId: "ticket-57100", status: "Resolved" },
    });

    const domain = getTicketsTools();
    await domain.handleCall("superops_tickets_resolve_full", {
      ticketId: "ticket-57100",
      clientName: "Task Group",
      verify: false,
    });

    const { urgency: _urgency, ...requiredClassification } =
      RESOLVED_CLASSIFICATION;
    expect(mockClient.query.mock.calls[0][0]).toContain("getClientList");
    expect(mockClient.mutate).toHaveBeenCalledWith(
      expect.stringContaining("updateTicket"),
      {
        input: {
          ticketId: "ticket-57100",
          status: "Resolved",
          suppressCloseNotification: true,
          ...requiredClassification,
          client: { accountId: "2993553194649526272" },
        },
      }
    );
  });

  it("adds a note only after resolve validation succeeds", async () => {
    mockClient.query.mockResolvedValue({
      getFields: RESOLVED_OPTION_FIELDS,
    });
    mockClient.mutate
      .mockResolvedValueOnce({
        createTicketNote: {
          noteId: "note-123",
          addedOn: "2026-06-26T08:00:00",
          content: "Internal note",
          privacyType: "PRIVATE",
        },
      })
      .mockResolvedValueOnce({
        updateTicket: { ticketId: "ticket-57100", status: "Resolved" },
      });

    const domain = getTicketsTools();
    await domain.handleCall("superops_tickets_resolve_full", {
      ticketId: "ticket-57100",
      ...RESOLVED_CLASSIFICATION,
      note: "Internal note",
      verify: false,
    });

    expect(mockClient.mutate.mock.calls[0][0]).toContain("createTicketNote");
    expect(mockClient.mutate.mock.calls[1][0]).toContain("updateTicket");
    expect(mockClient.mutate.mock.calls[0][1]).toEqual({
      input: {
        ticket: { ticketId: "ticket-57100" },
        content: "Internal note",
        privacyType: "PRIVATE",
      },
    });
  });

  it("keeps partialFailure for unexpected update errors after note creation", async () => {
    mockClient.query.mockResolvedValue({
      getFields: RESOLVED_OPTION_FIELDS,
    });
    mockClient.mutate
      .mockResolvedValueOnce({
        createTicketNote: {
          noteId: "note-123",
          addedOn: "2026-06-26T08:00:00",
          content: "Internal note",
          privacyType: "PRIVATE",
        },
      })
      .mockRejectedValueOnce(new Error("update failed after validation"));

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_resolve_full", {
      ticketId: "ticket-57100",
      ...RESOLVED_CLASSIFICATION,
      note: "Internal note",
      verify: false,
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(parsed.partialFailure).toBe(true);
    expect(parsed.noteAdded.noteId).toBe("note-123");
    expect(parsed.updateError).toBe("update failed after validation");
  });

  it("returns a clearer partialFailure message for unexpected mandatory priority errors after note creation", async () => {
    mockClient.query.mockResolvedValue({
      getFields: RESOLVED_OPTION_FIELDS,
    });
    mockClient.mutate
      .mockResolvedValueOnce({
        createTicketNote: {
          noteId: "note-123",
          addedOn: "2026-06-26T08:00:00",
          content: "Internal note",
          privacyType: "PRIVATE",
        },
      })
      .mockRejectedValueOnce(new Error("mandatory_validation_failed: priority"));

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_resolve_full", {
      ticketId: "ticket-57100",
      ...RESOLVED_CLASSIFICATION,
      note: "Internal note",
      verify: false,
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(parsed.partialFailure).toBe(true);
    expect(parsed.updateError).toContain("priority is required");
    expect(parsed.updateError).toContain("No further note should be added");
    expect(parsed.updateError).not.toContain("mandatory_validation_failed");
  });

  it("rejects invalid resolve_full option names before mutation", async () => {
    mockClient.query.mockResolvedValue({
      getFields: RESOLVED_OPTION_FIELDS,
    });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_resolve_full", {
      ticketId: "ticket-57100",
      ...RESOLVED_CLASSIFICATION,
      priority: "Not a priority",
      verify: false,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Invalid priority");
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });

  it("updates tickets with technician assignment rather than assignee", async () => {
    mockClient.mutate.mockResolvedValue({
      updateTicket: { ticketId: "ticket-123", technician: { userId: "tech-456" } },
    });

    const domain = getTicketsTools();
    await domain.handleCall("superops_tickets_update", {
      ticketId: "ticket-123",
      status: "Resolved",
      assigneeId: "tech-456",
      resolution: "Fixed the issue",
    });

    expect(mockClient.mutate).toHaveBeenCalledWith(
      expect.stringContaining("updateTicket"),
      {
        input: {
          ticketId: "ticket-123",
          status: "Resolved",
          technician: { userId: "tech-456" },
        },
      }
    );
    expect(mockClient.mutate.mock.calls[0][1].input).not.toHaveProperty("priority");
  });

  it.each([
    ["priority", "Very Low"],
    ["impact", "High"],
    ["urgency", "High"],
    ["resolutionCode", "Fixed"],
    ["cause", "Component issue"],
    ["subcategory", "Wireless"],
  ] as const)(
    "updates tickets with validated %s option values",
    async (fieldName, optionValue) => {
      mockClient.query
        .mockResolvedValueOnce({
          getFields: [ticketField(fieldName, [optionValue])],
        })
        .mockResolvedValueOnce({
          getTicket: { ticketId: "ticket-123", [fieldName]: optionValue },
        });
      mockClient.mutate.mockResolvedValue({
        updateTicket: { ticketId: "ticket-123", [fieldName]: optionValue },
      });

      const domain = getTicketsTools();
      const result = await domain.handleCall("superops_tickets_update", {
        ticketId: "ticket-123",
        [fieldName]: optionValue,
      });

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining("getFields"),
        {
          input: [{ module: "TICKET", columnName: fieldName }],
        }
      );
      expect(mockClient.mutate).toHaveBeenCalledWith(
        expect.stringContaining("updateTicket"),
        {
          input: {
            ticketId: "ticket-123",
            [fieldName]: optionValue,
          },
        }
      );
      expect(mockClient.mutate.mock.calls[0][0]).toContain(fieldName);
      expect(mockClient.query).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining("getTicket"),
        { input: { ticketId: "ticket-123" } }
      );
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        result: { ticketId: "ticket-123", [fieldName]: optionValue },
        finalOutcome: "Updated",
        verification: {
          performed: true,
          possible: true,
          verified: true,
          comparedFields: [fieldName],
          mismatches: [],
        },
        writeAttempted: true,
        writeMayHaveSucceeded: true,
        reliableResponseReceived: true,
        replaySafe: false,
      });
    }
  );

  it("updates tickets with configured category names", async () => {
    mockClient.mutate.mockResolvedValue({
      updateTicket: {
        ticketId: "ticket-123",
        category: "1. Support request",
      },
    });
    mockClient.query.mockResolvedValue({
      getTicket: {
        ticketId: "ticket-123",
        category: "1. Support request",
      },
    });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_update", {
      ticketId: "ticket-123",
      category: "1. Support request",
    });

    expect(mockClient.query).toHaveBeenCalledOnce();
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining("getTicket"),
      { input: { ticketId: "ticket-123" } }
    );
    expect(mockClient.mutate).toHaveBeenCalledWith(
      expect.stringContaining("updateTicket"),
      {
        input: {
          ticketId: "ticket-123",
          category: "1. Support request",
        },
      }
    );
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      verification: {
        performed: true,
        possible: true,
        verified: true,
        comparedFields: ["category"],
        mismatches: [],
      },
    });
  });

  it("rejects invalid dynamic ticket option names before mutation", async () => {
    mockClient.query.mockResolvedValue({
      getFields: [ticketField("impact", ["Low", "Medium"])],
    });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_update", {
      ticketId: "ticket-123",
      impact: "Not an impact",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Invalid impact");
    expect(result.content[0].text).toContain('"Low"');
    expect(result.content[0].text).toContain('"Medium"');
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });

  it("rejects invalid urgency before mutation", async () => {
    mockClient.query.mockResolvedValue({
      getFields: [ticketField("urgency", ["Low", "Medium"])],
    });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_update", {
      ticketId: "ticket-123",
      urgency: "Not an urgency",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Invalid urgency");
    expect(result.content[0].text).toContain('"Low"');
    expect(result.content[0].text).toContain('"Medium"');
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });

  it("rejects invalid configured category names before mutation", async () => {
    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_update", {
      ticketId: "ticket-123",
      category: "Unsupported category",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Invalid ticket category");
    expect(mockClient.query).not.toHaveBeenCalled();
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });

  it("validates dependent subcategory options against the supplied category", async () => {
    mockClient.query.mockResolvedValue({
      getFields: [
        ticketField("subcategory", ["Wireless"], {
          columnName: "category",
          value: "1. Support request",
        }),
      ],
    });
    mockClient.mutate.mockResolvedValue({
      updateTicket: {
        ticketId: "ticket-123",
        category: "1. Support request",
        subcategory: "Wireless",
      },
    });

    const domain = getTicketsTools();
    await domain.handleCall("superops_tickets_update", {
      ticketId: "ticket-123",
      category: "1. Support request",
      subcategory: "Wireless",
    });

    expect(mockClient.mutate).toHaveBeenCalledWith(
      expect.stringContaining("updateTicket"),
      {
        input: {
          ticketId: "ticket-123",
          category: "1. Support request",
          subcategory: "Wireless",
        },
      }
    );
  });

  it("rejects dependent subcategory options when the required category is missing", async () => {
    mockClient.query.mockResolvedValue({
      getFields: [
        ticketField("subcategory", ["Wireless"], {
          columnName: "category",
          value: "1. Support request",
        }),
      ],
    });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_update", {
      ticketId: "ticket-123",
      subcategory: "Wireless",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Include category");
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });

  it("requires expected candidates for approved triage plan execution", async () => {
    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_apply_triage_plan", {
      actions: [],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("expectedCandidateTicketNumbers");
    expect(mockClient.query).not.toHaveBeenCalled();
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });

  it("returns a result for every expected triage ticket and marks missing actions", async () => {
    mockClient.query
      .mockResolvedValueOnce({
        getTicketList: {
          tickets: [{ ticketId: "ticket-57400", displayId: "57400" }],
          listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 },
        },
      })
      .mockResolvedValueOnce({
        getTicket: {
          ticketId: "ticket-57400",
          displayId: "57400",
          subject: "Leave alone",
          status: "New Calls",
        },
      });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_apply_triage_plan", {
      expectedCandidateTicketNumbers: ["57400", "57401"],
      actions: [{ ticketNumber: "57400", action: "leave", expectedStatus: "New Calls" }],
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.results).toEqual([
      expect.objectContaining({ ticketNumber: "57400", finalOutcome: "Left" }),
      expect.objectContaining({
        ticketNumber: "57401",
        finalOutcome: "NoApprovedAction",
        writeAttempted: false,
      }),
    ]);
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });

  it("skips approved triage writes when updatedTime changed unless explicitly allowed", async () => {
    mockClient.query
      .mockResolvedValueOnce({
        getTicketList: {
          tickets: [{ ticketId: "ticket-57400", displayId: "57400" }],
          listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 },
        },
      })
      .mockResolvedValueOnce({
        getTicket: {
          ticketId: "ticket-57400",
          displayId: "57400",
          subject: "Changed",
          status: "New Calls",
          updatedTime: "2026-06-25T11:00:00",
        },
      });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_apply_triage_plan", {
      expectedCandidateTicketNumbers: ["57400"],
      actions: [
        {
          ticketNumber: "57400",
          expectedUpdatedTime: "2026-06-25T10:00:00",
          contentVerified: true,
          action: "update",
          target: { status: "Worked on" },
        },
      ],
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.results[0]).toMatchObject({
      finalOutcome: "SkippedChangedSinceSnapshot",
      failureStage: "validateUpdatedTime",
      writeAttempted: false,
    });
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });

  it("dry-runs approved triage updates without writing and reports requested state separately from observed state", async () => {
    mockClient.query
      .mockResolvedValueOnce({
        getTicketList: {
          tickets: [{ ticketId: "ticket-57400", displayId: "57400" }],
          listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 },
        },
      })
      .mockResolvedValueOnce({
        getTicket: {
          ticketId: "ticket-57400",
          displayId: "57400",
          subject: "Dry run",
          status: "New Calls",
          priority: "Low",
          updatedTime: "2026-06-25T10:00:00",
        },
      });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_apply_triage_plan", {
      expectedCandidateTicketNumbers: ["57400"],
      dryRun: true,
      actions: [
        {
          ticketNumber: "57400",
          expectedUpdatedTime: "2026-06-25T10:00:00",
          contentVerified: true,
          action: "update",
          target: { status: "Awaiting Engineer" },
        },
      ],
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.results[0]).toMatchObject({
      finalOutcome: "Updated",
      writeAttempted: false,
      writeMethod: "dryRun",
      requestedState: {
        status: "Awaiting Engineer",
      },
      attemptedState: null,
      observedFinalState: {
        status: "New Calls",
        priority: "Low",
      },
    });
    expect(mockClient.mutate).not.toHaveBeenCalled();

    const stored = await getOperationStore().get(parsed.operation.operationId);
    if (!stored) throw new Error("missing dry-run operation");
    expect(stored).toMatchObject({
      state: "Completed",
      pendingItems: [],
      continuationCount: 0,
    });
    expect(stored.terminalFailureReason).toBeUndefined();
  });

  it("rejects an approved triage update with no recognised mutable target fields", async () => {
    const result = await getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
      expectedCandidateTicketNumbers: ["57400"],
      dryRun: true,
      actions: [
        {
          ticketNumber: "57400",
          expectedUpdatedTime: "2026-06-25T10:00:00",
          contentVerified: true,
          action: "update",
          target: {},
        },
      ],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("recognised mutable target field");
    expect(mockClient.query).not.toHaveBeenCalled();
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });

  it("rejects unknown approved triage action fields instead of reporting an update no-op", async () => {
    const result = await getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
      expectedCandidateTicketNumbers: ["57400"],
      dryRun: true,
      actions: [
        {
          ticketNumber: "57400",
          expectedUpdatedTime: "2026-06-25T10:00:00",
          contentVerified: true,
          action: "update",
          requestedState: { status: "Awaiting Engineer" },
        },
      ],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("unsupported field(s): requestedState");
    expect(result.content[0].text).not.toContain('"finalOutcome": "Updated"');
    expect(mockClient.query).not.toHaveBeenCalled();
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });

  it("dedupes approved triage notes and does not duplicate existing note", async () => {
    mockClient.query
      .mockResolvedValueOnce({
        getTicketList: {
          tickets: [{ ticketId: "ticket-57400", displayId: "57400" }],
          listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 },
        },
      })
      .mockResolvedValueOnce({
        getTicket: {
          ticketId: "ticket-57400",
          displayId: "57400",
          subject: "Note",
          status: "New Calls",
        },
      })
      .mockResolvedValueOnce({
        getTicketNoteList: [
          {
            noteId: "note-existing",
            addedOn: "2026-06-25T10:00:00",
            content: "Already approved note",
            privacyType: "PRIVATE",
          },
        ],
      })
      .mockResolvedValueOnce({
        getTicket: {
          ticketId: "ticket-57400",
          displayId: "57400",
          status: "New Calls",
        },
      });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_apply_triage_plan", {
      expectedCandidateTicketNumbers: ["57400"],
      actions: [
        {
          ticketNumber: "57400",
          contentVerified: true,
          action: "addNote",
          note: "Already approved note",
        },
      ],
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.results[0]).toMatchObject({
      finalOutcome: "Updated",
      noteAdded: false,
      noteDeduped: true,
      verified: true,
    });
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });

  it("does not treat an identically worded public note as a private-note dedupe match", async () => {
    mockClient.query
      .mockResolvedValueOnce({
        getTicketList: {
          tickets: [{ ticketId: "ticket-57400", displayId: "57400" }],
          listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 },
        },
      })
      .mockResolvedValueOnce({
        getTicket: { ticketId: "ticket-57400", displayId: "57400", status: "New Calls" },
      })
      .mockResolvedValueOnce({
        getTicketNoteList: [{
          noteId: "public-copy", content: "Approved private note", privacyType: "PUBLIC",
        }],
      })
      .mockResolvedValueOnce({
        getTicket: { ticketId: "ticket-57400", displayId: "57400", status: "New Calls" },
      });
    mockClient.mutate.mockResolvedValueOnce({
      createTicketNote: { noteId: "private-copy", privacyType: "PRIVATE" },
    });

    const result = await getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
      expectedCandidateTicketNumbers: ["57400"],
      actions: [{
        ticketNumber: "57400", contentVerified: true, action: "addNote", note: "Approved private note",
      }],
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.results[0]).toMatchObject({ finalOutcome: "Updated", noteAdded: true, noteDeduped: false });
    expect(mockClient.mutate).toHaveBeenCalledWith(expect.stringContaining("createTicketNote"), {
      input: { ticket: { ticketId: "ticket-57400" }, content: "Approved private note", privacyType: "PRIVATE" },
    });
  });
  it("does not use update fallback for approved resolve internal server errors without conclusive rejection", async () => {
    mockClient.query
      .mockResolvedValueOnce({
        getTicketList: {
          tickets: [{ ticketId: "ticket-57400", displayId: "57400" }],
          listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 },
        },
      })
      .mockResolvedValueOnce({
        getTicket: {
          ticketId: "ticket-57400",
          displayId: "57400",
          subject: "Resolve",
          status: "New Calls",
        },
      })
      .mockResolvedValueOnce({ getFields: RESOLVED_OPTION_FIELDS })
      .mockResolvedValueOnce({
        getTicket: {
          ticketId: "ticket-57400",
          displayId: "57400",
          subject: "Resolve",
          status: "New Calls",
        },
      })
      .mockResolvedValueOnce({
        getTicket: {
          ticketId: "ticket-57400",
          displayId: "57400",
          status: "Resolved",
          ...RESOLVED_CLASSIFICATION,
        },
      });
    mockClient.mutate
      .mockRejectedValueOnce(new Error("SuperOps internal server error"))
      .mockResolvedValueOnce({
        updateTicket: { ticketId: "ticket-57400", displayId: "57400", status: "Resolved" },
      });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_apply_triage_plan", {
      expectedCandidateTicketNumbers: ["57400"],
      allowResolveFullFallbackToUpdate: true,
      actions: [
        {
          ticketNumber: "57400",
          expectedStatus: "New Calls",
          contentVerified: true,
          action: "resolve",
          target: { status: "Resolved", ...RESOLVED_CLASSIFICATION },
        },
      ],
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(mockClient.mutate).toHaveBeenCalledTimes(1);
    expect(parsed.results[0]).toMatchObject({
      finalOutcome: "Failed",
      writeAttempted: true,
      writeMethod: "resolve_full",
      fallbackAttempted: false,
      fallbackResult: "Ambiguous resolution response remains unresolved; fallback was not attempted.",
      failureStage: "ambiguousWrite",
      partialWrite: true,
      verified: false,
    });
  });

  it("does not replay a resolution after a lost response when state is unchanged", async () => {
    const initialTicket = {
      ticketId: "ticket-57400", displayId: "57400", subject: "Resolve once",
      status: "New Calls", updatedTime: "2026-07-18T10:00:00.000Z",
    };
    mockClient.query
      .mockResolvedValueOnce({
        getTicketList: { tickets: [{ ticketId: "ticket-57400", displayId: "57400" }],
          listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 } },
      })
      .mockResolvedValueOnce({ getTicket: initialTicket })
      .mockResolvedValueOnce({ getFields: RESOLVED_OPTION_FIELDS })
      .mockResolvedValueOnce({ getTicket: initialTicket });
    mockClient.mutate.mockRejectedValueOnce(new Error("network response lost"));

    const result = await getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
      expectedCandidateTicketNumbers: ["57400"],
      allowResolveFullFallbackToUpdate: true,
      actions: [{
        ticketNumber: "57400", expectedStatus: "New Calls",
        expectedUpdatedTime: "2026-07-18T10:00:00.000Z",
        contentVerified: true, action: "resolve",
        target: { status: "Resolved", ...RESOLVED_CLASSIFICATION },
      }],
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(mockClient.mutate).toHaveBeenCalledTimes(1);
    expect(parsed.operation).toMatchObject({
      writeAttempted: true,
      writeMayHaveSucceeded: true,
      partialWrite: true,
      verificationState: "Pending",
    });
    expect(parsed.results[0]).toMatchObject({
      finalOutcome: "Failed",
      failureStage: "ambiguousWrite",
      fallbackAttempted: false,
      partialWrite: true,
      verified: false,
    });
  });
  it("does not replay a resolution when a lost 5xx response is already visible", async () => {
    const initialTicket = {
      ticketId: "ticket-57400", displayId: "57400", subject: "Resolve once",
      status: "New Calls", updatedTime: "2026-07-18T10:00:00.000Z",
    };
    const resolvedTicket = {
      ...initialTicket, status: "Resolved", updatedTime: "2026-07-18T10:00:01.000Z",
      ...RESOLVED_CLASSIFICATION,
    };
    mockClient.query
      .mockResolvedValueOnce({
        getTicketList: { tickets: [{ ticketId: "ticket-57400", displayId: "57400" }],
          listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 } },
      })
      .mockResolvedValueOnce({ getTicket: initialTicket })
      .mockResolvedValueOnce({ getFields: RESOLVED_OPTION_FIELDS })
      .mockResolvedValueOnce({ getTicket: resolvedTicket });
    mockClient.mutate.mockRejectedValueOnce(new Error("SuperOps internal server error status 500"));

    const result = await getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
      expectedCandidateTicketNumbers: ["57400"],
      allowResolveFullFallbackToUpdate: true,
      actions: [{
        ticketNumber: "57400", expectedStatus: "New Calls",
        expectedUpdatedTime: "2026-07-18T10:00:00.000Z",
        contentVerified: true, action: "resolve",
        target: { status: "Resolved", ...RESOLVED_CLASSIFICATION },
      }],
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(mockClient.mutate).toHaveBeenCalledTimes(1);
    expect(parsed.results[0]).toMatchObject({
      finalOutcome: "Resolved", fallbackAttempted: false, verified: true,
      fallbackResult: "Not required; intended resolution is already visible.",
    });
  });
  it("marks verification failure as partial write for approved triage updates", async () => {
    mockClient.query
      .mockResolvedValueOnce({
        getTicketList: {
          tickets: [{ ticketId: "ticket-57400", displayId: "57400" }],
          listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 },
        },
      })
      .mockResolvedValueOnce({
        getTicket: {
          ticketId: "ticket-57400",
          displayId: "57400",
          subject: "Verify fail",
          status: "New Calls",
        },
      })
      .mockRejectedValueOnce(new Error("verify failed"));
    mockClient.mutate.mockResolvedValueOnce({
      updateTicket: { ticketId: "ticket-57400", displayId: "57400", status: "Worked on" },
    });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_apply_triage_plan", {
      expectedCandidateTicketNumbers: ["57400"],
      actions: [
        {
          ticketNumber: "57400",
          contentVerified: true,
          action: "update",
          target: { status: "Worked on" },
        },
      ],
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.results[0]).toMatchObject({
      finalOutcome: "Failed",
      writeAttempted: true,
      verified: false,
      partialWrite: true,
      failureStage: "verifyFinalState",
    });
    const stored = await getOperationStore().get(parsed.operation.operationId);
    if (!stored) throw new Error("missing verification-failure operation");
    expect(operationResultView(stored).totals).toMatchObject({
      failed: 1,
      partialWrite: 1,
      validationFailed: 0,
    });
  });
  it("fails final verification when update reports success but verified state stays New Calls", async () => {
    mockClient.query
      .mockResolvedValueOnce({
        getTicketList: {
          tickets: [{ ticketId: "ticket-57400", displayId: "57400" }],
          listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 },
        },
      })
      .mockResolvedValueOnce({
        getTicket: {
          ticketId: "ticket-57400",
          displayId: "57400",
          subject: "Verify stale",
          status: "New Calls",
        },
      })
      .mockResolvedValueOnce({
        getTicket: {
          ticketId: "ticket-57400",
          displayId: "57400",
          status: "New Calls",
        },
      });
    mockClient.mutate.mockResolvedValueOnce({
      updateTicket: { ticketId: "ticket-57400", displayId: "57400", status: "Worked on" },
    });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_apply_triage_plan", {
      expectedCandidateTicketNumbers: ["57400"],
      actions: [
        {
          ticketNumber: "57400",
          contentVerified: true,
          action: "update",
          target: { status: "Worked on" },
        },
      ],
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.results[0]).toMatchObject({
      finalOutcome: "Failed",
      verified: false,
      failureStage: "verifyFinalState",
      partialWrite: true,
      noteAdded: false,
      finalState: { status: "New Calls" },
    });
    expect(parsed.results[0].failureReason).toContain('"field":"status"');
    expect(parsed.results[0].failureReason).toContain('"expected":"Worked on"');
    expect(parsed.results[0].failureReason).toContain('"actual":"New Calls"');
  });

  it("maps approved update target fields from action.target", async () => {
    mockClient.query
      .mockResolvedValueOnce({
        getTicketList: {
          tickets: [{ ticketId: "ticket-57400", displayId: "57400" }],
          listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 },
        },
      })
      .mockResolvedValueOnce({
        getTicket: {
          ticketId: "ticket-57400",
          displayId: "57400",
          subject: "Map update",
          status: "New Calls",
        },
      })
      .mockResolvedValueOnce({ getFields: [ticketField("priority", ["High"])] })
      .mockResolvedValueOnce({
        getTicket: {
          ticketId: "ticket-57400",
          displayId: "57400",
          status: "Worked on",
          priority: "High",
        },
      });
    mockClient.mutate.mockResolvedValueOnce({
      updateTicket: { ticketId: "ticket-57400", displayId: "57400" },
    });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_apply_triage_plan", {
      expectedCandidateTicketNumbers: ["57400"],
      actions: [
        {
          ticketNumber: "57400",
          contentVerified: true,
          action: "update",
          target: { status: "Worked on", priority: "High" },
        },
      ],
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(mockClient.mutate).toHaveBeenCalledWith(
      expect.stringContaining("updateTicket"),
      { input: { ticketId: "ticket-57400", status: "Worked on", priority: "High" } }
    );
    expect(parsed.results[0]).toMatchObject({
      finalOutcome: "Updated",
      verified: true,
      noteAdded: false,
    });
  });

  it("maps approved resolve mandatory fields from action.target and validates them", async () => {
    mockClient.query
      .mockResolvedValueOnce({
        getTicketList: {
          tickets: [{ ticketId: "ticket-57400", displayId: "57400" }],
          listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 },
        },
      })
      .mockResolvedValueOnce({
        getTicket: {
          ticketId: "ticket-57400",
          displayId: "57400",
          subject: "Resolve mapped",
          status: "New Calls",
        },
      })
      .mockResolvedValueOnce({ getFields: RESOLVED_OPTION_FIELDS })
      .mockResolvedValueOnce({
        getTicket: {
          ticketId: "ticket-57400",
          displayId: "57400",
          status: "Resolved",
          ...RESOLVED_CLASSIFICATION,
        },
      });
    mockClient.mutate.mockResolvedValueOnce({
      updateTicket: { ticketId: "ticket-57400", displayId: "57400" },
    });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_apply_triage_plan", {
      expectedCandidateTicketNumbers: ["57400"],
      actions: [
        {
          ticketNumber: "57400",
          contentVerified: true,
          action: "resolve",
          target: { status: "Resolved", ...RESOLVED_CLASSIFICATION },
        },
      ],
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(mockClient.mutate).toHaveBeenCalledWith(
      expect.stringContaining("updateTicket"),
      {
        input: {
          ticketId: "ticket-57400",
          status: "Resolved",
          suppressCloseNotification: true,
          ...RESOLVED_CLASSIFICATION,
        },
      }
    );
    expect(parsed.results[0]).toMatchObject({
      finalOutcome: "Resolved",
      writeMethod: "resolve_full",
      verified: true,
    });
  });

  it("adds an approved private note for update actions when action.note is supplied", async () => {
    mockClient.query
      .mockResolvedValueOnce({
        getTicketList: {
          tickets: [{ ticketId: "ticket-57400", displayId: "57400" }],
          listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 },
        },
      })
      .mockResolvedValueOnce({
        getTicket: {
          ticketId: "ticket-57400",
          displayId: "57400",
          subject: "Note update",
          status: "New Calls",
        },
      })
      .mockResolvedValueOnce({
        getTicket: {
          ticketId: "ticket-57400",
          displayId: "57400",
          status: "Worked on",
        },
      })
      .mockResolvedValueOnce({ getTicketNoteList: [] });
    mockClient.mutate
      .mockResolvedValueOnce({
        updateTicket: { ticketId: "ticket-57400", displayId: "57400" },
      })
      .mockResolvedValueOnce({
        createTicketNote: {
          noteId: "note-1",
          content: "Approved private note",
          privacyType: "PRIVATE",
        },
      });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_apply_triage_plan", {
      expectedCandidateTicketNumbers: ["57400"],
      actions: [
        {
          ticketNumber: "57400",
          contentVerified: true,
          action: "update",
          note: "Approved private note",
          target: { status: "Worked on" },
        },
      ],
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(mockClient.mutate).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("createTicketNote"),
      {
        input: {
          ticket: { ticketId: "ticket-57400" },
          content: "Approved private note",
          privacyType: "PRIVATE",
        },
      }
    );
    expect(parsed.results[0]).toMatchObject({
      finalOutcome: "Updated",
      noteAdded: true,
      verified: true,
    });
  });

  it("does not attempt resolve fallback on mandatory validation errors", async () => {
    mockClient.query
      .mockResolvedValueOnce({
        getTicketList: {
          tickets: [{ ticketId: "ticket-57400", displayId: "57400" }],
          listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 },
        },
      })
      .mockResolvedValueOnce({
        getTicket: {
          ticketId: "ticket-57400",
          displayId: "57400",
          subject: "Resolve mandatory failure",
          status: "New Calls",
        },
      })
      .mockResolvedValueOnce({ getFields: RESOLVED_OPTION_FIELDS });
    mockClient.mutate.mockRejectedValueOnce(
      new Error("mandatory_validation_failed: priority")
    );

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_apply_triage_plan", {
      expectedCandidateTicketNumbers: ["57400"],
      allowResolveFullFallbackToUpdate: true,
      actions: [
        {
          ticketNumber: "57400",
          contentVerified: true,
          action: "resolve",
          target: { status: "Resolved", ...RESOLVED_CLASSIFICATION },
        },
      ],
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(mockClient.mutate).toHaveBeenCalledTimes(1);
    expect(parsed.results[0]).toMatchObject({
      finalOutcome: "Failed",
      failureStage: "resolve_full",
      fallbackAttempted: false,
      partialWrite: true,
    });
  });
  it("creates ticket notes using createTicketNote", async () => {
    mockClient.mutate.mockResolvedValue({
      createTicketNote: {
        noteId: "note-123",
        content: "Private note",
        privacyType: "PRIVATE",
      },
    });
    mockClient.query.mockResolvedValue({
      getTicketNoteList: [{ noteId: "note-123", content: "Private note", privacyType: "PRIVATE" }],
    });

    const domain = getTicketsTools();
    await domain.handleCall("superops_tickets_add_note", {
      ticketId: "ticket-123",
      content: "Private note",
    });

    expect(mockClient.mutate).toHaveBeenCalledWith(
      expect.stringContaining("createTicketNote"),
      {
        input: {
          ticket: { ticketId: "ticket-123" },
          content: "Private note",
          privacyType: "PRIVATE",
        },
      }
    );
  });

  it("logs time using createWorklogEntries", async () => {
    mockClient.mutate.mockResolvedValue({
      createWorklogEntries: [
        {
          itemId: "worklog-123",
          qty: "0.5",
          workItem: { workId: "ticket-123", module: "TICKET" },
        },
      ],
    });

    const domain = getTicketsTools();
    await domain.handleCall("superops_tickets_log_time", {
      ticketId: "ticket-123",
      duration: 30,
      description: "Troubleshooting",
    });

    expect(mockClient.mutate).toHaveBeenCalledWith(
      expect.stringContaining("createWorklogEntries"),
      {
        input: [
          expect.objectContaining({
            workItem: { workId: "ticket-123", module: "TICKET" },
            qty: "0.5",
            billDateTime: expect.any(String),
            notes: "Troubleshooting",
            billable: true,
            afterHours: false,
          }),
        ],
      }
    );
  });

  it("reports partial write when direct ticket update verification mismatches", async () => {
    mockClient.mutate.mockResolvedValue({
      updateTicket: { ticketId: "ticket-123", status: "Resolved" },
    });
    mockClient.query.mockResolvedValue({
      getTicket: { ticketId: "ticket-123", status: "New Calls" },
    });

    const result = await getTicketsTools().handleCall("superops_tickets_update", {
      ticketId: "ticket-123",
      status: "Resolved",
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(parsed).toMatchObject({
      finalOutcome: "VerificationFailed",
      partialWrite: true,
      writeAttempted: true,
      writeMayHaveSucceeded: true,
      verification: { verified: false },
    });
    expect(parsed.verification.mismatches[0]).toMatchObject({
      field: "status",
      expected: "Resolved",
      observed: "New Calls",
    });
  });

  it("reports partial write when direct ticket note verification is unavailable", async () => {
    mockClient.mutate.mockResolvedValue({
      createTicketNote: { privacyType: "PRIVATE" },
    });
    mockClient.query.mockResolvedValue({ getTicketNoteList: [] });

    const result = await getTicketsTools().handleCall("superops_tickets_add_note", {
      ticketId: "ticket-123",
      content: "Private note",
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(parsed).toMatchObject({
      finalOutcome: "VerificationFailed",
      partialWrite: true,
      verification: { performed: true, possible: false, verified: false },
      writeAttempted: true,
      writeMayHaveSucceeded: true,
    });
  });

  it("reports clean success when direct ticket update verification matches", async () => {
    mockClient.mutate.mockResolvedValue({
      updateTicket: { ticketId: "ticket-123", status: "Resolved" },
    });
    mockClient.query.mockResolvedValue({
      getTicket: { ticketId: "ticket-123", status: "Resolved" },
    });

    const result = await getTicketsTools().handleCall("superops_tickets_update", {
      ticketId: "ticket-123",
      status: "Resolved",
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).not.toBe(true);
    expect(parsed).toMatchObject({
      finalOutcome: "Updated",
      partialWrite: false,
      verification: { verified: true },
    });
  });
  it("returns a conservative ambiguity contract for failed synchronous ticket writes", async () => {
    mockClient.mutate.mockRejectedValueOnce(new Error("network response lost"));
    const result = await getTicketsTools().handleCall("superops_tickets_update", {
      ticketId: "ticket-123", status: "Awaiting Engineer",
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      writeAttempted: true,
      writeMayHaveSucceeded: true,
      reliableResponseReceived: false,
      replaySafe: false,
      classification: "AmbiguousSynchronousWrite",
    });
    expect(mockClient.mutate).toHaveBeenCalledTimes(1);
  });
  it("handles unknown tools and API errors", async () => {
    const domain = getTicketsTools();
    const unknown = await domain.handleCall("unknown_tool", {});
    expect(unknown.isError).toBe(true);

    mockClient.query.mockRejectedValue(new Error("API rate limit exceeded"));
    const failed = await domain.handleCall("superops_tickets_list", { page: 1 });
    expect(failed.isError).toBe(true);
    expect(failed.content[0].text).toContain("API rate limit exceeded");
  });

  it("returns API errors for ticket conversation and note reads", async () => {
    const domain = getTicketsTools();

    mockClient.query.mockRejectedValueOnce(new Error("conversation read failed"));
    const conversationResult = await domain.handleCall(
      "superops_tickets_conversation_list",
      { ticketId: "ticket-123" }
    );
    expect(conversationResult.isError).toBe(true);
    expect(conversationResult.content[0].text).toContain("conversation read failed");

    mockClient.query.mockRejectedValueOnce(new Error("notes read failed"));
    const notesResult = await domain.handleCall("superops_tickets_notes_list", {
      ticketId: "ticket-123",
    });
    expect(notesResult.isError).toBe(true);
    expect(notesResult.content[0].text).toContain("notes read failed");
  });
  it("never mutates when initial durable operation creation fails", async () => {
    await runWithOperationStore({}, async () => {
      const store = getOperationStore();
      store.put = vi.fn().mockRejectedValue(new Error("ledger unavailable"));
      const result = await withSuccessfulContinuationScheduling(() =>
        getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
        expectedCandidateTicketNumbers: ["57400"],
        actions: [{
          ticketNumber: "57400", contentVerified: true, action: "update",
          target: { status: "Awaiting Engineer" },
        }],
        })
      );
      const parsed = JSON.parse(result.content[0].text);
      expect(result.isError).toBe(true);
      expect(parsed.operation).toMatchObject({
        persisted: false, errorClass: "OperationStoreFailure",
        writeAttempted: false, writeMayHaveSucceeded: false,
      });
      expect(mockClient.query).not.toHaveBeenCalled();
      expect(mockClient.mutate).not.toHaveBeenCalled();
    });
  });

  it.each([
    ["accepted update", {
      action: { ticketNumber: "57400", contentVerified: true, action: "update", target: { status: "Awaiting Engineer" } },
      queries: [
        { getTicketList: { tickets: [{ ticketId: "ticket-57400", displayId: "57400" }], listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 } } },
        { getTicket: { ticketId: "ticket-57400", displayId: "57400", status: "New Calls" } },
        { getTicket: { ticketId: "ticket-57400", displayId: "57400", status: "Awaiting Engineer" } },
      ],
      mutation: { updateTicket: { ticketId: "ticket-57400", status: "Awaiting Engineer" } },
    }],
    ["accepted resolution", {
      action: { ticketNumber: "57400", contentVerified: true, action: "resolve", target: { status: "Resolved", ...RESOLVED_CLASSIFICATION } },
      queries: [
        { getTicketList: { tickets: [{ ticketId: "ticket-57400", displayId: "57400" }], listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 } } },
        { getTicket: { ticketId: "ticket-57400", displayId: "57400", status: "New Calls" } },
        { getFields: RESOLVED_OPTION_FIELDS },
        { getTicket: { ticketId: "ticket-57400", displayId: "57400", status: "Resolved", ...RESOLVED_CLASSIFICATION } },
      ],
      mutation: { updateTicket: { ticketId: "ticket-57400", status: "Resolved" } },
    }],
    ["accepted private note", {
      action: { ticketNumber: "57400", contentVerified: true, action: "addNote", note: "Approved private note" },
      queries: [
        { getTicketList: { tickets: [{ ticketId: "ticket-57400", displayId: "57400" }], listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 } } },
        { getTicket: { ticketId: "ticket-57400", displayId: "57400", status: "New Calls" } },
        { getTicketNoteList: [] },
        { getTicket: { ticketId: "ticket-57400", displayId: "57400", status: "New Calls" } },
      ],
      mutation: { createTicketNote: { noteId: "note-57400", privacyType: "PRIVATE" } },
    }],
  ] as const)("returns a conservative operation-store failure after %s", async (_label, scenario) => {
    for (const queryResult of scenario.queries) {
      mockClient.query.mockResolvedValueOnce(queryResult);
    }
    mockClient.mutate.mockResolvedValueOnce(scenario.mutation);

    await runWithOperationStore({}, async () => {
      const store = getOperationStore();
      const completeItem = store.completeItem.bind(store);
      store.completeItem = vi.fn(async (params) => {
        if (params.patch.writeAttempted === true) {
          throw new Error("ledger complete unavailable after write");
        }
        return completeItem(params);
      });

      const result = await getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
        batchId: `post-write-store-failure-${_label.replace(/\s+/g, "-")}`,
        expectedCandidateTicketNumbers: ["57400"],
        actions: [scenario.action],
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(result.isError).toBe(true);
      expect(parsed.operation).toMatchObject({
        persisted: true,
        errorClass: "OperationStoreFailure",
        finalReason: "OperationStorePostWriteFailure",
        writeAttempted: true,
        writeMayHaveSucceeded: true,
      });
      expect(mockClient.mutate).toHaveBeenCalledTimes(1);
    });
  });
  it("does not send the first mutation when WriteStarted persistence fails", async () => {
    mockClient.query
      .mockResolvedValueOnce({
        getTicketList: { tickets: [{ ticketId: "ticket-57400", displayId: "57400" }],
          listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 } },
      })
      .mockResolvedValueOnce({
        getTicket: { ticketId: "ticket-57400", displayId: "57400", status: "New Calls" },
      });
    await runWithOperationStore({}, async () => {
      const store = getOperationStore();
      const checkpoint = store.checkpointItem.bind(store);
      store.checkpointItem = async (params) => {
        if (params.patch.stage === "WriteStarted") throw new Error("WriteStarted persistence failed");
        return checkpoint(params);
      };
      const result = await withSuccessfulContinuationScheduling(() =>
        getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
          batchId: "checkpoint-failure-before-first-write",
          expectedCandidateTicketNumbers: ["57400"],
          actions: [{
            ticketNumber: "57400", expectedStatus: "New Calls",
            contentVerified: true, action: "update", target: { status: "Awaiting Engineer" },
          }],
        })
      );
      const parsed = JSON.parse(result.content[0].text);
      const stored = await store.get("checkpoint-failure-before-first-write");
      expect(result.isError).toBe(true);
      expect(parsed.operation).toMatchObject({ writeAttempted: false, writeMayHaveSucceeded: false });
      expect(stored?.itemStates["57400"]).toMatchObject({
        stage: "WriteNotStarted", writeAttempted: false, writeMayHaveSucceeded: false,
      });
      expect(mockClient.mutate).not.toHaveBeenCalled();
    });
  });

  it("counts two legitimate sequential durable mutation attempts", async () => {
    await runWithOperationStore({}, async () => {
      let getTicketReads = 0;
      mockClient.query.mockImplementation(async (query: string) => {
        if (query.includes("getTicketList")) {
          return { getTicketList: { tickets: [{ ticketId: "ticket-57400", displayId: "57400" }],
            listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 } } };
        }
        if (query.includes("getTicketNoteList")) return { getTicketNoteList: [] };
        getTicketReads += 1;
        return { getTicket: { ticketId: "ticket-57400", displayId: "57400",
          status: getTicketReads === 1 ? "New Calls" : "Awaiting Engineer",
          updatedTime: getTicketReads === 1 ? "2026-07-18T10:00:00Z" : "2026-07-18T10:01:00Z" } };
      });
      mockClient.mutate
        .mockResolvedValueOnce({ updateTicket: { ticketId: "ticket-57400", status: "Awaiting Engineer" } })
        .mockResolvedValueOnce({ createTicketNote: { noteId: "note-57400", privacyType: "PRIVATE" } });

      const result = await getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
        batchId: "sequential-attempt-count",
        expectedCandidateTicketNumbers: ["57400"],
        actions: [{
          ticketNumber: "57400",
          expectedStatus: "New Calls",
          expectedUpdatedTime: "2026-07-18T10:00:00Z",
          contentVerified: true,
          action: "update",
          target: { status: "Awaiting Engineer" },
          note: "Approved private follow-up",
        }],
      });
      const parsed = JSON.parse(result.content[0].text);
      const stored = await getOperationStore().get("sequential-attempt-count");

      expect(result.isError).not.toBe(true);
      expect(mockClient.mutate).toHaveBeenCalledTimes(2);
      expect(stored?.itemStates["57400"]).toMatchObject({
        stage: "Completed",
        writeAttempted: true,
        attemptCount: 2,
        verificationState: "Verified",
      });
      expect(parsed.operation.items).toContainEqual(expect.objectContaining({
        itemId: "57400",
        attemptCount: 2,
        writeAttempted: true,
        writeMayHaveSucceeded: true,
        verificationState: "Verified",
      }));
    });
  });

  it("records verified single-ticket apply-plan update telemetry per item and operation", async () => {
    await runWithOperationStore({}, async () => {
      mockClient.query
        .mockResolvedValueOnce({
          getTicketList: {
            tickets: [{ ticketId: "ticket-57400", displayId: "57400" }],
            listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 },
          },
        })
        .mockResolvedValueOnce({
          getTicket: {
            ticketId: "ticket-57400",
            displayId: "57400",
            status: "New Calls",
            updatedTime: "2026-07-18T10:00:00Z",
          },
        })
        .mockResolvedValueOnce({
          getTicket: {
            ticketId: "ticket-57400",
            displayId: "57400",
            status: "Awaiting Engineer",
            updatedTime: "2026-07-18T10:01:00Z",
          },
        });
      mockClient.mutate.mockImplementationOnce(async () => {
        const started = recordTypedSubrequestStart({
          type: "write",
          operationType: "mutation",
          operationName: "UpdateTicket",
        });
        recordSubrequestFinish(started, 200, true);
        return { updateTicket: { ticketId: "ticket-57400", status: "Awaiting Engineer" } };
      });

      const result = await runWithExecutionConfig({}, () =>
        runWithExecutionContext("superops_tickets_apply_triage_plan", () =>
          getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
            batchId: "verified-single-update-telemetry",
            expectedCandidateTicketNumbers: ["57400"],
            actions: [{
              ticketNumber: "57400",
              expectedStatus: "New Calls",
              expectedUpdatedTime: "2026-07-18T10:00:00Z",
              contentVerified: true,
              action: "update",
              target: { status: "Awaiting Engineer" },
            }],
          })
        )
      );
      const parsed = JSON.parse(result.content[0].text);
      const perItem = parsed.execution.items.perItem.find(
        (item: { itemKey?: string }) => item.itemKey === "57400"
      );
      const stored = await getOperationStore().get("verified-single-update-telemetry");

      expect(result.isError).not.toBe(true);
      expect(parsed.execution.requestsByType).toMatchObject({ write: 1 });
      expect(perItem).toMatchObject({ itemKey: "57400", writes: 1 });
      expect(parsed.results[0]).toMatchObject({
        ticketNumber: "57400",
        finalOutcome: "Updated",
        writeAttempted: true,
        verified: true,
        verifiedState: expect.objectContaining({ status: "Awaiting Engineer" }),
        partialWrite: false,
      });
      expect(parsed.operation).toMatchObject({
        state: "Completed",
        verificationState: "Verified",
        partialWrite: false,
        writeAttempted: true,
        writeMayHaveSucceeded: true,
      });
      expect(stored).toMatchObject({
        state: "Completed",
        partialWriteCount: 0,
        ambiguousWriteCount: 0,
        itemStates: {
          "57400": {
            stage: "Completed",
            outcome: "Updated",
            writeAttempted: true,
            writeMayHaveSucceeded: true,
            partialWrite: false,
            verificationState: "Verified",
          },
        },
      });
      expect(mockClient.mutate).toHaveBeenCalledTimes(1);
    });
  });
  it("persists conclusive rejection before retry scheduling", async () => {
    await runWithOperationStore({}, async () => {
      const initial = await withSuccessfulContinuationScheduling(() => runWithExecutionConfig(
        { SUPEROPS_EXECUTION_MAX_ITEMS_PER_BATCH: "1" },
        () => getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
          batchId: "rejection-before-schedule",
          expectedCandidateTicketNumbers: ["57400", "57401"],
          actions: [{ ticketNumber: "57401", contentVerified: true, action: "addNote", note: "Retry after throttle" }],
        })
      ));
      const operationId = JSON.parse(initial.content[0].text).operation.operationId as string;
      const stored = await getOperationStore().get(operationId);
      if (!stored) throw new Error("missing rejection-before-schedule operation");

      const events: string[] = [];
      const store = getOperationStore();
      const checkpoint = store.checkpointItem.bind(store);
      const schedule = store.scheduleContinuation.bind(store);
      store.checkpointItem = async (params) => {
        const updated = await checkpoint(params);
        if (params.patch.observedMutationResult === "Rejected") events.push("rejection-checkpoint");
        return updated;
      };
      store.scheduleContinuation = async (params) => {
        events.push("schedule-continuation");
        expect(events).toContain("rejection-checkpoint");
        const current = await store.get(params.operationId, params.ownerHash);
        expect(current?.itemStates["57401"]).toMatchObject({
          stage: "RateLimitedRescheduled",
          observedMutationResult: "Rejected",
          errorClass: "SuperOpsRateLimit",
        });
        return schedule(params);
      };
      mockClient.query.mockImplementation(async (query: string) => {
        if (query.includes("getTicketList")) return { getTicketList: {
          tickets: [{ ticketId: "ticket-57401", displayId: "57401" }],
          listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 },
        } };
        if (query.includes("getTicketNoteList")) return { getTicketNoteList: [] };
        return { getTicket: { ticketId: "ticket-57401", displayId: "57401", status: "New Calls" } };
      });
      mockClient.mutate.mockRejectedValueOnce(new SuperOpsHttpError("rate limited", 429, "Too Many Requests", 0));

      await runWithExecutionConfig({}, () => runWithExecutionContext(
        "superops_tickets_apply_triage_plan",
        () => resumeApplyTriageOperation({ operationId, ownerHash: stored.ownerHash, leaseOwner: "reject-before-schedule" })
      ));
      expect(events).toEqual(expect.arrayContaining(["rejection-checkpoint", "schedule-continuation"]));
      expect(events.indexOf("rejection-checkpoint")).toBeLessThan(events.indexOf("schedule-continuation"));
    });
  });

  it("resumes from a conclusive rejection checkpoint after a crash before retry", async () => {
    await runWithOperationStore({}, async () => {
      const initial = await withSuccessfulContinuationScheduling(() => runWithExecutionConfig(
        { SUPEROPS_EXECUTION_MAX_ITEMS_PER_BATCH: "1" },
        () => getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
          batchId: "rejection-crash-restart",
          expectedCandidateTicketNumbers: ["57400", "57401"],
          actions: [{ ticketNumber: "57401", contentVerified: true, action: "addNote", note: "Recover rejected note" }],
        })
      ));
      const operationId = JSON.parse(initial.content[0].text).operation.operationId as string;
      const stored = await getOperationStore().get(operationId);
      if (!stored) throw new Error("missing rejection-crash-restart operation");

      const store = getOperationStore();
      const checkpoint = store.checkpointItem.bind(store);
      let crashAfterRejection = true;
      store.checkpointItem = async (params) => {
        const updated = await checkpoint(params);
        if (params.patch.observedMutationResult === "Rejected" && crashAfterRejection) {
          crashAfterRejection = false;
          throw new Error("simulated crash after rejection checkpoint");
        }
        return updated;
      };
      mockClient.query.mockImplementation(async (query: string) => {
        if (query.includes("getTicketList")) return { getTicketList: {
          tickets: [{ ticketId: "ticket-57401", displayId: "57401" }],
          listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 },
        } };
        if (query.includes("getTicketNoteList")) return { getTicketNoteList: [] };
        return { getTicket: { ticketId: "ticket-57401", displayId: "57401", status: "New Calls" } };
      });
      mockClient.mutate
        .mockRejectedValueOnce(new SuperOpsHttpError("rate limited", 429, "Too Many Requests", 0))
        .mockResolvedValueOnce({ createTicketNote: { noteId: "note-recovered", privacyType: "PRIVATE" } });

      await expect(runWithExecutionConfig({}, () => runWithExecutionContext(
        "superops_tickets_apply_triage_plan",
        () => resumeApplyTriageOperation({
          operationId,
          ownerHash: stored.ownerHash,
          leaseOwner: "reject-crash-1",
          leaseMs: 1,
          now: "2026-07-18T00:00:00.000Z",
        })
      ))).rejects.toThrow(/simulated crash after rejection checkpoint/);

      const rejected = await store.get(operationId, stored.ownerHash);
      expect(rejected?.itemStates["57401"]).toMatchObject({
        stage: "RateLimitedRescheduled",
        observedMutationResult: "Rejected",
        writeAttempted: true,
        attemptCount: 1,
        errorClass: "SuperOpsRateLimit",
      });

      const resumed = await runWithExecutionConfig({}, () => runWithExecutionContext(
        "superops_tickets_apply_triage_plan",
        () => resumeApplyTriageOperation({
          operationId,
          ownerHash: stored.ownerHash,
          leaseOwner: "reject-crash-2",
          now: new Date(Date.now() + 1_000).toISOString(),
        })
      ));
      const finalRecord = await store.get(operationId, stored.ownerHash);
      if (!finalRecord) throw new Error("missing final rejection-crash-restart operation");
      expect(finalRecord.itemStates["57401"]).toMatchObject({
        stage: "Completed",
        observedMutationResult: "VerifiedApplied",
        attemptCount: 2,
        verificationState: "Verified",
      });
      expect(operationResultView(finalRecord).totals).toMatchObject({
        completedAfterRetry: 1,
        updated: 1,
        validationFailed: 0,
      });
      expect(resumed.view.totals).toMatchObject({ completedAfterRetry: 1 });
      expect(mockClient.mutate).toHaveBeenCalledTimes(2);
    });
  });
  it("resumes a pending approved triage update using the real adapter", async () => {
    const domain = getTicketsTools();
    const initial = await withSuccessfulContinuationScheduling(() => runWithExecutionConfig(
      { SUPEROPS_EXECUTION_MAX_ITEMS_PER_BATCH: "1" },
      () =>
        domain.handleCall("superops_tickets_apply_triage_plan", {
          expectedCandidateTicketNumbers: ["57400", "57401"],
          actions: [
            {
              ticketNumber: "57401",
              expectedStatus: "New Calls",
              expectedUpdatedTime: "2026-07-18T10:00:00Z",
              contentVerified: true,
              action: "update",
              target: { status: "Awaiting Engineer" },
            },
          ],
        })
    ));
    const parsedInitial = JSON.parse(initial.content[0].text);
    const operationId = parsedInitial.operation.operationId;
    const stored = await getOperationStore().get(operationId);
    expect(stored?.operationRequest).toMatchObject({ kind: "applyTriagePlan" });

    mockClient.query
      .mockResolvedValueOnce({
        getTicketList: {
          tickets: [{ ticketId: "ticket-57401", displayId: "57401" }],
          listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 },
        },
      })
      .mockResolvedValueOnce({
        getTicket: {
          ticketId: "ticket-57401",
          displayId: "57401",
          subject: "Resume update",
          status: "New Calls",
          updatedTime: "2026-07-18T10:00:00Z",
        },
      })
      .mockResolvedValueOnce({
        getTicket: {
          ticketId: "ticket-57401",
          displayId: "57401",
          status: "Awaiting Engineer",
          updatedTime: "2026-07-18T10:01:00Z",
        },
      });
    mockClient.mutate.mockResolvedValueOnce({
      updateTicket: { ticketId: "ticket-57401", status: "Awaiting Engineer" },
    });

    await runWithExecutionConfig({}, async () => {
      await runWithExecutionContext("superops_tickets_apply_triage_plan", async () => {
        const resumed = await resumeApplyTriageOperation({
          operationId,
          ownerHash: stored?.ownerHash ?? stableHash("anonymous"),
          leaseOwner: "test-resume",
        });
        expect(resumed.state).toBe("Completed");
      });
    });

    const finalRecord = await getOperationStore().get(operationId);
    if (!finalRecord) throw new Error("missing first-attempt operation");
    expect(finalRecord.itemStates["57401"]).toMatchObject({
      stage: "Completed",
      outcome: "Updated",
      writeAttempted: true,
      verificationState: "Verified",
    });
    expect(operationResultView(finalRecord).totals).toMatchObject({
      completedAfterRetry: 0,
      updated: 1,
      validationFailed: 0,
    });
    expect(mockClient.mutate).toHaveBeenCalledTimes(1);
  });

  it("terminalizes unavailable immediate scheduling so unfinished work is not stranded", async () => {
    const result = await runWithExecutionConfig(
      { SUPEROPS_EXECUTION_MAX_ITEMS_PER_BATCH: "1" },
      () => getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
        batchId: "terminalize-unavailable-scheduling",
        expectedCandidateTicketNumbers: ["57400", "57401"],
        actions: [],
      })
    );
    const parsed = JSON.parse(result.content[0].text);
    const stored = await getOperationStore().get("terminalize-unavailable-scheduling");

    expect(parsed.operation).toMatchObject({
      complete: true,
      continuationRequired: false,
      state: "CompletedWithFailures",
      continuationScheduling: {
        attempted: true,
        scheduled: false,
        terminalized: true,
      },
    });
    expect(stored).toMatchObject({
      state: "CompletedWithFailures",
      schedulingAttempted: true,
      schedulingSucceeded: false,
      itemStates: {
        "57401": {
          stage: "FailedBeforeWrite",
          outcome: "ContinuationSchedulingFailed",
          errorClass: "ContinuationSchedulingFailure",
          writeAttempted: false,
        },
      },
    });
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });

  it("does not resume a pending triage write when updatedTime is stale", async () => {
    const domain = getTicketsTools();
    const initial = await withSuccessfulContinuationScheduling(() => runWithExecutionConfig(
      { SUPEROPS_EXECUTION_MAX_ITEMS_PER_BATCH: "1" },
      () =>
        domain.handleCall("superops_tickets_apply_triage_plan", {
          expectedCandidateTicketNumbers: ["57400", "57401"],
          actions: [
            {
              ticketNumber: "57401",
              expectedUpdatedTime: "2026-07-18T10:00:00Z",
              contentVerified: true,
              action: "update",
              target: { status: "Awaiting Engineer" },
            },
          ],
        })
    ));
    const operationId = JSON.parse(initial.content[0].text).operation.operationId;
    const stored = await getOperationStore().get(operationId);

    mockClient.query
      .mockResolvedValueOnce({
        getTicketList: {
          tickets: [{ ticketId: "ticket-57401", displayId: "57401" }],
          listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 },
        },
      })
      .mockResolvedValueOnce({
        getTicket: {
          ticketId: "ticket-57401",
          displayId: "57401",
          status: "New Calls",
          updatedTime: "2026-07-18T10:05:00Z",
        },
      });

    await runWithExecutionConfig({}, async () => {
      await runWithExecutionContext("superops_tickets_apply_triage_plan", async () => {
        await resumeApplyTriageOperation({
          operationId,
          ownerHash: stored?.ownerHash ?? stableHash("anonymous"),
          leaseOwner: "test-stale",
        });
      });
    });

    const finalRecord = await getOperationStore().get(operationId);
    if (!finalRecord) throw new Error("missing stale operation");
    expect(finalRecord.itemStates["57401"]).toMatchObject({
      stage: "Stale",
      outcome: "SkippedChangedSinceSnapshot",
      writeAttempted: false,
    });
    expect(operationResultView(finalRecord).totals).toMatchObject({
      stale: 1,
      validationFailed: 0,
    });
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });

  it("counts ordinary target validation failures from the reloaded operation", async () => {
    const initial = await withSuccessfulContinuationScheduling(() => runWithExecutionConfig(
      { SUPEROPS_EXECUTION_MAX_ITEMS_PER_BATCH: "1" },
      () => getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
        batchId: "ordinary-validation-total",
        expectedCandidateTicketNumbers: ["57400", "57401"],
        actions: [{
          ticketNumber: "57401",
          contentVerified: true,
          action: "update",
          target: { status: "Not a SuperOps status" },
        }],
      })
    ));
    const operationId = JSON.parse(initial.content[0].text).operation.operationId as string;
    const stored = await getOperationStore().get(operationId);
    if (!stored) throw new Error("missing ordinary validation operation");

    mockClient.query
      .mockResolvedValueOnce({
        getTicketList: {
          tickets: [{ ticketId: "ticket-57401", displayId: "57401" }],
          listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 },
        },
      })
      .mockResolvedValueOnce({
        getTicket: {
          ticketId: "ticket-57401",
          displayId: "57401",
          status: "New Calls",
        },
      });

    await runWithExecutionConfig({}, () => runWithExecutionContext(
      "superops_tickets_apply_triage_plan",
      () => resumeApplyTriageOperation({
        operationId,
        ownerHash: stored.ownerHash,
        leaseOwner: "ordinary-validation-worker",
      })
    ));

    const finalRecord = await getOperationStore().get(operationId, stored.ownerHash);
    if (!finalRecord) throw new Error("missing final ordinary validation operation");
    expect(finalRecord.itemStates["57401"]).toMatchObject({
      stage: "FailedBeforeWrite",
      outcome: "Blocked",
      errorClass: "ValidationFailure",
      writeAttempted: false,
    });
    expect(operationResultView(finalRecord).totals).toMatchObject({
      failed: 1,
      validationFailed: 1,
      stale: 0,
      ambiguousUnresolved: 0,
      rateLimitExceeded: 0,
    });
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });

  it("resolves ambiguous started updates by reading state before retrying", async () => {
    const domain = getTicketsTools();
    const initial = await withSuccessfulContinuationScheduling(() => runWithExecutionConfig(
      { SUPEROPS_EXECUTION_MAX_ITEMS_PER_BATCH: "1" },
      () =>
        domain.handleCall("superops_tickets_apply_triage_plan", {
          expectedCandidateTicketNumbers: ["57400", "57401"],
          actions: [
            {
              ticketNumber: "57401",
              expectedUpdatedTime: "2026-07-18T10:00:00Z",
              contentVerified: true,
              action: "update",
              target: { status: "Awaiting Engineer" },
            },
          ],
        })
    ));
    const operationId = JSON.parse(initial.content[0].text).operation.operationId;
    const stored = await getOperationStore().get(operationId);
    if (!stored) throw new Error("missing operation");
    stored.itemStates["57401"] = {
      ...stored.itemStates["57401"],
      stage: "WriteStarted",
      writeAttempted: true,
      writeMayHaveSucceeded: true,
      partialWrite: true,
    };
    await getOperationStore().put(stored);

    mockClient.query
      .mockResolvedValueOnce({
        getTicketList: {
          tickets: [{ ticketId: "ticket-57401", displayId: "57401" }],
          listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 },
        },
      })
      .mockResolvedValueOnce({
        getTicket: {
          ticketId: "ticket-57401",
          displayId: "57401",
          status: "Awaiting Engineer",
          updatedTime: "2026-07-18T10:01:00Z",
        },
      });

    await runWithExecutionConfig({}, async () => {
      await runWithExecutionContext("superops_tickets_apply_triage_plan", async () => {
        await resumeApplyTriageOperation({
          operationId,
          ownerHash: stored.ownerHash,
          leaseOwner: "test-ambiguous",
        });
      });
    });

    const finalRecord = await getOperationStore().get(operationId);
    expect(finalRecord?.itemStates["57401"]).toMatchObject({
      stage: "CompletedAfterAmbiguousWriteVerification",
      outcome: "Updated",
      writeAttempted: true,
      verificationState: "Verified",
    });
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });

  it("does not repeat an ambiguous resolution when the requested target is already applied", async () => {
    const domain = getTicketsTools();
    const initial = await withSuccessfulContinuationScheduling(() => runWithExecutionConfig(
      { SUPEROPS_EXECUTION_MAX_ITEMS_PER_BATCH: "1" },
      () => domain.handleCall("superops_tickets_apply_triage_plan", {
        expectedCandidateTicketNumbers: ["57400", "57401"],
        actions: [{
          ticketNumber: "57401", expectedUpdatedTime: "2026-07-18T10:00:00Z",
          contentVerified: true, action: "resolve", target: { status: "Resolved" },
        }],
      })
    ));
    const operationId = JSON.parse(initial.content[0].text).operation.operationId;
    const stored = await getOperationStore().get(operationId);
    if (!stored) throw new Error("missing operation");
    stored.itemStates["57401"] = {
      ...stored.itemStates["57401"], stage: "ResolutionWriteAmbiguous", mutationType: "resolution",
      writeAttempted: true, writeMayHaveSucceeded: true, partialWrite: true,
    };
    await getOperationStore().put(stored);
    mockClient.query
      .mockResolvedValueOnce({
        getTicketList: { tickets: [{ ticketId: "ticket-57401", displayId: "57401" }],
          listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 } },
      })
      .mockResolvedValueOnce({
        getTicket: { ticketId: "ticket-57401", displayId: "57401", status: "Resolved",
          updatedTime: "2026-07-18T10:01:00Z" },
      });
    await runWithExecutionConfig({}, async () => {
      await runWithExecutionContext("superops_tickets_apply_triage_plan", async () =>
        resumeApplyTriageOperation({ operationId, ownerHash: stored.ownerHash, leaseOwner: "test-resolution-ambiguous" })
      );
    });
    const finalRecord = await getOperationStore().get(operationId);
    expect(finalRecord?.itemStates["57401"]).toMatchObject({
      stage: "CompletedAfterAmbiguousWriteVerification", outcome: "Resolved",
      writeAttempted: true, verificationState: "Verified",
    });
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });

  it("does not repeat an ambiguous private note when its canonical content is observed", async () => {
    const domain = getTicketsTools();
    const initial = await withSuccessfulContinuationScheduling(() => runWithExecutionConfig(
      { SUPEROPS_EXECUTION_MAX_ITEMS_PER_BATCH: "1" },
      () => domain.handleCall("superops_tickets_apply_triage_plan", {
        expectedCandidateTicketNumbers: ["57400", "57401"],
        actions: [{ ticketNumber: "57401", contentVerified: true, action: "addNote", note: "Approved private note" }],
      })
    ));
    const operationId = JSON.parse(initial.content[0].text).operation.operationId;
    const stored = await getOperationStore().get(operationId);
    if (!stored) throw new Error("missing operation");
    expect(JSON.stringify(stored)).not.toContain("Approved private note");
    stored.itemStates["57401"] = {
      ...stored.itemStates["57401"], stage: "NoteWriteStarted",
      writeAttempted: true, writeMayHaveSucceeded: true, partialWrite: true,
    };
    await getOperationStore().put(stored);
    mockClient.query
      .mockResolvedValueOnce({
        getTicketList: { tickets: [{ ticketId: "ticket-57401", displayId: "57401" }],
          listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 } },
      })
      .mockResolvedValueOnce({
        getTicket: { ticketId: "ticket-57401", displayId: "57401", status: "Awaiting Engineer",
          updatedTime: "2026-07-18T10:01:00Z" },
      })
      .mockResolvedValueOnce({
        getTicketNoteList: [{ noteId: "note-1", content: "Approved private note", privacyType: "PRIVATE" }],
      });
    await runWithExecutionConfig({}, async () => {
      await runWithExecutionContext("superops_tickets_apply_triage_plan", async () =>
        resumeApplyTriageOperation({ operationId, ownerHash: stored.ownerHash, leaseOwner: "test-note-ambiguous" })
      );
    });
    const finalRecord = await getOperationStore().get(operationId);
    expect(finalRecord?.itemStates["57401"]).toMatchObject({
      stage: "CompletedAfterAmbiguousWriteVerification", outcome: "Updated",
      writeAttempted: true, verificationState: "Verified",
    });
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });

  it("recovers an approved private note in a fresh continuation without exposing its body", async () => {
    const noteBody = "Fresh durable private note content";
    const domain = getTicketsTools();
    const initial = await withSuccessfulContinuationScheduling(() => runWithExecutionConfig(
      { SUPEROPS_EXECUTION_MAX_ITEMS_PER_BATCH: "1" },
      () => domain.handleCall("superops_tickets_apply_triage_plan", {
        batchId: "fresh-private-note-recovery",
        expectedCandidateTicketNumbers: ["57400", "57401"],
        actions: [{
          ticketNumber: "57401",
          contentVerified: true,
          action: "addNote",
          note: noteBody,
        }],
      })
    ));
    const initialRecord = await getOperationStore().get("fresh-private-note-recovery");
    expect(initial.content[0].text).not.toContain(noteBody);
    expect(JSON.stringify(initialRecord)).not.toContain(noteBody);

    mockClient.query
      .mockResolvedValueOnce({
        getTicketList: { tickets: [{ ticketId: "ticket-57401", displayId: "57401" }],
          listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 } },
      })
      .mockResolvedValueOnce({
        getTicket: { ticketId: "ticket-57401", displayId: "57401", status: "New Calls" },
      })
      .mockResolvedValueOnce({ getTicketNoteList: [] })
      .mockResolvedValueOnce({
        getTicket: { ticketId: "ticket-57401", displayId: "57401", status: "New Calls" },
      });
    mockClient.mutate.mockResolvedValueOnce({
      createTicketNote: { noteId: "fresh-private-note", privacyType: "PRIVATE" },
    });

    await runWithExecutionConfig({}, () =>
      runWithExecutionContext("superops_tickets_apply_triage_plan", () =>
        resumeApplyTriageOperation({
          operationId: "fresh-private-note-recovery",
          ownerHash: initialRecord?.ownerHash ?? stableHash("anonymous"),
          leaseOwner: "fresh-private-note-worker",
        })
      )
    );

    expect(mockClient.mutate).toHaveBeenCalledWith(expect.stringContaining("createTicketNote"), {
      input: {
        ticket: { ticketId: "ticket-57401" },
        content: noteBody,
        privacyType: "PRIVATE",
      },
    });
    const finalRecord = await getOperationStore().get("fresh-private-note-recovery");
    expect(finalRecord?.itemStates["57401"]).toMatchObject({
      stage: "Completed",
      mutationType: "note",
      outcome: "Updated",
    });
    expect(JSON.stringify(finalRecord)).not.toContain(noteBody);
  });

  it.each([
    ["http-429", () => new SuperOpsHttpError("rate limited", 429, "Too Many Requests", 0)],
    ["graphql-throttle", () => new SuperOpsError("GraphQL throttled", "THROTTLED", 0)],
  ])("durably reschedules a conclusively rejected private note for %s and revalidates before retry", async (
    throttleKind,
    throttleError
  ) => {
    const noteBody = "Approved throttled private note";
    const domain = getTicketsTools();
    const initial = await withSuccessfulContinuationScheduling(() => runWithExecutionConfig(
      { SUPEROPS_EXECUTION_MAX_ITEMS_PER_BATCH: "1" },
      () => domain.handleCall("superops_tickets_apply_triage_plan", {
        batchId: `private-note-throttle-${throttleKind}`,
        expectedCandidateTicketNumbers: ["57400", "57401"],
        actions: [{ ticketNumber: "57401", contentVerified: true, action: "addNote", note: noteBody }],
      })
    ));
    const operationId = JSON.parse(initial.content[0].text).operation.operationId as string;
    const stored = await getOperationStore().get(operationId);
    if (!stored) throw new Error("missing private-note throttle operation");

    const events: string[] = [];
    mockClient.query.mockImplementation(async (query: string) => {
      if (query.includes("getTicketList")) {
        events.push("revalidate-list");
        return { getTicketList: { tickets: [{ ticketId: "ticket-57401", displayId: "57401" }],
          listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 } } };
      }
      if (query.includes("getTicketNoteList")) {
        events.push("dedupe-notes");
        return { getTicketNoteList: [] };
      }
      events.push("revalidate-ticket");
      return { getTicket: { ticketId: "ticket-57401", displayId: "57401", status: "New Calls" } };
    });
    let acceptedPrivateNotes = 0;
    mockClient.mutate
      .mockImplementationOnce(async () => {
        events.push("note-throttled");
        throw throttleError();
      })
      .mockImplementationOnce(async (_mutation: string, variables: { input: { privacyType: string } }) => {
        events.push("note-accepted");
        expect(variables.input.privacyType).toBe("PRIVATE");
        acceptedPrivateNotes += 1;
        return { createTicketNote: { noteId: "note-accepted", privacyType: "PRIVATE" } };
      });

    await runWithExecutionConfig({}, () =>
      runWithExecutionContext("superops_tickets_apply_triage_plan", () =>
        resumeApplyTriageOperation({ operationId, ownerHash: stored.ownerHash, leaseOwner: "note-throttle-1" })
      )
    );
    const rescheduled = await getOperationStore().get(operationId);
    expect(rescheduled?.itemStates["57401"]).toMatchObject({
      stage: "RateLimitedRescheduled",
      mutationType: "note",
      mutationStartStage: "NoteWriteStarted",
      writeAttempted: true,
      writeMayHaveSucceeded: false,
      reliableResponseReceived: true,
      observedMutationResult: "Rejected",
      partialWrite: false,
      nextEligibleTime: expect.any(String),
    });
    expect(rescheduled?.itemStates["57401"].rateLimit).toMatchObject({ attempts: 1 });
    if (!rescheduled) throw new Error("missing rate-limited operation");
    expect(operationResultView(rescheduled).totals).toMatchObject({
      waitingForRateLimit: 1,
      validationFailed: 0,
    });

    await runWithExecutionConfig({}, () =>
      runWithExecutionContext("superops_tickets_apply_triage_plan", () =>
        resumeApplyTriageOperation({ operationId, ownerHash: stored.ownerHash, leaseOwner: "note-throttle-2" })
      )
    );
    const secondMutation = events.indexOf("note-accepted");
    const eventsBeforeRetry = events.slice(events.indexOf("note-throttled") + 1, secondMutation);
    expect(eventsBeforeRetry).toEqual(expect.arrayContaining([
      "revalidate-list", "revalidate-ticket", "dedupe-notes",
    ]));
    expect(acceptedPrivateNotes).toBe(1);
    expect(mockClient.mutate).toHaveBeenCalledTimes(2);
    expect(mockClient.mutate.mock.calls.every(([, variables]) =>
      variables.input.privacyType === "PRIVATE"
    )).toBe(true);
  });

  it("does not reschedule or replay an ambiguous private-note failure", async () => {
    const domain = getTicketsTools();
    await withSuccessfulContinuationScheduling(() => runWithExecutionConfig(
      { SUPEROPS_EXECUTION_MAX_ITEMS_PER_BATCH: "1" },
      () => domain.handleCall("superops_tickets_apply_triage_plan", {
        batchId: "private-note-ambiguous",
        expectedCandidateTicketNumbers: ["57400", "57401"],
        actions: [{ ticketNumber: "57401", contentVerified: true, action: "addNote", note: "Ambiguous private note" }],
      })
    ));
    const stored = await getOperationStore().get("private-note-ambiguous");
    if (!stored) throw new Error("missing ambiguous private-note operation");
    mockClient.query.mockImplementation(async (query: string) => {
      if (query.includes("getTicketList")) return { getTicketList: {
        tickets: [{ ticketId: "ticket-57401", displayId: "57401" }],
        listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 },
      } };
      if (query.includes("getTicketNoteList")) return { getTicketNoteList: [] };
      return { getTicket: { ticketId: "ticket-57401", displayId: "57401", status: "New Calls" } };
    });
    mockClient.mutate.mockRejectedValueOnce(new Error("network response lost after note write"));

    await runWithExecutionConfig({}, () =>
      runWithExecutionContext("superops_tickets_apply_triage_plan", () =>
        resumeApplyTriageOperation({
          operationId: "private-note-ambiguous",
          ownerHash: stored.ownerHash,
          leaseOwner: "note-ambiguous",
        })
      )
    );
    const finalRecord = await getOperationStore().get("private-note-ambiguous");
    if (!finalRecord) throw new Error("missing ambiguous private-note operation");
    expect(finalRecord.itemStates["57401"]).toMatchObject({
      stage: "AmbiguousWriteUnresolved",
      writeAttempted: true,
      writeMayHaveSucceeded: true,
      partialWrite: true,
      errorClass: "AmbiguousWrite",
    });
    expect(finalRecord.itemStates["57401"].nextEligibleTime).toBeUndefined();
    expect(operationResultView(finalRecord).totals).toMatchObject({
      ambiguousUnresolved: 1,
      validationFailed: 0,
    });
    expect(mockClient.mutate).toHaveBeenCalledTimes(1);
  });

  it("dedupes a matching private note before a resumed conclusive-throttle retry", async () => {
    const noteBody = "Appeared during durable wait";
    const domain = getTicketsTools();
    await withSuccessfulContinuationScheduling(() => runWithExecutionConfig(
      { SUPEROPS_EXECUTION_MAX_ITEMS_PER_BATCH: "1" },
      () => domain.handleCall("superops_tickets_apply_triage_plan", {
        batchId: "private-note-dedupe-after-throttle",
        expectedCandidateTicketNumbers: ["57400", "57401"],
        actions: [{ ticketNumber: "57401", contentVerified: true, action: "addNote", note: noteBody }],
      })
    ));
    const stored = await getOperationStore().get("private-note-dedupe-after-throttle");
    if (!stored) throw new Error("missing private-note dedupe operation");
    let noteNowExists = false;
    mockClient.query.mockImplementation(async (query: string) => {
      if (query.includes("getTicketList")) return { getTicketList: {
        tickets: [{ ticketId: "ticket-57401", displayId: "57401" }],
        listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 },
      } };
      if (query.includes("getTicketNoteList")) return { getTicketNoteList: noteNowExists
        ? [{ noteId: "existing-note", content: noteBody, privacyType: "PRIVATE" }]
        : [] };
      return { getTicket: { ticketId: "ticket-57401", displayId: "57401", status: "New Calls" } };
    });
    mockClient.mutate.mockRejectedValueOnce(
      new SuperOpsHttpError("rate limited", 429, "Too Many Requests", 0)
    );

    await runWithExecutionConfig({}, () => runWithExecutionContext(
      "superops_tickets_apply_triage_plan",
      () => resumeApplyTriageOperation({
        operationId: "private-note-dedupe-after-throttle",
        ownerHash: stored.ownerHash,
        leaseOwner: "note-dedupe-1",
      })
    ));
    noteNowExists = true;
    await runWithExecutionConfig({}, () => runWithExecutionContext(
      "superops_tickets_apply_triage_plan",
      () => resumeApplyTriageOperation({
        operationId: "private-note-dedupe-after-throttle",
        ownerHash: stored.ownerHash,
        leaseOwner: "note-dedupe-2",
      })
    ));

    const finalRecord = await getOperationStore().get("private-note-dedupe-after-throttle");
    expect(finalRecord?.itemStates["57401"]).toMatchObject({
      outcome: "Updated",
      writeAttempted: true,
      writeMayHaveSucceeded: false,
      reliableResponseReceived: true,
      observedMutationResult: "Rejected",
      verificationState: "Verified",
      partialWrite: false,
    });
    expect(finalRecord?.compactResults).toContainEqual(expect.objectContaining({
      ticketNumber: "57401",
      finalOutcome: "Updated",
      writeAttempted: true,
      noteDeduped: true,
    }));
    expect(mockClient.mutate).toHaveBeenCalledTimes(1);
    expect(mockClient.mutate.mock.calls[0][1].input.privacyType).toBe("PRIVATE");
  });

  it("rejects public-note continuation without writing", async () => {
    const domain = getTicketsTools();
    const initial = await withSuccessfulContinuationScheduling(() => runWithExecutionConfig(
      { SUPEROPS_EXECUTION_MAX_ITEMS_PER_BATCH: "1" },
      () =>
        domain.handleCall("superops_tickets_apply_triage_plan", {
          expectedCandidateTicketNumbers: ["57400", "57401"],
          actions: [
            {
              ticketNumber: "57401",
              contentVerified: true,
              action: "addNote",
              note: "Do not publish",
              isPublicNote: true,
            },
          ],
        })
    ));
    const operationId = JSON.parse(initial.content[0].text).operation.operationId;
    const stored = await getOperationStore().get(operationId);

    await runWithExecutionConfig({}, async () => {
      await runWithExecutionContext("superops_tickets_apply_triage_plan", async () => {
        await resumeApplyTriageOperation({
          operationId,
          ownerHash: stored?.ownerHash ?? stableHash("anonymous"),
          leaseOwner: "test-public-note",
        });
      });
    });

    const finalRecord = await getOperationStore().get(operationId);
    expect(finalRecord?.itemStates["57401"]).toMatchObject({
      stage: "FailedBeforeWrite",
      outcome: "Blocked",
      writeAttempted: false,
    });
    expect(mockClient.query).not.toHaveBeenCalled();
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });
});

describe("Tickets triage execution budget", () => {
  let mockClient: { query: ReturnType<typeof vi.fn>; mutate: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockClient = {
      query: vi.fn(),
      mutate: vi.fn(),
    };
    vi.mocked(getClient).mockReturnValue(mockClient as unknown as ReturnType<typeof getClient>);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns a result for every expected ticket when maxItemsPerBatch stops execution", async () => {
    const domain = getTicketsTools();
    const result = await withSuccessfulContinuationScheduling(() => runWithExecutionConfig(
      { SUPEROPS_EXECUTION_MAX_ITEMS_PER_BATCH: "1" },
      () =>
        domain.handleCall("superops_tickets_apply_triage_plan", {
          expectedCandidateTicketNumbers: ["57400", "57401", "57402"],
          actions: [],
        })
    ));
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.results).toHaveLength(3);
    expect(parsed.results[0]).toMatchObject({
      ticketNumber: "57400",
      finalOutcome: "NoApprovedAction",
    });
    expect(parsed.results[1]).toMatchObject({
      ticketNumber: "57401",
      finalOutcome: "NotAttemptedExecutionStopped",
      failureStage: "executionBudget",
    });
    expect(parsed.results[2]).toMatchObject({
      ticketNumber: "57402",
      finalOutcome: "NotAttemptedExecutionStopped",
      failureStage: "executionBudget",
    });
    expect(parsed.operation).toMatchObject({
      complete: false,
      continuationRequired: true,
      persisted: true,
    });
    await expect(getOperationStore().get(parsed.operation.operationId)).resolves.toMatchObject({
      state: "ContinuationRequired",
      expectedItems: ["57400", "57401", "57402"],
      completedItems: [],
      skippedItems: ["57400"],
      pendingItems: ["57401", "57402"],
      unattemptedItems: ["57401", "57402"],
    });
    expect(mockClient.query).not.toHaveBeenCalled();
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });
  it("runs the real triage adapter across a 250-item mocked continuation harness", async () => {
    const domain = getTicketsTools();
    const expected = Array.from({ length: 250 }, (_, index) => String(58000 + index));
    const actions = expected.slice(1).map((ticketNumber) => ({
      ticketNumber,
      expectedStatus: "New Calls",
      expectedUpdatedTime: "2026-07-18T10:00:00Z",
      contentVerified: true,
      action: "update" as const,
      target: { status: "Awaiting Engineer" },
    }));

    const initial = await withSuccessfulContinuationScheduling(() => runWithExecutionConfig(
      { SUPEROPS_EXECUTION_MAX_ITEMS_PER_BATCH: "1" },
      () =>
        domain.handleCall("superops_tickets_apply_triage_plan", {
          expectedCandidateTicketNumbers: expected,
          actions,
        })
    ));
    const operationId = JSON.parse(initial.content[0].text).operation.operationId;
    const stored = await getOperationStore().get(operationId);
    if (!stored) throw new Error("missing operation");

    const ticketState = new Map(
      expected.slice(1).map((ticketNumber) => [
        ticketNumber,
        {
          ticketId: `ticket-${ticketNumber}`,
          displayId: ticketNumber,
          status: "New Calls",
          updatedTime: "2026-07-18T10:00:00Z",
        },
      ])
    );
    const mutationCounts = new Map<string, number>();
    mockClient.query.mockImplementation(async (query: string, variables: { input?: { condition?: { value?: string }; ticketId?: string } }) => {
      const started = recordTypedSubrequestStart({
        type: query.includes("getTicketList") ? "initialRead" : "verificationRead",
        operationType: "query",
        operationName: query.includes("getTicketList") ? "getTicketList" : "getTicket",
      });
      recordSubrequestFinish(started, 200, true);
      if (query.includes("getTicketList")) {
        const ticketNumber = String(variables.input?.condition?.value ?? "");
        const ticket = ticketState.get(ticketNumber);
        return {
          getTicketList: {
            tickets: ticket ? [{ ticketId: ticket.ticketId, displayId: ticket.displayId }] : [],
            listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: ticket ? 1 : 0 },
          },
        };
      }
      if (query.includes("getTicket")) {
        const ticketId = String(variables.input?.ticketId ?? "");
        const ticket = [...ticketState.values()].find((item) => item.ticketId === ticketId);
        if (!ticket) throw new Error(`missing ticket ${ticketId}`);
        return { getTicket: { ...ticket } };
      }
      throw new Error("unexpected query");
    });
    mockClient.mutate.mockImplementation(async (_mutation: string, variables: { input?: { ticketId?: string; status?: string } }) => {
      const started = recordTypedSubrequestStart({
        type: "write",
        operationType: "mutation",
        operationName: "updateTicket",
      });
      recordSubrequestFinish(started, 200, true);
      const ticketId = String(variables.input?.ticketId ?? "");
      const ticket = [...ticketState.values()].find((item) => item.ticketId === ticketId);
      if (!ticket) throw new Error(`missing ticket ${ticketId}`);
      mutationCounts.set(ticket.displayId, (mutationCounts.get(ticket.displayId) ?? 0) + 1);
      ticket.status = String(variables.input?.status ?? ticket.status);
      ticket.updatedTime = "2026-07-18T10:01:00Z";
      return { updateTicket: { ticketId, status: ticket.status } };
    });

    const subrequestsByInvocation: number[] = [];
    let continuationRequired = true;
    let continuations = 0;
    while (continuationRequired && continuations < 300) {
      continuations += 1;
      await runWithExecutionConfig(
        {
          SUPEROPS_EXECUTION_SUBREQUEST_BUDGET: "14",
          SUPEROPS_EXECUTION_SUBREQUEST_SAFETY_MARGIN: "2",
          SUPEROPS_EXECUTION_SAFE_REMAINING_TIME_MS: "0",
          SUPEROPS_EXECUTION_MAX_CONTINUATION_COUNT: "300",
        },
        async () => {
          await runWithExecutionContext("superops_tickets_apply_triage_plan", async () => {
            const result = await resumeApplyTriageOperation({
              operationId,
              ownerHash: stored.ownerHash,
              leaseOwner: `load-${continuations}`,
            });
            continuationRequired = result.continuationRequired;
            subrequestsByInvocation.push(getExecutionState()?.subrequests ?? 0);
          });
        }
      );
    }

    const finalRecord = await getOperationStore().get(operationId);
    expect(finalRecord?.expectedItems).toHaveLength(250);
    expect(finalRecord?.pendingItems).toHaveLength(0);
    expect(finalRecord?.completedItems).toHaveLength(249);
    expect(finalRecord?.skippedItems).toEqual([expected[0]]);
    expect(continuations).toBeGreaterThan(1);
    expect(Math.max(...subrequestsByInvocation)).toBeLessThanOrEqual(12);
    expect(mutationCounts.size).toBe(249);
    expect([...mutationCounts.values()].filter((count) => count !== 1)).toHaveLength(0);
  });
});
