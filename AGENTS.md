# AGENTS.md

## Repository Purpose

- This repository is a TypeScript MCP server that integrates ChatGPT/MCP clients with the SuperOps.ai PSA/RMM GraphQL API.
- The primary hosted runtime is a Cloudflare Worker serving MCP over Streamable HTTP at `/mcp`; a Node entrypoint also supports stdio and HTTP transports.
- MCP tools are registered centrally by `src/mcp-server.ts` and exposed as a flat tool list for broad MCP client compatibility.
- Domain modules under `src/domains/` implement SuperOps tool groups: clients, tickets, assets, alerts, technicians, and custom GraphQL.
- `src/client.ts` is the shared SuperOps GraphQL client. It owns API endpoint selection, per-request credential isolation, outbound-call accounting, and bounded read retry behavior.
- `src/worker.ts` owns the Cloudflare Worker boundary, CORS, `/health`, `/mcp`, gateway/env auth modes, ChatGPT direct OAuth, execution-budget config, and operation-store wiring.
- Read-only tools include listing/search/reporting/safe retrieval tools and operation-status tools.
- Mutating tools include ticket create/update/resolve/note/time-log, alert create/resolve, approved triage plan execution, and custom mutation when enabled.
- Ticket triage is safety-critical: `superops_tickets_triage_snapshot` is the read-only evidence collection path, and `superops_tickets_apply_triage_plan` is the approved fixed-candidate write path.
- Historical ticket reporting is createdTime-based and implemented in `src/domains/ticket-reporting.ts`; it uses sequential bounded pagination and local post-filtering for most dimensions.
- Never put SuperOps tokens, OAuth tokens, Cloudflare Access secrets, customer message bodies, full ticket descriptions, note bodies, attachment bodies, or sensitive headers in docs, tests, logs, or committed fixtures.

## Important Files And Architecture

- `src/mcp-server.ts` - side-effect-free shared MCP server factory, tool listing, navigation/status/operation tools, domain routing, audit/execution wrappers.
- `src/worker.ts` - Cloudflare Worker entrypoint, ChatGPT direct OAuth provider, Cloudflare Access checks, gateway credential extraction, Worker env typing, Durable Object export.
- `src/index.ts` - Node CLI entrypoint for stdio or HTTP transport selected by `MCP_TRANSPORT`.
- `src/client.ts` - SuperOps GraphQL POST client for US/EU endpoints, AsyncLocalStorage credentials, subrequest instrumentation, read retry/rate-limit handling.
- `src/execution.ts` - invocation IDs, operation IDs, subrequest budgets, safety margin, elapsed-time checks, per-item stats, retry diagnostics, structured execution logs.
- `src/operation-store.ts` - Durable Object-compatible operation ledger plus in-memory fallback for tests/local unbound contexts.
- `src/audit.ts` - runtime flags, high-risk tool classification, audit metadata, secret/error redaction, audit log records.
- `src/domains/tickets.ts` - largest domain; ticket CRUD, safe retrieval, triage snapshot, approved triage plan, validation, note dedupe, partial-write reporting.
- `src/domains/ticket-reporting.ts` - createdTime historical ticket query/report aggregation, bounded pagination, local filtering, retry diagnostics.
- `src/domains/alerts.ts` - alert list/get/for-asset/create/resolve/summary, including bounded fallback and sequential verification paths.
- `src/domains/clients.ts`, `assets.ts`, `technicians.ts`, `custom.ts` - smaller domain tool modules.
- `src/types.ts` - shared MCP/SuperOps types.
- `src/utils/elicitation.ts` and `src/utils/server-ref.ts` - MCP helper utilities.
- `src/test-shims/cloudflare-workers.ts` - test shim for `cloudflare:workers` imports.
- `src/*.test.ts` and `src/domains/*.test.ts` - Vitest unit/integration coverage for client, worker, domains, navigation, operation store.
- `docs/execution-audit.md` - verified outbound-call inventory, implementation matrix, root cause, risk assessment, and known execution-safety limits.
- `docs/execution-architecture-decision.md` - ADR for execution budget, SuperOps rate limits, Durable Object ledger, and deferred automatic continuation.
- `README.md` - operator-facing deployment/configuration/tool documentation and confirmed workflow guidance.
- `wrangler.json` - Cloudflare Worker config, non-secret vars, `OAUTH_KV`, and `SUPEROPS_OPERATION_LEDGER` Durable Object binding/export.
- `package.json` - scripts, dependencies, package metadata. Node engine is `>=20.0.0`; module system is ESM/NodeNext.

## Development Commands

Run commands from the repository root in PowerShell.

```powershell
npm test
npm run build
git diff --check
git status --short
git diff --stat
```

Other confirmed scripts from `package.json`:

```powershell
npm run dev
npm run start
npm run lint
npm run typecheck
npm run test:watch
npm run pack:mcpb
npm run validate:mcpb
```

Notes:

