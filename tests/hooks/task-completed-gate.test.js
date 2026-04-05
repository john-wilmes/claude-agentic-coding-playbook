#!/usr/bin/env node
// Integration tests for task-completed-gate.js (TaskCompleted quality gate hook).
// Zero dependencies — uses only Node built-ins + local test-helpers.
//
// Run: node tests/hooks/task-completed-gate.test.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { runHook, runHookRaw } = require("./test-helpers");

// Resolve hook path relative to repo root
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const HOOK = path.join(REPO_ROOT, "templates", "hooks", "task-completed-gate.js");

// Import pure functions for unit tests
const { extractTestCommand, runTests } = require(HOOK);

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

// ─── Unit tests: extractTestCommand ──────────────────────────────────────────

console.log("\ntask-completed-gate.js:");

test("1. extractTestCommand: finds test command from CLAUDE.md (Test: `npm test`)", () => {
  const content = `# Project\n\n## Quality Gates\n\n- Test: \`npm test\`\n`;
  const cmd = extractTestCommand(content);
  assert.strictEqual(cmd, "npm test");
});

test("2. extractTestCommand: finds test command with lowercase key (test: `pytest`)", () => {
  const content = `## Gates\n\n- test: \`pytest -x\`\n`;
  const cmd = extractTestCommand(content);
  assert.strictEqual(cmd, "pytest -x");
});

test("3. extractTestCommand: finds multiword test command", () => {
  const content = `- Test: \`for t in tests/*.test.js; do node "$t"; done\`\n`;
  const cmd = extractTestCommand(content);
  assert.strictEqual(cmd, 'for t in tests/*.test.js; do node "$t"; done');
});

test("4. extractTestCommand: returns null when no test command", () => {
  const content = `# Project\n\n## Quality Gates\n\n- Lint: \`eslint src/\`\n`;
  const cmd = extractTestCommand(content);
  assert.strictEqual(cmd, null);
});

test("5. extractTestCommand: returns null for empty content", () => {
  const cmd = extractTestCommand("");
  assert.strictEqual(cmd, null);
});

// ─── Unit tests: runTests ─────────────────────────────────────────────────────

test("6. runTests: returns { passed: true } for a successful command", () => {
  const result = runTests("true", os.tmpdir());
  assert.deepStrictEqual(result, { passed: true, output: "" });
});

test("7. runTests: returns { passed: false, output: ... } for a failing command", () => {
  const result = runTests("exit 1", os.tmpdir());
  assert.strictEqual(result.passed, false);
  assert.ok(typeof result.output === "string", "output should be a string");
});

test("8. runTests: returns { passed: false } for a non-zero exit command", () => {
  const result = runTests("false", os.tmpdir());
  assert.strictEqual(result.passed, false);
});

// ─── Integration tests ───────────────────────────────────────────────────────

test("9. Hook outputs {} when no agent_id in input (main agent — not gated)", () => {
  const result = runHook(HOOK, { session_id: "s1", cwd: os.tmpdir() });
  assert.strictEqual(result.status, 0, "Should exit 0");
  assert.ok(result.json, "Should output valid JSON");
  assert.deepStrictEqual(result.json, {}, "Should output {} for main agent");
});

test("10. Hook outputs {} when CLAUDE.md does not exist", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-test-no-claude-"));
  try {
    const result = runHook(HOOK, {
      session_id: "s2",
      agent_id: "agent-abc",
      cwd: tmpDir,
    });
    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.deepStrictEqual(result.json, {}, "Should output {} when no CLAUDE.md");
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test("11. Hook outputs {} when CLAUDE.md has no test command", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-test-no-cmd-"));
  try {
    fs.writeFileSync(
      path.join(tmpDir, "CLAUDE.md"),
      "# Project\n\n## Quality Gates\n\n- Lint: `eslint src/`\n"
    );
    const result = runHook(HOOK, {
      session_id: "s3",
      agent_id: "agent-abc",
      cwd: tmpDir,
    });
    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.deepStrictEqual(result.json, {}, "Should output {} when no test command");
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test("12. Hook exits 0 with feedback when tests fail", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-test-fail-"));
  try {
    fs.writeFileSync(
      path.join(tmpDir, "CLAUDE.md"),
      "# Project\n\n## Quality Gates\n\n- Test: `exit 1`\n"
    );
    const result = runHook(HOOK, {
      session_id: "s4",
      agent_id: "agent-abc",
      cwd: tmpDir,
    });
    assert.strictEqual(result.status, 0, "Should exit 0 when tests fail (exit 0 always)");
    assert.ok(result.json, "Should output valid JSON");
    assert.ok(result.json.hookSpecificOutput, "Should have hookSpecificOutput");
    assert.ok(
      result.json.hookSpecificOutput.additionalContext.includes("Tests failed"),
      `Should mention test failure, got: ${result.json.hookSpecificOutput.additionalContext}`
    );
    assert.strictEqual(
      result.json.hookSpecificOutput.hookEventName,
      "TaskCompleted",
      `hookEventName should be "TaskCompleted", got: ${result.json.hookSpecificOutput.hookEventName}`
    );
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test("13. Hook exits 0 when tests pass", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-test-pass-"));
  try {
    fs.writeFileSync(
      path.join(tmpDir, "CLAUDE.md"),
      "# Project\n\n## Quality Gates\n\n- Test: `true`\n"
    );
    const result = runHook(HOOK, {
      session_id: "s5",
      agent_id: "agent-abc",
      cwd: tmpDir,
    });
    assert.strictEqual(result.status, 0, "Should exit 0 when tests pass");
    assert.deepStrictEqual(result.json, {}, "Should output {} when tests pass");
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test("14b. Hook exits 0 with feedback when test command is rejected (dangerous pattern)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-test-reject-"));
  try {
    fs.writeFileSync(
      path.join(tmpDir, "CLAUDE.md"),
      "# Project\n\n## Quality Gates\n\n- Test: `eval echo pwned`\n"
    );
    const result = runHook(HOOK, {
      session_id: "s6",
      agent_id: "agent-abc",
      cwd: tmpDir,
    });
    assert.strictEqual(result.status, 0, "Should exit 0 when command is rejected");
    assert.ok(result.json, "Should output valid JSON");
    assert.ok(result.json.hookSpecificOutput, "Should have hookSpecificOutput");
    assert.ok(
      result.json.hookSpecificOutput.additionalContext.includes("rejected"),
      `Should mention rejection, got: ${result.json.hookSpecificOutput.additionalContext}`
    );
    assert.strictEqual(
      result.json.hookSpecificOutput.hookEventName,
      "TaskCompleted",
      `hookEventName should be "TaskCompleted", got: ${result.json.hookSpecificOutput.hookEventName}`
    );
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test("14. Hook exits 0 with {} on malformed JSON input", () => {
  const result = runHookRaw(HOOK, "not valid json");
  assert.strictEqual(result.status, 0, "Should exit 0 on parse error");
  assert.deepStrictEqual(result.json, {}, "Should output {} on parse error");
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
