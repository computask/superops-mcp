# SuperOps MCP Execution Safety Verification

Verification date: 2026-07-18. Final conformance repair cycle 1.

## Root cause and repaired boundary

The original multi-ticket failure was consistent with exhausting a Cloudflare invocation subrequest budget after some SuperOps mutations. Sleeping in that invocation cannot reset its limits. Upstream HTTP 429/GraphQL throttling is separate and may require a wait longer than one request lifetime.

The repaired production path makes the complete fixed-candidate operation durable before the first SuperOps call, stops before unsafe units of work, checkpoints mutation start before every write, checkpoints reliable success immediately, and resumes only from the authoritative item stage under an owner-scoped lease. Possible successful writes are read back and are never blindly replayed.

## Implementation status

| Requirement | Production implementation | Direct evidence |
| --- | --- | --- |
| Configured subrequest/time/CPU guard | `src/execution.ts` separates configured budget, request timeout, cooperative CPU guard, and recognized Cloudflare hard-limit classes. | `src/execution.test.ts`, continuation tests |
| Real request timeout and bounded reads | Every `SuperOpsClient` request uses `AbortController`; timeout is a retryable read-network class within attempt/duration ceilings. Writes remain one attempt. | `src/client.test.ts` |
| Complete durable operation before work | Public apply-triage persists all expected items and zero/initial results before it enters the real adapter; store failure returns no-write truth. | ticket store-failure and first-checkpoint tests |
| Mutation checkpoints | Update, resolution, and note use acknowledged start/success stages; created note ID is checkpointed before later work. | ticket and mixed-fault tests |
| Ambiguity and fallback | Possible-write state is monotonic. Accepted lost responses are reconciled by read-back without replay. Retry or fallback requires a durable, conclusive non-acceptance checkpoint; an unchanged read after a timeout, network failure, HTTP 5xx, or lost response is not proof of rejection. | accepted-resolution-lost-response, conclusive-rejection restart, and ambiguity tests |
| Durable wait and Workflow accounting | Pinned Wrangler `4.111.0` Workflow binding uses `step.sleepUntil`; DO alarms are retention cleanup only. Every Workflow delivery creates a fresh execution-accounting context, and store, SuperOps, verification, scheduling, and `createBatch` calls use the central accounting path. | workflow, execution, client, and operation-store tests |
| Retry ceilings | Continuation, durable attempt/duration/single-wait, scheduling, request, and lifetime ceilings terminalize honestly. | continuation and store tests |
| Terminal retention | The configured retention duration restarts when an active operation first becomes terminal; creation-time expiry never erases newly terminal evidence. | memory and Durable Object operation-store tests |
| Ledger safety | 500-item and 512-KiB limits, exact item coverage, shape/timestamp validation, forbidden-content scan, redacted compact results. | operation-store tests |
| Default tool policy | Unreviewed synchronous writes, custom mutation, and direct-route mutations are false by default; durable apply-triage, reads, and status remain. Guards precede credential/client initialization. | audit/worker tests and `wrangler.json` |
| Fixed-seed acceptance harness | Exactly 250 items pass through public apply-triage and the real resume adapter with mocked SuperOps transport only. The checkpoint matrix terminates before and after every update, resolution, and private-note checkpoint, restarts through the production adapter, tests duplicate delivery under an active lease, and proves successful mutations are not repeated. | `src/continuation-mixed-fault-harness.test.ts` |

## Outbound call inventory

All standard SuperOps traffic is one GraphQL POST per client attempt to the US or EU `/msp` endpoint. A “read retries” worst case is the configured read-attempt ceiling, which defaults to three total attempts. Writes are one outbound attempt unless the durable adapter has conclusive evidence that the previous write was rejected.

