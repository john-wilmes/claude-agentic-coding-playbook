#!/usr/bin/env node
// Integration tests for subagent-recovery.js (PostToolUse hook).
// Zero dependencies — uses only Node built-ins + local test-helpers.
//
// Run: node tests/hooks/subagent-recovery.test.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const { runHook } = require("./test-helpers");

// Resolve hook path relative to repo root
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const HOOK_PATH = path.join(REPO_ROOT, "templates", "hooks", "subagent-recovery.js");

// State directory used by the hook
const STATE_DIR = path.join(os.tmpdir(), "claude-subagent-recovery");

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

function newSessionId() {
  return `test-${crypto.randomUUID()}`;
}

function runRecovery(input, env = {}) {
  // Default: unset CLAUDE_LOOP_PID so host env doesn't change state key
  return runHook(HOOK_PATH, input, { CLAUDE_LOOP_PID: "", ...env });
}

function cleanupState(sessionId) {
  try { fs.rmSync(path.join(STATE_DIR, `${sessionId}.json`), { force: true }); } catch {}
}

function readState(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(STATE_DIR, `${sessionId}.json`), "utf8"));
  } catch { return null; }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

console.log("\nsubagent-recovery.js:");

// Test 1: Non-Task tool calls are skipped
test("1. Non-Task tool call: skip", () => {
  const sid = newSessionId();
  const result = runRecovery({
    session_id: sid,
    tool_name: "Bash",
    tool_input: { command: "ls" },
    tool_response: "file1.txt\nfile2.txt",
  });
  assert.strictEqual(result.status, 0);
  assert.deepStrictEqual(result.json, {});
});

// Test 2: Subagent context (agent_id present) is skipped
test("2. Subagent context: skip", () => {
  const sid = newSessionId();
  const result = runRecovery({
    session_id: sid,
    agent_id: "sub-123",
    tool_name: "Task",
    tool_input: { prompt: "do stuff" },
    tool_response: "Agent exhausted all turns",
  });
  assert.strictEqual(result.status, 0);
  assert.deepStrictEqual(result.json, {});
});

// Test 3: PreToolUse (no tool_response) is skipped
test("3. PreToolUse (no tool_response): skip", () => {
  const sid = newSessionId();
  const result = runRecovery({
    session_id: sid,
    tool_name: "Task",
    tool_input: { prompt: "do stuff" },
  });
  assert.strictEqual(result.status, 0);
  assert.deepStrictEqual(result.json, {});
});

// Test 4: Normal Task completion (no truncation markers) is skipped
test("4. Normal Task completion: skip", () => {
  const sid = newSessionId();
  const result = runRecovery({
    session_id: sid,
    tool_name: "Task",
    tool_input: { prompt: "read the file", description: "Read config" },
    tool_response: "The file contains configuration for the app. Here are the details...",
  });
  assert.strictEqual(result.status, 0);
  assert.deepStrictEqual(result.json, {});
});

// Test 5: Max turns truncation detected
test("5. Max turns truncation: advisory + state file", () => {
  const sid = newSessionId();
  try {
    const result = runRecovery({
      session_id: sid,
      tool_name: "Task",
      tool_input: { prompt: "Read 5 files and summarize", description: "Summarize files", model: "haiku" },
      tool_response: "I was able to read 2 files but the agent reached its maximum number of turns before completing.",
    });
    assert.strictEqual(result.status, 0);
    assert.ok(result.json.hookSpecificOutput, "Should have hookSpecificOutput");
    assert.strictEqual(result.json.hookSpecificOutput.hookEventName, "PostToolUse");
    assert.ok(result.json.hookSpecificOutput.additionalContext.includes("max_turns"));
    assert.ok(result.json.hookSpecificOutput.additionalContext.includes("Summarize files"));

    // Check state file
    const state = readState(sid);
    assert.ok(state, "State file should exist");
    assert.strictEqual(state.reason, "max_turns");
    assert.strictEqual(state.prompt, "Read 5 files and summarize");
    assert.strictEqual(state.taskDescription, "Summarize files");
    assert.strictEqual(state.model, "haiku");
    assert.ok(state.timestamp > 0);
  } finally {
    cleanupState(sid);
  }
});

