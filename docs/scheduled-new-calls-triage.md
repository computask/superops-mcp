# Scheduled New Calls Triage

This is the version-controlled, paste-ready standing command for the `SO mcp v6` app. Update this document whenever the scheduled-policy schema or durable-recovery behaviour changes. Last reviewed against the current source tree on 2026-07-31.

```text
Using SO MCP v6, run the standing scheduled New Calls triage policy through to a terminal durable result. This instruction is standing authorisation for policyMode scheduled-new-calls-v1. Do not ask for per-ticket approval and do not stop after presenting a proposal.

Use Europe/London time.

READ PHASE

1. Call superops_tickets_triage_snapshot with:

- status: ["New Calls"]
- safeRead: true
- includeConversations: true
- includeNotes: true
- includeAttachments: metadataOnly
- latestFirst: true

2. Retrieve every page by following pagination.nextPage until it is null. Retain every candidate from every page in one fixed ordered list and use the snapshot's explicit completeness state. When upstream hasMore is null, the snapshot may be terminal only when all of these are true:

- pagination.complete is true and pagination.completeness is complete;
- pagination.totalCount is a valid finite non-negative count;
- the current page position plus the raw upstream row count reaches or exceeds totalCount;
- the list page succeeded and was not truncated; and
- the upstream response did not explicitly say hasMore:true.

Do not use the deduplicated candidate count as a substitute for raw upstream rows, and do not infer completion from page length alone. A smaller execution-safe page may still be complete when all rows covered by totalCount were returned; `truncated:true` or `completeness` of `budget_capped`/`truncated` remains incomplete and must be continued. If a null hasMore response does not satisfy the total-count rule, treat it as ambiguous and do not claim a complete aggregate.

3. Safely recover missing or truncated metadata, conversations and private notes with read-only safe ticket tools. Prefer superops_tickets_triage_evidence_recover for up to ten immutable internal ticket IDs in their frozen order. Use superops_tickets_get_safe for a single immutable internal ticket ID when individual follow-up is required. Use display-number reads only as a fallback or diagnostic aid.

Retry read-only failures and rate limits with bounded waits. Respect any retry delay returned by the tool. Never treat a retrieval failure, unsupported note shape, unavailable client value, truncation or rate limit as empty content.

If the list page itself remains rate-limited after the shared client's bounded read retries, the snapshot intentionally returns the existing top-level tool error rather than a partial candidate page. Retry the tool later; never interpret that error as an empty or complete queue. Per-ticket content-channel failures remain structured in the safe evidence response.

Do not retrieve attachment bodies.

4. Do not submit any mutation unless every fixed candidate has:

- verified content;
- a proven immutable internal ticket ID;
- an exact subject;
- expectedStatus New Calls;
- an exact updatedTime;
- proven canonical client state;
- complete required classification;
- exactly one contentEvidenceState from meaningful, empty or unavailable;
- exactly one policyReason supported by the verified evidence;
- exactly one policyDisposition; and
- exactly one approved structured private TRIAGE SUMMARY note string.

If complete evidence cannot be obtained for every candidate, perform no mutation and report the entire run as safely blocked.

STANDING POLICY DECISIONS

Assign exactly one of these policyDisposition values to every candidate:

- customer_request: genuine customer or requester work stays in New Calls using action leave.
- server_down: server, asset, agent, device or host down, offline, disconnected or not-responding notifications stay in New Calls using action leave.
- manual_intake: ambiguous work requiring intake, clarification or correlation stays in New Calls using action leave.
- engineer_review: actionable technical, security, backup, monitoring or machine-generated work moves only to Awaiting Engineer using action update.
- resolve_no_action: conclusively no-action administration, junk, newsletters, marketing or automated digests moves only to Resolved using action resolve.
- Microsoft Outlook Reaction Daily Digest tickets always use resolve_no_action.

Use exactly one policyReason consistent with policyDisposition:

- customer_request -> customer_or_requester_work
- server_down -> server_down_notification
- manual_intake -> ambiguous_or_empty_intake
- engineer_review -> actionable_engineer_work
- resolve_no_action -> one of no_action_administration, junk, newsletter_or_marketing, automated_digest or outlook_reaction_digest

Set contentEvidenceState from the frozen safe evidence:

- meaningful: at least one safe description, conversation or note item contains usable text. An optional channel may still have failed or been rate-limited; preserve that failure in warnings/errors/content availability and `degraded`, and do not treat meaningful as contentVerified;
- empty: all requested content channels were retrieved successfully but contain no usable content; or
- unavailable: no usable safe item exists and one or more required content sources failed, was truncated beyond safe recovery, rate-limited, unsupported or otherwise unproven. If every requested content channel fails, the state is unavailable.

contentEvidenceState unavailable blocks the entire batch. Empty content is not affirmative no-action evidence. An empty or unexplained ticket, including the ticket-59405 shape, must use manual_intake with action leave. It must not use resolve_no_action. The only subject-proven exception is a Microsoft Outlook Reaction Daily Digest, which must use resolve_no_action with policyReason outlook_reaction_digest.

Never select Waiting on third party, Awaiting Customer Reply, On Hold or any other status.

REQUIRED ACTION DATA

Create exactly one complete action for every candidate.

Every action must include:

- ticketNumber;
- expectedTicketId containing the immutable internal ticket ID;
- expectedSubject containing the exact snapshot subject;
- expectedStatus: New Calls;
- expectedUpdatedTime containing the exact snapshot updatedTime;
- contentVerified: true;
- contentEvidenceState containing the exact frozen evidence state;
- policyReason containing the exact supported reason class;
- the action matching its policyDisposition;
- exactly one policyDisposition;
- a complete target;
- note containing exactly one approved private TRIAGE SUMMARY note string; and
- isPublicNote: false.

For a proven existing non-null client, also set expectedClient to the exact canonical client name from the frozen evidence.

For resolve, update and leave:

- Set impact.
- Set urgency.
- Set category.
- Set subcategory.

For update and leave:

- Set cause when supported by the evidence.
- Cause is optional when it cannot be supported.
- Do not set resolutionCode.

For resolve:

- Set cause.
- Set resolutionCode.
- Set status: Resolved.
- Set suppressCloseNotification: true.

For update:

- Set status: Awaiting Engineer.

For leave:

- Omit status from the target.
- Retain New Calls.

CLIENT SAFETY

Preserve every proven existing non-null client and do not replace it.

When the canonical client is non-null:

- set expectedClient to the exact canonical client name;
- preserve both the proven client name and account ID;
- either omit clientName and clientId from the target or set both to the exact existing pair; and
- never submit a different or partial client target.

If the canonical client is null, target exactly:

- clientName: TaskGroup
- clientId: 2993553194649526272

Never interpret unavailable, missing, truncated, partial or failed client retrieval as a null client. If canonical client state cannot be proven for any candidate, do not submit the batch.

PRIVATE TRIAGE NOTE

Every action must contain exactly one approved private-note string in the note field, using plain text with one blank line between every section, formatted exactly as follows:

TRIAGE SUMMARY

Ticket goal: ...

What needs to be known: ...

Next step: ...

When: ...

Each section must contain specific, non-empty content derived from the verified ticket evidence.

Preserve the blank lines in the submitted note.

Do not use HTML, HTML tags, Markdown headings or literal formatting instructions in the note.

Set isPublicNote: false.

If an existing note is proven private, is an accurate TRIAGE SUMMARY for the current ticket evidence and goal, and remains suitable without modification, reuse its exact full normalised text as the action note so canonical deduplication prevents a duplicate physical note.

If an existing summary is no longer accurate because the ticket materially changed, supply one new accurate summary.

Exactly one note string must be approved per action. Its physical outcome may be Added or Deduplicated.

PROHIBITED ACTIONS

- Do not set priority.
- Do not set technician or assignee.
- Do not set techGroupName or assign a technician group.
- Do not send replies or emails.
- Do not add public notes or customer-visible content.
- Do not retrieve attachment bodies.
- Do not use skip.
- Do not use addNote.
- Do not use resolve/update fallback.
- Do not bypass stale-data checks.
- Do not write without verified content.

MUTATION SUBMISSION

Create one fixed ordered candidate list and exactly one action for every candidate in that same order.

Before submission, create one final disposition manifest containing, for every candidate in order: ticketNumber, expectedTicketId, expectedSubject, contentEvidenceState, policyReason, policyDisposition and action. Compare the manifest deterministically with the actual actions array. Do not submit if any narrative decision, policyDisposition, policyReason or action differs. Regenerate the action from the final manifest instead of reusing an earlier action template.

Submit the complete plan through superops_tickets_apply_triage_plan with:

- policyMode: scheduled-new-calls-v1
- expectedCandidateTicketNumbers: the exact fixed ordered candidate list
- actions: exactly one complete action for every candidate
- dryRun: false
- verify: true
- dedupeNotes: true
- stopOnFirstFailure: false
- allowResolveFullFallbackToUpdate: false
- allowWriteIfUpdatedTimeChanged: false
- allowWriteWithoutVerifiedContent: false

Make only one accepted full-plan submission and create at most one durable operation.

Follow only the operation returned by that submission. Never resubmit the complete action payload once the call may have reached the MCP server.

DURABLE OPERATION FOLLOW-THROUGH

Use superops_operations_get with the returned operation.durableOperationId when present, otherwise operation.operationId. Treat executionTraceId, executionOperationId, invocationId, workflowId and continuationInstanceId as diagnostic identifiers only. Use superops_operations_results when needed to locate or reconcile that same durable operation.

Follow that durable operation through automatic continuations, rate-limit rescheduling, delayed ambiguity reconciliation, controlled recovery and lease handoffs until it reaches a terminal state.

The durable ledger has a bounded continuation watchdog. When an acknowledged Workflow does not wake after nextEligibleTime plus the grace period, the watchdog may schedule the same operation again without crossing a SuperOps mutation boundary itself. It may do this at most three times. If no durable progress follows, the operation must terminalise safely as ContinuationWatchdogExhausted rather than remain Rescheduled indefinitely.

Respect nextEligibleTime. Do not busy-loop before the operation becomes eligible.

Read-only operation-status calls may be retried after bounded waits. A failed status read never authorises another full-plan submission or client-side mutation replay.

Never:

- replay or resubmit an uncertain write from the client;
- resubmit the complete plan;
- create a replacement operation;
- resume a terminal operation;
- change the candidate order;
- change an approved action;
- create a second operation or unrelated batchId for the same run; or
- infer rejection merely because an accepted write is not immediately visible.

CONTROLLED DURABLE RECOVERY

Do not prevent or treat as a policy violation the MCP server's built-in controlled recovery policy.

Within the same durable operation, the MCP server may issue one controlled recovery retry for a deterministic state-setting mutation only after the first bounded reconciliation pass durably classifies that mutation as ConfirmedNotApplied.

Such recovery must:

- remain within the same operationId and item;
- preserve the same approved action and expectedTicketId;
- use only effects still proven missing;
- never repeat accepted or already observed effects;
- persist RecoveryWriteStarted before the recovery call;
- have recoveryRetryCount no greater than one for that mutation stage;
- perform complete verification afterward; and
- enter a second bounded reconciliation pass if the recovery response is also ambiguous.

A different later mutation stage may have its own separate one-retry allowance only when it represents a different physical state-setting mutation and has not already consumed that allowance.

No third mutation attempt is permitted for the same mutation stage.

Do not initiate this recovery from the client. Follow and report the recovery performed by the same durable operation.

PRIVATE-NOTE RECOVERY BOUNDARY

createTicketNote is a non-idempotent create operation and has no approved client-side replay path.

If createTicketNote returns an ambiguous result:

- do not replay it;
- do not resubmit the action or plan;
- allow the durable operation to perform bounded read-only canonical private-note reconciliation;
- treat an observed exact private-note fingerprint as VerifiedSuccess;
- otherwise allow the note stage to terminate as AmbiguousUnresolved;
- require replaySafe:false and humanReconciliationRequired:true when it remains unresolved.

An ambiguous note create must never receive an automatic recovery write unless the current schema explicitly exposes a genuine server-enforced idempotency mechanism. Do not invent or infer such a mechanism.

COMPACT SAME-OPERATION RECOVERY

The operation status reports manualResumeAllowed, manualResumeReason, manualResumeCount, manualResumeLimit and updatedAt. If the same durable operation remains nonterminal beyond its eligibility or idle grace period, automatic continuation has not completed it, manualResumeAllowed is true, and the current superops_tickets_apply_triage_plan schema explicitly permits compact recovery, invoke one compact same-operation recovery boundary.

Compact recovery is durably limited to three boundaries for the whole operation. Each boundary requires a fresh operation-status read and must use that read's exact updatedAt. Never invoke compact recovery while manualResumeAllowed is false, while an item lease is active, before nextEligibleTime, during its grace period, or after manualResumeCount reaches manualResumeLimit.

For that compact recovery call:

- set batchId exactly to the returned operation.durableOperationId when present, otherwise operation.operationId;
- set expectedOperationUpdatedAt exactly to updatedAt from the latest superops_operations_get response;
- provide the original exact ordered expectedCandidateTicketNumbers;
- omit actions;
- omit policyMode;
- omit dryRun;
- omit verify;
- omit dedupeNotes;
- omit stopOnFirstFailure;
- omit allowResolveFullFallbackToUpdate;
- omit allowWriteIfUpdatedTimeChanged; and
- omit allowWriteWithoutVerifiedContent.

Continue following the same durable operation after compact recovery. Never submit another full action payload.

If it stalls again later and a fresh status read again reports manualResumeAllowed:true with manualResumeCount below manualResumeLimit, another compact recovery boundary may be used under the same rules. Never exceed the server-reported limit and never use compact recovery to change an approved action.

CONTROLLED CANCELLATION OF AN INVALID PLAN

If, after the one accepted full-plan submission, a deterministic manifest check proves that an approved action is wrong, do not let that incorrect plan continue and do not create a replacement operation. Read the same operation with superops_operations_get.

Only when the operation is nonterminal, no item lease is active, and the latest status is still current, call superops_operations_cancel once with:

- operationId: the exact durable operation ID;
- expectedUpdatedAt: the exact updatedAt from that latest status read; and
- reason: a bounded content-free reason identifying a policy/action consistency failure.

Cancellation never calls SuperOps. It atomically terminalises untouched items as CancelledBeforeWrite and preserves any accepted, partial or ambiguous evidence for reconciliation. If cancellation is refused because the operation changed or a lease is active, read status again; do not race the active invocation, do not change the plan and do not create another operation.

PRE-EXECUTION FAILURE RULE

Read-only calls may be retried after bounded waits.

A full apply call may be retried only when it is explicitly confirmed that the attempt was blocked before MCP-server execution and all of the following are true:

- no operationId was created or returned;
- there was no MCP-server receipt;
- the request could not have reached the mutation handler;
- writeAttempted is not true;
- writeMayHaveSucceeded is not true; and
- there is no possibility that any SuperOps write occurred.

In that exact pre-execution case only, retry the identical full apply call with byte-for-byte equivalent arguments, including the same candidate order, actions, note contents, whitespace and batchId if one was supplied.

Allow no more than five total full-apply attempts, including the first attempt. This means at most four retries.

Do not retry or resubmit the full apply call from the client after:

- a timeout;
- an unknown or interrupted response;
- an operationId;
- a possible MCP-server receipt;
- any indication that the handler began executing;
- writeAttempted: true;
- writeMayHaveSucceeded: true; or
- any uncertainty about whether a write occurred.

This restriction applies to client submission retries. It does not disable the same durable operation's internal one-retry state-setting recovery policy after ConfirmedNotApplied.

After any uncertain full-apply response, use superops_operations_results and superops_operations_get to locate, reconcile and follow the original durable operation. Never create or submit a replacement operation.

TERMINAL COMPLETION REQUIREMENTS

Do not claim that the run reached a terminal durable result unless:

- every snapshot page was retrieved;
- pagination.nextPage is null;
- the aggregate unique candidate count matches pagination.totalCount;
- every candidate's required evidence was complete or safely recovered;
- the original fixed ordered candidate list was preserved;
- exactly one durable item result exists for every fixed candidate;
- the durable operation is terminal;
- if the latest apply or compact-recovery response contains operation.complete, it is true;
- otherwise superops_operations_get reports state Completed, CompletedWithFailures, Failed or Cancelled;
- pendingCount is zero;
- waitingForRateLimitCount is zero;
- every candidate has a terminal item stage;
- operation-level counters agree with the authoritative durable item outcomes; and
- no nonterminal item remains retry-eligible, waiting or pending.

A terminal AmbiguousWriteUnresolved result is permitted only as a terminal failure. It must remain unresolved, must not be retried by the client, and must be clearly reported.

A terminal operation containing failures is a terminal durable result, but it is not an entirely successful triage run. Clearly identify every failed, stale, not-found, rate-limited, partially written or ambiguously unresolved item.

Do not claim that the triage run was entirely successful unless every item completed with verified success and there are no terminal failures, partial writes requiring reconciliation, unresolved ambiguities or human-reconciliation requirements.

If a final status, client or classification cannot be verified, report it as unknown or unverified. Do not infer or guess it.

TERMINAL REPORT

At terminal, report every candidate's:

- ticket number;
- subject from the frozen snapshot;
- policyDisposition;
- action;
- final status;
- final client;
- final impact;
- final urgency;
- final category;
- final subcategory;
- final cause where applicable;
- final resolutionCode where applicable;
- private-note outcome as Added, Deduplicated, Not attempted, Failed or Unverified;
- acceptedPhysicalWrites;
- completed durable stages;
- continuation attempt count;
- currentPauseReason for a nonterminal pause;
- currentSchedulingAttemptCount and totalSchedulingAttemptCount;
- watchdogWakeCount and lastWatchdogWakeAt;
- manualResumeCount and lastManualResumeAt;
- reconciliationDisposition;
- ambiguityEncountered;
- ambiguityMutationType;
- reconciliationPasses;
- reconciliationReadAttempts;
- recoveryRetryCount;
- recoveryRetryOutcome;
- observedRequestedEffects;
- missingRequestedEffects;
- conflictingEffects;
- verification result;
- partial-write state;
- ambiguous-write state;
- whether replay is safe;
- whether human reconciliation is required;
- initial failure reason and class where applicable; and
- terminal failure reason and class where applicable.

Treat RateLimitedPending as pending, not as a terminal Failed outcome. Historical recoverable rate limits belong in initial failure or recovery history. A verified successful item must not be reported with a terminal failure merely because it recovered from an earlier rate limit.

Report these operation totals:

- total fixed candidates;
- verified-success count;
- failed count;
- stale count;
- not-found count where exposed;
- accepted physical-write count;
- partial-write count;
- ambiguous-unresolved count;
- human-reconciliation count;
- unattempted count;
- pendingCount;
- waitingForRateLimitCount; and
- terminal durable operation state.

Treat ambiguousWriteCount as the current unresolved or pending ambiguity count. Do not count successfully recovered historical ambiguity as an unresolved ambiguous failure merely because ambiguityEncountered remains true.

Clearly identify anything incomplete.

Confirm explicitly that:

- no public note was added;
- no customer reply or email was sent;
- no individual technician was assigned;
- no technician group was assigned;
- no attachment body was retrieved;
- no ticket outside the frozen New Calls snapshot was modified;
- no accepted or already observed classification, client, note or status effect was repeated;
- no uncertain full-plan submission or mutation was replayed by the client;
- no ambiguous createTicketNote call was replayed;
- any state-setting recovery retry was performed only by the same durable operation after ConfirmedNotApplied, used only missing effects and occurred at most once per mutation stage; and
- no replacement durable operation was created.
```

The Worker enforces the mechanical standing-policy contract before it creates an operation or calls SuperOps. Semantic assessment of the safe ticket evidence remains the operator's responsibility; `policyDisposition` makes that decision auditable and binds it to the permitted action/status mapping.
