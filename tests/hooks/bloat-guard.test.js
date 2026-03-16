#!/usr/bin/env node
/**
 * bloat-guard.test.js — Integration tests for bloat-guard.js
 */

"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { runHook, runHookRaw } = require("./test-helpers");

const HOOK = path.resolve(__dirname, "../../templates/hooks/bloat-guard.js");

// ---------------------------------------------------------------------------
// Simple test runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeInput(filePath, content) {
  return { tool_name: "Write", tool_input: { file_path: filePath, content: content || "hello" } };
}

/**
 * Create a temp dir outside /tmp/ so the hook's /tmp/ exemption doesn't trigger.
 * Uses $HOME as the parent. Returns the dir path — caller must clean up.
 */
function createNonTmpDir() {
  return fs.mkdtempSync(path.join(os.homedir(), ".bg-test-"));
}

function unwrap(result) {
  if (result && Object.prototype.hasOwnProperty.call(result, "json")) {
    return result.json || {};
  }
  return result || {};
}

function isWarned(result) {
  const obj = unwrap(result);
  return (
    obj &&
    obj.hookSpecificOutput &&
    obj.hookSpecificOutput.permissionDecision === "warn"
  );
}

function isSilent(result) {
  const obj = unwrap(result);
  // Silent = empty object or no hookSpecificOutput
  return !obj || !obj.hookSpecificOutput;
}

function warnReason(result) {
  const obj = unwrap(result);
  return (
    obj &&
    obj.hookSpecificOutput &&
    obj.hookSpecificOutput.permissionDecisionReason
  );
}

/**
 * Clear the bloat-guard state directory to isolate tests.
 */
function clearState() {
  const stateDir = path.join(os.tmpdir(), "claude-bloat-guard");
  try {
    fs.rmSync(stateDir, { recursive: true, force: true });
  } catch {}
}

// ---------------------------------------------------------------------------
// Existing file (edit) tests
// ---------------------------------------------------------------------------

console.log("\nExisting file (edit) tests:");

