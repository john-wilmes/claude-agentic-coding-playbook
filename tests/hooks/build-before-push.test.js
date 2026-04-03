#!/usr/bin/env node
// Integration tests for build-before-push.js (PreToolUse + PostToolUse hook).
// Zero dependencies — uses only Node built-ins + local test-helpers.
//
// Run: node tests/hooks/build-before-push.test.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const { runHook, runHookRaw } = require("./test-helpers");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const HOOK = path.join(REPO_ROOT, "templates", "hooks", "build-before-push.js");

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

const { execSync } = require("child_process");

function markerPath(repoRoot) {
  const hash = crypto.createHash("md5").update(repoRoot).digest("hex").slice(0, 12);
  return path.join(os.tmpdir(), `claude-build-pass-${hash}`);
}

/** Resolve a dir the same way git does (handles macOS /tmp → /private/tmp) */
function gitResolvedRoot(dir) {
  return execSync("git rev-parse --show-toplevel", {
    encoding: "utf8", cwd: dir, timeout: 3000,
  }).trim();
}

/** Create a temp dir with tsconfig.json so the hook considers it a build repo */
function createBuildRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bbp-test-"));
  execSync("git init", { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "tsconfig.json"), "{}");
  // Return the git-resolved path so marker calculations match the hook
  return gitResolvedRoot(dir);
}

/** Create a temp dir without any build markers (no tsconfig, no lockfiles) */
function createNonBuildRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bbp-test-"));
  execSync("git init", { cwd: dir, stdio: "ignore" });
  return gitResolvedRoot(dir);
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function cleanupMarker(dir) {
  try { fs.unlinkSync(markerPath(dir)); } catch {}
}

function runPost(cmd, dir, toolResult = {}) {
  return runHook(HOOK, {
    event: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: cmd },
    tool_result: toolResult,
    cwd: dir,
  });
}

function runPre(cmd, dir) {
  return runHook(HOOK, {
    event: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: cmd },
    cwd: dir,
  });
}

// ─── Tests: non-Bash tools ignored ──────────────────────────────────────────

console.log("\n  build-before-push.js");

test("ignores non-Bash tools", () => {
  const res = runHook(HOOK, {
    event: "PreToolUse",
    tool_name: "Edit",
    tool_input: { file_path: "/tmp/foo.ts" },
  });
  assert.strictEqual(res.status, 0);
  assert.deepStrictEqual(res.json, {});
});

// ─── Tests: PostToolUse — build marker creation ─────────────────────────────

console.log("");

test("PostToolUse: records marker on successful pnpm run build", () => {
  const dir = createBuildRepo();
  cleanupMarker(dir);
  try {
    const res = runPost("pnpm run build", dir, { exitCode: 0, stdout: "Done" });
    assert.strictEqual(res.status, 0);
    assert.ok(fs.existsSync(markerPath(dir)), "marker file should exist");
  } finally {
    cleanupMarker(dir);
    cleanup(dir);
  }
});

test("PostToolUse: records marker on successful npm run build", () => {
  const dir = createBuildRepo();
  cleanupMarker(dir);
  try {
    const res = runPost("npm run build", dir, { exitCode: 0 });
    assert.strictEqual(res.status, 0);
    assert.ok(fs.existsSync(markerPath(dir)), "marker file should exist");
  } finally {
    cleanupMarker(dir);
    cleanup(dir);
  }
});

test("PostToolUse: records marker on successful tsc", () => {
  const dir = createBuildRepo();
  cleanupMarker(dir);
  try {
    const res = runPost("npx tsc", dir, { exitCode: 0 });
    assert.strictEqual(res.status, 0);
    assert.ok(fs.existsSync(markerPath(dir)), "marker file should exist");
  } finally {
    cleanupMarker(dir);
    cleanup(dir);
  }
});

test("PostToolUse: records marker on yarn build", () => {
  const dir = createBuildRepo();
  cleanupMarker(dir);
  try {
    const res = runPost("yarn build", dir, { exitCode: 0 });
    assert.strictEqual(res.status, 0);
    assert.ok(fs.existsSync(markerPath(dir)), "marker file should exist");
  } finally {
    cleanupMarker(dir);
    cleanup(dir);
  }
});

test("PostToolUse: does NOT record marker on failed build (exitCode 1)", () => {
  const dir = createBuildRepo();
  cleanupMarker(dir);
  try {
    runPost("pnpm run build", dir, { exitCode: 1, stderr: "Build failed" });
    assert.ok(!fs.existsSync(markerPath(dir)), "marker should NOT exist after failed build");
  } finally {
    cleanupMarker(dir);
    cleanup(dir);
  }
});

test("PostToolUse: does NOT record marker when stdout has TS errors", () => {
  const dir = createBuildRepo();
  cleanupMarker(dir);
  try {
    runPost("pnpm run build", dir, { exitCode: 0, stdout: "error TS2304: Cannot find name 'foo'" });
    assert.ok(!fs.existsSync(markerPath(dir)), "marker should NOT exist with TS errors in stdout");
  } finally {
    cleanupMarker(dir);
    cleanup(dir);
  }
});

test("PostToolUse: ignores non-build commands", () => {
  const dir = createBuildRepo();
  cleanupMarker(dir);
  try {
    runPost("git status", dir, { exitCode: 0 });
    assert.ok(!fs.existsSync(markerPath(dir)), "marker should NOT exist for non-build command");
  } finally {
    cleanupMarker(dir);
    cleanup(dir);
  }
});

