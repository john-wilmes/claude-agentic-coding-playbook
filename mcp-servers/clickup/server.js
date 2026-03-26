'use strict';

/**
 * server.js — PHI-safe ClickUp MCP server
 *
 * Exposes three read-only tools:
 *   get_task     — fetch a single task by ID
 *   get_tasks    — list tasks in a list
 *   search_tasks — search tasks across a team
 *
 * All operations are strictly GET-only (read-only). No POST/PUT/DELETE calls
 * are made to the ClickUp API. PHI/PII is stripped from all results by
 * sanitizer.js before being returned to the model.
 *
 * Required environment variable:
 *   CLICKUP_API_TOKEN — ClickUp personal API token (injected by launch script)
 */

const https = require('https');
const { URL } = require('url');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const { sanitizeValue } = require('./sanitizer.js');

// ── Configuration ─────────────────────────────────────────────────────────────

const CLICKUP_API_TOKEN = process.env.CLICKUP_API_TOKEN;
if (!CLICKUP_API_TOKEN) {
  process.stderr.write('Fatal: CLICKUP_API_TOKEN environment variable is required\n');
  process.exit(1);
}

const REQUEST_TIMEOUT_MS = 15000;

// ── HTTP helper ───────────────────────────────────────────────────────────────

/**
 * Make a read-only HTTPS GET request to the ClickUp API.
 * Returns parsed JSON or throws on error / non-2xx status.
 *
 * @param {string} path  API path (e.g. "/api/v2/task/abc123")
 * @param {object} [queryParams]  Key/value pairs appended as query string
 * @returns {Promise<object>}
 */
function clickupGet(path, queryParams) {
  return new Promise((resolve, reject) => {
    const url = new URL(`https://api.clickup.com${path}`);
    if (queryParams) {
      for (const [k, v] of Object.entries(queryParams)) {
        if (v !== undefined && v !== null && v !== '') {
          if (Array.isArray(v)) {
            for (const item of v) url.searchParams.append(k, item);
          } else {
            url.searchParams.set(k, String(v));
          }
        }
      }
    }

    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      // READ-ONLY: method is always GET — no POST/PUT/DELETE
      method: 'GET',
      headers: {
        Authorization: CLICKUP_API_TOKEN,
        'Content-Type': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          let msg = `ClickUp API error ${res.statusCode}`;
          try {
            const parsed = JSON.parse(body);
            if (parsed.err) msg += `: ${parsed.err}`;
            else if (parsed.error) msg += `: ${parsed.error}`;
          } catch (_) {}
          return reject(new Error(msg));
        }
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`Failed to parse ClickUp response: ${e.message}`));
        }
      });
    });

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`ClickUp API request timed out after ${REQUEST_TIMEOUT_MS}ms`));
    });

    req.on('error', reject);
    req.end();
  });
}

// ── Formatting helpers ─────────────────────────────────────────────────────────

/**
 * Convert a ClickUp due_date (millisecond timestamp string) to ISO 8601.
 *
 * @param {string|null} dueDateMs
 * @returns {string|null}
 */
function formatDueDate(dueDateMs) {
  if (!dueDateMs) return null;
  return new Date(parseInt(dueDateMs, 10)).toISOString();
}

/**
 * Extract display names from a ClickUp assignees array.
 *
 * @param {object[]} assignees
 * @returns {string[]}
 */
function extractAssigneeNames(assignees) {
  if (!Array.isArray(assignees)) return [];
  return assignees.map((a) => a.username || a.name || '[unknown]');
}

// ── MCP server setup ──────────────────────────────────────────────────────────

