/**
 * SuperOps.ai Alerts Domain
 *
 * Tools for monitoring, retrieving, creating, and resolving alerts.
 */

import { getClient } from "../client.js";
import { sanitizeError } from "../audit.js";
import type {
  Alert,
  DomainTools,
  ListInfo,
  ListInfoInput,
  NormalizedAlert,
  SuperOpsJson,
} from "../types.js";

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 500;
const ALERT_ID_LOOKUP_PAGE_LIMIT = 10;
const ALERT_ID_LOOKUP_PAGE_SIZE = 100;
const STATUS_EQUALS_OPERATOR = "is";
const DEFAULT_SORT_BY = "createdTime";
const DEFAULT_SORT_ORDER = "DESC";

const ALERT_FIELDS = `
  id
  message
  createdTime
  status
  severity
  description
  asset
  policy
  resolvedTime
  occurrenceCount
`;

const GET_ALERT_LIST_QUERY = `
  query GetAlertList($input: ListInfoInput!) {
    getAlertList(input: $input) {
      alerts {
        ${ALERT_FIELDS}
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

const GET_ALERTS_FOR_ASSET_QUERY = `
  query GetAlertsForAsset($input: AssetDetailsListInput!) {
    getAlertsForAsset(input: $input) {
      alerts {
        ${ALERT_FIELDS}
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

const CREATE_ALERT_MUTATION = `
  mutation CreateAlert($input: CreateAlertInput!) {
    createAlert(input: $input) {
      ${ALERT_FIELDS}
    }
  }
`;

const RESOLVE_ALERTS_MUTATION = `
  mutation ResolveAlerts($input: [ResolveAlertInput]) {
    resolveAlerts(input: $input)
  }
`;

interface AlertListResponse {
  getAlertList: {
    alerts: Alert[];
    listInfo: ListInfo;
  };
}

interface AlertsForAssetResponse {
  getAlertsForAsset: {
    alerts: Alert[];
    listInfo: ListInfo;
  };
}

interface CreateAlertResponse {
  createAlert: Alert;
}

interface ResolveAlertsResponse {
  resolveAlerts: boolean;
}

type SuperOpsClientInstance = ReturnType<typeof getClient>;
type SortOrder = "ASC" | "DESC";

class AlertValidationError extends Error {}

interface AlertListParams {
  status?: string;
  activeOnly?: boolean;
  severity?: string;
  assetId?: string;
  page?: number;
  pageSize?: number;
  sortBy?: string;
  sortOrder?: SortOrder;
  includeResolved?: boolean;
}

interface AlertCreateParams {
  assetId?: string;
  message?: string;
  description?: string;
  severity?: string;
  verify?: boolean;
  dryRun?: boolean;
}

interface AlertResolveParams {
  alertId?: string;
  alertIds?: string[];
  verify?: boolean;
  dryRun?: boolean;
}

function errorResult(message: string, details?: Record<string, unknown>) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            ok: false,
            message,
            ...details,
          },
          null,
          2
        ),
      },
    ],
    isError: true,
  };
}

function alertErrorMessage(error: unknown): string {
  return sanitizeError(error).replace(
    /\b(token|secret|password|api[_-]?key)\b\s*[:=]\s*["']?[^"',\s}]+/gi,
    "[redacted credential/token]"
  );
}

function textResult(value: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstStringFromRecord(
  record: Record<string, unknown> | undefined,
  keys: string[]
): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = stringValue(record[key]);
    if (value) return value;
  }
  return undefined;
}

function nestedRecord(
  record: Record<string, unknown> | undefined,
  keys: string[]
): Record<string, unknown> | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const nested = jsonRecord(record[key]);
    if (nested) return nested;
  }
  return undefined;
}

