'use strict';

/**
 * server.js — PHI-safe Slack MCP server
 *
 * Exposes three read-only tools:
 *   get_channels      — list channels via conversations.list
 *   get_channel_history — fetch message history via conversations.history
 *   search_messages   — search messages via search.messages
 *
 * All operations are strictly GET-only (read-only). No POST/PUT/DELETE calls
 * are made to the Slack API. PHI/PII is stripped from all results by
 * sanitizer.js before being returned to the model.
 *
 * Required environment variable:
 *   SLACK_BOT_TOKEN — Slack bot token (xoxb-...) or user token (xoxp-...)
 *                     injected by launch script.
 *                     Note: search_messages requires search:read scope,
 *                     which is only available on user tokens (xoxp-).
 */

const https = require('https');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const { sanitizeValue } = require('./sanitizer.js');

// ── Configuration ─────────────────────────────────────────────────────────────

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
if (!SLACK_BOT_TOKEN) {
  process.stderr.write('Fatal: SLACK_BOT_TOKEN environment variable is required\n');
  process.exit(1);
}

const REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_CHANNEL_LIMIT = 100;
const MAX_CHANNEL_LIMIT = 200;
const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 200;
const DEFAULT_SEARCH_COUNT = 20;
const MAX_SEARCH_COUNT = 100;

// ── HTTP helper ───────────────────────────────────────────────────────────────

/**
 * Make a read-only HTTPS GET request to the Slack Web API.
 * Returns parsed JSON or throws on network/HTTP error.
 * On Slack API error (ok: false), throws with the error message.
 *
 * @param {string} method  Slack API method (e.g. "conversations.list")
 * @param {object} [params]  Query string parameters
 * @returns {Promise<object>}
 */
function slackGet(method, params) {
  return new Promise((resolve, reject) => {
    // Build query string from params
    const queryParts = [];
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== '') {
          queryParts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
        }
      }
    }
    const queryString = queryParts.length > 0 ? `?${queryParts.join('&')}` : '';

    const options = {
      hostname: 'slack.com',
      path: `/api/${method}${queryString}`,
      // READ-ONLY: method is always GET — no POST/PUT/DELETE
      method: 'GET',
      headers: {
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`Slack API HTTP error ${res.statusCode}`));
        }
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch (e) {
          return reject(new Error(`Failed to parse Slack response: ${e.message}`));
        }
        if (!parsed.ok) {
          return reject(new Error(`Slack API error: ${parsed.error || 'unknown'}`));
        }
        resolve(parsed);
      });
    });

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`Slack API request timed out after ${REQUEST_TIMEOUT_MS}ms`));
    });

    req.on('error', reject);
    req.end();
  });
}

// ── ISO timestamp → Slack ts conversion ──────────────────────────────────────

/**
 * Convert an ISO 8601 timestamp string to a Slack API `ts` value (Unix seconds
 * as a decimal string). Returns undefined if the input is falsy or invalid.
 *
 * @param {string|undefined} iso
 * @returns {string|undefined}
 */
function isoToSlackTs(iso) {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  if (isNaN(ms)) return undefined;
  return String(ms / 1000);
}

// ── MCP server setup ──────────────────────────────────────────────────────────

const server = new Server(
  { name: 'slack-sanitizer', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// ── Tool definitions ──────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'get_channels',
      description:
        'List Slack channels via conversations.list. Returns channel id, name, topic, purpose, ' +
        'member count, and privacy type. PHI/PII is redacted from all output. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: {
            type: 'integer',
            description: `Maximum channels to return (default ${DEFAULT_CHANNEL_LIMIT}, max ${MAX_CHANNEL_LIMIT})`,
          },
          cursor: {
            type: 'string',
            description: 'Pagination cursor from a previous response (next_cursor field)',
          },
          types: {
            type: 'string',
            description: 'Comma-separated channel types to include (default "public_channel,private_channel")',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'get_channel_history',
      description:
        'Fetch message history for a Slack channel via conversations.history. Returns messages ' +
        'with text, user, timestamp, and thread info. PHI/PII is redacted from all output. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          channel: {
            type: 'string',
            description: 'Channel ID (e.g. "C01234ABCDE")',
          },
          limit: {
            type: 'integer',
            description: `Maximum messages to return (default ${DEFAULT_HISTORY_LIMIT}, max ${MAX_HISTORY_LIMIT})`,
          },
          oldest: {
            type: 'string',
            description: 'ISO 8601 timestamp — only return messages after this time (optional)',
          },
          latest: {
            type: 'string',
            description: 'ISO 8601 timestamp — only return messages before this time (optional)',
          },
        },
        required: ['channel'],
        additionalProperties: false,
      },
    },
    {
      name: 'search_messages',
      description:
        'Search Slack messages via search.messages. Requires search:read scope (user token). ' +
        'Returns matching messages with text, channel, user, and permalink. ' +
        'PHI/PII is redacted from all output. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Slack search query (supports modifiers like "in:#channel", "from:@user")',
          },
          count: {
            type: 'integer',
            description: `Results per page (default ${DEFAULT_SEARCH_COUNT}, max ${MAX_SEARCH_COUNT})`,
          },
          page: {
            type: 'integer',
            description: 'Page number, 1-indexed (default 1)',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  ],
}));

