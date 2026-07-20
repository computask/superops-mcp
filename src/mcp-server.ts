/**
 * Shared MCP server factory for SuperOps.ai.
 *
 * This module is **side-effect free** (importing it never starts a transport),
 * so it can be reused by every entrypoint:
 * - `index.ts`  — stdio + Node HTTP transport
 * - `worker.ts` — Cloudflare Workers (Web Standard) transport
 *
 * All SuperOps.ai tools are exposed upfront (flat architecture) for universal
 * MCP client compatibility.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import type { Domain, DomainTools, ToolDefinition } from "./types.js";
import { getCredentials } from "./client.js";
import { setServerRef } from "./utils/server-ref.js";
import {
  auditToolCall,
  blockedToolReason,
  classifyTool,
  errorSummaryFromResult,
  sanitizeError,
  sanitizeToolResult,
  toolAuditMetadata,
  type ToolResult,
  type ToolCategory,
  type AuditMetadata,
} from "./audit.js";
import {
  finishExecution,
  logExecutionDiagnostics,
  runWithExecutionContext,
} from "./execution.js";
import { boundedToolResult } from "./utils/tool-result.js";
import {
  currentOwnerHash,
  getOperationStore,
  operationResultView,
} from "./operation-store.js";

// Lazy-loaded domain modules
const domainCache = new Map<Domain, DomainTools>();

// All domain tools, collected once at startup.
//
// The tool set is static and credential-independent, but a fresh server is
// created per request (for credential isolation), so the assembled list is
// memoized at module scope to avoid rebuilding it on every request.
let allDomainTools: ToolDefinition[] | null = null;

export async function loadDomain(domain: Domain): Promise<DomainTools> {
  const cached = domainCache.get(domain);
  if (cached) {
    return cached;
  }

  let tools: DomainTools;
  switch (domain) {
    case "clients": {
      const { getClientsTools } = await import("./domains/clients.js");
      tools = getClientsTools();
      break;
    }
    case "tickets": {
      const { getTicketsTools } = await import("./domains/tickets.js");
      tools = getTicketsTools();
      break;
    }
    case "assets": {
      const { getAssetsTools } = await import("./domains/assets.js");
      tools = getAssetsTools();
      break;
    }
    case "alerts": {
      const { getAlertsTools } = await import("./domains/alerts.js");
      tools = getAlertsTools();
      break;
    }
    case "technicians": {
      const { getTechniciansTools } = await import("./domains/technicians.js");
      tools = getTechniciansTools();
      break;
    }
    case "custom": {
      const { getCustomTools } = await import("./domains/custom.js");
      tools = getCustomTools();
      break;
    }
    default:
      throw new Error(`Unknown domain: ${domain}`);
  }

  domainCache.set(domain, tools);
  return tools;
}

/**
 * Domain metadata for navigation
 */
const domainDescriptions: Record<Domain, string> = {
  clients:
    "Client/company management - list, get, search accounts and company information",
  tickets:
    "Ticket management - list, get, read-only created-time historical query/reporting, create tickets, and manage support workflow",
  assets:
    "Asset management - list and get hardware/software assets, endpoint inventory",
  alerts:
    "Alert management - list, retrieve, create, resolve, and summarise SuperOps alerts",
  technicians:
    "Technician management - list and get support staff and technician information",
  custom: "Custom queries - execute advanced GraphQL queries with full API access",
};

/**
 * Load all domain tools (lazy-loaded on first access)
 */
async function getAllDomainTools(): Promise<ToolDefinition[]> {
  if (allDomainTools !== null) {
    return allDomainTools;
  }

  const domains: Domain[] = [
    "clients",
    "tickets",
    "assets",
    "alerts",
    "technicians",
    "custom",
  ];
  const tools: ToolDefinition[] = [];

  for (const domain of domains) {
    const domainTools = await loadDomain(domain);
    tools.push(...domainTools.tools);
  }

  allDomainTools = tools;
  return tools;
}

