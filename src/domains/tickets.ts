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
import {
  aggregateTicketReport,
  fetchTicketsPaginated,
  type HistoricalTicketQueryParams,
  type HistoricalTicketReportParams,
} from "./ticket-reporting.js";
import {
  executionDiagnostics,
  getExecutionConfig,
  hasExecutionBudgetFor,
  markExecutionItem,
  withExecutionItem,
  ExecutionBudgetExceededError,
  ExecutionTimeoutBudgetExceededError,
} from "../execution.js";
import {
  currentOwnerHash,
  getOperationStore,
  normalizedNoteFingerprint,
  stableHash,
  type OperationItemState,
  type OperationLedgerRecord,
} from "../operation-store.js";

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
const DEFAULT_TRIAGE_SNAPSHOT_MAX = 50;
const MAX_TRIAGE_SNAPSHOT_MAX = 500;
const DEFAULT_TRIAGE_MAX_CONTENT_CHARS_PER_TICKET = 3000;
const MAX_TRIAGE_MAX_CONTENT_CHARS_PER_TICKET = 10000;
const DEFAULT_TRIAGE_MAX_ITEMS_PER_TICKET = 8;
const MAX_TRIAGE_MAX_ITEMS_PER_TICKET = 20;
const DISPLAY_ID_EQUALS_OPERATOR = "is";
const STATUS_EQUALS_OPERATOR = "is";
const STATUS_IN_OPERATOR = "in";
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
  "urgency",
  "resolutionCode",
  "cause",
  "subcategory",
] as const;

type ValidatedTicketOptionField =
  (typeof VALIDATED_TICKET_OPTION_FIELDS)[number];

const RESOLVED_REQUIRED_OPTION_FIELDS = [
  "priority",
  "impact",
  "subcategory",
  "cause",
  "resolutionCode",
] as const satisfies readonly ValidatedTicketOptionField[];

const RESOLVED_REQUIRED_FIELDS = [
  ...RESOLVED_REQUIRED_OPTION_FIELDS,
  "category",
] as const;

const TICKET_OPTION_FIELD_LABELS: Record<ValidatedTicketOptionField, string> = {
  priority: "priority",
  impact: "impact",
  urgency: "urgency",
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
      urgency
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

interface SafeTicketParams {
  ticketNumber?: string | number;
  includeDescription?: boolean;
  includeNotes?: boolean;
  includeConversations?: boolean;
  latestFirst?: boolean;
  maxItems?: number;
  maxCharsPerItem?: number;
  maxTotalChars?: number;
  redactCredentials?: boolean;
  stripHtml?: boolean;
  stripHeaders?: boolean;
  attachments?: "metadataOnly" | "none";
}

interface TriageSnapshotParams {
  status?: string[];
  max?: number;
  page?: number;
  safeRead?: boolean;
  includeNotes?: boolean;
  includeConversations?: boolean;
  includeAttachments?: "metadataOnly" | "none";
  maxContentCharsPerTicket?: number;
  maxItemsPerTicket?: number;
  latestFirst?: boolean;
  storeBatch?: boolean;
}

interface SanitizationDiagnostics {
  htmlStripped: boolean;
  headersRemoved: boolean;
  credentialsRedacted: boolean;
  base64Removed: boolean;
  attachmentsMetadataOnly: boolean;
  truncated: boolean;
  itemsReturned: number;
  itemsOmittedByLimit: number;
}

interface SafeTextResult {
  plainText: string;
  truncated: boolean;
  diagnostics: Partial<SanitizationDiagnostics> & {
    embeddedImageRemoved?: boolean;
    binaryRemoved?: boolean;
  };
}

interface SafeContentItem {
  id: string;
  type: "conversation" | "note" | "description";
  direction: "customer" | "technician" | "internal" | "unknown";
  createdTime?: string;
  author?: string;
  isInternal: boolean;
  plainText: string;
  truncated: boolean;
}

type TriageProcessingState =
  | "SnapshotRead"
  | "MetadataOnly"
  | "ContentUnavailable"
  | "ContentBlocked"
  | "NotFound"
  | "Failed";

interface NormalizedTriageSnapshotParams {
  status: string[];
  max: number;
  page: number;
  safeRead: true;
  includeNotes: boolean;
  includeConversations: boolean;
  includeAttachments: "metadataOnly" | "none";
  maxContentCharsPerTicket: number;
  maxItemsPerTicket: number;
  latestFirst: boolean;
  storeBatch: boolean;
}

interface TicketClassificationParams {
  status?: string;
  priority?: string;
  impact?: string;
  urgency?: string;
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


type TriagePlanActionType = "resolve" | "update" | "addNote" | "leave" | "skip";
type TriageFinalOutcome =
  | "Resolved"
  | "Updated"
  | "Left"
  | "Skipped"
  | "Blocked"
  | "Failed"
  | "NoApprovedAction"
  | "NotFound"
  | "SkippedChangedSinceSnapshot"
  | "FailedBeforeProcessing"
  | "NotAttemptedExecutionStopped";

interface TriagePlanAction {
  ticketNumber: string;
  expectedTicketId?: string;
  expectedSubject?: string;
  expectedClient?: string;
  expectedStatus?: string;
  expectedUpdatedTime?: string;
  contentVerified?: boolean;
  action: TriagePlanActionType;
  reason?: string;
  note?: string;
  isPublicNote?: boolean;
  target?: TicketClassificationParams & {
    techGroupName?: string;
    clientName?: string;
    clientId?: string;
    suppressCloseNotification?: boolean;
  };
  allowResolveFullFallbackToUpdate?: boolean;
  allowWriteIfUpdatedTimeChanged?: boolean;
  allowWriteWithoutVerifiedContent?: boolean;
}

interface ApplyTriagePlanParams {
  batchId?: string;
  expectedCandidateTicketNumbers?: string[];
  actions?: TriagePlanAction[];
  dryRun?: boolean;
  verify?: boolean;
  dedupeNotes?: boolean;
  stopOnFirstFailure?: boolean;
  allowResolveFullFallbackToUpdate?: boolean;
  allowWriteIfUpdatedTimeChanged?: boolean;
  allowWriteWithoutVerifiedContent?: boolean;
}

interface ApplyTriagePlanResult {
  ticketNumber: string;
  ticketId?: string;
  subject?: string;
  client?: string;
  requestedAction?: TriagePlanActionType;
  finalOutcome: TriageFinalOutcome;
  writeAttempted: boolean;
  writeMethod?: string | null;
  noteAdded: boolean;
  noteDeduped: boolean;
  verified: boolean;
  finalState?: Record<string, unknown> | null;
  failureStage?: string | null;
  failureReason?: string | null;
  fallbackAttempted: boolean;
  fallbackResult?: string | null;
  partialWrite: boolean;
  requestedState?: Record<string, unknown> | null;
  attemptedState?: Record<string, unknown> | null;
  observedFinalState?: Record<string, unknown> | null;
  verifiedState?: Record<string, unknown> | null;
}
interface StructuredValidationFailure {
  ok: false;
  message: string;
  missingFields: string[];
  invalidFields: Record<string, string>;
  validOptions: Record<string, string[]>;
}

function pageInput(max: number | undefined, page?: number) {
  return {
    page: page ?? DEFAULT_LIST_PAGE,
    pageSize: Math.min(max ?? 50, 500),
  };
}

function buildStatusCondition(statuses: string[]): ListInfoInput["condition"] {
  if (statuses.length === 1) {
    return {
      attribute: "status",
      operator: STATUS_EQUALS_OPERATOR,
      value: statuses[0],
    };
  }

  return {
    attribute: "status",
    operator: STATUS_IN_OPERATOR,
    value: statuses,
  };
}

function buildTicketListInput(params: {
  max?: number;
  page?: number;
  status?: string[];
}): ListInfoInput {
  const input: ListInfoInput = pageInput(params.max, params.page);
  if (params.status && params.status.length > 0) {
    input.condition = buildStatusCondition(params.status);
  }
  return input;
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

function readableString(value: unknown, keys: string[]): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  const record = jsonRecord(value);
  if (!record) {
    return undefined;
  }

  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  const first = typeof record.firstName === "string" ? record.firstName.trim() : "";
  const last = typeof record.lastName === "string" ? record.lastName.trim() : "";
  const fullName = `${first} ${last}`.trim();
  return fullName || undefined;
}

function safeTicketParams(args: SafeTicketParams): Required<SafeTicketParams> {
  const attachments =
    args.attachments === "none" || args.attachments === "metadataOnly"
      ? args.attachments
      : "metadataOnly";

  return {
    ticketNumber: args.ticketNumber ?? "",
    includeDescription: args.includeDescription ?? true,
    includeNotes: args.includeNotes ?? true,
    includeConversations: args.includeConversations ?? true,
    latestFirst: args.latestFirst ?? true,
    maxItems: Math.min(Math.max(Math.trunc(args.maxItems ?? 20), 0), 50),
    maxCharsPerItem: Math.min(
      Math.max(Math.trunc(args.maxCharsPerItem ?? 4000), 1),
      10000
    ),
    maxTotalChars: Math.min(
      Math.max(Math.trunc(args.maxTotalChars ?? 20000), 0),
      50000
    ),
    redactCredentials: args.redactCredentials ?? true,
    stripHtml: args.stripHtml ?? true,
    stripHeaders: args.stripHeaders ?? true,
    attachments,
  };
}

function triageSnapshotParams(
  args: TriageSnapshotParams
): NormalizedTriageSnapshotParams {
  const max = typeof args.max === "number" && Number.isFinite(args.max)
    ? Math.trunc(args.max)
    : DEFAULT_TRIAGE_SNAPSHOT_MAX;
  const page = typeof args.page === "number" && Number.isFinite(args.page)
    ? Math.trunc(args.page)
    : DEFAULT_LIST_PAGE;
  const maxContentCharsPerTicket =
    typeof args.maxContentCharsPerTicket === "number" &&
    Number.isFinite(args.maxContentCharsPerTicket)
      ? Math.trunc(args.maxContentCharsPerTicket)
      : DEFAULT_TRIAGE_MAX_CONTENT_CHARS_PER_TICKET;
  const maxItemsPerTicket =
    typeof args.maxItemsPerTicket === "number" && Number.isFinite(args.maxItemsPerTicket)
      ? Math.trunc(args.maxItemsPerTicket)
      : DEFAULT_TRIAGE_MAX_ITEMS_PER_TICKET;
  const includeAttachments = args.includeAttachments === "none"
    ? "none"
    : "metadataOnly";

  return {
    status: args.status && args.status.length > 0 ? args.status : ["New Calls"],
    max: Math.min(Math.max(max, 1), MAX_TRIAGE_SNAPSHOT_MAX),
    page: Math.max(page, 1),
    safeRead: true,
    includeNotes: args.includeNotes ?? true,
    includeConversations: args.includeConversations ?? true,
    includeAttachments,
    maxContentCharsPerTicket: Math.min(
      Math.max(maxContentCharsPerTicket, 1),
      MAX_TRIAGE_MAX_CONTENT_CHARS_PER_TICKET
    ),
    maxItemsPerTicket: Math.min(
      Math.max(maxItemsPerTicket, 0),
      MAX_TRIAGE_MAX_ITEMS_PER_TICKET
    ),
    latestFirst: args.latestFirst ?? true,
    storeBatch: false,
  };
}

function safeParamsForTriageSnapshot(
  params: NormalizedTriageSnapshotParams
): Required<SafeTicketParams> {
  return safeTicketParams({
    includeDescription: false,
    includeNotes: params.includeNotes,
    includeConversations: params.includeConversations,
    latestFirst: params.latestFirst,
    maxItems: params.maxItemsPerTicket,
    maxCharsPerItem: params.maxContentCharsPerTicket,
    maxTotalChars: params.maxContentCharsPerTicket,
    attachments: params.includeAttachments,
    redactCredentials: true,
    stripHtml: true,
    stripHeaders: true,
  });
}
function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };

  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, body: string) => {
    const lower = body.toLowerCase();
    if (lower[0] === "#") {
      const codePoint = lower[1] === "x"
        ? Number.parseInt(lower.slice(2), 16)
        : Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity;
    }
    return named[lower] ?? entity;
  });
}

