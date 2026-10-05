# Authorized API channel replacement, 2026-10-05

This supersedes the completion prescription in
`triage-release-evidence-2026-10-04.md`. An older stored channel instruction
does not establish the entire effective runtime prompt. Official trigger/run
documentation does not establish that an API channel must be recreated to
update Agent instructions:
https://developers.openai.com/workspace-agents/trigger-runs

The user authorized a replacement after the supported channel management
plugin remained unavailable. The original Agent and channel are preserved.
The replacement was duplicated through the normal ChatGPT Agent editor and
published privately with the existing healthy shared SuperOps and callback
connections. Historical-ticket access remains paused. No approval requirements
were removed and no durable coordinator state or failed scope was reset.

## Verified published configuration

- Agent: `agt_6ac3afed07308191b5d76797a47cb9c7`
- Name: SuperOps Triage API 2026-10-05
- Published version: `agtv_6ac3b36b977c8191b52de6910ced7f39` (8)
- API channel: `agtch_6ac3b3695f8c8191811c41b71ef650cc`
- Canonical instruction contract: `2026-10-04.1`
- Published policy-text SHA256:
  `dd0701b3404f8340c1af94f28c132cbff5dcdacd3a8c0454c87d1334dac12e3f`
- New channel guidance: `Run this agent from the API channel.`

The new channel's default guidance is separate from the full published Agent
policy. It is not a second full policy snapshot. Do not make equality between
these two different fields a release requirement. Runtime behaviour still
requires a controlled automatic-path test.

## Concrete HTML constraint defect

The duplicated OpenAI action constraint required a literal space immediately
after every required bold label. A note using `</strong><br>` therefore failed
the schema before reaching MCP. This matches the formatting captured for
ticket 63473; it does not establish the hidden rationale for separate
unacceptable-risk decisions.

The replacement's Scheduled triage HTML note shape constraint now accepts
content after inline whitespace or an HTML break. Required labels/order,
nonempty bodies, supported optional sections and private-note-only enforcement
remain. The other Email-trigger triage safety bounds constraint is unchanged.
Both saved constraint objects were compared against their reviewed versions
in the normal UI publication response.

The reviewed schema is `agent/superops-triage-html-note-constraint.json`.
Four regression tests cover the actual rejected format, empty sections,
required structure, optional historical content and private notes. Focused
regressions passed. Release checks passed: 716 Vitest tests, three policy-text
checks, the canonical contract checker, the TypeScript build, 74 trigger
recovery tests plus the isolated trigger verification harness, trigger build
and `git diff --check`.

## Cutover and rollback

Only the trigger URL changes in the trigger Worker configuration. Existing
bindings, namespace, secrets, intake scope, cooldowns, rate fences and approval
controls are preserved. Previously accepted runs retain their original run
identity; no old mutation scope is replayed.

Rollback is a normal Git revert of the URL change to
`agtch_6aa8549398188191ab83ec01e16bf474`, followed by the Git-connected build.
It restores the previous channel and its known limitations; it does not erase
queued runs or operation history.

Credential-redacted live source/configuration backups were saved privately in
`.wrangler/triage-channel-2026-10-05/`. Baseline active Worker versions were
`612719eb-be89-4690-9970-6feed3da6ff7` (MCP) and
`d89fa536-a2a9-4c36-abbc-b027ae738757` (trigger).

The task remains incomplete until a bounded fresh automatic intake run has
independent terminal-result, ticket-field and single-private-note verification.
HTTP 202, publication or an intent callback alone is insufficient.
