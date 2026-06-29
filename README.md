# SuperOps.ai MCP Server

MCP server for Claude that provides tools to interact with the SuperOps.ai PSA/RMM platform using their GraphQL API.

## One-Click Deployment

[![Deploy to DO](https://www.deploytodo.com/do-btn-blue.svg)](https://cloud.digitalocean.com/apps/new?repo=https://github.com/wyre-technology/superops-mcp/tree/main)

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/wyre-technology/superops-mcp)

> **Operator note — GitHub Packages authentication.** This package is published
> to the `@wyre-technology` scope on **GitHub Packages**, which requires an
> authentication token on every install (GitHub Packages has no anonymous reads,
> even for public packages). Create a GitHub **Personal Access Token** with the
> `read:packages` scope and supply it to the cloud builder:
>
> - **Cloudflare Workers** — set a build variable named `NODE_AUTH_TOKEN` to your PAT.
> - **DigitalOcean App Platform** — set a **build-time** secret named `GITHUB_TOKEN` to your PAT.
>
> For local installs, run `export NODE_AUTH_TOKEN=$(gh auth token)` before `npm install`.

## Features

- **Decision Tree Architecture**: Navigate to domains (clients, tickets, assets, technicians) to see relevant tools
- **Lazy Loading**: Domain modules load on-demand for faster startup
- **Full CRUD Operations**: List, get, create, and update entities
- **GraphQL Support**: Use custom queries for advanced operations

## Installation

```bash
# The @wyre-technology scope lives on GitHub Packages and needs a token to install:
export NODE_AUTH_TOKEN=$(gh auth token)
npm install @wyre-technology/superops-mcp
```

## Configuration

Set the following environment variables:

```bash
export SUPEROPS_SUBDOMAIN="yourcompany"
export SUPEROPS_REGION="us"  # or "eu" for EU region
```

Configure the SuperOps API token as a secret in your runtime or Worker platform.
Never commit token values or put them in examples, logs, headers, or responses.

### Getting Your API Token

1. Log in to SuperOps.ai
2. Click settings icon > "My Profile"
3. Navigate to "API token" tab
4. Click "Generate token"
5. Copy and securely store the token

## Usage with Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "superops": {
      "command": "npx",
      "args": ["@wyre-technology/superops-mcp"],
      "env": {
        "SUPEROPS_SUBDOMAIN": "yourcompany",
        "SUPEROPS_REGION": "us"
      }
    }
  }
}
```

Provide the SuperOps API token through your MCP client's secure secret/env
mechanism rather than committing it to this file.

## Cloudflare Worker Deployment Notes

- Worker name: `superops-mcp`
- MCP endpoint: `https://<your-mcp-host>/mcp`
- Health endpoint: `https://<your-mcp-host>/health`
- Required non-secret vars: `AUTH_MODE=env`, `SUPEROPS_SUBDOMAIN=computaskltd`, `SUPEROPS_REGION=us`, `LOG_LEVEL=warn`
- Optional non-secret safety vars: `MCP_ENABLED=true`, `ENABLE_WRITE_TOOLS=true`, `ENABLE_CUSTOM_MUTATION=true`
- Required secrets: the SuperOps API token Worker secret, plus any OAuth/session secrets required by the deployed auth provider
- Never commit: API token values, OAuth access/refresh tokens, bearer tokens, Cloudflare service token values, client secrets, private keys, or full request headers

Safe local validation:

```bash
npm test
npm run build
```

Safe deployed smoke tools:

- `superops_status`
- `superops_test_connection`
- `superops_clients_list`
- `superops_tickets_list`
- `superops_assets_list`
- `superops_technicians_list`

Write-capable tools remain enabled by default:

- `superops_tickets_create`
- `superops_tickets_update`
- `superops_tickets_add_note`
- `superops_tickets_log_time`
- `superops_custom_mutation`

`superops_custom_mutation` is the highest-risk tool because it accepts custom
GraphQL mutation text. Audit logs record only safe metadata for custom GraphQL:
operation type, operation name when parseable, and variable key names. Full
GraphQL bodies and variable values are not logged by default.

Audit logs are structured JSON records emitted for MCP tool calls. They include
timestamp, request/correlation ID, tool name, user identity when available from
the auth layer, tool category, high-risk marker, success/failure, duration, and
a sanitised error summary on failure.

Emergency disable process:

- Set `MCP_ENABLED=false` to stop MCP tool execution.
- Set `ENABLE_WRITE_TOOLS=false` to block ticket write tools.
- Set `ENABLE_CUSTOM_MUTATION=false` to block custom GraphQL mutations.
- Re-run the deployment pipeline after changing Worker vars, then verify `/health` and `superops_status`.

Token rotation plan:

1. Generate a replacement SuperOps API token in SuperOps.
2. Update the existing Cloudflare Worker secret value.
3. Redeploy or restart using the normal deployment process.
4. Run safe smoke tests.
5. Revoke the old SuperOps token.
6. Review audit logs for unexpected failed calls after rotation.

## Available Domains & Tools

### Navigation

- `superops_navigate` - Navigate to a domain
- `superops_back` - Return to main menu
- `superops_test_connection` - Test API connectivity

### Clients Domain

- `superops_clients_list` - List clients with filters
- `superops_clients_get` - Get client details
- `superops_clients_search` - Search clients by name/domain

### Tickets Domain

