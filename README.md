# SuperOps.ai MCP Server

MCP server for Claude that provides tools to interact with the SuperOps.ai PSA/RMM platform using their GraphQL API.

## One-Click Deployment

[![Deploy to DO](https://www.deploytodo.com/do-btn-blue.svg)](https://cloud.digitalocean.com/apps/new?repo=https://github.com/wyre-technology/superops-mcp/tree/main)

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/wyre-technology/superops-mcp)

> **Operator note — GitHub Packages authentication.** This package is published
> to the `@wyre-technology` scope on **GitHub Packages**, which requires an
> authentication token on every install (GitHub Packages has no anonymous reads,
> even for public packages). Create a GitHub **Personal Access Token** with the
> `read:packages` scope and supply it to the cloud builder:
>
> - **Cloudflare Workers** — set a build variable named `NODE_AUTH_TOKEN` to your PAT.
> - **DigitalOcean App Platform** — set a **build-time** secret named `GITHUB_TOKEN` to your PAT.
>
> For local installs, run `export NODE_AUTH_TOKEN=$(gh auth token)` before `npm install`.

## Features

- **Decision Tree Architecture**: Navigate to domains (clients, tickets, assets, technicians) to see relevant tools
- **Lazy Loading**: Domain modules load on-demand for faster startup
- **Full CRUD Operations**: List, get, create, and update entities
- **GraphQL Support**: Use custom queries for advanced operations

## Installation

```bash
# The @wyre-technology scope lives on GitHub Packages and needs a token to install:
export NODE_AUTH_TOKEN=$(gh auth token)
npm install @wyre-technology/superops-mcp
```

## Configuration

Set the following environment variables:

```bash
export SUPEROPS_SUBDOMAIN="yourcompany"
export SUPEROPS_REGION="us"  # or "eu" for EU region
```

Configure the SuperOps API token as a secret in your runtime or Worker platform.
Never commit token values or put them in examples, logs, headers, or responses.

### Getting Your API Token

1. Log in to SuperOps.ai
2. Click settings icon > "My Profile"
3. Navigate to "API token" tab
4. Click "Generate token"
5. Copy and securely store the token

## Usage with Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "superops": {
      "command": "npx",
      "args": ["@wyre-technology/superops-mcp"],
      "env": {
        "SUPEROPS_SUBDOMAIN": "yourcompany",
        "SUPEROPS_REGION": "us"
      }
    }
  }
}
```

Provide the SuperOps API token through your MCP client's secure secret/env
mechanism rather than committing it to this file.

## Cloudflare Worker Deployment Notes

- Worker name: `superops-mcp`
- MCP endpoint: `https://<your-mcp-host>/mcp`
- Health endpoint: `https://<your-mcp-host>/health`
- Required non-secret vars: `AUTH_MODE=env`, `SUPEROPS_SUBDOMAIN=computaskltd`, `SUPEROPS_REGION=us`, `LOG_LEVEL=warn`
- Non-secret safety defaults: `MCP_ENABLED=true`, `ENABLE_WRITE_TOOLS=false`, `ENABLE_CUSTOM_MUTATION=false`, `CHATGPT_DIRECT_ALLOW_MUTATING_TOOLS=false`, `CHATGPT_DIRECT_ALLOW_SCRIPT_EXECUTION=false`
- Execution controls additionally include per-request timeout, CPU guard, continuation/retry/delay/scheduling ceilings, retention, and maximum operation lifetime. The exact committed values are in `wrangler.json` and are described in the continuation runbook.
- Required secrets: the SuperOps API token Worker secret, plus any OAuth/session secrets required by the deployed auth provider. SUPEROPS_PRIVATE_NOTE_ENCRYPTION_KEY is also required when durable approved private-note recovery is enabled; store it as a Cloudflare secret and keep it distinct from SUPEROPS_INTERNAL_CONTINUATION_TOKEN.
- Never commit: API token values, OAuth access/refresh tokens, bearer tokens, Cloudflare service token values, client secrets, private keys, or full request headers
- Durable operation status uses `SUPEROPS_OPERATION_LEDGER`. Long rate-limit waits use the `SUPEROPS_CONTINUATION_WORKFLOW` binding; immediate delivery and Workflow wake delivery use the internal service binding/token. Both continuation flags default false. Durable Object alarms are cleanup-only: they enforce maximum operation lifetime and retention without performing SuperOps mutations. Do not reuse `OAUTH_KV` for operation state.