test("PostToolUse: records marker for pnpm run typecheck", () => {
  const dir = createBuildRepo();
  cleanupMarker(dir);
  try {
    runPost("pnpm run typecheck", dir, { exitCode: 0 });
    assert.ok(fs.existsSync(markerPath(dir)), "marker file should exist for typecheck");
  } finally {
    cleanupMarker(dir);
    cleanup(dir);
  }
});

// ─── Tests: PreToolUse — push gating ───────────────────────────────────────

console.log("");

test("PreToolUse: allows push when fresh marker exists", () => {
  const dir = createBuildRepo();
  const marker = markerPath(dir);
  try {
    // Write a fresh marker
    fs.writeFileSync(marker, `${new Date().toISOString()}\n${dir}\n`);
    const res = runPre("git push", dir);
    assert.strictEqual(res.status, 0);
    // Should NOT have a deny decision
    const decision = res.json?.hookSpecificOutput?.permissionDecision;
    assert.ok(decision !== "deny", "should allow push with fresh marker");
  } finally {
    cleanupMarker(dir);
    cleanup(dir);
  }
});

test("PreToolUse: blocks push when no marker exists", () => {
  const dir = createBuildRepo();
  cleanupMarker(dir);
  try {
    const res = runPre("git push", dir);
    assert.strictEqual(res.status, 0);
    assert.strictEqual(res.json?.hookSpecificOutput?.permissionDecision, "deny");
    assert.ok(
      res.json.hookSpecificOutput.permissionDecisionReason.includes("No successful build"),
      "reason should mention missing build"
    );
  } finally {
    cleanup(dir);
  }
});

test("PreToolUse: blocks push when marker is stale (>30min)", () => {
  const dir = createBuildRepo();
  const marker = markerPath(dir);
  try {
    // Write marker and backdate it
    fs.writeFileSync(marker, "stale\n");
    const staleTime = Date.now() - 31 * 60 * 1000;
    fs.utimesSync(marker, new Date(staleTime), new Date(staleTime));
    const res = runPre("git push", dir);
    assert.strictEqual(res.status, 0);
    assert.strictEqual(res.json?.hookSpecificOutput?.permissionDecision, "deny");
  } finally {
    cleanupMarker(dir);
    cleanup(dir);
  }
});

test("PreToolUse: allows push for non-build repos (no tsconfig/lockfile)", () => {
  const dir = createNonBuildRepo();
  cleanupMarker(dir);
  try {
    const res = runPre("git push", dir);
    assert.strictEqual(res.status, 0);
    const decision = res.json?.hookSpecificOutput?.permissionDecision;
    assert.ok(decision !== "deny", "should not block non-build repos");
  } finally {
    cleanup(dir);
  }
});

test("PreToolUse: allows push with git push origin main", () => {
  const dir = createBuildRepo();
  const marker = markerPath(dir);
  try {
    fs.writeFileSync(marker, `${new Date().toISOString()}\n${dir}\n`);
    const res = runPre("git push origin main", dir);
    assert.strictEqual(res.status, 0);
    const decision = res.json?.hookSpecificOutput?.permissionDecision;
    assert.ok(decision !== "deny", "should allow push with fresh marker");
  } finally {
    cleanupMarker(dir);
    cleanup(dir);
  }
});

test("PreToolUse: ignores non-push commands", () => {
  const dir = createBuildRepo();
  cleanupMarker(dir);
  try {
    const res = runPre("git status", dir);
    assert.strictEqual(res.status, 0);
    assert.deepStrictEqual(res.json, {});
  } finally {
    cleanup(dir);
  }
});

// ─── Tests: cd prefix handling ──────────────────────────────────────────────

console.log("");

test("PostToolUse: handles cd prefix in build command", () => {
  const dir = createBuildRepo();
  cleanupMarker(dir);
  try {
    runPost(`cd ${dir} && pnpm run build`, dir, { exitCode: 0 });
    assert.ok(fs.existsSync(markerPath(dir)), "marker should exist for cd-prefixed build");
  } finally {
    cleanupMarker(dir);
    cleanup(dir);
  }
});

test("PreToolUse: handles cd prefix in push command", () => {
  const dir = createBuildRepo();
  cleanupMarker(dir);
  try {
    const res = runPre(`cd ${dir} && git push`, dir);
    assert.strictEqual(res.status, 0);
    assert.strictEqual(res.json?.hookSpecificOutput?.permissionDecision, "deny");
  } finally {
    cleanup(dir);
  }
});

// ─── Tests: edge cases ──────────────────────────────────────────────────────

console.log("");

test("handles malformed JSON gracefully", () => {
  const res = runHookRaw(HOOK, "not json at all");
  assert.strictEqual(res.status, 0);
  assert.deepStrictEqual(res.json, {});
});

test("handles missing tool_input gracefully", () => {
  const res = runHook(HOOK, { event: "PreToolUse", tool_name: "Bash" });
  assert.strictEqual(res.status, 0);
  assert.deepStrictEqual(res.json, {});
});

test("PostToolUse: records marker when exitCode is undefined (success assumed)", () => {
  const dir = createBuildRepo();
  cleanupMarker(dir);
  try {
    // When exitCode is not present, treat as success
    runPost("pnpm run build", dir, { stdout: "Build completed" });
    assert.ok(fs.existsSync(markerPath(dir)), "marker should exist when exitCode undefined");
  } finally {
    cleanupMarker(dir);
    cleanup(dir);
  }
});

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failures.length > 0) {
  console.log("  Failures:");
  for (const f of failures) {
    console.log(`    - ${f.name}: ${f.error}`);
  }
  process.exit(1);
}
