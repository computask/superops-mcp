/**
 * SuperOps.ai Tickets Domain
 *
 * Tools for managing service tickets in SuperOps.ai PSA.
 */

import { getClient, SuperOpsError, SuperOpsHttpError } from "../client.js";
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
  assertExecutionBudget,
  classifyCloudflarePlatformLimit,
  executionDiagnostics,
  ExecutionBudgetExceededError,
  ExecutionCpuBudgetExceededError,
  ExecutionTimeoutBudgetExceededError,
  getExecutionConfig,
} from "../execution.js";
import {
  runOperationContinuation,
  type ContinuationItemOutcome,
  type OperationContinuationAdapter,
} from "../continuation.js";
import { scheduleApplyTriageContinuation } from "../continuation-scheduler.js";
import {
  currentOwnerHash,
  getOperationStore,
  normalizedNoteFingerprint,
  operationResultView,
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
  verify?: boolean;
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
  expectedSubjectHash?: string;
  expectedClient?: string;
  expectedClientHash?: string;
  expectedStatus?: string;
  expectedUpdatedTime?: string;
  contentVerified?: boolean;
  action: TriagePlanActionType;
  reason?: string;
  note?: string;
  noteFingerprint?: string;
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

const TRIAGE_PLAN_ACTION_TYPES = ["resolve", "update", "addNote", "leave", "skip"] as const;
const TRIAGE_PLAN_UPDATE_TARGET_FIELDS = [
  "status",
  "priority",
  "impact",
  "urgency",
  "category",
  "subcategory",
  "cause",
  "resolutionCode",
  "techGroupName",
  "clientName",
  "clientId",
  "suppressCloseNotification",
] as const;

const TRIAGE_PLAN_ACTION_FIELD_NAMES = [
  "ticketNumber",
  "expectedTicketId",
  "expectedSubject",
  "expectedSubjectHash",
  "expectedClient",
  "expectedClientHash",
  "expectedStatus",
  "expectedUpdatedTime",
  "contentVerified",
  "action",
  "reason",
  "note",
  "noteFingerprint",
  "isPublicNote",
  "target",
  "allowResolveFullFallbackToUpdate",
  "allowWriteIfUpdatedTimeChanged",
  "allowWriteWithoutVerifiedContent",
] as const;
const TRIAGE_PLAN_ACTION_FIELD_SET = new Set<string>(TRIAGE_PLAN_ACTION_FIELD_NAMES);
const TRIAGE_PLAN_TARGET_FIELD_SET = new Set<string>(TRIAGE_PLAN_UPDATE_TARGET_FIELDS);

const TRIAGE_PLAN_EXPECTATION_SCHEMA_PROPERTIES = {
  ticketNumber: {
    type: "string",
    description: "Ticket number/display ID from the approved snapshot.",
  },
  expectedTicketId: {
    type: "string",
    description: "Optional internal ticket ID expected from the approved snapshot.",
  },
  expectedSubject: {
    type: "string",
    description: "Optional exact subject expected from the approved snapshot.",
  },
  expectedSubjectHash: {
    type: "string",
    description: "Optional stable hash of the expected subject.",
  },
  expectedClient: {
    type: "string",
    description: "Optional exact client name expected from the approved snapshot.",
  },
  expectedClientHash: {
    type: "string",
    description: "Optional stable hash of the expected client name.",
  },
  expectedStatus: {
    type: "string",
    enum: [...VALID_TICKET_STATUSES],
    description: "Optional current status expected before applying the action.",
  },
  expectedUpdatedTime: {
    type: "string",
    description: "Current updatedTime from the approved snapshot; used to block stale writes.",
  },
  contentVerified: {
    type: "boolean",
    description: "Required true for mutating actions unless an explicit override is supplied.",
  },
  allowWriteIfUpdatedTimeChanged: {
    type: "boolean",
    default: false,
    description: "Per-action override allowing a write despite an updatedTime mismatch.",
  },
  allowWriteWithoutVerifiedContent: {
    type: "boolean",
    default: false,
    description: "Per-action override allowing a mutating write without contentVerified=true.",
  },
} as const;

const TRIAGE_PLAN_TARGET_SCHEMA_PROPERTIES = {
  status: {
    type: "string",
    enum: [...VALID_TICKET_STATUSES],
    description: "Target ticket status, e.g. Awaiting Engineer.",
  },
  priority: { type: "string", description: "Target priority display value from SuperOps field options." },
  impact: { type: "string", description: "Target impact display value from SuperOps field options." },
  urgency: { type: "string", description: "Target urgency display value from SuperOps field options." },
  category: { type: "string", enum: [...VALID_TICKET_CATEGORIES], description: "Target ticket category." },
  subcategory: { type: "string", description: "Target subcategory display value from SuperOps field options." },
  cause: { type: "string", description: "Target cause display value from SuperOps field options." },
  resolutionCode: { type: "string", description: "Target resolution code display value from SuperOps field options." },
  techGroupName: { type: "string", description: "Target technician group name." },
  clientName: { type: "string", description: "Target client/account name." },
  clientId: { type: "string", description: "Target client/account ID." },
  suppressCloseNotification: { type: "boolean", description: "Suppress SuperOps close notification where supported." },
} as const;

const TRIAGE_PLAN_UPDATE_TARGET_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: TRIAGE_PLAN_TARGET_SCHEMA_PROPERTIES,
  anyOf: TRIAGE_PLAN_UPDATE_TARGET_FIELDS.map((field) => ({ required: [field] })),
} as const;

const TRIAGE_PLAN_RESOLVE_TARGET_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...TRIAGE_PLAN_TARGET_SCHEMA_PROPERTIES,
    status: {
      type: "string",
      enum: [...VALID_TICKET_STATUSES],
      default: DEFAULT_RESOLVE_TICKET_STATUS,
      description: "Final resolve status. Defaults to Resolved.",
    },
  },
  required: ["category", "priority", "impact", "subcategory", "cause", "resolutionCode"],
} as const;

const TRIAGE_PLAN_ACTION_SCHEMA = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: {
        ...TRIAGE_PLAN_EXPECTATION_SCHEMA_PROPERTIES,
        action: { type: "string", const: "update" },
        target: TRIAGE_PLAN_UPDATE_TARGET_SCHEMA,
        note: { type: "string", description: "Optional private note to add after the update succeeds." },
        isPublicNote: { type: "boolean", default: false, description: "Whether the optional note is client-visible." },
      },
      required: ["ticketNumber", "expectedUpdatedTime", "contentVerified", "action", "target"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        ...TRIAGE_PLAN_EXPECTATION_SCHEMA_PROPERTIES,
        action: { type: "string", const: "resolve" },
        target: TRIAGE_PLAN_RESOLVE_TARGET_SCHEMA,
        note: { type: "string", description: "Optional private note to add after the resolve succeeds." },
        isPublicNote: { type: "boolean", default: false, description: "Whether the optional note is client-visible." },
        allowResolveFullFallbackToUpdate: {
          type: "boolean",
          default: false,
          description: "Allow controlled update fallback only after a SuperOps internal server error.",
        },
      },
      required: ["ticketNumber", "expectedUpdatedTime", "contentVerified", "action", "target"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        ...TRIAGE_PLAN_EXPECTATION_SCHEMA_PROPERTIES,
        action: { type: "string", const: "addNote" },
        note: { type: "string", description: "Private note body to add." },
        isPublicNote: { type: "boolean", default: false, description: "Whether the note is client-visible." },
      },
      required: ["ticketNumber", "expectedUpdatedTime", "contentVerified", "action", "note"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        ...TRIAGE_PLAN_EXPECTATION_SCHEMA_PROPERTIES,
        action: { type: "string", const: "leave" },
        reason: { type: "string", description: "Optional reason for leaving the ticket unchanged." },
      },
      required: ["ticketNumber", "action"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        ...TRIAGE_PLAN_EXPECTATION_SCHEMA_PROPERTIES,
        action: { type: "string", const: "skip" },
        reason: { type: "string", description: "Optional reason for skipping this approved candidate." },
      },
      required: ["ticketNumber", "action"],
    },
  ],
} as const;

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
  /** Compact retry metadata only; never include an upstream response body. */
  rateLimitRetryAfterMs?: number;
  rateLimitRetryAfterSupplied?: boolean;
  rateLimitRequestedDelayMs?: number;
  rateLimitDelaySource?: "retry-after" | "backoff";
  rateLimitConclusiveRejection?: boolean;
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

function validateTriagePlanActionShape(rawAction: unknown, index: number): string | undefined {
  const action = jsonRecord(rawAction);
  const label = `actions[${index}]`;
  if (!action) {
    return `${label} must be an object.`;
  }

  const unknownActionFields = Object.keys(action).filter(
    (field) => !TRIAGE_PLAN_ACTION_FIELD_SET.has(field)
  );
  if (unknownActionFields.length > 0) {
    return `${label} contains unsupported field(s): ${unknownActionFields.join(", ")}.`;
  }

  const ticketNumber = normaliseTicketNumber(action.ticketNumber);
  if (!ticketNumber) {
    return `${label}.ticketNumber is required.`;
  }

  if (
    typeof action.action !== "string" ||
    !(TRIAGE_PLAN_ACTION_TYPES as readonly string[]).includes(action.action)
  ) {
    return `${label}.action must be one of: ${TRIAGE_PLAN_ACTION_TYPES.join(", ")}.`;
  }

  const target = action.target === undefined ? undefined : jsonRecord(action.target);
  if (action.target !== undefined && !target) {
    return `${label}.target must be an object when supplied.`;
  }

  if (target) {
    const unknownTargetFields = Object.keys(target).filter(
      (field) => !TRIAGE_PLAN_TARGET_FIELD_SET.has(field)
    );
    if (unknownTargetFields.length > 0) {
      return `${label}.target contains unsupported field(s): ${unknownTargetFields.join(", ")}.`;
    }
  }

  if (action.action === "update") {
    if (!target) {
      return `${label} update action requires target with at least one mutable ticket field.`;
    }
    const hasRecognizedTarget = TRIAGE_PLAN_UPDATE_TARGET_FIELDS.some(
      (field) => target[field] !== undefined
    );
    if (!hasRecognizedTarget) {
      return `${label} update action requires at least one recognised mutable target field.`;
    }
  }

  if (
    action.action === "addNote" &&
    (typeof action.note !== "string" || action.note.trim().length === 0)
  ) {
    return `${label} addNote action requires a non-empty note.`;
  }
}

function validateTriagePlanActions(actions: unknown[]): string | undefined {
  for (const [index, action] of actions.entries()) {
    const validationError = validateTriagePlanActionShape(action, index);
    if (validationError) return validationError;
  }
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
  const text = value
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

function isBinaryLikeControlChar(char: string): boolean {
  const code = char.charCodeAt(0);
  return code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31);
}

