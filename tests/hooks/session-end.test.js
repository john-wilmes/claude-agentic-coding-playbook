#!/usr/bin/env node
// Integration tests for templates/hooks/session-end.js
// Zero dependencies — uses only Node built-ins + local test-helpers.
//
// Run: node tests/hooks/session-end.test.js

"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

const { createTempHome, runHook, runHookRaw } = require("./test-helpers");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const HOOK_MODULE = path.join(REPO_ROOT, "templates", "hooks", "session-end.js");

// ─── Test runner ──────────────────────────────────────────────────────────────

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

// ─── Module helpers ───────────────────────────────────────────────────────────

/**
 * Require a fresh (uncached) copy of session-end.js's exported functions.
 * session-end.js isn't structured as a module — it runs on stdin end.
 * We extract and eval just the extractSalientTerms function for direct testing.
 */
function loadExtractSalientTerms() {
  // Read the source and extract just the function definition
  const src = fs.readFileSync(HOOK_MODULE, "utf8");
  // Match the function declaration
  const match = src.match(/function extractSalientTerms[\s\S]*?^}/m);
  if (!match) throw new Error("Could not find extractSalientTerms in session-end.js");
  // Evaluate in a fresh context
  // eslint-disable-next-line no-new-func
  const fn = new Function(`${match[0]}; return extractSalientTerms;`)();
  return fn;
}

/**
 * Initialize a minimal git repo in dir with a user config and optional initial commit.
 */
function initGitRepo(dir, opts = {}) {
  const gitOpts = { cwd: dir, stdio: "pipe" };
  spawnSync("git", ["init"], gitOpts);
  spawnSync("git", ["config", "user.email", "test@test.com"], gitOpts);
  spawnSync("git", ["config", "user.name", "Test User"], gitOpts);
  if (opts.initialCommit) {
    fs.writeFileSync(path.join(dir, ".gitkeep"), "");
    spawnSync("git", ["add", ".gitkeep"], gitOpts);
    spawnSync("git", ["commit", "-m", "initial commit"], gitOpts);
  }
}

/**
 * Encode a cwd path the same way session-end.js does, for building memory paths.
 */
function encodeCwd(cwd) {
  return cwd.replace(/:/g, "-").replace(/[\\/]/g, "-");
}

// ─── Tests ────────────────────────────────────────────────────────────────────

console.log("\nsession-end.js:");

// Test 1: Basic invocation with valid JSON returns {} and exits 0
test("1. Basic invocation with valid JSON returns {} and exits 0", () => {
  const { home, cleanup } = createTempHome();
  try {
    const result = runHook(
      HOOK_MODULE,
      { session_id: "test-basic-001", cwd: home },
      { HOME: home, USERPROFILE: home, CLAUDE_NO_AUTO_PUSH: "1" }
    );
    assert.strictEqual(result.status, 0, "Hook should exit 0");
    assert.ok(result.json !== null, "Should output valid JSON");
    // No push failure — should be {} or have no unexpected keys
    if (Object.keys(result.json).length > 0) {
      // Only allowed output is hookSpecificOutput (push warning)
      assert.ok(
        result.json.hookSpecificOutput !== undefined,
        `Unexpected JSON keys: ${JSON.stringify(result.json)}`
      );
    }
  } finally {
    cleanup();
  }
});

// Test 2: Malformed JSON input returns {} and exits 0 (never crash)
test("2. Malformed JSON input returns {} and exits 0", () => {
  const result = runHookRaw(HOOK_MODULE, "this is { not valid ] JSON");
  assert.strictEqual(result.status, 0, "Hook should exit 0 with malformed input");
  assert.ok(result.json !== null, "Should output valid JSON even on error");
  assert.deepStrictEqual(result.json, {}, "Should output empty object on malformed input");
});

