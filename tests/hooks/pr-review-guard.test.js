#!/usr/bin/env node
// Unit tests for templates/hooks/pr-review-guard.js
// Zero dependencies — uses only Node built-ins + test-helpers.
//
// Run: node tests/hooks/pr-review-guard.test.js

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");

const { runHook, createTempHome } = require("./test-helpers");

// Resolve hook path relative to repo root
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const HOOK_PATH = path.join(REPO_ROOT, "templates", "hooks", "pr-review-guard.js");

// ─── extractFunction (local copy — mirrors prompt-injection-guard.test.js) ───

let _extractCounter = 0;
function extractFunction(hookPath, funcName) {
  const src = fs.readFileSync(hookPath, "utf8");

  // Take everything before the stdin handler — all function declarations live there
  const boundary = src.indexOf("process.stdin.resume()");
  const declarations = boundary > 0 ? src.slice(0, boundary) : src;

  const tmpFile = path.join(os.tmpdir(), `hook-extract-${Date.now()}-${_extractCounter++}.js`);
  // Stub out execFileSync and log so extracted functions don't hit real APIs
  const stubbed = `
const { execFileSync: _realExecFileSync } = require("child_process");
let _execSyncMock = null;
function setExecSyncMock(fn) { _execSyncMock = fn; }
const origSrc = ${JSON.stringify(declarations)};
` + declarations
    .replace(/require\("child_process"\)/, '{ execFileSync: (cmd, args, ...rest) => _execSyncMock ? _execSyncMock(cmd, args, ...rest) : _realExecFileSync(cmd, args, ...rest) }')
    .replace(/require\("\.\/log"\)/, '{ writeLog() {} }') +
    `\nmodule.exports = { ${funcName}, setExecSyncMock };\n`;

  fs.writeFileSync(tmpFile, stubbed);

  try {
    const mod = require(tmpFile);
    if (typeof mod[funcName] !== "function") {
      throw new Error(`${funcName} not found or not a function in ${hookPath}`);
    }
    return mod;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

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

function unitTest(name, fn) {
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

// ─── Helper ──────────────────────────────────────────────────────────────────

function runGuard(command, env, extra = {}) {
  // Use a PATH that includes node but not gh (strip dirs containing gh)
  const nodeBin = path.dirname(process.execPath);
  return runHook(HOOK_PATH, {
    tool_name: "Bash",
    tool_input: { command },
    ...extra,
  }, { HOME: env.home, USERPROFILE: env.home, PATH: nodeBin });
}

// ─── Unit tests: isMergeCommand ──────────────────────────────────────────────

console.log("\npr-review-guard.js (isMergeCommand):");

const isMergeExtract = extractFunction(HOOK_PATH, "isMergeCommand");
const isMergeCommand = isMergeExtract.isMergeCommand;

unitTest("U1. 'gh pr merge' -> true", () => {
  assert.strictEqual(isMergeCommand("gh pr merge"), true);
});

unitTest("U2. 'gh pr merge 42' -> true", () => {
  assert.strictEqual(isMergeCommand("gh pr merge 42"), true);
});

unitTest("U3. 'gh pr merge --squash' -> true", () => {
  assert.strictEqual(isMergeCommand("gh pr merge --squash"), true);
});

unitTest("U4. 'gh pr merge https://github.com/org/repo/pull/42' -> true", () => {
  assert.strictEqual(isMergeCommand("gh pr merge https://github.com/org/repo/pull/42"), true);
});

unitTest("U5. chained: 'git push && gh pr merge 42' -> true", () => {
  assert.strictEqual(isMergeCommand("git push && gh pr merge 42"), true);
});

unitTest("U6. 'gh pr create' -> false", () => {
  assert.strictEqual(isMergeCommand("gh pr create"), false);
});

unitTest("U7. 'gh pr view' -> false", () => {
  assert.strictEqual(isMergeCommand("gh pr view"), false);
});

unitTest("U8. 'gh pr list' -> false", () => {
  assert.strictEqual(isMergeCommand("gh pr list"), false);
});

unitTest("U9. null input -> false", () => {
  assert.strictEqual(isMergeCommand(null), false);
});

unitTest("U10. empty string -> false", () => {
  assert.strictEqual(isMergeCommand(""), false);
});

unitTest("U11. 'echo gh pr merge' -> true (best effort, not inside quotes detection)", () => {
  // We accept this as a known limitation — better to over-check than under-check
  assert.strictEqual(isMergeCommand("echo gh pr merge"), true);
});

// ─── Unit tests: extractPrNumber ─────────────────────────────────────────────

console.log("\npr-review-guard.js (extractPrNumber):");

const extractPrMod = extractFunction(HOOK_PATH, "extractPrNumber");
const extractPrNumber = extractPrMod.extractPrNumber;

unitTest("P1. 'gh pr merge 42' -> '42'", () => {
  assert.strictEqual(extractPrNumber("gh pr merge 42"), "42");
});

unitTest("P2. 'gh pr merge 123 --squash' -> '123'", () => {
  assert.strictEqual(extractPrNumber("gh pr merge 123 --squash"), "123");
});

unitTest("P3. 'gh pr merge https://github.com/org/repo/pull/99' -> '99'", () => {
  assert.strictEqual(extractPrNumber("gh pr merge https://github.com/org/repo/pull/99"), "99");
});

unitTest("P4. 'gh pr merge --squash' (no number) -> null", () => {
  assert.strictEqual(extractPrNumber("gh pr merge --squash"), null);
});

unitTest("P5. 'gh pr merge' (bare) -> null", () => {
  assert.strictEqual(extractPrNumber("gh pr merge"), null);
});

unitTest("P6. null input -> null", () => {
  assert.strictEqual(extractPrNumber(null), null);
});

// ─── Unit tests: checkCodeRabbitReview (mocked) ──────────────────────────────

console.log("\npr-review-guard.js (checkCodeRabbitReview - mocked):");

const reviewMod = extractFunction(HOOK_PATH, "checkCodeRabbitReview");
const checkCodeRabbitReview = reviewMod.checkCodeRabbitReview;
const setExecSyncMock = reviewMod.setExecSyncMock;

unitTest("R1. CodeRabbit review found -> reviewed:true", () => {
  setExecSyncMock((cmd, args) => {
    if (args && args.includes("reviews")) return "coderabbitai[bot]\ngithub-actions[bot]\n";
    return "";
  });
  const result = checkCodeRabbitReview("42");
  assert.strictEqual(result.reviewed, true);
  assert.strictEqual(result.error, false);
  setExecSyncMock(null);
});

unitTest("R2. No CodeRabbit review, but CodeRabbit comment -> reviewed:true", () => {
  setExecSyncMock((cmd, args) => {
    if (args && args.includes("reviews")) return "some-human\n";
    if (args && args.includes("comments")) return "coderabbitai[bot]\n";
    return "";
  });
  const result = checkCodeRabbitReview("42");
  assert.strictEqual(result.reviewed, true);
  assert.strictEqual(result.error, false);
  setExecSyncMock(null);
});

unitTest("R3. No CodeRabbit activity at all -> reviewed:false, error:false", () => {
  setExecSyncMock((cmd, args) => {
    if (args && args.includes("reviews")) return "some-human\n";
    if (args && args.includes("comments")) return "some-human\n";
    return "";
  });
  const result = checkCodeRabbitReview("42");
  assert.strictEqual(result.reviewed, false);
  assert.strictEqual(result.error, false);
  assert.ok(result.reason.includes("Wait 2-3 minutes"), `Reason: ${result.reason}`);
  setExecSyncMock(null);
});

unitTest("R4. API error on reviews -> error:true (graceful degradation)", () => {
  setExecSyncMock(() => { throw new Error("gh not found"); });
  const result = checkCodeRabbitReview("42");
  assert.strictEqual(result.reviewed, false);
  assert.strictEqual(result.error, true);
  setExecSyncMock(null);
});

unitTest("R5. Reviews OK but comments API fails -> error:true (graceful degradation)", () => {
  let callCount = 0;
  setExecSyncMock((cmd, args) => {
    callCount++;
    if (callCount === 1) return "some-human\n"; // reviews OK, no coderabbit
    throw new Error("API timeout"); // comments fail
  });
  const result = checkCodeRabbitReview("42");
  assert.strictEqual(result.error, true);
  setExecSyncMock(null);
});

unitTest("R6. Empty review output -> checks comments", () => {
  setExecSyncMock((cmd, args) => {
    if (args && args.includes("reviews")) return "";
    if (args && args.includes("comments")) return "coderabbitai[bot]\n";
    return "";
  });
  const result = checkCodeRabbitReview("42");
  assert.strictEqual(result.reviewed, true);
  setExecSyncMock(null);
});

// ─── Integration tests (subprocess via runHook) ──────────────────────────────

console.log("\npr-review-guard.js (integration tests):");

test("I1. Non-merge command (ls -la) -> allow", (env) => {
  const result = runGuard("ls -la", env);

  assert.strictEqual(result.status, 0);
  assert.ok(result.json, "Should output valid JSON");
  assert.strictEqual(result.json.hookSpecificOutput, undefined);
});

test("I2. Non-Bash tool (Read) -> allow", (env) => {
  const result = runHook(HOOK_PATH, {
    tool_name: "Read",
    tool_input: { file_path: "/tmp/test.txt" },
  }, { HOME: env.home, USERPROFILE: env.home });

  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.json.hookSpecificOutput, undefined);
});

test("I3. gh pr create -> allow (not a merge)", (env) => {
  const result = runGuard("gh pr create --title test", env);

  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.json.hookSpecificOutput, undefined);
});

test("I4. gh pr merge with no gh on PATH -> allow (graceful degradation)", (env) => {
  // PATH="" in runGuard ensures gh is not found
  const result = runGuard("gh pr merge 42", env);

  assert.strictEqual(result.status, 0);
  // Should allow because gh API call fails → graceful degradation
  const decision = result.json.hookSpecificOutput?.permissionDecision;
  assert.ok(!decision || decision !== "deny", "Should not deny when gh is unavailable");
});

test("I5. Subagent context (agent_id set) -> allow without check", (env) => {
  const result = runGuard("gh pr merge 42", env, { agent_id: "sub-123" });

  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.json.hookSpecificOutput, undefined);
});

test("I6. Malformed JSON input -> exits 0 (never crash)", (env) => {
  const result = runHook(HOOK_PATH, "not valid json", { HOME: env.home, USERPROFILE: env.home });

  assert.strictEqual(result.status, 0);
  assert.ok(result.json, "Should still output JSON");
  assert.strictEqual(result.json.hookSpecificOutput, undefined);
});

test("I7. gh pr view -> allow (not a merge)", (env) => {
  const result = runGuard("gh pr view 42 --json reviews", env);

  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.json.hookSpecificOutput, undefined);
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
