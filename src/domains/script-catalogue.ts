/**
 * Central, read-only SuperOps script catalogue tools.
 *
 * These tools search the last complete authoritative snapshot. They deliberately
 * do not call the SuperOps API, execute scripts, or mutate tickets/scripts.
 */

import type { DomainTools } from "../types.js";
import { ensureInitialScriptCatalogueSeed } from "../script-catalogue-sync.js";
import {
  getScriptCatalogueStore,
  type ScriptCatalogueRecord,
  type ScriptCatalogueSafetyFlag,
  type ScriptCatalogueStatusRecord,
} from "../script-catalogue-store.js";

type RecommendationState = "FOUND" | "NEEDS_DETAILS" | "NO_CONFIDENT_MATCH";
type Confidence = "High" | "Medium" | "Low";

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "for", "from",
  "has", "have", "how", "i", "in", "is", "it", "me", "my", "need", "of",
  "on", "or", "please", "script", "that", "the", "this", "to", "use", "we",
  "what", "with", "would", "you", "your", "issue", "problem", "fix", "make",
  "get", "run", "running", "want", "help", "computer", "device", "machine",
]);

const BLOCKING_FLAGS = new Set<ScriptCatalogueSafetyFlag>([
  "DO_NOT_USE",
  "TEST",
  "PLACEHOLDER",
  "LEGACY",
  "CLIENT_SPECIFIC",
  "DESTRUCTIVE",
  "CREDENTIAL_BEARING",
  "REBOOTING",
  "FORCED_REBOOT",
]);

function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

