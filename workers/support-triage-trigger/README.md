# Email triage trigger — Git deployment

This is the canonical deployment folder for the existing support-triage-trigger
Worker. The initial JavaScript module is byte-for-byte production version
8bcfcc94-ec82-44db-8715-4c276817fc12, SHA-256
c902b1914961653c3567e0695a5f0c3badffa916c753055e93f8f170db4a8f4b.
It is a preserved compiled baseline, not a claim that the older local TypeScript
projects match production. no_bundle preserves that baseline at upload.

Reviewed reconciliation, 24 September 2026: the recorded-callback retry-drain
branch now proceeds after a terminal run instead of fabricating a missing
callback. Terminal retry runs also bypass stale-run recovery, because their
callback already selected the safe recovery path. The awaiting-result watchdog,
ambiguous-write protections, active-run exclusion and immutable window remain.
Current module SHA-256:
9c0196e17d1ceac67879bd967698dfe94ab30b3cab10f3664e8d001b3ba0f2e7.
`recovery-checks.mjs` exercises the actual module with synthetic storage/Agent
responses; no production test endpoint is introduced. Revert this reviewed
commit through Git for rollback. Existing attention records are not cleared.

Overlapping attention windows, 24 September 2026: an undispatched email window
can now retain its protected prefix and release only the suffix after every
overlapping attention fence. This addresses the 62890/62891 failure sequence:
an uncertain update for the earlier ticket must not swallow the later ticket's
window just because its lookback overlaps. The original upper bound and due time
are retained (normal dispatch-time end clamping still applies). The existing
single-run gate, rate-limit gate, stale checks and mutation safeguards remain.
Accepted/frozen scopes are never clipped or replayed. Empty-result recovery
cannot widen a released suffix back into a hold.

`TRIAGE_ATTENTION_TAIL_ISOLATION_ENABLED=true` enables this behavior; set it false
and push through Git to restore whole-window parking. No state migration or
hold clearing is needed. Old aggregated parked windows remain conservative
fences: their gaps and already-parked tickets are NOT automatically released.
Fully covered windows, unknown/full-queue fences and malformed bounds still
fail closed. Prefixes before the final fence remain held for reconciliation.
This fixes later-window starvation, not every possible missed-ticket case.
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
receipt ID/state, and structured outcome flags. Unknown keys, headers, bodies,
URLs, and malformed values remain rejected. Dispatcher polls are transport
coordination, not additional SuperOps calls; receipt-level upstream accounting
remains authoritative. Refresh Triage Result Reporter v2 in ChatGPT after this
Git deployment so its cached schema includes the additive fields.

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
- Deploy (CI only): npx wrangler deploy --config workers/support-triage-trigger/wrangler.jsonc
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