function firstName(record: Record<string, unknown> | undefined): string | undefined {
  const direct = firstStringFromRecord(record, [
    "name",
    "displayName",
    "fullName",
    "email",
  ]);
  if (direct) return direct;

  const first = stringValue(record?.firstName) ?? "";
  const last = stringValue(record?.lastName) ?? "";
  const combined = `${first} ${last}`.trim();
  return combined || undefined;
}

function normalizeAlert(alert: Alert): NormalizedAlert {
  const asset = jsonRecord(alert.asset);
  const policy = jsonRecord(alert.policy);
  const client = nestedRecord(asset, ["client", "account", "company"]);
  const site = nestedRecord(asset, ["site", "location"]);
  const owner = nestedRecord(asset, ["owner", "requester", "user", "assignedUser"]);

  return {
    id: alert.id,
    message: alert.message,
    createdTime: alert.createdTime,
    status: alert.status,
    severity: alert.severity,
    description: alert.description,
    asset: alert.asset,
    policy: alert.policy,
    resolvedTime: alert.resolvedTime,
    occurrenceCount: alert.occurrenceCount,
    clientName:
      firstStringFromRecord(asset, ["clientName", "accountName", "companyName"]) ??
      firstName(client),
    siteName: firstStringFromRecord(asset, ["siteName", "locationName"]) ?? firstName(site),
    assetName: firstStringFromRecord(asset, ["name", "assetName", "hostName", "hostname"]),
    assetId: firstStringFromRecord(asset, ["assetId", "id"]),
    policyName: firstStringFromRecord(policy, ["name", "policyName", "displayName"]),
    policyType: firstStringFromRecord(policy, ["type", "policyType", "category"]),
    ownerName:
      firstStringFromRecord(asset, ["ownerName", "requesterName"]) ?? firstName(owner),
    ownerEmail:
      firstStringFromRecord(asset, ["ownerEmail", "requesterEmail"]) ??
      firstStringFromRecord(owner, ["email"]),
  };
}

function normalizeAlerts(alerts: Alert[]): NormalizedAlert[] {
  return alerts.map(normalizeAlert);
}

function pageSize(value: unknown, fallback = DEFAULT_PAGE_SIZE): number {
  const parsed = typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : fallback;
  return Math.min(Math.max(parsed, 1), MAX_PAGE_SIZE);
}

function pageNumber(value: unknown): number {
  const parsed = typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : DEFAULT_PAGE;
  return Math.max(parsed, 1);
}

function sortOrder(value: unknown): SortOrder {
  return value === "ASC" || value === "DESC" ? value : DEFAULT_SORT_ORDER;
}

function statusCondition(status: string): NonNullable<ListInfoInput["condition"]> {
  return {
    attribute: "status",
    operator: STATUS_EQUALS_OPERATOR,
    value: status,
  };
}

function idCondition(alertId: string): NonNullable<ListInfoInput["condition"]> {
  return {
    attribute: "id",
    operator: STATUS_EQUALS_OPERATOR,
    value: alertId,
  };
}

function buildAlertListInput(params: AlertListParams): {
  input?: ListInfoInput;
  error?: string;
  clientFilters: { severity?: string; assetId?: string };
} {
  if (params.activeOnly === true && stringValue(params.status)) {
    return {
      error:
        "Use either activeOnly=true or status, not both. activeOnly maps to status Open.",
      clientFilters: {},
    };
  }

  const status = params.activeOnly === true
    ? "Open"
    : stringValue(params.status) ??
      (params.includeResolved === true ? undefined : undefined);
  const input: ListInfoInput = {
    page: pageNumber(params.page),
    pageSize: pageSize(params.pageSize),
    sort: [
      {
        attribute: stringValue(params.sortBy) ?? DEFAULT_SORT_BY,
        order: sortOrder(params.sortOrder),
      },
    ],
  };
  if (status) {
    input.condition = statusCondition(status);
  }

  return {
    input,
    clientFilters: {
      severity: stringValue(params.severity),
      assetId: stringValue(params.assetId),
    },
  };
}

