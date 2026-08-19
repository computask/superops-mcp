import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

import type { ToolDefinition } from "./types.js";

export const READ_ONLY_TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

export const MUTATING_TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

const EMERGING_ISSUE_TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  // The signal is internal and bounded, but an upsert changes durable state.
  // Advertise that state change so authenticated MCP clients do not discard
  // this non-read-only tool as an unclassified middle state.
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

export const READ_ONLY_TOOL_NAMES = new Set<string>([
  "superops_navigate",
  "superops_status",
  "superops_test_connection",
  "superops_operations_get",
  "superops_operations_results",
  "superops_clients_list",
  "superops_clients_get",
  "superops_clients_search",
  "superops_tickets_list",
  "superops_tickets_recent",
  "superops_tickets_query",
  "superops_tickets_created_between",
  "superops_tickets_report",
  "superops_tickets_get",
  "superops_tickets_get_by_number",
  "superops_tickets_get_safe_by_number",
  "superops_tickets_get_safe",
  "superops_tickets_triage_evidence_recover",
  "superops_tickets_triage_snapshot",
  "superops_tickets_conversation_list",
  "superops_tickets_notes_list",
  "superops_tickets_field_options",
  "superops_assets_list",
  "superops_assets_get",
  "superops_assets_software",
  "superops_assets_patches",
  "superops_scripts_list",
  "superops_scripts_get",
  "superops_script_catalog_status",
  "superops_script_catalog_recommend",
  "superops_script_catalog_get",
  "superops_scripts_supported_targets",
  "superops_scripts_executions_list",
  "superops_scripts_execution_get",
  "superops_script_catalog_recommend",
  "superops_script_catalog_get",
  "superops_script_catalog_status",
  "superops_script_catalog_review_queue",
  "superops_alerts_list",
  "superops_alerts_get",
  "superops_alerts_for_asset",
  "superops_alerts_summary",
  "superops_technicians_list",
  "superops_technicians_get",
  "superops_technicians_groups",
  "superops_custom_query",
]);

export const MUTATING_TOOL_NAMES = new Set<string>([
  "superops_triage_emerging_issue_upsert",
  "superops_operations_cancel",
  "superops_tickets_apply_triage_plan",
  "superops_tickets_create",
  "superops_tickets_resolve_full",
  "superops_tickets_update",
  "superops_tickets_add_note",
  "superops_tickets_log_time",
  "superops_alerts_resolve",
  "superops_alerts_create",
  "superops_scripts_execute_on_asset",
  "superops_custom_mutation",
]);

const READ_ONLY_DESCRIPTION_PREFIX = "Read-only. Does not modify SuperOps data.";

function annotationsForTool(name: string): ToolAnnotations {
  if (name === "superops_triage_emerging_issue_upsert") {
    return EMERGING_ISSUE_TOOL_ANNOTATIONS;
  }
  if (READ_ONLY_TOOL_NAMES.has(name)) {
    return READ_ONLY_TOOL_ANNOTATIONS;
  }
  if (MUTATING_TOOL_NAMES.has(name)) {
    return MUTATING_TOOL_ANNOTATIONS;
  }

  throw new Error(`Tool ${name} is missing explicit MCP safety annotations.`);
}

function readOnlyDescription(description: string): string {
  if (description.startsWith(READ_ONLY_DESCRIPTION_PREFIX)) {
    return description;
  }

  if (description.startsWith("Read-only.")) {
    return `${READ_ONLY_DESCRIPTION_PREFIX} ${description.slice("Read-only.".length).trimStart()}`;
  }

  return `${READ_ONLY_DESCRIPTION_PREFIX} ${description}`;
}

export function publishToolDefinition(tool: ToolDefinition): ToolDefinition {
  const annotations = annotationsForTool(tool.name);
  return {
    ...tool,
    description:
      annotations.readOnlyHint === true
        ? readOnlyDescription(tool.description)
        : tool.description,
    annotations,
  };
}
