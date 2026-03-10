#!/usr/bin/env node
// Integration tests for stuck-detector.js (PreToolUse hook).
// Zero dependencies — uses only Node built-ins + local test-helpers.
//
// Run: node tests/hooks/stuck-detector.test.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const { runHook } = require("./test-helpers");

// Resolve hook path relative to repo root
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const STUCK_DETECTOR = path.join(REPO_ROOT, "templates", "hooks", "stuck-detector.js");

// State directory used by the hook
const STATE_DIR = path.join(os.tmpdir(), "claude-stuck-detector");

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Generate a unique session_id so each test has isolated state.
 */
function newSessionId() {
  return `test-${crypto.randomUUID()}`;
}

/**
 * Run the stuck-detector hook once with the given session_id and tool payload.
 */
function runDetector(sessionId, toolName, toolInput) {
  return runHook(STUCK_DETECTOR, {
    session_id: sessionId,
    tool_name: toolName,
    tool_input: toolInput,
  });
}

/**
 * Clean up the state file for a given session_id.
 */
function cleanupSession(sessionId) {
  const stateFile = path.join(STATE_DIR, `${sessionId}.json`);
  try { fs.rmSync(stateFile, { force: true }); } catch {}
}

// ─── Tests ───────────────────────────────────────────────────────────────────

console.log("\nstuck-detector.js:");

// Test 1: First call — no warning, passes through
test("1. First call: no warning", () => {
  const sessionId = newSessionId();
  try {
    const result = runDetector(sessionId, "Bash", { command: "ls" });

    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.ok(result.json, "Should output valid JSON");
    // No decision field means allow; additionalContext absent means no warning
    assert.strictEqual(result.json.decision, undefined, "Should not block");
    assert.strictEqual(result.json.hookSpecificOutput, undefined, "Should not warn");
  } finally {
    cleanupSession(sessionId);
  }
});

// Test 2: 3 identical calls — warning in additionalContext (not a block)
test("2. 3 identical calls: warning in additionalContext", () => {
  const sessionId = newSessionId();
  try {
    const payload = { command: "git status" };
    runDetector(sessionId, "Bash", payload); // call 1
    runDetector(sessionId, "Bash", payload); // call 2
    const result = runDetector(sessionId, "Bash", payload); // call 3

    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.ok(result.json, "Should output valid JSON");
    assert.strictEqual(result.json.decision, undefined, "Should not block at 3");
    assert.ok(result.json.hookSpecificOutput, "Should have hookSpecificOutput");
    assert.ok(
      result.json.hookSpecificOutput.additionalContext.includes("3 times"),
      `additionalContext should mention '3 times', got: ${result.json.hookSpecificOutput.additionalContext}`
    );
  } finally {
    cleanupSession(sessionId);
  }
});

// Test 3: 5 identical calls — blocked
test("3. 5 identical calls: blocked", () => {
  const sessionId = newSessionId();
  try {
    const payload = { command: "npm test" };
    for (let i = 0; i < 4; i++) {
      runDetector(sessionId, "Bash", payload);
    }
    const result = runDetector(sessionId, "Bash", payload); // call 5

    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.ok(result.json, "Should output valid JSON");
    assert.strictEqual(result.json.decision, "block", "Should block at 5");
    assert.ok(
      result.json.reason.includes("5 identical"),
      `reason should mention '5 identical', got: ${result.json.reason}`
    );
  } finally {
    cleanupSession(sessionId);
  }
});

// Test 4: Different calls interspersed — consecutive count resets, no warning
test("4. Different calls interspersed: no warning (consecutive count resets)", () => {
  const sessionId = newSessionId();
  try {
    runDetector(sessionId, "Bash", { command: "ls" });          // hash A
    runDetector(sessionId, "Bash", { command: "ls" });          // hash A  (2x A)
    runDetector(sessionId, "Bash", { command: "pwd" });         // hash B  (resets A streak)
    runDetector(sessionId, "Bash", { command: "ls" });          // hash A  (1x A again)
    const result = runDetector(sessionId, "Bash", { command: "ls" }); // hash A  (2x A)

    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.ok(result.json, "Should output valid JSON");
    assert.strictEqual(result.json.decision, undefined, "Should not block");
    assert.strictEqual(result.json.hookSpecificOutput, undefined, "Should not warn — only 2 consecutive");
  } finally {
    cleanupSession(sessionId);
  }
});

// Test 5: After a block at 5, a different call resets (no block, no warning)
test("5. After block at 5, different call resets (no block, no warning)", () => {
  const sessionId = newSessionId();
  try {
    const payload = { command: "echo stuck" };
    for (let i = 0; i < 5; i++) {
      runDetector(sessionId, "Bash", payload);
    }
    // The 5th call was blocked. Now send a different call.
    const result = runDetector(sessionId, "Bash", { command: "echo different" });

    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.ok(result.json, "Should output valid JSON");
    assert.strictEqual(result.json.decision, undefined, "Should not block after reset");
    assert.strictEqual(result.json.hookSpecificOutput, undefined, "Should not warn after reset");
  } finally {
    cleanupSession(sessionId);
  }
});

// Bonus: malformed JSON input — should exit 0 and output {}
test("6. Malformed JSON input: exits 0 with {}", () => {
  const result = runHook(STUCK_DETECTOR, "not valid json at all");

  assert.strictEqual(result.status, 0, "Should exit 0");
  assert.ok(result.json, "Should output valid JSON");
  assert.deepStrictEqual(result.json, {}, "Should output empty object on error");
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed (${passed + failed} total)`);

if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) {
    console.log(`  \u2717 ${f.name}: ${f.error}`);
  }
}

process.exit(failed > 0 ? 1 : 0);
