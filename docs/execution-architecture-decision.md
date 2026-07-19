# ADR: Execution Budget, Rate Limits and Operation Ledger

Date: 2026-07-18
Status: implemented for durable apply-triage execution; automatic continuation is disabled by default

## Context

Cloudflare invocation limits are not reset by sleeping inside one Worker invocation. A multi-ticket write can therefore mutate SuperOps and terminate before returning a complete result. SuperOps HTTP 429 and GraphQL throttling are separate upstream conditions. Every retry still consumes Worker time and subrequests.

Official Cloudflare references used for this decision:

- Workflows Workers API: https://developers.cloudflare.com/workflows/build/workers-api/
- Workflows get-started guide: https://developers.cloudflare.com/workflows/get-started/guide/
- Durable Objects overview: https://developers.cloudflare.com/durable-objects/
- Durable Object storage API: https://developers.cloudflare.com/durable-objects/api/storage-api/
- Durable Object alarms: https://developers.cloudflare.com/durable-objects/api/alarms/
- Wrangler configuration: https://developers.cloudflare.com/workers/wrangler/configuration/

## Options considered

| Option | Decision | Reason |
| --- | --- | --- |
| SQLite-backed Durable Object | Selected for the authoritative ledger | Strong per-operation state, owner checks, leases, compact status reads, and no reuse of OAuth KV. |
| Cloudflare Workflows | Selected for delayed continuation | The pinned Wrangler `4.111.0` schema and runtime types support Workflow bindings, `WorkflowEntrypoint`, instance creation, and durable `step.sleepUntil`. |
| Durable Object alarms | Retention cleanup only | Workflows are compatible, so alarms are not used for long waits. Their only production role is deletion of expired terminal records. |
| Service binding | Selected for immediate fresh-invocation and Workflow delivery | It calls the guarded internal continuation route; it is not an operation authority. |
| Queues, KV, D1, R2 | Rejected for this scope | They add weaker locking or unnecessary operational surface for the current per-operation ledger. |

## Decision

Use `SuperOpsOperationLedger`, a SQLite-backed Durable Object, as the authoritative state for `superops_tickets_apply_triage_plan`. Use `SuperOpsContinuationWorkflow` for waits that must outlive a request. The Workflow persists only compact operation identity, sleeps until the durable eligibility time, records wake telemetry, and calls the guarded internal continuation route. The resumed adapter must claim the persisted item, re-read SuperOps state, and reconcile the checkpoint before any new mutation.

The ledger rejects records over 500 items or 512 KiB, malformed record/item shapes, duplicate expected IDs, unexpected item-state keys, excessive compact results, and prohibited customer-content keys. It stores operation/owner hashes, expected item IDs, mutation type, reliable-response and observed-result state, canonical target hashes, normalized note fingerprints, created note IDs, leases, stages, retry metadata, fallback state, compact redacted results, and scheduling/wake telemetry. It never stores note bodies, ticket descriptions, conversation/message bodies, attachment bodies, credentials, tokens, or sensitive headers.

`superops_operations_get` and `superops_operations_results` are read-only and owner-scoped. There is no public resume or cancel tool.

## Checkpoint and idempotency rules

An operation containing every fixed candidate and an initial item state is durable before the first SuperOps read or write. Each claimed item follows the applicable lifecycle:

- Update: `Validated` -> `WriteNotStarted` -> `WriteStarted` -> `FieldsUpdated` -> `Verifying` -> terminal.
- Resolution: `Validated` -> `ResolutionValidated` -> `ResolutionWriteStarted` -> `ResolutionWriteSucceeded` -> `ResolutionVerified` -> optional note stages -> `Verifying` -> terminal.
- Private note: `NoteChecked` -> `NoteWriteStarted` -> `NoteAdded` -> `Verifying` -> terminal.

`WriteStarted`, `ResolutionWriteStarted`, and `NoteWriteStarted` are acknowledged durably before the outbound mutation. A reliable accepted response is checkpointed immediately as `FieldsUpdated`, `ResolutionWriteSucceeded`, or `NoteAdded`; a created note ID is stored with `NoteAdded`. If acknowledgement or response delivery is uncertain after mutation start, the item remains possible-write/ambiguous and is reconciled by read-back. It is never blindly replayed.

Terminal items cannot reopen. `writeAttempted` and `writeMayHaveSucceeded` cannot move backwards. Claims require the correct owner and lease ID; expired leases can be reclaimed, while stale claim tokens cannot commit. The default item lease is 180 seconds, while configured request timeout, CPU guard, and invocation duration are 10, 20, and 25 seconds respectively, proving bounded processing beneath the lease.

Resolution fallback after a 5xx is allowed only after a re-read proves the requested resolution is absent and `updatedTime` is unchanged. A visible accepted resolution, any changed `updatedTime`, or an ambiguous read blocks fallback.

## Budget and retry policy

Normal work stops before `subrequestBudget - safetyMargin`; reserved margin is available for authoritative ledger persistence. The client applies a real timeout to every SuperOps request. Timed-out reads may retry within central attempt/duration limits; writes are never centrally retried.

Durable continuation enforces maximum item count per invocation, continuation count, durable retry attempts, total durable retry duration, and single durable wait. It persists first-throttled time, parsed/capped/applied delay, the measured delay observed at the next attempt, accumulated retry duration, next eligibility, and scheduling outcome. Exhaustion is terminal `RateLimitExceeded`. Configured budget exhaustion, platform subrequest-limit signatures, CPU-limit signatures, request timeout, SuperOps throttling, network failure, scheduling failure, and malformed ledger state have distinct stable classes.

## Scheduling and retention

Immediate continuation uses the self service binding only when enabled. Long waits use the Workflow binding and deterministic schedule identity. Workflow creation retries use bounded exponential backoff with a 500 ms cap; exhausted scheduling terminalizes every unfinished item while retaining possible-write truth. Duplicate or stale deliveries cannot bypass the owner/lease/checkpoint adapter.

`expiresAt` controls terminal-record retention and is restarted for the configured retention duration when an active operation first becomes terminal. Durable Object alarms delete expired terminal records independently of reads and reschedule retained terminal expiry. Non-terminal or ambiguous records are not deleted merely because a read did not occur or the creation-time window elapsed. `maxOperationLifetimeAt` prevents indefinite new work and terminalizes unfinished items without erasing ambiguity evidence.

## Scope consequences

Durable apply-triage is the primary production write path. Direct ticket and alert mutations have conservative synchronous response contracts but no resumable ledger and remain blocked by default. Opaque custom mutation is bounded, non-resumable, and blocked by default. Read tools, durable apply-triage, and operation status remain available under the normal tool policy.

Whole-MCP durable adapters, public resume/cancel tools, and historical assignment/resolution reporting are not implemented.

## Provisioning and rollback

`wrangler.json` pins the project to Wrangler `4.111.0`, declares the Durable Object, self service binding, and `SUPEROPS_CONTINUATION_WORKFLOW`, and keeps both continuation flags false. No production resources were provisioned by this repair.

Deployment is a separately approved resource-changing action. Rollback must first set both continuation flags false. Pending Workflow instances may still deliver, so retain the Worker internal route, service binding, token, Workflow class, and ledger until all pending operations are terminal or explicitly investigated. Do not remove the Durable Object binding or delete records while ambiguity/partial-write evidence remains within retention. Alarms are cleanup-only and should remain until retained terminal records expire.