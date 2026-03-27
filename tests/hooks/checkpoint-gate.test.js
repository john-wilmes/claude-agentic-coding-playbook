#!/usr/bin/env node
// Integration tests for templates/hooks/checkpoint-gate.js
// Zero dependencies — uses only Node built-ins + local test-helpers.
//
// Run: node tests/hooks/checkpoint-gate.test.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { runHook, runHookRaw, createTempHome, todayLocal } = require("./test-helpers");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const HOOK_PATH = path.join(REPO_ROOT, "templates", "hooks", "checkpoint-gate.js");

// ─── Test runner ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  const env = createTempHome();
  try {
    fn(env);
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message });
    console.log(`  \u2717 ${name}`);
    console.log(`    ${err.message}`);
  } finally {
    env.cleanup();
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const FAKE_PID = `ckgate-test-${process.pid}`;

function sentinelPath() {
  return path.join(os.tmpdir(), `claude-checkpoint-exit-${FAKE_PID}`);
}

function contextHighPath() {
  return path.join(os.tmpdir(), `claude-context-high-${FAKE_PID}`);
}

function runGate(toolName, extraEnv = {}, homeEnv = {}) {
  return runHook(HOOK_PATH, {
    tool_name: toolName,
    tool_input: {},
    session_id: "test-session",
    tool_use_id: "tu-001",
    cwd: "/tmp/test-project",
  }, { CLAUDE_LOOP_PID: FAKE_PID, ...homeEnv, ...extraEnv });
}

function cleanup() {
  try { fs.rmSync(sentinelPath()); } catch {}
  try { fs.rmSync(contextHighPath()); } catch {}
}

// ─── Tests ────────────────────────────────────────────────────────────────────

console.log("\ncheckpoint-gate.js:");

test("1. No sentinel, no context-high flag -> allow ({})", (env) => {
  cleanup();
  const result = runGate("Read", {}, { HOME: env.home, USERPROFILE: env.home });

  assert.strictEqual(result.status, 0);
  assert.ok(result.json, "Should output valid JSON");
  assert.deepStrictEqual(result.json, {}, "Should return {} (allow)");
});

test("2. Checkpoint sentinel exists -> deny all tools", (env) => {
  cleanup();
  fs.writeFileSync(sentinelPath(), JSON.stringify({ reason: "checkpoint", timestamp: Date.now() }));
  try {
    const result = runGate("Read", {}, { HOME: env.home, USERPROFILE: env.home });

    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.json.hookSpecificOutput.permissionDecision, "deny");
    assert.ok(
      result.json.hookSpecificOutput.permissionDecisionReason.includes("checkpoint complete"),
      `Reason was: ${result.json.hookSpecificOutput.permissionDecisionReason}`
    );
  } finally {
    cleanup();
  }
});

test("3. Context-high flag exists, tool is Bash -> allow", (env) => {
  cleanup();
  fs.writeFileSync(contextHighPath(), JSON.stringify({ reason: "context-high", ratio: 0.65, timestamp: Date.now() }));
  try {
    const result = runGate("Bash", {}, { HOME: env.home, USERPROFILE: env.home });

    assert.strictEqual(result.status, 0);
    assert.deepStrictEqual(result.json, {}, "Bash should be allowed when context-high");
  } finally {
    cleanup();
  }
});

test("4. Context-high flag exists, tool is Skill -> allow", (env) => {
  cleanup();
  fs.writeFileSync(contextHighPath(), JSON.stringify({ reason: "context-high", ratio: 0.65, timestamp: Date.now() }));
  try {
    const result = runGate("Skill", {}, { HOME: env.home, USERPROFILE: env.home });

    assert.strictEqual(result.status, 0);
    assert.deepStrictEqual(result.json, {}, "Skill should be allowed when context-high");
  } finally {
    cleanup();
  }
});

test("5. Context-high flag exists, tool is Read -> deny", (env) => {
  cleanup();
  fs.writeFileSync(contextHighPath(), JSON.stringify({ reason: "context-high", ratio: 0.65, timestamp: Date.now() }));
  try {
    const result = runGate("Read", {}, { HOME: env.home, USERPROFILE: env.home });

    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.json.hookSpecificOutput.permissionDecision, "deny");
    assert.ok(
      result.json.hookSpecificOutput.permissionDecisionReason.includes("Context critical"),
      `Reason was: ${result.json.hookSpecificOutput.permissionDecisionReason}`
    );
  } finally {
    cleanup();
  }
});

test("6. Context-high flag exists, tool is Edit -> deny", (env) => {
  cleanup();
  fs.writeFileSync(contextHighPath(), JSON.stringify({ reason: "context-high", ratio: 0.65, timestamp: Date.now() }));
  try {
    const result = runGate("Edit", {}, { HOME: env.home, USERPROFILE: env.home });

    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.json.hookSpecificOutput.permissionDecision, "deny");
  } finally {
    cleanup();
  }
});

