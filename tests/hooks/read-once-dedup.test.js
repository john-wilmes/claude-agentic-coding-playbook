#!/usr/bin/env node
// Integration tests for read-once-dedup.js (PreToolUse hook).
// Zero dependencies — uses only Node built-ins + local test-helpers.
//
// Run: node tests/hooks/read-once-dedup.test.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const { runHook, runHookRaw, todayLocal, createTempHome } = require("./test-helpers");

// Resolve hook path relative to repo root
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const HOOK = path.join(REPO_ROOT, "templates", "hooks", "read-once-dedup.js");

// Import exported helpers for direct unit-level assertions
const { STATE_DIR, STATE_TTL_MS } = require(HOOK);

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

function cleanupSession(sessionId) {
  const stateFile = path.join(STATE_DIR, `${sessionId}.json`);
  try { fs.rmSync(stateFile, { force: true }); } catch {}
}

/**
 * Create a real temp file that the hook can stat.
 * Returns { filePath, cleanup }.
 */
function createTempFile(content = "hello world\n") {
  const filePath = path.join(os.tmpdir(), `read-once-test-${crypto.randomUUID()}.txt`);
  fs.writeFileSync(filePath, content);
  return {
    filePath,
    cleanup() { try { fs.rmSync(filePath, { force: true }); } catch {} },
  };
}

/**
 * Run the hook with a Read tool call.
 */