function stringArg(args: Record<string, unknown>, name: string, max: number): string | undefined {
  const value = args[name];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${name} must be a non-empty string.`);
  const text = value.trim();
  if (text.length > max) throw new Error(`${name} must not exceed ${max} characters.`);
  return text;
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9%$_.-]+/g, " ").replace(/\s+/g, " ").trim();
}

function tokens(value: string): Set<string> {
  return new Set(normalize(value).split(" ").filter((token) => token.length >= 3 && !STOP_WORDS.has(token)));
}

function isDisallowed(record: ScriptCatalogueRecord): boolean {
  return record.safetyFlags.some((flag) => BLOCKING_FLAGS.has(flag));
}

function riskText(record: ScriptCatalogueRecord): string[] {
  const risks = [...record.risks];
  for (const flag of record.safetyFlags) {
    if (flag === "DO_NOT_USE" && !risks.some((risk) => /do not use/i.test(risk))) risks.push("Marked DO NOT USE in the reviewed catalogue.");
    if (flag === "TEST" && !risks.some((risk) => /test/i.test(risk))) risks.push("Marked TEST/TESTING in the reviewed catalogue.");
    if (flag === "CREDENTIAL_BEARING" && !risks.some((risk) => /credential|secret/i.test(risk))) risks.push("Credential or secret handling must be reviewed securely; secret values are not shown.");
    if (flag === "DESTRUCTIVE" && !risks.some((risk) => /alter|remove|uninstall|destructive/i.test(risk))) risks.push("May alter endpoint state; separate approval is required.");
    if (flag === "REBOOTING" && !risks.some((risk) => /restart|reboot|sign/i.test(risk))) risks.push("May require or cause a restart or sign-out.");
    if (flag === "FORCED_REBOOT" && !risks.some((risk) => /force|restart|reboot/i.test(risk))) risks.push("May force a restart; confirm a maintenance window.");
    if (flag === "CLIENT_SPECIFIC" && !risks.some((risk) => /client/i.test(risk))) risks.push("Client-specific applicability must be verified before use.");
  }
  return [...new Set(risks)];
}

function scoreRecord(record: ScriptCatalogueRecord, query: string): { score: number; matched: string[] } {
  const queryTokens = tokens(query);
  const nameTokens = tokens(record.name);
  const descriptionTokens = tokens(record.reviewedDescription);
  const matched = [...queryTokens].filter((token) => nameTokens.has(token) || descriptionTokens.has(token));
  const nameMatches = matched.filter((token) => nameTokens.has(token)).length;
  const descriptionMatches = matched.filter((token) => descriptionTokens.has(token)).length;
  const phrase = normalize(query).includes(normalize(record.name)) || normalize(record.name).includes(normalize(query));
  const score = nameMatches * 4 + descriptionMatches + (phrase && normalize(record.name).length >= 8 ? 8 : 0);
  return { score, matched };
}

function confidenceFor(score: number, reviewedConfidence?: Confidence): Confidence {
  const computed: Confidence = score >= 14 ? "High" : score >= 8 ? "Medium" : "Low";
  if (reviewedConfidence === "Low") return "Low";
  if (reviewedConfidence === "Medium" && computed === "High") return "Medium";
  return computed;
}

function candidateView(record: ScriptCatalogueRecord, score: number, matched: string[], primary: boolean) {
  return {
    scriptName: record.name,
    scriptId: record.scriptId,
    scriptUrl: record.url,
    whyItMatches: primary
      ? `Matched the requested outcome against the reviewed script name/description${matched.length > 0 ? ` using: ${matched.join(", ")}` : "."}`
      : `Secondary candidate with overlapping reviewed terms: ${matched.join(", ") || "limited overlap"}.`,
    whatItDoes: record.reviewedDescription,
    platformRunContext: {
      platform: record.platform ?? "Not recorded in the published catalogue.",
      language: record.language ?? "Not recorded in the published catalogue.",
      runAs: record.runAs ?? "Not recorded in the published catalogue.",
    },
    runtimeVariables: record.runtimeVariables.length > 0 ? record.runtimeVariables : ["None configured."],
    prerequisites: record.prerequisites.length > 0 ? record.prerequisites : ["No structured prerequisites are recorded; validate the reviewed description and target context."],
    risks: riskText(record),
    safetyFlags: record.safetyFlags,
    confidence: confidenceFor(score, record.confidence),
    score,
  };
}

function snapshot(status: ScriptCatalogueStatusRecord) {
  return {
    syncState: status.syncState,
    lastAttemptAt: status.lastAttemptAt,
    lastSuccessfulSyncAt: status.lastSuccessfulSyncAt,
    activeObservedRunId: status.activeObservedRunId,
    publishedCount: status.publishedCount,
    queueCount: status.queueCount,
    queueByKind: status.queueByKind,
    lastRun: status.lastRun,
  };
}

function detailBlockers(record: ScriptCatalogueRecord, args: { platform?: string; clientName?: string }, ranked: Array<{ record: ScriptCatalogueRecord; score: number }>): string[] {
  const blockers: string[] = [];
  if (args.platform && !record.platform) blockers.push(`Confirm the target platform (${args.platform}); the published record has no structured platform value.`);
  if (args.clientName && record.safetyFlags.includes("CLIENT_SPECIFIC")) blockers.push(`Confirm that the client-specific entry applies to ${args.clientName}; do not reuse it for another client without review.`);
  if (record.safetyFlags.includes("DO_NOT_USE")) blockers.push("This entry is marked DO NOT USE and must not be selected for execution.");
  if (record.safetyFlags.includes("TEST")) blockers.push("This entry is marked TEST/TESTING and requires explicit review before any use.");
  if (record.safetyFlags.includes("PLACEHOLDER")) blockers.push("This entry is a placeholder or unfinished.");
  if (record.safetyFlags.includes("LEGACY")) blockers.push("This entry is marked legacy; confirm a current approved alternative.");
  if (record.safetyFlags.includes("CREDENTIAL_BEARING")) blockers.push("Confirm secure credential handling without sharing secret values.");
  if (record.safetyFlags.includes("DESTRUCTIVE")) blockers.push("Confirm the intended endpoint change and separate approval before execution.");
  if (record.safetyFlags.includes("REBOOTING") || record.safetyFlags.includes("FORCED_REBOOT")) blockers.push("Confirm restart behaviour, user impact, and a maintenance window.");
  if (ranked.length > 1 && ranked[1].score >= ranked[0].score * 0.8) blockers.push("Closely scoring duplicate or variant candidates require comparison before selection.");
  return [...new Set(blockers)];
}

function parseMaxAlternatives(value: unknown): number {
  if (value === undefined) return 2;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 2) throw new Error("maxAlternatives must be an integer from 0 to 2.");
  return value;
}

export function getScriptCatalogueTools(): DomainTools {
  return {
    tools: [
      {
        name: "superops_script_catalog_recommend",
        description: "Search the central last-complete authoritative SuperOps script catalogue and return a read-only FOUND, NEEDS_DETAILS, or NO_CONFIDENT_MATCH recommendation. Complete nightly SuperOps metadata pulls publish new and changed records automatically. Does not call SuperOps for this request and never executes, edits, schedules, or deletes scripts or tickets.",
        inputSchema: {
          type: "object",
          properties: {
            ticketText: { type: "string", description: "Ticket or request text to match against reviewed descriptions.", maxLength: 20000 },
            desiredOutcome: { type: "string", description: "Optional concise technical outcome.", maxLength: 4000 },
            platform: { type: "string", enum: ["WINDOWS", "MAC", "LINUX", "OTHER"], description: "Known target platform, if supplied." },
            clientName: { type: "string", description: "Client name when client applicability matters; do not include secrets.", maxLength: 300 },
            maxAlternatives: { type: "number", enum: [0, 1, 2], description: "Maximum secondary candidates to return." },
          },
          required: ["ticketText"],
        },
      },
      {
        name: "superops_script_catalog_get",
        description: "Read one exact SuperOps script record from the central authoritative catalogue by script ID. Does not call SuperOps or mutate any state.",
        inputSchema: {
          type: "object",
          properties: { scriptId: { type: "string", description: "Exact script ID from a catalogue result." } },
          required: ["scriptId"],
        },
      },
      {
        name: "superops_script_catalog_status",
        description: "Read central script catalogue freshness, authoritative-record count, and retirement diagnostics. Does not call SuperOps or mutate any state.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "superops_script_catalog_review_queue",
        description: "Read the central diagnostic queue for SuperOps scripts missing from the last complete pull. New and changed records are published automatically after a complete pull; this tool does not publish anything.",
        inputSchema: {
          type: "object",
          properties: { limit: { type: "number", description: "Maximum queue items to return, from 1 to 100." } },
        },
      },
    ],
    async handleCall(name, args) {
      try {
        const store = getScriptCatalogueStore();
        await ensureInitialScriptCatalogueSeed(store);

        if (name === "superops_script_catalog_status") {
          return jsonResult(snapshot(await store.getStatus()));
        }

        if (name === "superops_script_catalog_review_queue") {
          const limit = args.limit === undefined ? 100 : args.limit;
          if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100) {
            return errorResult("limit must be an integer from 1 to 100.");
          }
          const queue = (await store.listQueue())
            .sort((left, right) => left.lastSeenAt.localeCompare(right.lastSeenAt))
            .slice(0, limit);
          return jsonResult({
            queue,
            catalogueSnapshot: snapshot(await store.getStatus()),
            diagnosticOnly: true,
          });
        }

        if (name === "superops_script_catalog_get") {
          const scriptId = stringArg(args, "scriptId", 200);
          if (!scriptId) return errorResult("scriptId is required.");
          const record = await store.getPublished(scriptId);
          return record ? jsonResult(record) : errorResult(`No authoritative published script exists for exact scriptId ${scriptId}.`);
        }

        if (name !== "superops_script_catalog_recommend") return errorResult(`Unknown central script catalogue tool: ${name}.`);
        const ticketText = stringArg(args, "ticketText", 20_000);
        if (!ticketText) return errorResult("ticketText is required.");
        const desiredOutcome = stringArg(args, "desiredOutcome", 4_000);
        const clientName = stringArg(args, "clientName", 300);
        const platform = stringArg(args, "platform", 20)?.toUpperCase();
        if (platform && !["WINDOWS", "MAC", "LINUX", "OTHER"].includes(platform)) return errorResult("platform must be WINDOWS, MAC, LINUX, or OTHER.");
        const maxAlternatives = parseMaxAlternatives(args.maxAlternatives);
        const query = [ticketText, desiredOutcome, platform, clientName].filter(Boolean).join(" ");
        const records = await store.listPublished();
        const ranked = records
          .map((record) => ({ record, ...scoreRecord(record, query) }))
          .filter((entry) => entry.score >= 4)
          .sort((left, right) => right.score - left.score || left.record.name.localeCompare(right.record.name));
        const primaryPool = ranked.filter((entry) => !isDisallowed(entry.record));
        const primaryEntry = primaryPool[0] ?? ranked[0];
        const status = await store.getStatus();

        if (!primaryEntry) {
          return jsonResult({
            recommendation: "NO_CONFIDENT_MATCH" as RecommendationState,
            bestMatch: null,
            alternatives: [],
            confidence: "Low" as Confidence,
            risks: ["No authoritative SuperOps record reached the confidence threshold; no script is being invented."],
            ticketReadyNextStep: "Clarify the desired outcome, platform, affected component, and constraints, then search the central catalogue again or scope a separately reviewed script request.",
            catalogueSnapshot: snapshot(status),
          });
        }

        const blockers = detailBlockers(primaryEntry.record, { platform, clientName }, ranked);
        const confidence = confidenceFor(primaryEntry.score, primaryEntry.record.confidence);
        const recommendation: RecommendationState = confidence === "Low" || primaryEntry.score < 8 || blockers.length > 0
          ? "NEEDS_DETAILS"
          : "FOUND";
        const bestMatch = candidateView(primaryEntry.record, primaryEntry.score, primaryEntry.matched, true);
        const alternatives = ranked
          .filter((entry) => entry.record.scriptId !== primaryEntry.record.scriptId)
          .slice(0, maxAlternatives)
          .map((entry) => candidateView(entry.record, entry.score, entry.matched, false));

        return jsonResult({
          recommendation,
          bestMatch,
          alternatives,
          confidence,
          detailRequests: blockers,
          ticketReadyNextStep: recommendation === "FOUND"
            ? primaryEntry.record.ticketReadyNextStep
            : `Do not execute yet. ${blockers.join(" ") || "Confirm the missing technical details and review the candidate against the endpoint."}`,
          catalogueSnapshot: snapshot(status),
          readOnly: true,
        });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
