# snowflake-sanitizer MCP Server

PHI-safe Snowflake MCP server. Executes read-only SQL queries and strips PHI
from results before returning them to the AI model.

## Prerequisites

- Node.js 18+
- Snowflake account credentials

```bash
cd mcp-servers/snowflake
npm install
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SNOWFLAKE_ACCOUNT` | Yes | Account identifier (e.g. `xy12345.us-east-1`) |
| `SNOWFLAKE_USER` | Yes | Username |
| `SNOWFLAKE_PASSWORD` | Yes | Password |
| `SNOWFLAKE_DATABASE` | No | Default database |
| `SNOWFLAKE_WAREHOUSE` | No | Warehouse to use |
| `SNOWFLAKE_ROLE` | No | Role to use |
| `PHI_CONFIG_PATH` | No | Path to `phi-config.yaml` (see below) |

## PHI Configuration

PHI rules are driven by `phi-config.yaml`. Copy the example and customize:

```bash
cp ../shared/phi-config.example.yaml phi-config.yaml
export PHI_CONFIG_PATH=/path/to/phi-config.yaml
```

See [`../shared/phi-config.example.yaml`](../shared/phi-config.example.yaml)
for all available fields.

## Tool: `run_sql`

Execute a read-only SQL query.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sql` | string | Yes | SQL to execute. Must start with `SELECT`, `DESCRIBE`, `SHOW`, `EXPLAIN`, `WITH`, or `USE`. Must include a `LIMIT` clause. |
| `table_hint` | string | No | Table/view name for context-sensitive PHI detection (e.g. `patients`). |

## Read-Only Enforcement

Two layers prevent write operations:

1. **First-keyword check** — only `SELECT`, `DESCRIBE`, `SHOW`, `EXPLAIN`,
   `WITH`, and `USE` are allowed as the first SQL keyword.
2. **LIMIT required** — queries without a `LIMIT` clause are rejected to
   prevent unbounded full-table scans.

## PHI Redaction

Three layers of protection are applied to every result set:

1. **Column blocklist** — columns matching known PHI names (e.g. `dob`,
   `ssn`, `firstname`) are dropped before results are returned.
2. **String redaction** — regex patterns for emails, phones, SSNs, tokens,
   and URIs are applied to all remaining string values.
3. **Presidio NLP pass** — optional Python-based NLP pass for names and
   addresses (gracefully skipped if not installed).

Entity tables (lookup tables such as facilities or appointment types) skip
string redaction — values in those tables are labels, not person data.

## Integration with Claude Code

Create a launch script (e.g. `~/.mcp/snowflake-launch.sh`):

```bash
#!/bin/bash
export SNOWFLAKE_ACCOUNT="$(security find-generic-password -a SNOWFLAKE_ACCOUNT -s snowflake-mcp -w)"
export SNOWFLAKE_USER="$(security find-generic-password -a SNOWFLAKE_USER -s snowflake-mcp -w)"
export SNOWFLAKE_PASSWORD="$(security find-generic-password -a SNOWFLAKE_PASSWORD -s snowflake-mcp -w)"
exec node /path/to/mcp-servers/snowflake/server.js
```

Register in `~/.claude.json` under `mcpServers`:

```json
"snowflake": {
  "command": "/bin/bash",
  "args": ["/Users/you/.mcp/snowflake-launch.sh"]
}
```
