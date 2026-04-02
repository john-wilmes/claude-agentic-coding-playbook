"use strict";

const assert = require("assert");
const path = require("path");
const { runHook } = require("./test-helpers");

const HOOK = path.resolve(__dirname, "../../templates/hooks/rejection-advisor.js");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failed++;
    console.error(`  \u2717 ${name}`);
    console.error(`    ${err.message}`);
  }
}

console.log("rejection-advisor.js tests:");

// --- Integration tests ---

test("Non-interrupt exits with {}", () => {
  const result = runHook(HOOK, {
    tool_name: "Bash",
    error: "command failed",
    is_interrupt: false,
  });
  assert.strictEqual(result.status, 0);
  assert.ok(!result.json?.hookSpecificOutput?.additionalContext);
});

test("User rejection injects general advice", () => {
  const result = runHook(HOOK, {
    tool_name: "Bash",
    error: "User rejected",
    is_interrupt: true,
  });
  assert.strictEqual(result.status, 0);
  const ctx = result.json?.hookSpecificOutput?.additionalContext || "";
  assert.ok(ctx.includes("rejected your tool call"), `Missing general advice: ${ctx}`);
  assert.ok(ctx.includes("Do NOT retry"), `Missing retry warning: ${ctx}`);
});

test("MongoDB rejection includes mongo-specific advice", () => {
  const result = runHook(HOOK, {
    tool_name: "mcp__mongodb__find",
    error: "User rejected",
    is_interrupt: true,
  });
  const ctx = result.json?.hookSpecificOutput?.additionalContext || "";
  assert.ok(ctx.includes("$oid"), `Missing $oid advice: ${ctx}`);
  assert.ok(ctx.includes("users"), `Missing collection advice: ${ctx}`);
});

test("Datadog rejection includes DD-specific advice", () => {
  const result = runHook(HOOK, {
    tool_name: "mcp__datadog__get_logs",
    error: "User rejected",
    is_interrupt: true,
  });
  const ctx = result.json?.hookSpecificOutput?.additionalContext || "";
  assert.ok(ctx.includes("integrator, rest, chat, followup"), `Missing service names: ${ctx}`);
  assert.ok(ctx.includes("NOT integrator-service"), `Missing anti-pattern: ${ctx}`);
});

test("Snowflake rejection includes SF-specific advice", () => {
  const result = runHook(HOOK, {
    tool_name: "mcp__snowflake__run_sql",
    error: "User rejected",
    is_interrupt: true,
  });
  const ctx = result.json?.hookSpecificOutput?.additionalContext || "";
  assert.ok(ctx.includes("LIMIT"), `Missing LIMIT advice: ${ctx}`);
});

test("Snowflake non-run_sql tool also gets SF-specific advice", () => {
  const result = runHook(HOOK, {
    tool_name: "mcp__snowflake__describe_table",
    error: "User rejected",
    is_interrupt: true,
  });
  const ctx = result.json?.hookSpecificOutput?.additionalContext || "";
  assert.ok(ctx.includes("LIMIT"), `Missing LIMIT advice for non-run_sql SF tool: ${ctx}`);
});

test("Non-MCP rejection gets only general advice", () => {
  const result = runHook(HOOK, {
    tool_name: "Edit",
    error: "User rejected",
    is_interrupt: true,
  });
  const ctx = result.json?.hookSpecificOutput?.additionalContext || "";
  assert.ok(ctx.includes("rejected your tool call"), `Missing general advice`);
  assert.ok(!ctx.includes("$oid"), `Should not have mongo advice for Edit`);
  assert.ok(!ctx.includes("LIMIT"), `Should not have snowflake advice for Edit`);
});

test("Missing tool_name still works", () => {
  const result = runHook(HOOK, {
    error: "User rejected",
    is_interrupt: true,
  });
  assert.strictEqual(result.status, 0);
  const ctx = result.json?.hookSpecificOutput?.additionalContext || "";
  assert.ok(ctx.includes("rejected your tool call"));
});

test("Malformed JSON exits cleanly with {} output", () => {
  const { runHookRaw } = require("./test-helpers");
  const result = runHookRaw(HOOK, "not json");
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout.trim(), "{}");
});

// --- Unit tests ---

const { buildAdvice, GENERAL_ADVICE, MONGO_ADVICE, DATADOG_ADVICE, SNOWFLAKE_ADVICE } = require(HOOK);

test("buildAdvice: unknown tool returns general only", () => {
  const advice = buildAdvice("Write");
  assert.ok(advice.includes(GENERAL_ADVICE));
  assert.ok(!advice.includes(MONGO_ADVICE));
});

test("buildAdvice: mongodb tool includes mongo advice", () => {
  const advice = buildAdvice("mcp__mongodb__aggregate");
  assert.ok(advice.includes(GENERAL_ADVICE));
  assert.ok(advice.includes(MONGO_ADVICE));
});

test("buildAdvice: datadog tool includes DD advice", () => {
  const advice = buildAdvice("mcp__datadog__get_logs");
  assert.ok(advice.includes(DATADOG_ADVICE));
});

test("buildAdvice: snowflake tool includes SF advice", () => {
  const advice = buildAdvice("mcp__snowflake__run_sql");
  assert.ok(advice.includes(SNOWFLAKE_ADVICE));
});

test("buildAdvice: snowflake prefix matches non-run_sql tools", () => {
  const advice = buildAdvice("mcp__snowflake__describe_table");
  assert.ok(advice.includes(SNOWFLAKE_ADVICE));
});

test("buildAdvice: null tool returns general only", () => {
  const advice = buildAdvice(null);
  assert.ok(advice.includes(GENERAL_ADVICE));
});

// --- Text-based rejection detection ---

test("tool_result rejection text triggers advice without is_interrupt", () => {
  const result = runHook(HOOK, {
    tool_name: "Agent",
    tool_result: "The user doesn't want to proceed with this tool use. The tool use was rejected.",
    is_interrupt: false,
  });
  assert.strictEqual(result.status, 0);
  const ctx = result.json?.hookSpecificOutput?.additionalContext || "";
  assert.ok(ctx.includes("rejected your tool call"), `Should fire on rejection text: ${ctx}`);
});

test("tool_result without rejection text does not trigger", () => {
  const result = runHook(HOOK, {
    tool_name: "Agent",
    tool_result: "Agent completed successfully",
    is_interrupt: false,
  });
  assert.strictEqual(result.status, 0);
  assert.ok(!result.json?.hookSpecificOutput?.additionalContext);
});

console.log(`\n${"─".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed (${passed + failed} total)`);
process.exit(failed > 0 ? 1 : 0);
