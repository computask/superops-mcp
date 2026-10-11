# Confirmed failed reads before triage apply

Two upstream HTTP 401 replies exposed a mismatch: the coordinator retried an
Agent, but the automatic read journal retained its terminal failed receipt.
The next Agent therefore received the same failure without a new upstream read.
The failed first query was also mistaken for a successful empty query and its
window was widened. An empty 401 reply does not establish why SuperOps rejected
the request; this repair changes recovery, not credentials or upstream policy.

The MCP now records a typed, content-free failed-read observation through the
private coordinator binding. Only the bounded query, canonical evidence recovery
and field-options tools are eligible. The receipt must be definitively failed,
with a recognized HTTP failure (401, 408, 429, 500, 502, 503 or 504), timeout,
network error or rate-limit classification. Pending, unknown, cancelled and
uncertain receipts never receive this exception. Synchronous failed HTTP replies
retain their observed status and HTTP_ERROR classification in the read journal.
Other definite HTTP failures, including 400, 403 and 404, are observed so the
coordinator can stop immediately. They never receive a renewal grant. A guarded
terminal read without an independently recorded receipt also stops with
attention instead of falling through the older generic Agent retry. Live
verification exposed an empty HTTP 400 reply being reread by successive Agents;
it did not establish whether the upstream cause was a query or infrastructure
error. Tests reproduce that asynchronous reply and prohibit a new POST.

For a terminal callback, the coordinator requires the enforced start/write guards
and bounded-terminal-read-v1 capability, the exact current scope, and no
preparation, apply intent, operation, write check, authorized item, unknown tool
work or observed denial in any attempt. It atomically fences the old attempt,
retains the original window and grants renewal of only the failed receipt's
owner/workflow/payload identity. Grants survive restart and carry across the
next attempts, so an options failure followed by a query failure can recover
both receipts. Each new journal generation links its predecessor and retains
the original dispatcher receipt. Mutation keys and replay rules are unchanged.

There are at most two recovery attempts for the workflow and two renewals per
failed read. A fixed deadline is the earlier of ten minutes after the original
accepted attempt or its stored read deadline. It is never extended by another
failure or wake. Expiry, exhausted attempts, unavailable capability, possible
writes or observed denial stop automatic retry and preserve an attention fence.
A failed query is never proof of an empty result: empty-window recovery requires
the current server-observed complete query with no candidates or failure
diagnostics. Fresh authoritative reads, immutable ticket identity, stale-data
checks, preparation, normal action review, private-note dedupe, verification and
uncertain-write reconciliation remain mandatory.

For historical 401 failures after their deadline, Sam can use
POST /admin/triage-read-failure-recovery with triggerId, attempt (1..3),
sourceEventId, ticketNumber and dryRun. The Access-protected MCP independently
retrieves every retained attempt's complete capture page, requires positive 401
evidence and read-only tools in each attempt, and projects only fixed ticket
identity, scope, capture IDs and failed receipt IDs. Gaps, partial captures,
mutations, preparation or missing candidate identity refuse recovery. The
coordinator independently checks the terminal failure history, all attempt
leases, original scope, old-attempt fencing, current provider completion and
one-shot replay history. Preview has no side effects. Scheduling creates a new
exact-ticket assessment in the original history window; it does not reuse an
expired failed read or replay a mutation. Prior receipt references remain in
history, and the old attention scope remains fenced. Normal Agent review and
all MCP apply safeguards still run.

Generic provider run_failed remains a separate case. The documented Workspace
Agents status API does not return workflow steps or the Agent's response. Empty
MCP captures alone cannot establish that no platform denial occurred. Automatic
startup retry remains limited to positively classified dispatch_failed before
work. A generic failure requires the existing Sam-only inspected provider proof
route, including a complete zero-work workflow, retryable provider error and no
denial or elicitation. Do not claim generic startup failure is automatically
resolved by this read-journal change.

Validation reproduces an options 401 followed by a first-query 401 through the
actual coordinator, real MCP/client/journal receipt renewal, cold durable objects,
exact-receipt grants, persistent-failure limits and protected terminal cases.
Separate regressions cover authenticated historical previews, full capture
corroboration, possible-write/denial refusal and one-shot exact-ticket scheduling.
Tests use synthetic data and make no live upstream calls.

Deploy both Workers through the existing Git pipelines after full MCP and
coordinator test/build gates. The new coordinator checks the MCP capability
before granting renewal, so mixed versions fail closed. Verify both active
versions and runtime protocols, stable Durable Object bindings and secret names
before live recovery. Rollback through Git, preserving all existing operation
and receipt state. Code/settings backups are not a Durable Object database backup.