function stripBinaryLikeControlText(value: string): { text: string; removed: boolean } {
  let output = "";
  let removed = false;
  let inRemovedRun = false;
  for (const char of value) {
    if (isBinaryLikeControlChar(char)) {
      removed = true;
      if (!inRemovedRun) {
        output += "[removed binary-like content]";
      }
      inRemovedRun = true;
      continue;
    }
    output += char;
    inRemovedRun = false;
  }
  return { text: output, removed };
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

  const strippedBinaryText = stripBinaryLikeControlText(text);
  if (strippedBinaryText.removed) {
    binaryRemoved = true;
    text = strippedBinaryText.text;
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
  if (maxChars <= 0) {
    return { text: "", truncated: value.length > 0 };
  }

  if (value.length <= maxChars) {
    return { text: value, truncated: false };
  }

  const marker = "\n\n[... content truncated by safe retrieval ...]\n\n";
  if (maxChars <= marker.length) {
    if (maxChars <= 3) {
      return { text: value.slice(0, maxChars), truncated: true };
    }
    return { text: `${value.slice(0, maxChars - 3)}...`, truncated: true };
  }

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

function uniqueTicketIds(ticketIds: (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const ticketId of ticketIds) {
    const normalized = typeof ticketId === "string" ? ticketId.trim() : "";
    if (normalized.length === 0 || seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(normalized);
  }
  return unique;
}

function addUniqueConversation(
  conversations: TicketConversation[],
  seenConversationIds: Set<string>,
  conversation: TicketConversation
): void {
  if (seenConversationIds.has(conversation.conversationId)) return;
  seenConversationIds.add(conversation.conversationId);
  conversations.push(conversation);
}

function addUniqueNote(
  notes: TicketNote[],
  seenNoteIds: Set<string>,
  note: TicketNote
): void {
  if (seenNoteIds.has(note.noteId)) return;
  seenNoteIds.add(note.noteId);
  notes.push(note);
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
    const remainingChars = safeParams.maxTotalChars - usedChars;
    if (remainingChars <= 0) {
      sanitization.itemsOmittedByLimit += 1;
      sanitization.truncated = true;
      continue;
    }

    if (item.plainText.length > remainingChars) {
      const truncated = truncateSafeText(item.plainText, remainingChars);
      if (truncated.text.length === 0) {
        sanitization.itemsOmittedByLimit += 1;
        sanitization.truncated = true;
        continue;
      }
      const limitedItem = {
        ...item,
        plainText: truncated.text,
        truncated: true,
      };
      usedChars += limitedItem.plainText.length;
      limitedItems.push(limitedItem);
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

async function collectSafeTicketContent(params: {
  client: SuperOpsClientInstance;
  ticket: Ticket;
  safeParams: Required<SafeTicketParams>;
  initialContentTicketIds?: string[];
  displayId?: string;
  displayIdMatches?: Ticket[];
}): Promise<{
  safeResult: ReturnType<typeof buildSafeTicketResult>;
  contentErrors: string[];
}> {
  const { client, ticket, safeParams, displayId, displayIdMatches } = params;
  const contentErrors: string[] = [];
  const conversations: TicketConversation[] = [];
  const notes: TicketNote[] = [];
  const seenConversationIds = new Set<string>();
  const seenNoteIds = new Set<string>();
  const readTicketIds = new Set<string>();
  let conversationReadSucceeded = false;

  async function readContentFromTicketIds(ticketIds: string[]): Promise<void> {
    for (const ticketId of uniqueTicketIds(ticketIds)) {
      if (readTicketIds.has(ticketId)) continue;
      readTicketIds.add(ticketId);

      if (safeParams.includeConversations) {
        try {
          const ticketConversations = await getTicketConversations(client, ticketId);
          conversationReadSucceeded = true;
          for (const conversation of ticketConversations) {
            addUniqueConversation(conversations, seenConversationIds, conversation);
          }
        } catch (error) {
          contentErrors.push(
            `Conversations could not be fetched safely: ${safeErrorMessage(error)}`
          );
        }
      }

      if (safeParams.includeNotes) {
        try {
          const ticketNotes = await getTicketNotes(client, ticketId);
          for (const note of ticketNotes) {
            addUniqueNote(notes, seenNoteIds, note);
          }
        } catch (error) {
          contentErrors.push(`Notes could not be fetched safely: ${safeErrorMessage(error)}`);
        }
      }
    }
  }

  await readContentFromTicketIds([
    ...(params.initialContentTicketIds ?? []),
    ticket.ticketId,
  ]);

  const hasDescription = conversations.some(
    (conversation) => conversation.type?.toUpperCase() === "DESCRIPTION"
  );

  if (safeParams.includeConversations && conversationReadSucceeded && !hasDescription) {
    const normalizedDisplayId = normaliseTicketNumber(displayId ?? ticket.displayId);
    let matches = displayIdMatches;

    if (!matches && normalizedDisplayId) {
      try {
        matches = await resolveTicketIdByDisplayId(client, normalizedDisplayId);
      } catch (error) {
        contentErrors.push(
          `Display-number content lookup could not be fetched safely: ${safeErrorMessage(error)}`
        );
      }
    }

    if (matches?.length === 1) {
      await readContentFromTicketIds([matches[0].ticketId]);
    } else if (matches && matches.length > 1) {
      contentErrors.push(
        `Display-number content lookup was not unique for ticket ${normalizedDisplayId}.`
      );
    }
  }

  return {
    safeResult: buildSafeTicketResult({
      ticket,
      safeParams,
      conversations,
      notes,
      contentErrors: contentErrors.length > 0 ? contentErrors : undefined,
    }),
    contentErrors,
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
    id: item.id,
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

  const collection = await collectSafeTicketContent({
    client,
    ticket,
    safeParams: safeParamsForTriageSnapshot(params),
    initialContentTicketIds: [candidate.ticketId],
    displayId: ticket.displayId ?? candidate.displayId,
  });

  contentErrors.push(...collection.contentErrors);
  return buildTriageSnapshotTicket({
    candidate,
    ticket,
    safeResult: collection.safeResult,
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

function uniqueTrimmedValues(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    unique.push(trimmed);
  }
  return unique;
}

function structuredValidationResult(
  failure: StructuredValidationFailure,
  writeContract: Record<string, unknown> = {}
): {
  content: { type: "text"; text: string }[];
  isError: true;
} {
  return {
    content: [{ type: "text", text: JSON.stringify({ ...failure, ...writeContract }, null, 2) }],
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


function isReliableSynchronousMutationRejection(error: unknown): boolean {
  if (error instanceof SuperOpsHttpError) {
    return error.status >= 400 && error.status < 500;
  }
  if (error instanceof SuperOpsError) {
    return /THROTTL|VALIDATION|BAD_USER_INPUT|UNAUTHENTICATED|FORBIDDEN/i.test(error.code ?? "");
  }
  return false;
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
  rawValue: unknown,
  params?: TicketClassificationParams
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
  const lowered = requested.toLowerCase();
  const exactMatches = options.filter((option) => option.value?.trim() === requested);
  const matches = exactMatches.length > 0 ? exactMatches : options.filter(
    (option) => option.value?.trim().toLowerCase() === lowered
  );

  if (matches.length === 0) {
    return {
      error: `Invalid ${label}: "${requested}". Valid values: ${formatValidOptionValues(values)}`,
    };
  }

  const parentFieldName =
    field.parentField?.columnName ?? FALLBACK_PARENT_FIELDS[fieldName];
  const parentValues = uniqueTrimmedValues(
    matches.map((option) => option.parentOption?.value)
  );
  const rawParent = parentFieldName && params
    ? (params as unknown as Record<string, unknown>)[parentFieldName]
    : undefined;
  const requestedParent = typeof rawParent === "string" && rawParent.trim().length > 0
    ? rawParent.trim()
    : undefined;

  if (parentFieldName && parentValues.length > 0) {
    if (requestedParent) {
      const parentMatches = matches.filter(
        (option) => option.parentOption?.value?.trim() === requestedParent
      );

      if (parentMatches.length === 1 && parentMatches[0].value) {
        return { value: parentMatches[0].value.trim(), option: parentMatches[0] };
      }

      if (parentMatches.length === 0) {
        return {
          error: `${label} "${requested}" belongs under ${parentFieldName} ${formatValidOptionValues(parentValues)}, not "${requestedParent}".`,
        };
      }

      return {
        error: `The ${label} value "${requested}" is ambiguous under ${parentFieldName} "${requestedParent}". Valid ${parentFieldName} values: ${formatValidOptionValues(parentValues)}`,
      };
    }

    if (matches.length > 1) {
      return {
        error: `The ${label} value "${requested}" is ambiguous. Include ${parentFieldName} in the same update. Valid ${parentFieldName} values: ${formatValidOptionValues(parentValues)}`,
      };
    }
  }

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

    const resolved = resolveOptionValue(fieldName, field, params[fieldName], params);
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

    const resolved = resolveOptionValue(fieldName, field, params[fieldName], params);
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

    const resolved = resolveOptionValue(fieldName, field, value, params.optionParams);
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

function isRateLimitError(error: unknown): boolean {
  if (error instanceof SuperOpsHttpError) return error.status === 429;
  if (error instanceof SuperOpsError) {
    return /rate|thrott|too_many_requests/i.test(error.code ?? "") ||
      /rate limit|too many requests|throttl/i.test(error.message);
  }
  const message = error instanceof Error ? error.message : String(error);
  return /rate limit|too many requests|status\s*429/i.test(message);
}

function rateLimitRetryMetadata(error: unknown): {
  delayMs: number;
  requestedDelayMs: number;
  retryAfterSupplied: boolean;
  delaySource: "retry-after" | "backoff";
  conclusiveRejection: boolean;
} {
  const retryAfterSeconds = error instanceof SuperOpsHttpError || error instanceof SuperOpsError
    ? error.retryAfter
    : undefined;
  const configured = getExecutionConfig();
  const retryAfterSupplied = typeof retryAfterSeconds === "number" && Number.isFinite(retryAfterSeconds);
  const requestedDelayMs = retryAfterSupplied
    ? Math.max(0, Math.ceil(retryAfterSeconds * 1000))
    : configured.backoffBaseDelayMs;
  // Durable waits may exceed the short in-invocation delay cap, but never the
  // configured durable retry window. The continuation runner applies the
  // durable single-wait cap before scheduling. A 429/structured throttle is a reliable
  // rejection, so a resumed adapter may make one bounded retry after re-read.
  return {
    delayMs: Math.min(requestedDelayMs, configured.maxDurableRetryDurationMs),
    requestedDelayMs,
    retryAfterSupplied,
    delaySource: retryAfterSupplied ? "retry-after" : "backoff",
    conclusiveRejection: error instanceof SuperOpsHttpError
      ? error.status === 429
      : error instanceof SuperOpsError && isRateLimitError(error),
  };
}

function ticketClientName(ticket: Ticket): string | undefined {
  return readableString(ticket.client, ["name", "accountName"]);
}

function ticketTechGroupName(ticket: Ticket): string | undefined {
  return readableString(ticket.techGroup, ["name", "groupName"]);
}


const DIRECT_TICKET_VERIFY_FIELDS = [
  "status",
  "priority",
  "impact",
  "urgency",
  "category",
  "subcategory",
  "cause",
  "resolutionCode",
] as const;

function synchronousWriteCount(attempted: number, maximum: number) {
  return { attempted, maximum, exact: true };
}

function verifyDirectTicketUpdate(input: Record<string, unknown>, ticket: Ticket): Record<string, unknown> {
  const finalState = ticketFinalState(ticket);
  const compared = DIRECT_TICKET_VERIFY_FIELDS.filter((field) => input[field] !== undefined);
  const mismatches = compared
    .filter((field) => finalState[field] !== input[field])
    .map((field) => ({ field, expected: input[field], observed: finalState[field] }));
  return {
    performed: true,
    possible: compared.length > 0,
    verified: compared.length > 0 && mismatches.length === 0,
    comparedFields: compared,
    mismatches,
    finalState,
    reason: compared.length === 0
      ? "No scalar ticket fields with a confirmed read-back mapping were supplied."
      : undefined,
  };
}

function noteVerificationResult(notes: TicketNote[], createdNote: TicketNote): Record<string, unknown> {
  const createdId = createdNote.noteId;
  const found = Boolean(createdId) && notes.some((note) => note.noteId === createdId);
  return {
    performed: true,
    possible: Boolean(createdId),
    verified: found,
    noteId: createdId,
    reason: createdId ? undefined : "Mutation response did not include a note ID for read-back verification.",
  };
}
function verificationSucceeded(verification: Record<string, unknown>): boolean {
  return verification.verified === true;
}

function synchronousVerificationFailureReason(verification: Record<string, unknown>): string {
  if (typeof verification.reason === "string") return verification.reason;
  if (Array.isArray(verification.mismatches) && verification.mismatches.length > 0) {
    return "Verification did not establish the requested final state: " +
      JSON.stringify(verification.mismatches);
  }
  return "Verification did not establish the requested final state.";
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
  if (
    (action.expectedSubject && ticket.subject !== action.expectedSubject) ||
    (action.expectedSubjectHash && stableHash(ticket.subject) !== action.expectedSubjectHash)
  ) {
    return {
      stage: "validateSubject",
      reason: "Ticket subject no longer matches the approved snapshot identity.",
    };
  }
  if (
    (action.expectedClient && ticketClientName(ticket) !== action.expectedClient) ||
    (action.expectedClientHash && stableHash(ticketClientName(ticket)) !== action.expectedClientHash)
  ) {
    return {
      stage: "validateClient",
      reason: "Ticket client no longer matches the approved snapshot identity.",
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

async function existingNoteMatchesFingerprint(
  client: SuperOpsClientInstance,
  ticketId: string,
  fingerprint: string | undefined
): Promise<boolean> {
  if (!fingerprint) return false;
  const notes = await getTicketNotes(client, ticketId);
  // Continuation recovery is deliberately private-note only. A public note with
  // identical text is neither evidence that the approved private note was
  // written nor a reason to skip its private write.
  return notes.some(
    (existing) => existing.privacyType === "PRIVATE" &&
      normalizedNoteFingerprint(existing.content) === fingerprint
  );
}

async function existingNoteMatches(
  client: SuperOpsClientInstance,
  ticketId: string,
  note: string
): Promise<boolean> {
  return existingNoteMatchesFingerprint(client, ticketId, normalizedNoteFingerprint(note));
}

async function addNoteForPlan(params: {
  client: SuperOpsClientInstance;
  ticketId: string;
  note?: string;
  isPublic?: boolean;
  dedupe: boolean;
  result: ApplyTriagePlanResult;
  beforeCheck?: () => Promise<void>;
  beforeCreate?: () => Promise<void>;
  afterCreate?: (note: TicketNote) => Promise<void>;
}): Promise<void> {
  if (typeof params.note !== "string" || params.note.trim().length === 0) {
    return;
  }
  await params.beforeCheck?.();
  if (params.dedupe && await existingNoteMatches(params.client, params.ticketId, params.note)) {
    params.result.noteDeduped = true;
    return;
  }
  await params.beforeCreate?.();
  const created = await createTicketNote(
    params.client,
    params.ticketId,
    params.note,
    params.isPublic ?? false
  );
  await params.afterCreate?.(created);
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

/**
 * A durable checkpoint failure must reach the continuation runner unchanged.
 * The last acknowledged ledger stage remains authoritative whether the failure
 * occurred before mutation, after a reliable response, or after verification.
 */
class DurableCheckpointError extends Error {
  constructor(cause: unknown) {
    super(`Durable checkpoint failed: ${safeErrorMessage(cause)}`);
    this.name = "DurableCheckpointError";
  }
}

function isExecutionStopError(error: unknown): boolean {
  return error instanceof ExecutionBudgetExceededError ||
    error instanceof ExecutionTimeoutBudgetExceededError ||
    error instanceof ExecutionCpuBudgetExceededError ||
    classifyCloudflarePlatformLimit(error) !== undefined;
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

function validationErrorClassForApplyResult(
  result: ApplyTriagePlanResult
): OperationItemState["errorClass"] | undefined {
  if (result.writeAttempted || result.partialWrite) return undefined;
  if (result.finalOutcome === "SkippedChangedSinceSnapshot") return undefined;
  if (result.failureStage?.startsWith("validate")) return "ValidationFailure";
  return [
    "contentVerification",
    "notePrivacy",
    "operationPayload",
    "noteContentUnavailable",
    "validation",
  ].includes(result.failureStage ?? "")
    ? "ValidationFailure"
    : undefined;
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
    finalState: result.finalState,
  };
}

function serializableApplyTriageRequest(
  request: ApplyTriagePlanParams,
  expected: string[]
): Record<string, unknown> {
  return {
    kind: "applyTriagePlan",
    schemaVersion: 1,
    batchId: request.batchId,
    expectedCandidateTicketNumbers: expected,
    actions: Array.isArray(request.actions)
      ? request.actions.map((action) => ({
          ticketNumber: normaliseTicketNumber(action.ticketNumber),
          expectedTicketId: action.expectedTicketId,
          expectedSubjectHash: action.expectedSubject
            ? stableHash(action.expectedSubject)
            : action.expectedSubjectHash,
          expectedClientHash: action.expectedClient
            ? stableHash(action.expectedClient)
            : action.expectedClientHash,
          expectedStatus: action.expectedStatus,
          expectedUpdatedTime: action.expectedUpdatedTime,
          contentVerified: action.contentVerified,
          action: action.action,
          noteFingerprint: action.note
            ? normalizedNoteFingerprint(action.note)
            : action.noteFingerprint,
          isPublicNote: action.isPublicNote,
          target: action.target ? { ...action.target } : undefined,
          allowResolveFullFallbackToUpdate: action.allowResolveFullFallbackToUpdate,
          allowWriteIfUpdatedTimeChanged: action.allowWriteIfUpdatedTimeChanged,
          allowWriteWithoutVerifiedContent: action.allowWriteWithoutVerifiedContent,
        }))
      : [],
    dryRun: request.dryRun ?? false,
    verify: request.verify ?? true,
    dedupeNotes: request.dedupeNotes ?? true,
    stopOnFirstFailure: request.stopOnFirstFailure ?? false,
    allowResolveFullFallbackToUpdate: request.allowResolveFullFallbackToUpdate ?? false,
    allowWriteIfUpdatedTimeChanged: request.allowWriteIfUpdatedTimeChanged ?? false,
    allowWriteWithoutVerifiedContent: request.allowWriteWithoutVerifiedContent ?? false,
  };
}

function operationRequestApplyTriageParams(
  request: Record<string, unknown> | undefined
): ApplyTriagePlanParams | undefined {
  if (!request || request.kind !== "applyTriagePlan") return undefined;
  return {
    batchId: typeof request.batchId === "string" ? request.batchId : undefined,
    expectedCandidateTicketNumbers: Array.isArray(request.expectedCandidateTicketNumbers)
      ? request.expectedCandidateTicketNumbers.map((value) => String(value))
      : [],
    actions: Array.isArray(request.actions)
      ? request.actions.filter((value): value is TriagePlanAction =>
          typeof value === "object" && value !== null &&
          typeof (value as { ticketNumber?: unknown }).ticketNumber === "string" &&
          typeof (value as { action?: unknown }).action === "string"
        )
      : [],
    dryRun: request.dryRun === true,
    verify: request.verify !== false,
    dedupeNotes: request.dedupeNotes !== false,
    stopOnFirstFailure: request.stopOnFirstFailure === true,
    allowResolveFullFallbackToUpdate: request.allowResolveFullFallbackToUpdate === true,
    allowWriteIfUpdatedTimeChanged: request.allowWriteIfUpdatedTimeChanged === true,
    allowWriteWithoutVerifiedContent: request.allowWriteWithoutVerifiedContent === true,
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
  const maxOperationLifetimeAt = new Date(
    now.getTime() + getExecutionConfig().operationMaxLifetimeSeconds * 1000
  );
  const itemStates = Object.fromEntries(
    params.expected.map((ticketNumber) => {
      const result = params.results.find((item) => item.ticketNumber === ticketNumber);
      const action = params.actionsByTicket.get(ticketNumber);
      const stage = result ? triageStageForResult(result) : "Unattempted";
      const state: OperationItemState = {
        itemKey: ticketNumber,
        stage,
        outcome: result?.finalOutcome,
        idempotencyKey: stableHash({ operationId: params.operationId, ticketNumber }),
        writeAttempted: result?.writeAttempted ?? false,
        writeMayHaveSucceeded: Boolean(result?.partialWrite),
        partialWrite: result?.partialWrite ?? false,
        mutationType: action?.action === "resolve"
          ? "resolution"
          : action?.action === "addNote"
            ? "note"
            : action?.action === "update"
              ? "update"
              : undefined,
        reliableResponseReceived: result?.writeAttempted ? result.partialWrite === false : undefined,
        observedMutationResult: result?.writeAttempted
          ? result.partialWrite ? "Ambiguous" : "Accepted"
          : undefined,
        canonicalTargetHash: action
          ? stableHash({ action: action.action, target: action.target, ticketNumber })
          : undefined,
        noteFingerprint: normalizedNoteFingerprint(action?.note) ?? action?.noteFingerprint,
        fallbackAllowed: action?.allowResolveFullFallbackToUpdate ??
          params.request.allowResolveFullFallbackToUpdate ?? false,
        fallbackAttempted: result?.fallbackAttempted ?? false,
        fallbackApplied: result?.fallbackResult === "Updated",
        fallbackVerified: result?.fallbackResult === "Updated" && result?.verified === true,
        verificationState: result?.verified
          ? "Verified"
          : result?.writeAttempted
            ? "Failed"
            : "NotRequired",
        retryCount: 0,
        failureReason: result?.failureReason ?? undefined,
        errorClass: result ? validationErrorClassForApplyResult(result) : undefined,
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
  const pendingExists = params.expected.some(
    (ticketNumber) => !params.results.some((result) => result.ticketNumber === ticketNumber)
  ) || unattemptedItems.length > 0;
  const terminalFailure = params.continuationRequired || pendingExists
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
    maxOperationLifetimeAt: maxOperationLifetimeAt.toISOString(),
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
    operationRequest: serializableApplyTriageRequest(params.request, params.expected),
    state: pendingExists
      ? params.continuationRequired ? "ContinuationRequired" : "Running"
      : "Completed",
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
    continuationCount: 0,
    terminalFailureReason: terminalFailure,
  };
}
const APPLY_TRIAGE_TERMINAL_ITEM_STAGES = new Set<OperationItemState["stage"]>([
  "Completed",
  "CompletedAfterRetry",
  "CompletedAfterAmbiguousWriteVerification",
  "AmbiguousWriteUnresolved",
  "Stale",
  "Skipped",
  "FailedBeforeWrite",
  "FailedAfterPartialWrite",
  "RateLimitExceeded",
  "StaleAfterRateLimitWait",
]);

function applyTriageItemHasPossibleWrite(item: OperationItemState): boolean {
  if (item.writeMayHaveSucceeded) return true;
  if (item.observedMutationResult === "Accepted" || item.observedMutationResult === "VerifiedApplied") {
    return true;
  }
  return item.writeAttempted &&
    item.reliableResponseReceived !== true &&
    item.observedMutationResult !== "Rejected";
}

function applyTriageOperationVerificationState(
  items: OperationItemState[],
  conservativeOutcome?: ContinuationItemOutcome
): "Verified" | "Failed" | "Pending" | undefined {
  if (conservativeOutcome?.verificationFailed === true) return "Failed";

  const possibleWriteItems = items.filter(applyTriageItemHasPossibleWrite);
  if (possibleWriteItems.some((item) => item.verificationState === "Failed")) {
    return "Failed";
  }
  if (possibleWriteItems.length > 0) {
    return possibleWriteItems.every((item) =>
      APPLY_TRIAGE_TERMINAL_ITEM_STAGES.has(item.stage) &&
      item.verificationState === "Verified" &&
      item.partialWrite !== true &&
      item.ambiguousWrite !== true
    )
      ? "Verified"
      : "Pending";
  }

  if (conservativeOutcome?.verified === true) return "Verified";
  if (conservativeOutcome?.writeMayHaveSucceeded === true || conservativeOutcome?.partialWrite === true) {
    return "Pending";
  }
  return undefined;
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

function completeApplyResultsFromLedger(
  record: OperationLedgerRecord,
  expected: string[],
  actionsByTicket: Map<string, TriagePlanAction>
): ApplyTriagePlanResult[] {
  const compactByTicket = new Map(
    record.compactResults.flatMap((value) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
      const result = value as Partial<ApplyTriagePlanResult>;
      return typeof result.ticketNumber === "string"
        ? [[result.ticketNumber, result as ApplyTriagePlanResult] as const]
        : [];
    })
  );
  return expected.map((ticketNumber) => {
    const compact = compactByTicket.get(ticketNumber);
    if (compact) return compact;
    const item = record.itemStates[ticketNumber];
    const pending = record.pendingItems.includes(ticketNumber);
    return {
      ticketNumber,
      requestedAction: actionsByTicket.get(ticketNumber)?.action,
      finalOutcome: pending ? "NotAttemptedExecutionStopped" : "Failed",
      failureStage: pending ? "executionBudget" : "continuation",
      failureReason: item?.failureReason ?? (pending
        ? "The durable operation has not attempted this item yet."
        : "The item reached a terminal ledger state without a compact result."),
      writeAttempted: item?.writeAttempted ?? false,
      noteAdded: Boolean(item?.createdNoteId),
      noteDeduped: false,
      fallbackAttempted: item?.fallbackAttempted ?? false,
      partialWrite: item?.partialWrite ?? false,
      verified: item?.verificationState === "Verified",
    };
  });
}

type DurableMutationType = "update" | "resolution" | "note" | "resolveFallback";

type ConclusiveMutationRejection = {
  delayMs: number;
  requestedDelayMs: number;
  retryAfterSupplied: boolean;
  delaySource: "retry-after" | "backoff";
  conclusiveRejection: boolean;
};

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
  beforeNoteCheck?: () => Promise<void>;
  beforeMutation?: (mutationType: DurableMutationType) => Promise<void>;
  afterMutation?: (
    mutationType: DurableMutationType,
    observed: { ticketId?: string; noteId?: string }
  ) => Promise<void>;
  afterConclusiveRejection?: (
    mutationType: DurableMutationType,
    rejection: ConclusiveMutationRejection,
    failureReason: string | undefined
  ) => Promise<void>;
  afterVerification?: (mutationType: "update" | "resolution" | "note") => Promise<void>;
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
    if (isExecutionStopError(error)) throw error;
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
      result.writeMethod = "createTicketNote";
      await addNoteForPlan({
        client,
        ticketId: ticket.ticketId,
        note: action.note,
        isPublic: action.isPublicNote,
        dedupe: params.dedupeNotes,
        result,
        beforeCheck: params.beforeNoteCheck,
        beforeCreate: async () => {
          await (params.beforeMutation?.("note") ?? Promise.resolve());
          result.writeAttempted = true;
        },
        afterCreate: (note) => params.afterMutation?.("note", {
          ticketId: ticket.ticketId,
          noteId: note.noteId,
        }) ?? Promise.resolve(),
      });
      result.finalOutcome = "Updated";
      if (params.verify) {
        try {
          const verified = await getTicketByInternalId(client, ticket.ticketId);
          result.finalState = ticketFinalState(verified);
          result.observedFinalState = result.finalState;
          result.verifiedState = result.finalState;
          result.verified = true;
          await params.afterVerification?.("note");
        } catch (error) {
          if (error instanceof DurableCheckpointError || isExecutionStopError(error)) throw error;
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

      result.attemptedState = updateInput as Record<string, unknown>;
      result.writeMethod = action.action === "resolve" ? "resolve_full" : "update";
      const mutationType: DurableMutationType = action.action === "resolve" ? "resolution" : "update";
      try {
        await params.beforeMutation?.(mutationType);
        result.writeAttempted = true;
        const mutationResult = await mutateTicketUpdate(
          client,
          updateInput as Record<string, unknown>
        );
        await params.afterMutation?.(mutationType, { ticketId: mutationResult.ticketId });
      } catch (error) {
        if (error instanceof DurableCheckpointError || isExecutionStopError(error)) throw error;
        if (isRateLimitError(error)) {
          const rateLimit = rateLimitRetryMetadata(error);
          result.finalOutcome = "Failed";
          result.failureStage = "rateLimit";
          result.failureReason = safeErrorMessage(error);
          result.rateLimitRetryAfterMs = rateLimit.delayMs;
          result.rateLimitRequestedDelayMs = rateLimit.requestedDelayMs;
          result.rateLimitRetryAfterSupplied = rateLimit.retryAfterSupplied;
          result.rateLimitDelaySource = rateLimit.delaySource;
          result.rateLimitConclusiveRejection = rateLimit.conclusiveRejection;
          // The outbound write checkpoint remains conservative. The response
          // classification separately records that this particular request was
          // reliably rejected and therefore eligible for one checked retry.
          result.partialWrite = !rateLimit.conclusiveRejection && (result.writeAttempted || result.noteAdded);
          if (rateLimit.conclusiveRejection) {
            await params.afterConclusiveRejection?.(mutationType, rateLimit, result.failureReason ?? undefined);
          }
          return result;
        }
        const fallbackAllowed = action.allowResolveFullFallbackToUpdate ?? params.allowResolveFullFallbackToUpdate;
        if (action.action === "resolve" && fallbackAllowed &&
            !isReliableSynchronousMutationRejection(error) && mandatoryValidationFields(error).length === 0) {
          result.failureStage = "resolve_full";
          result.failureReason = safeErrorMessage(error);
          result.writeAttempted = true;
          result.partialWrite = true;
          let reread: Ticket;
          try {
            reread = await getTicketByInternalId(client, ticket.ticketId);
          } catch (rereadError) {
            result.finalOutcome = "Failed";
            result.failureStage = "ambiguousWrite";
            result.failureReason = "Ambiguous resolution response could not be reconciled: " +
              safeErrorMessage(rereadError);
            result.fallbackResult = "Ambiguous resolution response remains unresolved; fallback was not attempted.";
            return result;
          }
          if (targetAppliedToTicket(action, reread)) {
            result.finalOutcome = "Resolved";
            result.failureStage = null;
            result.failureReason = null;
            result.partialWrite = false;
            result.finalState = ticketFinalState(reread);
            result.observedFinalState = result.finalState;
            result.verifiedState = result.finalState;
            result.verified = true;
            result.fallbackResult = "Not required; intended resolution is already visible.";
            await params.afterVerification?.("resolution");
            return result;
          } else if (reread.updatedTime !== ticket.updatedTime) {
            result.finalOutcome = "SkippedChangedSinceSnapshot";
            result.fallbackResult = "Ticket changed after the ambiguous resolution response; fallback was not attempted.";
            return result;
          } else {
            const rereadFailure = validateExpectedTicket(ticketNumber, action, reread, true);
            if (rereadFailure) {
              result.finalOutcome = "Blocked";
              result.fallbackResult = rereadFailure.reason;
              return result;
            }
            result.finalOutcome = "Failed";
            result.failureStage = "ambiguousWrite";
            result.failureReason = "Ambiguous resolution response was not observed, but non-acceptance was not conclusively proven.";
            result.fallbackResult = "Ambiguous resolution response remains unresolved; fallback was not attempted.";
            return result;
          }
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
        if (isExecutionStopError(error)) throw error;
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
      await params.afterVerification?.(action.action === "resolve" ? "resolution" : "update");

      try {
        await addNoteForPlan({
          client,
          ticketId: ticket.ticketId,
          note: action.note,
          isPublic: action.isPublicNote,
          dedupe: params.dedupeNotes,
          result,
          beforeCheck: params.beforeNoteCheck,
          beforeCreate: async () => {
            await (params.beforeMutation?.("note") ?? Promise.resolve());
            result.writeAttempted = true;
          },
          afterCreate: (note) => params.afterMutation?.("note", {
            ticketId: ticket.ticketId,
            noteId: note.noteId,
          }) ?? Promise.resolve(),
        });
      } catch (error) {
        if (error instanceof DurableCheckpointError || isExecutionStopError(error)) throw error;
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
    if (error instanceof DurableCheckpointError || isExecutionStopError(error)) throw error;
    const rateLimited = isRateLimitError(error);
    result.finalOutcome = "Failed";
    result.failureStage = rateLimited
      ? "rateLimit"
      : result.writeMethod === "createTicketNote" ? "createTicketNote" : "write";
    result.failureReason = safeErrorMessage(error);
    if (rateLimited) {
      const rateLimit = rateLimitRetryMetadata(error);
      result.rateLimitRetryAfterMs = rateLimit.delayMs;
          result.rateLimitRequestedDelayMs = rateLimit.requestedDelayMs;
          result.rateLimitRetryAfterSupplied = rateLimit.retryAfterSupplied;
          result.rateLimitDelaySource = rateLimit.delaySource;
          result.rateLimitConclusiveRejection = rateLimit.conclusiveRejection;
      // NoteWriteStarted remains the durable mutation boundary. A reliable
      // rejection permits only a later re-read/dedupe/revalidation cycle; an
      // ambiguous transport or upstream failure remains possible-write truth.
      result.partialWrite = !rateLimit.conclusiveRejection &&
        (result.writeAttempted || result.noteAdded);
      if (rateLimit.conclusiveRejection) {
        const mutationType: DurableMutationType = result.writeMethod === "createTicketNote"
          ? "note"
          : result.writeMethod === "resolve_full"
            ? "resolution"
            : "update";
        await params.afterConclusiveRejection?.(mutationType, rateLimit, result.failureReason ?? undefined);
      }
    } else {
      result.partialWrite = result.writeAttempted || result.noteAdded;
    }
    return result;
  }
}

function applyResultToContinuationOutcome(
  result: ApplyTriagePlanResult,
  stage: OperationItemState["stage"] = triageStageForResult(result),
  priorObservedMutationResult?: OperationItemState["observedMutationResult"]
): ContinuationItemOutcome {
  const rateLimitReschedule = result.failureStage === "rateLimit" &&
    result.rateLimitConclusiveRejection === true;
  const ambiguousMutation = result.writeAttempted && result.partialWrite && (
    result.failureStage === "update" || result.failureStage === "resolve_full" ||
    result.failureStage === "createTicketNote" || result.failureStage === "write" ||
    result.failureStage === "ambiguousWrite"
  );
  const persistedStage = result.failureStage === "ambiguousWrite"
    ? "AmbiguousWriteUnresolved"
    : ambiguousMutation
      ? result.failureStage === "createTicketNote"
      ? "NoteWriteAmbiguous"
      : result.failureStage === "resolve_full"
        ? "ResolutionWriteAmbiguous"
        : "WriteAmbiguous"
    : stage;
  return {
    stage: rateLimitReschedule ? "RateLimitedRescheduled" : persistedStage,
    outcome: rateLimitReschedule ? "SuperOpsRateLimitRescheduled" :
      result.failureStage === "ambiguousWrite" ? "AmbiguousWriteUnresolved" : result.finalOutcome,
    writeAttempted: result.writeAttempted,
    // A conclusive throttle proves this mutation was not accepted. Ambiguous
    // transports remain conservative; only a reliable rejection can clear
    // possible-write state and authorise a checked retry.
    writeMayHaveSucceeded: rateLimitReschedule ? false : result.writeAttempted || result.partialWrite,
    reliableResponseReceived: rateLimitReschedule ? true : undefined,
    retryDelaySource: result.rateLimitDelaySource,
    retryAfterSupplied: result.rateLimitRetryAfterSupplied,
    suppliedDelayMs: result.rateLimitRetryAfterSupplied ? result.rateLimitRequestedDelayMs : undefined,
    retryOperationName: result.writeMethod === "createTicketNote" ? "CreateTicketNote" : "UpdateTicket",
    retryEndpoint: "SuperOps GraphQL /msp",
    observedMutationResult: rateLimitReschedule
      ? "Rejected"
      : result.verified
        ? priorObservedMutationResult === "Rejected" && !result.writeAttempted
          ? "Rejected"
          : "VerifiedApplied"
        : ambiguousMutation ? "Ambiguous" : undefined,
    partialWrite: result.partialWrite,
    verified: result.verified,
    rateLimited: rateLimitReschedule,
    nextEligibleTime: rateLimitReschedule
      ? new Date(Date.now() + (result.rateLimitRetryAfterMs ?? 0)).toISOString()
      : undefined,
    verificationFailed: result.failureStage === "verify" || result.failureStage === "verifyFinalState",
    stale: result.finalOutcome === "SkippedChangedSinceSnapshot",
    failureReason: result.failureReason ?? undefined,
    result: compactApplyResult(result),
    errorClass: rateLimitReschedule
      ? "SuperOpsRateLimit"
      : result.finalOutcome === "SkippedChangedSinceSnapshot"
        ? "StaleData"
      : result.failureStage === "ambiguousWrite" || ambiguousMutation
        ? "AmbiguousWrite"
      : result.failureStage === "verify" || result.failureStage === "verifyFinalState"
        ? "VerificationMismatch"
      : result.partialWrite
        ? "AmbiguousWrite"
        : validationErrorClassForApplyResult(result),
  };
}

function actionByTicketFromApplyParams(params: ApplyTriagePlanParams): Map<string, TriagePlanAction> {
  const actions = Array.isArray(params.actions) ? params.actions : [];
  const actionByTicket = new Map<string, TriagePlanAction>();
  for (const action of actions) {
    const ticketNumber = normaliseTicketNumber(action.ticketNumber);
    if (ticketNumber && !actionByTicket.has(ticketNumber)) {
      actionByTicket.set(ticketNumber, action);
    }
  }
  return actionByTicket;
}

function publicNoteBlockedResult(ticketNumber: string, action: TriagePlanAction): ApplyTriagePlanResult {
  const result = baseApplyResult(ticketNumber, action);
  result.finalOutcome = "Blocked";
  result.failureStage = "notePrivacy";
  result.failureReason = "Continuation will not create public notes; approved triage notes must be private.";
  return result;
}

function targetAppliedToTicket(action: TriagePlanAction, ticket: Ticket): boolean {
  if (action.action === "addNote") return false;
  return verifyFinalTargetState(action, ticket).mismatches.length === 0;
}

async function ambiguityCheckedTriageResult(params: {
  client: SuperOpsClientInstance;
  ticketNumber: string;
  action: TriagePlanAction;
  applyParams: ApplyTriagePlanParams;
  previousRetryCount: number;
  ambiguityStage: OperationItemState["stage"];
  beforeNoteCheck?: () => Promise<void>;
  beforeMutation?: (mutationType: DurableMutationType) => Promise<void>;
  afterMutation?: (
    mutationType: DurableMutationType,
    observed: { ticketId?: string; noteId?: string }
  ) => Promise<void>;
  afterConclusiveRejection?: (
    mutationType: DurableMutationType,
    rejection: ConclusiveMutationRejection,
    failureReason: string | undefined
  ) => Promise<void>;
  afterVerification?: (mutationType: "update" | "resolution" | "note") => Promise<void>;
}): Promise<{ result: ApplyTriagePlanResult; stage?: OperationItemState["stage"]; retryCount?: number }> {
  const { client, ticketNumber, action, applyParams } = params;
  if (action.isPublicNote === true && Boolean(action.noteFingerprint ?? normalizedNoteFingerprint(action.note))) {
    return { result: publicNoteBlockedResult(ticketNumber, action) };
  }

  const resolved = await resolveTicketId(client, { ticketNumber });
  if (resolved.error || !resolved.ticketId) {
    const result = baseApplyResult(ticketNumber, action);
    result.finalOutcome = "NotFound";
    result.failureStage = "ambiguityRead";
    result.failureReason = resolved.error ?? "Ticket was not found while resolving an ambiguous write.";
    return { result };
  }

  const ticket = await getTicketByInternalId(client, resolved.ticketId);
  if (
    action.action === "addNote" ||
    params.ambiguityStage === "NoteWriteStarted" ||
    params.ambiguityStage === "NoteWriteAmbiguous"
  ) {
    const result = baseApplyResult(ticketNumber, action, ticket);
    result.writeAttempted = true;
    result.writeMethod = "createTicketNote";
    const fingerprint = action.noteFingerprint ?? normalizedNoteFingerprint(action.note);
    if (await existingNoteMatchesFingerprint(client, ticket.ticketId, fingerprint)) {
      result.noteDeduped = true;
      result.finalOutcome = "Updated";
      result.verified = true;
      result.verifiedState = ticketFinalState(ticket);
      return { result, stage: "CompletedAfterAmbiguousWriteVerification" };
    }
    result.finalOutcome = "Failed";
    result.failureStage = "ambiguousWrite";
    result.failureReason = "Ambiguous private-note write was not observed; it will not be retried automatically.";
    result.partialWrite = true;
    return { result, stage: "AmbiguousWriteUnresolved" };
  }
  const targetApplied = targetAppliedToTicket(action, ticket);
  const allowChanged = action.allowWriteIfUpdatedTimeChanged ?? applyParams.allowWriteIfUpdatedTimeChanged ?? false;
  const validationFailure = targetApplied
    ? validateExpectedTicket(ticketNumber, { ...action, expectedStatus: undefined, expectedUpdatedTime: undefined }, ticket, true)
    : validateExpectedTicket(ticketNumber, action, ticket, allowChanged);
  if (validationFailure) {
    const result = baseApplyResult(ticketNumber, action, ticket);
    result.finalOutcome = validationFailure.outcome ?? "Blocked";
    result.failureStage = validationFailure.stage;
    result.failureReason = validationFailure.reason;
    result.partialWrite = true;
    return {
      result,
      stage: validationFailure.outcome === "SkippedChangedSinceSnapshot"
        ? "StaleAfterRateLimitWait"
        : "AmbiguousWriteUnresolved",
    };
  }

  if (targetApplied) {
    const result = baseApplyResult(ticketNumber, action, ticket);
    result.writeAttempted = true;
    result.writeMethod = action.action === "resolve" ? "resolve_full" : "update";
    result.finalOutcome = action.action === "resolve" ? "Resolved" : "Updated";
    result.finalState = ticketFinalState(ticket);
    result.observedFinalState = result.finalState;
    result.verifiedState = result.finalState;
    result.verified = true;
    await params.afterVerification?.(action.action === "resolve" ? "resolution" : "update");

    try {
      await addNoteForPlan({
        client,
        ticketId: ticket.ticketId,
        note: action.note,
        isPublic: false,
        dedupe: applyParams.dedupeNotes ?? true,
        result,
        beforeCheck: params.beforeNoteCheck,
        beforeCreate: async () => {
          await (params.beforeMutation?.("note") ?? Promise.resolve());
          result.writeAttempted = true;
        },
        afterCreate: (note) => params.afterMutation?.("note", {
          ticketId: ticket.ticketId,
          noteId: note.noteId,
        }) ?? Promise.resolve(),
      });
    } catch (error) {
      result.finalOutcome = "Failed";
      result.failureStage = "createTicketNote";
      result.failureReason = safeErrorMessage(error);
      result.partialWrite = true;
      return { result, stage: "FailedAfterPartialWrite" };
    }

    return { result, stage: "CompletedAfterAmbiguousWriteVerification" };
  }

  // A WriteStarted checkpoint means the preceding invocation may have reached
  // SuperOps even when no matching target is visible on this read.  Retrying
  // would replay a possible successful mutation and requires a backward stage
  // transition, so retain an explicit unresolved ambiguity instead.
  const result = baseApplyResult(ticketNumber, action, ticket);
  result.finalOutcome = "Failed";
  result.failureStage = "ambiguousWrite";
  result.failureReason = "Ambiguous write was not observed; it will not be retried automatically.";
  result.writeAttempted = true;
  result.partialWrite = true;
  return { result, stage: "AmbiguousWriteUnresolved" };
}

function createApplyTriageContinuationAdapter(
  client: SuperOpsClientInstance,
  liveParams?: ApplyTriagePlanParams
): OperationContinuationAdapter {
  return {
    toolName: "superops_tickets_apply_triage_plan",
    estimateItemSubrequests(record, itemKey) {
      const storedParams = operationRequestApplyTriageParams(record.operationRequest);
      const action = actionByTicketFromApplyParams(storedParams ?? {}).get(itemKey);
      if (!action) return 2;
      if (action.action === "leave" || action.action === "skip") return 3;
      if (action.action === "addNote") {
        const validationAndDedupeReads = 2 + (storedParams?.dedupeNotes === false ? 0 : 1);
        const postMutationVerification = storedParams?.verify === false ? 0 : 2;
        return validationAndDedupeReads + 5 + postMutationVerification;
      }
      const target = action.target ?? {};
      const optionLookup = action.action === "resolve" ||
        [target.priority, target.impact, target.urgency, target.resolutionCode,
          target.cause, target.subcategory].some(Boolean) ? 1 : 0;
      const clientLookup = target.clientName && !target.clientId ? 1 : 0;
      const techGroupLookup = target.techGroupName ? 1 : 0;
      const validationReads = 2 + optionLookup + clientLookup + techGroupLookup;
      // Each read retry is separately budget-checked by SuperOpsClient. This
      // estimate reserves the required first attempt; the mutation hook then
      // reserves all required checkpoints, one write, and one read-back.
      return validationReads + 8;
    },
    async processItem({ record, claim, checkpoint }) {
      const storedParams = operationRequestApplyTriageParams(record.operationRequest);
      if (!storedParams || !Array.isArray(storedParams.expectedCandidateTicketNumbers)) {
        return {
          stage: "FailedBeforeWrite",
          outcome: "Validation failed",
          writeAttempted: false,
          writeMayHaveSucceeded: false,
          partialWrite: false,
          failureReason: "Stored apply-triage operation payload is missing or malformed.",
          errorClass: "ValidationFailure",
          result: {
            ticketNumber: claim.itemKey,
            finalOutcome: "Failed",
            failureStage: "operationPayload",
            failureReason: "Stored apply-triage operation payload is missing or malformed.",
            writeAttempted: false,
            partialWrite: false,
          },
        };
      }

      let action = actionByTicketFromApplyParams(liveParams ?? {}).get(claim.itemKey) ??
        actionByTicketFromApplyParams(storedParams).get(claim.itemKey);
      if (action?.isPublicNote === true && Boolean(action.noteFingerprint ?? normalizedNoteFingerprint(action.note))) {
        return applyResultToContinuationOutcome(publicNoteBlockedResult(claim.itemKey, action));
      }
      if (action?.noteFingerprint && !action.note) {
        const recovered = await getOperationStore().getApprovedPrivateNote(
          record.operationId,
          record.ownerHash,
          claim.itemKey,
          action.noteFingerprint
        );
        if (recovered && normalizedNoteFingerprint(recovered) === action.noteFingerprint) {
          action = { ...action, note: recovered, isPublicNote: false };
        }
      }
      if (
        action?.noteFingerprint && !action.note && !claim.item.createdNoteId &&
        claim.item.stage !== "NoteAdded" &&
        claim.item.stage !== "NoteWriteStarted" &&
        claim.item.stage !== "NoteWriteAmbiguous"
      ) {
        const possiblePriorWrite = claim.item.writeMayHaveSucceeded && claim.item.observedMutationResult !== "Rejected";
        return {
          stage: possiblePriorWrite ? "FailedAfterPartialWrite" : "FailedBeforeWrite",
          outcome: "ApprovedNoteContentUnavailable",
          writeAttempted: claim.item.writeAttempted,
          writeMayHaveSucceeded: claim.item.writeMayHaveSucceeded,
          partialWrite: possiblePriorWrite,
          failureReason: "The approved private-note body is intentionally not persisted; this item cannot create it after process loss.",
          errorClass: possiblePriorWrite ? "ContinuationFailure" : "ValidationFailure",
          result: {
            ticketNumber: claim.itemKey,
            finalOutcome: "Failed",
            failureStage: "noteContentUnavailable",
            failureReason: "Approved private-note content is unavailable to the resumed invocation.",
            writeAttempted: claim.item.writeAttempted,
            partialWrite: possiblePriorWrite,
          },
        };
      }

      let checkpointStage = claim.item.stage;
      let reliableResponseReceived = claim.item.reliableResponseReceived === true;
      let observedMutationResult = claim.item.observedMutationResult;
      let durableWriteAttempted = claim.item.writeAttempted === true;
      let durableWriteMayHaveSucceeded = claim.item.writeMayHaveSucceeded === true;
      let durableAttemptCount = claim.item.attemptCount ?? 0;
      let fallbackAttempted = claim.item.fallbackAttempted === true;
      let fallbackApplied = claim.item.fallbackApplied === true;
      const canonicalTargetHash = stableHash({
        ticketNumber: claim.itemKey,
        action: action?.action,
        target: action?.target,
        noteFingerprint: action?.noteFingerprint ?? normalizedNoteFingerprint(action?.note),
      });
      const beforeNoteCheck = async () => {
        if (checkpointStage === "NoteChecked") return;
        try {
          await checkpoint({
            stage: "NoteChecked",
            mutationType: "note",
            writeAttempted: durableWriteAttempted,
            writeMayHaveSucceeded: durableWriteMayHaveSucceeded,
            reliableResponseReceived,
            observedMutationResult,
            canonicalTargetHash,
            noteFingerprint: action?.noteFingerprint ?? normalizedNoteFingerprint(action?.note),
            fallbackAllowed: action?.allowResolveFullFallbackToUpdate ??
              storedParams.allowResolveFullFallbackToUpdate ?? false,
            fallbackAttempted,
            fallbackApplied,
            partialWrite: claim.item.partialWrite,
            verificationState: "Pending",
          });
          checkpointStage = "NoteChecked";
        } catch (error) {
          throw new DurableCheckpointError(error);
        }
      };
      const beforeMutation = async (
        mutationType: DurableMutationType
      ) => {
        const checkpointCount = mutationType === "note" ? 2 : mutationType === "resolveFallback" ? 1 : 3;
        const verificationReserve = mutationType === "note"
          ? (storedParams.verify === false ? 0 : 2)
          : 2;
        // Reserve the start checkpoint(s), one write, accepted-response
        // checkpoint, required read-back/checkpoint, and final ledger commit.
        // If this does not fit, no mutation-start checkpoint or write occurs.
        assertExecutionBudget(checkpointCount + 1 + 1 + verificationReserve + 1);
        try {
          const stages: OperationItemState["stage"][] = mutationType === "note"
            ? ["NoteChecked", "NoteWriteStarted"]
            : mutationType === "resolution"
              ? ["Validated", "ResolutionValidated", "ResolutionWriteStarted"]
              : mutationType === "resolveFallback"
                ? ["ResolutionWriteStarted"]
                : ["Validated", "WriteNotStarted", "WriteStarted"];
const completedStageIndex = mutationType === "resolveFallback"
  ? -1
  : stages.indexOf(checkpointStage);

const remainingStages = completedStageIndex >= 0
  ? stages.slice(completedStageIndex + 1)
  : stages;

for (const stage of remainingStages) {
            const mutationStarted = stage === "WriteStarted" ||
              stage === "ResolutionWriteStarted" || stage === "NoteWriteStarted";
            const nextWriteAttempted = durableWriteAttempted || mutationStarted;
            const nextWriteMayHaveSucceeded = durableWriteMayHaveSucceeded || mutationStarted;
            const nextReliableResponseReceived = mutationStarted
              ? false
              : reliableResponseReceived;
            const nextObservedMutationResult = mutationStarted
              ? "Ambiguous"
              : observedMutationResult;
            const nextAttemptCount = mutationStarted ? durableAttemptCount + 1 : undefined;
            await checkpoint({
              stage,
              mutationType,
              mutationStartStage: mutationStarted ? stage as
                "WriteStarted" | "ResolutionWriteStarted" | "NoteWriteStarted" : undefined,
              writeAttempted: nextWriteAttempted,
              writeMayHaveSucceeded: nextWriteMayHaveSucceeded,
              reliableResponseReceived: nextReliableResponseReceived,
              observedMutationResult: nextObservedMutationResult,
              canonicalTargetHash,
              noteFingerprint: action?.noteFingerprint ?? normalizedNoteFingerprint(action?.note),
              fallbackAllowed: action?.allowResolveFullFallbackToUpdate ??
                storedParams.allowResolveFullFallbackToUpdate ?? false,
              fallbackAttempted: fallbackAttempted || mutationType === "resolveFallback",
              partialWrite: claim.item.partialWrite,
              verificationState: "Pending",
              attemptCount: nextAttemptCount,
            });
            checkpointStage = stage;
            if (nextAttemptCount !== undefined) durableAttemptCount = nextAttemptCount;
            durableWriteAttempted = nextWriteAttempted;
            durableWriteMayHaveSucceeded = nextWriteMayHaveSucceeded;
            reliableResponseReceived = nextReliableResponseReceived;
            observedMutationResult = nextObservedMutationResult;
            if (mutationType === "resolveFallback") fallbackAttempted = true;
          }
        } catch (error) {
          throw new DurableCheckpointError(error);
        }
      };
      const afterMutation = async (
        mutationType: DurableMutationType,
        observed: { ticketId?: string; noteId?: string }
      ) => {
        const stage: OperationItemState["stage"] = mutationType === "note"
          ? "NoteAdded"
          : mutationType === "resolution" || mutationType === "resolveFallback"
            ? "ResolutionWriteSucceeded"
            : "FieldsUpdated";
        try {
          durableWriteAttempted = true;
          durableWriteMayHaveSucceeded = true;
          reliableResponseReceived = true;
          observedMutationResult = "Accepted";
          await checkpoint({
            stage,
            mutationType,
            writeAttempted: true,
            writeMayHaveSucceeded: true,
            reliableResponseReceived: true,
            observedMutationResult: "Accepted",
            canonicalTargetHash,
            createdNoteId: observed.noteId,
            fallbackAllowed: action?.allowResolveFullFallbackToUpdate ??
              storedParams.allowResolveFullFallbackToUpdate ?? false,
            fallbackAttempted: fallbackAttempted || mutationType === "resolveFallback",
            fallbackApplied: mutationType === "resolveFallback" || fallbackApplied,
            partialWrite: claim.item.partialWrite,
            verificationState: "Pending",
          });
          checkpointStage = stage;
          if (mutationType === "resolveFallback") {
            fallbackAttempted = true;
            fallbackApplied = true;
          }
        } catch (error) {
          throw new DurableCheckpointError(error);
        }
      };
      const afterConclusiveRejection = async (
        mutationType: DurableMutationType,
        rejection: ConclusiveMutationRejection,
        failureReason: string | undefined
      ) => {
        const nextEligibleTime = new Date(Date.now() + rejection.delayMs).toISOString();
        const observedAt = new Date().toISOString();
        try {
          durableWriteAttempted = true;
          reliableResponseReceived = true;
          observedMutationResult = "Rejected";
          await checkpoint({
            stage: "RateLimitedRescheduled",
            mutationType,
            writeAttempted: durableWriteAttempted,
            writeMayHaveSucceeded: false,
            reliableResponseReceived: true,
            observedMutationResult: "Rejected",
            canonicalTargetHash,
            noteFingerprint: action?.noteFingerprint ?? normalizedNoteFingerprint(action?.note),
            fallbackAllowed: action?.allowResolveFullFallbackToUpdate ??
              storedParams.allowResolveFullFallbackToUpdate ?? false,
            fallbackAttempted,
            fallbackApplied,
            partialWrite: false,
            verificationState: "Pending",
            nextEligibleTime,
            failureReason,
            errorClass: "SuperOpsRateLimit",
            rateLimit: {
              endpoint: "SuperOps GraphQL /msp",
              operationName: mutationType === "note" ? "CreateTicketNote" : "UpdateTicket",
              source: rejection.delaySource,
              attempts: (claim.item.rateLimit?.attempts ?? 0) + 1,
              suppliedDelayMs: rejection.retryAfterSupplied ? rejection.requestedDelayMs : undefined,
              parsedDelayMs: rejection.delayMs,
              cappedDelayMs: rejection.delayMs,
              appliedDelayMs: rejection.delayMs,
              scheduledAt: observedAt,
              firstThrottledAt: claim.item.rateLimit?.firstThrottledAt ?? observedAt,
              nextEligibleAt: nextEligibleTime,
              retryAfterSupplied: rejection.retryAfterSupplied,
              continuedInAnotherInvocation: true,
              writeAttempted: true,
              finalResult: "SuperOpsRateLimitRescheduled",
            },
          });
          checkpointStage = "RateLimitedRescheduled";
          durableWriteMayHaveSucceeded = false;
        } catch (error) {
          throw new DurableCheckpointError(error);
        }
      };
      const afterVerification = async (
        mutationType: "update" | "resolution" | "note"
      ) => {
        const stage: OperationItemState["stage"] = mutationType === "resolution"
          ? "ResolutionVerified"
          : "Verifying";
        try {
          // Verification after a dedupe proves the approved target exists, but
          // it does not change a reliably rejected mutation into an applied one.
          // A genuine retry first advances Rejected -> Ambiguous -> Accepted.
          if (durableWriteMayHaveSucceeded && observedMutationResult !== "Rejected") {
            observedMutationResult = "VerifiedApplied";
          }
          await checkpoint({
            stage,
            mutationType,
            writeAttempted: durableWriteAttempted,
            writeMayHaveSucceeded: durableWriteMayHaveSucceeded,
            reliableResponseReceived,
            observedMutationResult,
            canonicalTargetHash,
            fallbackAllowed: claim.item.fallbackAllowed,
            fallbackAttempted,
            fallbackApplied,
            fallbackVerified: fallbackApplied ? true : claim.item.fallbackVerified,
            partialWrite: false,
            verificationState: "Verified",
          });
          checkpointStage = stage;
        } catch (error) {
          throw new DurableCheckpointError(error);
        }
      };
      const shouldResolveAmbiguity =
        claim.item.stage === "WriteStarted" ||
        claim.item.stage === "WriteAmbiguous" ||
        claim.item.stage === "ResolutionWriteStarted" ||
        claim.item.stage === "ResolutionWriteAmbiguous" ||
        claim.item.stage === "NoteWriteStarted" ||
        claim.item.stage === "NoteWriteAmbiguous" ||
        (claim.item.writeMayHaveSucceeded === true &&
          claim.item.observedMutationResult !== "Rejected");
      const applied = shouldResolveAmbiguity && action
        ? await ambiguityCheckedTriageResult({
            client,
            ticketNumber: claim.itemKey,
            action,
            applyParams: storedParams,
            previousRetryCount: claim.item.retryCount,
            ambiguityStage: claim.item.stage,
            beforeNoteCheck,
            beforeMutation,
            afterMutation,
            afterConclusiveRejection,
            afterVerification,
          })
        : {
            result: await applyApprovedTriageAction({
              client,
              ticketNumber: claim.itemKey,
              action,
              dryRun: storedParams.dryRun ?? false,
              verify: storedParams.verify ?? true,
              dedupeNotes: storedParams.dedupeNotes ?? true,
              allowResolveFullFallbackToUpdate:
                storedParams.allowResolveFullFallbackToUpdate ?? false,
              allowWriteIfUpdatedTimeChanged:
                storedParams.allowWriteIfUpdatedTimeChanged ?? false,
              allowWriteWithoutVerifiedContent:
                storedParams.allowWriteWithoutVerifiedContent ?? false,
              beforeNoteCheck,
              beforeMutation,
              afterMutation,
              afterConclusiveRejection,
              afterVerification,
            }),
          };

      const outcome = applyResultToContinuationOutcome(
        applied.result,
        applied.stage,
        observedMutationResult
      );
      outcome.retryCount = typeof applied.retryCount === "number"
        ? applied.retryCount
        : (claim.item.retryCount ?? 0) +
          (claim.item.observedMutationResult === "Rejected" ? 1 : 0);
      return outcome;
    },
  };
}

export async function resumeApplyTriageOperation(params: {
  operationId: string;
  ownerHash: string;
  leaseOwner: string;
  leaseMs?: number;
  now?: string;
}) {
  return runOperationContinuation({
    operationId: params.operationId,
    ownerHash: params.ownerHash,
    adapter: createApplyTriageContinuationAdapter(getClient()),
    leaseOwner: params.leaseOwner,
    leaseMs: params.leaseMs,
    now: params.now,
  });
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
              items: TRIAGE_PLAN_ACTION_SCHEMA,
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
            verify: {
              type: "boolean",
              description: "Re-read the created ticket when the mutation returns a ticket ID. Defaults to true.",
              default: true,
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
      let synchronousWriteAttempted = false;
      let synchronousWriteAccepted = false;

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

            const collection = await collectSafeTicketContent({
              client,
              ticket,
              safeParams,
              initialContentTicketIds: [ticketId],
              displayId,
              displayIdMatches: matches,
            });
            const result = collection.safeResult;
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
            const actionValidationError = validateTriagePlanActions(actions);
            if (actionValidationError) {
              return errorResult(actionValidationError);
            }

            const actionByTicket = new Map<string, TriagePlanAction>();
            for (const action of actions) {
              const ticketNumber = normaliseTicketNumber(action.ticketNumber);
              if (ticketNumber && !actionByTicket.has(ticketNumber)) {
                actionByTicket.set(ticketNumber, action);
              }
            }

            if (expected.length > 500) {
              return errorResult("A durable triage operation may contain at most 500 items.");
            }
            if (new Set(expected).size !== expected.length) {
              return errorResult("expectedCandidateTicketNumbers must not contain duplicates.");
            }

            const diagnosticsBefore = executionDiagnostics();
            const operationId = params.batchId ??
              (diagnosticsBefore?.operationId as string | undefined) ?? `triage-${Date.now()}`;
            const ownerHash = currentOwnerHash();
            const store = getOperationStore();
            const initialSummary = summarizeApplyResults([]);
            const initialRecord = buildApplyTriageLedgerRecord({
              operationId, request: params, expected, results: [],
              actionsByTicket: actionByTicket, continuationRequired: false,
              summary: initialSummary,
            });

            try {
              const existing = await store.get(operationId, ownerHash);
              if (existing) {
                if (existing.ownerHash !== ownerHash ||
                    existing.originalRequestHash !== initialRecord.originalRequestHash) {
                  return errorResult("The requested operation ID already exists with different ownership or approved input.");
                }
              } else {
                // No initial mutation is permitted until this write is acknowledged.
                const approvedPrivateNotes = [...actionByTicket.values()].flatMap((action) => {
                  const ticketNumber = normaliseTicketNumber(action.ticketNumber);
                  const fingerprint = normalizedNoteFingerprint(action.note);
                  const approved = action.contentVerified === true ||
                    action.allowWriteWithoutVerifiedContent === true ||
                    params.allowWriteWithoutVerifiedContent === true;
                  return ticketNumber && expected.includes(ticketNumber) &&
                    action.isPublicNote !== true && fingerprint && action.note && approved
                    ? [{
                        itemKey: ticketNumber,
                        fingerprint,
                        content: action.note,
                        privacyType: "PRIVATE" as const,
                      }]
                    : [];
                });
                await store.put(initialRecord, { approvedPrivateNotes });
              }
            } catch (error) {
              return {
                content: [{ type: "text", text: JSON.stringify({
                  operation: { operationId, complete: false, continuationRequired: false,
                    persisted: false, errorClass: "OperationStoreFailure",
                    writeAttempted: false, writeMayHaveSucceeded: false,
                    storeError: safeErrorMessage(error) },
                  initialCandidateCount: expected.length,
                  expectedCandidateTicketNumbers: expected,
                  results: [], summary: initialSummary,
                  execution: executionDiagnostics(),
                }, null, 2) }], isError: true,
              };
            }

            let continuation;
            let continuationError: string | undefined;
            let conservativeOutcome: ContinuationItemOutcome | undefined;
            try {
              continuation = await runOperationContinuation({
                operationId, ownerHash,
                adapter: createApplyTriageContinuationAdapter(client, params),
                leaseOwner: String(diagnosticsBefore?.invocationId ?? `initial-${Date.now()}`),
              });
            } catch (error) {
              continuationError = safeErrorMessage(error);
              conservativeOutcome = typeof error === "object" && error !== null
                ? (error as { conservativeOutcome?: ContinuationItemOutcome }).conservativeOutcome
                : undefined;
            }

            let finalRecord = initialRecord;
            let finalRecordReadFailed = false;
            try {
              finalRecord = (await store.get(operationId, ownerHash)) ?? initialRecord;
            } catch (error) {
              finalRecordReadFailed = true;
              continuationError ??= safeErrorMessage(error);
            }
            let continuationScheduling: Record<string, unknown> | undefined;
            const continuationRequired = (continuation?.continuationRequired ??
              finalRecord.pendingItems.length > 0) || finalRecordReadFailed || Boolean(conservativeOutcome);
            if (continuationRequired && !finalRecord.nextEligibleTime && !finalRecordReadFailed && !conservativeOutcome) {
              let scheduled: Awaited<ReturnType<typeof scheduleApplyTriageContinuation>>;
              try {
                scheduled = await scheduleApplyTriageContinuation(operationId, ownerHash);
              } catch (error) {
                continuationError ??= safeErrorMessage(error);
                continuationScheduling = { attempted: true, scheduled: false,
                  error: safeErrorMessage(error), mechanism: "serviceBinding" };
                scheduled = { scheduled: false, reason: safeErrorMessage(error) };
              }
              continuationScheduling ??= { attempted: true, scheduled: scheduled.scheduled,
                status: scheduled.status, error: scheduled.scheduled ? undefined : scheduled.reason,
                mechanism: "serviceBinding" };
              if (scheduled.scheduled) {
                try {
                  finalRecord = await store.update(operationId, ownerHash, (record) => ({
                    ...record, schedulingAttempted: true,
                    schedulingSucceeded: true,
                    schedulingError: undefined,
                    schedulingAttemptCount: (record.schedulingAttemptCount ?? 0) + 1,
                  }));
                } catch (error) {
                  continuationError ??= safeErrorMessage(error);
                }
              } else if (!continuationScheduling.terminalized) {
                const reason = scheduled.status
                  ? "Immediate continuation delivery failed with status " + scheduled.status + "."
                  : "Immediate continuation delivery failed or is not configured.";
                let terminalizationError: unknown;
                for (let attempt = 1; attempt <= 3; attempt += 1) {
                  try {
                    finalRecord = await store.terminalizeContinuationFailure({
                      operationId,
                      ownerHash,
                      errorClass: "ContinuationSchedulingFailure",
                      outcome: "ContinuationSchedulingFailed",
                      reason,
                      schedulingFailure: true,
                    });
                    terminalizationError = undefined;
                    continuationScheduling.terminalized = true;
                    break;
                  } catch (error) {
                    terminalizationError = error;
                  }
                }
                if (terminalizationError) {
                  continuationError ??= safeErrorMessage(terminalizationError);
                  continuationScheduling.terminalized = false;
                  continuationScheduling.recovery =
                    "Maximum-lifetime cleanup remains scheduled for durable normalization.";
                }
              }
            }

            const results = completeApplyResultsFromLedger(finalRecord, expected, actionByTicket);
            const summary = summarizeApplyResults(results);
            try {
              if (!finalRecordReadFailed) {
                finalRecord = await store.update(operationId, ownerHash, (record) => ({ ...record, summary }));
              }
            } catch (error) {
              continuationError ??= safeErrorMessage(error);
            }
            const complete = !finalRecordReadFailed && (
              finalRecord.state === "Completed" ||
              finalRecord.state === "CompletedWithFailures" ||
              finalRecord.state === "Failed" || finalRecord.state === "Cancelled"
            );
            const durableItems = Object.values(finalRecord.itemStates);
            const conservativeWriteAttempted = durableItems.some((item) => item.writeAttempted) ||
              conservativeOutcome?.writeAttempted === true;
            const conservativeWriteMayHaveSucceeded = durableItems.some((item) => item.writeMayHaveSucceeded) ||
              conservativeOutcome?.writeMayHaveSucceeded === true || conservativeOutcome?.partialWrite === true;
            const conservativePartialWrite = durableItems.some((item) => item.partialWrite) ||
              conservativeOutcome?.partialWrite === true;
            const conservativeVerificationState = applyTriageOperationVerificationState(
              durableItems,
              conservativeOutcome
            );
            const operationView = operationResultView(finalRecord);
            const durableFinalErrorClass = durableItems.find((item) => item.errorClass)?.errorClass ??
              conservativeOutcome?.errorClass;
            const conservativeFinalReason = continuationError && !durableFinalErrorClass
              ? "OperationStorePostWriteFailure"
              : conservativeOutcome?.outcome ?? durableItems.find((item) => item.failureReason)?.failureReason;

            return {
              content: [{ type: "text", text: JSON.stringify({
                batchId: params.batchId,
                operation: { operationId, idempotencyKey: params.batchId ?? operationId,
                  complete, continuationRequired: !complete, persisted: true,
                  storeError: continuationError, continuationScheduling, state: finalRecord.state,
                  errorClass: durableFinalErrorClass ?? (continuationError ? "OperationStoreFailure" : undefined),
                  finalReason: conservativeFinalReason,
                  items: operationView.items,
                  partialWrite: conservativePartialWrite,
                  verificationState: conservativeVerificationState,
                  writeAttempted: conservativeWriteAttempted,
                  writeMayHaveSucceeded: conservativeWriteMayHaveSucceeded },
                initialCandidateCount: expected.length,
                expectedCandidateTicketNumbers: expected,
                results, summary, execution: executionDiagnostics(),
              }, null, 2) }],
              isError: Boolean(continuationError),
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
              verify?: boolean;
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

            synchronousWriteAttempted = true;
            const response = await client.mutate<CreateTicketResponse>(
              CREATE_TICKET_MUTATION,
              { input }
            );
            synchronousWriteAccepted = true;
            const createdTicket = response.createTicket;
            const createdTicketId = typeof createdTicket?.ticketId === "string"
              ? createdTicket.ticketId
              : undefined;
            const verification = params.verify === false
              ? {
                  performed: false,
                  possible: Boolean(createdTicketId),
                  verified: null,
                  reason: "verify=false",
                }
              : createdTicketId
                ? {
                    performed: true,
                    possible: true,
                    verified: true,
                    result: ticketSummary(await getTicketByInternalId(client, createdTicketId)),
                  }
                : {
                    performed: false,
                    possible: false,
                    verified: null,
                    reason: "Mutation response did not include a ticket ID for read-back verification.",
                  };

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    result: createdTicket,
                    finalOutcome: "Created",
                    partialWrite: false,
                    verification,
                    writeCount: synchronousWriteCount(1, 1),
                    writeAttempted: true,
                    writeMayHaveSucceeded: true,
                    reliableResponseReceived: true,
                    replaySafe: false,
                  }, null, 2),
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
              synchronousWriteAttempted = true;
              createdNote = await createTicketNote(
                client,
                resolvedTicket.ticketId,
                params.note,
                params.isPublicNote ?? false
              );
              synchronousWriteAccepted = true;
            }

            let updateResponse: UpdateTicketResponse;
            try {
              synchronousWriteAttempted = true;
              updateResponse = await client.mutate<UpdateTicketResponse>(
                UPDATE_TICKET_MUTATION,
                { input: updateInput }
              );
              synchronousWriteAccepted = true;
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
                          finalOutcome: "PartialWriteThenUpdateFailed",
                          verification: { performed: false, possible: true, verified: null, reason: "Update failed after note creation; no final ticket verification was attempted." },
                          writeCount: synchronousWriteCount(2, 2),
                          writeAttempted: true,
                          writeMayHaveSucceeded: true,
                          reliableResponseReceived: isReliableSynchronousMutationRejection(error),
                          replaySafe: false,
                          classification: isReliableSynchronousMutationRejection(error)
                            ? "PartialWriteThenRejectedUpdate"
                            : "PartialWriteThenAmbiguousUpdate",
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
                  }),
                  {
                    writeAttempted: true,
                    writeMayHaveSucceeded: false,
                    reliableResponseReceived: true,
                    replaySafe: true,
                    classification: "RejectedSynchronousWrite",
                  }
                );
              }

              throw error;
            }
            if (params.verify === false) {
              const writes = createdNote ? 2 : 1;
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(
                      {
                        result: createdNote
                          ? {
                              noteAdded: {
                                noteId: createdNote.noteId,
                                addedOn: createdNote.addedOn,
                                privacyType: createdNote.privacyType,
                              },
                              update: updateResponse.updateTicket,
                            }
                          : updateResponse.updateTicket,
                        finalOutcome: "Updated",
                        partialWrite: false,
                        verification: { performed: false, possible: true, verified: null, reason: "verify=false" },
                        writeCount: synchronousWriteCount(writes, writes),
                        writeAttempted: true,
                        writeMayHaveSucceeded: true,
                        reliableResponseReceived: true,
                        replaySafe: false,
                      },
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
            const writes = createdNote ? 2 : 1;
            const updateVerification = verifyDirectTicketUpdate(updateInput, verifiedTicket);
            const noteVerification = createdNote
              ? noteVerificationResult(latestNotes, createdNote)
              : undefined;
            const verification = {
              performed: true,
              possible: true,
              verified: verificationSucceeded(updateVerification) &&
                (noteVerification ? verificationSucceeded(noteVerification) : true),
              update: updateVerification,
              note: noteVerification,
            };
            const verificationFailed = verification.verified !== true;
            const verificationFailureReason = verificationFailed
              ? !verificationSucceeded(updateVerification)
                ? synchronousVerificationFailureReason(updateVerification)
                : noteVerification ? synchronousVerificationFailureReason(noteVerification) : undefined
              : undefined;

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      result: ticketSummary(verifiedTicket, latestNotes[0] ?? createdNote),
                      finalOutcome: verificationFailed ? "VerificationFailed" : "Updated",
                      partialWrite: verificationFailed,
                      verification,
                      failureReason: verificationFailureReason,
                      writeCount: synchronousWriteCount(writes, writes),
                      writeAttempted: true,
                      writeMayHaveSucceeded: true,
                      reliableResponseReceived: true,
                      replaySafe: false,
                    },
                    null,
                    2
                  ),
                },
              ],
              isError: verificationFailed,
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

            synchronousWriteAttempted = true;
            const response = await client.mutate<UpdateTicketResponse>(
              UPDATE_TICKET_MUTATION,
              { input }
            );
            synchronousWriteAccepted = true;
            const verification = params.verify === false
              ? { performed: false, possible: true, verified: null, reason: "verify=false" }
              : verifyDirectTicketUpdate(input, await getTicketByInternalId(client, params.ticketId));
            const verificationFailed = params.verify !== false && !verificationSucceeded(verification);

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    result: response.updateTicket,
                    finalOutcome: verificationFailed ? "VerificationFailed" : "Updated",
                    partialWrite: verificationFailed,
                    verification,
                    failureReason: verificationFailed
                      ? synchronousVerificationFailureReason(verification)
                      : undefined,
                    writeCount: synchronousWriteCount(1, 1),
                    writeAttempted: true,
                    writeMayHaveSucceeded: true,
                    reliableResponseReceived: true,
                    replaySafe: false,
                  }, null, 2),
                },
              ],
              isError: verificationFailed,
            };
          }

          case "superops_tickets_add_note": {
            const params = args as {
              ticketId: string;
              content: string;
              isPublic?: boolean;
              verify?: boolean;
            };

            synchronousWriteAttempted = true;
            const response = await client.mutate<AddNoteResponse>(ADD_TICKET_NOTE_MUTATION, {
              input: {
                ticket: { ticketId: params.ticketId },
                content: params.content,
                privacyType: params.isPublic ? "PUBLIC" : "PRIVATE",
              },
            });
            synchronousWriteAccepted = true;
            const verification = params.verify === false
              ? { performed: false, possible: Boolean(response.createTicketNote.noteId), verified: null, reason: "verify=false" }
              : noteVerificationResult(await getTicketNotes(client, params.ticketId), response.createTicketNote);
            const verificationFailed = params.verify !== false && !verificationSucceeded(verification);

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    result: {
                      noteId: response.createTicketNote.noteId,
                      addedOn: response.createTicketNote.addedOn,
                      privacyType: response.createTicketNote.privacyType,
                    },
                    finalOutcome: verificationFailed ? "VerificationFailed" : "NoteAdded",
                    partialWrite: verificationFailed,
                    verification,
                    failureReason: verificationFailed
                      ? synchronousVerificationFailureReason(verification)
                      : undefined,
                    writeCount: synchronousWriteCount(1, 1),
                    writeAttempted: true,
                    writeMayHaveSucceeded: true,
                    reliableResponseReceived: true,
                    replaySafe: false,
                  }, null, 2),
                },
              ],
              isError: verificationFailed,
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

            synchronousWriteAttempted = true;
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
            synchronousWriteAccepted = true;

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    result: response.createWorklogEntries,
                    finalOutcome: "TimeLogged",
                    partialWrite: false,
                    verification: {
                      performed: false,
                      possible: false,
                      verified: null,
                      reason: "No bounded worklog read-back tool is implemented for direct time-log verification.",
                    },
                    writeCount: synchronousWriteCount(1, 1),
                    writeAttempted: true,
                    writeMayHaveSucceeded: true,
                    reliableResponseReceived: true,
                    replaySafe: false,
                  }, null, 2),
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
        const synchronousWriteTools = new Set([
          "superops_tickets_create", "superops_tickets_resolve_full",
          "superops_tickets_update", "superops_tickets_add_note", "superops_tickets_log_time",
        ]);
        if (synchronousWriteTools.has(name)) {
          const reliablyRejected = synchronousWriteAttempted &&
            !synchronousWriteAccepted && isReliableSynchronousMutationRejection(error);
          return {
            content: [{ type: "text", text: JSON.stringify({
              error: message,
              writeAttempted: synchronousWriteAttempted,
              writeMayHaveSucceeded: synchronousWriteAttempted && !reliablyRejected,
              writeCount: {
                attempted: synchronousWriteAttempted ? 1 : 0,
                maximum: name === "superops_tickets_resolve_full" ? 2 : 1,
                exact: name !== "superops_tickets_resolve_full",
              },
              reliableResponseReceived: synchronousWriteAccepted || reliablyRejected,
              replaySafe: reliablyRejected || !synchronousWriteAttempted,
              classification: synchronousWriteAccepted
                ? "AcceptedSynchronousWriteFollowupFailed"
                : reliablyRejected
                  ? "RejectedSynchronousWrite"
                  : synchronousWriteAttempted ? "AmbiguousSynchronousWrite" : "FailedBeforeWrite",
            }, null, 2) }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  };
}