const server = new Server(
  { name: 'clickup-sanitizer', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// ── Tool definitions ──────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'get_task',
      description:
        'Fetch a single ClickUp task by ID. Returns name, status, description, URL, assignees, ' +
        'due date, and priority. PHI/PII is redacted from all output. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: {
            type: 'string',
            description: 'ClickUp task ID (e.g. "abc123")',
          },
        },
        required: ['task_id'],
        additionalProperties: false,
      },
    },
    {
      name: 'get_tasks',
      description:
        'List tasks in a ClickUp list. Returns id, name, status, due_date, assignees, and url ' +
        'for each task. PHI/PII is redacted from all output. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          list_id: {
            type: 'string',
            description: 'ClickUp list ID',
          },
          page: {
            type: 'integer',
            description: 'Page number (default 0)',
          },
          order_by: {
            type: 'string',
            description: 'Sort field (default "due_date")',
          },
          statuses: {
            type: 'array',
            items: { type: 'string' },
            description: 'Filter by status names (optional)',
          },
        },
        required: ['list_id'],
        additionalProperties: false,
      },
    },
    {
      name: 'search_tasks',
      description:
        'Search for tasks in a ClickUp team by query string. Returns matching tasks with id, ' +
        'name, status, list name, and url. PHI/PII is redacted from all output. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          team_id: {
            type: 'string',
            description: 'ClickUp team (workspace) ID',
          },
          query: {
            type: 'string',
            description: 'Search query string',
          },
          page: {
            type: 'integer',
            description: 'Page number (default 0)',
          },
        },
        required: ['team_id', 'query'],
        additionalProperties: false,
      },
    },
  ],
}));

// ── Tool handlers ─────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === 'get_task') {
      return await handleGetTask(args || {});
    } else if (name === 'get_tasks') {
      return await handleGetTasks(args || {});
    } else if (name === 'search_tasks') {
      return await handleSearchTasks(args || {});
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

async function handleGetTask(args) {
  const { task_id } = args;
  if (!task_id || typeof task_id !== 'string' || task_id.trim() === '') {
    throw new Error('task_id must be a non-empty string');
  }

  const task = await clickupGet(`/api/v2/task/${encodeURIComponent(task_id)}`, {
    include_markdown_description: 'true',
  });

  const result = {
    id:          task.id,
    name:        task.name,
    status:      task.status ? task.status.status : null,
    description: task.markdown_description || task.description || null,
    url:         task.url,
    assignees:   extractAssigneeNames(task.assignees),
    due_date:    formatDueDate(task.due_date),
    priority:    task.priority ? task.priority.priority : null,
  };

  const sanitized = await sanitizeValue(result);
  return {
    content: [{ type: 'text', text: JSON.stringify(sanitized, null, 2) }],
  };
}

async function handleGetTasks(args) {
  const { list_id, page = 0, order_by = 'due_date', statuses } = args;
  if (!list_id || typeof list_id !== 'string' || list_id.trim() === '') {
    throw new Error('list_id must be a non-empty string');
  }

  const queryParams = { page, order_by };
  if (Array.isArray(statuses) && statuses.length > 0) {
    queryParams['statuses[]'] = statuses;
  }

  const data = await clickupGet(
    `/api/v2/list/${encodeURIComponent(list_id)}/task`,
    queryParams
  );

  const tasks = (data.tasks || []).map((task) => ({
    id:        task.id,
    name:      task.name,
    status:    task.status ? task.status.status : null,
    due_date:  formatDueDate(task.due_date),
    assignees: extractAssigneeNames(task.assignees),
    url:       task.url,
  }));

  const sanitized = await sanitizeValue(tasks);
  const summary = `List: ${list_id} | Tasks returned: ${sanitized.length} | Page: ${page}`;
  return {
    content: [
      { type: 'text', text: summary },
      { type: 'text', text: JSON.stringify(sanitized, null, 2) },
    ],
  };
}

async function handleSearchTasks(args) {
  const { team_id, query, page = 0 } = args;
  if (!team_id || typeof team_id !== 'string' || team_id.trim() === '') {
    throw new Error('team_id must be a non-empty string');
  }
  if (!query || typeof query !== 'string' || query.trim() === '') {
    throw new Error('query must be a non-empty string');
  }

  const data = await clickupGet(
    `/api/v2/team/${encodeURIComponent(team_id)}/task`,
    { query, page }
  );

  const tasks = (data.tasks || []).map((task) => ({
    id:     task.id,
    name:   task.name,
    status: task.status ? task.status.status : null,
    list:   task.list ? task.list.name : null,
    url:    task.url,
  }));

  const sanitized = await sanitizeValue(tasks);
  const summary = `Team: ${team_id} | Query: "${query}" | Results: ${sanitized.length} | Page: ${page}`;
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
  process.stderr.write('clickup-sanitizer MCP server running\n');
}

main().catch(err => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(0); // exit 0 — hooks must never crash with non-zero
});
