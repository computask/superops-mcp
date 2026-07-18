# SuperOps MCP Execution Safety Verification

Verification date: 2026-07-18.

## Root Cause

The original `superops_tickets_apply_triage_plan` failure was consistent with too many SuperOps GraphQL POSTs inside one Cloudflare Worker invocation. A single ticket could consume calls for display-id lookup, safe ticket read, metadata validation, duplicate-note read, mutation, fallback mutation, and verification. The previous implementation did not proactively stop before the invocation-level subrequest ceiling and did not persist or return a complete per-ticket ledger after a mid-batch failure.

Waiting inside the same Worker invocation would not reset the Cloudflare invocation subrequest limit. SuperOps HTTP/GraphQL throttling is a separate upstream condition and is now classified separately in the client retry path.

## Implementation Matrix

| Requirement | Implemented | Partial | Missing | Evidence | Test evidence | Risk | Recommended action |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Complete outbound-call inventory | Yes |  |  | This document, `rg fetch/client.query/client.mutate` scan | Manual scan | Inventory can drift as tools are added | Keep this doc updated with every new tool |
| Central SuperOps outbound instrumentation | Yes |  |  | `src/client.ts`, `src/execution.ts` | `src/client.test.ts` | Calls through mocked domain clients are not counted in unit tests | Prefer integration tests for accounting |
| Internal Durable Object fetch accounting | Yes |  |  | `src/operation-store.ts`, `recordTypedSubrequestStart(...allowSafetyMargin)` | Typecheck; worker status tests use memory store | DO calls consume reserved margin and can still fail near a hard platform limit | Keep safety margin conservative |
| Configurable subrequest budget and safety margin | Yes |  |  | `src/execution.ts`, `wrangler.json` vars | `src/client.test.ts`, `src/domains/tickets.test.ts` | Defaults assume current Workers limits indirectly | Tune in staging before production writes |
| Per-operation and per-item accounting | Yes |  |  | `executionDiagnostics()`, `withExecutionItem()` | Client and triage tests | Some non-ticket tools do not set item keys | Add item keys to future batch paths |
| Structured budget-exhaustion outcomes | Yes |  |  | `ExecutionBudgetExceededError`, triage result mapping | Triage budget test | Direct simple tools still return standard errors | Accept for single-call tools |
| Bounded ticket pagination | Yes |  |  | `src/domains/ticket-reporting.ts`, ticket list pages | Existing reporting tests | `tickets_list` is a single requested page | Keep max-page caps low |
| Bounded alert verification | Yes |  |  | `src/domains/alerts.ts` sequential verification | Alert tests | Batch resolve can partially mutate upstream before verification | Return verification diagnostics |
| Complete per-ticket triage results after stop | Yes |  |  | `src/domains/tickets.ts` apply plan result assembly | Triage budget/partial-write tests | Automatic scheduling disabled by default | Use operation status tools to inspect partials |
| Explicit unprocessed outcomes | Yes |  |  | `NotAttemptedExecutionStopped`, durable unattempted items | Triage budget test | None known for apply plan | Extend same model to future batch writes |
| Honest `partialWrite` reporting | Yes for triage and resolve-full | Partial for all writes |  | `src/domains/tickets.ts` | Existing partial-write tests | Direct one-off create/update/note tools can still fail after mutation without durable stage detail | Move direct writes into common mutation result wrapper |
| HTTP 429 detection and `Retry-After` parsing | Yes |  |  | `src/client.ts`, `src/continuation.ts` | `src/client.test.ts`, `src/continuation.test.ts` | Immediate waits are capped; durable wake is apply-triage only | Keep maximum delay/lifetime caps conservative |
| GraphQL throttling detection | Yes |  |  | `isGraphQLRateLimit()` in `src/client.ts` | `src/client.test.ts` | Message matching can miss vendor-specific shapes | Add cases when real SuperOps shapes are observed |
| Read retry safety | Yes |  |  | `SuperOpsClient.query()` read retry loop | `src/client.test.ts` | Pagination page retry is central per request, not durable per page | Add per-page resume for very deep reads if needed |
| Write retry safety | Yes by restraint | Partial |  | Writes default to one attempt; no blind retry | `src/client.test.ts` | Ambiguous write resolution is implemented in triage paths but not central for all writes | Do not raise write retries without idempotency/verification wrapper |
| Durable operation state | Yes for triage | Partial for whole-MCP write integration |  | `src/operation-store.ts`, `wrangler.json`, triage persistence | `src/operation-store.test.ts`, `src/continuation.test.ts`, `src/domains/tickets.test.ts`, worker status test | Apply-triage persists approved action snapshots; other write tools still use immediate contracts | Integrate one write tool at a time with a verified adapter |
| Fresh-invocation continuation | Yes for apply-triage when enabled |  |  | `src/continuation.ts`, `src/continuation-scheduler.ts`, `src/operation-store.ts`, `src/worker.ts` | continuation, operation-store, and triage tests | Durable Object alarm delivery is at-least-once; state/claim adapter remains authoritative | Keep both continuation flags disabled until staging evidence exists |
| Operation status tools | Yes |  |  | `superops_operations_get`, `superops_operations_results` | `src/worker.test.ts` | Read-only only; no resume/cancel | Add resume only when item processor is safe |
| Load/fault harness | Yes |  | Fixed-seed 250-item real apply-triage adapter harness; mocked transport only | `src/continuation-mixed-fault-harness.test.ts` | Update, resolution, private note, validation/stale, 429 durable wait, 5xx/network ambiguity, lost responses, owner/lease, store/scheduler and budget faults | No live SuperOps calls | Run `npm run test:continuation-harness` before enabling production continuation |

