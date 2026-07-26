# Continuation Operations Runbook

This runbook covers the checkpointed `superops_tickets_apply_triage_plan` continuation. The operation ledger is authoritative; scheduling or Workflow delivery is never itself a success signal. Inspect `superops_operations_get` until every expected item is terminal.

## Safety model

The Durable Object owns operation identity, owner hash, exact candidates, claims, leases, checkpoint stages, retry metadata, and compact redacted results. It is created before the initial adapter performs a SuperOps call. Duplicate delivery is expected and safe only because the adapter must acquire the owner-scoped item lease and reconcile persisted state.

| Surface | Contract | Durable/resumable | Default |
| --- | --- | --- | --- |
| Apply-triage update, resolution, private note | Durable pre-mutation and accepted-response checkpoints; stale checks; read-back ambiguity reconciliation | Yes | Available |
| Direct ticket create/update/note/log-time/resolve-full | Conservative synchronous write-attempt/ambiguity result; no automatic retry | No | Blocked |
| Alert create/resolve | Conservative synchronous write-attempt/ambiguity result; no automatic retry | No | Blocked |
| Custom mutation | Bounded opaque mutation; no retry; ambiguous possible write remains unresolved | No | Blocked |
| Reviewed read and operation-status tools | Bounded read contract | Not applicable | Available |

Use durable apply-triage as the primary production write path. Do not enable a synchronous mutation merely to bypass its missing durable adapter.

## Compact recovery envelope

If an existing owner-scoped operation is nonterminal and automatic delivery has not advanced it, call `superops_tickets_apply_triage_plan` with only the stored operation ID and its exact ordered candidate list:

```json
{
  "batchId": "existing-operation-id",
  "expectedCandidateTicketNumbers": ["ticket-1", "ticket-2"]
}
```

Omit `actions`, `dryRun`, `verify`, `dedupeNotes`, `stopOnFirstFailure`, and every override flag. The Durable Object supplies the already-approved plan and encrypted private-note recovery content. Candidate order is part of the approval identity. Wrong ownership, a changed candidate list, any supplied flag, missing pending items, or a terminal operation fails closed. The adapter claims only pending durable items, so completed writes cannot be replayed. This is recovery through the existing public mutation; it does not add a public resume or cancel tool.

## Checkpoint lifecycle

Every expected candidate has a ledger item before processing begins.

- Update: `Validated` -> `WriteNotStarted` -> `WriteStarted` -> `FieldsUpdated` -> `Verifying` -> terminal.
- Resolution: `Validated` -> `ResolutionValidated` -> `ResolutionWriteStarted` -> `ResolutionWriteSucceeded` -> `ResolutionVerified` -> optional note stages -> `Verifying` -> terminal.
- Note: `NoteChecked` -> `NoteWriteStarted` -> `NoteAdded` -> `Verifying` -> terminal.

Mutation-start state is acknowledged before the outbound mutation. Successful response state is acknowledged before later work; `NoteAdded` includes the created note ID. A crash at any possible-write boundary resumes with reconciliation, never a blind replay. Terminal items cannot reopen, write truth cannot move backwards, and stale lease tokens cannot commit.

## Workflow wake diagnostics

`superops_operations_get` exposes the safe scheduling and delivery fields required to distinguish creation, wake, delivery, and execution: `continuationMechanism`, `continuationInstanceId`, `schedulingAttempted`, `schedulingSucceeded`, `schedulingError`, `schedulingAttemptCount`, `wakeAttemptCount`, `wakeDeliveryCount`, `lastWakeAttemptAt`, `lastWakeSucceededAt`, `wakeDeliveryError`, and `wakeDeliveryExhaustedAt`. A `Rescheduled` operation more than two minutes beyond `nextEligibleTime` is reported with `derivedState: "Stalled"` and a reason based on those durable counters; this projection does not mutate the ledger.

Workflow batch creation is successful only when `createBatch` acknowledges the requested deterministic instance ID. A Workflow delivery that reaches the internal continuation route before the exact durable eligibility instant receives retryable HTTP 425 rather than false HTTP 200 success, so the configured Workflow retry executes it again without replaying a possible write.

## Limits, waits, and retention

Committed defaults keep `ENABLE_WRITE_TOOLS=false`, `ENABLE_CUSTOM_MUTATION=false`, `CHATGPT_DIRECT_ALLOW_MUTATING_TOOLS=false`, `SUPEROPS_CONTINUATION_ENABLED=false`, and `SUPEROPS_DURABLE_RETRY_ENABLED=false`. The reviewed durable apply-triage tool is allowed by the central policy even while unreviewed synchronous writes are blocked.

Long Retry-After waits use `SuperOpsContinuationWorkflow.step.sleepUntil`. Workflow parameters contain only operation ID, owner hash, eligibility time, and deterministic schedule identity. Credentials and customer content are not Workflow parameters. Durable Object alarms independently enforce maximum operation lifetime and terminal-record expiry; they never execute SuperOps mutations.

Configured ceilings include 500 operation items, 512 KiB serialized record size, 25 seconds per invocation, 10 seconds per SuperOps request, 20 seconds cooperative CPU guard, 100 continuations, 10 durable throttle attempts, one hour cumulative durable delay, 15 minutes per durable wait, and 8 Workflow scheduling attempts with exponential backoff capped at 500 ms. Exhaustion produces a terminal classified result rather than an infinite loop.

