"use strict";

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");

// ─── Load module under test ─────────────────────────────────────────────────

const hookPath = path.resolve(__dirname, "../../templates/hooks/mcp-result-advisor.js");
const {
  buildAdvice, isZeroResult, readState, writeState,
  CHEAT_SHEET, MONGO_ZERO_RESULT_TIPS, DATADOG_ZERO_RESULT_TIPS, COLLECTION_QUERY_GUIDE,
  STATE_FILE, STATE_DIR,
} = require(hookPath);

// ─── Test helpers ───────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function unitTest(name, fn) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    passed++;
  } catch (e) {
    console.log(`  \u2717 ${name}: ${e.message}`);
    failed++;
    failures.push(name);
  }
}

function test(name, fn) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    passed++;
  } catch (e) {
    console.log(`  \u2717 ${name}: ${e.message}`);
    failed++;
    failures.push(name);
  }
}

function cleanState() {
  try { fs.unlinkSync(STATE_FILE); } catch { /* ok */ }
  // Also remove per-session atomic marker files
  try {
    for (const entry of fs.readdirSync(STATE_DIR)) {
      if (entry.endsWith(".seen")) {
        try { fs.unlinkSync(path.join(STATE_DIR, entry)); } catch { /* ok */ }
      }
    }
  } catch { /* ok if dir doesn't exist */ }
}

function runHook(toolName, toolResult, sessionId) {
  const hookInput = JSON.stringify({
    tool_name: toolName,
    tool_response: toolResult,
    session_id: sessionId || "test-session",
    tool_use_id: "test-tool-use",
    cwd: "/tmp/test",
  });

  // Strip CLAUDE_LOOP* env vars
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLAUDE_LOOP")) delete env[key];
  }

  const result = execFileSync(process.execPath, [hookPath], {
    input: hookInput,
    encoding: "utf8",
    env,
    timeout: 5000,
  });
  return JSON.parse(result);
}

// ─── Unit tests: isZeroResult ───────────────────────────────────────────────

console.log("\nmcp-result-advisor.js (unit: isZeroResult):");

unitTest("U1. MongoDB 'No documents found' -> true", () => {
  assert.strictEqual(isZeroResult("mcp__mongodb__find", "No documents found"), true);
});

unitTest("U2. MongoDB '0 documents' -> true", () => {
  assert.strictEqual(isZeroResult("mcp__mongodb__find", "Found 0 documents"), true);
});

unitTest("U3. MongoDB empty array -> true", () => {
  assert.strictEqual(isZeroResult("mcp__mongodb__find", "[]"), true);
});

unitTest("U4. MongoDB with results -> false", () => {
  assert.strictEqual(isZeroResult("mcp__mongodb__find", '[{"_id": "abc"}]'), false);
});

unitTest("U5. Datadog 'No logs found' -> true", () => {
  assert.strictEqual(isZeroResult("mcp__datadog__get_logs", "No logs found"), true);
});

unitTest("U6. Datadog '0 logs' -> true", () => {
  assert.strictEqual(isZeroResult("mcp__datadog__get_logs", "0 logs returned"), true);
});

unitTest("U7. Datadog with results -> false", () => {
  assert.strictEqual(isZeroResult("mcp__datadog__get_logs", "Found 5 logs..."), false);
});

unitTest("U8. null toolResult -> false", () => {
  assert.strictEqual(isZeroResult("mcp__mongodb__find", null), false);
});

unitTest("U9. Snowflake tool -> false (no zero-result detection)", () => {
  assert.strictEqual(isZeroResult("mcp__snowflake__run_sql", "No documents found"), false);
});

unitTest("U10. MongoDB 'no matching logs' -> false (wrong tool prefix)", () => {
  assert.strictEqual(isZeroResult("mcp__mongodb__find", "no matching logs"), false);
});

// ─── Unit tests: buildAdvice ────────────────────────────────────────────────

console.log("\nmcp-result-advisor.js (unit: buildAdvice):");