export type McpServerOptions = {
  blockedToolNames?: ReadonlySet<string>;
};

export async function blockedToolNamesByCategory(
  categories: ReadonlySet<ToolCategory>
): Promise<Set<string>> {
  if (categories.size === 0) {
    return new Set();
  }

  const domainTools = await getAllDomainTools();
  return new Set(
    domainTools
      .filter((tool) => categories.has(classifyTool(tool.name).category))
      .map((tool) => tool.name)
  );
}

const CHATGPT_DIRECT_TRIAGE_PLAN_TOOL_NAME = "superops_tickets_apply_triage_plan";

export type ChatGptDirectToolPolicy = {
  generalMutatingToolsAllowed?: boolean;
  customMutationsAllowed?: boolean;
  reviewedTriagePlanAllowed?: boolean;
};

/**
 * ChatGPT direct-route policy derives its synchronous-mutation and broad-query
 * blocklist from the same assembled registry returned by tools/list.
 */
export async function chatGptDirectBlockedToolNames(
  policy: ChatGptDirectToolPolicy = {}
): Promise<Set<string>> {
  const categories = new Set<ToolCategory>(["custom_query"]);
  if (policy.generalMutatingToolsAllowed !== true) {
    categories.add("write");
  }
  if (policy.customMutationsAllowed !== true) {
    categories.add("custom_mutation");
  }

  const blocked = await blockedToolNamesByCategory(categories);
  if (policy.reviewedTriagePlanAllowed === true) {
    blocked.delete(CHATGPT_DIRECT_TRIAGE_PLAN_TOOL_NAME);
  } else {
    blocked.add(CHATGPT_DIRECT_TRIAGE_PLAN_TOOL_NAME);
  }
  return blocked;
}

export const chatGptDirectBlockedMutationToolNames =
  chatGptDirectBlockedToolNames;
// Navigation / discovery tool - helps the LLM find the right tools
const navigationTool: ToolDefinition = {
  name: "superops_navigate",
  description:
    "Discover available SuperOps.ai tools by domain. Returns tool names and descriptions for the selected domain. All tools are callable at any time — this is a help/discovery aid, not a prerequisite.",
  inputSchema: {
    type: "object",
    properties: {
      domain: {
        type: "string",
        description: `The domain to explore:
- clients: ${domainDescriptions.clients}
- tickets: ${domainDescriptions.tickets}
- assets: ${domainDescriptions.assets}
- alerts: ${domainDescriptions.alerts}
- technicians: ${domainDescriptions.technicians}
- custom: ${domainDescriptions.custom}`,
        enum: ["clients", "tickets", "assets", "alerts", "technicians", "custom"],
      },
    },
    required: ["domain"],
  },
};