test("Write: existing file is allowed silently", () => {
  clearState();
  const dir = createNonTmpDir();
  const file = path.join(dir, "existing.txt");
  try {
    fs.writeFileSync(file, "original content");
    const result = runHook(HOOK, writeInput(file));
    assert.ok(isSilent(result), `Expected silent allow for existing file, got: ${JSON.stringify(result.json)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// New file tests
// ---------------------------------------------------------------------------

console.log("\nNew file creation tests:");

test("Write: new file gets advisory warning", () => {
  clearState();
  const dir = createNonTmpDir();
  const file = path.join(dir, "brand-new.txt");
  try {
    const result = runHook(HOOK, writeInput(file));
    assert.ok(isWarned(result), `Expected warn for new file, got: ${JSON.stringify(result.json)}`);
    assert.ok(
      warnReason(result).includes("brand-new.txt"),
      `Expected filename in reason, got: ${warnReason(result)}`
    );
    assert.ok(
      warnReason(result).includes("referenced"),
      `Expected orphan file reminder, got: ${warnReason(result)}`
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Write: /tmp/ path is exempt (silent allow)", () => {
  clearState();
  const file = path.join(os.tmpdir(), "bg-test-exempt-" + Date.now() + ".txt");
  const result = runHook(HOOK, writeInput(file));
  assert.ok(isSilent(result), `Expected silent allow for /tmp/ path, got: ${JSON.stringify(result.json)}`);
});

// ---------------------------------------------------------------------------
// Throwaway filename tests
// ---------------------------------------------------------------------------

console.log("\nThrowaway filename tests:");

test("Write: test-*.js is flagged as throwaway", () => {
  clearState();
  const dir = createNonTmpDir();
  const file = path.join(dir, "test-quick.js");
  try {
    const result = runHook(HOOK, writeInput(file));
    assert.ok(isWarned(result), `Expected warn for throwaway pattern, got: ${JSON.stringify(result.json)}`);
    assert.ok(
      warnReason(result).includes("throwaway"),
      `Expected 'throwaway' in reason, got: ${warnReason(result)}`
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Write: debug-* is flagged as throwaway", () => {
  clearState();
  const dir = createNonTmpDir();
  const file = path.join(dir, "debug-output.log");
  try {
    const result = runHook(HOOK, writeInput(file));
    assert.ok(isWarned(result), `Expected warn for debug- pattern, got: ${JSON.stringify(result.json)}`);
    assert.ok(
      warnReason(result).includes("throwaway"),
      `Expected 'throwaway' in reason, got: ${warnReason(result)}`
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Write: tmp-* is flagged as throwaway", () => {
  clearState();
  const dir = createNonTmpDir();
  const file = path.join(dir, "tmp-data.csv");
  try {
    const result = runHook(HOOK, writeInput(file));
    assert.ok(isWarned(result), `Expected warn for tmp- pattern, got: ${JSON.stringify(result.json)}`);
    assert.ok(
      warnReason(result).includes("throwaway"),
      `Expected 'throwaway' in reason, got: ${warnReason(result)}`
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Write: scratch.* is flagged as throwaway", () => {
  clearState();
  const dir = createNonTmpDir();
  const file = path.join(dir, "scratch.py");
  try {
    const result = runHook(HOOK, writeInput(file));
    assert.ok(isWarned(result), `Expected warn for scratch.* pattern, got: ${JSON.stringify(result.json)}`);
    assert.ok(
      warnReason(result).includes("throwaway"),
      `Expected 'throwaway' in reason, got: ${warnReason(result)}`
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Write: untitled* is flagged as throwaway", () => {
  clearState();
  const dir = createNonTmpDir();
  const file = path.join(dir, "untitled-document.md");
  try {
    const result = runHook(HOOK, writeInput(file));
    assert.ok(isWarned(result), `Expected warn for untitled* pattern, got: ${JSON.stringify(result.json)}`);
    assert.ok(
      warnReason(result).includes("throwaway"),
      `Expected 'throwaway' in reason, got: ${warnReason(result)}`
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Escalation tests
// ---------------------------------------------------------------------------

console.log("\nEscalation tests:");

test("Write: escalates after 5+ new files", () => {
  clearState();
  const dir = createNonTmpDir();
  try {
    // Create 5 new files (under threshold)
    for (let i = 1; i <= 5; i++) {
      const file = path.join(dir, `new-file-${i}.txt`);
      const result = runHook(HOOK, writeInput(file));
      assert.ok(isWarned(result), `Expected warn for new file ${i}`);
      assert.ok(
        !warnReason(result).includes("threshold"),
        `Should not mention threshold for file ${i} (at or below 5)`
      );
    }

    // 6th file should trigger escalation
    const file6 = path.join(dir, "new-file-6.txt");
    const result6 = runHook(HOOK, writeInput(file6));
    assert.ok(isWarned(result6), "Expected warn for 6th file");
    assert.ok(
      warnReason(result6).includes("6 new files") || warnReason(result6).includes("threshold"),
      `Expected escalation message, got: ${warnReason(result6)}`
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Write: existing files do not count toward threshold", () => {
  clearState();
  const dir = createNonTmpDir();
  try {
    // Create 3 new files
    for (let i = 1; i <= 3; i++) {
      const file = path.join(dir, `counted-${i}.txt`);
      runHook(HOOK, writeInput(file));
    }

    // Edit an existing file — should not increment counter
    const existing = path.join(dir, "already-here.txt");
    fs.writeFileSync(existing, "original");
    runHook(HOOK, writeInput(existing));

    // 4th and 5th new files should still be under threshold
    for (let i = 4; i <= 5; i++) {
      const file = path.join(dir, `counted-${i}.txt`);
      const result = runHook(HOOK, writeInput(file));
      assert.ok(
        !warnReason(result).includes("threshold"),
        `File ${i} should not trigger escalation`
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Session-id isolation tests
// ---------------------------------------------------------------------------

console.log("\nSession-id isolation tests:");

test("Different sessionIds maintain separate state", () => {
  clearState();
  const dir = createNonTmpDir();
  try {
    // Create 5 new files under session-A — counts should stay per-session
    for (let i = 1; i <= 5; i++) {
      const file = path.join(dir, `session-a-file-${i}.txt`);
      const input = { tool_name: "Write", tool_input: { file_path: file }, session_id: "session-A" };
      runHook(HOOK, input);
    }
    // session-B starts fresh — 1st file should be advisory only, NOT escalated
    const fileB = path.join(dir, "session-b-file-1.txt");
    const resultB = runHook(HOOK, { tool_name: "Write", tool_input: { file_path: fileB }, session_id: "session-B" });
    assert.ok(isWarned(resultB), "Expected warn for new file in session-B");
    assert.ok(
      !warnReason(resultB).includes("threshold"),
      `session-B should not see session-A's file count, got: ${warnReason(resultB)}`
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Same sessionId accumulates state across calls", () => {
  clearState();
  const dir = createNonTmpDir();
  try {
    // Create 5 files under the same session — 6th should escalate
    for (let i = 1; i <= 5; i++) {
      const file = path.join(dir, `accum-file-${i}.txt`);
      runHook(HOOK, { tool_name: "Write", tool_input: { file_path: file }, session_id: "session-C" });
    }
    const file6 = path.join(dir, "accum-file-6.txt");
    const result6 = runHook(HOOK, { tool_name: "Write", tool_input: { file_path: file6 }, session_id: "session-C" });
    assert.ok(isWarned(result6), "Expected warn for 6th file in session-C");
    assert.ok(
      warnReason(result6).includes("threshold") || warnReason(result6).includes("6 new files"),
      `Expected escalation on 6th file in same session, got: ${warnReason(result6)}`
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Non-Write tool tests
// ---------------------------------------------------------------------------

console.log("\nNon-Write tool tests:");

test("Read tool is allowed silently", () => {
  clearState();
  const result = runHook(HOOK, { tool_name: "Read", tool_input: { file_path: "/tmp/foo.txt" } });
  assert.ok(isSilent(result), `Expected silent allow for Read tool, got: ${JSON.stringify(result.json)}`);
});

test("Bash tool is allowed silently", () => {
  clearState();
  const result = runHook(HOOK, { tool_name: "Bash", tool_input: { command: "ls" } });
  assert.ok(isSilent(result), `Expected silent allow for Bash tool, got: ${JSON.stringify(result.json)}`);
});

test("Edit tool is allowed silently", () => {
  clearState();
  const result = runHook(HOOK, { tool_name: "Edit", tool_input: { file_path: "/tmp/foo.txt" } });
  assert.ok(isSilent(result), `Expected silent allow for Edit tool, got: ${JSON.stringify(result.json)}`);
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

console.log("\nEdge cases:");

test("malformed JSON input returns {}", () => {
  clearState();
  const result = runHookRaw(HOOK, "not valid json {{{{");
  assert.strictEqual(result.stdout.trim(), "{}", `Expected '{}' for malformed input, got: ${result.stdout}`);
});

test("Write with no file_path returns {}", () => {
  clearState();
  const result = runHook(HOOK, { tool_name: "Write", tool_input: {} });
  assert.ok(isSilent(result), `Expected silent for missing file_path, got: ${JSON.stringify(result.json)}`);
});

test("Write with null file_path returns {}", () => {
  clearState();
  const result = runHook(HOOK, { tool_name: "Write", tool_input: { file_path: null } });
  assert.ok(isSilent(result), `Expected silent for null file_path, got: ${JSON.stringify(result.json)}`);
});

test("throwaway files are tracked in session count", () => {
  clearState();
  const dir = createNonTmpDir();
  try {
    // Create 5 throwaway files — they should warn AND count toward threshold
    for (let i = 1; i <= 5; i++) {
      runHook(HOOK, writeInput(path.join(dir, `test-throwaway-${i}.js`)));
    }

    // Next non-throwaway new file should be file #6 (escalated past threshold of 5)
    const file = path.join(dir, "legit-new-file.txt");
    const result = runHook(HOOK, writeInput(file));
    assert.ok(isWarned(result), "Expected warning");
    assert.ok(
      warnReason(result).includes("threshold"),
      `Throwaway files should count toward threshold, got: ${warnReason(result)}`
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Unit tests for exported helpers
// ---------------------------------------------------------------------------

console.log("\nUnit tests (exports):");

const { isThrowaway, THROWAWAY_PATTERNS, ESCALATION_THRESHOLD } = require(HOOK);

test("isThrowaway matches test-*.js", () => {
  assert.ok(isThrowaway("test-quick.js"), "test-quick.js should be throwaway");
});

test("isThrowaway does not match valid filenames", () => {
  assert.ok(!isThrowaway("utils.js"), "utils.js should not be throwaway");
  assert.ok(!isThrowaway("my-test.js"), "my-test.js should not be throwaway (doesn't start with test-)");
  assert.ok(!isThrowaway("testing.js"), "testing.js should not be throwaway");
});

test("isThrowaway matches scratch.py", () => {
  assert.ok(isThrowaway("scratch.py"), "scratch.py should be throwaway");
});

test("isThrowaway matches untitled", () => {
  assert.ok(isThrowaway("untitled"), "untitled should be throwaway");
  assert.ok(isThrowaway("untitled-1.md"), "untitled-1.md should be throwaway");
});

test("THROWAWAY_PATTERNS has expected count", () => {
  assert.strictEqual(THROWAWAY_PATTERNS.length, 5, `Expected 5 patterns, got ${THROWAWAY_PATTERNS.length}`);
});

test("ESCALATION_THRESHOLD is 5", () => {
  assert.strictEqual(ESCALATION_THRESHOLD, 5, `Expected threshold 5, got ${ESCALATION_THRESHOLD}`);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
