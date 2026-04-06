#!/usr/bin/env node
// Unit tests for templates/hooks/pre-commit-tests.js
// Zero dependencies — uses only Node built-ins + test-helpers.
//
// Run: node tests/hooks/pre-commit-tests.test.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { runHook } = require("./test-helpers");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const HOOK = path.join(REPO_ROOT, "templates", "hooks", "pre-commit-tests.js");

// The shared state file written by post-tool-verify.js and read by this hook.
const STATE_FILE = path.join(os.homedir(), ".claude", ".verify-last-run");

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

// ─── Helpers for state file management ───────────────────────────────────────

function readStateFile() {
  try { return fs.readFileSync(STATE_FILE, "utf8"); } catch { return null; }
}

function writeStateFile(obj) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(obj));
}

function restoreStateFile(original) {
  if (original === null) {
    try { fs.unlinkSync(STATE_FILE); } catch {}
  } else {
    fs.writeFileSync(STATE_FILE, original);
  }
}

// ─── extractFunction: load exported functions from hook source ────────────────

let _extractCounter = 0;
function extractFunction(hookPath, funcName) {
  const src = fs.readFileSync(hookPath, "utf8");
  const boundary = src.indexOf("process.stdin.resume()");
  const declarations = boundary > 0 ? src.slice(0, boundary) : src;
  const tmpFile = path.join(os.tmpdir(), `hook-extract-${Date.now()}-${_extractCounter++}.js`);
  fs.writeFileSync(tmpFile, `${declarations}\nmodule.exports = { ${funcName} };\n`);
  try {
    const mod = require(tmpFile);
    if (typeof mod[funcName] !== "function") {
      throw new Error(`${funcName} not found or not a function in ${hookPath}`);
    }
    return mod[funcName];
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

// ─── Integration tests: runHook ──────────────────────────────────────────────

const CWD = "/tmp/test-pre-commit-project";

console.log("\nintegration (runHook):");

test("1. Allows non-git-commit Bash commands (e.g., ls -la)", () => {
  const result = runHook(HOOK, {
    tool_name: "Bash",
    tool_input: { command: "ls -la" },
    cwd: CWD,
  });

  assert.strictEqual(result.status, 0, "exit 0");
  assert.ok(result.json, "valid JSON");
  const decision = result.json.hookSpecificOutput && result.json.hookSpecificOutput.decision;
  assert.notStrictEqual(decision, "block", "should not block ls");
});

test("2. Allows git commit when no state file exists", () => {
  const original = readStateFile();
  try {
    try { fs.unlinkSync(STATE_FILE); } catch {}

    const result = runHook(HOOK, {
      tool_name: "Bash",
      tool_input: { command: "git commit -m 'test'" },
      cwd: CWD,
    });

    assert.strictEqual(result.status, 0, "exit 0");
    assert.ok(result.json, "valid JSON");
    const decision = result.json.hookSpecificOutput && result.json.hookSpecificOutput.decision;
    assert.notStrictEqual(decision, "block", "should allow when no state file");
  } finally {
    restoreStateFile(original);
  }
});

test("3. Allows git commit when tests last passed", () => {
  const original = readStateFile();
  try {
    const state = {};
    state[CWD] = { ts: Date.now(), lastPassed: true, lastFailOutput: "" };
    writeStateFile(state);

    const result = runHook(HOOK, {
      tool_name: "Bash",
      tool_input: { command: "git commit -m 'wip'" },
      cwd: CWD,
    });

    assert.strictEqual(result.status, 0, "exit 0");
    assert.ok(result.json, "valid JSON");
    const decision = result.json.hookSpecificOutput && result.json.hookSpecificOutput.decision;
    assert.notStrictEqual(decision, "block", "should allow when tests passed");
  } finally {
    restoreStateFile(original);
  }
});

test("4. Blocks git commit when tests last failed (within 5 min)", () => {
  const original = readStateFile();
  try {
    const state = {};
    state[CWD] = {
      ts: Date.now(),
      lastPassed: false,
      lastFailOutput: "AssertionError: expected 1 to equal 2\n  at test.js:10",
    };
    writeStateFile(state);

    const result = runHook(HOOK, {
      tool_name: "Bash",
      tool_input: { command: "git commit -m 'broken'" },
      cwd: CWD,
    });

    assert.strictEqual(result.status, 0, "exit 0");
    assert.ok(result.json, "valid JSON");
    const hso = result.json.hookSpecificOutput;
    assert.ok(hso, "hookSpecificOutput present");
    assert.strictEqual(hso.decision, "block", "should block when tests failed");
    assert.ok(hso.reason, "reason present");
    assert.ok(hso.reason.includes("known-failing"), `reason should mention known-failing, got: ${hso.reason}`);
    assert.ok(hso.reason.includes("AssertionError"), `reason should include failure snippet, got: ${hso.reason}`);
  } finally {
    restoreStateFile(original);
  }
});

test("5. Allows git commit when test failure state is stale (>5 min old)", () => {
  const original = readStateFile();
  try {
    const state = {};
    state[CWD] = {
      ts: Date.now() - 6 * 60 * 1000, // 6 minutes ago
      lastPassed: false,
      lastFailOutput: "FAIL: something broke",
    };
    writeStateFile(state);

    const result = runHook(HOOK, {
      tool_name: "Bash",
      tool_input: { command: "git commit -m 'stale'" },
      cwd: CWD,
    });

    assert.strictEqual(result.status, 0, "exit 0");
    assert.ok(result.json, "valid JSON");
    const decision = result.json.hookSpecificOutput && result.json.hookSpecificOutput.decision;
    assert.notStrictEqual(decision, "block", "should allow when state is stale");
  } finally {
    restoreStateFile(original);
  }
});

test("6. Allows non-Bash tools (e.g., Edit)", () => {
  const result = runHook(HOOK, {
    tool_name: "Edit",
    tool_input: { file_path: "/tmp/foo.js", old_string: "a", new_string: "b" },
    cwd: CWD,
  });

  assert.strictEqual(result.status, 0, "exit 0");
  assert.ok(result.json, "valid JSON");
  const decision = result.json.hookSpecificOutput && result.json.hookSpecificOutput.decision;
  assert.notStrictEqual(decision, "block", "Edit tool should pass through");
});

// ─── Unit tests: isGitCommit ─────────────────────────────────────────────────

console.log("\nisGitCommit:");

test("7. isGitCommit correctly identifies git commit variants", () => {
  const isGitCommit = extractFunction(HOOK, "isGitCommit");

  assert.strictEqual(isGitCommit("git commit -m 'fix'"), true, "basic commit");
  assert.strictEqual(isGitCommit("git commit --all"), true, "commit --all");
  assert.strictEqual(isGitCommit("git -C /some/path commit -m 'msg'"), true, "git -C path commit");
  assert.strictEqual(isGitCommit("git commit"), true, "bare git commit");
  assert.strictEqual(isGitCommit("git commit -am 'fix'"), true, "commit -am");
});

test("8. isGitCommit rejects non-commit git commands", () => {
  const isGitCommit = extractFunction(HOOK, "isGitCommit");

  assert.strictEqual(isGitCommit("git status"), false, "git status");
  assert.strictEqual(isGitCommit("git push origin master"), false, "git push");
  assert.strictEqual(isGitCommit("git log --oneline"), false, "git log");
  assert.strictEqual(isGitCommit("ls -la"), false, "ls");
  assert.strictEqual(isGitCommit(""), false, "empty string");
  assert.strictEqual(isGitCommit(null), false, "null");
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
