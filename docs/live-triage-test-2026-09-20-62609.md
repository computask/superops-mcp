# Live clean-queue triage test: ticket #62609

Snapshot captured on 20 September 2026. This report contains only safe
diagnostic metadata: ticket display number, event IDs, operation names, HTTP
status, timings, retry counts, and bounded outcome enums. It contains no
email body, note text, credentials, bearer tokens, request bodies, GraphQL,
or external Agent run IDs.

## Test setup

- Trigger Worker: `support-triage-trigger.sam-c6d.workers.dev`
- Trigger deployment after reset: `b1dd7a61-dd24-4cf9-b8b0-dd727e0df7d6`
- Clean reset event: `256746` at `2026-09-20T08:29:31.319Z`
- Reset result: pending window cleared, six recovery jobs cleared, alarm
  deleted, diagnostic archive preserved, external run status `completed`
- Test notification accepted: `2026-09-20T08:30:32.957Z`, batch `2245`
- Fixed email scope: `2026-09-20T08:29:32.957Z` inclusive to
  `2026-09-20T08:30:48.957Z` exclusive
- Candidate: `#62609`

## Ordered Worker timeline

| UTC time | Event | Batch / attempt | Result |
|---|---|---:|---|
| 08:30:32.957 | `notification_accepted` | 2245 / 1 | 1 notification accepted |
| 08:30:48.957 | `dispatch_started` | 2245 / 1 | Agent dispatch started; 16,000 ms bounded wait |
| 08:30:48.957 | `agent_accepted` | 2245 / 1 | Accepted by Workspace Agents |
| 08:31:18.958 | `agent_run_status_checked` | 2245 / 1 | `in_progress`; status poll 1, 617 ms |
| 08:31:48.958 | `agent_run_status_checked` | 2245 / 1 | `in_progress`; status poll 2, 579 ms |
| 08:32:18.958 | `agent_run_status_checked` | 2245 / 1 | `in_progress`; status poll 3, 551 ms |
| 08:32:38.841 | `result_callback_received` | 2245 / 1 | `terminal_failure`, stage `triage_apply`; 1 considered, 0 completed, 1 deferred; Agent accepted-to-callback 109,884 ms |
| 08:32:38.841 | `batch_failed` | 2245 / 1 | Failure class `ambiguous` |
| 08:32:38.841 | `retry_scheduled` | 2245 / 1 | Recovery dispatch immediately eligible |
| 08:32:39.794 | `dispatch_started` | 2246 / 1 | Recovery of exactly `#62609` |
| 08:32:39.794 | `agent_accepted` | 2246 / 1 | Accepted by Workspace Agents |
| 08:33:09.794 | `agent_run_status_checked` | 2246 / 1 | `in_progress`; status poll 1, 647 ms |
| 08:33:28.253 | `result_callback_received` | 2246 / 1 | `terminal_failure`, stage `evidence_recovery`; 1 considered, 0 completed, 1 deferred; Agent accepted-to-callback 48,459 ms |
| 08:33:28.253 | `retry_scheduled` | 2246 / 1 | Next retry 08:34:28.253, wait 60,000 ms |
| 08:34:28.253 | `agent_run_status_checked` | 2246 / 1 | Prior recovery run `completed` |
| 08:34:28.253 | `dispatch_started` | 2246 / 2 | Recovery retry |
| 08:34:28.253 | `agent_accepted` | 2246 / 2 | Accepted by Workspace Agents |
| 08:34:58.253 | `agent_run_status_checked` | 2246 / 2 | `in_progress`; status poll 1, 483 ms |
| 08:35:15.117 | `result_callback_received` | 2246 / 2 | `terminal_failure`, stage `evidence_recovery`; 1 considered, 0 completed, 1 deferred; Agent accepted-to-callback 46,864 ms |
| 08:35:15.117 | `retry_scheduled` | 2246 / 2 | Next retry 08:37:15.117, wait 120,000 ms |
| 08:37:15.133 | `dispatch_started` | 2246 / 3 | Recovery retry |
| 08:37:15.133 | `agent_accepted` | 2246 / 3 | Accepted by Workspace Agents |
| 08:37:45.146 | `agent_run_status_checked` | 2246 / 3 | `in_progress`; status poll 1 |
| 08:38:15.165 | `agent_run_status_checked` | 2246 / 3 | `in_progress`; status poll 2 |
| 08:38:24.641 | `result_callback_received` | 2246 / 3 | `retryable_rate_limit`, stage `evidence_recovery`; 1 considered, 0 completed, 1 deferred; Agent accepted-to-callback 69,508 ms |
| 08:38:24.641 | `retry_scheduled` | 2246 / 3 | Next retry 08:46:24.641, wait 480,000 ms |
| 08:39:41.289 | `admin_queue_reset` | — | Remaining recovery job cleared after the complete failure path was captured |

The two `retry_scheduled` records repeat the same callback trace for audit
correlation; they are not additional SuperOps calls.

## Every captured SuperOps API call

The callback traces identify these as SuperOps MCP query requests. The first
six returned HTTP 200 with `retryCount=0`. The seventh request was also HTTP
200 at the transport layer, but its GraphQL result was rate-limited; the MCP
retried it twice, producing requests eight and nine. There was no mutation
call and no `superops_tickets_apply_triage_plan` call in the captured test.

