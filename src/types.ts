/**
 * SuperOps MCP Server Types
 *
 * Type definitions for the SuperOps.ai GraphQL API integration.
 */

import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

export interface SuperOpsCredentials {
  apiToken: string;
  subdomain: string;
  region?: "us" | "eu";
}

export interface GraphQLResponse<T = unknown> {
  data?: T;
  errors?: GraphQLError[];
}

export interface GraphQLError {
  message: string;
  locations?: { line: number; column: number }[];
  path?: Array<string | number>;
  extensions?: {
    code?: string;
    retryAfter?: number | string;
    field?: string;
    [key: string]: unknown;
  };
}

export type SuperOpsJson =
  | string
  | number
  | boolean
  | null
  | SuperOpsJson[]
  | { [key: string]: SuperOpsJson };

export interface Sort {
  attribute?: string;
  order?: "ASC" | "DESC";
}

export interface RuleConditionInput {
  attribute?: string;
  operator?: string;
  value?: SuperOpsJson;
}

export interface ListInfo {
  page?: number;
  pageSize?: number;
  sort?: Sort[];
  condition?: SuperOpsJson;
  hasMore?: boolean;
  totalCount?: number;
}

export interface ListInfoInput {
  page?: number;
  pageSize?: number;
  condition?: RuleConditionInput;
  sort?: Sort[];
}

// Client types
export interface Client {
  accountId: string;
  name: string;
  stage?: string;
  status?: string;
  emailDomains?: string[];
  accountManager?: SuperOpsJson;
  primaryContact?: SuperOpsJson;
  secondaryContact?: SuperOpsJson;
  hqSite?: SuperOpsJson;
  technicianGroups?: SuperOpsJson;
  customFields?: SuperOpsJson;
}

export interface Address {
  street?: string;
  city?: string;
  state?: string;
  country?: string;
  postalCode?: string;
}

export interface Site {
  id: string;
  name: string;
  address?: SuperOpsJson;
}

export interface Contact {
  userId: string;
  firstName?: string;
  lastName?: string;
  name?: string;
  email?: string;
  contactNumber?: string;
  reportingManager?: SuperOpsJson;
  site?: SuperOpsJson;
  role?: SuperOpsJson;
  client?: SuperOpsJson;
  customFields?: SuperOpsJson;
}

// Ticket types
export interface Ticket {
  ticketId: string;
  displayId?: string;
  subject: string;
  ticketType?: string;
  requestType?: string;
  source?: string;
  client?: SuperOpsJson;
  site?: SuperOpsJson;
  requester?: SuperOpsJson;
  additionalRequester?: SuperOpsJson;
  followers?: SuperOpsJson;
  techGroup?: SuperOpsJson;
  technician?: SuperOpsJson;
  status?: string;
  priority?: string;
  impact?: string;
  urgency?: string;
  category?: string;
  subcategory?: string;
  cause?: string;
  subcause?: string;
  resolutionCode?: string;
  sla?: SuperOpsJson;
  createdTime?: string;
  updatedTime?: string;
  firstResponseDueTime?: string;
  firstResponseTime?: string;
  firstResponseViolated?: boolean;
  resolutionDueTime?: string;
  resolutionTime?: string;
  resolutionViolated?: boolean;
  customFields?: SuperOpsJson;
  worklogTimespent?: string;
}

export interface TechGroup {
  groupId: string;
  name: string;
}

export interface Category {
  id: string;
  name: string;
}

export interface FieldOption {
  id?: string;
  value?: string;
  description?: string;
  parentOption?: FieldOption;
}

export interface SuperOpsField {
  id?: string;
  module?: string;
  columnName?: string;
  label?: string;
  options?: FieldOption[];
  parentField?: {
    id?: string;
    columnName?: string;
    label?: string;
  };
}

export interface TicketNote {
  noteId: string;
  addedBy?: SuperOpsJson;
  addedOn: string;
  content: string;
  attachments?: TicketAttachment[];
  privacyType?: "PUBLIC" | "PRIVATE";
}

export interface TicketAttachment {
  fileName: string;
  originalFileName: string;
  fileSize: string;
}

export interface TicketRecipientInfo {
  user?: SuperOpsJson;
}

export interface TicketConversation {
  conversationId: string;
  content?: string;
  time: string;
  user?: SuperOpsJson;
  toUsers?: TicketRecipientInfo[];
  ccUsers?: TicketRecipientInfo[];
  bccUsers?: TicketRecipientInfo[];
  attachments?: TicketAttachment[];
  type: string;
}

export interface Alert {
  id: string;
  message?: string;
  createdTime?: string;
  status?: string;
  severity?: string;
  description?: string;
  asset?: SuperOpsJson;
  policy?: SuperOpsJson;
  resolvedTime?: string;
  occurrenceCount?: number;
}

export interface NormalizedAlert extends Alert {
  clientName?: string;
  siteName?: string;
  assetName?: string;
  assetId?: string;
  policyName?: string;
  policyType?: string;
  ownerName?: string;
  ownerEmail?: string;
}

export interface TimeEntry {
  itemId: string;
  status?: string;
  serviceItem?: SuperOpsJson;
  billable?: boolean;
  afterHours?: boolean;
  qty: string;
  unitPrice?: string;
  billDateTime: string;
  technician?: SuperOpsJson;
  notes?: string;
  workItem?: SuperOpsJson;
}

// Asset types
export interface Asset {
  assetId: string;
  name: string;
  assetClass?: SuperOpsJson;
  client?: SuperOpsJson;
  site?: SuperOpsJson;
  requester?: SuperOpsJson;
  primaryMac?: string;
  loggedInUser?: string;
  serialNumber?: string;
  manufacturer?: string;
  model?: string;
  hostName?: string;
  publicIp?: string;
  gateway?: string;
  platform?: string;
  domain?: string;
  status?: string;
  sysUptime?: string;
  lastCommunicatedTime?: string;
  agentVersion?: string;
  platformFamily?: string;
  platformCategory?: string;
  platformVersion?: string;
  patchStatus?: string;
  warrantyExpiryDate?: string;
  purchasedDate?: string;
  customFields?: SuperOpsJson;
  lastReportedTime?: string;
  deviceCategory?: SuperOpsJson;
}

// Technician types
export interface Technician {
  userId: string;
  firstName: string;
  lastName?: string;
  name: string;
  email: string;
  contactNumber?: string;
  emailSignature?: string;
  designation?: SuperOpsJson;
  businessFunction?: SuperOpsJson;
  team?: SuperOpsJson;
  reportingManager?: SuperOpsJson;
  role?: SuperOpsJson;
  groups?: SuperOpsJson;
}

export interface CustomField {
  id?: string;
  columnName?: string;
  label?: string;
  description?: string;
  fieldType?: string;
  showToClient?: boolean;
}

// Tool definition types
export interface ToolDefinition {
  name: string;
  description: string;
  annotations?: ToolAnnotations;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export type Domain =
  | "clients"
  | "tickets"
  | "assets"
  | "scripts"
  | "script_catalogue"
  | "alerts"
  | "technicians"
  | "custom";

export interface DomainTools {
  tools: ToolDefinition[];
  handleCall: (
    name: string,
    args: Record<string, unknown>
  ) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;
}