| Tool or runtime operation | Normal calls | Worst-case bound / rule | Resumable |
| --- | ---: | --- | --- |
| Status/navigation | 0 | 0 | N/A |
| `superops_test_connection` | 1 read | 3 attempts | No |
| Operation get/list | 1 DO fetch | 1 per call | N/A |
| Client list/get/search | 1 read | 3 attempts | No |
| Asset list/get/software/patches | 1 read | 3 attempts | No |
| Technician list/get/groups | 1 read | 3 attempts | No |
| Alert list/for-asset | 1 read | for-asset fallback: 2 reads, each within retry bound | No |
| Alert get | 1 read | exact lookup plus at most 11 fallback pages; each read within retry bound | No |
| Alert create | 1 write + optional verification | one write; verification lookup bounded as alert get | No |
| Alert resolve | 1 write + optional per-alert verification | one batch write; each requested verification bounded as alert get | No |
| Custom query | 1 read | query document 64 KiB, variables 128 KiB, response 1 MiB, read retry bound; caller query shape is otherwise opaque | No |
| Custom mutation | 1 write | one attempt; same request/response size bounds; ambiguous response is non-resumable | No |
| Ticket list/get/conversation/notes/fields | 1 read | read retry bound | No |
| Ticket get by number | 2 reads | 6 total attempts | No |
| Ticket safe get | 2 base reads | at most 4 logical reads, each within retry bound | No |
| Ticket recent | 1 list | plus at most 2 content reads for each of at most 10 tickets | No |
| Triage snapshot | 1 list | plus at most 2 safe-content reads per bounded candidate | No |
| Historical query/created-between/report | sequential pages | `maxPages` and `maxRecords`; each page within retry bound; never concurrent | No |
| Direct ticket create/note/log-time | 1 write | one attempt | No |
| Direct ticket update | validation read + write | at most 2 logical calls; one write | No |
| Direct resolve-full | lookup/read/metadata/note/update/verify | bounded synchronous path; a note followed by failed update reports partial write and is never blindly repeated | No |
| Durable apply-triage | per-item validation/dedupe/write/verification | one Worker invocation can consume at most 45 counted outbound calls; normal work stops before 37 and reserves 8 for ledger persistence. It also stops at 25 items. No item starts unless its estimated first-attempt unit fits, and every mutation hook rechecks capacity for its start/accepted checkpoints, outbound write, required read-back, and final ledger commit. | Yes |
| Immediate continuation delivery | 1 self service-binding fetch | one delivery attempt by the scheduler; route rechecks token and ledger | Yes |
| Schedule long wait | 1 Workflow `createBatch` | deterministic identity, at most 8 creation attempts with exponential backoff capped at 500 ms | Yes |
| Workflow wake attempt | 3 DO calls + 1 service fetch before success accounting | repeated service failure: at most 8 Workflow step attempts (32 internal calls); successful attempt adds 3 DO calls, for at most 35 internal calls across the step | Yes |
| Operation cleanup alarm | DO storage list/delete/put/setAlarm | no SuperOps or service-binding call; expires retained terminal records and terminalizes overdue active records | N/A |

The maximum normal counted calls in an MCP invocation are therefore 37 with the committed 45/8 configuration. The dedicated harness uses 37 for its initial invocation and 12 for each deliberately constrained continuation invocation, and checks each invocation against its own effective budget.

## Mutation classification

- Durable: `superops_tickets_apply_triage_plan`. Primary production write path; mutation type, target hash, note fingerprint/ID, response observation, fallback, checkpoint, and verification state are authoritative.
- Safe synchronous but blocked by default: direct ticket and alert mutations. Successful/rejected/ambiguous returns expose `writeAttempted`, `writeMayHaveSucceeded`, reliable-response state, replay safety, and classification. They are not automatically replayed.
- Opaque and blocked by default: `superops_custom_mutation`. It is bounded but cannot derive a canonical verification target.
- Read-only: standard reads and operation-status tools. They remain available.

## Rate-limit and execution taxonomy

