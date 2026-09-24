# Live email triage verification — 24 September 2026

All timestamps below are UTC. Controlled emails were explicitly authorized.
Only ticket numbers, timing and safe outcome metadata are retained here.

## Git-only rollout

Repository: computask/superops-mcp, branch main. Both superops-mcp and
support-triage-trigger use the repository's Cloudflare Git builds. No manual
Worker deployment was performed. Existing Durable Object identity/state and
secret bindings were retained; no queue/history reset or permission expansion.

- ae3e410: terminal-run recovery honors an already recorded safe callback.
- 9e7feac: late coalesced email notifications retain bounded ingestion grace.
- 46c2dd8: reporter accepts bounded dispatcher telemetry, including polls.
- c5f4d0f: safety/access denials are fenced rather than automatically replayed;
  disjoint new email windows can still run. Existing risk gates remain enabled.

At c5f4d0f, local/main and origin/main matched. Git checks passed for both
Workers. Actual 100% deployments were independently verified:

- MCP version 67736d84-d3ba-463e-86fe-84fe11f98bef.
- Trigger version b8289bf9-7f67-4439-bf4d-42911359b980.
- Trigger SHA-256 9a01ed54365302326c5300c2ccc5b6215d0c153a0c6359cf63187de0c99d2b1d.
- Trigger enabled; existing coordinator namespace unchanged.

Validation: 642 MCP tests, 24 production-module trigger regressions, local
workerd boundary verification, typecheck, lint, build and diff whitespace checks
passed. Tests do not make live SuperOps writes.

## Five-ticket positive proof (batch 2322)

Email send window: 06:30:01.772–06:30:03.308.
Graph notification window: 06:30:13.419–06:30:20.119.
Dispatch started: 06:30:36.119; acceptance response completed: 06:30:40.371.
Durable operation created: 06:34:01.934; terminal Completed: 06:35:08.661.

| Ticket | Ticket created | Verified private note created | Arrival to note |
|---|---|---|---|
| 62861 | 06:30:18.911 | 06:35:03.957 | 285.046 s |
| 62862 | 06:30:19.390 | 06:34:49.682 | 270.292 s |
| 62863 | 06:30:20.924 | 06:34:36.699 | 255.775 s |
| 62864 | 06:30:23.893 | 06:34:23.674 | 239.781 s |
| 62865 | 06:30:25.897 | 06:34:10.637 | 224.740 s |

Independent fresh safe reads found exactly one private TRIAGE SUMMARY note on
each ticket, with status New Calls. The durable ledger confirmed all five
Verified, zero failed/pending/partial/ambiguous items, two continuations and ten
physical writes (five field updates, five notes). The callback preceded final
durable completion and alone was not treated as proof of all five writes.

The apply's 45 MCP subrequests include internal/ledger coordination; they are
NOT 45 SuperOps calls. No total upstream-call count is inferred here.
Safe retrieval returned plain text; raw HTML formatting was not independently
confirmed by these reads. The Agent instructions require strong/br markup and
the MCP's note validation remains enforced.

## Failures are not silently counted as success

- Batch 2321: 62856–62859 failed before apply because the proposed evidence
  classification conflicted with successful meaningful content. 62860 arrived
  outside the earlier frozen window. These were not manually replayed or
  silently marked triaged. The evidence provenance clarification and debounce
  fix address the observed causes, but do not prove those earlier tickets done.
- Ticket 62866: created 06:40:49.413. First dispatch 06:41:00.190. At
  06:43:52.533 the callback recorded risk_gate/unacceptable_risk at triage_apply;
  Agent conversation stated inconsistent history assessment. The old trigger
  incorrectly scheduled a retry because read-only telemetry was present. Attempt
  two returned DispatcherPending; attempt three later completed. Fresh read
  confirmed one private TRIAGE SUMMARY at 06:50:02.379 and New Calls. This
  eventual completion is NOT a clean first-attempt pass. c5f4d0f explicitly
  prevents replay of such a denial; no safety gate was disabled to obtain it.
- Historical attention scopes remain retained. These tests do not prove that
  the old failed backlog has been reconciled or that all future tickets succeed.

## ChatGPT publication

Published the evidence-provenance clarification before the successful five-ticket
batch. Published the existing exact base-note labels after c5f4d0f. No connector
write permissions or risk approval settings changed. Triage Result Reporter v2
was refreshed and its dispatcher telemetry fields verified. Local SO MCP v6's
admin catalogue was refreshed and its probe actions checked; that is not a claim
that its separate personal OAuth reconnection was completed.

## Final-version fresh test

A distinct controlled test email FINAL-GIT-20260924-01 was sent at 06:56:12.381.
It created 62867 at 06:56:35.573; Graph notification was 06:56:27.583 and dispatch
started 06:56:43.703 (16.120 seconds after notification). This run FAILED: the
ChatGPT conversation displayed Something went wrong. At 07:00:13.986 the run API
returned failed/run_failed, without a more specific cause. No callback arrived.
The coordinator recorded result_callback_missing and held the exact scope for
reconciliation. A fresh safe read found unchanged updatedTime, New Calls and no
notes. operations_get returned not found or not visible, which alone is not
proof no operation exists. No browser Retry, reset or manual replay was used.

