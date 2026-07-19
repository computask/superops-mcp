import { SuperOpsError, SuperOpsHttpError } from "../client.js";
import { getExecutionConfig, hasExecutionBudgetFor } from "../execution.js";
import type { ListInfo, ListInfoInput, SuperOpsJson, Ticket } from "../types.js";

export const CREATED_TIME_REPORT_PAGE_SIZE = 100;
const DEFAULT_QUERY_MAX_RECORDS = 5000;
const DEFAULT_QUERY_MAX_PAGES = 100;
const DEFAULT_REPORT_MAX_RECORDS = 10000;
const DEFAULT_REPORT_MAX_PAGES = 200;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const IDENTITY_FIELDS = ["ticketId", "displayId", "createdTime"] as const;
const FIELD_PROFILES = {
  minimal: ["ticketId", "displayId", "subject", "createdTime"],
  reporting: ["ticketId", "displayId", "subject", "createdTime", "updatedTime", "resolutionTime", "client", "requester", "technician", "techGroup", "status", "source", "category", "subcategory", "priority", "impact", "urgency", "requestType"],
} as const;
const SAFE_TICKET_FIELDS = new Set([...FIELD_PROFILES.reporting, "site", "approvalStatus", "cause", "subcause", "resolutionCode", "firstResponseDueTime", "firstResponseTime", "firstResponseViolated", "resolutionDueTime", "resolutionViolated", "worklogTimespent"]);
const FILTER_REQUIRED_FIELDS = ["client", "technician", "techGroup", "status", "source", "category", "subcategory", "priority", "requestType"] as const;
const LOCAL_FILTER_KEYS = ["priorities", "clientIds", "clientNames", "technicianIds", "technicianNames", "sources", "requestTypes", "categories", "subcategories", "techGroups"] as const;
const GROUP_BY_FIELDS = ["client", "technician", "techGroup", "source", "status", "category", "subcategory", "priority", "requestType"] as const;
const UNSUPPORTED_FIRST_VERSION_FIELDS = ["updatedFrom", "updatedTo", "resolvedFrom", "resolvedTo"] as const;
type FieldProfile = keyof typeof FIELD_PROFILES;
type Interval = "hour" | "day" | "week" | "month" | "none";
type GroupByField = (typeof GROUP_BY_FIELDS)[number];
type QueryableClient = { query<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T> };
interface TicketListResponse { getTicketList: { tickets: Ticket[]; listInfo: ListInfo } }
export interface HistoricalTicketQueryParams {
  createdFrom?: string; createdTo?: string; updatedFrom?: string; updatedTo?: string; resolvedFrom?: string; resolvedTo?: string;
  status?: string[]; priorities?: string[]; clientIds?: string[]; clientNames?: string[]; technicianIds?: string[]; technicianNames?: string[];
  sources?: string[]; requestTypes?: string[]; categories?: string[]; subcategories?: string[]; techGroups?: string[];
  fieldProfile?: FieldProfile; fields?: string[]; maxRecords?: number; maxPages?: number; sortOrder?: "ASC" | "DESC"; timeField?: string;
}
export interface HistoricalTicketReportParams extends HistoricalTicketQueryParams {
  timezone?: string; interval?: Interval; groupBy?: GroupByField[]; includeZeroBuckets?: boolean; topN?: number; includeSampleTickets?: boolean; sampleSizePerGroup?: number;
}
interface EffectiveQuery { createdFrom: string; createdTo: string; createdFromMs: number; createdToMs: number; fieldProfile: FieldProfile; outputFields: string[]; fetchFields: string[]; maxRecords: number; maxPages: number; sortOrder: "ASC" | "DESC" }
interface NormalizedIdentity { id?: string; name?: string; email?: string }
export interface NormalizedReportingTicket { ticketId: string; displayId?: string | null; subject?: string | null; createdTime: string; updatedTime?: string | null; resolutionTime?: string | null; client?: NormalizedIdentity | null; requester?: NormalizedIdentity | null; technician?: NormalizedIdentity | null; techGroup?: NormalizedIdentity | null; status?: string | null; source?: string | null; category?: string | null; subcategory?: string | null; priority?: string | null; impact?: string | null; urgency?: string | null; requestType?: string | null; [key: string]: unknown }
interface FetchErrorDiagnostic { stage: "fetchPage"; page: number; errorType: "rateLimit" | "server" | "graphql" | "network" | "budget"; message: string; retryable: boolean; attempts: number }
interface RetryDiagnostics { retries: number; retryDelaysMs: number[] }
export interface TicketPaginationDiagnostics { pagesFetched: number; pageSize: number; apiTotalCount?: number; recordsExamined: number; recordsMatched: number; recordsReturned: number; duplicateRecordsRemoved: number; complete: boolean; truncated: boolean; nextPage: number | null; stopReason: "crossedCreatedFromBoundary" | "hasMoreFalse" | "emptyPage" | "maxPagesReached" | "maxRecordsReached" | "repeatedPageLoop" | "fetchError" | "executionBudgetExhausted" }
export interface TicketQueryResult { responseVersion: 1; queryWindow: { createdFrom: string; createdTo: string; boundarySemantics: "createdFromInclusiveCreatedToExclusive"; timeField: "createdTime" }; sort: { attribute: "createdTime"; order: "DESC"; effectiveReturnOrder: "ASC" | "DESC" }[]; fieldProfile: FieldProfile; fields: string[]; records: NormalizedReportingTicket[]; pagination: TicketPaginationDiagnostics; filterExecution: Record<string, "server" | "local">; warnings: string[]; errors: FetchErrorDiagnostic[]; retryDiagnostics: RetryDiagnostics }
export interface TicketReportResult { responseVersion: 1; queryWindow: { createdFrom: string; createdTo: string; timezone: string; timeField: "createdTime"; boundarySemantics: "createdFromInclusiveCreatedToExclusive" }; totals: { tickets: number }; series: { bucketStart: string; bucketEnd: string; count: number }[]; breakdowns: Record<string, { key: string; count: number; percentage: number }[]>; rows?: Record<string, unknown>[]; samples?: Record<string, { key: string; tickets: { displayId?: string | null; subject?: string | null; createdTime: string; client?: string; source?: string | null; technician?: string }[] }[]>; pagination: TicketPaginationDiagnostics & { recordsAnalysed: number }; filterExecution: Record<string, "server" | "local">; technicianSemantics: "currentAssigneeAtQueryTime"; warnings: string[]; errors: FetchErrorDiagnostic[]; retryDiagnostics: RetryDiagnostics }

