# Automatic triage run expiry and recovery

The coordinator previously polled nonterminal/unavailable Workspace Agent runs
forever. Its five-minute maximum-age setting did not release these runs when
reconciliation separation was enabled. A redeployment preserves Durable Object
state and therefore does not clear this blockage.

Automatic runs now have independent, bounded write leases. The MCP checks the
lease before apply, before mutation-start checkpoints using live ticket metadata,
and immediately before every new dispatcher mutation POST. Durable continuations
use their original operation ID and pass the same gate. Receipt GETs remain
available after expiry; accepted writes are not cancelled or replayed.

The lease never grants approval. Existing platform review, immutable operation
input, stale checks, note dedupe and final verification remain mandatory. Capture
receipts remain observational. Automatic correlation uses the existing reserved
Trigger ID as batchId and the existing dispatch-attempt metadata; no new Agent
action or credential is required. Uncorrelated manual operations retain their
existing authorization gates. This is not a new identity boundary: callers still
need the existing MCP authentication and plan approval.

Before a physical write, the MCP's live ticket read must place the ticket's
createdTime/source inside the exact frozen half-open EMAIL scope. The coordinator
records only bounded ticket identifiers as validated members. Final submission
checks both membership and expiry. Expired/unknown/revoked leases fail closed.
At most 256 compact leases and 500 identifiers per lease are retained; eviction
denies future writes rather than renewing permission. Lease checks do not extend
deadlines. Dates without a timezone from SuperOps are interpreted as UTC.

On expiry the coordinator first confirms, through its private service binding,
that the deployed MCP advertises triage-run-lease-v1 enforcement. Without that
handshake it retains the active lock. It then durably revokes the exact run before
quarantining its original window and promoting disjoint work. All prior attention
and reconciliation records survive. A late callback cannot change a newer run.
Unknown run identity or non-targeted scope remains blocked for explicit diagnosis.

The five-minute limit is a wall-clock write deadline, including continuations.
Legitimate work delayed beyond it needs reconciliation; it must not be retriggered
blindly. A POST admitted immediately before expiry may finish later, so its old
window remains fenced and existing receipts/partial writes must be inspected.
The coordinator does not claim to cancel the OpenAI job.

GET /health exposes accepted age, expiry, stalled state and recovery-enabled state.
POST /admin/run/recover uses the existing replay-admin secret and requires the
exact active triggerId, runId and a boolean dryRun. Preview reports the retained
scope and intended action; execution uses the same expiry/handshake checks as
automatic recovery. It never clears global history or replays a ticket window.
The underlying run-lease check is reachable through the existing Durable Object
binding only, not a public Worker route. No new production resource is created.

Rollout is Git-only. Test/build both Workers and review the diff, commit and push
main, then verify both active versions, the new binding to the existing coordinator
namespace, unchanged secrets and the capability response. Deployment order cannot
unlock a stuck run prematurely because of the runtime handshake. For rollback,
first pause automatic dispatch in Git and fence/drain automatic work; never roll
back the MCP guard while relying on expired-run separation.

Regressions cover expiry/restart persistence, exact scope membership, wrong
attempt, nonterminal and unavailable status, missing/disabled/wrong-version guard,
fence persistence before queue promotion, late callbacks, new-POST rejection and
same-receipt reconciliation. Automated tests use synthetic data only. Live
completion additionally requires evidence from the automatic channel and verified
ticket state/private-note dedupe; deployment alone is not end-to-end success.
