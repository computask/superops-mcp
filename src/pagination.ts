import { getExecutionConfig, hasExecutionBudgetFor } from "./execution.js";
import type { ListInfo } from "./types.js";

type QueryClient = { query<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T> };
type RecordValue = Record<string, unknown>;
function object(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
}
export function pageNumber(value: unknown, fallback = 1): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error("Pagination page and pageSize must be positive integers.");
  return value;
}
export function pageSize(value: unknown, fallback = 100): number { return Math.min(100, pageNumber(value, fallback)); }
const identities = ["ticketId", "accountId", "assetId", "userId", "technicianId", "alertId", "softwareId", "patchId", "scriptId", "id"];
function identity(value: unknown): string | undefined {
  const row = object(value);
  if (!row) return undefined;
  if (object(row.patchDetail)) return identity(row.patchDetail);
  for (const key of identities) if ((typeof row[key] === "string" && row[key] !== "") || typeof row[key] === "number") return `${key}:${row[key]}`;
  return undefined;
}

/** Only normal list reads opt in. Frozen snapshots, recent-N and exact
 * reconciliation reads keep their intentionally bounded contracts. */
export function paginatedClient<C extends QueryClient>(client: C): C {
  return new Proxy(client, { get(target, property) {
    if (property !== "query") { const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value; }
    return <T>(query: string, variables?: RecordValue) => {
      if (!/\blistInfo\s*\{/.test(query) || !variables?.input) return variables === undefined ? target.query<T>(query) : target.query<T>(query, variables);
      return fetchAllPages<T>(target, query, variables);
    };
  }});
}

export async function fetchAllPages<T>(client: QueryClient, query: string, variables: RecordValue,
  bounds: { maxPages?: number; maxRecords?: number; maxBytes?: number } = {}): Promise<T> {
  const originalInput = object(variables.input);
  if (!originalInput) throw new Error("List input is required.");
  const nested = object(originalInput.listInfo);
  const paging = nested ?? originalInput;
  const start = pageNumber(paging.page);
  const size = pageSize(paging.pageSize);
  const maxPages = Math.min(bounds.maxPages ?? 100, getExecutionConfig().maxPaginationDepth);
  const maxRecords = bounds.maxRecords ?? 5000;
  // Reserve serialization/metadata overhead below the MCP 1 MiB cap.
  const maxBytes = bounds.maxBytes ?? 600_000;
  const records: unknown[] = [];
  const ids = new Set<string>();
  const signatures = new Set<string>();
  let page = start, pages = 0, duplicates = 0;
  const containers: Record<string, string> = {getTicketList:"tickets", getClientList:"clients", getAssetList:"assets", getTechnicianList:"userList", getAlertList:"alerts", getAlertsForAsset:"alerts", getAssetSoftwareList:"assetSoftwares", getAssetPatchDetails:"assetPatches"};
  let root = Object.keys(containers).find(key => new RegExp(`\\b${key}\\s*\\(`).test(query));
  let arrayKey = root ? containers[root] : undefined;
  let template: RecordValue = {};
  let info: ListInfo = {page: start, pageSize: size};
  let complete = false, reason = "maxPagesReached";
  let total: number | undefined;
  let bytes = 0;
  while (pages < maxPages) {
    if (!hasExecutionBudgetFor(1)) { reason = "executionBudgetExhausted"; break; }
    const nextInput = nested ? {...originalInput, listInfo: {...nested, page, pageSize: size}} : {...originalInput, page, pageSize: size};
    let result: RecordValue;
    try { result = await client.query<RecordValue>(query, {...variables, input: nextInput}); }
    catch (error) {
      const exhausted = !hasExecutionBudgetFor(1) || (error instanceof Error && /Execution.*Budget/.test(error.name));
      if (!root || !arrayKey || (pages === 0 && !exhausted)) throw error;
      reason = exhausted ? "executionBudgetExhausted" : "fetchError"; break;
    }
    root ??= Object.keys(result).find(key => object(result[key])?.listInfo);
    const list = root ? object(result[root]) : undefined;
    if (!list) throw new Error("List response is missing pagination metadata.");
    template = list;
    arrayKey ??= Object.keys(list).find(key => Array.isArray(list[key]));
    if (!arrayKey) throw new Error("List response is missing records.");
    if (!Array.isArray(list[arrayKey])) { reason = "invalidPage"; break; }
    const rows = list[arrayKey] as unknown[];
    info = object(list.listInfo) ?? {};
    if ((info.page !== undefined && info.page !== page) || (info.pageSize !== undefined && info.pageSize !== size) || rows.length > size) { reason = "invalidPage"; break; }
    if (info.totalCount !== undefined) {
      if (!Number.isSafeInteger(info.totalCount) || info.totalCount < 0 || (total !== undefined && total !== info.totalCount)) { reason = "totalCountChangedOrInvalid"; break; }
      total = info.totalCount;
    }
    const rowIds = rows.map(identity);
    if (rowIds.some(id => id === undefined)) { reason = "missingStableRecordId"; break; }
    const signature = JSON.stringify(rowIds);
    if (rows.length && signatures.has(signature)) { reason = "repeatedPage"; break; }
    signatures.add(signature);
    const fresh: unknown[] = [];
    const pageIds = new Set<string>();
    rows.forEach((row, index) => {
      const id = rowIds[index]!;
      if (ids.has(id) || pageIds.has(id)) duplicates++;
      else { fresh.push(row); pageIds.add(id); }
    });
    if (rows.length && !fresh.length) { reason = "stalledPagination"; break; }
    const nextBytes = new TextEncoder().encode(JSON.stringify(fresh, null, 2)).length;
    if (records.length + fresh.length > maxRecords) { reason = "maxRecordsReached"; break; }
    if (bytes + nextBytes > maxBytes) { reason = "responseSizeLimit"; break; }
    fresh.forEach(row => { ids.add(identity(row)!); records.push(row); });
    bytes += nextBytes;
    pages++;
    const observed = (start - 1) * size + records.length;
    if (info.hasMore === false) {
      complete = total === undefined || records.length === Math.max(0, total - (start - 1) * size);
      reason = complete ? "hasMoreFalse" : "totalCountMismatch";
      page++;
      break;
    }
    if (total !== undefined && observed === total && info.hasMore !== true) { complete = true; reason = "totalCountReached"; page++; break; }
    if (!rows.length) { reason = "emptyPageWithMoreOrUnknown"; break; }
    if (info.hasMore !== true) { reason = "missingHasMore"; page++; break; }
    if (total !== undefined && observed >= total) { reason = "inconsistentHasMore"; page++; break; }
    page++;
  }
  if (!root || !arrayKey) throw new Error("Pagination stopped before any page could be fetched.");
  const continuation = complete ? undefined : { nextPage: page, pageSize: size,
    variables: {...variables, input: nested ? {...originalInput, listInfo: {...nested, page, pageSize: size}} : {...originalInput, page, pageSize: size}} };
  const metadata = {complete, truncated: !complete, nextPage: complete ? null : page, totalCount: total,
    recordsReturned: records.length, pagesFetched: pages, duplicateRecordsRemoved: duplicates,
    truncationReason: complete ? undefined : reason, continuation};
  return { [root]: {...template, [arrayKey]: records, ...metadata,
    listInfo: {...info, page: start, pageSize: size, hasMore: complete ? false : true, ...metadata}} } as T;
}

/** Enforce the upstream per-page ceiling even on custom queries. Never silently
 * rewrite GraphQL or variables at the transport boundary. */
export function assertPageBounds(query: string, variables?: RecordValue): void {
  const check = (value: unknown, key?: string): void => {
    if (key === "pageSize") { if (pageNumber(value) > 100) throw new Error("SuperOps pageSize must not exceed 100."); }
    if (key === "page" && value !== undefined) pageNumber(value);
    if (Array.isArray(value)) value.forEach(item => check(item));
    else if (object(value)) Object.entries(value as RecordValue).forEach(([name, item]) => check(item, name));
  };
  check(variables);
  // Ignore comment/string contents; they may legitimately mention pageSize.
  // Defaults in variable declarations are still inspected (including input
  // object defaults). Unresolved pagination variables fail closed.
  const source = query.replace(/"""(?:\\[\s\S]|(?!""")[\s\S])*"""|"(?:\\[\s\S]|[^"\\])*"|#[^\r\n]*/g, " ");
  const defaults = new Map<string, number>();
  for (const match of source.matchAll(/\$([A-Za-z_][A-Za-z_0-9]*)\s*:\s*Int\s*!?\s*=\s*(-?[0-9]+(?:\.[0-9]+)?)/g)) defaults.set(match[1], Number(match[2]));
  for (const match of source.matchAll(/\b(pageSize|page)\s*:\s*(\$[A-Za-z_][A-Za-z_0-9]*|-?[0-9]+(?:\.[0-9]+)?)/g)) {
    const value = match[2].startsWith("$") ? variables?.[match[2].slice(1)] ?? defaults.get(match[2].slice(1)) : Number(match[2]);
    if (value === undefined) throw new Error("Pagination variables must have an explicit valid value or Int default.");
    check(value, match[1]);
  }
}