function buildAssetAlertsInput(params: AlertListParams & { assetId: string }): {
  input?: { assetId: string; listInfo: ListInfoInput };
  error?: string;
  clientFilters: { status?: string };
} {
  if (params.activeOnly === true && stringValue(params.status)) {
    return {
      error:
        "Use either activeOnly=true or status, not both. activeOnly maps to status Open.",
      clientFilters: {},
    };
  }

  const status = params.activeOnly === true ? "Open" : stringValue(params.status);
  const listInfo: ListInfoInput = {
    page: pageNumber(params.page),
    pageSize: pageSize(params.pageSize),
    sort: [
      {
        attribute: stringValue(params.sortBy) ?? DEFAULT_SORT_BY,
        order: sortOrder(params.sortOrder),
      },
    ],
  };
  if (status) {
    listInfo.condition = statusCondition(status);
  }

  return {
    input: { assetId: params.assetId, listInfo },
    clientFilters: {},
  };
}

function applyClientFilters(
  alerts: NormalizedAlert[],
  filters: { severity?: string; assetId?: string; status?: string }
): NormalizedAlert[] {
  return alerts.filter((alert) => {
    if (filters.severity && alert.severity !== filters.severity) return false;
    if (filters.status && alert.status !== filters.status) return false;
    if (filters.assetId && alert.assetId !== filters.assetId) {
      const asset = jsonRecord(alert.asset);
      if (firstStringFromRecord(asset, ["assetId", "id"]) !== filters.assetId) {
        return false;
      }
    }
    return true;
  });
}

function clearUnreliableListInfo(
  listInfo: ListInfo,
  appliedClientFilters: boolean
): ListInfo {
  if (!appliedClientFilters) return listInfo;
  return {
    page: listInfo.page,
    pageSize: listInfo.pageSize,
  };
}

async function queryAlertList(
  client: SuperOpsClientInstance,
  params: AlertListParams
): Promise<{ alerts: NormalizedAlert[]; listInfo: ListInfo; input: ListInfoInput }> {
  const built = buildAlertListInput(params);
  if (built.error || !built.input) {
    throw new AlertValidationError(built.error ?? "Invalid alert list input.");
  }

  const response = await client.query<AlertListResponse>(GET_ALERT_LIST_QUERY, {
    input: built.input,
  });
  const normalized = normalizeAlerts(response.getAlertList.alerts ?? []);
  const filtered = applyClientFilters(normalized, built.clientFilters);
  const clientFiltered = Boolean(built.clientFilters.severity || built.clientFilters.assetId);

  return {
    alerts: filtered,
    listInfo: clearUnreliableListInfo(response.getAlertList.listInfo, clientFiltered),
    input: built.input,
  };
}

async function queryAlertsForAsset(
  client: SuperOpsClientInstance,
  params: AlertListParams & { assetId: string }
): Promise<{ alerts: NormalizedAlert[]; listInfo: ListInfo; input: unknown }> {
  const built = buildAssetAlertsInput(params);
  if (built.error || !built.input) {
    throw new AlertValidationError(built.error ?? "Invalid asset alert input.");
  }

  try {
    const response = await client.query<AlertsForAssetResponse>(
      GET_ALERTS_FOR_ASSET_QUERY,
      { input: built.input }
    );
    return {
      alerts: normalizeAlerts(response.getAlertsForAsset.alerts ?? []),
      listInfo: response.getAlertsForAsset.listInfo,
      input: built.input,
    };
  } catch (error) {
    const condition = built.input.listInfo.condition;
    if (!condition) throw error;

    const fallbackInput = {
      ...built.input,
      listInfo: {
        ...built.input.listInfo,
        condition: undefined,
      },
    };
    const response = await client.query<AlertsForAssetResponse>(
      GET_ALERTS_FOR_ASSET_QUERY,
      { input: fallbackInput }
    );
    const status = stringValue((condition as { value?: unknown }).value);
    const alerts = applyClientFilters(normalizeAlerts(response.getAlertsForAsset.alerts ?? []), {
      status,
    });
    return {
      alerts,
      listInfo: clearUnreliableListInfo(response.getAlertsForAsset.listInfo, Boolean(status)),
      input: fallbackInput,
    };
  }
}

