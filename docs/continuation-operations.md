# Continuation Operations Runbook

This runbook covers the checkpointed `superops_tickets_apply_triage_plan` continuation only. It does not turn scheduling into a success signal: inspect `superops_operations_get` and per-item results until every expected item is terminal.

## Safety model

The Durable Object is the authority for the operation, owner hash, item claims, checkpoint stage, retry metadata, and compact redacted results. A continuation may be delivered more than once. Before every mutation-capable triage stage the adapter owns a claim, re-reads the ticket, validates identity and `updatedTime`, and persists the mutation checkpoint. A possible-write failure becomes an ambiguity-verification stage; it is never blindly replayed.

| Surface | Current contract | Durable/resumable |
| --- | --- | --- |
| Apply-triage update, resolution, private note | checkpointed, stale-checked, verified where requested; ambiguous writes are read before any replay | Yes |
| Alert create/resolve | one request, optional final-state verification; no automatic write retry | No |
| Direct ticket create/update/note/log-time/resolve-full | one request or bounded synchronous workflow; no automatic write retry; may report a partial write where the tool can observe it | No |
| Custom mutation | opaque request; no retry; possible write returns `AmbiguousWriteUnresolved` | Intentionally no |

Direct tools are intentionally synchronous and must not be described as durable continuation support. Before extending a direct write, add a canonical target, mutation-start checkpoint, read-back verification, and an owner-scoped ledger adapter.

## Limits and retention

`SUPEROPS_CONTINUATION_ENABLED` and `SUPEROPS_DURABLE_RETRY_ENABLED` default to `false`; both must be true before durable alarm scheduling is enabled. A long rate-limit wait persists the exact stage, releases its lease, and schedules one Durable Object alarm per operation. The alarm input/state contains compact operation identifiers only; caller credentials, notes, ticket descriptions, conversations, and attachments are never stored.

- `SUPEROPS_OPERATION_RETENTION_SECONDS` controls terminal record expiry (default 86400).
- `SUPEROPS_OPERATION_MAX_LIFETIME_SECONDS` caps active operation lifetime (default 21600).
- Expired terminal records may be removed. Non-terminal and possible-write records are retained so ambiguity evidence is not lost.
- Maximum item/budget/retry/delay limits are configured by the `SUPEROPS_EXECUTION_*` variables in `wrangler.json`.

## External validation

Run these from the repository root in an unrestricted PowerShell session before any manual commit or deployment:

```powershell
npm test
npm run test:continuation-harness
npm run build
npm run typecheck
npm run lint
git diff --check
git status --short
git diff --stat
git diff
git log --oneline --decorate -20
git rev-list --count origin/main..HEAD
```

If Wrangler is installed for the pinned project dependencies, perform only a local, non-deploying configuration check:

```powershell
npx wrangler --version
npx wrangler dev --test-scheduled
```

Stop the local Worker after configuration/startup validation. Do not use `wrangler deploy`, `wrangler secret put`, or a live mutation as part of local validation.

## Staging rollout

These steps change Cloudflare resources and require explicit human approval:

1. Review the local commits and validation output, then manually approve a push.
2. Select or create the staging Worker and configure the Durable Object binding/migration represented by `wrangler.json`.
3. Configure the service binding named `SUPEROPS_CONTINUATION_SERVICE` to the staging Worker.
4. Set `SUPEROPS_INTERNAL_CONTINUATION_TOKEN` through the Cloudflare secret UI or approved secret-management workflow; never place its value in source or command history.
5. Deploy with both continuation flags set to `false`.
6. Smoke-test `superops_status`, `superops_operations_get`, `superops_operations_results`, and one read-only SuperOps tool.
7. Use mocked/staging-safe tests to exercise a low-budget stop, a short 429, and a long Retry-After durable wake. Confirm the resumed item is re-read and stale changes are skipped.
8. Run one explicitly approved low-risk write. Verify update, resolution, and note mutation counts are each at most one for their item.
9. Deliberately enable both flags only after the previous evidence is retained in the operation ledger, then monitor ambiguous, stale, partial-write, and scheduling-failure outcomes.

## Production rollout and rollback

For production, repeat the staging evidence review, restore conservative limits from the approved configuration, configure the production internal token by approved secret management, verify bindings, and deploy with both continuation flags disabled. Smoke-test read-only tools first. Enable continuation deliberately, run one controlled approved operation, and monitor operation results.

For rollback, disable both continuation flags first. Do not delete the Durable Object or its records while retention evidence is required. Neutralise pending alarms by disabling continuation and let the persisted record remain visible; an already delivered alarm still enters the claim/checkpoint adapter and cannot directly replay a mutation. Revert the Worker deployment only after preserving operation IDs/results needed for investigation. Revert Git commits separately if required; no rollback step should erase a partial-write or ambiguity record before retention expiry.

## ChatGPT direct mutation boundary

The ChatGPT direct route derives its default blocklist from the registered tool inventory. Only `superops_tickets_apply_triage_plan` is a reviewed checkpointed mutation workflow. Direct ticket writes (`create`, `update`, `resolve_full`, `add_note`, `log_time`), alert `create`/`resolve`, and `superops_custom_mutation` are synchronous and blocked by default. Read-only tools and `superops_operations_get` / `superops_operations_results` remain available. `CHATGPT_DIRECT_ALLOW_MUTATING_TOOLS=true` is an explicit disabled-by-default override and must be reviewed before use.
