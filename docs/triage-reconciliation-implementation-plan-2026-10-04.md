# Triage reconciliation and implementation plan

The approved work combines earlier triage candidates with the fixes established
from the three private pre-apply captures. It includes implementation, regression
testing, Git deployment, coordinated Agent and API-channel updates, and live
verification. Real capture bodies, customer messages, notes and credentials must
not enter this document or test fixtures.

## Verified baseline

The clean starting checkout is main at cfa2a61. The deployed MCP is version
cb22aa7e-727d-47a2-9ac9-43fe00eaddaf, built from that commit. The trigger is
b56a6529-de47-460a-b790-7506474c826f; its module matches the tracked source with
SHA256 d34103734338fc72c537264b63c4cdcbbf6563012baae7f3474d9d65149f24a1.
Before release, recheck active versions and retain credential-free source and
configuration backups. Worker snapshots do not back up Durable Object data.

The saved plans established three construction errors: ticket 63454 used an
account ID as a client-name hash; 63455 selected a subcategory under the wrong
parent; 63459 omitted both fallback client fields. The last action was denied
before an MCP apply invocation. Its hidden review rationale is unavailable.
The coordinator also retries terminal validation operations and schedules work
after its configured retry cap has been reached.

## Reconcile previous work

Compare scoped candidates against current source and behavior, rather than
replacing current files with older snapshots. Retain the original directories.
For each row, record final evidence and classify it as incorporated, integrated
here, or superseded. An absent old worktree is not evidence its changes landed.

| Earlier candidate | Current evidence and required action |
| --- | --- |
| September 15 read-error contract | The standalone safe error projection is absent. Integrate the bounded error contract, structured-content size accounting and central read-retry telemetry against the current dispatcher-aware client. Preserve write retry restraint. |
| September 14 relevant-history coverage | Current trigger contains ascending filtered SQL and frozen coverage cursors. Verify matching-row filtering precedes LIMIT and retain pagination and incomplete-coverage behavior. |
| September 15 latency and eligibility separation | Current trigger contains reconciliation holds, persisted fences, fresh disjoint intake and active-run checks. Verify unknown accepted leases, non-overwriting holds, restart and flag rollback; integrate only remaining gaps. |
| September 15 optional Agent invocation timings | Compare with current server-owned timing instrumentation. Prefer the newer authoritative boundary markers; do not reinstate caller-estimated timings or permit forged internal rejection markers. |
| September 7 field-option efficiency | Older worktree no longer exists. Verify tenant/region/field-set cache isolation, single retry ownership and unchanged-leave behavior in current source; correct actual attempt telemetry where needed. |
| September 25 dispatcher diagnostics | MCP and trigger diagnostics are tracked; the separate Dispatcher now has a Git release and a newer October 3 deployment. Verify producer-scoped safe diagnostics and preserve that newer release, native adapters and uncertainty evidence. Its untracked deployment archives are historical artifacts, not missing runtime fixes. |
| September 28 failed-run recovery investigation | Account for untouched-only recovery separately from validation repair. Do not infer a timeout, missing callback or missing run ID proves no write or a terminal lease. Preserve existing holds and bounded scope. |

## Implement the missing controls

1. Add a read-only `superops_tickets_prepare_triage_plan` tool. It accepts the
   frozen candidate set and proposed actions, performs no SuperOps mutation and
   creates no durable write operation. Reuse action, policy, identity, option,
   content and privacy validators. Require the original ID, subject, status and
   updatedTime; changed evidence cannot be silently refreshed. Derive client-name
   hashes from canonical names. Add the fixed fallback pair only for confirmed
   null clients, preserve assigned clients, and reject unknown identity.
2. Return the complete prepared argument object only after every candidate is
   valid. Include a bounded preparation checksum and policy contract version
   for accidental-change and deployment-drift detection; neither grants write
   approval. Do not return a valid subset as an approved full plan. Correctable
   construction errors may be repaired during read-only preparation, before a
   write operation exists. Final apply retains independent stale checks, live
   field validation, private-note dedupe, mutation review and final verification.
3. Classify persisted operation status independently of callback stage. A
   terminal operation or changed approved-input conflict stops automatic
   resubmission. Pending operations retain same-operation continuation. Risk
   denials and ambiguous writes remain fenced. Apply the hard retry cap before
   scheduling in every relevant branch and after persisted state restoration.
4. Keep failures actionable through existing bounded diagnostics: preparation,
   platform review, MCP validation, mutation, verification and continuation must
   remain distinguishable. Missing HTTP status stays missing. No raw provider
   body or customer content enters routine output or logs. Safe retry metadata
   never authorizes mutation replay.