- `npm test` runs `vitest run`.
- `npm run build` runs `tsc` and emits `dist/`.
- `npm run typecheck` runs `tsc --noEmit`.
- `npm run lint` is defined as `eslint src --ext .ts`; do not assume it passes unless you run it.
- `dist/`, `.wrangler/`, and `node_modules/` may exist locally; avoid editing generated output unless the task explicitly requires it.

## Coding Conventions

- TypeScript is strict, ESM, `module`/`moduleResolution` `NodeNext`, target `ES2022`.
- Use `.js` extensions in TypeScript relative imports because the project compiles as NodeNext ESM.
- Keep `src/mcp-server.ts` side-effect free. Do not start transports from imported modules.
- Keep domain modules returning the existing `DomainTools` shape: `{ tools, handleCall }`.
- Preserve existing public MCP tool names and required input fields unless a breaking change is explicitly requested and documented.
- Prefer small, targeted edits that follow the local patterns in each domain module.
- Keep tool responses JSON-stringified text payloads where existing tools do that.
- Do not add broad refactors, dependency changes, config changes, or deployment changes during unrelated fixes.
- Do not use ad hoc string parsing where the code already has structured helpers for list inputs, validation, sanitization, or audit metadata.
- Avoid logging raw GraphQL variables or response bodies when they may contain customer content or secrets.

## Authentication And Runtime Boundaries

- In Worker `AUTH_MODE=env`, credentials come from Worker env/secrets and are propagated through `runWithCredentials` because `process.env` is unavailable on workerd.
- In `AUTH_MODE=gateway`, the Worker/HTTP server requires `X-SuperOps-API-Token` and `X-SuperOps-Subdomain` headers for credential-requiring calls.
- `initialize` and `tools/list` work without SuperOps credentials; most `tools/call` paths require credentials except status/navigation and operation-status tools.
- ChatGPT direct OAuth is implemented in `src/worker.ts` with Cloudflare Access identity checks, PKCE S256, allowed redirect hosts, resource validation, and `OAUTH_KV` for OAuth provider storage.
- Do not repurpose `OAUTH_KV` for operation state. Operation state belongs to `SUPEROPS_OPERATION_LEDGER`.
- Runtime flags in `src/audit.ts` can disable all tools, write tools, or custom mutations: `MCP_ENABLED`, `ENABLE_WRITE_TOOLS`, `ENABLE_CUSTOM_MUTATION`.
- The ChatGPT direct route can separately block mutating and broad custom tools unless `CHATGPT_DIRECT_ALLOW_MUTATING_TOOLS=true`.

## SuperOps Client, Rate Limits And Execution Budget

- All standard SuperOps API traffic should pass through `SuperOpsClient.query()` / `.mutate()` in `src/client.ts`.
- The client posts GraphQL to `https://api.superops.ai/msp` for US and `https://euapi.superops.ai/msp` for EU.
- `src/execution.ts` accounts for outbound subrequests, request purpose, retry count, per-item stats, configured budget, safety margin, and elapsed-time budget.
- Normal SuperOps calls stop before `subrequestBudget - subrequestSafetyMargin`; the Durable Object ledger may use reserved margin to persist partial outcomes.
- Reads may be retried with bounded attempts for HTTP 429, recognized GraphQL throttling, HTTP 5xx, and network failures.
- `Retry-After` seconds/date and common reset headers are parsed and capped by execution config.
- Writes are not blindly retried by the central client. Add write retries only when the specific path proves idempotency or verifies current state after an ambiguous response.
- Do not sleep inside the same Worker invocation to solve Cloudflare subrequest exhaustion. Waiting may help SuperOps throttling only if time and subrequest budgets remain.
- See `docs/execution-audit.md` before changing budgets, pagination, retry behavior, or partial-result contracts.

## Durable Operation Ledger Status

- `SuperOpsOperationLedger` is declared in `wrangler.json` as a SQLite-backed Durable Object export and bound as `SUPEROPS_OPERATION_LEDGER`.
- `src/operation-store.ts` stores compact operation metadata only: operation ID, owner hash, expected item IDs, item stages, target fields, note fingerprints, verification state, partial-write flags, pending/unattempted sets, and compact results.
- Operation-status MCP tools are read-only: `superops_operations_get` and `superops_operations_results`.
- Current ledger support is implemented for `superops_tickets_apply_triage_plan` result/status visibility.
- Automatic fresh-invocation continuation is not implemented. Do not claim it is. The current behavior is honest `ContinuationRequired` plus durable status inspection.
- There is no safe `resume` or `cancel` tool yet. Add one only after implementing per-operation locking, exact item resume, stale checks, note fingerprint checks, and tests.

## Ticket Domain Safety Rules