| # | Callback / MCP tool | Trace index | Request type | Operation | HTTP | OK | Duration |
|---:|---|---:|---|---|---:|---|---:|
| 1 | 2245 / `superops_tickets_get_safe` | 1 | `verificationRead` | `getTicket` | 200 | true | 72 ms |
| 2 | 2246 / `superops_tickets_triage_evidence_recover` | 1 | `verificationRead` | `getTicket` | 200 | true | 391 ms |
| 3 | 2246 / `superops_tickets_triage_evidence_recover` | 2 | `verificationRead` | `getTicketConversationList` | 200 | true | 392 ms |
| 4 | 2246 / `superops_tickets_triage_evidence_recover` | 3 | `duplicateNoteCheck` | `getTicketNoteList` | 200 | true | 309 ms |
| 5 | 2246 / `superops_tickets_get_safe` | 1 | `verificationRead` | `getTicket` | 200 | true | 354 ms |
| 6 | 2246 / `superops_tickets_get_safe` | 2 | `duplicateNoteCheck` | `getTicketNoteList` | 200 | true | 359 ms |
| 7 | 2246 / `superops_tickets_get_safe` | 1 | `verificationRead` | `getTicket` | 200 | false | 1,195 ms |
| 8 | 2246 / `superops_tickets_get_safe` | 2 | `retry` | `getTicket` | 200 | false | 271 ms |
| 9 | 2246 / `superops_tickets_get_safe` | 3 | `retry` | `getTicket` | 200 | false | 927 ms |

MCP execution totals from the callbacks:

- First callback: 1 SuperOps request, 72 ms, 0 retries.
- Recovery callback: 3 SuperOps requests, 783 ms, 0 retries.
- Recovery retry callback: 2 SuperOps requests, 713 ms, 0 retries.
- Third recovery callback: 3 SuperOps requests, 2 MCP retries, 2,702 ms;
  GraphQL rate-limit diagnostics on request 3.
- Captured total: **9 SuperOps API requests**, **2 MCP retries**, **1
  rate-limited operation**. The rate-limited operation used three HTTP
  requests because the first request and both retries returned HTTP 200 with a
  GraphQL `rate_limit_exceeded` result.
- Internal Worker status/maintenance events are not included in that total.

The rate-limit callback's safe retry trace was:

```text
getTicket retry 1: Retry-After supplied=false; parsed/capped/actual backoff=102 ms
getTicket retry 2: Retry-After supplied=false; parsed/capped/actual backoff=207 ms
failureDiagnostics: stage=mcp_tool, errorCode=rate_limit_exceeded,
  httpStatus=200, requestIndex=3, operationName=getTicket
```

The transport status is 200 because SuperOps returned the throttle as a
GraphQL error result; `ok=false` and the safe diagnostic are the authoritative
failure indicators.

## Where this test fell over

1. The email was accepted and dispatched in 16 seconds.
2. The first Agent run took 109.884 seconds to callback.
3. The Agent returned `terminal_failure` at `triage_apply`, but its only
   captured MCP call was a successful `getTicket` verification read. It did
   not call `superops_tickets_apply_triage_plan` and did not provide the
   required failure diagnostics. The Worker therefore preserved the ticket
   rather than treating the callback as a successful triage.
4. The bounded recovery then read the ticket, conversation list, and note list
   successfully, but the Agent still reported the candidate as unavailable.
5. The second recovery read the ticket and note list successfully, but again
   reported it unavailable. It scheduled the next bounded retry rather than
   writing a note.
6. On the third recovery, the first `getTicket` read hit a SuperOps GraphQL
   rate limit. The MCP honoured bounded local backoff of 102 ms and 207 ms,
   but no `Retry-After` value was supplied. All three transport responses were
   HTTP 200; the MCP correctly classified the GraphQL result as
   `rate_limit_exceeded` and the Agent reported `retryable_rate_limit`.
7. The remaining retry was cleared at 08:39:41 after this evidence was
   captured. The test did not add a triage note or change the ticket.

The first failure was not a rate limit: its read succeeded but the Agent did
not apply triage or provide the required diagnostics. Later recovery encountered
a genuine GraphQL rate limit inside HTTP 200 responses, as shown above. No
write was attempted in this captured test.

## Telemetry gap found

The MCP trace included operation, purpose, HTTP status, duration, retry count,
success, and (on the rate-limited callback) the retry trace and safe failure
diagnostic. The Agent did not copy the newer optional `provider`,
`endpointHost`, `outcome`, `errorClass`, `graphqlCode`, or
`responseHadData` fields into these callback payloads. They are therefore
marked as unavailable for this run rather than guessed. The live MCP history
endpoint remains the authoritative bounded archive:

<https://support-triage-trigger.sam-c6d.workers.dev/history?limit=100>

The remaining retry was cleared only after the third callback and its complete
request/retry trace had been captured. The trigger is now idle with no pending
or queued work (`enabled=true`, `phase=null`, `acceptedRun=false`,
`recoveryJobs=0`, history sequence `256874`).