Safe local validation:

```bash
npm test
npm run build
```

Safe deployed smoke tools:

- `superops_status`
- `superops_test_connection`
- `superops_clients_list`
- `superops_tickets_list`
- `superops_alerts_list`
- `superops_assets_list`
- `superops_scripts_list`
- `superops_technicians_list`

Unreviewed synchronous write tools and custom mutation are blocked by default. The reviewed durable `superops_tickets_apply_triage_plan` remains available, as do read and operation-status tools. Direct ticket writes, alert writes, and `superops_custom_mutation` require an explicit reviewed override and retain only their conservative synchronous ambiguity contract. Saved script execution is separate and remains hidden/blocked unless `CHATGPT_DIRECT_ALLOW_SCRIPT_EXECUTION=true`.

`superops_custom_mutation` is the highest-risk tool because it accepts custom
GraphQL mutation text. Audit logs record only safe metadata for custom GraphQL:
operation type, operation name when parseable, and variable key names. Full
GraphQL bodies and variable values are not logged by default.

See [docs/execution-audit.md](docs/execution-audit.md) for the outbound-call inventory, risk assessment, root-cause analysis, and execution-limit migration plan.

See [docs/continuation-operations.md](docs/continuation-operations.md) for the continuation checkpoint model, feature-flag defaults, external validation, staging rollout, production enablement, and rollback safeguards.

Audit logs are structured JSON records emitted for MCP tool calls. They include
timestamp, request/correlation ID, tool name, user identity when available from
the auth layer, tool category, high-risk marker, success/failure, duration, and
a sanitised error summary on failure.

Emergency disable process:

- Set `MCP_ENABLED=false` to stop MCP tool execution.
- `ENABLE_WRITE_TOOLS=false` blocks unreviewed synchronous ticket and alert writes; the reviewed durable apply-triage path remains available. Use `MCP_ENABLED=false` for an all-tool emergency stop.
- Set `ENABLE_CUSTOM_MUTATION=false` to block custom GraphQL mutations.
- Keep `CHATGPT_DIRECT_ALLOW_SCRIPT_EXECUTION=false` unless single-asset saved-script execution has been explicitly reviewed for exposure.
- Re-run the deployment pipeline after changing Worker vars, then verify `/health` and `superops_status`.

Token rotation plan:

1. Generate a replacement SuperOps API token in SuperOps.
2. Update the existing Cloudflare Worker secret value.
3. Redeploy or restart using the normal deployment process.
4. Run safe smoke tests.
5. Revoke the old SuperOps token.
6. Review audit logs for unexpected failed calls after rotation.

## Available Domains & Tools

### Navigation

- `superops_navigate` - Navigate to a domain
- `superops_back` - Return to main menu
- `superops_test_connection` - Test API connectivity
- `superops_operations_get` - Read durable status and compact results for one operation ID
- `superops_operations_results` - List recent durable operation results visible to the caller

Operation status is fail-closed and owner-scoped. Direct OAuth uses the authenticated OAuth user. Gateway mode derives a stable caller/tenant owner hash from the normalized SuperOps tenant and a fingerprint of the presented API credential; raw API/bearer tokens are never persisted or returned. Recent results come from a bounded owner-local Durable Object index and expose fixed-field redacted summaries only.

### Clients Domain

- `superops_clients_list` - List clients with filters
- `superops_clients_get` - Get client details
- `superops_clients_search` - Search clients by name/domain

### Tickets Domain