unitTest("U11. first call -> includes cheat sheet", () => {
  cleanState();
  const advice = buildAdvice("mcp__mongodb__find", "found 5 docs", "session-u11");
  assert.ok(advice, "Expected advice");
  assert.ok(advice.includes("MCP Data Access Reminders"), "Expected cheat sheet");
});

unitTest("U12. second call same session -> no cheat sheet", () => {
  cleanState();
  buildAdvice("mcp__mongodb__find", "found 5 docs", "session-u12");
  const advice = buildAdvice("mcp__mongodb__find", "found 5 docs", "session-u12");
  assert.strictEqual(advice, null, "Expected null on second call with results");
});

unitTest("U13. different session -> gets cheat sheet again", () => {
  cleanState();
  buildAdvice("mcp__mongodb__find", "found 5 docs", "session-u13a");
  const advice = buildAdvice("mcp__mongodb__find", "found 5 docs", "session-u13b");
  assert.ok(advice && advice.includes("MCP Data Access Reminders"), "Different session should get cheat sheet");
});

unitTest("U14. zero-result MongoDB -> includes troubleshooting", () => {
  cleanState();
  const advice = buildAdvice("mcp__mongodb__find", "No documents found", "session-u14");
  assert.ok(advice.includes("Bare ObjectId"), "Expected MongoDB troubleshooting tips");
});

unitTest("U15. zero-result Datadog -> includes troubleshooting", () => {
  cleanState();
  const advice = buildAdvice("mcp__datadog__get_logs", "No logs found", "session-u15");
  assert.ok(advice.includes("Phantom filter keys"), "Expected Datadog troubleshooting tips");
});

unitTest("U16. zero-result on second call -> tips without cheat sheet", () => {
  cleanState();
  buildAdvice("mcp__mongodb__find", "found 5 docs", "session-u16");
  const advice = buildAdvice("mcp__mongodb__find", "No documents found", "session-u16");
  assert.ok(advice, "Expected advice");
  assert.ok(!advice.includes("MCP Data Access Reminders"), "No cheat sheet on second call");
  assert.ok(advice.includes("Bare ObjectId"), "Expected MongoDB tips");
});

unitTest("U17. Snowflake first call -> cheat sheet only", () => {
  cleanState();
  const advice = buildAdvice("mcp__snowflake__run_sql", "results...", "session-u17");
  assert.ok(advice && advice.includes("MCP Data Access Reminders"), "Expected cheat sheet for Snowflake");
});

unitTest("U18. discover_collection with known collection -> includes query guide", () => {
  cleanState();
  const advice = buildAdvice("mcp__mongodb__discover_collection", "indexes: ...", "session-u18", { collection: "integrators" });
  assert.ok(advice, "Expected advice");
  assert.ok(advice.includes('Query guide for "integrators"'), "Expected integrators query guide");
  assert.ok(advice.includes('"user"'), "Expected user org field mention");
});

unitTest("U19. discover_collection with unknown collection -> no query guide (cheat sheet only)", () => {
  cleanState();
  const advice = buildAdvice("mcp__mongodb__discover_collection", "indexes: ...", "session-u19", { collection: "customcollection" });
  assert.ok(advice, "Expected cheat sheet");
  assert.ok(advice.includes("MCP Data Access Reminders"), "Expected cheat sheet");
  assert.ok(!advice.includes("Query guide"), "No query guide for unknown collection");
});

unitTest("U20. discover_collection for appointments -> mentions plain string org", () => {
  cleanState();
  const advice = buildAdvice("mcp__mongodb__discover_collection", "indexes: ...", "session-u20", { collection: "appointments" });
  assert.ok(advice.includes("plain string"), "Expected plain string mention for appointments org");
});

unitTest("U21. discover_collection for patientforms -> mentions root field", () => {
  cleanState();
  const advice = buildAdvice("mcp__mongodb__discover_collection", "indexes: ...", "session-u21", { collection: "patientforms" });
  assert.ok(advice.includes('"root"'), "Expected root org field for patientforms");
});

// ─── Integration tests ──────────────────────────────────────────────────────

