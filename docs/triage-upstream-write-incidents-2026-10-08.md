# Upstream write incidents, 8 October 2026

This content-free record separates SuperOps failures from local continuation
defects. No customer text, note bodies, credentials or request variables are
included. Times are UTC. No failed mutation was resubmitted during this review.

All four stored attempt bodies returned HTTP 200 with an internal execution
error and `data.updateTicket:null`. They contain no field path or provider error
code explaining the cause. This is evidence of an upstream error, not proof of
its internal root cause or permission to replay a possibly applied write.

| Ticket | Original operation | Dispatcher receipt / attempt | Attempt time | Latest authoritative observation |
|---|---|---|---|---|
| 63806 | `triage-3467-98445561-9634-4e7e-86a1-9c71fae7cffc` | `73b24392-c7ab-49df-a749-30198945aa3d` / 42460 | 08:17:58 | New Calls; original created/updated time 08:12:40; four requested classification fields do not match. |
| 63826 | `triage-3492-bee3af98-7c30-4942-8329-8a21fe807ba4` | `fa2ce5dd-69a8-4dcb-9a06-dfbf37584370` / 42818 | 09:59:06 | New Calls; original created/updated time 09:53:45; four classification fields do not match; requested client already matches. |
| 63862 | `triage-3539-024a4de0-8195-4a30-b967-07e3fabe2049` | `89e116ac-fff0-425f-b696-288481183aea` / 43559 | 13:57:29 | New Calls; original created/updated time 13:55:50.905; four classification fields do not match; requested client already matches. |
| 63877 | `triage-3554-ad87f581-7e8b-4842-b440-1f360771b8bf` | `a970c464-1620-40fc-a2a0-2ce666849a27` / 44055 | 16:36:30.338-16:36:30.570 | Classification and exactly one private triage note verified; New Calls; updated 16:36:20.891; closing effect unobserved. |

For the first three tickets, private-note reads returned unavailable with zero
observed notes. That is not a complete proof that no note exists. The original
uncertain receipts remain quarantined and are not replaced by a new request.

For 63877, the first post-release watchdog resumed the original pending approved
operation. Two earlier physical writes were accepted: classification and note.
Cloudflare Workflow instance `wf-c6723d1a` then recorded an invalid local
`StatusWriteStarted -> WriteAmbiguous` transition at 16:36:31.111 and
16:40:56.869, with seven intervening no-progress wakes while the lease remained
claimed. The operation terminalized at 16:40:56.909 as CompletedWithFailures,
retaining partial-write and ambiguity evidence. The follow-up release preserves
the exact classification/status mutation checkpoint and releases the lease on
execution stops so read-only reconciliation can continue normally.

The local transition fix does not resolve SuperOps' internal error. Next evidence
needed from SuperOps is the server-side exception correlated to these four
request times/ticket identifiers, or a documented invalid input/permission rule
that explains the same stored failures. Until then, do not substitute another
mutation, repeat a private note, weaken freshness checks or infer success from an
HTTP 200 envelope. Reconciliation must begin with current immutable-ID reads and
retain the original receipt identity. Any separately approved corrective action
requires a fresh complete plan with current staff-change fences.