## Outbound Call Inventory

All SuperOps API calls use `SuperOpsClient` and one GraphQL POST endpoint: `https://api.superops.ai/msp` or `https://euapi.superops.ai/msp`. The operation ledger uses a Cloudflare Durable Object binding when configured; that internal `stub.fetch()` is now counted as a custom subrequest.

| Tool / operation | Source | GraphQL operation or action | Expected calls | Worst case | Pagination / retry / verification | Partial write risk | Resumable |
| --- | --- | --- | ---: | ---: | --- | --- | --- |
| `superops_status` | `src/mcp-server.ts` | none | 0 | 0 | none | No | N/A |
| `superops_test_connection` | `src/mcp-server.ts` | simple query | 1 | read retries | central read retry | No | No |
| `superops_operations_get` | `src/mcp-server.ts` | Durable Object get | 0 memory / 1 DO | 1 | no retry | No | N/A |
| `superops_operations_results` | `src/mcp-server.ts` | Durable Object list | 0 memory / 1 DO | 1 | no retry | No | N/A |
| `superops_clients_list` | `src/domains/clients.ts` | `getClientList` | 1 | read retries | single page | No | No |
| `superops_clients_get` | `src/domains/clients.ts` | `getClient` | 1 | read retries | none | No | No |
| `superops_clients_search` | `src/domains/clients.ts` | `getClientList` | 1 | read retries | local filter | No | No |
| `superops_assets_list` | `src/domains/assets.ts` | `getAssetList` | 1 | read retries | single page | No | No |
| `superops_assets_get` | `src/domains/assets.ts` | `getAsset` | 1 | read retries | none | No | No |
| `superops_assets_software` | `src/domains/assets.ts` | software list | 1 | read retries | single page | No | No |
| `superops_assets_patches` | `src/domains/assets.ts` | patch details | 1 | read retries | single page | No | No |
| `superops_technicians_list` | `src/domains/technicians.ts` | `getTechnicianList` | 1 | read retries | single page | No | No |
| `superops_technicians_get` | `src/domains/technicians.ts` | `getTechnicianList` | 1 | read retries | first page of 500 | No | No |
| `superops_technicians_groups` | `src/domains/technicians.ts` | `getTechnicianGroupList` | 1 | read retries | none | No | No |
| `superops_alerts_list` | `src/domains/alerts.ts` | `getAlertList` | 1 | read retries | requested page | No | No |
| `superops_alerts_get` | `src/domains/alerts.ts` | `getAlertList` | 1 | 12 plus retries | exact lookup plus capped fallback scan | No | No |
| `superops_alerts_for_asset` | `src/domains/alerts.ts` | `getAlertsForAsset` | 1 | 2 plus retries | fallback without status condition | No | No |
| `superops_alerts_resolve` | `src/domains/alerts.ts` | `resolveAlerts`, `getAlertList` | 1 + verification | 1 + 12 per alert plus retries | sequential verification | Yes | No |
| `superops_alerts_create` | `src/domains/alerts.ts` | `createAlert`, `getAlertList` | 1-2 | 13 plus retries | optional verification | Yes | No |
| `superops_custom_query` | `src/domains/custom.ts` | caller supplied query | 1 | read retries | no schema-level page cap | No | No |
| `superops_custom_mutation` | `src/domains/custom.ts` | caller supplied mutation | 1 | 1 by default | no automatic write retry; reliable rejection is distinguished from uncertain transport outcome | Yes | Intentionally no |
| `superops_tickets_list` | `src/domains/tickets.ts` | `getTicketList` | 1 | read retries | requested page | No | No |
| `superops_tickets_recent` | `src/domains/tickets.ts` | `getTicketList`, optional content reads | 1 | 1 + 2 per capped ticket plus retries | content capped to 10 tickets | No | No |
| `superops_tickets_query` | `src/domains/ticket-reporting.ts` | `getTicketList` | pages | capped pages plus retries | sequential pagination, no completeness claim when capped | No | No |
| `superops_tickets_created_between` | `src/domains/ticket-reporting.ts` | `getTicketList` | pages | capped pages plus retries | same query engine | No | No |
| `superops_tickets_report` | `src/domains/ticket-reporting.ts` | `getTicketList` | pages | capped pages plus retries | same query engine | No | No |
| `superops_tickets_get` | `src/domains/tickets.ts` | `getTicket` | 1 | read retries | none | No | No |
| `superops_tickets_get_by_number` | `src/domains/tickets.ts` | lookup then `getTicket` | 2 | 2 plus retries | no pagination beyond lookup page | No | No |
| `superops_tickets_get_safe_by_number` | `src/domains/tickets.ts` | lookup, ticket, optional notes/conversations | 2 | 4 plus retries | optional sections report unavailable content | No | No |
| `superops_tickets_triage_snapshot` | `src/domains/tickets.ts` | list plus safe content | 1 | 1 + 2 per candidate plus retries | candidate/content caps | No | No |
| `superops_tickets_apply_triage_plan` | `src/domains/tickets.ts` | read/validate/dedupe/mutate/verify/fallback | 0 to many | bounded by item/budget stops plus retries | per-ticket budget estimate before starting next item | Yes | Ledger only |
| `superops_tickets_conversation_list` | `src/domains/tickets.ts` | conversation list | 1 | read retries | single request | No | No |
| `superops_tickets_notes_list` | `src/domains/tickets.ts` | note list | 1 | read retries | single request | No | No |
| `superops_tickets_field_options` | `src/domains/tickets.ts` | `getFields` | 1 | read retries | single request | No | No |
| `superops_tickets_create` | `src/domains/tickets.ts` | `createTicket` | 1 | 1 | no write retry | Yes | No |
| `superops_tickets_resolve_full` | `src/domains/tickets.ts` | lookup/read/metadata/note/update/verify | 2-6 | 8+ | optional verification/fallback validation | Yes | No |
| `superops_tickets_update` | `src/domains/tickets.ts` | `getFields`, `updateTicket` | 1-2 | 2 | metadata validation | Yes | No |
| `superops_tickets_add_note` | `src/domains/tickets.ts` | `createTicketNote` | 1 | 1 | no direct dedupe | Yes | No |
| `superops_tickets_log_time` | `src/domains/tickets.ts` | worklog mutation | 1 | 1 | no verification | Yes | No |

