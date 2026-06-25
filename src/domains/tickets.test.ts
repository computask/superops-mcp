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
}));

import { getClient } from "../client.js";
import { getTicketsTools } from "./tickets.js";

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
      "superops_tickets_get",
      "superops_tickets_conversation_list",
      "superops_tickets_notes_list",
      "superops_tickets_create",
      "superops_tickets_update",
      "superops_tickets_add_note",
      "superops_tickets_log_time",
    ]);
  });

  it("uses page/pageSize list variables and local status filtering", async () => {
    mockClient.query.mockResolvedValue({
      getTicketList: {
        tickets: [
          {
            ticketId: "1",
            displayId: "062822-0001",
            subject: "Worked ticket",
            status: "Worked on",
          },
          { ticketId: "2", displayId: "062822-0002", subject: "Closed", status: "Closed" },
        ],
        listInfo: { page: 1, pageSize: 50, hasMore: false, totalCount: 2 },
      },
    });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_list", {
      status: ["Worked on"],
      max: 75,
      page: 2,
    });

    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining("getTicketList"),
      { input: { page: 2, pageSize: 75 } }
    );
    expect(mockClient.query.mock.calls[0][1].input).not.toHaveProperty("first");
    expect(mockClient.query.mock.calls[0][1].input).not.toHaveProperty("filter");
    expect(result.content[0].text).toContain("Worked ticket");
    expect(result.content[0].text).not.toContain("Closed");
  });

  it("exposes tenant-specific status and category enums", () => {
    const domain = getTicketsTools();
    const listTool = domain.tools.find((tool) => tool.name === "superops_tickets_list");
    const createTool = domain.tools.find((tool) => tool.name === "superops_tickets_create");
    const updateTool = domain.tools.find((tool) => tool.name === "superops_tickets_update");

    const listStatus = listTool?.inputSchema.properties.status as {
      items?: { enum?: string[] };
    };
    const createCategory = createTool?.inputSchema.properties.categoryName as {
      enum?: string[];
    };
    const updateStatus = updateTool?.inputSchema.properties.status as {
      enum?: string[];
    };

    expect(listStatus.items?.enum).toEqual(VALID_TICKET_STATUSES);
    expect(updateStatus.enum).toEqual(VALID_TICKET_STATUSES);
    expect(createCategory.enum).toEqual(VALID_TICKET_CATEGORIES);
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
    expect(result.content[0].text).toContain("created-ticket");
    expect(mockClient.mutate.mock.calls[0][1].input).not.toHaveProperty("priority");
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

  it("creates ticket notes using createTicketNote", async () => {
    mockClient.mutate.mockResolvedValue({
      createTicketNote: {
        noteId: "note-123",
        content: "Private note",
        privacyType: "PRIVATE",
      },
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
});
