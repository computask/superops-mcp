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
          { ticketId: "1", displayId: "062822-0001", subject: "Open", status: "Open" },
          { ticketId: "2", displayId: "062822-0002", subject: "Closed", status: "Closed" },
        ],
        listInfo: { page: 1, pageSize: 50, hasMore: false, totalCount: 2 },
      },
    });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_list", {
      status: ["Open"],
      max: 75,
      page: 2,
    });

    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining("getTicketList"),
      { input: { page: 2, pageSize: 75 } }
    );
    expect(mockClient.query.mock.calls[0][1].input).not.toHaveProperty("first");
    expect(mockClient.query.mock.calls[0][1].input).not.toHaveProperty("filter");
    expect(result.content[0].text).toContain("Open");
    expect(result.content[0].text).not.toContain("Closed");
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

  it("creates tickets with documented input names and response fields", async () => {
    mockClient.mutate.mockResolvedValue({
      createTicket: {
        ticketId: "new-ticket",
        displayId: "062822-0005",
        subject: "New Issue",
      },
    });

    const domain = getTicketsTools();
    const result = await domain.handleCall("superops_tickets_create", {
      subject: "New Issue",
      clientId: "client-123",
      description: "Detailed description",
      priority: "High",
      requesterEmail: "user@example.com",
      techGroupName: "Support Team",
      categoryName: "Hardware",
    });

    expect(mockClient.mutate).toHaveBeenCalledWith(
      expect.stringContaining("createTicket"),
      {
		input: {
		  subject: "New Issue",
		  client: { accountId: "client-123" },
		  status: "New",
		  requestType: "Incident",
		  source: "FORM",
		  description: "Detailed description",
		  category: "Hardware",
		},
      }
    );
    expect(mockClient.mutate.mock.calls[0][0]).toContain("displayId");
    expect(result.content[0].text).toContain("new-ticket");
  });

  it("updates tickets with technician assignment rather than assignee", async () => {
    mockClient.mutate.mockResolvedValue({
      updateTicket: { ticketId: "ticket-123", technician: { userId: "tech-456" } },
    });

    const domain = getTicketsTools();
    await domain.handleCall("superops_tickets_update", {
      ticketId: "ticket-123",
      status: "Resolved",
      priority: "Low",
      assigneeId: "tech-456",
      resolution: "Fixed the issue",
    });

    expect(mockClient.mutate).toHaveBeenCalledWith(
      expect.stringContaining("updateTicket"),
      {
        input: {
          ticketId: "ticket-123",
          status: "Resolved",
          priority: "Low",
          technician: { userId: "tech-456" },
        },
      }
    );
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
});
