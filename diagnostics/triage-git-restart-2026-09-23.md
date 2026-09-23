# Git-managed triage restart and five-email test

All times UTC. This report contains only deployment identifiers, synthetic test
references and content-free diagnostics. It is a local evidence artifact.

## Deployment evidence

- Repository: https://github.com/computask/superops-mcp.git, branch main.
- Trigger baseline commit: ad4f422ce948c39f5477d41f7f768e88cc0174c8.
- Post-connection commit: 50a88d42d4cd1427340417c8a0a5ec72b15262b0.
- Both Cloudflare Git checks succeeded for 50a88d4.
- MCP build: 48ef3570-f2e3-4c32-bcc8-ba8a1344851c.
- MCP live version: 86985612-2499-464f-9de7-52793a86b54c, 100%, 20:05:39.961Z.
- Trigger build: 82e0f136-c6b7-44da-807f-ddf78a658814.
- Trigger live version: 1127b692-9d40-4a06-add2-5dd2784c83f3, 100%, 20:05:14.154Z.
- Trigger module matches the preserved live baseline SHA-256:
  c902b1914961653c3567e0695a5f0c3badffa916c753055e93f8f170db4a8f4b.
- Existing Durable Object namespace bf8c485de0c541e2a896a53d226c841a retained.
- Six existing secret bindings retained; no values exposed or committed.
- Git enable flag true; Graph subscription renewed at 20:06:20.287, expiring
  20:51:18.160Z. One-minute maintenance cron retained; preview builds disabled.
- No manual deployment. Cloudflare's Git build executes Wrangler as CI publisher.
- Local root tests: 639 passed; typecheck, lint, build and diff check passed.
- Trigger baseline/runtime checks passed with no external calls.

## Five controlled emails

Sent from verified sam@computask.co.uk to supportdesk@computask.co.uk, saved to
Sent Items. Exactly five send calls succeeded. All scenarios are synthetic.

| Test suffix | Send accepted | Ticket | Ticket created |
|---|---|---|---|
| 01 | 20:07:08.385 | 62854 | 20:07:25.000 |
| 02 | 20:07:08.756 | 62850 | 20:07:20.935 |
| 03 | 20:07:09.315 | 62852 | 20:07:23.411 |
| 04 | 20:07:09.687 | 62851 | 20:07:23.061 |
| 05 | 20:07:10.228 | 62853 | 20:07:24.507 |

Subject prefix: Controlled triage test GIT-TRIAGE-20260923-.
Independent bounded MCP query at 20:07:40 confirmed all five EMAIL tickets in
New Calls, through superops-api-dispatcher.taskgroup.co.uk. One getTicketList
request plus one dispatcher status poll; no retries. No manual triage performed.

## Trigger observations

- Startup batch 2318 discovered recent-mail metadata through the existing Graph
  sweep; Agent dispatch started 20:06:38.739, HTTP acceptance returned 20:06:43.081.
- It reported complete with zero candidates at 20:07:25.816; the existing empty-
  result recovery scheduled another bounded attempt for 20:08:25.816.
- Five test notifications were queued into batch 2319 at 20:07:16.333,
  20:07:17.475, 20:07:17.634, 20:07:19.220 and 20:07:19.340 while 2318 was active.
  Individual notification-to-ticket mapping is not exposed by this metadata.
- Old September 15 attention state remains preserved; it is not an active run.

## Failed end-to-end result and diagnosed defect

Batch 2318 attempt 2 dispatched at 20:08:25.817; acceptance returned at
20:08:29.557. At 20:11:33.127 the Agent callback reported terminal_failure,
failureStage=triage_apply, errorCode=apply_not_attempted: five considered,
zero completed, five deferred. Each of 62850–62854 was explicitly not_attempted.
The recorded last read succeeded; this callback did not report a rate limit.

The Agent conversation explains that canonical client identity was unavailable:
https://chatgpt.com/c/6ab431bb-5c88-83ed-9a80-3bbee03e87bd
An independent getTicket read for 62850 returned client:null, while get_safe
omitted client entirely. buildSafeTicketResult converted null to undefined and
JSON serialisation removed it. The fix preserves explicit client:null, adds the
verified clientId for assigned clients, and leaves unknown/omitted data unknown.
It adds no upstream request and changes no mutation or fallback policy.
Three regressions cover unassigned, assigned and unavailable identities through
single and batch evidence paths; 642 tests passed.

A separate trigger recovery defect remains: after recording the actual callback
(event 260326) and scheduling recovery (260327), its watchdog observed completed
and emitted result_callback_missing/orphan_recovered at 20:12:33.185 (260336).
That diagnostic conflicts with the persisted callback. No queue reset, blind
replay, manual triage or additional test emails were performed.

The Git migration/restart passed. The five-ticket automatic triage test failed;
it must not be represented as five successful triages or meeting the latency goal.
