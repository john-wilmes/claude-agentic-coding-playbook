'use strict';

/**
 * server.js — PHI-safe Snowflake MCP server
 *
 * Exposes one read-only tool:
 *   run_sql — execute a SELECT/DESCRIBE/SHOW/EXPLAIN/WITH/USE query and return
 *             sanitized results
 *
 * PHI is stripped from all results by sanitizer.js before being returned to
 * the model. Write operations (INSERT, UPDATE, DELETE, etc.) are rejected.
 * All queries must include a LIMIT clause.
 *
 * Required environment variables:
 *   SNOWFLAKE_ACCOUNT   — Snowflake account identifier (e.g. xy12345.us-east-1)
 *   SNOWFLAKE_USER      — Snowflake username
 *   SNOWFLAKE_PASSWORD  — Snowflake password
 *
 * Optional environment variables:
 *   SNOWFLAKE_DATABASE  — default database (default: empty string)
 *   SNOWFLAKE_WAREHOUSE — warehouse to use
 *   SNOWFLAKE_ROLE      — role to use
 *   PHI_CONFIG_PATH     — absolute path to phi-config.yaml
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const snowflake = require('snowflake-sdk');

const { sanitizeRows, validateQuery } = require('./sanitizer.js');

// ── Configuration ─────────────────────────────────────────────────────────────

const SNOWFLAKE_ACCOUNT = process.env.SNOWFLAKE_ACCOUNT;
const SNOWFLAKE_USER = process.env.SNOWFLAKE_USER;
const SNOWFLAKE_PASSWORD = process.env.SNOWFLAKE_PASSWORD;
const SNOWFLAKE_DATABASE = process.env.SNOWFLAKE_DATABASE || '';
const SNOWFLAKE_WAREHOUSE = process.env.SNOWFLAKE_WAREHOUSE || '';
const SNOWFLAKE_ROLE = process.env.SNOWFLAKE_ROLE || '';

if (!SNOWFLAKE_ACCOUNT || !SNOWFLAKE_USER || !SNOWFLAKE_PASSWORD) {
  process.stderr.write(
    'Fatal: SNOWFLAKE_ACCOUNT, SNOWFLAKE_USER, and SNOWFLAKE_PASSWORD are required\n'
  );
  process.exit(1);
}

// Credential values to scrub from error messages
const CREDENTIALS_TO_SCRUB = [SNOWFLAKE_PASSWORD];

// ── Error scrubbing ───────────────────────────────────────────────────────────

/**
 * Remove credential env var values from an error message before returning it
 * to the model.
 *
 * @param {Error|string} err
 * @returns {string}
 */
function scrubError(err) {
  let msg = err instanceof Error ? err.message : String(err);
  for (const secret of CREDENTIALS_TO_SCRUB) {
    if (secret) {
      // Escape special regex characters in the secret before substituting
      const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      msg = msg.replace(new RegExp(escaped, 'g'), '[REDACTED]');
    }
  }
  return msg;
}

// ── Snowflake query helper ────────────────────────────────────────────────────

/**
 * Create a Snowflake connection, execute a SQL statement, return rows, then
 * destroy the connection. Per snowflake-sdk convention, connections are created
 * and destroyed per query (the SDK manages pooling internally).
 *
 * @param {string} sql
 * @returns {Promise<object[]>}
 */
function executeQuery(sql) {
  return new Promise((resolve, reject) => {
    const connOptions = {
      account: SNOWFLAKE_ACCOUNT,
      username: SNOWFLAKE_USER,
      password: SNOWFLAKE_PASSWORD,
    };
    if (SNOWFLAKE_DATABASE) connOptions.database = SNOWFLAKE_DATABASE;
    if (SNOWFLAKE_WAREHOUSE) connOptions.warehouse = SNOWFLAKE_WAREHOUSE;
    if (SNOWFLAKE_ROLE) connOptions.role = SNOWFLAKE_ROLE;

    const connection = snowflake.createConnection(connOptions);

    connection.connect((connectErr) => {
      if (connectErr) {
        reject(connectErr);
        return;
      }

      connection.execute({
        sqlText: sql,
        complete: (execErr, _stmt, rows) => {
          // Destroy connection regardless of execution outcome
          connection.destroy((destroyErr) => {
            if (destroyErr) {
              process.stderr.write(`Warning: failed to destroy Snowflake connection: ${destroyErr.message}\n`);
            }
          });

          if (execErr) {
            reject(execErr);
          } else {
            resolve(rows || []);
          }
        },
      });
    });
  });
}

// ── MCP server setup ──────────────────────────────────────────────────────────

const server = new Server(
  { name: 'snowflake-sanitizer', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// ── Tool definitions ──────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'run_sql',
      description:
        'Execute a read-only SQL query against Snowflake. PHI columns are stripped from ' +
        'results and string values are redacted. Only SELECT, DESCRIBE, SHOW, EXPLAIN, ' +
        'WITH, and USE statements are permitted. A LIMIT clause is required.',
      inputSchema: {
        type: 'object',
        properties: {
          sql: {
            type: 'string',
            description:
              'SQL statement to execute. Must start with SELECT, DESCRIBE, SHOW, EXPLAIN, ' +
              'WITH, or USE and must include a LIMIT clause.',
          },
          table_hint: {
            type: 'string',
            description:
              'Optional table/view name being queried. Used to improve PHI field detection ' +
              'accuracy for context-sensitive columns (e.g. "name" in a patients table). ' +
              'Defaults to empty string if omitted.',
          },
        },
        required: ['sql'],
      },
    },
  ],
}));

// ── Tool handlers ─────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === 'run_sql') {
      return await handleRunSql(args);
    } else {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${scrubError(err)}` }],
      isError: true,
    };
  }
});

async function handleRunSql(args) {
  const { sql, table_hint } = args || {};
  const tableHint = typeof table_hint === 'string' ? table_hint : '';

  // Validate query before executing
  validateQuery(sql);

  const raw = await executeQuery(sql);
  const sanitized = await sanitizeRows(raw, tableHint);

  const summary = `Returned ${sanitized.length} row(s).`;
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
  process.stderr.write('snowflake-sanitizer MCP server running\n');
}

main().catch(err => {
  process.stderr.write(`Fatal: ${scrubError(err)}\n`);
  process.exit(0); // exit 0 — hooks must never crash with non-zero
});
