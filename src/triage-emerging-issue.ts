import { sanitizeText } from "./audit.js";
import {
  assertEmergingIssueObservation,
  currentOwnerHash,
  EMERGING_ISSUE_QUIET_PERIOD_MS,
  getOperationStore,
  MAX_EMERGING_ISSUE_CURRENT_TICKETS,
  MAX_EMERGING_ISSUE_REPRESENTATIVES,
  MAX_EMERGING_ISSUE_SUMMARY_LENGTH,
  MAX_EMERGING_ISSUE_TICKETS,
  stableHash,
  type EmergingIssueObservation,
  type EmergingIssueSignal,
} from "./operation-store.js";
import type { ToolDefinition } from "./types.js";

const EVIDENCE_STRENGTHS = ["weak", "moderate", "strong"] as const;
const SIGNAL_STATES = ["active", "resolved"] as const;

export const TRIAGE_EMERGING_ISSUE_TOOL_NAME = "superops_triage_emerging_issue_upsert";

export const triageEmergingIssueTool: ToolDefinition = {
  name: TRIAGE_EMERGING_ISSUE_TOOL_NAME,
  description:
    "Internal durable emerging-issue signal only. Use only for credible cross-client evidence correlated by the Ticket History MCP and triage agent; requester recurrence or recurrence confined to one client is not a wider issue. The signal is stable-fingerprint deduplicated, bounded, and does not contact customers, choose notification destinations, create or change tickets, merge tickets, execute scripts, or remediate systems.",
  inputSchema: {
    type: "object",
    properties: {
      issueFingerprint: {
        type: "string",
        minLength: 8,
        maxLength: 128,
        description: "Stable bounded issue fingerprint from correlated history evidence; replay the exact fingerprint for reconciliation.",
      },
      summary: {
        type: "string",
        maxLength: MAX_EMERGING_ISSUE_SUMMARY_LENGTH,
        description: "Short plain-text issue summary, not a customer message body, HTML, ticket dump, or secret.",
      },
      firstSeen: { type: "string", description: "ISO timestamp for the earliest correlated observation." },
      lastSeen: { type: "string", description: "ISO timestamp for the latest correlated observation." },
      affectedClientCount: {
        type: "number",
        minimum: 2,
        maximum: 10000,
        description: "Verified or otherwise credible number of distinct affected clients; at least two is required for a wider issue signal.",
      },
      affectedRequesterCount: {
        type: "number",
        minimum: 0,
        maximum: 10000,
        description: "Optional bounded distinct requester count; requester recurrence alone does not qualify as cross-client evidence.",
      },
      affectedTicketNumbers: {
        type: "array",
        maxItems: MAX_EMERGING_ISSUE_TICKETS,
        uniqueItems: true,
        items: { type: "string", maxLength: 40 },
        description: "Optional bounded ticket-number evidence; duplicate values are collapsed.",
      },
      representativeTicketNumbers: {
        type: "array",
        maxItems: MAX_EMERGING_ISSUE_REPRESENTATIVES,
        uniqueItems: true,
        items: { type: "string", maxLength: 40 },
        description: "Optional bounded representative ticket numbers; no ticket body or dump is accepted.",
      },
      evidenceStrength: {
        type: "string",
        enum: [...EVIDENCE_STRENGTHS],
        description: "Bounded correlated-evidence strength. Weak single-client or requester-only recurrence is not a credible wider issue.",
      },
      signalState: {
        type: "string",
        enum: [...SIGNAL_STATES],
        default: "active",
        description: "Active observation or explicit resolved signal state. Quiet-period expiry is derived centrally and does not claim the technical incident is fixed.",
      },
      currentRelatedTicketNumbers: {
        type: "array",
        maxItems: MAX_EMERGING_ISSUE_CURRENT_TICKETS,
        uniqueItems: true,
        items: { type: "string", maxLength: 40 },
        description: "Optional bounded currently related ticket numbers; this action never changes their status or merges them.",
      },
    },
    required: [
      "issueFingerprint",
      "summary",
      "firstSeen",
      "lastSeen",
      "affectedClientCount",
      "evidenceStrength",
    ],
  },
};

