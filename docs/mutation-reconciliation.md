# Original-receipt mutation reconciliation

The MCP and dispatcher release of 7 October 2026 removes automatic mutation
recovery after unchanged or partial ticket reads. Four successful reads without
the target do not prove that a write was rejected. Such items remain uncertain,
retain their original receipt, and require reconciliation. A previously issued
legacy recovery checkpoint can still be read back; it cannot issue another write.

The dispatcher exposes `POST /v1/requests/{requestId}/verify` only to the
authenticated `superops-mcp` producer. The request contains schema version 1,
the original mutation fingerprint, its exact attempt count, and 1–8 owned read
receipt IDs. It accepts no outcome, free-text evidence, GraphQL, or target values.
The dispatcher derives the target from its stored original payload and evaluates
its stored successful read responses. Reads must physically start after the
original attempt completes and finish within the preceding five minutes.
Pre-write coalesced reads, partial GraphQL errors, missing fields, aliases that
obscure metadata, and unavailable evidence cannot establish the complete target.

An `applied` result means that the complete target was observed. It does not
assert which physical attempt or actor produced that state. The original
response, attempt history and HTTP status remain intact; status reports expose
`RECONCILED_APPLIED` with a null mutation response rather than inventing success
data. `not_observed` and `unknown` leave the original receipt uncertain. Every
outcome has `replayAllowed: false`. Identical evidence is idempotent; at most
eight distinct evidence records are retained per receipt.

MCP verification reads no longer replace the mutation receipt. Its durable
continuation checkpoints settlement before advancing, and retains bounded
content-free references to earlier verified mutation stages. A lost settlement
acknowledgement is recovered by polling the original receipt. Missing service
support, authentication failure, storage failure, or an exhausted execution
budget leaves the write held. The existing execution and 512-KiB ledger bounds
are unchanged; large verified success results omit empty presentation fields.

The dispatcher records durable resource intents for MCP ticket updates, notes,
worklogs, alert creation/resolution, script execution and ticket creation. While
an intent is queued, running, retrying or uncertain, identical payloads with a
new key recover the original receipt; conflicting writes to its resource are
rejected before enqueue. Note/worklog/update stages share the ticket identity.
Other producers retain their existing replay and authentication contracts.

Complete ticket field/identity updates, newly identifiable matching notes with
the exact privacy and canonical text, and complete alert resolution sets can be
verified automatically. Creation, time-log, script and unsupported custom
effects remain `unknown` when no complete authoritative comparison is available.
Unknown mutation roots or missing resource identities fail before admission.
Unobservable update controls also retain uncertainty. One-off uncertain calls
retain their dispatcher fence; this release does not add a public MCP resume or
reconciliation tool.

No historical receipt is reconciled as part of deployment. Rollback uses Git
and preserves the current dispatcher storage, producer credentials, Access
configuration, Rewst policies and read-recovery settings. Reverting only MCP
would restore its former recovery behavior, so keep the dispatcher fence active.

Validation includes real MCP transport/continuation tests, the 250-item mixed
fault harness, Node dispatcher tests, Cloudflare Durable Object eviction tests,
and a compiled Worker process restart test. All write simulations use synthetic
fixtures and intercepted or loopback upstreams.