- For New Calls triage, use `superops_tickets_triage_snapshot` first. It freezes candidates and returns safe compact evidence.
- Do not write during triage assessment. Writes belong in `superops_tickets_apply_triage_plan` only after explicit approval of a fixed candidate/action set.
- `apply_triage_plan` must return one result for every expected candidate, including skipped, stale, failed, and not-attempted tickets.
- Preserve `updatedTime` stale-data checks. Do not bypass them to reduce calls.
- Mutating triage actions require `contentVerified=true` unless the caller explicitly supplies the existing override flag.
- Note dedupe trims text, collapses whitespace, and compares case-insensitively; do not weaken this or add duplicate private notes on retry/resume.
- Resolve/update triage actions verify final state when requested; verification mismatches are partial-write failures, not success.
- `superops_tickets_resolve_full` may create a note before a later update fails; this is reported as `partialFailure`. Do not hide that or retry the note blindly.
- Direct `superops_tickets_add_note`, `create`, `update`, and `log_time` are simpler one-off mutations and do not have the same durable stage ledger as triage.

## Confirmed SuperOps API Limitations And Quirks

- Ticket status filters use SuperOps-safe condition operators `is` and `in`.
- Alert status filtering uses `is`; avoid known-bad alert operators such as `EQUALS`, `IN`, and `IS_EMPTY` for standard alert tools.
- Historical reporting supports createdTime ranges only. `updatedFrom`, `updatedTo`, `resolvedFrom`, `resolvedTo`, and non-`createdTime` `timeField` values are intentionally rejected.
- Historical reporting does not rely on guessed SuperOps date operators. It fetches `getTicketList` sorted by `createdTime DESC`, then applies the half-open range locally.
- Historical reporting treats `createdFrom` as inclusive and `createdTo` as exclusive.
- Historical reporting server-side filters are narrow: status is server-side; priority/client/technician/source/request type/category/subcategory/tech group filters are local.
- Technician reporting means current assignee at query time, not historical first assignee.
- `Ticket.description` is not queried by safe retrieval or triage snapshot; ticket body text can come from conversation items with type `DESCRIPTION`.
- Attachment bodies are never returned by safe retrieval. Attachment handling is metadata-only or none.
- `No Action Needed` is a subcategory, not a resolution code. Use a valid resolution code such as `Permanent Fix` where available from live field options.
- Ticket priority, impact, urgency, resolution code, cause, and subcategory are validated against live SuperOps field options where the tool supports those fields.
- Some name-to-ID mappings are intentionally not implemented yet; respect TODOs around requester email, service item/work type, and tech group mapping where present.

## Audit, Logging And Redaction

- Audit logs are structured JSON emitted through `auditToolCall()`.
- High-risk write tools are classified in `src/audit.ts`; update that set when adding mutating tools.
- Custom GraphQL audit metadata includes operation type/name and variable key names only, not full query variables or mutation bodies.
- `sanitizeError()` and `sanitizeToolResult()` redact tokens, auth headers, API-token-like fields, local paths, and stack traces.
- Do not log customer message bodies, ticket descriptions, note contents, requester emails, attachment contents, bearer tokens, OAuth tokens, Cloudflare Access assertions, or SuperOps API tokens.
- When adding a new tool, add safe audit metadata if it is useful, but keep metadata bounded and content-free.

## Testing Expectations

- Add or update tests with behavior changes. Existing coverage is under `src/*.test.ts` and `src/domains/*.test.ts`.
- Worker tests drive the exported Worker `fetch` handler directly and use local memory shims.
- Client tests mock `fetch` and cover execution accounting, HTTP/GraphQL rate-limit handling, and write retry restraint.
- Ticket tests mock `getClient()` and cover triage snapshots, apply-plan validation, partial writes, budget stops, and operation-ledger persistence.
- Operation-store tests cover memory store behavior, compact result projection, and Durable Object fetch handlers.
- Use deterministic or capped retry delays in tests; do not make tests sleep for real upstream retry windows.
- Do not run live SuperOps mutations from automated tests.

## Deployment And Provisioning Caution

- Documentation/code agents should not deploy unless explicitly asked.
- Do not create production Cloudflare resources automatically.
- `wrangler.json` contains the Worker configuration and non-secret vars; secrets must be managed outside Git.
- The Durable Object binding is declared, but account-level provisioning/deployment still requires normal Cloudflare authorization.
- Before any staging/production deployment, run at least `npm test`, `npm run build`, and `git diff --check`.
- Use safe smoke tools first after deployment: `superops_status`, `superops_test_connection`, and read-only list tools.
- Treat `superops_custom_mutation` as highest risk because it accepts arbitrary GraphQL mutation text.

## Git And Workspace Notes

- Recent major commits include execution budgets/durable operation status, created-time historical reporting, approved triage plan execution, New Calls triage snapshot, alert tools, and safe ticket retrieval.
- Always check `git status --short` before editing. The user may have local changes; do not revert unrelated work.
- This repository may contain generated `dist/` and `.wrangler/` output locally. Prefer source edits in `src/`, docs in `docs/`, and root documentation when requested.
- For documentation-only tasks, do not modify production code, tests, auth, config, dependencies, lockfiles, or generated artifacts unless explicitly instructed.