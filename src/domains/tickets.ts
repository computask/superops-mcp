/**
 * SuperOps.ai Tickets Domain
 *
 * Tools for managing service tickets in SuperOps.ai PSA.
 */

import { getClient } from "../client.js";
import type {
  DomainTools,
  Client,
  Ticket,
  TicketConversation,
  TicketNote,
  TechGroup,
  TimeEntry,
  ListInfo,
  ListInfoInput,
  SuperOpsField,
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
const DEFAULT_RESOLVE_TICKET_STATUS = "Resolved";
const DEFAULT_RECENT_TICKETS_COUNT = 10;
const MIN_RECENT_TICKETS_COUNT = 1;
const MAX_RECENT_TICKETS_COUNT = 50;
const MAX_RECENT_TICKETS_WITH_CONTENT = 10;
const DISPLAY_ID_EQUALS_OPERATOR = "is";
const TICKET_FIELD_MODULE = "TICKET";
const CLIENT_LOOKUP_PAGE_SIZE = 200;

const CLIENT_NAME_ALIASES: Record<string, string> = {
  "task group": "TaskGroup",
  taskgroup: "TaskGroup",
  computask: "TaskGroup",
};

const VALIDATED_TICKET_OPTION_FIELDS = [
  "priority",
  "impact",
  "resolutionCode",
  "cause",
  "subcategory",
] as const;

type ValidatedTicketOptionField =
  (typeof VALIDATED_TICKET_OPTION_FIELDS)[number];

const TICKET_OPTION_FIELD_LABELS: Record<ValidatedTicketOptionField, string> = {
  priority: "priority",
  impact: "impact",
  resolutionCode: "resolution code",
  cause: "cause",
  subcategory: "subcategory",
};

const FALLBACK_PARENT_FIELDS: Partial<
  Record<ValidatedTicketOptionField, keyof TicketClassificationParams>
> = {
  subcategory: "category",
};

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

const GET_TICKET_FIELDS_QUERY = `
  query getFields($input: [FieldIdentifierInput!]!) {
    getFields(input: $input) {
      id
      module
      columnName
      label
      options {
        id
        value
        description
        parentOption {
          id
          value
          description
        }
      }
      parentField {
        id
        columnName
        label
      }
    }
  }
`;

const LIST_CLIENTS_QUERY = `
  query getClientList($input: ListInfoInput!) {
    getClientList(input: $input) {
      clients {
        accountId
        name
        status
        stage
        emailDomains
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

const LIST_TECH_GROUPS_QUERY = `
  query getTechnicianGroupList {
    getTechnicianGroupList {
      groupId
      name
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
      impact
      category
      subcategory
      cause
      subcause
      resolutionCode
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

interface GetTicketFieldsResponse {
  getFields: SuperOpsField[] | SuperOpsField;
}

interface ListClientsResponse {
  getClientList: {
    clients: Client[];
    listInfo: ListInfo;
  };
}

interface ListTechGroupsResponse {
  getTechnicianGroupList: TechGroup[];
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

type SuperOpsClientInstance = ReturnType<typeof getClient>;

interface TicketClassificationParams {
  status?: string;
  priority?: string;
  impact?: string;
  resolutionCode?: string;
  category?: string;
  cause?: string;
  subcategory?: string;
}

interface UpdateTicketParams extends TicketClassificationParams {
  ticketId: string;
  assigneeId?: string;
  techGroupName?: string;
  resolution?: string;
}

interface ResolveFullParams extends TicketClassificationParams {
  ticketNumber?: string;
  ticketId?: string;
  clientName?: string;
  clientId?: string;
  note?: string;
  isPublicNote?: boolean;
  techGroupName?: string;
  suppressCloseNotification?: boolean;
  verify?: boolean;
}

function pageInput(max: number | undefined, page?: number) {
  return {
    page: page ?? DEFAULT_LIST_PAGE,
    pageSize: Math.min(max ?? 50, 500),
  };
}

function clampRecentTicketCount(count: unknown): number {
  if (typeof count !== "number" || !Number.isFinite(count)) {
    return DEFAULT_RECENT_TICKETS_COUNT;
  }

  return Math.min(
    MAX_RECENT_TICKETS_COUNT,
    Math.max(MIN_RECENT_TICKETS_COUNT, Math.trunc(count))
  );
}

function buildRecentTicketsInput(count: number): ListInfoInput {
  return {
    page: 1,
    pageSize: count,
    sort: [{ attribute: "createdTime", order: "DESC" }],
  };
}

function normaliseTicketNumber(ticketNumber: unknown): string {
  if (typeof ticketNumber !== "string" && typeof ticketNumber !== "number") {
    return "";
  }

  return String(ticketNumber).trim().replace(/^#/, "").trim();
}

function buildDisplayIdLookupInput(displayId: string): ListInfoInput {
  return {
    page: 1,
    pageSize: 5,
    condition: {
      attribute: "displayId",
      operator: DISPLAY_ID_EQUALS_OPERATOR,
      value: displayId,
    },
  };
}

async function getTicketByInternalId(
  client: SuperOpsClientInstance,
  ticketId: string
): Promise<Ticket> {
  const response = await client.query<GetTicketResponse>(GET_TICKET_QUERY, {
    input: { ticketId },
  });

  return response.getTicket;
}

async function getTicketConversations(
  client: SuperOpsClientInstance,
  ticketId: string
): Promise<TicketConversation[]> {
  const response = await client.query<GetTicketConversationListResponse>(
    GET_TICKET_CONVERSATION_LIST_QUERY,
    { input: { ticketId } }
  );

  return response.getTicketConversationList;
}

async function getTicketNotes(
  client: SuperOpsClientInstance,
  ticketId: string
): Promise<TicketNote[]> {
  const response = await client.query<GetTicketNoteListResponse>(
    GET_TICKET_NOTE_LIST_QUERY,
    { input: { ticketId } }
  );

  return response.getTicketNoteList;
}

async function resolveTicketIdByDisplayId(
  client: SuperOpsClientInstance,
  displayId: string
): Promise<Ticket[]> {
  const response = await client.query<ListTicketsResponse>(LIST_TICKETS_QUERY, {
    input: buildDisplayIdLookupInput(displayId),
  });

  return response.getTicketList.tickets;
}

async function withTicketContent<T extends Ticket>(
  client: SuperOpsClientInstance,
  ticket: T
): Promise<T & { conversations: TicketConversation[]; notes: TicketNote[] }> {
  const [conversations, notes] = await Promise.all([
    getTicketConversations(client, ticket.ticketId),
    getTicketNotes(client, ticket.ticketId),
  ]);

  return { ...ticket, conversations, notes };
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

function normalizeClientName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function canonicalClientName(value: string): string {
  const normalized = normalizeClientName(value);
  return CLIENT_NAME_ALIASES[normalized] ?? value.trim();
}

function requestedValidatedOptionFields(
  params: TicketClassificationParams,
  allowedFields: readonly ValidatedTicketOptionField[] = VALIDATED_TICKET_OPTION_FIELDS
): ValidatedTicketOptionField[] {
  return allowedFields.filter(
    (field) => params[field] !== undefined
  );
}

function optionValues(field: SuperOpsField): string[] {
  return (field.options ?? [])
    .map((option) => option.value?.trim())
    .filter((value): value is string => Boolean(value));
}

function formatValidOptionValues(values: string[]): string {
  const visible = values.slice(0, 30).map((value) => `"${value}"`);
  const suffix = values.length > visible.length ? `, and ${values.length - visible.length} more` : "";
  return `${visible.join(", ")}${suffix}`;
}

function resolveOptionValue(
  fieldName: ValidatedTicketOptionField,
  field: SuperOpsField,
  rawValue: unknown
):
  | { value: string; option: NonNullable<SuperOpsField["options"]>[number] }
  | { error: string } {
  const label = TICKET_OPTION_FIELD_LABELS[fieldName];
  if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
    return { error: `${label} must be a non-empty string.` };
  }

  const options = (field.options ?? []).filter(
    (option) => typeof option.value === "string" && option.value.trim().length > 0
  );
  const values = optionValues(field);

  if (options.length === 0) {
    return {
      error: `SuperOps did not return valid ${label} options; cannot safely update ${fieldName}.`,
    };
  }

  const requested = rawValue.trim();
  const exact = options.find((option) => option.value?.trim() === requested);
  if (exact?.value) {
    return { value: exact.value.trim(), option: exact };
  }

  const lowered = requested.toLowerCase();
  const matches = options.filter(
    (option) => option.value?.trim().toLowerCase() === lowered
  );

  if (matches.length === 1 && matches[0].value) {
    return { value: matches[0].value.trim(), option: matches[0] };
  }

  if (matches.length > 1) {
    return {
      error: `The ${label} value "${requested}" is ambiguous. Valid values: ${formatValidOptionValues(values)}`,
    };
  }

  return {
    error: `Invalid ${label}: "${requested}". Valid values: ${formatValidOptionValues(values)}`,
  };
}

function validateOptionDependency(
  params: TicketClassificationParams,
  fieldName: ValidatedTicketOptionField,
  field: SuperOpsField,
  resolvedOption: NonNullable<SuperOpsField["options"]>[number]
): string | undefined {
  const parentValue = resolvedOption.parentOption?.value?.trim();
  if (!parentValue) {
    return undefined;
  }

  const parentFieldName =
    field.parentField?.columnName ?? FALLBACK_PARENT_FIELDS[fieldName];
  if (!parentFieldName) {
    return `SuperOps returned a parent option for ${TICKET_OPTION_FIELD_LABELS[fieldName]} but did not identify the parent field; cannot safely update ${fieldName}.`;
  }

  const rawParent = (params as unknown as Record<string, unknown>)[parentFieldName];
  if (typeof rawParent !== "string" || rawParent.trim().length === 0) {
    return `${TICKET_OPTION_FIELD_LABELS[fieldName]} "${resolvedOption.value}" depends on ${parentFieldName} "${parentValue}". Include ${parentFieldName} in the same update so the option dependency can be validated.`;
  }

  if (rawParent.trim().toLowerCase() !== parentValue.toLowerCase()) {
    return `${TICKET_OPTION_FIELD_LABELS[fieldName]} "${resolvedOption.value}" belongs under ${parentFieldName} "${parentValue}", not "${rawParent.trim()}".`;
  }
}

async function getTicketOptionFields(
  client: SuperOpsClientInstance,
  fieldNames: ValidatedTicketOptionField[]
): Promise<Map<ValidatedTicketOptionField, SuperOpsField>> {
  const response = await client.query<GetTicketFieldsResponse>(
    GET_TICKET_FIELDS_QUERY,
    {
      input: fieldNames.map((columnName) => ({
        module: TICKET_FIELD_MODULE,
        columnName,
      })),
    }
  );

  const returnedFields = Array.isArray(response.getFields)
    ? response.getFields
    : response.getFields
      ? [response.getFields]
      : [];
  const requested = new Set<string>(fieldNames);
  const byName = new Map<ValidatedTicketOptionField, SuperOpsField>();

  for (const field of returnedFields) {
    if (field.columnName && requested.has(field.columnName)) {
      byName.set(field.columnName as ValidatedTicketOptionField, field);
    }
  }

  return byName;
}

async function addValidatedTicketOptionUpdates(
  client: SuperOpsClientInstance,
  params: TicketClassificationParams,
  input: Record<string, unknown>,
  allowedFields: readonly ValidatedTicketOptionField[] = VALIDATED_TICKET_OPTION_FIELDS
): Promise<string | undefined> {
  const fieldsToValidate = requestedValidatedOptionFields(params, allowedFields);
  if (fieldsToValidate.length === 0) {
    return undefined;
  }

  const fields = await getTicketOptionFields(client, fieldsToValidate);

  for (const fieldName of fieldsToValidate) {
    const field = fields.get(fieldName);
    if (!field) {
      return `SuperOps did not return field metadata for ${TICKET_OPTION_FIELD_LABELS[fieldName]} via getFields; cannot safely update ${fieldName}.`;
    }

    const resolved = resolveOptionValue(fieldName, field, params[fieldName]);
    if ("error" in resolved) {
      return resolved.error;
    }

    const dependencyError = validateOptionDependency(
      params,
      fieldName,
      field,
      resolved.option
    );
    if (dependencyError) {
      return dependencyError;
    }

    input[fieldName] = resolved.value;
  }
}

async function resolveTicketId(
  client: SuperOpsClientInstance,
  params: { ticketId?: string; ticketNumber?: string }
): Promise<{ ticketId?: string; error?: string }> {
  if (typeof params.ticketId === "string" && params.ticketId.trim().length > 0) {
    return { ticketId: params.ticketId.trim() };
  }

  const displayId = normaliseTicketNumber(params.ticketNumber);
  if (!displayId) {
    return { error: "Either ticketId or ticketNumber is required." };
  }

  const matches = await resolveTicketIdByDisplayId(client, displayId);
  if (matches.length === 0) {
    return { error: `No ticket was found for display number ${displayId}.` };
  }

  if (matches.length > 1) {
    const matchSummary = matches.map((ticket) => ({
      ticketId: ticket.ticketId,
      displayId: ticket.displayId,
      subject: ticket.subject,
    }));
    return {
      error: `Display number ${displayId} was not unique. Matching tickets: ${JSON.stringify(matchSummary)}`,
    };
  }

  return { ticketId: matches[0].ticketId };
}

async function resolveClientAccountId(
  client: SuperOpsClientInstance,
  params: { clientId?: string; clientName?: string }
): Promise<{ accountId?: string; name?: string; error?: string }> {
  if (typeof params.clientId === "string" && params.clientId.trim().length > 0) {
    return { accountId: params.clientId.trim() };
  }

  if (typeof params.clientName !== "string" || params.clientName.trim().length === 0) {
    return {};
  }

  const canonicalName = canonicalClientName(params.clientName);
  const normalizedTarget = normalizeClientName(canonicalName);
  const response = await client.query<ListClientsResponse>(LIST_CLIENTS_QUERY, {
    input: {
      page: 1,
      pageSize: CLIENT_LOOKUP_PAGE_SIZE,
    },
  });

  const exactMatches = response.getClientList.clients.filter(
    (candidate) => normalizeClientName(candidate.name) === normalizedTarget
  );

  if (exactMatches.length === 1) {
    return {
      accountId: exactMatches[0].accountId,
      name: exactMatches[0].name,
    };
  }

  if (exactMatches.length > 1) {
    return {
      error: `Multiple clients matched "${canonicalName}": ${JSON.stringify(
        exactMatches.map((candidate) => ({
          accountId: candidate.accountId,
          name: candidate.name,
        }))
      )}`,
    };
  }

  return { error: `No client matched "${canonicalName}".` };
}

async function resolveTechGroup(
  client: SuperOpsClientInstance,
  techGroupName: string | undefined
): Promise<{ groupId?: string; name?: string; error?: string }> {
  if (typeof techGroupName !== "string" || techGroupName.trim().length === 0) {
    return {};
  }

  const requested = techGroupName.trim().toLowerCase();
  const response = await client.query<ListTechGroupsResponse>(LIST_TECH_GROUPS_QUERY);
  const matches = response.getTechnicianGroupList.filter(
    (group) => group.name.trim().toLowerCase() === requested
  );

  if (matches.length === 1) {
    return {
      groupId: matches[0].groupId,
      name: matches[0].name,
    };
  }

  if (matches.length > 1) {
    return {
      error: `Multiple technician groups matched "${techGroupName.trim()}": ${JSON.stringify(
        matches.map((group) => ({
          groupId: group.groupId,
          name: group.name,
        }))
      )}`,
    };
  }

  return { error: `No technician group matched "${techGroupName.trim()}".` };
}

async function createTicketNote(
  client: SuperOpsClientInstance,
  ticketId: string,
  content: string,
  isPublic = false
): Promise<TicketNote> {
  const response = await client.mutate<AddNoteResponse>(ADD_TICKET_NOTE_MUTATION, {
    input: {
      ticket: { ticketId },
      content,
      privacyType: isPublic ? "PUBLIC" : "PRIVATE",
    },
  });

  return response.createTicketNote;
}

function ticketSummary(ticket: Ticket, latestNote?: TicketNote) {
  return {
    ticketId: ticket.ticketId,
    displayId: ticket.displayId,
    subject: ticket.subject,
    client: ticket.client,
    status: ticket.status,
    priority: ticket.priority,
    impact: ticket.impact,
    category: ticket.category,
    subcategory: ticket.subcategory,
    cause: ticket.cause,
    resolutionCode: ticket.resolutionCode,
    techGroup: ticket.techGroup,
    technician: ticket.technician,
    latestNoteSummary: latestNote
      ? {
          noteId: latestNote.noteId,
          addedOn: latestNote.addedOn,
          privacyType: latestNote.privacyType,
          contentPreview: latestNote.content.slice(0, 160),
        }
      : undefined,
  };
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
        name: "superops_tickets_recent",
        description:
          "List the most recently created tickets, sorted by createdTime descending.",
        inputSchema: {
          type: "object",
          properties: {
            count: {
              type: "number",
              description: "Number of recent tickets to return (default: 10, max: 50)",
              default: DEFAULT_RECENT_TICKETS_COUNT,
            },
            includeContent: {
              type: "boolean",
              description:
                "Include ticket conversations and notes. Limited to 10 tickets.",
              default: false,
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
        name: "superops_tickets_get_by_number",
        description:
          "Get detailed ticket information by visible SuperOps display number, such as 57072 or #57072.",
        inputSchema: {
          type: "object",
          properties: {
            ticketNumber: {
              oneOf: [{ type: "string" }, { type: "number" }],
              description: "The visible SuperOps ticket number or display ID",
            },
            includeContent: {
              type: "boolean",
              description: "Include ticket conversations and notes",
              default: false,
            },
          },
          required: ["ticketNumber"],
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
        name: "superops_tickets_resolve_full",
        description:
          "Resolve or fully classify a ticket by ticket number or internal ticket ID, optionally adding a note, client, technician group, and final classification values before verifying the final state.",
        inputSchema: {
          type: "object",
          properties: {
            ticketNumber: {
              type: "string",
              description: "Visible SuperOps ticket number or display ID, such as 57100 or #57100",
            },
            ticketId: {
              type: "string",
              description: "Internal SuperOps ticket ID. Preferred over ticketNumber when both are supplied.",
            },
            clientName: {
              type: "string",
              description:
                "Client display name. Aliases supported: Task Group, taskgroup, computask.",
            },
            clientId: {
              type: "string",
              description: "Client account ID. Used directly when supplied.",
            },
            status: {
              type: "string",
              description: "Final ticket status. Defaults to Resolved.",
              default: DEFAULT_RESOLVE_TICKET_STATUS,
            },
            priority: {
              type: "string",
              description:
                "Priority display name. Validated against SuperOps ticket field options before update.",
            },
            impact: {
              type: "string",
              description:
                "Impact display name. Validated against SuperOps ticket field options before update.",
            },
            category: {
              type: "string",
              description:
                `Configured top-level ticket category: ${VALID_TICKET_CATEGORIES.join(", ")}`,
              enum: [...VALID_TICKET_CATEGORIES],
            },
            subcategory: {
              type: "string",
              description:
                "Subcategory display name. Include category when SuperOps marks the subcategory as dependent on a parent category.",
            },
            cause: {
              type: "string",
              description:
                "Cause display name. Validated against SuperOps ticket field options before update.",
            },
            resolutionCode: {
              type: "string",
              description:
                "Resolution code display name. Validated against SuperOps ticket field options before update.",
            },
            note: {
              type: "string",
              description: "Optional note to add before resolving the ticket.",
            },
            isPublicNote: {
              type: "boolean",
              description: "Whether the optional note is client-visible. Defaults to false.",
              default: false,
            },
            techGroupName: {
              type: "string",
              description: "Technician group name to resolve and assign before closing.",
            },
            suppressCloseNotification: {
              type: "boolean",
              description: "Suppress the close notification email. Defaults to true.",
              default: true,
            },
            verify: {
              type: "boolean",
              description: "Re-read the ticket after update and return the final state. Defaults to true.",
              default: true,
            },
          },
        },
      },
      {
        name: "superops_tickets_update",
        description:
          "Update an existing ticket - change status, assignment, impact, category, cause, subcategory, or resolution code.",
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
            impact: {
              type: "string",
              description:
                "Impact name. Validated against SuperOps ticket field options before update.",
            },
            resolutionCode: {
              type: "string",
              description:
                "Resolution code name. Validated against SuperOps ticket field options before update.",
            },
            category: {
              type: "string",
              description:
                `Configured top-level ticket category: ${VALID_TICKET_CATEGORIES.join(", ")}`,
              enum: [...VALID_TICKET_CATEGORIES],
            },
            cause: {
              type: "string",
              description:
                "Cause name. Validated against SuperOps ticket field options before update.",
            },
            subcategory: {
              type: "string",
              description:
                "Subcategory name. Validated against SuperOps ticket field options before update. Include category when SuperOps marks the subcategory as dependent on a parent category.",
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

          case "superops_tickets_recent": {
            const params = args as { count?: number; includeContent?: boolean };
            const count = clampRecentTicketCount(params.count);

            if (params.includeContent && count > MAX_RECENT_TICKETS_WITH_CONTENT) {
              return errorResult(
                `includeContent is limited to ${MAX_RECENT_TICKETS_WITH_CONTENT} tickets. Reduce count before requesting ticket conversations and notes.`
              );
            }

            let response: ListTicketsResponse;
            try {
              response = await client.query<ListTicketsResponse>(LIST_TICKETS_QUERY, {
                input: buildRecentTicketsInput(count),
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              return errorResult(
                `createdTime sort was rejected by SuperOps while fetching recent tickets: ${message}`
              );
            }

            const tickets = params.includeContent
              ? await Promise.all(
                  response.getTicketList.tickets.map((ticket) =>
                    withTicketContent(client, ticket)
                  )
                )
              : response.getTicketList.tickets;

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    { tickets, listInfo: response.getTicketList.listInfo },
                    null,
                    2
                  ),
                },
              ],
            };
          }

          case "superops_tickets_get": {
            const { ticketId } = args as { ticketId: string };

            const ticket = await getTicketByInternalId(client, ticketId);

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(ticket, null, 2),
                },
              ],
            };
          }

          case "superops_tickets_get_by_number": {
            const params = args as {
              ticketNumber?: string | number;
              includeContent?: boolean;
            };
            const displayId = normaliseTicketNumber(params.ticketNumber);

            if (!displayId) {
              return errorResult("ticketNumber is required and cannot be empty.");
            }

            const matches = await resolveTicketIdByDisplayId(client, displayId);

            if (matches.length === 0) {
              return errorResult(`No ticket was found for display number ${displayId}.`);
            }

            if (matches.length > 1) {
              const matchSummary = matches.map((ticket) => ({
                ticketId: ticket.ticketId,
                displayId: ticket.displayId,
                subject: ticket.subject,
              }));
              return errorResult(
                `Display number ${displayId} was not unique. Matching tickets: ${JSON.stringify(matchSummary)}`
              );
            }

            const ticket = await getTicketByInternalId(client, matches[0].ticketId);
            const result = params.includeContent
              ? await withTicketContent(client, ticket)
              : ticket;

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          }

          case "superops_tickets_conversation_list": {
            const { ticketId } = args as { ticketId: string };

            const conversations = await getTicketConversations(client, ticketId);

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(conversations, null, 2),
                },
              ],
            };
          }

          case "superops_tickets_notes_list": {
            const { ticketId } = args as { ticketId: string };

            const notes = await getTicketNotes(client, ticketId);

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(notes, null, 2),
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

          case "superops_tickets_resolve_full": {
            const params = args as ResolveFullParams;

            const resolvedTicket = await resolveTicketId(client, {
              ticketId: params.ticketId,
              ticketNumber: params.ticketNumber,
            });
            if (resolvedTicket.error || !resolvedTicket.ticketId) {
              return errorResult(
                resolvedTicket.error ?? "Either ticketId or ticketNumber is required."
              );
            }

            if (
              params.category &&
              invalidValues([params.category], VALID_TICKET_CATEGORIES).length > 0
            ) {
              return errorResult(`Invalid ticket category: ${params.category}`);
            }

            const resolvedClient = await resolveClientAccountId(client, {
              clientId: params.clientId,
              clientName: params.clientName,
            });
            if (resolvedClient.error) {
              return errorResult(resolvedClient.error);
            }

            const resolvedTechGroup = await resolveTechGroup(
              client,
              params.techGroupName
            );
            if (resolvedTechGroup.error) {
              return errorResult(resolvedTechGroup.error);
            }

            const updateInput: Record<string, unknown> = {
              ticketId: resolvedTicket.ticketId,
              status: params.status ?? DEFAULT_RESOLVE_TICKET_STATUS,
              suppressCloseNotification: params.suppressCloseNotification ?? true,
            };

            if (
              updateInput.status &&
              typeof updateInput.status === "string" &&
              invalidValues([updateInput.status], VALID_TICKET_STATUSES).length > 0
            ) {
              return errorResult(`Invalid ticket status: ${updateInput.status}`);
            }

            if (params.category) {
              updateInput.category = params.category;
            }

            const optionValidationError = await addValidatedTicketOptionUpdates(
              client,
              {
                priority: params.priority,
                impact: params.impact,
                category: params.category,
                subcategory: params.subcategory,
                cause: params.cause,
                resolutionCode: params.resolutionCode,
                status: params.status,
              },
              updateInput
            );
            if (optionValidationError) {
              return errorResult(optionValidationError);
            }

            if (resolvedClient.accountId) {
              updateInput.client = { accountId: resolvedClient.accountId };
            }

            if (resolvedTechGroup.groupId) {
              updateInput.techGroup = { groupId: resolvedTechGroup.groupId };
            }

            let createdNote: TicketNote | undefined;
            if (typeof params.note === "string" && params.note.trim().length > 0) {
              createdNote = await createTicketNote(
                client,
                resolvedTicket.ticketId,
                params.note,
                params.isPublicNote ?? false
              );
            }

            let updateResponse: UpdateTicketResponse;
            try {
              updateResponse = await client.mutate<UpdateTicketResponse>(
                UPDATE_TICKET_MUTATION,
                { input: updateInput }
              );
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              if (createdNote) {
                return {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify(
                        {
                          partialFailure: true,
                          ticketId: resolvedTicket.ticketId,
                          noteAdded: {
                            noteId: createdNote.noteId,
                            addedOn: createdNote.addedOn,
                            privacyType: createdNote.privacyType,
                          },
                          updateError: message,
                        },
                        null,
                        2
                      ),
                    },
                  ],
                  isError: true,
                };
              }

              throw error;
            }

            if (params.verify === false) {
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(
                      createdNote
                        ? {
                            noteAdded: {
                              noteId: createdNote.noteId,
                              addedOn: createdNote.addedOn,
                              privacyType: createdNote.privacyType,
                            },
                            update: updateResponse.updateTicket,
                          }
                        : updateResponse.updateTicket,
                      null,
                      2
                    ),
                  },
                ],
              };
            }

            const verifiedTicket = await getTicketByInternalId(
              client,
              resolvedTicket.ticketId
            );
            const latestNotes = createdNote
              ? await getTicketNotes(client, resolvedTicket.ticketId)
              : [];

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    ticketSummary(verifiedTicket, latestNotes[0] ?? createdNote),
                    null,
                    2
                  ),
                },
              ],
            };
          }

          case "superops_tickets_update": {
            const rawParams = args as Record<string, unknown>;

            if (
              typeof rawParams.ticketId !== "string" ||
              rawParams.ticketId.length === 0
            ) {
              return errorResult("ticketId is required.");
            }

            const params = rawParams as unknown as UpdateTicketParams;

            const input: Record<string, unknown> = { ticketId: params.ticketId };
            if (
              params.status &&
              invalidValues([params.status], VALID_TICKET_STATUSES).length > 0
            ) {
              return errorResult(`Invalid ticket status: ${params.status}`);
            }
            if (params.status) input.status = params.status;
            if (
              params.category &&
              invalidValues([params.category], VALID_TICKET_CATEGORIES).length > 0
            ) {
              return errorResult(`Invalid ticket category: ${params.category}`);
            }
            if (params.category) input.category = params.category;

            const optionValidationError = await addValidatedTicketOptionUpdates(
              client,
              params,
              input,
              [
                "impact",
                "resolutionCode",
                "cause",
                "subcategory",
              ] as ValidatedTicketOptionField[]
            );
            if (optionValidationError) {
              return errorResult(optionValidationError);
            }
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