- `superops_tickets_list` - List tickets with filters
- `superops_tickets_recent` - List the most recently created tickets, optionally with conversations and notes
- `superops_tickets_query` - Read-only createdTime historical ticket query with automatic sequential pagination and completeness diagnostics
- `superops_tickets_created_between` - Convenience wrapper for tickets created in a half-open createdTime range
- `superops_tickets_report` - Read-only compact historical workload reports grouped by time, client, source, status, category, priority, request type, technician, or tech group
- `superops_tickets_get` - Get ticket details
- `superops_tickets_get_by_number` - Get ticket details by visible SuperOps ticket number/display ID
- `superops_tickets_get_safe_by_number` - Safely get ticket metadata and sanitized plain-text context by visible SuperOps ticket number/display ID
- `superops_tickets_triage_snapshot` - Read-only queue triage snapshot that freezes the initial candidate list and returns safe compact evidence for ChatGPT assessment
- `superops_tickets_conversation_list` - Read customer ticket conversations/replies, including attachment metadata where returned by SuperOps
- `superops_tickets_notes_list` - Read public/internal ticket notes, including attachment metadata where returned by SuperOps
- `superops_tickets_field_options` - Discover live SuperOps ticket option values for priority, impact, urgency, resolution code, cause, and subcategory
- `superops_tickets_create` - Create a new ticket
- `superops_tickets_resolve_full` - Resolve or fully classify a ticket by ticket number or internal ID, with client lookup, technician group lookup, validated display-name classification fields, optional note creation, and optional final verification
- `superops_tickets_apply_triage_plan` - Write/high-risk tool that applies an approved fixed-candidate triage plan with metadata validation, dry-run, note dedupe, controlled fallback, and verification
- `superops_tickets_update` - Update ticket status, assignment, impact, urgency, category, cause, subcategory, resolution code, or an explicit manual priority override. Tenant category values use the configured enum; other option values are resolved and validated from SuperOps ticket field metadata before mutation.
- `superops_tickets_add_note` - Add note to ticket
- `superops_tickets_log_time` - Log time on ticket

`superops_tickets_list` supports configured status display names such as
`New Calls`. Status filters are sent to SuperOps as a ticket-list condition so
queue listing is not limited to the first unfiltered page. `max` controls the
requested page size up to 500, with `page` selecting the page number. If extra
client, priority, or assignee filters are applied locally after the SuperOps
query, `totalCount` and `hasMore` are omitted rather than reporting unrelated
unfiltered counts.

Ticket urgency and impact are writable. Priority can still be supplied manually
and will be validated against live SuperOps options. Prefer impact plus urgency
where SuperOps can calculate priority, but resolved-ticket workflows may require
the full classification set: priority, impact, category, subcategory, cause, and
resolutionCode. `superops_tickets_resolve_full` validates those fields before
adding notes or mutating the ticket, and can reuse existing ticket values only
when they are present and valid against live SuperOps options.

`No Action Needed` is a subcategory, not a resolutionCode. Use a valid
resolutionCode returned by SuperOps, such as `Permanent Fix` when available.

If a response reports `partialFailure`, a note was already created but the later
ticket update failed unexpectedly. Do not retry with the same note unless you
intentionally want a duplicate note.

Use `superops_tickets_get_by_number` for normal ticket lookup when raw ticket
content is acceptable, or when you explicitly need the unmodified SuperOps
conversation/note payloads. If `includeContent=true` is blocked by OpenAI safety
checks, or if you only need safe plain-text triage context, use
`superops_tickets_get_safe_by_number` instead.

Safe retrieval returns ticket metadata, requester/sender fields, sanitized
visible text from the existing conversation and note content paths, timestamps,
author names, public/internal flags, convenience latest-message fields, content
availability diagnostics, and attachment metadata only. It does not query
unsupported ticket description fields. It strips HTML, removes raw email headers
and MIME-like payloads, removes base64/data/cid embedded content, redacts
credentials, tokens, private keys, long hashes, passwords, passcodes and secrets,
and truncates long content. Attachment bodies are never returned by the safe
tool; `attachments` currently supports only `metadataOnly` and `none`.

`superops_tickets_triage_snapshot` is the preferred read-only starting point for
New Calls triage. It lists the requested status/page once using the normal ticket
list path, freezes the returned ticket numbers and internal IDs, and then reads
safe compact evidence for each candidate. Phase 1 snapshots are stateless and are
not persisted, even if `storeBatch` is supplied. The tool never writes, resolves,
updates, notes, classifies, calls field options, or uses `superops_tickets_recent`.
It returns every original candidate, including tickets where content is empty,
blocked, unavailable, or metadata-only. Original ticket body content may come
from SuperOps conversation items with type `DESCRIPTION`; the tool does not query
`Ticket.description`, because that field is not available in the live schema.
Prefer this tool over manually listing New Calls and then issuing many individual
safe reads.