function runReadHook(sessionId, filePath, opts = {}, envOverrides = {}) {
  const toolInput = { file_path: filePath };
  if (opts.offset !== undefined) toolInput.offset = opts.offset;
  if (opts.limit !== undefined) toolInput.limit = opts.limit;

  return runHook(HOOK, {
    session_id: sessionId,
    tool_name: "Read",
    tool_input: toolInput,
    ...opts.hookExtras,
  }, envOverrides);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

console.log("\nread-once-dedup.js:");

// Test 1: First read of a file → allow ({})
test("1. First read of a file: allow ({})", () => {
  const sessionId = newSessionId();
  const tmp = createTempFile();
  try {
    const result = runReadHook(sessionId, tmp.filePath);
    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.ok(result.json, "Should output valid JSON");
    assert.deepStrictEqual(result.json, {}, "Should return {} on first read");
  } finally {
    tmp.cleanup();
    cleanupSession(sessionId);
  }
});

// Test 2: Second read of same file, unchanged → deny
test("2. Second read of same file, unchanged: deny", () => {
  const sessionId = newSessionId();
  const tmp = createTempFile();
  try {
    runReadHook(sessionId, tmp.filePath); // first read
    const result = runReadHook(sessionId, tmp.filePath); // second read

    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.ok(result.json, "Should output valid JSON");
    assert.ok(result.json.hookSpecificOutput, "Should have hookSpecificOutput");
    assert.strictEqual(
      result.json.hookSpecificOutput.permissionDecision, "deny",
      "Should deny second read of unchanged file"
    );
    assert.ok(
      result.json.hookSpecificOutput.permissionDecisionReason.includes("already in context"),
      `Reason should mention 'already in context', got: ${result.json.hookSpecificOutput.permissionDecisionReason}`
    );
  } finally {
    tmp.cleanup();
    cleanupSession(sessionId);
  }
});

// Test 3: Second read of same file, modified (touch file between reads) → allow
test("3. Second read of same file, modified: allow", () => {
  const sessionId = newSessionId();
  const tmp = createTempFile();
  try {
    runReadHook(sessionId, tmp.filePath); // first read

    // Advance mtime by 1 second to simulate modification
    const now = new Date(Date.now() + 2000);
    fs.utimesSync(tmp.filePath, now, now);

    const result = runReadHook(sessionId, tmp.filePath); // second read after mtime bump

    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.ok(result.json, "Should output valid JSON");
    assert.deepStrictEqual(result.json, {}, "Should allow re-read of modified file");
  } finally {
    tmp.cleanup();
    cleanupSession(sessionId);
  }
});

// Test 4: Non-Read tool (Bash) → pass through ({})
test("4. Non-Read tool (Bash): pass through ({})", () => {
  const sessionId = newSessionId();
  try {
    const result = runHook(HOOK, {
      session_id: sessionId,
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.ok(result.json, "Should output valid JSON");
    assert.deepStrictEqual(result.json, {}, "Should pass through non-Read tools");
  } finally {
    cleanupSession(sessionId);
  }
});

// Test 5: Read with different offset than stored → allow
test("5. Read with different offset than stored: allow", () => {
  const sessionId = newSessionId();
  const tmp = createTempFile("line1\nline2\nline3\nline4\nline5\n");
  try {
    runReadHook(sessionId, tmp.filePath, { offset: 1 }); // first read with offset=1
    const result = runReadHook(sessionId, tmp.filePath, { offset: 50 }); // different offset

    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.ok(result.json, "Should output valid JSON");
    assert.deepStrictEqual(result.json, {}, "Should allow read with different offset");
  } finally {
    tmp.cleanup();
    cleanupSession(sessionId);
  }
});

// Test 6: Read with different limit than stored → allow
test("6. Read with different limit than stored: allow", () => {
  const sessionId = newSessionId();
  const tmp = createTempFile("line1\nline2\nline3\nline4\nline5\n");
  try {
    runReadHook(sessionId, tmp.filePath, { limit: 10 }); // first read with limit=10
    const result = runReadHook(sessionId, tmp.filePath, { limit: 50 }); // different limit

    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.ok(result.json, "Should output valid JSON");
    assert.deepStrictEqual(result.json, {}, "Should allow read with different limit");
  } finally {
    tmp.cleanup();
    cleanupSession(sessionId);
  }
});

// Test 7: Read with same offset/limit, unchanged → deny
test("7. Read with same offset/limit, unchanged: deny", () => {
  const sessionId = newSessionId();
  const tmp = createTempFile("line1\nline2\nline3\nline4\nline5\n");
  try {
    runReadHook(sessionId, tmp.filePath, { offset: 1, limit: 10 }); // first read
    const result = runReadHook(sessionId, tmp.filePath, { offset: 1, limit: 10 }); // same window

    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.ok(result.json.hookSpecificOutput, "Should have hookSpecificOutput");
    assert.strictEqual(
      result.json.hookSpecificOutput.permissionDecision, "deny",
      "Should deny re-read with same offset/limit on unchanged file"
    );
  } finally {
    tmp.cleanup();
    cleanupSession(sessionId);
  }
});

// Test 8: File deleted between reads → allow
test("8. File deleted between reads: allow", () => {
  const sessionId = newSessionId();
  const tmp = createTempFile();
  try {
    runReadHook(sessionId, tmp.filePath); // first read
    fs.rmSync(tmp.filePath, { force: true }); // delete the file
    const result = runReadHook(sessionId, tmp.filePath); // second read (file gone)

    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.ok(result.json, "Should output valid JSON");
    assert.deepStrictEqual(result.json, {}, "Should allow read when file has been deleted");
  } finally {
    cleanupSession(sessionId);
  }
});

// Test 9: File under ~/.claude/ → always allow (even on re-read)
test("9. File under ~/.claude/: always allow (even on re-read)", () => {
  const sessionId = newSessionId();
  // Use an actual file under ~/.claude/ that we know exists: CLAUDE.md or similar.
  // For portability, create a temp file inside a temp ~/.claude-test/ — but since
  // the hook checks os.homedir()+"/.claude/", we need to inject HOME.
  const env = createTempHome();
  const claudeFile = path.join(env.claudeDir, "MEMORY.md");
  fs.writeFileSync(claudeFile, "# Memory\n");

  try {
    runHook(HOOK, {
      session_id: sessionId,
      tool_name: "Read",
      tool_input: { file_path: claudeFile },
    }, { HOME: env.home, USERPROFILE: env.home });

    const result = runHook(HOOK, {
      session_id: sessionId,
      tool_name: "Read",
      tool_input: { file_path: claudeFile },
    }, { HOME: env.home, USERPROFILE: env.home });

    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.ok(result.json, "Should output valid JSON");
    assert.deepStrictEqual(result.json, {}, "Should always allow files under ~/.claude/");
  } finally {
    cleanupSession(sessionId);
    env.cleanup();
  }
});

// Test 10: agent_id present (subagent) → pass through ({})
test("10. agent_id present (subagent): pass through ({})", () => {
  const sessionId = newSessionId();
  const tmp = createTempFile();
  try {
    // First read (no agent_id) — records the file
    runReadHook(sessionId, tmp.filePath);

    // Second read with agent_id — should pass through regardless
    const result = runHook(HOOK, {
      session_id: sessionId,
      tool_name: "Read",
      tool_input: { file_path: tmp.filePath },
      agent_id: "subagent-abc-123",
    });

    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.ok(result.json, "Should output valid JSON");
    assert.deepStrictEqual(result.json, {}, "Should pass through subagent reads");
  } finally {
    tmp.cleanup();
    cleanupSession(sessionId);
  }
});

// Test 11: Malformed JSON input → {}, exit 0
test("11. Malformed JSON input: exits 0 with {}", () => {
  const result = runHookRaw(HOOK, "not valid json at all");
  assert.strictEqual(result.status, 0, "Should exit 0");
  assert.ok(result.json, "Should output valid JSON");
  assert.deepStrictEqual(result.json, {}, "Should output empty object on malformed input");
});

// Test 12: Two sessions with same CLAUDE_LOOP_PID share state
test("12. Two sessions with same CLAUDE_LOOP_PID share state", () => {
  const session1 = newSessionId();
  const session2 = newSessionId();
  const loopPid = `test-${Date.now()}`;
  const stateKey = `loop-${loopPid}`;
  const tmp = createTempFile();
  const env = { CLAUDE_LOOP_PID: loopPid };
  try {
    // Session 1 reads the file (first read)
    runHook(HOOK, {
      session_id: session1,
      tool_name: "Read",
      tool_input: { file_path: tmp.filePath },
    }, env);

    // Session 2 reads the same file (should be treated as second read → deny)
    const result = runHook(HOOK, {
      session_id: session2,
      tool_name: "Read",
      tool_input: { file_path: tmp.filePath },
    }, env);

    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.ok(result.json.hookSpecificOutput, "Should have hookSpecificOutput (shared state across sessions)");
    assert.strictEqual(
      result.json.hookSpecificOutput.permissionDecision, "deny",
      "Should deny re-read across sessions sharing CLAUDE_LOOP_PID"
    );
  } finally {
    tmp.cleanup();
    cleanupSession(stateKey);
  }
});

// Test 13: Two sessions without CLAUDE_LOOP_PID have independent state
test("13. Two sessions without CLAUDE_LOOP_PID: independent state", () => {
  const session1 = newSessionId();
  const session2 = newSessionId();
  const tmp = createTempFile();
  try {
    // Session 1 reads the file (first read for session 1)
    runHook(HOOK, {
      session_id: session1,
      tool_name: "Read",
      tool_input: { file_path: tmp.filePath },
    });

    // Session 2 reads the same file — should be a fresh first read
    const result = runHook(HOOK, {
      session_id: session2,
      tool_name: "Read",
      tool_input: { file_path: tmp.filePath },
    });

    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.ok(result.json, "Should output valid JSON");
    assert.deepStrictEqual(result.json, {}, "Should allow re-read in a different session without CLAUDE_LOOP_PID");
  } finally {
    tmp.cleanup();
    cleanupSession(session1);
    cleanupSession(session2);
  }
});

// Test 14: State file older than 4h → state discarded, allow
test("14. State file older than 4h: state discarded, allow", () => {
  const sessionId = newSessionId();
  const tmp = createTempFile();
  try {
    // First read — records state
    runReadHook(sessionId, tmp.filePath);

    // Manually age the state file beyond TTL
    const stateFile = path.join(STATE_DIR, `${sessionId}.json`);
    const oldTime = new Date(Date.now() - STATE_TTL_MS - 1000);
    fs.utimesSync(stateFile, oldTime, oldTime);

    // Second read — stale state should be discarded, so this is treated as first read → allow
    const result = runReadHook(sessionId, tmp.filePath);

    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.ok(result.json, "Should output valid JSON");
    assert.deepStrictEqual(result.json, {}, "Should allow when state file is older than TTL");
  } finally {
    tmp.cleanup();
    cleanupSession(sessionId);
  }
});

// Test 15: Block event writes JSONL log entry
test("15. Block event writes JSONL log entry", () => {
  const sessionId = newSessionId();
  const tmp = createTempFile();
  const env = createTempHome();
  try {
    const hookEnv = { HOME: env.home, USERPROFILE: env.home };

    // First read — allow, records state
    runHook(HOOK, {
      session_id: sessionId,
      tool_name: "Read",
      tool_input: { file_path: tmp.filePath },
    }, hookEnv);

    // Second read — should block and write log
    runHook(HOOK, {
      session_id: sessionId,
      tool_name: "Read",
      tool_input: { file_path: tmp.filePath },
    }, hookEnv);

    const logDir = path.join(env.home, ".claude", "logs");
    const today = todayLocal();
    const logFile = path.join(logDir, `${today}.jsonl`);
    assert.ok(fs.existsSync(logFile), `Log file should exist at ${logFile}`);

    const lines = fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean);
    const entries = lines.map(l => JSON.parse(l)).filter(e => e.hook === "read-once-dedup");
    assert.ok(entries.length > 0, "Should have read-once-dedup log entries");

    const blockEntry = entries.find(e => e.event === "block");
    assert.ok(blockEntry, "Should have a block entry");
    assert.ok(
      blockEntry.details.includes(tmp.filePath) || blockEntry.context.file === tmp.filePath,
      `Block entry should reference the blocked file, got: ${JSON.stringify(blockEntry)}`
    );
  } finally {
    tmp.cleanup();
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
