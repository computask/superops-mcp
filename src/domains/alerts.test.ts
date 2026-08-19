/**
 * Alerts Domain Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../client.js", () => ({
  getClient: vi.fn(() => ({
    query: vi.fn(),
    mutate: vi.fn(),
  })),
}));

import { getClient } from "../client.js";
import { getAlertsTools } from "./alerts.js";

const BAD_OPERATORS = ["EQUALS", "IN", "IS_EMPTY"];

function activeAlert(overrides: Record<string, unknown> = {}) {
  return {
    id: "alert-1",
    message: "CPU high",
    createdTime: "2026-06-25T10:00:00",
    status: "Open",
    severity: "High",
    description: "CPU exceeded threshold",
    asset: {
      assetId: "asset-1",
      name: "Server 1",
      client: { name: "TaskGroup" },
      site: { name: "HQ" },
      owner: { name: "Owner User", email: "owner@example.test" },
    },
    policy: { name: "CPU Policy", type: "Performance" },
    occurrenceCount: 2,
    ...overrides,
  };
}

describe("Alerts Domain", () => {
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

  it("returns the expected public alert tools with descriptions", () => {
    const domain = getAlertsTools();
    expect(domain.tools.map((tool) => tool.name)).toEqual([
      "superops_alerts_list",
      "superops_alerts_get",
      "superops_alerts_for_asset",
      "superops_alerts_resolve",
      "superops_alerts_create",
      "superops_alerts_summary",
    ]);
    expect(domain.tools.every((tool) => tool.description.length > 0)).toBe(true);
  });

  it("lists active alerts with status Open using lower-case is and default sort", async () => {
    mockClient.query.mockResolvedValue({
      getAlertList: {
        alerts: [activeAlert({ updatedTime: "2026-06-25T10:05:00" })],
        listInfo: { page: 1, pageSize: 25, totalCount: 1 },
      },
    });

    const domain = getAlertsTools();
    const result = await domain.handleCall("superops_alerts_list", {
      activeOnly: true,
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(mockClient.query).toHaveBeenCalledWith(expect.stringContaining("getAlertList"), {
      input: {
        page: 1,
        pageSize: 25,
        sort: [{ attribute: "createdTime", order: "DESC" }],
        condition: { attribute: "status", operator: "is", value: "Open" },
      },
    });
    const serializedInput = JSON.stringify(mockClient.query.mock.calls[0][1]);
    for (const bad of BAD_OPERATORS) {
      expect(serializedInput).not.toContain(bad);
    }
    expect(parsed.alerts[0]).toMatchObject({
      id: "alert-1",
      updatedTime: "2026-06-25T10:05:00",
      clientName: "TaskGroup",
      siteName: "HQ",
      assetName: "Server 1",
      assetId: "asset-1",
      policyName: "CPU Policy",
      policyType: "Performance",
      ownerName: "Owner User",
      ownerEmail: "owner@example.test",
    });
    expect(parsed.listInfo).toEqual({ page: 1, pageSize: 25, totalCount: 1 });
    expect(parsed.evidence).toMatchObject({
      evidenceType: "current_rmm_alert",
      live: true,
      causalInference: "not_proven",
      exactAssetCorrelationStrongerThanClientCorrelation: true,
      freeTextAssetInferenceAllowed: false,
    });
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });

  it("uses explicit status with lower-case is and caps pageSize", async () => {
    mockClient.query.mockResolvedValue({
      getAlertList: {
        alerts: [],
        listInfo: { page: 2, pageSize: 500, totalCount: 0 },
      },
    });

    const domain = getAlertsTools();
    await domain.handleCall("superops_alerts_list", {
      status: "Resolved",
      page: 2,
      pageSize: 9999,
      sortBy: "severity",
      sortOrder: "ASC",
    });

    expect(mockClient.query.mock.calls[0][1]).toEqual({
      input: {
        page: 2,
        pageSize: 500,
        sort: [{ attribute: "severity", order: "ASC" }],
        condition: { attribute: "status", operator: "is", value: "Resolved" },
      },
    });
  });

  it("returns validation when activeOnly and status are both supplied", async () => {
    const domain = getAlertsTools();
    const result = await domain.handleCall("superops_alerts_list", {
      activeOnly: true,
      status: "Resolved",
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(parsed.message).toContain("Use either activeOnly=true or status");
    expect(mockClient.query).not.toHaveBeenCalled();
  });

  it("applies severity and asset filters client-side and clears unreliable totals", async () => {
    mockClient.query.mockResolvedValue({
      getAlertList: {
        alerts: [
          activeAlert({ id: "alert-1", severity: "High", asset: { assetId: "asset-1" } }),
          activeAlert({ id: "alert-2", severity: "Low", asset: { assetId: "asset-1" } }),
          activeAlert({ id: "alert-3", severity: "High", asset: { assetId: "asset-2" } }),
        ],
        listInfo: { page: 1, pageSize: 25, hasMore: true, totalCount: 999 },
      },
    });

    const domain = getAlertsTools();
    const result = await domain.handleCall("superops_alerts_list", {
      severity: "High",
      assetId: "asset-1",
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.alerts.map((alert: { id: string }) => alert.id)).toEqual(["alert-1"]);
    expect(parsed.listInfo).toEqual({ page: 1, pageSize: 25 });
  });

  it("gets an alert by exact ID using ID condition lookup", async () => {
    mockClient.query.mockResolvedValue({
      getAlertList: {
        alerts: [activeAlert({ id: "alert-123" })],
        listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 },
      },
    });

    const domain = getAlertsTools();
    const result = await domain.handleCall("superops_alerts_get", {
      alertId: "alert-123",
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(mockClient.query.mock.calls[0][1].input.condition).toEqual({
      attribute: "id",
      operator: "is",
      value: "alert-123",
    });
    expect(parsed).toMatchObject({ found: true, alert: { id: "alert-123" } });
  });

  it("does not return a mismatched alert and falls back through recent pages", async () => {
    mockClient.query
      .mockResolvedValueOnce({
        getAlertList: {
          alerts: [activeAlert({ id: "other-alert" })],
          listInfo: { page: 1, pageSize: 5, hasMore: true, totalCount: 1 },
        },
      })
      .mockResolvedValueOnce({
        getAlertList: {
          alerts: [activeAlert({ id: "target-alert" })],
          listInfo: { page: 1, pageSize: 100, hasMore: false, totalCount: 1 },
        },
      });

    const domain = getAlertsTools();
    const result = await domain.handleCall("superops_alerts_get", {
      alertId: "target-alert",
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.alert.id).toBe("target-alert");
    expect(mockClient.query.mock.calls[1][1].input).toMatchObject({
      page: 1,
      pageSize: 100,
      sort: [{ attribute: "createdTime", order: "DESC" }],
    });
    expect(mockClient.query.mock.calls[1][1].input.condition).toBeUndefined();
  });

  it("returns not found when no exact alert ID match exists", async () => {
    mockClient.query.mockResolvedValue({
      getAlertList: {
        alerts: [],
        listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 0 },
      },
    });

    const domain = getAlertsTools();
    const result = await domain.handleCall("superops_alerts_get", {
      alertId: "missing-alert",
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed).toMatchObject({ found: false, alertId: "missing-alert", alert: null });
    expect(parsed.evidence).toMatchObject({
      evidenceType: "current_rmm_alert",
      live: true,
      causalInference: "not_proven",
      correlation: "exact_alert_id",
    });
  });

  it("lists alerts for an asset with safe status filter", async () => {
    mockClient.query.mockResolvedValue({
      getAlertsForAsset: {
        alerts: [activeAlert({ id: "asset-alert" })],
        listInfo: { page: 1, pageSize: 25, totalCount: 1 },
      },
    });

    const domain = getAlertsTools();
    const result = await domain.handleCall("superops_alerts_for_asset", {
      assetId: "asset-1",
      activeOnly: true,
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining("getAlertsForAsset"),
      {
        input: {
          assetId: "asset-1",
          listInfo: {
            page: 1,
            pageSize: 25,
            sort: [{ attribute: "createdTime", order: "DESC" }],
            condition: { attribute: "status", operator: "is", value: "Open" },
          },
        },
      }
    );
    expect(parsed.alerts[0].id).toBe("asset-alert");
    expect(parsed.evidence).toMatchObject({
      correlation: "exact_asset_id",
      assetId: "asset-1",
      live: true,
      causalInference: "not_proven",
    });
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });

  it("falls back to client-side status filtering for asset alerts if status condition fails", async () => {
    mockClient.query
      .mockRejectedValueOnce(new Error("internal server error"))
      .mockResolvedValueOnce({
        getAlertsForAsset: {
          alerts: [
            activeAlert({ id: "open-alert", status: "Open" }),
            activeAlert({ id: "resolved-alert", status: "Resolved" }),
          ],
          listInfo: { page: 1, pageSize: 25, totalCount: 2 },
        },
      });

    const domain = getAlertsTools();
    const result = await domain.handleCall("superops_alerts_for_asset", {
      assetId: "asset-1",
      status: "Open",
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(mockClient.query.mock.calls[1][1].input.listInfo.condition).toBeUndefined();
    expect(parsed.alerts.map((alert: { id: string }) => alert.id)).toEqual([
      "open-alert",
    ]);
    expect(parsed.listInfo).toEqual({ page: 1, pageSize: 25 });
  });

  it("validates alert resolution input and de-duplicates dry runs", async () => {
    const domain = getAlertsTools();
    const missing = await domain.handleCall("superops_alerts_resolve", {});
    expect(missing.isError).toBe(true);

    const dryRun = await domain.handleCall("superops_alerts_resolve", {
      alertId: "alert-1",
      alertIds: ["alert-1", "alert-2"],
      dryRun: true,
    });
    const parsed = JSON.parse(dryRun.content[0].text);

    expect(parsed).toEqual({
      dryRun: true,
      wouldResolve: [{ id: "alert-1" }, { id: "alert-2" }],
      verificationReadBound: {
        maxAlertIds: 4,
        perAlertMaxReads: 11,
        maximumReadRequests: 44,
        exactBound: true,
      },
    });
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });

  it("resolves alerts using ResolveAlertInput and verifies status changes", async () => {
    mockClient.mutate.mockResolvedValue({ resolveAlerts: true });
    mockClient.query
      .mockResolvedValueOnce({
        getAlertList: {
          alerts: [activeAlert({ id: "alert-1", status: "Resolved", resolvedTime: "now" })],
          listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 },
        },
      })
      .mockResolvedValueOnce({
        getAlertList: {
          alerts: [activeAlert({ id: "alert-2", status: "Closed" })],
          listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 },
        },
      });

    const domain = getAlertsTools();
    const result = await domain.handleCall("superops_alerts_resolve", {
      alertIds: ["alert-1", "alert-2"],
      verify: true,
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(mockClient.mutate).toHaveBeenCalledWith(
      expect.stringContaining("resolveAlerts"),
      { input: [{ id: "alert-1" }, { id: "alert-2" }] }
    );
    expect(parsed.resolved).toBe(true);
    expect(parsed.verification["alert-1"].resolved).toBe(true);
    expect(parsed.verification["alert-2"].resolved).toBe(true);
  });

  it("accepts the maximum synchronous alert resolve batch", async () => {
    mockClient.mutate.mockResolvedValue({ resolveAlerts: true });

    const result = await getAlertsTools().handleCall("superops_alerts_resolve", {
      alertIds: ["alert-1", "alert-2", "alert-3", "alert-4"],
      verify: false,
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).not.toBe(true);
    expect(parsed.requestedIds).toEqual(["alert-1", "alert-2", "alert-3", "alert-4"]);
    expect(parsed.verificationReadBound).toMatchObject({
      maxAlertIds: 4,
      perAlertMaxReads: 11,
      maximumReadRequests: 44,
      exactBound: true,
    });
    expect(mockClient.mutate).toHaveBeenCalledTimes(1);
  });

  it("rejects more than the maximum synchronous alert resolve batch before mutation", async () => {
    const result = await getAlertsTools().handleCall("superops_alerts_resolve", {
      alertIds: ["alert-1", "alert-2", "alert-3", "alert-4", "alert-5"],
      verify: false,
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(parsed).toMatchObject({
      ok: false,
      validation: "TooManyAlertIds",
      requestedCount: 5,
      maximum: 4,
      writeAttempted: false,
      writeMayHaveSucceeded: false,
    });
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });

  it("reports partial write when alert resolve verification mismatches", async () => {
    mockClient.mutate.mockResolvedValue({ resolveAlerts: true });
    mockClient.query.mockResolvedValue({
      getAlertList: {
        alerts: [activeAlert({ id: "alert-1", status: "Open" })],
        listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 },
      },
    });

    const result = await getAlertsTools().handleCall("superops_alerts_resolve", {
      alertId: "alert-1",
      verify: true,
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(parsed).toMatchObject({
      finalOutcome: "VerificationFailed",
      partialWrite: true,
      writeAttempted: true,
      writeMayHaveSucceeded: true,
    });
    expect(parsed.verification["alert-1"]).toMatchObject({ found: true, resolved: false });
  });

  it("reports partial write when alert create verification cannot find the alert", async () => {
    mockClient.mutate.mockResolvedValue({
      createAlert: activeAlert({ id: "created-alert", message: "Created" }),
    });
    mockClient.query.mockResolvedValue({
      getAlertList: {
        alerts: [],
        listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 0 },
      },
    });

    const result = await getAlertsTools().handleCall("superops_alerts_create", {
      assetId: "asset-1",
      message: "Created",
      verify: true,
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(parsed).toMatchObject({
      finalOutcome: "VerificationFailed",
      partialWrite: true,
      verification: { performed: true, possible: true, verified: false },
      writeAttempted: true,
      writeMayHaveSucceeded: true,
    });
  });
  it("validates and dry-runs alert creation", async () => {
    const domain = getAlertsTools();
    const missing = await domain.handleCall("superops_alerts_create", {
      assetId: "asset-1",
    });
    expect(missing.isError).toBe(true);

    const dryRun = await domain.handleCall("superops_alerts_create", {
      assetId: "asset-1",
      message: "Test alert",
      description: "Optional description",
      severity: "High",
      dryRun: true,
    });
    const parsed = JSON.parse(dryRun.content[0].text);

    expect(parsed).toEqual({
      dryRun: true,
      wouldCreate: {
        assetId: "asset-1",
        message: "Test alert",
        description: "Optional description",
        severity: "High",
      },
    });
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });

  it("creates an alert and verifies by returned ID", async () => {
    mockClient.mutate.mockResolvedValue({
      createAlert: activeAlert({ id: "created-alert", message: "Created" }),
    });
    mockClient.query.mockResolvedValue({
      getAlertList: {
        alerts: [activeAlert({ id: "created-alert", message: "Created" })],
        listInfo: { page: 1, pageSize: 5, hasMore: false, totalCount: 1 },
      },
    });

    const domain = getAlertsTools();
    const result = await domain.handleCall("superops_alerts_create", {
      assetId: "asset-1",
      message: "Created",
      severity: "High",
      verify: true,
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(mockClient.mutate).toHaveBeenCalledWith(
      expect.stringContaining("createAlert"),
      {
        input: {
          assetId: "asset-1",
          message: "Created",
          severity: "High",
        },
      }
    );
    expect(parsed.alert.id).toBe("created-alert");
    expect(parsed.verification.id).toBe("created-alert");
  });

  it("summarises alerts by severity, client, policy, and policy type without mutating", async () => {
    mockClient.query.mockResolvedValue({
      getAlertList: {
        alerts: [
          activeAlert({
            id: "alert-1",
            severity: "High",
            createdTime: "2026-06-25T10:00:00",
          }),
          activeAlert({
            id: "alert-2",
            severity: "Low",
            createdTime: "2026-06-25T11:00:00",
            asset: { clientName: "Client Two", name: "Asset Two" },
            policy: { policyName: "Disk Policy", policyType: "Storage" },
          }),
        ],
        listInfo: { page: 1, pageSize: 100, totalCount: 2 },
      },
    });

    const domain = getAlertsTools();
    const result = await domain.handleCall("superops_alerts_summary", {});
    const parsed = JSON.parse(result.content[0].text);

    expect(mockClient.query.mock.calls[0][1].input.condition).toEqual({
      attribute: "status",
      operator: "is",
      value: "Open",
    });
    expect(parsed.totalAlertsInspected).toBe(2);
    expect(parsed.countsBySeverity).toEqual({ High: 1, Low: 1 });
    expect(parsed.countsByClientName).toEqual({ TaskGroup: 1, "Client Two": 1 });
    expect(parsed.countsByPolicyName).toEqual({ "CPU Policy": 1, "Disk Policy": 1 });
    expect(parsed.countsByPolicyType).toEqual({ Performance: 1, Storage: 1 });
    expect(parsed.oldestAlerts[0].id).toBe("alert-1");
    expect(parsed.newestAlerts[0].id).toBe("alert-2");
    expect(parsed.evidence).toMatchObject({
      evidenceType: "current_rmm_alert",
      live: true,
      causalInference: "not_proven",
      readCompleteness: "ambiguous",
    });
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });

  it("normalises GraphQL errors into useful MCP errors", async () => {
    mockClient.query.mockRejectedValue(new Error("GraphQL failed with token=secret"));

    const domain = getAlertsTools();
    const result = await domain.handleCall("superops_alerts_list", {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("GraphQL failed");
    expect(result.content[0].text).not.toContain("secret");
  });

  it("preserves an accepted-write contract when alert verification fails", async () => {
    mockClient.mutate.mockResolvedValueOnce({
      createAlert: { id: "alert-accepted", message: "Disk alert" },
    });
    mockClient.query.mockRejectedValue(new Error("verification unavailable"));
    const result = await getAlertsTools().handleCall("superops_alerts_create", {
      assetId: "asset-1", message: "Disk alert",
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      writeAttempted: true,
      writeMayHaveSucceeded: true,
      reliableResponseReceived: true,
      replaySafe: false,
      classification: "AcceptedSynchronousWriteFollowupFailed",
    });
    expect(mockClient.mutate).toHaveBeenCalledTimes(1);
  });

  it("returns a conservative ambiguity contract for failed synchronous alert writes", async () => {
    mockClient.mutate.mockRejectedValueOnce(new Error("network response lost"));
    const result = await getAlertsTools().handleCall("superops_alerts_create", {
      assetId: "asset-1", message: "Disk alert",
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      writeAttempted: true,
      writeMayHaveSucceeded: true,
      reliableResponseReceived: false,
      replaySafe: false,
      classification: "AmbiguousSynchronousWrite",
    });
    expect(mockClient.mutate).toHaveBeenCalledTimes(1);
  });
});
