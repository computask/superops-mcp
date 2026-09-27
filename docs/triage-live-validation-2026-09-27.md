# Controlled live triage validation - 27 September 2026

All timestamps below are UTC. Tests used synthetic internal emails sent by the
authorized Outlook identity to the existing support mailbox. No credentials or
real customer content are retained in this report.

## First five tickets (queue-isolation release b93d102)

| Ticket | Ticket created | Agent dispatched | Private note created | Creation to note | Final independently observed state |
| --- | --- | --- | --- | --- | --- |
| 63001 | 07:49:29.000 | 07:49:52.381 | 07:51:20.179 | 1m 51.179s | New Calls; one private note; classified |
| 63002 | 07:50:23.949 | 07:51:50.413 | 07:53:53.439 | 3m 29.490s | New Calls; one private note; classified, but old test-specific General Admin defect observed |
| 63003 | 07:55:17.469 | 07:55:31.240 | 07:57:45.817 | 2m 28.348s | New Calls; one private note; Network |
| 63004 | 07:55:19.417 | 07:55:31.240 | 07:57:30.041 | 2m 10.624s | New Calls; one private note; Software |
| 63005 | 07:55:21.445 | 07:55:31.240 | 07:57:15.423 | 1m 53.978s | New Calls; one private note; Hardware |

Notification receipt: A at 07:49:36.352; B at 07:50:17.474. Burst notifications
were received at 07:55:11.293, 07:55:13.488, and 07:55:15.212. Public history does
not identify which burst message maps to each ticket; do not invent that mapping.

Callbacks: batch 2502 at 07:51:50.397; batch 2503 at 07:54:27.965; batch 2504 at
07:58:05.690. These are later than the actual note timestamps and must not be
presented as the moment the note was created. The last verified apply reads
completed at 07:51:24.805, 07:53:58.358, and 07:57:50.356 respectively.

Batch 2503 included 63001 in its overlapping lookback and reported a verified
existing-note skip. Independent readback found one note, not a duplicate.
Batch 2504 handed two unfinished items to durable continuation. All three later
had verified final notes/classifications; the handoff callback alone was not
counted as proof. The operation-status read by this interactive identity could
not see the Agent-owned operation; no ownership bypass was attempted.

For 07:49:20-08:00:00, the private MCP call table recorded 64 Agent-path dispatcher
submissions: 3 query, 18 evidence, 5 metadata-only safe reads, 2 field-options and
36 apply/continuation submissions. Zero recorded failed or rate-limited
submissions. Separate test verification added 15 safe-by-number and 1 recent-list
submissions; these are excluded from the Agent total. Dispatcher submissions
are NOT exact physical upstream SuperOps attempt counts or receipt-poll counts.

The raw first-ticket note check confirmed strong tags and double br separators.
All five independently read notes were private. Actionable tickets stayed in New
Calls, and no customer reply or device action was requested by the test harness.

## Repairs and publication

Two verified instruction defects are documented in
[the correction record](agent-live-test-corrections-2026-09-27.md).
Commit a226e7324d1c61e153e6da1d3481a95b319f7a71 was pushed normally to main at
https://github.com/computask/superops-mcp. Cloudflare Git build
723a1556-5276-4ca0-b511-f215d5e526b4 showed success for that commit. Active trigger
version a8d1bde8-36be-4b64-915d-226d7412d002 received 100% of traffic at
08:00:31.195Z. Agent Builder was separately published and visibly showed
Updated just now with no pending changes. No manual Worker deployment occurred.

## Automated regression coverage

- Root suite: 666 passed, including the real-adapter 250-item mixed-fault and
  checkpoint-crash harness; typecheck, lint, build and diff checks passed.
- Trigger: 61 tests plus workerd verifier and syntax build passed.
- New deterministic stress test: 100 terminal-failure scenarios, each followed
  by five fresh notifications plus duplicate redelivery, produced exactly one
  eligible later dispatch while preserving the original denied/ambiguous scope.
- Existing tests cover rate-limit delays, active-run exclusion, failed and
  completed run drainage, unavailable triggers, legacy attention sentinels,
  overlapping-window tails, sustained arrivals and rollback.

Production provider failures were not artificially injected. Mocked fault tests
demonstrate the code paths, not an uptime guarantee. The single-active-Agent
policy still queues arrivals during an actual active run; the 63002 timing proves
that a universal two-minute SLA is not yet established.

## Post-correction retest

Two further emails were sent at 08:01:19, becoming 63006 (affirmative no-action
notice) and 63007 (technical printer issue). Batch 2505 dispatched at 08:01:43.207.
Its evidence was followed directly by the options lookup; no redundant get_safe
was observed before plan construction. Final outcomes are recorded below after
independent verification, not inferred from acceptance.

| Ticket | Created | Note created | Final status | Observed effect timing |
| --- | --- | --- | --- | --- |
| 63007 | 08:01:32.890 | 08:03:54.255 | New Calls, Support request / Hardware | 2m 21.365s to private note |
| 63006 | 08:01:30.887 | 08:04:07.776 | Resolved, General Admin, No Fault Found / Exception | 2m 36.889s to private note; resolved updatedTime 08:04:21.586, 2m 50.699s after creation |

Independent safe reads found exactly one internal note on each. A raw note check
for 63007 confirmed strong tags and double br separators. Last MCP verification
for the mixed operation completed at 08:04:26.137, or 2m 55.250s after 63006 was
created. The callback at 08:04:43.912 reported a durable handoff rather than final
per-ticket completion; readback supplied the missing final-effect evidence.

Post-correction Agent-path submissions totalled 31: 1 query, 6 evidence,
1 field-options and 23 apply/continuation submissions. There were zero
metadata-only get_safe calls, saving two dispatcher submissions and two Agent
tool roundtrips relative to the prior instruction. Zero recorded submissions
failed or reported throttling. A notes-list and recent-list verification call
are excluded. This mixed resolve/leave test is not a like-for-like total-call or
latency comparison with the earlier leave-only tests.

At 08:05:47.294, trigger health showed pending=false, queuedPending=false,
queuedBlockedByAttention=false, lastResultStatus=complete. Historical
needsAttentionCount remained 89. The old incidents were neither deleted nor
blindly replayed, and they did not prevent the seven new test tickets processing.

Outcome: seven of seven controlled tickets received a single private triage note
and their expected status effect. The observed test-specific classification bug
was corrected and the printer retest used Hardware. This is bounded live evidence,
not proof that every possible future failure is solved or every ticket finishes
within two minutes. No automated long-running monitor was created by this test.
