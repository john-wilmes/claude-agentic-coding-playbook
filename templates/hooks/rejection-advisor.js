"use strict";

// PostToolUseFailure hook: when the user rejects a tool call, inject advice
// to immediately analyze what went wrong and report — don't go silent.
//
// Also provides domain-specific troubleshooting for MCP data tool rejections.

const DATADOG_SERVICES = "integrator, rest, chat, followup";

const GENERAL_ADVICE =
  "The user rejected your tool call. Do NOT retry or go silent. " +
  "Immediately explain: (1) what you were trying to do, (2) what was likely " +
  "wrong with the call, and (3) your corrected approach. If unsure why it " +
  "was rejected, ask.";

const MONGO_ADVICE =
  "MongoDB query rejected. Check: " +
  "(1) $oid wrappers on ObjectId fields, " +
  "(2) collection name (no 'providers'/'patients' — use 'users' with type filter), " +
  "(3) projection is inclusion-mode (value: 1), " +
  "(4) filter is non-empty, " +
  "(5) appointment statuses are only: unconfirmed, confirmed, cancelled.";

const DATADOG_ADVICE =
  "Datadog query rejected. Check: " +
  `(1) service name — real names are: ${DATADOG_SERVICES} (NOT integrator-service), ` +
  "(2) time_range is an enum (1h|4h|8h|1d|7d|14d|30d), " +
  "(3) filters is an object not a query string, " +
  "(4) use @-prefixed attribute filters for hex IDs.";

const SNOWFLAKE_ADVICE =
  "Snowflake query rejected. Check: " +
  "(1) LIMIT clause is present, " +
  "(2) query is SELECT/DESCRIBE/SHOW/EXPLAIN/WITH/USE only (read-only).";

function buildAdvice(toolName) {
  const parts = [GENERAL_ADVICE];

  if (toolName && toolName.startsWith("mcp__mongodb__")) {
    parts.push(MONGO_ADVICE);
  } else if (toolName && toolName.startsWith("mcp__datadog__")) {
    parts.push(DATADOG_ADVICE);
  } else if (toolName && toolName.startsWith("mcp__snowflake__")) {
    parts.push(SNOWFLAKE_ADVICE);
  }

  return parts.join("\n\n");
}

// ─── Hook logic ─────────────────────────────────────────────────────────────

function handleHookInput(hookInput) {
  // Fire on user rejections: either is_interrupt flag or rejection text in tool_result
  const result = hookInput.tool_result || "";
  const isRejection = hookInput.is_interrupt ||
    (typeof result === "string" && result.includes("The user doesn't want to proceed"));
  if (!isRejection) {
    return {};
  }

  const toolName = hookInput.tool_name || "";
  const advice = buildAdvice(toolName);

  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUseFailure",
      additionalContext: advice,
    },
  };
}

// ─── stdin handler ──────────────────────────────────────────────────────────

function main() {
  let input = "";
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => {
    let output = {};
    try {
      output = handleHookInput(JSON.parse(input));
    } catch {}
    try {
      process.stdout.write(JSON.stringify(output));
    } catch {
      try { process.stdout.write("{}"); } catch {}
    }
    process.exitCode = 0;
  });
}

if (require.main === module) {
  main();
}

// ─── Exports ────────────────────────────────────────────────────────────────

if (typeof module !== "undefined") {
  module.exports = { buildAdvice, handleHookInput, GENERAL_ADVICE, MONGO_ADVICE, DATADOG_ADVICE, SNOWFLAKE_ADVICE };
}
