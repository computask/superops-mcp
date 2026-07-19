/**
 * SuperOps.ai Clients Domain
 *
 * Tools for managing clients (accounts) in SuperOps.ai PSA.
 */

import { getClient } from "../client.js";
import type { DomainTools, Client, ListInfo } from "../types.js";
import { elicitText } from "../utils/elicitation.js";

const DEFAULT_LIST_PAGE = 1;

const LIST_CLIENTS_QUERY = `
  query getClientList($input: ListInfoInput!) {
    getClientList(input: $input) {
      clients {
        accountId
        name
        stage
        status
        emailDomains
        accountManager
        primaryContact
        hqSite
        customFields
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

const GET_CLIENT_QUERY = `
  query getClient($input: ClientIdentifierInput!) {
    getClient(input: $input) {
      accountId
      name
      stage
      status
      emailDomains
      accountManager
      primaryContact
      secondaryContact
      hqSite
      technicianGroups
      customFields
    }
  }
`;

const SEARCH_CLIENTS_QUERY = `
  query searchClients($input: ListInfoInput!) {
    getClientList(input: $input) {
      clients {
        accountId
        name
        emailDomains
        status
        stage
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

interface ListClientsResponse {
  getClientList: {
    clients: Client[];
    listInfo: ListInfo;
  };
}

interface GetClientResponse {
  getClient: Client;
}

function pageInput(max: number | undefined, defaultPageSize: number, page?: number) {
  return {
    page: page ?? DEFAULT_LIST_PAGE,
    pageSize: Math.min(max ?? defaultPageSize, 500),
  };
}

function applyClientFilters(
  clients: Client[],
  filters: { status?: string; stage?: string; query?: string }
): Client[] {
  return clients.filter((client) => {
    if (filters.status && client.status !== filters.status) return false;
    if (filters.stage && client.stage !== filters.stage) return false;

    if (filters.query) {
      const query = filters.query.toLowerCase();
      const nameMatches = client.name.toLowerCase().includes(query);
      const domainMatches = client.emailDomains?.some((domain) =>
        domain.toLowerCase().includes(query)
      );

      if (!nameMatches && !domainMatches) return false;
    }

    return true;
  });
}

function appliedClientFilterFields(filters: {
  status?: string;
  stage?: string;
  query?: string;
}): string[] {
  return [
    filters.status ? "status" : undefined,
    filters.stage ? "stage" : undefined,
    filters.query ? "query" : undefined,
  ].filter((field): field is string => Boolean(field));
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
  list: ListClientsResponse["getClientList"],
  clients: Client[],
  filterFields: string[]
) {
  return {
    ...list,
    clients,
    listInfo: filteredListInfo(list.listInfo, clients.length, filterFields),
    readMetadata: readMetadata({
      listInfo: list.listInfo,
      returnedCount: clients.length,
      upstreamReturnedCount: list.clients.length,
      filterFields,
    }),
  };
}

export function getClientsTools(): DomainTools {
  return {
    tools: [
      {
        name: "superops_clients_list",
        description:
          "List clients (accounts) in SuperOps.ai. Can filter by status, stage, or paginate through results.",
        inputSchema: {
          type: "object",
          properties: {
            status: {
              type: "string",
              description: "Filter by status: Active, Inactive, or Archived",
              enum: ["Active", "Inactive", "Archived"],
            },
            stage: {
              type: "string",
              description: "Filter by stage: Lead, Prospect, Customer, or Churned",
              enum: ["Lead", "Prospect", "Customer", "Churned"],
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
        name: "superops_clients_get",
        description: "Get detailed information for a specific client by their account ID.",
        inputSchema: {
          type: "object",
          properties: {
            accountId: {
              type: "string",
              description: "The unique account ID of the client",
            },
          },
          required: ["accountId"],
        },
      },
      {
        name: "superops_clients_search",
        description:
          "Search for clients by name or email domain. Returns matching clients with basic information.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search term to find clients by name or email domain",
            },
            max: {
              type: "number",
              description: "Maximum number of results (default: 20)",
              default: 20,
            },
          },
          required: ["query"],
        },
      },
    ],

    async handleCall(name, args) {
      const client = getClient();

      try {
        switch (name) {
          case "superops_clients_list": {
            const params = args as {
              status?: string;
              stage?: string;
              max?: number;
              page?: number;
            };

            // If no filters provided, elicit a search term from the user
            const hasFilters = params.status || params.stage;
            if (!hasFilters && !params.page) {
              const searchTerm = await elicitText(
                "No filters specified. Would you like to search for a specific client?",
                "search",
                "Enter a client name to search for, or leave blank to list all"
              );
              if (searchTerm) {
                // Redirect to the search handler which supports name filtering
                const searchResponse = await client.query<ListClientsResponse>(
                  SEARCH_CLIENTS_QUERY,
                  {
                    input: pageInput(params.max, 50, params.page),
                  }
                );
                const filters = { query: searchTerm };
                const clients = applyClientFilters(searchResponse.getClientList.clients, filters);
                return {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify(
                        listResult(
                          searchResponse.getClientList,
                          clients,
                          appliedClientFilterFields(filters)
                        ),
                        null,
                        2
                      ),
                    },
                  ],
                };
              }
            }

            const response = await client.query<ListClientsResponse>(LIST_CLIENTS_QUERY, {
              // TODO: Replace local filtering with ListInfoInput.condition after
              // SuperOps documents per-list condition operators and attributes.
              input: pageInput(params.max, 50, params.page),
            });
            const filters = { status: params.status, stage: params.stage };
            const clients = applyClientFilters(response.getClientList.clients, filters);

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    listResult(
                      response.getClientList,
                      clients,
                      appliedClientFilterFields(filters)
                    ),
                    null,
                    2
                  ),
                },
              ],
            };
          }

          case "superops_clients_get": {
            const { accountId } = args as { accountId: string };

            const response = await client.query<GetClientResponse>(GET_CLIENT_QUERY, {
              input: { accountId },
            });

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(response.getClient, null, 2),
                },
              ],
            };
          }

          case "superops_clients_search": {
            const params = args as { query: string; max?: number };

            const response = await client.query<ListClientsResponse>(SEARCH_CLIENTS_QUERY, {
              // TODO: Replace local search with ListInfoInput.condition after
              // SuperOps documents reliable condition syntax for Client fields.
              input: {
                page: DEFAULT_LIST_PAGE,
                pageSize: Math.min(params.max ?? 20, 100),
              },
            });
            const filters = { query: params.query };
            const clients = applyClientFilters(response.getClientList.clients, filters);

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    listResult(
                      response.getClientList,
                      clients,
                      appliedClientFilterFields(filters)
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
              content: [{ type: "text", text: `Unknown clients tool: ${name}` }],
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