- `superops_tickets_list` - List tickets with filters
- `superops_tickets_recent` - List the most recently created tickets, optionally with conversations and notes
- `superops_tickets_get` - Get ticket details
- `superops_tickets_get_by_number` - Get ticket details by visible SuperOps ticket number/display ID
- `superops_tickets_get_safe_by_number` - Safely get ticket metadata and sanitized plain-text context by visible SuperOps ticket number/display ID
- `superops_tickets_conversation_list` - Read customer ticket conversations/replies, including attachment metadata where returned by SuperOps
- `superops_tickets_notes_list` - Read public/internal ticket notes, including attachment metadata where returned by SuperOps
- `superops_tickets_field_options` - Discover live SuperOps ticket option values for priority, impact, urgency, resolution code, cause, and subcategory
- `superops_tickets_create` - Create a new ticket
- `superops_tickets_resolve_full` - Resolve or fully classify a ticket by ticket number or internal ID, with client lookup, technician group lookup, validated display-name classification fields, optional note creation, and optional final verification
- `superops_tickets_update` - Update ticket status, assignment, impact, urgency, category, cause, subcategory, resolution code, or an explicit manual priority override. Tenant category values use the configured enum; other option values are resolved and validated from SuperOps ticket field metadata before mutation.
- `superops_tickets_add_note` - Add note to ticket
- `superops_tickets_log_time` - Log time on ticket

`superops_tickets_list` supports configured status display names such as
`New Calls`. Status filters are sent to SuperOps as a ticket-list condition so
queue listing is not limited to the first unfiltered page. `max` controls the
requested page size up to 500, with `page` selecting the page number. If extra
client, priority, or assignee filters are applied locally after the SuperOps
query, `totalCount` and `hasMore` are omitted rather than reporting unrelated
unfiltered counts.

Ticket urgency and impact are writable. Priority can still be supplied manually
and will be validated against live SuperOps options. Prefer impact plus urgency
where SuperOps can calculate priority, but resolved-ticket workflows may require
the full classification set: priority, impact, category, subcategory, cause, and
resolutionCode. `superops_tickets_resolve_full` validates those fields before
adding notes or mutating the ticket, and can reuse existing ticket values only
when they are present and valid against live SuperOps options.

`No Action Needed` is a subcategory, not a resolutionCode. Use a valid
resolutionCode returned by SuperOps, such as `Permanent Fix` when available.

If a response reports `partialFailure`, a note was already created but the later
ticket update failed unexpectedly. Do not retry with the same note unless you
intentionally want a duplicate note.

Use `superops_tickets_get_by_number` for normal ticket lookup when raw ticket
content is acceptable, or when you explicitly need the unmodified SuperOps
conversation/note payloads. If `includeContent=true` is blocked by OpenAI safety
checks, or if you only need safe plain-text triage context, use
`superops_tickets_get_safe_by_number` instead.

Safe retrieval returns ticket metadata, requester/sender fields, sanitized
visible text, timestamps, author names, public/internal flags, convenience
latest-message fields, and attachment metadata only. It strips HTML, removes raw
email headers and MIME-like payloads, removes base64/data/cid embedded content,
redacts credentials, tokens, private keys, long hashes, passwords, passcodes and
secrets, and truncates long content. Attachment bodies are never returned by the
safe tool; `attachments` currently supports only `metadataOnly` and `none`.

Example safe retrieval call:

```json
{
  "ticketNumber": "55841",
  "includeDescription": true,
  "includeNotes": true,
  "includeConversations": true,
  "latestFirst": true,
  "maxItems": 20,
  "maxCharsPerItem": 4000,
  "maxTotalChars": 20000,
  "attachments": "metadataOnly"
}
```

### Assets Domain

- `superops_assets_list` - List assets/endpoints
- `superops_assets_get` - Get asset details
- `superops_assets_software` - Get software inventory
- `superops_assets_patches` - Get patch status

### Technicians Domain

- `superops_technicians_list` - List technicians
- `superops_technicians_get` - Get technician details
- `superops_technicians_groups` - List technician groups

### Custom Domain

- `superops_custom_query` - Run custom GraphQL query
- `superops_custom_mutation` - Run custom GraphQL mutation

## Example Usage

```
User: What tools are available?
Claude: Use superops_navigate to select a domain...

User: Navigate to tickets
Claude: [calls superops_navigate with domain: "tickets"]
Now in tickets domain. Available tools: superops_tickets_list, superops_tickets_get...

User: Show open high priority tickets
Claude: [calls superops_tickets_list with status: ["Open"], priority: ["High"]]
Here are the open high priority tickets...

User: Show tickets currently in New Calls
Claude: [calls superops_tickets_list with {
  "status": ["New Calls"],
  "max": 50,
  "page": 1
}]
Here are the current New Calls tickets...

Note: superops_tickets_recent is only a recent-ticket view. Do not use it as a
complete queue listing for statuses such as New Calls.

User: Resolve spam ticket 57100
Claude: [calls superops_tickets_resolve_full with {
  "ticketNumber": "57100",
  "clientName": "Task Group",
  "status": "Resolved",
  "priority": "Very Low",
  "impact": "Low",
  "urgency": "Low",
  "category": "7. Sales call",
  "subcategory": "No Action Needed",
  "cause": "No Fault Found",
  "resolutionCode": "Permanent Fix",
  "techGroupName": "Level 1 Support",
  "note": "Resolving as unsolicited marketing/sales email rather than a genuine support request.",
  "suppressCloseNotification": true,
  "verify": true
}]
The ticket has been classified and resolved.

User: Manually override ticket 57101 priority
Claude: [calls superops_tickets_update with {
  "ticketId": "ticket-57101",
  "priority": "High"
}]
The priority override has been validated and applied.
```

## Rate Limits

SuperOps.ai API has a rate limit of 800 requests per minute per API token.

## License

Apache-2.0

## Support

For issues and feature requests, please visit the [GitHub repository](https://github.com/wyre-technology/superops-mcp/issues).
