# Email triage trigger — Git deployment

9 October 2026: pending first-query recovery now receives independent,
content-free MCP observations. A missing callback can resume only the exact
read-only window after provider completion and old-lease revocation, before the
fixed deadline/retry cap, with no apply intent, write check or operation. The
Reporter schema/parser share the bounded internal journal-label/status contract.
Rejected callbacks retain fixed validation field paths only. Sam-only MCP admin
recovery of historical first-read-only runs preserves receipt identity and all
attention fences. See `../../docs/triage-pending-read-release-2026-10-09.md`.

8 October automatic-run validation: ticket 63883 completed through the original
durable operation, and a fresh read confirmed all four approved classification
fields and exactly one private triage note. A later overlap run reported that
verified existing-note skip as `completed` instead of `skipped`, so the strict
callback classifier scheduled unnecessary retries. The classifier now accepts
either label only with the same evidence-recovery tool, current note check,
verification-read counts, complete accounting and absence of failure/ambiguity.
Missing proof still cannot complete. The Agent prompt explicitly separates the
`ticketsCompleted` count from the `skipped` outcome and retains pending-read
diagnostics from every returned text block. Two actual-module regressions cover
the observed shape and the rejected missing-proof variants.

8 October 2026: the MCP records content-free exact-window query candidates and
associates the approved operation owner through its existing internal write-lease
check. The coordinator reads only that owner's correlated operation through the
existing `SUPEROPS_OPERATION_LEDGER` namespace. Verified durable completion can
recover a missing callback; an acknowledged scheduled continuation is a handoff,
not final ticket completion. Unseen/deferred candidates, unscheduled operations
and ambiguous writes cannot be converted into success or replayed. No public
internal endpoint, new namespace or migration is introduced.

An expired Agent cannot renew its write permission. An internal MCP continuation
may finish only a currently claimed item of the same approved, unrevoked,
unexpired operation; the original Agent deadline remains unchanged. Empty or
reversed created-time windows stop before dispatch. The additive callback status
`retryable_read_pending` resumes a server-owned durable read without asserting a
SuperOps throttle or setting the shared throttle gate. Refresh the Reporter's
action catalogue and publish the canonical Agent instructions with this release.
See `../../docs/triage-recovery-release-2026-10-08.md` for the eleven-issue record.

5 October 2026: accepted runs persist their original trigger URL and every
status-poll branch uses it. `WORKSPACE_AGENT_LEGACY_TRIGGER_URL` identifies the
old channel for accepted records written before URL persistence existed. Fresh
dispatches use `WORKSPACE_AGENT_TRIGGER_URL`; never remove the legacy fallback
until old accepted records have drained. Stored polling endpoints are restricted
to the exact HTTPS Workspace Agents route on api.chatgpt.com. No scopes, leases,
attention fences or mutation retry rules are reset during a channel cutover.

4 October 2026: terminal durable operations are classified independently of
callback failureStage. CompletedWithFailures/Failed/Cancelled are fenced even
when replaySafe is true; they cannot be repaired under the same operation ID.
Result and transport retries stop at the configured cap, including restored
retry state. Existing uncertain scopes and active leases remain protected.
The dispatch prompt requires contract 2026-10-04.1 and read-only preparation
before the diagnostic intent and one separately reviewed apply. Canonical Agent
instructions are in `../../agent/superops-triage-instructions.md`; Builder and
API-channel readback must be checked separately at release.

This is the canonical deployment folder for the existing support-triage-trigger
Worker. The initial JavaScript module is byte-for-byte production version
8bcfcc94-ec82-44db-8715-4c276817fc12, SHA-256
c902b1914961653c3567e0695a5f0c3badffa916c753055e93f8f170db4a8f4b.
It is a preserved compiled baseline, not a claim that the older local TypeScript
projects match production. no_bundle preserves that baseline at upload.

Private Workspace Agent capture, 26 September 2026: each dispatched prompt's
exact JSON request body (excluding Authorization) and each accepted
`triage_apply_intent_report` payload are stored in a separate SQLite table in
the existing coordinator DO, never in `/history` or ordinary logs. Both expire
after seven days; trigger capture is bounded to 256 KiB per record and 256 MiB
total. Retrieve one exact run with the bearer-protected
`/admin/agent-capture?triggerId=...&attempt=...` endpoint, or use the equally
bounded `batchSequence` lookup when public dispatch history provides the batch
number but intentionally omits the opaque trigger UUID. Sequence lookup remains
behind the distinct capture-read bearer token and returns at most one matching
run; missing or ambiguous matches fail closed. Provision the distinct
`TRIAGE_CAPTURE_READ_TOKEN` as a Worker secret outside Git before deployment;
capture remains off until that secret exists, and `/health` reports only its
enabled boolean. Do not reuse the history-reset or replay token. The MCP-side captures of each
correlated SuperOps tool call and returned result are stored separately by the
SO MCP and retrieved through its Sam-only Cloudflare Access admin route.