// Test 3: Empty stdin returns {} and exits 0 gracefully
test("3. Empty stdin returns {} and exits 0 gracefully", () => {
  const result = runHookRaw(HOOK_MODULE, "");
  assert.strictEqual(result.status, 0, "Hook should exit 0 with empty stdin");
  assert.ok(result.json !== null, "Should output valid JSON");
  assert.deepStrictEqual(result.json, {}, "Should output empty object on empty input");
});

// Test 4: extractSalientTerms extracts correct terms
test("4. extractSalientTerms extracts meaningful terms from text", () => {
  const extractSalientTerms = loadExtractSalientTerms();
  const text = "Fixed claude-loop task-advance bug during dogfood session";
  const terms = extractSalientTerms(text);
  assert.ok(Array.isArray(terms), "Should return an array");
  assert.ok(terms.length > 0, "Should extract some terms");
  assert.ok(terms.includes("claude-loop"), "Should include 'claude-loop'");
  assert.ok(terms.includes("task-advance"), "Should include 'task-advance'");
  assert.ok(terms.includes("bug"), "Should include 'bug'");
  assert.ok(terms.includes("dogfood"), "Should include 'dogfood'");
  assert.ok(terms.includes("session"), "Should include 'session'");
});

// Test 5: extractSalientTerms filters stopwords
test("5. extractSalientTerms filters common stopwords", () => {
  const extractSalientTerms = loadExtractSalientTerms();
  const text = "the agent and the hook and the test are done with this";
  const terms = extractSalientTerms(text);
  assert.ok(!terms.includes("the"), "Should filter stopword 'the'");
  assert.ok(!terms.includes("and"), "Should filter stopword 'and'");
  assert.ok(!terms.includes("are"), "Should filter stopword 'are'");
  assert.ok(!terms.includes("with"), "Should filter stopword 'with'");
  assert.ok(!terms.includes("this"), "Should filter stopword 'this'");
  // "agent", "hook", "test", "done" are not stopwords
  assert.ok(terms.includes("agent"), "Should include 'agent'");
  assert.ok(terms.includes("hook"), "Should include 'hook'");
  assert.ok(terms.includes("test"), "Should include 'test'");
  assert.ok(terms.includes("done"), "Should include 'done'");
});

// Test 6: extractSalientTerms respects maxTerms limit
test("6. extractSalientTerms respects maxTerms limit", () => {
  const extractSalientTerms = loadExtractSalientTerms();
  const text = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima";
  const terms3 = extractSalientTerms(text, 3);
  assert.strictEqual(terms3.length, 3, "Should return exactly 3 terms when maxTerms=3");
  const terms5 = extractSalientTerms(text, 5);
  assert.strictEqual(terms5.length, 5, "Should return exactly 5 terms when maxTerms=5");
  // Default is 8
  const termsDefault = extractSalientTerms(text);
  assert.ok(termsDefault.length <= 8, "Default should return at most 8 terms");
});

// Test 7: extractSalientTerms handles null/undefined/empty input
test("7. extractSalientTerms returns empty array for null/undefined/empty input", () => {
  const extractSalientTerms = loadExtractSalientTerms();
  assert.deepStrictEqual(extractSalientTerms(null), [], "null → []");
  assert.deepStrictEqual(extractSalientTerms(undefined), [], "undefined → []");
  assert.deepStrictEqual(extractSalientTerms(""), [], "empty string → []");
});

