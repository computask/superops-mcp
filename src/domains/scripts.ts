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
const SCRIPT_CATALOGUE_MAX_RECORDS = 500;
const SCRIPT_CATALOGUE_MAX_RECOMMENDATION_CANDIDATES = 100;
const SCRIPT_CATALOGUE_MAX_REJECTED_MATCHES = 20;
const SCRIPT_CATALOGUE_RECOMMENDATION_STATES = [
  "DEFINITIVE_RECOMMENDATION",
  "NEEDS_DETAILS",
  "NO_SUITABLE_SCRIPT",
  "CATALOGUE_UNAVAILABLE",
  "CATALOGUE_DEGRADED",
] as const;
const SCRIPT_CATALOGUE_SYNC_STATES = ["COMPLETE", "INCOMPLETE", "UNAVAILABLE", "DEGRADED"] as const;

type ScriptPlatformType = (typeof SCRIPT_PLATFORM_TYPES)[number];
type ScriptCatalogueStatus = "REVIEWED" | "UNREVIEWED" | "REJECTED";
type ScriptCatalogueSyncState = (typeof SCRIPT_CATALOGUE_SYNC_STATES)[number];
type ScriptCatalogueRecommendationState = (typeof SCRIPT_CATALOGUE_RECOMMENDATION_STATES)[number];

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

interface ScriptCatalogueMetadata {
  catalogueStatus: ScriptCatalogueStatus;
  markers: string[];
  supportedPlatforms: ScriptPlatformType[];
  prerequisites: string[];
  safetyRequirements: string[];
  sourceReviewTime?: string;
  unsuitable: boolean;
}

interface ScriptCatalogueEntry {
  script: Script;
  metadata: ScriptCatalogueMetadata;
}

interface ScriptCatalogueSnapshot {
  entries: ScriptCatalogueEntry[];
  syncState: ScriptCatalogueSyncState;
  latestSyncAttemptAt: string;
  upstreamHasMore: boolean | null;
  upstreamTotalCount?: number;
}

interface ScriptCatalogueRecommendationParams {
  request: string;
  targetPlatform?: ScriptPlatformType;
  platformVerified: boolean;
  verifiedPrerequisites?: string[];
  prerequisitesMet?: boolean;
  safetyRequirementsVerified: boolean;
  maxCandidates: number;
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

function normalizedCatalogueMarker(value: string): string {
  return value.trim().toUpperCase().replace(/[\s-]+/g, "_");
}

function canonicalScriptPlatform(value: unknown): ScriptPlatformType | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toUpperCase();
  if (normalized === "WINDOWS" || normalized === "WIN") return "WINDOWS";
  if (normalized === "MAC" || normalized === "MACOS" || normalized === "OSX") return "MAC";
  if (normalized === "LINUX") return "LINUX";
  return undefined;
}

function boundedStringList(value: unknown, max = 20): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const text = entry.trim().replace(/\s+/g, " ");
    if (!text || text.length > 120 || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    result.push(text);
    if (result.length >= max) break;
  }
  return result;
}

