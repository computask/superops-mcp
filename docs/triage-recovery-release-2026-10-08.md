# Triage recovery release, 8 October 2026

The release retains the earlier fixes and closes the remaining integration gaps
without overwriting tickets that staff changed, replaying uncertain writes or
bypassing normal action review. Staff may work on a ticket before triage finishes;
same-ID edits are expected protected skips. The recurring monitor remains paused.

## Eleven-issue implementation and evidence

| # | Issue | Solution and location | Evidence and closure boundary |
|---|---|---|---|
| 1 | Budget continuations do not progress or never wake | Existing stage-resume fix plus atomic immediate Workflow scheduling and reserved cleanup budget in `operation-store.ts`; bounded watchdog for older unscheduled approved operations | The staged apply harness verifies exact stage resume, one note and accepted-write preservation. Live 63877 had persisted progress with `ContinuationRequired` and no scheduled wake. |
| 2 | Note collection hides an execution stop | Existing note collectors propagate execution stops instead of returning incomplete notes | Prior deployed fix retained; budget and note-read harness coverage. |
| 3 | Pending dispatcher reads become terminal failures | Existing durable read journal resumes the same receipt; Agent and coordinator use `retryable_read_pending` before apply | Same exact query/window and receipt retained. A pending receipt does not become a shared SuperOps throttle. Terminal receipts and uncertain writes remain terminal. |
| 4 | Invalid ledger stage transitions | Existing progressed checkpoint preservation retained | Crash/checkpoint harnesses verify transitions and mutation dedupe. |
| 5 | Agent terminates without its callback | Server-owned query/operation correlation and read-only authoritative ledger recovery in the trigger | Synthetic actual-module tests recover verified completion without another Agent run or write; unknown subsets, owner mismatch and ambiguity remain fenced. Provider runs with no approved operation still require attention. |
| 6 | Empty/reversed scopes reach the Agent repeatedly | Reject invalid scope construction and persisted windows before dispatch | Actual-module tests verify zero Agent calls and no retry loop, preserving the independent queued tail. |
| 7 | Callback or saved summary conflicts with durable results | Derive summaries from item checkpoints, expose authoritative counts and use the correlated ledger for callback reconciliation | Tests cover stale summary values, false completion, terminal failures and scheduled partial progress. A handoff is distinguished from final completion. |
| 8 | Ambiguous upstream writes | Preserve no-replay quarantine and expose retained immutable IDs for authoritative read-back | Stored upstream replies for 63806, 63826 and 63862 contain `Internal Server Error(s) while executing query` with `updateTicket:null`. Four bounded observations did not prove the requested effects. An upstream defect is not fixed by resubmitting; these incidents need reconciliation. |
| 9 | Mutable client/status/subject edits are treated as identity defects | Compare immutable ID first, then the timestamp fence before mutable metadata; preparation derives canonical client-name hashes | Same-ID staff-edit regressions skip safely with zero writes. Immutable mismatch and unknown client identity remain blocked. |
| 10 | Prepared arguments change between prepare, intent and apply | Preparation returns explicit `dryRun:false`; Agent reuses one unchanged complete object and checksum | Checksum/review safeguards remain strict. The exact changed fields of historical failures were not established; the release prevents reconstruction/default drift. |
| 11 | Missing evidence/options on one ticket block the whole batch | Preparation exposes eligible/deferred IDs; Agent may make one new complete preparation of the eligible subset with frozen fences | Two-candidate regression proves the valid candidate can be prepared independently, failed candidates remain explicitly deferred, and partial preparation never authorizes writes. |

## Validation and publication

Local release checks: 791 Vitest tests, three policy text checks, 91 trigger
recovery tests, trigger workerd boundary/provenance checks, both builds and
`git diff --check`. None of these tests mutates live SuperOps data.

Commit and push the reviewed changes to `main`; the existing Cloudflare
Git-connected builds publish both Workers. Verify deployed module hashes,
100-percent traffic, unchanged coordinator namespace and the existing MCP ledger
binding. Publish and read back the canonical Agent policy separately, refresh
the Reporter catalogue and verify the automatic channel using a bounded live run.
Source tests alone do not establish deployment or every provider-dependent path.

The complete stored response bodies and release backups remain only in private
ignored `.wrangler/` storage. No customer text, credentials or real note bodies
are included in this release record or regression fixtures.