test("7. Subagent (agent_id present) -> skip ({})", (env) => {
  cleanup();
  // Even with checkpoint sentinel, subagents should be skipped
  fs.writeFileSync(sentinelPath(), JSON.stringify({ reason: "checkpoint", timestamp: Date.now() }));
  try {
    const result = runHook(HOOK_PATH, {
      tool_name: "Read",
      tool_input: {},
      session_id: "test-session",
      agent_id: "subagent-abc",
    }, { CLAUDE_LOOP_PID: FAKE_PID, HOME: env.home, USERPROFILE: env.home });

    assert.strictEqual(result.status, 0);
    assert.deepStrictEqual(result.json, {}, "Subagents should always be skipped");
  } finally {
    cleanup();
  }
});

test("8. Malformed JSON input -> exits 0 with {}", (env) => {
  const result = runHookRaw(HOOK_PATH, "not valid json at all", {
    CLAUDE_LOOP_PID: FAKE_PID,
    HOME: env.home,
    USERPROFILE: env.home,
  });

  assert.strictEqual(result.status, 0);
  assert.ok(result.json, "Should still output JSON");
  assert.deepStrictEqual(result.json, {});
});

test("9. No CLAUDE_LOOP_PID env -> skip ({})", (env) => {
  cleanup();
  // Write sentinel — but without PID, hook should skip
  fs.writeFileSync(sentinelPath(), JSON.stringify({ reason: "checkpoint", timestamp: Date.now() }));
  try {
    // runHook strips CLAUDE_LOOP_PID by default; we explicitly don't add it
    const result = runHook(HOOK_PATH, {
      tool_name: "Read",
      tool_input: {},
    }, { HOME: env.home, USERPROFILE: env.home });
    // CLAUDE_LOOP_PID is NOT in env (stripped by test-helpers)

    assert.strictEqual(result.status, 0);
    assert.deepStrictEqual(result.json, {}, "Without CLAUDE_LOOP_PID, hook should be a no-op");
  } finally {
    cleanup();
  }
});

test("10. Deny event writes JSONL log entry", (env) => {
  cleanup();
  fs.writeFileSync(sentinelPath(), JSON.stringify({ reason: "checkpoint", timestamp: Date.now() }));
  try {
    const result = runHook(HOOK_PATH, {
      session_id: "test-ckgate-log",
      tool_use_id: "tu-999",
      tool_name: "Edit",
      tool_input: {},
      cwd: "/tmp/test-project",
    }, { CLAUDE_LOOP_PID: FAKE_PID, HOME: env.home, USERPROFILE: env.home });

    assert.strictEqual(result.json.hookSpecificOutput.permissionDecision, "deny");

    const logDir = path.join(env.home, ".claude", "logs");
    const today = todayLocal();
    const logFile = path.join(logDir, `${today}.jsonl`);
    assert.ok(fs.existsSync(logFile), "Log file should exist");
    const lines = fs.readFileSync(logFile, "utf8").trim().split("\n");
    const entries = lines.map(l => JSON.parse(l)).filter(e => e.hook === "checkpoint-gate");
    assert.ok(entries.length > 0, "Should have checkpoint-gate log entry");
    assert.strictEqual(entries[0].event, "deny");
    assert.ok(entries[0].details.includes("checkpoint complete"), `Details: ${entries[0].details}`);
  } finally {
    cleanup();
  }
});

test("11. Context-high flag from different session -> allow (stale flag cleared)", (env) => {
  cleanup();
  // Write flag with a different session_id than the runGate helper's "test-session"
  fs.writeFileSync(contextHighPath(), JSON.stringify({ reason: "context-high", ratio: 0.65, session_id: "old-session", timestamp: Date.now() }));
  try {
    const result = runGate("Read", {}, { HOME: env.home, USERPROFILE: env.home });

    assert.strictEqual(result.status, 0);
    assert.deepStrictEqual(result.json, {}, "Stale-session flag should be cleared and tool allowed");
    assert.ok(!fs.existsSync(contextHighPath()), "Stale flag file should have been deleted");
  } finally {
    cleanup();
  }
});

test("12. Context-high flag from same session -> deny", (env) => {
  cleanup();
  // Write flag with same session_id as runGate helper's "test-session"
  fs.writeFileSync(contextHighPath(), JSON.stringify({ reason: "context-high", ratio: 0.65, session_id: "test-session", timestamp: Date.now() }));
  try {
    const result = runGate("Read", {}, { HOME: env.home, USERPROFILE: env.home });

    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.json.hookSpecificOutput.permissionDecision, "deny");
    assert.ok(
      result.json.hookSpecificOutput.permissionDecisionReason.includes("Context critical"),
      `Reason was: ${result.json.hookSpecificOutput.permissionDecisionReason}`
    );
  } finally {
    cleanup();
  }
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
