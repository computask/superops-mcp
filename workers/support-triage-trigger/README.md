# Email triage trigger — Git deployment

This is the canonical deployment folder for the existing support-triage-trigger
Worker. The initial JavaScript module is byte-for-byte production version
8bcfcc94-ec82-44db-8715-4c276817fc12, SHA-256
c902b1914961653c3567e0695a5f0c3badffa916c753055e93f8f170db4a8f4b.
It is a preserved compiled baseline, not a claim that the older local TypeScript
projects match production. no_bundle preserves that baseline at upload.

Cloudflare Git build uses computask/superops-mcp, main, root /:

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