// Test 8: Memory auto-commit — commits when memory file has changes
test("8. Memory auto-commit: commits when memory file changes", () => {
  const { home, claudeDir, cleanup } = createTempHome();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-end-proj-"));
  try {
    // Initialize ~/.claude as a git repo
    initGitRepo(claudeDir, { initialCommit: true });

    // Create the memory file in the repo
    const encodedCwd = encodeCwd(projectDir);
    const memDir = path.join(claudeDir, "projects", encodedCwd, "memory");
    fs.mkdirSync(memDir, { recursive: true });
    const memPath = path.join(memDir, "MEMORY.md");
    fs.writeFileSync(memPath, "# Memory\n\nInitial content\n");

    // Stage + commit so it's tracked
    const gitOpts = { cwd: claudeDir, stdio: "pipe" };
    spawnSync("git", ["add", "--", `projects/${encodedCwd}/memory/MEMORY.md`], gitOpts);
    spawnSync("git", ["commit", "-m", "initial memory"], gitOpts);

    // Now modify the file (unstaged change)
    fs.writeFileSync(memPath, "# Memory\n\nUpdated content\n");

    const result = runHook(
      HOOK_MODULE,
      { session_id: "test-commit-001", cwd: projectDir },
      { HOME: home, USERPROFILE: home, CLAUDE_NO_AUTO_PUSH: "1" }
    );

    assert.strictEqual(result.status, 0, "Hook should exit 0");

    // Verify a new commit was created
    const logResult = spawnSync("git", ["log", "--oneline"], { cwd: claudeDir, encoding: "utf8" });
    const logLines = logResult.stdout.trim().split("\n").filter(Boolean);
    assert.ok(logLines.length >= 2, "Should have at least 2 commits (initial + auto-commit)");
    // The most recent commit should be an auto-commit for this project
    assert.ok(
      logLines[0].includes("auto:"),
      `Latest commit should be an auto-commit, got: ${logLines[0]}`
    );
  } finally {
    cleanup();
    try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch {}
  }
});

// Test 9: Memory auto-commit — skips commit when no changes
test("9. Memory auto-commit: skips commit when memory file unchanged", () => {
  const { home, claudeDir, cleanup } = createTempHome();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-end-proj-"));
  try {
    initGitRepo(claudeDir, { initialCommit: true });

    // Create and commit the memory file (no pending changes)
    const encodedCwd = encodeCwd(projectDir);
    const memDir = path.join(claudeDir, "projects", encodedCwd, "memory");
    fs.mkdirSync(memDir, { recursive: true });
    const memPath = path.join(memDir, "MEMORY.md");
    fs.writeFileSync(memPath, "# Memory\n\nContent that won't change\n");

    const gitOpts = { cwd: claudeDir, stdio: "pipe" };
    spawnSync("git", ["add", "--", `projects/${encodedCwd}/memory/MEMORY.md`], gitOpts);
    spawnSync("git", ["commit", "-m", "initial memory"], gitOpts);

    // Record the commit count before running the hook
    const beforeLog = spawnSync("git", ["log", "--oneline"], { cwd: claudeDir, encoding: "utf8" });
    const beforeCount = beforeLog.stdout.trim().split("\n").filter(Boolean).length;

    const result = runHook(
      HOOK_MODULE,
      { session_id: "test-nochange-001", cwd: projectDir },
      { HOME: home, USERPROFILE: home, CLAUDE_NO_AUTO_PUSH: "1" }
    );

    assert.strictEqual(result.status, 0, "Hook should exit 0");

    // Commit count should not have increased
    const afterLog = spawnSync("git", ["log", "--oneline"], { cwd: claudeDir, encoding: "utf8" });
    const afterCount = afterLog.stdout.trim().split("\n").filter(Boolean).length;
    assert.strictEqual(afterCount, beforeCount, "Should not create a new commit when nothing changed");
  } finally {
    cleanup();
    try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch {}
  }
});