function htmlToPlainText(value: string): { text: string; stripped: boolean } {
  const hadHtml = /<[^>]+>/.test(value);
  let text = value
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(
      /<(script|style|iframe|object|embed|svg|form|input|button)\b[\s\S]*?<\/\1>/gi,
      " "
    )
    .replace(
      /<(script|style|iframe|object|embed|svg|form|input|button|img)\b[^>]*\/?>/gi,
      " "
    )
    .replace(/<[^>]+\b(?:hidden|display\s*:\s*none|visibility\s*:\s*hidden)[^>]*>[\s\S]*?<\/[^>]+>/gi, " ")
    .replace(/<(br|p|div|li|tr|h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  return { text: decodeHtmlEntities(text), stripped: hadHtml };
}

function stripRawEmailHeaders(value: string): { text: string; removed: boolean } {
  const headerLine =
    /^(?:Received|DKIM-Signature|Authentication-Results|SPF|Return-Path|Message-ID|MIME-Version|Content-Type|Content-Transfer-Encoding|ARC-[A-Za-z-]+|X-[A-Za-z0-9-]+)\s*:/i;
  const lines = value.replace(/\r\n/g, "\n").split("\n");
  const kept: string[] = [];
  let removed = false;
  let inHeaderBlock = false;

  for (const line of lines) {
    if (headerLine.test(line)) {
      removed = true;
      inHeaderBlock = true;
      continue;
    }
    if (inHeaderBlock && /^[ \t]+/.test(line)) {
      removed = true;
      continue;
    }
    inHeaderBlock = false;
    kept.push(line);
  }

  return { text: kept.join("\n"), removed };
}

function redactRiskyText(
  value: string,
  redactCredentials: boolean
): {
  text: string;
  credentialsRedacted: boolean;
  base64Removed: boolean;
  embeddedImageRemoved: boolean;
  binaryRemoved: boolean;
} {
  let text = value;
  let credentialsRedacted = false;
  let base64Removed = false;
  let embeddedImageRemoved = false;
  let binaryRemoved = false;

  text = text
    .replace(/data:[^"'\s>)]+/gi, () => {
      embeddedImageRemoved = true;
      return "[removed embedded image]";
    })
    .replace(/\bcid:[^\s"'<>]+/gi, () => {
      embeddedImageRemoved = true;
      return "[removed embedded image]";
    })
    .replace(/--[A-Za-z0-9'()+_,./:=?-]{12,}[\s\S]*?(?=\n--|\n\n|$)/g, () => {
      base64Removed = true;
      return "[removed attachment body]";
    })
    .replace(/BEGIN:VCALENDAR[\s\S]*?END:VCALENDAR/gi, "[removed attachment body]")
    .replace(/BEGIN:VCARD[\s\S]*?END:VCARD/gi, "[removed attachment body]")
    .replace(/<\?xml[\s\S]*?(?:<\/[A-Za-z][^>]*>|$)/gi, "[removed attachment body]");

  text = text.replace(/\b[A-Za-z0-9+/]{120,}={0,2}\b/g, () => {
    base64Removed = true;
    return "[removed base64 content]";
  });

  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) {
    binaryRemoved = true;
    text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]+/g, "[removed binary-like content]");
  }

  if (redactCredentials) {
    const patterns: RegExp[] = [
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
      /\b(?:password|passwd|pwd|passcode|secret|client_secret|api[_-]?key|api[_-]?token|access[_-]?token|refresh[_-]?token|authorization)\b\s*[:=]\s*["']?[^"'\s,;]+/gi,
      /\b[A-Fa-f0-9]{48,}\b/g,
    ];

    for (const pattern of patterns) {
      text = text.replace(pattern, () => {
        credentialsRedacted = true;
        return "[redacted credential/token]";
      });
    }
  }

  return {
    text,
    credentialsRedacted,
    base64Removed,
    embeddedImageRemoved,
    binaryRemoved,
  };
}

function normalizePlainText(value: string): string {
  return value
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncateSafeText(value: string, maxChars: number): {
  text: string;
  truncated: boolean;
} {
  if (value.length <= maxChars) {
    return { text: value, truncated: false };
  }

  const marker = "\n\n[... content truncated by safe retrieval ...]\n\n";
  const available = Math.max(0, maxChars - marker.length);
  const firstLength = Math.floor(available * 0.75);
  const lastLength = available - firstLength;
  return {
    text: `${value.slice(0, firstLength)}${marker}${value.slice(value.length - lastLength)}`,
    truncated: true,
  };
}

function sanitizeTicketText(
  value: unknown,
  params: Required<SafeTicketParams>
): SafeTextResult {
  let text = typeof value === "string" ? value : "";
  let htmlStripped = false;
  let headersRemoved = false;

  if (params.stripHtml) {
    const html = htmlToPlainText(text);
    text = html.text;
    htmlStripped = html.stripped;
  }

  if (params.stripHeaders) {
    const headers = stripRawEmailHeaders(text);
    text = headers.text;
    headersRemoved = headers.removed;
  }

  const redacted = redactRiskyText(text, params.redactCredentials);
  const truncated = truncateSafeText(
    normalizePlainText(redacted.text),
    params.maxCharsPerItem
  );

  return {
    plainText: truncated.text,
    truncated: truncated.truncated,
    diagnostics: {
      htmlStripped,
      headersRemoved,
      credentialsRedacted: redacted.credentialsRedacted,
      base64Removed: redacted.base64Removed,
      embeddedImageRemoved: redacted.embeddedImageRemoved,
      binaryRemoved: redacted.binaryRemoved,
      truncated: truncated.truncated,
    },
  };
}

function safeAttachmentMetadata(attachments: unknown): {
  filename?: string;
  contentType?: string;
  size?: number | string;
}[] {
  if (!Array.isArray(attachments)) {
    return [];
  }

  return attachments
    .map((attachment): {
      filename?: string;
      contentType?: string;
      size?: number | string;
    } | undefined => {
      const record = jsonRecord(attachment);
      if (!record) {
        return undefined;
      }
      const filename = readableString(record.originalFileName, []) ??
        readableString(record.fileName, []) ??
        readableString(record.filename, []) ??
        readableString(record.name, []);
      const contentType = readableString(record.contentType, []) ??
        readableString(record.mimeType, []);
      const size = record.fileSize ?? record.size;
      return {
        filename,
        contentType,
        size: typeof size === "number" || typeof size === "string" ? size : undefined,
      };
    })
    .filter((attachment): attachment is {
      filename?: string;
      contentType?: string;
      size?: number | string;
    } => Boolean(attachment?.filename || attachment?.contentType || attachment?.size));
}

function conversationDirection(
  conversation: TicketConversation
): SafeContentItem["direction"] {
  const type = conversation.type?.toLowerCase() ?? "";
  if (type === "description") return "customer";
  if (type.includes("req") || type.includes("customer")) return "customer";
  if (type.includes("tech") || type.includes("reply")) return "technician";
  return "unknown";
}

function safeContentTypeForConversation(
  conversation: TicketConversation
): SafeContentItem["type"] {
  return conversation.type?.toUpperCase() === "DESCRIPTION"
    ? "description"
    : "conversation";
}

function noteDirection(note: TicketNote): SafeContentItem["direction"] {
  return note.privacyType === "PRIVATE" ? "internal" : "technician";
}

function timestampOf(item: SafeContentItem): string {
  return item.createdTime ?? "";
}

function mergeDiagnostics(
  target: SanitizationDiagnostics,
  source: SafeTextResult["diagnostics"]
): void {
  target.htmlStripped ||= Boolean(source.htmlStripped);
  target.headersRemoved ||= Boolean(source.headersRemoved);
  target.credentialsRedacted ||= Boolean(source.credentialsRedacted);
  target.base64Removed ||= Boolean(source.base64Removed);
  target.truncated ||= Boolean(source.truncated);
  if (source.embeddedImageRemoved || source.binaryRemoved) {
    target.base64Removed ||= Boolean(source.embeddedImageRemoved);
  }
}

function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return normalizePlainText(
    redactRiskyText(stripRawEmailHeaders(raw).text, true).text
  ).slice(0, 500);
}

function buildSafeTicketResult(params: {
  ticket: Ticket;
  safeParams: Required<SafeTicketParams>;
  conversations?: TicketConversation[];
  notes?: TicketNote[];
  contentErrors?: string[];
}) {
  const { ticket, safeParams } = params;
  const sanitization: SanitizationDiagnostics = {
    htmlStripped: false,
    headersRemoved: false,
    credentialsRedacted: false,
    base64Removed: false,
    attachmentsMetadataOnly: safeParams.attachments === "metadataOnly",
    truncated: false,
    itemsReturned: 0,
    itemsOmittedByLimit: 0,
  };

  const attachments = safeParams.attachments === "metadataOnly"
    ? [
        ...(params.conversations ?? []).flatMap((item) =>
          safeAttachmentMetadata(item.attachments)
        ),
        ...(params.notes ?? []).flatMap((item) => safeAttachmentMetadata(item.attachments)),
      ]
    : [];

  const sectionWarnings: string[] = [...(params.contentErrors ?? [])];
  const ticketBodyAvailable = false;
  const conversationCount = params.conversations?.length ?? 0;
  const noteCount = params.notes?.length ?? 0;

  const items: SafeContentItem[] = [];
  if (safeParams.includeDescription) {
    sectionWarnings.push(
      "Ticket body/description is not queried because Ticket.description is not available in the live SuperOps schema. Safe retrieval uses the proven conversation and note content paths."
    );
  }

  if (safeParams.includeConversations) {
    for (const conversation of params.conversations ?? []) {
      const safeText = sanitizeTicketText(conversation.content, safeParams);
      mergeDiagnostics(sanitization, safeText.diagnostics);
      items.push({
        id: conversation.conversationId,
        type: safeContentTypeForConversation(conversation),
        direction: conversationDirection(conversation),
        createdTime: conversation.time,
        author: readableString(conversation.user, ["name", "email"]),
        isInternal: false,
        plainText: safeText.plainText,
        truncated: safeText.truncated,
      });
    }
  }

  if (safeParams.includeNotes) {
    for (const note of params.notes ?? []) {
      const safeText = sanitizeTicketText(note.content, safeParams);
      mergeDiagnostics(sanitization, safeText.diagnostics);
      items.push({
        id: note.noteId,
        type: "note",
        direction: noteDirection(note),
        createdTime: note.addedOn,
        author: readableString(note.addedBy, ["name", "email"]),
        isInternal: note.privacyType === "PRIVATE",
        plainText: safeText.plainText,
        truncated: safeText.truncated,
      });
    }
  }

  const orderedItems = [...items].sort((a, b) => {
    const comparison = timestampOf(a).localeCompare(timestampOf(b));
    return safeParams.latestFirst ? -comparison : comparison;
  });

  let usedChars = 0;
  const limitedItems: SafeContentItem[] = [];
  for (const item of orderedItems) {
    if (limitedItems.length >= safeParams.maxItems) {
      sanitization.itemsOmittedByLimit += 1;
      continue;
    }
    if (usedChars + item.plainText.length > safeParams.maxTotalChars) {
      sanitization.itemsOmittedByLimit += 1;
      sanitization.truncated = true;
      continue;
    }
    usedChars += item.plainText.length;
    limitedItems.push(item);
  }

  sanitization.itemsReturned = limitedItems.length;
  if (limitedItems.length === 0 && (conversationCount > 0 || noteCount > 0)) {
    sectionWarnings.push(
      "Content sources were available, but all sanitized items were omitted by item or total character limits."
    );
  }

  const latestCustomerMessage = limitedItems.find(
    (item) => item.type === "conversation" && item.direction === "customer"
  );
  const latestInternalNote = limitedItems.find(
    (item) => item.type === "note" && item.isInternal
  );
  const latestTechnicianReply = limitedItems.find(
    (item) =>
      (item.type === "conversation" && item.direction === "technician") ||
      (item.type === "note" && !item.isInternal)
  );

  return {
    ticketNumber: ticket.displayId,
    ticketId: ticket.ticketId,
    subject: ticket.subject,
    client: readableString(ticket.client, ["name", "accountName"]),
    site: readableString(ticket.site, ["name"]),
    status: ticket.status,
    priority: ticket.priority,
    impact: ticket.impact,
    urgency: ticket.urgency,
    category: ticket.category,
    subcategory: ticket.subcategory,
    cause: ticket.cause,
    resolutionCode: ticket.resolutionCode,
    requesterName: readableString(ticket.requester, ["name", "firstName", "lastName"]),
    requesterEmail: readableString(ticket.requester, ["email"]),
    createdTime: ticket.createdTime,
    updatedTime: ticket.updatedTime,
    safeContent: {
      description: undefined,
      items: limitedItems,
      contentWarnings: sectionWarnings.length > 0 ? sectionWarnings : undefined,
    },
    contentAvailability: {
      ticketBody: {
        requested: safeParams.includeDescription,
        available: ticketBodyAvailable,
        source: "notAvailableInLiveSchema",
      },
      conversations: {
        requested: safeParams.includeConversations,
        available: conversationCount > 0,
        count: conversationCount,
      },
      notes: {
        requested: safeParams.includeNotes,
        available: noteCount > 0,
        count: noteCount,
      },
      degraded: limitedItems.length === 0 && (conversationCount > 0 || noteCount > 0),
    },
    latestCustomerMessage,
    latestInternalNote,
    latestTechnicianReply,
    attachments,
    sanitization,
  };
}


