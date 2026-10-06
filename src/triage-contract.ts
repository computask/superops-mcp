import { createHash } from "node:crypto";

export const TRIAGE_POLICY_CONTRACT_VERSION = "2026-10-04.1";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => [key, canonical(item)]));
}

const DISABLED_WRITE_OVERRIDES = [
  "allowResolveFullFallbackToUpdate",
  "allowWriteIfUpdatedTimeChanged",
  "allowWriteWithoutVerifiedContent",
] as const;

function fingerprint(plan: object, normalizeDisabledOverrides: boolean): string {
  const { preparationFingerprint: _checksum, triageCapture: _capture, ...input } = plan as Record<string, unknown>;
  // Apply and its durable approved-input contract already default these exact
  // top-level flags to false. Do not normalize notes, targets, fences or any
  // other field, and never erase true, null or an invalid override value.
  if (normalizeDisabledOverrides) {
    for (const key of DISABLED_WRITE_OVERRIDES) if (input[key] === false) delete input[key];
  }
  return createHash("sha256").update(JSON.stringify(canonical(input))).digest("hex");
}

/** Detect accidental edits; this checksum is never write approval. */
export function triagePreparationFingerprint(plan: object): string {
  return fingerprint(plan, true);
}

export function triagePreparationFingerprintMatches(plan: object): boolean {
  const checksum = (plan as Record<string, unknown>).preparationFingerprint;
  // The exact legacy representation remains valid across deployment for plans
  // prepared before disabled-override normalization. All its fields still hash.
  return typeof checksum === "string" &&
    (checksum === triagePreparationFingerprint(plan) || checksum === fingerprint(plan, false));
}
