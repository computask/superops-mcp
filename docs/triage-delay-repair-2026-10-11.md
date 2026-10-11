# Automatic triage delay repair — 11 October 2026

Ticket 63987 completed in 399,355 ms with one verified private note. Its
first dispatcher read waited 154,366 ms behind a shared cooldown triggered by
two Dashboard `rate_limit_exceeded` replies. The original read then succeeded
in 553 ms. The third Agent attempt received a complete query but subsequently
reported the earlier pending state, causing a fourth Agent start. Apply used two
fresh-budget continuations; the first invocation counted 30 internal calls and
six other requests. These are distinct delays. The provider's quota bucket and
reason for throttling remain unconfirmed.

## Reviewed implementation plan

1. Carry only the existing read journal's owner/workflow/payload hashes, receipt
   ID and immutable deadline to the coordinator over its private binding.
   Before a new Agent start, read the original receipt through the existing MCP
   ledger binding. Use one bounded dispatcher status GET per wake. Pending or
   unavailable status waits under the original deadline without consuming an
   Agent attempt. Failed/cancelled/uncertain reads stop with attention required.
   Success permits normal Agent processing of the same query and original
   receipt; it does not establish query completion or authorize a write.
   Existing observations without journal correlation retain their legacy path.
2. Bind each successful server query observation to its MCP invocation. Reject
   a zero-work, bounded-query pending callback contradicted by that observation.
   Tell the current Agent to continue using its frozen successful query result.
   Preserve the original run deadline and allow a later valid final callback.
   A durable operation's authoritative outcome takes precedence. Later evidence
   or metadata failures must remain reportable.
3. Combine terminal read checkpoint and successful delivery in one atomic
   journal command when the original receipt was already durable. Persist new
   receipt identities immediately, and flush a failed parse/validation as an
   undelivered terminal checkpoint. Return the persisted operation record with
   the atomic item claim, avoiding an immediate duplicate GET. No cross-request
   cache or removed persistence checkpoint is introduced. Preserve a prior
   stage's durable verification when a budget stop happens before the next
   mutation. Continue with fresh identity, target and note reads. Clear a
   resumed partial-write result only after all required final verification.

The production-budget comparison exposed an existing boundary defect: a budget
stop overwrote `Verified` with `Pending`, causing repeated stage work. Preserving
that checkpoint also exposed a stale partial-write flag on successful note-only
completion. The regression now completes with one update, one private note,
fresh target/note verification and no partial failure. With queued read receipts,
the measured total is 76 calls versus 81 with the original separate commands;
both need one continuation under the 45-call budget with an 8-call reserve.
This measured reduction is specific to the synthetic fixture; it is not a
prediction of a fixed production triage time.

## Validation and deployment

Use synthetic regressions for delayed receipts, restart/eviction, unknown status,
wrong identity, deadline expiry, stale callbacks, later valid callbacks and
post-query failures. Check atomic delivery and failed parse, fresh authoritative
reads, lease conflicts and unchanged mutation identities. Measure execution calls
with the production 45-call budget and 8-call reserve.

Run the complete MCP and trigger suites, TypeScript build, trigger syntax build,
and `git diff --check`. Update the trigger module provenance hash after reviewed
source changes. Back up current live versions/settings, commit and push explicit
files, and verify both Git-connected builds, active versions, exact source and
read-only health/smoke behavior. Do not use Wrangler to publish. Keep the monitor
paused. Production receipt waits require a subsequent naturally pending read
for end-to-end observation; synthetic regression success does not prove that
SuperOps will stop throttling.

The shared dispatcher limit, cooldown, frozen candidate scope, owner isolation,
approval, stale checks, note dedupe, mutation-start checkpoints, final verification
and uncertain-write reconciliation remain mandatory. This change creates no
direct SuperOps route, replacement pending receipt or mutation replay.
