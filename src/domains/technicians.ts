/**
 * SuperOps.ai Technicians Domain
 *
 * Tools for managing technicians (agents) in SuperOps.ai PSA.
 */

import { getClient } from "../client.js";
import type { DomainTools, Technician, ListInfo } from "../types.js";

const DEFAULT_LIST_PAGE = 1;

const LIST_TECHNICIANS_QUERY = `
  query getTechnicianList($input: ListInfoInput!) {
    getTechnicianList(input: $input) {
      userList {
        userId
        firstName
        lastName
        name
        email
        contactNumber
        emailSignature
        designation
        businessFunction
        team
        reportingManager
        role
        groups
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

const GET_TECHNICIAN_QUERY = `
  query getTechnicianList($input: ListInfoInput!) {
    getTechnicianList(input: $input) {
      userList {
        userId
        firstName
        lastName
        name
        email
        contactNumber
        emailSignature
        designation
        businessFunction
        team
        reportingManager
        role
        groups
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

interface ListTechniciansResponse {
  getTechnicianList: {
    userList: Technician[];
    listInfo: ListInfo;
  };
}

interface GetTechnicianResponse {
  getTechnicianList: {
    userList: Technician[];
    listInfo: ListInfo;
  };
}

interface TechGroup {
  groupId: string;
  name: string;
}

interface ListTechGroupsResponse {
  getTechnicianGroupList: TechGroup[];
}

function pageInput(max: number | undefined, page?: number) {
  return {
    page: page ?? DEFAULT_LIST_PAGE,
    pageSize: Math.min(max ?? 50, 500),
  };
}

function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function applyTechnicianFilters(
  technicians: Technician[],
  filters: { teamId?: string }
): Technician[] {
  return technicians.filter((technician) => {
    const team = jsonRecord(technician.team);
    if (filters.teamId && team?.teamId !== filters.teamId) return false;
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

function listResult(
  list: ListTechniciansResponse["getTechnicianList"],
  userList: Technician[],
  filterFields: string[]
) {
  return {
    ...list,
    userList,
    listInfo: filteredListInfo(list.listInfo, userList.length, filterFields),
    readMetadata: readMetadata({
      listInfo: list.listInfo,
      returnedCount: userList.length,
      upstreamReturnedCount: list.userList.length,
      filterFields,
    }),
  };
}

function groupReadMetadata(totalAvailable: number, returnedCount: number, requestedLimit: number) {
  const truncated = returnedCount < totalAvailable;
  return {
    complete: !truncated,
    truncated,
    truncationReason: truncated ? "recordLimit" : undefined,
    continuation: undefined,
    returnedCount,
    upstreamReturnedCount: totalAvailable,
    upstreamTotalCount: totalAvailable,
    completeness: truncated ? "partial" : "known",
    limit: { requested: requestedLimit, effective: returnedCount },
    filtering: { applied: false, fields: [] },
  };
}

export function getTechniciansTools(): DomainTools {
  return {
    tools: [
      {
        name: "superops_technicians_list",
        description:
          "List technicians (agents) in SuperOps.ai. Can filter by active status or team.",
        inputSchema: {
          type: "object",
          properties: {
            activeOnly: {
              type: "boolean",
              description: "Show only active technicians (default: true)",
              default: true,
            },
            teamId: {
              type: "string",
              description: "Filter by team/group ID",
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
        name: "superops_technicians_get",
        description: "Get detailed information for a specific technician by their ID.",
        inputSchema: {
          type: "object",
          properties: {
            technicianId: {
              type: "string",
              description: "The unique technician ID",
            },
          },
          required: ["technicianId"],
        },
      },
      {
        name: "superops_technicians_groups",
        description: "List technician groups/teams in SuperOps.ai.",
        inputSchema: {
          type: "object",
          properties: {
            max: {
              type: "number",
              description: "Maximum number of results (default: 50)",
              default: 50,
            },
          },
        },
      },
    ],

    async handleCall(name, args) {
      const client = getClient();

      try {
        switch (name) {
          case "superops_technicians_list": {
            const params = args as {
              activeOnly?: boolean;
              teamId?: string;
              max?: number;
              page?: number;
            };

            const response = await client.query<ListTechniciansResponse>(
              LIST_TECHNICIANS_QUERY,
              {
                // TODO: Replace local filtering with ListInfoInput.condition after
                // SuperOps documents condition syntax for technician fields.
                input: pageInput(params.max, params.page),
              }
            );
            const filters = { teamId: params.teamId };
            const userList = applyTechnicianFilters(
              response.getTechnicianList.userList,
              filters
            );

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    listResult(
                      response.getTechnicianList,
                      userList,
                      filters.teamId ? ["teamId"] : []
                    ),
                    null,
                    2
                  ),
                },
              ],
            };
          }

          case "superops_technicians_get": {
            const { technicianId } = args as { technicianId: string };

            const response = await client.query<GetTechnicianResponse>(GET_TECHNICIAN_QUERY, {
              input: pageInput(500),
            });
            const technician = response.getTechnicianList.userList.find(
              (item) => item.userId === technicianId
            );

            if (!technician) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Error: Technician not found in first returned page: ${technicianId}`,
                  },
                ],
                isError: true,
              };
            }

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(technician, null, 2),
                },
              ],
            };
          }

          case "superops_technicians_groups": {
            const params = args as { max?: number };

            const response = await client.query<ListTechGroupsResponse>(LIST_TECH_GROUPS_QUERY);
            const requestedLimit = Math.min(params.max ?? 50, 500);
            const groups = response.getTechnicianGroupList.slice(0, requestedLimit);

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      groups,
                      readMetadata: groupReadMetadata(
                        response.getTechnicianGroupList.length,
                        groups.length,
                        requestedLimit
                      ),
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }

          default:
            return {
              content: [{ type: "text", text: `Unknown technicians tool: ${name}` }],
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
