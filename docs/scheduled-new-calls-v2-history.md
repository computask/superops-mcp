# Scheduled New Calls Triage v2

`scheduled-new-calls-v2` is a parallel contract for the existing durable
`superops_tickets_apply_triage_plan` path. It does not replace or alter
`scheduled-new-calls-v1`, and it does not make the SuperOps MCP call Supabase or
the Ticket History connector.

## History boundary

The Agent or its separately configured history connector performs bounded
historical checks before it submits the fixed action plan. The MCP receives the
result as safe metadata only. A history lookup may return `unknown`,
`unavailable` or `degraded`; those states are explicit and must never be
interpreted as no history.

Every v2 action must include `historyAssessment` with these controlled states:

- `issueRecurrence`: `recurrent`, `not_recurrent` or `unknown`;
- `solutionHistory`: `prior_solution_found`, `no_prior_solution_found` or `unknown`;
- `postSolutionRecurrence`: `observed_recurrence`,
  `no_observed_recurrence_in_window` or `follow_up_unknown`;
- `crossClientSignal`: `none`, `watch`, `credible` or `unknown`;
- `emergingIssueSignal`: `none`, `watch`, `credible` or `unknown`;
- `resultState`: `complete`, `no_matches`, `unavailable`, `degraded` or `unknown`.

Counts, lookback, and at most five representative ticket numbers are bounded.
Optional summaries are short plain-text metadata only. Bodies, attachments,
ticket dumps, HTML, line breaks, credentials and private-key markers are
rejected. `credible` cross-client or emerging-issue evidence requires a
complete result and at least two verified distinct clients. Same-client or
same-requester recurrence is not cross-client evidence.

Historical solutions are observations, not guarantees. A current script
recommendation is advisory and must not be presented as a promised fix. If the
assessment includes `currentScriptRecommendation`, the note must include the
corresponding section.

## V2 note

The private note must use HTML labels and two line breaks between sections. The
core sections are always required:

```html
<strong>TRIAGE SUMMARY</strong><br><br>
<strong>Ticket goal:</strong> ...<br><br>
<strong>What needs to be known:</strong> ...<br><br>
<strong>Next step:</strong> ...<br><br>
<strong>When:</strong> ...
```

Add these history sections only when their state is relevant and supported:

- `Historical issue` only for `issueRecurrence: recurrent`;
- `Historical solution` only for `solutionHistory: prior_solution_found`; and
  `Post-solution recurrence` only for `postSolutionRecurrence:
  observed_recurrence` with a prior solution;
- `Cross-client signal` only for `crossClientSignal: watch` or `credible`; and
- `Emerging issue` only for `emergingIssueSignal: watch` or `credible`.

For no matches, no prior solution, unavailable/degraded/unknown history, and
no-signal states, omit the corresponding sections rather than writing an empty
or negative section. The structured `historyAssessment` still records those
states for auditability.

Add this section only when a non-empty recommendation is present, immediately
before `Next step`:

```html
<strong>Current script recommendation:</strong> Advisory recommendation only ...<br><br>
```

The server checks the required labels, non-empty sections, relevant optional
sections, controlled state wording (including clear human-readable
equivalents), `<strong>` labels and `<br><br>` spacing. The Agent should put
the canonical state phrase first in each included history section to avoid an
unnecessary validation retry. Dynamic values must be HTML escaped by the
Agent. Existing v1 notes remain governed by the v1 validator.

## Call and rollout boundary

V2 reuses the same bounded snapshot, fixed candidate list, one durable apply
operation, stale-data checks, note dedupe, write checkpoints, verification and
continuation. It adds zero SuperOps history reads and no post-apply note
rewrite. If history enrichment is unavailable, submit explicit `unknown`
metadata or keep the candidate safely pending according to the Agent policy;
never widen the queue to compensate.

Only a genuinely credible bounded cross-client observation should be passed to
the existing `superops_triage_emerging_issue_upsert` path. That upsert remains
separate from the per-ticket apply plan and must not be used for same-client or
same-requester recurrence.

To roll back immediately, change the Agent policy mode back to
`scheduled-new-calls-v1`. The v1 code path and its standing instruction remain
unchanged.