function triageItemType(item: SafeContentItem): string {
  if (item.type === "description") return "description";
  if (item.type === "note" && item.isInternal) return "internal_note";
  if (item.type === "note") return "note";
  if (item.direction === "customer") return "customer_reply";
  if (item.direction === "technician") return "technician_reply";
  return "conversation";
}

function triageProcessingState(params: {
  metadataAvailable: boolean;
  itemCount: number;
  conversationCount: number;
  noteCount: number;
  contentErrors: string[];
}): TriageProcessingState {
  if (!params.metadataAvailable) return "Failed";
  if (params.itemCount > 0) return "SnapshotRead";
  if (params.contentErrors.length > 0) return "ContentBlocked";
  if (params.conversationCount > 0 || params.noteCount > 0) return "ContentUnavailable";
  return "MetadataOnly";
}

function buildTriageSnapshotTicket(params: {
  candidate: Ticket;
  ticket: Ticket;
  safeResult: ReturnType<typeof buildSafeTicketResult>;
  contentErrors: string[];
  metadataAvailable: boolean;
}) {
  const { candidate, ticket, safeResult, contentErrors, metadataAvailable } = params;
  const safeContentItems = safeResult.safeContent.items.map((item) => ({
    type: triageItemType(item),
    time: item.createdTime,
    author: item.author,
    isInternal: item.isInternal,
    plainText: item.plainText,
    truncated: item.truncated,
  }));
  const safeSummary = safeContentItems
    .map((item) => item.plainText)
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 800);
  const conversationAvailability = safeResult.contentAvailability.conversations;
  const noteAvailability = safeResult.contentAvailability.notes;

  return {
    ticketNumber: ticket.displayId ?? candidate.displayId,
    ticketId: ticket.ticketId ?? candidate.ticketId,
    subject: ticket.subject ?? candidate.subject,
    client: readableString(ticket.client ?? candidate.client, ["name", "accountName"]),
    site: readableString(ticket.site, ["name"]),
    requesterName: readableString(
      ticket.requester ?? candidate.requester,
      ["name", "firstName", "lastName"]
    ),
    requesterEmail: readableString(ticket.requester ?? candidate.requester, ["email"]),
    status: ticket.status ?? candidate.status,
    priority: ticket.priority ?? candidate.priority,
    impact: ticket.impact ?? candidate.impact,
    urgency: ticket.urgency ?? candidate.urgency,
    category: ticket.category ?? candidate.category,
    subcategory: ticket.subcategory,
    cause: ticket.cause,
    resolutionCode: ticket.resolutionCode,
    createdTime: ticket.createdTime ?? candidate.createdTime,
    updatedTime: ticket.updatedTime ?? candidate.updatedTime,
    processingState: triageProcessingState({
      metadataAvailable,
      itemCount: safeContentItems.length,
      conversationCount: conversationAvailability.count,
      noteCount: noteAvailability.count,
      contentErrors,
    }),
    safeSummary,
    safeContentItems,
    attachments: safeResult.attachments,
    contentAvailability: {
      metadata: metadataAvailable ? "available" : "unavailable",
      descriptionField: "notAvailableInSchema",
      conversations: conversationAvailability.available
        ? "available"
        : conversationAvailability.requested
          ? "unavailable"
          : "notRequested",
      notes: noteAvailability.available
        ? "available"
        : noteAvailability.requested
          ? "unavailable"
          : "notRequested",
      attachments: safeResult.sanitization.attachmentsMetadataOnly
        ? "metadataOnly"
        : "none",
    },
    contentSourceNotes: [
      "Ticket.description is not available in the live SuperOps schema. Original ticket body is retrieved from conversation items where SuperOps exposes it, including DESCRIPTION items.",
    ],
    warnings: contentErrors,
  };
}

async function buildTriageSnapshotForCandidate(
  client: SuperOpsClientInstance,
  candidate: Ticket,
  params: NormalizedTriageSnapshotParams
) {
  let ticket = candidate;
  let metadataAvailable = true;
  const contentErrors: string[] = [];

  try {
    ticket = await getTicketByInternalId(client, candidate.ticketId);
  } catch (error) {
    metadataAvailable = false;
    contentErrors.push(`Metadata could not be fetched safely: ${safeErrorMessage(error)}`);
  }

  let conversations: TicketConversation[] = [];
  let notes: TicketNote[] = [];

  if (params.includeConversations) {
    try {
      conversations = await getTicketConversations(client, candidate.ticketId);
    } catch (error) {
      contentErrors.push(
        `Conversations could not be fetched safely: ${safeErrorMessage(error)}`
      );
    }
  }

  if (params.includeNotes) {
    try {
      notes = await getTicketNotes(client, candidate.ticketId);
    } catch (error) {
      contentErrors.push(`Notes could not be fetched safely: ${safeErrorMessage(error)}`);
    }
  }

  const safeResult = buildSafeTicketResult({
    ticket,
    safeParams: safeParamsForTriageSnapshot(params),
    conversations,
    notes,
    contentErrors: undefined,
  });

  return buildTriageSnapshotTicket({
    candidate,
    ticket,
    safeResult,
    contentErrors,
    metadataAvailable,
  });
}
function applyTicketFilters(
  tickets: Ticket[],
  filters: {
    priority?: string[];
    clientId?: string;
    assigneeId?: string;
    unassigned?: boolean;
  }
): Ticket[] {
  return tickets.filter((ticket) => {
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

function structuredValidationResult(
  failure: StructuredValidationFailure
): {
  content: { type: "text"; text: string }[];
  isError: true;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(failure, null, 2) }],
    isError: true,
  };
}

function validationFailure(params?: {
  message?: string;
  missingFields?: string[];
  invalidFields?: Record<string, string>;
  validOptions?: Record<string, string[]>;
}): StructuredValidationFailure {
  return {
    ok: false,
    message: params?.message ?? "Ticket was not updated because validation failed.",
    missingFields: params?.missingFields ?? [],
    invalidFields: params?.invalidFields ?? {},
    validOptions: params?.validOptions ?? {},
  };
}

function isPriorityMandatoryValidation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /mandatory_validation_failed\s*:\s*priority/i.test(message);
}

function mandatoryValidationFields(error: unknown): string[] {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/mandatory_validation_failed\s*:\s*([A-Za-z0-9_,\s-]+)/i);
  if (!match?.[1]) {
    return [];
  }

  return match[1]
    .split(/[,\s]+/)
    .map((field) => field.trim())
    .filter(Boolean);
}

