#!/usr/bin/env node
// Integration tests for protect-main.js (PreToolUse:Bash hook).
// Blocks git commit commands when on main/master branch.
// Zero dependencies — uses only Node built-ins + local test-helpers.
//
// Run: node tests/hooks/protect-main.test.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

const { runHook, runHookRaw, createTempHome } = require("./test-helpers");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const PROTECT_MAIN = path.join(REPO_ROOT, "templates", "hooks", "protect-main.js");

// ─── Test runner ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failed++;
    console.log(`  \u2717 ${name}`);
    console.log(`    ${err.message}`);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Create a temporary git repo and optionally switch to a named branch.
 * Returns { dir, cleanup }.
 */
function makeTempRepo(branch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-test-"));
  try {
    execSync("git init", { cwd: dir, stdio: "pipe" });
    // Set a default branch name explicitly so git doesn't default to "master" or "main"
    // depending on system config — we control it via checkout below.
    if (branch && branch !== "main") {
      // git init defaults to "master" or "main"; rename if needed
      try {
        execSync(`git checkout -b ${branch}`, { cwd: dir, stdio: "pipe" });
      } catch {
        // If checkout -b fails (empty repo on some git versions), try symbolic-ref
        execSync(`git symbolic-ref HEAD refs/heads/${branch}`, { cwd: dir, stdio: "pipe" });
      }
    }
    // If branch is "main", ensure we're on main (handle systems that default to master)
    if (branch === "main") {
      try {
        execSync("git checkout -b main", { cwd: dir, stdio: "pipe" });
      } catch {
        execSync("git symbolic-ref HEAD refs/heads/main", { cwd: dir, stdio: "pipe" });
      }
    }
    if (branch === "master") {
      try {
        execSync("git checkout -b master", { cwd: dir, stdio: "pipe" });
      } catch {
        execSync("git symbolic-ref HEAD refs/heads/master", { cwd: dir, stdio: "pipe" });
      }
    }
  } catch (e) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    throw e;
  }
  return {
    dir,
    cleanup() {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

console.log("\nprotect-main.js:");

// 1. Non-commit Bash command → allow
test("1. Non-commit command (git push): allow", () => {
  const env = createTempHome();
  try {
    const result = runHook(PROTECT_MAIN, {
      tool_name: "Bash",
      tool_input: { command: "git push origin feat/test" },
    }, { HOME: env.home, USERPROFILE: env.home });
    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.ok(result.json, "Should output valid JSON");
    assert.ok(!result.json?.hookSpecificOutput?.permissionDecision || result.json.hookSpecificOutput.permissionDecision !== "deny", "Should not block non-commit command");
  } finally {
    env.cleanup();
  }
});

// 2. Non-Bash tool (Read) → allow
test("2. Non-Bash tool (Read): allow", () => {
  const env = createTempHome();
  try {
    const result = runHook(PROTECT_MAIN, {
      tool_name: "Read",
      tool_input: { file_path: "/some/file.js" },
    }, { HOME: env.home, USERPROFILE: env.home });
    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.ok(result.json, "Should output valid JSON");
    assert.ok(!result.json?.hookSpecificOutput?.permissionDecision || result.json.hookSpecificOutput.permissionDecision !== "deny", "Should not block non-Bash tool");
  } finally {
    env.cleanup();
  }
});

// 3. git commit on a feature branch → allow
test("3. git commit on a feature branch: allow", () => {
  const env = createTempHome();
  const repo = makeTempRepo("feat/test");
  try {
    const result = runHook(PROTECT_MAIN, {
      tool_name: "Bash",
      tool_input: { command: 'git commit -m "test"' },
      cwd: repo.dir,
    }, { HOME: env.home, USERPROFILE: env.home });
    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.ok(result.json, "Should output valid JSON");
    assert.ok(!result.json?.hookSpecificOutput?.permissionDecision || result.json.hookSpecificOutput.permissionDecision !== "deny", "Should allow commit on feature branch");
  } finally {
    repo.cleanup();
    env.cleanup();
  }
});

// 4. git commit on main → block
test("4. git commit on main: block with permissionDecision:deny", () => {
  const env = createTempHome();
  const repo = makeTempRepo("main");
  try {
    const result = runHook(PROTECT_MAIN, {
      tool_name: "Bash",
      tool_input: { command: 'git commit -m "test"' },
      cwd: repo.dir,
    }, { HOME: env.home, USERPROFILE: env.home });
    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.ok(result.json, "Should output valid JSON");
    const hso = result.json?.hookSpecificOutput;
    assert.strictEqual(hso?.permissionDecision, "deny", "Should deny on main branch");
    assert.ok(hso?.permissionDecisionReason, "Should include a reason");
    assert.ok(hso?.permissionDecisionReason.includes("main"), "Reason should mention branch name");
  } finally {
    repo.cleanup();
    env.cleanup();
  }
});

// 5. git commit on master → block
test("5. git commit on master: block with permissionDecision:deny", () => {
  const env = createTempHome();
  const repo = makeTempRepo("master");
  try {
    const result = runHook(PROTECT_MAIN, {
      tool_name: "Bash",
      tool_input: { command: 'git commit -m "test"' },
      cwd: repo.dir,
    }, { HOME: env.home, USERPROFILE: env.home });
    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.ok(result.json, "Should output valid JSON");
    const hso = result.json?.hookSpecificOutput;
    assert.strictEqual(hso?.permissionDecision, "deny", "Should deny on master branch");
    assert.ok(hso?.permissionDecisionReason, "Should include a reason");
    assert.ok(hso?.permissionDecisionReason.includes("master"), "Reason should mention branch name");
  } finally {
    repo.cleanup();
    env.cleanup();
  }
});

// 6. Malformed JSON input → exits 0, outputs valid JSON
test("6. Malformed JSON input: exits 0, outputs valid JSON", () => {
  const result = runHookRaw(PROTECT_MAIN, "not valid json at all");
  assert.strictEqual(result.status, 0, "Should exit 0");
  assert.ok(result.json, "Should output valid JSON");
  assert.deepStrictEqual(result.json, {}, "Should output empty object on parse error");
});

// 7. git commit in a non-git directory → allow (graceful degradation)
test("7. git commit in non-git directory: allow (graceful degradation)", () => {
  const env = createTempHome();
  // Use a real temp dir that is NOT a git repo
  const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-nongit-"));
  try {
    const result = runHook(PROTECT_MAIN, {
      tool_name: "Bash",
      tool_input: { command: 'git commit -m "test"' },
      cwd: nonGitDir,
    }, { HOME: env.home, USERPROFILE: env.home });
    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.ok(result.json, "Should output valid JSON");
    assert.ok(!result.json?.hookSpecificOutput?.permissionDecision || result.json.hookSpecificOutput.permissionDecision !== "deny", "Should allow when branch cannot be determined");
  } finally {
    try { fs.rmSync(nonGitDir, { recursive: true, force: true }); } catch {}
    env.cleanup();
  }
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed (${passed + failed} total)`);

process.exit(failed > 0 ? 1 : 0);