### Historical ticket reporting

Use `superops_tickets_query`, `superops_tickets_created_between`, and
`superops_tickets_report` for historical ticket workload analysis. These tools
are read-only and createdTime-based in the first version. They do not use guessed
SuperOps date comparison operators: live probing confirmed `after`/`before` were
not reliable for ticket arrays and `greater_than` caused an internal server
error. Instead, the MCP requests confirmed `getTicketList` pages sorted by
`createdTime DESC`, with an effective page size of 100, then applies the
half-open range locally:

- `createdFrom` is inclusive.
- `createdTo` is exclusive.
- pages are fetched sequentially, never concurrently.
- records newer than `createdTo` are ignored.
- records in `createdFrom <= createdTime < createdTo` are included.
- paging stops after crossing the `createdFrom` lower boundary.
- tickets are deduplicated by `ticketId`.
- `pagination.complete` is false whenever `maxPages`, `maxRecords`, retry
  exhaustion, or a repeated-page loop prevents crossing the lower boundary.

Confirmed server-side reporting filters are intentionally narrow. `status` is
sent to SuperOps using the existing proven `is`/`in` condition logic. Filters for
priority, client, technician, source, request type, category, subcategory, and
tech group are applied locally after the createdTime range has been collected.
Responses include `filterExecution` so callers can see which filters were
`server` versus `local`.

Unsupported first-version inputs are rejected clearly: `updatedFrom`,
`updatedTo`, `resolvedFrom`, `resolvedTo`, `timeField` values other than
`createdTime`, closure-rate reports, arbitrary GraphQL conditions, arbitrary
operators, and raw GraphQL field selection. Resolution-time reporting remains a
planned capability requiring further safe API investigation.

Technician reporting means the current ticket technician at query time:
`currentAssigneeAtQueryTime`. It does not prove who originally received the
ticket because assignment-history support has not been confirmed.

Examples:

Tickets created today:

```json
{
  "createdFrom": "2026-07-16T00:00:00+01:00",
  "createdTo": "2026-07-17T00:00:00+01:00",
  "sortOrder": "ASC"
}
```

Today versus yesterday: call `superops_tickets_report` once for each local day
and compare the returned hourly `series` arrays.

```json
{
  "createdFrom": "2026-07-16T00:00:00+01:00",
  "createdTo": "2026-07-17T00:00:00+01:00",
  "timezone": "Europe/London",
  "interval": "hour"
}
```

Monday through Thursday up to the same local time: call the report tool with the
same local-time cutoff for each window, using `timezone: "Europe/London"`.

Hourly arrivals:

```json
{
  "createdFrom": "2026-07-16T00:00:00+01:00",
  "createdTo": "2026-07-17T00:00:00+01:00",
  "timezone": "Europe/London",
  "interval": "hour",
  "includeZeroBuckets": true
}
```

Client breakdown:

```json
{
  "createdFrom": "2026-07-01T00:00:00+01:00",
  "createdTo": "2026-07-08T00:00:00+01:00",
  "timezone": "Europe/London",
  "interval": "day",
  "groupBy": ["client"]
}
```

Source breakdown:

```json
{
  "createdFrom": "2026-07-01T00:00:00+01:00",
  "createdTo": "2026-07-08T00:00:00+01:00",
  "timezone": "Europe/London",
  "interval": "day",
  "groupBy": ["source"]
}
```

Rolling seven-day trends: request daily buckets over the full period and let the
caller calculate rolling averages only when `pagination.complete` is true.

```json
{
  "createdFrom": "2026-04-17T00:00:00+01:00",
  "createdTo": "2026-07-16T00:00:00+01:00",
  "timezone": "Europe/London",
  "interval": "day",
  "includeZeroBuckets": true
}
```

Busiest hour over 90 days:

```json
{
  "createdFrom": "2026-04-17T00:00:00+01:00",
  "createdTo": "2026-07-16T00:00:00+01:00",
  "timezone": "Europe/London",
  "interval": "hour"
}
```
### Recommended New Calls Triage Workflow

