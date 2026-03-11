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

const { runHook, todayLocal, createTempHome, createStagedDir } = require("./test-helpers");

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
    const payload = { command: "cat README.md" };
    for (let i = 0; i < 4; i++) {
      runDetector(sessionId, "Bash", payload);
    }
    const result = runDetector(sessionId, "Bash", payload); // call 5

    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.ok(result.json, "Should output valid JSON");
    assert.strictEqual(result.json.hookSpecificOutput.permissionDecision, "deny", "Should block at 5");
    assert.ok(
      result.json.hookSpecificOutput.permissionDecisionReason.includes("5 identical"),
      `permissionDecisionReason should mention '5 identical', got: ${result.json.hookSpecificOutput.permissionDecisionReason}`
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

// Test 7: Whitelisted test commands are never flagged as stuck
test("7. Whitelisted test commands: never warned or blocked", () => {
  const sessionId = newSessionId();
  try {
    const payload = { command: "npm test" };
    for (let i = 0; i < 6; i++) {
      const result = runDetector(sessionId, "Bash", payload);
      assert.strictEqual(result.status, 0, `Call ${i + 1} should exit 0`);
      assert.ok(result.json, `Call ${i + 1} should output valid JSON`);
      assert.strictEqual(result.json.decision, undefined, `Call ${i + 1} should not block`);
      assert.strictEqual(result.json.hookSpecificOutput, undefined, `Call ${i + 1} should not warn`);
    }
  } finally {
    cleanupSession(sessionId);
  }
});

// Bonus: malformed JSON input — should exit 0 and output {}
// Note: runHook stringifies the string, producing valid JSON (a quoted string).
// The hook parses it as a string (not an object), falls back to session "unknown".
// Clean up stale state from prior runs to prevent false positives.
test("6. Malformed JSON input: exits 0 with {}", () => {
  cleanupSession("unknown");
  const result = runHook(STUCK_DETECTOR, "not valid json at all");

  assert.strictEqual(result.status, 0, "Should exit 0");
  assert.ok(result.json, "Should output valid JSON");
  assert.deepStrictEqual(result.json, {}, "Should output empty object on error");
});

// Test 8: Block event writes JSONL log entry
test("8. Block event writes JSONL log entry", () => {
  const sessionId = newSessionId();
  const env = require("./test-helpers").createTempHome();
  try {
    const payload = { command: "echo stuck" };
    for (let i = 0; i < 4; i++) {
      runHook(STUCK_DETECTOR, {
        session_id: sessionId,
        tool_name: "Bash",
        tool_input: payload,
      }, { HOME: env.home, USERPROFILE: env.home });
    }
    runHook(STUCK_DETECTOR, {
      session_id: sessionId,
      tool_name: "Bash",
      tool_input: payload,
    }, { HOME: env.home, USERPROFILE: env.home });

    const logDir = path.join(env.home, ".claude", "logs");
    const today = todayLocal();
    const logFile = path.join(logDir, `${today}.jsonl`);
    assert.ok(fs.existsSync(logFile), "Log file should exist");
    const lines = fs.readFileSync(logFile, "utf8").trim().split("\n");
    const entries = lines.map(l => JSON.parse(l)).filter(e => e.hook === "stuck-detector");
    assert.ok(entries.length > 0, "Should have stuck-detector log entries");
    const blockEntry = entries.find(e => e.event === "block");
    assert.ok(blockEntry, "Should have a block entry");
    assert.ok(blockEntry.details.includes("5"), "Details should mention 5 identical actions");
  } finally {
    cleanupSession(sessionId);
    env.cleanup();
  }
});

// ─── Knowledge capture tests ─────────────────────────────────────────────────

console.log("\nknowledge capture (runHook):");

// Test 9: stuck→unstuck stages a knowledge candidate
test("9. stuck→unstuck stages a knowledge candidate", () => {
  const sessionId = newSessionId();
  const env = createTempHome();
  const stagedDir = createStagedDir(env.home);

  // Pre-populate state file with wasStuck=true and stuckTool="Edit"
  const stateFile = path.join(STATE_DIR, `${sessionId}.json`);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({
    window: ["aaaa", "aaaa", "aaaa"],  // 3 identical (was at warn threshold)
    wasStuck: true,
    stuckTool: "Edit",
  }));

  try {
    // Run with a different action (hash won't match "aaaa") — drops consecutive below threshold.
    // Use a non-whitelisted tool so the hook doesn't short-circuit before state processing.
    const result = runHook(STUCK_DETECTOR, {
      session_id: sessionId,
      tool_name: "Read",
      tool_input: { file_path: "/tmp/some-file.txt" },
      cwd: "/tmp/test-project",
    }, { HOME: env.home, USERPROFILE: env.home });

    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.ok(result.json, "Should output valid JSON");

    // Verify a staged file was created
    const stagedFile = path.join(stagedDir, `${sessionId}.jsonl`);
    assert.ok(fs.existsSync(stagedFile), `Staged file should exist at ${stagedFile}`);
    const lines = fs.readFileSync(stagedFile, "utf8").trim().split("\n").filter(Boolean);
    assert.ok(lines.length >= 1, "Should have at least one staged candidate");
    const candidate = JSON.parse(lines[0]);
    assert.strictEqual(candidate.trigger, "stuck-resolved", "trigger should be stuck-resolved");
    assert.strictEqual(candidate.session_id, sessionId);
    assert.ok(candidate.summary.includes("Edit"), `summary should mention stuck tool, got: ${candidate.summary}`);
  } finally {
    cleanupSession(sessionId);
    env.cleanup();
  }
});

// Test 10: never-stuck does not stage a candidate
test("10. never-stuck does not stage a candidate", () => {
  const sessionId = newSessionId();
  const env = createTempHome();
  const stagedDir = createStagedDir(env.home);

  // Pre-populate state with wasStuck=false
  const stateFile = path.join(STATE_DIR, `${sessionId}.json`);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({
    window: [],
    wasStuck: false,
    stuckTool: "",
  }));

  try {
    const result = runHook(STUCK_DETECTOR, {
      session_id: sessionId,
      tool_name: "Bash",
      tool_input: { command: "ls" },
      cwd: "/tmp/test-project",
    }, { HOME: env.home, USERPROFILE: env.home });

    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.ok(result.json, "Should output valid JSON");

    // Verify no staged file was created
    const stagedFile = path.join(stagedDir, `${sessionId}.jsonl`);
    assert.ok(!fs.existsSync(stagedFile), "Staged file should NOT exist when wasStuck=false");
  } finally {
    cleanupSession(sessionId);
    env.cleanup();
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
