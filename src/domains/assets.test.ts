/**
 * Assets Domain Tests
 *
 * Tests for asset (endpoint) management tools.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

vi.mock("../client.js", () => ({
  getClient: vi.fn(() => ({
    query: vi.fn(),
    mutate: vi.fn(),
  })),
}));

import { getClient } from "../client.js";
import { getAssetsTools } from "./assets.js";

describe("Assets Domain", () => {
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

  it("returns the expected public tools", () => {
    const domain = getAssetsTools();

    expect(domain.tools.map((tool) => tool.name)).toEqual([
      "superops_assets_list",
      "superops_assets_get",
      "superops_assets_software",
      "superops_assets_patches",
    ]);
  });

  it("uses page/pageSize list variables and local filters", async () => {
    mockClient.query.mockResolvedValue({
      getAssetList: {
        assets: [
          {
            assetId: "1",
            name: "DESKTOP-001",
            status: "ONLINE",
            platform: "Microsoft Windows 11",
            client: { accountId: "client-123", name: "Acme" },
          },
          {
            assetId: "2",
            name: "MAC-001",
            status: "OFFLINE",
            platform: "macOS",
            client: { accountId: "other", name: "Other" },
          },
        ],
        listInfo: { page: 1, pageSize: 100, hasMore: false, totalCount: 2 },
      },
    });

    const domain = getAssetsTools();
    const result = await domain.handleCall("superops_assets_list", {
      status: "ONLINE",
      platform: "Windows",
      clientId: "client-123",
      max: 200,
      page: 2,
    });

    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining("getAssetList"),
      { input: { page: 2, pageSize: 200 } }
    );
    expect(mockClient.query.mock.calls[0][1].input).not.toHaveProperty("first");
    expect(mockClient.query.mock.calls[0][1].input).not.toHaveProperty("filter");
    expect(result.content[0].text).toContain("DESKTOP-001");
    expect(result.content[0].text).not.toContain("MAC-001");
  });

  it("uses documented asset fields", async () => {
    mockClient.query.mockResolvedValue({
      getAsset: {
        assetId: "asset-123",
        name: "WORKSTATION-001",
        hostName: "WORKSTATION-001",
      },
    });

    const domain = getAssetsTools();
    const result = await domain.handleCall("superops_assets_get", {
      assetId: "asset-123",
    });

    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining("getAsset"),
      { input: { assetId: "asset-123" } }
    );
    const queryArg = mockClient.query.mock.calls[0][0];
    expect(queryArg).toContain("hostName");
    expect(queryArg).toContain("lastCommunicatedTime");
    expect(queryArg).toContain("deviceCategory");
    expect(queryArg).not.toContain("ipAddress");
    expect(queryArg).not.toContain("osName");
    expect(result.content[0].text).toContain("WORKSTATION-001");
  });

  it("uses AssetDetailsListInput and assetSoftwares for software inventory", async () => {
    mockClient.query.mockResolvedValue({
      getAssetSoftwareList: {
        assetSoftwares: [
          {
            id: "software-1",
            software: { softwareId: "catalog-1", name: "Microsoft Office" },
            version: "365",
          },
          {
            id: "software-2",
            software: { softwareId: "catalog-2", name: "Chrome" },
            version: "125",
          },
        ],
        listInfo: { page: 1, pageSize: 100, hasMore: false, totalCount: 2 },
      },
    });

    const domain = getAssetsTools();
    const result = await domain.handleCall("superops_assets_software", {
      assetId: "asset-123",
      search: "office",
    });

    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining("AssetDetailsListInput"),
      {
        input: {
          assetId: "asset-123",
          listInfo: { page: 1, pageSize: 100 },
        },
      }
    );
    expect(result.content[0].text).toContain("Microsoft Office");
    expect(result.content[0].text).not.toContain("Chrome");
  });

  it("uses AssetDetailsListInput and assetPatches for patch details", async () => {
    mockClient.query.mockResolvedValue({
      getAssetPatchDetails: {
        assetPatches: [
          {
            patchDetail: {
              patchId: "patch-1",
              title: "Security Update",
              severity: "Critical",
            },
            installationStatus: "Pending",
          },
          {
            patchDetail: {
              patchId: "patch-2",
              title: "Optional Update",
              severity: "Low",
            },
            installationStatus: "Installed",
          },
        ],
        listInfo: { page: 1, pageSize: 100, hasMore: false, totalCount: 2 },
      },
    });

    const domain = getAssetsTools();
    const result = await domain.handleCall("superops_assets_patches", {
      assetId: "asset-123",
      status: "Pending",
      severity: ["Critical"],
    });

    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining("getAssetPatchDetails"),
      {
        input: {
          assetId: "asset-123",
          listInfo: { page: 1, pageSize: 100 },
        },
      }
    );
    const queryArg = mockClient.query.mock.calls[0][0];
    expect(queryArg).toContain("assetPatches");
    expect(queryArg).toContain("patchDetail");
    expect(queryArg).toContain("listInfo");
    expect(queryArg).not.toContain("summary");
    expect(result.content[0].text).toContain("Security Update");
    expect(result.content[0].text).not.toContain("Optional Update");
  });

  it("caps asset list pageSize at 500", async () => {
    mockClient.query.mockResolvedValue({
      getAssetList: {
        assets: [],
        listInfo: { page: 1, pageSize: 500, hasMore: false, totalCount: 0 },
      },
    });

    const domain = getAssetsTools();
    await domain.handleCall("superops_assets_list", { max: 1000 });

    expect(mockClient.query).toHaveBeenCalledWith(
      expect.any(String),
      { input: { page: 1, pageSize: 500 } }
    );
  });

  it("handles unknown tools and API errors", async () => {
    const domain = getAssetsTools();
    const unknown = await domain.handleCall("unknown_tool", {});
    expect(unknown.isError).toBe(true);

    mockClient.query.mockRejectedValue(new Error("Asset not found"));
    const failed = await domain.handleCall("superops_assets_get", {
      assetId: "missing",
    });
    expect(failed.isError).toBe(true);
    expect(failed.content[0].text).toContain("Asset not found");
  });
});
