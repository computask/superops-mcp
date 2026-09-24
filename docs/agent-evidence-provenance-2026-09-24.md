# Evidence provenance clarification for SuperOps Triage

Intended as a prepended clarification to the existing Agent instructions, not a
replacement for its policy, action approvals, or attached runbook. Publish via
the existing Agent Builder after Git review; no connector permissions change.

## Instruction text

EVIDENCE PROVENANCE BEFORE FIRST APPLY (mandatory; no additional calls)

Keep content evidence and classification metadata separate for every immutable
ticket ID. A successful triage_evidence_recover item with meaningful content
remains the source for the issue summary and contentEvidenceState. A later
get_safe call made with includeConversations=false and includeNotes=false is a
metadata-only read: its empty safeContent/items or contentEvidenceState=empty
does not prove the ticket body is empty and must not replace previously recovered
meaningful content. Reuse its authoritative current classification/client fields
only, while preserving the frozen identity and updatedTime concurrency fence.

Use the empty-evidence manual-intake fallback only when the successful bounded
content read actually requested content and returned empty evidence. For a
meaningful customer issue, use meaningful contentEvidenceState and the supported
customer_request/leave or engineer_review/leave policy based on that evidence;
retain New Calls. Never describe recovered meaningful evidence as empty. Missing
classification fields, unavailable notes, missing history, or a test label do not
make meaningful ticket content empty. Never fabricate evidence or read results.

Before the FIRST apply, ensure the private note and disposition agree with the
successful content evidence for that exact ID. This adds no authority to retry
a denied action, change the fixed candidate set, weaken a safety gate, or replay
an accepted/ambiguous operation. On a denied action, retain the existing terminal
callback and no-replay rules.

Preserve the most recent real safe mcpExecution block from any successful read,
including a separate JSON text content block alongside the main tool result.
If a later action returns no telemetry, use that retained read block with its
original toolName and invocationId; never label it as an apply or invent counts.
Only copy schema-valid safe fields. Keep the existing callback privacy rules.

Private notes start with <strong>TRIAGE SUMMARY</strong><br><br>. Use <strong>
for each relevant section title and <br><br> between lines/sections. Omit irrelevant
or unknown history/emerging sections; preserve positive-evidence enum rules.

The required base section labels, including their colons, are exactly
<strong>Ticket goal:</strong>, <strong>What needs to be known:</strong>,
<strong>Next step:</strong>, and <strong>When:</strong>. Each must have useful
non-empty text. Do not substitute labels such as Issue summary or Recommendation.
Insert only relevant, evidence-backed optional history sections between the
second and third base sections, using the existing exact labels and enum rules.
This is the existing MCP v2 note contract, not an additional note requirement.

## Evidence and rollout status

Batch 2321 considered four tickets (62856-62859) and reported apply_rejected
before execution because its plan conflicted with successful meaningful evidence.
The callback omitted mcpExecution. Ticket 62860 was created after the frozen
window, exposing the separately tested notification ingestion defect.
This clarification addresses the metadata-only read ambiguity; it is not proof
that a later live run succeeds. Record live publication and test results separately.
