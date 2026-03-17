#!/usr/bin/env node
// Integration tests for tool-failure-logger.js (PostToolUseFailure hook).
// Zero dependencies — uses only Node built-ins + local test-helpers.
//
// Run: node tests/hooks/tool-failure-logger.test.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const { runHook, runHookRaw } = require("./test-helpers");

// Resolve hook path relative to repo root
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const HOOK = path.join(REPO_ROOT, "templates", "hooks", "tool-failure-logger.js");

// Import pure functions for unit tests
const { summarizeInput, REPEAT_THRESHOLD } = require(HOOK);

// Session tracking dir (matches the hook's SESSION_DIR)
const SESSION_DIR = path.join(os.tmpdir(), "claude-tool-failures");

// ─── Test runner ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message });
    console.log(`  \u2717 ${name}`);
    console.log(`    ${err.message}`);
  }
}

// Generate unique session IDs per test to avoid cross-contamination
function uniqueSession() {
  return `test-${crypto.randomUUID().slice(0, 12)}`;
}

// Clean up a session tracking file
function cleanupSession(sessionId) {
  try { fs.unlinkSync(path.join(SESSION_DIR, `${sessionId}.json`)); } catch {}
}

// ─── Unit tests: summarizeInput ──────────────────────────────────────────────

console.log("\ntool-failure-logger.js:");

test("1. summarizeInput: returns null for null/undefined input", () => {
  assert.strictEqual(summarizeInput(null), null);
  assert.strictEqual(summarizeInput(undefined), null);
});

test("2. summarizeInput: returns null for non-object input", () => {
  assert.strictEqual(summarizeInput("string"), null);
  assert.strictEqual(summarizeInput(42), null);
});

test("3. summarizeInput: truncates sensitive fields (content, body, new_string)", () => {
  const input = {
    content: "A".repeat(500),
    command: "ls",
    new_string: "B".repeat(500),
  };
  const result = summarizeInput(input);
  assert.ok(result.content.length < 100, `content should be truncated, got length ${result.content.length}`);
  assert.strictEqual(result.command, "ls", "Non-sensitive short fields should pass through");
  assert.ok(result.new_string.length < 100, `new_string should be truncated, got length ${result.new_string.length}`);
});

test("4. summarizeInput: truncates long string values over 200 chars", () => {
  const input = { file_path: "C".repeat(300) };
  const result = summarizeInput(input);
  assert.ok(result.file_path.length < 200, `Long value should be truncated, got length ${result.file_path.length}`);
});

test("5. summarizeInput: passes through short non-sensitive fields unchanged", () => {
  const input = { command: "npm test", description: "Run tests", timeout: 5000 };
  const result = summarizeInput(input);
  assert.strictEqual(result.command, "npm test");
  assert.strictEqual(result.description, "Run tests");
  assert.strictEqual(result.timeout, 5000);
});

test("6. REPEAT_THRESHOLD is 3", () => {
  assert.strictEqual(REPEAT_THRESHOLD, 3);
});

// ─── Integration tests ──────────────────────────────────────────────────────

test("7. Hook outputs {} on empty stdin", () => {
  const result = runHookRaw(HOOK, "");
  assert.strictEqual(result.status, 0, "Should exit 0");
  assert.deepStrictEqual(result.json, {}, "Should output {} on empty input");
});

test("8. Hook outputs {} on malformed JSON", () => {
  const result = runHookRaw(HOOK, "not valid json {{{");
  assert.strictEqual(result.status, 0, "Should exit 0");
  assert.deepStrictEqual(result.json, {}, "Should output {} on parse error");
});

test("9. Hook outputs {} for interrupt failures", () => {
  const sid = uniqueSession();
  try {
    const result = runHook(HOOK, {
      session_id: sid,
      tool_name: "Bash",
      error: "Interrupted",
      is_interrupt: true,
    });
    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.deepStrictEqual(result.json, {}, "Should output {} for interrupts");
  } finally {
    cleanupSession(sid);
  }
});

test("10. Hook outputs {} for first failure (below threshold)", () => {
  const sid = uniqueSession();
  try {
    const result = runHook(HOOK, {
      session_id: sid,
      tool_name: "Edit",
      tool_input: { file_path: "/tmp/test.js", old_string: "foo", new_string: "bar" },
      error: "old_string not found in file",
      tool_use_id: "toolu_001",
      cwd: os.tmpdir(),
    });
    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.deepStrictEqual(result.json, {}, "Should output {} below threshold");
  } finally {
    cleanupSession(sid);
  }
});

test("11. Hook tracks failures and warns after REPEAT_THRESHOLD", () => {
  const sid = uniqueSession();
  try {
    // Fire REPEAT_THRESHOLD failures for the same tool
    for (let i = 0; i < REPEAT_THRESHOLD; i++) {
      runHook(HOOK, {
        session_id: sid,
        tool_name: "Bash",
        error: `Command failed attempt ${i + 1}`,
        tool_use_id: `toolu_${i}`,
        cwd: os.tmpdir(),
      });
    }
    // The last call (at threshold) should have produced the warning.
    // Run one more to confirm ongoing warnings.
    const result = runHook(HOOK, {
      session_id: sid,
      tool_name: "Bash",
      error: "Command failed again",
      tool_use_id: "toolu_extra",
      cwd: os.tmpdir(),
    });
    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.ok(result.json.hookSpecificOutput, "Should have hookSpecificOutput");
    const ctx = result.json.hookSpecificOutput.additionalContext;
    assert.ok(typeof ctx === "string", "additionalContext should be a string");
    assert.ok(ctx.includes("Bash"), `Should mention the failing tool name, got: ${ctx}`);
    assert.ok(ctx.includes("failed"), `Should mention failure, got: ${ctx}`);
    assert.ok(ctx.includes("different approach"), `Should suggest different approach, got: ${ctx}`);
  } finally {
    cleanupSession(sid);
  }
});

test("12. Hook tracks different tools independently", () => {
  const sid = uniqueSession();
  try {
    // Fail Bash twice
    for (let i = 0; i < 2; i++) {
      runHook(HOOK, {
        session_id: sid,
        tool_name: "Bash",
        error: "fail",
        tool_use_id: `toolu_bash_${i}`,
        cwd: os.tmpdir(),
      });
    }
    // Fail Edit once — total failures across tools = 3, but each tool < threshold
    const result = runHook(HOOK, {
      session_id: sid,
      tool_name: "Edit",
      error: "fail",
      tool_use_id: "toolu_edit_0",
      cwd: os.tmpdir(),
    });
    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.deepStrictEqual(result.json, {}, "Should output {} — each tool below threshold independently");
  } finally {
    cleanupSession(sid);
  }
});

test("13. Hook creates session tracking file in temp dir", () => {
  const sid = uniqueSession();
  try {
    runHook(HOOK, {
      session_id: sid,
      tool_name: "Write",
      error: "Permission denied",
      tool_use_id: "toolu_w1",
      cwd: os.tmpdir(),
    });
    const sessionFile = path.join(SESSION_DIR, `${sid}.json`);
    assert.ok(fs.existsSync(sessionFile), "Should create session tracking file");
    const counts = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
    assert.strictEqual(counts.Write, 1, "Should track 1 Write failure");
  } finally {
    cleanupSession(sid);
  }
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed (${passed + failed} total)`);

if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) {
    console.log(`  \u2717 ${f.name}: ${f.error}`);
  }
}

process.exit(failed > 0 ? 1 : 0);
