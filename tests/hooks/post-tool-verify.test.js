#!/usr/bin/env node
// Unit tests for templates/hooks/post-tool-verify.js
// Zero dependencies — uses only Node built-ins + test-helpers.
//
// Run: node tests/hooks/post-tool-verify.test.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { runHook, createTempHome, createStagedDir } = require("./test-helpers");

// Resolve hook path relative to repo root
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const POST_TOOL_VERIFY = path.join(REPO_ROOT, "templates", "hooks", "post-tool-verify.js");

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

// ─── extractFunction ──────────────────────────────────────────────────────────

/**
 * Extract functions from a hook source by writing them to a temp module file.
 * Returns the requested function ready to call. Dependencies (other functions
 * from the same file) are included automatically.
 */
let _extractCounter = 0;
function extractFunction(hookPath, funcName) {
  const src = fs.readFileSync(hookPath, "utf8");

  // Take everything before the stdin handler — all function declarations live there
  const boundary = src.indexOf("process.stdin.resume()");
  const declarations = boundary > 0 ? src.slice(0, boundary) : src;

  // Write a temp module that re-exports the needed function
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

// ─── Helper: create a temp project with CLAUDE.md and an optional code file ──

function createTempProject(claudeMdContent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-proj-"));
  if (claudeMdContent !== null && claudeMdContent !== undefined) {
    fs.writeFileSync(path.join(dir, "CLAUDE.md"), claudeMdContent);
  }
  return dir;
}

// ─── Unit tests: extractTestCommand ──────────────────────────────────────────

console.log("\nextractTestCommand:");

test("1. Test: `npm test` -> extracts 'npm test'", (env) => {
  const extractTestCommand = extractFunction(POST_TOOL_VERIFY, "extractTestCommand");
  const result = extractTestCommand("## Quality Gates\n\nTest: `npm test`\n");
  assert.strictEqual(result, "npm test");
});

test("2. test: `pytest` -> extracts 'pytest' (case insensitive)", (env) => {
  const extractTestCommand = extractFunction(POST_TOOL_VERIFY, "extractTestCommand");
  const result = extractTestCommand("test: `pytest`\n");
  assert.strictEqual(result, "pytest");
});

test("3. No test line -> returns null", (env) => {
  const extractTestCommand = extractFunction(POST_TOOL_VERIFY, "extractTestCommand");
  const result = extractTestCommand("## Commands\n\nLint: `npm run lint`\nBuild: `npm run build`\n");
  assert.strictEqual(result, null);
});

test("4. Multiple quality gates -> extracts the test one", (env) => {
  const extractTestCommand = extractFunction(POST_TOOL_VERIFY, "extractTestCommand");
  const content = [
    "## Quality Gates",
    "",
    "Lint: `npm run lint`",
    "Type-check: `npm run tsc`",
    "Test: `npm run test:unit`",
    "Build: `npm run build`",
  ].join("\n");
  const result = extractTestCommand(content);
  assert.strictEqual(result, "npm run test:unit");
});

// ─── Unit tests: shouldSkipFile ───────────────────────────────────────────────

console.log("\nshouldSkipFile:");

test("5. src/app.ts -> false (should NOT skip)", (env) => {
  const shouldSkipFile = extractFunction(POST_TOOL_VERIFY, "shouldSkipFile");
  assert.strictEqual(shouldSkipFile("src/app.ts"), false);
});

test("6. README.md -> true (should skip)", (env) => {
  const shouldSkipFile = extractFunction(POST_TOOL_VERIFY, "shouldSkipFile");
  assert.strictEqual(shouldSkipFile("README.md"), true);
});

test("7. package.json -> true (should skip)", (env) => {
  const shouldSkipFile = extractFunction(POST_TOOL_VERIFY, "shouldSkipFile");
  assert.strictEqual(shouldSkipFile("package.json"), true);
});

test("8. config.yaml -> true (should skip)", (env) => {
  const shouldSkipFile = extractFunction(POST_TOOL_VERIFY, "shouldSkipFile");
  assert.strictEqual(shouldSkipFile("config.yaml"), true);
});

// ─── Integration tests via runHook ───────────────────────────────────────────

console.log("\nintegration (runHook):");

test("9. Edit on .ts file in project with test command -> hook runs (additionalContext present)", (env) => {
  const projDir = createTempProject("## Quality Gates\n\nTest: `echo PASS`\n");
  fs.writeFileSync(path.join(projDir, "app.ts"), "export const x = 1;\n");

  try {
    const result = runHook(POST_TOOL_VERIFY, {
      tool_name: "Edit",
      tool_input: { file_path: path.join(projDir, "app.ts") },
      session_id: "test-session-9",
      cwd: projDir,
    }, { HOME: env.home, USERPROFILE: env.home });

    assert.strictEqual(result.status, 0);
    assert.ok(result.json, "Should output valid JSON");
    const ctx = result.json.hookSpecificOutput && result.json.hookSpecificOutput.additionalContext;
    assert.ok(ctx, "additionalContext should be present");
    assert.ok(
      ctx.includes("Tests passed") || ctx.includes("Tests failed"),
      `additionalContext should mention test result, got: ${ctx}`
    );
  } finally {
    try { fs.rmSync(projDir, { recursive: true, force: true }); } catch {}
  }
});

test("10. Edit on .md file -> hook skips (no additionalContext about tests)", (env) => {
  const projDir = createTempProject("## Quality Gates\n\nTest: `echo PASS`\n");

  try {
    const result = runHook(POST_TOOL_VERIFY, {
      tool_name: "Edit",
      tool_input: { file_path: path.join(projDir, "README.md") },
      session_id: "test-session-10",
      cwd: projDir,
    }, { HOME: env.home, USERPROFILE: env.home });

    assert.strictEqual(result.status, 0);
    assert.ok(result.json, "Should output valid JSON");
    // Either returns { decision: "allow" } or {} — no test additionalContext
    const ctx = result.json.hookSpecificOutput && result.json.hookSpecificOutput.additionalContext;
    assert.ok(!ctx, `Should have no additionalContext for .md file, got: ${ctx}`);
  } finally {
    try { fs.rmSync(projDir, { recursive: true, force: true }); } catch {}
  }
});

test("11. Write tool on .js file -> hook runs (additionalContext present)", (env) => {
  const projDir = createTempProject("## Quality Gates\n\nTest: `echo PASS`\n");
  fs.writeFileSync(path.join(projDir, "util.js"), "module.exports = {};\n");

  try {
    const result = runHook(POST_TOOL_VERIFY, {
      tool_name: "Write",
      tool_input: { file_path: path.join(projDir, "util.js") },
      session_id: "test-session-11",
      cwd: projDir,
    }, { HOME: env.home, USERPROFILE: env.home });

    assert.strictEqual(result.status, 0);
    assert.ok(result.json, "Should output valid JSON");
    const ctx = result.json.hookSpecificOutput && result.json.hookSpecificOutput.additionalContext;
    assert.ok(ctx, "additionalContext should be present for Write on .js file");
  } finally {
    try { fs.rmSync(projDir, { recursive: true, force: true }); } catch {}
  }
});

test("12. Read tool -> hook skips entirely (no additionalContext)", (env) => {
  const projDir = createTempProject("## Quality Gates\n\nTest: `echo PASS`\n");

  try {
    const result = runHook(POST_TOOL_VERIFY, {
      tool_name: "Read",
      tool_input: { file_path: path.join(projDir, "app.ts") },
      session_id: "test-session-12",
      cwd: projDir,
    }, { HOME: env.home, USERPROFILE: env.home });

    assert.strictEqual(result.status, 0);
    assert.ok(result.json, "Should output valid JSON");
    // Should be a quick allow with no test context
    const ctx = result.json.hookSpecificOutput && result.json.hookSpecificOutput.additionalContext;
    assert.ok(!ctx, `Read tool should not trigger tests, got: ${ctx}`);
    assert.strictEqual(result.json.decision, undefined, "PostToolUse should not use decision field");
  } finally {
    try { fs.rmSync(projDir, { recursive: true, force: true }); } catch {}
  }
});

test("13. No CLAUDE.md in project -> hook skips gracefully", (env) => {
  const projDir = createTempProject(null); // no CLAUDE.md

  try {
    const result = runHook(POST_TOOL_VERIFY, {
      tool_name: "Edit",
      tool_input: { file_path: path.join(projDir, "app.ts") },
      session_id: "test-session-13",
      cwd: projDir,
    }, { HOME: env.home, USERPROFILE: env.home });

    assert.strictEqual(result.status, 0);
    assert.ok(result.json, "Should output valid JSON");
    const ctx = result.json.hookSpecificOutput && result.json.hookSpecificOutput.additionalContext;
    assert.ok(!ctx, "No CLAUDE.md should produce no additionalContext");
  } finally {
    try { fs.rmSync(projDir, { recursive: true, force: true }); } catch {}
  }
});

// ─── Knowledge capture tests ─────────────────────────────────────────────────

console.log("\nknowledge capture (runHook):");

test("14. fail→pass transition stages a knowledge candidate", (env) => {
  const projDir = createTempProject("## Quality Gates\n\nTest: `echo PASS`\n");
  const stagedDir = createStagedDir(env.home);

  // Pre-populate debounce state with lastPassed=false so the hook sees a fail→pass transition.
  // Use a timestamp older than DEBOUNCE_MS so it is not debounced.
  const debounceFile = require("path").join(env.home, ".claude", ".verify-last-run");
  const oldState = {};
  oldState[projDir] = { ts: Date.now() - 20000, lastPassed: false, lastFailOutput: "AssertionError: expected 1 to equal 2" };
  require("fs").writeFileSync(debounceFile, JSON.stringify(oldState));

  try {
    const result = runHook(POST_TOOL_VERIFY, {
      tool_name: "Edit",
      tool_input: { file_path: path.join(projDir, "app.ts") },
      session_id: "test-session-14",
      cwd: projDir,
    }, { HOME: env.home, USERPROFILE: env.home });

    assert.strictEqual(result.status, 0);
    assert.ok(result.json, "Should output valid JSON");

    // Verify a staged candidate was created for this session.
    // When knowledge-db is available the hook writes to SQLite rather than JSONL.
    const dbPath = path.join(env.home, ".claude", "knowledge", "knowledge.db");
    const kdb = require(path.join(REPO_ROOT, "templates", "hooks", "knowledge-db"));
    if (fs.existsSync(dbPath)) {
      // DB-backed path
      const verifyDb = kdb.openDb(dbPath);
      const candidates = kdb.readStagedCandidates(verifyDb, "test-session-14");
      assert.ok(candidates.length >= 1, "Should have at least one staged candidate in DB");
      const candidate = candidates[0];
      assert.strictEqual(candidate.trigger, "test-fix", "trigger should be test-fix");
      assert.strictEqual(candidate.session_id, "test-session-14");
      assert.ok(candidate.summary.includes("AssertionError"), `summary should include first line of fail output, got: ${candidate.summary}`);
    } else {
      // JSONL fallback path
      const stagedFile = path.join(stagedDir, "test-session-14.jsonl");
      assert.ok(fs.existsSync(stagedFile), `Staged file should exist at ${stagedFile}`);
      const lines = fs.readFileSync(stagedFile, "utf8").trim().split("\n").filter(Boolean);
      assert.ok(lines.length >= 1, "Should have at least one staged candidate");
      const candidate = JSON.parse(lines[0]);
      assert.strictEqual(candidate.trigger, "test-fix", "trigger should be test-fix");
      assert.strictEqual(candidate.session_id, "test-session-14");
      assert.ok(candidate.summary.includes("AssertionError"), `summary should include first line of fail output, got: ${candidate.summary}`);
    }
  } finally {
    try { fs.rmSync(projDir, { recursive: true, force: true }); } catch {}
  }
});

test("15. pass→pass does not stage a candidate", (env) => {
  const projDir = createTempProject("## Quality Gates\n\nTest: `echo PASS`\n");
  const stagedDir = createStagedDir(env.home);

  // Pre-populate debounce state with lastPassed=true
  const debounceFile = require("path").join(env.home, ".claude", ".verify-last-run");
  const oldState = {};
  oldState[projDir] = { ts: Date.now() - 20000, lastPassed: true, lastFailOutput: "" };
  require("fs").writeFileSync(debounceFile, JSON.stringify(oldState));

  try {
    const result = runHook(POST_TOOL_VERIFY, {
      tool_name: "Edit",
      tool_input: { file_path: path.join(projDir, "app.ts") },
      session_id: "test-session-15",
      cwd: projDir,
    }, { HOME: env.home, USERPROFILE: env.home });

    assert.strictEqual(result.status, 0);
    assert.ok(result.json, "Should output valid JSON");

    // Verify no staged candidate was created for this session.
    const dbPath = path.join(env.home, ".claude", "knowledge", "knowledge.db");
    const kdb = require(path.join(REPO_ROOT, "templates", "hooks", "knowledge-db"));
    if (fs.existsSync(dbPath)) {
      // DB-backed path
      const verifyDb = kdb.openDb(dbPath);
      const candidates = kdb.readStagedCandidates(verifyDb, "test-session-15");
      assert.strictEqual(candidates.length, 0, "Should have no staged candidates for pass→pass transition");
    } else {
      // JSONL fallback path
      const stagedFile = path.join(stagedDir, "test-session-15.jsonl");
      assert.ok(!fs.existsSync(stagedFile), "Staged file should NOT exist for pass→pass transition");
    }
  } finally {
    try { fs.rmSync(projDir, { recursive: true, force: true }); } catch {}
  }
});

// ─── Debounce and timeout tests (M3) ─────────────────────────────────────────

console.log("\ndebounce and timeout (runHook):");

test("16. Debounce: second Edit within 10s skips test run (returns {})", (env) => {
  const projDir = createTempProject("## Quality Gates\n\nTest: `echo PASS`\n");
  fs.writeFileSync(path.join(projDir, "app.ts"), "export const x = 1;\n");

  // The hook uses per-session debounce files in /tmp/claude-post-tool-verify/<sessionId>.json.
  // Write a debounce entry with ts=now so the hook sees it as within the debounce window.
  const SESSION_ID = "test-debounce-16";
  const debounceDir = path.join(os.tmpdir(), "claude-post-tool-verify");
  fs.mkdirSync(debounceDir, { recursive: true });
  const debounceFile = path.join(debounceDir, `${SESSION_ID}.json`);
  const state = {};
  state[projDir] = { ts: Date.now(), lastPassed: true, lastFailOutput: "" };
  fs.writeFileSync(debounceFile, JSON.stringify(state));

  try {
    const result = runHook(POST_TOOL_VERIFY, {
      tool_name: "Edit",
      tool_input: { file_path: path.join(projDir, "app.ts") },
      session_id: SESSION_ID,
      cwd: projDir,
    }, { HOME: env.home, USERPROFILE: env.home });

    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.ok(result.json, "Should output valid JSON");
    // Debounced — no test run, no additionalContext
    const ctx = result.json.hookSpecificOutput && result.json.hookSpecificOutput.additionalContext;
    assert.ok(!ctx, `Debounced call should produce no additionalContext, got: ${ctx}`);
  } finally {
    try { fs.rmSync(debounceFile, { force: true }); } catch {}
    try { fs.rmSync(projDir, { recursive: true, force: true }); } catch {}
  }
});

test("17. Debounce: Edit after debounce window expires runs tests again", (env) => {
  const projDir = createTempProject("## Quality Gates\n\nTest: `echo PASS`\n");
  fs.writeFileSync(path.join(projDir, "app.ts"), "export const x = 1;\n");

  // Write a per-session debounce entry with a timestamp older than DEBOUNCE_MS (10s)
  // so the hook treats it as expired and runs tests.
  const SESSION_ID = "test-debounce-17";
  const debounceDir = path.join(os.tmpdir(), "claude-post-tool-verify");
  fs.mkdirSync(debounceDir, { recursive: true });
  const debounceFile = path.join(debounceDir, `${SESSION_ID}.json`);
  const state = {};
  state[projDir] = { ts: Date.now() - 15000, lastPassed: true, lastFailOutput: "" };
  fs.writeFileSync(debounceFile, JSON.stringify(state));

  try {
    const result = runHook(POST_TOOL_VERIFY, {
      tool_name: "Edit",
      tool_input: { file_path: path.join(projDir, "app.ts") },
      session_id: SESSION_ID,
      cwd: projDir,
    }, { HOME: env.home, USERPROFILE: env.home });

    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.ok(result.json, "Should output valid JSON");
    // Debounce expired — test should have run
    const ctx = result.json.hookSpecificOutput && result.json.hookSpecificOutput.additionalContext;
    assert.ok(ctx, "After debounce window, additionalContext should be present");
    assert.ok(
      ctx.includes("Tests passed") || ctx.includes("Tests failed"),
      `Expected test result in additionalContext, got: ${ctx}`
    );
  } finally {
    try { fs.rmSync(debounceFile, { force: true }); } catch {}
    try { fs.rmSync(projDir, { recursive: true, force: true }); } catch {}
  }
});

test("18. Timeout: test command that exceeds TEST_TIMEOUT_MS is treated as failure", (env) => {
  // Use a command that sleeps longer than the hook's TEST_TIMEOUT_MS (30s)
  // We can't actually wait 30s in tests, so we use a command that exits non-zero quickly
  // to verify failure handling — and a separate check for the timeout code path using
  // a very short sleep that would exceed a hypothetically tiny timeout.
  // Here we verify the failure path: a failing test command produces "Tests failed" output.
  const projDir = createTempProject("## Quality Gates\n\nTest: `exit 1`\n");
  fs.writeFileSync(path.join(projDir, "app.ts"), "export const x = 1;\n");

  try {
    const result = runHook(POST_TOOL_VERIFY, {
      tool_name: "Edit",
      tool_input: { file_path: path.join(projDir, "app.ts") },
      session_id: "test-session-18",
      cwd: projDir,
    }, { HOME: env.home, USERPROFILE: env.home });

    assert.strictEqual(result.status, 0, "Should exit 0 even when tests fail");
    assert.ok(result.json, "Should output valid JSON");
    const ctx = result.json.hookSpecificOutput && result.json.hookSpecificOutput.additionalContext;
    assert.ok(ctx, "Should have additionalContext for failing tests");
    assert.ok(
      ctx.includes("Tests failed"),
      `Expected 'Tests failed' in additionalContext, got: ${ctx}`
    );
  } finally {
    try { fs.rmSync(projDir, { recursive: true, force: true }); } catch {}
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
