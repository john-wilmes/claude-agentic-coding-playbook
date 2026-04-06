#!/usr/bin/env node
// Tests for gitignore-guard.js — warns before git commit if .gitignore missing.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { runHook, runHookRaw } = require("./test-helpers");

const HOOK_PATH = path.resolve(__dirname, "../../templates/hooks/gitignore-guard.js");

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e });
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
  }
}

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gitignore-guard-test-"));
}

console.log("gitignore-guard.js:");

// Test 1: non-Bash tool → no output
test("1. non-Bash tool returns empty", () => {
  const result = runHook(HOOK_PATH, {
    tool_name: "Read",
    tool_input: { file_path: "/some/file" },
    cwd: "/tmp",
  });
  assert.strictEqual(result.status, 0);
  assert.ok(!result.json || !result.json.hookSpecificOutput, "Should not have hookSpecificOutput");
});

// Test 2: Bash but not git commit → no output
test("2. Bash non-git-commit returns empty", () => {
  const result = runHook(HOOK_PATH, {
    tool_name: "Bash",
    tool_input: { command: "git status" },
    cwd: "/tmp",
  });
  assert.strictEqual(result.status, 0);
  assert.ok(!result.json || !result.json.hookSpecificOutput, "Should not have hookSpecificOutput");
});

// Test 3: git commit with .gitignore present → no warning
test("3. git commit with .gitignore present returns empty", () => {
  const dir = createTempDir();
  try {
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n");

    const result = runHook(HOOK_PATH, {
      tool_name: "Bash",
      tool_input: { command: "git commit -m 'test'" },
      cwd: dir,
    });
    assert.strictEqual(result.status, 0);
    assert.ok(!result.json || !result.json.hookSpecificOutput, "Should not have hookSpecificOutput");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Test 4: git commit without .gitignore in git repo → warns
test("4. git commit without .gitignore warns", () => {
  const dir = createTempDir();
  try {
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
    // No .gitignore created

    const result = runHook(HOOK_PATH, {
      tool_name: "Bash",
      tool_input: { command: "git commit -m 'initial'" },
      cwd: dir,
    });
    assert.strictEqual(result.status, 0);
    assert.ok(result.json, "Should return JSON output");
    const ctx = result.json.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes(".gitignore"), "Warning should mention .gitignore");
    assert.ok(ctx.includes("node_modules"), "Warning should suggest node_modules");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Test 5: git commit in non-git dir (no .git) → no warning
test("5. git commit in non-git dir returns empty", () => {
  const dir = createTempDir();
  try {
    // No .git dir, no .gitignore
    const result = runHook(HOOK_PATH, {
      tool_name: "Bash",
      tool_input: { command: "git commit -m 'test'" },
      cwd: dir,
    });
    assert.strictEqual(result.status, 0);
    assert.ok(!result.json || !result.json.hookSpecificOutput, "Should not have hookSpecificOutput");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Test 6: malformed JSON → exits 0 with empty output
test("6. malformed JSON exits 0 gracefully", () => {
  const result = runHookRaw(HOOK_PATH, "not json at all");
  assert.strictEqual(result.status, 0);
});

// Test 7: git commit with flags still triggers check
test("7. git commit with various flags triggers check", () => {
  const dir = createTempDir();
  try {
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true });

    const result = runHook(HOOK_PATH, {
      tool_name: "Bash",
      tool_input: { command: 'git commit -a -m "feat: add feature"' },
      cwd: dir,
    });
    assert.strictEqual(result.status, 0);
    assert.ok(result.json, "Should warn for git commit -a -m too");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed (${passed + failed} total)`);

if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) {
    console.log(`  - ${f.name}: ${f.error.message}`);
  }
}

process.exit(failed > 0 ? 1 : 0);
