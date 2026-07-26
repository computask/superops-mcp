/**
 * SuperOps.ai Tickets Domain
 *
 * Tools for managing service tickets in SuperOps.ai PSA.
 */

import { getClient, getCredentials, SuperOpsError, SuperOpsHttpError } from "../client.js";
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
  hasExecutionBudgetFor,
  recordRetryDelay,
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
const TRIAGE_SNAPSHOT_SUBREQUEST_HEADROOM = 4;
const DEFAULT_TRIAGE_MAX_CONTENT_CHARS_PER_TICKET = 3000;
const MAX_TRIAGE_MAX_CONTENT_CHARS_PER_TICKET = 10000;
const DEFAULT_TRIAGE_MAX_ITEMS_PER_TICKET = 8;
const MAX_TRIAGE_MAX_ITEMS_PER_TICKET = 20;
const DISPLAY_ID_EQUALS_OPERATOR = "is";
const STATUS_EQUALS_OPERATOR = "is";
const STATUS_IN_OPERATOR = "in";
const TICKET_FIELD_MODULE = "TICKET";
const CLIENT_LOOKUP_PAGE_SIZE = 200;
const FIELD_OPTIONS_MAX_INTERNAL_ATTEMPTS = 2;
/** Short Cloudflare Cache API TTL for tenant field metadata; SuperOps option sets change rarely. */
const FIELD_OPTIONS_CACHE_TTL_MS = 5 * 60 * 1000;
const FIELD_OPTIONS_RETRY_ENDPOINT = "SuperOps GraphQL /msp getFields";

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

interface TicketOptionFieldsRetrieval {
  fields: Map<ValidatedTicketOptionField, SuperOpsField>;
  metadata: {
    source: "fresh" | "cache";
    cacheStatus: "miss" | "fallback" | "unavailable";
    cacheTtlSeconds: number;
    cachedAt?: string;
    expiresAt?: string;
    attempts: number;
    retried: boolean;
    rateLimited: boolean;
    retryAfterPresent: boolean;
  };
}

interface TicketOptionFieldsCacheEntry {
  fields: Map<ValidatedTicketOptionField, SuperOpsField>;
  cachedAtMs: number;
  expiresAtMs: number;
}

interface TicketOptionFieldsCachePayload {
  version: 1;
  tenant: string;
  region: "us" | "eu";
  fields: ValidatedTicketOptionField[];
  cachedAtMs: number;
  expiresAtMs: number;
  entries: Array<[ValidatedTicketOptionField, SuperOpsField]>;
}

interface TicketOptionFieldsCacheIdentity {
  tenant: string;
  region: "us" | "eu";
  fields: ValidatedTicketOptionField[];
  request: Request;
  memoryKey: string;
}

interface TicketOptionFieldsCacheLookup {
  entry?: TicketOptionFieldsCacheEntry;
  available: boolean;
  valid: boolean;
  readFailed: boolean;
  nativeAvailable: boolean;
}

interface CloudflareNativeCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

interface CloudflareNativeCacheStorage {
  default?: CloudflareNativeCache;
}

const ticketFieldOptionsCache = new Map<string, TicketOptionFieldsCacheEntry>();

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
const TRIAGE_RESOLVED_REQUIRED_OPTION_FIELDS = [
  "impact",
  "subcategory",
  "cause",
  "resolutionCode",
] as const satisfies readonly ValidatedTicketOptionField[];
const TRIAGE_RESOLVED_REQUIRED_FIELDS = [
  ...TRIAGE_RESOLVED_REQUIRED_OPTION_FIELDS,
  "category",
] as const;
const TRIAGE_DERIVED_PRIORITY_IGNORE_REASON =
  "Priority is derived from impact and urgency; target.priority is ignored for triage writes and verification.";

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
  getTicketNoteList: TicketNote[] | {
    notes?: TicketNote[];
    ticketNotes?: TicketNote[];
    items?: TicketNote[];
    data?: TicketNote[];
    list?: TicketNote[];
    listInfo?: ListInfo;
  };
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

const CANONICAL_NOTE_PAGE_SIZE = 50;
const CANONICAL_NOTE_MAX_PAGES = 5;

interface CanonicalTicketNote {
  id: string;
  type: "note";
  direction: "internal" | "technician";
  isInternal: boolean;
  plainText: string;
  createdTime?: string;
  addedBy?: unknown;
  attachments?: unknown;
}

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
  | "NoteVisibilityPending"
  | "RejectedOrNoChange"
  | "AmbiguousNoChangeObserved"
  | "PartialResolveStatusMissing"
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
const TRIAGE_PLAN_MUTABLE_STATUSES = ["Resolved", "Awaiting Engineer"] as const;
const TRIAGE_PLAN_REQUIRED_CLASSIFICATION_FIELDS = [
  "impact",
  "urgency",
  "category",
  "subcategory",
] as const;
const TRIAGE_PLAN_NON_RESOLUTION_CLASSIFICATION_FIELDS = [
  ...TRIAGE_PLAN_REQUIRED_CLASSIFICATION_FIELDS,
  "cause",
] as const;
const TRIAGE_PLAN_LEAVE_TARGET_FIELDS = [
  ...TRIAGE_PLAN_NON_RESOLUTION_CLASSIFICATION_FIELDS,
  "clientName",
  "clientId",
] as const;
const TRIAGE_PLAN_RESOLVE_REQUIRED_CLASSIFICATION_FIELDS = [
  ...TRIAGE_PLAN_REQUIRED_CLASSIFICATION_FIELDS,
  "cause",
  "resolutionCode",
] as const;
const TRIAGE_PLAN_WRITABLE_TARGET_FIELDS = [
  "status",
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
const TRIAGE_PLAN_DERIVED_READONLY_TARGET_FIELDS = ["priority"] as const;
const TRIAGE_PLAN_ACCEPTED_TARGET_FIELDS = [
  ...TRIAGE_PLAN_WRITABLE_TARGET_FIELDS,
  ...TRIAGE_PLAN_DERIVED_READONLY_TARGET_FIELDS,
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
const TRIAGE_PLAN_TARGET_FIELD_SET = new Set<string>(TRIAGE_PLAN_ACCEPTED_TARGET_FIELDS);

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
    enum: [...TRIAGE_PLAN_MUTABLE_STATUSES],
    description: "Approved triage status. Only Resolved or Awaiting Engineer may be written.",
  },
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
  properties: {
    status: {
      type: "string",
      enum: ["Awaiting Engineer"],
      description: "Update actions may only move a ticket to Awaiting Engineer.",
    },
    impact: TRIAGE_PLAN_TARGET_SCHEMA_PROPERTIES.impact,
    urgency: TRIAGE_PLAN_TARGET_SCHEMA_PROPERTIES.urgency,
    category: TRIAGE_PLAN_TARGET_SCHEMA_PROPERTIES.category,
    subcategory: TRIAGE_PLAN_TARGET_SCHEMA_PROPERTIES.subcategory,
    cause: TRIAGE_PLAN_TARGET_SCHEMA_PROPERTIES.cause,
    techGroupName: TRIAGE_PLAN_TARGET_SCHEMA_PROPERTIES.techGroupName,
    clientName: TRIAGE_PLAN_TARGET_SCHEMA_PROPERTIES.clientName,
    clientId: TRIAGE_PLAN_TARGET_SCHEMA_PROPERTIES.clientId,
    suppressCloseNotification: TRIAGE_PLAN_TARGET_SCHEMA_PROPERTIES.suppressCloseNotification,
  },
  required: ["status", ...TRIAGE_PLAN_REQUIRED_CLASSIFICATION_FIELDS],
} as const;

const TRIAGE_PLAN_RESOLVE_TARGET_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...TRIAGE_PLAN_TARGET_SCHEMA_PROPERTIES,
    status: {
      type: "string",
      enum: ["Resolved"],
      default: DEFAULT_RESOLVE_TICKET_STATUS,
      description: "Resolve actions may only close to Resolved.",
    },
  },
  required: [...TRIAGE_PLAN_RESOLVE_REQUIRED_CLASSIFICATION_FIELDS],
} as const;

const TRIAGE_PLAN_LEAVE_TARGET_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    impact: TRIAGE_PLAN_TARGET_SCHEMA_PROPERTIES.impact,
    urgency: TRIAGE_PLAN_TARGET_SCHEMA_PROPERTIES.urgency,
    category: TRIAGE_PLAN_TARGET_SCHEMA_PROPERTIES.category,
    subcategory: TRIAGE_PLAN_TARGET_SCHEMA_PROPERTIES.subcategory,
    cause: TRIAGE_PLAN_TARGET_SCHEMA_PROPERTIES.cause,
    clientName: TRIAGE_PLAN_TARGET_SCHEMA_PROPERTIES.clientName,
    clientId: TRIAGE_PLAN_TARGET_SCHEMA_PROPERTIES.clientId,
  },
  required: [...TRIAGE_PLAN_REQUIRED_CLASSIFICATION_FIELDS],
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
        target: TRIAGE_PLAN_LEAVE_TARGET_SCHEMA,
        note: { type: "string", description: "Optional private triage-summary note to add after classification succeeds." },
        isPublicNote: { type: "boolean", default: false, description: "Whether the optional note is client-visible." },
        reason: {
          type: "string",
          description: "Optional reason for retaining the current status after classification.",
        },
      },
      required: ["ticketNumber", "expectedUpdatedTime", "contentVerified", "action", "target"],
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
  writeMayHaveSucceeded?: boolean;
  writeMethod?: string | null;
  noteAdded: boolean;
  noteDeduped: boolean;
  notePlanned?: boolean;
  noteDedupePlanned?: boolean;
  noteDedupeChecked?: boolean;
  noteWriteOutcome?: string | null;
  initialNoteVerificationObserved?: boolean;
  noteVerificationAttempts?: number;
  noteVerifiedAfterDelay?: boolean;
  continuationRequired?: boolean;
  plannedMutations?: string[];
  workflowMode?: "staged" | "combined";
  completedStages?: string[];
  currentStage?: string | null;
  classificationWriteMethod?: string | null;
  classificationWriteOutcome?: string | null;
  statusWriteMethod?: string | null;
  statusWriteOutcome?: string | null;
  suppressCloseNotificationRequested?: boolean;
  suppressCloseNotificationIncluded?: boolean;
  verified: boolean;
  finalState?: Record<string, unknown> | null;
  failureStage?: string | null;
  failureReason?: string | null;
  primaryWriteMethod?: string | null;
  primaryWriteOutcome?: string | null;
  primaryFailureDiagnostics?: Record<string, unknown> | null;
  primaryGraphqlClassification?: string | null;
  primaryGraphqlCode?: string | null;
  primaryGraphqlPath?: Array<string | number> | null;
  primaryResponseHadData?: boolean | null;
  primarySynchronousFailure?: boolean | null;
  updatedTimeChanged?: boolean | null;
  requestedFieldsObserved?: string[];
  noChangeObserved?: boolean | null;
  retrySafe?: boolean | null;
  partialFieldsObserved?: Record<string, unknown> | null;
  statusObserved?: string | null;
  fallbackEligible?: boolean;
  fallbackAttempted: boolean;
  fallbackWriteMethod?: string | null;
  fallbackOutcome?: string | null;
  fallbackResult?: string | null;
  physicalWrites?: Array<{ method: string; outcome: string }>;
  finalVerificationState?: "Verified" | "Failed" | "Pending" | "NotRequired";
  terminalReason?: string | null;
  partialWrite: boolean;
  requestedState?: Record<string, unknown> | null;
  attemptedState?: Record<string, unknown> | null;
  writableTargetState?: Record<string, unknown> | null;
  derivedReadOnlyState?: Record<string, unknown> | null;
  ignoredTargetFields?: Array<{ field: string; value: unknown; reason: string }>;
  observedFinalState?: Record<string, unknown> | null;
  verifiedState?: Record<string, unknown> | null;
  /** Compact retry metadata only; never include an upstream response body. */
  rateLimitRetryAfterMs?: number;
  rateLimitRetryAfterSupplied?: boolean;
  rateLimitRequestedDelayMs?: number;
  rateLimitDelaySource?: "retry-after" | "backoff";
  rateLimitConclusiveRejection?: boolean;
  rateLimitOperationName?: string;
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

function ticketNoteArray(value: unknown): TicketNote[] | undefined {
  return Array.isArray(value) ? value as TicketNote[] : undefined;
}

function parseTicketNotePage(value: GetTicketNoteListResponse["getTicketNoteList"]): {
  notes: TicketNote[];
  hasMore: boolean;
} {
  if (Array.isArray(value)) {
    return { notes: value, hasMore: false };
  }
  const page = jsonRecord(value);
  if (!page) {
    throw new Error("Unsupported ticket note collection response.");
  }
  const notes = ticketNoteArray(page.notes) ??
    ticketNoteArray(page.ticketNotes) ??
    ticketNoteArray(page.items) ??
    ticketNoteArray(page.data) ??
    ticketNoteArray(page.list);
  if (!notes) {
    throw new Error("Unsupported ticket note collection response.");
  }
  const listInfo = jsonRecord(page.listInfo);
  return {
    notes,
    hasMore: listInfo?.hasMore === true,
  };
}

async function getTicketNotesPage(
  client: SuperOpsClientInstance,
  ticketId: string,
  page: number
): Promise<{ notes: TicketNote[]; hasMore: boolean }> {
  const input: Record<string, unknown> = { ticketId };
  if (page > 1) {
    input.page = page;
    input.pageSize = CANONICAL_NOTE_PAGE_SIZE;
  }
  const response = await client.query<GetTicketNoteListResponse>(
    GET_TICKET_NOTE_LIST_QUERY,
    { input }
  );

  return parseTicketNotePage(response.getTicketNoteList);
}

async function getTicketNotes(
  client: SuperOpsClientInstance,
  ticketId: string
): Promise<TicketNote[]> {
  return (await getTicketNotesPage(client, ticketId, 1)).notes;
}

function collectionHasPrivateFingerprint(
  notes: CanonicalTicketNote[],
  fingerprint: string | undefined
): boolean {
  return Boolean(fingerprint) && notes.some(
    (note) => isPrivateTicketNote(note) &&
      normalizedNoteFingerprint(note.plainText) === fingerprint
  );
}

function isPrivateTicketNote(value: unknown): boolean {
  const note = jsonRecord(value);
  if (!note) return false;
  if (note.privacyType === "PRIVATE") return true;
  return typeof note.type === "string" &&
    note.type.toLowerCase() === "note" &&
    note.isInternal === true &&
    typeof note.direction === "string" &&
    note.direction.toLowerCase() === "internal";
}

function normalizedTicketNoteText(value: unknown): string | undefined {
  const note = jsonRecord(value);
  if (!note) return undefined;
  if (typeof note.plainText === "string") {
    return normalizePlainText(note.plainText);
  }
  if (typeof note.content !== "string") return undefined;
  return normalizePlainText(htmlToPlainText(note.content).text);
}

function normalizeCanonicalTicketNote(
  value: unknown,
  fallbackId: string
): CanonicalTicketNote {
  const note = jsonRecord(value);
  if (!note) {
    throw new Error("Unsupported ticket note object.");
  }
  const isPrivate = isPrivateTicketNote(note);
  const isPublic = note.privacyType === "PUBLIC" ||
    (
      typeof note.type === "string" &&
      note.type.toLowerCase() === "note" &&
      note.isInternal === false &&
      typeof note.direction === "string" &&
      note.direction.toLowerCase() === "technician"
    );
  if (!isPrivate && !isPublic) {
    throw new Error("Unsupported ticket note privacy shape.");
  }
  const plainText = normalizedTicketNoteText(note);
  if (plainText === undefined) {
    throw new Error("Unsupported ticket note text shape.");
  }
  const id = stringValue(note.id) ?? stringValue(note.noteId) ?? fallbackId;
  const createdTime = stringValue(note.createdTime) ?? stringValue(note.addedOn);
  return {
    id,
    type: "note",
    direction: isPrivate ? "internal" : "technician",
    isInternal: isPrivate,
    plainText,
    createdTime,
    addedBy: note.addedBy,
    attachments: note.attachments,
  };
}

