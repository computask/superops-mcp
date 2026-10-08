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

Fresh immutable-ID reads at 22:17 UTC returned complete note-metadata arrays:
zero notes on the first three tickets and one private note on 63877. The earlier
safe-content `notes.available:false` flag described an empty collection, rather
than a failed collector. It must not be used as a completeness flag. The first
three tickets still had their original updated times; 63877 still remained New
Calls. These observations do not establish whether an upstream error can have
transient or other side effects. The original uncertain receipts remain
quarantined and are not replaced by a new request.

For 63877, the first post-release watchdog resumed the original pending approved
operation. Two earlier physical writes were accepted: classification and note.
Cloudflare Workflow instance `wf-c6723d1a` then recorded an invalid local
`StatusWriteStarted -> WriteAmbiguous` transition at 16:36:31.111 and
16:40:56.869, with seven intervening no-progress wakes while the lease remained
claimed. The operation terminalized at 16:40:56.909 as CompletedWithFailures,
retaining partial-write and ambiguity evidence. The follow-up release preserves
the exact classification/status mutation checkpoint and releases the lease on
execution stops so read-only reconciliation can continue normally.

## Stored-payload comparison and controlled investigation

The exact retained payloads were retrieved from the dispatcher database. The
07:00-19:00 UTC sample contains 23 MCP `updateTicket` attempts: 19 successes and
these four failures. All four failures used the same query selection and returned
the same fully received 102-byte error body. Durations were 209, 520, 214 and
232 ms respectively. No provider request ID was available in the selected stored
headers. The generic error supplies no specific throttling or validation code.

Identical input combinations, apart from the ticket ID, succeeded for other
tickets. The successful closing attempt for 63881 occurred 5.826 seconds after
63877 failed. Live field metadata confirmed all six mandatory closure fields
were already present on 63877. The stored failures do not demonstrate a universal
invalid input, missing closure field, timeout or response-size defect.

Manual, supervised testing used internal synthetic ticket 63884, without sending
an email or replaying an original failed write. All three failed classification
combinations succeeded. Both normal and minimal ticket-ID response selections
succeeded, including status-only closure. The complete stored experiment
sequence contains 34 requests: 22 reads and 12 mutations, excluding ticket
creation; all completed successfully with one upstream attempt. The ticket was
left Resolved with exactly one private synthetic note. Its source was FORM and
it had no requester; the original incidents used EMAIL. Synthetic success cannot
exclude a ticket-specific rule or transient provider defect.

The experiment exposed a separate local reporting gap: after accepted one-off
writes, a pending verification read could lose its original receipt from the
error response and undercount write attempts. The targeted correction in
`src/domains/tickets.ts` reports exact attempt/accepted counts and retains bounded
pending or terminal read metadata. Verification remains unproven, and the
enclosing mutation remains non-retryable. Four regressions cover pending ticket
and note verification, terminal read expiry, and an uncertain mutation that must
not be misclassified as a pending read. This correction adds no write replay or
automatic recovery action and does not resolve the upstream internal error.

Local validation passed: 800 Vitest tests, three policy text checks, the triage
contract check, `npm run build` and `git diff --check`. The private controlled
experiment was manually supervised; automated tests use synthetic mocks only.
Publication uses the existing Git-connected pipeline. Final active-version,
module and binding evidence is retained privately after publication.

A private support packet contains the exact queries, variables, error bodies,
UTC attempt windows, receipt identifiers and successful comparisons. It is
prepared but has not been sent. Ask SuperOps for the correlated server exception,
any ticket-specific rule and authoritative side-effect evidence. The
[official error contract](https://support.superops.com/en/articles/6632228-handling-errors)
does not identify the cause from this generic response; the
[API schema](https://developer.superops.com/msp) supplies the field contract.

The local transition fix does not resolve SuperOps' internal error. Next evidence
needed from SuperOps is the server-side exception correlated to these four
request times/ticket identifiers, or a documented invalid input/permission rule
that explains the same stored failures. Until then, do not substitute another
mutation, repeat a private note, weaken freshness checks or infer success from an
HTTP 200 envelope. Reconciliation must begin with current immutable-ID reads and
retain the original receipt identity. Any separately approved corrective action
requires a fresh complete plan with current staff-change fences.