The client distinguishes HTTP 429, reset headers, structured GraphQL throttling, HTTP 5xx, authentication/validation GraphQL rejection, malformed response, network failure, and request timeout. Continuation additionally distinguishes configured subrequest stop, platform subrequest signature, configured execution timeout, cooperative CPU guard/platform CPU signature, rate-limit exhaustion, scheduling failure, Workflow delivery failure, operation-store failure, malformed stored operation, stale data, verification mismatch, and ambiguous write.

Durable rate state records attempt count, first-throttled time, parsed/capped/applied/actual delay, accumulated retry duration/elapsed time, next eligibility, whether another invocation is required, and final result. A conclusive throttle marks the mutation response rejected and may be retried later. An inconclusive possible write remains ambiguous and is reconciled instead. Exhaustion becomes terminal `RateLimitExceeded`.

## Durable record and checkpoint inventory

The public operation record contains no note body or customer message content. The approved request snapshot stores fixed candidates, action type, canonical target hashes, expected metadata hashes, and note fingerprints. Approved private-note body content needed for durable recovery is persisted separately as AES-GCM encrypted recovery content keyed by SUPEROPS_PRIVATE_NOTE_ENCRYPTION_KEY, and plaintext is excluded from operation status, compact results, diagnostics, logs, audit data, and errors. A later process that lacks recoverable private-note content fails safely before write unless the persisted note stage can be reconciled from its fingerprint/created note identity.

Required stages:

- Update: `Validated`, `WriteNotStarted`, `WriteStarted`, `FieldsUpdated`, `Verifying`, terminal.
- Resolution: `ResolutionValidated`, `ResolutionWriteStarted`, `ResolutionWriteSucceeded`, `ResolutionVerified`, optional note stages, `Verifying`, terminal.
- Note: `NoteChecked`, `NoteWriteStarted`, `NoteAdded`, `Verifying`, terminal.

The store rejects broad transition weakening. Terminal stages cannot reopen; write truth cannot regress. Exhausted durable Workflow scheduling, unavailable immediate delivery, and exhausted Workflow wake delivery terminalize unfinished items without erasing possible-write truth. An initial store failure stops before every SuperOps call and returns explicit no-write truth. Cleanup alarms independently terminalize operations that exceed their maximum lifetime and never call SuperOps.

## Fixed-seed mixed-fault harness

Seed `0x5eed250` creates exactly 250 expected items and drives the public apply entrypoint plus `resumeApplyTriageOperation`, mocking only the SuperOps transport. It injects reliable HTTP and GraphQL throttles, accepted update/resolution/note with lost responses, ambiguous 5xx/network failures, stale changes during a long wait, validation failure, no-action and explicit skip, wrong owner, duplicate wake, expired-lease reclaim, stale lease token, checkpoint acknowledgement loss, scheduling failure, malformed record, and constrained fresh budgets.

Mandatory counters include expected, accounted, terminal, unaccounted, updated, resolved, note-only, skipped, completed, failed, stale, validation failure, ambiguity, partial write, rate reschedules, retries, continuation invocations, durable waits, maximum durable wait, maximum calls per invocation, over-budget invocations, duplicate writes by type, scheduling/store failures, and malformed records. Assertions require 250 expected/accounted/terminal, unaccounted zero, duplicate update/resolution/private note zero, no invocation over its effective budget, and a durable wait longer than 25 seconds.

A second real-adapter crash matrix covers 28 deterministic before/after checkpoint failures spanning every update, resolution, and private-note boundary. It uses the public apply entrypoint with mocked SuperOps transport, verifies the last acknowledged durable stage, and asserts that each scenario performs at most one outbound mutation.

## Configuration and external validation

`package.json` and the lockfile pin Wrangler `4.111.0`, whose CLI validation requires Node.js 22 or newer. `wrangler.json` validates against that installed package’s `config-schema.json`, declares the Workflow/DO/service bindings, and sets all write/continuation overrides false. In this restricted repair environment, typecheck, build, lint, JSON schema validation, version inspection, and `git diff --check` pass. Vitest and Wrangler’s esbuild build path are not runnable here because Windows child-process creation fails with `spawn EPERM`; that is not counted as passing evidence.