async function collectCanonicalTicketNotes(params: {
  client: SuperOpsClientInstance;
  ticketId: string;
  ticketNumber?: string;
  additionalTicketIds?: string[];
  stopAfterPrivateFingerprint?: string;
}): Promise<{
  available: boolean;
  notes: CanonicalTicketNote[];
  ticketIdsRead: string[];
  errors: string[];
}> {
  const notes: CanonicalTicketNote[] = [];
  const seenNoteIds = new Set<string>();
  const ticketIdsRead: string[] = [];
  const errors: string[] = [];
  let matchedRequestedPrivateFingerprint = false;

  function hasRequestedPrivateFingerprint(): boolean {
    return Boolean(params.stopAfterPrivateFingerprint) && collectionHasPrivateFingerprint(notes, params.stopAfterPrivateFingerprint);
  }

  async function readTicketId(ticketId: string): Promise<boolean> {
    const normalized = ticketId.trim();
    if (!normalized || ticketIdsRead.includes(normalized)) return true;
    ticketIdsRead.push(normalized);
    try {
      for (let page = 1; page <= CANONICAL_NOTE_MAX_PAGES; page += 1) {
        const result = await getTicketNotesPage(params.client, normalized, page);
        for (const [index, rawNote] of result.notes.entries()) {
          let note: CanonicalTicketNote;
          try {
            note = normalizeCanonicalTicketNote(
              rawNote,
              `note:${normalized}:${page}:${index + 1}`
            );
          } catch (error) {
            errors.push(
              `Notes contained an unsupported shape for ticketId ${normalized}: ${safeErrorMessage(error)}`
            );
            return false;
          }
          addUniqueNote(notes, seenNoteIds, note);
        }
        if (hasRequestedPrivateFingerprint()) {
          matchedRequestedPrivateFingerprint = true;
          break;
        }
        if (!result.hasMore) break;
      }
      return true;
    } catch (error) {
      errors.push(`Notes could not be fetched for ticketId ${normalized}: ${safeErrorMessage(error)}`);
      return false;
    }
  }

  const displayId = normaliseTicketNumber(params.ticketNumber);
  const canonicalTicketIds = uniqueTicketIds([
    params.ticketId,
    ...(params.additionalTicketIds ?? []),
  ]).slice(0, 2);
  const initialTicketIds = uniqueTicketIds([
    ...canonicalTicketIds,
    displayId,
  ]);
  for (const ticketId of initialTicketIds) {
    if (!await readTicketId(ticketId)) {
      return { available: false, notes, ticketIdsRead, errors };
    }
    if (matchedRequestedPrivateFingerprint) break;
  }

  const hasCanonicalTicketId = canonicalTicketIds.some((ticketId) => ticketId !== displayId);
  if (notes.length === 0 && displayId && !hasCanonicalTicketId) {
    try {
      const matches = await resolveTicketIdByDisplayId(params.client, displayId);
      if (matches.length !== 1) {
        errors.push(matches.length === 0
          ? `No ticket was found for display number ${displayId} while collecting notes.`
          : `Display number ${displayId} was not unique while collecting notes.`);
        return { available: false, notes, ticketIdsRead, errors };
      }
      if (!await readTicketId(matches[0].ticketId)) {
        return { available: false, notes, ticketIdsRead, errors };
      }
    } catch (error) {
      errors.push(`Display-number note lookup could not be fetched safely: ${safeErrorMessage(error)}`);
      return { available: false, notes, ticketIdsRead, errors };
    }
  }

  return { available: true, notes, ticketIdsRead, errors };
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

  if (action.action === "resolve" || action.action === "update" || action.action === "leave") {
    if (!target) {
      return `${label} ${action.action} action requires a complete classification target.`;
    }
    const requiredClassificationFields = action.action === "resolve"
      ? TRIAGE_PLAN_RESOLVE_REQUIRED_CLASSIFICATION_FIELDS
      : TRIAGE_PLAN_REQUIRED_CLASSIFICATION_FIELDS;
    const missingClassificationFields = requiredClassificationFields.filter(
      (field) => typeof target[field] !== "string" || String(target[field]).trim().length === 0
    );
    if (missingClassificationFields.length > 0) {
      return `${label} ${action.action} action requires classification field(s): ${missingClassificationFields.join(", ")}.`;
    }
  }

  if ((action.action === "update" || action.action === "leave") && target && "resolutionCode" in target) {
    return `${label}.target.resolutionCode is only allowed for a resolve action.`;
  }

  if (action.action === "resolve" && target?.status !== undefined && target.status !== "Resolved") {
    return `${label}.target.status must be Resolved for a resolve action.`;
  }
  if (action.action === "update" && target?.status !== "Awaiting Engineer") {
    return `${label}.target.status must be Awaiting Engineer for an update action.`;
  }
  if (action.action === "leave" && target && "status" in target) {
    return `${label}.target.status is not allowed for a leave action; leave retains the current status.`;
  }
  if (
    target?.status !== undefined &&
    !(TRIAGE_PLAN_MUTABLE_STATUSES as readonly unknown[]).includes(target.status)
  ) {
    return `${label}.target.status must be one of: ${TRIAGE_PLAN_MUTABLE_STATUSES.join(", ")}.`;
  }

  if (action.action === "leave" && target) {
    const unsupportedLeaveFields = Object.keys(target).filter(
      (field) => !(TRIAGE_PLAN_LEAVE_TARGET_FIELDS as readonly string[]).includes(field)
    );
    if (unsupportedLeaveFields.length > 0) {
      return `${label}.target contains field(s) not allowed for a classification-only leave action: ${unsupportedLeaveFields.join(", ")}.`;
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

function triageSnapshotEffectivePageSize(
  params: NormalizedTriageSnapshotParams
): number {
  const config = getExecutionConfig();
  const usableSubrequests = Math.max(
    1,
    config.subrequestBudget - config.subrequestSafetyMargin -
      1 - TRIAGE_SNAPSHOT_SUBREQUEST_HEADROOM
  );
  const candidateReadCost = 1 +
    (params.includeConversations ? 2 : 0) +
    (params.includeNotes ? 1 : 0);
  return Math.max(1, Math.min(params.max, Math.floor(usableSubrequests / candidateReadCost)));
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
  notes: CanonicalTicketNote[],
  seenNoteIds: Set<string>,
  note: CanonicalTicketNote
): void {
  if (seenNoteIds.has(note.id)) return;
  seenNoteIds.add(note.id);
  notes.push(note);
}

function buildSafeTicketResult(params: {
  ticket: Ticket;
  safeParams: Required<SafeTicketParams>;
  conversations?: TicketConversation[];
  notes?: CanonicalTicketNote[];
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
      const safeText = sanitizeTicketText(note.plainText, safeParams);
      mergeDiagnostics(sanitization, safeText.diagnostics);
      items.push({
        id: note.id,
        type: "note",
        direction: note.direction,
        createdTime: note.createdTime,
        author: readableString(note.addedBy, ["name", "email"]),
        isInternal: note.isInternal,
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
  const notes: CanonicalTicketNote[] = [];
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
          const ticketNotes = await collectCanonicalTicketNotes({ client, ticketId });
          if (!ticketNotes.available) {
            throw new Error(ticketNotes.errors.join("; ") || "Ticket notes were unavailable.");
          }
          for (const note of ticketNotes.notes) {
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

function cloneTicketOptionFields(
  fields: Map<ValidatedTicketOptionField, SuperOpsField>
): Map<ValidatedTicketOptionField, SuperOpsField> {
  return new Map(
    [...fields.entries()].map(([fieldName, field]) => [
      fieldName,
      JSON.parse(JSON.stringify(field)) as SuperOpsField,
    ])
  );
}

function fieldOptionsCacheIdentity(
  fieldNames: readonly ValidatedTicketOptionField[]
): TicketOptionFieldsCacheIdentity | undefined {
  const credentials = getCredentials();
  if (!credentials?.subdomain) return undefined;
  const tenant = credentials.subdomain.trim().toLowerCase();
  if (!tenant) return undefined;
  const region = credentials.region ?? "us";
  const fields = [...fieldNames].sort() as ValidatedTicketOptionField[];
  const params = new URLSearchParams({
    v: "1",
    tenant,
    region,
    fields: fields.join(","),
  });
  const request = new Request(
    `https://superops-mcp.internal/cache/ticket-field-options?${params.toString()}`
  );
  return {
    tenant,
    region,
    fields,
    request,
    memoryKey: JSON.stringify({ version: 1, tenant, region, fields }),
  };
}

function defaultFieldOptionsNativeCache(): CloudflareNativeCache | undefined {
  return (globalThis as { caches?: CloudflareNativeCacheStorage }).caches?.default;
}

function sameFieldSet(
  left: readonly ValidatedTicketOptionField[],
  right: readonly ValidatedTicketOptionField[]
): boolean {
  return left.length === right.length && left.every((field, index) => field === right[index]);
}

function cacheEntryMetadata(entry: TicketOptionFieldsCacheEntry | undefined) {
  return entry
    ? {
        cachedAt: new Date(entry.cachedAtMs).toISOString(),
        expiresAt: new Date(entry.expiresAtMs).toISOString(),
      }
    : {};
}

function cacheableTicketOptionFields(
  fields: Map<ValidatedTicketOptionField, SuperOpsField>,
  fieldNames: readonly ValidatedTicketOptionField[]
): boolean {
  return fieldNames.every((fieldName) => {
    const field = fields.get(fieldName);
    return Boolean(
      field &&
      field.columnName === fieldName &&
      field.module === TICKET_FIELD_MODULE &&
      Array.isArray(field.options)
    );
  });
}

function payloadToTicketOptionCacheEntry(
  payload: unknown,
  identity: TicketOptionFieldsCacheIdentity,
  nowMs: number
): TicketOptionFieldsCacheEntry | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const candidate = payload as Partial<TicketOptionFieldsCachePayload>;
  if (
    candidate.version !== 1 ||
    candidate.tenant !== identity.tenant ||
    candidate.region !== identity.region ||
    !Array.isArray(candidate.fields) ||
    !sameFieldSet(candidate.fields, identity.fields) ||
    typeof candidate.cachedAtMs !== "number" ||
    typeof candidate.expiresAtMs !== "number" ||
    candidate.expiresAtMs <= nowMs ||
    !Array.isArray(candidate.entries)
  ) {
    return undefined;
  }
  const fields = new Map<ValidatedTicketOptionField, SuperOpsField>();
  for (const entry of candidate.entries) {
    if (!Array.isArray(entry) || entry.length !== 2) return undefined;
    const [fieldName, field] = entry;
    if (!identity.fields.includes(fieldName)) return undefined;
    fields.set(fieldName, field);
  }
  if (!cacheableTicketOptionFields(fields, identity.fields)) return undefined;
  return {
    fields,
    cachedAtMs: candidate.cachedAtMs,
    expiresAtMs: candidate.expiresAtMs,
  };
}

async function readTicketOptionFieldsCache(
  identity: TicketOptionFieldsCacheIdentity | undefined
): Promise<TicketOptionFieldsCacheLookup> {
  const nativeCache = defaultFieldOptionsNativeCache();
  if (!identity) {
    return { available: false, valid: false, readFailed: false, nativeAvailable: Boolean(nativeCache) };
  }
  const nowMs = Date.now();
  if (nativeCache) {
    try {
      const response = await nativeCache.match(identity.request);
      if (!response) {
        return { available: false, valid: false, readFailed: false, nativeAvailable: true };
      }
      const payload = await response.json();
      const entry = payloadToTicketOptionCacheEntry(payload, identity, nowMs);
      return {
        entry,
        available: true,
        valid: Boolean(entry),
        readFailed: false,
        nativeAvailable: true,
      };
    } catch {
      return { available: false, valid: false, readFailed: true, nativeAvailable: true };
    }
  }

  const entry = ticketFieldOptionsCache.get(identity.memoryKey);
  const valid = Boolean(entry && entry.expiresAtMs > nowMs);
  return {
    entry: valid ? entry : undefined,
    available: Boolean(entry),
    valid,
    readFailed: false,
    nativeAvailable: false,
  };
}

async function writeTicketOptionFieldsCache(
  identity: TicketOptionFieldsCacheIdentity | undefined,
  fields: Map<ValidatedTicketOptionField, SuperOpsField>
): Promise<void> {
  if (!identity || !cacheableTicketOptionFields(fields, identity.fields)) return;
  const cachedAtMs = Date.now();
  const expiresAtMs = cachedAtMs + FIELD_OPTIONS_CACHE_TTL_MS;
  const entry: TicketOptionFieldsCacheEntry = {
    fields: cloneTicketOptionFields(fields),
    cachedAtMs,
    expiresAtMs,
  };
  const nativeCache = defaultFieldOptionsNativeCache();
  if (nativeCache) {
    try {
      const payload: TicketOptionFieldsCachePayload = {
        version: 1,
        tenant: identity.tenant,
        region: identity.region,
        fields: identity.fields,
        cachedAtMs,
        expiresAtMs,
        entries: [...entry.fields.entries()],
      };
      await nativeCache.put(
        identity.request,
        new Response(JSON.stringify(payload), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": `max-age=${FIELD_OPTIONS_CACHE_TTL_MS / 1000}`,
          },
        })
      );
    } catch {
      // Cache writes are an optimisation and must not fail a successful fresh lookup.
    }
    return;
  }

  ticketFieldOptionsCache.set(identity.memoryKey, entry);
}
function fieldOptionsRetryDelay(error: unknown, attempt: number): {
  delayMs: number;
  retryAfterPresent: boolean;
  suppliedDelayMs?: number;
  source: "retry-after" | "backoff";
} {
  const config = getExecutionConfig();
  const retryAfterSeconds =
    error instanceof SuperOpsHttpError || error instanceof SuperOpsError
      ? error.retryAfter
      : undefined;
  if (typeof retryAfterSeconds === "number" && Number.isFinite(retryAfterSeconds)) {
    const suppliedDelayMs = Math.max(0, Math.ceil(retryAfterSeconds * 1000));
    return {
      delayMs: Math.min(config.maxSingleDelayMs, suppliedDelayMs),
      retryAfterPresent: true,
      suppliedDelayMs,
      source: "retry-after",
    };
  }

  const base = config.backoffBaseDelayMs * 2 ** Math.max(0, attempt - 1);
  const jitter = config.backoffJitterRatio <= 0
    ? 0
    : base * config.backoffJitterRatio * Math.random();
  return {
    delayMs: Math.min(config.maxSingleDelayMs, Math.ceil(base + jitter)),
    retryAfterPresent: false,
    source: "backoff",
  };
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getTicketOptionFieldsForTool(
  client: SuperOpsClientInstance,
  fieldNames: ValidatedTicketOptionField[]
): Promise<TicketOptionFieldsRetrieval> {
  const cacheIdentity = fieldOptionsCacheIdentity(fieldNames);
  const config = getExecutionConfig();
  const maxAttempts = Math.max(
    1,
    Math.min(FIELD_OPTIONS_MAX_INTERNAL_ATTEMPTS, config.maxReadRetryAttempts)
  );
  const startedMs = Date.now();
  let attempts = 0;
  let retryAfterPresent = false;
  let lastError: unknown;

  while (attempts < maxAttempts) {
    attempts += 1;
    try {
      const fields = await getTicketOptionFields(client, fieldNames);
      await writeTicketOptionFieldsCache(cacheIdentity, fields);
      return {
        fields,
        metadata: {
          source: "fresh",
          cacheStatus: cacheIdentity ? "miss" : "unavailable",
          cacheTtlSeconds: FIELD_OPTIONS_CACHE_TTL_MS / 1000,
          attempts,
          retried: attempts > 1,
          rateLimited: false,
          retryAfterPresent,
        },
      };
    } catch (error) {
      lastError = error;
      if (!isRateLimitError(error) || attempts >= maxAttempts) break;
      const retry = fieldOptionsRetryDelay(error, attempts);
      retryAfterPresent ||= retry.retryAfterPresent;
      const elapsedAfterDelay = Date.now() - startedMs + retry.delayMs;
      if (
        elapsedAfterDelay > config.maxRetryDurationMs ||
        !hasExecutionBudgetFor(1) ||
        elapsedAfterDelay + config.safeRemainingTimeMs >= config.maxDurationMs
      ) {
        break;
      }
      recordRetryDelay({
        attempt: attempts,
        source: retry.source,
        retryAfterSupplied: retry.retryAfterPresent,
        suppliedDelayMs: retry.suppliedDelayMs,
        parsedDelayMs: retry.suppliedDelayMs ?? retry.delayMs,
        cappedDelayMs: retry.delayMs,
        actualDelayMs: retry.delayMs,
        endpoint: FIELD_OPTIONS_RETRY_ENDPOINT,
        operationType: "query",
        operationName: "getFields",
      });
      await sleep(retry.delayMs);
    }
  }

  const cacheLookup = isRateLimitError(lastError)
    ? await readTicketOptionFieldsCache(cacheIdentity)
    : { available: false, valid: false, readFailed: false, nativeAvailable: Boolean(defaultFieldOptionsNativeCache()) };
  if (isRateLimitError(lastError) && cacheLookup.entry) {
    return {
      fields: cloneTicketOptionFields(cacheLookup.entry.fields),
      metadata: {
        source: "cache",
        cacheStatus: "fallback",
        cacheTtlSeconds: FIELD_OPTIONS_CACHE_TTL_MS / 1000,
        ...cacheEntryMetadata(cacheLookup.entry),
        attempts,
        retried: attempts > 1,
        rateLimited: true,
        retryAfterPresent,
      },
    };
  }

  throw {
    fieldOptionsError: true,
    errorClass: isRateLimitError(lastError)
      ? "SuperOpsRateLimit"
      : lastError instanceof SuperOpsHttpError
        ? "SuperOpsHttpError"
        : lastError instanceof SuperOpsError
          ? "SuperOpsGraphQLError"
          : "SuperOpsMetadataError",
    rateLimited: isRateLimitError(lastError),
    attempts,
    retryAfterPresent,
    cacheEntryAvailable: cacheLookup.available,
    cacheEntryValid: cacheLookup.valid,
    cacheReadFailed: cacheLookup.readFailed,
    nativeCacheAvailable: cacheLookup.nativeAvailable,
    finalReason: safeErrorMessage(lastError),
  };
}

export function resetTicketFieldOptionsCacheForTests(): void {
  ticketFieldOptionsCache.clear();
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
  fieldName: (typeof RESOLVED_REQUIRED_FIELDS)[number] | (typeof TRIAGE_RESOLVED_REQUIRED_FIELDS)[number]
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
  requiredOptionFields?: readonly ValidatedTicketOptionField[];
}): StructuredValidationFailure | undefined {
  const missingFields: string[] = [];
  const invalidFields: Record<string, string> = {};
  const requiredOptionFields = params.requiredOptionFields ?? RESOLVED_REQUIRED_OPTION_FIELDS;
  const validOptions = validOptionsForFields(
    params.optionFields,
    requiredOptionFields
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

  for (const fieldName of requiredOptionFields) {
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
    const extensions = JSON.stringify(error.extensions ?? {});
    return /rate|thrott|too_many_requests/i.test(error.code ?? "") ||
      /rate[-_\s]?limit|too many requests|throttl/i.test(error.message) ||
      /rate_limit_exceeded|too_many_requests|throttl/i.test(extensions);
  }
  const message = error instanceof Error ? error.message : String(error);
  return /rate[-_\s]?limit|too many requests|status\s*429/i.test(message);
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

function preWriteReadFailureResult(params: {
  ticketNumber: string;
  action: TriagePlanAction;
  error: unknown;
  operationName: string;
}): ApplyTriagePlanResult {
  const result = baseApplyResult(params.ticketNumber, params.action);
  result.finalOutcome = "Failed";
  result.failureStage = "readMetadata";
  result.failureReason = safeErrorMessage(params.error);
  if (!isRateLimitError(params.error)) {
    return result;
  }

  const rateLimit = rateLimitRetryMetadata(params.error);
  result.failureStage = "rateLimit";
  result.retrySafe = true;
  result.rateLimitRetryAfterMs = rateLimit.delayMs;
  result.rateLimitRequestedDelayMs = rateLimit.requestedDelayMs;
  result.rateLimitRetryAfterSupplied = rateLimit.retryAfterSupplied;
  result.rateLimitDelaySource = rateLimit.delaySource;
  // A throttled read cannot have changed SuperOps state. This flag feeds the
  // existing durable rate-limit continuation path without implying a write.
  result.rateLimitConclusiveRejection = true;
  result.rateLimitOperationName = params.operationName;
  return result;
}

function ticketClientName(ticket: Ticket): string | undefined {
  return readableString(ticket.client, ["name", "accountName"]);
}

function ticketClientAccountId(ticket: Ticket): string | undefined {
  const client = jsonRecord(ticket.client);
  const accountId = client?.accountId ?? client?.clientId ?? client?.id;
  return typeof accountId === "string" && accountId.trim().length > 0
    ? accountId.trim()
    : undefined;
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
  const clientName = ticketClientName(ticket);
  const clientId = ticketClientAccountId(ticket);
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
    client: clientName ?? ticket.client,
    clientName,
    clientId,
  };
}

function ticketVerificationValue(ticket: Ticket, field: string): unknown {
  if (field === "techGroup") {
    return ticketTechGroupName(ticket);
  }
  if (field === "clientName") {
    const clientName = ticketClientName(ticket);
    return clientName ? canonicalClientName(clientName) : undefined;
  }
  if (field === "clientId") {
    return ticketClientAccountId(ticket);
  }
  return (ticket as unknown as Record<string, unknown>)[field];
}

function triageWritableTargetState(action?: TriagePlanAction): Record<string, unknown> | null {
  const target = action?.target;
  if (!target) return null;
  const writable = Object.fromEntries(
    TRIAGE_PLAN_WRITABLE_TARGET_FIELDS.flatMap((field) =>
      target[field] !== undefined ? [[field, target[field]] as const] : []
    )
  );
  return Object.keys(writable).length > 0 ? writable : null;
}

function triageDerivedReadOnlyState(action?: TriagePlanAction): Record<string, unknown> | null {
  const target = action?.target;
  if (!target) return null;
  const derived = Object.fromEntries(
    TRIAGE_PLAN_DERIVED_READONLY_TARGET_FIELDS.flatMap((field) =>
      target[field] !== undefined ? [[field, target[field]] as const] : []
    )
  );
  return Object.keys(derived).length > 0 ? derived : null;
}

function ignoredTriageTargetFields(action?: TriagePlanAction): Array<{ field: string; value: unknown; reason: string }> | undefined {
  const target = action?.target;
  if (!target || target.priority === undefined) return undefined;
  return [{ field: "priority", value: target.priority, reason: TRIAGE_DERIVED_PRIORITY_IGNORE_REASON }];
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
    "status", "impact", "urgency", "category", "subcategory", "cause", "resolutionCode",
  ] as const) {
    if (target[field] !== undefined) {
      requested.push({ field, expected: target[field] });
    }
  }

  if (target.techGroupName !== undefined) {
    requested.push({ field: "techGroup", expected: target.techGroupName });
  }
  if (target.clientId !== undefined || target.clientName !== undefined) {
    const actualClientId = ticketClientAccountId(ticket);
    const actualClientName = ticketClientName(ticket);
    if (target.clientId !== undefined && actualClientId !== undefined) {
      requested.push({ field: "clientId", expected: target.clientId });
    }
    if (target.clientName !== undefined && actualClientName !== undefined) {
      requested.push({ field: "clientName", expected: canonicalClientName(target.clientName) });
    }
    if (actualClientId === undefined && actualClientName === undefined) {
      if (target.clientId !== undefined) {
        requested.push({ field: "clientId", expected: target.clientId });
      }
      if (target.clientName !== undefined) {
        requested.push({ field: "clientName", expected: canonicalClientName(target.clientName) });
      }
    } else if (target.clientId !== undefined && target.clientName === undefined && actualClientId === undefined) {
      requested.push({ field: "clientId", expected: target.clientId });
    } else if (target.clientName !== undefined && target.clientId === undefined && actualClientName === undefined) {
      requested.push({ field: "clientName", expected: canonicalClientName(target.clientName) });
    }
  }

  const mismatches = requested.flatMap(({ field, expected }) => {
    const actual = ticketVerificationValue(ticket, field);
    return compareTicketValue(expected, actual) ? [] : [{ field, expected, actual }];
  });

  return { mismatches };
}

function baseApplyResult(
  ticketNumber: string,
  action?: TriagePlanAction,
  ticket?: Ticket
): ApplyTriagePlanResult {
  const writableTargetState = triageWritableTargetState(action);
  const derivedReadOnlyState = triageDerivedReadOnlyState(action);
  return {
    ticketNumber,
    ticketId: ticket?.ticketId,
    subject: ticket?.subject,
    client: ticket ? ticketClientName(ticket) : undefined,
    requestedAction: action?.action,
    finalOutcome: "Failed",
    writeAttempted: false,
    writeMayHaveSucceeded: undefined,
    writeMethod: null,
    noteAdded: false,
    noteDeduped: false,
    verified: false,
    finalState: ticket ? ticketFinalState(ticket) : null,
    failureStage: null,
    failureReason: null,
    primaryWriteMethod: null,
    primaryWriteOutcome: null,
    primaryFailureDiagnostics: null,
    primaryGraphqlClassification: undefined,
    primaryGraphqlCode: undefined,
    primaryGraphqlPath: undefined,
    primaryResponseHadData: undefined,
    primarySynchronousFailure: undefined,
    updatedTimeChanged: undefined,
    requestedFieldsObserved: undefined,
    noChangeObserved: undefined,
    retrySafe: undefined,
    partialFieldsObserved: null,
    statusObserved: ticket?.status ?? null,
    fallbackEligible: false,
    fallbackAttempted: false,
    fallbackWriteMethod: null,
    fallbackOutcome: null,
    fallbackResult: null,
    physicalWrites: [],
    finalVerificationState: "NotRequired",
    terminalReason: null,
    partialWrite: false,
    requestedState: writableTargetState,
    attemptedState: null,
    writableTargetState,
    derivedReadOnlyState,
    ignoredTargetFields: ignoredTriageTargetFields(action),
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
  fingerprint: string | undefined,
  options: { ticketNumber?: string; additionalTicketIds?: string[] } = {}
): Promise<boolean> {
  if (!fingerprint) return false;
  const collection = await collectCanonicalTicketNotes({
    client,
    ticketId,
    ticketNumber: options.ticketNumber,
    additionalTicketIds: options.additionalTicketIds,
    stopAfterPrivateFingerprint: fingerprint,
  });
  if (!collection.available) {
    throw new Error(collection.errors.join("; ") || "Ticket notes were unavailable.");
  }
  // Continuation recovery is deliberately private-note only. A public note with
  // identical text is neither evidence that the approved private note was
  // written nor a reason to skip its private write.
  return collection.notes.some(
    (existing) => isPrivateTicketNote(existing) &&
      normalizedNoteFingerprint(existing.plainText) === fingerprint
  );
}

async function existingNoteMatches(
  client: SuperOpsClientInstance,
  ticketId: string,
  note: string,
  options: { ticketNumber?: string; additionalTicketIds?: string[] } = {}
): Promise<boolean> {
  return existingNoteMatchesFingerprint(client, ticketId, normalizedNoteFingerprint(note), options);
}

function noteBodyForPlan(note: string | undefined): string | undefined {
  return typeof note === "string" && note.trim().length > 0 ? note : undefined;
}

function markNotePlanned(result: ApplyTriagePlanResult, note: string | undefined): boolean {
  const planned = noteBodyForPlan(note) !== undefined;
  if (planned) {
    result.notePlanned = true;
  }
  return planned;
}

function markNoteDedupePlanned(
  result: ApplyTriagePlanResult,
  note: string | undefined,
  dedupe: boolean
): boolean {
  const planned = markNotePlanned(result, note);
  if (planned && dedupe) {
    result.noteDedupePlanned = true;
    result.noteDedupeChecked = false;
  }
  return planned && dedupe;
}

async function checkNoteForPlan(params: {
  client: SuperOpsClientInstance;
  ticketId: string;
  ticketNumber?: string;
  additionalTicketIds?: string[];
  note?: string;
  dedupe: boolean;
  result: ApplyTriagePlanResult;
  beforeCheck?: () => Promise<void>;
}): Promise<"none" | "deduped" | "pending"> {
  const note = noteBodyForPlan(params.note);
  if (!note) return "none";
  markNotePlanned(params.result, note);
  if (!params.dedupe) return "pending";
  markNoteDedupePlanned(params.result, note, true);
  await params.beforeCheck?.();
  const noteDeduped = await existingNoteMatches(params.client, params.ticketId, note, {
    ticketNumber: params.ticketNumber,
    additionalTicketIds: params.additionalTicketIds,
  });
  params.result.noteDedupeChecked = true;
  if (noteDeduped) {
    params.result.noteDeduped = true;
    return "deduped";
  }
  return "pending";
}

async function createNoteForPlan(params: {
  client: SuperOpsClientInstance;
  ticketId: string;
  note?: string;
  isPublic?: boolean;
  result: ApplyTriagePlanResult;
  beforeCreate?: () => Promise<void>;
  afterCreate?: (note: TicketNote) => Promise<void>;
}): Promise<void> {
  const note = noteBodyForPlan(params.note);
  if (!note) return;
  await params.beforeCreate?.();
  let created: TicketNote;
  try {
    created = await createTicketNote(
      params.client,
      params.ticketId,
      note,
      params.isPublic ?? false
    );
  } catch (error) {
    recordPhysicalWrite(
      params.result,
      "createTicketNote",
      isReliableSynchronousMutationRejection(error) ? "Rejected" : "Ambiguous"
    );
    throw error;
  }
  recordPhysicalWrite(params.result, "createTicketNote", "Accepted");
  await params.afterCreate?.(created);
  params.result.noteAdded = true;
  params.result.writeMayHaveSucceeded = true;
}

async function addNoteForPlan(params: {
  client: SuperOpsClientInstance;
  ticketId: string;
  ticketNumber?: string;
  additionalTicketIds?: string[];
  note?: string;
  isPublic?: boolean;
  dedupe: boolean;
  result: ApplyTriagePlanResult;
  beforeCheck?: () => Promise<void>;
  beforeCreate?: () => Promise<void>;
  afterCreate?: (note: TicketNote) => Promise<void>;
}): Promise<void> {
  const notePlan = await checkNoteForPlan(params);
  if (notePlan !== "pending") return;
  await createNoteForPlan(params);
}

async function buildApprovedUpdateInput(
  client: SuperOpsClientInstance,
  ticketId: string,
  action: TriagePlanAction,
  defaultStatus?: string
): Promise<Record<string, unknown> | { error: string }> {
  const target = action.target ?? {};
  const input: Record<string, unknown> = { ticketId };
  if (action.action === "resolve" || action.action === "update" || action.action === "leave") {
    const requiredClassificationFields = action.action === "resolve"
      ? TRIAGE_PLAN_RESOLVE_REQUIRED_CLASSIFICATION_FIELDS
      : TRIAGE_PLAN_REQUIRED_CLASSIFICATION_FIELDS;
    const missingClassificationFields = requiredClassificationFields.filter(
      (field) => typeof target[field] !== "string" || String(target[field]).trim().length === 0
    );
    if (missingClassificationFields.length > 0) {
      return {
        error: `${action.action} action requires classification field(s): ${missingClassificationFields.join(", ")}.`,
      };
    }
  }
  if ((action.action === "update" || action.action === "leave") && "resolutionCode" in target) {
    return { error: "Resolution code is only allowed for a resolve action." };
  }
  if (action.action === "leave") {
    const unsupportedLeaveFields = Object.keys(target).filter(
      (field) => !(TRIAGE_PLAN_LEAVE_TARGET_FIELDS as readonly string[]).includes(field)
    );
    if (unsupportedLeaveFields.length > 0) {
      return { error: `Leave action contains unsupported target field(s): ${unsupportedLeaveFields.join(", ")}.` };
    }
  }

  const status = target.status ?? defaultStatus;
  if (action.action === "resolve" && status !== undefined && status !== "Resolved") {
    return { error: `Resolve action can only set status to Resolved; got ${status}.` };
  }
  if (action.action === "update" && status !== "Awaiting Engineer") {
    return { error: `Update action can only set status to Awaiting Engineer; got ${status ?? "no status"}.` };
  }
  if (action.action === "leave" && status !== undefined) {
    return { error: `Leave action cannot change status; got ${status}.` };
  }
  if (status) {
    if (!(TRIAGE_PLAN_MUTABLE_STATUSES as readonly string[]).includes(status)) {
      return { error: `Invalid approved triage status: ${status}` };
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
    ["impact", "urgency", "resolutionCode", "cause", "subcategory"]
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

const STAGED_NOTE_VISIBILITY_RECONCILIATION_DELAY_MS = 15_000;
const STAGED_NOTE_VISIBILITY_MAX_ATTEMPTS = 4;

const STAGED_RESOLVE_CLASSIFICATION_FIELDS = [
  "impact",
  "urgency",
  "category",
  "subcategory",
  "cause",
  "resolutionCode",
  "clientName",
  "clientId",
] as const;


function markWorkflowStage(result: ApplyTriagePlanResult, stage: string): void {
  result.completedStages = [...new Set([...(result.completedStages ?? []), stage])];
  result.currentStage = stage;
}

function stagedResolvePlannedMutations(action: TriagePlanAction, ticket?: Ticket): string[] {
  const planned: string[] = [];
  const classificationAction = stagedResolveClassificationAction(action);
  if (!ticket || verifyFinalTargetState(classificationAction, ticket).mismatches.length > 0) {
    planned.push("updateClassificationAndClient");
  }
  if (noteBodyForPlan(action.note)) {
    planned.push("checkPrivateNote", "createPrivateNote");
  }
  planned.push("updateStatusResolved");
  return planned;
}

function stagedResolveClassificationAction(action: TriagePlanAction): TriagePlanAction {
  const target = action.target ?? {};
  const classificationTarget: TicketClassificationParams & { clientName?: string; clientId?: string } = {};
  for (const field of STAGED_RESOLVE_CLASSIFICATION_FIELDS) {
    const value = target[field];
    if (value !== undefined) {
      (classificationTarget as Record<string, unknown>)[field] = value;
    }
  }
  return { ...action, target: classificationTarget };
}

function stagedResolveFinalAction(action: TriagePlanAction): TriagePlanAction {
  return {
    ...action,
    target: {
      ...(action.target ?? {}),
      status: action.target?.status ?? DEFAULT_RESOLVE_TICKET_STATUS,
    },
  };
}

function stagedResolveResumeSkipsSnapshotExpectations(stage: OperationItemState["stage"] | undefined): boolean {
  return stage === "ClassificationWriteStarted" ||
    stage === "ClassificationWriteSucceeded" ||
    stage === "ClassificationVerified" ||
    stage === "NoteDedupeChecked" ||
    stage === "NoteWriteStarted" ||
    stage === "NoteAdded" ||
    stage === "NoteVerified" ||
    stage === "StatusWriteStarted" ||
    stage === "StatusWriteSucceeded" ||
    stage === "StatusVerified";
}

function stagedResolveResumeHasVerifiedClassification(stage: OperationItemState["stage"] | undefined): boolean {
  return stage === "ClassificationVerified" ||
    stage === "NoteDedupeChecked" ||
    stage === "NoteWriteStarted" ||
    stage === "NoteAdded" ||
    stage === "NoteVerified" ||
    stage === "StatusWriteStarted" ||
    stage === "StatusWriteSucceeded" ||
    stage === "StatusVerified";
}

function stagedResolveResumeHasPreflightValidation(stage: OperationItemState["stage"] | undefined): boolean {
  return stage === "PreflightValidated" ||
    stage === "ClassificationWriteStarted" ||
    stage === "ClassificationWriteSucceeded" ||
    stagedResolveResumeHasVerifiedClassification(stage);
}

function stagedResolveResumeHasCheckedNote(stage: OperationItemState["stage"] | undefined): boolean {
  return stage === "NoteDedupeChecked" ||
    stage === "NoteWriteStarted" ||
    stage === "NoteAdded" ||
    stage === "NoteVerified" ||
    stage === "StatusWriteStarted" ||
    stage === "StatusWriteSucceeded" ||
    stage === "StatusVerified";
}

function stagedResolveResumeAtOrPastNoteWrite(stage: OperationItemState["stage"] | undefined): boolean {
  return stage === "NoteWriteStarted" ||
    stage === "NoteAdded" ||
    stage === "NoteVerified" ||
    stage === "StatusWriteStarted" ||
    stage === "StatusWriteSucceeded" ||
    stage === "StatusVerified";
}

function stagedResolveResumeHasVerifiedNote(stage: OperationItemState["stage"] | undefined): boolean {
  return stage === "NoteVerified" ||
    stage === "StatusWriteStarted" ||
    stage === "StatusWriteSucceeded" ||
    stage === "StatusVerified";
}
function actionWithSnapshotExpectationsRelaxedForStagedResume(action: TriagePlanAction): TriagePlanAction {
  return {
    ...action,
    expectedClient: undefined,
    expectedClientHash: undefined,
    expectedStatus: undefined,
    expectedUpdatedTime: undefined,
  };
}

async function buildStagedResolveClassificationInput(
  client: SuperOpsClientInstance,
  ticketId: string,
  action: TriagePlanAction
): Promise<Record<string, unknown> | { error: string }> {
  const target = action.target ?? {};
  if (target.techGroupName !== undefined) {
    return { error: "Resolve triage actions do not support technician-group assignment in staged mode." };
  }
  if (target.status !== undefined && target.status !== DEFAULT_RESOLVE_TICKET_STATUS) {
    return { error: `Resolve triage actions must close to ${DEFAULT_RESOLVE_TICKET_STATUS}; got ${target.status}.` };
  }
  const input: Record<string, unknown> = { ticketId };
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
    ["impact", "urgency", "resolutionCode", "cause", "subcategory"]
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
  return input;
}

function buildStagedResolveStatusInput(
  ticketId: string,
  status: string | undefined
): Record<string, unknown> | { error: string } {
  const finalStatus = status ?? DEFAULT_RESOLVE_TICKET_STATUS;
  if (finalStatus !== DEFAULT_RESOLVE_TICKET_STATUS) {
    return { error: `Staged resolve can only close to ${DEFAULT_RESOLVE_TICKET_STATUS}; got ${finalStatus}.` };
  }
  if (invalidValues([finalStatus], VALID_TICKET_STATUSES).length > 0) {
    return { error: `Invalid ticket status: ${finalStatus}` };
  }
  return { ticketId, status: finalStatus, suppressCloseNotification: true };
}

function classificationInputHasWritableFields(input: Record<string, unknown>): boolean {
  return Object.keys(input).some((key) => key !== "ticketId");
}

function noteExpectedForAction(action: TriagePlanAction): boolean {
  return Boolean(action.noteFingerprint ?? normalizedNoteFingerprint(action.note));
}

function stagedTicketStateChanges(before: Ticket, after: Ticket): Array<{ field: string; before: unknown; after: unknown }> {
  const beforeState = ticketFinalState(before) as Record<string, unknown>;
  const afterState = ticketFinalState(after) as Record<string, unknown>;
  const fields = new Set([...Object.keys(beforeState), ...Object.keys(afterState)]);
  return [...fields].flatMap((field) => {
    const beforeValue = beforeState[field];
    const afterValue = afterState[field];
    return JSON.stringify(beforeValue ?? null) === JSON.stringify(afterValue ?? null)
      ? []
      : [{ field, before: beforeValue ?? null, after: afterValue ?? null }];
  });
}
function updateStagedNoChangeFailureStage(result: ApplyTriagePlanResult, stage: string): void {
  if (result.finalOutcome !== "RejectedOrNoChange" && result.finalOutcome !== "AmbiguousNoChangeObserved") return;
  result.failureStage = stage;
  result.terminalReason = result.finalOutcome;
}

function stagedNoteVisibilityNextEligibleTime(): string {
  return new Date(Date.now() + STAGED_NOTE_VISIBILITY_RECONCILIATION_DELAY_MS).toISOString();
}

function markStagedNoteVisibilityPending(params: {
  result: ApplyTriagePlanResult;
  stage?: string;
  attempts: number;
  initialObserved?: boolean;
}): ApplyTriagePlanResult {
  params.result.finalOutcome = "NoteVisibilityPending";
  params.result.failureStage = "noteVisibility";
  params.result.failureReason = "The submitted private-note write is not visible yet; completion is deferred to read-only reconciliation.";
  params.result.terminalReason = "NoteVisibilityPending";
  params.result.partialWrite = true;
  params.result.writeMayHaveSucceeded = true;
  params.result.verified = false;
  params.result.finalVerificationState = "Pending";
  params.result.noteWriteOutcome = "NoteVisibilityPending";
  params.result.initialNoteVerificationObserved = params.initialObserved ?? false;
  params.result.noteVerificationAttempts = params.attempts;
  params.result.noteVerifiedAfterDelay = false;
  params.result.continuationRequired = true;
  markWorkflowStage(params.result, params.stage ?? "NoteVisibilityPending");
  return params.result;
}

function markStagedNoteVisibilityUnresolved(params: {
  result: ApplyTriagePlanResult;
  attempts: number;
}): ApplyTriagePlanResult {
  const result = markStagedFailure({
    result: params.result,
    stage: "noteVisibility",
    reason: "The submitted private-note write remained invisible after " + params.attempts + " read-only verification attempts; no further mutation was attempted.",
    terminalReason: "NoteVisibilityUnresolved",
    partialWrite: true,
    writeMayHaveSucceeded: true,
    verificationState: "Pending",
  });
  result.noteWriteOutcome = "NoteVisibilityUnresolved";
  result.initialNoteVerificationObserved = false;
  result.noteVerificationAttempts = params.attempts;
  result.noteVerifiedAfterDelay = false;
  result.continuationRequired = false;
  return result;
}

function markStagedNoteVerifiedAfterDelay(result: ApplyTriagePlanResult, attempts: number): void {
  result.noteWriteOutcome = "NoteVerifiedAfterDelay";
  result.initialNoteVerificationObserved = false;
  result.noteVerificationAttempts = attempts;
  result.noteVerifiedAfterDelay = true;
  result.continuationRequired = false;
}

function markStagedFailure(params: {
  result: ApplyTriagePlanResult;
  stage: string;
  reason: string;
  terminalReason: string;
  partialWrite: boolean;
  writeMayHaveSucceeded?: boolean;
  finalOutcome?: TriageFinalOutcome;
  verificationState?: "Failed" | "Pending";
}): ApplyTriagePlanResult {
  params.result.finalOutcome = params.finalOutcome ?? "Failed";
  params.result.failureStage = params.stage;
  params.result.failureReason = params.reason;
  params.result.terminalReason = params.terminalReason;
  params.result.partialWrite = params.partialWrite;
  params.result.writeMayHaveSucceeded = params.writeMayHaveSucceeded ?? params.result.writeMayHaveSucceeded;
  params.result.verified = false;
  params.result.finalVerificationState = params.verificationState ?? "Failed";
  params.result.currentStage = params.stage;
  return params.result;
}

async function applyStagedResolveAction(params: {
  client: SuperOpsClientInstance;
  ticketNumber: string;
  action: TriagePlanAction;
  ticket: Ticket;
  resolvedTicketId: string;
  result: ApplyTriagePlanResult;
  verify: boolean;
  dedupeNotes: boolean;
  resumeStage?: OperationItemState["stage"];
  noteVisibilityPriorAttempts?: number;
  beforeNoteCheck?: () => Promise<void>;
  afterPreflightValidation?: () => Promise<void>;
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
  afterVerification?: (mutationType: "update" | "classification" | "resolution" | "status" | "note") => Promise<void>;
}): Promise<ApplyTriagePlanResult> {
  const { client, action, result } = params;
  result.workflowMode = "staged";
  result.writeMethod = "staged";
  result.suppressCloseNotificationRequested = true;
  result.suppressCloseNotificationIncluded = false;
  result.plannedMutations = stagedResolvePlannedMutations(action, params.ticket);
  result.physicalWrites = result.physicalWrites ?? [];
  markWorkflowStage(result, "PreflightValidated");

  const classificationAction = stagedResolveClassificationAction(action);
  const finalAction = stagedResolveFinalAction(action);
  const classificationInput = await buildStagedResolveClassificationInput(client, params.resolvedTicketId, action);
  const classificationInputError = (classificationInput as { error?: unknown }).error;
  if (typeof classificationInputError === "string") {
    return markStagedFailure({
      result,
      stage: "validation",
      reason: classificationInputError,
      terminalReason: "StagedResolveValidationFailed",
      partialWrite: false,
      finalOutcome: "Blocked",
    });
  }

  const classificationMismatches = verifyFinalTargetState(classificationAction, params.ticket).mismatches;
  let trustedTicket = params.ticket;
  const stagedNoteTicketIds = () => [params.resolvedTicketId, params.ticket.ticketId, trustedTicket.ticketId];
  const classificationWriteRequired = classificationInputHasWritableFields(classificationInput as Record<string, unknown>) &&
    classificationMismatches.length > 0 &&
    !stagedResolveResumeHasVerifiedClassification(params.resumeStage);
  result.classificationWriteMethod = "updateTicket.classification";
  result.classificationWriteOutcome = classificationWriteRequired ? "Pending" : "NotRequired";

  if (!classificationWriteRequired && !stagedResolveResumeHasPreflightValidation(params.resumeStage)) {
    await params.afterPreflightValidation?.();
  }

  if (classificationWriteRequired) {
    result.attemptedState = classificationInput as Record<string, unknown>;
    result.primaryWriteMethod = "updateTicket.classification";
    try {
      await params.beforeMutation?.("classification");
      result.writeAttempted = true;
      const mutationResult = await mutateTicketUpdate(client, classificationInput as Record<string, unknown>);
      result.writeMayHaveSucceeded = true;
      result.primaryWriteOutcome = "Accepted";
      result.classificationWriteOutcome = "Accepted";
      recordPhysicalWrite(result, "updateTicket.classification", "Accepted");
      await params.afterMutation?.("classification", { ticketId: mutationResult.ticketId });
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
        result.partialWrite = !rateLimit.conclusiveRejection;
        result.writeMayHaveSucceeded = !rateLimit.conclusiveRejection;
        result.classificationWriteOutcome = rateLimit.conclusiveRejection ? "Rejected" : "Ambiguous";
        if (rateLimit.conclusiveRejection) {
          await params.afterConclusiveRejection?.("classification", rateLimit, result.failureReason ?? undefined);
        }
        return result;
      }
      result.primaryWriteOutcome = isReliableSynchronousMutationRejection(error) ? "Rejected" : "Ambiguous";
      result.classificationWriteOutcome = result.primaryWriteOutcome;
      result.writeAttempted = true;
      result.writeMayHaveSucceeded = !isReliableSynchronousMutationRejection(error);
      result.partialWrite = result.writeMayHaveSucceeded === true;
      result.primaryWriteMethod = "updateTicket.classification";
      applyPrimaryFailureDiagnostics(result, error);
      recordPhysicalWrite(result, "updateTicket.classification", result.primaryWriteOutcome);
      let reread: Ticket;
      try {
        reread = await getTicketByInternalId(client, params.resolvedTicketId);
      } catch (verifyError) {
        return markStagedFailure({
          result,
          stage: "classificationAmbiguousVerification",
          reason: "Classification write response could not be reconciled: " + safeErrorMessage(verifyError),
          terminalReason: "ClassificationAmbiguousUnresolved",
          partialWrite: result.writeMayHaveSucceeded === true,
          writeMayHaveSucceeded: result.writeMayHaveSucceeded,
          verificationState: "Pending",
        });
      }
      result.finalState = ticketFinalState(reread);
      result.observedFinalState = result.finalState;
      result.updatedTimeChanged = updatedTimeChanged(params.ticket, reread);
      result.requestedFieldsObserved = requestedFieldsMatchingTarget(classificationAction, reread);
      if (markNoChangeObserved({ result, error, originalTicket: params.ticket, reread, action: classificationAction })) {
        updateStagedNoChangeFailureStage(result, "classification");
        result.classificationWriteOutcome = result.primaryWriteOutcome;
        return result;
      }
      if ((result.requestedFieldsObserved?.length ?? 0) > 0) {
        result.noChangeObserved = false;
        result.partialFieldsObserved = observedRequestedNonStatusFields(classificationAction, reread);
        return markStagedFailure({
          result,
          stage: "classificationVerification",
          reason: "Classification/client write returned an error but requested fields were observed; later staged writes were not attempted.",
          terminalReason: "PartialClassificationObserved",
          partialWrite: true,
          writeMayHaveSucceeded: true,
        });
      }
      if (!isSynchronousMutationFailure(error) && result.updatedTimeChanged === false) {
        return markStagedFailure({
          result,
          stage: "classificationAmbiguousVerification",
          reason: "Ambiguous classification/client write was not observed; it will not be retried automatically.",
          terminalReason: "ClassificationAmbiguousUnresolved",
          partialWrite: true,
          writeMayHaveSucceeded: true,
          verificationState: "Pending",
        });
      }
      const verification = verifyFinalTargetState(classificationAction, reread);
      if (verification.mismatches.length > 0) {
        result.partialFieldsObserved = observedRequestedNonStatusFields(classificationAction, reread);
        return markStagedFailure({
          result,
          stage: "classificationVerification",
          reason: `Classification/client verification mismatched requested fields: ${JSON.stringify(verification.mismatches)}`,
          terminalReason: result.requestedFieldsObserved && result.requestedFieldsObserved.length > 0
            ? "PartialClassificationObserved"
            : "ClassificationVerificationMismatch",
          partialWrite: result.writeMayHaveSucceeded === true,
          writeMayHaveSucceeded: result.writeMayHaveSucceeded,
        });
      }
      trustedTicket = reread;
    }
  }

  if (params.resumeStage === "ClassificationWriteStarted" || params.resumeStage === "ClassificationWriteSucceeded" ||
      params.resumeStage === "ClassificationVerified" || !classificationWriteRequired) {
    const verifiedClassification = !classificationWriteRequired && !params.resumeStage
      ? params.ticket
      : await getTicketByInternalId(client, params.resolvedTicketId);
    const verification = verifyFinalTargetState(classificationAction, verifiedClassification);
    result.finalState = ticketFinalState(verifiedClassification);
    result.observedFinalState = result.finalState;
    if (verification.mismatches.length > 0) {
      return markStagedFailure({
        result,
        stage: "classificationVerification",
        reason: `Classification/client verification mismatched requested fields: ${JSON.stringify(verification.mismatches)}`,
        terminalReason: "ClassificationVerificationMismatch",
        partialWrite: result.writeAttempted || params.resumeStage === "ClassificationWriteStarted",
        writeMayHaveSucceeded: result.writeMayHaveSucceeded ?? (params.resumeStage === "ClassificationWriteStarted" ? true : undefined),
      });
    }
    trustedTicket = verifiedClassification;
  } else {
    const verifiedClassification = await getTicketByInternalId(client, params.resolvedTicketId);
    const verification = verifyFinalTargetState(classificationAction, verifiedClassification);
    result.finalState = ticketFinalState(verifiedClassification);
    result.observedFinalState = result.finalState;
    if (verification.mismatches.length > 0) {
      return markStagedFailure({
        result,
        stage: "classificationVerification",
        reason: `Classification/client verification mismatched requested fields: ${JSON.stringify(verification.mismatches)}`,
        terminalReason: "ClassificationVerificationMismatch",
        partialWrite: result.writeAttempted,
        writeMayHaveSucceeded: result.writeMayHaveSucceeded,
      });
    }
    trustedTicket = verifiedClassification;
  }
  result.verifiedState = ticketFinalState(trustedTicket);
  result.updatedTimeChanged = updatedTimeChanged(params.ticket, trustedTicket);
  result.classificationWriteOutcome = result.classificationWriteOutcome === "Pending" ? "Verified" : result.classificationWriteOutcome;
  markWorkflowStage(result, "ClassificationVerified");
  if (!stagedResolveResumeHasVerifiedClassification(params.resumeStage)) {
    await params.afterVerification?.("classification");
  }

  const noteRequired = noteBodyForPlan(action.note) !== undefined;
  if (noteRequired) {
    let notePlan: "none" | "deduped" | "pending";
    try {
      notePlan = await checkNoteForPlan({
        client,
        ticketId: trustedTicket.ticketId,
        ticketNumber: params.ticketNumber,
        additionalTicketIds: stagedNoteTicketIds(),
        note: action.note,
        dedupe: params.dedupeNotes,
        result,
        beforeCheck: stagedResolveResumeHasCheckedNote(params.resumeStage) ? undefined : params.beforeNoteCheck,
      });
      markWorkflowStage(result, "NoteDedupeChecked");
    } catch (error) {
      if (error instanceof DurableCheckpointError || isExecutionStopError(error)) throw error;
      return markStagedFailure({
        result,
        stage: "noteCheck",
        reason: safeErrorMessage(error),
        terminalReason: "NoteCheckFailed",
        partialWrite: result.writeAttempted,
        writeMayHaveSucceeded: result.writeMayHaveSucceeded,
      });
    }
    if (notePlan === "deduped" && (params.noteVisibilityPriorAttempts ?? 0) > 0) {
      markStagedNoteVerifiedAfterDelay(result, (params.noteVisibilityPriorAttempts ?? 0) + 1);
    }
    if (notePlan === "pending" && stagedResolveResumeAtOrPastNoteWrite(params.resumeStage)) {
      const attempts = (params.noteVisibilityPriorAttempts ?? 0) + 1;
      result.writeAttempted = true;
      result.writeMayHaveSucceeded = true;
      result.partialWrite = true;
      if (attempts >= STAGED_NOTE_VISIBILITY_MAX_ATTEMPTS) {
        return markStagedNoteVisibilityUnresolved({ result, attempts });
      }
      return markStagedNoteVisibilityPending({
        result,
        stage: params.resumeStage === "NoteWriteStarted" ? "NoteWriteStarted" : "NoteAdded",
        attempts,
      });
    }
    if (notePlan === "pending") {
      result.writeMethod = "staged";
      try {
        await params.beforeMutation?.("note");
        result.writeAttempted = true;
        const created = await createTicketNote(client, params.resolvedTicketId, noteBodyForPlan(action.note) as string, false);
        result.noteAdded = true;
        result.writeMayHaveSucceeded = true;
        result.noteWriteOutcome = "Accepted";
        recordPhysicalWrite(result, "createTicketNote", "Accepted");
        await params.afterMutation?.("note", { ticketId: params.resolvedTicketId, noteId: created.noteId });
      } catch (error) {
        if (error instanceof DurableCheckpointError || isExecutionStopError(error)) throw error;
        const rejected = isReliableSynchronousMutationRejection(error);
        recordPhysicalWrite(result, "createTicketNote", rejected ? "Rejected" : "Ambiguous");
        result.writeMayHaveSucceeded = !rejected;
        const fingerprint = action.noteFingerprint ?? normalizedNoteFingerprint(action.note);
        let observed = false;
        try {
          observed = await existingNoteMatchesFingerprint(client, trustedTicket.ticketId, fingerprint, {
            ticketNumber: params.ticketNumber,
            additionalTicketIds: stagedNoteTicketIds(),
          });
          result.noteDedupeChecked = true;
        } catch {
          observed = false;
        }
        if (!observed) {
          return markStagedFailure({
            result,
            stage: "createTicketNote",
            reason: rejected
              ? "Private note creation was rejected: " + safeErrorMessage(error)
              : "Private note creation is ambiguous and was not observed; status resolution was not attempted.",
            terminalReason: rejected ? "NoteCreationRejected" : "AmbiguousNoteCreationUnresolved",
            partialWrite: !rejected,
            writeMayHaveSucceeded: !rejected,
            verificationState: rejected ? "Failed" : "Pending",
          });
        }
        result.noteDeduped = true;
      }
    }
    const fingerprint = action.noteFingerprint ?? normalizedNoteFingerprint(action.note);
    const noteVerified = await existingNoteMatchesFingerprint(client, trustedTicket.ticketId, fingerprint, {
      ticketNumber: params.ticketNumber,
      additionalTicketIds: stagedNoteTicketIds(),
    });
    result.noteDedupeChecked = true;
    result.initialNoteVerificationObserved ??= noteVerified;
    result.noteVerificationAttempts = (params.noteVisibilityPriorAttempts ?? 0) + 1;
    if (!noteVerified) {
      const attempts = result.noteVerificationAttempts;
      if (attempts >= STAGED_NOTE_VISIBILITY_MAX_ATTEMPTS) {
        return markStagedNoteVisibilityUnresolved({ result, attempts });
      }
      return markStagedNoteVisibilityPending({
        result,
        stage: "NoteAdded",
        attempts,
        initialObserved: false,
      });
    }
    if ((params.noteVisibilityPriorAttempts ?? 0) > 0 || result.initialNoteVerificationObserved === false) {
      markStagedNoteVerifiedAfterDelay(result, result.noteVerificationAttempts ?? 1);
    } else {
      result.noteWriteOutcome ??= result.noteAdded ? "AcceptedAndVerified" : "VerifiedExistingPrivateNote";
      result.noteVerifiedAfterDelay = false;
      result.continuationRequired = false;
    }
    markWorkflowStage(result, "NoteVerified");
    if (!stagedResolveResumeHasVerifiedNote(params.resumeStage)) {
      await params.afterVerification?.("note");
    }
  }

  let preStatusTicket: Ticket;
  if (compareTicketValue(DEFAULT_RESOLVE_TICKET_STATUS, ticketVerificationValue(trustedTicket, "status"))) {
    preStatusTicket = trustedTicket;
  } else {
    try {
      preStatusTicket = await getTicketByInternalId(client, params.resolvedTicketId);
    } catch (error) {
      if (isExecutionStopError(error)) throw error;
      return markStagedFailure({
        result,
        stage: "concurrencyRecheck",
        reason: safeErrorMessage(error),
        terminalReason: "ConcurrencyRecheckUnavailable",
        partialWrite: result.writeAttempted,
        writeMayHaveSucceeded: result.writeMayHaveSucceeded,
        verificationState: "Pending",
      });
    }
  }
  const preStatusVerification = verifyFinalTargetState(classificationAction, preStatusTicket);
  if (preStatusVerification.mismatches.length > 0) {
    return markStagedFailure({
      result,
      stage: "concurrencyRecheck",
      reason: `Previously verified classification/client fields changed before status close: ${JSON.stringify(preStatusVerification.mismatches)}`,
      terminalReason: "ConcurrentModificationDetected",
      partialWrite: result.writeAttempted,
      writeMayHaveSucceeded: result.writeMayHaveSucceeded,
    });
  }
  if (preStatusTicket.status !== trustedTicket.status && params.resumeStage !== "StatusWriteStarted" && params.resumeStage !== "StatusWriteSucceeded") {
    return markStagedFailure({
      result,
      stage: "concurrencyRecheck",
      reason: `Ticket status changed before staged close: expected ${trustedTicket.status ?? "unknown"}, got ${preStatusTicket.status ?? "unknown"}.`,
      terminalReason: "ConcurrentModificationDetected",
      partialWrite: result.writeAttempted,
      writeMayHaveSucceeded: result.writeMayHaveSucceeded,
    });
  }
  const statusWriteMayAlreadyHaveRun = params.resumeStage === "StatusWriteStarted" ||
    params.resumeStage === "StatusWriteSucceeded" ||
    params.resumeStage === "StatusVerified";
  const unexpectedPreStatusChanges = stagedTicketStateChanges(trustedTicket, preStatusTicket)
    .filter((change) => !(statusWriteMayAlreadyHaveRun && change.field === "status"));
  if (unexpectedPreStatusChanges.length > 0) {
    return markStagedFailure({
      result,
      stage: "concurrencyRecheck",
      reason: `Ticket state changed unexpectedly before staged close: ${JSON.stringify(unexpectedPreStatusChanges)}`,
      terminalReason: "ConcurrentModificationDetected",
      partialWrite: result.writeAttempted,
      writeMayHaveSucceeded: result.writeMayHaveSucceeded,
    });
  }
  trustedTicket = preStatusTicket;

  const statusInput = buildStagedResolveStatusInput(params.resolvedTicketId, action.target?.status);
  const statusInputError = (statusInput as { error?: unknown }).error;
  if (typeof statusInputError === "string") {
    return markStagedFailure({
      result,
      stage: "statusCloseValidation",
      reason: statusInputError,
      terminalReason: "NotificationSuppressionUnproven",
      partialWrite: result.writeAttempted,
      writeMayHaveSucceeded: result.writeMayHaveSucceeded,
    });
  }
  result.statusWriteMethod = "updateTicket.statusOnly";
  result.statusWriteOutcome = "Pending";
  result.suppressCloseNotificationIncluded = (statusInput as Record<string, unknown>).suppressCloseNotification === true;
  if (!result.suppressCloseNotificationIncluded) {
    return markStagedFailure({
      result,
      stage: "statusCloseValidation",
      reason: "Status-only close input did not include suppressCloseNotification=true.",
      terminalReason: "NotificationSuppressionUnproven",
      partialWrite: result.writeAttempted,
      writeMayHaveSucceeded: result.writeMayHaveSucceeded,
    });
  }

  const statusAlreadyResolved = compareTicketValue(DEFAULT_RESOLVE_TICKET_STATUS, ticketVerificationValue(trustedTicket, "status"));
  if (statusAlreadyResolved) {
    result.statusWriteOutcome = "NotRequired";
  }
  if (!statusAlreadyResolved && params.resumeStage !== "StatusWriteStarted" && params.resumeStage !== "StatusWriteSucceeded" && params.resumeStage !== "StatusVerified") {
    try {
      await params.beforeMutation?.("status");
      result.writeAttempted = true;
      const mutationResult = await mutateTicketUpdate(client, statusInput as Record<string, unknown>);
      result.writeMayHaveSucceeded = true;
      result.statusWriteOutcome = "Accepted";
      recordPhysicalWrite(result, "updateTicket.statusOnly", "Accepted");
      await params.afterMutation?.("status", { ticketId: mutationResult.ticketId });
    } catch (error) {
      if (error instanceof DurableCheckpointError || isExecutionStopError(error)) throw error;
      const rejected = isReliableSynchronousMutationRejection(error);
      result.statusWriteOutcome = rejected ? "Rejected" : "Ambiguous";
      result.primaryWriteMethod = "updateTicket.statusOnly";
      result.primaryWriteOutcome = result.statusWriteOutcome;
      applyPrimaryFailureDiagnostics(result, error);
      recordPhysicalWrite(result, "updateTicket.statusOnly", result.statusWriteOutcome);
      result.writeMayHaveSucceeded = !rejected;
      let statusReread: Ticket;
      try {
        statusReread = await getTicketByInternalId(client, params.resolvedTicketId);
      } catch (verifyError) {
        return markStagedFailure({
          result,
          stage: "statusCloseVerification",
          reason: "Status close response could not be reconciled: " + safeErrorMessage(verifyError),
          terminalReason: rejected ? "StatusCloseSuppressionRejected" : "AmbiguousStatusCloseUnresolved",
          partialWrite: !rejected,
          writeMayHaveSucceeded: !rejected,
          verificationState: "Pending",
        });
      }
      trustedTicket = statusReread;
      result.finalState = ticketFinalState(trustedTicket);
      result.observedFinalState = result.finalState;
      if (!compareTicketValue(DEFAULT_RESOLVE_TICKET_STATUS, ticketVerificationValue(trustedTicket, "status"))) {
        return markStagedFailure({
          result,
          stage: "statusCloseVerification",
          reason: rejected
            ? "Status-only close with suppressCloseNotification=true was rejected."
            : "Ambiguous status-only close was not observed; it will not be retried automatically.",
          terminalReason: rejected ? "StatusCloseSuppressionRejected" : "AmbiguousStatusCloseUnresolved",
          partialWrite: !rejected,
          writeMayHaveSucceeded: !rejected,
          verificationState: rejected ? "Failed" : "Pending",
        });
      }
    }
  }

  const finalTicket = statusAlreadyResolved
    ? trustedTicket
    : await getTicketByInternalId(client, params.resolvedTicketId);
  const finalVerification = verifyFinalTargetState(finalAction, finalTicket);
  result.finalState = ticketFinalState(finalTicket);
  result.observedFinalState = result.finalState;
  result.statusObserved = finalTicket.status ?? null;
  if (finalVerification.mismatches.length > 0) {
    return markStagedFailure({
      result,
      stage: "finalVerification",
      reason: `Final staged resolve verification mismatched requested fields: ${JSON.stringify(finalVerification.mismatches)}`,
      terminalReason: "FinalVerificationMismatch",
      partialWrite: result.writeAttempted,
      writeMayHaveSucceeded: result.writeMayHaveSucceeded,
    });
  }
  if (noteExpectedForAction(action)) {
    const noteVerified = await existingNoteMatchesFingerprint(
      client,
      finalTicket.ticketId,
      action.noteFingerprint ?? normalizedNoteFingerprint(action.note),
      {
        ticketNumber: params.ticketNumber,
        additionalTicketIds: [params.resolvedTicketId, params.ticket.ticketId, finalTicket.ticketId],
      }
    );
    result.noteDedupeChecked = true;
    if (!noteVerified) {
      return markStagedFailure({
        result,
        stage: "finalVerification",
        reason: "Approved private note was not observed during final staged verification.",
        terminalReason: "FinalVerificationMismatch",
        partialWrite: result.writeAttempted,
        writeMayHaveSucceeded: result.writeMayHaveSucceeded,
      });
    }
  }
  result.finalOutcome = "Resolved";
  result.verified = true;
  result.verifiedState = result.finalState;
  result.finalVerificationState = "Verified";
  result.partialWrite = false;
  result.failureStage = null;
  result.failureReason = null;
  result.terminalReason = null;
  result.statusWriteOutcome = result.statusWriteOutcome === "Pending" ? "Verified" : result.statusWriteOutcome;
  markWorkflowStage(result, "StatusVerified");
  if (params.resumeStage !== "StatusVerified") {
    await params.afterVerification?.("status");
  }
  return result;
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

function safeGraphQLErrorExtensions(extensions: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!extensions) return null;
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extensions).slice(0, 20)) {
    const lowered = key.toLowerCase();
    if (/token|auth|secret|header|cookie|email|stack|trace|body|request|response/.test(lowered)) continue;
    if (typeof value === "string") safe[key] = safeErrorMessage(value).slice(0, 120);
    else if (typeof value === "number" || typeof value === "boolean" || value === null) safe[key] = value;
    else if (Array.isArray(value)) safe[key] = "[array]";
    else if (typeof value === "object") safe[key] = "[object]";
  }
  return Object.keys(safe).length > 0 ? safe : null;
}

function mutationFailureDiagnostics(error: unknown): Record<string, unknown> {
  const diagnostics: Record<string, unknown> = {
    classification: "UnknownMutationFailure",
    httpStatus: null,
    graphQLDataPresent: "unknown",
    graphQLErrorMessageCategory: "Unknown",
    graphQLErrorCode: null,
    graphQLErrorClassification: null,
    graphQLErrorPath: null,
    graphQLErrorExtensions: null,
    timeout: false,
    transportError: false,
    partialMutationDataReturned: "unknown",
    reliableSynchronousRejection: isReliableSynchronousMutationRejection(error),
    synchronousFailure: isSynchronousMutationFailure(error),
    retrySafe: false,
  };
  if (error instanceof SuperOpsHttpError) {
    diagnostics.classification = "HttpError";
    diagnostics.httpStatus = error.status;
    diagnostics.httpStatusText = safeErrorMessage(error.statusText);
    diagnostics.retryAfterSupplied = error.retryAfter !== undefined;
    diagnostics.retrySafe = false;
  } else if (error instanceof SuperOpsError) {
    diagnostics.classification = "GraphQLError";
    diagnostics.httpStatus = error.httpStatus ?? 200;
    diagnostics.graphQLDataPresent = error.graphQLDataPresent ?? "unknown";
    diagnostics.partialMutationDataReturned = error.mutationPayloadReturned ?? "unknown";
    diagnostics.graphQLErrorCode = error.code ?? null;
    diagnostics.graphQLErrorClassification = graphqlErrorClassification(error);
    diagnostics.graphQLErrorMessageCategory = graphqlErrorMessageCategory(error);
    diagnostics.graphQLErrorPath = safeGraphQLPath(error.graphQLPath);
    diagnostics.graphQLErrorExtensions = safeGraphQLErrorExtensions(error.extensions);
    diagnostics.retryAfterSupplied = error.retryAfter !== undefined;
    diagnostics.retrySafe = false;
  } else if (error instanceof Error && error.name === "SuperOpsTimeoutError") {
    diagnostics.classification = "Timeout";
    diagnostics.timeout = true;
    diagnostics.transportError = true;
    diagnostics.retrySafe = false;
  } else if (error instanceof Error && error.name === "SuperOpsNetworkError") {
    diagnostics.classification = "TransportError";
    diagnostics.transportError = true;
    diagnostics.retrySafe = false;
  } else if (error instanceof Error) {
    diagnostics.classification = error.name || "Error";
  }
  return diagnostics;
}

function safeGraphQLPath(path: Array<string | number> | undefined): Array<string | number> | null {
  if (!Array.isArray(path)) return null;
  return path
    .slice(0, 10)
    .filter((part): part is string | number => typeof part === "string" || typeof part === "number");
}

function graphqlErrorClassification(error: SuperOpsError): string | null {
  const value = error.extensions?.classification;
  return typeof value === "string" ? safeErrorMessage(value).slice(0, 80) : null;
}

function graphqlErrorMessageCategory(error: SuperOpsError): string {
  const classification = graphqlErrorClassification(error);
  if (classification) return classification;
  const code = error.code;
  if (code) return safeErrorMessage(code).slice(0, 80);
  if (/internal server error/i.test(error.message)) return "InternalServerError";
  if (/validation/i.test(error.message)) return "ValidationError";
  return "GraphQLError";
}

function isSynchronousMutationFailure(error: unknown): boolean {
  return error instanceof SuperOpsHttpError || error instanceof SuperOpsError;
}

function graphQLMutationPayloadReturned(error: unknown): boolean | null {
  if (error instanceof SuperOpsError && typeof error.mutationPayloadReturned === "boolean") {
    return error.mutationPayloadReturned;
  }
  return null;
}

function responseHadGraphQLData(error: unknown): boolean | null {
  if (error instanceof SuperOpsError && typeof error.graphQLDataPresent === "boolean") {
    return error.graphQLDataPresent;
  }
  return null;
}
function requestedResolveStatus(action: TriagePlanAction): string | undefined {
  if (action.action !== "resolve") return action.target?.status;
  return action.target?.status ?? DEFAULT_RESOLVE_TICKET_STATUS;
}

const RESOLVE_PARTIAL_OBSERVED_FIELDS = [
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
] as const;

function observedRequestedNonStatusFields(
  action: TriagePlanAction,
  ticket: Ticket
): Record<string, unknown> {
  const target = action.target ?? {};
  const observed: Record<string, unknown> = {};
  for (const field of RESOLVE_PARTIAL_OBSERVED_FIELDS) {
    if (target[field] === undefined) continue;
    const verificationField = field === "techGroupName" ? "techGroup" : field;
    observed[field] = ticketVerificationValue(ticket, verificationField);
  }
  return observed;
}

function resolveStatusAnalysis(action: TriagePlanAction, ticket: Ticket): {
  complete: boolean;
  statusMissing: boolean;
  statusTarget?: string;
  statusObserved: string | null;
  nonStatusMismatches: { field: string; expected: unknown; actual: unknown }[];
  partialFieldsObserved: Record<string, unknown>;
} {
  const verification = verifyFinalTargetState(action, ticket);
  const statusTarget = requestedResolveStatus(action);
  const statusObservedValue = ticketVerificationValue(ticket, "status");
  const statusObserved = typeof statusObservedValue === "string" ? statusObservedValue : null;
  const statusMismatch = statusTarget !== undefined && !compareTicketValue(statusTarget, statusObservedValue);
  const nonStatusMismatches = verification.mismatches.filter((mismatch) => mismatch.field !== "status");
  return {
    complete: verification.mismatches.length === 0,
    statusMissing: statusMismatch && nonStatusMismatches.length === 0,
    statusTarget,
    statusObserved,
    nonStatusMismatches,
    partialFieldsObserved: observedRequestedNonStatusFields(action, ticket),
  };
}

function targetVerificationField(field: string): string {
  return field === "techGroupName" ? "techGroup" : field;
}

const RESOLVE_READBACK_TARGET_FIELDS = [
  "status",
  "impact",
  "urgency",
  "category",
  "subcategory",
  "cause",
  "resolutionCode",
  "techGroupName",
  "clientName",
  "clientId",
] as const;

type ResolveReadbackTargetField = (typeof RESOLVE_READBACK_TARGET_FIELDS)[number];

function requestedReadbackFields(action: TriagePlanAction): ResolveReadbackTargetField[] {
  const target = action.target ?? {};
  return RESOLVE_READBACK_TARGET_FIELDS.filter((field) => target[field] !== undefined);
}

function requestedFieldsMatchingTarget(action: TriagePlanAction, ticket: Ticket): string[] {
  const target = action.target ?? {};
  return requestedReadbackFields(action).filter((field) => {
    const expected = field === "clientName" ? canonicalClientName(String(target[field])) : target[field];
    return compareTicketValue(expected, ticketVerificationValue(ticket, targetVerificationField(field)));
  });
}

function requestedFieldsChangedAfterWrite(
  action: TriagePlanAction,
  before: Ticket,
  after: Ticket
): string[] {
  return requestedReadbackFields(action).filter((field) => {
    const verificationField = targetVerificationField(field);
    return !compareTicketValue(
      ticketVerificationValue(before, verificationField),
      ticketVerificationValue(after, verificationField)
    );
  });
}

function updatedTimeChanged(before: Ticket, after: Ticket): boolean | null {
  if (!before.updatedTime || !after.updatedTime) return null;
  return before.updatedTime !== after.updatedTime;
}

function applyPrimaryFailureDiagnostics(
  result: ApplyTriagePlanResult,
  error: unknown
): void {
  const diagnostics = mutationFailureDiagnostics(error);
  result.primaryFailureDiagnostics = diagnostics;
  result.primaryGraphqlClassification = typeof diagnostics.graphQLErrorClassification === "string"
    ? diagnostics.graphQLErrorClassification
    : null;
  result.primaryGraphqlCode = typeof diagnostics.graphQLErrorCode === "string"
    ? diagnostics.graphQLErrorCode
    : null;
  result.primaryGraphqlPath = Array.isArray(diagnostics.graphQLErrorPath)
    ? diagnostics.graphQLErrorPath as Array<string | number>
    : null;
  result.primaryResponseHadData = typeof diagnostics.graphQLDataPresent === "boolean"
    ? diagnostics.graphQLDataPresent
    : responseHadGraphQLData(error);
  result.primarySynchronousFailure = diagnostics.synchronousFailure === true;
  result.retrySafe = diagnostics.retrySafe === true;
}

function primaryFailureReturnedNoMutationPayload(error: unknown): boolean {
  const payloadReturned = graphQLMutationPayloadReturned(error);
  return payloadReturned === false || payloadReturned === null;
}

function noChangeOutcomeForPrimaryFailure(error: unknown): "RejectedOrNoChange" | "AmbiguousNoChangeObserved" {
  return isReliableSynchronousMutationRejection(error)
    ? "RejectedOrNoChange"
    : "AmbiguousNoChangeObserved";
}

function markNoChangeObserved(params: {
  result: ApplyTriagePlanResult;
  error: unknown;
  originalTicket: Ticket;
  reread: Ticket;
  action: TriagePlanAction;
}): boolean {
  if (!isSynchronousMutationFailure(params.error) || !primaryFailureReturnedNoMutationPayload(params.error)) {
    return false;
  }

  const changedFields = requestedFieldsChangedAfterWrite(
    params.action,
    params.originalTicket,
    params.reread
  );
  const didUpdatedTimeChange = updatedTimeChanged(params.originalTicket, params.reread);
  const observedFields = requestedFieldsMatchingTarget(params.action, params.reread);
  const noChange = didUpdatedTimeChange === false && changedFields.length === 0 && observedFields.length === 0;
  params.result.updatedTimeChanged = didUpdatedTimeChange;
  params.result.requestedFieldsObserved = observedFields;
  params.result.noChangeObserved = noChange;
  if (!noChange) return false;

  const outcome = noChangeOutcomeForPrimaryFailure(params.error);
  params.result.finalOutcome = outcome;
  params.result.failureStage = "resolve_full";
  params.result.failureReason = outcome === "RejectedOrNoChange"
    ? "Synchronous mutation rejection returned no mutation data; verification read observed unchanged updatedTime and no requested field changes."
    : "Synchronous GraphQL failure returned no mutation data; verification read observed unchanged updatedTime and no requested field changes.";
  params.result.partialWrite = false;
  params.result.writeMayHaveSucceeded = false;
  params.result.verified = false;
  params.result.finalVerificationState = "Failed";
  params.result.terminalReason = outcome;
  params.result.fallbackEligible = false;
  params.result.fallbackAttempted = false;
  params.result.fallbackResult = "No status-only fallback attempted because the primary write produced no observed change.";
  return true;
}
function fallbackIdentityFailure(
  ticketNumber: string,
  action: TriagePlanAction,
  ticket: Ticket
): string | undefined {
  if (ticket.displayId && ticket.displayId !== ticketNumber) {
    return `Expected display number ${ticketNumber}, got ${ticket.displayId}.`;
  }
  if (action.expectedTicketId && ticket.ticketId !== action.expectedTicketId) {
    return `Expected ticketId ${action.expectedTicketId}, got ${ticket.ticketId}.`;
  }
  if (
    (action.expectedSubject && ticket.subject !== action.expectedSubject) ||
    (action.expectedSubjectHash && stableHash(ticket.subject) !== action.expectedSubjectHash)
  ) {
    return "Ticket subject no longer matches the approved snapshot identity.";
  }
  if (action.expectedStatus && ticket.status !== action.expectedStatus) {
    return `Ticket status changed unexpectedly before fallback: expected ${action.expectedStatus}, got ${ticket.status}.`;
  }
  return undefined;
}

function statusOnlyFallbackEligibility(params: {
  ticketNumber: string;
  action: TriagePlanAction;
  ticket: Ticket;
  analysis: ReturnType<typeof resolveStatusAnalysis>;
  fallbackAllowed: boolean;
  allowWriteWithoutVerifiedContent: boolean;
}): { eligible: boolean; reason: string } {
  if (!params.fallbackAllowed) return { eligible: false, reason: "allowResolveFullFallbackToUpdate is false." };
  if (params.action.contentVerified !== true && !params.allowWriteWithoutVerifiedContent) {
    return { eligible: false, reason: "Ticket content is no longer verified for fallback." };
  }
  if (!params.analysis.statusMissing || !params.analysis.statusTarget) {
    return { eligible: false, reason: "Latest verification did not show only a missing resolve status." };
  }
  if (params.analysis.nonStatusMismatches.length > 0) {
    return { eligible: false, reason: "Requested client or classification fields differ from the latest ticket state." };
  }
  if (!params.ticket.updatedTime) {
    return { eligible: false, reason: "Latest updatedTime is unavailable; fallback safety cannot be established." };
  }
  const identityFailure = fallbackIdentityFailure(params.ticketNumber, params.action, params.ticket);
  if (identityFailure) return { eligible: false, reason: identityFailure };
  return { eligible: true, reason: "Status-only updateTicket fallback is eligible." };
}

function buildStatusOnlyFallbackInput(
  ticketId: string,
  status: string | undefined
): Record<string, unknown> | { error: string } {
  if (!status) return { error: "Resolve target status is unavailable for status-only fallback." };
  if (invalidValues([status], VALID_TICKET_STATUSES).length > 0) {
    return { error: `Invalid ticket status: ${status}` };
  }
  return { ticketId, status };
}

function recordPhysicalWrite(
  result: ApplyTriagePlanResult,
  method: string,
  outcome: string
): void {
  result.physicalWrites = [...(result.physicalWrites ?? []), { method, outcome }];
}

function markPartialResolveStatusMissing(params: {
  result: ApplyTriagePlanResult;
  analysis: ReturnType<typeof resolveStatusAnalysis>;
  fallbackReason: string;
}): void {
  const { result, analysis, fallbackReason } = params;
  result.finalOutcome = "PartialResolveStatusMissing";
  result.failureStage = "partialResolveStatusMissing";
  result.failureReason = `Resolve write applied requested non-status fields, but status remained ${analysis.statusObserved ?? "unknown"} instead of ${analysis.statusTarget ?? "unknown"}. ${fallbackReason}`;
  result.partialWrite = true;
  result.writeMayHaveSucceeded = true;
  result.verified = false;
  result.finalVerificationState = "Failed";
  result.terminalReason = "PartialResolveStatusMissing";
  result.primaryWriteOutcome ??= "Ambiguous";
}

async function reconcileAmbiguousResolveWrite(params: {
  client: SuperOpsClientInstance;
  ticketNumber: string;
  action: TriagePlanAction;
  originalTicket: Ticket;
  result: ApplyTriagePlanResult;
  notePlan: "none" | "deduped" | "pending";
  fallbackAllowed: boolean;
  allowWriteWithoutVerifiedContent: boolean;
  primaryError: unknown;
  beforeMutation?: (mutationType: DurableMutationType) => Promise<void>;
  afterMutation?: (
    mutationType: DurableMutationType,
    observed: { ticketId?: string; noteId?: string }
  ) => Promise<void>;
  afterVerification?: (mutationType: "update" | "classification" | "resolution" | "status" | "note") => Promise<void>;
}): Promise<ApplyTriagePlanResult> {
  const { client, ticketNumber, action, originalTicket, result } = params;
  result.writeMethod = "resolve_full";
  result.primaryWriteMethod = "updateTicket.resolve_full";
  result.primaryWriteOutcome = isReliableSynchronousMutationRejection(params.primaryError) ? "Rejected" : "Ambiguous";
  applyPrimaryFailureDiagnostics(result, params.primaryError);
  result.failureStage = "resolve_full";
  result.failureReason = safeErrorMessage(params.primaryError);
  result.writeAttempted = true;
  result.writeMayHaveSucceeded = true;
  result.partialWrite = true;
  result.finalVerificationState = "Pending";
  recordPhysicalWrite(result, "updateTicket.resolve_full", result.primaryWriteOutcome);

  let reread: Ticket;
  try {
    reread = await getTicketByInternalId(client, originalTicket.ticketId);
  } catch (rereadError) {
    result.finalOutcome = "Failed";
    result.failureStage = "ambiguousWrite";
    result.failureReason = "Ambiguous resolution response could not be reconciled: " +
      safeErrorMessage(rereadError);
    result.fallbackEligible = false;
    result.fallbackAttempted = false;
    result.fallbackResult = "Ambiguous resolution response remains unresolved; fallback was not attempted.";
    result.finalVerificationState = "Pending";
    result.terminalReason = "AmbiguousWriteUnresolved";
    return result;
  }

  const analysis = resolveStatusAnalysis(action, reread);
  result.finalState = ticketFinalState(reread);
  result.observedFinalState = result.finalState;
  result.partialFieldsObserved = analysis.partialFieldsObserved;
  result.statusObserved = analysis.statusObserved;
  result.updatedTimeChanged = updatedTimeChanged(originalTicket, reread);
  result.requestedFieldsObserved = requestedFieldsMatchingTarget(action, reread);
  if (markNoChangeObserved({
    result,
    error: params.primaryError,
    originalTicket,
    reread,
    action,
  })) {
    return result;
  }

  if (analysis.complete) {
    result.finalOutcome = "Resolved";
    result.failureStage = null;
    result.failureReason = null;
    result.partialWrite = false;
    result.writeMayHaveSucceeded = true;
    result.verifiedState = result.finalState;
    result.verified = true;
    result.finalVerificationState = "Verified";
    result.terminalReason = null;
    result.fallbackEligible = false;
    result.fallbackAttempted = false;
    result.fallbackResult = "Not required; intended resolution is already visible.";
    await params.afterVerification?.("resolution");
    try {
      if (params.notePlan === "pending") {
        await createNoteForPlan({
          client,
          ticketId: originalTicket.ticketId,
          note: action.note,
          isPublic: false,
          result,
          beforeCreate: async () => {
            await (params.beforeMutation?.("note") ?? Promise.resolve());
            result.writeAttempted = true;
          },
          afterCreate: (note) => params.afterMutation?.("note", {
            ticketId: originalTicket.ticketId,
            noteId: note.noteId,
          }) ?? Promise.resolve(),
        });
      }
    } catch (noteError) {
      if (noteError instanceof DurableCheckpointError || isExecutionStopError(noteError)) throw noteError;
      result.finalOutcome = "Failed";
      result.failureStage = "createTicketNote";
      result.failureReason = safeErrorMessage(noteError);
      result.partialWrite = true;
      result.finalVerificationState = "Failed";
      result.terminalReason = "CreateTicketNoteFailedAfterVerifiedResolve";
      return result;
    }
    return result;
  }

  const eligibility = statusOnlyFallbackEligibility({
    ticketNumber,
    action,
    ticket: reread,
    analysis,
    fallbackAllowed: params.fallbackAllowed,
    allowWriteWithoutVerifiedContent: params.allowWriteWithoutVerifiedContent,
  });
  result.fallbackEligible = eligibility.eligible;

  if (!analysis.statusMissing) {
    result.finalOutcome = "Failed";
    result.failureStage = "ambiguousWrite";
    result.failureReason = analysis.nonStatusMismatches.length > 0
      ? `Ambiguous resolution response left requested non-status fields mismatched: ${JSON.stringify(analysis.nonStatusMismatches)}`
      : "Ambiguous resolution response was not observed, but non-acceptance was not conclusively proven.";
    result.fallbackAttempted = false;
    result.fallbackResult = `Fallback was not attempted: ${eligibility.reason}`;
    result.finalVerificationState = "Pending";
    result.terminalReason = "AmbiguousWriteUnresolved";
    return result;
  }

  if (!eligibility.eligible) {
    result.fallbackAttempted = false;
    result.fallbackResult = `Status-only fallback not attempted: ${eligibility.reason}`;
    markPartialResolveStatusMissing({ result, analysis, fallbackReason: result.fallbackResult });
    return result;
  }

  const fallbackInput = buildStatusOnlyFallbackInput(originalTicket.ticketId, analysis.statusTarget);
  const fallbackInputError = (fallbackInput as { error?: unknown }).error;
  if (typeof fallbackInputError === "string") {
    result.fallbackAttempted = false;
    result.fallbackEligible = false;
    result.fallbackResult = `Status-only fallback not attempted: ${fallbackInputError}`;
    markPartialResolveStatusMissing({ result, analysis, fallbackReason: result.fallbackResult });
    return result;
  }

  result.fallbackAttempted = true;
  result.fallbackWriteMethod = "updateTicket.statusOnly";
  result.fallbackOutcome = "PendingVerification";
  result.fallbackResult = "Status-only fallback attempted with latest verified ticket state.";
  try {
    await params.beforeMutation?.("resolveFallback");
    const fallbackMutation = await mutateTicketUpdate(client, fallbackInput as Record<string, unknown>);
    await params.afterMutation?.("resolveFallback", { ticketId: fallbackMutation.ticketId });
    result.fallbackOutcome = "Accepted";
    recordPhysicalWrite(result, "updateTicket.statusOnly", "Accepted");
  } catch (fallbackError) {
    if (fallbackError instanceof DurableCheckpointError || isExecutionStopError(fallbackError)) throw fallbackError;
    result.fallbackOutcome = isReliableSynchronousMutationRejection(fallbackError) ? "Rejected" : "Ambiguous";
    result.fallbackResult = "Status-only fallback response requires verification: " + safeErrorMessage(fallbackError);
    recordPhysicalWrite(result, "updateTicket.statusOnly", result.fallbackOutcome);
  }

  let verifiedFallback: Ticket;
  try {
    verifiedFallback = await getTicketByInternalId(client, originalTicket.ticketId);
  } catch (verifyError) {
    result.finalOutcome = "Failed";
    result.failureStage = "statusOnlyFallbackVerify";
    result.failureReason = "Status-only fallback verification failed: " + safeErrorMessage(verifyError);
    result.partialWrite = true;
    result.verified = false;
    result.finalVerificationState = "Failed";
    result.terminalReason = "StatusOnlyFallbackVerificationUnavailable";
    return result;
  }

  const fallbackAnalysis = resolveStatusAnalysis(action, verifiedFallback);
  result.finalState = ticketFinalState(verifiedFallback);
  result.observedFinalState = result.finalState;
  result.partialFieldsObserved = fallbackAnalysis.partialFieldsObserved;
  result.statusObserved = fallbackAnalysis.statusObserved;
  if (fallbackAnalysis.complete) {
    result.finalOutcome = "Resolved";
    result.failureStage = null;
    result.failureReason = null;
    result.partialWrite = false;
    result.writeMayHaveSucceeded = true;
    result.verified = true;
    result.verifiedState = result.finalState;
    result.finalVerificationState = "Verified";
    result.terminalReason = null;
    result.fallbackOutcome = result.fallbackOutcome === "Ambiguous"
      ? "VerifiedAppliedAfterAmbiguous"
      : "VerifiedApplied";
    result.fallbackResult = "Updated";
    await params.afterVerification?.("resolution");
    return result;
  }

  result.finalOutcome = "Failed";
  result.failureStage = "statusOnlyFallbackVerify";
  result.failureReason = `Status-only fallback failed closed; final state mismatches requested target: ${JSON.stringify(verifyFinalTargetState(action, verifiedFallback).mismatches)}`;
  result.partialWrite = true;
  result.writeMayHaveSucceeded = true;
  result.verified = false;
  result.finalVerificationState = "Failed";
  result.terminalReason = "StatusOnlyFallbackVerificationMismatch";
  return result;
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
    case "RejectedOrNoChange":
    case "AmbiguousNoChangeObserved":
      return "AmbiguousWriteUnresolved";
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

function compactApplyResult(
  result: ApplyTriagePlanResult,
  options: { trimVerifiedSuccessDetails?: boolean } = {}
): Record<string, unknown> {
  const trimmedVerifiedSuccess = options.trimVerifiedSuccessDetails === true &&
    ["Resolved", "Updated", "Left"].includes(result.finalOutcome) &&
    result.verified === true &&
    result.partialWrite !== true;
  return {
    ticketNumber: result.ticketNumber,
    ticketId: result.ticketId,
    requestedAction: result.requestedAction,
    finalOutcome: result.finalOutcome,
    writeAttempted: result.writeAttempted,
    writeMayHaveSucceeded: result.writeAttempted && (result.writeMayHaveSucceeded === false || result.partialWrite || !["Resolved", "Updated"].includes(result.finalOutcome))
      ? result.writeMayHaveSucceeded
      : undefined,
    writeMethod: result.writeMethod,
    noteAdded: result.noteAdded,
    noteDeduped: result.noteDeduped,
    notePlanned: result.notePlanned,
    noteDedupePlanned: result.noteDedupePlanned,
    noteDedupeChecked: result.noteDedupeChecked,
    noteWriteOutcome: result.noteWriteOutcome,
    initialNoteVerificationObserved: result.initialNoteVerificationObserved,
    noteVerificationAttempts: result.noteVerificationAttempts,
    noteVerifiedAfterDelay: result.noteVerifiedAfterDelay,
    continuationRequired: result.continuationRequired,
    plannedMutations: trimmedVerifiedSuccess ? undefined : result.plannedMutations,
    workflowMode: result.workflowMode,
    completedStages: trimmedVerifiedSuccess ? undefined : result.completedStages,
    currentStage: trimmedVerifiedSuccess ? undefined : result.currentStage,
    classificationWriteMethod: trimmedVerifiedSuccess ? undefined : result.classificationWriteMethod,
    classificationWriteOutcome: trimmedVerifiedSuccess ? undefined : result.classificationWriteOutcome,
    statusWriteMethod: trimmedVerifiedSuccess ? undefined : result.statusWriteMethod,
    statusWriteOutcome: trimmedVerifiedSuccess ? undefined : result.statusWriteOutcome,
    suppressCloseNotificationRequested: trimmedVerifiedSuccess ? undefined : result.suppressCloseNotificationRequested,
    suppressCloseNotificationIncluded: trimmedVerifiedSuccess ? undefined : result.suppressCloseNotificationIncluded,
    verified: result.verified,
    failureStage: result.failureStage,
    failureReason: result.failureReason,
    primaryWriteMethod: result.primaryWriteMethod,
    primaryWriteOutcome: result.primaryWriteOutcome,
    primaryFailureDiagnostics: trimmedVerifiedSuccess ? undefined : result.primaryFailureDiagnostics,
    primaryGraphqlClassification: trimmedVerifiedSuccess ? undefined : result.primaryGraphqlClassification,
    primaryGraphqlCode: trimmedVerifiedSuccess ? undefined : result.primaryGraphqlCode,
    primaryGraphqlPath: trimmedVerifiedSuccess ? undefined : result.primaryGraphqlPath,
    primaryResponseHadData: trimmedVerifiedSuccess ? undefined : result.primaryResponseHadData,
    primarySynchronousFailure: trimmedVerifiedSuccess ? undefined : result.primarySynchronousFailure,
    updatedTimeChanged: trimmedVerifiedSuccess ? undefined : result.updatedTimeChanged,
    requestedFieldsObserved: trimmedVerifiedSuccess ? undefined : result.requestedFieldsObserved,
    noChangeObserved: trimmedVerifiedSuccess ? undefined : result.noChangeObserved,
    retrySafe: trimmedVerifiedSuccess ? undefined : result.retrySafe,
    partialFieldsObserved: trimmedVerifiedSuccess ? undefined : result.partialFieldsObserved,
    statusObserved: trimmedVerifiedSuccess ? undefined : result.statusObserved,
    fallbackEligible: trimmedVerifiedSuccess ? undefined : result.fallbackEligible,
    fallbackAttempted: trimmedVerifiedSuccess ? undefined : result.fallbackAttempted,
    fallbackWriteMethod: trimmedVerifiedSuccess ? undefined : result.fallbackWriteMethod,
    fallbackOutcome: trimmedVerifiedSuccess ? undefined : result.fallbackOutcome,
    fallbackResult: trimmedVerifiedSuccess ? undefined : result.fallbackResult,
    physicalWrites: result.physicalWrites,
    finalVerificationState: result.finalVerificationState,
    terminalReason: result.terminalReason,
    partialWrite: result.partialWrite,
    requestedState: trimmedVerifiedSuccess ? undefined : result.requestedState,
    attemptedState: trimmedVerifiedSuccess ? undefined : result.attemptedState,
    writableTargetState: trimmedVerifiedSuccess ? undefined : result.writableTargetState,
    derivedReadOnlyState: trimmedVerifiedSuccess ? undefined : result.derivedReadOnlyState,
    ignoredTargetFields: trimmedVerifiedSuccess ? undefined : result.ignoredTargetFields,
    observedFinalState: trimmedVerifiedSuccess ? undefined : result.observedFinalState,
    verifiedState: trimmedVerifiedSuccess ? undefined : result.verifiedState,
    finalState: trimmedVerifiedSuccess ? undefined : result.finalState,
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
function applyTriageHasDurableContinuationState(record: OperationLedgerRecord): boolean {
  if (record.toolName !== "superops_tickets_apply_triage_plan") return false;
  if (record.continuationCount <= 0) return false;
  if (record.state !== "ContinuationRequired" && record.state !== "Rescheduled") return false;
  if (record.pendingItems.length === 0) return false;
  const storedParams = operationRequestApplyTriageParams(record.operationRequest);
  if (!storedParams || !Array.isArray(storedParams.expectedCandidateTicketNumbers)) return false;
  const storedExpected = new Set(
    storedParams.expectedCandidateTicketNumbers.map((ticketNumber) => normaliseTicketNumber(ticketNumber))
  );
  return record.pendingItems.every((itemKey) => {
    const item = record.itemStates[itemKey];
    if (!item) return false;
    if (item.stage === "Unattempted") return storedExpected.has(itemKey);
    return true;
  });
}
function applyTriageOriginalRequestHash(
  request: ApplyTriagePlanParams,
  expected: string[]
): string {
  return stableHash({
    batchId: request.batchId,
    expectedCandidateTicketNumbers: expected,
    actions: Array.isArray(request.actions)
      ? request.actions.map((action) => ({
          ...action,
          note: action.note ? normalizedNoteFingerprint(action.note) : undefined,
        }))
      : [],
    dryRun: request.dryRun ?? false,
    verify: request.verify ?? true,
  });
}

function isCompactStoredApplyTriageRecovery(
  request: ApplyTriagePlanParams,
  expected: string[],
  actions: TriagePlanAction[],
  record: OperationLedgerRecord
): boolean {
  if (
    request.batchId !== record.operationId ||
    actions.length !== 0 ||
    record.pendingItems.length === 0 ||
    !["Running", "ContinuationRequired", "Rescheduled"].includes(record.state)
  ) return false;
  if ([
    request.dryRun,
    request.verify,
    request.dedupeNotes,
    request.stopOnFirstFailure,
    request.allowResolveFullFallbackToUpdate,
    request.allowWriteIfUpdatedTimeChanged,
    request.allowWriteWithoutVerifiedContent,
  ].some((value) => value !== undefined)) return false;

  const storedRequest = operationRequestApplyTriageParams(record.operationRequest);
  const storedExpected = storedRequest?.expectedCandidateTicketNumbers?.map((ticketNumber) =>
    normaliseTicketNumber(ticketNumber)
  );
  return Array.isArray(storedExpected) &&
    storedExpected.length === expected.length &&
    storedExpected.every((ticketNumber, index) => ticketNumber === expected[index]);
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
        writeMayHaveSucceeded: result?.writeMayHaveSucceeded ?? false,
        partialWrite: result?.partialWrite ?? false,
        mutationType: action?.action === "resolve"
          ? "resolution"
          : action?.action === "addNote"
            ? "note"
            : action?.action === "update" || action?.action === "leave"
              ? "update"
              : undefined,
        reliableResponseReceived: result?.writeAttempted ? result.writeMayHaveSucceeded === false || result.partialWrite === false : undefined,
        observedMutationResult: result?.writeAttempted
          ? result.writeMayHaveSucceeded === false
            ? "Rejected"
            : result.partialWrite ? "Ambiguous" : "Accepted"
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
        ["Failed", "RejectedOrNoChange", "AmbiguousNoChangeObserved", "PartialResolveStatusMissing", "Blocked", "NotFound", "FailedBeforeProcessing"].includes(
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
    originalRequestHash: applyTriageOriginalRequestHash(params.request, params.expected),
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
    compactResults: params.results.map((result) => compactApplyResult(result, {
      trimVerifiedSuccessDetails: params.expected.length > 50,
    })),
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
    failed: results.filter((result) => ["Failed", "RejectedOrNoChange", "AmbiguousNoChangeObserved", "PartialResolveStatusMissing"].includes(result.finalOutcome)).length,
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

type DurableMutationType = "update" | "classification" | "resolution" | "status" | "note" | "resolveFallback";

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
  resumeStage?: OperationItemState["stage"];
  noteVisibilityPriorAttempts?: number;
  beforeNoteCheck?: () => Promise<void>;
  afterPreflightValidation?: () => Promise<void>;
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
  afterVerification?: (mutationType: "update" | "classification" | "resolution" | "status" | "note") => Promise<void>;
}): Promise<ApplyTriagePlanResult> {
  const { client, ticketNumber, action } = params;
  if (!action) {
    const result = baseApplyResult(ticketNumber);
    result.finalOutcome = "NoApprovedAction";
    result.failureStage = "approval";
    result.failureReason = "No approved action was supplied for this expected candidate.";
    return result;
  }

  let resolved: Awaited<ReturnType<typeof resolveTicketId>>;
  try {
    resolved = await resolveTicketId(client, { ticketNumber });
  } catch (error) {
    if (isExecutionStopError(error)) throw error;
    return preWriteReadFailureResult({
      ticketNumber,
      action,
      error,
      operationName: "getTicketList",
    });
  }
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
    return preWriteReadFailureResult({
      ticketNumber,
      action,
      error,
      operationName: "getTicket",
    });
  }

  const result = baseApplyResult(ticketNumber, action, ticket);
  const allowChanged = action.allowWriteIfUpdatedTimeChanged ?? params.allowWriteIfUpdatedTimeChanged;
  const stagedResume = action.action === "resolve" && stagedResolveResumeSkipsSnapshotExpectations(params.resumeStage);
  const validationAction = stagedResume ? actionWithSnapshotExpectationsRelaxedForStagedResume(action) : action;
  const validationFailure = validateExpectedTicket(ticketNumber, validationAction, ticket, allowChanged || stagedResume);
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
  const mutating = action.action === "resolve" || action.action === "update" ||
    action.action === "leave" || action.action === "addNote";
  const allowUnverified = action.allowWriteWithoutVerifiedContent ?? params.allowWriteWithoutVerifiedContent;
  if (mutating && action.contentVerified !== true && !allowUnverified) {
    result.finalOutcome = "Blocked";
    result.failureStage = "contentVerification";
    result.failureReason = "Mutating action requires contentVerified=true or allowWriteWithoutVerifiedContent=true.";
    return result;
  }

  if (noteBodyForPlan(action.note) && action.isPublicNote === true) {
    result.finalOutcome = "Blocked";
    result.failureStage = "notePrivacy";
    result.failureReason = "Approved triage notes must be private; public note creation is not allowed.";
    markNotePlanned(result, action.note);
    return result;
  }

  if (params.dryRun) {
    if (action.action === "resolve") {
      const classificationInput = await buildStagedResolveClassificationInput(client, ticket.ticketId, action);
      const classificationError = (classificationInput as { error?: unknown }).error;
      const statusInput = buildStagedResolveStatusInput(ticket.ticketId, action.target?.status);
      const statusError = (statusInput as { error?: unknown }).error;
      if (typeof classificationError === "string" || typeof statusError === "string") {
        result.finalOutcome = "Blocked";
        result.failureStage = "validation";
        result.failureReason = typeof classificationError === "string" ? classificationError : String(statusError);
        return result;
      }
      result.workflowMode = "staged";
      result.plannedMutations = stagedResolvePlannedMutations(action, ticket);
      result.classificationWriteMethod = "updateTicket.classification";
      result.classificationWriteOutcome = result.plannedMutations.includes("updateClassificationAndClient") ? "Planned" : "NotRequired";
      result.statusWriteMethod = "updateTicket.statusOnly";
      result.statusWriteOutcome = "Planned";
      result.suppressCloseNotificationRequested = true;
      result.suppressCloseNotificationIncluded = true;
    } else if (action.action === "update" || action.action === "leave") {
      const dryRunInput = await buildApprovedUpdateInput(client, ticket.ticketId, action);
      const dryRunError = (dryRunInput as { error?: unknown }).error;
      if (typeof dryRunError === "string") {
        result.finalOutcome = "Blocked";
        result.failureStage = "validation";
        result.failureReason = dryRunError;
        return result;
      }
      result.plannedMutations = ["update"];
    } else if (action.action === "addNote") {
      result.plannedMutations = [];
    }
    if (markNotePlanned(result, action.note)) {
      markNoteDedupePlanned(result, action.note, params.dedupeNotes);
      if (action.action !== "resolve") {
        result.plannedMutations = [...(result.plannedMutations ?? []), "createTicketNote"];
      }
    }
    result.finalOutcome = action.action === "resolve"
      ? "Resolved"
      : action.action === "leave"
        ? "Left"
        : "Updated";
    result.writeMethod = "dryRun";
    return result;
  }
  try {
    if (action.action === "addNote") {
      result.writeMethod = "createTicketNote";
      await addNoteForPlan({
        client,
        ticketId: ticket.ticketId,
        ticketNumber,
        additionalTicketIds: [resolved.ticketId, ticket.ticketId],
        note: action.note,
        isPublic: false,
        dedupe: params.dedupeNotes,
        result,
        beforeCheck: stagedResolveResumeHasCheckedNote(params.resumeStage) ? undefined : params.beforeNoteCheck,
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
          result.finalVerificationState = "Verified";
          await params.afterVerification?.("note");
        } catch (error) {
          if (error instanceof DurableCheckpointError || isExecutionStopError(error)) throw error;
          result.finalOutcome = "Failed";
          result.partialWrite = result.writeAttempted || result.noteAdded;
          result.failureStage = "verify";
          result.failureReason = safeErrorMessage(error);
          result.finalVerificationState = "Failed";
        }
      }
    } else {
      if (action.action === "resolve") {
        return await applyStagedResolveAction({
          client,
          ticketNumber,
          action,
          ticket,
          resolvedTicketId: resolved.ticketId,
          result,
          verify: params.verify,
          dedupeNotes: params.dedupeNotes,
          resumeStage: params.resumeStage,
          noteVisibilityPriorAttempts: params.noteVisibilityPriorAttempts,
          beforeNoteCheck: params.beforeNoteCheck,
          afterPreflightValidation: params.afterPreflightValidation,
          beforeMutation: params.beforeMutation,
          afterMutation: params.afterMutation,
          afterConclusiveRejection: params.afterConclusiveRejection,
          afterVerification: params.afterVerification,
        });
      }
      const updateInput = await buildApprovedUpdateInput(client, ticket.ticketId, action);
      const updateError = (updateInput as { error?: unknown }).error;
      if (typeof updateError === "string") {
        result.finalOutcome = "Blocked";
        result.failureStage = "validation";
        result.failureReason = updateError;
        return result;
      }

      let notePlan: "none" | "deduped" | "pending" = "none";
      try {
        notePlan = await checkNoteForPlan({
          client,
          ticketId: ticket.ticketId,
          ticketNumber,
          additionalTicketIds: [resolved.ticketId, ticket.ticketId],
          note: action.note,
          dedupe: params.dedupeNotes,
          result,
          beforeCheck: stagedResolveResumeHasCheckedNote(params.resumeStage) ? undefined : params.beforeNoteCheck,
        });
      } catch (error) {
        if (error instanceof DurableCheckpointError || isExecutionStopError(error)) throw error;
        result.finalOutcome = "Failed";
        result.failureStage = "duplicateNoteCheck";
        result.failureReason = safeErrorMessage(error);
        result.partialWrite = false;
        return result;
      }

      result.attemptedState = updateInput as Record<string, unknown>;
      result.writeMethod = "update";
      result.primaryWriteMethod = "updateTicket";
      const mutationType: DurableMutationType = "update";
      try {
        await params.beforeMutation?.(mutationType);
        result.writeAttempted = true;
        const mutationResult = await mutateTicketUpdate(
          client,
          updateInput as Record<string, unknown>
        );
        result.primaryWriteOutcome = "Accepted";
        result.writeMayHaveSucceeded = true;
        recordPhysicalWrite(result, result.primaryWriteMethod ?? "updateTicket", "Accepted");
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
          result.writeMayHaveSucceeded = result.partialWrite;
          if (rateLimit.conclusiveRejection) {
            await params.afterConclusiveRejection?.(mutationType, rateLimit, result.failureReason ?? undefined);
          }
          return result;
        }
        result.finalOutcome = "Failed";
        result.failureStage = "update";
        result.failureReason = safeErrorMessage(error);
        result.partialWrite = result.writeAttempted || result.noteAdded;
        result.writeMayHaveSucceeded = result.partialWrite;
        return result;
      }
      let verified: Ticket;
      try {
        verified = await getTicketByInternalId(client, ticket.ticketId);
      } catch (error) {
        if (isExecutionStopError(error)) throw error;
        result.finalOutcome = "Failed";
        result.partialWrite = true;
        result.writeMayHaveSucceeded = true;
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
        result.writeMayHaveSucceeded = true;
        result.failureStage = "verifyFinalState";
        result.failureReason = `Final state did not match requested target fields: ${JSON.stringify(finalVerification.mismatches)}`;
        result.finalVerificationState = "Failed";
        return result;
      }
      result.verified = true;
      result.writeMayHaveSucceeded = true;
      result.verifiedState = result.finalState;
      result.finalVerificationState = "Verified";
      await params.afterVerification?.("update");

      try {
        if (notePlan === "pending") {
          await createNoteForPlan({
            client,
            ticketId: ticket.ticketId,
            note: action.note,
            isPublic: false,
            result,
            beforeCreate: async () => {
              await (params.beforeMutation?.("note") ?? Promise.resolve());
              result.writeAttempted = true;
            },
            afterCreate: (note) => params.afterMutation?.("note", {
              ticketId: ticket.ticketId,
              noteId: note.noteId,
            }) ?? Promise.resolve(),
          });
        }
      } catch (error) {
        if (error instanceof DurableCheckpointError || isExecutionStopError(error)) throw error;
        result.finalOutcome = "Failed";
        result.failureStage = "createTicketNote";
        result.failureReason = safeErrorMessage(error);
        result.partialWrite = true;
        result.writeMayHaveSucceeded = true;
        return result;
      }

      if (notePlan === "pending") {
        const fingerprint = action.noteFingerprint ?? normalizedNoteFingerprint(action.note);
        let noteVerified = false;
        try {
          noteVerified = await existingNoteMatchesFingerprint(client, ticket.ticketId, fingerprint, {
            ticketNumber,
            additionalTicketIds: [resolved.ticketId, ticket.ticketId],
          });
          result.noteDedupeChecked = true;
        } catch {
          result.noteDedupeChecked = false;
        }
        result.initialNoteVerificationObserved = noteVerified;
        result.noteVerificationAttempts = 1;
        if (!noteVerified) {
          return markStagedNoteVisibilityPending({
            result,
            stage: "NoteAdded",
            attempts: 1,
            initialObserved: false,
          });
        }
        result.noteWriteOutcome = "AcceptedAndVerified";
        result.noteVerifiedAfterDelay = false;
        result.continuationRequired = false;
        await params.afterVerification?.("note");
      } else if (notePlan === "deduped") {
        result.noteWriteOutcome = "VerifiedExistingPrivateNote";
        result.initialNoteVerificationObserved = true;
        result.noteVerificationAttempts = 1;
        result.noteVerifiedAfterDelay = false;
        result.continuationRequired = false;
      }

      result.finalOutcome = action.action === "leave" ? "Left" : "Updated";
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
      result.writeMayHaveSucceeded = result.partialWrite;
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
      result.writeMayHaveSucceeded = result.partialWrite;
    }
    return result;
  }
}

function applyResultToContinuationOutcome(
  result: ApplyTriagePlanResult,
  stage: OperationItemState["stage"] = triageStageForResult(result),
  priorObservedMutationResult?: OperationItemState["observedMutationResult"],
  compactOptions: { trimVerifiedSuccessDetails?: boolean } = {}
): ContinuationItemOutcome {
  const rateLimitReschedule = result.failureStage === "rateLimit" &&
    result.rateLimitConclusiveRejection === true;
  const noteVisibilityPending = result.terminalReason === "NoteVisibilityPending";
  const noteVisibilityUnresolved = result.terminalReason === "NoteVisibilityUnresolved";
  const ambiguousMutation = result.writeAttempted && result.partialWrite && (
    result.failureStage === "update" || result.failureStage === "resolve_full" ||
    result.failureStage === "createTicketNote" || result.failureStage === "write" ||
    result.failureStage === "ambiguousWrite"
  );
  const persistedStage = noteVisibilityPending
    ? stage === "NoteWriteStarted" ? "NoteWriteStarted" : "NoteAdded"
    : noteVisibilityUnresolved
      ? "AmbiguousWriteUnresolved"
      : result.failureStage === "ambiguousWrite"
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
      noteVisibilityPending ? "NoteVisibilityPending" :
      noteVisibilityUnresolved ? "NoteVisibilityUnresolved" :
      result.failureStage === "ambiguousWrite" ? "AmbiguousWriteUnresolved" : result.finalOutcome,
    writeAttempted: result.writeAttempted,
    // A conclusive throttle proves this mutation was not accepted. Ambiguous
    // transports remain conservative; only a reliable rejection can clear
    // possible-write state and authorise a checked retry.
    writeMayHaveSucceeded: rateLimitReschedule ? false : result.writeMayHaveSucceeded === true,
    reliableResponseReceived: rateLimitReschedule || noteVisibilityPending || noteVisibilityUnresolved ? true : result.writeAttempted && result.writeMayHaveSucceeded === false ? true : undefined,
    retryDelaySource: result.rateLimitDelaySource,
    retryAfterSupplied: result.rateLimitRetryAfterSupplied,
    suppliedDelayMs: result.rateLimitRetryAfterSupplied ? result.rateLimitRequestedDelayMs : undefined,
    retryOperationName: result.rateLimitOperationName ??
      (result.failureStage === "createTicketNote" || result.writeMethod === "createTicketNote"
        ? "CreateTicketNote"
        : "UpdateTicket"),
    retryEndpoint: "SuperOps GraphQL /msp",
    retryCount: noteVisibilityPending || noteVisibilityUnresolved ? result.noteVerificationAttempts : undefined,
    observedMutationResult: rateLimitReschedule
      ? "Rejected"
      : noteVisibilityPending || noteVisibilityUnresolved
        ? "Accepted"
      : result.verified
        ? priorObservedMutationResult === "Rejected" && !result.writeAttempted
          ? "Rejected"
          : "VerifiedApplied"
        : result.writeAttempted && result.writeMayHaveSucceeded === false
          ? "Rejected"
          : ambiguousMutation ? "Ambiguous" : undefined,
    partialWrite: result.partialWrite,
    verified: result.verified,
    verificationNotRequired: !result.writeAttempted &&
      !result.partialWrite &&
      ["Resolved", "Updated", "Left", "NoApprovedAction"].includes(result.finalOutcome),
    rateLimited: rateLimitReschedule,
    nextEligibleTime: rateLimitReschedule
      ? new Date(Date.now() + (result.rateLimitRetryAfterMs ?? 0)).toISOString()
      : noteVisibilityPending
        ? stagedNoteVisibilityNextEligibleTime()
        : undefined,
    verificationFailed: result.failureStage === "verify" || result.failureStage === "verifyFinalState",
    stale: result.finalOutcome === "SkippedChangedSinceSnapshot",
    failureReason: result.failureReason ?? undefined,
    result: compactApplyResult(result, compactOptions),
    errorClass: rateLimitReschedule
      ? "SuperOpsRateLimit"
      : noteVisibilityPending
        ? undefined
      : noteVisibilityUnresolved
        ? "AmbiguousWrite"
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
  markNotePlanned(result, action.note);
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
  fallbackAlreadyAttempted?: boolean;
  beforeNoteCheck?: () => Promise<void>;
  afterPreflightValidation?: () => Promise<void>;
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
  afterVerification?: (mutationType: "update" | "classification" | "resolution" | "status" | "note") => Promise<void>;
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
    if (fingerprint) {
      result.notePlanned = true;
      result.noteDedupePlanned = true;
      result.noteDedupeChecked = false;
    }
    const noteDeduped = await existingNoteMatchesFingerprint(client, ticket.ticketId, fingerprint, {
      ticketNumber,
      additionalTicketIds: [resolved.ticketId, ticket.ticketId],
    });
    if (fingerprint) {
      result.noteDedupeChecked = true;
    }
    if (noteDeduped) {
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
  const statusMissingAfterResolve = action.action === "resolve"
    ? resolveStatusAnalysis(action, ticket).statusMissing
    : false;
  const allowChanged = action.allowWriteIfUpdatedTimeChanged ?? applyParams.allowWriteIfUpdatedTimeChanged ?? false;
  const validationFailure = targetApplied
    ? validateExpectedTicket(ticketNumber, { ...action, expectedStatus: undefined, expectedUpdatedTime: undefined }, ticket, true)
    : statusMissingAfterResolve
      ? undefined
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
    result.finalOutcome = action.action === "resolve"
      ? "Resolved"
      : action.action === "leave"
        ? "Left"
        : "Updated";
    result.finalState = ticketFinalState(ticket);
    result.observedFinalState = result.finalState;
    result.verifiedState = result.finalState;
    result.verified = true;
    await params.afterVerification?.(action.action === "resolve" ? "resolution" : "update");

    try {
      await addNoteForPlan({
        client,
        ticketId: ticket.ticketId,
        ticketNumber,
        additionalTicketIds: [resolved.ticketId, ticket.ticketId],
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

  if (action.action === "resolve") {
    const analysis = resolveStatusAnalysis(action, ticket);
    if (analysis.statusMissing) {
      const result = baseApplyResult(ticketNumber, action, ticket);
      result.writeAttempted = true;
      result.writeMethod = "resolve_full";
      result.primaryWriteMethod = "updateTicket.resolve_full";
      result.primaryWriteOutcome = "Ambiguous";
      result.partialWrite = true;
      result.finalState = ticketFinalState(ticket);
      result.observedFinalState = result.finalState;
      result.partialFieldsObserved = analysis.partialFieldsObserved;
      result.statusObserved = analysis.statusObserved;
      result.finalVerificationState = "Pending";
      recordPhysicalWrite(result, "updateTicket.resolve_full", "Ambiguous");
      const fallbackAllowed = action.allowResolveFullFallbackToUpdate ??
        applyParams.allowResolveFullFallbackToUpdate ?? false;
      const allowUnverified = action.allowWriteWithoutVerifiedContent ??
        applyParams.allowWriteWithoutVerifiedContent ?? false;
      const eligibility = statusOnlyFallbackEligibility({
        ticketNumber,
        action,
        ticket,
        analysis,
        fallbackAllowed,
        allowWriteWithoutVerifiedContent: allowUnverified,
      });
      result.fallbackEligible = eligibility.eligible;
      if (eligibility.eligible && !params.fallbackAlreadyAttempted) {
        const fallbackResult = await reconcileAmbiguousResolveWrite({
          client,
          ticketNumber,
          action,
          originalTicket: ticket,
          result,
          notePlan: "none",
          fallbackAllowed,
          allowWriteWithoutVerifiedContent: allowUnverified,
          primaryError: new Error("Previously ambiguous resolve_full write requires state reconciliation."),
          beforeMutation: params.beforeMutation,
          afterMutation: params.afterMutation,
          afterVerification: params.afterVerification,
        });
        return {
          result: fallbackResult,
          stage: fallbackResult.finalOutcome === "Resolved"
            ? "CompletedAfterAmbiguousWriteVerification"
            : "FailedAfterPartialWrite",
        };
      }
      const fallbackReason = params.fallbackAlreadyAttempted
        ? "Status-only fallback was already attempted and will not be retried."
        : `Status-only fallback not attempted: ${eligibility.reason}`;
      result.fallbackAttempted = params.fallbackAlreadyAttempted === true;
      result.fallbackResult = fallbackReason;
      markPartialResolveStatusMissing({ result, analysis, fallbackReason });
      return { result, stage: "FailedAfterPartialWrite" };
    }
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
  result.writeMayHaveSucceeded = true;
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
      if (action.action === "skip") return 3;
      if (action.action === "addNote") {
        const validationAndDedupeReads = 2 + (storedParams?.dedupeNotes === false ? 0 : 2);
        const postMutationVerification = storedParams?.verify === false ? 0 : 2;
        return validationAndDedupeReads + 5 + postMutationVerification;
      }
      const target = action.target ?? {};
      const optionLookup = action.action === "resolve" ||
        [target.impact, target.urgency, target.resolutionCode,
          target.cause, target.subcategory].some(Boolean) ? 1 : 0;
      const clientLookup = target.clientName && !target.clientId ? 1 : 0;
      const techGroupLookup = target.techGroupName ? 1 : 0;
      const validationReads = 2 + optionLookup + clientLookup + techGroupLookup;
      const noteWork = noteExpectedForAction(action)
        ? storedParams?.dedupeNotes === false ? 6 : 8
        : 0;
      // Each read retry is separately budget-checked by SuperOpsClient. This
      // estimate reserves the required first attempt; the mutation hook then
      // reserves every durable checkpoint, write, and read-back, including
      // private-note dedupe and visibility verification when requested.
      return validationReads + 8 + noteWork;
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
        claim.item.stage !== "NoteVerified" &&
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
        const noteCheckStage: OperationItemState["stage"] = action?.action === "resolve" ? "NoteDedupeChecked" : "NoteChecked";
        if (checkpointStage === noteCheckStage) return;
        try {
          await checkpoint({
            stage: noteCheckStage,
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
          checkpointStage = noteCheckStage;
        } catch (error) {
          throw new DurableCheckpointError(error);
        }
      };
      const afterPreflightValidation = async () => {
        if (stagedResolveResumeHasPreflightValidation(checkpointStage)) return;
        try {
          await checkpoint({
            stage: "PreflightValidated",
            mutationType: "classification",
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
          checkpointStage = "PreflightValidated";
        } catch (error) {
          throw new DurableCheckpointError(error);
        }
      };
      const beforeMutation = async (
        mutationType: DurableMutationType
      ) => {
        const checkpointCount = mutationType === "note" ? 2 : mutationType === "resolveFallback" || mutationType === "status" ? 1 : mutationType === "classification" ? 2 : 3;
        const verificationReserve = mutationType === "note"
          ? (storedParams.verify === false ? 0 : 2)
          : 2;
        // Reserve the start checkpoint(s), one write, accepted-response
        // checkpoint, required read-back/checkpoint, and final ledger commit.
        // If this does not fit, no mutation-start checkpoint or write occurs.
        assertExecutionBudget(checkpointCount + 1 + 1 + verificationReserve + 1);
        try {
          const stages: OperationItemState["stage"][] = mutationType === "note"
            ? [action?.action === "resolve" ? "NoteDedupeChecked" : "NoteChecked", "NoteWriteStarted"]
            : mutationType === "classification"
              ? ["PreflightValidated", "ClassificationWriteStarted"]
            : mutationType === "status"
              ? ["StatusWriteStarted"]
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
              stage === "ClassificationWriteStarted" || stage === "ResolutionWriteStarted" ||
              stage === "StatusWriteStarted" || stage === "NoteWriteStarted";
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
                "WriteStarted" | "ClassificationWriteStarted" | "ResolutionWriteStarted" | "StatusWriteStarted" | "NoteWriteStarted" : undefined,
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
          : mutationType === "classification"
            ? "ClassificationWriteSucceeded"
          : mutationType === "status"
            ? "StatusWriteSucceeded"
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
        mutationType: "update" | "classification" | "resolution" | "status" | "note"
      ) => {
        const stage: OperationItemState["stage"] = mutationType === "resolution"
          ? "ResolutionVerified"
          : mutationType === "classification"
            ? "ClassificationVerified"
          : mutationType === "status"
            ? "StatusVerified"
          : mutationType === "note" && action?.action === "resolve"
            ? "NoteVerified"
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
      let resumeStageOverride: OperationItemState["stage"] | undefined = claim.item.stage;
      let noteVerifiedAfterDelayAttempts: number | undefined;
      if (action && noteExpectedForAction(action) &&
          (claim.item.stage === "NoteWriteStarted" || claim.item.stage === "NoteAdded")) {
        const fingerprint = action.noteFingerprint ?? normalizedNoteFingerprint(action.note);
        const visibilityResult = baseApplyResult(claim.itemKey, action);
        visibilityResult.workflowMode = action.action === "resolve" ? "staged" : undefined;
        visibilityResult.writeMethod = action.action === "resolve" ? "staged" : "update";
        visibilityResult.writeAttempted = true;
        visibilityResult.writeMayHaveSucceeded = true;
        visibilityResult.partialWrite = true;
        visibilityResult.noteAdded = claim.item.stage === "NoteAdded" || Boolean(claim.item.createdNoteId);
        visibilityResult.notePlanned = Boolean(fingerprint);
        visibilityResult.noteDedupePlanned = Boolean(fingerprint);
        visibilityResult.physicalWrites = [];
        markWorkflowStage(visibilityResult, claim.item.stage);

        const resolvedForNotes = await resolveTicketId(client, { ticketNumber: claim.itemKey });
        if (resolvedForNotes.error || !resolvedForNotes.ticketId) {
          visibilityResult.finalOutcome = "Failed";
          visibilityResult.failureStage = "noteVisibilityRead";
          visibilityResult.failureReason = resolvedForNotes.error ?? "Ticket was not found while reconciling private-note visibility.";
          visibilityResult.terminalReason = "NoteVisibilityUnresolved";
          visibilityResult.finalVerificationState = "Pending";
          return applyResultToContinuationOutcome(
            markStagedNoteVisibilityUnresolved({
              result: visibilityResult,
              attempts: (claim.item.retryCount ?? 0) + 1,
            }),
            claim.item.stage,
            observedMutationResult
          );
        }

        let noteObserved = false;
        try {
          noteObserved = await existingNoteMatchesFingerprint(client, resolvedForNotes.ticketId, fingerprint, {
            ticketNumber: claim.itemKey,
            additionalTicketIds: [resolvedForNotes.ticketId],
          });
          visibilityResult.noteDedupeChecked = true;
        } catch {
          visibilityResult.noteDedupeChecked = false;
        }
        visibilityResult.initialNoteVerificationObserved = false;
        const attempts = (claim.item.retryCount ?? 0) + 1;
        visibilityResult.noteVerificationAttempts = attempts;
        if (!noteObserved) {
          if (attempts >= STAGED_NOTE_VISIBILITY_MAX_ATTEMPTS) {
            return applyResultToContinuationOutcome(
              markStagedNoteVisibilityUnresolved({ result: visibilityResult, attempts }),
              claim.item.stage,
              observedMutationResult
            );
          }
          return applyResultToContinuationOutcome(
            markStagedNoteVisibilityPending({
              result: visibilityResult,
              stage: claim.item.stage,
              attempts,
            }),
            claim.item.stage,
            observedMutationResult
          );
        }

        noteVerifiedAfterDelayAttempts = attempts;
        if (action.action === "resolve") {
          await afterVerification("note");
          resumeStageOverride = "NoteVerified";
        } else {
          const verifiedTicket = await getTicketByInternalId(client, resolvedForNotes.ticketId);
          const identityFailure = validateExpectedTicket(
            claim.itemKey,
            { ...action, expectedStatus: undefined, expectedUpdatedTime: undefined },
            verifiedTicket,
            true
          );
          const targetVerification = verifyFinalTargetState(action, verifiedTicket);
          visibilityResult.finalState = ticketFinalState(verifiedTicket);
          visibilityResult.observedFinalState = visibilityResult.finalState;
          if (identityFailure || targetVerification.mismatches.length > 0) {
            visibilityResult.finalOutcome = identityFailure?.outcome ?? "Failed";
            visibilityResult.failureStage = identityFailure?.stage ?? "verifyFinalState";
            visibilityResult.failureReason = identityFailure?.reason ??
              `Final state did not match requested target fields: ${JSON.stringify(targetVerification.mismatches)}`;
            visibilityResult.terminalReason = "PostNoteTargetVerificationMismatch";
            visibilityResult.finalVerificationState = "Failed";
            visibilityResult.verified = false;
            return applyResultToContinuationOutcome(
              visibilityResult,
              "FailedAfterPartialWrite",
              observedMutationResult
            );
          }

          await afterVerification("note");
          visibilityResult.finalOutcome = action.action === "leave" ? "Left" : "Updated";
          visibilityResult.partialWrite = false;
          visibilityResult.verified = true;
          visibilityResult.verifiedState = visibilityResult.finalState;
          visibilityResult.finalVerificationState = "Verified";
          markStagedNoteVerifiedAfterDelay(visibilityResult, attempts);
          return applyResultToContinuationOutcome(
            visibilityResult,
            "CompletedAfterAmbiguousWriteVerification",
            observedMutationResult
          );
        }
      }
      const stagedResolveResume = action?.action === "resolve" &&
        stagedResolveResumeSkipsSnapshotExpectations(resumeStageOverride);
      const shouldResolveAmbiguity = !stagedResolveResume && (
        claim.item.stage === "WriteStarted" ||
        claim.item.stage === "WriteAmbiguous" ||
        claim.item.stage === "ResolutionWriteStarted" ||
        claim.item.stage === "ResolutionWriteAmbiguous" ||
        claim.item.stage === "NoteWriteStarted" ||
        claim.item.stage === "NoteWriteAmbiguous" ||
        (claim.item.writeMayHaveSucceeded === true &&
          claim.item.observedMutationResult !== "Rejected"));
      const applied = shouldResolveAmbiguity && action
        ? await ambiguityCheckedTriageResult({
            client,
            ticketNumber: claim.itemKey,
            action,
            applyParams: storedParams,
            previousRetryCount: claim.item.retryCount,
            ambiguityStage: claim.item.stage,
            fallbackAlreadyAttempted: claim.item.fallbackAttempted === true,
            beforeNoteCheck,
            afterPreflightValidation,
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
              resumeStage: resumeStageOverride,
              noteVisibilityPriorAttempts: claim.item.retryCount,
              beforeNoteCheck,
              afterPreflightValidation,
              beforeMutation,
              afterMutation,
              afterConclusiveRejection,
              afterVerification,
            }),
          };

      if (noteVerifiedAfterDelayAttempts !== undefined) {
        markStagedNoteVerifiedAfterDelay(applied.result, noteVerifiedAfterDelayAttempts);
      }

      const trimVerifiedSuccessDetails = Array.isArray(storedParams.expectedCandidateTicketNumbers) &&
        storedParams.expectedCandidateTicketNumbers.length > 50;
      const outcome = applyResultToContinuationOutcome(
        applied.result,
        applied.stage,
        observedMutationResult,
        { trimVerifiedSuccessDetails }
      );
      outcome.retryCount = typeof applied.retryCount === "number"
        ? applied.retryCount
        : typeof outcome.retryCount === "number"
          ? outcome.retryCount
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
          "Read-only ticket triage snapshot for an explicitly selected configured status queue. Returns one execution-safe page of fixed candidates with safe compact metadata and sanitized conversation/note evidence. Follow pagination.nextPage until hasMore is false before proposing a complete queue plan.",
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
              description: "Requested candidates per page (default: 50, max: 500). The tool automatically uses a smaller stable page size when required to preserve safe metadata and content reads; follow pagination.nextPage until hasMore is false.",
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
          "Write/high-risk tool. Applies an approved fixed-candidate ticket triage plan from any configured status queue. Resolve requires full resolution classification; update and leave require active classification, allow optional cause, and prohibit resolution code. Leave retains status, and status changes are restricted to Resolved or Awaiting Engineer.",
        inputSchema: {
          type: "object",
          properties: {
            batchId: {
              type: "string",
              description: "Optional batch identifier. To resume an existing nonterminal operation, send its exact expectedCandidateTicketNumbers and omit actions and override flags.",
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

            let retrieval: TicketOptionFieldsRetrieval;
            try {
              retrieval = await getTicketOptionFieldsForTool(client, requestedFields);
            } catch (error) {
              if (typeof error === "object" && error !== null && "fieldOptionsError" in error) {
                const structured = { ...(error as Record<string, unknown>) };
                delete structured.fieldOptionsError;
                return {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify(structured, null, 2),
                    },
                  ],
                  isError: true,
                };
              }
              throw error;
            }
            const fields = retrieval.fields;
            const result: Record<string, unknown> = Object.fromEntries(
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
            result._metadata = { retrieval: retrieval.metadata };
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

            const effectiveMax = triageSnapshotEffectivePageSize(snapshotParams);
            const response = await client.query<ListTicketsResponse>(LIST_TICKETS_QUERY, {
              input: buildTicketListInput({
                status: snapshotParams.status,
                max: effectiveMax,
                page: snapshotParams.page,
              }),
            });
            const candidates = response.getTicketList.tickets;
            const listInfo = response.getTicketList.listInfo;
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
                        effectiveMax,
                      },
                      pagination: {
                        page: snapshotParams.page,
                        pageSize: effectiveMax,
                        hasMore: listInfo.hasMore,
                        totalCount: listInfo.totalCount,
                        nextPage: listInfo.hasMore ? snapshotParams.page + 1 : null,
                        budgetCapped: effectiveMax < snapshotParams.max,
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
                const storedRequest = operationRequestApplyTriageParams(existing.operationRequest);
                const recoveryRequest = params.batchId === existing.operationId &&
                    storedRequest?.batchId === undefined
                  ? serializableApplyTriageRequest({ ...params, batchId: undefined }, expected)
                  : undefined;
                const exactGeneratedIdRecovery = recoveryRequest !== undefined &&
                  stableHash(existing.operationRequest) === stableHash(recoveryRequest);
                const compactStoredRecovery = isCompactStoredApplyTriageRecovery(
                  params,
                  expected,
                  actions,
                  existing
                );
                if (existing.ownerHash !== ownerHash ||
                    (
                      existing.originalRequestHash !== initialRecord.originalRequestHash &&
                      !exactGeneratedIdRecovery &&
                      !compactStoredRecovery
                    )) {
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
            const checkpointFailureRequiresFreshOperation = continuationError !== undefined &&
              !continuationError.includes("crash-boundary after") &&
              (
                conservativeOutcome?.errorClass === "OperationStoreFailure" ||
                /Operation store .*failed|rate_limit_exceeded|Invalid operation item transition|persistence failed|crash-boundary before/.test(continuationError)
              );
            if (checkpointFailureRequiresFreshOperation && !finalRecordReadFailed &&
                !["Completed", "CompletedWithFailures", "Failed", "Cancelled"].includes(finalRecord.state)) {
              const durableItemsBeforeTerminalize = Object.values(finalRecord.itemStates);
              const possibleWriteBeforeCheckpointFailure = durableItemsBeforeTerminalize.some((item) =>
                item.writeMayHaveSucceeded === true && item.observedMutationResult !== "Rejected"
              );
              const checkpointFailureMessage = continuationError ?? "";
              const checkpointFailureReason = checkpointFailureMessage.includes("fresh operation")
                ? checkpointFailureMessage
                : checkpointFailureMessage +
                  " This operation was terminalized because a required durable checkpoint could not be persisted; submit a fresh operation after the code defect or durable-store failure is corrected.";
              conservativeOutcome = {
                stage: possibleWriteBeforeCheckpointFailure ? "AmbiguousWriteUnresolved" : "FailedBeforeWrite",
                outcome: possibleWriteBeforeCheckpointFailure ? "AmbiguousWriteRequiresReconciliation" : "OperationStoreFailure",
                writeAttempted: durableItemsBeforeTerminalize.some((item) => item.writeAttempted),
                writeMayHaveSucceeded: durableItemsBeforeTerminalize.some((item) => item.writeMayHaveSucceeded),
                partialWrite: possibleWriteBeforeCheckpointFailure || durableItemsBeforeTerminalize.some((item) => item.partialWrite),
                failureReason: checkpointFailureReason,
                errorClass: "OperationStoreFailure",
              };
              try {
                finalRecord = await store.terminalizeContinuationFailure({
                  operationId,
                  ownerHash,
                  errorClass: "OperationStoreFailure",
                  outcome: "OperationStoreFailed",
                  reason: checkpointFailureReason,
                });
                conservativeOutcome = undefined;
              } catch (error) {
                continuationError = checkpointFailureReason + " Terminal failure persistence also failed: " + safeErrorMessage(error);
              }
            }
            let continuationRequired = (continuation?.continuationRequired ??
              finalRecord.pendingItems.length > 0) || finalRecordReadFailed || Boolean(conservativeOutcome);
            const durableContinuationReady = applyTriageHasDurableContinuationState(finalRecord);
            if (continuationRequired && checkpointFailureRequiresFreshOperation &&
                !finalRecordReadFailed && !conservativeOutcome &&
                !finalRecord.nextEligibleTime && !durableContinuationReady) {
              const reason = "Continuation was not scheduled because no resumable durable state was persisted after the operation-store failure; submit a fresh operation.";
              continuationScheduling = { attempted: false, scheduled: false,
                terminalized: false, reasonCode: "durableStateMissing", error: reason,
                mechanism: "serviceBinding" };
              continuationError ??= reason;
              try {
                finalRecord = await store.terminalizeContinuationFailure({
                  operationId,
                  ownerHash,
                  errorClass: "OperationStoreFailure",
                  outcome: "OperationStoreFailed",
                  reason,
                });
                continuationScheduling.terminalized = true;
                continuationRequired = false;
              } catch (error) {
                continuationScheduling.terminalized = false;
                continuationScheduling.recovery = "operations_get reports a derived stalled state if this Running operation remains unadvanced.";
                continuationError = reason + " Terminal failure persistence also failed: " + safeErrorMessage(error);
              }
            }
            if (continuationRequired && durableContinuationReady && !finalRecord.nextEligibleTime && !finalRecordReadFailed && !conservativeOutcome) {
              let scheduled: Awaited<ReturnType<typeof scheduleApplyTriageContinuation>>;
              try {
                scheduled = await scheduleApplyTriageContinuation(operationId, ownerHash);
              } catch (error) {
                continuationError ??= safeErrorMessage(error);
                continuationScheduling = { attempted: true, scheduled: false,
                  error: safeErrorMessage(error), mechanism: "serviceBinding",
                  reasonCode: "exceptionDuringScheduling" };
                scheduled = {
                  scheduled: false,
                  reason: safeErrorMessage(error),
                  reasonCode: "exceptionDuringScheduling",
                };
              }
              continuationScheduling ??= { attempted: true, scheduled: scheduled.scheduled,
                status: scheduled.status, error: scheduled.scheduled ? undefined : scheduled.reason,
                reasonCode: scheduled.reasonCode, diagnostics: scheduled.diagnostics,
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
                  : scheduled.reason ?? "Immediate continuation delivery failed or is not configured.";
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
            const possibleSuperOpsWriteBeforeStoreFailure = conservativeWriteAttempted ||
              conservativeWriteMayHaveSucceeded || conservativePartialWrite;
            const conservativeFinalReason = continuationError && !durableFinalErrorClass
              ? possibleSuperOpsWriteBeforeStoreFailure
                ? "OperationStorePostWriteFailure"
                : "OperationStoreFailure"
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
              isError: Boolean(continuationError || durableFinalErrorClass === "OperationStoreFailure"),
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