The pre-apply report is logging only and does not approve or bypass tool review.
Missing/corrupt/over-limit captures are marked incomplete or returned as
bounded failure metadata. This captures only the integration-visible request
and tool traffic; it cannot expose hidden OpenAI system context or internal
auto-review rationale.

Protected capture lookup, 26 September 2026: the same bearer-protected route
also accepts one numeric `batchSequence` plus `attempt` when the opaque trigger
UUID is absent from public history. The Durable Object performs a bounded,
parameterized lookup across unexpired capture and capture-failure rows; it
returns a result only for exactly one matching trigger and fails closed for
missing or ambiguous matches. Public `/history` remains unchanged and does not
expose trigger UUIDs or capture contents.

Reviewed reconciliation, 24 September 2026: the recorded-callback retry-drain
branch now proceeds after a terminal run instead of fabricating a missing
callback. Terminal retry runs also bypass stale-run recovery, because their
callback already selected the safe recovery path. The awaiting-result watchdog,
ambiguous-write protections, active-run exclusion and immutable window remain.
Current module SHA-256:
722f61db91968fd98023710a3936922853a128d6168cc334428b3e7b68e6ea00.
`recovery-checks.mjs` exercises the actual module with synthetic storage/Agent
responses; no production test endpoint is introduced. Revert this reviewed
commit through Git for rollback. Existing attention records are not cleared.

Timing instrumentation, 27 September 2026: the existing pre-apply report emits
content-free `received` and `response_ready` markers to the private Tail Worker.
These bracket report persistence without another Agent tool roundtrip or
SuperOps call. Response-ready means the server is returning a response, not
proof the Agent received it. No capture payload, note or credential is logged.
See `../../docs/triage-tool-timing.md` for correlation and limitations.

Intent-receipt correction, 27 September 2026: the five-email run recorded intent,
then submitted another intent report and stopped without a correlated apply
invocation. The conversation described a missing operation result, but the
underlying review reason was not visible. The reporter now explicitly returns
a diagnostic-only receipt, never an operation result or authorization. The
trigger instructions distinguish the two calls and prohibit re-reporting merely
to obtain an operation ID. This does not establish whether any earlier apply
ran; actual missing/ambiguous results and observed denials still stop replay.
Specific bounded capture failure codes are retained in timing diagnostics.
No extra SuperOps call, queue reset, capture overwrite or safety override is
introduced. Existing queue-isolation regressions retain the failed scope while
proving that later disjoint notifications dispatch.

Queue isolation, 27 September 2026: a needs-attention scope is no longer
represented as a fake queued notification, and scope-less lifecycle recovery
cannot set a global queue fence. Legacy attention-only sentinels are cleared
on the next coordinator intake/alarm even when a stale reason label exists but
no notification window/scope does; the underlying failed scope stays durable.
Disjoint email work is promoted ahead of delayed retry windows; exact
overlapping prefixes stay fenced, and eligible suffixes may proceed. A retry
whose Agent run is still active continues to hold the single-run lease until
terminal status is confirmed. One automatic reconciliation retry is retained;
if that slot is already occupied, additional failed scopes become
needs-attention records rather than blocking fresh work or being merged into a
wider replay. Provider-wide rate-limit Retry-After gates remain respected.

Live-test prompt correction, 27 September 2026: targeted input now distinguishes
explicit null classification from omitted/unknown data so the Agent need not
repeat a successful canonical read merely to confirm null. The bounded options
lookup, frozen updatedTime and mandatory MCP pre-write stale check remain.
Meaningful technical test cases use evidence-based technical classification,
not a historical General Admin test special case. Agent Builder edits and
independent verification are recorded in the accompanying test-correction doc.

Overlapping attention windows, 24 September 2026: an undispatched email window
can now retain its protected prefix and release only the suffix after every
overlapping attention fence. This addresses the 62890/62891 failure sequence:
an uncertain update for the earlier ticket must not swallow the later ticket's
window just because its lookback overlaps. The original upper bound and due time
are retained (normal dispatch-time end clamping still applies). The existing
single-run gate, rate-limit gate, stale checks and mutation safeguards remain.
Accepted/frozen scopes are never automatically clipped or replayed. Empty-result
recovery cannot widen a released suffix back into a hold.

Operator-controlled single-ticket replay, 25 September 2026: `POST /admin/replay`
is a separate, bearer-token-protected recovery path for one ticket from a
recorded `orphan_recovered` event whose Agent run is confirmed `failed` and
whose result callback is missing. The caller must provide the exact
`sourceEventId`, one display `ticketNumber`, and `confirmNoMcpCalls: true` after
checking MCP/dispatcher logs. The Worker requires no active Agent, no
rate-limit or reconciliation hold, the exact matching attention fence, and
either no queued work or a queue explicitly blocked by attention. An explicitly
blocked queue is preserved untouched while the one-ticket replay runs. The
Worker records the replay request, preserves every attention fence, rejects a
duplicate request for that event/ticket, and constrains the Agent prompt and
candidate application to that ticket only. A later failure remains fenced; it
is not automatically replayed. Replays never widen the original time window,
clear history, or bypass stale checks, deduplication, verification, or write
safeguards.