function scriptCatalogueMetadata(script: Script): ScriptCatalogueMetadata {
  const tagRecord = jsonRecord(script.tags);
  const scriptRecord = jsonRecord(script);
  const publishedRecord = jsonRecord(scriptRecord?.catalogue) ?? scriptRecord;
  const rawTags = Array.isArray(script.tags)
    ? script.tags.filter((tag): tag is string => typeof tag === "string")
    : [];
  const objectMarkers = [
    publishedRecord?.status,
    publishedRecord?.reviewStatus,
    publishedRecord?.catalogueStatus,
    ...(Array.isArray(publishedRecord?.flags) ? publishedRecord.flags : []),
    tagRecord?.status,
    tagRecord?.reviewStatus,
    tagRecord?.catalogueStatus,
    ...(Array.isArray(tagRecord?.flags) ? tagRecord.flags : []),
  ].filter((value): value is string => typeof value === "string");
  const markers = [...new Set(
    [...rawTags, ...objectMarkers]
      .flatMap((tag) => tag.split(/[,;|]/g))
      .map(normalizedCatalogueMarker)
      .filter(Boolean)
  )].slice(0, 30);
  const markerSet = new Set(markers);
  const supportedPlatforms = SCRIPT_PLATFORM_TYPES.filter((platform) =>
    markerSet.has(platform) || markerSet.has(`PLATFORM_${platform}`) ||
    markerSet.has(`SUPPORTED_${platform}`) ||
    boundedStringList(publishedRecord?.supportedPlatforms).some((value) => canonicalScriptPlatform(value) === platform)
  );
  const prerequisites = [
    ...boundedStringList(publishedRecord?.prerequisites),
    ...boundedStringList(tagRecord?.prerequisites),
    ...markers
      .filter((marker) => marker.startsWith("REQUIRES_"))
      .map((marker) => marker.slice("REQUIRES_".length).replace(/_/g, " ")),
  ].slice(0, 20);
  const safetyRequirements = [
    ...boundedStringList(publishedRecord?.safetyRequirements),
    ...boundedStringList(tagRecord?.safetyRequirements),
    ...markers
      .filter((marker) => marker.startsWith("SAFETY_"))
      .map((marker) => marker.slice("SAFETY_".length).replace(/_/g, " ")),
  ].slice(0, 20);
  const rawStatus = [
    publishedRecord?.status,
    publishedRecord?.reviewStatus,
    publishedRecord?.catalogueStatus,
    tagRecord?.status,
    tagRecord?.reviewStatus,
    tagRecord?.catalogueStatus,
  ].find((value): value is string => typeof value === "string");
  const explicitRejected = markerSet.has("DO_NOT_USE") || markerSet.has("LEGACY") ||
    markerSet.has("UNSUITABLE") || tagRecord?.suitable === false || tagRecord?.usable === false ||
    publishedRecord?.suitable === false || publishedRecord?.usable === false;
  const reviewed = normalizedCatalogueMarker(rawStatus ?? "") === "REVIEWED" ||
    markerSet.has("REVIEWED");
  const sourceReviewTime = [
    publishedRecord?.sourceReviewTime,
    publishedRecord?.reviewedAt,
    publishedRecord?.reviewTime,
    tagRecord?.sourceReviewTime,
    tagRecord?.reviewedAt,
    tagRecord?.reviewTime,
  ].find((value): value is string =>
    typeof value === "string" && Number.isFinite(Date.parse(value))
  );

  return {
    catalogueStatus: explicitRejected ? "REJECTED" : reviewed ? "REVIEWED" : "UNREVIEWED",
    markers,
    supportedPlatforms,
    prerequisites,
    safetyRequirements,
    sourceReviewTime,
    unsuitable: explicitRejected,
  };
}

function scriptCatalogueEntry(script: Script): ScriptCatalogueEntry {
  return { script, metadata: scriptCatalogueMetadata(script) };
}

function uniqueScriptCatalogueEntries(scripts: Script[]): ScriptCatalogueEntry[] {
  const seen = new Set<string>();
  const entries: ScriptCatalogueEntry[] = [];
  for (const script of scripts) {
    if (!script.scriptId || seen.has(script.scriptId)) continue;
    seen.add(script.scriptId);
    entries.push(scriptCatalogueEntry(script));
  }
  return entries;
}

function scriptCatalogueSummary(snapshot: ScriptCatalogueSnapshot) {
  const reviewed = snapshot.entries.filter((entry) => entry.metadata.catalogueStatus === "REVIEWED");
  const rejected = snapshot.entries.filter((entry) => entry.metadata.catalogueStatus === "REJECTED");
  return {
    syncState: snapshot.syncState,
    latestSyncAttemptAt: snapshot.latestSyncAttemptAt,
    upstreamHasMore: snapshot.upstreamHasMore,
    upstreamTotalCount: snapshot.upstreamTotalCount,
    coverageComplete: snapshot.syncState === "COMPLETE",
    coverageMayBeIncomplete: snapshot.syncState !== "COMPLETE",
    catalogueAvailable: snapshot.syncState !== "UNAVAILABLE",
    publishedRecordCount: snapshot.entries.length,
    publishedReviewedRecordCount: reviewed.length,
    rejectedRecordCount: rejected.length,
    sourceReviewTimesAvailable: snapshot.entries.some((entry) => Boolean(entry.metadata.sourceReviewTime)),
    sourceReviewTime: reviewed
      .map((entry) => entry.metadata.sourceReviewTime)
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1),
  };
}

