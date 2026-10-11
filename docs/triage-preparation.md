# Read-only triage preparation

`superops_tickets_prepare_triage_plan` accepts a complete frozen standing-policy
proposal, up to 50 candidates. It performs canonical reads and existing policy,
identity, timestamp, privacy and field-option validation without creating an
operation or calling a SuperOps mutation. A complete successful response alone
contains `preparedPlan`. A partial or invalid preparation returns every candidate
result and no plan.

During preparation only, `ticketNumber` may be omitted when the action contains
its frozen `expectedTicketId`. The preparer derives the display number by that
immutable ID, checks it against the complete fixed candidate set and reuses the
canonical read for the existing validators. It never assigns actions by array
position or guesses a candidate. Supplied conflicting numbers, duplicate IDs,
missing IDs, scope mismatches and changed snapshot expectations remain blocked.
Every returned apply action still contains the required display number. The
public apply contract and its review, checksum, stale checks and dedupe are
unchanged. Callers with an older cached preparation schema continue supplying
both identifiers until their catalogue refreshes.

Automatic preparation begins with an independently acknowledged invocation ID
under the existing run-start guard. The coordinator invalidates any older
preparation outcome before execution. Its private internal observer retains only
that ID, fixed candidate numbers and `ready`, `validation_failed` or `unavailable`.
A lost observation leaves `in_progress`; older or conflicting outcomes cannot
overwrite a correction. One additional internal observation is budget-accounted;
number derivation adds no SuperOps read per item and no write.

After provider termination, a missing Agent callback can be replaced by a
canonical failure report only for the latest server-observed validation failure,
a complete frozen query and no pending read, apply intent, operation, write check,
authorized item or unsafe callback claim. The coordinator reports `not_attempted`
with coarse `validation`, retains `plan_validation_failed` in cause diagnostics,
revokes the attempt and preserves attention. Unseen candidates remain `unknown`.
This does not schedule a retry or claim success. Platform rejections that never
reach the MCP and incomplete/read failures retain conservative handling.

For an assigned client, supply its frozen canonical `expectedClient` name. The
preparer derives `expectedClientHash` from that name; an account ID is not a hash.
For an explicitly null client, it adds both fixed TaskGroup target fields if
absent. Missing client data remains unknown and blocks preparation. Existing
assignments and frozen snapshot expectations cannot be silently refreshed.

Copy the complete prepared object unchanged to the separately reviewed apply
tool, after the existing diagnostic intent receipt when capture is enabled.
Do not add `dryRun` or change defaults afterward. `policyContractVersion` and
`preparationFingerprint` detect drift/accidental edits and grant no approval.
When supplied, apply checks them before operation creation, then independently
retains live stale-data validation, field checks, private-note dedupe and final
verification. Existing clients and v1 inputs retain their required fields.

Preparation returns `stopOnFirstFailure:false` and the three disabled write
overrides explicitly. The checksum treats omission and literal `false` as
equivalent only for the top-level `allowResolveFullFallbackToUpdate`,
`allowWriteIfUpdatedTimeChanged` and `allowWriteWithoutVerifiedContent` flags,
matching the existing apply and durable-input defaults. `true`, invalid values,
nested flags and all other fields remain part of the checksum. An unchanged
legacy checksum is also accepted during deployment; it does not permit edits
to its proposal. Continue copying the returned plan unchanged, and prepare
again before apply after a genuine proposal change.

Repair a correctable construction defect during bounded read-only preparation.
Do not resubmit apply after any actual response or change approved input under
the same operation ID. A zero-SuperOps-call validation response can still belong
to a durable terminal operation. Pending continuation retains the same approved
operation; terminal failure and ambiguity require reconciliation.

Safe error metadata is allowlisted in both text and structured MCP channels.
Raw provider reasons and bodies do not become retry instructions. The central
client remains the only owner of bounded read retries; write rate-limit metadata
never grants replay. Field-options attempt counts come from the invocation's
actual read trace, with an explicit one-call fallback for uninstrumented local
clients. Structured content contributes to the existing response-size limit.

The Git instruction source is `agent/superops-triage-instructions.md`.
`node scripts/check-triage-contract.mjs` checks the source/trigger/Agent version.
Optional supported-UI instruction exports can be supplied as arguments for
content comparison. The checker reports both raw and policy-text hashes. It
accepts only the observed Builder Markdown escapes before underscore, less-than
and asterisk, CRLF conversion, surrounding whitespace and repeated paragraph
newlines; words, line boundaries, inline spacing and HTML tags must still match.
The source is not unescaped. Publishing the Builder does not establish API-channel
sync; read back both separately. Rollback uses Git and the prior published instruction
version while preserving Durable Object identities and uncertainty fences.
