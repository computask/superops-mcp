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

/** Detect accidental edits; this checksum is never write approval. */
export function triagePreparationFingerprint(plan: object): string {
  const { preparationFingerprint: _checksum, triageCapture: _capture, ...input } = plan as Record<string, unknown>;
  return createHash("sha256").update(JSON.stringify(canonical(input))).digest("hex");
}