async function loadScriptCatalogue(
  client: ReturnType<typeof getClient>,
  max = SCRIPT_CATALOGUE_MAX_RECORDS
): Promise<ScriptCatalogueSnapshot> {
  const latestSyncAttemptAt = new Date().toISOString();
  const response = await queryScriptList(client, {
    page: 1,
    max: Math.min(Math.max(Math.trunc(max), 1), SCRIPT_CATALOGUE_MAX_RECORDS),
  });
  const upstreamHasMore = response.listInfo.hasMore === true
    ? true
    : response.listInfo.hasMore === false
      ? false
      : null;
  const syncState: ScriptCatalogueSyncState = upstreamHasMore === false
    ? "COMPLETE"
    : upstreamHasMore === true
      ? "INCOMPLETE"
      : "DEGRADED";
  return {
    entries: uniqueScriptCatalogueEntries(response.scripts),
    syncState,
    latestSyncAttemptAt,
    upstreamHasMore,
    upstreamTotalCount: response.listInfo.totalCount,
  };
}

function recommendationTokens(value: string): string[] {
  return [...new Set(value.toLowerCase().match(/[a-z0-9]+/g) ?? [])]
    .filter((token) => token.length > 1)
    .slice(0, 40);
}

function scriptMatchScore(script: Script, request: string): number {
  const tokens = recommendationTokens(request);
  if (tokens.length === 0) return 0;
  const name = (script.name ?? "").toLowerCase();
  const description = (script.description ?? "").toLowerCase();
  const matched = tokens.filter((token) => name.includes(token) || description.includes(token));
  const nameMatched = tokens.filter((token) => name.includes(token)).length;
  const phraseBonus = request.trim().length > 0 &&
    `${name} ${description}`.includes(request.trim().toLowerCase()) ? 15 : 0;
  return Math.min(100, Math.round((matched.length / tokens.length) * 75) +
    Math.min(20, nameMatched * 5) + phraseBonus);
}

function canonicalPlatform(value: unknown): ScriptPlatformType | undefined {
  return canonicalScriptPlatform(value);
}

function normalizedPrerequisites(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return boundedStringList(value, 20).map((entry) => entry.toLowerCase());
}

function evaluateScriptSuitability(
  entry: ScriptCatalogueEntry,
  params: ScriptCatalogueRecommendationParams
): {
  eligible: boolean;
  needsDetails: boolean;
  suitabilityRank: number;
  reasons: string[];
} {
  const { metadata } = entry;
  const reasons: string[] = [];
  if (metadata.catalogueStatus !== "REVIEWED") {
    reasons.push(`Catalogue status is ${metadata.catalogueStatus}, not REVIEWED.`);
  }
  if (metadata.markers.includes("DO_NOT_USE")) reasons.push("Catalogue marker DO_NOT_USE is present.");
  if (metadata.markers.includes("LEGACY")) reasons.push("Catalogue marker LEGACY is present.");
  if (metadata.unsuitable) reasons.push("Reviewed catalogue metadata marks this script unsuitable.");
  if (params.targetPlatform && !params.platformVerified) {
    reasons.push("Target platform was supplied but not verified.");
  }
  if (!params.targetPlatform && metadata.supportedPlatforms.length > 0) {
    reasons.push("A compatible target platform is required but was not supplied and verified.");
  }
  if (params.targetPlatform && metadata.supportedPlatforms.length > 0 &&
      !metadata.supportedPlatforms.includes(params.targetPlatform)) {
    reasons.push(`Verified target platform ${params.targetPlatform} is incompatible.`);
  }
  if (metadata.prerequisites.length > 0) {
    if (params.prerequisitesMet === false) {
      reasons.push("Required prerequisites are known not to be met.");
    } else if (!params.verifiedPrerequisites) {
      reasons.push("Required prerequisites have not been verified.");
    } else {
      const verified = new Set(params.verifiedPrerequisites.map((value) => value.toLowerCase()));
      const missing = metadata.prerequisites.filter((value) => !verified.has(value.toLowerCase()));
      if (missing.length > 0) reasons.push(`Required prerequisites are missing: ${missing.join(", ")}.`);
    }
  }
  if (metadata.safetyRequirements.length > 0 && !params.safetyRequirementsVerified) {
    reasons.push("Catalogue safety requirements prevent an advisory recommendation until verified.");
  }

  const hardRejected = metadata.catalogueStatus !== "REVIEWED" || metadata.unsuitable ||
    metadata.markers.includes("DO_NOT_USE") || metadata.markers.includes("LEGACY") ||
    (params.targetPlatform !== undefined && metadata.supportedPlatforms.length > 0 &&
      !metadata.supportedPlatforms.includes(params.targetPlatform)) ||
    params.prerequisitesMet === false ||
    (metadata.prerequisites.length > 0 && params.verifiedPrerequisites !== undefined &&
      metadata.prerequisites.some((value) => !params.verifiedPrerequisites!.some(
        (verified) => verified.toLowerCase() === value.toLowerCase()
      )));
  const needsDetails = !hardRejected && reasons.length > 0;
  return {
    eligible: reasons.length === 0,
    needsDetails,
    suitabilityRank: reasons.length === 0 ? 100 : hardRejected ? 0 : 50,
    reasons,
  };
}