The `SUPEROPS_OPERATION_RETENTION_SECONDS` window starts when an operation first becomes terminal, so long-running work still retains its final, partial-write, and ambiguity evidence for the full configured period. Active work is bounded separately by `SUPEROPS_OPERATION_MAX_LIFETIME_SECONDS`; non-terminal evidence is not deleted merely because the original creation-time window elapsed.

## Local validation (no external resource change)

Run from the repository root in an unrestricted PowerShell session:

```powershell
npm ci
npm test
npm run test:continuation-harness
npm run build
npm run typecheck
npm run lint
git diff --check
git status --short
git diff --stat
git diff
node -p "require('./node_modules/wrangler/package.json').version"
node -e "const fs=require('fs');const Ajv=require('ajv');const schema=JSON.parse(fs.readFileSync('node_modules/wrangler/config-schema.json','utf8'));const config=JSON.parse(fs.readFileSync('wrangler.json','utf8'));if(!new Ajv({allErrors:true,strict:false}).validate(schema,config))process.exit(1)"
npx wrangler deploy --dry-run --config wrangler.json
```

Expected pinned Wrangler version: `4.111.0`. Wrangler 4.111.0 requires Node.js 22 or newer for Wrangler validation commands; the MCP server runtime itself retains its declared Node.js 20-or-newer support. The schema check is non-deploying. `--dry-run` builds and validates without deployment but may create workspace-local `.wrangler` output; remove only artifacts created by that validation after inspecting their exact paths.

## Staging rollout

Durable approved private-note recovery requires SUPEROPS_PRIVATE_NOTE_ENCRYPTION_KEY as a Cloudflare secret. Generate and manage it independently from SUPEROPS_INTERNAL_CONTINUATION_TOKEN; neither value belongs in Wrangler configuration or source control.

Every command in this section changes external Cloudflare resources and requires explicit human approval. Use an independently reviewed `wrangler.staging.json` with distinct staging Worker, Workflow, Durable Object migration/binding, routes, vars, and service binding; never point staging at the production ledger.

```powershell
# RESOURCE-CHANGING: stores/rotates the staging internal continuation secret.
npx wrangler secret put SUPEROPS_INTERNAL_CONTINUATION_TOKEN --config wrangler.staging.json

# RESOURCE-CHANGING: stores/rotates the distinct staging private-note encryption secret.
npx wrangler secret put SUPEROPS_PRIVATE_NOTE_ENCRYPTION_KEY --config wrangler.staging.json

# RESOURCE-CHANGING: deploys the staging Worker, Workflow, bindings, and migrations.
npx wrangler deploy --config wrangler.staging.json
```

Deploy initially with both continuation flags false. Smoke-test `/health`, `superops_status`, operation-status tools, and read-only lists. Run the fixed-seed harness outside the restricted sandbox. Then exercise an approved staging-safe low-budget stop, conclusive HTTP 429, GraphQL throttle, wait longer than one request lifetime, stale change during wait, duplicate Workflow delivery, and lost-response update/resolution/note. Confirm all expected items are accounted, no invocation exceeds its configured effective budget, and duplicate successful updates/resolutions/private notes are zero.

Only after retaining that evidence may an approved operator set staging `SUPEROPS_CONTINUATION_ENABLED=true` and `SUPEROPS_DURABLE_RETRY_ENABLED=true` and redeploy. Changing vars and redeploying are resource-changing actions.

## Production rollout

The following commands change production resources and require a separate explicit approval:

```powershell
# RESOURCE-CHANGING: stores/rotates the production internal continuation secret.
npx wrangler secret put SUPEROPS_INTERNAL_CONTINUATION_TOKEN --config wrangler.json

# RESOURCE-CHANGING: stores/rotates the distinct production private-note encryption secret.
npx wrangler secret put SUPEROPS_PRIVATE_NOTE_ENCRYPTION_KEY --config wrangler.json

# RESOURCE-CHANGING: deploys the production Worker, Workflow, bindings, and migrations.
npx wrangler deploy --config wrangler.json
```

First deploy with both continuation flags false. Smoke-test only read and status tools. Review staging evidence and pending operation inventory. Enabling continuation requires an approved config change plus another approved deploy. Keep synchronous write and custom mutation flags false; use approved fixed-candidate apply-triage for production writes.

## Rollback with pending Workflows and alarms

1. RESOURCE-CHANGING: set both continuation flags false and deploy the configuration.
2. Do not remove the internal route, token, self service binding, Workflow class/binding, or Durable Object while Workflow instances may still deliver.
3. Inventory every non-terminal operation ID and retain status/results. A pending Workflow delivery may still arrive, but it must pass token, owner, lease, stale, checkpoint, verification, and dedupe guards.
4. Allow pending operations to reach a reviewed terminal result or investigate them manually. Do not fabricate completion and do not delete ambiguity evidence.
5. Keep cleanup-only Durable Object alarms and the ledger binding until retained terminal records expire.
6. Only after no pending operation depends on the old code may an approved operator deploy a previous Worker version. Git reversion and Cloudflare deployment are separate actions.

## External validation still required

A restricted environment may deny Vitest/Vite/Wrangler esbuild child processes with `spawn EPERM`. That is an environment limitation, not a passing test result. Run the full tests, dedicated harness, and Wrangler dry-run in an unrestricted environment before staging. No live SuperOps mutation is part of local validation.