For New Calls triage, start with `superops_tickets_triage_snapshot` and treat
its `candidateTicketNumbers` list as fixed. ChatGPT should assess only the safe
compact evidence returned by that snapshot when proposing a triage plan. Do not
write changes while assessing the snapshot.

Recommended flow:

1. Call `superops_tickets_triage_snapshot` for `status: ["New Calls"]`.
2. Follow `pagination.nextPage` until `hasMore` is false; the tool uses a stable execution-safe page size so no listed candidate is knowingly starved of safe reads.
3. Aggregate the page candidate lists into one fixed assessment set and analyse only the returned safe evidence.
4. Present a pre-write proposed action table for user approval.
5. After approval, submit the fixed candidates and approved actions to durable `superops_tickets_apply_triage_plan`.
6. Inspect the authoritative operation result until every fixed candidate is terminal, then report every outcome.

The pre-write approval table should include every proposed write or intentional
non-write. Suggested columns: ticket number, subject, client, evidence summary,
proposed action, fields or note to apply, and reason. Do not perform writes until
the user approves the table.

The final outcome table must include every ticket from the snapshot, even when no
change was made. Each ticket must have one final outcome from: `Resolved`,
`Moved`, `Updated`, `Left in New Calls`, `Skipped`, `Blocked`, `Failed`, or
`Not Found`. Do not omit tickets because they were skipped, blocked, failed, not
found, or left unchanged.

If a separately reviewed synchronous write is used, report failures explicitly with
the ticket number, requested action, failure stage, and whether any partial write
occurred. If a ticket changed or disappeared after the snapshot, keep it in the
final table and mark it as `Blocked`, `Failed`, or `Not Found` as appropriate.

Suggested Custom GPT instruction:

```text
For New Calls triage, use `superops_tickets_triage_snapshot` first and follow every execution-safe page until `pagination.hasMore` is false. Treat the aggregated candidate lists as fixed. Do not write changes until a proposed action table has been presented and approved. Every ticket from the snapshot pages must appear in the final report with a complete classification target and final outcome. Only `Resolved` and `Awaiting Engineer` may be proposed as status changes; a `leave` action retains status while applying classification.
```

### Approved Triage Plan Execution

`superops_tickets_apply_triage_plan` is a write/high-risk Phase 3 tool for
applying a user-approved plan to a fixed snapshot candidate set. Use it only
after the Phase 2 pre-write table has been approved. The tool requires
`expectedCandidateTicketNumbers` unless a safe stored batch mechanism is added in
the future, and it returns a result for every expected ticket even when no action
is supplied.

Before writing each ticket, the tool re-reads metadata and validates the display
number, internal ticket ID, subject, client, status, and `updatedTime` where the
action supplied expected values. If `updatedTime` changed, the ticket is skipped
as `SkippedChangedSinceSnapshot` unless `allowWriteIfUpdatedTimeChanged=true` is
set. Mutating actions require `contentVerified=true` unless
`allowWriteWithoutVerifiedContent=true` is supplied.

Supported actions are `resolve`, `update`, `addNote`, `leave`, and `skip`.
Every `resolve`, `update`, and `leave` proposal publishes a complete target for
impact, urgency, category, subcategory, cause, and resolution code. `leave` is a
classification-only write that retains the current status. Status changes are
closed to `Resolved` for resolve actions and `Awaiting Engineer` for update
actions; other target statuses are rejected before any SuperOps read or write.
`dryRun=true` performs validation and returns intended outcomes without writing.
When `dedupeNotes=true`, existing notes are checked before adding a note, and a
matching note is not duplicated. Resolve actions use the controlled resolve path;
if SuperOps returns an internal server error and fallback is explicitly allowed,
the tool re-reads metadata. It attempts one update fallback only when the intended
resolution is absent and `updatedTime` is unchanged. A visible resolution, changed
`updatedTime`, ambiguous read, or validation failure blocks fallback.

Update and resolve actions are always re-read before success is reported. Every writable requested target field must match the final state; otherwise the outcome is `Failed` with `failureStage: "verifyFinalState"` and `partialWrite: true`. Priority is derived from impact and urgency, so `superops_tickets_apply_triage_plan` does not publish priority as a writable target, does not send it in `UpdateTicketInput`, and ignores legacy `target.priority` for writes and independent verification while reporting it as a derived/read-only field. Private notes are added only after writable-field verification succeeds. Note dedupe trims text, collapses whitespace, and compares case-insensitively.