A separate NEXT-ARRIVAL-20260924-01 test checks whether that held failure permits
subsequent unrelated email processing. Sent 07:02:08.075; notification
07:02:18.268; ticket 62868 created 07:02:24.099; dispatch 07:02:34.288. The
held 62867 scope did not block this dispatch. However this independent Agent
run also returned failed/run_failed at 07:03:04.288 without a result callback.
Its ticket remained New Calls with its original updatedTime when queried.
Further test emails were stopped rather than creating more unhandled work.

## Logging deployment gap

The private D1 collector's last persisted call was 23 September 13:46:36.391.
Read-only deployment inspection showed it still used the 18 September version
3ce97bd0-da0c-4236-aa99-d7d51f27b70c, with no Git connection. The current
committed parser already permits dispatcher traffic, but was not live in that
separate Worker. Connected it to this repository/main using the existing MCP
build token, explicit wrangler.api-call-log.jsonc CI command and no previews.
No permission expansion, migration or retention change. Four real-SQLite tests
and its separate TypeScript check pass. Live synchronization and a fresh
persisted read-only submission must be verified after this commit is pushed.

The first Git collector build failed safely before deployment because its
ignored generated Worker type definitions were present locally but absent in
CI. The committed build:api-call-log script now generates those definitions
before typechecking, then runs the four SQLite tests. No runtime code or
permissions changed for this build correction.

Workspace billing was inspected read-only after both failed Agent runs: it
showed 1,215 credits / GBP 48.59 available. An exhausted balance is therefore
not established as the cause; the Agent API supplied only run_failed.

Post-push verification for d7e9050: all three Git builds succeeded and all three
actual deployments were at 100%: MCP 0624063c-9e35-429f-a939-81c79fae2855,
trigger 485bad49-2fb9-468a-9995-b2cd21967704 and collector
dc5c94d8-8d65-43f7-98f1-9e277db7e3c0. A fresh read-only ticket 62868 check
persisted two dispatcher submissions in D1 at 07:12:43.327 and 07:12:44.485,
getTicket and getTicketNoteList, both HTTP 200/success with Worker outcome ok.
Three receipt polls in that invocation were not counted as SuperOps calls.
Logging is restored going forward; the gap has not been backfilled.

## Logged final diagnostic: 62869 — passed

One distinct controlled email LOGGED-20260924-01 was sent after logging was
restored, at 07:14:23.160. This was not a replay of a held failed scope.
Ticket createdTime: 07:14:23.000. Notification: 07:14:30.565. Dispatch:
07:14:46.565. One Agent dispatch, with the exact frozen window retained.
Private note created: 07:17:58.314 (215.314 seconds after ticket creation).
Durable operation terminal Completed: 07:18:03.656. Callback: 07:18:38.413.
Fresh independent safe read and operation-status read verified one private
TRIAGE SUMMARY, classification updated, New Calls retained, no failures,
pending items, partial writes or ambiguity. The ledger confirms exactly two
physical writes: updateTicket and createTicketNote. No manual triage was used.
The callback's coarse no_action reason must not be read as ticket resolution:
the authoritative operation explicitly records requestedAction leave and Left.

The private collector captured these 13 successful MCP-to-dispatcher submissions
for this run (all HTTP 200, no rate_limited outcome). Receipt polling is not
additional upstream SuperOps traffic. Dispatcher-owned retry totals require its
own attempt ledger; this table alone is not proof of 13 physical upstream calls.

| Start UTC | Operation | End UTC |
|---|---|---|
| 07:15:31.360 | getTicketList | 07:15:33.613 |
| 07:15:45.704 | getTicket | 07:15:47.739 |
| 07:15:47.739 | getTicketConversationList | 07:15:50.367 |
| 07:15:47.739 | getTicketNoteList | 07:15:49.146 |
| 07:17:01.857 | getTicket | 07:17:05.785 |
| 07:17:21.821 | getFields | 07:17:23.255 |
| 07:17:49.324 | getTicket | 07:17:51.393 |
| 07:17:51.625 | getTicketNoteList | 07:17:53.029 |
| 07:17:53.607 | updateTicket | 07:17:55.436 |
| 07:17:55.632 | getTicket | 07:17:57.076 |
| 07:17:58.049 | createTicketNote | 07:17:59.868 |
| 07:18:00.071 | getTicketNoteList | 07:18:01.500 |
| 07:18:01.500 | getTicket | 07:18:02.902 |

The first MCP request began 44.795 seconds after dispatch. The final apply took
16.936 seconds; most elapsed time was outside that final apply. That gap cannot
be attributed exclusively to model reasoning because history/tool transport
also occurs there. No specific cause was exposed for the earlier Agent crashes.
62867 and 62868 remain held/untriaged; earlier failed test/backlog scopes remain
unreconciled. No blanket claim that every ticket is now triaged is warranted.

Relevant Agent conversations for troubleshooting:
- 62867: https://chatgpt.com/c/6ab4c9ae-a5fc-83ed-9af9-77da76e58ebd
- 62868: https://chatgpt.com/c/6ab4cb0c-4370-83eb-8e47-88c495d53588

The five-ticket proof exceeded the desired two-minute latency. Reliability and
latency must be reported separately; no 100-percent future guarantee is made.
