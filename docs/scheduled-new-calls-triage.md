# Scheduled New Calls Triage

Use the following text as the single daily scheduled ChatGPT instruction with the `SO mcp v6` app. The `scheduled-new-calls-v1` policy mode is standing authorization for this exact workflow, so ChatGPT must not pause for a per-ticket approval table.

```text
Using SO mcp v6, run the standing scheduled New Calls triage policy through to a terminal durable result. This instruction is standing authorization for policyMode scheduled-new-calls-v1. Do not ask for per-ticket approval and do not stop after presenting a proposal.

Read phase:
1. Call superops_tickets_triage_snapshot for status New Calls with safe content, conversations, private notes, and attachment metadata. Follow every page until nextPage is null and the unique candidate count exactly matches totalCount. Never treat hasMore:null as complete unless nextPage is null and the unique count matches totalCount.
2. Recover missing or truncated safe metadata, conversations, and notes with read-only safe ticket tools. Use the internal ticket ID for note reads. Retry only read-only failures or rate limits with bounded waits. Never treat retrieval failure, an unsupported note shape, or rate limiting as an empty note list.
3. Do not submit a mutation unless every fixed candidate has verified content, canonical client state, immutable snapshot fields, full classification, one policy disposition, and one private structured triage note. If complete evidence cannot be obtained for every candidate, perform no mutation and report the whole run as safely blocked.

Standing decisions:
- customer_request: genuine customer or requester work stays in New Calls with action leave.
- server_down: server, asset, agent, device, or host down/offline notifications stay in New Calls with action leave.
- manual_intake: ambiguous work needing intake or correlation stays in New Calls with action leave.
- engineer_review: actionable technical, security, backup, monitoring, or machine-generated work moves only to Awaiting Engineer with action update.
- resolve_no_action: conclusively no-action administration, junk, newsletters, marketing, or automated digests move only to Resolved with action resolve. Microsoft Outlook Reaction Daily Digest tickets use resolve_no_action.
- Never choose Waiting on third party, Awaiting Customer, On Hold, or any other status.

Required action data for every candidate:
- Include expectedTicketId, exact expectedSubject, expectedStatus New Calls, exact expectedUpdatedTime, and contentVerified true.
- Set impact, urgency, category, and subcategory on resolve, update, and leave. Set cause when supported by evidence; cause is optional for update and leave. Set cause and resolutionCode for resolve.
- Preserve every proven existing client. When canonical client is null, target exactly clientName TaskGroup and clientId 2993553194649526272. If client retrieval is unavailable, do not submit the batch.
- Do not set priority, technician, assignee, or techGroupName. Do not send a reply, email, public note, or customer-visible content.
- Every resolve must set status Resolved and suppressCloseNotification true.
- Every update must set status Awaiting Engineer.
- Every leave must omit status and retain New Calls.
- Every action must include isPublicNote false and a private note in exactly this structure, with specific non-empty content:
  TRIAGE SUMMARY
  Ticket goal: ...
  What needs to be known: ...
  Next step: ...
  When: ...
- If an existing proven-private TRIAGE SUMMARY remains accurate for the current evidence and goal, reuse its exact full normalized text as the action note so canonical dedupe prevents a duplicate. If it is no longer accurate because the ticket materially changed, write one new accurate summary.

Mutation and recovery:
1. Create one fixed ordered candidate list and exactly one action per candidate. Do not use skip or addNote actions.
2. Call superops_tickets_apply_triage_plan once with policyMode scheduled-new-calls-v1, the exact candidate list and complete actions. Set dryRun false, verify true, dedupeNotes true, stopOnFirstFailure false, allowResolveFullFallbackToUpdate false, allowWriteIfUpdatedTimeChanged false, and allowWriteWithoutVerifiedContent false.
3. Follow only the returned durable operation with superops_operations_get and superops_operations_results until terminal. Respect nextEligibleTime and rate-limit rescheduling. Never create a replacement operation and never resubmit the full action payload.
4. If the same operation remains nonterminal after its eligible time and the current tool schema explicitly permits compact recovery, call superops_tickets_apply_triage_plan for that same operation exactly once with only batchId and the exact ordered expectedCandidateTicketNumbers. Omit actions, policyMode, and every override flag. Continue following the same durable operation.
5. Report every candidate, its disposition, classification, client assignment or preservation, private-note added/deduped outcome, physical writes, final status, and verification. A nonterminal operation is not success; keep following it or report the exact durable blocker.
```

The Worker enforces the mechanical contract before it creates an operation or calls SuperOps. Semantic assessment of safe ticket evidence remains ChatGPT's responsibility; the explicit `policyDisposition` on every action makes that decision auditable and binds it to the permitted action/status mapping.