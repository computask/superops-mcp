import { describe, expect, it } from "vitest";
import { canonicalizeNoteText } from "./note-canonicalization.js";
import { normalizedNoteFingerprint } from "../operation-store.js";

const submitted61125Note = [
  "<strong>TRIAGE SUMMARY</strong><br><br>",
  "<strong>Ticket goal:</strong> Review supplier pricing changes before they take effect.<br><br>",
  "<strong>What needs to be known:</strong> The supplier has announced a dated pricing change for selected subscriptions.<br><br>",
  "<strong>Next step:</strong> Review affected renewals, quotes and pricing assumptions.<br><br>",
  "<strong>When:</strong> Complete the review before the effective date.",
].join("");

const plain61125Note = [
  "TRIAGE SUMMARY",
  "",
  "Ticket goal: Review supplier pricing changes before they take effect.",
  "",
  "What needs to be known: The supplier has announced a dated pricing change for selected subscriptions.",
  "",
  "Next step: Review affected renewals, quotes and pricing assumptions.",
  "",
  "When: Complete the review before the effective date.",
].join("\n");

describe("note canonicalisation", () => {
  it("matches the ticket 61125 HTML submission to SuperOps wrapped and safe-reader forms", () => {
    const returnedHtml = `<html>${submitted61125Note}</html>`;

    expect(canonicalizeNoteText(submitted61125Note)).toBe(plain61125Note);
    expect(canonicalizeNoteText(returnedHtml)).toBe(plain61125Note);
    expect(canonicalizeNoteText(plain61125Note)).toBe(plain61125Note);
    expect(normalizedNoteFingerprint(submitted61125Note)).toBe(
      normalizedNoteFingerprint(returnedHtml)
    );
    expect(normalizedNoteFingerprint(submitted61125Note)).toBe(
      normalizedNoteFingerprint(plain61125Note)
    );
  });

  it("treats br spellings, line endings, entities, nbsp and formatting spaces equivalently", () => {
    const submitted = " <strong>TRIAGE SUMMARY</strong> <br> <br> " +
      "<strong>Ticket goal:</strong> A &amp; B&nbsp;review &#x2013; ready.<br/>";
    const returned = "<body>TRIAGE SUMMARY\r\n\r\nTicket goal: A & B review – ready.<br /> </body>";

    expect(canonicalizeNoteText(submitted)).toBe("TRIAGE SUMMARY\n\nTicket goal: A & B review – ready.");
    expect(canonicalizeNoteText(submitted)).toBe(canonicalizeNoteText(returned));
  });

  it("keeps semantic differences different and preserves old plain-text deduplication", () => {
    const original = "TRIAGE SUMMARY\n\nTicket goal: Keep the approved wording.";
    const equivalent = "  TRIAGE SUMMARY\r\n\r\nTicket goal:   Keep the approved wording.  ";
    const different = "TRIAGE SUMMARY\n\nTicket goal: Change the approved wording.";

    expect(normalizedNoteFingerprint(original)).toBe(normalizedNoteFingerprint(equivalent));
    expect(normalizedNoteFingerprint(original)).not.toBe(normalizedNoteFingerprint(different));
  });
});
