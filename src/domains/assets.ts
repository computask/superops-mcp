/**
 * SuperOps.ai Assets Domain
 *
 * Tools for managing assets (endpoints) in SuperOps.ai RMM.
 */

import { getClient } from "../client.js";
import type { DomainTools, Asset, ListInfo } from "../types.js";

const DEFAULT_LIST_PAGE = 1;

const LIST_ASSETS_QUERY = `
  query getAssetList($input: ListInfoInput!) {
    getAssetList(input: $input) {
      assets {
        assetId
        name
        assetClass
        client
        site
        status
        platform
        lastCommunicatedTime
        patchStatus
        deviceCategory
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

const GET_ASSET_QUERY = `
  query getAsset($input: AssetIdentifierInput!) {
    getAsset(input: $input) {
      assetId
      name
      assetClass
      client
      site
      requester
      primaryMac
      loggedInUser
      serialNumber
      manufacturer
      model
      hostName
      publicIp
      gateway
      platform
      domain
      status
      sysUptime
      lastCommunicatedTime
      agentVersion
      platformFamily
      platformCategory
      platformVersion
      patchStatus
      warrantyExpiryDate
      purchasedDate
      customFields
      lastReportedTime
      deviceCategory
    }
  }
`;

const GET_ASSET_SOFTWARE_QUERY = `
  query getAssetSoftwareList($input: AssetDetailsListInput!) {
    getAssetSoftwareList(input: $input) {
      assetSoftwares {
        id
        software
        version
        installedDate
        bitVersion
        installedPath
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

const GET_ASSET_PATCHES_QUERY = `
  query getAssetPatchDetails($input: AssetDetailsListInput!) {
    getAssetPatchDetails(input: $input) {
      assetPatches {
        patchDetail {
          patchId
          patchKey
          title
          publishedDate
          category
          severity
          kbNumbers {
            kbNumber
          }
          restartRequired
        }
        approvalStatus
        installationTime
        installationStatus
        failedMessage
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

interface ListAssetsResponse {
  getAssetList: {
    assets: Asset[];
    listInfo: ListInfo;
  };
}

interface GetAssetResponse {
  getAsset: Asset;
}

interface Software {
  id?: string;
  software?: unknown;
  version?: string;
  installedDate?: string;
  bitVersion?: string;
  installedPath?: string;
}

interface GetSoftwareResponse {
  getAssetSoftwareList: {
    assetSoftwares: Software[];
    listInfo: ListInfo;
  };
}

interface PatchDetails {
  patchId: string;
  patchKey?: string;
  title?: string;
  publishedDate?: string;
  category?: string;
  severity?: string;
  kbNumbers?: { kbNumber?: string }[];
  restartRequired?: boolean;
}

interface PatchData {
  patchDetail?: PatchDetails;
  approvalStatus?: string;
  installationTime?: string;
  installationStatus?: string;
  failedMessage?: string;
}

interface GetPatchesResponse {
  getAssetPatchDetails: {
    assetPatches: PatchData[];
    listInfo: ListInfo;
  };
}

function pageInput(max: number | undefined, defaultPageSize: number, page?: number) {
  return {
    page: page ?? DEFAULT_LIST_PAGE,
    pageSize: Math.min(max ?? defaultPageSize, 500),
  };
}

function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function applyAssetFilters(
  assets: Asset[],
  filters: { status?: string; platform?: string; clientId?: string }
): Asset[] {
  return assets.filter((asset) => {
    if (filters.status && asset.status !== filters.status) return false;
    if (filters.platform && !asset.platform?.includes(filters.platform)) return false;

    const clientInfo = jsonRecord(asset.client);
    if (filters.clientId && clientInfo?.accountId !== filters.clientId) return false;

    return true;
  });
}

function applySoftwareSearch(assetSoftwares: Software[], search?: string): Software[] {
  if (!search) return assetSoftwares;
  const query = search.toLowerCase();

  return assetSoftwares.filter((softwareEntry) => {
    const software = jsonRecord(softwareEntry.software);
    const softwareName = typeof software?.name === "string" ? software.name : "";
    return softwareName.toLowerCase().includes(query);
  });
}

function applyPatchFilters(
  assetPatches: PatchData[],
  filters: { status?: string; severity?: string[] }
): PatchData[] {
  return assetPatches.filter((patch) => {
    if (
      filters.status &&
      patch.approvalStatus !== filters.status &&
      patch.installationStatus !== filters.status
    ) {
      return false;
    }
    if (
      filters.severity &&
      (!patch.patchDetail?.severity || !filters.severity.includes(patch.patchDetail.severity))
    ) {
      return false;
    }

    return true;
  });
}

function filteredListInfo(
  listInfo: ListInfo,
  returnedCount: number,
  filterFields: string[]
): ListInfo {
  if (filterFields.length === 0) return listInfo;
  if (listInfo.hasMore === false) {
    return {
      page: listInfo.page,
      pageSize: listInfo.pageSize,
      hasMore: false,
      totalCount: returnedCount,
    };
  }
  return { page: listInfo.page, pageSize: listInfo.pageSize };
}

function readMetadata(params: {
  listInfo: ListInfo;
  returnedCount: number;
  upstreamReturnedCount: number;
  filterFields: string[];
}) {
  const complete = params.listInfo.hasMore === false;
  const truncated = params.listInfo.hasMore === true;
  const nextPage =
    truncated && typeof params.listInfo.page === "number"
      ? params.listInfo.page + 1
      : undefined;

  return {
    complete,
    truncated,
    truncationReason: truncated ? "upstreamHasMore" : undefined,
    continuation: truncated
      ? { nextPage, pageSize: params.listInfo.pageSize }
      : undefined,
    returnedCount: params.returnedCount,
    upstreamReturnedCount: params.upstreamReturnedCount,
    upstreamTotalCount: params.listInfo.totalCount,
    upstreamHasMore: params.listInfo.hasMore,
    completeness: complete ? "known" : truncated ? "partial" : "unknown",
    filtering: {
      applied: params.filterFields.length > 0,
      fields: params.filterFields,
      upstreamReturnedCount:
        params.filterFields.length > 0 ? params.upstreamReturnedCount : undefined,
      filteredOutCount:
        params.filterFields.length > 0
          ? params.upstreamReturnedCount - params.returnedCount
          : undefined,
    },
  };
}

function activeFields(fields: Record<string, unknown>): string[] {
  return Object.entries(fields)
    .filter(([, value]) =>
      Array.isArray(value) ? value.length > 0 : value !== undefined && value !== ""
    )
    .map(([key]) => key);
}

function listResult<T extends Record<string, unknown>, K extends keyof T & string>(
  list: T & { listInfo: ListInfo },
  key: K,
  items: T[K] extends unknown[] ? T[K] : never,
  upstreamCount: number,
  filterFields: string[]
) {
  return {
    ...list,
    [key]: items,
    listInfo: filteredListInfo(list.listInfo, (items as unknown[]).length, filterFields),
    readMetadata: readMetadata({
      listInfo: list.listInfo,
      returnedCount: (items as unknown[]).length,
      upstreamReturnedCount: upstreamCount,
      filterFields,
    }),
  };
}

export function getAssetsTools(): DomainTools {
  return {
    tools: [
      {
        name: "superops_assets_list",
        description:
          "List assets (endpoints) in SuperOps.ai RMM. Can filter by status, platform, or client.",
        inputSchema: {
          type: "object",
          properties: {
            status: {
              type: "string",
              description: "Filter by status: Online, Offline, or Maintenance",
              enum: ["Online", "Offline", "Maintenance"],
            },
            platform: {
              type: "string",
              description: "Filter by platform: Windows, macOS, or Linux",
              enum: ["Windows", "macOS", "Linux"],
            },
            clientId: {
              type: "string",
              description: "Filter by client account ID",
            },
            max: {
              type: "number",
              description: "Maximum number of results (default: 100, max: 500)",
              default: 100,
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
        name: "superops_assets_get",
        description:
          "Get detailed information for a specific asset including hardware, OS, and network details.",
        inputSchema: {
          type: "object",
          properties: {
            assetId: {
              type: "string",
              description: "The unique asset ID",
            },
          },
          required: ["assetId"],
        },
      },
      {
        name: "superops_assets_software",
        description: "Get the software inventory for a specific asset.",
        inputSchema: {
          type: "object",
          properties: {
            assetId: {
              type: "string",
              description: "The unique asset ID",
            },
            search: {
              type: "string",
              description: "Search term to filter software by name",
            },
            max: {
              type: "number",
              description: "Maximum number of results (default: 100)",
              default: 100,
            },
          },
          required: ["assetId"],
        },
      },
      {
        name: "superops_assets_patches",
        description: "Get patch status and pending patches for a specific asset.",
        inputSchema: {
          type: "object",
          properties: {
            assetId: {
              type: "string",
              description: "The unique asset ID",
            },
            status: {
              type: "string",
              description: "Filter patches by status: Pending, Installed, or Failed",
              enum: ["Pending", "Installed", "Failed"],
            },
            severity: {
              type: "array",
              items: { type: "string" },
              description: "Filter by severity levels: Critical, Important, Moderate, Low",
            },
          },
          required: ["assetId"],
        },
      },
    ],

    async handleCall(name, args) {
      const client = getClient();

      try {
        switch (name) {
          case "superops_assets_list": {
            const params = args as {
              status?: string;
              platform?: string;
              clientId?: string;
              max?: number;
              page?: number;
            };

            const response = await client.query<ListAssetsResponse>(LIST_ASSETS_QUERY, {
              // TODO: Replace local filtering with ListInfoInput.condition after
              // SuperOps documents per-list condition operators and attributes.
              input: pageInput(params.max, 100, params.page),
            });
            const filters = {
              status: params.status,
              platform: params.platform,
              clientId: params.clientId,
            };
            const assets = applyAssetFilters(response.getAssetList.assets, filters);

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    listResult(
                      response.getAssetList,
                      "assets",
                      assets,
                      response.getAssetList.assets.length,
                      activeFields(filters)
                    ),
                    null,
                    2
                  ),
                },
              ],
            };
          }

          case "superops_assets_get": {
            const { assetId } = args as { assetId: string };

            const response = await client.query<GetAssetResponse>(GET_ASSET_QUERY, {
              input: { assetId },
            });

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(response.getAsset, null, 2),
                },
              ],
            };
          }

          case "superops_assets_software": {
            const params = args as {
              assetId: string;
              search?: string;
              max?: number;
            };

            const response = await client.query<GetSoftwareResponse>(GET_ASSET_SOFTWARE_QUERY, {
              input: {
                assetId: params.assetId,
                listInfo: pageInput(params.max, 100),
              },
            });
            const assetSoftwares = applySoftwareSearch(
              response.getAssetSoftwareList.assetSoftwares,
              params.search
            );

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    listResult(
                      response.getAssetSoftwareList,
                      "assetSoftwares",
                      assetSoftwares,
                      response.getAssetSoftwareList.assetSoftwares.length,
                      activeFields({ search: params.search })
                    ),
                    null,
                    2
                  ),
                },
              ],
            };
          }

          case "superops_assets_patches": {
            const params = args as {
              assetId: string;
              status?: string;
              severity?: string[];
            };

            const response = await client.query<GetPatchesResponse>(GET_ASSET_PATCHES_QUERY, {
              input: {
                assetId: params.assetId,
                // TODO: Replace local filtering with ListInfoInput.condition after
                // SuperOps documents condition syntax for patch fields.
                listInfo: pageInput(undefined, 100),
              },
            });
            const filters = { status: params.status, severity: params.severity };
            const assetPatches = applyPatchFilters(
              response.getAssetPatchDetails.assetPatches,
              filters
            );

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    listResult(
                      response.getAssetPatchDetails,
                      "assetPatches",
                      assetPatches,
                      response.getAssetPatchDetails.assetPatches.length,
                      activeFields(filters)
                    ),
                    null,
                    2
                  ),
                },
              ],
            };
          }

          default:
            return {
              content: [{ type: "text", text: `Unknown assets tool: ${name}` }],
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
