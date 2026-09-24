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
7f884b20977f89c094174331ab64e4308ad045de83710b5a6a093cff334f8ed7.
`recovery-checks.mjs` exercises the actual module with synthetic storage/Agent
responses; no production test endpoint is introduced. Revert this reviewed
commit through Git for rollback. Existing attention records are not cleared.

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