async function findAlertByIdWithCondition(
  client: SuperOpsClientInstance,
  alertId: string
): Promise<NormalizedAlert | undefined> {
  const response = await client.query<AlertListResponse>(GET_ALERT_LIST_QUERY, {
    input: {
      page: 1,
      pageSize: 5,
      condition: idCondition(alertId),
      sort: [{ attribute: DEFAULT_SORT_BY, order: DEFAULT_SORT_ORDER }],
    },
  });
  return normalizeAlerts(response.getAlertList.alerts ?? []).find(
    (alert) => alert.id === alertId
  );
}

async function findAlertByIdFallback(
  client: SuperOpsClientInstance,
  alertId: string
): Promise<NormalizedAlert | undefined> {
  for (let page = 1; page <= ALERT_ID_LOOKUP_PAGE_LIMIT; page += 1) {
    const response = await client.query<AlertListResponse>(GET_ALERT_LIST_QUERY, {
      input: {
        page,
        pageSize: ALERT_ID_LOOKUP_PAGE_SIZE,
        sort: [{ attribute: DEFAULT_SORT_BY, order: DEFAULT_SORT_ORDER }],
      },
    });
    const found = normalizeAlerts(response.getAlertList.alerts ?? []).find(
      (alert) => alert.id === alertId
    );
    if (found) return found;
    if (response.getAlertList.listInfo.hasMore === false) break;
  }
}

async function findAlertById(
  client: SuperOpsClientInstance,
  alertId: string
): Promise<NormalizedAlert | undefined> {
  try {
    return (await findAlertByIdWithCondition(client, alertId)) ??
      (await findAlertByIdFallback(client, alertId));
  } catch {
    return findAlertByIdFallback(client, alertId);
  }
}

async function createAlert(
  client: SuperOpsClientInstance,
  params: Required<Pick<AlertCreateParams, "assetId" | "message">> &
    Pick<AlertCreateParams, "description" | "severity">
): Promise<NormalizedAlert> {
  const input: Record<string, string> = {
    assetId: params.assetId,
    message: params.message,
  };
  if (stringValue(params.description)) input.description = params.description!.trim();
  if (stringValue(params.severity)) input.severity = params.severity!.trim();

  const response = await client.mutate<CreateAlertResponse>(CREATE_ALERT_MUTATION, {
    input,
  });
  return normalizeAlert(response.createAlert);
}

async function resolveAlerts(
  client: SuperOpsClientInstance,
  alertIds: string[]
): Promise<boolean> {
  const response = await client.mutate<ResolveAlertsResponse>(
    RESOLVE_ALERTS_MUTATION,
    {
      input: alertIds.map((id) => ({ id })),
    }
  );
  return response.resolveAlerts;
}

function uniqueAlertIds(params: AlertResolveParams): string[] {
  const ids = [
    stringValue(params.alertId),
    ...(Array.isArray(params.alertIds) ? params.alertIds.map(stringValue) : []),
  ].filter((id): id is string => Boolean(id));
  return [...new Set(ids)];
}