For direct human-client tickets that remain in New Calls, use an operational note: classify it, state that it remains for manual engineer reply, and direct the engineer to review the original request, confirm it, and reply before progressing. Rate limits are reported with `failureStage: "rateLimit"`;
the tool does not perform ad hoc repeated retries.

Every expected ticket gets exactly one final outcome: `Resolved`, `Updated`,
`Left`, `Skipped`, `Blocked`, `Failed`, `NoApprovedAction`, `NotFound`,
`SkippedChangedSinceSnapshot`, or `NotAttemptedExecutionStopped`. If the configured
execution budget stops the batch, the response includes `operation.complete=false`,
`continuationRequired=true`, every completed/skipped/failed/unattempted ticket result,
and a durable `operationId` when the operation ledger is available. This is an
observable incomplete state, not background success. A SuperOps triage continuation
adapter is implemented for pending apply-plan items and uses the same validation,
stale-data, note-deduplication, mutation and verification helpers as the synchronous
path. Automatic fresh-invocation scheduling is disabled by default and requires both continuation flags, the internal service binding/token, and the Workflow binding for long waits. Long Retry-After values use a durable Workflow sleep with compact identity only; Durable Object alarms are retention cleanup only. The resumed adapter must reclaim the item, re-read it, and revalidate identity/`updatedTime`. Update, resolution, and note lifecycles persist `WriteStarted`, `ResolutionWriteStarted`, or `NoteWriteStarted` before mutation and persist `FieldsUpdated`, `ResolutionWriteSucceeded`/`ResolutionVerified`, or `NoteAdded` immediately after reliable success. A created note ID is retained in the public operation record. Approved private-note body content needed for durable recovery is persisted only as encrypted AES-GCM recovery content keyed by SUPEROPS_PRIVATE_NOTE_ENCRYPTION_KEY; plaintext note bodies are excluded from operation status, compact results, diagnostics, logs, audit data, and errors. Ambiguity is verified rather than blindly retried. Use `superops_operations_get` to inspect the authoritative compact result. The audit record is high-risk write metadata only: batch ID,
candidate count, ticket numbers, action types, dry-run/verify flags, and fallback
allowance. It does not audit raw ticket content or full note bodies.
Example safe retrieval call:

```json
{
  "ticketNumber": "55841",
  "includeDescription": true,
  "includeNotes": true,
  "includeConversations": true,
  "latestFirst": true,
  "maxItems": 20,
  "maxCharsPerItem": 4000,
  "maxTotalChars": 20000,
  "attachments": "metadataOnly"
}
```

### Assets Domain

- `superops_assets_list` - List assets/endpoints
- `superops_assets_get` - Get asset details
- `superops_assets_software` - Get software inventory
- `superops_assets_patches` - Get patch status

### Alerts Domain

- `superops_alerts_list` - List alerts with safe status filtering, pagination, sorting, and optional severity or asset filtering
- `superops_alerts_get` - Retrieve one alert by exact alert ID
- `superops_alerts_for_asset` - List alerts for a specific asset
- `superops_alerts_resolve` - Write action: resolve one or more alerts, with `dryRun` and optional verification
- `superops_alerts_create` - Write action: create a new alert for an asset, with `dryRun` and optional verification
- `superops_alerts_summary` - Summarise alerts by severity, client, policy, and policy type

Alert status filtering uses the SuperOps-safe condition form:

```json
{
  "attribute": "status",
  "operator": "is",
  "value": "Open"
}
```

Avoid raw custom GraphQL for standard alert work. The alert tools use the
dedicated SuperOps alert schema and deliberately avoid known-bad status
operators such as `EQUALS`, `IN`, and `IS_EMPTY`.

Example: list active alerts:

```json
{
  "activeOnly": true,
  "page": 1,
  "pageSize": 25,
  "sortBy": "createdTime",
  "sortOrder": "DESC"
}
```

Example: get an alert by ID:

```json
{
  "alertId": "ALERT_ID_HERE"
}
```

Example: list alerts for an asset:

```json
{
  "assetId": "ASSET_ID_HERE",
  "activeOnly": true,
  "page": 1,
  "pageSize": 25
}
```

