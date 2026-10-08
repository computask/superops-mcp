# Triage recovery release, 8 October 2026

The release retains the earlier fixes and addresses the confirmed integration gaps
without overwriting tickets that staff changed, replaying uncertain writes or
bypassing normal action review. Staff may work on a ticket before triage finishes;
same-ID edits are expected protected skips. The recurring monitor remains paused.

## Eleven-issue implementation and evidence

| # | Issue | Solution and location | Evidence and closure boundary |
|---|---|---|---|
| 1 | Budget continuations do not progress or never wake | Existing stage-resume fix plus atomic immediate Workflow scheduling and reserved cleanup budget in `operation-store.ts`; bounded watchdog for older unscheduled approved operations | Live 63877 resumed the original approved operation after a status read armed its watchdog, verified one private note and attempted closure. An upstream error and the additional issue-4 transition defect stopped closure. The production-budget harness verifies normal stage completion. |
| 2 | Note collection hides an execution stop | Existing note collectors propagate execution stops instead of returning incomplete notes | Prior deployed fix retained; budget and note-read harness coverage. |
| 3 | Pending dispatcher reads become terminal failures | Existing durable read journal resumes the same receipt; Agent and coordinator use `retryable_read_pending` before apply | Live read-back of 63826 first returned pending, then resumed the same receipt `a1b96e17-6218-4e18-96d6-3926cf8ae7ac` successfully by GET. The Reporter catalogue includes the new status. Automatic Agent recovery of this particular pending-read case still needs runtime observation. |
| 4 | Invalid ledger stage transitions | Preserve progressed checkpoints, including exact `ClassificationWriteStarted` and `StatusWriteStarted` identity when execution stops or a reconciliation unit cannot fit | Cloudflare Workflow attempts for 63877 proved `StatusWriteStarted -> WriteAmbiguous` was rejected twice, with seven intervening no-progress wakes. Five new regressions reproduce this gap and verify lease release, bounded read-only reconciliation and no duplicate mutation or note. |
| 5 | Agent terminates without its callback | Server-owned query/operation correlation and read-only authoritative ledger recovery in the trigger | Synthetic actual-module tests recover verified completion without another Agent run or write; unknown subsets, owner mismatch and ambiguity remain fenced. Provider runs with no approved operation still require attention. |
| 6 | Empty/reversed scopes reach the Agent repeatedly | Reject invalid scope construction and persisted windows before dispatch | Actual-module tests verify zero Agent calls and no retry loop, preserving the independent queued tail. |
| 7 | Callback or saved summary conflicts with durable results | Derive summaries from item checkpoints, expose authoritative counts and use the correlated ledger for callback reconciliation | Tests cover stale summary values, false completion, terminal failures and scheduled partial progress. A handoff is distinguished from final completion. |
| 8 | Ambiguous upstream writes | Preserve no-replay quarantine and expose retained immutable IDs for authoritative read-back | Stored upstream replies for 63806, 63826, 63862 and 63877 contain an internal execution error with `updateTicket:null`. Fresh reads show the first three classification targets remain unapplied; 63877 has a verified classification and one private note but remains New Calls. SuperOps' underlying error remains unresolved. See the separate content-free incident record. |
| 9 | Mutable client/status/subject edits are treated as identity defects | Compare immutable ID first, then the timestamp fence before mutable metadata; preparation derives canonical client-name hashes | Same-ID staff-edit regressions skip safely with zero writes. Immutable mismatch and unknown client identity remain blocked. |
| 10 | Prepared arguments change between prepare, intent and apply | Preparation returns explicit `dryRun:false`; Agent reuses one unchanged complete object and checksum | Checksum/review safeguards remain strict. The exact changed fields of historical failures were not established; the release prevents reconstruction/default drift. |
| 11 | Missing evidence/options on one ticket block the whole batch | Preparation exposes eligible/deferred IDs; Agent may make one new complete preparation of the eligible subset with frozen fences | Two-candidate regression proves the valid candidate can be prepared independently, failed candidates remain explicitly deferred, and partial preparation never authorizes writes. |

## Validation and publication

Local release checks: 796 Vitest tests, three policy text checks, 91 trigger
recovery tests, trigger workerd boundary/provenance checks, both builds and
`git diff --check`. None of these tests mutates live SuperOps data.

The initial release commit is `2087e74761b6221d3d66a8855e750de525aa803b`,
verified on local and remote `main`. The Git-connected pipeline published both
Workers. At 16:35 UTC, MCP version `13cf308b-c497-4272-a080-40cce8436753`
and trigger version `593d6e42-7b2b-49c4-891d-25ff5af7ed74` each served 100%
of traffic. The trigger module matched reviewed source byte for byte. Coordinator
and operation-ledger namespaces were retained. The follow-up issue-4 correction
uses the same Git-only publication path; final module/version verification is
recorded privately after that push.

The canonical instructions were published to `SuperOps Triage API 2026-10-05`
without recreating the Agent or its API channel. Normalized published policy
SHA-256 is `19b6b09c2eac533f36b26c4c27298ec5c13584599b5429fc48b89f2916eb9ad3`,
verified against the committed policy by the contract checker. `Triage Result
Reporter v2` was refreshed and its live schema includes `retryable_read_pending`.
No action-review constraints were weakened.

After publication, natural automatic callbacks completed at 16:46:43 and
16:48:42 UTC for batch 3569, both reporting zero ticket outcomes. This establishes
that dispatch and callbacks are working, but does not validate writes on a new
candidate, the exact API-run instruction version, or every recovery branch.
The Workspace Agents management plugin is not currently exposed in this session;
its absence did not prevent publication through the Agent editor.

The remaining closure work is a fresh candidate-bearing automatic run with
verified effects or protected staff skips, and resolution/reconciliation of the
four upstream write incidents. Historical unknown/orphan scopes remain fenced;
they are not silently declared successful or replayed. The paused monitor has
not been restarted.

The complete stored response bodies and release backups remain only in private
ignored `.wrangler/` storage. No customer text, credentials or real note bodies
are included in this release record or regression fixtures.