function countBy(alerts: NormalizedAlert[], field: keyof NormalizedAlert) {
  const counts: Record<string, number> = {};
  for (const alert of alerts) {
    const value = stringValue(alert[field]);
    if (!value) continue;
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function compactAlert(alert: NormalizedAlert) {
  return {
    id: alert.id,
    message: alert.message,
    createdTime: alert.createdTime,
    status: alert.status,
    severity: alert.severity,
    clientName: alert.clientName,
    assetName: alert.assetName,
    policyName: alert.policyName,
  };
}

function verificationResult(alert: NormalizedAlert | undefined) {
  if (!alert) {
    return {
      found: false,
      resolved: false,
      reason: "Alert was not found during verification.",
    };
  }

  const resolved = alert.status !== "Open" || Boolean(alert.resolvedTime);
  return {
    found: true,
    resolved,
    status: alert.status,
    resolvedTime: alert.resolvedTime,
  };
}

export function getAlertsTools(): DomainTools {
  return {
    tools: [
      {
        name: "superops_alerts_list",
        description:
          "List SuperOps alerts with safe status filtering, sorting, pagination, and optional client-side severity or asset filtering.",
        inputSchema: {
          type: "object",
          properties: {
            status: { type: "string", description: "Alert status, for example Open" },
            activeOnly: {
              type: "boolean",
              description: "When true, filters status to Open using operator is",
            },
            severity: { type: "string", description: "Client-side severity filter" },
            assetId: { type: "string", description: "Client-side asset ID filter" },
            page: { type: "number", default: DEFAULT_PAGE },
            pageSize: { type: "number", default: DEFAULT_PAGE_SIZE },
            sortBy: { type: "string", default: DEFAULT_SORT_BY },
            sortOrder: { type: "string", enum: ["ASC", "DESC"], default: DEFAULT_SORT_ORDER },
            includeResolved: {
              type: "boolean",
              description:
                "When true, does not add an Open-only filter unless status is explicitly supplied.",
            },
          },
        },
      },
      {
        name: "superops_alerts_get",
        description:
          "Retrieve one SuperOps alert by exact alert ID using alert-list lookup and safe fallback paging.",
        inputSchema: {
          type: "object",
          properties: {
            alertId: { type: "string", description: "The alert ID to retrieve" },
          },
          required: ["alertId"],
        },
      },
      {
        name: "superops_alerts_for_asset",
        description: "List SuperOps alerts for a specific asset ID.",
        inputSchema: {
          type: "object",
          properties: {
            assetId: { type: "string", description: "The asset ID" },
            status: { type: "string", description: "Alert status, for example Open" },
            activeOnly: { type: "boolean", description: "Filter status to Open" },
            page: { type: "number", default: DEFAULT_PAGE },
            pageSize: { type: "number", default: DEFAULT_PAGE_SIZE },
            sortBy: { type: "string", default: DEFAULT_SORT_BY },
            sortOrder: { type: "string", enum: ["ASC", "DESC"], default: DEFAULT_SORT_ORDER },
          },
          required: ["assetId"],
        },
      },
      {
        name: "superops_alerts_resolve",
        description:
          "Write action: resolve one or more SuperOps alerts by ID. Supports dryRun and optional verification.",
        inputSchema: {
          type: "object",
          properties: {
            alertId: { type: "string", description: "Single alert ID to resolve" },
            alertIds: {
              type: "array",
              items: { type: "string" },
              description: "Alert IDs to resolve",
            },
            verify: { type: "boolean", default: true },
            dryRun: { type: "boolean", default: false },
          },
        },
      },
      {
        name: "superops_alerts_create",
        description:
          "Write action: create a new SuperOps alert for an asset. Supports dryRun and optional verification.",
        inputSchema: {
          type: "object",
          properties: {
            assetId: { type: "string", description: "Asset ID for the alert" },
            message: { type: "string", description: "Alert message" },
            description: { type: "string", description: "Optional alert description" },
            severity: { type: "string", description: "Optional alert severity" },
            verify: { type: "boolean", default: true },
            dryRun: { type: "boolean", default: false },
          },
          required: ["assetId", "message"],
        },
      },
      {
        name: "superops_alerts_summary",
        description:
          "Summarise SuperOps alerts by severity, client, policy, and policy type. Read-only.",
        inputSchema: {
          type: "object",
          properties: {
            status: { type: "string", default: "Open" },
            pageSize: { type: "number", default: 100 },
          },
        },
      },
    ],

    async handleCall(name, args) {
      const client = getClient();

      try {
        switch (name) {
          case "superops_alerts_list": {
            const result = await queryAlertList(client, args as AlertListParams);
            return textResult({ alerts: result.alerts, listInfo: result.listInfo });
          }

          case "superops_alerts_get": {
            const alertId = stringValue((args as { alertId?: unknown }).alertId);
            if (!alertId) {
              return errorResult("alertId is required.");
            }
            const alert = await findAlertById(client, alertId);
            if (!alert) {
              return textResult({ found: false, alertId, alert: null });
            }
            return textResult({ found: true, alert });
          }

          case "superops_alerts_for_asset": {
            const params = args as AlertListParams & { assetId?: unknown };
            const assetId = stringValue(params.assetId);
            if (!assetId) {
              return errorResult("assetId is required.");
            }
            const result = await queryAlertsForAsset(client, {
              ...params,
              assetId,
            });
            return textResult({ alerts: result.alerts, listInfo: result.listInfo });
          }

          case "superops_alerts_resolve": {
            const params = args as AlertResolveParams;
            const ids = uniqueAlertIds(params);
            if (ids.length === 0) {
              return errorResult("At least one alertId or alertIds value is required.");
            }
            if (params.dryRun === true) {
              return textResult({
                dryRun: true,
                wouldResolve: ids.map((id) => ({ id })),
              });
            }

            const resolved = await resolveAlerts(client, ids);
            const verification = params.verify === false
              ? undefined
              : Object.fromEntries(
                  await Promise.all(
                    ids.map(async (id) => [
                      id,
                      verificationResult(await findAlertById(client, id)),
                    ])
                  )
                );
            return textResult({
              dryRun: false,
              requestedIds: ids,
              resolved,
              verification,
            });
          }

          case "superops_alerts_create": {
            const params = args as AlertCreateParams;
            const assetId = stringValue(params.assetId);
            const message = stringValue(params.message);
            if (!assetId) {
              return errorResult("assetId is required.");
            }
            if (!message) {
              return errorResult("message is required.");
            }

            const input = {
              assetId,
              message,
              ...(stringValue(params.description)
                ? { description: params.description!.trim() }
                : {}),
              ...(stringValue(params.severity) ? { severity: params.severity!.trim() } : {}),
            };
            if (params.dryRun === true) {
              return textResult({ dryRun: true, wouldCreate: input });
            }

            const alert = await createAlert(client, input);
            const verification = params.verify === false
              ? undefined
              : alert.id
                ? await findAlertById(client, alert.id)
                : undefined;
            return textResult({ dryRun: false, alert, verification });
          }

          case "superops_alerts_summary": {
            const params = args as { status?: string; pageSize?: number };
            const result = await queryAlertList(client, {
              status: stringValue(params.status) ?? "Open",
              pageSize: pageSize(params.pageSize, 100),
              page: 1,
            });
            const byCreated = [...result.alerts].sort((a, b) =>
              (a.createdTime ?? "").localeCompare(b.createdTime ?? "")
            );
            return textResult({
              totalAlertsInspected: result.alerts.length,
              countsBySeverity: countBy(result.alerts, "severity"),
              countsByClientName: countBy(result.alerts, "clientName"),
              countsByPolicyName: countBy(result.alerts, "policyName"),
              countsByPolicyType: countBy(result.alerts, "policyType"),
              oldestAlerts: byCreated.slice(0, 5).map(compactAlert),
              newestAlerts: byCreated.slice(-5).reverse().map(compactAlert),
            });
          }

          default:
            return {
              content: [{ type: "text", text: `Unknown alerts tool: ${name}` }],
              isError: true,
            };
        }
      } catch (error) {
        if (error instanceof AlertValidationError) {
          return errorResult(error.message);
        }
        return {
          content: [{ type: "text", text: `Error: ${alertErrorMessage(error)}` }],
          isError: true,
        };
      }
    },
  };
}