## Before and After Subrequest Counts

- Before: `apply_triage_plan` could grow approximately linearly with ticket count and hidden per-ticket stages; no proactive stop or durable status existed.
- After: default configured budget is 45 with safety margin 8. Normal SuperOps work stops before 37 counted subrequests. Durable ledger persistence may consume reserved margin so partial outcomes can be stored.
- Safe batch size depends on requested stages. With the current default, practical synchronous triage batches should stay below 25 items and much lower when actions require note dedupe, fallback, and verification.

## Rate-Limit Handling

`src/client.ts` now distinguishes:

- HTTP 429 and Retry-After seconds/date.
- Rate-limit reset headers: `X-RateLimit-Reset`, `RateLimit-Reset`, `X-Rate-Limit-Reset`.
- GraphQL throttling codes/messages without treating all GraphQL errors as throttling.
- HTTP 5xx, network failures, malformed responses, and authentication/validation errors.

Reads use bounded retry attempts. Writes do not retry by default, even if `SUPEROPS_EXECUTION_MAX_WRITE_RETRY_ATTEMPTS` is raised, because `shouldRetrySuperOpsRequest()` returns false for writes. That is intentional until a specific write path proves idempotency or verifies current state after an ambiguous response.

## Implemented Changes

- `src/execution.ts`: invocation IDs, operation IDs, configurable budget, safety margin, elapsed-time checks, per-item stats, request classification, retry counters, structured diagnostics.
- `src/client.ts`: central HTTP/GraphQL rate-limit detection, bounded read retries, Retry-After parsing, no blind write retries.
- `src/operation-store.ts`: SQLite Durable Object compatible operation ledger plus memory fallback for local tests; owner-scoped claim, complete and continuation scheduling primitives.
- `src/continuation.ts`: generic budget-aware continuation runner for exact unfinished-item resume.
- `src/continuation-scheduler.ts`: disabled-by-default service-binding scheduler for immediate fresh Worker invocations.
- `src/operation-store.ts`: optional Durable Object alarm wake path for long Retry-After delays; it stores only operation identity/owner hash and re-enters the internal continuation adapter.
- `src/domains/tickets.ts`: apply-triage continuation adapter that reuses synchronous safety helpers.
- `src/mcp-server.ts`: read-only `superops_operations_get` and `superops_operations_results` tools.
- `src/worker.ts` and `wrangler.json`: operation-store binding wiring.
- `src/domains/tickets.ts`: triage result ledger persistence and durable classification of completed, skipped, failed, pending and unattempted items.
- Tests added for rate limits, operation store, operation status tools, and triage ledger persistence.