// ── Tool handlers ─────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === 'get_channels') {
      return await handleGetChannels(args || {});
    } else if (name === 'get_channel_history') {
      return await handleGetChannelHistory(args || {});
    } else if (name === 'search_messages') {
      return await handleSearchMessages(args || {});
    } else {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

async function handleGetChannels(args) {
  const {
    limit,
    cursor,
    types = 'public_channel,private_channel',
  } = args;

  const resolvedLimit = Math.min(
    typeof limit === 'number' && limit > 0 ? Math.floor(limit) : DEFAULT_CHANNEL_LIMIT,
    MAX_CHANNEL_LIMIT
  );

  const params = { limit: resolvedLimit, types };
  if (cursor) params.cursor = cursor;

  const data = await slackGet('conversations.list', params);

  const channels = (data.channels || []).map((ch) => ({
    id:           ch.id,
    name:         ch.name,
    is_private:   ch.is_private || false,
    is_archived:  ch.is_archived || false,
    topic:        ch.topic ? ch.topic.value : null,
    purpose:      ch.purpose ? ch.purpose.value : null,
    num_members:  ch.num_members || 0,
  }));

  const next_cursor = data.response_metadata && data.response_metadata.next_cursor
    ? data.response_metadata.next_cursor
    : null;

  const result = { channels, next_cursor };
  const sanitized = await sanitizeValue(result);

  const summary = `Channels returned: ${sanitized.channels.length}${next_cursor ? ' (more available)' : ''}`;
  return {
    content: [
      { type: 'text', text: summary },
      { type: 'text', text: JSON.stringify(sanitized, null, 2) },
    ],
  };
}

async function handleGetChannelHistory(args) {
  const { channel, limit, oldest, latest } = args;

  if (!channel || typeof channel !== 'string' || channel.trim() === '') {
    throw new Error('channel must be a non-empty string');
  }

  const resolvedLimit = Math.min(
    typeof limit === 'number' && limit > 0 ? Math.floor(limit) : DEFAULT_HISTORY_LIMIT,
    MAX_HISTORY_LIMIT
  );

  const params = { channel, limit: resolvedLimit };
  const oldestTs = isoToSlackTs(oldest);
  const latestTs = isoToSlackTs(latest);
  if (oldestTs) params.oldest = oldestTs;
  if (latestTs) params.latest = latestTs;

  const data = await slackGet('conversations.history', params);

  const messages = (data.messages || []).map((msg) => ({
    ts:          msg.ts,
    user:        msg.user || null,
    text:        msg.text || null,
    thread_ts:   msg.thread_ts || null,
    reply_count: msg.reply_count || 0,
    reactions:   Array.isArray(msg.reactions)
      ? msg.reactions.map((r) => ({ name: r.name, count: r.count }))
      : [],
  }));

  const sanitized = await sanitizeValue(messages);
  const summary = `Channel: ${channel} | Messages returned: ${sanitized.length}`;
  return {
    content: [
      { type: 'text', text: summary },
      { type: 'text', text: JSON.stringify(sanitized, null, 2) },
    ],
  };
}

async function handleSearchMessages(args) {
  const { query, count, page = 1 } = args;

  if (!query || typeof query !== 'string' || query.trim() === '') {
    throw new Error('query must be a non-empty string');
  }

  const resolvedCount = Math.min(
    typeof count === 'number' && count > 0 ? Math.floor(count) : DEFAULT_SEARCH_COUNT,
    MAX_SEARCH_COUNT
  );

  const data = await slackGet('search.messages', { query, count: resolvedCount, page });

  const matches = (data.messages && data.messages.matches) || [];
  const messages = matches.map((msg) => ({
    ts:        msg.ts,
    user:      msg.username || msg.user || null,
    text:      msg.text || null,
    channel:   msg.channel ? { id: msg.channel.id, name: msg.channel.name } : null,
    permalink: msg.permalink || null,
  }));

  const total = data.messages && data.messages.total ? data.messages.total : messages.length;
  const sanitized = await sanitizeValue(messages);
  const summary = `Query: "${query}" | Results: ${sanitized.length} of ${total} | Page: ${page}`;
  return {
    content: [
      { type: 'text', text: summary },
      { type: 'text', text: JSON.stringify(sanitized, null, 2) },
    ],
  };
}

// ── Start server ──────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('slack-sanitizer MCP server running\n');
}

main().catch(err => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(0); // exit 0 — hooks must never crash with non-zero
});