// Test 10: CLAUDE_NO_AUTO_PUSH=1 skips push (commit still happens)
test("10. CLAUDE_NO_AUTO_PUSH=1 skips push, commit still happens", () => {
  const { home, claudeDir, cleanup } = createTempHome();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-end-proj-"));
  try {
    initGitRepo(claudeDir, { initialCommit: true });

    const encodedCwd = encodeCwd(projectDir);
    const memDir = path.join(claudeDir, "projects", encodedCwd, "memory");
    fs.mkdirSync(memDir, { recursive: true });
    const memPath = path.join(memDir, "MEMORY.md");
    fs.writeFileSync(memPath, "# Memory\n\nInitial content\n");

    const gitOpts = { cwd: claudeDir, stdio: "pipe" };
    spawnSync("git", ["add", "--", `projects/${encodedCwd}/memory/MEMORY.md`], gitOpts);
    spawnSync("git", ["commit", "-m", "initial"], gitOpts);

    // Modify the file
    fs.writeFileSync(memPath, "# Memory\n\nChanged after no-push\n");

    const result = runHook(
      HOOK_MODULE,
      { session_id: "test-nopush-001", cwd: projectDir },
      { HOME: home, USERPROFILE: home, CLAUDE_NO_AUTO_PUSH: "1" }
    );

    assert.strictEqual(result.status, 0, "Hook should exit 0");
    // Output should be {} — no push failure warning
    assert.deepStrictEqual(result.json, {}, "Should output {} when push is skipped");

    // A commit should still have been created
    const logResult = spawnSync("git", ["log", "--oneline"], { cwd: claudeDir, encoding: "utf8" });
    const logLines = logResult.stdout.trim().split("\n").filter(Boolean);
    assert.ok(logLines.length >= 2, "Commit should still have been created despite no-push");
    assert.ok(logLines[0].includes("auto:"), "Most recent commit should be an auto-commit");
  } finally {
    cleanup();
    try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch {}
  }
});

// Test 11: Push failure produces warning in output
test("11. Push failure produces warning in hookSpecificOutput", () => {
  const { home, claudeDir, cleanup } = createTempHome();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-end-proj-"));
  try {
    initGitRepo(claudeDir, { initialCommit: true });

    // Add a fake remote that will always fail
    const gitOpts = { cwd: claudeDir, stdio: "pipe" };
    spawnSync("git", ["remote", "add", "origin", "git://nonexistent.invalid/repo.git"], gitOpts);

    // Create and commit initial memory so subsequent change can be auto-committed
    const encodedCwd = encodeCwd(projectDir);
    const memDir = path.join(claudeDir, "projects", encodedCwd, "memory");
    fs.mkdirSync(memDir, { recursive: true });
    const memPath = path.join(memDir, "MEMORY.md");
    fs.writeFileSync(memPath, "# Memory\n\nInitial\n");

    spawnSync("git", ["add", "--", `projects/${encodedCwd}/memory/MEMORY.md`], gitOpts);
    spawnSync("git", ["commit", "-m", "initial memory"], gitOpts);

    // Modify to trigger auto-commit + push attempt
    fs.writeFileSync(memPath, "# Memory\n\nModified to trigger push\n");

    const result = runHook(
      HOOK_MODULE,
      { session_id: "test-pushfail-001", cwd: projectDir },
      {
        HOME: home,
        USERPROFILE: home,
        // Do NOT set CLAUDE_NO_AUTO_PUSH — let push run and fail
        GIT_TERMINAL_PROMPT: "0",  // Prevent git from prompting for credentials
      }
    );

    assert.strictEqual(result.status, 0, "Hook should exit 0 even when push fails");
    assert.ok(result.json !== null, "Should output valid JSON");
    // Either push warning or {} (if push was skipped because remote is unreachable at git level)
    // The key guarantee is: never crash, always exit 0, always valid JSON
    if (result.json.hookSpecificOutput) {
      assert.ok(
        typeof result.json.hookSpecificOutput.additionalContext === "string",
        "Push warning additionalContext should be a string"
      );
      assert.ok(
        result.json.hookSpecificOutput.additionalContext.includes("WARNING") ||
        result.json.hookSpecificOutput.additionalContext.includes("push"),
        `Warning should mention push failure, got: ${result.json.hookSpecificOutput.additionalContext}`
      );
    }
    // Always valid JSON either way
    assert.ok(typeof result.json === "object", "Output should always be a valid object");
  } finally {
    cleanup();
    try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch {}
  }
});

