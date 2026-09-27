# Live triage test corrections - 27 September 2026

## Reproduced issues

Controlled tickets 63001 and 63002 both received one verified private triage note
and retained New Calls. The second run safely skipped the first ticket's existing
note. However, the live Agent's instruction contained an old special case that
selected General Admin for a controlled test; ticket 63002 reproduced that
misclassification for an otherwise meaningful technical issue.

Both runs also performed a metadata-only get_safe after successful canonical
evidence recovery. The safe evidence builder already returns current impact,
urgency, category and subcategory, preserving explicit null values. Re-reading
the same null classification adds a dispatcher submission and Agent tool roundtrip.
Missing/omitted data is different and still needs the existing bounded recovery.

## Exact Agent Builder edits

Replace this clause once:

> for this controlled internal administrative test, use 5. Non-technical query and General Admin when those exact options are returned

with:

> classify a meaningful controlled-test issue by its described technical issue exactly as a real request; a test label never justifies General Admin

Replace this sentence once:

> If any required active classification is missing from the successful evidence, call superops_tickets_get_safe once for the frozen ticket ID with includeDescription:false, includeNotes:false, and includeConversations:false, then copy the current values.

with:

> If a required active classification field is omitted or undefined in the successful evidence, call superops_tickets_get_safe once for the frozen ticket ID with includeDescription:false, includeNotes:false, and includeConversations:false, then copy the current values. If successful canonical evidence explicitly returns that field as null, it is already known to be unassigned: do not re-read the same ticket merely to confirm null; use the one bounded field-options lookup for missing values. Unknown client data and unsuccessful or conflicting evidence retain their existing bounded recovery/deferral requirements. Preserve the frozen expectedUpdatedTime and the MCP's mandatory live pre-write stale check.

These edits do not change permissions, policy dispositions, required options,
fixed candidates, mutation replay rules, HTML note format, deduplication or
verification. No existing ticket is rewritten merely to repair this test label.
The same clarification is included in Git-controlled targeted trigger input.

## Publication and proof

Git push and Cloudflare activation are separate from Agent Builder publication.
Record the verified deployment, publication and later controlled-test outcomes
separately; a successful callback is not a substitute for independent ticket
readback. Historical failure injection belongs in the isolated regression
harness, not in production provider responses or customer tickets.
