/**
 * SuperOps.ai Tickets Domain
 *
 * Tools for managing service tickets in SuperOps.ai PSA.
 */

import { getClient } from "../client.js";
import type {
  DomainTools,
  Ticket,
  TicketConversation,
  TicketNote,
  TimeEntry,
  ListInfo,
} from "../types.js";
import { elicitText } from "../utils/elicitation.js";

const DEFAULT_LIST_PAGE = 1;

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
] as const;

const VALID_TICKET_CATEGORIES = [
  "1. Support request",
  "2. Change request",
  "3. Security Incident",
  "4. New setup",
  "5. Non-technical query",
  "6. New enquiry",
  "7. Sales call",
  "8. Rewst",
] as const;

const DEFAULT_CREATE_TICKET_STATUS = "New Calls";

const LIST_TICKETS_QUERY = `
  query getTicketList($input: ListInfoInput!) {
    getTicketList(input: $input) {
      tickets {
        ticketId
        displayId
        subject
        requestType
        source
        client
        requester
        techGroup
        technician
        status
        priority
        impact
        urgency
        category
        createdTime
        updatedTime
      }
      listInfo {
        page
        pageSize
        hasMore
        totalCount
      }
    }
  }
`;

const GET_TICKET_QUERY = `
  query getTicket($input: TicketIdentifierInput!) {
    getTicket(input: $input) {
      ticketId
      displayId
      subject
      ticketType
      requestType
      source
      client
      site
      requester
      additionalRequester
      followers
      techGroup
      technician
      status
      priority
      impact
      urgency
      category
      subcategory
      cause
      subcause
      resolutionCode
      sla
      createdTime
      updatedTime
      firstResponseDueTime
      firstResponseTime
      firstResponseViolated
      resolutionDueTime
      resolutionTime
      resolutionViolated
      customFields
      worklogTimespent
    }
  }
`;

const GET_TICKET_CONVERSATION_LIST_QUERY = `
  query getTicketConversationList($input: TicketIdentifierInput!) {
    getTicketConversationList(input: $input) {
      conversationId
      content
      time
      user
      toUsers {
        user
      }
      ccUsers {
        user
      }
      bccUsers {
        user
      }
      attachments {
        fileName
        originalFileName
        fileSize
      }
      type
    }
  }
`;

const GET_TICKET_NOTE_LIST_QUERY = `
  query getTicketNoteList($input: TicketIdentifierInput!) {
    getTicketNoteList(input: $input) {
      noteId
      addedBy
      addedOn
      content
      attachments {
        fileName
        originalFileName
        fileSize
      }
      privacyType
    }
  }
`;

const CREATE_TICKET_MUTATION = `
  mutation createTicket($input: CreateTicketInput!) {
    createTicket(input: $input) {
      ticketId
      displayId
      subject
      client
      requester
      techGroup
      technician
      status
      priority
      category
      createdTime
      updatedTime
    }
  }
`;

const UPDATE_TICKET_MUTATION = `
  mutation updateTicket($input: UpdateTicketInput!) {
    updateTicket(input: $input) {
      ticketId
      displayId
      status
      priority
      techGroup
      technician
      updatedTime
    }
  }
`;

const ADD_TICKET_NOTE_MUTATION = `
  mutation createTicketNote($input: CreateTicketNoteInput!) {
    createTicketNote(input: $input) {
      noteId
      addedBy
      addedOn
      content
      privacyType
    }
  }
`;

const ADD_TIME_ENTRY_MUTATION = `
  mutation createWorklogEntries($input: [CreateWorklogEntryInput!]!) {
    createWorklogEntries(input: $input) {
      itemId
      status
      serviceItem
      billable
      afterHours
      qty
      unitPrice
      billDateTime
      technician
      notes
      workItem
    }
  }
`;

interface ListTicketsResponse {
  getTicketList: {
    tickets: Ticket[];
    listInfo: ListInfo;
  };
}

interface GetTicketResponse {
  getTicket: Ticket;
}

interface GetTicketConversationListResponse {
  getTicketConversationList: TicketConversation[];
}

interface GetTicketNoteListResponse {
  getTicketNoteList: TicketNote[];
}

interface CreateTicketResponse {
  createTicket: Ticket;
}

interface UpdateTicketResponse {
  updateTicket: Ticket;
}

