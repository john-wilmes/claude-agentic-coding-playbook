// PreToolUse hook: intercepts MongoDB, Datadog, and Snowflake MCP tool calls when
// MCP_QUERY_INTERCEPT=1 is set, blocks them, and returns formatted queries for the
// user to run manually and paste results back.
//
// Activate by setting MCP_QUERY_INTERCEPT=1 in the environment. When not set,
// the hook fast-exits with {} and imposes no overhead.

"use strict";

let log;
try { log = require("./log"); } catch { log = { writeLog() {} }; }

// ─── Formatters ──────────────────────────────────────────────────────────────

/**
 * Format a MongoDB find query as a mongosh command.
 * @param {object} input - tool_input from mcp__mongodb__find
 * @returns {string}
 */
function formatMongoFind(input) {
  const { collection, filter, projection, sort, limit } = input || {};
  const col = collection || "unknown";
  const filterStr = JSON.stringify(filter != null ? filter : {}, null, 2);
  let cmd;
  if (projection != null) {
    const projStr = JSON.stringify(projection, null, 2);
    cmd = `db.${col}.find(${filterStr}, ${projStr})`;
  } else {
    cmd = `db.${col}.find(${filterStr})`;
  }
  if (sort != null) {
    cmd += `.sort(${JSON.stringify(sort, null, 2)})`;
  }
  if (limit != null) {
    cmd += `.limit(${limit})`;
  }
  return cmd;
}

/**
 * Format a MongoDB aggregate query as a mongosh command.
 * @param {object} input - tool_input from mcp__mongodb__aggregate
 * @returns {string}
 */
function formatMongoAggregate(input) {
  const { collection, pipeline } = input || {};
  const col = collection || "unknown";
  const pipelineStr = JSON.stringify(pipeline != null ? pipeline : [], null, 2);
  return `db.${col}.aggregate(${pipelineStr})`;
}

/**
 * Format a MongoDB discover_collection as mongosh inspection commands.
 * @param {object} input - tool_input from mcp__mongodb__discover_collection
 * @returns {string}
 */
function formatMongoDiscover(input) {
  const { collection } = input || {};
  const col = collection || "unknown";
  return `db.${col}.findOne()\ndb.${col}.getIndexes()`;
}

/**
 * Format a Datadog get_logs query as a human-readable block.
 * @param {object} input - tool_input from mcp__datadog__get_logs
 * @returns {string}
 */
function formatDatadogLogs(input) {
  const { query, from, to, limit } = input || {};
  const lines = ["Datadog Log Query:"];
  if (query != null) lines.push(`  query: ${query}`);
  if (from != null) lines.push(`  from:  ${from}`);
  if (to != null) lines.push(`  to:    ${to}`);
  if (limit != null) lines.push(`  limit: ${limit}`);
  return lines.join("\n");
}

/**
 * Format a Snowflake run_sql query — returns the SQL string as-is.
 * @param {object} input - tool_input from mcp__snowflake__run_sql
 * @returns {string}
 */
function formatSnowflakeSQL(input) {
  const { sql } = input || {};
  return sql != null ? String(sql) : "";
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

/**
 * Format a query based on tool name and input.
 * Returns null if the tool is not a known intercepted variant.
 * @param {string} toolName
 * @param {object} toolInput
 * @returns {string|null}
 */
function formatQuery(toolName, toolInput) {
  if (toolName === "mcp__mongodb__find") return formatMongoFind(toolInput);
  if (toolName === "mcp__mongodb__aggregate") return formatMongoAggregate(toolInput);
  if (toolName === "mcp__mongodb__discover_collection") return formatMongoDiscover(toolInput);
  if (toolName === "mcp__datadog__get_logs") return formatDatadogLogs(toolInput);
  if (toolName === "mcp__snowflake__run_sql") return formatSnowflakeSQL(toolInput);
  return null;
}

/**
 * Return true if the tool name belongs to an intercepted MCP service.
 * @param {string} toolName
 * @returns {boolean}
 */
function isInterceptedTool(toolName) {
  return (
    toolName.startsWith("mcp__mongodb__") ||
    toolName.startsWith("mcp__datadog__") ||
    toolName.startsWith("mcp__snowflake__")
  );
}

// ─── stdin handler ────────────────────────────────────────────────────────────

let input = "";
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    // Fast-exit if interception is not enabled
    if (process.env.MCP_QUERY_INTERCEPT !== "1") {
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    const hookInput = JSON.parse(input);
    const toolName = hookInput.tool_name || "";

    // Fast-exit for non-intercepted tools
    if (!isInterceptedTool(toolName)) {
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    const toolInput = hookInput.tool_input || {};
    const formatted = formatQuery(toolName, toolInput);

    // Fall back to raw JSON for unknown intercepted tool variants
    const queryBlock = formatted != null ? formatted : JSON.stringify(toolInput, null, 2);

    log.writeLog({
      hook: "mcp-query-interceptor",
      event: "block",
      session_id: hookInput.session_id,
      tool_use_id: hookInput.tool_use_id,
      details: toolName,
      project: hookInput.cwd,
    });

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          `MCP query intercepted — run manually and paste results back.\n\n${queryBlock}`,
      },
    }));
    process.exit(0);
  } catch {
    // Never block tool execution on errors
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }
});

// Export formatters for testing
if (typeof module !== "undefined") {
  module.exports = {
    formatMongoFind,
    formatMongoAggregate,
    formatMongoDiscover,
    formatDatadogLogs,
    formatSnowflakeSQL,
    formatQuery,
    isInterceptedTool,
  };
}