console.log("\nmcp-result-advisor.js (integration):");

test("I1. non-MCP tool -> empty output", () => {
  cleanState();
  const result = runHook("Read", "/some/file content", "session-i1");
  assert.deepStrictEqual(result, {});
});

test("I2. first MongoDB call -> cheat sheet injected", () => {
  cleanState();
  const result = runHook("mcp__mongodb__find", "found 3 documents", "session-i2");
  assert.ok(result.hookSpecificOutput, "Expected hookSpecificOutput");
  assert.ok(result.hookSpecificOutput.additionalContext.includes("MCP Data Access Reminders"));
});

test("I3. second MongoDB call same session -> no output", () => {
  cleanState();
  runHook("mcp__mongodb__find", "found 3 documents", "session-i3");
  const result = runHook("mcp__mongodb__find", "found 3 documents", "session-i3");
  assert.deepStrictEqual(result, {});
});

test("I4. MongoDB zero results -> troubleshooting injected", () => {
  cleanState();
  runHook("mcp__mongodb__find", "found 3 docs", "session-i4"); // consume cheat sheet
  const result = runHook("mcp__mongodb__find", "No documents found", "session-i4");
  assert.ok(result.hookSpecificOutput, "Expected hookSpecificOutput");
  assert.ok(result.hookSpecificOutput.additionalContext.includes("Bare ObjectId"));
});

test("I5. Datadog zero results -> troubleshooting injected", () => {
  cleanState();
  runHook("mcp__datadog__get_logs", "found 5 logs", "session-i5"); // consume cheat sheet
  const result = runHook("mcp__datadog__get_logs", "No logs found", "session-i5");
  assert.ok(result.hookSpecificOutput, "Expected hookSpecificOutput");
  assert.ok(result.hookSpecificOutput.additionalContext.includes("Phantom filter keys"));
});

test("I6. first call + zero results -> both cheat sheet and tips", () => {
  cleanState();
  const result = runHook("mcp__mongodb__find", "No documents found", "session-i6");
  assert.ok(result.hookSpecificOutput, "Expected hookSpecificOutput");
  const ctx = result.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes("MCP Data Access Reminders"), "Expected cheat sheet");
  assert.ok(ctx.includes("Bare ObjectId"), "Expected troubleshooting tips");
});

test("I7. malformed JSON input -> graceful exit", () => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLAUDE_LOOP")) delete env[key];
  }
  const result = execFileSync(process.execPath, [hookPath], {
    input: "not json",
    encoding: "utf8",
    env,
    timeout: 5000,
  });
  assert.deepStrictEqual(JSON.parse(result), {});
});

test("I8. empty input -> graceful exit", () => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLAUDE_LOOP")) delete env[key];
  }
  const result = execFileSync(process.execPath, [hookPath], {
    input: "",
    encoding: "utf8",
    env,
    timeout: 5000,
  });
  assert.deepStrictEqual(JSON.parse(result), {});
});

test("I9. discover_collection for integrators -> query guide injected", () => {
  cleanState();
  const hookInput = JSON.stringify({
    tool_name: "mcp__mongodb__discover_collection",
    tool_response: "Found indexes: user_1, type_1",
    tool_input: { collection: "integrators" },
    session_id: "session-i9",
    tool_use_id: "test-tool-use",
    cwd: "/tmp/test",
  });
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLAUDE_LOOP")) delete env[key];
  }
  const result = JSON.parse(execFileSync(process.execPath, [hookPath], {
    input: hookInput,
    encoding: "utf8",
    env,
    timeout: 5000,
  }));
  assert.ok(result.hookSpecificOutput, "Expected hookSpecificOutput");
  const ctx = result.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes('Query guide for "integrators"'), "Expected integrators query guide");
});

// ─── Cleanup and summary ────────────────────────────────────────────────────

cleanState();

console.log(`\n${"─".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed (${passed + failed} total)`);
if (failures.length > 0) {
  console.log(`Failures: ${failures.join(", ")}`);
  process.exit(1);
}
