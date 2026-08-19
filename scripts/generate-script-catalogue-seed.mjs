import fs from "node:fs";
import path from "node:path";

const inputPath = process.argv[2];
const outputPath = process.argv[3] ?? path.resolve("src/script-catalogue-seed.json");

if (!inputPath) {
  throw new Error("Usage: node scripts/generate-script-catalogue-seed.mjs <catalogue.md> [output.json]");
}

const source = fs.readFileSync(path.resolve(inputPath), "utf8");
const reviewedAt = (source.match(/^Last reviewed:\s*(\d{4}-\d{2}-\d{2})$/m)?.[1] ?? "1970-01-01") + "T00:00:00.000Z";

function redact(value) {
  return value
    .trim()
    .replace(/\b(password|passphrase|token|secret|api[_-]?key|activation(?:id)?|customerid|recovery\s+key)\b\s*[:=]\s*([^,;\n]+)/gi, "$1=[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .slice(0, 30000);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function runtimeVariables(description) {
  const values = [];
  const variablePattern = /%[A-Za-z0-9_]+%|\$[A-Za-z_][A-Za-z0-9_]*|\b[A-Za-z_][A-Za-z0-9_]*\b/g;
  const clauses = [
    /Requires(?:\s+SuperOps)?\s+runtime variables?\s+([^.;\n]+)/gi,
    /(?:%[A-Za-z0-9_]+%|\$[A-Za-z_][A-Za-z0-9_]*|[A-Za-z_][A-Za-z0-9_]*)\s+runtime variable/gi,
    /runtime variable\s+((?:%[A-Za-z0-9_]+%|\$[A-Za-z_][A-Za-z0-9_]*|[A-Za-z_][A-Za-z0-9_]*))/gi,
  ];

  for (const clause of clauses) {
    for (const match of description.matchAll(clause)) {
      const text = match[1] ?? match[0];
      for (const token of text.match(variablePattern) ?? []) {
        if (/^(requires?|superops?|runtime|variable|variables|are|is|required|configured|and|the|from|for)$/i.test(token)) continue;
        if (token.length <= 100) values.push(token);
      }
    }
  }
  return unique(values);
}

function safetyFlags(name, description) {
  const text = `${name}\n${description}`;
  const flags = [];
  if (/\bDO\s+NOT\s+USE\b/i.test(text)) flags.push("DO_NOT_USE");
  if (/\bTEST(?:ING)?\b|one[- ]time\s+test/i.test(text)) flags.push("TEST");
  if (/placeholder|does not .*current form|opening .*marker/i.test(text)) flags.push("PLACEHOLDER");
  if (/\blegacy\b|obsolete|old\s+script/i.test(text)) flags.push("LEGACY");
  if (/password|passphrase|token|secret|credential|activation key|recovery key|wi-?fi password|hard-coded account/i.test(text)) flags.push("CREDENTIAL_BEARING");
  if (/force(?:d)?\s+(?:a\s+)?(?:re)?start|shutdown\s*\/r\s*\/f|restart\s+forcefully/i.test(text)) flags.push("FORCED_REBOOT");
  if (/\breboot\b|\brestart(?:s|ed|ing)?\b|sign[- ]out\/sign[- ]in/i.test(text)) flags.push("REBOOTING");
  if (/destructive|recursively deletes?|\buninstalls?\b|\bdeletes?\b|\bunjoins?\b|removes? .*agent|force[- ]installs?/i.test(text)) flags.push("DESTRUCTIVE");
  if (/client[- ]specific|do not apply to|specific to (?:the )?(?:client|tenant)|embedded .*tenant|hard-coded target/i.test(text)) flags.push("CLIENT_SPECIFIC");
  return unique(flags);
}

function risksFor(flags) {
  const risks = [];
  if (flags.includes("DO_NOT_USE")) risks.push("Marked DO NOT USE in the reviewed catalogue.");
  if (flags.includes("TEST")) risks.push("Marked TEST/TESTING in the reviewed catalogue.");
  if (flags.includes("PLACEHOLDER")) risks.push("Marked as a placeholder or unfinished entry.");
  if (flags.includes("LEGACY")) risks.push("Marked as legacy or obsolete; current approval is required.");
  if (flags.includes("CLIENT_SPECIFIC")) risks.push("Client-specific applicability must be verified before use.");
  if (flags.includes("CREDENTIAL_BEARING")) risks.push("May depend on credentials or secrets; never paste secret values into a ticket or chat.");
  if (flags.includes("DESTRUCTIVE")) risks.push("May change, remove, uninstall, or otherwise alter endpoint state; separate approval is required.");
  if (flags.includes("REBOOTING")) risks.push("May require or cause a restart or sign-out.");
  if (flags.includes("FORCED_REBOOT")) risks.push("May force a restart; confirm maintenance window and user-impact approval.");
  return risks;
}

const records = [];
for (const block of source.split(/^##\s+/m).slice(1)) {
  const lines = block.split(/\r?\n/);
  const name = lines.shift()?.trim();
  const id = block.match(/^- Script ID:\s*(\S+)\s*$/m)?.[1];
  const url = block.match(/^- Script URL:\s*(https:\/\/\S+)\s*$/m)?.[1];
  const descriptionMatch = block.match(/^- Reviewed description:\s*([\s\S]*?)(?=\r?\n\r?\n|$)/m);
  if (!name || !id || !url || !descriptionMatch) continue;
  const description = redact(descriptionMatch[1]);
  const flags = safetyFlags(name, description);
  records.push({
    version: 1,
    scriptId: id,
    name,
    url,
    reviewedDescription: description,
    runtimeVariables: runtimeVariables(description),
    prerequisites: [],
    risks: risksFor(flags),
    alternatives: [],
    confidence: "Medium",
    ticketReadyNextStep: "Confirm the target asset, platform, prerequisites, warnings, and separate execution approval before any use; do not treat this recommendation as execution.",
    safetyFlags: flags,
    status: "REVIEWED",
    sourceReviewedAt: reviewedAt,
  });
}

if (records.length === 0) throw new Error("No reviewed script records were found.");
const ids = new Set(records.map((record) => record.scriptId));
if (ids.size !== records.length) throw new Error("Duplicate script IDs were found in the reviewed catalogue.");

fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
fs.writeFileSync(path.resolve(outputPath), `${JSON.stringify(records, null, 2)}\n`, "utf8");
console.log(`Wrote ${records.length} reviewed script records to ${path.resolve(outputPath)}`);