Before any staging change, run in an unrestricted environment:

```powershell
npm ci
npm test
npm run test:continuation-harness
npm run build
npm run typecheck
npm run lint
git diff --check
npx wrangler deploy --dry-run --config wrangler.json
```

Exact approved staging/production resource-changing commands and pending-Workflow rollback rules are in `docs/continuation-operations.md`. No commit, push, deployment, provisioning, secret creation, or live SuperOps mutation was performed in this repair cycle.

### Exact per-tool call and response matrix

Counts below are logical SuperOps GraphQL POSTs before read retry multiplication. A read marked `R` can consume up to 3 total attempts under committed defaults; a synchronous write marked `W` is one attempt and is not retried by the shared client. Durable apply-triage is the only resumable write path.

| Tool | Calls before read retries | Pagination/fallback | Verification | Worst-case committed SuperOps attempts | Output bound |
| --- | --- | --- | --- | --- | --- |
| `superops_clients_list` | 1R | one requested page, page size max 500 | none | 3 | MCP serialized response cap 1 MiB |
| `superops_clients_get` | 1R | none | same read is retrieval | 3 | MCP serialized response cap 1 MiB |
| `superops_clients_search` | 1R | one requested page, max 20 unless supplied | none | 3 | MCP serialized response cap 1 MiB |
| `superops_assets_list` | 1R | one requested page, page size max 500 | none | 3 | MCP serialized response cap 1 MiB |
| `superops_assets_get` | 1R | none | same read is retrieval | 3 | MCP serialized response cap 1 MiB |
| `superops_assets_software` | 1R | one requested page | none | 3 | MCP serialized response cap 1 MiB |
| `superops_assets_patches` | 1R | one requested page | none | 3 | MCP serialized response cap 1 MiB |
| `superops_technicians_list` | 1R | one requested page, page size max 500 | none | 3 | MCP serialized response cap 1 MiB |
| `superops_technicians_get` | 1R | none | same read is retrieval | 3 | MCP serialized response cap 1 MiB |
| `superops_technicians_groups` | 1R | one requested page | none | 3 | MCP serialized response cap 1 MiB |
| `superops_alerts_list` | 1R | one requested page, page size max 500 | none | 3 | MCP serialized response cap 1 MiB |
| `superops_alerts_for_asset` | 1R, fallback 1R if status condition is rejected | one requested page | none | 6 | MCP serialized response cap 1 MiB |
| `superops_alerts_get` | 1R exact-condition lookup plus up to 10 fallback pages | fallback stops when found or `hasMore=false` | same read is retrieval | 33 | MCP serialized response cap 1 MiB |
| `superops_alerts_summary` | 1R | one requested page, default 100 | aggregate only | 3 | aggregate counts plus 10 compact samples, MCP cap |
| `superops_alerts_create` | 1W plus optional alert lookup | lookup uses alert-get path when `verify` is not false | returns verification or accepted-followup failure | 34 | one alert plus compact verification, MCP cap |
| `superops_alerts_resolve` | 1W plus optional lookup per requested alert ID | each lookup uses alert-get path | per-alert verification or skipped reason | `1 + 33 * ids` | compact per-ID verification, MCP cap |
| `superops_custom_query` | 1R | caller-defined query, bounded only by input/response bytes | none | 3 | custom response cap 1 MiB plus MCP cap |
| `superops_custom_mutation` | 1W | none | explicitly not possible for opaque mutation | 1 | custom response cap 1 MiB plus MCP cap |
| `superops_tickets_list` | 1R | one requested page, page size max 500 | none | 3 | MCP serialized response cap 1 MiB |
| `superops_tickets_recent` | 1R plus up to 2R per included content ticket | recent page is capped; content tickets capped at 10 | content retrieval only | 63 | per-content char/item caps plus MCP cap |
| `superops_tickets_query`, `superops_tickets_created_between`, `superops_tickets_report` | sequential R pages | bounded by `maxPages`, `maxRecords`, and execution budget | aggregate/report only | `3 * fetchedPages` | max records/pages plus MCP cap |
| `superops_tickets_get` | 1R | none | same read is retrieval | 3 | MCP serialized response cap 1 MiB |
| `superops_tickets_get_by_number` | up to 2R | display lookup then internal read | same read is retrieval | 6 | MCP serialized response cap 1 MiB |
| `superops_tickets_get_safe_by_number` | up to 4R | metadata plus optional conversations/notes | safe content retrieval | 12 | per-item and total char caps plus MCP cap |
| `superops_tickets_field_options` | 1R | selected field list | metadata validation | 3 | MCP serialized response cap 1 MiB |
| `superops_tickets_conversation_list` | 1R | bounded by SuperOps response and MCP cap | none | 3 | MCP serialized response cap 1 MiB |
| `superops_tickets_notes_list` | 1R | bounded by SuperOps response and MCP cap | none | 3 | MCP serialized response cap 1 MiB |
| `superops_tickets_triage_snapshot` | 1R list plus up to 2R per candidate | candidate count and per-ticket content caps | read-only evidence | `3 * (1 + 2 * candidates)` | per-ticket content caps plus MCP cap |
| `superops_tickets_create` | 1W plus optional 1R read-back when response has ticket ID | none | ticket read-back when `verify` is not false | 4 | created ticket plus compact verification, MCP cap |
| `superops_tickets_update` | 0-1R metadata option lookup plus 1W plus optional 1R read-back | option lookup only for validated dynamic fields | scalar field read-back when `verify` is not false | 7 | update result plus compact verification, MCP cap |
| `superops_tickets_resolve_full` | lookup/metadata/options reads, optional 1W note, 1W update, optional ticket/notes verification reads | no pagination beyond lookup helpers | final state and optional note ID verification unless `verify=false` | bounded by selected fields; at most two writes | compact result, exact write count, MCP cap |
| `superops_tickets_add_note` | 1W plus optional 1R notes read-back | none | returned note ID checked when `verify` is not false | 4 | note ID/privacy metadata only, MCP cap |
| `superops_tickets_log_time` | 1W | none | no bounded worklog read-back exists; response states this | 1 | worklog mutation result plus non-verification reason, MCP cap |
| `superops_tickets_apply_triage_plan` | durable per-item units | stops before unsafe unit; resumes by ledger | mandatory read-back/dedupe/stale verification according to action | max 37 counted SuperOps calls per default invocation | compact results for every expected item plus MCP cap |

