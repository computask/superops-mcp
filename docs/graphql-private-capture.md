# Private GraphQL exchange capture

`SUPEROPS_GRAPHQL_CAPTURE_ENABLED=true` enables version 1 for the hosted MCP
Worker. Set it to `false` through Git deployment to disable new captures;
existing captures still expire. No tool permission or triage policy changes.

## Recorded boundary

MCP Worker requests (including internal continuation HTTP requests) and nightly
catalogue invocations collect the actual dispatcher HTTP exchanges:

- Full GraphQL query and variables in the submitted JSON body.
- Method, URL, redacted headers, idempotency keys and dispatcher receipt IDs.
- Every receipt/status poll and safe-diagnostics response received by the MCP.
- HTTP status, full returned body, all returned GraphQL errors/extensions/paths,
  malformed non-JSON responses, and transport failures.
- Ordered sequence, UTC start/finish, response-header latency, invocation,
  operation, tool and current ticket item key where available.

Bodies remain exact strings unless credential redaction is necessary. Known
Worker secrets, bearer/basic credentials, JWTs, private keys and labelled
credential fields are removed. Customer/ticket content remains private, never
in ordinary logs. Unknown unlabelled secrets in arbitrary prose cannot be
identified with certainty; do not submit credentials as ticket content.

This is the **MCP-to-dispatcher boundary**. An uncertain receipt can contain only
`GRAPHQL_ERROR`: its original upstream response remains in the dispatcher's
existing private attempt store, correlated by request ID. Producer-safe
diagnostics deliberately omit raw upstream errors. Capture does not invent that
message, grant dispatcher-admin access, expose hidden ChatGPT review inputs,
or recover historical payloads.

The standalone Node entrypoint and stress-probe Durable Object are outside this
Worker scope; their upstream attempts remain dispatcher records. Production
tools and continuations still use only the dispatcher.

## Private retrieval

Use the ChatGPT-direct hostname with the existing verified Cloudflare Access
identity `sam@computask.co.uk`, not merely an MCP OAuth token:

```text
GET /admin/graphql-captures?date=YYYY-MM-DD
GET /admin/graphql-captures?date=YYYY-MM-DD&invocationId=<invocation-id>
GET /admin/graphql-captures?date=YYYY-MM-DD&captureId=<capture-id>
```

Dates are UTC. Index responses return metadata only, at most 50 entries, with
`nextOffset`. Fetch an individual capture for content. Bound pagination scripts
and stop if the cursor repeats. Responses are `no-store, private`; other users
are denied. The public health endpoint exposes enabled/version/retention only.

Ordinary logs contain `graphql_capture_stored` with date/capture/invocation IDs
and completeness, or `graphql_capture_store_failed` with safe IDs/reason only.
The index describes stored records, not guaranteed capture of every attempt:
check gap events too. No raw request or response is written to routine logs.

## Bounds and guarantees

- No additional SuperOps or dispatcher calls. One private binding request is
  reserved/accounted per captured Worker invocation.
- Background capture/persistence preserves original HTTP responses, retry rules,
  Retry-After, mutation checkpoints and no-blind-replay safeguards.
- At most 128 exchanges, 4 MiB per body and 8 MiB combined body reservation per
  invocation. Serialized records above 8 MiB + 256 KiB are refused explicitly.
- Oversized, unreadable or timed-out bodies are omitted entirely with
  `complete:false` and a reason. No fragment that could cut a credential is saved.
- Capture readers wait at most five seconds in the background. `waitUntil`
  retains background persistence, but platform/process failure can still lose
  a capture; this is diagnostics, not guaranteed audit delivery.
- Separate daily objects in the existing operation-ledger namespace: 2,000
  records and 64 MiB serialized content per day, including incomplete writes.
  At most eight day buckets overlap the seven-day rolling retention window.
- Expiry is seven days from capture start, enforced on reads and by alarms.
  Interrupted writes remain incomplete and expire with their chunks. Existing
  operation lifecycle/retention and alarms remain intact.

Never copy raw private captures into source fixtures, public issues, routine
logs, or committed reports.
