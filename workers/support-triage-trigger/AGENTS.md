# Trigger deployment boundary

This folder is the Git-controlled deployment source for the existing
support-triage-trigger Worker. All production code and non-secret configuration
changes must be committed and pushed to main and published by its Cloudflare
Git-connected build. Never upload/deploy manually.

The initial src/index.js is the exact deployed module, preserved to avoid
replacing production with a stale local TypeScript copy. Its baseline hash is
checked in verify.mjs and README.md. Every source change needs a reviewed diff,
runtime regression tests and an explicit updated provenance record.

Preserve TriageCoordinator, TRIAGE_COORDINATOR, namespace
bf8c485de0c541e2a896a53d226c841a, migration v1 and supportdesk-global object name.
Do not reset durable state, widen ticket scope or change Agent identity to make
a test pass. Secrets stay in the existing Worker; never commit their values.

The authorized seven-day Agent-capture exception stores the exact outgoing
Workspace Agent JSON request body and the exact pre-apply argument object in a
separate private SQLite table, not in dispatch history or logs. It excludes the
Authorization header and credentials, is retrieved only with the distinct
TRIAGE_CAPTURE_READ_TOKEN, and is bounded by per-record and total-storage caps.
Keep the apply-intent report observational only: it must not approve writes,
alter safety gates, or be treated as proof the apply reached the MCP. Never put
real captured customer data in fixtures or docs.

Validate with npm test and npm run build in this folder. The parent repository's
MCP must remain independently deployable. Use read-only production verification
and bounded history queries; do not accumulate unlimited pagination results.