## Known Limitations

- Apply-triage continuation is implemented but automatic scheduling is disabled by default. Without `SUPEROPS_CONTINUATION_ENABLED=true` and the internal service binding/token, the MCP still returns and persists `ContinuationRequired` for manual/status inspection.
- Operation ledger state is implemented for `superops_tickets_apply_triage_plan`; other mutating tools still rely on immediate return contracts.
- Direct one-off mutations cannot be fully idempotent without either SuperOps idempotency support or per-tool verification wrappers.
- Custom GraphQL tools remain intentionally broad. They are budgeted and instrumented at the client layer but cannot be statically call-counted from schema alone. An opaque custom mutation is intentionally non-resumable: a possible-write error is returned as `AmbiguousWriteUnresolved`, never automatically retried, because the tool cannot safely derive a canonical verification target.
- The dedicated fixed-seed mixed-fault harness is `src/continuation-mixed-fault-harness.test.ts`. It drives exactly 250 items through `superops_tickets_apply_triage_plan` plus `resumeApplyTriageOperation`, mocking only the SuperOps transport. It asserts authoritative expected/accounted/terminal counters, zero duplicate successful update/resolution/private-note mutations, and no invocation over the configured 12-request safety threshold. It includes validation and stale outcomes, 429 durable rescheduling, 5xx/network ambiguity, accepted writes with lost responses, expired lease recovery, wrong-owner rejection, injected operation-store and continuation-scheduling failures, and fresh-budget continuation. It does not call live SuperOps.

## Audit Conclusions and Remaining Local Work

The central client is the sole SuperOps GraphQL transport and records every standard read/write request. Its deterministic coverage includes HTTP 429 with Retry-After seconds and HTTP dates, reset-header throttling, structured GraphQL throttling, false-positive GraphQL validation messages, HTTP 5xx, network and abort-style timeout failures, retry exhaustion, retry accounting, and restraint on write retries. Long Retry-After values that cannot fit the configured in-invocation duration are surfaced with their parsed delay so the checkpointed apply-triage adapter can schedule its durable wake rather than sleeping or replaying a write.

The mutation inventory above is complete. The safety implementation is intentionally tiered:

- Apply-triage is the only multi-item durable mutation workflow. It owns mutation-start checkpoints, stale checks, ambiguity reads, private-note fingerprint recovery, long-wait scheduling, and owner-scoped status.
- Alert and direct ticket writes are centrally budgeted and never blindly retried. They remain synchronous; where a final-state verification exists, they return that result, but they do not have a per-write durable checkpoint/continuation adapter.
- Opaque custom mutations are explicitly non-resumable. A transport-style possible write is returned as `AmbiguousWriteUnresolved`; a reliable rejection is `WriteRejected`.

Therefore whole-MCP durable recovery remains deliberately limited to apply-triage. On the ChatGPT direct route, the registry-derived policy blocks these synchronous mutations by default: `superops_tickets_create`, `superops_tickets_update`, `superops_tickets_resolve_full`, `superops_tickets_add_note`, `superops_tickets_log_time`, `superops_alerts_create`, `superops_alerts_resolve`, and `superops_custom_mutation`. The reviewed durable `superops_tickets_apply_triage_plan`, all read-only tools, and operation-status tools remain available. Set `CHATGPT_DIRECT_ALLOW_MUTATING_TOOLS=true` only after an explicit deployment review; it is disabled by default.

## Read-only Audit

The inventory's read-only tools are bounded as follows: single-page list tools cap caller page size; ticket reporting uses sequential capped pagination with local post-filtering and explicit truncation/completeness metadata; alert ID fallback has a fixed page limit; recent/triage safe-content enrichment is capped; and all standard reads use central bounded retry accounting. Read-only custom GraphQL remains caller-defined and cannot be statically guaranteed to paginate or cap its response; treat it as an advanced operator tool rather than a safe reporting primitive. No standard report retrieves ticket descriptions, conversation bodies, note bodies, or attachment bodies unless an explicitly requested safe-retrieval tool does so under its caps.

## Deployment Boundary

No deployment was performed. Before staging or production, provision the Durable Object binding declared in `wrangler.json`, validate with `wrangler dev`, run `npm test`, `npm run build`, and perform low-budget dry-run triage tests. Do not repurpose `OAUTH_KV` for operation state.
