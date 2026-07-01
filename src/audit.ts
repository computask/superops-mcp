import { AsyncLocalStorage } from "node:async_hooks";

export type ToolCategory = "read" | "write" | "custom_query" | "custom_mutation";

export interface AuditContext {
  requestId: string;
  user?: string;
  mcpEnabled: boolean;
  writeToolsEnabled: boolean;
  customMutationEnabled: boolean;
}

export interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

export interface AuditMetadata {
  operationType?: string;
  operationName?: string;
  variableKeys?: string[];
  changedFields?: string[];
  triageSnapshot?: {
    status?: unknown;
    page?: unknown;
    max?: unknown;
    candidateCount?: unknown;
    ticketNumbers?: unknown;
    safeRead?: unknown;
  };
}

const HIGH_RISK_WRITE_TOOLS = new Set([
  "superops_tickets_create",
  "superops_tickets_update",
  "superops_tickets_resolve_full",
  "superops_tickets_add_note",
  "superops_tickets_log_time",
  "superops_alerts_create",
  "superops_alerts_resolve",
  "superops_custom_mutation",
]);

const RUNTIME_CONTEXT = new AsyncLocalStorage<AuditContext>();

const SECRET_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(access_token|refresh_token|client_secret|authorization|cookie|cf-access-jwt-assertion|cf-access-client-secret|x-superops-api-token|api[_-]?token)\b\s*[:=]\s*["']?[^"',\s}]+/gi,
  /\bSUPEROPS_API_TOKEN\b/g,
  /\b[A-Za-z]:\\[^\s)"']+/g,
  /\bat\s+.+\(.+\)/g,
];

function generatedRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `req-${Date.now()}`;
}

function readProcessEnv(name: string): string | undefined {
  return typeof process !== "undefined" ? process.env[name] : undefined;
}

function enabledFlag(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) {
    return defaultValue;
  }

  return value.trim().toLowerCase() !== "false";
}

export function runtimeFlagsFromEnv(env: {
  MCP_ENABLED?: string;
  ENABLE_WRITE_TOOLS?: string;
  ENABLE_CUSTOM_MUTATION?: string;
}): Pick<
  AuditContext,
  "mcpEnabled" | "writeToolsEnabled" | "customMutationEnabled"
> {
  return {
    mcpEnabled: enabledFlag(env.MCP_ENABLED, true),
    writeToolsEnabled: enabledFlag(env.ENABLE_WRITE_TOOLS, true),
    customMutationEnabled: enabledFlag(env.ENABLE_CUSTOM_MUTATION, true),
  };
}

export function requestIdFromHeaders(headers: {
  get(name: string): string | null;
}): string {
  return (
    headers.get("cf-ray")?.trim() ||
    headers.get("x-request-id")?.trim() ||
    generatedRequestId()
  );
}

export function runWithAuditContext<T>(
  context: Partial<AuditContext>,
  fn: () => T
): T {
  const flags = runtimeFlagsFromEnv({
    MCP_ENABLED: readProcessEnv("MCP_ENABLED"),
    ENABLE_WRITE_TOOLS: readProcessEnv("ENABLE_WRITE_TOOLS"),
    ENABLE_CUSTOM_MUTATION: readProcessEnv("ENABLE_CUSTOM_MUTATION"),
  });

  return RUNTIME_CONTEXT.run(
    {
      requestId: context.requestId ?? generatedRequestId(),
      user: context.user,
      mcpEnabled: context.mcpEnabled ?? flags.mcpEnabled,
      writeToolsEnabled: context.writeToolsEnabled ?? flags.writeToolsEnabled,
      customMutationEnabled:
        context.customMutationEnabled ?? flags.customMutationEnabled,
    },
    fn
  );
}

export function getAuditContext(): AuditContext {
  const stored = RUNTIME_CONTEXT.getStore();
  if (stored) {
    return stored;
  }

  return {
    requestId: generatedRequestId(),
    ...runtimeFlagsFromEnv({
      MCP_ENABLED: readProcessEnv("MCP_ENABLED"),
      ENABLE_WRITE_TOOLS: readProcessEnv("ENABLE_WRITE_TOOLS"),
      ENABLE_CUSTOM_MUTATION: readProcessEnv("ENABLE_CUSTOM_MUTATION"),
    }),
  };
}

export function classifyTool(name: string): {
  category: ToolCategory;
  highRisk: boolean;
} {
  if (name === "superops_custom_query") {
    return { category: "custom_query", highRisk: false };
  }

  if (name === "superops_custom_mutation") {
    return { category: "custom_mutation", highRisk: true };
  }

  if (HIGH_RISK_WRITE_TOOLS.has(name)) {
    return { category: "write", highRisk: true };
  }

  return { category: "read", highRisk: false };
}

