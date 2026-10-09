# Pending first-read handoff recovery

The first created-time query can return an incomplete empty report while its
original dispatcher receipt remains queued behind the shared account cooldown.
Previously the normal partial-result wrapper lost durable recovery metadata.
Reporter validation also rejected the MCP's fixed `dispatcherRead.open` and
`dispatcherRead.checkpoint` labels and `dispatcherTransportUnknown` status.
Provider completion without an accepted callback then quarantined the window
because no approved apply operation existed to reconcile.

The MCP now preserves partial records and publishes the server-owned recovery
contract in structured content and the first text block. An incomplete empty
query is an error, never proof of a complete empty candidate set. Routine failure
summaries retain only the bounded recovery reason. The Reporter uses one bounded
allowlist for its public schema and parser, including the actual internal labels
and statuses. Rejected callbacks expose and record only fixed validation field
paths, correlated to the current attempt.

The MCP independently observes a durably pending first query using the existing
internal coordinator binding. The coordinator may recover a missing callback
only after provider completion, for the original exact window, original owner
and read receipt, before its fixed recovery deadline and configured retry cap.
It atomically revokes the old write lease before scheduling a new attempt.
Successful query observation, apply intent, any write check, operation identity,
authorized items or an unsafe rejected callback disables this fallback. Pending
reads do not assert an upstream throttle or set the shared rate-limit gate.
Newly queued reads without an upstream deadline use the journal's persisted
creation time plus fifteen minutes. A later upstream deadline can shorten this
bound but cannot extend it. An expired pending receipt is explicitly
non-retryable; it remains available for receipt-only inspection. Accepted
pending-read callbacks also stop automatically at the fixed deadline.

For an already quarantined historical run, Sam-only Cloudflare Access protects
`POST /admin/triage-read-recovery` on the MCP. Supply the exact trigger, attempt,
missing-callback history event and target ticket, with `dryRun:true` first. The
MCP requires complete, untruncated private captures proving only the same pending
empty first query and no captured writes. The coordinator additionally checks
the actual old write lease, absent intent/operation, matching history/window,
current attention fence, idle coordinator and live MCP write guard. Applying the
preview uses `dryRun:false`. It preserves the original trigger read-journal
identity, increments the attempt, limits processing to the named ticket and
retains attention fences. This control does not approve a plan, reset a ledger,
change Agent identity, alter credentials, or replay a mutation. The normal
preparation, review, fresh stale checks, technician-edit protection, note dedupe
and final verification remain mandatory.

Regressions use synthetic data and the actual MCP and Reporter implementations:
194,012 ms and 91,207 ms queue delays, 100-record pages, partial-result handoff,
public schema and parser compatibility, one original read POST then receipt GET,
missing-callback revocation/recovery, current-attempt isolation, deadline and
retry caps, active/failed provider states, unsafe writes and operator recovery
authentication/preview/fencing. Production uses Git-connected builds for both
Workers. Revert the reviewed commit through Git for rollback; private deployment
module/settings backups preserve the pre-release baseline.

This fixes the handoff around account cooldowns. It does not establish why
SuperOps throttles otherwise compliant account traffic.