function catalogueScriptView(entry: ScriptCatalogueEntry) {
  return {
    ...sanitizeScript(entry.script),
    catalogue: {
      status: entry.metadata.catalogueStatus,
      markers: entry.metadata.markers,
      supportedPlatforms: entry.metadata.supportedPlatforms,
      prerequisites: entry.metadata.prerequisites,
      safetyRequirements: entry.metadata.safetyRequirements,
      sourceReviewTime: entry.metadata.sourceReviewTime,
      suitable: !entry.metadata.unsuitable,
    },
  };
}

function recommendationMatchView(params: {
  entry: ScriptCatalogueEntry;
  matchScore: number;
  suitabilityRank: number;
  reasons: string[];
  selectionReason?: string;
}) {
  return {
    scriptId: params.entry.script.scriptId,
    name: params.entry.script.name,
    matchScore: params.matchScore,
    suitabilityRank: params.suitabilityRank,
    selectionReason: params.selectionReason,
    catalogueStatus: params.entry.metadata.catalogueStatus,
    markers: params.entry.metadata.markers,
    supportedPlatforms: params.entry.metadata.supportedPlatforms,
    prerequisites: params.entry.metadata.prerequisites,
    reasons: params.reasons,
    advisoryOnly: true,
    executionAuthorised: false,
  };
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
        name: "superops_script_catalog_status",
        description:
          "Read-only status for the existing published saved-script catalogue. An INCOMPLETE or DEGRADED sync means coverage cannot be claimed complete, but it does not invalidate a specific published REVIEWED record that is present. Does not return script source or authorise execution.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "superops_script_catalog_get",
        description:
          "Read-only safe metadata for one exact published script-catalogue record. A record is advisory evidence only; REVIEWED status, platform applicability, prerequisites, and safety metadata are exposed without returning source or authorising execution.",
        inputSchema: {
          type: "object",
          properties: {
            scriptId: { type: "string", description: "Exact saved SuperOps script ID." },
          },
          required: ["scriptId"],
        },
      },
      {
        name: "superops_script_catalog_recommend",
        description:
          "Read-only advisory recommendation from the existing published script catalogue. Definitive recommendations require a present REVIEWED record with no DO_NOT_USE or LEGACY marker, compatible verified platform, met prerequisites, and satisfied safety requirements. NEEDS_DETAILS is only a candidate state. A catalogue recommendation never authorises script execution.",
        inputSchema: {
          type: "object",
          properties: {
            request: {
              type: "string",
              maxLength: 500,
              description: "Bounded task description used for lexical matching; do not include customer message bodies or secrets.",
            },
            targetPlatform: {
              type: "string",
              enum: [...SCRIPT_PLATFORM_TYPES],
              description: "Target platform when known. A platform-restricted script cannot be definitively recommended until this is verified.",
            },
            platformVerified: {
              type: "boolean",
              default: false,
              description: "Set true only when the target platform is verified from live asset evidence.",
            },
            verifiedPrerequisites: {
              type: "array",
              maxItems: 20,
              items: { type: "string", maxLength: 120 },
              description: "Bounded prerequisite identifiers confirmed by evidence.",
            },
            prerequisitesMet: {
              type: "boolean",
              description: "Explicitly false when known prerequisites are not met.",
            },
            safetyRequirementsVerified: {
              type: "boolean",
              default: false,
              description: "Set true only after the catalogue safety requirements are verified for this advisory context.",
            },
            maxCandidates: {
              type: "number",
              default: 20,
              description: "Maximum bounded catalogue records to inspect (max 100).",
            },
          },
          required: ["request"],
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

          case "superops_script_catalog_status": {
            try {
              const snapshot = await loadScriptCatalogue(client);
              return {
                content: [{
                  type: "text",
                  text: JSON.stringify({
                    ...scriptCatalogueSummary(snapshot),
                    advisoryOnly: true,
                    executionAuthorised: false,
                  }, null, 2),
                }],
              };
            } catch (error) {
              return {
                content: [{
                  type: "text",
                  text: JSON.stringify({
                    syncState: "UNAVAILABLE",
                    catalogueAvailable: false,
                    coverageComplete: false,
                    coverageMayBeIncomplete: true,
                    latestSyncAttemptAt: new Date().toISOString(),
                    advisoryOnly: true,
                    executionAuthorised: false,
                    error: error instanceof Error ? error.message.slice(0, 240) : "Catalogue read failed.",
                  }, null, 2),
                }],
                isError: true,
              };
            }
          }

          case "superops_script_catalog_get": {
            const scriptId = normalizeId(args.scriptId);
            if (!scriptId) throw new Error("scriptId is required.");
            const snapshot = await loadScriptCatalogue(client);
            const entry = snapshot.entries.find((candidate) => candidate.script.scriptId === scriptId);
            if (!entry) {
              return {
                content: [{
                  type: "text",
                  text: JSON.stringify({
                    found: false,
                    scriptId,
                    catalogue: scriptCatalogueSummary(snapshot),
                    advisoryOnly: true,
                    executionAuthorised: false,
                  }, null, 2),
                }],
              };
            }
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  found: true,
                  script: catalogueScriptView(entry),
                  catalogue: scriptCatalogueSummary(snapshot),
                  advisoryOnly: true,
                  executionAuthorised: false,
                }, null, 2),
              }],
            };
          }

          case "superops_script_catalog_recommend": {
            const request = stringValue(args.request);
            if (!request) throw new Error("request is required.");
            if (request.length > 500) throw new Error("request must not exceed 500 characters.");
            const targetPlatform = canonicalPlatform(args.targetPlatform);
            if (args.targetPlatform !== undefined && !targetPlatform) {
              throw new Error("targetPlatform must be WINDOWS, MAC, or LINUX.");
            }
            const verifiedPrerequisites = normalizedPrerequisites(args.verifiedPrerequisites);
            if (args.verifiedPrerequisites !== undefined && !verifiedPrerequisites) {
              throw new Error("verifiedPrerequisites must be an array of bounded strings.");
            }
            const maxCandidates = typeof args.maxCandidates === "number" && Number.isFinite(args.maxCandidates)
              ? Math.min(Math.max(Math.trunc(args.maxCandidates), 1), SCRIPT_CATALOGUE_MAX_RECOMMENDATION_CANDIDATES)
              : 20;
            const params: ScriptCatalogueRecommendationParams = {
              request,
              targetPlatform,
              platformVerified: args.platformVerified === true,
              verifiedPrerequisites,
              prerequisitesMet: typeof args.prerequisitesMet === "boolean" ? args.prerequisitesMet : undefined,
              safetyRequirementsVerified: args.safetyRequirementsVerified === true,
              maxCandidates,
            };

            let snapshot: ScriptCatalogueSnapshot;
            try {
              snapshot = await loadScriptCatalogue(client, maxCandidates);
            } catch (error) {
              return {
                content: [{
                  type: "text",
                  text: JSON.stringify({
                    recommendationState: "CATALOGUE_UNAVAILABLE",
                    bestMatch: null,
                    candidate: null,
                    rejectedMatches: [],
                    catalogue: {
                      syncState: "UNAVAILABLE",
                      catalogueAvailable: false,
                      coverageComplete: false,
                      coverageMayBeIncomplete: true,
                      latestSyncAttemptAt: new Date().toISOString(),
                    },
                    advisoryOnly: true,
                    executionAuthorised: false,
                    error: error instanceof Error ? error.message.slice(0, 240) : "Catalogue read failed.",
                  }, null, 2),
                }],
                isError: true,
              };
            }

            const ranked = snapshot.entries
              .map((entry) => {
                const suitability = evaluateScriptSuitability(entry, params);
                return {
                  entry,
                  matchScore: scriptMatchScore(entry.script, request),
                  ...suitability,
                };
              })
              .sort((left, right) =>
                right.suitabilityRank - left.suitabilityRank ||
                right.matchScore - left.matchScore ||
                left.entry.script.scriptId.localeCompare(right.entry.script.scriptId)
              );
            const eligible = ranked.filter((candidate) => candidate.eligible);
            const details = ranked.filter((candidate) => candidate.needsDetails);
            const rejected = ranked
              .filter((candidate) => !candidate.eligible && !candidate.needsDetails)
              .slice(0, SCRIPT_CATALOGUE_MAX_REJECTED_MATCHES)
              .map((candidate) => recommendationMatchView({
                entry: candidate.entry,
                matchScore: candidate.matchScore,
                suitabilityRank: candidate.suitabilityRank,
                reasons: candidate.reasons,
              }));
            const selected = eligible[0];
            const detailCandidate = details[0];
            const degradedSelectedCandidate = selected && snapshot.syncState === "DEGRADED"
              ? {
                  ...selected,
                  reasons: [
                    "Latest catalogue enumeration is degraded; coverage cannot be claimed complete.",
                  ],
                }
              : undefined;
            const recommendationState: ScriptCatalogueRecommendationState = selected && !degradedSelectedCandidate
              ? "DEFINITIVE_RECOMMENDATION"
              : detailCandidate
                ? "NEEDS_DETAILS"
                : snapshot.syncState !== "COMPLETE"
                  ? "CATALOGUE_DEGRADED"
                  : "NO_SUITABLE_SCRIPT";
            const selectionReason = selected && !degradedSelectedCandidate
              ? "Selected because reviewed safety and suitability outrank lexical matchScore; the recommendation is advisory only and does not authorise execution."
              : undefined;
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  recommendationState,
                  bestMatch: selected && !degradedSelectedCandidate
                    ? recommendationMatchView({
                        entry: selected.entry,
                        matchScore: selected.matchScore,
                        suitabilityRank: selected.suitabilityRank,
                        reasons: selected.reasons,
                        selectionReason,
                      })
                    : null,
                  candidate: (detailCandidate ?? degradedSelectedCandidate)
                    ? recommendationMatchView({
                        entry: (detailCandidate ?? degradedSelectedCandidate)!.entry,
                        matchScore: (detailCandidate ?? degradedSelectedCandidate)!.matchScore,
                        suitabilityRank: (detailCandidate ?? degradedSelectedCandidate)!.suitabilityRank,
                        reasons: (detailCandidate ?? degradedSelectedCandidate)!.reasons,
                      })
                    : null,
                  rejectedMatches: rejected,
                  alternatives: ranked.slice(0, Math.min(maxCandidates, 10)).map((candidate) =>
                    recommendationMatchView({
                      entry: candidate.entry,
                      matchScore: candidate.matchScore,
                      suitabilityRank: candidate.suitabilityRank,
                      reasons: candidate.reasons,
                    })
                  ),
                  catalogue: scriptCatalogueSummary(snapshot),
                  advisoryOnly: true,
                  executionAuthorised: false,
                  executionTool: "superops_scripts_execute_on_asset",
                }, null, 2),
              }],
            };
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
