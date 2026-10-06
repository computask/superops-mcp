import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TRIAGE_POLICY_CONTRACT_VERSION, triagePreparationFingerprint, triagePreparationFingerprintMatches } from "./triage-contract.js";

const overrides = ["allowResolveFullFallbackToUpdate", "allowWriteIfUpdatedTimeChanged", "allowWriteWithoutVerifiedContent"] as const;
function proposal(): Record<string, unknown> {
  return { batchId: "synthetic-checksum-contract", policyContractVersion: TRIAGE_POLICY_CONTRACT_VERSION,
    actions: [{ ticketNumber: "90101", note: "Synthetic private note", target: { impact: "Low" } }],
    expectedCandidateTicketNumbers: ["90101"], verify: true, dedupeNotes: true, stopOnFirstFailure: false };
}
function prepared(): Record<string, unknown> & { preparationFingerprint: string } {
  const plan = proposal();
  return { ...plan, preparationFingerprint: triagePreparationFingerprint(plan) };
}

describe("prepared triage checksum contract", () => {
  it("accepts exactly the three disabled overrides added after preparation", () => {
    const plan = prepared();
    const caller = { ...plan, allowResolveFullFallbackToUpdate: false,
      allowWriteIfUpdatedTimeChanged: false, allowWriteWithoutVerifiedContent: false };
    expect(triagePreparationFingerprintMatches(caller)).toBe(true);
    expect(triagePreparationFingerprint(caller)).toBe(plan.preparationFingerprint);
  });

  it.each(overrides)("equates omission and false only for top-level %s", key => {
    const plan = prepared();
    expect(triagePreparationFingerprintMatches({ ...plan, [key]: false })).toBe(true);
    expect(triagePreparationFingerprintMatches({ ...plan, [key]: undefined })).toBe(true);
    for (const value of [true, null, "false", 0]) {
      expect(triagePreparationFingerprintMatches({ ...plan, [key]: value })).toBe(false);
    }
    const nested = proposal();
    (nested.actions as Array<Record<string, unknown>>)[0][key] = false;
    expect(triagePreparationFingerprint(nested)).not.toBe(plan.preparationFingerprint);
  });

  it("preserves key-order, absent-property and diagnostic-context equivalence", () => {
    const plan = prepared();
    const reordered = Object.fromEntries(Object.entries(plan).reverse());
    reordered.actions = (plan.actions as Array<Record<string, unknown>>).map(action => Object.fromEntries(Object.entries(action).reverse()));
    expect(triagePreparationFingerprintMatches({ ...reordered, unused: undefined,
      triageCapture: { triggerId: "synthetic-diagnostic-context", attempt: 2 } })).toBe(true);
  });

  it.each([
    ["batch", { batchId: "changed" }], ["candidate", { expectedCandidateTicketNumbers: ["90102"] }],
    ["verification", { verify: false }], ["dedupe", { dedupeNotes: false }],
    ["stop flag", { stopOnFirstFailure: true }], ["added dry run", { dryRun: false }],
    ["new field", { extra: "changed" }],
  ])("rejects a changed %s without discarding any other field", (_label, change) => {
    expect(triagePreparationFingerprintMatches({ ...prepared(), ...change })).toBe(false);
  });

  it("rejects changed note text, targets, frozen fences and array order", () => {
    const plan = prepared();
    for (const change of [{ note: "Changed synthetic note" }, { target: { impact: "High" } },
      { expectedUpdatedTime: "2026-10-06T10:00:00Z" }, { expectedTicketId: "changed-identity" }]) {
      const action = { ...(plan.actions as Array<Record<string, unknown>>)[0], ...change };
      expect(triagePreparationFingerprintMatches({ ...plan, actions: [action] })).toBe(false);
    }
    const multi = { ...proposal(), expectedCandidateTicketNumbers: ["90101", "90102"] };
    const checksum = triagePreparationFingerprint(multi);
    expect(triagePreparationFingerprintMatches({ ...multi, preparationFingerprint: checksum,
      expectedCandidateTicketNumbers: ["90102", "90101"] })).toBe(false);
  });

  it("accepts an unchanged legacy checksum while rejecting changed legacy proposals", () => {
    // Explicitly sorted synthetic input for the previous raw-object hash contract.
    const legacy = { actions: [{ note: "Synthetic private note", ticketNumber: "90101" }],
      allowResolveFullFallbackToUpdate: false, allowWriteIfUpdatedTimeChanged: false,
      allowWriteWithoutVerifiedContent: false, batchId: "synthetic-legacy-prepared",
      policyContractVersion: TRIAGE_POLICY_CONTRACT_VERSION };
    const checksum = createHash("sha256").update(JSON.stringify(legacy)).digest("hex");
    expect(triagePreparationFingerprint(legacy)).not.toBe(checksum);
    expect(triagePreparationFingerprintMatches({ ...legacy, preparationFingerprint: checksum })).toBe(true);
    expect(triagePreparationFingerprintMatches({ ...legacy, batchId: "changed", preparationFingerprint: checksum })).toBe(false);
    expect(triagePreparationFingerprintMatches({ ...legacy, allowWriteIfUpdatedTimeChanged: true, preparationFingerprint: checksum })).toBe(false);
  });
});