function boundedIdentifiers(value: unknown, max: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) {
    throw new Error("Evidence collection exceeds its bounded limit.");
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") throw new Error("Evidence identifiers must be strings.");
    const normalized = entry.trim();
    if (!normalized || normalized.length > 40 || /[\r\n<>]/.test(normalized)) {
      throw new Error("Evidence identifiers must be bounded plain identifiers.");
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function plainSummary(value: unknown): string {
  if (typeof value !== "string") throw new Error("summary is required.");
  const summary = sanitizeText(value).replace(/\s+/g, " ").trim();
  if (!summary || summary.length > MAX_EMERGING_ISSUE_SUMMARY_LENGTH || /[<>\r\n]/.test(summary)) {
    throw new Error("summary must be bounded plain text without markup or line breaks.");
  }
  return summary;
}

function isoTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${field} must be a valid ISO timestamp.`);
  }
  return new Date(value).toISOString();
}

function normalizedFingerprint(value: unknown): string {
  if (typeof value !== "string") throw new Error("issueFingerprint is required.");
  const fingerprint = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._:-]{7,127}$/.test(fingerprint)) {
    throw new Error("issueFingerprint must be a stable bounded identifier.");
  }
  return fingerprint;
}

function normalizedObservation(args: Record<string, unknown>): EmergingIssueObservation {
  const issueFingerprint = normalizedFingerprint(args.issueFingerprint);
  const summary = plainSummary(args.summary);
  const firstSeen = isoTimestamp(args.firstSeen, "firstSeen");
  const lastSeen = isoTimestamp(args.lastSeen, "lastSeen");
  if (Date.parse(firstSeen) > Date.parse(lastSeen)) {
    throw new Error("firstSeen must not be after lastSeen.");
  }
  if (typeof args.affectedClientCount !== "number" ||
      !Number.isSafeInteger(args.affectedClientCount) || args.affectedClientCount < 2 ||
      args.affectedClientCount > 10000) {
    throw new Error("affectedClientCount must be an integer from 2 through 10000.");
  }
  const affectedRequesterCount: number | undefined = args.affectedRequesterCount === undefined
    ? undefined
    : args.affectedRequesterCount as number;
  if (affectedRequesterCount !== undefined &&
      (typeof affectedRequesterCount !== "number" || !Number.isSafeInteger(affectedRequesterCount) ||
       affectedRequesterCount < 0 || affectedRequesterCount > 10000)) {
    throw new Error("affectedRequesterCount is outside its bounded range.");
  }
  if (!EVIDENCE_STRENGTHS.includes(args.evidenceStrength as typeof EVIDENCE_STRENGTHS[number])) {
    throw new Error("evidenceStrength must be weak, moderate, or strong.");
  }
  if (args.evidenceStrength === "weak") {
    throw new Error("Weak or single-client evidence cannot create a wider emerging issue signal.");
  }
  const signalState = (args.signalState === undefined ? "active" : args.signalState) as typeof SIGNAL_STATES[number];
  if (!SIGNAL_STATES.includes(signalState as typeof SIGNAL_STATES[number])) {
    throw new Error("signalState must be active or resolved.");
  }
  const observation: EmergingIssueObservation = {
    issueFingerprint,
    summary,
    firstSeen,
    lastSeen,
    affectedClientCount: args.affectedClientCount as number,
    affectedRequesterCount,
    affectedTicketNumbers: boundedIdentifiers(args.affectedTicketNumbers, MAX_EMERGING_ISSUE_TICKETS),
    representativeTicketNumbers: boundedIdentifiers(args.representativeTicketNumbers, MAX_EMERGING_ISSUE_REPRESENTATIVES),
    evidenceStrength: args.evidenceStrength as typeof EVIDENCE_STRENGTHS[number],
    signalState,
    currentRelatedTicketNumbers: boundedIdentifiers(args.currentRelatedTicketNumbers, MAX_EMERGING_ISSUE_CURRENT_TICKETS),
  };
  assertEmergingIssueObservation(observation);
  return observation;
}

function operationId(ownerHash: string, issueFingerprint: string): string {
  return `emerging-issue-${stableHash({ version: 1, ownerHash, issueFingerprint })}`;
}

function publicSignalMatchesObservation(signal: EmergingIssueSignal, observation: EmergingIssueObservation): boolean {
  return signal.issueFingerprint === observation.issueFingerprint &&
    signal.affectedClientCount >= observation.affectedClientCount &&
    signal.affectedTicketNumbers.every((ticket) => typeof ticket === "string") &&
    signal.currentRelatedTicketNumbers.length <= MAX_EMERGING_ISSUE_CURRENT_TICKETS;
}

function resultText(value: unknown): { content: { type: "text"; text: string }[]; isError?: boolean } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export async function handleTriageEmergingIssueUpsert(
  args: Record<string, unknown>
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  let observation: EmergingIssueObservation;
  let ownerHash: string;
  try {
    observation = normalizedObservation(args);
    ownerHash = currentOwnerHash();
  } catch (error) {
    return {
      ...resultText({
        outcome: "failed",
        acceptedStage: "NotAccepted",
        finalVerification: { performed: false, verified: false },
        error: error instanceof Error ? error.message : "Invalid emerging issue signal.",
      }),
      isError: true,
    };
  }

  const durableOperationId = operationId(ownerHash, observation.issueFingerprint);
  try {
    const store = getOperationStore();
    const stored = await store.upsertEmergingIssue({
      ownerHash,
      operationId: durableOperationId,
      observation,
      quietPeriodMs: EMERGING_ISSUE_QUIET_PERIOD_MS,
    });
    const verified = await store.getEmergingIssue(observation.issueFingerprint, ownerHash);
    if (!verified || !publicSignalMatchesObservation(verified, observation)) {
      return {
        ...resultText({
          outcome: "failed",
          operationId: durableOperationId,
          acceptedStage: stored.acceptedStage,
          updatedAt: stored.updatedAt,
          continuationRequired: false,
          ambiguityReconciled: false,
          finalVerification: { performed: true, verified: false },
          reconciliation: "The durable signal write could not be verified; replay the exact stable fingerprint for reconciliation.",
        }),
        isError: true,
      };
    }
    return resultText({
      ...stored,
      signal: verified,
      quietPeriodMs: EMERGING_ISSUE_QUIET_PERIOD_MS,
      expiryDoesNotDeclareTheUnderlyingIncidentFixed: true,
      notificationDestination: null,
      executionAuthorised: false,
    });
  } catch (error) {
    return {
      ...resultText({
        outcome: "failed",
        operationId: durableOperationId,
        acceptedStage: "Unknown",
        updatedAt: new Date().toISOString(),
        continuationRequired: false,
        ambiguityReconciled: false,
        finalVerification: { performed: false, verified: false },
        reconciliation: "The durable signal write may be ambiguous. Replay the exact issueFingerprint; the operation is idempotent and deduplicated.",
        error: error instanceof Error ? sanitizeText(error.message) : "Emerging issue signal persistence failed.",
      }),
      isError: true,
    };
  }
}
