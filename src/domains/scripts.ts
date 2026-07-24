/**
 * SuperOps.ai Scripts Domain
 *
 * Dedicated, constrained tools for saved SuperOps RMM scripts.
 * Execution is limited to an existing script ID against one exact asset ID.
 */

import { getClient } from "../client.js";
import type { Asset, DomainTools, ListInfo, SuperOpsJson } from "../types.js";

const DEFAULT_LIST_PAGE = 1;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;
const DEFAULT_FIND_MAX_PAGES = 20;
const SCRIPT_PLATFORM_TYPES = ["WINDOWS", "MAC", "LINUX"] as const;

type ScriptPlatformType = (typeof SCRIPT_PLATFORM_TYPES)[number];

const SCRIPT_FIELDS = `
  scriptId
  name
  description
  language
  addedBy
  createdTime
  favourite
  runAs
  runTimeVariables
  timeOut
  tags
`;

const LIST_SCRIPTS_QUERY = `
  query getScriptList($input: ListInfoInput!) {
    getScriptList(input: $input) {
      scripts {
        ${SCRIPT_FIELDS}
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

const LIST_SCRIPTS_BY_TYPE_QUERY = `
  query getScriptListByType($input: ScriptListByTypeInput!) {
    getScriptListByType(input: $input) {
      scripts {
        ${SCRIPT_FIELDS}
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
      hostName
      client
      status
      platform
      platformFamily
      platformCategory
      platformVersion
      lastCommunicatedTime
      deviceCategory
      assetClass
    }
  }
`;

const GET_ASSET_ACTIVITY_QUERY = `
  query getAssetActivity($input: AssetDetailsListInput!) {
    getAssetActivity(input: $input) {
      activities {
        activityId
        module
        activityType
        activityData
        createdBy
        createdTime
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

const RUN_SCRIPT_ON_ASSET_MUTATION = `
  mutation runScriptOnAsset($input: RunScriptInput!) {
    runScriptOnAsset(input: $input) {
      actionConfigId
      script
      scriptArguments
      addedBy
    }
  }
`;

interface Script {
  scriptId: string;
  name?: string;
  description?: string;
  language?: string;
  addedBy?: SuperOpsJson;
  createdTime?: string;
  favourite?: boolean;
  runAs?: string;
  runTimeVariables?: string[];
  timeOut?: number;
  tags?: SuperOpsJson;
}

interface ScriptListResponse {
  getScriptList: {
    scripts: Script[];
    listInfo: ListInfo;
  };
}

interface ScriptListByTypeResponse {
  getScriptListByType: {
    scripts: Script[];
    listInfo: ListInfo;
  };
}

interface GetAssetResponse {
  getAsset: Asset | null;
}

interface AssetActivity {
  activityId?: string;
  module?: string;
  activityType?: string;
  activityData?: SuperOpsJson;
  createdBy?: SuperOpsJson;
  createdTime?: string;
}

interface AssetActivityResponse {
  getAssetActivity: {
    activities: AssetActivity[];
    listInfo: ListInfo;
  };
}

interface RunScriptResponse {
  runScriptOnAsset: {
    actionConfigId?: string;
    script?: SuperOpsJson;
    scriptArguments?: SuperOpsJson;
    addedBy?: SuperOpsJson;
  } | null;
}

function pageInput(max: number | undefined, defaultPageSize = DEFAULT_PAGE_SIZE, page?: number) {
  return {
    page: page ?? DEFAULT_LIST_PAGE,
    pageSize: Math.min(max ?? defaultPageSize, MAX_PAGE_SIZE),
  };
}

function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeId(value: unknown): string | undefined {
  const text = stringValue(value);
  return text ? text : undefined;
}

function listInfoWithReadMetadata(listInfo: ListInfo, returnedCount: number) {
  const complete = listInfo.hasMore === false;
  const truncated = listInfo.hasMore === true;
  return {
    page: listInfo.page,
    pageSize: listInfo.pageSize,
    hasMore: listInfo.hasMore,
    totalCount: listInfo.totalCount,
    readMetadata: {
      complete,
      truncated,
      truncationReason: truncated ? "upstreamHasMore" : undefined,
      returnedCount,
      upstreamTotalCount: listInfo.totalCount,
      completeness: complete ? "known" : truncated ? "partial" : "unknown",
      continuation: truncated && typeof listInfo.page === "number"
        ? { nextPage: listInfo.page + 1, pageSize: listInfo.pageSize }
        : undefined,
    },
  };
}

function sanitizeScript(script: Script) {
  return {
    scriptId: script.scriptId,
    name: script.name,
    description: script.description,
    language: script.language,
    addedBy: script.addedBy,
    createdTime: script.createdTime,
    favourite: script.favourite,
    runAs: script.runAs,
    runTimeVariables: script.runTimeVariables,
    timeOut: script.timeOut,
    tags: script.tags,
    contentsReturned: false,
  };
}

function redactScriptArguments(value: unknown): unknown {
  if (!Array.isArray(value)) return value === undefined ? undefined : "[redacted]";
  return value.map((entry) => {
    const record = jsonRecord(entry);
    if (!record) return "[redacted]";
    return { name: record.name, value: "[redacted]" };
  });
}

function filterScripts(
  scripts: Script[],
  filters: { search?: string; language?: string; tag?: string; favourite?: boolean }
): Script[] {
  const search = filters.search?.trim().toLowerCase();
  const language = filters.language?.trim().toLowerCase();
  const tag = filters.tag?.trim().toLowerCase();
  return scripts.filter((script) => {
    if (search) {
      const haystack = [script.scriptId, script.name, script.description]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    if (language && script.language?.toLowerCase() !== language) return false;
    if (typeof filters.favourite === "boolean" && script.favourite !== filters.favourite) return false;
    if (tag) {
      const tagsText = JSON.stringify(script.tags ?? []).toLowerCase();
      if (!tagsText.includes(tag)) return false;
    }
    return true;
  });
}

async function queryScriptList(
  client: ReturnType<typeof getClient>,
  input: { page?: number; max?: number; type?: ScriptPlatformType }
): Promise<{ scripts: Script[]; listInfo: ListInfo }> {
  if (input.type) {
    const response = await client.query<ScriptListByTypeResponse>(LIST_SCRIPTS_BY_TYPE_QUERY, {
      input: { type: input.type, listInfo: pageInput(input.max, DEFAULT_PAGE_SIZE, input.page) },
    });
    return response.getScriptListByType;
  }

  const response = await client.query<ScriptListResponse>(LIST_SCRIPTS_QUERY, {
    input: pageInput(input.max, DEFAULT_PAGE_SIZE, input.page),
  });
  return response.getScriptList;
}

async function findScriptById(
  client: ReturnType<typeof getClient>,
  scriptId: string,
  params: { type?: ScriptPlatformType; maxPages?: number } = {}
): Promise<{ script: Script; listType?: ScriptPlatformType }> {
  const maxPages = params.maxPages ?? DEFAULT_FIND_MAX_PAGES;
  let page = 1;
  let sawMore = false;
  const matches: Script[] = [];

  while (page <= maxPages) {
    const response = await queryScriptList(client, { page, max: MAX_PAGE_SIZE, type: params.type });
    for (const script of response.scripts) {
      if (script.scriptId === scriptId) matches.push(script);
    }
    sawMore = response.listInfo.hasMore === true;
    if (matches.length > 1) {
      throw new Error(`Ambiguous script identity: scriptId ${scriptId} appeared more than once.`);
    }
    if (matches.length === 1) {
      return { script: matches[0], listType: params.type };
    }
    if (!sawMore) break;
    page += 1;
  }

  if (sawMore) {
    throw new Error(`API uncertainty: scriptId ${scriptId} was not found before the script list pagination limit.`);
  }
  throw new Error(`Script not found for exact scriptId ${scriptId}.`);
}

function assetClient(asset: Asset): { accountId?: string; name?: string } {
  const client = jsonRecord(asset.client);
  return {
    accountId: stringValue(client?.accountId),
    name: stringValue(client?.name),
  };
}

function assetPlatformType(asset: Asset): ScriptPlatformType | undefined {
  const deviceCategory = jsonRecord(asset.deviceCategory);
  const assetClass = jsonRecord(asset.assetClass);
  const text = [
    asset.platform,
    asset.platformFamily,
    asset.platformCategory,
    asset.platformVersion,
    deviceCategory?.name,
    assetClass?.name,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ");

  if (/windows/i.test(text)) return "WINDOWS";
  if (/\b(mac|macos|os x|darwin)\b/i.test(text)) return "MAC";
  if (/\b(linux|ubuntu|debian|centos|red hat|rhel)\b/i.test(text)) return "LINUX";
  return undefined;
}

function scriptLanguageSupported(language: string | undefined): boolean {
  return !!language && /^(powershell|bat|batch|vbscript|bash)$/i.test(language.trim());
}

function assertAllowedExecutionArgs(args: Record<string, unknown>): void {
  const allowed = new Set([
    "scriptId",
    "expectedScriptName",
    "assetId",
    "expectedAssetNameOrHostname",
    "expectedClientAccountId",
    "reviewed",
  ]);
  const forbidden = [
    "script",
    "scriptText",
    "source",
    "code",
    "command",
    "commands",
    "powershell",
    "shell",
    "python",
    "assetIds",
    "assets",
    "clientIds",
    "siteId",
    "siteIds",
  ];
  const supplied = Object.keys(args);
  const forbiddenHit = supplied.find((key) => forbidden.includes(key));
  if (forbiddenHit) {
    throw new Error(`${forbiddenHit} is not accepted. This tool only runs an existing saved script by exact scriptId against one exact assetId.`);
  }
  const unknown = supplied.filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`Unsupported execution input field(s): ${unknown.join(", ")}.`);
  }
}

async function readAndValidateExecutionTarget(
  client: ReturnType<typeof getClient>,
  args: Record<string, unknown>
): Promise<{ script: Script; asset: Asset; platformType: ScriptPlatformType }> {
  assertAllowedExecutionArgs(args);

  const scriptId = normalizeId(args.scriptId);
  const assetId = normalizeId(args.assetId);
  const expectedScriptName = stringValue(args.expectedScriptName);
  const expectedAssetNameOrHostname = stringValue(args.expectedAssetNameOrHostname);
  const expectedClientAccountId = stringValue(args.expectedClientAccountId);

  if (!scriptId) throw new Error("scriptId is required.");
  if (!assetId) throw new Error("assetId is required.");
  if (!expectedScriptName) throw new Error("expectedScriptName is required.");
  if (!expectedAssetNameOrHostname) throw new Error("expectedAssetNameOrHostname is required.");
  if (!expectedClientAccountId) throw new Error("expectedClientAccountId is required.");
  if (args.reviewed !== true) {
    throw new Error("reviewed must be true after the selected asset and saved script have been reviewed.");
  }

  const { script } = await findScriptById(client, scriptId);
  if (!script.name) throw new Error("Missing required script metadata: name.");
  if (script.name !== expectedScriptName) {
    throw new Error(`Script name mismatch for ${scriptId}. Expected ${expectedScriptName}, found ${script.name}.`);
  }
  if (!scriptLanguageSupported(script.language)) {
    throw new Error(`Unsupported script type or missing language for scriptId ${scriptId}.`);
  }
  if ((script.runTimeVariables ?? []).length > 0) {
    throw new Error("Unsupported script type: scripts with runtime variables are not executable by this safe tool version.");
  }

  const assetResponse = await client.query<GetAssetResponse>(GET_ASSET_QUERY, { input: { assetId } });
  const asset = assetResponse.getAsset;
  if (!asset || asset.assetId !== assetId) {
    throw new Error(`Asset not found or ambiguous for exact assetId ${assetId}.`);
  }

  const identityMatches = asset.name === expectedAssetNameOrHostname || asset.hostName === expectedAssetNameOrHostname;
  if (!identityMatches) {
    throw new Error(`Asset identity mismatch for ${assetId}. Expected asset name or hostname ${expectedAssetNameOrHostname}.`);
  }

  const clientInfo = assetClient(asset);
  if (!clientInfo.accountId) {
    throw new Error("Missing required asset metadata: client.accountId.");
  }
  if (clientInfo.accountId !== expectedClientAccountId) {
    throw new Error(`Client mismatch for assetId ${assetId}. Expected ${expectedClientAccountId}, found ${clientInfo.accountId}.`);
  }

  if (!asset.status) {
    throw new Error("Missing required asset metadata: status.");
  }
  if (!/^online$/i.test(asset.status)) {
    throw new Error(`Asset ${assetId} is not available for script execution. Current status: ${asset.status}.`);
  }

  const platformType = assetPlatformType(asset);
  if (!platformType) {
    throw new Error("Missing required asset metadata: supported platform could not be determined.");
  }

  const supported = await findScriptById(client, scriptId, { type: platformType });
  if (supported.script.name !== script.name) {
    throw new Error("API uncertainty: platform-specific script metadata did not match the reviewed script.");
  }

  return { script, asset, platformType };
}

function activityExecutionId(activity: AssetActivity): string | undefined {
  const data = jsonRecord(activity.activityData);
  return stringValue(data?.actionConfigId) ?? stringValue(data?.actionId) ?? stringValue(data?.id) ?? stringValue(activity.activityId);
}

function activityScriptId(activity: AssetActivity): string | undefined {
  const data = jsonRecord(activity.activityData);
  const script = jsonRecord(data?.script);
  return stringValue(data?.scriptId) ?? stringValue(script?.scriptId);
}

function isScriptActivity(activity: AssetActivity): boolean {
  const text = [activity.module, activity.activityType, JSON.stringify(activity.activityData ?? {})]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return text.includes("script") || text.includes("actionconfigid");
}

function activityStatus(activity: AssetActivity): { status?: unknown; result?: unknown; output?: unknown; error?: unknown } {
  const data = jsonRecord(activity.activityData);
  return {
    status: data?.status ?? data?.executionStatus ?? data?.state,
    result: data?.result,
    output: data?.output ?? data?.stdOut ?? data?.stdout,
    error: data?.error ?? data?.stdErr ?? data?.stderr,
  };
}

function sanitizeActivity(activity: AssetActivity) {
  return {
    executionId: activityExecutionId(activity),
    scriptId: activityScriptId(activity),
    activityId: activity.activityId,
    module: activity.module,
    activityType: activity.activityType,
    createdTime: activity.createdTime,
    createdBy: activity.createdBy,
    activityData: activity.activityData,
    ...activityStatus(activity),
  };
}

async function findExecutionActivity(
  client: ReturnType<typeof getClient>,
  params: { assetId: string; executionId: string; maxPages?: number }
): Promise<AssetActivity> {
  const maxPages = params.maxPages ?? DEFAULT_FIND_MAX_PAGES;
  let page = 1;
  let sawMore = false;
  while (page <= maxPages) {
    const response = await client.query<AssetActivityResponse>(GET_ASSET_ACTIVITY_QUERY, {
      input: { assetId: params.assetId, listInfo: pageInput(MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE, page) },
    });
    const matches = response.getAssetActivity.activities.filter((activity) => activityExecutionId(activity) === params.executionId);
    if (matches.length > 1) {
      throw new Error(`Ambiguous execution identity: executionId ${params.executionId} appeared more than once for assetId ${params.assetId}.`);
    }
    if (matches.length === 1) return matches[0];
    sawMore = response.getAssetActivity.listInfo.hasMore === true;
    if (!sawMore) break;
    page += 1;
  }
  if (sawMore) {
    throw new Error(`API uncertainty: executionId ${params.executionId} was not found before the activity pagination limit.`);
  }
  throw new Error(`Script execution ${params.executionId} was not found for assetId ${params.assetId}.`);
}

export function getScriptsTools(): DomainTools {
  return {
    tools: [
      {
        name: "superops_scripts_list",
        description: "List saved SuperOps RMM scripts by metadata. Does not return script source.",
        inputSchema: {
          type: "object",
          properties: {
            type: { type: "string", enum: [...SCRIPT_PLATFORM_TYPES], description: "Optional SuperOps script platform type." },
            search: { type: "string", description: "Client-side search across script ID, name, and description." },
            language: { type: "string", description: "Client-side exact language filter, for example PowerShell or Bash." },
            tag: { type: "string", description: "Client-side tag text filter." },
            favourite: { type: "boolean", description: "Filter favourite scripts." },
            max: { type: "number", default: 100, description: "Maximum records to fetch from SuperOps for this page." },
            page: { type: "number", default: 1, description: "Script list page to fetch." },
          },
        },
      },
      {
        name: "superops_scripts_get",
        description: "Get one saved SuperOps script's safe metadata by exact script ID. Does not return script source.",
        inputSchema: {
          type: "object",
          properties: {
            scriptId: { type: "string", description: "Exact saved SuperOps script ID." },
          },
          required: ["scriptId"],
        },
      },
      {
        name: "superops_scripts_supported_targets",
        description: "Identify which SuperOps script platform types currently include a saved script ID.",
        inputSchema: {
          type: "object",
          properties: {
            scriptId: { type: "string", description: "Exact saved SuperOps script ID." },
          },
          required: ["scriptId"],
        },
      },
      {
        name: "superops_scripts_executions_list",
        description: "List script-like asset activity records for one exact asset. Does not submit or resubmit scripts.",
        inputSchema: {
          type: "object",
          properties: {
            assetId: { type: "string", description: "Exact asset ID whose script activity should be read." },
            scriptId: { type: "string", description: "Optional exact script ID filter when activity data includes it." },
            executionId: { type: "string", description: "Optional execution/action ID filter." },
            max: { type: "number", default: 100, description: "Maximum activity records to fetch for this page." },
            page: { type: "number", default: 1, description: "Activity page to fetch." },
          },
          required: ["assetId"],
        },
      },
      {
        name: "superops_scripts_execution_get",
        description: "Retrieve one script execution/action record from asset activity. Does not submit or resubmit scripts.",
        inputSchema: {
          type: "object",
          properties: {
            assetId: { type: "string", description: "Exact asset ID associated with the script execution." },
            executionId: { type: "string", description: "Exact actionConfigId/execution ID returned by script submission." },
          },
          required: ["assetId", "executionId"],
        },
      },
      {
        name: "superops_scripts_execute_on_asset",
        description: "Execute one existing saved SuperOps script by exact script ID against one exact reviewed asset ID. Does not accept script source or bulk targets.",
        inputSchema: {
          type: "object",
          properties: {
            scriptId: { type: "string", description: "Exact saved SuperOps script ID to run." },
            expectedScriptName: { type: "string", description: "Exact script name observed during review." },
            assetId: { type: "string", description: "Exact single asset ID to target." },
            expectedAssetNameOrHostname: { type: "string", description: "Exact asset name or hostname observed during review." },
            expectedClientAccountId: { type: "string", description: "Exact client account ID expected for the selected asset." },
            reviewed: { type: "boolean", description: "Must be true after the saved script and target asset have been reviewed." },
          },
          required: ["scriptId", "expectedScriptName", "assetId", "expectedAssetNameOrHostname", "expectedClientAccountId", "reviewed"],
        },
      },
    ],

    async handleCall(name, args) {
      const client = getClient();
      try {
        switch (name) {
          case "superops_scripts_list": {
            const params = args as { type?: ScriptPlatformType; search?: string; language?: string; tag?: string; favourite?: boolean; max?: number; page?: number };
            const response = await queryScriptList(client, { type: params.type, max: params.max, page: params.page });
            const scripts = filterScripts(response.scripts, params).map(sanitizeScript);
            return { content: [{ type: "text", text: JSON.stringify({ scripts, ...listInfoWithReadMetadata(response.listInfo, scripts.length) }, null, 2) }] };
          }

          case "superops_scripts_get": {
            const scriptId = normalizeId(args.scriptId);
            if (!scriptId) throw new Error("scriptId is required.");
            const { script } = await findScriptById(client, scriptId);
            return { content: [{ type: "text", text: JSON.stringify(sanitizeScript(script), null, 2) }] };
          }

          case "superops_scripts_supported_targets": {
            const scriptId = normalizeId(args.scriptId);
            if (!scriptId) throw new Error("scriptId is required.");
            const platforms: ScriptPlatformType[] = [];
            const scripts: Record<string, unknown> = {};
            for (const platform of SCRIPT_PLATFORM_TYPES) {
              try {
                const { script } = await findScriptById(client, scriptId, { type: platform, maxPages: 5 });
                platforms.push(platform);
                scripts[platform] = sanitizeScript(script);
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                if (!/Script not found/.test(message)) throw error;
              }
            }
            return { content: [{ type: "text", text: JSON.stringify({ scriptId, supportedPlatformTypes: platforms, scripts }, null, 2) }] };
          }

          case "superops_scripts_executions_list": {
            const assetId = normalizeId(args.assetId);
            if (!assetId) throw new Error("assetId is required.");
            const params = args as { scriptId?: string; executionId?: string; max?: number; page?: number };
            const response = await client.query<AssetActivityResponse>(GET_ASSET_ACTIVITY_QUERY, {
              input: { assetId, listInfo: pageInput(params.max, DEFAULT_PAGE_SIZE, params.page) },
            });
            const scriptId = normalizeId(params.scriptId);
            const executionId = normalizeId(params.executionId);
            const activities = response.getAssetActivity.activities
              .filter(isScriptActivity)
              .filter((activity) => !scriptId || activityScriptId(activity) === scriptId)
              .filter((activity) => !executionId || activityExecutionId(activity) === executionId)
              .map(sanitizeActivity);
            return { content: [{ type: "text", text: JSON.stringify({ assetId, executions: activities, ...listInfoWithReadMetadata(response.getAssetActivity.listInfo, activities.length) }, null, 2) }] };
          }

          case "superops_scripts_execution_get": {
            const assetId = normalizeId(args.assetId);
            const executionId = normalizeId(args.executionId);
            if (!assetId) throw new Error("assetId is required.");
            if (!executionId) throw new Error("executionId is required.");
            const activity = await findExecutionActivity(client, { assetId, executionId });
            return { content: [{ type: "text", text: JSON.stringify({ assetId, ...sanitizeActivity(activity) }, null, 2) }] };
          }

          case "superops_scripts_execute_on_asset": {
            const { script, asset, platformType } = await readAndValidateExecutionTarget(client, args);
            try {
              const response = await client.mutate<RunScriptResponse>(RUN_SCRIPT_ON_ASSET_MUTATION, {
                input: { assetId: asset.assetId, scriptId: script.scriptId },
              });
              const execution = response.runScriptOnAsset;
              const executionId = stringValue(execution?.actionConfigId);
              if (!executionId) {
                throw new Error("API uncertainty: runScriptOnAsset did not return actionConfigId.");
              }
              return {
                content: [{
                  type: "text",
                  text: JSON.stringify({
                    executionId,
                    actionConfigId: executionId,
                    submitted: true,
                    replaySafe: false,
                    statusTool: "superops_scripts_execution_get",
                    statusInput: { assetId: asset.assetId, executionId },
                    script: sanitizeScript(script),
                    asset: {
                      assetId: asset.assetId,
                      name: asset.name,
                      hostName: asset.hostName,
                      client: assetClient(asset),
                      platform: asset.platform,
                      platformType,
                      status: asset.status,
                    },
                    runScriptOnAsset: {
                      actionConfigId: executionId,
                      script: execution?.script,
                      scriptArguments: redactScriptArguments(execution?.scriptArguments),
                      addedBy: execution?.addedBy,
                    },
                  }, null, 2),
                }],
              };
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              return {
                content: [{
                  type: "text",
                  text: JSON.stringify({
                    submitted: false,
                    uncertainSubmission: true,
                    writeMayHaveSucceeded: true,
                    replaySafe: false,
                    retryAttempted: false,
                    executionId: undefined,
                    reason: message,
                    statusTool: "superops_scripts_execution_get",
                    statusInput: { assetId: asset.assetId, executionId: "<actionConfigId if SuperOps accepted the request>" },
                  }, null, 2),
                }],
                isError: true,
              };
            }
          }

          default:
            return { content: [{ type: "text", text: `Unknown scripts tool: ${name}` }], isError: true };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
      }
    },
  };
}
