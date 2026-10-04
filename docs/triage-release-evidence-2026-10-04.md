# Triage release evidence, 4 October 2026

The MCP and trigger fixes are committed, pushed and deployed through Cloudflare's
Git builds. The controlled Agent-to-MCP write succeeded and was independently
verified. **The whole task remains incomplete: the existing API channel still
contains an older instruction snapshot.** Builder publication did not update it.

## Source and earlier work

The starting main checkout at `cfa2a61` had no tracked changes, stashes or other
active worktrees. Earlier triage candidates were reconciled individually rather
than copied over newer code. The final matrix in
[the implementation plan](triage-reconciliation-implementation-plan-2026-10-04.md#reviewed-implementation-and-reconciliation)
accounts for the read-error contract, filtered history, queue/latency separation,
invocation timing, field-option efficiency, dispatcher diagnostics and conservative
failed-run recovery. Missing changes are integrated, present changes are retained
and checked, and superseded alternatives are recorded. Historical Dispatcher
archives/logs/snapshots remain in their original directory; they are not missing
runtime source and are not included in this release.

The reviewed runtime commits on `main` are:

- `f8c1fea1c47eebc2cf5b056b78ce56ee8299d41e`: preparation, safe error metadata,
  contract checks, terminal retry handling and previous-work reconciliation.
- `523764ffd6fce03576a7bf15f86758b38ca1b00b`: multiline HTML section validation,
  the bounded preparation schema and the saved paused-history policy example.

The later evidence/checker change does not change either Worker runtime module.
Its final Git build and local/remote identity are verified separately after push.

## Original incidents and prevention

| Incident | Established defect | Released control |
| --- | --- | --- |
| 63454 | An account ID was used as the canonical client-name hash. | Read-only preparation derives the hash from the canonical client name and preserves the frozen identity expectations. |
| 63455 | No Action Needed was paired with the wrong parent category. | Preparation uses live field validation before creating a write operation; the Agent gets one bounded read-only construction correction. |
| 63459 | Both fixed fallback client fields were absent for an explicitly null client. The action was denied before an MCP apply invocation. | Preparation adds the fixed pair only for a confirmed null client. Unknown identity still blocks. Normal mutation review remains; the hidden unacceptable_risk rationale is unavailable and no future approval is guaranteed. |

Terminal operation failures now stop automatic resubmission irrespective of the
callback stage. The retry cap is checked before scheduling and after restoration.
Approved-input conflicts, stale evidence, active or unknown leases and ambiguous
writes retain their fences. Old incident scopes were not cleared or blindly
replayed during testing.

## Checks

The final local check command passed **712 Vitest tests in 32 files**, followed
by **3 instruction serialization checks**. Typecheck, lint, build and
`git diff --check` passed. The trigger's **74 regression checks** and its
production-module/workerd, auth and configuration smoke checks passed. Automated
tests use synthetic data and mocks; they perform no live SuperOps mutation.

The first bounded live Agent probe failed during preparation, before apply,
because HTML labels followed by line breaks incorrectly appeared to have empty
bodies. The correction reads each section only up to the next recognized label
and continues to reject empty sections. A separate regression validates the
actual saved paused-history example against the runtime schema. Technician-group
assignment is omitted from the standing-policy preparation schema; legacy apply
inputs keep their compatibility.

## Verified runtime release

Both Cloudflare Git build rows explicitly showed Success for `523764f`.
Authenticated read-only deployment/source inspection established:

| Worker | Active version when controlled test ran | Deployed at, UTC | Module SHA256 |
| --- | --- | --- | --- |
| superops-mcp | 949ae168-8186-45fa-8681-84e5f853f10e | 2026-10-04 11:49:33.609 | 7734304e519f43041ae318f6f91ba83faa6f040e1e29edeb32b82a3dcd13dee4 |
| support-triage-trigger | 22bda721-e66f-4e3a-98c7-8019b19bac2a | 2026-10-04 11:49:20.797 | 6d11f159be32a4fbc2f95fae18dd900d9ba4e9c87cb09c6b4f5d3131ccd32ab3 |

Durable Object, KV, service, workflow bindings and secret names matched the
pre-release configuration. No namespace was replaced or newly provisioned.
Private credential-free source/configuration snapshots were retained locally;
these are not backups of Durable Object data. The already newer October 3
Dispatcher deployment was preserved.

Safe MCP status and connection smoke checks passed. The trigger's public health
endpoint returned HTTP 200 and existing subscription maintenance succeeded.
Existing needs-attention scopes remain protected. The SO MCP live catalogue was
refreshed and the read-only preparation tool enabled in the existing Agent-owned
connection; existing approval and safety constraints were retained.

## Independently verified controlled outcome

A single synthetic internal test ticket, **63471**, was used. No email trigger,
customer reply or old failed ticket was submitted for this test. The Agent used
complete read-only preparation, then one reviewed apply invocation.

The independent operation read for
`triage-release-smoke2-2026-10-04-63471` returned Completed, with one successful
verified candidate, zero failures/pending/partial/ambiguous results and exactly
two accepted physical writes: `updateTicket` and `createTicketNote`. The ledger
records two item attempts and one completed-after-retry item; this does not
authorize callers to resubmit an apply. Exactly one physical note write occurred.

A separate live ticket read confirmed New Calls, preserved TaskGroup, Low
impact/urgency and `1. Support request` / `Network`. A separate raw-note read
confirmed PRIVATE privacy, the required strong HTML header and four blank
section separators. No engineer/group assignment or resolution was performed.
No real note or ticket body is copied into this document.

Three exact safe-read Dispatcher receipt IDs were independently retrieved:
all succeeded with HTTP 200, one attempt and no uncertainty. The synchronous
successful operation had no linked pending-write receipts. These diagnostics
do not prove an email/API-channel/coordinator intake run; that path still needs
testing after the channel's instruction copy is corrected.

## Instruction drift and remaining completion condition

The canonical Git instruction contract is `2026-10-04.1`. The Builder is
published as version **462**, `agtv_6ac23d51f7348191925fd877bea87e28`.
A normal supported-UI published-version response was read independently.

| Text | Raw UTF-8 SHA256 | Policy-text SHA256 |
| --- | --- | --- |
| Canonical Git file | 789d4086cd7e2be592ef24839ab0d0a4e11f62f2a1e326c43934541972e8643a | dd0701b3404f8340c1af94f28c132cbff5dcdacd3a8c0454c87d1334dac12e3f |
| Published Builder | cbd643e9ea3ca63d5116ce59f06338d7449ed4fdd10342bbaa523a77ee9b8d81 | dd0701b3404f8340c1af94f28c132cbff5dcdacd3a8c0454c87d1334dac12e3f |
| Existing API channel | 773ce7360c1727164083bb223dab15ce3bf7fe6c4224c6559ef10ec1a718a769 | 3165d948336d3a7d6a23253c03e8ae3b8e1634b080039130a8559d04c1d08d84 |

Raw Builder bytes differ because its rich-text editor serializes Markdown
escapes before underscore, less-than and asterisk, plus paragraph whitespace.
The bounded checker accepts only those observed presentation differences,
reports both hashes and rejects changed words, tool names, line boundaries,
inline spacing or HTML tags. It does not unescape the canonical source.

The existing API channel `agtch_6aa8549398188191ab83ec01e16bf474` was read
separately. Its snapshot last changed at `2026-09-15T09:00:52.601861Z` and does
not contain the new preparation instruction. The supported Builder editor
reported that it can add/remove channels but cannot edit this channel-specific
snapshot; no channel was removed or recreated. The API page links to the
Workspace Agents plugin, whose channel editing tools are not available in this
Codex session. Access to that supported capability has been requested.

To finish, update the existing channel's instruction snapshot with the canonical
policy through the supported channel editor, preserving its identity and safety
constraints. Read it back, obtain the matching policy-text hash, and then run a
bounded controlled API-channel/coordinator test with independent terminal-ledger,
ticket-field and note verification. A queued HTTP 202 or an intent callback is
not completion. The whole task must not be described as complete until these
conditions hold.
