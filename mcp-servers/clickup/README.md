# clickup-sanitizer-mcp

PHI-safe read-only ClickUp MCP server.

Fetches tasks from the ClickUp API and passes all output through a sanitization
layer before returning it to the model. All operations are strictly GET-only —
no POST, PUT, or DELETE calls are made.

## Setup

```bash
cd mcp-servers/clickup
npm install
```

Create a launch script (e.g. `~/.mcp/clickup-launch.sh`) that injects the token
from your system keychain and starts the server:

```bash
#!/bin/bash
export CLICKUP_API_TOKEN=$(security find-generic-password -a CLICKUP_API_TOKEN -s clickup-mcp -w)
exec node /path/to/mcp-servers/clickup/server.js
```

Register the launch script in `~/.claude.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "clickup": {
      "command": "/Users/you/.mcp/clickup-launch.sh"
    }
  }
}
```

## Tools

### `get_task`

Fetch a single ClickUp task by ID.

| Parameter | Type   | Required | Description            |
|-----------|--------|----------|------------------------|
| `task_id` | string | yes      | ClickUp task ID        |

Returns: `id`, `name`, `status`, `description`, `url`, `assignees`, `due_date`, `priority`.

### `get_tasks`

List tasks in a ClickUp list.

| Parameter  | Type     | Required | Description                        |
|------------|----------|----------|------------------------------------|
| `list_id`  | string   | yes      | ClickUp list ID                    |
| `page`     | integer  | no       | Page number (default 0)            |
| `order_by` | string   | no       | Sort field (default "due_date")    |
| `statuses` | string[] | no       | Filter by status names             |

Returns: array of `{ id, name, status, due_date, assignees, url }`.

### `search_tasks`

Search for tasks in a ClickUp team by query string.

| Parameter | Type    | Required | Description                          |
|-----------|---------|----------|--------------------------------------|
| `team_id` | string  | yes      | ClickUp team (workspace) ID          |
| `query`   | string  | yes      | Search query string                  |
| `page`    | integer | no       | Page number (default 0)              |

Returns: array of `{ id, name, status, list, url }`.

## Environment Variables

| Variable             | Required | Description                              |
|----------------------|----------|------------------------------------------|
| `CLICKUP_API_TOKEN`  | yes      | ClickUp personal API token               |

## Sanitization

All tool results pass through `sanitizer.js`, which:

1. Collects all string leaves from the result value tree
2. Attempts batch redaction via Presidio (NLP-based, if installed)
3. Falls back to per-string regex redaction (emails, phones, SSNs, JWTs, bearer tokens)

No field-level blocking is applied (ClickUp is not a PHI database). The sanitizer
catches PII that may appear in task names, descriptions, or custom fields.