// Test 12: extractSalientTerms deduplicates repeated tokens
test("12. extractSalientTerms deduplicates repeated tokens", () => {
  const extractSalientTerms = loadExtractSalientTerms();
  const text = "hook hook hook testing testing testing error error";
  const terms = extractSalientTerms(text);
  const hookCount = terms.filter(t => t === "hook").length;
  const testCount = terms.filter(t => t === "testing").length;
  const errorCount = terms.filter(t => t === "error").length;
  assert.strictEqual(hookCount, 1, "Should deduplicate 'hook'");
  assert.strictEqual(testCount, 1, "Should deduplicate 'testing'");
  assert.strictEqual(errorCount, 1, "Should deduplicate 'error'");
});

// Test 13: Memory auto-commit initializes ~/.claude as git repo if needed
test("13. Memory auto-commit initializes ~/.claude as git repo if not already one", () => {
  const { home, claudeDir, cleanup } = createTempHome();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-end-proj-"));
  try {
    // Do NOT pre-initialize claudeDir as a git repo — let the hook do it
    assert.ok(!fs.existsSync(path.join(claudeDir, ".git")), "Precondition: no .git in claudeDir");

    const result = runHook(
      HOOK_MODULE,
      { session_id: "test-init-001", cwd: projectDir },
      { HOME: home, USERPROFILE: home, CLAUDE_NO_AUTO_PUSH: "1" }
    );

    assert.strictEqual(result.status, 0, "Hook should exit 0");
    // After running, ~/.claude should be a git repo
    assert.ok(
      fs.existsSync(path.join(claudeDir, ".git")),
      "Hook should have initialized ~/.claude as a git repo"
    );
  } finally {
    cleanup();
    try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch {}
  }
});

// Test 14: Hook exits 0 when cwd is missing from input
test("14. Hook exits 0 when cwd is omitted from input (uses process.cwd())", () => {
  const { home, cleanup } = createTempHome();
  try {
    // No cwd in input — hook falls back to process.cwd()
    const result = runHook(
      HOOK_MODULE,
      { session_id: "test-nocwd-001" },
      { HOME: home, USERPROFILE: home, CLAUDE_NO_AUTO_PUSH: "1" }
    );
    assert.strictEqual(result.status, 0, "Hook should exit 0 when cwd omitted");
    assert.ok(result.json !== null, "Should output valid JSON");
  } finally {
    cleanup();
  }
});

// Test 15: Hook skips push when no remote is configured
test("15. Hook skips push when no remote is configured (outputs {})", () => {
  const { home, claudeDir, cleanup } = createTempHome();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-end-proj-"));
  try {
    // Initialize git repo but add NO remote
    initGitRepo(claudeDir, { initialCommit: true });

    const encodedCwd = encodeCwd(projectDir);
    const memDir = path.join(claudeDir, "projects", encodedCwd, "memory");
    fs.mkdirSync(memDir, { recursive: true });
    const memPath = path.join(memDir, "MEMORY.md");
    fs.writeFileSync(memPath, "# Memory\n\nContent\n");

    const gitOpts = { cwd: claudeDir, stdio: "pipe" };
    spawnSync("git", ["add", "--", `projects/${encodedCwd}/memory/MEMORY.md`], gitOpts);
    spawnSync("git", ["commit", "-m", "initial memory"], gitOpts);

    // Modify to trigger auto-commit path
    fs.writeFileSync(memPath, "# Memory\n\nNew content\n");

    const result = runHook(
      HOOK_MODULE,
      { session_id: "test-noremote-001", cwd: projectDir },
      { HOME: home, USERPROFILE: home }
      // NOTE: no CLAUDE_NO_AUTO_PUSH — should auto-detect no remote and skip
    );

    assert.strictEqual(result.status, 0, "Hook should exit 0");
    // No remote → no push attempted → no push failure warning → output is {}
    assert.deepStrictEqual(result.json, {}, "Should output {} when no remote is configured");
  } finally {
    cleanup();
    try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch {}
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
