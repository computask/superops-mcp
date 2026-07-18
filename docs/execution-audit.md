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
| Complete per-ticket triage results after stop | Yes |  |  | `src/domains/tickets.ts` apply plan result assembly | Triage budget/partial-write tests | Automatic resume not implemented | Use operation status tools to inspect partials |
| Explicit unprocessed outcomes | Yes |  |  | `NotAttemptedExecutionStopped`, durable unattempted items | Triage budget test | None known for apply plan | Extend same model to future batch writes |
| Honest `partialWrite` reporting | Yes for triage and resolve-full | Partial for all writes |  | `src/domains/tickets.ts` | Existing partial-write tests | Direct one-off create/update/note tools can still fail after mutation without durable stage detail | Move direct writes into common mutation result wrapper |
| HTTP 429 detection and `Retry-After` parsing | Yes |  |  | `src/client.ts` | `src/client.test.ts` | Sleeps are capped; long reschedule is not automatic yet | Use operation ledger for future reschedule state |
| GraphQL throttling detection | Yes |  |  | `isGraphQLRateLimit()` in `src/client.ts` | `src/client.test.ts` | Message matching can miss vendor-specific shapes | Add cases when real SuperOps shapes are observed |
| Read retry safety | Yes |  |  | `SuperOpsClient.query()` read retry loop | `src/client.test.ts` | Pagination page retry is central per request, not durable per page | Add per-page resume for very deep reads if needed |
| Write retry safety | Yes by restraint | Partial |  | Writes default to one attempt; no blind retry | `src/client.test.ts` | Ambiguous write resolution is implemented in triage paths but not central for all writes | Do not raise write retries without idempotency/verification wrapper |
| Durable operation state | Yes for triage result ledger | Partial |  | `src/operation-store.ts`, `wrangler.json`, triage persistence | `src/operation-store.test.ts`, worker status test | Ledger stores outcomes but does not yet drive automatic processing | Add a processor/resume state machine before claiming continuation execution |
| Fresh-invocation continuation |  |  | Yes | No Workflow/Queue/DO alarm processor exists | None | Large operations stop with `ContinuationRequired` but are not auto-resumed | Implement a safe processor with locks and exact item resume |
| Operation status tools | Yes |  |  | `superops_operations_get`, `superops_operations_results` | `src/worker.test.ts` | Read-only only; no resume/cancel | Add resume only when item processor is safe |
| Load/fault harness | Partial | Yes |  | Budget, rate-limit, DO and partial-write tests | 205 tests passing | No standalone hundreds-item harness script yet | Add a dedicated non-live load harness before production deployment |

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
| `superops_custom_mutation` | `src/domains/custom.ts` | caller supplied mutation | 1 | 1 by default | no automatic write retry | Yes | No |
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
- `src/operation-store.ts`: SQLite Durable Object compatible operation ledger plus memory fallback for local tests.
- `src/mcp-server.ts`: read-only `superops_operations_get` and `superops_operations_results` tools.
- `src/worker.ts` and `wrangler.json`: operation-store binding wiring.
- `src/domains/tickets.ts`: triage result ledger persistence and durable classification of completed, skipped, failed, pending and unattempted items.
- Tests added for rate limits, operation store, operation status tools, and triage ledger persistence.

## Known Limitations

- Automatic fresh-invocation continuation is not implemented yet. The MCP now returns and persists `ContinuationRequired`; it does not silently continue in the background.
- Operation ledger state is implemented for `superops_tickets_apply_triage_plan`; other mutating tools still rely on immediate return contracts.
- Direct one-off mutations cannot be fully idempotent without either SuperOps idempotency support or per-tool verification wrappers.
- Custom GraphQL tools remain intentionally broad. They are budgeted and instrumented at the client layer but cannot be statically call-counted from schema alone.
- There is no standalone hundreds-item load harness script yet; current coverage is unit/integration fault simulation.

## Deployment Boundary

No deployment was performed. Before staging or production, provision the Durable Object binding declared in `wrangler.json`, validate with `wrangler dev`, run `npm test`, `npm run build`, and perform low-budget dry-run triage tests. Do not repurpose `OAUTH_KV` for operation state.