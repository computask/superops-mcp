/** Content-free proof derived by the dispatcher from its stored read receipts.
 * `applied` means the complete target was observed, not proof of execution. */
export interface DispatcherVerification {
  schemaVersion: 1;
  requestId: string;
  mutationFingerprint: string;
  attemptCount: number;
  evidenceHash: string;
  outcome: "applied" | "not_observed" | "unknown";
  reasonCode: string;
  partial: boolean;
  checkedFields: string[];
  readRequestIds: string[];
  replayAllowed: false;
  verifiedAt: string;
}
const fields = new Set(["ticketId", "content", "privacyType", "noteId", "addedOn", "alertId", "status", "priority", "impact", "urgency", "category", "subcategory", "cause", "subcause", "resolutionCode", "client", "technician", "techGroup", "site", "requester"]);
const reasons = new Set(["unsupported_intent_fields", "immutable_identity_unavailable", "incomplete_read", "unsupported_identity_input", "complete_target_observed", "target_not_observed", "partial_target_observed", "unsupported_note_intent", "note_read_unavailable", "private_note_target_observed", "note_identity_ambiguous", "note_not_observed", "unsupported_alert_intent", "complete_alert_targets_observed", "alert_targets_incomplete", "unsupported_mutation_verification", "stale_or_unavailable_evidence"]);
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function validDispatcherVerification(value: unknown): value is DispatcherVerification {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).every(k => ["schemaVersion", "requestId", "mutationFingerprint", "attemptCount", "evidenceHash", "outcome", "reasonCode", "partial", "checkedFields", "readRequestIds", "replayAllowed", "verifiedAt"].includes(k)) &&
    v.schemaVersion === 1 && typeof v.requestId === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(v.requestId) &&
    sha(v.mutationFingerprint) && sha(v.evidenceHash) && Number.isInteger(v.attemptCount) && (v.attemptCount as number) >= 1 && (v.attemptCount as number) <= 1000 &&
    ["applied", "not_observed", "unknown"].includes(String(v.outcome)) && reasons.has(String(v.reasonCode)) && typeof v.partial === "boolean" &&
    Array.isArray(v.checkedFields) && v.checkedFields.length <= 20 && v.checkedFields.every(k => typeof k === "string" && fields.has(k)) &&
    Array.isArray(v.readRequestIds) && v.readRequestIds.length >= 1 && v.readRequestIds.length <= 8 &&
    v.readRequestIds.every(id => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id)) && new Set(v.readRequestIds).size === v.readRequestIds.length &&
    v.replayAllowed === false && typeof v.verifiedAt === "string" && v.verifiedAt.length <= 32 && Number.isFinite(Date.parse(v.verifiedAt));
}
