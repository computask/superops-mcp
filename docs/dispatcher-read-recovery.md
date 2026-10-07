# Durable dispatcher read recovery

MCP journals dispatcher read identities in its existing operation-ledger Durable
Object namespace before submitting a read. It stores owner/workflow/payload
hashes, the original key and receipt, state, retry time and immutable recovery
deadline. It stores no GraphQL, variables, customer content or credentials.

Correlated Agent calls use the same trigger and tool identity across dispatch
attempts. Durable continuations use the same owner, operation and item identity.
A pending read is recovered by GET of its original receipt. If acknowledgement
was lost before an ID was available, only the original key and identical body
are resubmitted. Dispatcher idempotency prevents another logical submission.
Retry timing survives Worker restart; a cooldown extending beyond the recovery
deadline still permits checking expiry on the original receipt at that deadline.

Automatic callers retain terminal failed/cancelled receipts and do not silently
start another generation. Uncertain receipts never renew. A separate deliberate
manual read after failure links its new generation to the earlier receipt.
Confirmed successful reads may renew, retaining that link, so later evidence is
fresh. Before a mutation stage uses a read recovered from an earlier execution,
MCP first recovers that read and then takes a new authoritative read. This keeps
live stale checks, note dedupe and post-write settlement from using an earlier
cached snapshot. An unavailable fresh read holds the stage without writing.

The public error contract distinguishes durable pending work, terminal expiry
and invalid recovery evidence. It exposes safe receipt/timing fields, never the
private key. Only a recognized durable pending read permits a read retry. A
receipt mismatch requires review. This grants no mutation replay permission.
The original mutation receipt, issue-6 settlement proof, stage checkpoints,
channel pinning, expired-run fences and prepared-plan checksum remain intact.

Private journal calls count toward the existing execution budget. Atomic open
and generation-checked checkpoints fail closed on storage failure or stale
updates. Each owner/workflow/hash-prefix shard holds at most 256 payload slots;
each slot retains at most eight earlier terminal references. The dispatcher's
original receipts retain the full request and attempt history. No new resource,
binding, secret, Access policy or producer registration is provisioned.

Node callers without the Durable Object binding retain the existing explicit
receipt contract; they do not claim durable cross-process journaling. Agent
recovery depends on the existing triage correlation being supplied on its calls.
No new public resume tool or independent read scheduler is added.

Validation covers repeated throttles across fresh executions, lost acknowledgements,
unreadable 504 responses, owner isolation, deadline immutability, stale-generation
rejection, terminal renewal rules, first-call synchronous failures, fresh
pre-write reads, mutation settlement preservation, fresh MCP Agent calls and a
complete real Worker restart using the production ledger class. All upstream
faults are synthetic; production throttling and business mutations are not
induced by verification.

Deployment uses the existing Git pipeline after the full MCP test/build gate.
Rollback must preserve issue-6 reconciliation, current credentials and bindings,
original dispatcher receipts and the existing ledger. Source/Worker snapshots
are not a backup of the live Durable Object database.