export function buildTicketSelection(params: HistoricalTicketQueryParams): { fieldProfile: FieldProfile; outputFields: string[]; fetchFields: string[] } {
  const fieldProfile = params.fieldProfile ?? "reporting";
  if (!Object.prototype.hasOwnProperty.call(FIELD_PROFILES, fieldProfile)) throw new Error(`Unsupported fieldProfile: ${String(fieldProfile)}`);
  const requested = Array.isArray(params.fields) && params.fields.length > 0 ? params.fields : [...FIELD_PROFILES[fieldProfile]];
  const unknown = requested.filter((field) => !SAFE_TICKET_FIELDS.has(field));
  if (unknown.length > 0) throw new Error(`Unsupported ticket reporting field(s): ${unknown.join(", ")}`);
  const outputFields = unique([...IDENTITY_FIELDS, ...requested]);
  const fetchFields = unique([...outputFields, ...FILTER_REQUIRED_FIELDS]);
  return { fieldProfile, outputFields, fetchFields };
}
export function buildTicketSort(): { attribute: "createdTime"; order: "DESC" }[] { return [{ attribute: "createdTime", order: "DESC" }]; }
export function buildTicketConditions(params: HistoricalTicketQueryParams): ListInfoInput["condition"] | undefined {
  const statuses = cleanStringArray(params.status);
  if (statuses.length === 0) return undefined;
  return statuses.length === 1 ? { attribute: "status", operator: "is", value: statuses[0] } : { attribute: "status", operator: "in", value: statuses };
}
export function validateHistoricalTicketQueryParams(params: HistoricalTicketQueryParams): EffectiveQuery {
  const unsupported = UNSUPPORTED_FIRST_VERSION_FIELDS.filter((field) => { const value = params[field]; return value !== undefined && value !== null && value !== ""; });
  if (unsupported.length > 0) throw new Error(`Unsupported first-version ticket reporting input(s): ${unsupported.join(", ")}. This implementation supports createdTime ranges only.`);
  if (params.timeField && params.timeField !== "createdTime") throw new Error("Unsupported first-version timeField: only createdTime is supported.");
  const createdFrom = parseIsoDateTime(params.createdFrom, "createdFrom");
  const createdTo = parseIsoDateTime(params.createdTo, "createdTo");
  if (createdFrom.ms >= createdTo.ms) throw new Error("createdFrom must be earlier than createdTo.");
  const selection = buildTicketSelection(params);
  return { createdFrom: createdFrom.iso, createdTo: createdTo.iso, createdFromMs: createdFrom.ms, createdToMs: createdTo.ms, ...selection, maxRecords: clampInteger(params.maxRecords, DEFAULT_QUERY_MAX_RECORDS, 1, 50000), maxPages: clampInteger(params.maxPages, DEFAULT_QUERY_MAX_PAGES, 1, 10000), sortOrder: params.sortOrder === "ASC" ? "ASC" : "DESC" };
}
export async function fetchTicketPage(client: QueryableClient, input: ListInfoInput, selectionFields: string[], page: number): Promise<{ response?: TicketListResponse; error?: FetchErrorDiagnostic }> {
  const query = buildTicketListQuery(selectionFields);
  try {
    return { response: await client.query<TicketListResponse>(query, { input }) };
  } catch (error) {
    return { error: { stage: "fetchPage", page, errorType: errorType(error), message: safeErrorMessage(error), retryable: isRetryable(error), attempts: 1 } };
  }
}
export async function fetchTicketsPaginated(client: QueryableClient, params: HistoricalTicketQueryParams): Promise<TicketQueryResult> {
  const effective = validateHistoricalTicketQueryParams(params);
  const executionConfig = getExecutionConfig();
  const maxPageLimit = Math.min(effective.maxPages, executionConfig.maxPaginationDepth);
  const retryDiagnostics: RetryDiagnostics = { retries: 0, retryDelaysMs: [] };
  const warnings: string[] = []; const errors: FetchErrorDiagnostic[] = [];
  const recordsById = new Map<string, NormalizedReportingTicket>(); const rangeMatched: NormalizedReportingTicket[] = []; const seenPages = new Set<string>();
  const condition = buildTicketConditions(params);
  const pagination: TicketPaginationDiagnostics = { pagesFetched: 0, pageSize: CREATED_TIME_REPORT_PAGE_SIZE, recordsExamined: 0, recordsMatched: 0, recordsReturned: 0, duplicateRecordsRemoved: 0, complete: false, truncated: false, nextPage: null, stopReason: "fetchError" };
  let page = 1; let done = false;
  while (!done) {
    if (page > maxPageLimit) { pagination.complete = false; pagination.truncated = true; pagination.nextPage = page; pagination.stopReason = "maxPagesReached"; warnings.push("Configured pagination depth reached; results are partial."); break; }
    if (!hasExecutionBudgetFor(1)) { errors.push({ stage: "fetchPage", page, errorType: "budget", message: "Execution subrequest budget exhausted before fetching the next page.", retryable: true, attempts: 0 }); pagination.complete = false; pagination.truncated = true; pagination.nextPage = page; pagination.stopReason = "executionBudgetExhausted"; warnings.push("Execution budget reached before all pages were fetched; results are partial."); break; }
    const input: ListInfoInput = { page, pageSize: CREATED_TIME_REPORT_PAGE_SIZE, sort: buildTicketSort(), condition };
    if (!condition) delete input.condition;
    const pageResult = await fetchTicketPage(client, input, effective.fetchFields, page);
    if (pageResult.error) { errors.push(pageResult.error); pagination.complete = false; pagination.truncated = true; pagination.nextPage = page; pagination.stopReason = "fetchError"; break; }
    const ticketList = pageResult.response?.getTicketList; const tickets = ticketList?.tickets ?? [];
    pagination.pagesFetched += 1; pagination.apiTotalCount ??= ticketList?.listInfo?.totalCount; pagination.pageSize = Math.min(ticketList?.listInfo?.pageSize ?? CREATED_TIME_REPORT_PAGE_SIZE, CREATED_TIME_REPORT_PAGE_SIZE);
    if (tickets.length === 0) { pagination.complete = true; pagination.stopReason = "emptyPage"; break; }
    const signature = tickets.map((ticket) => ticket.ticketId || ticket.displayId || "").join("|");
    if (seenPages.has(signature)) { pagination.complete = false; pagination.truncated = true; pagination.nextPage = page; pagination.stopReason = "repeatedPageLoop"; warnings.push("Repeated ticket page detected; results are partial."); break; }
    seenPages.add(signature);
    let crossedLowerBoundary = false;
    for (const ticket of tickets) {
      pagination.recordsExamined += 1;
      const createdMs = parseTicketCreatedMs(ticket.createdTime); if (createdMs === undefined) continue;
      if (createdMs >= effective.createdToMs) continue;
      if (createdMs < effective.createdFromMs) { crossedLowerBoundary = true; continue; }
      if (recordsById.has(ticket.ticketId)) { pagination.duplicateRecordsRemoved += 1; continue; }
      const normalized = normaliseReportingTicket(ticket, effective.fetchFields); recordsById.set(ticket.ticketId, normalized); rangeMatched.push(normalized); pagination.recordsMatched += 1;
      if (rangeMatched.length >= effective.maxRecords) { pagination.complete = false; pagination.truncated = true; pagination.nextPage = page + 1; pagination.stopReason = "maxRecordsReached"; done = true; break; }
    }
    if (done) break;
    if (crossedLowerBoundary) { pagination.complete = true; pagination.stopReason = "crossedCreatedFromBoundary"; break; }
    if (!ticketList?.listInfo?.hasMore) { pagination.complete = true; pagination.stopReason = "hasMoreFalse"; break; }
    if (page >= maxPageLimit) { pagination.complete = false; pagination.truncated = true; pagination.nextPage = page + 1; pagination.stopReason = "maxPagesReached"; break; }
    page += 1;
  }
  const filtered = applyLocalFilters(rangeMatched, params);
  const returned = effective.sortOrder === "ASC" ? [...filtered].sort((a, b) => a.createdTime.localeCompare(b.createdTime)) : filtered;
  pagination.recordsReturned = returned.length;
  if (pagination.apiTotalCount !== undefined && pagination.pagesFetched > 0) warnings.push("SuperOps totalCount is for the server-side status-filtered list, not the created-time window. Completeness is determined by crossing the createdFrom boundary.");
  return { responseVersion: 1, queryWindow: { createdFrom: effective.createdFrom, createdTo: effective.createdTo, boundarySemantics: "createdFromInclusiveCreatedToExclusive", timeField: "createdTime" }, sort: [{ attribute: "createdTime", order: "DESC", effectiveReturnOrder: effective.sortOrder }], fieldProfile: effective.fieldProfile, fields: effective.outputFields, records: returned.map((record) => pickTicketFields(record, effective.outputFields)), pagination, filterExecution: buildFilterExecution(params), warnings, errors, retryDiagnostics };
}
export function normaliseReportingTicket(ticket: Ticket, fields: readonly string[] = FIELD_PROFILES.reporting): NormalizedReportingTicket {
  const normalized: NormalizedReportingTicket = { ticketId: ticket.ticketId, displayId: ticket.displayId, subject: ticket.subject, createdTime: ticket.createdTime ?? "" };
  for (const field of fields) {
    switch (field) {
      case "client": case "requester": case "technician": case "techGroup": normalized[field] = normaliseIdentity(ticket[field]); break;
      default: normalized[field] = (ticket as unknown as Record<string, unknown>)[field] ?? null;
    }
  }
  return normalized;
}

