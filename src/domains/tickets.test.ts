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
  getCredentials: vi.fn(() => ({ apiToken: "secret-token", subdomain: "example", region: "us" })),
  SuperOpsError: class SuperOpsError extends Error {
    code?: string;
    retryAfter?: number;
    extensions?: Record<string, unknown>;
    httpStatus?: number;
    graphQLPath?: Array<string | number>;
    graphQLDataPresent?: boolean;
    mutationPayloadReturned?: boolean;
    constructor(
      message: string,
      code?: string,
      retryAfter?: number,
      extensions?: Record<string, unknown>,
      metadata: {
        httpStatus?: number;
        path?: Array<string | number>;
        graphQLDataPresent?: boolean;
        mutationPayloadReturned?: boolean;
      } = {}
    ) {
      super(message);
      this.code = code;
      this.retryAfter = retryAfter;
      this.extensions = extensions;
      this.httpStatus = metadata.httpStatus;
      this.graphQLPath = metadata.path;
      this.graphQLDataPresent = metadata.graphQLDataPresent;
      this.mutationPayloadReturned = metadata.mutationPayloadReturned;
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

import { getClient, getCredentials, SuperOpsError, SuperOpsHttpError } from "../client.js";
import { getTicketsTools, resetTicketFieldOptionsCacheForTests, resumeApplyTriageOperation } from "./tickets.js";
import {
  getExecutionState,
  recordSubrequestFinish,
  recordTypedSubrequestStart,
  runWithExecutionConfig,
  runWithExecutionContext,
} from "../execution.js";
import { currentOwnerHash, getOperationStore, operationResultView, runWithOperationStore, stableHash, SuperOpsOperationLedger } from "../operation-store.js";
import { runWithContinuationScheduler } from "../continuation-scheduler.js";
import { publishToolDefinition, READ_ONLY_TOOL_NAMES } from "../tool-catalogue.js";

function withSuccessfulContinuationScheduling<T>(fn: () => T): T {
  return runWithContinuationScheduler({
    SUPEROPS_CONTINUATION_ENABLED: "true",
    SUPEROPS_DURABLE_RETRY_ENABLED: "true",
    SUPEROPS_INTERNAL_CONTINUATION_TOKEN: "test-internal-token",
    SUPEROPS_CONTINUATION_SERVICE: {
      fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    },
  }, fn);
}

function ownerScopedDurableNamespaceForTickets() {
  const valuesByName = new Map<string, Map<string, unknown>>();
  const ledgers = new Map<string, SuperOpsOperationLedger>();
  const valuesFor = (name: string) => {
    let values = valuesByName.get(name);
    if (!values) {
      values = new Map<string, unknown>();
      valuesByName.set(name, values);
    }
    return values;
  };
  const namespace = {
    idFromName: (name: string) => name,
    get: (id: unknown) => {
      const name = String(id);
      let ledger = ledgers.get(name);
      if (!ledger) {
        const values = valuesFor(name);
        ledger = new SuperOpsOperationLedger({
          storage: {
            get: async <T = unknown>(key: string) => values.get(key) as T | undefined,
            put: async (key: string | Record<string, unknown>, value?: unknown) => {
              if (typeof key === "string") values.set(key, value);
              else for (const [entryKey, entryValue] of Object.entries(key)) values.set(entryKey, entryValue);
            },
            delete: async (key: string) => values.delete(key),
            list: async <T = unknown>(options?: { prefix?: string }) => new Map(
              [...values.entries()].filter(([key]) => !options?.prefix || key.startsWith(options.prefix))
            ) as Map<string, T>,
          },
        });
        ledgers.set(name, ledger);
      }
      return { fetch: (request: Request) => ledger!.fetch(request) };
    },
  };
  return { namespace };
}

function installFakeExecutionClock(startIso = "2026-07-22T09:00:00.000Z") {
  vi.useFakeTimers();
  const startMs = Date.parse(startIso);
  let monotonicMs = 0;
  vi.setSystemTime(new Date(startMs));
  vi.stubGlobal("performance", { now: () => monotonicMs });
  return {
    advanceTo(elapsedMs: number) {
      monotonicMs = elapsedMs;
      vi.setSystemTime(new Date(startMs + elapsedMs));
    },
    resetMonotonic() {
      monotonicMs = 0;
    },
  };
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

const TRIAGE_TEST_CLASSIFICATION = {
  impact: "Low",
  urgency: "Low",
  category: "7. Sales call",
  subcategory: "No Action Needed",
};
const TRIAGE_TEST_RESOLUTION_CLASSIFICATION = {
  ...TRIAGE_TEST_CLASSIFICATION,
  cause: "No Fault Found",
  resolutionCode: "Permanent Fix",
};
const SCHEDULED_TRIAGE_TEST_NOTE = [
  "TRIAGE SUMMARY",
  "Ticket goal: Route the ticket under the standing New Calls policy.",
  "What needs to be known: The safe evidence was fully retrieved and assessed.",
  "Next step: Apply the approved policy outcome.",
  "When: During this scheduled triage run.",
].join("\n");

const RESOLVED_CLASSIFICATION = {
  priority: "Very Low",
  ...TRIAGE_TEST_RESOLUTION_CLASSIFICATION,
};


const DRY_RUN_NOTE_DEDUPE_REGRESSION = {
  operationId: "a9574d2c-11cc-4c1e-b8e9-6ccd3a923c94",
  ticketNumber: "58824",
  ticketId: "ticket-58824",
  note: "JUNK",
};
const LIVE_RESOLVE_NO_CHANGE_DATAFETCHING_REGRESSION = {
  operationIds: [
    "d81332a6-73cb-4a0c-aea5-74c794e030ec",
    "a6668b52-6ad7-401d-971c-a75b2cdc3946",
  ],
  ticketNumber: "59005",
  ticketId: "2691030162477215744",
  clientName: "TaskGroup",
  clientId: "2993553194649526272",
  note: "JUNK",
  originalUpdatedTime: "2026-07-25T09:00:00Z",
  target: {
    status: "Resolved",
    impact: "Low",
    urgency: "Low",
    category: "7. Sales call",
    subcategory: "No Action Needed",
    cause: "Unknown",
    resolutionCode: "Permanent Fix",
    clientName: "TaskGroup",
    clientId: "2993553194649526272",
    suppressCloseNotification: true,
  },
};
const LIVE_PARTIAL_RESOLVE_STATUS_MISSING_REGRESSION = {
  operationIds: [
    "8d7b83fb-e890-4685-bb9c-79815a85dc1a",
    "0c61fa84-8f90-478c-8cec-ea6f5283c8d6",
    "79af4663-9b1d-4a8c-9c56-2d9377c22bd0",
  ],
  ticketNumber: "58824",
  ticketId: "4191204259748139008",
  clientName: "TaskGroup",
  clientId: "2993553194649526272",
  note: "JUNK",
  target: {
    status: "Resolved",
    clientName: "TaskGroup",
    clientId: "2993553194649526272",
    suppressCloseNotification: true,
    ...RESOLVED_CLASSIFICATION,
  },
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

const SECURITY_ACCESS_SUBCATEGORY_ID = "2568302641668456449";
const CHANGE_ACCESS_SUBCATEGORY_ID = "8051631619094929408";

function subcategoryFieldWithParents(
  options: Array<{ id: string; value: string; parentCategory: string }>
) {
  return {
    id: "subcategory-field",
    module: "TICKET",
    columnName: "subcategory",
    label: "subcategory",
    options: options.map((option) => ({
      id: option.id,
      value: option.value,
      parentOption: {
        id: `category-${option.parentCategory}`,
        value: option.parentCategory,
      },
    })),
    parentField: { id: "category-field", columnName: "category" },
  };
}

function installFieldOptionsNativeCache(options: { matchFails?: boolean; putFails?: boolean } = {}) {
  const store = new Map<string, Response>();
  const match = vi.fn(async (request: Request) => {
    if (options.matchFails) throw new Error("cache read failed");
    return store.get(request.url)?.clone();
  });
  const put = vi.fn(async (request: Request, response: Response) => {
    if (options.putFails) throw new Error("cache write failed");
    store.set(request.url, response.clone());
  });
  vi.stubGlobal("caches", { default: { match, put } });
  return { store, match, put };
}
function duplicateAccessSubcategoryField(reverse = false) {
  const options = [
    {
      id: SECURITY_ACCESS_SUBCATEGORY_ID,
      value: "Access",
      parentCategory: "3. Security Incident",
    },
    {
      id: CHANGE_ACCESS_SUBCATEGORY_ID,
      value: "Access",
      parentCategory: "2. Change request",
    },
  ];
  return subcategoryFieldWithParents(reverse ? [...options].reverse() : options);
}

describe("Tickets Domain", () => {
  let mockClient: { query: ReturnType<typeof vi.fn>; mutate: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockClient = {
      query: vi.fn(),
      mutate: vi.fn(),
    };
    vi.mocked(getClient).mockReturnValue(mockClient as unknown as ReturnType<typeof getClient>);
    vi.mocked(getCredentials).mockReturnValue({ apiToken: "secret-token", subdomain: "example", region: "us" });
  });

  afterEach(() => {
    resetTicketFieldOptionsCacheForTests();
    vi.unstubAllGlobals();
    vi.useRealTimers();
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
      "superops_tickets_get_safe",
      "superops_tickets_triage_evidence_recover",
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
    expect(update?.properties.target.properties.status.enum).toEqual(["Awaiting Engineer"]);
    expect(update?.properties.target.required).toEqual([
      "status", "impact", "urgency", "category", "subcategory",
    ]);
    expect(update?.properties.target.properties).toEqual(
      expect.objectContaining({
        status: expect.any(Object),
        impact: expect.any(Object),
        urgency: expect.any(Object),
        category: expect.any(Object),
        subcategory: expect.any(Object),
        cause: expect.any(Object),
        techGroupName: expect.any(Object),
        clientName: expect.any(Object),
        clientId: expect.any(Object),
        suppressCloseNotification: expect.any(Object),
      })
    );

    const resolve = variants.find((variant) => variant.properties.action.const === "resolve");
    expect(resolve?.properties.target.properties.status.enum).toEqual(["Resolved"]);
    expect(resolve?.properties.target.required).toEqual([
      "impact", "urgency", "category", "subcategory", "cause", "resolutionCode",
    ]);
    const leave = variants.find((variant) => variant.properties.action.const === "leave");
    expect(leave?.required).toEqual(
      expect.arrayContaining(["ticketNumber", "expectedUpdatedTime", "contentVerified", "action", "target"])
    );
    expect(leave?.properties.target.required).toEqual([
      "impact", "urgency", "category", "subcategory",
    ]);
    expect(update?.properties.target.properties).not.toHaveProperty("resolutionCode");
    expect(leave?.properties.target.properties).not.toHaveProperty("status");
    expect(leave?.properties.target.properties).not.toHaveProperty("resolutionCode");
    expect(leave?.properties.target.properties).toHaveProperty("cause");
    expect(leave?.properties).toHaveProperty("note");
    expect(leave?.properties).toHaveProperty("isPublicNote");
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
    expect(parsed._metadata.retrieval).toMatchObject({ source: "fresh", attempts: 1, retried: false, rateLimited: false });
  });

  it("retries one GraphQL rate_limit_exceeded field-options response internally and then succeeds", async () => {
    mockClient.query
      .mockRejectedValueOnce(new SuperOpsError("rate_limit_exceeded", "rate_limit_exceeded"))
      .mockResolvedValueOnce({ getFields: [ticketField("priority", ["Very Low"])] });

    const domain = getTicketsTools();
    const result = await runWithExecutionConfig(
      { SUPEROPS_EXECUTION_MAX_SINGLE_DELAY_MS: "0", SUPEROPS_EXECUTION_BACKOFF_JITTER_RATIO: "0" },
      () => domain.handleCall("superops_tickets_field_options", { fields: ["priority"] })
    );
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).not.toBe(true);
    expect(mockClient.query).toHaveBeenCalledTimes(2);
    expect(parsed.priority.options[0].value).toBe("Very Low");
    expect(parsed._metadata.retrieval).toMatchObject({ source: "fresh", attempts: 2, retried: true });
  });

  it("retries HTTP 429 field-options responses with Retry-After metadata", async () => {
    mockClient.query
      .mockRejectedValueOnce(new SuperOpsHttpError("HTTP error: 429 Too Many Requests", 429, "Too Many Requests", 1))
      .mockResolvedValueOnce({ getFields: [ticketField("impact", ["Low"])] });

    const domain = getTicketsTools();
    const result = await runWithExecutionConfig(
      { SUPEROPS_EXECUTION_MAX_SINGLE_DELAY_MS: "0", SUPEROPS_EXECUTION_BACKOFF_JITTER_RATIO: "0" },
      () => domain.handleCall("superops_tickets_field_options", { fields: ["impact"] })
    );
    const parsed = JSON.parse(result.content[0].text);

    expect(mockClient.query).toHaveBeenCalledTimes(2);
    expect(parsed.impact.options[0].value).toBe("Low");
    expect(parsed._metadata.retrieval).toMatchObject({ attempts: 2, retried: true, retryAfterPresent: true });
  });

  it("recognises DataFetchingException field-options wrappers containing rate_limit_exceeded", async () => {
    mockClient.query
      .mockRejectedValueOnce(new SuperOpsError(
        "Exception while fetching data for getFields",
        "DataFetchingException",
        undefined,
        { classification: "DataFetchingException", errorType: "rate_limit_exceeded" }
      ))
      .mockResolvedValueOnce({ getFields: [ticketField("urgency", ["Low"])] });

    const domain = getTicketsTools();
    const result = await runWithExecutionConfig(
      { SUPEROPS_EXECUTION_MAX_SINGLE_DELAY_MS: "0", SUPEROPS_EXECUTION_BACKOFF_JITTER_RATIO: "0" },
      () => domain.handleCall("superops_tickets_field_options", { fields: ["urgency"] })
    );
    const parsed = JSON.parse(result.content[0].text);

    expect(mockClient.query).toHaveBeenCalledTimes(2);
    expect(parsed.urgency.options[0].value).toBe("Low");
    expect(parsed._metadata.retrieval.retried).toBe(true);
  });

  it("bounds field-options retry attempts and returns structured rate-limit errors", async () => {
    mockClient.query.mockRejectedValue(new SuperOpsError("rate_limit_exceeded", "rate_limit_exceeded"));

    const domain = getTicketsTools();
    const result = await runWithExecutionConfig(
      {
        SUPEROPS_EXECUTION_MAX_READ_RETRY_ATTEMPTS: "5",
        SUPEROPS_EXECUTION_MAX_SINGLE_DELAY_MS: "0",
        SUPEROPS_EXECUTION_BACKOFF_JITTER_RATIO: "0",
      },
      () => domain.handleCall("superops_tickets_field_options", { fields: ["priority"] })
    );
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(mockClient.query).toHaveBeenCalledTimes(2);
    expect(parsed).toMatchObject({ errorClass: "SuperOpsRateLimit", rateLimited: true, attempts: 2, cacheEntryAvailable: false });
  });

  it("writes successful field-options lookups to caches.default", async () => {
    const nativeCache = installFieldOptionsNativeCache();
    mockClient.query.mockResolvedValueOnce({ getFields: [ticketField("priority", ["Very Low"])] });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_field_options", { fields: ["priority"] });
    const parsed = JSON.parse(result.content[0].text);
    const cacheUrl = [...nativeCache.store.keys()][0];
    const cachedPayload = await [...nativeCache.store.values()][0].clone().json() as Record<string, unknown>;

    expect(result.isError).not.toBe(true);
    expect(parsed.priority.options[0].value).toBe("Very Low");
    expect(nativeCache.put).toHaveBeenCalledTimes(1);
    expect(cacheUrl).toContain("tenant=example");
    expect(cacheUrl).toContain("region=us");
    expect(cacheUrl).toContain("fields=priority");
    expect(cacheUrl).not.toContain("secret-token");
    expect(JSON.stringify(cachedPayload)).not.toContain("secret-token");
    expect(cachedPayload).toMatchObject({ tenant: "example", region: "us", fields: ["priority"] });
  });

  it("retrieves caches.default field-options entries across invocations after transient rate-limit retries fail", async () => {
    const nativeCache = installFieldOptionsNativeCache();
    mockClient.query.mockResolvedValueOnce({ getFields: [ticketField("priority", ["Very Low"])] });
    const domain = getTicketsTools();
    const first = await domain.handleCall("superops_tickets_field_options", { fields: ["priority"] });
    expect(JSON.parse(first.content[0].text).priority.options[0].value).toBe("Very Low");
    expect(nativeCache.put).toHaveBeenCalledTimes(1);

    resetTicketFieldOptionsCacheForTests();
    mockClient.query.mockReset();
    mockClient.query.mockRejectedValue(new SuperOpsError("rate_limit_exceeded", "rate_limit_exceeded"));
    const fallback = await runWithExecutionConfig(
      { SUPEROPS_EXECUTION_MAX_SINGLE_DELAY_MS: "0", SUPEROPS_EXECUTION_BACKOFF_JITTER_RATIO: "0" },
      () => domain.handleCall("superops_tickets_field_options", { fields: ["priority"] })
    );
    const parsed = JSON.parse(fallback.content[0].text);

    expect(fallback.isError).not.toBe(true);
    expect(mockClient.query).toHaveBeenCalledTimes(2);
    expect(nativeCache.match).toHaveBeenCalledTimes(1);
    expect(parsed.priority.options[0].value).toBe("Very Low");
    expect(parsed._metadata.retrieval).toMatchObject({ source: "cache", cacheStatus: "fallback", rateLimited: true });
  });

  it("keeps caches.default field-options entries isolated by tenant", async () => {
    const nativeCache = installFieldOptionsNativeCache();
    mockClient.query.mockResolvedValueOnce({ getFields: [ticketField("priority", ["Tenant A"])] });
    const domain = getTicketsTools();
    await domain.handleCall("superops_tickets_field_options", { fields: ["priority"] });

    resetTicketFieldOptionsCacheForTests();
    mockClient.query.mockReset();
    mockClient.query.mockRejectedValue(new SuperOpsError("rate_limit_exceeded", "rate_limit_exceeded"));
    vi.mocked(getCredentials).mockReturnValue({ apiToken: "secret-token", subdomain: "other", region: "us" });
    const result = await runWithExecutionConfig(
      { SUPEROPS_EXECUTION_MAX_SINGLE_DELAY_MS: "0", SUPEROPS_EXECUTION_BACKOFF_JITTER_RATIO: "0" },
      () => domain.handleCall("superops_tickets_field_options", { fields: ["priority"] })
    );

    expect(result.isError).toBe(true);
    expect(nativeCache.match).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ cacheEntryAvailable: false, cacheEntryValid: false });
  });

  it("keeps caches.default field-options entries isolated by region", async () => {
    const nativeCache = installFieldOptionsNativeCache();
    mockClient.query.mockResolvedValueOnce({ getFields: [ticketField("priority", ["US Priority"])] });
    const domain = getTicketsTools();
    await domain.handleCall("superops_tickets_field_options", { fields: ["priority"] });

    resetTicketFieldOptionsCacheForTests();
    mockClient.query.mockReset();
    mockClient.query.mockRejectedValue(new SuperOpsError("rate_limit_exceeded", "rate_limit_exceeded"));
    vi.mocked(getCredentials).mockReturnValue({ apiToken: "secret-token", subdomain: "example", region: "eu" });
    const result = await runWithExecutionConfig(
      { SUPEROPS_EXECUTION_MAX_SINGLE_DELAY_MS: "0", SUPEROPS_EXECUTION_BACKOFF_JITTER_RATIO: "0" },
      () => domain.handleCall("superops_tickets_field_options", { fields: ["priority"] })
    );

    expect(result.isError).toBe(true);
    expect(nativeCache.match).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ cacheEntryAvailable: false, cacheEntryValid: false });
  });

  it("keeps caches.default field-options entries isolated by requested field set", async () => {
    const nativeCache = installFieldOptionsNativeCache();
    mockClient.query.mockResolvedValueOnce({ getFields: [ticketField("priority", ["Very Low"])] });
    const domain = getTicketsTools();
    await domain.handleCall("superops_tickets_field_options", { fields: ["priority"] });

    resetTicketFieldOptionsCacheForTests();
    mockClient.query.mockReset();
    mockClient.query.mockRejectedValue(new SuperOpsError("rate_limit_exceeded", "rate_limit_exceeded"));
    const result = await runWithExecutionConfig(
      { SUPEROPS_EXECUTION_MAX_SINGLE_DELAY_MS: "0", SUPEROPS_EXECUTION_BACKOFF_JITTER_RATIO: "0" },
      () => domain.handleCall("superops_tickets_field_options", { fields: ["impact"] })
    );

    expect(result.isError).toBe(true);
    expect(nativeCache.match).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ cacheEntryAvailable: false, cacheEntryValid: false });
  });

  it("rejects expired caches.default field-options entries", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T00:00:00.000Z"));
    const nativeCache = installFieldOptionsNativeCache();
    mockClient.query.mockResolvedValueOnce({ getFields: [ticketField("priority", ["Very Low"])] });
    const domain = getTicketsTools();
    await domain.handleCall("superops_tickets_field_options", { fields: ["priority"] });

    resetTicketFieldOptionsCacheForTests();
    vi.setSystemTime(new Date("2026-07-22T00:05:01.000Z"));
    mockClient.query.mockReset();
    mockClient.query.mockRejectedValue(new SuperOpsError("rate_limit_exceeded", "rate_limit_exceeded"));
    const result = await runWithExecutionConfig(
      { SUPEROPS_EXECUTION_MAX_SINGLE_DELAY_MS: "0", SUPEROPS_EXECUTION_BACKOFF_JITTER_RATIO: "0" },
      () => domain.handleCall("superops_tickets_field_options", { fields: ["priority"] })
    );
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(nativeCache.match).toHaveBeenCalledTimes(1);
    expect(parsed).toMatchObject({ cacheEntryAvailable: true, cacheEntryValid: false, rateLimited: true, nativeCacheAvailable: true });
  });

  it("does not let cache read failure break successful fresh field-options lookup", async () => {
    const nativeCache = installFieldOptionsNativeCache({ matchFails: true });
    mockClient.query.mockResolvedValueOnce({ getFields: [ticketField("priority", ["Very Low"])] });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_field_options", { fields: ["priority"] });
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).not.toBe(true);
    expect(parsed.priority.options[0].value).toBe("Very Low");
    expect(nativeCache.match).not.toHaveBeenCalled();
  });

  it("does not let cache write failure break successful fresh field-options lookup", async () => {
    const nativeCache = installFieldOptionsNativeCache({ putFails: true });
    mockClient.query.mockResolvedValueOnce({ getFields: [ticketField("priority", ["Very Low"])] });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_field_options", { fields: ["priority"] });
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).not.toBe(true);
    expect(parsed.priority.options[0].value).toBe("Very Low");
    expect(nativeCache.put).toHaveBeenCalledTimes(1);
  });

  it("does not use cached options to conceal permanent field-options failures", async () => {
    const nativeCache = installFieldOptionsNativeCache();
    mockClient.query.mockResolvedValueOnce({ getFields: [ticketField("priority", ["Very Low"])] });
    const domain = getTicketsTools();
    await domain.handleCall("superops_tickets_field_options", { fields: ["priority"] });

    resetTicketFieldOptionsCacheForTests();
    mockClient.query.mockReset();
    mockClient.query.mockRejectedValue(new SuperOpsError("Invalid metadata request", "BAD_USER_INPUT"));
    const result = await domain.handleCall("superops_tickets_field_options", { fields: ["priority"] });
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(nativeCache.match).not.toHaveBeenCalled();
    expect(mockClient.query).toHaveBeenCalledTimes(1);
    expect(parsed).toMatchObject({ errorClass: "SuperOpsGraphQLError", rateLimited: false, attempts: 1, cacheEntryAvailable: false });
  });
  it("keeps the field-options MCP tool classified as read-only", () => {
    const domain = getTicketsTools();
    const fieldOptionsTool = domain.tools.find((tool) => tool.name === "superops_tickets_field_options");
    if (!fieldOptionsTool) throw new Error("field-options tool missing");

    expect(READ_ONLY_TOOL_NAMES.has("superops_tickets_field_options")).toBe(true);
    expect(publishToolDefinition(fieldOptionsTool).annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
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
      .mockResolvedValueOnce({ getTicketNoteList: [] })
      .mockResolvedValueOnce({
        getTicketList: {
          tickets: [
            {
              ticketId: "ticket-57401",
              displayId: "57401",
              subject: "No content",
              status: "New Calls",
            },
          ],
          listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 },
        },
      });

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
        pageSize: 8,
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
    expect(parsed.source).toEqual({
      status: ["New Calls"], page: 1, max: 50, effectiveMax: 8,
    });
    expect(parsed.pagination).toEqual({
      page: 1,
      pageSize: 8,
      hasMore: false,
      totalCount: 2,
      nextPage: null,
      budgetCapped: true,
    });
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

  it("snapshots an explicitly selected Ticket on Hold queue", async () => {
    mockClient.query
      .mockResolvedValueOnce({
        getTicketList: {
          tickets: [{
            ticketId: "ticket-59020",
            displayId: "59020",
            subject: "Held for review",
            status: "Ticket on Hold",
          }],
          listInfo: { page: 1, pageSize: 32, hasMore: false, totalCount: 1 },
        },
      })
      .mockResolvedValueOnce({
        getTicket: {
          ticketId: "ticket-59020",
          displayId: "59020",
          subject: "Held for review",
          status: "Ticket on Hold",
          updatedTime: "2026-07-26T08:00:00.000Z",
        },
      });

    const result = await getTicketsTools().handleCall("superops_tickets_triage_snapshot", {
      status: ["Ticket on Hold"],
      max: 50,
      page: 1,
      includeConversations: false,
      includeNotes: false,
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).toBeUndefined();
    expect(mockClient.query.mock.calls[0][1]).toEqual({
      input: {
        page: 1,
        pageSize: 32,
        condition: { attribute: "status", operator: "is", value: "Ticket on Hold" },
      },
    });
    expect(parsed.source).toEqual({
      status: ["Ticket on Hold"], page: 1, max: 50, effectiveMax: 32,
    });
    expect(parsed.candidateTicketNumbers).toEqual(["59020"]);
    expect(parsed.tickets[0]).toMatchObject({
      ticketNumber: "59020",
      status: "Ticket on Hold",
      processingState: "MetadataOnly",
    });
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });
  it("paginates the exact 14-ticket New Calls shape before safe-read budget exhaustion", async () => {
    const candidates = Array.from({ length: 14 }, (_, index) => {
      const ticketNumber = String(59001 + index);
      return {
        ticketId: `ticket-${ticketNumber}`,
        displayId: ticketNumber,
        subject: `Candidate ${ticketNumber}`,
        status: "New Calls",
        impact: "Low",
        urgency: "Low",
        category: "1. Support request",
        createdTime: "2026-07-25T08:00:00.000Z",
        updatedTime: `2026-07-25T08:${String(index).padStart(2, "0")}:00.000Z`,
      };
    });
    const listRequests: Array<{ page: number; pageSize: number }> = [];

    mockClient.query.mockImplementation(async (
      query: string,
      variables?: { input?: { page?: number; pageSize?: number; ticketId?: string } }
    ) => {
      const input = variables?.input ?? {};
      if (query.includes("getTicketList")) {
        const page = input.page ?? 1;
        const pageSize = input.pageSize ?? 50;
        listRequests.push({ page, pageSize });
        const start = (page - 1) * pageSize;
        const tickets = candidates.slice(start, start + pageSize);
        return {
          getTicketList: {
            tickets,
            listInfo: {
              page,
              pageSize,
              hasMore: start + tickets.length < candidates.length,
              totalCount: candidates.length,
            },
          },
        };
      }
      const ticketId = input.ticketId ?? "";
      const candidate = candidates.find((item) => item.ticketId === ticketId);
      if (!candidate) throw new Error(`Unexpected ticket ID ${ticketId}`);
      if (query.includes("getTicket(input")) {
        return {
          getTicket: {
            ...candidate,
            subcategory: "No Action Needed",
            cause: "Unknown",
            resolutionCode: "Permanent Fix",
          },
        };
      }
      if (query.includes("getTicketConversationList")) {
        return {
          getTicketConversationList: [{
            conversationId: `description-${candidate.displayId}`,
            type: "DESCRIPTION",
            time: candidate.createdTime,
            content: `Verified safe evidence for ${candidate.displayId}.`,
          }],
        };
      }
      if (query.includes("getTicketNoteList")) {
        return {
          getTicketNoteList: [{
            noteId: `note-${candidate.displayId}`,
            addedOn: candidate.updatedTime,
            content: `<html>Private context for ${candidate.displayId}.</html>`,
            privacyType: "PRIVATE",
          }],
        };
      }
      throw new Error(`Unexpected query ${query}`);
    });

    const domain = getTicketsTools();
    const pages = [];
    for (const page of [1, 2]) {
      const result = await runWithExecutionConfig({
        SUPEROPS_EXECUTION_SUBREQUEST_BUDGET: "45",
        SUPEROPS_EXECUTION_SUBREQUEST_SAFETY_MARGIN: "8",
      }, () => domain.handleCall("superops_tickets_triage_snapshot", {
        status: ["New Calls"],
        max: 500,
        page,
        includeNotes: true,
        includeConversations: true,
      }));
      expect(result.isError).toBeUndefined();
      pages.push(JSON.parse(result.content[0].text));
    }

    expect(listRequests).toEqual([
      { page: 1, pageSize: 8 },
      { page: 2, pageSize: 8 },
    ]);
    expect(pages[0].pagination).toMatchObject({
      page: 1, pageSize: 8, hasMore: true, nextPage: 2, budgetCapped: true,
    });
    expect(pages[1].pagination).toMatchObject({
      page: 2, pageSize: 8, hasMore: false, nextPage: null, budgetCapped: true,
    });
    expect(pages.flatMap((page) => page.candidateTicketNumbers)).toEqual(
      candidates.map((candidate) => candidate.displayId)
    );
    const tickets = pages.flatMap((page) => page.tickets);
    expect(tickets).toHaveLength(14);
    expect(tickets).toEqual(tickets.map((_ticket: Record<string, unknown>) =>
      expect.objectContaining({
        processingState: "SnapshotRead",
        warnings: [],
        contentAvailability: expect.objectContaining({
          metadata: "available",
          conversations: "available",
          notes: "available",
        }),
      })
    ));
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });
  it("returns the same canonical DESCRIPTION evidence from safe-by-number and triage snapshot", async () => {
    const automatedAcknowledgement = {
      conversationId: "5059118458555555840",
      type: "TECH_REPLY",
      time: "2026-07-21T15:30:06.942",
      user: { name: "Task Group" },
      content: "Task Group automated acknowledgement: we have received your request.",
    };
    const customerDescription = {
      conversationId: "5383986353711595520",
      type: "DESCRIPTION",
      time: "2026-07-21T15:30:05.642",
      user: { name: "Catherine Cooper" },
      content:
        "Please could Catherine Cooper have access to the Twelve Trees SharePoint page as soon as possible.",
    };

    type TicketQueryVariables = {
      input?: {
        ticketId?: string;
        condition?: { attribute?: string; value?: unknown };
      };
    };

    mockClient.query.mockImplementation(
      async (query: string, variables?: TicketQueryVariables) => {
        const input = variables?.input;
        const ticketId = input?.ticketId;

        if (query.includes("getTicketList")) {
          const isDisplayLookup = input?.condition?.attribute === "displayId";
          return {
            getTicketList: {
              tickets: [
                isDisplayLookup
                  ? {
                      ticketId: "canonical-58744",
                      displayId: "58744",
                      subject: "SharePoint access",
                      status: "New Calls",
                    }
                  : {
                      ticketId: "list-candidate-58744",
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
              ticketId: ticketId ?? "list-candidate-58744",
              displayId: "58744",
              subject: "SharePoint access",
              status: "New Calls",
              createdTime: "2026-07-21T15:30:05.000",
              updatedTime: "2026-07-21T15:30:07.000",
            },
          };
        }

        if (query.includes("getTicketConversationList")) {
          return {
            getTicketConversationList:
              ticketId === "canonical-58744"
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
    const safeByNumberResult = await domain.handleCall("superops_tickets_get_safe_by_number", {
      ticketNumber: "58744",
      includeNotes: true,
      includeConversations: true,
      attachments: "metadataOnly",
      maxTotalChars: 2500,
      maxItems: 6,
      latestFirst: true,
    });
    const triageResult = await domain.handleCall("superops_tickets_triage_snapshot", {
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

    expect(safeByNumberResult.isError).toBeUndefined();
    expect(triageResult.isError).toBeUndefined();
    const safeByNumber = JSON.parse(safeByNumberResult.content[0].text);
    const triageSnapshot = JSON.parse(triageResult.content[0].text);
    const snapshotTicket = triageSnapshot.tickets[0];

    const safeItems = safeByNumber.safeContent.items.map(
      (item: { id: string; plainText: string }) => ({
        id: item.id,
        plainText: item.plainText,
      })
    );
    const snapshotItems = snapshotTicket.safeContentItems.map(
      (item: { id: string; plainText: string }) => ({
        id: item.id,
        plainText: item.plainText,
      })
    );

    expect(safeItems).toEqual([
      {
        id: "5059118458555555840",
        plainText: expect.stringContaining("automated acknowledgement"),
      },
      {
        id: "5383986353711595520",
        plainText: expect.stringContaining(
          "Please could Catherine Cooper have access to the Twelve Trees SharePoint page"
        ),
      },
    ]);
    expect(snapshotItems).toEqual(safeItems);
    expect(snapshotTicket.safeSummary).toContain("automated acknowledgement");
    expect(snapshotTicket.safeSummary).toContain(
      "Please could Catherine Cooper have access to the Twelve Trees SharePoint page"
    );
    expect(new Set(snapshotTicket.safeContentItems.map((item: { id: string }) => item.id)).size)
      .toBe(snapshotTicket.safeContentItems.length);
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });

  it("recovers bounded sanitised evidence by immutable ticket ID and preserves batch failures", async () => {
    mockClient.query.mockImplementation(async (
      query: string,
      variables?: { input?: { ticketId?: string } }
    ) => {
      const ticketId = String(variables?.input?.ticketId ?? "");
      if (query.includes("getTicket(input")) {
        if (ticketId === "ticket-unavailable") throw new Error("read temporarily unavailable");
        return {
          getTicket: {
            ticketId,
            displayId: ticketId === "ticket-59420" ? "59420" : "59419",
            subject: ticketId === "ticket-59420" ? "Greenport-Fresh new starter" : "Disk space request",
            client: { accountId: "client-1", name: "TaskGroup" },
            status: "New Calls",
            impact: "Medium",
            urgency: "Medium",
            category: "1. Support request",
            subcategory: "User Administration",
            createdTime: "2026-07-31T08:00:00.000Z",
            updatedTime: "2026-07-31T09:00:00.000Z",
          },
        };
      }
      if (query.includes("getTicketConversationList")) {
        return {
          getTicketConversationList: [{
            conversationId: `description-${ticketId}`,
            type: "DESCRIPTION",
            time: "2026-07-31T08:00:00.000Z",
            content: `<p>Verified request for ${ticketId}.</p><script>hidden()</script>`,
          }],
        };
      }
      throw new Error(`Unexpected query: ${query}`);
    });

    const domain = getTicketsTools();
    const singleResult = await domain.handleCall("superops_tickets_get_safe", {
      ticketId: "ticket-59420",
      includeNotes: false,
      includeConversations: true,
      attachments: "metadataOnly",
    });
    const single = JSON.parse(singleResult.content[0].text);
    expect(singleResult.isError).toBeUndefined();
    expect(single).toMatchObject({
      ok: true,
      ticketId: "ticket-59420",
      contentEvidenceState: "meaningful",
      evidence: {
        ticketId: "ticket-59420",
        ticketNumber: "59420",
        subject: "Greenport-Fresh new starter",
        safeContent: {
          items: [{ plainText: expect.stringContaining("Verified request for ticket-59420") }],
        },
      },
    });
    expect(JSON.stringify(single)).not.toContain("<script>");

    const batchResult = await domain.handleCall("superops_tickets_triage_evidence_recover", {
      ticketIds: ["ticket-59419", "ticket-unavailable"],
      includeNotes: false,
      includeConversations: true,
      attachments: "metadataOnly",
    });
    const batch = JSON.parse(batchResult.content[0].text);
    expect(batchResult.isError).toBeUndefined();
    expect(batch).toMatchObject({
      complete: false,
      requestedCount: 2,
      recoveredCount: 1,
      ticketIds: ["ticket-59419", "ticket-unavailable"],
      results: [
        { ticketId: "ticket-59419", ok: true, contentEvidenceState: "meaningful" },
        {
          ticketId: "ticket-unavailable",
          ok: false,
          contentEvidenceState: "unavailable",
          errorClass: "SafeReadFailure",
        },
      ],
    });
    const safeMetadataQueries = mockClient.query.mock.calls
      .map(([query]) => String(query))
      .filter((query) => query.includes("getTicket(input"));
    expect(safeMetadataQueries).not.toHaveLength(0);
    expect(safeMetadataQueries.every((query) => !query.includes("customFields"))).toBe(true);
    expect(mockClient.mutate).not.toHaveBeenCalled();
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

  it.each([2500, 10000])(
    "applies triage snapshot character limit %i to safe content",
    async (maxContentCharsPerTicket) => {
      mockClient.query
        .mockResolvedValueOnce({
          getTicketList: {
            tickets: [
              {
                ticketId: "ticket-58744-char-limit",
                displayId: "58744",
                subject: "SharePoint access",
                status: "New Calls",
              },
            ],
            listInfo: { page: 1, pageSize: 20, hasMore: false, totalCount: 1 },
          },
        })
        .mockResolvedValueOnce({
          getTicket: {
            ticketId: "ticket-58744-char-limit",
            displayId: "58744",
            subject: "SharePoint access",
            status: "New Calls",
          },
        })
        .mockResolvedValueOnce({
          getTicketConversationList: [
            {
              conversationId: "conversation-short",
              type: "TECH_REPLY",
              time: "2026-07-21T10:05:00Z",
              content: "Task Group automated acknowledgement: we have received your request.",
            },
            {
              conversationId: "description-too-long",
              type: "DESCRIPTION",
              time: "2026-07-21T10:00:00Z",
              content:
                "Please could Catherine Cooper have access to the Twelve Trees SharePoint page " +
                Array(2000).fill("details").join(" "),
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
        maxContentCharsPerTicket,
        maxItemsPerTicket: 6,
        latestFirst: true,
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.tickets[0].safeContentItems).toEqual([
        expect.objectContaining({
          id: "conversation-short",
          type: "technician_reply",
          plainText: "Task Group automated acknowledgement: we have received your request.",
          truncated: false,
        }),
        expect.objectContaining({
          id: "description-too-long",
          type: "description",
          plainText: expect.stringContaining(
            "Please could Catherine Cooper have access to the Twelve Trees SharePoint page"
          ),
          truncated: true,
        }),
      ]);
      expect(
        parsed.tickets[0].safeContentItems.reduce(
          (total: number, item: { plainText: string }) => total + item.plainText.length,
          0
        )
      ).toBeLessThanOrEqual(maxContentCharsPerTicket);
    }
  );
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


  async function runTriageSubcategoryDryRun(
    field: ReturnType<typeof subcategoryFieldWithParents>,
    target: { category?: string; subcategory: string }
  ) {
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
          subject: "Dry run subcategory",
          status: "New Calls",
          updatedTime: "2026-06-25T10:00:00",
        },
      })
      .mockResolvedValueOnce({ getFields: [
        ...RESOLVED_OPTION_FIELDS.filter((optionField) => optionField.columnName !== "subcategory"),
        field,
      ] });

    const result = await getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
      expectedCandidateTicketNumbers: ["57400"],
      dryRun: true,
      actions: [
        {
          ticketNumber: "57400",
          expectedUpdatedTime: "2026-06-25T10:00:00",
          contentVerified: true,
          action: "update",
          target: {
            impact: "Low",
            urgency: "Low",
            status: "Awaiting Engineer",
            ...target,
          },
        },
      ],
    });

    return result.isError
      ? { validationError: result.content[0].text }
      : JSON.parse(result.content[0].text);
  }

  it.each([
    ["normal order", "2. Change request", CHANGE_ACCESS_SUBCATEGORY_ID, false],
    ["normal order", "3. Security Incident", SECURITY_ACCESS_SUBCATEGORY_ID, false],
    ["reversed order", "2. Change request", CHANGE_ACCESS_SUBCATEGORY_ID, true],
    ["reversed order", "3. Security Incident", SECURITY_ACCESS_SUBCATEGORY_ID, true],
  ] as const)(
    "selects duplicate Access subcategory option %s for %s using option ID %s",
    async (_order, category, expectedOptionId, reverse) => {
      const field = duplicateAccessSubcategoryField(reverse);
      const expectedOption = field.options.find((option) => option.id === expectedOptionId);
      expect(expectedOption).toMatchObject({
        value: "Access",
        parentOption: { value: category },
      });

      const parsed = await runTriageSubcategoryDryRun(field, {
        category,
        subcategory: "Access",
      });

      expect(parsed.results[0]).toMatchObject({
        finalOutcome: "Updated",
        writeAttempted: false,
        writeMethod: "dryRun",
        requestedState: {
          category,
          subcategory: "Access",
        },
        attemptedState: null,
      });
      expect(mockClient.mutate).not.toHaveBeenCalled();
    }
  );

  it("rejects a triage classification target missing category before any read or write", async () => {
    const parsed = await runTriageSubcategoryDryRun(duplicateAccessSubcategoryField(), {
      subcategory: "Access",
    });

    expect(parsed.validationError).toContain("requires classification field(s): category");
    expect(mockClient.query).not.toHaveBeenCalled();
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });

  it("blocks duplicate Access subcategory with an invalid parent category before write", async () => {
    const parsed = await runTriageSubcategoryDryRun(duplicateAccessSubcategoryField(), {
      category: "1. Support request",
      subcategory: "Access",
    });

    expect(parsed.results[0]).toMatchObject({
      finalOutcome: "Blocked",
      failureStage: "validation",
      writeAttempted: false,
    });
    expect(parsed.results[0].failureReason).toContain('not "1. Support request"');
    expect(parsed.results[0].failureReason).toContain("2. Change request");
    expect(parsed.results[0].failureReason).toContain("3. Security Incident");
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });

  it("validates a unique dependent subcategory normally in triage dry-run", async () => {
    const parsed = await runTriageSubcategoryDryRun(
      subcategoryFieldWithParents([
        {
          id: "unique-wireless-subcategory",
          value: "Wireless",
          parentCategory: "1. Support request",
        },
      ]),
      {
        category: "1. Support request",
        subcategory: "Wireless",
      }
    );

    expect(parsed.results[0]).toMatchObject({
      finalOutcome: "Updated",
      writeAttempted: false,
      writeMethod: "dryRun",
      requestedState: {
        category: "1. Support request",
        subcategory: "Wireless",
      },
    });
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

  it("classifies a Ticket on Hold leave ticket without changing its status and reports every expected candidate", async () => {
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
          subject: "Leave on hold",
          status: "Ticket on Hold",
          updatedTime: "2026-06-25T10:00:00Z",
        },
      })
      .mockResolvedValueOnce({ getFields: RESOLVED_OPTION_FIELDS })
      .mockResolvedValueOnce({
        getTicket: {
          ticketId: "ticket-57400",
          displayId: "57400",
          subject: "Leave on hold",
          status: "Ticket on Hold",
          updatedTime: "2026-06-25T10:01:00Z",
          ...TRIAGE_TEST_CLASSIFICATION,
        },
      });
    mockClient.mutate.mockResolvedValueOnce({
      updateTicket: { ticketId: "ticket-57400" },
    });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_apply_triage_plan", {
      expectedCandidateTicketNumbers: ["57400", "57401"],
      actions: [{
        ticketNumber: "57400",
        expectedStatus: "Ticket on Hold",
        expectedUpdatedTime: "2026-06-25T10:00:00Z",
        contentVerified: true,
        action: "leave",
        target: { ...TRIAGE_TEST_CLASSIFICATION },
      }],
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.results).toEqual([
      expect.objectContaining({
        ticketNumber: "57400",
        finalOutcome: "Left",
        writeAttempted: true,
        verified: true,
        physicalWrites: [{ method: "updateTicket", outcome: "Accepted" }],
        finalState: expect.objectContaining({ status: "Ticket on Hold" }),
      }),
      expect.objectContaining({
        ticketNumber: "57401",
        finalOutcome: "NoApprovedAction",
        writeAttempted: false,
      }),
    ]);
    expect(mockClient.mutate).toHaveBeenCalledTimes(1);
    const mutationInput = mockClient.mutate.mock.calls[0][1].input;
    expect(mutationInput).toEqual({
      ticketId: "ticket-57400",
      ...TRIAGE_TEST_CLASSIFICATION,
    });
    expect(mutationInput).not.toHaveProperty("status");
  });

  it("blocks a null-client triage write unless the approved target includes client name and ID", async () => {
    mockClient.query
      .mockResolvedValueOnce({
        getTicketList: {
          tickets: [{ ticketId: "ticket-57402-blocked", displayId: "57402" }],
          listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 },
        },
      })
      .mockResolvedValueOnce({
        getTicket: {
          ticketId: "ticket-57402-blocked",
          displayId: "57402",
          subject: "Null-client resolve",
          status: "New Calls",
          client: null,
          updatedTime: "2026-07-26T08:59:00Z",
        },
      });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_apply_triage_plan", {
      expectedCandidateTicketNumbers: ["57402"],
      actions: [{
        ticketNumber: "57402",
        expectedStatus: "New Calls",
        expectedUpdatedTime: "2026-07-26T08:59:00Z",
        contentVerified: true,
        action: "resolve",
        target: {
          status: "Resolved",
          ...TRIAGE_TEST_RESOLUTION_CLASSIFICATION,
          suppressCloseNotification: true,
        },
      }],
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.results).toEqual([
      expect.objectContaining({
        ticketNumber: "57402",
        finalOutcome: "Blocked",
        failureStage: "clientAssignment",
        failureReason: expect.stringContaining("clientName and clientId"),
        writeAttempted: false,
        physicalWrites: [],
      }),
    ]);
    expect(mockClient.query).toHaveBeenCalledTimes(2);
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });

  it("assigns TaskGroup to an already-resolved ticket without replaying its resolve or note writes", async () => {
    mockClient.query
      .mockResolvedValueOnce({
        getTicketList: {
          tickets: [{ ticketId: "ticket-57402", displayId: "57402" }],
          listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 },
        },
      })
      .mockResolvedValueOnce({
        getTicket: {
          ticketId: "ticket-57402",
          displayId: "57402",
          subject: "Already resolved without a client",
          status: "Resolved",
          client: null,
          updatedTime: "2026-07-26T09:00:00Z",
          ...TRIAGE_TEST_CLASSIFICATION,
        },
      })
      .mockResolvedValueOnce({ getFields: RESOLVED_OPTION_FIELDS })
      .mockResolvedValueOnce({
        getTicket: {
          ticketId: "ticket-57402",
          displayId: "57402",
          subject: "Already resolved without a client",
          status: "Resolved",
          client: {
            accountId: "2993553194649526272",
            name: "TaskGroup",
          },
          updatedTime: "2026-07-26T09:01:00Z",
          ...TRIAGE_TEST_CLASSIFICATION,
        },
      });
    mockClient.mutate.mockResolvedValueOnce({
      updateTicket: { ticketId: "ticket-57402" },
    });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_apply_triage_plan", {
      expectedCandidateTicketNumbers: ["57402"],
      actions: [{
        ticketNumber: "57402",
        expectedStatus: "Resolved",
        expectedUpdatedTime: "2026-07-26T09:00:00Z",
        contentVerified: true,
        action: "leave",
        target: {
          ...TRIAGE_TEST_CLASSIFICATION,
          clientName: "TaskGroup",
          clientId: "2993553194649526272",
        },
      }],
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.results).toEqual([
      expect.objectContaining({
        ticketNumber: "57402",
        finalOutcome: "Left",
        writeAttempted: true,
        noteAdded: false,
        verified: true,
        physicalWrites: [{ method: "updateTicket", outcome: "Accepted" }],
        finalState: expect.objectContaining({
          status: "Resolved",
          clientName: "TaskGroup",
          clientId: "2993553194649526272",
        }),
      }),
    ]);
    expect(mockClient.mutate).toHaveBeenCalledTimes(1);
    const mutationInput = mockClient.mutate.mock.calls[0][1].input;
    expect(mutationInput).toEqual({
      ticketId: "ticket-57402",
      ...TRIAGE_TEST_CLASSIFICATION,
      client: { accountId: "2993553194649526272" },
    });
    expect(mutationInput).not.toHaveProperty("status");
    expect(mutationInput).not.toHaveProperty("resolutionCode");
    expect(mockClient.mutate.mock.calls[0][0]).not.toContain("createTicketNote");
  });

  it("adds and verifies one deduplicated private triage-summary note for a leave action", async () => {
    const triageNote = [
      "Ticket goal: Confirm the reported availability issue and route it safely.",
      "What needs to be known: This is an automated device-down alert.",
      "Next step: Service desk reviews and assigns the ticket.",
      "When: At the next New Calls review.",
    ].join("\n");
    const ticketState: Record<string, unknown> = {
      ticketId: "ticket-57403",
      displayId: "57403",
      subject: "Server is down",
      status: "New Calls",
      updatedTime: "2026-07-26T09:00:00Z",
    };
    const notes: Array<Record<string, unknown>> = [];

    mockClient.query.mockImplementation(async (query: string) => {
      if (query.includes("getTicketList")) {
        return { getTicketList: {
          tickets: [{ ticketId: "ticket-57403", displayId: "57403" }],
          listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 },
        } };
      }
      if (query.includes("getFields")) return { getFields: RESOLVED_OPTION_FIELDS };
      if (query.includes("getTicketNoteList")) return { getTicketNoteList: [...notes] };
      return { getTicket: { ...ticketState } };
    });
    mockClient.mutate.mockImplementation(async (mutation: string, variables: { input: Record<string, unknown> }) => {
      if (mutation.includes("createTicketNote")) {
        expect(variables.input).toEqual({
          ticket: { ticketId: "ticket-57403" },
          content: triageNote,
          privacyType: "PRIVATE",
        });
        notes.push({ noteId: "note-57403", content: triageNote, privacyType: "PRIVATE" });
        return { createTicketNote: { noteId: "note-57403", privacyType: "PRIVATE" } };
      }
      Object.assign(ticketState, variables.input, { updatedTime: "2026-07-26T09:01:00Z" });
      return { updateTicket: { ticketId: "ticket-57403" } };
    });

    const result = await getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
      batchId: "leave-private-triage-summary",
      expectedCandidateTicketNumbers: ["57403"],
      actions: [{
        ticketNumber: "57403",
        expectedTicketId: "ticket-57403",
        expectedStatus: "New Calls",
        expectedUpdatedTime: "2026-07-26T09:00:00Z",
        contentVerified: true,
        action: "leave",
        target: { ...TRIAGE_TEST_CLASSIFICATION },
        note: triageNote,
        isPublicNote: false,
      }],
      verify: true,
      dedupeNotes: true,
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.results[0]).toMatchObject({
      finalOutcome: "Left",
      notePlanned: true,
      noteDedupeChecked: true,
      noteDeduped: false,
      noteAdded: true,
      noteWriteOutcome: "AcceptedAndVerified",
      finalVerificationState: "Verified",
      verified: true,
    });
    expect(parsed.results[0].physicalWrites).toEqual([
      { method: "updateTicket", outcome: "Accepted" },
      { method: "createTicketNote", outcome: "Accepted" },
    ]);
    expect(mockClient.mutate).toHaveBeenCalledTimes(2);
    const updateInput = mockClient.mutate.mock.calls
      .find(([mutation]) => !String(mutation).includes("createTicketNote"))?.[1].input;
    expect(updateInput).not.toHaveProperty("status");
    expect(updateInput).not.toHaveProperty("resolutionCode");
  });
  it("reconciles delayed leave-note visibility without replaying either write", async () => {
    await runWithOperationStore({}, async () => {
      const triageNote = [
        "Ticket goal: Confirm the server-down alert and route it safely.",
        "What needs to be known: The monitoring message reports lost connectivity.",
        "Next step: Service desk reviews and assigns the ticket.",
        "When: At the next New Calls review.",
      ].join("\n");
      const ticketState: Record<string, unknown> = {
        ticketId: "ticket-57404",
        displayId: "57404",
        subject: "#Asset Name is down",
        status: "New Calls",
        updatedTime: "2026-07-26T10:00:00Z",
      };
      let noteSubmitted = false;
      let noteVisible = false;
      let updateWrites = 0;
      let noteWrites = 0;

      mockClient.query.mockImplementation(async (query: string) => {
        if (query.includes("getTicketList")) {
          return { getTicketList: {
            tickets: [{ ticketId: "ticket-57404", displayId: "57404" }],
            listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 },
          } };
        }
        if (query.includes("getFields")) return { getFields: RESOLVED_OPTION_FIELDS };
        if (query.includes("getTicketNoteList")) {
          return { getTicketNoteList: noteSubmitted && noteVisible
            ? [{ noteId: "note-57404", content: triageNote, privacyType: "PRIVATE" }]
            : [] };
        }
        return { getTicket: { ...ticketState } };
      });
      mockClient.mutate.mockImplementation(async (mutation: string, variables: { input: Record<string, unknown> }) => {
        if (mutation.includes("createTicketNote")) {
          noteWrites += 1;
          noteSubmitted = true;
          return { createTicketNote: { noteId: "note-57404", privacyType: "PRIVATE" } };
        }
        updateWrites += 1;
        Object.assign(ticketState, variables.input, { updatedTime: "2026-07-26T10:01:00Z" });
        return { updateTicket: { ticketId: "ticket-57404" } };
      });

      const initial = await withSuccessfulContinuationScheduling(() =>
        getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
          batchId: "leave-note-delayed-visibility",
          expectedCandidateTicketNumbers: ["57404"],
          actions: [{
            ticketNumber: "57404",
            expectedTicketId: "ticket-57404",
            expectedStatus: "New Calls",
            expectedUpdatedTime: "2026-07-26T10:00:00Z",
            contentVerified: true,
            action: "leave",
            target: { ...TRIAGE_TEST_CLASSIFICATION },
            note: triageNote,
            isPublicNote: false,
          }],
          verify: true,
          dedupeNotes: true,
        })
      );
      const initialParsed = JSON.parse(initial.content[0].text);
      const pending = await getOperationStore().get("leave-note-delayed-visibility");

      expect(initialParsed.results[0]).toMatchObject({
        finalOutcome: "NoteVisibilityPending",
        noteAdded: true,
        noteVerificationAttempts: 1,
        continuationRequired: true,
      });
      expect(pending?.itemStates["57404"]).toMatchObject({
        stage: "NoteAdded",
        outcome: "NoteVisibilityPending",
        writeAttempted: true,
        writeMayHaveSucceeded: true,
      });
      expect(updateWrites).toBe(1);
      expect(noteWrites).toBe(1);

      noteVisible = true;
      await runWithExecutionConfig({}, () => runWithExecutionContext(
        "superops_tickets_apply_triage_plan",
        () => resumeApplyTriageOperation({
          operationId: "leave-note-delayed-visibility",
          ownerHash: pending?.ownerHash ?? stableHash("anonymous"),
          leaseOwner: "leave-note-visibility-worker",
          now: new Date(Date.now() + 60_000).toISOString(),
        })
      ));

      const completed = await getOperationStore().get("leave-note-delayed-visibility");
      expect(completed?.state).toBe("Completed");
      expect(completed?.itemStates["57404"]).toMatchObject({
        stage: "CompletedAfterAmbiguousWriteVerification",
        outcome: "Left",
        verificationState: "Verified",
        writeAttempted: true,
        writeMayHaveSucceeded: true,
        partialWrite: false,
      });
      const completedView = operationResultView(completed!) as {
        results: Array<Record<string, unknown>>;
      };
      expect(completedView.results[0]).toMatchObject({
        finalOutcome: "Left",
        noteAdded: true,
        noteWriteOutcome: "NoteVerifiedAfterDelay",
        noteVerifiedAfterDelay: true,
        finalVerificationState: "Verified",
      });
      expect(updateWrites).toBe(1);
      expect(noteWrites).toBe(1);
    });
  });
  it("updates from Ticket on Hold with optional cause and no resolution code", async () => {
    mockClient.query
      .mockResolvedValueOnce({
        getTicketList: {
          tickets: [{ ticketId: "ticket-57402", displayId: "57402" }],
          listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 },
        },
      })
      .mockResolvedValueOnce({
        getTicket: {
          ticketId: "ticket-57402",
          displayId: "57402",
          status: "Ticket on Hold",
          updatedTime: "2026-07-26T08:00:00.000Z",
        },
      })
      .mockResolvedValueOnce({ getFields: RESOLVED_OPTION_FIELDS })
      .mockResolvedValueOnce({
        getTicket: {
          ticketId: "ticket-57402",
          displayId: "57402",
          status: "Awaiting Engineer",
          updatedTime: "2026-07-26T08:01:00.000Z",
          ...TRIAGE_TEST_CLASSIFICATION,
          cause: "User Request",
        },
      });
    mockClient.mutate.mockResolvedValueOnce({
      updateTicket: { ticketId: "ticket-57402", status: "Awaiting Engineer" },
    });

    const result = await getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
      expectedCandidateTicketNumbers: ["57402"],
      actions: [{
        ticketNumber: "57402",
        expectedStatus: "Ticket on Hold",
        expectedUpdatedTime: "2026-07-26T08:00:00.000Z",
        contentVerified: true,
        action: "update",
        target: {
          ...TRIAGE_TEST_CLASSIFICATION,
          cause: "User Request",
          status: "Awaiting Engineer",
        },
      }],
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.results[0]).toMatchObject({
      finalOutcome: "Updated",
      verified: true,
      finalState: expect.objectContaining({ status: "Awaiting Engineer", cause: "User Request" }),
    });
    expect(mockClient.mutate).toHaveBeenCalledTimes(1);
    expect(mockClient.mutate.mock.calls[0][1].input).toEqual({
      ticketId: "ticket-57402",
      ...TRIAGE_TEST_CLASSIFICATION,
      cause: "User Request",
      status: "Awaiting Engineer",
    });
    expect(mockClient.mutate.mock.calls[0][1].input).not.toHaveProperty("resolutionCode");
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
          target: { ...TRIAGE_TEST_CLASSIFICATION, status: "Awaiting Engineer" },
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

  it("rejects an unknown scheduled policy mode before any read, ledger write, or mutation", async () => {
    const result = await getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
      policyMode: "scheduled-new-calls-v2",
      expectedCandidateTicketNumbers: ["57400"],
      actions: [],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("policyMode must be one of");
    expect(mockClient.query).not.toHaveBeenCalled();
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });

  it("rejects a partial scheduled New Calls batch before any read or write", async () => {
    const result = await getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
      policyMode: "scheduled-new-calls-v1",
      expectedCandidateTicketNumbers: ["57400", "57401"],
      actions: [{
        ticketNumber: "57400",
        expectedTicketId: "ticket-57400",
        expectedSubject: "Customer request",
        expectedStatus: "New Calls",
        expectedUpdatedTime: "2026-06-25T10:00:00Z",
        contentVerified: true,
        action: "leave",
        policyDisposition: "customer_request",
        contentEvidenceState: "meaningful",
        policyReason: "customer_or_requester_work",
        note: SCHEDULED_TRIAGE_TEST_NOTE,
        isPublicNote: false,
        target: { ...TRIAGE_TEST_CLASSIFICATION },
      }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("exactly one action for every fixed candidate");
    expect(mockClient.query).not.toHaveBeenCalled();
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });

  it("rejects missing structured private notes and unsafe scheduled overrides before any read or write", async () => {
    const domain = getTicketsTools();
    const baseAction = {
      ticketNumber: "57400",
      expectedTicketId: "ticket-57400",
      expectedSubject: "Customer request",
      expectedStatus: "New Calls",
      expectedUpdatedTime: "2026-06-25T10:00:00Z",
      contentVerified: true,
      action: "leave",
      policyDisposition: "customer_request",
      contentEvidenceState: "meaningful",
      policyReason: "customer_or_requester_work",
      isPublicNote: false,
      target: { ...TRIAGE_TEST_CLASSIFICATION },
    };
    const missingNote = await domain.handleCall("superops_tickets_apply_triage_plan", {
      policyMode: "scheduled-new-calls-v1",
      expectedCandidateTicketNumbers: ["57400"],
      actions: [baseAction],
    });
    const unsafeOverride = await domain.handleCall("superops_tickets_apply_triage_plan", {
      policyMode: "scheduled-new-calls-v1",
      expectedCandidateTicketNumbers: ["57400"],
      allowWriteIfUpdatedTimeChanged: true,
      actions: [{ ...baseAction, note: SCHEDULED_TRIAGE_TEST_NOTE }],
    });

    expect(missingNote.isError).toBe(true);
    expect(missingNote.content[0].text).toContain("TRIAGE SUMMARY note is required");
    expect(unsafeOverride.isError).toBe(true);
    expect(unsafeOverride.content[0].text).toContain("prohibits unsafe write overrides");
    expect(mockClient.query).not.toHaveBeenCalled();
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });

  it("forces obvious server-down notifications to remain in New Calls", async () => {
    const result = await getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
      policyMode: "scheduled-new-calls-v1",
      expectedCandidateTicketNumbers: ["57400"],
      actions: [{
        ticketNumber: "57400",
        expectedTicketId: "ticket-57400",
        expectedSubject: "#Asset Name is down",
        expectedStatus: "New Calls",
        expectedUpdatedTime: "2026-06-25T10:00:00Z",
        contentVerified: true,
        action: "update",
        policyDisposition: "engineer_review",
        contentEvidenceState: "meaningful",
        policyReason: "actionable_engineer_work",
        note: SCHEDULED_TRIAGE_TEST_NOTE,
        isPublicNote: false,
        target: { ...TRIAGE_TEST_CLASSIFICATION, status: "Awaiting Engineer" },
      }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("must use server_down with leave");
    expect(mockClient.query).not.toHaveBeenCalled();
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });

  it("rejects a 59405-equivalent empty ticket resolution before creating an operation", async () => {
    const result = await getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
      policyMode: "scheduled-new-calls-v1",
      expectedCandidateTicketNumbers: ["59405"],
      actions: [{
        ticketNumber: "59405",
        expectedTicketId: "ticket-59405",
        expectedSubject: "Test from Sam to support",
        expectedStatus: "New Calls",
        expectedUpdatedTime: "2026-07-31T09:00:00Z",
        contentVerified: true,
        contentEvidenceState: "empty",
        policyReason: "no_action_administration",
        policyDisposition: "resolve_no_action",
        action: "resolve",
        note: SCHEDULED_TRIAGE_TEST_NOTE,
        isPublicNote: false,
        target: {
          ...TRIAGE_TEST_CLASSIFICATION,
          cause: "Unknown",
          resolutionCode: "Permanent Fix",
          status: "Resolved",
          suppressCloseNotification: true,
        },
      }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("empty content evidence");
    expect(mockClient.query).not.toHaveBeenCalled();
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
      })
      .mockResolvedValueOnce({ getFields: RESOLVED_OPTION_FIELDS });

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
          target: { ...TRIAGE_TEST_CLASSIFICATION, status: "Awaiting Engineer" },
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

  it("rejects an approved triage update without a complete classification target", async () => {
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
    expect(result.content[0].text).toContain("update action requires classification field(s)");
    expect(mockClient.query).not.toHaveBeenCalled();
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });

  it.each(VALID_TICKET_STATUSES.filter(
    (status) => status !== "Resolved" && status !== "Awaiting Engineer"
  ))("rejects disallowed triage status %s before any read or write", async (status) => {
    const result = await getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
      expectedCandidateTicketNumbers: ["57400"],
      actions: [{
        ticketNumber: "57400",
        expectedUpdatedTime: "2026-06-25T10:00:00Z",
        contentVerified: true,
        action: "update",
        target: { ...TRIAGE_TEST_CLASSIFICATION, status },
      }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      "target.status must be Awaiting Engineer for an update action"
    );
    expect(mockClient.query).not.toHaveBeenCalled();
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });

  it("rejects Awaiting Engineer on resolve and any status on leave", async () => {
    const domain = getTicketsTools();
    const resolve = await domain.handleCall("superops_tickets_apply_triage_plan", {
      expectedCandidateTicketNumbers: ["57400"],
      actions: [{
        ticketNumber: "57400",
        expectedUpdatedTime: "2026-06-25T10:00:00Z",
        contentVerified: true,
        action: "resolve",
        target: { ...TRIAGE_TEST_RESOLUTION_CLASSIFICATION, status: "Awaiting Engineer" },
      }],
    });
    const leave = await domain.handleCall("superops_tickets_apply_triage_plan", {
      expectedCandidateTicketNumbers: ["57400"],
      actions: [{
        ticketNumber: "57400",
        expectedUpdatedTime: "2026-06-25T10:00:00Z",
        contentVerified: true,
        action: "leave",
        target: { ...TRIAGE_TEST_CLASSIFICATION, status: "Resolved" },
      }],
    });

    expect(resolve.isError).toBe(true);
    expect(resolve.content[0].text).toContain("target.status must be Resolved");
    expect(leave.isError).toBe(true);
    expect(leave.content[0].text).toContain("target.status is not allowed for a leave action");
    expect(mockClient.query).not.toHaveBeenCalled();
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });

  it("rejects resolution code on update and leave before any read or write", async () => {
    const domain = getTicketsTools();
    for (const action of ["update", "leave"] as const) {
      const result = await domain.handleCall("superops_tickets_apply_triage_plan", {
        expectedCandidateTicketNumbers: ["57400"],
        actions: [{
          ticketNumber: "57400",
          expectedUpdatedTime: "2026-06-25T10:00:00Z",
          contentVerified: true,
          action,
          target: {
            ...TRIAGE_TEST_CLASSIFICATION,
            ...(action === "update" ? { status: "Awaiting Engineer" } : {}),
            resolutionCode: "Permanent Fix",
          },
        }],
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(
        "target.resolutionCode is only allowed for a resolve action"
      );
    }
    expect(mockClient.query).not.toHaveBeenCalled();
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });
  it("rejects a leave action without every classification field", async () => {
    const result = await getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
      expectedCandidateTicketNumbers: ["57400"],
      actions: [{
        ticketNumber: "57400",
        expectedUpdatedTime: "2026-06-25T10:00:00Z",
        contentVerified: true,
        action: "leave",
        target: { category: "1. Support request" },
      }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("leave action requires classification field(s)");
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
      noteDedupePlanned: true,
      noteDedupeChecked: true,
      verified: true,
    });
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });

  it("does not treat an identically worded public note as a private-note dedupe match", async () => {
    let privateNoteCreated = false;
    mockClient.query.mockImplementation(async (query: string) => {
      if (query.includes("getTicketList")) {
        return { getTicketList: {
          tickets: [{ ticketId: "ticket-57400", displayId: "57400" }],
          listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 },
        } };
      }
      if (query.includes("getTicketNoteList")) {
        return { getTicketNoteList: [
          { noteId: "public-copy", content: "Approved private note", privacyType: "PUBLIC" },
          ...(privateNoteCreated
            ? [{ noteId: "private-copy", content: "Approved private note", privacyType: "PRIVATE" }]
            : []),
        ] };
      }
      return { getTicket: { ticketId: "ticket-57400", displayId: "57400", status: "New Calls" } };
    });
    mockClient.mutate.mockImplementation(async () => {
      privateNoteCreated = true;
      return { createTicketNote: { noteId: "private-copy", privacyType: "PRIVATE" } };
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
  it("finds a matching private note across canonical note pages and does not create a duplicate", async () => {
    const events: string[] = [];
    mockClient.query.mockImplementation(async (query: string, variables?: { input?: Record<string, unknown> }) => {
      if (query.includes("getTicketList")) {
        events.push("ticket-list");
        return { getTicketList: { tickets: [{ ticketId: "ticket-57402", displayId: "57402" }],
          listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 } } };
      }
      if (query.includes("getTicketNoteList")) {
        events.push(`notes-page-${variables?.input?.page ?? 1}`);
        return variables?.input?.page === 2
          ? { getTicketNoteList: { notes: [{ noteId: "private-junk", content: "JUNK", privacyType: "PRIVATE" }], listInfo: { hasMore: false } } }
          : { getTicketNoteList: { notes: [{ noteId: "public-junk", content: "JUNK", privacyType: "PUBLIC" }], listInfo: { hasMore: true } } };
      }
      events.push("ticket");
      return { getTicket: { ticketId: "ticket-57402", displayId: "57402", status: "New Calls" } };
    });

    const result = await getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
      expectedCandidateTicketNumbers: ["57402"],
      actions: [{ ticketNumber: "57402", contentVerified: true, action: "addNote", note: " junk " }],
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.results[0]).toMatchObject({
      finalOutcome: "Updated",
      noteAdded: false,
      noteDeduped: true,
      noteDedupeChecked: true,
      verified: true,
    });
    expect(events).toEqual(["ticket-list", "ticket", "notes-page-1", "notes-page-2", "ticket"]);
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });

  it("blocks note creation when canonical note retrieval fails before an update", async () => {
    mockClient.query.mockImplementation(async (query: string) => {
      if (query.includes("getTicketList")) return { getTicketList: {
        tickets: [{ ticketId: "ticket-57403", displayId: "57403" }],
        listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 },
      } };
      if (query.includes("getFields")) return { getFields: RESOLVED_OPTION_FIELDS };
      if (query.includes("getTicketNoteList")) throw new Error("note read unavailable");
      return { getTicket: { ticketId: "ticket-57403", displayId: "57403", status: "New Calls" } };
    });

    const result = await getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
      expectedCandidateTicketNumbers: ["57403"],
      actions: [{
        ticketNumber: "57403",
        contentVerified: true,
        action: "update",
        note: "JUNK",
        target: { ...TRIAGE_TEST_CLASSIFICATION, status: "Awaiting Engineer" },
      }],
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.results[0]).toMatchObject({
      finalOutcome: "Failed",
      failureStage: "duplicateNoteCheck",
      writeAttempted: false,
      partialWrite: false,
    });
    expect(parsed.results[0].failureReason).toContain("note read unavailable");
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });
  function stagedResolveAction(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      ticketNumber: LIVE_RESOLVE_NO_CHANGE_DATAFETCHING_REGRESSION.ticketNumber,
      expectedTicketId: LIVE_RESOLVE_NO_CHANGE_DATAFETCHING_REGRESSION.ticketId,
      expectedStatus: "New Calls",
      expectedUpdatedTime: LIVE_RESOLVE_NO_CHANGE_DATAFETCHING_REGRESSION.originalUpdatedTime,
      contentVerified: true,
      action: "resolve",
      note: LIVE_RESOLVE_NO_CHANGE_DATAFETCHING_REGRESSION.note,
      target: LIVE_RESOLVE_NO_CHANGE_DATAFETCHING_REGRESSION.target,
      ...overrides,
    };
  }

  function installStagedResolveMocks(options: {
    note?: "missing" | "deduped" | "none" | "fail";
    classificationReject?: unknown;
    statusReject?: unknown;
    original?: Record<string, unknown>;
    classificationAfter?: Record<string, unknown>;
    preStatus?: Record<string, unknown>;
    final?: Record<string, unknown>;
  } = {}) {
    const original = {
      ticketId: LIVE_RESOLVE_NO_CHANGE_DATAFETCHING_REGRESSION.ticketId,
      displayId: LIVE_RESOLVE_NO_CHANGE_DATAFETCHING_REGRESSION.ticketNumber,
      status: "New Calls",
      client: null,
      updatedTime: LIVE_RESOLVE_NO_CHANGE_DATAFETCHING_REGRESSION.originalUpdatedTime,
      ...(options.original ?? {}),
    };
    const classified = {
      ...original,
      client: { accountId: LIVE_RESOLVE_NO_CHANGE_DATAFETCHING_REGRESSION.clientId, name: "TaskGroup" },
      impact: "Low",
      urgency: "Low",
      category: "7. Sales call",
      subcategory: "No Action Needed",
      cause: "Unknown",
      resolutionCode: "Permanent Fix",
      updatedTime: "2026-07-25T09:01:00Z",
      ...(options.classificationAfter ?? {}),
    };
    const preStatus = options.preStatus ?? classified;
    const final = options.final ?? { ...classified, status: "Resolved", updatedTime: "2026-07-25T09:02:00Z" };
    let ticketReads = 0;
    let privateNotePresent = options.note === "deduped";
    mockClient.query.mockImplementation(async (query: string) => {
      if (query.includes("getTicketList")) {
        return { getTicketList: { tickets: [{ ticketId: original.ticketId, displayId: original.displayId }],
          listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 } } };
      }
      if (query.includes("getFields")) return { getFields: RESOLVED_OPTION_FIELDS };
      if (query.includes("getTicketNoteList")) {
        return { getTicketNoteList: privateNotePresent
          ? [{ noteId: "note-junk", content: "JUNK", privacyType: "PRIVATE" }]
          : [] };
      }
      const reads = [original, classified, preStatus, final];
      return { getTicket: reads[Math.min(ticketReads++, reads.length - 1)] };
    });
    mockClient.mutate.mockImplementation(async (_mutation: string, variables: { input: Record<string, unknown> }) => {
      if (variables.input.ticket) {
        if (options.note === "fail") throw new Error("note write failed");
        privateNotePresent = true;
        return { createTicketNote: { noteId: "note-junk", privacyType: "PRIVATE" } };
      }
      if (variables.input.status === "Resolved") {
        if (options.statusReject) throw options.statusReject;
        return { updateTicket: { ticketId: original.ticketId, status: "Resolved" } };
      }
      if (options.classificationReject) throw options.classificationReject;
      return { updateTicket: { ticketId: original.ticketId } };
    });
    return { original, classified, final };
  }

  it("dedupes the exact live raw GraphQL private JUNK note proven by notes_list before status-only close", async () => {
    const events: string[] = [];
    const internalTicketId = LIVE_RESOLVE_NO_CHANGE_DATAFETCHING_REGRESSION.ticketId;
    const displayTicketId = LIVE_RESOLVE_NO_CHANGE_DATAFETCHING_REGRESSION.ticketNumber;
    let statusResolved = false;
    mockClient.query.mockImplementation(async (query: string, variables?: { input?: Record<string, unknown> }) => {
      if (query.includes("getTicketList")) {
        events.push("ticket-list");
        return { getTicketList: { tickets: [{ ticketId: internalTicketId, displayId: displayTicketId }],
          listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 } } };
      }
      if (query.includes("getFields")) {
        events.push("fields");
        return { getFields: RESOLVED_OPTION_FIELDS };
      }
      if (query.includes("getTicketNoteList")) {
        events.push(`notes:${variables?.input?.ticketId}`);
        if (variables?.input?.ticketId !== internalTicketId) {
          return { getTicketNoteList: [] };
        }
        return { getTicketNoteList: [{
          noteId: "8656361040688640000",
          addedBy: { userId: "158888810903851008", name: "Sam Godfrey" },
          addedOn: "2026-07-25T16:18:03.579",
          content: "<html>JUNK</html>",
          attachments: [],
          privacyType: "PRIVATE",
        }] };
      }
      events.push(`ticket:${variables?.input?.ticketId}`);
      return { getTicket: {
        ticketId: internalTicketId,
        displayId: displayTicketId,
        status: statusResolved ? "Resolved" : "New Calls",
        updatedTime: statusResolved
          ? "2026-07-25T17:46:38.390"
          : LIVE_RESOLVE_NO_CHANGE_DATAFETCHING_REGRESSION.originalUpdatedTime,
        client: {
          accountId: LIVE_RESOLVE_NO_CHANGE_DATAFETCHING_REGRESSION.clientId,
          name: LIVE_RESOLVE_NO_CHANGE_DATAFETCHING_REGRESSION.clientName,
        },
        impact: LIVE_RESOLVE_NO_CHANGE_DATAFETCHING_REGRESSION.target.impact,
        urgency: LIVE_RESOLVE_NO_CHANGE_DATAFETCHING_REGRESSION.target.urgency,
        category: LIVE_RESOLVE_NO_CHANGE_DATAFETCHING_REGRESSION.target.category,
        subcategory: LIVE_RESOLVE_NO_CHANGE_DATAFETCHING_REGRESSION.target.subcategory,
        cause: LIVE_RESOLVE_NO_CHANGE_DATAFETCHING_REGRESSION.target.cause,
        resolutionCode: LIVE_RESOLVE_NO_CHANGE_DATAFETCHING_REGRESSION.target.resolutionCode,
      } };
    });
    mockClient.mutate.mockImplementation(async (mutation: string, variables: { input: Record<string, unknown> }) => {
      expect(mutation).not.toContain("createTicketNote");
      expect(variables.input).toMatchObject({
        ticketId: internalTicketId,
        status: "Resolved",
        suppressCloseNotification: true,
      });
      statusResolved = true;
      events.push("status-write");
      return { updateTicket: { ticketId: internalTicketId, status: "Resolved" } };
    });

    const domain = getTicketsTools();
    const noteListByInternalId = await domain.handleCall(
      "superops_tickets_notes_list",
      { ticketId: internalTicketId }
    );
    expect(JSON.parse(noteListByInternalId.content[0].text)).toEqual([{
      noteId: "8656361040688640000",
      addedBy: { userId: "158888810903851008", name: "Sam Godfrey" },
      addedOn: "2026-07-25T16:18:03.579",
      content: "<html>JUNK</html>",
      attachments: [],
      privacyType: "PRIVATE",
    }]);
    const noteListByDisplayNumber = await domain.handleCall(
      "superops_tickets_notes_list",
      { ticketId: displayTicketId }
    );
    expect(JSON.parse(noteListByDisplayNumber.content[0].text)).toEqual([]);
    events.length = 0;

    const result = await domain.handleCall("superops_tickets_apply_triage_plan", {
      expectedCandidateTicketNumbers: [displayTicketId],
      actions: [{
        ticketNumber: displayTicketId,
        expectedStatus: "New Calls",
        expectedUpdatedTime: LIVE_RESOLVE_NO_CHANGE_DATAFETCHING_REGRESSION.originalUpdatedTime,
        contentVerified: true,
        action: "resolve",
        note: "JUNK",
        target: LIVE_RESOLVE_NO_CHANGE_DATAFETCHING_REGRESSION.target,
      }],
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.results[0]).toMatchObject({
      finalOutcome: "Resolved",
      workflowMode: "staged",
      classificationWriteOutcome: "NotRequired",
      noteAdded: false,
      noteDeduped: true,
      noteDedupeChecked: true,
      statusWriteOutcome: "Accepted",
      suppressCloseNotificationIncluded: true,
      verified: true,
    });
    expect(parsed.results[0].physicalWrites).toEqual([
      { method: "updateTicket.statusOnly", outcome: "Accepted" },
    ]);
    expect(mockClient.mutate).toHaveBeenCalledTimes(1);
    expect(events).toContain(`notes:${internalTicketId}`);
    expect(events).not.toContain(`notes:${displayTicketId}`);
  });
  it("staged junk resolve dry-run reports planned stages and zero writes", async () => {
    installStagedResolveMocks({ note: "missing" });
    const result = await getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
      batchId: DRY_RUN_NOTE_DEDUPE_REGRESSION.operationId,
      dryRun: true,
      expectedCandidateTicketNumbers: [LIVE_RESOLVE_NO_CHANGE_DATAFETCHING_REGRESSION.ticketNumber],
      actions: [stagedResolveAction()],
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(mockClient.mutate).not.toHaveBeenCalled();
    expect(parsed.results[0]).toMatchObject({
      finalOutcome: "Resolved",
      writeAttempted: false,
      writeMethod: "dryRun",
      workflowMode: "staged",
      plannedMutations: ["updateClassificationAndClient", "checkPrivateNote", "createPrivateNote", "updateStatusResolved"],
      noteDedupePlanned: true,
      noteDedupeChecked: false,
      suppressCloseNotificationRequested: true,
      suppressCloseNotificationIncluded: true,
      derivedReadOnlyState: null,
    });
  });

  it("resumes an exact generated operation payload by batchId", async () => {
    const operationId = "exact-generated-operation-recovery";
    const expectedCandidateTicketNumbers = ["59009", "59012"];

    await runWithOperationStore({}, async () => {
      await withSuccessfulContinuationScheduling(() =>
        runWithExecutionConfig(
          { SUPEROPS_EXECUTION_MAX_ITEMS_PER_BATCH: "1" },
          () => runWithExecutionContext(
            "superops_tickets_apply_triage_plan",
            () => getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
              expectedCandidateTicketNumbers,
              actions: [],
            }),
            operationId
          )
        )
      );

      const recovered = await runWithExecutionContext(
        "superops_tickets_apply_triage_plan",
        () => getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
          batchId: operationId,
          expectedCandidateTicketNumbers,
          actions: [],
        })
      );
      const recoveredParsed = JSON.parse(recovered.content[0].text);
      const terminal = await getOperationStore().get(operationId, currentOwnerHash());

      expect(recovered.isError).not.toBe(true);
      expect(recoveredParsed.operation).toMatchObject({
        operationId,
        complete: true,
        continuationRequired: false,
        state: "Completed",
        writeAttempted: false,
        writeMayHaveSucceeded: false,
      });
      expect(terminal).toMatchObject({
        state: "Completed",
        skippedItems: ["59009", "59012"],
        pendingItems: [],
      });
      expect(mockClient.query).not.toHaveBeenCalled();
      expect(mockClient.mutate).not.toHaveBeenCalled();
    });
  });

  it("resumes a stored approved operation from a compact batch envelope without replay", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-26T09:00:00.000Z"));
    const operationId = "legacy-generated-operation-recovery";
    const expectedCandidateTicketNumbers = ["59009", "59012"];
    const approvedActions = [
      { ticketNumber: "59009", contentVerified: false, action: "skip", reason: "Approved skip one." },
      { ticketNumber: "59012", contentVerified: false, action: "skip", reason: "Approved skip two." },
    ];
    const durable = ownerScopedDurableNamespaceForTickets();
    const ticketReads: string[] = [];
    mockClient.query.mockImplementation(async (
      query: string,
      variables?: { input?: { condition?: { value?: string }; ticketId?: string } }
    ) => {
      if (query.includes("getTicketList")) {
        const ticketNumber = String(variables?.input?.condition?.value ?? "");
        ticketReads.push(`list:${ticketNumber}`);
        return {
          getTicketList: {
            tickets: [{ ticketId: `ticket-${ticketNumber}`, displayId: ticketNumber }],
            listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 },
          },
        };
      }
      const ticketId = String(variables?.input?.ticketId ?? "");
      const ticketNumber = ticketId.replace(/^ticket-/, "");
      ticketReads.push(`ticket:${ticketNumber}`);
      return {
        getTicket: {
          ticketId,
          displayId: ticketNumber,
          status: "New Calls",
          updatedTime: "2026-07-26T09:00:00.000",
        },
      };
    });

    await runWithOperationStore({ SUPEROPS_OPERATION_LEDGER: durable.namespace }, async () => {
      const first = await withSuccessfulContinuationScheduling(() =>
        runWithExecutionConfig(
          { SUPEROPS_EXECUTION_MAX_ITEMS_PER_BATCH: "1" },
          () => runWithExecutionContext(
            "superops_tickets_apply_triage_plan",
            () => getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
              expectedCandidateTicketNumbers,
              actions: approvedActions,
            }),
            operationId
          )
        )
      );
      const firstParsed = JSON.parse(first.content[0].text);
      const afterFirst = await getOperationStore().get(operationId, currentOwnerHash());

      expect(firstParsed.operation).toMatchObject({
        operationId,
        complete: false,
        continuationRequired: true,
        state: "ContinuationRequired",
      });
      expect(afterFirst).toMatchObject({
        operationId,
        state: "ContinuationRequired",
        completedItems: [],
        skippedItems: ["59009"],
        pendingItems: ["59012"],
        itemStates: {
          "59009": { stage: "Skipped", writeAttempted: false },
          "59012": { stage: "Unattempted", writeAttempted: false },
        },
      });

      const changedCandidateSet = await runWithExecutionContext(
        "superops_tickets_apply_triage_plan",
        () => getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
          batchId: operationId,
          expectedCandidateTicketNumbers: [...expectedCandidateTicketNumbers].reverse(),
        })
      );
      expect(changedCandidateSet.isError).toBe(true);
      expect(changedCandidateSet.content[0].text).toContain(
        "already exists with different ownership or approved input"
      );
      await expect(getOperationStore().get(operationId, currentOwnerHash())).resolves.toMatchObject({
        state: "ContinuationRequired",
        pendingItems: ["59012"],
      });

      const changedFlags = await runWithExecutionContext(
        "superops_tickets_apply_triage_plan",
        () => getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
          batchId: operationId,
          expectedCandidateTicketNumbers,
          verify: true,
        })
      );
      expect(changedFlags.isError).toBe(true);
      expect(changedFlags.content[0].text).toContain(
        "already exists with different ownership or approved input"
      );

      vi.setSystemTime(new Date("2026-07-26T09:03:00.000Z"));
      const recovered = await runWithExecutionContext(
        "superops_tickets_apply_triage_plan",
        () => getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
          batchId: operationId,
          expectedCandidateTicketNumbers,
        })
      );
      const recoveredParsed = JSON.parse(recovered.content[0].text);
      const terminal = await getOperationStore().get(operationId, currentOwnerHash());

      expect(recovered.isError).not.toBe(true);
      expect(recoveredParsed.operation).toMatchObject({
        operationId,
        complete: true,
        continuationRequired: false,
        state: "Completed",
        writeAttempted: false,
        writeMayHaveSucceeded: false,
      });
      expect(terminal).toMatchObject({
        state: "Completed",
        skippedItems: ["59009", "59012"],
        pendingItems: [],
        itemStates: {
          "59009": { stage: "Skipped", retryCount: 0, writeAttempted: false },
          "59012": { stage: "Skipped", retryCount: 0, writeAttempted: false },
        },
      });
      expect(ticketReads).toEqual([
        "list:59009",
        "ticket:59009",
        "list:59012",
        "ticket:59012",
      ]);
      expect(mockClient.mutate).not.toHaveBeenCalled();

    });
  });

  it("staged resolve persists preflight before already-correct classification and only closes status", async () => {
    const checkpointStages: string[] = [];

    await runWithOperationStore({}, async () => {
      const store = getOperationStore();
      const checkpointItem = store.checkpointItem.bind(store);
      store.checkpointItem = vi.fn(async (params) => {
        if (params.itemKey === LIVE_RESOLVE_NO_CHANGE_DATAFETCHING_REGRESSION.ticketNumber) {
          checkpointStages.push(String(params.patch.stage));
        }
        return checkpointItem(params);
      });
      installStagedResolveMocks({
        note: "deduped",
        original: {
          client: {
            accountId: LIVE_RESOLVE_NO_CHANGE_DATAFETCHING_REGRESSION.clientId,
            name: LIVE_RESOLVE_NO_CHANGE_DATAFETCHING_REGRESSION.clientName,
          },
          impact: "Low",
          urgency: "Low",
          category: "7. Sales call",
          subcategory: "No Action Needed",
          cause: "Unknown",
          resolutionCode: "Permanent Fix",
        },
      });

      const result = await withSuccessfulContinuationScheduling(() => runWithExecutionContext(
        "superops_tickets_apply_triage_plan",
        () => getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
          batchId: "staged-noop-classification-59005",
          expectedCandidateTicketNumbers: [LIVE_RESOLVE_NO_CHANGE_DATAFETCHING_REGRESSION.ticketNumber],
          actions: [stagedResolveAction()],
        })
      ));
      const parsed = JSON.parse(result.content[0].text);
      const stored = await store.get("staged-noop-classification-59005", currentOwnerHash());

      expect(result.isError).not.toBe(true);
      expect(checkpointStages).toEqual([
        "PreflightValidated",
        "ClassificationVerified",
        "NoteDedupeChecked",
        "NoteVerified",
        "StatusWriteStarted",
        "StatusWriteSucceeded",
        "StatusVerified",
      ]);
      expect(mockClient.mutate).toHaveBeenCalledTimes(1);
      expect(mockClient.mutate.mock.calls[0][1].input).toEqual({
        ticketId: LIVE_RESOLVE_NO_CHANGE_DATAFETCHING_REGRESSION.ticketId,
        status: "Resolved",
        suppressCloseNotification: true,
      });
      expect(parsed.results[0]).toMatchObject({
        finalOutcome: "Resolved",
        workflowMode: "staged",
        classificationWriteMethod: "updateTicket.classification",
        classificationWriteOutcome: "NotRequired",
        noteDeduped: true,
        noteAdded: false,
        noteWriteOutcome: "VerifiedExistingPrivateNote",
        statusWriteOutcome: "Accepted",
        suppressCloseNotificationIncluded: true,
        writeAttempted: true,
        verified: true,
      });
      expect(parsed.results[0].physicalWrites).toEqual([
        { method: "updateTicket.statusOnly", outcome: "Accepted" },
      ]);
      expect(stored?.itemStates[LIVE_RESOLVE_NO_CHANGE_DATAFETCHING_REGRESSION.ticketNumber]).toMatchObject({
        stage: "Completed",
        outcome: "Resolved",
        writeAttempted: true,
        writeMayHaveSucceeded: true,
        partialWrite: false,
        verificationState: "Verified",
      });
      expect(operationResultView(stored!).results).toEqual(parsed.results);

      vi.clearAllMocks();
      await runWithExecutionContext("superops_tickets_apply_triage_plan", () =>
        resumeApplyTriageOperation({
          operationId: "staged-noop-classification-59005",
          ownerHash: stored!.ownerHash,
          leaseOwner: "noop-classification-replay-check",
        })
      );
      expect(mockClient.mutate).not.toHaveBeenCalled();
    });
  });
  it("terminalizes a no-write staged classification checkpoint failure before any write", async () => {
    await runWithOperationStore({}, async () => {
      const store = getOperationStore();
      const checkpointItem = store.checkpointItem.bind(store);
      store.checkpointItem = vi.fn(async (params) => {
        if (params.patch.stage === "PreflightValidated") {
          throw new Error("PreflightValidated persistence failed");
        }
        return checkpointItem(params);
      });
      installStagedResolveMocks({
        note: "deduped",
        original: {
          client: {
            accountId: LIVE_RESOLVE_NO_CHANGE_DATAFETCHING_REGRESSION.clientId,
            name: LIVE_RESOLVE_NO_CHANGE_DATAFETCHING_REGRESSION.clientName,
          },
          impact: "Low",
          urgency: "Low",
          category: "7. Sales call",
          subcategory: "No Action Needed",
          cause: "Unknown",
          resolutionCode: "Permanent Fix",
        },
      });

      const result = await withSuccessfulContinuationScheduling(() => runWithExecutionContext(
        "superops_tickets_apply_triage_plan",
        () => getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
          batchId: "staged-noop-classification-preflight-store-failure",
          expectedCandidateTicketNumbers: [LIVE_RESOLVE_NO_CHANGE_DATAFETCHING_REGRESSION.ticketNumber],
          actions: [stagedResolveAction()],
        })
      ));
      const parsed = JSON.parse(result.content[0].text);
      const stored = await store.get("staged-noop-classification-preflight-store-failure", currentOwnerHash());

      expect(result.isError).toBe(true);
      expect(parsed.operation).toMatchObject({
        complete: true,
        continuationRequired: false,
        persisted: true,
        state: "CompletedWithFailures",
        errorClass: "OperationStoreFailure",
        writeAttempted: false,
        writeMayHaveSucceeded: false,
        partialWrite: false,
      });
      expect(parsed.operation.finalReason).toContain("fresh operation");
      expect(stored).toMatchObject({
        state: "CompletedWithFailures",
        pendingItems: [],
        unattemptedItems: [],
        itemStates: {
          [LIVE_RESOLVE_NO_CHANGE_DATAFETCHING_REGRESSION.ticketNumber]: {
            stage: "FailedBeforeWrite",
            outcome: "OperationStoreFailed",
            errorClass: "OperationStoreFailure",
            writeAttempted: false,
            writeMayHaveSucceeded: false,
            partialWrite: false,
          },
        },
      });
      expect(stored?.terminalFailureReason).toContain("fresh operation");
      expect(mockClient.mutate).not.toHaveBeenCalled();
    });
  });
  it("staged resolve sends classification/client without status, priority or suppression, then status-only suppressed close", async () => {
    installStagedResolveMocks({ note: "none" });
    const result = await getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
      expectedCandidateTicketNumbers: [LIVE_RESOLVE_NO_CHANGE_DATAFETCHING_REGRESSION.ticketNumber],
      actions: [stagedResolveAction({ note: undefined })],
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(result.isError).not.toBe(true);
    expect(mockClient.mutate).toHaveBeenCalledTimes(2);
    expect(mockClient.mutate.mock.calls[0][1].input).toEqual({
      ticketId: LIVE_RESOLVE_NO_CHANGE_DATAFETCHING_REGRESSION.ticketId,
      impact: "Low",
      urgency: "Low",
      category: "7. Sales call",
      subcategory: "No Action Needed",
      cause: "Unknown",
      resolutionCode: "Permanent Fix",
      client: { accountId: LIVE_RESOLVE_NO_CHANGE_DATAFETCHING_REGRESSION.clientId },
    });
    expect(mockClient.mutate.mock.calls[1][1].input).toEqual({
      ticketId: LIVE_RESOLVE_NO_CHANGE_DATAFETCHING_REGRESSION.ticketId,
      status: "Resolved",
      suppressCloseNotification: true,
    });
    expect(parsed.results[0]).toMatchObject({
      finalOutcome: "Resolved",
      workflowMode: "staged",
      classificationWriteOutcome: "Accepted",
      statusWriteOutcome: "Accepted",
      suppressCloseNotificationIncluded: true,
      verified: true,
      partialWrite: false,
    });
  });

  it("staged resolve deduplicates or creates the approved private note before status", async () => {
    installStagedResolveMocks({ note: "missing" });
    const result = await getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
      expectedCandidateTicketNumbers: [LIVE_RESOLVE_NO_CHANGE_DATAFETCHING_REGRESSION.ticketNumber],
      actions: [stagedResolveAction()],
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(mockClient.mutate).toHaveBeenCalledTimes(3);
    expect(mockClient.mutate.mock.calls[1][1].input).toEqual({
      ticket: { ticketId: LIVE_RESOLVE_NO_CHANGE_DATAFETCHING_REGRESSION.ticketId },
      content: "JUNK",
      privacyType: "PRIVATE",
    });
    expect(mockClient.mutate.mock.calls[2][1].input).toMatchObject({ status: "Resolved", suppressCloseNotification: true });
    expect(parsed.results[0]).toMatchObject({ finalOutcome: "Resolved", noteAdded: true, noteDeduped: false, verified: true });
  });

  it("staged resolve stops before note and status on classification mismatch", async () => {
    installStagedResolveMocks({ classificationAfter: { impact: "High" } });
    const result = await getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
      expectedCandidateTicketNumbers: [LIVE_RESOLVE_NO_CHANGE_DATAFETCHING_REGRESSION.ticketNumber],
      actions: [stagedResolveAction()],
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(mockClient.mutate).toHaveBeenCalledTimes(1);
    expect(parsed.results[0]).toMatchObject({
      finalOutcome: "Failed",
      failureStage: "classificationVerification",
      terminalReason: "ClassificationVerificationMismatch",
      noteAdded: false,

    });
  });

  it.each(LIVE_RESOLVE_NO_CHANGE_DATAFETCHING_REGRESSION.operationIds)(
    "defers live no-change DataFetchingException operation %s for bounded recovery evidence",
    async (operationId) => {
      const graphQLError = new SuperOpsError(
        "SuperOps internal server error with token secret-token and customer@example.com",
        "INTERNAL_SERVER_ERROR",
        undefined,
        {
          code: "INTERNAL_SERVER_ERROR",
          classification: "DataFetchingException",
          headers: { authorization: "Bearer secret-token" },
          responseBody: "sensitive body",
          customerEmail: "customer@example.com",
          exception: { stacktrace: ["sensitive stack"] },
        },
        { httpStatus: 200, path: ["updateTicket"], graphQLDataPresent: false, mutationPayloadReturned: false }
      );
      installStagedResolveMocks({ classificationReject: graphQLError, classificationAfter: {
        client: null,
        impact: undefined,
        urgency: undefined,
        category: undefined,
        subcategory: undefined,
        cause: undefined,
        resolutionCode: undefined,
        updatedTime: LIVE_RESOLVE_NO_CHANGE_DATAFETCHING_REGRESSION.originalUpdatedTime,
      } });
      const result = await getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
        batchId: operationId,
        allowResolveFullFallbackToUpdate: true,
        expectedCandidateTicketNumbers: [LIVE_RESOLVE_NO_CHANGE_DATAFETCHING_REGRESSION.ticketNumber],
        actions: [stagedResolveAction()],
      });
      const parsed = JSON.parse(result.content[0].text);
      const stored = await getOperationStore().get(operationId);
      if (!stored) throw new Error("missing no-change regression operation");
      expect(mockClient.mutate).toHaveBeenCalledTimes(1);
      expect(mockClient.mutate.mock.calls[0][1].input).not.toHaveProperty("status");
      expect(mockClient.mutate.mock.calls[0][1].input).not.toHaveProperty("priority");
      expect(parsed.results[0]).toMatchObject({
        finalOutcome: "Failed",
        writeMethod: "staged",
        primaryWriteMethod: "updateTicket.classification",
        primaryGraphqlClassification: "DataFetchingException",
        primaryGraphqlCode: "INTERNAL_SERVER_ERROR",
        primaryGraphqlPath: ["updateTicket"],
        primaryResponseHadData: false,
        primarySynchronousFailure: true,
        initialFailure: expect.objectContaining({ errorClass: "DataFetchingException" }),
        updatedTimeChanged: false,
        noChangeObserved: true,
        noteAdded: false,
        fallbackAttempted: false,
        terminalReason: "AmbiguousWritePending",
        reconciliationDisposition: "AmbiguousUnresolved",
        partialWrite: false,
        continuationRequired: true,
      });
      expect(JSON.stringify(parsed.results[0])).not.toContain("secret-token");
      expect(JSON.stringify(parsed.results[0])).not.toContain("customer@example.com");
      expect(operationResultView(stored).results).toEqual(parsed.results);
      vi.clearAllMocks();
      await resumeApplyTriageOperation({ operationId, ownerHash: stored.ownerHash, leaseOwner: "no-change-regression-worker" });
      expect(mockClient.mutate).not.toHaveBeenCalled();
    }
  );

  it("keeps a transport timeout ambiguous when classification verification reads no change", async () => {
    const timeout = new Error("network response lost after classification update");
    timeout.name = "SuperOpsTimeoutError";
    installStagedResolveMocks({ classificationReject: timeout, classificationAfter: {
      client: null,
      impact: undefined,
      urgency: undefined,
      category: undefined,
      subcategory: undefined,
      cause: undefined,
      resolutionCode: undefined,
      updatedTime: LIVE_RESOLVE_NO_CHANGE_DATAFETCHING_REGRESSION.originalUpdatedTime,
    } });
    const result = await getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
      expectedCandidateTicketNumbers: [LIVE_RESOLVE_NO_CHANGE_DATAFETCHING_REGRESSION.ticketNumber],
      actions: [stagedResolveAction({ note: undefined })],
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(mockClient.mutate).toHaveBeenCalledTimes(1);
    expect(parsed.results[0]).toMatchObject({
      finalOutcome: "Failed",
      failureStage: "ambiguousWrite",
      terminalReason: "AmbiguousWritePending",
      reconciliationDisposition: "AmbiguousUnresolved",
      writeAttempted: true,
      writeMayHaveSucceeded: true,
      partialWrite: false,
      noteAdded: false,
      continuationRequired: true,
    });
  });

  it("keeps fields appearing after a classification error as a partial write", async () => {
    installStagedResolveMocks({ classificationReject: new SuperOpsError(
      "SuperOps internal server error",
      "INTERNAL_SERVER_ERROR",
      undefined,
      { code: "INTERNAL_SERVER_ERROR", classification: "DataFetchingException" },
      { httpStatus: 200, path: ["updateTicket"], graphQLDataPresent: false, mutationPayloadReturned: false }
    ) });
    const result = await getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
      expectedCandidateTicketNumbers: [LIVE_RESOLVE_NO_CHANGE_DATAFETCHING_REGRESSION.ticketNumber],
      actions: [stagedResolveAction({ note: undefined })],
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(mockClient.mutate).toHaveBeenCalledTimes(1);
    expect(parsed.results[0]).toMatchObject({
      finalOutcome: "Failed",
      terminalReason: "AmbiguousWritePending",
      reconciliationDisposition: "ConfirmedPartialWrite",
      partialWrite: true,
      noteAdded: false,
      continuationRequired: true,
      observedRequestedEffects: expect.arrayContaining(["impact"]),
    });
  });

  it("staged resolve stops before status when note creation remains ambiguous", async () => {
    installStagedResolveMocks({ note: "fail" });
    const result = await getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
      expectedCandidateTicketNumbers: [LIVE_RESOLVE_NO_CHANGE_DATAFETCHING_REGRESSION.ticketNumber],
      actions: [stagedResolveAction()],
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(mockClient.mutate).toHaveBeenCalledTimes(2);
    expect(parsed.results[0]).toMatchObject({
      finalOutcome: "Failed",
      failureStage: "ambiguousWrite",

      noteAdded: false,
    });
    expect(mockClient.mutate.mock.calls.some(([, variables]) => variables.input.status === "Resolved")).toBe(false);
  });

  it("staged resolve verifies ambiguous status without replaying it", async () => {
    installStagedResolveMocks({ note: "none", statusReject: new Error("lost status response") });
    const result = await getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
      expectedCandidateTicketNumbers: [LIVE_RESOLVE_NO_CHANGE_DATAFETCHING_REGRESSION.ticketNumber],
      actions: [stagedResolveAction({ note: undefined })],
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(mockClient.mutate).toHaveBeenCalledTimes(2);
    expect(parsed.results[0]).toMatchObject({
      finalOutcome: "Resolved",
      statusWriteOutcome: "Ambiguous",
      verified: true,
      partialWrite: false,
    });
  });

  it("staged resolve blocks unrelated concurrent changes before status", async () => {
    installStagedResolveMocks({ note: "none", preStatus: { status: "Awaiting Engineer" } });
    const result = await getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
      expectedCandidateTicketNumbers: [LIVE_RESOLVE_NO_CHANGE_DATAFETCHING_REGRESSION.ticketNumber],
      actions: [stagedResolveAction({ note: undefined })],
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(mockClient.mutate).toHaveBeenCalledTimes(1);
    expect(parsed.results[0]).toMatchObject({
      finalOutcome: "Failed",
      failureStage: "concurrencyRecheck",
      terminalReason: "ConcurrentModificationDetected",
    });
  });

  it("staged resolve rejects public notes before any write", async () => {
    installStagedResolveMocks({ note: "none" });
    const result = await getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
      expectedCandidateTicketNumbers: [LIVE_RESOLVE_NO_CHANGE_DATAFETCHING_REGRESSION.ticketNumber],
      actions: [stagedResolveAction({ isPublicNote: true })],
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.results[0]).toMatchObject({ finalOutcome: "Blocked", failureStage: "notePrivacy", writeAttempted: false });
    expect(mockClient.mutate).not.toHaveBeenCalled();
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
          target: { ...TRIAGE_TEST_CLASSIFICATION, status: "Awaiting Engineer" },
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
      action: { ticketNumber: "57400", contentVerified: true, action: "update", target: { ...TRIAGE_TEST_CLASSIFICATION, status: "Awaiting Engineer" } },
      queries: [
        { getTicketList: { tickets: [{ ticketId: "ticket-57400", displayId: "57400" }], listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 } } },
        { getTicket: { ticketId: "ticket-57400", displayId: "57400", status: "New Calls" } },
        { getFields: RESOLVED_OPTION_FIELDS },
        { getTicket: { ticketId: "ticket-57400", displayId: "57400", status: "Awaiting Engineer", ...TRIAGE_TEST_CLASSIFICATION } },
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
      })
      .mockResolvedValueOnce({ getFields: RESOLVED_OPTION_FIELDS });
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
            contentVerified: true, action: "update", target: { ...TRIAGE_TEST_CLASSIFICATION, status: "Awaiting Engineer" },
          }],
        })
      );
      const parsed = JSON.parse(result.content[0].text);
      const stored = await store.get("checkpoint-failure-before-first-write");
      expect(result.isError).toBe(true);
      expect(parsed.operation).toMatchObject({
        complete: true,
        continuationRequired: false,
        state: "CompletedWithFailures",
        errorClass: "OperationStoreFailure",
        writeAttempted: false,
        writeMayHaveSucceeded: false,
      });
      expect(parsed.operation.finalReason).toContain("fresh operation");
      expect(stored).toMatchObject({
        state: "CompletedWithFailures",
        pendingItems: [],
        unattemptedItems: [],
      });
      expect(stored?.itemStates["57400"]).toMatchObject({
        stage: "FailedBeforeWrite",
        outcome: "OperationStoreFailed",
        errorClass: "OperationStoreFailure",
        writeAttempted: false,
        writeMayHaveSucceeded: false,
        partialWrite: false,
      });
      expect(mockClient.mutate).not.toHaveBeenCalled();
    });
  });

  it("terminalizes a persistent operation-store rate limit before PreflightValidated without scheduling continuation", async () => {
    mockClient.query
      .mockResolvedValueOnce({
        getTicketList: { tickets: [{ ticketId: "ticket-57400", displayId: "57400" }],
          listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 } },
      })
      .mockResolvedValueOnce({
        getTicket: { ticketId: "ticket-57400", displayId: "57400", status: "New Calls" },
      })
      .mockResolvedValueOnce({ getFields: RESOLVED_OPTION_FIELDS });

    await runWithOperationStore({}, async () => {
      const store = getOperationStore();
      const checkpoint = store.checkpointItem.bind(store);
      store.checkpointItem = async (params) => {
        if (params.patch.stage === "PreflightValidated") throw new Error("rate_limit_exceeded");
        return checkpoint(params);
      };
      let serviceBindingDeliveries = 0;
      const result = await runWithContinuationScheduler({
        SUPEROPS_CONTINUATION_ENABLED: "true",
        SUPEROPS_DURABLE_RETRY_ENABLED: "true",
        SUPEROPS_INTERNAL_CONTINUATION_TOKEN: "test-internal-token",
        SUPEROPS_CONTINUATION_SERVICE: {
          fetch: async () => {
            serviceBindingDeliveries += 1;
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          },
        },
      }, () => getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
        batchId: "preflight-store-rate-limit-terminal",
        expectedCandidateTicketNumbers: ["57400"],
        actions: [{
          ticketNumber: "57400",
          expectedStatus: "New Calls",
          contentVerified: true,
          action: "resolve",
          target: { status: "Resolved", ...RESOLVED_CLASSIFICATION },
        }],
      }));
      const parsed = JSON.parse(result.content[0].text);
      const stored = await store.get("preflight-store-rate-limit-terminal");

      expect(result.isError).toBe(true);
      expect(serviceBindingDeliveries).toBe(0);
      expect(mockClient.mutate).not.toHaveBeenCalled();
      expect(parsed.operation).toMatchObject({
        complete: true,
        continuationRequired: false,
        state: "CompletedWithFailures",
        errorClass: "OperationStoreFailure",
        writeAttempted: false,
        writeMayHaveSucceeded: false,
      });
      expect(parsed.operation.finalReason).toContain("fresh operation");
      expect(parsed.operation.continuationScheduling).toBeUndefined();
      expect(stored?.itemStates["57400"]).toMatchObject({
        stage: "FailedBeforeWrite",
        errorClass: "OperationStoreFailure",
        writeAttempted: false,
        writeMayHaveSucceeded: false,
        partialWrite: false,
      });
    });
  });
  it("counts two legitimate sequential durable mutation attempts", async () => {
    await runWithOperationStore({}, async () => {
      let getTicketReads = 0;
      let noteCreated = false;
      mockClient.query.mockImplementation(async (query: string) => {
        if (query.includes("getTicketList")) {
          return { getTicketList: { tickets: [{ ticketId: "ticket-57400", displayId: "57400" }],
            listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 } } };
        }
        if (query.includes("getFields")) return { getFields: RESOLVED_OPTION_FIELDS };
        if (query.includes("getTicketNoteList")) return { getTicketNoteList: noteCreated
          ? [{ noteId: "note-57400", content: "Approved private follow-up", privacyType: "PRIVATE" }]
          : [] };
        getTicketReads += 1;
        return { getTicket: { ticketId: "ticket-57400", displayId: "57400",
          status: getTicketReads === 1 ? "New Calls" : "Awaiting Engineer",
          updatedTime: getTicketReads === 1 ? "2026-07-18T10:00:00Z" : "2026-07-18T10:01:00Z",
          ...(getTicketReads === 1 ? {} : TRIAGE_TEST_CLASSIFICATION) } };
      });
      mockClient.mutate
        .mockResolvedValueOnce({ updateTicket: { ticketId: "ticket-57400", status: "Awaiting Engineer" } })
        .mockImplementationOnce(async () => {
          noteCreated = true;
          return { createTicketNote: { noteId: "note-57400", privacyType: "PRIVATE" } };
        });

      const result = await getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
        batchId: "sequential-attempt-count",
        expectedCandidateTicketNumbers: ["57400"],
        actions: [{
          ticketNumber: "57400",
          expectedStatus: "New Calls",
          expectedUpdatedTime: "2026-07-18T10:00:00Z",
          contentVerified: true,
          action: "update",
          target: { ...TRIAGE_TEST_CLASSIFICATION, status: "Awaiting Engineer" },
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
        .mockResolvedValueOnce({ getFields: RESOLVED_OPTION_FIELDS })
        .mockResolvedValueOnce({
          getTicket: {
            ticketId: "ticket-57400",
            displayId: "57400",
            status: "Awaiting Engineer",
            updatedTime: "2026-07-18T10:01:00Z",
            ...TRIAGE_TEST_CLASSIFICATION,
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
              target: { ...TRIAGE_TEST_CLASSIFICATION, status: "Awaiting Engineer" },
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
      expect(mockClient.mutate.mock.calls[0][1].input).toEqual({
        ticketId: "ticket-57400",
        ...TRIAGE_TEST_CLASSIFICATION,
        status: "Awaiting Engineer",
      });
      expect(mockClient.mutate.mock.calls[0][1].input).not.toHaveProperty("cause");
      expect(mockClient.mutate.mock.calls[0][1].input).not.toHaveProperty("resolutionCode");
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
              target: { ...TRIAGE_TEST_CLASSIFICATION, status: "Awaiting Engineer" },
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
      .mockResolvedValueOnce({ getFields: RESOLVED_OPTION_FIELDS })
      .mockResolvedValueOnce({
        getTicket: {
          ticketId: "ticket-57401",
          displayId: "57401",
          status: "Awaiting Engineer",
          updatedTime: "2026-07-18T10:01:00Z",
          ...TRIAGE_TEST_CLASSIFICATION,
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
        reasonCode: "schedulerContextMissing",
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
          failureReason: "Continuation scheduling unavailable: scheduler context was not installed.",
        },
      },
    });
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "disabled flag",
      env: {
        SUPEROPS_CONTINUATION_ENABLED: "false",
        SUPEROPS_DURABLE_RETRY_ENABLED: "true",
        SUPEROPS_INTERNAL_CONTINUATION_TOKEN: "test-internal-token",
        SUPEROPS_CONTINUATION_SERVICE: {
          fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
        },
      },
      reasonCode: "continuationFeatureDisabled",
      reason: "Continuation scheduling disabled: SUPEROPS_CONTINUATION_ENABLED is not true.",
    },
    {
      name: "missing service binding",
      env: {
        SUPEROPS_CONTINUATION_ENABLED: "true",
        SUPEROPS_DURABLE_RETRY_ENABLED: "true",
        SUPEROPS_INTERNAL_CONTINUATION_TOKEN: "test-internal-token",
      },
      reasonCode: "serviceBindingMissing",
      reason: "Continuation scheduling unavailable: SUPEROPS_CONTINUATION_SERVICE binding is missing.",
    },
  ])("reports precise immediate scheduling diagnostics for $name", async ({ env, reasonCode, reason }) => {
    const result = await runWithContinuationScheduler(env, () => runWithExecutionConfig(
      { SUPEROPS_EXECUTION_MAX_ITEMS_PER_BATCH: "1" },
      () => getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
        batchId: `precise-scheduling-${reasonCode}`,
        expectedCandidateTicketNumbers: ["57400", "57401"],
        actions: [],
      })
    ));
    const parsed = JSON.parse(result.content[0].text);
    const stored = await getOperationStore().get(`precise-scheduling-${reasonCode}`);

    expect(parsed.operation.continuationScheduling).toMatchObject({
      attempted: true,
      scheduled: false,
      terminalized: true,
      reasonCode,
      error: reason,
      diagnostics: {
        code: reasonCode,
        internalTokenPresent: true,
      },
    });
    expect(stored).toMatchObject({
      state: "CompletedWithFailures",
      terminalFailureReason: reason,
      schedulingError: reason,
    });
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
              target: { ...TRIAGE_TEST_CLASSIFICATION, status: "Awaiting Engineer" },
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
          target: { ...TRIAGE_TEST_CLASSIFICATION, status: "Awaiting Engineer", category: "Not a SuperOps category" },
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
              target: { ...TRIAGE_TEST_CLASSIFICATION, status: "Awaiting Engineer" },
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
          ...TRIAGE_TEST_CLASSIFICATION,
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

  it("verifies an ambiguous write before mutating later pending tickets", async () => {
    const domain = getTicketsTools();
    const initial = await withSuccessfulContinuationScheduling(() => runWithExecutionConfig(
      { SUPEROPS_EXECUTION_MAX_ITEMS_PER_BATCH: "1" },
      () =>
        domain.handleCall("superops_tickets_apply_triage_plan", {
          batchId: "ambiguous-before-later-ticket",
          expectedCandidateTicketNumbers: ["57400", "57401", "57402"],
          actions: [
            {
              ticketNumber: "57401",
              expectedUpdatedTime: "2026-07-18T10:00:00Z",
              contentVerified: true,
              action: "update",
              target: { ...TRIAGE_TEST_CLASSIFICATION, status: "Awaiting Engineer" },
            },
            {
              ticketNumber: "57402",
              expectedUpdatedTime: "2026-07-18T10:00:00Z",
              contentVerified: true,
              action: "update",
              target: { ...TRIAGE_TEST_CLASSIFICATION, status: "Awaiting Engineer" },
            },
          ],
        })
    ));
    const operationId = JSON.parse(initial.content[0].text).operation.operationId;
    const stored = await getOperationStore().get(operationId);
    if (!stored) throw new Error("missing operation");
    expect(stored.pendingItems).toEqual(["57401", "57402"]);
    stored.itemStates["57401"] = {
      ...stored.itemStates["57401"],
      stage: "WriteStarted",
      writeAttempted: true,
      writeMayHaveSucceeded: true,
      partialWrite: true,
      verificationState: "Pending",
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
          ...TRIAGE_TEST_CLASSIFICATION,
        },
      })
      .mockResolvedValueOnce({
        getTicketList: {
          tickets: [{ ticketId: "ticket-57402", displayId: "57402" }],
          listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 },
        },
      })
      .mockResolvedValueOnce({
        getTicket: {
          ticketId: "ticket-57402",
          displayId: "57402",
          status: "New Calls",
          updatedTime: "2026-07-18T10:00:00Z",
        },
      })
      .mockResolvedValueOnce({ getFields: RESOLVED_OPTION_FIELDS })
      .mockResolvedValueOnce({
        getTicket: {
          ticketId: "ticket-57402",
          displayId: "57402",
          status: "Awaiting Engineer",
          updatedTime: "2026-07-18T10:01:00Z",
          ...TRIAGE_TEST_CLASSIFICATION,
        },
      });
    mockClient.mutate.mockResolvedValueOnce({
      updateTicket: { ticketId: "ticket-57402", status: "Awaiting Engineer" },
    });

    await runWithExecutionConfig({}, async () => {
      await runWithExecutionContext("superops_tickets_apply_triage_plan", async () => {
        const resumed = await resumeApplyTriageOperation({
          operationId,
          ownerHash: stored.ownerHash,
          leaseOwner: "test-ambiguous-before-later",
        });
        expect(resumed.state).toBe("Completed");
      });
    });

    const finalRecord = await getOperationStore().get(operationId);
    expect(finalRecord?.itemStates["57401"]).toMatchObject({
      stage: "CompletedAfterAmbiguousWriteVerification",
      outcome: "Updated",
      writeAttempted: true,
      verificationState: "Verified",
    });
    expect(finalRecord?.itemStates["57402"]).toMatchObject({
      stage: "Completed",
      outcome: "Updated",
      writeAttempted: true,
      verificationState: "Verified",
    });
    expect(mockClient.mutate).toHaveBeenCalledTimes(1);
    expect(mockClient.query.mock.invocationCallOrder[1]).toBeLessThan(
      mockClient.mutate.mock.invocationCallOrder[0]
    );
  });

  it("does not repeat an ambiguous resolution when the requested target is already applied", async () => {
    const domain = getTicketsTools();
    const initial = await withSuccessfulContinuationScheduling(() => runWithExecutionConfig(
      { SUPEROPS_EXECUTION_MAX_ITEMS_PER_BATCH: "1" },
      () => domain.handleCall("superops_tickets_apply_triage_plan", {
        expectedCandidateTicketNumbers: ["57400", "57401"],
        actions: [{
          ticketNumber: "57401", expectedUpdatedTime: "2026-07-18T10:00:00Z",
          contentVerified: true, action: "resolve", target: { status: "Resolved", ...TRIAGE_TEST_RESOLUTION_CLASSIFICATION },
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
          updatedTime: "2026-07-18T10:01:00Z", ...TRIAGE_TEST_RESOLUTION_CLASSIFICATION },
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

  it("does not replay resolve_full or status-only fallback after a fallback-start checkpoint", async () => {
    const domain = getTicketsTools();
    await withSuccessfulContinuationScheduling(() => runWithExecutionConfig(
      { SUPEROPS_EXECUTION_MAX_ITEMS_PER_BATCH: "1" },
      () => domain.handleCall("superops_tickets_apply_triage_plan", {
        batchId: "status-only-fallback-no-replay",
        allowResolveFullFallbackToUpdate: true,
        expectedCandidateTicketNumbers: ["57400", "57401"],
        actions: [{
          ticketNumber: "57401", expectedStatus: "New Calls", expectedUpdatedTime: "2026-07-24T09:00:00Z",
          contentVerified: true, action: "resolve", target: LIVE_PARTIAL_RESOLVE_STATUS_MISSING_REGRESSION.target,
        }],
      })
    ));
    const stored = await getOperationStore().get("status-only-fallback-no-replay");
    if (!stored) throw new Error("missing fallback no-replay operation");
    stored.itemStates["57401"] = {
      ...stored.itemStates["57401"],
      stage: "ResolutionWriteStarted",
      mutationType: "resolveFallback",
      writeAttempted: true,
      writeMayHaveSucceeded: true,
      partialWrite: true,
      fallbackAllowed: true,
      fallbackAttempted: true,
      attemptCount: 2,
      verificationState: "Pending",
      observedMutationResult: "Ambiguous",
    };
    await getOperationStore().put(stored);
    mockClient.query
      .mockResolvedValueOnce({ getTicketList: { tickets: [{ ticketId: "ticket-57401", displayId: "57401" }],
        listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 } } })
      .mockResolvedValueOnce({ getTicket: { ticketId: "ticket-57401", displayId: "57401", status: "New Calls",
        updatedTime: "2026-07-24T09:01:00Z",
        client: { accountId: LIVE_PARTIAL_RESOLVE_STATUS_MISSING_REGRESSION.clientId },
        ...RESOLVED_CLASSIFICATION } });

    await runWithExecutionConfig({}, () => runWithExecutionContext(
      "superops_tickets_apply_triage_plan",
      () => resumeApplyTriageOperation({
        operationId: "status-only-fallback-no-replay",
        ownerHash: stored.ownerHash,
        leaseOwner: "status-only-no-replay-worker",
      })
    ));

    const finalRecord = await getOperationStore().get("status-only-fallback-no-replay");
    expect(mockClient.mutate).not.toHaveBeenCalled();
    expect(finalRecord?.itemStates["57401"]).toMatchObject({
      stage: "AmbiguousWriteUnresolved",
      outcome: "AmbiguousWriteUnresolved",
      fallbackAttempted: true,
      attemptCount: 2,
      partialWrite: true,
      reconciliationDisposition: "AmbiguousUnresolved",
      replaySafe: false,
      humanReconciliationRequired: true,
    });
    expect(operationResultView(finalRecord!).results).toContainEqual(expect.objectContaining({
      ticketNumber: "57401",
      fallbackAttempted: true,
      terminalReason: "AmbiguousWriteUnresolved",
      reconciliationDisposition: "AmbiguousUnresolved",
      replaySafe: false,
    }));
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
        getTicketNoteList: [{ noteId: "note-1", content: "Approved private note", privacyType: "PRIVATE" }],
      })
      .mockResolvedValueOnce({
        getTicket: { ticketId: "ticket-57401", displayId: "57401", status: "Awaiting Engineer",
          updatedTime: "2026-07-18T10:01:00Z" },
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

  function stagedVisibilityAction(note = "JUNK") {
    return {
      ticketNumber: "57401",
      contentVerified: true,
      action: "resolve" as const,
      note,
      target: LIVE_PARTIAL_RESOLVE_STATUS_MISSING_REGRESSION.target,
    };
  }

  function installStagedVisibilityMocks(options: { publicOnly?: boolean } = {}) {
    const events: string[] = [];
    let classificationApplied = false;
    let statusResolved = false;
    let privateNoteVisible = false;
    const noteBody = "JUNK";
    mockClient.query.mockImplementation(async (query: string) => {
      if (query.includes("getTicketList")) {
        events.push("ticket-list");
        return { getTicketList: { tickets: [{ ticketId: "ticket-57401", displayId: "57401" }],
          listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 } } };
      }
      if (query.includes("getFields")) {
        events.push("fields");
        return { getFields: RESOLVED_OPTION_FIELDS };
      }
      if (query.includes("getTicketNoteList")) {
        events.push("notes");
        return { getTicketNoteList: privateNoteVisible
          ? [{ noteId: "private-note", content: noteBody, privacyType: options.publicOnly ? "PUBLIC" : "PRIVATE" }]
          : [] };
      }
      events.push("ticket");
      return { getTicket: {
        ticketId: "ticket-57401",
        displayId: "57401",
        status: statusResolved ? "Resolved" : "New Calls",
        updatedTime: statusResolved ? "2026-07-25T16:20:00.000Z" : "2026-07-25T16:18:03.608Z",
        ...(classificationApplied ? {
          client: { accountId: LIVE_PARTIAL_RESOLVE_STATUS_MISSING_REGRESSION.clientId },
          ...RESOLVED_CLASSIFICATION,
        } : {}),
      } };
    });
    mockClient.mutate.mockImplementation(async (mutation: string, variables: { input: Record<string, unknown> }) => {
      if (mutation.includes("createTicketNote")) {
        events.push("note-write");
        expect(variables.input.privacyType).toBe("PRIVATE");
        return { createTicketNote: { noteId: "created-note", privacyType: "PRIVATE" } };
      }
      if (variables.input.status === "Resolved") {
        events.push("status-write");
        expect(variables.input.suppressCloseNotification).toBe(true);
        statusResolved = true;
      } else {
        events.push("classification-write");
        classificationApplied = true;
      }
      return { updateTicket: { ticketId: "ticket-57401", status: variables.input.status } };
    });
    return {
      events,
      showPrivateNote() { privateNoteVisible = true; },
      markClassificationApplied() { classificationApplied = true; },
    };
  }

  it("defers accepted staged private-note verification when the first read misses", async () => {
    const mocks = installStagedVisibilityMocks();
    const result = await withSuccessfulContinuationScheduling(() => runWithExecutionConfig({}, () =>
      runWithExecutionContext("superops_tickets_apply_triage_plan", () =>
        getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
          batchId: "staged-note-visibility-pending",
          expectedCandidateTicketNumbers: ["57401"],
          actions: [stagedVisibilityAction()],
        })
      )
    ));
    const parsed = JSON.parse(result.content[0].text);
    const stored = await getOperationStore().get("staged-note-visibility-pending");

    expect(result.isError).not.toBe(true);
    expect(parsed.operation).toMatchObject({ complete: false, continuationRequired: true });
    expect(parsed.results[0]).toMatchObject({
      finalOutcome: "NoteVisibilityPending",
      noteWriteOutcome: "NoteVisibilityPending",
      initialNoteVerificationObserved: false,
      noteVerificationAttempts: 1,
      noteVerifiedAfterDelay: false,
      continuationRequired: true,
      currentStage: "NoteAdded",
      terminalReason: "NoteVisibilityPending",
    });
    expect(stored?.itemStates["57401"]).toMatchObject({
      stage: "NoteAdded",
      outcome: "NoteVisibilityPending",
      retryCount: 1,
      writeAttempted: true,
      writeMayHaveSucceeded: true,
      observedMutationResult: "Accepted",
    });
    expect(stored?.pendingItems).toEqual(["57401"]);
    expect(mocks.events).toContain("note-write");
    expect(mocks.events).not.toContain("status-write");
    expect(mockClient.mutate.mock.calls.filter(([mutation]) => String(mutation).includes("createTicketNote"))).toHaveLength(1);
  });

  it("verifies a delayed staged private note without duplicating it, then closes status with notification suppression", async () => {
    const mocks = installStagedVisibilityMocks();
    await withSuccessfulContinuationScheduling(() => runWithExecutionConfig({}, () =>
      runWithExecutionContext("superops_tickets_apply_triage_plan", () =>
        getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
          batchId: "staged-note-visibility-delayed-success",
          expectedCandidateTicketNumbers: ["57401"],
          actions: [stagedVisibilityAction()],
        })
      )
    ));
    const stored = await getOperationStore().get("staged-note-visibility-delayed-success");
    if (!stored) throw new Error("missing delayed success operation");
    mocks.showPrivateNote();

    await runWithExecutionConfig({}, () => runWithExecutionContext(
      "superops_tickets_apply_triage_plan",
      () => resumeApplyTriageOperation({
        operationId: "staged-note-visibility-delayed-success",
        ownerHash: stored.ownerHash,
        leaseOwner: "delayed-note-success",
        now: stored.nextEligibleTime ?? new Date().toISOString(),
      })
    ));

    const finalRecord = await getOperationStore().get("staged-note-visibility-delayed-success");
    expect(finalRecord?.state).toBe("Completed");
    expect(finalRecord?.itemStates["57401"]).toMatchObject({
      stage: "Completed",
      outcome: "Resolved",
      verificationState: "Verified",
      writeAttempted: true,
      writeMayHaveSucceeded: true,
      partialWrite: false,
    });
    const compact = finalRecord?.compactResults.find((entry) =>
      typeof entry === "object" && entry !== null &&
      (entry as { ticketNumber?: string }).ticketNumber === "57401"
    ) as Record<string, unknown> | undefined;
    expect(compact).toMatchObject({
      ticketNumber: "57401",
      finalOutcome: "Resolved",
      noteWriteOutcome: "NoteVerifiedAfterDelay",
      initialNoteVerificationObserved: false,
      noteVerificationAttempts: 2,
      noteVerifiedAfterDelay: true,
      statusWriteOutcome: "Accepted",
      suppressCloseNotificationIncluded: true,
    });
    expect(compact?.physicalWrites).toEqual([
      { method: "updateTicket.classification", outcome: "Accepted" },
      { method: "createTicketNote", outcome: "Accepted" },
      { method: "updateTicket.statusOnly", outcome: "Accepted" },
    ]);
    expect(compact?.completedStages).toEqual(expect.arrayContaining([
      "PreflightValidated",
      "ClassificationVerified",
      "NoteAdded",
      "NoteVerified",
    ]));
    expect(mockClient.mutate.mock.calls.filter(([mutation]) => String(mutation).includes("createTicketNote"))).toHaveLength(1);
    expect(mockClient.mutate.mock.calls).toContainEqual([
      expect.stringContaining("updateTicket"),
      expect.objectContaining({ input: expect.objectContaining({ status: "Resolved", suppressCloseNotification: true }) }),
    ]);
  });

  it("starts a NoteWriteStarted continuation with note reconciliation and does not replay classification or note writes", async () => {
    const mocks = installStagedVisibilityMocks();
    await withSuccessfulContinuationScheduling(() => runWithExecutionConfig({}, () =>
      runWithExecutionContext("superops_tickets_apply_triage_plan", () =>
        getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
          batchId: "staged-note-write-started-reconcile-first",
          expectedCandidateTicketNumbers: ["57401"],
          actions: [stagedVisibilityAction()],
        })
      )
    ));
    const stored = await getOperationStore().get("staged-note-write-started-reconcile-first");
    if (!stored) throw new Error("missing NoteWriteStarted operation");
    stored.itemStates["57401"] = {
      ...stored.itemStates["57401"],
      stage: "NoteWriteStarted",
      retryCount: 1,
      writeAttempted: true,
      writeMayHaveSucceeded: true,
      partialWrite: true,
      observedMutationResult: "Accepted",
      verificationState: "Pending",
    };
    await getOperationStore().put(stored);
    mocks.showPrivateNote();
    mocks.markClassificationApplied();
    mocks.events.length = 0;
    mockClient.mutate.mockClear();

    await runWithExecutionConfig({}, () => runWithExecutionContext(
      "superops_tickets_apply_triage_plan",
      () => resumeApplyTriageOperation({
        operationId: "staged-note-write-started-reconcile-first",
        ownerHash: stored.ownerHash,
        leaseOwner: "note-write-started-worker",
        now: stored.nextEligibleTime ?? new Date().toISOString(),
      })
    ));

    expect(mocks.events.slice(0, 2)).toEqual(["ticket-list", "notes"]);
    expect(mocks.events).not.toContain("classification-write");
    expect(mocks.events).not.toContain("note-write");
    expect(mocks.events).toContain("status-write");
    expect(mockClient.mutate.mock.calls).toHaveLength(1);
    expect(mockClient.mutate.mock.calls[0][1].input).toMatchObject({
      status: "Resolved",
      suppressCloseNotification: true,
    });
  });

  it.each([
    ["absent", false],
    ["public", true],
  ] as const)("ends unresolved and does not close when the private note remains %s", async (_case, publicOnly) => {
    const mocks = installStagedVisibilityMocks({ publicOnly });
    await withSuccessfulContinuationScheduling(() => runWithExecutionConfig({}, () =>
      runWithExecutionContext("superops_tickets_apply_triage_plan", () =>
        getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
          batchId: `staged-note-visibility-unresolved-${_case}`,
          expectedCandidateTicketNumbers: ["57401"],
          actions: [stagedVisibilityAction()],
        })
      )
    ));
    const stored = await getOperationStore().get(`staged-note-visibility-unresolved-${_case}`);
    if (!stored) throw new Error("missing unresolved operation");
    stored.itemStates["57401"] = {
      ...stored.itemStates["57401"],
      stage: "NoteAdded",
      retryCount: 3,
      writeAttempted: true,
      writeMayHaveSucceeded: true,
      partialWrite: true,
      observedMutationResult: "Accepted",
      verificationState: "Pending",
    };
    await getOperationStore().put(stored);
    if (publicOnly) mocks.showPrivateNote();
    mocks.events.length = 0;
    mockClient.mutate.mockClear();

    await runWithExecutionConfig({}, () => runWithExecutionContext(
      "superops_tickets_apply_triage_plan",
      () => resumeApplyTriageOperation({
        operationId: `staged-note-visibility-unresolved-${_case}`,
        ownerHash: stored.ownerHash,
        leaseOwner: `unresolved-${_case}`,
        now: stored.nextEligibleTime ?? new Date().toISOString(),
      })
    ));

    const finalRecord = await getOperationStore().get(`staged-note-visibility-unresolved-${_case}`);
    expect(finalRecord?.itemStates["57401"]).toMatchObject({
      stage: "AmbiguousWriteUnresolved",
      outcome: "NoteVisibilityUnresolved",
      writeAttempted: true,
      writeMayHaveSucceeded: true,
      partialWrite: true,
      verificationState: "Pending",
      errorClass: "AmbiguousWrite",
    });
    expect(finalRecord?.compactResults).toContainEqual(expect.objectContaining({
      ticketNumber: "57401",
      finalOutcome: "Failed",
      noteWriteOutcome: "NoteVisibilityUnresolved",
      noteVerificationAttempts: 4,
      terminalReason: "NoteVisibilityUnresolved",
    }));
    expect(mocks.events).toEqual(["ticket-list", "notes", "notes"]);
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });

  it("leaves staged resolve dry-run note behaviour unchanged", async () => {
    mockClient.query.mockImplementation(async (query: string) => {
      if (query.includes("getTicketList")) return { getTicketList: {
        tickets: [{ ticketId: "ticket-57401", displayId: "57401" }],
        listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 },
      } };
      if (query.includes("getFields")) return { getFields: RESOLVED_OPTION_FIELDS };
      return { getTicket: { ticketId: "ticket-57401", displayId: "57401", status: "New Calls" } };
    });

    const result = await withSuccessfulContinuationScheduling(() => runWithExecutionConfig({}, () =>
      runWithExecutionContext("superops_tickets_apply_triage_plan", () =>
        getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
          batchId: "staged-note-visibility-dry-run",
          dryRun: true,
          expectedCandidateTicketNumbers: ["57401"],
          actions: [stagedVisibilityAction()],
        })
      )
    ));
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.results[0]).toMatchObject({
      finalOutcome: "Resolved",
      writeMethod: "dryRun",
      notePlanned: true,
      noteDedupePlanned: true,
      noteDedupeChecked: false,
    });
    expect(parsed.results[0].noteWriteOutcome).toBeUndefined();
    expect(mockClient.query.mock.calls.some(([query]) => String(query).includes("getTicketNoteList"))).toBe(false);
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });
  it("marks completed dry-run update continuation items as verification not required", async () => {
    const domain = getTicketsTools();
    await withSuccessfulContinuationScheduling(() => runWithExecutionConfig(
      { SUPEROPS_EXECUTION_MAX_ITEMS_PER_BATCH: "1" },
      () => domain.handleCall("superops_tickets_apply_triage_plan", {
        batchId: "dry-run-update-verification-state",
        expectedCandidateTicketNumbers: ["57400", "58776"],
        dryRun: true,
        actions: [{
          ticketNumber: "58776",
          expectedUpdatedTime: "2026-07-18T10:00:00Z",
          contentVerified: true,
          action: "update",
          target: { ...TRIAGE_TEST_CLASSIFICATION, status: "Awaiting Engineer" },
        }],
      })
    ));
    const stored = await getOperationStore().get("dry-run-update-verification-state");
    if (!stored) throw new Error("missing dry-run operation");
    expect(stored.pendingItems).toEqual(["58776"]);

    mockClient.query
      .mockResolvedValueOnce({
        getTicketList: {
          tickets: [{ ticketId: "ticket-58776", displayId: "58776" }],
          listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 },
        },
      })
      .mockResolvedValueOnce({
        getTicket: {
          ticketId: "ticket-58776",
          displayId: "58776",
          status: "New Calls",
          updatedTime: "2026-07-18T10:00:00Z",
        },
      })
      .mockResolvedValueOnce({ getFields: RESOLVED_OPTION_FIELDS });

    await runWithExecutionConfig({}, () =>
      runWithExecutionContext("superops_tickets_apply_triage_plan", () =>
        resumeApplyTriageOperation({
          operationId: "dry-run-update-verification-state",
          ownerHash: stored.ownerHash,
          leaseOwner: "dry-run-worker",
        })
      )
    );

    const finalRecord = await getOperationStore().get("dry-run-update-verification-state");
    expect(finalRecord?.state).toBe("Completed");
    expect(finalRecord?.pendingItems).toEqual([]);
    expect(finalRecord?.itemStates["58776"]).toMatchObject({
      stage: "Completed",
      outcome: "Updated",
      writeAttempted: false,
      writeMayHaveSucceeded: false,
      partialWrite: false,
      verificationState: "NotRequired",
    });
  });

  it("never replays an ambiguous private-note failure and terminalises only after bounded reconciliation", async () => {
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
    let finalRecord = await getOperationStore().get("private-note-ambiguous");
    if (!finalRecord) throw new Error("missing ambiguous private-note operation");
    expect(finalRecord.itemStates["57401"]).toMatchObject({
      stage: "NoteWriteAmbiguous",
      writeAttempted: true,
      writeMayHaveSucceeded: true,
      partialWrite: false,
      verificationState: "Pending",
      errorClass: "AmbiguousWrite",
      reconciliationDisposition: "AmbiguousUnresolved",
      recoveryRetryCount: 0,
    });
    for (let attempt = 0; attempt < 4 && finalRecord.state !== "CompletedWithFailures"; attempt += 1) {
      await runWithExecutionConfig({}, () => runWithExecutionContext(
        "superops_tickets_apply_triage_plan",
        () => resumeApplyTriageOperation({
          operationId: "private-note-ambiguous",
          ownerHash: stored.ownerHash,
          leaseOwner: `note-reconcile-${attempt}`,
          now: finalRecord!.itemStates["57401"].nextEligibleTime,
        })
      ));
      finalRecord = await getOperationStore().get("private-note-ambiguous");
      if (!finalRecord) throw new Error("missing ambiguous private-note operation");
    }
    expect(finalRecord.itemStates["57401"]).toMatchObject({
      stage: "AmbiguousWriteUnresolved",
      writeAttempted: true,
      writeMayHaveSucceeded: true,
      partialWrite: false,
      verificationState: "Pending",
      errorClass: "AmbiguousWrite",
      reconciliationDisposition: "AmbiguousUnresolved",
      recoveryRetryCount: 0,
      replaySafe: false,
      humanReconciliationRequired: true,
    });
    expect(finalRecord.itemStates["57401"].nextEligibleTime).toBeUndefined();
    expect(operationResultView(finalRecord).totals).toMatchObject({
      ambiguousUnresolved: 1,
      partialWrite: 0,
      humanReconciliationRequired: 1,
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
    vi.mocked(getCredentials).mockReturnValue({ apiToken: "secret-token", subdomain: "example", region: "us" });
  });

  afterEach(() => {
    resetTicketFieldOptionsCacheForTests();
    vi.unstubAllGlobals();
    vi.useRealTimers();
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
  it("schedules and resumes a dry-run when the cooperative guard fires before the first item", async () => {
    const durable = ownerScopedDurableNamespaceForTickets();
    const clock = installFakeExecutionClock();
    const scheduledContinuations: unknown[] = [];
    const schedulerEnv = {
      SUPEROPS_CONTINUATION_ENABLED: "true",
      SUPEROPS_DURABLE_RETRY_ENABLED: "true",
      SUPEROPS_INTERNAL_CONTINUATION_TOKEN: "test-internal-token",
      SUPEROPS_CONTINUATION_SERVICE: {
        fetch: async (request: Request) => {
          scheduledContinuations.push(await request.json());
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      },
    };

    await runWithOperationStore({ SUPEROPS_OPERATION_LEDGER: durable.namespace }, async () => {
      const store = getOperationStore();
      const put = store.put.bind(store);
      const claimNextItem = store.claimNextItem.bind(store);
      store.put = vi.fn(async (...args: Parameters<typeof store.put>) => {
        await put(...args);
        clock.advanceTo(21_702);
      });
      store.claimNextItem = vi.fn(claimNextItem);

      const initial = await runWithContinuationScheduler(schedulerEnv, () => runWithExecutionConfig(
        {
          SUPEROPS_EXECUTION_CPU_GUARD_MS: "20000",
          SUPEROPS_EXECUTION_MAX_DURATION_MS: "25000",
          SUPEROPS_EXECUTION_SAFE_REMAINING_TIME_MS: "0",
        },
        () => runWithExecutionContext("superops_tickets_apply_triage_plan", () =>
          getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
            batchId: "3bb55703-59c9-43a6-8455-50ca68a44ad0",
            expectedCandidateTicketNumbers: ["58824"],
            dryRun: true,
            actions: [{
              ticketNumber: "58824",
              expectedStatus: "New Calls",
              expectedUpdatedTime: "2026-07-22T08:30:00.000Z",
              contentVerified: true,
              action: "update",
              target: { ...TRIAGE_TEST_CLASSIFICATION, status: "Awaiting Engineer" },
            }],
          })
        )
      ));
      const parsedInitial = JSON.parse(initial.content[0].text);
      const ownerHash = currentOwnerHash();
      const yielded = await store.get("3bb55703-59c9-43a6-8455-50ca68a44ad0", ownerHash);

      expect(initial.isError).not.toBe(true);
      expect(parsedInitial.operation).toMatchObject({
        complete: false,
        continuationRequired: true,
        persisted: true,
        state: "ContinuationRequired",
        continuationScheduling: {
          attempted: true,
          scheduled: true,
        },
        writeAttempted: false,
        writeMayHaveSucceeded: false,
      });
      expect(parsedInitial.operation.errorClass).toBeUndefined();
      expect(parsedInitial.operation.finalReason).toBeUndefined();
      expect(store.claimNextItem).not.toHaveBeenCalled();
      expect(mockClient.query).not.toHaveBeenCalled();
      expect(mockClient.mutate).not.toHaveBeenCalled();
      expect(scheduledContinuations).toHaveLength(1);
      expect(yielded).toMatchObject({
        state: "ContinuationRequired",
        pendingItems: ["58824"],
        unattemptedItems: ["58824"],
        continuationCount: 1,
        schedulingAttempted: true,
        schedulingSucceeded: true,
        itemStates: {
          "58824": {
            stage: "Unattempted",
            writeAttempted: false,
            writeMayHaveSucceeded: false,
            partialWrite: false,
          },
        },
      });
      expect(yielded?.itemStates["58824"]).not.toHaveProperty("attemptCount");
      expect(yielded?.compactResults).toEqual([]);

      clock.resetMonotonic();
      mockClient.query
        .mockResolvedValueOnce({
          getTicketList: {
            tickets: [{ ticketId: "ticket-58824", displayId: "58824" }],
            listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 },
          },
        })
        .mockResolvedValueOnce({
          getTicket: {
            ticketId: "ticket-58824",
            displayId: "58824",
            subject: "Dry-run resume",
            status: "New Calls",
            updatedTime: "2026-07-22T08:30:00.000Z",
          },
        })
        .mockResolvedValueOnce({ getFields: RESOLVED_OPTION_FIELDS });

      const resumed = await runWithExecutionConfig(
        {
          SUPEROPS_EXECUTION_CPU_GUARD_MS: "20000",
          SUPEROPS_EXECUTION_SAFE_REMAINING_TIME_MS: "0",
        },
        () => runWithExecutionContext("superops_tickets_apply_triage_plan", () =>
          resumeApplyTriageOperation({
            operationId: "3bb55703-59c9-43a6-8455-50ca68a44ad0",
            ownerHash,
            leaseOwner: "resume-after-cooperative-yield",
          })
        )
      );
      const finalRecord = await store.get("3bb55703-59c9-43a6-8455-50ca68a44ad0", ownerHash);

      expect(resumed).toMatchObject({
        state: "Completed",
        continuationRequired: false,
        completedItems: 1,
        pendingItems: 0,
        unattemptedItems: 0,
      });
      expect(finalRecord).toMatchObject({
        state: "Completed",
        pendingItems: [],
        unattemptedItems: [],
        continuationCount: 1,
        itemStates: {
          "58824": {
            stage: "Completed",
            outcome: "Updated",
            writeAttempted: false,
            writeMayHaveSucceeded: false,
            partialWrite: false,
            verificationState: "NotRequired",
          },
        },
      });
      expect(finalRecord?.compactResults).toContainEqual(expect.objectContaining({
        ticketNumber: "58824",
        finalOutcome: "Updated",
        writeAttempted: false,
        writeMethod: "dryRun",
      }));
      expect(mockClient.query).toHaveBeenCalledTimes(3);
      expect(mockClient.query.mock.calls.some(([query]) => String(query).includes("getFields"))).toBe(true);
      expect(mockClient.mutate).not.toHaveBeenCalled();
    });
  });

  it("persists completion after a slow field-option read exhausts the cooperative guard", async () => {
    const durable = ownerScopedDurableNamespaceForTickets();
    const clock = installFakeExecutionClock();

    await runWithOperationStore({ SUPEROPS_OPERATION_LEDGER: durable.namespace }, async () => {
      mockClient.query.mockImplementation(async (query: string) => {
        if (query.includes("getTicketList")) {
          return {
            getTicketList: {
              tickets: [{ ticketId: "ticket-58824", displayId: "58824" }],
              listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 },
            },
          };
        }
        if (query.includes("getTicket(")) {
          return {
            getTicket: {
              ticketId: "ticket-58824",
              displayId: "58824",
              subject: "Slow metadata dry run",
              status: "New Calls",
              updatedTime: "2026-07-22T08:30:00.000Z",
            },
          };
        }
        if (query.includes("getFields")) {
          clock.advanceTo(21_702);
          return {
            getFields: [
              ...RESOLVED_OPTION_FIELDS.filter((field) => field.columnName !== "impact"),
              ticketField("impact", ["High"]),
            ],
          };
        }
        throw new Error("unexpected query");
      });

      const result = await runWithExecutionConfig(
        {
          SUPEROPS_EXECUTION_CPU_GUARD_MS: "20000",
          SUPEROPS_EXECUTION_MAX_DURATION_MS: "25000",
          SUPEROPS_EXECUTION_SAFE_REMAINING_TIME_MS: "0",
        },
        () => runWithExecutionContext("superops_tickets_apply_triage_plan", () =>
          getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
            batchId: "slow-field-options-before-final-persist",
            expectedCandidateTicketNumbers: ["58824"],
            dryRun: true,
            actions: [{
              ticketNumber: "58824",
              expectedStatus: "New Calls",
              expectedUpdatedTime: "2026-07-22T08:30:00.000Z",
              contentVerified: true,
              action: "update",
              target: { ...TRIAGE_TEST_CLASSIFICATION, status: "Awaiting Engineer", impact: "High" },
            }],
          })
        )
      );
      const parsed = JSON.parse(result.content[0].text);
      const stored = await getOperationStore().get("slow-field-options-before-final-persist", currentOwnerHash());

      expect(result.isError).not.toBe(true);
      expect(parsed.operation).toMatchObject({
        complete: true,
        continuationRequired: false,
        state: "Completed",
        writeAttempted: false,
        writeMayHaveSucceeded: false,
      });
      expect(stored).toMatchObject({
        state: "Completed",
        pendingItems: [],
        unattemptedItems: [],
        continuationCount: 0,
        itemStates: {
          "58824": {
            stage: "Completed",
            outcome: "Updated",
            writeAttempted: false,
            writeMayHaveSucceeded: false,
            verificationState: "NotRequired",
          },
        },
      });
      expect(mockClient.query).toHaveBeenCalledTimes(3);
      expect(mockClient.mutate).not.toHaveBeenCalled();
    });
  });
  it("terminalizes a pre-item cooperative yield when immediate scheduling genuinely fails", async () => {
    const durable = ownerScopedDurableNamespaceForTickets();
    const clock = installFakeExecutionClock();

    await runWithOperationStore({ SUPEROPS_OPERATION_LEDGER: durable.namespace }, async () => {
      const store = getOperationStore();
      const put = store.put.bind(store);
      store.put = vi.fn(async (...args: Parameters<typeof store.put>) => {
        await put(...args);
        clock.advanceTo(21_702);
      });

      const result = await runWithContinuationScheduler({
        SUPEROPS_CONTINUATION_ENABLED: "true",
        SUPEROPS_DURABLE_RETRY_ENABLED: "true",
        SUPEROPS_INTERNAL_CONTINUATION_TOKEN: "test-internal-token",
        SUPEROPS_CONTINUATION_SERVICE: {
          fetch: async () => new Response("delivery unavailable", { status: 503 }),
        },
      }, () => runWithExecutionConfig(
        {
          SUPEROPS_EXECUTION_CPU_GUARD_MS: "20000",
          SUPEROPS_EXECUTION_MAX_DURATION_MS: "25000",
          SUPEROPS_EXECUTION_SAFE_REMAINING_TIME_MS: "0",
        },
        () => runWithExecutionContext("superops_tickets_apply_triage_plan", () =>
          getTicketsTools().handleCall("superops_tickets_apply_triage_plan", {
            batchId: "cooperative-yield-scheduler-failure",
            expectedCandidateTicketNumbers: ["58824"],
            dryRun: true,
            actions: [{
              ticketNumber: "58824",
              contentVerified: true,
              action: "update",
              target: { ...TRIAGE_TEST_CLASSIFICATION, status: "Awaiting Engineer" },
            }],
          })
        )
      ));
      const parsed = JSON.parse(result.content[0].text);
      const stored = await store.get("cooperative-yield-scheduler-failure", currentOwnerHash());

      expect(parsed.operation).toMatchObject({
        complete: true,
        continuationRequired: false,
        state: "CompletedWithFailures",
        continuationScheduling: {
          attempted: true,
          scheduled: false,
          terminalized: true,
          status: 503,
          reasonCode: "non2xxContinuationResponse",
        },
        errorClass: "ContinuationSchedulingFailure",
        writeAttempted: false,
        writeMayHaveSucceeded: false,
      });
      expect(parsed.operation.continuationScheduling.error).toContain("Continuation service returned non-2xx status 503");
      expect(stored).toMatchObject({
        state: "CompletedWithFailures",
        continuationCount: 1,
        schedulingAttempted: true,
        schedulingSucceeded: false,
        itemStates: {
          "58824": {
            stage: "FailedBeforeWrite",
            outcome: "ContinuationSchedulingFailed",
            errorClass: "ContinuationSchedulingFailure",
            writeAttempted: false,
            writeMayHaveSucceeded: false,
          },
        },
      });
      expect(mockClient.query).not.toHaveBeenCalled();
      expect(mockClient.mutate).not.toHaveBeenCalled();
    });
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
      target: { ...TRIAGE_TEST_CLASSIFICATION, status: "Awaiting Engineer" },
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
      if (query.includes("getFields")) {
        return { getFields: RESOLVED_OPTION_FIELDS };
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
      Object.assign(ticket, TRIAGE_TEST_CLASSIFICATION);
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