interface AddNoteResponse {
  createTicketNote: TicketNote;
}

interface AddTimeEntryResponse {
  createWorklogEntries: TimeEntry[];
}

function pageInput(max: number | undefined, page?: number) {
  return {
    page: page ?? DEFAULT_LIST_PAGE,
    pageSize: Math.min(max ?? 50, 500),
  };
}

function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function applyTicketFilters(
  tickets: Ticket[],
  filters: {
    status?: string[];
    priority?: string[];
    clientId?: string;
    assigneeId?: string;
    unassigned?: boolean;
  }
): Ticket[] {
  return tickets.filter((ticket) => {
    if (filters.status && (!ticket.status || !filters.status.includes(ticket.status))) {
      return false;
    }
    if (
      filters.priority &&
      (!ticket.priority || !filters.priority.includes(ticket.priority))
    ) {
      return false;
    }

    const clientInfo = jsonRecord(ticket.client);
    if (filters.clientId && clientInfo?.accountId !== filters.clientId) return false;

    const technicianInfo = jsonRecord(ticket.technician);
    if (filters.assigneeId && technicianInfo?.userId !== filters.assigneeId) return false;
    if (filters.unassigned && technicianInfo) return false;

    return true;
  });
}

function invalidValues(values: string[], validValues: readonly string[]): string[] {
  return values.filter((value) => !validValues.includes(value));
}

function errorResult(message: string) {
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
  };
}

