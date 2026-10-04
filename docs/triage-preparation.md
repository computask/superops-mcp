# Read-only triage preparation

`superops_tickets_prepare_triage_plan` accepts a complete frozen standing-policy
proposal, up to 50 candidates. It performs canonical reads and existing policy,
identity, timestamp, privacy and field-option validation without creating an
operation or calling a SuperOps mutation. A complete successful response alone
contains `preparedPlan`. A partial or invalid preparation returns every candidate
result and no plan.

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
content comparison. Publishing the Builder does not establish API-channel sync;
read back both separately. Rollback uses Git and the prior published instruction
version while preserving Durable Object identities and uncertainty fences.
