# Triage tool-boundary timing

The private D1 `triage_tool_timing` table joins both existing Workers by the
validated `trigger_id` and dispatch `attempt`. Each tool call has a fresh
`call_id`; each stage is idempotent by `(call_id, stage)`. Repeated reports get
separate call IDs, so retries cannot overwrite the original observation.

- `received`: valid intent report handler entry, or correlated SuperOps MCP
  tool-handler entry. This is after routing/authentication, not TCP arrival.
- `execution_finished`: SuperOps MCP result construction before the awaited
  private diagnostic capture. It does not imply all durable items completed.
- `response_ready`: immediately before returning from the handler, after
  capture/report persistence settles (including recorded capture failures).
  It is NOT proof of network delivery or Agent receipt.

Order these markers to separate:

1. Field-options response-ready to intent received: unobserved Agent/platform
   interval before the report reaches us. Not a measurement of pure reasoning.
2. Intent received to response-ready: measured reporting/persistence interval.
3. Intent response-ready to apply received: unobserved Agent/platform interval
   including transport and any tool review, not proof of a particular cause.
4. Apply received to execution-finished and response-ready: initial MCP work
   and diagnostic capture respectively. Durable continuation may finish later.

Use every individual call in chronological order. Do not subtract a first
report from an unrelated later apply, match on ticket number alone, collapse
retries, or fabricate a missing boundary. `outcome` describes the tool/report,
not final ticket success. Independent readback still proves ticket effects.

```sql
SELECT observed_at, producer, tool_name, stage, call_id, invocation_id,
       ticket_numbers_json, outcome, worker_outcome
FROM triage_tool_timing
WHERE trigger_id = ? AND attempt = ?
ORDER BY observed_at, event_id
LIMIT 200;
```

The projection allowlists only timing, correlation IDs, numeric ticket numbers
(at most 50, with a truncation flag), bounded outcomes and known tool names.
Ticket numbers are available on apply/intent when supplied; earlier calls join
by trigger and attempt. No raw plan, result, notes, headers or customer content
is copied. The distinct seven-day private capture stores are unchanged.

The existing authenticated Cloudflare D1 access is required. There is no new
public route, secret, tool, Agent instruction or connector-catalogue change.
Tail persistence happens after the producer invocation, with bounded retries;
hard termination/log truncation/collector failure can leave missing markers.
Missing markers mean unknown, never zero delay or proof of no invocation.
No synchronous database writes or additional SuperOps requests are introduced.

Retention uses the collector's existing 30-day configuration and bounded hourly
cleanup, plus a 250,000-row high-water target (not an instantaneous hard cap).
Rows are separate from API-attempt counts. Apply additive migration 0003 before
the Git-connected collector/producer releases. Deploy all three via Git and
verify their versions independently. Roll back code through Git; leave the
additive table in place and do not clear existing diagnostic/operation data.