function mandatoryValidationRuntimeMessage(
  fields: string[],
  noteAdded: boolean
): string {
  const fieldList = fields.length > 0 ? fields.join(", ") : "one or more fields";
  const verb = fields.length === 1 ? "is" : "are";
  const noteContext = noteAdded
    ? "A note was already added before this unexpected runtime failure. No further note should be added on retry unless you intentionally want a duplicate note."
    : "No note was added.";
  return `SuperOps rejected the update because ${fieldList} ${verb} required for this update path. ${noteContext}`;
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

function addValidatedTicketOptionUpdatesFromFields(
  fields: Map<ValidatedTicketOptionField, SuperOpsField>,
  params: TicketClassificationParams,
  input: Record<string, unknown>,
  allowedFields: readonly ValidatedTicketOptionField[] = VALIDATED_TICKET_OPTION_FIELDS
): string | undefined {
  const fieldsToValidate = requestedValidatedOptionFields(params, allowedFields);

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

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function ticketClassificationValue(
  ticket: Ticket,
  fieldName: (typeof RESOLVED_REQUIRED_FIELDS)[number]
): string | undefined {
  return stringValue((ticket as unknown as Record<string, unknown>)[fieldName]);
}

function validOptionsForFields(
  fields: Map<ValidatedTicketOptionField, SuperOpsField>,
  fieldNames: readonly ValidatedTicketOptionField[]
): Record<string, string[]> {
  return Object.fromEntries(
    fieldNames.map((fieldName) => [
      fieldName,
      fields.get(fieldName) ? optionValues(fields.get(fieldName) as SuperOpsField) : [],
    ])
  );
}

function validateResolvedTicketFields(params: {
  optionParams: TicketClassificationParams;
  optionFields: Map<ValidatedTicketOptionField, SuperOpsField>;
  input: Record<string, unknown>;
}): StructuredValidationFailure | undefined {
  const missingFields: string[] = [];
  const invalidFields: Record<string, string> = {};
  const validOptions = validOptionsForFields(
    params.optionFields,
    RESOLVED_REQUIRED_OPTION_FIELDS
  );
  validOptions.category = [...VALID_TICKET_CATEGORIES];

  const category = stringValue(params.optionParams.category);
  if (!category) {
    missingFields.push("category");
  } else if (invalidValues([category], VALID_TICKET_CATEGORIES).length > 0) {
    invalidFields.category = `Invalid ticket category: ${category}`;
  } else {
    params.input.category = category;
  }

  for (const fieldName of RESOLVED_REQUIRED_OPTION_FIELDS) {
    const value = stringValue(params.optionParams[fieldName]);
    if (!value) {
      missingFields.push(fieldName);
      continue;
    }

    const field = params.optionFields.get(fieldName);
    if (!field) {
      invalidFields[fieldName] =
        `SuperOps did not return field metadata for ${TICKET_OPTION_FIELD_LABELS[fieldName]} via getFields; cannot safely update ${fieldName}.`;
      continue;
    }

    const resolved = resolveOptionValue(fieldName, field, value);
    if ("error" in resolved) {
      invalidFields[fieldName] = resolved.error;
      continue;
    }

    const dependencyError = validateOptionDependency(
      params.optionParams,
      fieldName,
      field,
      resolved.option
    );
    if (dependencyError) {
      invalidFields[fieldName] = dependencyError;
      continue;
    }

    params.input[fieldName] = resolved.value;
  }

  if (missingFields.length > 0 || Object.keys(invalidFields).length > 0) {
    return validationFailure({ missingFields, invalidFields, validOptions });
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

function isSuperOpsInternalError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /internal server error|internal_error|server error|status\s*500/i.test(message);
}

function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /rate limit|too many requests|status\s*429/i.test(message);
}

function ticketClientName(ticket: Ticket): string | undefined {
  return readableString(ticket.client, ["name", "accountName"]);
}

function ticketTechGroupName(ticket: Ticket): string | undefined {
  return readableString(ticket.techGroup, ["name", "groupName"]);
}

function ticketFinalState(ticket: Ticket): Record<string, unknown> {
  return {
    status: ticket.status,
    priority: ticket.priority,
    impact: ticket.impact,
    urgency: ticket.urgency,
    category: ticket.category,
    subcategory: ticket.subcategory,
    cause: ticket.cause,
    resolutionCode: ticket.resolutionCode,
    techGroup: ticketTechGroupName(ticket) ?? ticket.techGroup,
    client: ticketClientName(ticket) ?? ticket.client,
  };
}

function ticketVerificationValue(
  ticket: Ticket,
  field: string,
  action: TriagePlanAction
): unknown {
  if (field === "techGroup") {
    return ticketTechGroupName(ticket);
  }
  if (field === "client") {
    const client = jsonRecord(ticket.client);
    if (action.target?.clientId) {
      return typeof client?.accountId === "string" ? client.accountId : undefined;
    }
    const clientName = ticketClientName(ticket);
    return clientName ? canonicalClientName(clientName) : undefined;
  }
  return (ticket as unknown as Record<string, unknown>)[field];
}

function compareTicketValue(expected: unknown, actual: unknown): boolean {
  if (typeof expected === "string" && typeof actual === "string") {
    return expected.trim() === actual.trim();
  }
  return expected === actual;
}

function verifyFinalTargetState(
  action: TriagePlanAction,
  ticket: Ticket
): { mismatches: { field: string; expected: unknown; actual: unknown }[] } {
  const target = action.target ?? {};
  const requested: { field: string; expected: unknown }[] = [];

  for (const field of [
    "status", "priority", "impact", "urgency", "category", "subcategory", "cause", "resolutionCode",
  ] as const) {
    if (target[field] !== undefined) {
      requested.push({ field, expected: target[field] });
    }
  }

  if (target.techGroupName !== undefined) {
    requested.push({ field: "techGroup", expected: target.techGroupName });
  }
  if (target.clientName !== undefined) {
    requested.push({ field: "client", expected: canonicalClientName(target.clientName) });
  } else if (target.clientId !== undefined) {
    requested.push({ field: "client", expected: target.clientId });
  }

  const mismatches = requested.flatMap(({ field, expected }) => {
    const actual = ticketVerificationValue(ticket, field, action);
    return compareTicketValue(expected, actual) ? [] : [{ field, expected, actual }];
  });

  return { mismatches };
}

function baseApplyResult(
  ticketNumber: string,
  action?: TriagePlanAction,
  ticket?: Ticket
): ApplyTriagePlanResult {
  return {
    ticketNumber,
    ticketId: ticket?.ticketId,
    subject: ticket?.subject,
    client: ticket ? ticketClientName(ticket) : undefined,
    requestedAction: action?.action,
    finalOutcome: "Failed",
    writeAttempted: false,
    writeMethod: null,
    noteAdded: false,
    noteDeduped: false,
    verified: false,
    finalState: ticket ? ticketFinalState(ticket) : null,
    failureStage: null,
    failureReason: null,
    fallbackAttempted: false,
    fallbackResult: null,
    partialWrite: false,
    requestedState: action?.target ? { ...action.target } : null,
    attemptedState: null,
    observedFinalState: ticket ? ticketFinalState(ticket) : null,
    verifiedState: null,
  };
}

function validateExpectedTicket(
  ticketNumber: string,
  action: TriagePlanAction,
  ticket: Ticket,
  allowChanged: boolean
): { stage: string; reason: string; outcome?: TriageFinalOutcome } | undefined {
  if (ticket.displayId && ticket.displayId !== ticketNumber) {
    return {
      stage: "validateTicketNumber",
      reason: `Expected display number ${ticketNumber}, got ${ticket.displayId}.`,
    };
  }
  if (action.expectedTicketId && ticket.ticketId !== action.expectedTicketId) {
    return {
      stage: "validateTicketId",
      reason: `Expected ticketId ${action.expectedTicketId}, got ${ticket.ticketId}.`,
    };
  }
  if (action.expectedSubject && ticket.subject !== action.expectedSubject) {
    return {
      stage: "validateSubject",
      reason: `Expected subject ${JSON.stringify(action.expectedSubject)}, got ${JSON.stringify(ticket.subject)}.`,
    };
  }
  if (action.expectedClient && ticketClientName(ticket) !== action.expectedClient) {
    return {
      stage: "validateClient",
      reason: `Expected client ${JSON.stringify(action.expectedClient)}, got ${JSON.stringify(ticketClientName(ticket))}.`,
    };
  }
  if (action.expectedStatus && ticket.status !== action.expectedStatus) {
    return {
      stage: "validateStatus",
      reason: `Expected status ${JSON.stringify(action.expectedStatus)}, got ${JSON.stringify(ticket.status)}.`,
    };
  }
  if (
    action.expectedUpdatedTime &&
    ticket.updatedTime !== action.expectedUpdatedTime &&
    !allowChanged
  ) {
    return {
      stage: "validateUpdatedTime",
      reason: `Ticket changed since snapshot. Expected updatedTime ${action.expectedUpdatedTime}, got ${ticket.updatedTime}.`,
      outcome: "SkippedChangedSinceSnapshot",
    };
  }
}

async function existingNoteMatches(
  client: SuperOpsClientInstance,
  ticketId: string,
  note: string
): Promise<boolean> {
  const notes = await getTicketNotes(client, ticketId);
  const normalized = normalizePlanNote(note);
  return notes.some((existing) => normalizePlanNote(existing.content) === normalized);
}

function normalizePlanNote(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

async function addNoteForPlan(params: {
  client: SuperOpsClientInstance;
  ticketId: string;
  note?: string;
  isPublic?: boolean;
  dedupe: boolean;
  result: ApplyTriagePlanResult;
}): Promise<void> {
  if (typeof params.note !== "string" || params.note.trim().length === 0) {
    return;
  }
  if (params.dedupe && await existingNoteMatches(params.client, params.ticketId, params.note)) {
    params.result.noteDeduped = true;
    return;
  }
  await createTicketNote(params.client, params.ticketId, params.note, params.isPublic ?? false);
  params.result.noteAdded = true;
}

async function buildApprovedUpdateInput(
  client: SuperOpsClientInstance,
  ticketId: string,
  action: TriagePlanAction,
  defaultStatus?: string
): Promise<Record<string, unknown> | { error: string }> {
  const target = action.target ?? {};
  const input: Record<string, unknown> = { ticketId };
  const status = target.status ?? defaultStatus;
  if (status) {
    if (invalidValues([status], VALID_TICKET_STATUSES).length > 0) {
      return { error: `Invalid ticket status: ${status}` };
    }
    input.status = status;
  }
  if (target.suppressCloseNotification !== undefined) {
    input.suppressCloseNotification = target.suppressCloseNotification;
  }
  if (target.category) {
    if (invalidValues([target.category], VALID_TICKET_CATEGORIES).length > 0) {
      return { error: `Invalid ticket category: ${target.category}` };
    }
    input.category = target.category;
  }

  const optionValidationError = await addValidatedTicketOptionUpdates(
    client,
    target,
    input,
    ["priority", "impact", "urgency", "resolutionCode", "cause", "subcategory"]
  );
  if (optionValidationError) {
    return { error: optionValidationError };
  }

  const resolvedClient = await resolveClientAccountId(client, {
    clientId: target.clientId,
    clientName: target.clientName,
  });
  if (resolvedClient.error) {
    return { error: resolvedClient.error };
  }
  if (resolvedClient.accountId) {
    input.client = { accountId: resolvedClient.accountId };
  }

  const resolvedTechGroup = await resolveTechGroup(client, target.techGroupName);
  if (resolvedTechGroup.error) {
    return { error: resolvedTechGroup.error };
  }
  if (resolvedTechGroup.groupId) {
    input.techGroup = { groupId: resolvedTechGroup.groupId };
  }

  return input;
}

async function buildApprovedResolveInput(
  client: SuperOpsClientInstance,
  ticketId: string,
  action: TriagePlanAction,
  currentTicket?: Ticket
): Promise<Record<string, unknown> | { error: string }> {
  const target = action.target ?? {};
  const finalStatus = target.status ?? DEFAULT_RESOLVE_TICKET_STATUS;
  const input: Record<string, unknown> = {
    ticketId,
    status: finalStatus,
    suppressCloseNotification: target.suppressCloseNotification ?? true,
  };

  if (invalidValues([finalStatus], VALID_TICKET_STATUSES).length > 0) {
    return { error: `Invalid ticket status: ${finalStatus}` };
  }

  const resolvedClient = await resolveClientAccountId(client, {
    clientId: target.clientId,
    clientName: target.clientName,
  });
  if (resolvedClient.error) {
    return { error: resolvedClient.error };
  }

  const resolvedTechGroup = await resolveTechGroup(client, target.techGroupName);
  if (resolvedTechGroup.error) {
    return { error: resolvedTechGroup.error };
  }

  const optionParams: TicketClassificationParams = {
    priority: target.priority,
    impact: target.impact,
    urgency: target.urgency,
    category: target.category,
    subcategory: target.subcategory,
    cause: target.cause,
    resolutionCode: target.resolutionCode,
    status: target.status,
  };
  const requiresResolvedPreflight = finalStatus === DEFAULT_RESOLVE_TICKET_STATUS;
  const optionFieldsToFetch = new Set<ValidatedTicketOptionField>(
    requestedValidatedOptionFields(optionParams)
  );
  if (requiresResolvedPreflight) {
    for (const fieldName of RESOLVED_REQUIRED_OPTION_FIELDS) {
      optionFieldsToFetch.add(fieldName);
    }
  }

  if (
    requiresResolvedPreflight &&
    RESOLVED_REQUIRED_FIELDS.some((fieldName) => !optionParams[fieldName])
  ) {
    const sourceTicket = currentTicket ?? await getTicketByInternalId(client, ticketId);
    for (const fieldName of RESOLVED_REQUIRED_FIELDS) {
      if (!optionParams[fieldName]) {
        optionParams[fieldName] = ticketClassificationValue(sourceTicket, fieldName);
      }
    }
  }

  const optionFields = optionFieldsToFetch.size > 0
    ? await getTicketOptionFields(client, [...optionFieldsToFetch])
    : new Map<ValidatedTicketOptionField, SuperOpsField>();

  if (requiresResolvedPreflight) {
    const validationError = validateResolvedTicketFields({
      optionParams,
      optionFields,
      input,
    });
    if (validationError) {
      return { error: JSON.stringify(validationError) };
    }

    const optionalOptionFields = requestedValidatedOptionFields(optionParams).filter(
      (fieldName) =>
        !RESOLVED_REQUIRED_OPTION_FIELDS.includes(
          fieldName as (typeof RESOLVED_REQUIRED_OPTION_FIELDS)[number]
        )
    );
    const optionalValidationError = addValidatedTicketOptionUpdatesFromFields(
      optionFields,
      optionParams,
      input,
      optionalOptionFields
    );
    if (optionalValidationError) {
      return { error: optionalValidationError };
    }
  } else {
    if (target.category) {
      if (invalidValues([target.category], VALID_TICKET_CATEGORIES).length > 0) {
        return { error: `Invalid ticket category: ${target.category}` };
      }
      input.category = target.category;
    }

    const optionValidationError = addValidatedTicketOptionUpdatesFromFields(
      optionFields,
      optionParams,
      input
    );
    if (optionValidationError) {
      return { error: optionValidationError };
    }
  }

  if (resolvedClient.accountId) {
    input.client = { accountId: resolvedClient.accountId };
  }
  if (resolvedTechGroup.groupId) {
    input.techGroup = { groupId: resolvedTechGroup.groupId };
  }

  return input;
}
async function mutateTicketUpdate(
  client: SuperOpsClientInstance,
  input: Record<string, unknown>
): Promise<Ticket> {
  const response = await client.mutate<UpdateTicketResponse>(UPDATE_TICKET_MUTATION, {
    input,
  });
  return response.updateTicket;
}

function triageStageForResult(result: ApplyTriagePlanResult): OperationItemState["stage"] {
  if (result.partialWrite) return "FailedAfterPartialWrite";
  switch (result.finalOutcome) {
    case "Resolved":
    case "Updated":
    case "Left":
      return "Completed";
    case "Skipped":
    case "NoApprovedAction":
      return "Skipped";
    case "SkippedChangedSinceSnapshot":
      return "Stale";
    case "FailedBeforeProcessing":
    case "NotAttemptedExecutionStopped":
      return "Unattempted";
    case "NotFound":
    case "Blocked":
      return "FailedBeforeWrite";
    case "Failed":
    default:
      return result.writeAttempted ? "FailedAfterPartialWrite" : "FailedBeforeWrite";
  }
}

function compactApplyResult(result: ApplyTriagePlanResult): Record<string, unknown> {
  return {
    ticketNumber: result.ticketNumber,
    ticketId: result.ticketId,
    requestedAction: result.requestedAction,
    finalOutcome: result.finalOutcome,
    writeAttempted: result.writeAttempted,
    writeMethod: result.writeMethod,
    noteAdded: result.noteAdded,
    noteDeduped: result.noteDeduped,
    verified: result.verified,
    failureStage: result.failureStage,
    failureReason: result.failureReason,
    fallbackAttempted: result.fallbackAttempted,
    fallbackResult: result.fallbackResult,
    partialWrite: result.partialWrite,
    requestedState: result.requestedState,
    attemptedState: result.attemptedState,
    observedFinalState: result.observedFinalState,
    verifiedState: result.verifiedState,
  };
}

function buildApplyTriageLedgerRecord(params: {
  operationId: string;
  request: ApplyTriagePlanParams;
  expected: string[];
  results: ApplyTriagePlanResult[];
  actionsByTicket: Map<string, TriagePlanAction>;
  continuationRequired: boolean;
  summary: Record<string, unknown>;
}): OperationLedgerRecord {
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + getExecutionConfig().operationRetentionSeconds * 1000
  );
  const itemStates = Object.fromEntries(
    params.expected.map((ticketNumber) => {
      const result = params.results.find((item) => item.ticketNumber === ticketNumber);
      const action = params.actionsByTicket.get(ticketNumber);
      const stage = result ? triageStageForResult(result) : "Pending";
      const state: OperationItemState = {
        itemKey: ticketNumber,
        stage,
        outcome: result?.finalOutcome,
        idempotencyKey: stableHash({ operationId: params.operationId, ticketNumber }),
        writeAttempted: result?.writeAttempted ?? false,
        writeMayHaveSucceeded: Boolean(result?.partialWrite),
        partialWrite: result?.partialWrite ?? false,
        noteFingerprint: normalizedNoteFingerprint(action?.note),
        verificationState: result?.verified
          ? "Verified"
          : result?.writeAttempted
            ? "Failed"
            : "NotRequired",
        retryCount: 0,
        failureReason: result?.failureReason ?? undefined,
        updatedTimeExpectation: action?.expectedUpdatedTime,
        targetFields: action?.target ? { ...action.target } : undefined,
      };
      return [ticketNumber, state];
    })
  );
  const completedItems = params.results
    .filter((result) => ["Resolved", "Updated", "Left"].includes(result.finalOutcome))
    .map((result) => result.ticketNumber);
  const failedItems = params.results
    .filter(
      (result) =>
        ["Failed", "Blocked", "NotFound", "FailedBeforeProcessing"].includes(
          result.finalOutcome
        ) && result.failureStage !== "executionBudget"
    )
    .map((result) => result.ticketNumber);
  const skippedItems = params.results
    .filter((result) => ["Skipped", "NoApprovedAction", "SkippedChangedSinceSnapshot"].includes(result.finalOutcome))
    .map((result) => result.ticketNumber);
  const unattemptedItems = params.results
    .filter(
      (result) =>
        result.finalOutcome === "NotAttemptedExecutionStopped" ||
        (result.finalOutcome === "FailedBeforeProcessing" &&
          result.failureStage === "executionBudget")
    )
    .map((result) => result.ticketNumber);
  const terminalFailure = params.continuationRequired
    ? "Continuation required before all expected items were processed."
    : undefined;

  return {
    responseVersion: 1,
    operationId: params.operationId,
    toolName: "superops_tickets_apply_triage_plan",
    ownerHash: currentOwnerHash(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    originalRequestHash: stableHash({
      batchId: params.request.batchId,
      expectedCandidateTicketNumbers: params.expected,
      actions: Array.isArray(params.request.actions)
        ? params.request.actions.map((action) => ({
            ...action,
            note: action.note ? normalizedNoteFingerprint(action.note) : undefined,
          }))
        : [],
      dryRun: params.request.dryRun ?? false,
      verify: params.request.verify ?? true,
    }),
    state: params.continuationRequired ? "ContinuationRequired" : "Completed",
    expectedItems: params.expected,
    currentItem: params.results.at(-1)?.ticketNumber,
    completedItems,
    failedItems,
    skippedItems,
    unattemptedItems,
    pendingItems: [
      ...new Set([
        ...unattemptedItems,
        ...params.expected.filter(
          (ticketNumber) =>
            !params.results.some((result) => result.ticketNumber === ticketNumber)
        ),
      ]),
    ],
    itemStates,
    summary: params.summary,
    compactResults: params.results.map(compactApplyResult),
    partialWriteCount: params.results.filter((result) => result.partialWrite).length,
    ambiguousWriteCount: 0,
    rateLimitedItems: params.results
      .filter((result) => result.failureStage === "rateLimit")
      .map((result) => result.ticketNumber),
    continuationCount: params.continuationRequired ? 1 : 0,
    terminalFailureReason: terminalFailure,
  };
}
function summarizeApplyResults(results: ApplyTriagePlanResult[]) {
  return {
    resolved: results.filter((result) => result.finalOutcome === "Resolved").length,
    updated: results.filter((result) => result.finalOutcome === "Updated").length,
    left: results.filter((result) => result.finalOutcome === "Left").length,
    skipped: results.filter((result) => result.finalOutcome === "Skipped" || result.finalOutcome === "NoApprovedAction" || result.finalOutcome === "SkippedChangedSinceSnapshot").length,
    blocked: results.filter((result) => result.finalOutcome === "Blocked").length,
    failed: results.filter((result) => result.finalOutcome === "Failed").length,
    notFound: results.filter((result) => result.finalOutcome === "NotFound").length,
    notAttempted: results.filter((result) => result.finalOutcome === "NotAttemptedExecutionStopped" || result.finalOutcome === "FailedBeforeProcessing").length,
    partialWrites: results.filter((result) => result.partialWrite).length,
    verified: results.filter((result) => result.verified).length,
  };
}

function executionStoppedApplyResult(
  ticketNumber: string,
  action: TriagePlanAction | undefined,
  reason: string,
  outcome: TriageFinalOutcome = "NotAttemptedExecutionStopped"
): ApplyTriagePlanResult {
  const result = baseApplyResult(ticketNumber, action);
  result.finalOutcome = outcome;
  result.failureStage = "executionBudget";
  result.failureReason = reason;
  return result;
}

function isExecutionBudgetError(error: unknown): boolean {
  return error instanceof ExecutionBudgetExceededError ||
    error instanceof ExecutionTimeoutBudgetExceededError;
}

async function applyApprovedTriageAction(params: {
  client: SuperOpsClientInstance;
  ticketNumber: string;
  action?: TriagePlanAction;
  dryRun: boolean;
  verify: boolean;
  dedupeNotes: boolean;
  allowResolveFullFallbackToUpdate: boolean;
  allowWriteIfUpdatedTimeChanged: boolean;
  allowWriteWithoutVerifiedContent: boolean;
}): Promise<ApplyTriagePlanResult> {
  const { client, ticketNumber, action } = params;
  if (!action) {
    const result = baseApplyResult(ticketNumber);
    result.finalOutcome = "NoApprovedAction";
    result.failureStage = "approval";
    result.failureReason = "No approved action was supplied for this expected candidate.";
    return result;
  }

  const resolved = await resolveTicketId(client, { ticketNumber });
  if (resolved.error || !resolved.ticketId) {
    const result = baseApplyResult(ticketNumber, action);
    result.finalOutcome = "NotFound";
    result.failureStage = "readMetadata";
    result.failureReason = resolved.error ?? "Ticket was not found.";
    return result;
  }

  let ticket: Ticket;
  try {
    ticket = await getTicketByInternalId(client, resolved.ticketId);
  } catch (error) {
    const result = baseApplyResult(ticketNumber, action);
    result.finalOutcome = "NotFound";
    result.failureStage = "readMetadata";
    result.failureReason = safeErrorMessage(error);
    return result;
  }

  const result = baseApplyResult(ticketNumber, action, ticket);
  const allowChanged = action.allowWriteIfUpdatedTimeChanged ?? params.allowWriteIfUpdatedTimeChanged;
  const validationFailure = validateExpectedTicket(ticketNumber, action, ticket, allowChanged);
  if (validationFailure) {
    result.finalOutcome = validationFailure.outcome ?? "Blocked";
    result.failureStage = validationFailure.stage;
    result.failureReason = validationFailure.reason;
    return result;
  }

  if (action.action === "skip") {
    result.finalOutcome = "Skipped";
    result.failureStage = "approval";
    result.failureReason = action.reason ?? "Approved action was skip.";
    return result;
  }
  if (action.action === "leave") {
    result.finalOutcome = "Left";
    return result;
  }

  const mutating = action.action === "resolve" || action.action === "update" || action.action === "addNote";
  const allowUnverified = action.allowWriteWithoutVerifiedContent ?? params.allowWriteWithoutVerifiedContent;
  if (mutating && action.contentVerified !== true && !allowUnverified) {
    result.finalOutcome = "Blocked";
    result.failureStage = "contentVerification";
    result.failureReason = "Mutating action requires contentVerified=true or allowWriteWithoutVerifiedContent=true.";
    return result;
  }

  if (params.dryRun) {
    if (action.action === "resolve" || action.action === "update") {
      const dryRunInput = action.action === "resolve"
        ? await buildApprovedResolveInput(client, ticket.ticketId, action, ticket)
        : await buildApprovedUpdateInput(client, ticket.ticketId, action);
      const dryRunError = (dryRunInput as { error?: unknown }).error;
      if (typeof dryRunError === "string") {
        result.finalOutcome = "Blocked";
        result.failureStage = "validation";
        result.failureReason = dryRunError;
        return result;
      }
    }
    result.finalOutcome = action.action === "resolve" ? "Resolved" : "Updated";
    result.writeMethod = "dryRun";
    return result;
  }

  try {
    if (action.action === "addNote") {
      result.writeAttempted = true;
      result.writeMethod = "createTicketNote";
      await addNoteForPlan({
        client,
        ticketId: ticket.ticketId,
        note: action.note,
        isPublic: action.isPublicNote,
        dedupe: params.dedupeNotes,
        result,
      });
      result.finalOutcome = "Updated";
      if (params.verify) {
        try {
          const verified = await getTicketByInternalId(client, ticket.ticketId);
          result.finalState = ticketFinalState(verified);
          result.observedFinalState = result.finalState;
          result.verifiedState = result.finalState;
          result.verified = true;
        } catch (error) {
          result.finalOutcome = "Failed";
          result.partialWrite = result.writeAttempted || result.noteAdded;
          result.failureStage = "verify";
          result.failureReason = safeErrorMessage(error);
        }
      }
    } else {
      const updateInput = action.action === "resolve"
        ? await buildApprovedResolveInput(client, ticket.ticketId, action, ticket)
        : await buildApprovedUpdateInput(client, ticket.ticketId, action);
      const updateError = (updateInput as { error?: unknown }).error;
      if (typeof updateError === "string") {
        result.finalOutcome = "Blocked";
        result.failureStage = "validation";
        result.failureReason = updateError;
        return result;
      }

      result.writeAttempted = true;
      result.attemptedState = updateInput as Record<string, unknown>;
      result.writeMethod = action.action === "resolve" ? "resolve_full" : "update";
      try {
        await mutateTicketUpdate(client, updateInput as Record<string, unknown>);
      } catch (error) {
        if (isRateLimitError(error)) {
          result.finalOutcome = "Failed";
          result.failureStage = "rateLimit";
          result.failureReason = safeErrorMessage(error);
          result.partialWrite = result.writeAttempted || result.noteAdded;
          return result;
        }
        const fallbackAllowed = action.allowResolveFullFallbackToUpdate ?? params.allowResolveFullFallbackToUpdate;
        if (action.action === "resolve" && fallbackAllowed && isSuperOpsInternalError(error)) {
          result.fallbackAttempted = true;
          result.failureStage = "resolve_full";
          result.failureReason = safeErrorMessage(error);
          const reread = await getTicketByInternalId(client, ticket.ticketId);
          const rereadFailure = validateExpectedTicket(ticketNumber, action, reread, true);
          if (rereadFailure) {
            result.finalOutcome = "Blocked";
            result.fallbackResult = rereadFailure.reason;
            result.partialWrite = result.writeAttempted || result.noteAdded;
            return result;
          }
          await mutateTicketUpdate(client, updateInput as Record<string, unknown>);
          result.writeMethod = "update_fallback";
          result.fallbackResult = "Updated";
        } else {
          result.finalOutcome = "Failed";
          result.failureStage = action.action === "resolve" ? "resolve_full" : "update";
          result.failureReason = safeErrorMessage(error);
          result.partialWrite = result.writeAttempted || result.noteAdded;
          return result;
        }
      }
      let verified: Ticket;
      try {
        verified = await getTicketByInternalId(client, ticket.ticketId);
      } catch (error) {
        result.finalOutcome = "Failed";
        result.partialWrite = true;
        result.failureStage = "verifyFinalState";
        result.failureReason = safeErrorMessage(error);
        return result;
      }
      result.finalState = ticketFinalState(verified);
      result.observedFinalState = result.finalState;
      const finalVerification = verifyFinalTargetState(action, verified);
      if (finalVerification.mismatches.length > 0) {
        result.finalOutcome = "Failed";
        result.verified = false;
        result.partialWrite = true;
        result.failureStage = "verifyFinalState";
        result.failureReason = `Final state did not match requested target fields: ${JSON.stringify(finalVerification.mismatches)}`;
        return result;
      }
      result.verified = true;
      result.verifiedState = result.finalState;

      try {
        await addNoteForPlan({
          client,
          ticketId: ticket.ticketId,
          note: action.note,
          isPublic: action.isPublicNote,
          dedupe: params.dedupeNotes,
          result,
        });
      } catch (error) {
        result.finalOutcome = "Failed";
        result.failureStage = "createTicketNote";
        result.failureReason = safeErrorMessage(error);
        result.partialWrite = true;
        return result;
      }
      result.finalOutcome = action.action === "resolve" ? "Resolved" : "Updated";
    }
    return result;
  } catch (error) {
    result.finalOutcome = isRateLimitError(error) ? "Failed" : "Failed";
    result.failureStage = isRateLimitError(error) ? "rateLimit" : "write";
    result.failureReason = safeErrorMessage(error);
    result.partialWrite = result.writeAttempted || result.noteAdded;
    return result;
  }
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
    urgency: ticket.urgency,
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
        name: "superops_tickets_query",
        description: "Read-only historical ticket query over createdTime ranges. Uses confirmed createdTime DESC sorting, sequential pagination, local date filtering, dedupe, and completeness diagnostics. Does not fetch conversations, notes, descriptions, or ticket content.",
        inputSchema: { type: "object", properties: { createdFrom: { type: "string", description: "Inclusive ISO 8601 createdTime lower boundary." }, createdTo: { type: "string", description: "Exclusive ISO 8601 createdTime upper boundary." }, status: { type: "array", items: { type: "string", enum: [...VALID_TICKET_STATUSES] }, description: "Server-side status filter using confirmed is/in conditions." }, priorities: { type: "array", items: { type: "string" } }, clientIds: { type: "array", items: { type: "string" } }, clientNames: { type: "array", items: { type: "string" } }, technicianIds: { type: "array", items: { type: "string" } }, technicianNames: { type: "array", items: { type: "string" } }, sources: { type: "array", items: { type: "string" } }, requestTypes: { type: "array", items: { type: "string" } }, categories: { type: "array", items: { type: "string" } }, subcategories: { type: "array", items: { type: "string" } }, techGroups: { type: "array", items: { type: "string" } }, fieldProfile: { type: "string", enum: ["minimal", "reporting"], default: "reporting" }, fields: { type: "array", items: { type: "string" }, description: "Optional strict allowlisted metadata fields. ticketId, displayId, and createdTime are always included." }, sortOrder: { type: "string", enum: ["ASC", "DESC"], default: "DESC", description: "Return ordering. Fetching always uses createdTime DESC for early stopping." }, maxRecords: { type: "number", default: 5000 }, maxPages: { type: "number", default: 100 } }, required: ["createdFrom", "createdTo"] },
      },
      {
        name: "superops_tickets_created_between",
        description: "Read-only convenience wrapper for tickets created in a half-open createdTime range. Uses the shared historical query service and returns completeness diagnostics.",
        inputSchema: { type: "object", properties: { createdFrom: { type: "string", description: "Inclusive ISO 8601 createdTime lower boundary." }, createdTo: { type: "string", description: "Exclusive ISO 8601 createdTime upper boundary." }, status: { type: "array", items: { type: "string", enum: [...VALID_TICKET_STATUSES] }, description: "Server-side status filter using confirmed is/in conditions." }, sortOrder: { type: "string", enum: ["ASC", "DESC"], default: "ASC" }, fieldProfile: { type: "string", enum: ["minimal", "reporting"], default: "reporting" }, maxRecords: { type: "number", default: 5000 }, maxPages: { type: "number", default: 100 } }, required: ["createdFrom", "createdTo"] },
      },
      {
        name: "superops_tickets_report",
        description: "Read-only compact historical workload report for tickets created in a date range. Aggregates metadata inside the MCP worker and does not return raw ticket records by default.",
        inputSchema: { type: "object", properties: { createdFrom: { type: "string", description: "Inclusive ISO 8601 createdTime lower boundary." }, createdTo: { type: "string", description: "Exclusive ISO 8601 createdTime upper boundary." }, timezone: { type: "string", default: "Europe/London", description: "IANA timezone for report buckets." }, interval: { type: "string", enum: ["hour", "day", "week", "month", "none"], default: "day" }, groupBy: { type: "array", items: { type: "string", enum: ["client", "technician", "techGroup", "source", "status", "category", "subcategory", "priority", "requestType"] }, description: "One or two grouping dimensions." }, includeZeroBuckets: { type: "boolean", default: false }, topN: { type: "number", default: 20 }, includeSampleTickets: { type: "boolean", default: false }, sampleSizePerGroup: { type: "number", default: 1, description: "Maximum 3." }, status: { type: "array", items: { type: "string", enum: [...VALID_TICKET_STATUSES] }, description: "Server-side status filter using confirmed is/in conditions." }, priorities: { type: "array", items: { type: "string" } }, clientIds: { type: "array", items: { type: "string" } }, clientNames: { type: "array", items: { type: "string" } }, technicianIds: { type: "array", items: { type: "string" } }, technicianNames: { type: "array", items: { type: "string" } }, sources: { type: "array", items: { type: "string" } }, requestTypes: { type: "array", items: { type: "string" } }, categories: { type: "array", items: { type: "string" } }, subcategories: { type: "array", items: { type: "string" } }, techGroups: { type: "array", items: { type: "string" } }, timeField: { type: "string", enum: ["createdTime"], default: "createdTime", description: "Only createdTime is supported in this first version." }, maxRecords: { type: "number", default: 10000 }, maxPages: { type: "number", default: 200 } }, required: ["createdFrom", "createdTo", "timezone"] },
      },      {
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
        name: "superops_tickets_get_safe_by_number",
        description:
          "Safely retrieve a SuperOps ticket by visible ticket number with HTML stripped, risky embedded content removed, credentials redacted, attachments returned as metadata only, and long content truncated. Use this when normal ticket content retrieval is blocked or when safe plain-text triage is preferred.",
        inputSchema: {
          type: "object",
          properties: {
            ticketNumber: {
              oneOf: [{ type: "string" }, { type: "number" }],
              description: "The visible SuperOps ticket number or display ID",
            },
            includeDescription: {
              type: "boolean",
              default: true,
              description:
                "Request ticket body content when available through a proven SuperOps content path. Conversations and notes are retrieved separately.",
            },
            includeNotes: {
              type: "boolean",
              default: true,
              description: "Include sanitized ticket notes",
            },
            includeConversations: {
              type: "boolean",
              default: true,
              description: "Include sanitized ticket conversations",
            },
            latestFirst: {
              type: "boolean",
              default: true,
              description: "Return notes and conversations newest first when timestamps are available",
            },
            maxItems: {
              type: "number",
              default: 20,
              description: "Maximum content items to return (max: 50)",
            },
            maxCharsPerItem: {
              type: "number",
              default: 4000,
              description: "Maximum characters per sanitized item (max: 10000)",
            },
            maxTotalChars: {
              type: "number",
              default: 20000,
              description: "Maximum total sanitized content characters (max: 50000)",
            },
            redactCredentials: {
              type: "boolean",
              default: true,
              description: "Redact credentials, secrets, tokens, private keys, and long hashes",
            },
            stripHtml: {
              type: "boolean",
              default: true,
              description: "Strip HTML and convert visible text to plain text",
            },
            stripHeaders: {
              type: "boolean",
              default: true,
              description: "Remove raw email source and security header lines",
            },
            attachments: {
              type: "string",
              enum: ["metadataOnly", "none"],
              default: "metadataOnly",
              description: "Return attachment metadata only, or omit attachments",
            },
          },
          required: ["ticketNumber"],
        },
      },
      {
        name: "superops_tickets_triage_snapshot",
        description:
          "Read-only New Calls triage snapshot. Lists a queue once, freezes the candidate ticket numbers and IDs, then returns safe compact metadata, sanitized conversation/note evidence, and attachment metadata only for ChatGPT assessment.",
        inputSchema: {
          type: "object",
          properties: {
            status: {
              type: "array",
              items: {
                type: "string",
                enum: [...VALID_TICKET_STATUSES],
              },
              default: ["New Calls"],
              description:
                `Queue status display names to snapshot. Defaults to New Calls. Valid values: ${VALID_TICKET_STATUSES.join(", ")}`,
            },
            max: {
              type: "number",
              default: DEFAULT_TRIAGE_SNAPSHOT_MAX,
              description: "Maximum candidates to list before freezing the snapshot (default: 50, max: 500)",
            },
            page: {
              type: "number",
              default: 1,
              description: "Ticket list page to snapshot (default: 1)",
            },
            safeRead: {
              type: "boolean",
              default: true,
              description: "Accepted for compatibility; this Phase 1 tool always uses safe compact retrieval.",
            },
            includeNotes: {
              type: "boolean",
              default: true,
              description: "Include sanitized ticket notes as evidence.",
            },
            includeConversations: {
              type: "boolean",
              default: true,
              description: "Include sanitized ticket conversations as evidence, including DESCRIPTION items when SuperOps returns them.",
            },
            includeAttachments: {
              type: "string",
              enum: ["metadataOnly", "none"],
              default: "metadataOnly",
              description: "Return attachment metadata only, or omit attachments.",
            },
            maxContentCharsPerTicket: {
              type: "number",
              default: DEFAULT_TRIAGE_MAX_CONTENT_CHARS_PER_TICKET,
              description: "Maximum sanitized content characters per ticket (default: 3000, max: 10000).",
            },
            maxItemsPerTicket: {
              type: "number",
              default: DEFAULT_TRIAGE_MAX_ITEMS_PER_TICKET,
              description: "Maximum safe content items per ticket (default: 8, max: 20).",
            },
            latestFirst: {
              type: "boolean",
              default: true,
              description: "Return newest safe content items first when timestamps are available.",
            },
            storeBatch: {
              type: "boolean",
              default: false,
              description: "Accepted for future compatibility; Phase 1 snapshots are stateless and are not persisted.",
            },
          },
        },
      },      {
        name: "superops_tickets_apply_triage_plan",
        description:
          "Write/high-risk tool. Applies an approved New Calls triage plan to a fixed expected ticket set with metadata validation, updatedTime safety checks, dry-run support, note dedupe, controlled fallback, and verification.",
        inputSchema: {
          type: "object",
          properties: {
            batchId: {
              type: "string",
              description: "Optional batch identifier from an external workflow. Phase 3 requires expectedCandidateTicketNumbers unless a stored batch exists.",
            },
            expectedCandidateTicketNumbers: {
              type: "array",
              items: { type: "string" },
              description: "Fixed ticket numbers from the approved snapshot. A result is returned for every ticket in this list.",
            },
            actions: {
              type: "array",
              description: "Approved per-ticket actions. Supported action values: resolve, update, addNote, leave, skip.",
            },
            dryRun: {
              type: "boolean",
              default: false,
              description: "Validate and report intended outcomes without writing.",
            },
            verify: {
              type: "boolean",
              default: true,
              description: "Re-read each written ticket once and return final state.",
            },
            dedupeNotes: {
              type: "boolean",
              default: true,
              description: "Check existing notes before adding an approved note.",
            },
            stopOnFirstFailure: {
              type: "boolean",
              default: false,
              description: "Stop processing remaining candidates after the first failed, blocked, not found, or changed result.",
            },
            allowResolveFullFallbackToUpdate: {
              type: "boolean",
              default: false,
              description: "Allow controlled update fallback for resolve actions only after a SuperOps internal server error.",
            },
            allowWriteIfUpdatedTimeChanged: {
              type: "boolean",
              default: false,
              description: "Allow writes when the current updatedTime differs from the approved snapshot expectation.",
            },
            allowWriteWithoutVerifiedContent: {
              type: "boolean",
              default: false,
              description: "Allow mutating writes without contentVerified=true on the action.",
            },
          },
          required: ["expectedCandidateTicketNumbers"],
        },
      },      {
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
        name: "superops_tickets_field_options",
        description:
          "Discover writable ticket classification field options from SuperOps for validation before updates.",
        inputSchema: {
          type: "object",
          properties: {
            fields: {
              type: "array",
              items: {
                type: "string",
                enum: [...VALIDATED_TICKET_OPTION_FIELDS],
              },
              description:
                "Optional subset of fields to fetch. Defaults to priority, impact, urgency, resolutionCode, cause, and subcategory.",
            },
          },
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
                "Manual priority override display name. Validated against SuperOps ticket field options before update. Prefer impact plus urgency so SuperOps can calculate priority.",
            },
            impact: {
              type: "string",
              description:
                "Impact display name. Validated against SuperOps ticket field options before update.",
            },
            urgency: {
              type: "string",
              description:
                "Urgency display name. Validated against SuperOps ticket field options before update.",
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
          "Update an existing ticket - change status, assignment, impact, urgency, category, cause, subcategory, resolution code, or an explicit manual priority override.",
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
                "Manual priority override name. Validated against SuperOps ticket field options before update. Omitted unless explicitly supplied.",
            },
            impact: {
              type: "string",
              description:
                "Impact name. Validated against SuperOps ticket field options before update.",
            },
            urgency: {
              type: "string",
              description:
                "Urgency name. Validated against SuperOps ticket field options before update.",
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
                return structuredValidationResult(
                  validationFailure({
                    message: "Tickets were not queried because validation failed.",
                    invalidFields: {
                      status: `Invalid ticket status(es): ${invalidStatuses.join(", ")}`,
                    },
                    validOptions: { status: [...VALID_TICKET_STATUSES] },
                  })
                );
              }
            }

            const response = await client.query<ListTicketsResponse>(LIST_TICKETS_QUERY, {
              input: buildTicketListInput(params),
            });
            const tickets = applyTicketFilters(
              response.getTicketList.tickets,
              params
            );
            const localFiltersApplied = Boolean(
              params.priority ||
                params.clientId ||
                params.assigneeId ||
                params.unassigned
            );
            const listInfo = localFiltersApplied
              ? {
                  page: response.getTicketList.listInfo.page ?? params.page ?? DEFAULT_LIST_PAGE,
                  pageSize:
                    response.getTicketList.listInfo.pageSize ??
                    Math.min(params.max ?? 50, 500),
                  totalCount: undefined,
                  hasMore: undefined,
                }
              : response.getTicketList.listInfo;

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ tickets, listInfo }, null, 2),
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

          case "superops_tickets_query": {
            const params = args as HistoricalTicketQueryParams;
            if (params.status) {
              const invalidStatuses = invalidValues(params.status, VALID_TICKET_STATUSES);
              if (invalidStatuses.length > 0) {
                return structuredValidationResult(
                  validationFailure({
                    message: "Historical tickets were not queried because validation failed.",
                    invalidFields: { status: `Invalid ticket status(es): ${invalidStatuses.join(", ")}` },
                    validOptions: { status: [...VALID_TICKET_STATUSES] },
                  })
                );
              }
            }
            const result = await fetchTicketsPaginated(client, params);
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
          }

          case "superops_tickets_created_between": {
            const params = args as HistoricalTicketQueryParams;
            if (params.status) {
              const invalidStatuses = invalidValues(params.status, VALID_TICKET_STATUSES);
              if (invalidStatuses.length > 0) {
                return structuredValidationResult(
                  validationFailure({
                    message: "Historical tickets were not queried because validation failed.",
                    invalidFields: { status: `Invalid ticket status(es): ${invalidStatuses.join(", ")}` },
                    validOptions: { status: [...VALID_TICKET_STATUSES] },
                  })
                );
              }
            }
            const result = await fetchTicketsPaginated(client, {
              ...params,
              fieldProfile: params.fieldProfile ?? "reporting",
              sortOrder: params.sortOrder ?? "ASC",
            });
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
          }

          case "superops_tickets_report": {
            const params = args as HistoricalTicketReportParams;
            if (params.status) {
              const invalidStatuses = invalidValues(params.status, VALID_TICKET_STATUSES);
              if (invalidStatuses.length > 0) {
                return structuredValidationResult(
                  validationFailure({
                    message: "Historical ticket report was not queried because validation failed.",
                    invalidFields: { status: `Invalid ticket status(es): ${invalidStatuses.join(", ")}` },
                    validOptions: { status: [...VALID_TICKET_STATUSES] },
                  })
                );
              }
            }
            const result = await aggregateTicketReport(client, params);
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
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

          case "superops_tickets_field_options": {
            const params = args as { fields?: ValidatedTicketOptionField[] };
            const requestedFields =
              params.fields && params.fields.length > 0
                ? params.fields
                : [...VALIDATED_TICKET_OPTION_FIELDS];
            const invalidFields = requestedFields.filter(
              (field) =>
                !VALIDATED_TICKET_OPTION_FIELDS.includes(
                  field as ValidatedTicketOptionField
                )
            );

            if (invalidFields.length > 0) {
              return errorResult(
                `Invalid field option field(s): ${invalidFields.join(", ")}`
              );
            }

            const fields = await getTicketOptionFields(client, requestedFields);
            const result = Object.fromEntries(
              requestedFields.map((fieldName) => {
                const field = fields.get(fieldName);
                return [
                  fieldName,
                  {
                    label: field?.label,
                    columnName: field?.columnName ?? fieldName,
                    options: field?.options ?? [],
                    parentField: field?.parentField,
                  },
                ];
              })
            );

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(result, null, 2),
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

          case "superops_tickets_get_safe_by_number": {
            const safeParams = safeTicketParams(args as SafeTicketParams);
            const displayId = normaliseTicketNumber(safeParams.ticketNumber);

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

            const ticketId = matches[0].ticketId;
            const ticket = await getTicketByInternalId(client, ticketId);

            const contentErrors: string[] = [];
            let conversations: TicketConversation[] = [];
            let notes: TicketNote[] = [];

            if (safeParams.includeConversations) {
              try {
                conversations = await getTicketConversations(client, ticket.ticketId);
              } catch (error) {
                contentErrors.push(
                  `Conversations could not be fetched safely: ${safeErrorMessage(error)}`
                );
              }
            }

            if (safeParams.includeNotes) {
              try {
                notes = await getTicketNotes(client, ticket.ticketId);
              } catch (error) {
                contentErrors.push(
                  `Notes could not be fetched safely: ${safeErrorMessage(error)}`
                );
              }
            }

            const result = buildSafeTicketResult({
              ticket,
              safeParams,
              conversations,
              notes,
              contentErrors: contentErrors.length > 0 ? contentErrors : undefined,
            });

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          }

          case "superops_tickets_triage_snapshot": {
            const snapshotParams = triageSnapshotParams(args as TriageSnapshotParams);
            const invalidStatuses = invalidValues(
              snapshotParams.status,
              VALID_TICKET_STATUSES
            );
            if (invalidStatuses.length > 0) {
              return structuredValidationResult(
                validationFailure({
                  message: "Triage snapshot was not queried because validation failed.",
                  invalidFields: {
                    status: `Invalid ticket status(es): ${invalidStatuses.join(", ")}`,
                  },
                  validOptions: { status: [...VALID_TICKET_STATUSES] },
                })
              );
            }

            const response = await client.query<ListTicketsResponse>(LIST_TICKETS_QUERY, {
              input: buildTicketListInput({
                status: snapshotParams.status,
                max: snapshotParams.max,
                page: snapshotParams.page,
              }),
            });
            const candidates = response.getTicketList.tickets;
            const candidateTicketNumbers = candidates.map(
              (ticket) => ticket.displayId ?? ticket.ticketId
            );
            const tickets = [];
            for (const ticket of candidates) {
              tickets.push(
                await buildTriageSnapshotForCandidate(client, ticket, snapshotParams)
              );
            }

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      batchId: undefined,
                      source: {
                        status: snapshotParams.status,
                        page: snapshotParams.page,
                        max: snapshotParams.max,
                      },
                      initialCandidateCount: candidates.length,
                      candidateTicketNumbers,
                      tickets,
                      errors: [],
                      safety: {
                        safeReadUsed: true,
                        rawHtmlReturned: false,
                        attachmentBodiesReturned: false,
                      },
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }
          case "superops_tickets_apply_triage_plan": {
            const params = args as ApplyTriagePlanParams;
            const expected = Array.isArray(params.expectedCandidateTicketNumbers)
              ? params.expectedCandidateTicketNumbers
                  .map((ticketNumber) => normaliseTicketNumber(ticketNumber))
                  .filter(Boolean)
              : [];
            if (expected.length === 0) {
              return errorResult(
                "expectedCandidateTicketNumbers is required for Phase 3 apply triage plan."
              );
            }

            const actions = Array.isArray(params.actions) ? params.actions : [];
            const actionByTicket = new Map<string, TriagePlanAction>();
            for (const action of actions) {
              const ticketNumber = normaliseTicketNumber(action.ticketNumber);
              if (ticketNumber && !actionByTicket.has(ticketNumber)) {
                actionByTicket.set(ticketNumber, action);
              }
            }

            const results: ApplyTriagePlanResult[] = [];
            const executionConfig = getExecutionConfig();
            const estimatedCallsPerTriageItem = params.verify === false ? 5 : 8;
            let stopped = false;
            let executionStopped = false;

            for (let index = 0; index < expected.length; index += 1) {
              const ticketNumber = expected[index];
              const action = actionByTicket.get(ticketNumber);
              const remainingAfterThis = expected.length - index - 1;

              if (stopped) {
                const skipped = baseApplyResult(ticketNumber, action);
                skipped.finalOutcome = "Skipped";
                skipped.failureStage = "stopOnFirstFailure";
                skipped.failureReason = "Processing stopped after an earlier failure.";
                results.push(skipped);
                markExecutionItem({ completed: true, remainingItems: remainingAfterThis });
                continue;
              }

              if (
                index >= executionConfig.maxItemsPerBatch ||
                !hasExecutionBudgetFor(estimatedCallsPerTriageItem)
              ) {
                executionStopped = true;
                const reason = index >= executionConfig.maxItemsPerBatch
                  ? `Configured maxItemsPerBatch ${executionConfig.maxItemsPerBatch} reached before processing this ticket.`
                  : "Execution stopped before starting this ticket because the remaining invocation budget cannot safely cover the estimated read/write/verification calls.";
                for (let pendingIndex = index; pendingIndex < expected.length; pendingIndex += 1) {
                  const pendingTicketNumber = expected[pendingIndex];
                  results.push(
                    executionStoppedApplyResult(
                      pendingTicketNumber,
                      actionByTicket.get(pendingTicketNumber),
                      reason,
                      pendingIndex === index ? "FailedBeforeProcessing" : "NotAttemptedExecutionStopped"
                    )
                  );
                }
                markExecutionItem({ remainingItems: expected.length - index });
                break;
              }

              let result: ApplyTriagePlanResult;
              try {
                result = await withExecutionItem(ticketNumber, () =>
                  applyApprovedTriageAction({
                    client,
                    ticketNumber,
                    action,
                    dryRun: params.dryRun ?? false,
                    verify: params.verify ?? true,
                    dedupeNotes: params.dedupeNotes ?? true,
                    allowResolveFullFallbackToUpdate:
                      params.allowResolveFullFallbackToUpdate ?? false,
                    allowWriteIfUpdatedTimeChanged:
                      params.allowWriteIfUpdatedTimeChanged ?? false,
                    allowWriteWithoutVerifiedContent:
                      params.allowWriteWithoutVerifiedContent ?? false,
                  })
                );
              } catch (error) {
                const reason = safeErrorMessage(error);
                result = executionStoppedApplyResult(
                  ticketNumber,
                  action,
                  reason,
                  isExecutionBudgetError(error) ? "FailedBeforeProcessing" : "Failed"
                );
                if (!isExecutionBudgetError(error)) {
                  result.failureStage = "unexpected";
                }
                executionStopped = isExecutionBudgetError(error);
              }

              results.push(result);
              markExecutionItem({
                completed: true,
                remainingItems: remainingAfterThis,
                partialWrite: result.partialWrite,
                stale: result.finalOutcome === "SkippedChangedSinceSnapshot",
                verificationFailure: result.failureStage === "verifyFinalState" ||
                  result.failureStage === "verify",
              });

              if (executionStopped) {
                for (let pendingIndex = index + 1; pendingIndex < expected.length; pendingIndex += 1) {
                  const pendingTicketNumber = expected[pendingIndex];
                  results.push(
                    executionStoppedApplyResult(
                      pendingTicketNumber,
                      actionByTicket.get(pendingTicketNumber),
                      "Execution stopped after the previous item before the remaining tickets were attempted."
                    )
                  );
                }
                markExecutionItem({ remainingItems: expected.length - index - 1 });
                break;
              }

              if (
                params.stopOnFirstFailure &&
                [
                  "Blocked",
                  "Failed",
                  "NotFound",
                  "SkippedChangedSinceSnapshot",
                  "FailedBeforeProcessing",
                ].includes(result.finalOutcome)
              ) {
                stopped = true;
              }
            }

            const summary = summarizeApplyResults(results);
            const diagnostics = executionDiagnostics();
            const operationId =
              params.batchId ??
              (diagnostics?.operationId as string | undefined) ??
              `triage-${Date.now()}`;
            let operationPersisted = false;
            let operationStoreError: string | undefined;
            try {
              await getOperationStore().put(
                buildApplyTriageLedgerRecord({
                  operationId,
                  request: params,
                  expected,
                  results,
                  actionsByTicket: actionByTicket,
                  continuationRequired: executionStopped,
                  summary,
                })
              );
              operationPersisted = true;
            } catch (error) {
              operationStoreError = safeErrorMessage(error);
            }

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      batchId: params.batchId,
                      operation: {
                        operationId,
                        idempotencyKey: params.batchId ?? operationId,
                        complete: !executionStopped,
                        continuationRequired: executionStopped,
                        persisted: operationPersisted,
                        storeError: operationStoreError,
                      },
                      initialCandidateCount: expected.length,
                      expectedCandidateTicketNumbers: expected,
                      results,
                      summary,
                      execution: diagnostics,
                    },
                    null,
                    2
                  ),
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

            const finalStatus = params.status ?? DEFAULT_RESOLVE_TICKET_STATUS;
            let currentTicket: Ticket | undefined;
            const requiresResolvedPreflight =
              finalStatus === DEFAULT_RESOLVE_TICKET_STATUS;

            if (
              !requiresResolvedPreflight &&
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
              status: finalStatus,
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

            const optionParams: TicketClassificationParams = {
              priority: params.priority,
              impact: params.impact,
              urgency: params.urgency,
              category: params.category,
              subcategory: params.subcategory,
              cause: params.cause,
              resolutionCode: params.resolutionCode,
              status: params.status,
            };
            const optionFieldsToFetch = new Set<ValidatedTicketOptionField>(
              requestedValidatedOptionFields(optionParams)
            );
            if (requiresResolvedPreflight) {
              for (const fieldName of RESOLVED_REQUIRED_OPTION_FIELDS) {
                optionFieldsToFetch.add(fieldName);
              }
            }

            if (
              requiresResolvedPreflight &&
              RESOLVED_REQUIRED_FIELDS.some((fieldName) => !optionParams[fieldName])
            ) {
              currentTicket = await getTicketByInternalId(
                client,
                resolvedTicket.ticketId
              );
              for (const fieldName of RESOLVED_REQUIRED_FIELDS) {
                if (!optionParams[fieldName]) {
                  optionParams[fieldName] = ticketClassificationValue(
                    currentTicket,
                    fieldName
                  );
                }
              }
            }

            const optionFields =
              optionFieldsToFetch.size > 0
                ? await getTicketOptionFields(client, [...optionFieldsToFetch])
                : new Map<ValidatedTicketOptionField, SuperOpsField>();

            if (requiresResolvedPreflight) {
              const validationError = validateResolvedTicketFields({
                optionParams,
                optionFields,
                input: updateInput,
              });
              if (validationError) {
                return structuredValidationResult(validationError);
              }
              const optionalOptionFields = requestedValidatedOptionFields(
                optionParams
              ).filter(
                (fieldName) =>
                  !RESOLVED_REQUIRED_OPTION_FIELDS.includes(
                    fieldName as (typeof RESOLVED_REQUIRED_OPTION_FIELDS)[number]
                  )
              );
              const optionalValidationError = addValidatedTicketOptionUpdatesFromFields(
                optionFields,
                optionParams,
                updateInput,
                optionalOptionFields
              );
              if (optionalValidationError) {
                return structuredValidationResult(
                  validationFailure({
                    invalidFields: { classification: optionalValidationError },
                  })
                );
              }
            } else {
              const optionValidationError = addValidatedTicketOptionUpdatesFromFields(
                optionFields,
                optionParams,
                updateInput
              );
              if (optionValidationError) {
                return structuredValidationResult(
                  validationFailure({
                    invalidFields: { classification: optionValidationError },
                  })
                );
              }
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
              const requiredFields = mandatoryValidationFields(error);
              const message = requiredFields.length > 0
                ? mandatoryValidationRuntimeMessage(requiredFields, Boolean(createdNote))
                : error instanceof Error
                  ? error.message
                  : String(error);
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

              if (requiredFields.length > 0) {
                return structuredValidationResult(
                  validationFailure({
                    message,
                    missingFields: requiredFields,
                    validOptions: validOptionsForFields(
                      optionFields,
                      RESOLVED_REQUIRED_OPTION_FIELDS
                    ),
                  })
                );
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
                "priority",
                "impact",
                "urgency",
                "resolutionCode",
                "cause",
                "subcategory",
              ] as ValidatedTicketOptionField[]
            );
            if (optionValidationError) {
              return errorResult(optionValidationError);
            }
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
