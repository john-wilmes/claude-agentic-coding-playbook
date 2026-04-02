# Operational Runbook: Data System Access

## Critical Policy: MCP Only

**Never use CLI tools to query MongoDB, Datadog, Snowflake, or ClickUp.**

The CLI tools (`node mongodb_mcp_client.js`, `uv run dd_logs_cli.py`, direct `mongosh`, `curl`) bypass the PHI/PII sanitization layer. All data access MUST go through the MCP servers below. This applies to all agents, subagents, and tasks.

## MCP Tool Reference

### MongoDB — `mcp__mongodb__find`, `mcp__mongodb__aggregate`

Default database: `db` (not `luma`, not `lumahealth`).

**Workflow**: Call `discover_collection` before querying any collection for the first time. Index keys reveal the real field names and which fields to filter on. Do not guess field names.

```
mcp__mongodb__find:
  collection: "appointments"     # required
  filter: { "org": "..." }       # required — never omit (full scans blocked)
  projection: { "field": 1 }     # always include — limits PHI exposure
  limit: 20                      # always include — default is unbounded
  sort: { "createdAt": -1 }      # optional

mcp__mongodb__aggregate:
  collection: "appointments"
  pipeline: [{ "$match": {...} }, { "$limit": 20 }]
  # $out and $merge are blocked server-side (read-only)
```

Key collections: `users`, `patients`, `appointments`, `integrators`, `patientforms`, `settings`, `messages`, `luma-audit-*`

### Datadog — `mcp__datadog__get_logs`

```
mcp__datadog__get_logs:
  filters:
    service: "integrator"   # real names: integrator, rest, chat, followup (NOT integrator-service)
    "@rootId": "abc123"
  time_range: "1h"          # use narrow ranges — broad queries are expensive
  limit: 50
```

Real service names: `integrator`, `rest`, `chat`, `followup`. Using `integrator-service` or `rest-service` returns 0 results.

Hex IDs embedded in log messages are not reliably found by full-text search. Use attribute filters (`@orgId`, `@rootId`, `service:`) and filter client-side when needed.

### Snowflake — `mcp__snowflake__run_sql`

Read-only (SELECT, DESCRIBE, USE only). Always include LIMIT.

### ClickUp — `mcp__clickup__get_task`, `mcp__clickup__get_tasks`, `mcp__clickup__search_tasks`

```
mcp__clickup__get_task:     { task_id: "86b8z9qqu" }
mcp__clickup__get_tasks:    { list_id: "..." }
mcp__clickup__search_tasks: { query: "fax ingestion" }
```

### Multi-Model Analyzer — `mcp__mma__*`

Use for static analysis of ISC/integrator-service codebases: `get_callers`, `get_callees`, `get_architecture`, `search`, `query`.