export function blockedToolReason(name: string): string | undefined {
  const context = getAuditContext();
  const classification = classifyTool(name);

  if (!context.mcpEnabled) {
    return "MCP tool execution is disabled by MCP_ENABLED=false.";
  }

  if (!context.writeToolsEnabled && classification.category === "write") {
    return "Write-capable ticket tools are disabled by ENABLE_WRITE_TOOLS=false.";
  }

  if (!context.customMutationEnabled && name === "superops_custom_mutation") {
    return "Custom GraphQL mutations are disabled by ENABLE_CUSTOM_MUTATION=false.";
  }
}

function parseGraphQLOperation(source: unknown): {
  operationType?: string;
  operationName?: string;
} {
  if (typeof source !== "string") {
    return {};
  }

  const withoutComments = source.replace(/#[^\r\n]*/g, " ");
  const match = withoutComments.match(
    /\b(query|mutation|subscription)\b\s*([_A-Za-z][_0-9A-Za-z]*)?/
  );

  return {
    operationType: match?.[1],
    operationName: match?.[2],
  };
}

function variableKeys(variables: unknown): string[] | undefined {
  if (
    typeof variables !== "object" ||
    variables === null ||
    Array.isArray(variables)
  ) {
    return undefined;
  }

  return Object.keys(variables as Record<string, unknown>).slice(0, 25);
}

const WRITE_FIELD_KEYS: Partial<Record<string, string[]>> = {
  superops_tickets_update: [
    "ticketId",
    "status",
    "priority",
    "impact",
    "urgency",
    "resolutionCode",
    "category",
    "cause",
    "subcategory",
    "assigneeId",
    "techGroupName",
    "resolution",
  ],
  superops_tickets_resolve_full: [
    "ticketId",
    "ticketNumber",
    "clientName",
    "clientId",
    "status",
    "priority",
    "impact",
    "urgency",
    "category",
    "subcategory",
    "cause",
    "resolutionCode",
    "note",
    "isPublicNote",
    "techGroupName",
    "suppressCloseNotification",
    "verify",
  ],
  superops_alerts_create: [
    "assetId",
    "message",
    "severity",
    "verify",
    "dryRun",
  ],
  superops_alerts_resolve: [
    "alertId",
    "alertIds",
    "verify",
    "dryRun",
  ],
};

function changedFieldKeys(
  toolName: string,
  args: Record<string, unknown>
): string[] | undefined {
  const allowed = WRITE_FIELD_KEYS[toolName];
  if (!allowed) {
    return undefined;
  }

  const fields = allowed.filter((key) => key in args);
  return fields.length > 0 ? fields : undefined;
}

export function toolAuditMetadata(
  name: string,
  args: Record<string, unknown>
): AuditMetadata | undefined {
  const changedFields = changedFieldKeys(name, args);

  if (name === "superops_tickets_triage_snapshot") {
    return {
      triageSnapshot: {
        status: args.status ?? ["New Calls"],
        page: args.page ?? 1,
        max: args.max ?? 50,
        safeRead: true,
      },
    };
  }

  if (name !== "superops_custom_query" && name !== "superops_custom_mutation") {
    return changedFields ? { changedFields } : undefined;
  }

  const source =
    name === "superops_custom_query" ? args.query : args.mutation;

  return {
    ...parseGraphQLOperation(source),
    variableKeys: variableKeys(args.variables),
    changedFields,
  };
}

export function sanitizeText(value: string): string {
  let text = value.replace(/\r\n/g, "\n");

  if (text.includes("\n    at ") || text.includes("\nError:")) {
    text = text.split("\n")[0];
  }

  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, "[redacted]");
  }

  if (text.length > 800) {
    text = `${text.slice(0, 800)}...`;
  }

  return text;
}

export function sanitizeError(error: unknown): string {
  if (error instanceof Error) {
    return sanitizeText(error.message || error.name);
  }

  return sanitizeText(String(error));
}

export function sanitizeToolResult(result: ToolResult): ToolResult {
  if (!result.isError) {
    return result;
  }

  return {
    ...result,
    content: result.content.map((item) =>
      item.type === "text" ? { ...item, text: sanitizeText(item.text) } : item
    ),
  };
}

export function errorSummaryFromResult(result: ToolResult): string | undefined {
  if (!result.isError) {
    return undefined;
  }

  return sanitizeText(
    result.content
      .map((item) => item.text)
      .filter(Boolean)
      .join(" ")
  );
}

export function auditToolCall(args: {
  toolName: string;
  success: boolean;
  durationMs: number;
  errorSummary?: string;
  metadata?: AuditMetadata;
}): void {
  const context = getAuditContext();
  const classification = classifyTool(args.toolName);
  const record = {
    event: "mcp.tool_call",
    timestamp: new Date().toISOString(),
    requestId: context.requestId,
    user: context.user,
    toolName: args.toolName,
    toolCategory: classification.category,
    highRisk: classification.highRisk,
    success: args.success,
    durationMs: args.durationMs,
    errorSummary: args.errorSummary ? sanitizeText(args.errorSummary) : undefined,
    changedFields: args.metadata?.changedFields,
    triageSnapshot: args.metadata?.triageSnapshot,
    customGraphql: args.metadata,
  };

  console.log(JSON.stringify(record));
}