5. Save one versioned Agent instruction source in Git, consolidate conflicting
   repair/retry wording and preserve the current evidence, HTML-note, history
   pause and no-replay rules. Generate or verify its runtime contract references.
   Update both Builder and the active API channel explicitly, then read back
   both actual texts and compare their hashes. Agent publication alone cannot
   establish API-channel synchronization. Use supported UI readback where no
   supported configuration API is available.

## Double check before release

Review the plan and implementation against the actual domain helpers, operation
ledger ordering, direct-route tool policy and trigger state machine. Reproduce
the original failures with synthetic data, not captured customer content.
Required regressions cover malformed identity hashes, null versus unknown client
identity, parent-child field mismatch, changed snapshot timestamps, no operation
creation during preparation, no public notes or unsafe overrides, terminal
validation with a persisted operation, changed input under the same ID, retry
exhaustion, restart, denials, ambiguous writes, active leases and disjoint queues.
Reconcile the older contracts with meaningful behavioral checks.

Run the complete MCP suite, typecheck, lint, build and diff check, plus the trigger
production-module/workerd checks and focused reconciliation regressions. Keep
the trigger module checksum/provenance record consistent with the reviewed
source. Review the complete diff and verify no unrelated changes or sensitive
fixtures have entered it.

## Deploy and verify

1. Commit and push normally through the repository's Git-connected Cloudflare
   pipeline. Never publish either SuperOps Worker manually with Wrangler.
2. Confirm both builds succeeded, deployed commits and active versions match,
   and identities, bindings, secrets and Durable Object namespaces are preserved.
3. Refresh the live connector catalogue as required, enable the bounded read-only
   preparation action for the existing Agent, and update/publish both instruction
   copies. Read back their actual contents and record matching hashes.
4. Start with safe status/connection/read smoke checks. Exercise preparation
   failures read-only and run bounded controlled test tickets through normal
   approval and apply. Verify terminal operation results, final fields and one
   deduplicated private note independently. HTTP 202, an intent receipt or a
   callback alone is not success.
5. Keep old failed or uncertain tickets and scopes intact; do not blindly replay
   them to demonstrate success. Record any separately required incident recovery.
   Retain rollback commits and instruction snapshots; rollback must preserve
   persisted fences and uncertainty records.

## Completion evidence

Completion requires a final reconciliation matrix for all identified earlier
candidates, passing checks, reviewed commits, verified deployments, matching
Agent/API instruction texts, and independently verified controlled outcomes.
Any platform denial or missing observable review rationale remains explicit;
implementation must not bypass those decisions or fabricate their causes.

## Reviewed implementation and reconciliation

The release adds complete read-only preparation, optional pre-ledger contract
checks, safe read errors in both MCP response channels, accurate field-read
attempts, terminal-operation fencing and hard retry limits. It consolidates the
Agent policy in Git and checks the trigger/runtime contract version during the
standard test command. Existing apply validators and durable uncertainty remain.

| Earlier work | Final disposition and evidence |
| --- | --- |
| Read-error candidate | Integrated against the current dispatcher client in error-contract.ts, the MCP boundary and response-size accounting. Synthetic tests cover privacy, read/write retry scope and actual attempts without an outer retry. |
| Filtered history | Already incorporated. A new actual-module regression verifies filtering before LIMIT, ascending cursor resume, frozen upper bound and incomplete retention coverage. |
| Latency/queue separation | Already incorporated. Current regressions retain active/unknown leases, disjoint intake, held retries, overlap fences, restart and rollback. Terminal retry fixes augment these paths without clearing old scopes. |
| Optional caller timings | Superseded by tracked server-owned invocation/timing boundaries and current safe dispatcher traces. Caller-estimated timing overlays are not reinstated. |
| Field-option efficiency | Already incorporated for cache isolation, one retry owner and unchanged leave classification. Missing attempt telemetry is integrated here. The absent September worktree is not used as proof of deployment. |
| September dispatcher diagnostics | Already tracked in MCP commit 5a4a037 and released separately in Dispatcher before the newer October 3 scheduler release. Retain the newer Dispatcher and its native adapter/uncertainty state. Historical untracked ZIP/log/snapshot artifacts are retained outside this runtime release. |
| Untouched failed-run recovery | Current conservative behavior is retained: a missing callback or uncertain accepted lease never proves no MCP calls. Existing bounded one-shot operator reconciliation remains separate from terminal validation repair. No automatic replay is introduced. |

Local release checks: 710 MCP tests, typecheck, lint, build and diff checks pass.
The trigger's 74 regressions and workerd/auth/config smoke pass with zero live
SuperOps mutations. Deployment and controlled outcomes are recorded separately
after the actual Git builds and Agent/API-channel readbacks complete.
