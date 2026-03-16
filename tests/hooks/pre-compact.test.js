#!/usr/bin/env node
// Integration tests for pre-compact.js (PreCompact hook).
// Zero dependencies — uses only Node built-ins + local test-helpers.
//
// Run: node tests/hooks/pre-compact.test.js

"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const { runHook, runHookRaw, createMemoryFile } = require("./test-helpers");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const PRE_COMPACT = path.join(REPO_ROOT, "templates", "hooks", "pre-compact.js");

// State directory used by the hook for deduplication
const STATE_DIR = path.join(os.tmpdir(), "claude-pre-compact");

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
  return `pre-compact-test-${crypto.randomUUID()}`;
}

/**
 * Clean up the deduplication sentinel file for a given session.
 */
function cleanupSession(sessionId) {
  const doneFile = path.join(STATE_DIR, `${sessionId}.done`);
  try { fs.rmSync(doneFile, { force: true }); } catch {}
}

/**
 * Create a temporary project directory.
 */
function createTempProjectDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pre-compact-proj-"));
}

/**
 * Derive the MEMORY.md path that pre-compact.js will use for the given home + cwd.
 * Replicates cwdToProjectKey logic from the hook.
 */
function expectedMemoryPath(home, cwd) {
  const key = cwd.replace(/:/g, "-").replace(/[\\/]/g, "-").replace(/^-/, "");
  return path.join(home, ".claude", "projects", key, "memory", "MEMORY.md");
}

// ─── Tests ───────────────────────────────────────────────────────────────────

console.log("\npre-compact.js:");

// Test 1: Basic functionality — hook reads memory file and creates snapshot
test("1. Basic: hook outputs hookSpecificOutput with PreCompact message", () => {
  const sessionId = newSessionId();
  const projectDir = createTempProjectDir();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pre-compact-home-"));

  try {
    const result = runHook(PRE_COMPACT, {
      session_id: sessionId,
      cwd: projectDir,
      trigger: "manual",
    }, { HOME: home, USERPROFILE: home });

    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.ok(result.json, "Should output valid JSON");
    assert.ok(result.json.hookSpecificOutput, "Should have hookSpecificOutput");
    assert.strictEqual(
      result.json.hookSpecificOutput.hookEventName,
      "PreCompact",
      "hookEventName should be PreCompact"
    );
    assert.ok(
      result.json.hookSpecificOutput.additionalContext.includes("Pre-compact snapshot saved"),
      `additionalContext should mention snapshot, got: ${result.json.hookSpecificOutput.additionalContext}`
    );
  } finally {
    cleanupSession(sessionId);
    try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  }
});

// Test 2: Hook writes a snapshot section into MEMORY.md
test("2. Hook writes Pre-compact snapshot section into MEMORY.md", () => {
  const sessionId = newSessionId();
  const projectDir = createTempProjectDir();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pre-compact-home-"));

  try {
    // Pre-create MEMORY.md with existing content
    const memPath = expectedMemoryPath(home, projectDir);
    fs.mkdirSync(path.dirname(memPath), { recursive: true });
    fs.writeFileSync(memPath, "# Project Memory\n\n## Current Work\n\nWorking on feature X.\n");

    runHook(PRE_COMPACT, {
      session_id: sessionId,
      cwd: projectDir,
      trigger: "test-trigger",
    }, { HOME: home, USERPROFILE: home });

    const memContent = fs.readFileSync(memPath, "utf8");
    assert.ok(
      memContent.includes("## Pre-compact snapshot"),
      "MEMORY.md should contain Pre-compact snapshot section"
    );
    assert.ok(
      memContent.includes("test-trigger"),
      "Snapshot should include the trigger value"
    );
    // Original content should be preserved
    assert.ok(
      memContent.includes("## Current Work"),
      "Original MEMORY.md content should be preserved"
    );
  } finally {
    cleanupSession(sessionId);
    try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  }
});