export async function aggregateTicketReport(client: QueryableClient, params: HistoricalTicketReportParams): Promise<TicketReportResult> {
  const timezone = params.timezone ?? "UTC"; validateTimezone(timezone);
  if (params.timeField && params.timeField !== "createdTime") throw new Error("Unsupported first-version timeField: only createdTime is supported.");
  const groupBy = Array.isArray(params.groupBy) ? params.groupBy : [];
  const invalidGroups = groupBy.filter((group) => !GROUP_BY_FIELDS.includes(group));
  if (invalidGroups.length > 0) throw new Error(`Unsupported groupBy field(s): ${invalidGroups.join(", ")}`);
  if (groupBy.length > 2) throw new Error("superops_tickets_report supports at most two groupBy dimensions.");
  const interval = params.interval ?? "day";
  if (!["hour", "day", "week", "month", "none"].includes(interval)) throw new Error(`Unsupported interval: ${interval}`);
  const query = await fetchTicketsPaginated(client, { ...params, fieldProfile: "reporting", fields: [...FIELD_PROFILES.reporting], maxRecords: params.maxRecords ?? DEFAULT_REPORT_MAX_RECORDS, maxPages: params.maxPages ?? DEFAULT_REPORT_MAX_PAGES, sortOrder: "ASC", timeField: "createdTime" });
  const records = query.records; const topN = clampInteger(params.topN, 20, 1, 100);
  const series = buildSeries(records, interval, timezone, params.includeZeroBuckets ?? false, query.queryWindow.createdFrom, query.queryWindow.createdTo);
  const breakdowns = Object.fromEntries(groupBy.map((dimension) => [dimension, breakdown(records, dimension, topN)]));
  const rows = groupBy.length > 0 ? buildRows(records, interval, timezone, groupBy) : undefined;
  const samples = params.includeSampleTickets ? buildSamples(records, groupBy, clampInteger(params.sampleSizePerGroup, 1, 1, 3)) : undefined;
  return { responseVersion: 1, queryWindow: { createdFrom: query.queryWindow.createdFrom, createdTo: query.queryWindow.createdTo, timezone, timeField: "createdTime", boundarySemantics: "createdFromInclusiveCreatedToExclusive" }, totals: { tickets: records.length }, series, breakdowns, rows, samples, pagination: { ...query.pagination, recordsAnalysed: records.length }, filterExecution: query.filterExecution, technicianSemantics: "currentAssigneeAtQueryTime", warnings: query.warnings, errors: query.errors, retryDiagnostics: query.retryDiagnostics };
}
function buildTicketListQuery(fields: string[]): string {
  const selection = unique(fields).filter((field) => SAFE_TICKET_FIELDS.has(field)).join("\n          ");
  return `query getTicketList($input: ListInfoInput!) { getTicketList(input: $input) { tickets { ${selection} } listInfo { page pageSize hasMore totalCount } } }`;
}
function parseIsoDateTime(value: unknown, field: string): { iso: string; ms: number } {
  if (typeof value !== "string" || !ISO_DATE_TIME.test(value)) throw new Error(`${field} must be an ISO 8601 date-time with timezone, such as 2026-07-16T00:00:00+01:00.`);
  const ms = Date.parse(value); if (!Number.isFinite(ms)) throw new Error(`${field} must be a valid ISO 8601 date-time.`);
  return { iso: new Date(ms).toISOString(), ms };
}
function parseTicketCreatedMs(value: unknown): number | undefined { if (typeof value !== "string") return undefined; const ms = Date.parse(value); return Number.isFinite(ms) ? ms : undefined; }
function cleanStringArray(value: unknown): string[] { return Array.isArray(value) ? value.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean) : []; }
function unique<T>(items: readonly T[]): T[] { return [...new Set(items)]; }
function clampInteger(value: unknown, defaultValue: number, min: number, max: number): number { if (typeof value !== "number" || !Number.isFinite(value)) return defaultValue; return Math.min(max, Math.max(min, Math.trunc(value))); }
function buildFilterExecution(params: HistoricalTicketQueryParams): Record<string, "server" | "local"> {
  const execution: Record<string, "server" | "local"> = {}; if (cleanStringArray(params.status).length > 0) execution.status = "server";
  for (const key of LOCAL_FILTER_KEYS) if (cleanStringArray(params[key]).length > 0) execution[key] = "local";
  return execution;
}
function applyLocalFilters(records: NormalizedReportingTicket[], params: HistoricalTicketQueryParams): NormalizedReportingTicket[] {
  return records.filter((record) => matchesValues(record.priority, params.priorities) && matchesIdentity(record.client, params.clientIds, params.clientNames) && matchesIdentity(record.technician, params.technicianIds, params.technicianNames) && matchesValues(record.source, params.sources) && matchesValues(record.requestType, params.requestTypes) && matchesValues(record.category, params.categories) && matchesValues(record.subcategory, params.subcategories) && matchesIdentity(record.techGroup, params.techGroups, params.techGroups));
}
function matchesValues(actual: unknown, expected: unknown): boolean { const values = cleanStringArray(expected).map(normaliseComparable); return values.length === 0 || values.includes(normaliseComparable(actual)); }
function matchesIdentity(identity: NormalizedIdentity | null | undefined, ids: unknown, names: unknown): boolean {
  const idValues = cleanStringArray(ids).map(normaliseComparable); const nameValues = cleanStringArray(names).map(normaliseComparable);
  if (idValues.length === 0 && nameValues.length === 0) return true;
  return Boolean((identity?.id && idValues.includes(normaliseComparable(identity.id))) || (identity?.name && nameValues.includes(normaliseComparable(identity.name))));
}
function normaliseComparable(value: unknown): string { return typeof value === "string" ? value.trim().toLowerCase() : ""; }
function normaliseIdentity(value: SuperOpsJson | undefined): NormalizedIdentity | null {
  if (value === null || value === undefined) return null; if (typeof value === "string") return value.trim() ? { name: value.trim() } : null;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, SuperOpsJson>; const first = stringValue(record.firstName); const last = stringValue(record.lastName); const fullName = [first, last].filter(Boolean).join(" ").trim();
  const identity = { id: firstString(record, ["id", "accountId", "clientId", "userId", "technicianId", "groupId"]), name: firstString(record, ["name", "displayName", "fullName", "value", "label"]) ?? (fullName || undefined), email: firstString(record, ["email", "emailId", "emailAddress"]) };
  return identity.id || identity.name || identity.email ? identity : null;
}
function firstString(record: Record<string, SuperOpsJson>, keys: string[]): string | undefined { for (const key of keys) { const value = stringValue(record[key]); if (value) return value; } return undefined; }
function stringValue(value: SuperOpsJson | undefined): string | undefined { return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined; }
function pickTicketFields(record: NormalizedReportingTicket, fields: string[]): NormalizedReportingTicket { const picked: Record<string, unknown> = {}; for (const field of fields) picked[field] = record[field] ?? null; return picked as NormalizedReportingTicket; }
function isRetryable(error: unknown): boolean {
  if (error instanceof SuperOpsHttpError) return error.status === 429 || (error.status >= 500 && error.status <= 599);
  if (error instanceof SuperOpsError) { const code = error.code?.toLowerCase() ?? ""; return code.includes("rate") || code.includes("timeout") || code.includes("internal"); }
  const status = typeof error === "object" && error !== null ? (error as { status?: unknown }).status : undefined; return status === 429 || (typeof status === "number" && status >= 500 && status <= 599);
}
function errorType(error: unknown): FetchErrorDiagnostic["errorType"] { if (error instanceof SuperOpsHttpError) { if (error.status === 429) return "rateLimit"; if (error.status >= 500) return "server"; } if (error instanceof SuperOpsError) return "graphql"; const status = typeof error === "object" && error !== null ? (error as { status?: unknown }).status : undefined; if (status === 429) return "rateLimit"; if (typeof status === "number" && status >= 500) return "server"; return "network"; }
function safeErrorMessage(error: unknown): string { return error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300); }

