# Issue 6: verified original-receipt reconciliation

Implemented and deployed through the existing Git-connected pipelines. Unchanged or partial state after an ambiguous mutation no longer permits a recovery mutation. The original uncertain receipt remains held until complete target state is verified, with no replay permission.

## Verified production release

| Component | Source commit | Active Worker version | Traffic |
| --- | --- | --- | --- |
| MCP | `22dcc9618a67b8b3f15006a21a800d1aa3512dce` | `55cb3fc8-6fa2-4ae3-865e-8cc66bbfbc2a` | 100% |
| Dispatcher | `831cee858ec42cf5482c3b1e3f4ec9ba69135485` | `ce3bd1e7-5a32-4e18-a06a-55b18685300b` | 100% |

Verified at 2026-10-07T16:28:57.915Z. Both GitHub Workers Build checks succeeded. The dispatcher bundle matches the tested local rebuild byte for byte (SHA-256 `abf518e12fe6089f021606cb9d1cc4285d03cc4fd7719ba2acdb072cf6cf4cad`).

MCP live SHA-256 is `4e45ae76534ad9d74287e08eec1dc1303791a58db494e72629291449092b3905`; local SHA-256 is `b904e167b14c4927ad78637e7f9d3324dc5be8ffb42fb0f3d2544772ad16d86e`. Their only differences are 12 generated SDK path comments: Windows pnpm shortens the dependency directory. Replacing that exact comment prefix makes the entire local file identical to the live file. Executable code is identical; two independent local builds produced the same result.

Runtime bindings, variables, secret binding names, Durable Object identities and compatibility settings match the pre-change snapshot. No credentials were uploaded or Access policies changed. Trigger and call-log Workers were rebuilt by the Git pipeline with identical bundles; native Rewst is unchanged. Existing read-recovery limits and both Rewst compatibility flags remain enabled.

## Resulting behavior

The authenticated MCP producer may submit only the original mutation fingerprint, exact attempt count and 1–8 owned read receipt IDs to the bounded verification endpoint. The dispatcher derives intent and evidence from its stored original request and successful physical reads after the write. Producer-supplied outcomes, free-text claims, target values and arbitrary GraphQL are rejected.

Complete target observation records bounded content-free evidence and settles the same receipt as `RECONCILED_APPLIED`. Original response, attempt history and HTTP status remain intact; the status response exposes no invented mutation data. `not_observed` and `unknown` keep the receipt uncertain. Identical evidence and lost acknowledgements are recoverable through the original receipt. All outcomes have `replayAllowed: false`.

MCP verification reads no longer overwrite its mutation receipt. It checkpoints verified settlement before advancing triage and retains bounded references to prior verified stages. The dispatcher persists resource fences across eviction/restart: identical unresolved payloads with a new key recover the original receipt, while conflicting MCP writes to the same resource fail before admission. Legacy recovery checkpoints remain readable and cannot trigger another write.

Automatic triage reconciliation covers complete ticket targets and newly identifiable matching notes. The dispatcher also supports complete alert-resolution comparisons. Creation, time logs, scripts, unsupported controls/custom effects and unavailable or stale evidence retain uncertainty. One-off uncertain calls retain their fence; no public MCP resume or reconciliation tool was added.

The issue 7 canonical checksum, omitted/false override equivalence and approval/content-verification policy remain covered by passing regressions. This release does not change tool names, required inputs, live field validation, stale-data checks, note dedupe, triage candidates, execution limits or the operation-store size bound. The existing narrowly proven write-throttle retry exception remains separate and unchanged.

## Validation and live checks

- MCP: 754 Vitest tests in 36 files, three policy-text tests, policy contract hashes, typecheck, build, lint and `git diff --check` passed.
- Dispatcher: full `cf:verify` passed with 153 Node tests, 60 Cloudflare tests and six compiled integration tests. Both Node and Cloudflare route implementations are covered, including object eviction and compiled Worker process restart.
- The 250-item mixed-fault harness accounts for all items with zero duplicate accepted writes, at most 37 normal subrequests per invocation and serialized operations at or below 512 KiB. Delayed visibility, partial/missing state, ambiguous network/5xx outcomes, duplicate scheduling, storage failure, unsupported evidence and acknowledgement loss are covered by synthetic fixtures or intercepted/loopback upstreams.
- Production connector status and connection checks passed after MCP deployment. Dispatcher health passed; all five existing shared producer bearers authenticated. A query-only `__typename` receipt succeeded with exactly one upstream attempt and was recovered by GET of the same receipt.
- Live verification of that read receipt failed with `409 VERIFICATION_INTENT_MISMATCH`; admin and other producer access failed with 404. The read receipt remained unchanged. No live SuperOps mutation probe, ticket creation, customer write, historical replay or historical reconciliation was performed.

## Historical receipt preservation

All 108 pre-existing uncertain rows retain their status and attempt count: 73 MCP, 34 ticket-scheduler and one call-logger. Both investigated receipts for the original incident remain uncertain, with one attempt, zero reconciliation records and their original fingerprint:

- `d2d64876-0df1-48e7-a763-8ad749f69e7a`
- `34550fa8-ac3a-4a0d-80d1-2f26d636d1f4`

Shared fingerprint: `ee95bd41e1a1915b3480fa003b5ccbca8e67c1e4de0e94dee4aaf1135f45038c`. Their current state was read without attempting verification or settlement. The release does not infer non-application from absent or partial target state.

## Backups, rollback and ownership handoff

Integrity-checked before/after/final Worker snapshots and exact before/tested Git source archives are in the MCP workspace under `.wrangler/issue6-reconciliation-20261007`. They exclude credentials; source archives contain tracked files only. These are source and Worker/configuration snapshots, not a backup of the live Durable Object database.

Rollback must use reviewed commits through Git while retaining current storage, credentials, Access configuration, producer registrations, read-recovery settings and Rewst flags. Keep the dispatcher fence and stored verification records: reverting MCP alone restores its old recovery behavior. Additive intent/verification tables must not be removed as part of rollback.

Issue 6 implementation and deployment ownership is released. Issue 2 may now continue the MCP durable read-receipt journal from these source commits. Its read journal must preserve the original mutation receipt, bounded verification references and per-stage settlement checkpoint; reads must never replace unresolved write identity. Continue with the current remote branches and preserve the issue 7 checksum/approval change.

Machine-readable evidence: [release evidence](mutation-reconciliation-release-evidence-2026-10-07.json).
