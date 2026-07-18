# ADR: Execution Budget, Rate Limits and Operation Ledger

Date: 2026-07-18
Status: implemented for triage ledger/status, triage continuation adapter, and disabled-by-default service-binding continuation

## Context

The MCP runs in Cloudflare Workers, where invocation-level limits are not reset by sleeping inside the same invocation. The production failure showed that a multi-ticket triage write can partially mutate SuperOps and then terminate before returning a complete result. SuperOps upstream rate limiting is a separate problem: a 429 or GraphQL throttle may be retriable after a delay, but each retry still consumes the current Worker budget.

Official Cloudflare references used for this decision:

- Durable Objects overview: https://developers.cloudflare.com/durable-objects/
- Durable Object storage API, including SQLite-backed storage: https://developers.cloudflare.com/durable-objects/api/storage-api/
- Durable Object alarms: https://developers.cloudflare.com/durable-objects/api/alarms/
- Wrangler configuration and Durable Object `exports`: https://developers.cloudflare.com/workers/wrangler/configuration/
- Workflows overview: https://developers.cloudflare.com/workflows/
- Queues overview: https://developers.cloudflare.com/queues/

## Options Considered

| Option | Use | Decision | Reason |
| --- | --- | --- | --- |
| SQLite-backed Durable Object | Strongly consistent operation ledger, per-operation item state, owner checks, local testability | Selected | Provides a small durable authority for operation status without repurposing OAuth KV. Wrangler supports module `exports` for new DO classes. |
| Cloudflare Workflows | Durable multi-step execution, sleep, retries | Deferred | Official Workflows support durable steps and sleep, but this project now uses a simpler service-binding fresh-invocation trigger for triage continuation. Workflows remain the preferred later mechanism for long rate-limit sleeps. |
| Queues | Fire-and-forget background continuation | Rejected for current phase | Good for buffering, but less direct for synchronous MCP-visible status and exact per-operation locking. |
| KV only | Simple persisted operation blobs | Rejected | Eventual consistency is a poor fit for exact item locking and idempotency. `OAUTH_KV` must not be reused. |
| D1/R2 | External ledger storage | Rejected for current phase | More operational surface than needed for a compact per-operation ledger. |

## Decision

Use a SQLite-backed Durable Object named `SuperOpsOperationLedger` as the durable operation ledger. In local unit tests or unbound environments, use an in-memory fallback with the same interface.

The implemented ledger stores compact operational metadata only: operation ID, owner hash, expected item IDs, item stages, per-item leases, target field metadata, note fingerprints, verification states, partial-write flags, ambiguous-write flags, retry/rate-limit metadata, pending/unattempted sets, and compact result summaries. It does not store ticket descriptions, note bodies, conversation bodies, attachment contents, OAuth tokens, API tokens, or sensitive headers.

Add read-only MCP tools:

- `superops_operations_get`
- `superops_operations_results`

These tools expose status and compact results for the same hashed owner only.

## State and Idempotency Rules

The item model supports explicit stages such as `Pending`, `Validating`, `WriteStarted`, `FieldsUpdated`, `StatusUpdated`, `NoteAdded`, `Verifying`, `Completed`, `Stale`, `Skipped`, `FailedBeforeWrite`, `FailedAfterPartialWrite`, `RateLimited`, `Rescheduled`, and `Unattempted`.

Every triage item receives a stable idempotency key based on operation ID and ticket number. Notes use a normalized note fingerprint. The ledger validates terminal item transitions and supports owner-scoped item claiming with leases so duplicate invocations cannot process the same pending item at the same time. `superops_tickets_apply_triage_plan` now persists a compact approved action snapshot and can resume pending items through the triage continuation adapter.

## Rate-Limit Policy

Reads may retry with bounded attempts when the failure is HTTP 429, recognized GraphQL throttling, HTTP 5xx, or network failure. Retry-After seconds/date and common reset headers are parsed and capped. Retries count against execution diagnostics and the current subrequest budget.

Writes do not retry centrally. A write path may only add retries later if it can prove the original request was not accepted, has a reliable upstream idempotency key, or can verify current state and stale-data expectations before retrying.

## Consequences

Implemented now:

- Proactive budget accounting and stop-before-next-unit behavior.
- Durable triage operation ledger and status visibility.
- Read-only operation tools.
- Owner-scoped item leases, completion updates, continuation scheduling metadata, and terminal transition validation.
- Generic continuation runner with budget-aware item claiming and exact pending-item resume.
- SuperOps apply-triage continuation adapter that reuses synchronous validation, stale checks, note dedupe, update/resolve input builders, and final verification.
- Disabled-by-default Worker service-binding continuation trigger guarded by `SUPEROPS_CONTINUATION_ENABLED` and an internal token secret.
- Central read retry and rate-limit classification.
- Internal Durable Object subrequest accounting.

Not implemented yet:

- Workflow or Durable Object alarm support for durable long Retry-After sleeps.
- Whole-MCP continuation beyond apply-triage.
- Resume/cancel MCP tools.
- Full durable state machine enforcement across all write tools.

## Future Continuation Design

The current continuation primitive is `runOperationContinuation()` in `src/continuation.ts`. It claims one unfinished item, checks the remaining execution budget before processing it, persists terminal or rescheduled item state, and returns an observable incomplete result when more work remains. `resumeApplyTriageOperation()` wires this runner to the real apply-triage safety helpers. Tests cover pending resume, stale skips, public-note rejection, ambiguous accepted updates that are read before retry, and a 250-item mocked triage harness across multiple fresh budgets.

The current triage processor behavior is:

1. Persist an operation and item ledger before budget exhaustion.
2. Acquire a per-operation lock in the Durable Object.
3. Resume only pending/unattempted items.
4. Re-read current ticket state before each write.
5. Re-check `updatedTime` and all original expectations.
6. Verify note fingerprints before adding notes.
7. Stop again before the next safe unit if budget is low.
8. Return `ContinuationRequired` until the synchronous MCP call or explicit resume can observe completion.

If long sleeps for rate limits are required, either a Durable Object alarm or Workflows step should be added. Official Durable Object alarms are at-least-once and retry automatically, so item leases and idempotency remain required. Workflows are better for durable sleep/retry orchestration; Durable Object storage remains the source of truth for item state and locking. Cloudflare Workflows step retries must not blindly retry non-idempotent SuperOps writes.

## Provisioning Notes

`wrangler.json` declares:

```json
{
  "durable_objects": {
    "bindings": [
      {
        "name": "SUPEROPS_OPERATION_LEDGER",
        "class_name": "SuperOpsOperationLedger"
      }
    ]
  },
  "exports": {
    "SuperOpsOperationLedger": {
      "type": "durable-object",
      "storage": "sqlite"
    }
  }
}
```

No production resources were provisioned by this change. Validate locally with `wrangler dev` after dependencies are installed, then run `npm test` and `npm run build`. Staging and production deployment still require normal Cloudflare account permissions and manual approval.

## Rollback

Rollback can remove the Durable Object binding and operation tools, but existing operation status records would no longer be readable through MCP. Do not delete operation storage until the retention period has elapsed or a manual export has been taken.