Configure the distinct `TRIAGE_REPLAY_ADMIN_TOKEN` as a Worker secret outside
Git before using this endpoint. Do not reuse `TRIAGE_HISTORY_RESET_TOKEN` or
commit the replay token. The history reset credential remains limited to its
existing reset route.

`TRIAGE_ATTENTION_TAIL_ISOLATION_ENABLED=true` enables this behavior; set it false
and push through Git to restore whole-window parking. No state migration or
hold clearing is needed. Old aggregated parked windows remain conservative
fences: their gaps and already-parked tickets are NOT automatically released.
For a new time-bounded email window, opaque legacy/full-queue fences no longer
block every later ticket: the Worker uses the durable original notification
window as the quarantine boundary and releases only a strictly later suffix.
If no exact time-bounded fence exists, the incident timestamp is the fallback
cutoff; if that timestamp is missing, the current queue-evaluation time is used.
Fully covered windows remain parked, and prefixes before the final known fence
remain held for reconciliation. This prevents one ambiguous ticket from
starving unrelated later email while never replaying its frozen scope.
History records `attention_prefix_parked` and `attention_tail_released` with
their exact half-open scopes. Original arrival events remain in history; when
a fence ends after the original arrival, the released window starts at that
fence boundary, not at a newly received email.

Failure diagnostics guidance now distinguishes an observed reason for not
attempting apply from the generic `apply_not_attempted` outcome. Failed-tool
telemetry must be reported instead of the last successful call; unknown reasons
remain explicitly unknown. This does not authorize any safety-gate override.
The one options lookup must cover required closure fields when an evidence-
supported resolve is under consideration, before spending that lookup on other
missing classifications. Leave actions do not require closure-only fields.

The five-email test exposed a second defect: the one-second maximum debounce
gave later coalesced notifications less than their configured ingestion grace.
Fast mode now coalesces for at most 30 seconds, plus 15 seconds ingestion grace.
An isolated notification still dispatches after 16 seconds. Notifications too
late for that bounded deadline go into the existing next-window queue; they
cannot indefinitely postpone the first batch or widen a frozen run. This is a
bounded ingestion allowance, not a guarantee against arbitrary upstream delays.
Regression tests include the exact final-arrival timing, sustained arrivals,
and notifications received during a frozen run.

The callback parser and published tool schema now accept the MCP's bounded
dispatcher telemetry: dispatcherPoll, provider, timing, host-only endpoint,
receipt ID/state, separate dispatcher/upstream HTTP statuses, and structured
attempt diagnostics including GraphQL codes and field paths. Diagnostic
retrieval failures are reported as their own bounded category. Unknown keys,
headers, bodies, URLs, and malformed values remain rejected. Dispatcher polls
are transport coordination, not additional SuperOps calls; receipt-level
upstream accounting remains authoritative. Refresh Triage Result Reporter v2
in ChatGPT after this Git deployment so its cached schema includes the additive
fields.

Safety/access denials (risk_gate, unacceptable_risk, apply_rejected,
permission_denied, access_denied) are terminal even when read-only telemetry
exists. Their exact scope is retained for human reconciliation; it is not
automatically replayed or widened. Persisted retries from an older version are
fenced after their accepted run drains. Disjoint new email windows can proceed.
Regression tests cover each denial, active-run draining, stored retry migration,
attention persistence and a subsequent unrelated email. No risk gate or mutation
safeguard is weakened.

Cloudflare Git build uses computask/superops-mcp, main, root /:

The existing Worker was connected to this repository on 23 September 2026,
reusing the existing superops-mcp build token. No new token or permissions were
created. The first post-connection push starts the Git-managed restart.

- Build: npm --prefix workers/support-triage-trigger test && npm --prefix workers/support-triage-trigger run build
- Deployment: commit and push to main; the existing Cloudflare Git-connected
  production build publishes the change. Do not deploy this Worker with Wrangler.
- Preview builds disabled: no second live mailbox consumer.
- Only change this folder for trigger-only updates. The root MCP configuration
  still targets superops-mcp and never this Worker.

All existing non-secret settings are declared explicitly. The enable flag is
true for the authorized restart; set it false in Git and push for a controlled
pause. Revert a reviewed commit through Git for rollback, never restore an older
unverified local folder. Secret values are inherited from the existing Worker.
The same Durable Object, namespace, migration and state are retained. Source
backups do not back up its live SQLite database.

The one-minute cron maintains Graph subscriptions and bounded fallback discovery.
New-mail Graph notifications remain the primary trigger; this is not a periodic
full-ticket-queue triage job. No email bodies or direct SuperOps requests are
performed by this Worker. The MCP remains the mutation authority.

Automatic run expiry now uses independent MCP-enforced write leases. Before
releasing an expired run, the coordinator requires a live write-guard capability
handshake, persists revocation, and retains the exact old EMAIL scope for
reconciliation. It promotes only disjoint queued work and never replays an
accepted mutation. See ../../docs/triage-run-expiry.md for the authenticated
preview/recovery control, deployment ordering and rollback requirements.
