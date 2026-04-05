# slack-sanitizer-mcp

PHI-safe read-only Slack MCP server.

Fetches channels, message history, and search results from the Slack Web API
and passes all output through a sanitization layer before returning it to the
model. All operations are strictly GET-only — no POST, PUT, or DELETE calls
are made.

## Setup

```bash
cd mcp-servers/slack
npm install
```

Create a launch script (e.g. `~/.mcp/slack-launch.sh`) that injects the token
from your system keychain and starts the server:

```bash
#!/bin/bash
export SLACK_BOT_TOKEN=$(security find-generic-password -a SLACK_BOT_TOKEN -s slack-mcp -w)
exec node /path/to/mcp-servers/slack/server.js
```

Register the launch script in `~/.claude.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "slack": {
      "command": "/Users/you/.mcp/slack-launch.sh"
    }
  }
}
```

## Tools

### `get_channels`

List Slack channels using `conversations.list`.

| Parameter | Type    | Required | Description                                                      |
|-----------|---------|----------|------------------------------------------------------------------|
| `limit`   | integer | no       | Max channels to return (default 100, max 200)                    |
| `cursor`  | string  | no       | Pagination cursor from a previous `next_cursor` field            |
| `types`   | string  | no       | Comma-separated channel types (default "public_channel,private_channel") |

Returns: `{ channels: [...], next_cursor }` where each channel has `id`, `name`,
`is_private`, `is_archived`, `topic`, `purpose`, `num_members`.

### `get_channel_history`

Fetch message history for a channel using `conversations.history`.

| Parameter | Type   | Required | Description                                         |
|-----------|--------|----------|-----------------------------------------------------|
| `channel` | string | yes      | Channel ID (e.g. "C01234ABCDE")                     |
| `limit`   | integer | no      | Max messages to return (default 50, max 200)        |
| `oldest`  | string | no       | ISO 8601 timestamp — only messages after this time  |
| `latest`  | string | no       | ISO 8601 timestamp — only messages before this time |

Returns: array of `{ ts, user, text, thread_ts, reply_count, reactions }`.

### `search_messages`

Search Slack messages using `search.messages`.

**Note:** This tool requires a user token (`xoxp-`) with the `search:read` scope.
Bot tokens do not have access to `search.messages`.

| Parameter | Type    | Required | Description                                                           |
|-----------|---------|----------|-----------------------------------------------------------------------|
| `query`   | string  | yes      | Slack search query (supports modifiers like `in:#channel`, `from:@user`) |
| `count`   | integer | no       | Results per page (default 20, max 100)                                |
| `page`    | integer | no       | Page number, 1-indexed (default 1)                                    |

Returns: array of `{ ts, user, text, channel: { id, name }, permalink }`.

## Environment Variables

| Variable          | Required | Description                                           |
|-------------------|----------|-------------------------------------------------------|
| `SLACK_BOT_TOKEN` | yes      | Slack bot token (`xoxb-`) or user token (`xoxp-`)     |

## Sanitization

All tool results pass through `sanitizer.js`, which:

1. Collects all string leaves from the result value tree
2. Attempts batch redaction via Presidio (NLP-based, if installed)
3. Falls back to per-string regex redaction (emails, phones, SSNs, JWTs, bearer tokens)

No field-level blocking is applied (Slack is not a PHI database). The sanitizer
catches PII that may appear in message text, channel names, or user display names.