// Test 3: Handles missing MEMORY.md gracefully — creates it
test("3. Missing MEMORY.md: hook creates it with snapshot section", () => {
  const sessionId = newSessionId();
  const projectDir = createTempProjectDir();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pre-compact-home-"));

  try {
    const memPath = expectedMemoryPath(home, projectDir);
    // Ensure MEMORY.md does NOT exist
    assert.ok(!fs.existsSync(memPath), "MEMORY.md should not exist before hook runs");

    const result = runHook(PRE_COMPACT, {
      session_id: sessionId,
      cwd: projectDir,
      trigger: "manual",
    }, { HOME: home, USERPROFILE: home });

    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.ok(fs.existsSync(memPath), "MEMORY.md should be created by hook");
    const memContent = fs.readFileSync(memPath, "utf8");
    assert.ok(
      memContent.includes("## Pre-compact snapshot"),
      "Created MEMORY.md should contain snapshot section"
    );
  } finally {
    cleanupSession(sessionId);
    try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  }
});

// Test 4: Deduplication — second call with same session_id returns {} (no duplicate snapshot)
test("4. Deduplication: second call with same session_id returns {}", () => {
  const sessionId = newSessionId();
  const projectDir = createTempProjectDir();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pre-compact-home-"));

  try {
    // First call — should succeed and write snapshot
    const result1 = runHook(PRE_COMPACT, {
      session_id: sessionId,
      cwd: projectDir,
      trigger: "manual",
    }, { HOME: home, USERPROFILE: home });
    assert.strictEqual(result1.status, 0);
    assert.ok(result1.json.hookSpecificOutput, "First call should have hookSpecificOutput");

    // Second call with same session — should be deduplicated
    const result2 = runHook(PRE_COMPACT, {
      session_id: sessionId,
      cwd: projectDir,
      trigger: "manual",
    }, { HOME: home, USERPROFILE: home });
    assert.strictEqual(result2.status, 0, "Should exit 0");
    assert.ok(result2.json, "Should output valid JSON");
    assert.deepStrictEqual(result2.json, {}, "Duplicate session should return {}");
  } finally {
    cleanupSession(sessionId);
    try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  }
});

// Test 5: Malformed JSON input — exits 0 with {} (H4 requirement)
test("5. Malformed JSON input: exits 0 with {}", () => {
  // Use runHookRaw so the hook receives truly malformed JSON
  const result = runHookRaw(PRE_COMPACT, "{ not valid json !!");
  assert.strictEqual(result.status, 0, "Should exit 0 on malformed JSON");
  assert.ok(result.json, "Should output valid JSON");
  assert.deepStrictEqual(result.json, {}, "Should output empty object on parse error");
});

// Test 6: Output is always valid JSON (even for edge-case inputs)
test("6. Always outputs valid JSON (empty input)", () => {
  const result = runHookRaw(PRE_COMPACT, "");
  assert.strictEqual(result.status, 0, "Should exit 0 on empty input");
  assert.ok(result.json, "Should always output parseable JSON");
  assert.deepStrictEqual(result.json, {}, "Empty input should produce {}");
});

// Test 7: Snapshot replaces previous snapshot section (not appended twice)
test("7. Snapshot section is replaced (not duplicated) on second distinct session", () => {
  const sessionId1 = newSessionId();
  const sessionId2 = newSessionId();
  const projectDir = createTempProjectDir();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pre-compact-home-"));

  try {
    // First session writes snapshot
    runHook(PRE_COMPACT, {
      session_id: sessionId1,
      cwd: projectDir,
      trigger: "first",
    }, { HOME: home, USERPROFILE: home });

    // Second distinct session replaces it
    runHook(PRE_COMPACT, {
      session_id: sessionId2,
      cwd: projectDir,
      trigger: "second",
    }, { HOME: home, USERPROFILE: home });

    const memPath = expectedMemoryPath(home, projectDir);
    const memContent = fs.readFileSync(memPath, "utf8");

    // Should appear only once
    const count = (memContent.match(/## Pre-compact snapshot/g) || []).length;
    assert.strictEqual(count, 1, `Pre-compact snapshot section should appear exactly once, got ${count}`);

    // Should contain the second trigger, not the first
    assert.ok(memContent.includes("second"), "Should contain second trigger");
  } finally {
    cleanupSession(sessionId1);
    cleanupSession(sessionId2);
    try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
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
