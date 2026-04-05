# mongodb-sanitizer MCP Server

A PHI-safe MongoDB MCP server. Queries return documents with PHI fields removed
and string values redacted before any content reaches the AI model.

## Prerequisites

- Node.js 18+
- `npm install` in this directory

## Configuration

### Required

```bash
export MONGODB_URI="mongodb+srv://user:[EMAIL]/"
```

### Optional

```bash
export PHI_CONFIG_PATH="/path/to/phi-config.yaml"
```

If `PHI_CONFIG_PATH` is not set, the server searches for `phi-config.yaml`
upward from the working directory, then falls back to built-in healthcare
defaults. See [`../shared/phi-config.example.yaml`](../shared/phi-config.example.yaml)
for a documented template.

## Tools

### `find`

Query a collection with optional projection, sort, and limit.

| Parameter    | Type    | Required | Description |
|--------------|---------|----------|-------------|
| `collection` | string  | yes      | Collection name |
| `filter`     | object  | yes      | MongoDB query filter (empty object `{}` requires explicit intent) |
| `projection` | object  | no       | MongoDB field mask. PHI fields are forced to `0`. |
| `limit`      | integer | no       | Max documents to return (default 20, max 100) |
| `sort`       | object  | no       | MongoDB sort spec, e.g. `{"createdAt": -1}` |

### `aggregate`

Run a read-only aggregation pipeline.

| Parameter    | Type   | Required | Description |
|--------------|--------|----------|-------------|
| `collection` | string | yes      | Collection name |
| `pipeline`   | array  | yes      | Pipeline stages. `$out` and `$merge` are blocked. |

## PHI Redaction

Two layers are applied to every result before it is returned:

1. **Field-level blocking** — fields listed in `phi-config.yaml` (or built-in
   defaults) are dropped entirely. The `name` field is dropped when querying
   person tables (`users`, `patients`, `providers`).

2. **String redaction** — remaining string values are scanned for emails,
   phone numbers, SSNs, bearer tokens, JWTs, and database URIs. If
   [Presidio](https://github.com/microsoft/presidio) is installed, an NLP
   pass runs first for higher recall on names and addresses.

## Read-only Enforcement

`$out` and `$merge` pipeline stages are rejected before the query reaches
MongoDB. The server never writes to the database.

## Claude Code Integration

Create a launch script (e.g. `~/.mcp/mongodb-launch.sh`):

```bash
#!/bin/bash
export MONGODB_URI="$(security find-generic-password -a MONGODB_URI -s mongodb-mcp -w)"
export PHI_CONFIG_PATH="$HOME/.mcp/phi-config.yaml"
exec node /path/to/mcp-servers/mongodb/server.js
```

Register in `~/.claude.json` under the `mcpServers` key:

```json
"mongodb": {
  "command": "/bin/bash",
  "args": ["/Users/you/.mcp/mongodb-launch.sh"],
  "env": {}
}
```