function validateTimezone(timezone: string): void { try { new Intl.DateTimeFormat("en-GB", { timeZone: timezone }).format(new Date()); } catch { throw new Error(`Unsupported IANA timezone: ${timezone}`); } }
function buildSeries(records: NormalizedReportingTicket[], interval: Interval, timezone: string, includeZeroBuckets: boolean, fromIso: string, toIso: string): { bucketStart: string; bucketEnd: string; count: number }[] {
  if (interval === "none") return [];
  const counts = new Map<string, { start: ZonedParts; end: ZonedParts; count: number }>();
  for (const record of records) { const bucket = bucketForInstant(record.createdTime, interval, timezone); const existing = counts.get(bucket.key); if (existing) existing.count += 1; else counts.set(bucket.key, { start: bucket.start, end: bucket.end, count: 1 }); }
  if (includeZeroBuckets) for (const bucket of bucketsBetween(fromIso, toIso, interval, timezone)) if (!counts.has(bucket.key)) counts.set(bucket.key, { start: bucket.start, end: bucket.end, count: 0 });
  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, bucket]) => ({ bucketStart: localIso(bucket.start, timezone), bucketEnd: localIso(bucket.end, timezone), count: bucket.count }));
}
function breakdown(records: NormalizedReportingTicket[], dimension: GroupByField, topN: number): { key: string; count: number; percentage: number }[] {
  const counts = new Map<string, number>(); for (const record of records) { const key = groupValue(record, dimension); counts.set(key, (counts.get(key) ?? 0) + 1); }
  const total = records.length || 1; return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, topN).map(([key, count]) => ({ key, count, percentage: Math.round((count / total) * 10000) / 100 }));
}
function buildRows(records: NormalizedReportingTicket[], interval: Interval, timezone: string, groupBy: GroupByField[]): Record<string, unknown>[] {
  const rows = new Map<string, Record<string, unknown> & { count: number }>();
  for (const record of records) {
    const bucket = interval === "none" ? undefined : bucketForInstant(record.createdTime, interval, timezone); const values = Object.fromEntries(groupBy.map((dimension) => [dimension, groupValue(record, dimension)])); const key = JSON.stringify({ bucket: bucket?.key, values });
    const existing = rows.get(key); if (existing) existing.count += 1; else rows.set(key, { ...(bucket ? { bucketStart: localIso(bucket.start, timezone), bucketEnd: localIso(bucket.end, timezone) } : {}), ...values, count: 1 });
  }
  return [...rows.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
function buildSamples(records: NormalizedReportingTicket[], groupBy: GroupByField[], sampleSize: number): Record<string, { key: string; tickets: { displayId?: string | null; subject?: string | null; createdTime: string; client?: string; source?: string | null; technician?: string }[] }[]> {
  const dimensions = groupBy.length > 0 ? groupBy : (["client"] as GroupByField[]);
  return Object.fromEntries(dimensions.map((dimension) => { const buckets = new Map<string, { displayId?: string | null; subject?: string | null; createdTime: string; client?: string; source?: string | null; technician?: string }[]>(); for (const record of records) { const key = groupValue(record, dimension); const samples = buckets.get(key) ?? []; if (samples.length < sampleSize) samples.push({ displayId: record.displayId, subject: record.subject, createdTime: record.createdTime, client: record.client?.name, source: record.source, technician: record.technician?.name }); buckets.set(key, samples); } return [dimension, [...buckets.entries()].map(([key, tickets]) => ({ key, tickets }))]; }));
}
function groupValue(record: NormalizedReportingTicket, dimension: GroupByField): string { const value = record[dimension]; if (dimension === "client" || dimension === "technician" || dimension === "techGroup") { const identity = value as NormalizedIdentity | null | undefined; return identity?.name || identity?.id || "Unassigned"; } return typeof value === "string" && value.trim().length > 0 ? value.trim() : "Unspecified"; }
interface ZonedParts { year: number; month: number; day: number; hour: number; minute: number; second: number }
function bucketForInstant(iso: string, interval: Interval, timezone: string): { key: string; start: ZonedParts; end: ZonedParts } { const parts = zonedParts(new Date(iso), timezone); const start = floorParts(parts, interval); const end = addInterval(start, interval); return { key: partsKey(start, interval), start, end }; }
function bucketsBetween(fromIso: string, toIso: string, interval: Interval, timezone: string): { key: string; start: ZonedParts; end: ZonedParts }[] {
  const buckets: { key: string; start: ZonedParts; end: ZonedParts }[] = []; let start = floorParts(zonedParts(new Date(fromIso), timezone), interval); const endLimit = zonedParts(new Date(toIso), timezone); let guard = 0;
  while (compareParts(start, endLimit) < 0 && guard < 20000) { const end = addInterval(start, interval); buckets.push({ key: partsKey(start, interval), start, end }); start = end; guard += 1; }
  return buckets;
}
function zonedParts(date: Date, timezone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second) };
}
function floorParts(parts: ZonedParts, interval: Interval): ZonedParts {
  switch (interval) { case "hour": return { ...parts, minute: 0, second: 0 }; case "day": return { ...parts, hour: 0, minute: 0, second: 0 }; case "week": { const utcDay = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay(); const daysSinceMonday = (utcDay + 6) % 7; const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day - daysSinceMonday)); return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: 0, minute: 0, second: 0 }; } case "month": return { year: parts.year, month: parts.month, day: 1, hour: 0, minute: 0, second: 0 }; case "none": return parts; }
}
function addInterval(parts: ZonedParts, interval: Interval): ZonedParts { const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)); switch (interval) { case "hour": date.setUTCHours(date.getUTCHours() + 1); break; case "day": date.setUTCDate(date.getUTCDate() + 1); break; case "week": date.setUTCDate(date.getUTCDate() + 7); break; case "month": date.setUTCMonth(date.getUTCMonth() + 1); break; case "none": break; } return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: date.getUTCHours(), minute: date.getUTCMinutes(), second: date.getUTCSeconds() }; }
function partsKey(parts: ZonedParts, interval: Interval): string { const date = `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}`; return interval === "hour" ? `${date}T${pad(parts.hour)}` : date; }
function localIso(parts: ZonedParts, timezone: string): string { const utcMs = zonedLocalToUtcMs(parts, timezone); return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}${offsetForInstant(new Date(utcMs), timezone)}`; }
function zonedLocalToUtcMs(parts: ZonedParts, timezone: string): number { let guess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second); for (let i = 0; i < 4; i += 1) { const actual = zonedParts(new Date(guess), timezone); const desiredAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second); const actualAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second); const diff = desiredAsUtc - actualAsUtc; if (diff === 0) break; guess += diff; } return guess; }
function offsetForInstant(date: Date, timezone: string): string { const formatter = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, timeZoneName: "shortOffset", hour: "2-digit" }); const value = formatter.formatToParts(date).find((part) => part.type === "timeZoneName")?.value ?? "GMT"; if (value === "GMT") return "Z"; const match = value.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/); return match ? `${match[1]}${pad(Number(match[2]))}:${pad(Number(match[3] ?? "0"))}` : "Z"; }
function compareParts(a: ZonedParts, b: ZonedParts): number { return Date.UTC(a.year, a.month - 1, a.day, a.hour, a.minute, a.second) - Date.UTC(b.year, b.month - 1, b.day, b.hour, b.minute, b.second); }
function pad(value: number, length = 2): string { return String(value).padStart(length, "0"); }
