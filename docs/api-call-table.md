# Private SuperOps API attempt table

Every network attempt dispatched through the deployed `SuperOpsClient` emits
allowlisted start and finish events. `superops-api-call-log` is a private Tail
Worker that combines them into one immutable D1 row per call ID. Each retry has
its own ID and row. No synchronous database write or additional SuperOps request
is added to triage. The Tail Worker runs after the producing invocation ends.

Database: `superops-api-call-log` (`b12bebb1-fe47-4a9b-b09a-1226feaa8304`).
Table: `superops_api_calls`. Views: `superops_api_call_timeline` and
`superops_api_calls_per_minute`. Access through the authenticated Cloudflare D1
console or Wrangler; there is no public HTTP endpoint and no new API key.

Times are UTC with milliseconds as observed by the Worker. `started_at` is the
dispatch time; `completed_at` includes response parsing. Transport timeouts and
network failures have no HTTP status. GraphQL failures may have HTTP 200; use
`outcome`/`ok` to determine API success. A start with no finish is `incomplete`,
never success. Rows are deduplicated by call ID on repeated tail delivery.

Ticket number is recorded only when verified from an explicit display-number
lookup or `getTicket` metadata. Calls with a canonical ticket ID can be joined
to a known number in the tenant-scoped timeline view. Queue/metadata calls can
legitimately have no single ticket number. `execution_trace_id`, `invocation_id`
and `request_id` link to MCP diagnostics; a trigger batch ID is not invented.

The triage response's bounded `mcpExecution.requestTrace` now carries the same
safe mixed timeline for callback correlation: each entry identifies `provider`
(`superops` or `internal`), start/finish timestamps, endpoint host, operation
purpose/name, status, HTTP/GraphQL outcome, retry/rate-limit flags, and duration.
The D1 table remains authoritative for the complete SuperOps-attempt history;
internal Durable Object/service-binding/workflow entries are deliberately
labelled separately and must not be counted as SuperOps API calls.

Every call from this deployed MCP is instrumented, including non-Agent callers
and continuations. Calls from other software using the same SuperOps tenant are
outside this collector. No sampling is configured. Platform log truncation,
platform termination before a start event is delivered, or a collector/D1 outage
can create gaps: this is diagnostic logging, not an exactly-once transaction
with SuperOps. D1 writes retry at most three times and log a content-free error
on persistence failure. Original private Worker events remain a fallback.

Only metadata is retained: no credentials, headers, GraphQL documents/variables,
response bodies, customer text, notes, or raw errors. Hourly cleanup removes
records older than 30 days in batches of 10,000, with a 250,000-row backstop
(enforced gradually by the hourly job). These limits affect this new table only.

## Queries

Per UTC minute (reads and mutations, including failed attempts):

```sql
SELECT * FROM superops_api_calls_per_minute
WHERE minute_utc >= strftime('%Y-%m-%dT%H:%M:00Z','now','-1 hour')
ORDER BY minute_utc DESC;
```

An arbitrary rolling 60-second interval, rather than calendar-minute buckets:

```sql
SELECT COUNT(*) AS total_attempts, SUM(ok=0) AS failed, SUM(rate_limited) AS throttled
FROM superops_api_calls
WHERE started_at >= '2026-09-18T10:00:30.000Z'
  AND started_at < '2026-09-18T10:01:30.000Z';
```

One ticket's calls in exact order:

```sql
SELECT started_at, completed_at, duration_ms, tool_name, operation_name,
       attempt, http_status, outcome, retry_after_seconds, invocation_id
FROM superops_api_call_timeline
WHERE tenant='computaskltd' AND resolved_ticket_number='62521'
ORDER BY started_at, invocation_id, call_index;
```

## Deployment and rollback

Generate the collector's separate types with
`wrangler types diagnostics/worker-env.d.ts --config wrangler.api-call-log.jsonc`,
then check them with `tsc -p diagnostics/tsconfig.json`. The generated runtime
declarations are deliberately outside the main MCP compiler scope.

Publish the collector through the repository's Git-connected deployment
pipeline using `wrangler.api-call-log.jsonc`; apply its D1 migrations before
enabling the producer's `tail_consumers` binding. Do not use `wrangler deploy`
for the collector or the main MCP Worker. Wrangler remains available for type
generation, validation, tails, and separately authorised resource operations.
The collector has no SuperOps credentials or HTTP endpoint. Keep the existing
producer runtime vars and routes when publishing. After publishing the MCP
source, refresh the isolated trigger project's result-callback schema and
published Agent instructions so they accept and copy the expanded safe request
trace. Until that refresh is published, the private D1 table still captures the
exact SuperOps attempts, but callback history may retain only the older
aggregate telemetry.

To stop capture immediately set collector `AUDIT_ENABLED=false`, or detach the
producer's `tail_consumers`. The existing producer flag
`SUPEROPS_EXECUTION_CALL_AUDIT_ENABLED=false` also disables all per-call events.
Leave the D1 table in place for inspection. Rollback does not require deleting
the database or changing ticket state.

Architecture follows Cloudflare's Tail Worker guidance:
https://developers.cloudflare.com/workers/observability/logs/tail-workers/

## Verified rollout: 18 September 2026

- Operator: `sam@computask.co.uk`; existing account and production tenant verified.
- Before editing, local MCP dry-run bundle matched the live Worker exactly:
  `45bdbfedd0ea48d2d3772eda9c5e142e422c7d8c5e86bd445074b84bb2375fcf`.
- Rollback MCP version: `d435f6fc-1b2f-45e5-954c-d9b4ae0c874f`.
- Deployed MCP version: `4fecd98f-69d9-443b-9472-b067d1a8678c`.
- Collector version: `3ce97bd0-da0c-4236-aa99-d7d51f27b70c`.
- Both downloaded live bundles matched their reviewed local dry-run SHA256:
  MCP `5d27ef1c0e8aadaaeedc62b6d1509fc6e79ee682d1ff880e2ca19b4f8eb4827b`,
  collector `017609d06c5106812cb1fe740a5366dc5c507aeb301803c42c0ea6751d0ecddd`.
- Existing production variables matched before deploy; live-only targeted-triage
  flag remained `true` using `--keep-vars`. Tail binding and D1 binding verified.
- Validation: 585 MCP tests passed (13 new); 3 real SQLite tests passed; main
  build, separate collector typecheck, scoped lint, whitespace checks and both
  deployment dry-runs passed.
- At 20:07:22.413Z, a read-only connection smoke check produced one persisted
  `getClientList` attempt (523ms, success). At 20:07:24.685Z through
  20:07:25.623Z, an existing Agent invocation produced three successful calls for
  ticket **62510**: `getTicket` (393ms), `getTicketConversationList` (430ms),
  `getTicketNoteList` (115ms). The timeline resolved all three to the ticket number.
- Per-minute SQL returned exactly four attempts in the partially observed
  20:07 UTC minute at verification, all successful. No earlier calls were backfilled.
- Failed/throttled/timeout/malformed and write-no-retry paths were verified using
  mocks. No failure was deliberately induced in live SuperOps, and no test email
  or ticket mutation was needed. Capturing evidence reads is not a claim that the
  ticket's triage has completed or that the upstream rate-limit issue is fixed.