Example: resolve alert dry run:

```json
{
  "alertIds": ["ALERT_ID_HERE"],
  "dryRun": true,
  "verify": false
}
```

Example: resolve alert for real:

```json
{
  "alertIds": ["ALERT_ID_HERE"],
  "dryRun": false,
  "verify": true
}
```

Example: create alert dry run:

```json
{
  "assetId": "ASSET_ID_HERE",
  "message": "Test alert message",
  "description": "Optional description",
  "severity": "High",
  "dryRun": true,
  "verify": false
}
```

Example: create alert for real:

```json
{
  "assetId": "ASSET_ID_HERE",
  "message": "Test alert message",
  "description": "Optional description",
  "severity": "High",
  "dryRun": false,
  "verify": true
}
```

Example: summarise active alerts:

```json
{
  "status": "Open",
  "pageSize": 100
}
```

### Technicians Domain

- `superops_technicians_list` - List technicians
- `superops_technicians_get` - Get technician details
- `superops_technicians_groups` - List technician groups

### Custom Domain

- `superops_custom_query` - Run custom GraphQL query
- `superops_custom_mutation` - Run custom GraphQL mutation

## Example Usage

```
User: What tools are available?
Claude: Use superops_navigate to select a domain...

User: Navigate to tickets
Claude: [calls superops_navigate with domain: "tickets"]
Now in tickets domain. Available tools: superops_tickets_list, superops_tickets_get...

User: Show open high priority tickets
Claude: [calls superops_tickets_list with status: ["Open"], priority: ["High"]]
Here are the open high priority tickets...

User: Show tickets currently in New Calls
Claude: [calls superops_tickets_triage_snapshot with {
  "status": ["New Calls"],
  "max": 50,
  "page": 1,
  "safeRead": true,
  "includeNotes": true,
  "includeConversations": true,
  "includeAttachments": "metadataOnly",
  "maxContentCharsPerTicket": 3000,
  "maxItemsPerTicket": 8,
  "latestFirst": true
}]
Here is the fixed safe New Calls snapshot for triage...

Note: superops_tickets_recent is only a recent-ticket view. Do not use it as a
complete queue listing or triage source of truth for statuses such as New Calls.

User: Resolve spam ticket 57100
Claude: [calls superops_tickets_resolve_full with {
  "ticketNumber": "57100",
  "clientName": "Task Group",
  "status": "Resolved",
  "priority": "Very Low",
  "impact": "Low",
  "urgency": "Low",
  "category": "7. Sales call",
  "subcategory": "No Action Needed",
  "cause": "No Fault Found",
  "resolutionCode": "Permanent Fix",
  "techGroupName": "Level 1 Support",
  "note": "Resolving as unsolicited marketing/sales email rather than a genuine support request.",
  "suppressCloseNotification": true,
  "verify": true
}]
The ticket has been classified and resolved.

User: Manually override ticket 57101 priority
Claude: [calls superops_tickets_update with {
  "ticketId": "ticket-57101",
  "priority": "High"
}]
The priority override has been validated and applied.
```

## Rate Limits

SuperOps.ai API has a published rate limit of 800 requests per minute per API token.
The MCP distinguishes SuperOps upstream throttling from Cloudflare invocation-budget
exhaustion. Read calls retry only with bounded attempts and capped Retry-After or
exponential backoff delays. Write calls are not blindly retried by the central client;
a write path must prove idempotency or verify current state before adding safe retries.

## License

Apache-2.0

## Support

For issues and feature requests, please visit the [GitHub repository](https://github.com/wyre-technology/superops-mcp/issues).

### Deterministic continuation acceptance harness

Run `npm run test:continuation-harness` to execute only `src/continuation-mixed-fault-harness.test.ts`. The fixed seed is `0x5eed250`; it processes exactly 250 mocked tickets through the real apply-triage continuation adapter. Its required assertions are 250 expected and accounted items, zero duplicate successful updates/resolutions/private notes, zero invocations over each invocation's configured effective request budget, terminal/unaccounted/update/resolution/note-only/skip/retry/wait counters, and a durable wait longer than one request lifetime. It is a no-network test and is required evidence before enabling durable continuation outside staging.
