# Datadog PHI-Sanitizing MCP Server

A minimal Datadog MCP server that exposes `get_logs` with PHI/PII redaction applied
before log output reaches the AI model. Implements three layers of protection:

1. **Field blocklist** — drops log attributes whose names match known PHI fields
   (names, emails, phone numbers, DOB, SSN, MRN, etc.)
2. **Regex redaction** — strips emails, phone numbers, SSNs, JWTs, bearer tokens,
   and database connection strings from string values
3. **Presidio NLP pass** — optional second pass using
   [presidio-analyzer](https://github.com/microsoft/presidio) for entity detection
   that regex misses (names, addresses)
4. **OpenRedaction pass** — optional third pass via the `openredaction` Node.js
   package for additional coverage (gracefully skipped if Node/package unavailable)

See [`server.py`](server.py) for the implementation.

## Setup

### 1. Install dependencies

```bash
# Core (required)
pip install mcp datadog-api-client

# Presidio NLP (optional, recommended)
pip install presidio-analyzer presidio-anonymizer
python -m spacy download en_core_web_lg

# OpenRedaction (optional)
npm install -g openredaction
```

### 2. Set credentials

The server reads Datadog credentials from environment variables:

| Variable | Required | Default |
|----------|----------|---------|
| `DD_API_KEY` | Yes | — |
| `DD_APP_KEY` | Yes | — |
| `DD_SITE` | No | `datadoghq.com` |

On macOS, store credentials in Keychain and inject via a launch wrapper:

```bash
# ~/.mcp/datadog-launch.sh
export DD_API_KEY=$(security find-generic-password -a DD_API_KEY -s datadog-mcp -w)
export DD_APP_KEY=$(security find-generic-password -a DD_APP_KEY -s datadog-mcp -w)
exec uv run /path/to/mcp-servers/datadog/server.py
```

### 3. Configure phi-config.yaml (optional)

By default, the server uses a built-in PHI field blocklist covering common
healthcare data fields. To extend or override, create a `phi-config.yaml`:

```bash
# Use PHI_CONFIG_PATH to point to your config
export PHI_CONFIG_PATH=/path/to/phi-config.yaml
```

Config format:

```yaml
phi_columns:
  - firstname
  - lastname
  - dob
  - mrn
  - ssn
  - email
  - phone
  # Add your schema-specific field names here
```

The server searches for `phi-config.yaml` upward from the current working
directory if `PHI_CONFIG_PATH` is not set.

### 4. Register in Claude Code

Add to `~/.claude.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "datadog": {
      "command": "/bin/bash",
      "args": ["/Users/you/.mcp/datadog-launch.sh"]
    }
  }
}
```

## Tool Reference

### `mcp__datadog__get_logs`

Search Datadog logs with PHI redaction applied to all results.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `time_range` | string | `"1h"` | `1h`, `4h`, `8h`, `1d`, `7d`, `14d`, `30d` |
| `filters` | object | `{}` | Structured fields: `service`, `env`, `status`, `host` |
| `query` | string | — | Free-text or Datadog query syntax |
| `limit` | integer | `50` | 1–1000 |
| `cursor` | string | — | Pagination cursor from previous response |
| `format` | string | `"table"` | `table`, `text`, `json` |

**Usage guidelines:**
- Use the narrowest `time_range` possible (prefer `1h` over `1d`)
- Always apply `filters` (especially `service` and `env`) before free-text `query`
- Start with a small `limit` and increase only if needed

**Example:**

```json
{
  "time_range": "1h",
  "filters": {
    "service": "api-service",
    "env": "prod",
    "status": "error"
  },
  "query": "timeout",
  "limit": 25,
  "format": "table"
}
```

**Response includes** a summary line showing time range, log count, and PHI
fields dropped. Paginate with the `cursor` value from a previous response.