### Retry telemetry fields

Read retry diagnostics now include `source`, `retryAfterSupplied`, `suppliedDelayMs`, `parsedDelayMs`, `cappedDelayMs`, `actualDelayMs`, `attempt`, endpoint, GraphQL operation type/name, invocation ID, operation ID, and item key when present. Durable rate-limit state records the same delay taxonomy plus attempts, first-throttled time, scheduled time, actual observed wait from the prior schedule, total retry duration, elapsed time, continuation flag, mutation operation name, endpoint marker, write truth, and final result.

### Synchronous mutation contract

Every synchronous write response, including rejected and ambiguous failures, reports write-attempt truth, `writeMayHaveSucceeded`, reliable-response state, replay safety, classification, final outcome, verification state, partial-write truth, and write count. Direct ticket and alert writes perform read-back verification where a bounded final-state target exists and do not report clean success when that verification fails or is inconclusive. `superops_tickets_log_time` and `superops_custom_mutation` explicitly report why verification is not locally derivable.

### Repository milestone evidence

This document records the current repair-cycle implementation and gate commands, but it is not historical proof that every earlier milestone was separately reviewed, materially committed, and continued. That proof can only come from repository history and external CI/audit records. This repair cycle therefore documents the limitation rather than overstating progress-note evidence as historical proof.