export function getTicketsTools(): DomainTools {
  return {
    tools: [
      {
        name: "superops_tickets_list",
        description:
          "List tickets in SuperOps.ai. Can filter by status, priority, client, or assignee.",
        inputSchema: {
          type: "object",
          properties: {
            status: {
              type: "array",
              items: {
                type: "string",
                enum: [...VALID_TICKET_STATUSES],
              },
              description:
                `Filter by configured ticket status(es): ${VALID_TICKET_STATUSES.join(", ")}`,
            },
            priority: {
              type: "array",
              items: { type: "string" },
              description: "Filter by priority value returned by SuperOps.",
            },
            clientId: {
              type: "string",
              description: "Filter by client account ID",
            },
            assigneeId: {
              type: "string",
              description: "Filter by assigned technician ID",
            },
            unassigned: {
              type: "boolean",
              description: "Show only unassigned tickets",
            },
            max: {
              type: "number",
              description: "Maximum number of results (default: 50, max: 500)",
              default: 50,
            },
            page: {
              type: "number",
              description: "Page number to fetch (default: 1)",
              default: 1,
            },
          },
        },
      },
      {
        name: "superops_tickets_get",
        description: "Get detailed information for a specific ticket by its ID.",
        inputSchema: {
          type: "object",
          properties: {
            ticketId: {
              type: "string",
              description: "The unique ticket ID",
            },
          },
          required: ["ticketId"],
        },
      },
      {
        name: "superops_tickets_conversation_list",
        description:
          "List customer ticket conversations and replies, including attachment metadata where returned.",
        inputSchema: {
          type: "object",
          properties: {
            ticketId: {
              type: "string",
              description: "The unique ticket ID",
            },
          },
          required: ["ticketId"],
        },
      },
      {
        name: "superops_tickets_notes_list",
        description:
          "List public and internal ticket notes, including attachment metadata where returned.",
        inputSchema: {
          type: "object",
          properties: {
            ticketId: {
              type: "string",
              description: "The unique ticket ID",
            },
          },
          required: ["ticketId"],
        },
      },
      {
        name: "superops_tickets_create",
        description: "Create a new ticket in SuperOps.ai.",
        inputSchema: {
          type: "object",
          properties: {
            subject: {
              type: "string",
              description: "Ticket subject/title",
            },
            description: {
              type: "string",
              description: "Detailed description of the issue",
            },
            clientId: {
              type: "string",
              description: "Client account ID",
            },
            priority: {
              type: "string",
              description:
                "Currently not sent by this tool. Requires confirmed SuperOps priority ID mapping.",
            },
            requesterEmail: {
              type: "string",
              description: "Email of the person reporting the issue",
            },
            techGroupName: {
              type: "string",
              description: "Name of the technician group to assign",
            },
            categoryName: {
              type: "string",
              description:
                `Configured top-level ticket category: ${VALID_TICKET_CATEGORIES.join(", ")}`,
              enum: [...VALID_TICKET_CATEGORIES],
            },
            // TODO: Add subcategoryName after the SuperOps ticket input shape for
            // configured subcategory references is confirmed.
          },
          required: ["subject", "clientId"],
        },
      },
      {
        name: "superops_tickets_update",
        description:
          "Update an existing ticket - change status, priority, assignment, or add resolution.",
        inputSchema: {
          type: "object",
          properties: {
            ticketId: {
              type: "string",
              description: "The ticket ID to update",
            },
            status: {
              type: "string",
              description:
                "New status. Must match one of the configured SuperOps ticket statuses for this tenant.",
              enum: [...VALID_TICKET_STATUSES],
            },
            priority: {
              type: "string",
              description:
                "Currently not sent by this tool. Requires confirmed SuperOps priority ID mapping.",
            },
            assigneeId: {
              type: "string",
              description: "ID of technician to assign",
            },
            techGroupName: {
              type: "string",
              description: "Name of technician group to assign",
            },
            resolution: {
              type: "string",
              description: "Resolution notes (for resolving/closing tickets)",
            },
          },
          required: ["ticketId"],
        },
      },
      {
        name: "superops_tickets_add_note",
        description: "Add a note to a ticket. Can be internal or public (visible to client).",
        inputSchema: {
          type: "object",
          properties: {
            ticketId: {
              type: "string",
              description: "The ticket ID",
            },
            content: {
              type: "string",
              description: "Note content",
            },
            isPublic: {
              type: "boolean",
              description: "Whether the note is visible to the client (default: false)",
              default: false,
            },
          },
          required: ["ticketId", "content"],
        },
      },
      {
        name: "superops_tickets_log_time",
        description: "Log time spent on a ticket.",
        inputSchema: {
          type: "object",
          properties: {
            ticketId: {
              type: "string",
              description: "The ticket ID",
            },
            duration: {
              type: "number",
              description: "Time spent in minutes",
            },
            description: {
              type: "string",
              description: "Description of work performed",
            },
            workType: {
              type: "string",
              description: "Type of work (e.g., Remote Support, On-site, Phone)",
            },
            billable: {
              type: "boolean",
              description: "Whether the time is billable (default: true)",
              default: true,
            },
          },
          required: ["ticketId", "duration"],
        },
      },
    ],

    async handleCall(name, args) {
      const client = getClient();

      try {
        switch (name) {
          case "superops_tickets_list": {
            const params = args as {
              status?: string[];
              priority?: string[];
              clientId?: string;
              assigneeId?: string;
              unassigned?: boolean;
              max?: number;
              page?: number;
            };

            // If no filters provided, elicit a date range from the user
            const hasFilters =
              params.status ||
              params.priority ||
              params.clientId ||
              params.assigneeId ||
              params.unassigned;

            if (!hasFilters && !params.page) {
              const statusChoice = await elicitText(
                "No filters specified. Would you like to narrow by ticket status?",
                "status",
                `Enter status (${VALID_TICKET_STATUSES.join(", ")}) or leave blank for all`
              );
              if (statusChoice) {
                params.status = statusChoice.split(",").map((s) => s.trim());
              }
            }

            if (params.status) {
              const invalidStatuses = invalidValues(params.status, VALID_TICKET_STATUSES);
              if (invalidStatuses.length > 0) {
                return errorResult(
                  `Invalid ticket status(es): ${invalidStatuses.join(", ")}`
                );
              }
            }

            const response = await client.query<ListTicketsResponse>(LIST_TICKETS_QUERY, {
              // TODO: Replace local filtering with ListInfoInput.condition after
              // SuperOps documents per-list condition operators and attributes.
              input: pageInput(params.max, params.page),
            });
            response.getTicketList.tickets = applyTicketFilters(
              response.getTicketList.tickets,
              params
            );

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(response.getTicketList, null, 2),
                },
              ],
            };
          }

          case "superops_tickets_get": {
            const { ticketId } = args as { ticketId: string };

            const response = await client.query<GetTicketResponse>(GET_TICKET_QUERY, {
              input: { ticketId },
            });

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(response.getTicket, null, 2),
                },
              ],
            };
          }

          case "superops_tickets_conversation_list": {
            const { ticketId } = args as { ticketId: string };

            const response = await client.query<GetTicketConversationListResponse>(
              GET_TICKET_CONVERSATION_LIST_QUERY,
              { input: { ticketId } }
            );

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(response.getTicketConversationList, null, 2),
                },
              ],
            };
          }

          case "superops_tickets_notes_list": {
            const { ticketId } = args as { ticketId: string };

            const response = await client.query<GetTicketNoteListResponse>(
              GET_TICKET_NOTE_LIST_QUERY,
              { input: { ticketId } }
            );

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(response.getTicketNoteList, null, 2),
                },
              ],
            };
          }

          case "superops_tickets_create": {
            const params = args as {
              subject: string;
              description?: string;
              clientId: string;
              priority?: string;
              requesterEmail?: string;
              techGroupName?: string;
              categoryName?: string;
            };

            if (
              params.categoryName &&
              invalidValues([params.categoryName], VALID_TICKET_CATEGORIES).length > 0
            ) {
              return errorResult(`Invalid ticket category: ${params.categoryName}`);
            }

            const input: Record<string, unknown> = {
              subject: params.subject,
              client: { accountId: params.clientId },
              status: DEFAULT_CREATE_TICKET_STATUS,
              requestType: "Incident",
              source: "FORM",
            };
            if (params.description) input.description = params.description;
            // Priority appears to require a SuperOps priority ID, not a friendly label.
            // Leave it unset until priority ID mapping is implemented.
            if (params.categoryName) input.category = params.categoryName;
            // TODO: Map requesterEmail and techGroupName only after IDs can be
            // resolved safely to ClientUserIdentifierInput and TechnicianGroupIdentifierInput.

            const response = await client.mutate<CreateTicketResponse>(
              CREATE_TICKET_MUTATION,
              { input }
            );

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(response.createTicket, null, 2),
                },
              ],
            };
          }

          case "superops_tickets_update": {
            const params = args as {
              ticketId: string;
              status?: string;
              priority?: string;
              assigneeId?: string;
              techGroupName?: string;
              resolution?: string;
            };

            const input: Record<string, unknown> = { ticketId: params.ticketId };
            if (
              params.status &&
              invalidValues([params.status], VALID_TICKET_STATUSES).length > 0
            ) {
              return errorResult(`Invalid ticket status: ${params.status}`);
            }
            if (params.status) input.status = params.status;
            // Priority appears to require a SuperOps priority ID, not a friendly label.
            // Leave it unset until priority ID mapping is implemented.
            if (params.assigneeId) input.technician = { userId: params.assigneeId };
            // TODO: Map techGroupName and resolution only after a documented
            // name-to-ID lookup or resolution-code workflow is available.

            const response = await client.mutate<UpdateTicketResponse>(
              UPDATE_TICKET_MUTATION,
              { input }
            );

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(response.updateTicket, null, 2),
                },
              ],
            };
          }

          case "superops_tickets_add_note": {
            const params = args as {
              ticketId: string;
              content: string;
              isPublic?: boolean;
            };

            const response = await client.mutate<AddNoteResponse>(ADD_TICKET_NOTE_MUTATION, {
              input: {
                ticket: { ticketId: params.ticketId },
                content: params.content,
                privacyType: params.isPublic ? "PUBLIC" : "PRIVATE",
              },
            });

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(response.createTicketNote, null, 2),
                },
              ],
            };
          }

          case "superops_tickets_log_time": {
            const params = args as {
              ticketId: string;
              duration: number;
              description?: string;
              workType?: string;
              billable?: boolean;
            };

            const response = await client.mutate<AddTimeEntryResponse>(
              ADD_TIME_ENTRY_MUTATION,
              {
                input: [
                  {
                    workItem: { workId: params.ticketId, module: "TICKET" },
                    qty: String(params.duration / 60),
                    billDateTime: new Date().toISOString(),
                    notes: params.description,
                    billable: params.billable ?? true,
                    afterHours: false,
                    // TODO: Map workType to ServiceItemIdentifierInput only after
                    // a documented service-item lookup is added.
                  },
                ],
              }
            );

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(response.createWorklogEntries, null, 2),
                },
              ],
            };
          }

          default:
            return {
              content: [{ type: "text", text: `Unknown tickets tool: ${name}` }],
              isError: true,
            };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  };
}