// Test 6: Context overflow detected
test("6. Context overflow: advisory + state file", () => {
  const sid = newSessionId();
  try {
    const result = runRecovery({
      session_id: sid,
      tool_name: "Task",
      tool_input: { prompt: "Analyze the entire codebase", description: "Full analysis" },
      tool_response: "Partial analysis complete. The context window has been exceeded and output was truncated.",
    });
    assert.strictEqual(result.status, 0);
    assert.ok(result.json.hookSpecificOutput);
    assert.ok(result.json.hookSpecificOutput.additionalContext.includes("context_overflow"));
    assert.ok(result.json.hookSpecificOutput.additionalContext.includes("Full analysis"));

    const state = readState(sid);
    assert.ok(state);
    assert.strictEqual(state.reason, "context_overflow");
  } finally {
    cleanupState(sid);
  }
});

// Test 7: State file format validation
test("7. State file format: all required fields present", () => {
  const sid = newSessionId();
  try {
    runRecovery({
      session_id: sid,
      tool_name: "Task",
      tool_input: { prompt: "Do the thing", description: "Thing doer", model: "sonnet" },
      tool_response: "The agent exhausted all turns without finishing.",
    });
    const state = readState(sid);
    assert.ok(state, "State file should exist");
    const requiredKeys = ["prompt", "partialResult", "reason", "taskDescription", "model", "timestamp"];
    for (const key of requiredKeys) {
      assert.ok(key in state, `State file missing key: ${key}`);
    }
    assert.strictEqual(typeof state.timestamp, "number");
    assert.strictEqual(typeof state.prompt, "string");
    assert.strictEqual(typeof state.partialResult, "string");
  } finally {
    cleanupState(sid);
  }
});

// Test 8: Cross-session key (CLAUDE_LOOP_PID) used when available
test("8. Cross-session key: uses CLAUDE_LOOP_PID", () => {
  const sid = newSessionId();
  const fakePid = "99999";
  const loopKey = `loop-${fakePid}`;
  try {
    runRecovery({
      session_id: sid,
      tool_name: "Task",
      tool_input: { prompt: "Do work", description: "Work" },
      tool_response: "Agent ran out of turns.",
    }, { CLAUDE_LOOP_PID: fakePid });

    // State file should be keyed by loop PID, not session ID
    const loopState = readState(loopKey);
    assert.ok(loopState, "State file should be keyed by loop PID");
    assert.strictEqual(loopState.reason, "max_turns");

    // Session-keyed file should NOT exist
    const sessionState = readState(sid);
    assert.strictEqual(sessionState, null, "Should NOT have session-keyed state file");
  } finally {
    // Clean up loop-keyed file
    try { fs.rmSync(path.join(STATE_DIR, `${loopKey}.json`), { force: true }); } catch {}
  }
});

// Test 9: Session key (session_id) used when no loop PID
test("9. Session key: uses session_id when no CLAUDE_LOOP_PID", () => {
  const sid = newSessionId();
  try {
    runRecovery({
      session_id: sid,
      tool_name: "Task",
      tool_input: { prompt: "Do work", description: "Work" },
      tool_response: "Maximum number of turns exceeded.",
    }, { CLAUDE_LOOP_PID: "" }); // Explicitly unset

    const state = readState(sid);
    assert.ok(state, "State file should be keyed by session_id");
  } finally {
    cleanupState(sid);
  }
});

// Test 10: Idempotency — second truncation overwrites state file
test("10. Idempotency: second truncation overwrites state file", () => {
  const sid = newSessionId();
  try {
    // First truncation
    runRecovery({
      session_id: sid,
      tool_name: "Task",
      tool_input: { prompt: "First task", description: "Task 1" },
      tool_response: "Agent exhausted all turns.",
    });
    const state1 = readState(sid);
    assert.strictEqual(state1.prompt, "First task");

    // Second truncation — should overwrite
    runRecovery({
      session_id: sid,
      tool_name: "Task",
      tool_input: { prompt: "Second task", description: "Task 2" },
      tool_response: "The context window was exceeded.",
    });
    const state2 = readState(sid);
    assert.strictEqual(state2.prompt, "Second task");
    assert.strictEqual(state2.reason, "context_overflow");
  } finally {
    cleanupState(sid);
  }
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failures.length > 0) {
  console.log("Failures:");
  for (const f of failures) {
    console.log(`  - ${f.name}: ${f.error}`);
  }
  process.exit(1);
}
