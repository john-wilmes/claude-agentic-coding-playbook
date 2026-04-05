# Operational Runbook: Data System Access
# Copy this file to profiles/combined/rules/operations.md and fill in your own MCP server details.

## Critical Policy: MCP Only

**Never use CLI tools to query your databases, log systems, or project management tools.**

CLI tools bypass the PII/PHI sanitization layer. All data access MUST go through the MCP servers below. This applies to all agents, subagents, and tasks.

## MCP Tool Reference

### MongoDB -- `mcp__mongodb__find`, `mcp__mongodb__aggregate`

Default database: `db` <!-- Replace with your actual database name -->

**Workflow**: Call `discover_collection` before querying any collection for the first time. Index keys reveal the real field names and which fields to filter on. Do not guess field names.

```
mcp__mongodb__find:
  collection: "your_collection"  # required
  filter: { "org": "..." }       # required -- never omit (full scans blocked)
  projection: { "field": 1 }     # always include -- limits PII exposure
  limit: 20                      # always include -- default is unbounded
  sort: { "createdAt": -1 }      # optional

mcp__mongodb__aggregate:
  collection: "your_collection"
  pipeline: [{ "$match": {...} }, { "$limit": 20 }]
  # $out and $merge are blocked server-side (read-only)
```

Key collections: <!-- YOUR_COLLECTIONS_HERE -- list your most-queried collections -->

#### ObjectId filters -- CRITICAL

MongoDB stores `_id` and reference fields as Binary ObjectIds, not strings. Passing a plain hex string will silently match nothing. Always use `$oid` syntax:

```js
// correct -- matches the ObjectId
{ "user": { "$oid": "69b83f75ca339243d5415c97" } }

// correct -- $in with ObjectIds
{ "user": { "$in": [{ "$oid": "69b83f75ca339243d5415c97" }] } }

// wrong -- silently returns 0 results
{ "user": "69b83f75ca339243d5415c97" }
```

Document which fields in your schema store plain strings vs ObjectIds. For example, some `org` or `externalId` fields may be plain strings that do NOT need `$oid`. Test both forms if you get 0 results.

#### Org/tenant ID field

<!-- Document your org/tenant ID field name here. Different collections may use different field names. -->
<!-- Example:
- appointments: "org" (plain string)
- users: "tenantId" (ObjectId -- use $oid)
-->

### Datadog -- `mcp__datadog__get_logs`

```
mcp__datadog__get_logs:
  filters:
    service: "your-service"   # YOUR_SERVICE_NAMES -- document real Datadog service names here
    "@your_org_field": "abc123"
  time_range: "1h"          # use narrow ranges -- broad queries are expensive
  limit: 50
```

Service names: <!-- YOUR_SERVICE_NAMES -- list your actual Datadog service names here. Using wrong names returns 0 results. -->

Document your real attribute filter keys here -- wrong attribute names silently return 0 results. Common gotcha: the attribute name in Datadog may differ from the field name in your code.

### Snowflake -- `mcp__snowflake__run_sql`

Read-only (SELECT, DESCRIBE, USE only). Always include LIMIT.

### ClickUp -- `mcp__clickup__get_task`, `mcp__clickup__get_tasks`, `mcp__clickup__search_tasks`

```
mcp__clickup__get_task:     { task_id: "86b8z9qqu" }
mcp__clickup__get_tasks:    { list_id: "..." }
mcp__clickup__search_tasks: { query: "search term" }
```