// Status tool - shows credentials status and available domains
const statusTool: ToolDefinition = {
  name: "superops_status",
  description: "Show credentials status and available domains",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

const operationTools: ToolDefinition[] = [
  {
    name: "superops_operations_get",
    description:
      "Read durable execution status for one SuperOps MCP operation by operation ID. Does not call SuperOps.",
    inputSchema: {
      type: "object",
      properties: {
        operationId: {
          type: "string",
          description: "Durable operation ID returned by an incomplete operation.",
        },
      },
      required: ["operationId"],
    },
  },
  {
    name: "superops_operations_results",
    description:
      "List recent durable operation summaries visible to the current authenticated caller. Does not call SuperOps.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];
// Connection test tool
const testConnectionTool: ToolDefinition = {
  name: "superops_test_connection",
  description:
    "Test the connection to SuperOps.ai API using configured credentials.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

/**
 * Resolve per-request gateway credentials from a header accessor.
 *
 * Works with any transport: pass a getter that returns a (lowercased) header
 * value. Returns `{ creds }` on success, or `{ error }` when required headers
 * are missing.
 */
export function resolveGatewayCredentials(
  getHeader: (lowerName: string) => string | undefined
): {
  creds?: { apiToken: string; subdomain: string };
  error?: string;
} {
  const apiToken = getHeader("x-superops-api-token");
  const subdomain = getHeader("x-superops-subdomain");
  if (!apiToken || !subdomain) {
    return {
      error:
        "Gateway mode requires X-SuperOps-API-Token and X-SuperOps-Subdomain headers",
    };
  }
  return { creds: { apiToken, subdomain } };
}

function errorResult(message: string): ToolResult {
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
  };
}

async function executeToolCall(
  name: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const blockedReason = blockedToolReason(name);
  if (blockedReason) {
    return errorResult(blockedReason);
  }

  // Handle test connection
  if (name === "superops_test_connection") {
    const creds = getCredentials();
    if (!creds) {
      return errorResult("SuperOps API credentials are not configured.");
    }

    try {
      const clientsTools = await loadDomain("clients");
      const result = await clientsTools.handleCall("superops_clients_list", {
        max: 1,
      });

      if (result.isError) {
        return result;
      }

      return {
        content: [
          {
            type: "text",
            text: `Connection successful!\n\nCredentials configured for:\n- Subdomain: ${creds.subdomain}\n- Region: ${creds.region ?? "us"}\n\nAPI is responding correctly.`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Connection test failed: ${sanitizeError(error)}`,
          },
        ],
        isError: true,
      };
    }
  }

  // Handle navigation / discovery helper
  if (name === "superops_navigate") {
    const { domain } = args as { domain?: string };
    const validDomains: Domain[] = [
      "clients",
      "tickets",
      "assets",
      "alerts",
      "technicians",
      "custom",
    ];

    if (!domain || !validDomains.includes(domain as Domain)) {
      return {
        content: [
          {
            type: "text",
            text: `Invalid domain. Please choose from: ${validDomains.join(", ")}`,
          },
        ],
        isError: true,
      };
    }

    const domainTools = await loadDomain(domain as Domain);
    const toolSummary = domainTools.tools
      .map((t) => `- ${t.name}: ${t.description}`)
      .join("\n");

    return {
      content: [
        {
          type: "text",
          text: `${domainDescriptions[domain as Domain]}\n\nAvailable tools:\n${toolSummary}\n\nYou can call any of these tools directly.`,
        },
      ],
    };
  }

  // Handle status
  if (name === "superops_status") {
    const creds = getCredentials();
    const credStatus = creds
      ? `Configured (subdomain: ${creds.subdomain}, region: ${creds.region ?? "us"})`
      : "NOT CONFIGURED - SuperOps API credentials are required";

    return {
      content: [
        {
          type: "text",
          text: `SuperOps.ai MCP Server Status\n\nCredentials: ${credStatus}\nAvailable domains: ${Object.keys(domainDescriptions).join(", ")}\n\nAll tools are available at all times. Use superops_navigate to discover tools by domain.`,
        },
      ],
    };
  }

  if (name === "superops_operations_get") {
    const operationId = typeof args.operationId === "string" ? args.operationId.trim() : "";
    if (!operationId) {
      return errorResult("operationId is required.");
    }
    const ownerHash = currentOwnerHash();
    const record = await getOperationStore().get(operationId, ownerHash);
    if (!record || record.ownerHash !== ownerHash) {
      return errorResult("Operation was not found or is not visible to this caller.");
    }
    return {
      content: [{ type: "text", text: JSON.stringify(operationResultView(record), null, 2) }],
    };
  }

  if (name === "superops_operations_results") {
    const records = await getOperationStore().list(currentOwnerHash());
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(records, null, 2),
        },
      ],
    };
  }
  // Check for credential issues before domain calls
  const creds = getCredentials();
  if (!creds) {
    return errorResult("SuperOps API credentials are not configured.");
  }

  // Route to appropriate domain handler based on tool name prefix
  if (name.startsWith("superops_clients_")) {
    const domainTools = await loadDomain("clients");
    return domainTools.handleCall(name, args);
  }
  if (name.startsWith("superops_tickets_")) {
    const domainTools = await loadDomain("tickets");
    return domainTools.handleCall(name, args);
  }
  if (name.startsWith("superops_assets_")) {
    const domainTools = await loadDomain("assets");
    return domainTools.handleCall(name, args);
  }
  if (name.startsWith("superops_alerts_")) {
    const domainTools = await loadDomain("alerts");
    return domainTools.handleCall(name, args);
  }
  if (name.startsWith("superops_technicians_")) {
    const domainTools = await loadDomain("technicians");
    return domainTools.handleCall(name, args);
  }
  if (name.startsWith("superops_custom_")) {
    const domainTools = await loadDomain("custom");
    return domainTools.handleCall(name, args);
  }

  // Unknown tool
  return {
    content: [
      {
        type: "text",
        text: `Unknown tool: ${name}. Use superops_navigate to discover available tools by domain.`,
      },
    ],
    isError: true,
  };
}

function enrichAuditMetadataFromResult(
  toolName: string,
  result: ToolResult,
  metadata: AuditMetadata | undefined
): AuditMetadata | undefined {
  if (toolName !== "superops_tickets_triage_snapshot" || result.isError) {
    return metadata;
  }

  const text = result.content.find((item) => item.type === "text")?.text;
  if (!text) {
    return metadata;
  }

  try {
    const parsed = JSON.parse(text) as {
      source?: { status?: unknown; page?: unknown; max?: unknown };
      initialCandidateCount?: unknown;
      candidateTicketNumbers?: unknown;
    };
    return {
      ...metadata,
      triageSnapshot: {
        status: parsed.source?.status,
        page: parsed.source?.page,
        max: parsed.source?.max,
        candidateCount: parsed.initialCandidateCount,
        ticketNumbers: parsed.candidateTicketNumbers,
        safeRead: true,
      },
    };
  } catch {
    return metadata;
  }
}

/**
 * Create and configure an MCP Server instance with all request handlers.
 * Called once for stdio, or per-request for HTTP / Workers transports.
 */
export function createMcpServer(options: McpServerOptions = {}): Server {
  const blockedToolNames = options.blockedToolNames ?? new Set<string>();
  const server = new Server(
    {
      name: "superops-mcp",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );
  setServerRef(server);

  // List available tools - returns the assembled catalogue minus tools blocked
  // by the current route/runtime policy.
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const domainTools = await getAllDomainTools();
    const tools = [navigationTool, statusTool, testConnectionTool, ...operationTools, ...domainTools];
    return {
      tools: tools.filter((tool) => !blockedToolNames.has(tool.name)),
    };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    return runWithExecutionContext(name, async () => {
      const started = Date.now();
      let metadata = toolAuditMetadata(name, args);

      try {
        const result = boundedToolResult(
          sanitizeToolResult(
            blockedToolNames.has(name)
              ? errorResult(`${name} is disabled by this MCP server configuration.`)
              : await executeToolCall(name, args)
          )
        );
        metadata = enrichAuditMetadataFromResult(name, result, metadata);
        const errorSummary = errorSummaryFromResult(result);
        finishExecution(result.isError ? "toolError" : "completed");
        auditToolCall({
          toolName: name,
          success: !result.isError,
          durationMs: Date.now() - started,
          errorSummary,
          metadata,
        });
        logExecutionDiagnostics(!result.isError, errorSummary);
        return result as never;
      } catch (error) {
        const result = errorResult(sanitizeError(error));
        const errorSummary = errorSummaryFromResult(result);
        finishExecution("unhandledError");
        auditToolCall({
          toolName: name,
          success: false,
          durationMs: Date.now() - started,
          errorSummary,
          metadata,
        });
        logExecutionDiagnostics(false, errorSummary);
        return result as never;
      }
    });
  });

  return server;
}
