#!/usr/bin/env node
/**
 * Tests for orphan-file-guard.js PreToolUse hook.
 * Validates: orphan detection, exempt paths, existing file bypass, reference detection.
 */

"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { runHook } = require("./test-helpers");

const HOOK = path.resolve(__dirname, "../../templates/hooks/orphan-file-guard.js");
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

// Helper: create a temp project directory
function createTempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orphan-test-"));
  return {
    dir,
    cleanup() {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

console.log("orphan-file-guard.js tests:");

// --- Test: non-Write tools pass through ---
test("non-Write tools pass through", () => {
  const result = runHook(HOOK, {
    tool_name: "Read",
    tool_input: { file_path: "/tmp/nonexistent.js" },
    cwd: "/tmp",
  });
  assert.strictEqual(result.status, 0);
  assert.deepStrictEqual(result.json, {});
});

// --- Test: existing files pass through (overwrites are fine) ---
test("existing files pass through", () => {
  const proj = createTempProject();
  const existing = path.join(proj.dir, "existing.js");
  fs.writeFileSync(existing, "// existing");

  const result = runHook(HOOK, {
    tool_name: "Write",
    tool_input: { file_path: existing, content: "// updated" },
    cwd: proj.dir,
  });
  assert.strictEqual(result.status, 0);
  assert.deepStrictEqual(result.json, {});
  proj.cleanup();
});

// --- Test: exempt basenames pass through ---
test("exempt basenames pass through", () => {
  const proj = createTempProject();
  const exemptFiles = [
    ".gitignore", "package.json", "README.md", "CLAUDE.md",
    "Dockerfile", "LICENSE", "MEMORY.md",
  ];

  for (const name of exemptFiles) {
    const result = runHook(HOOK, {
      tool_name: "Write",
      tool_input: { file_path: path.join(proj.dir, name), content: "content" },
      cwd: proj.dir,
    });
    assert.deepStrictEqual(result.json, {}, `${name} should be exempt`);
  }
  proj.cleanup();
});

// --- Test: .env variants are exempt ---
test(".env variants are exempt", () => {
  const proj = createTempProject();
  for (const name of [".env", ".env.local", ".env.production"]) {
    const result = runHook(HOOK, {
      tool_name: "Write",
      tool_input: { file_path: path.join(proj.dir, name), content: "X=1" },
      cwd: proj.dir,
    });
    assert.deepStrictEqual(result.json, {}, `${name} should be exempt`);
  }
  proj.cleanup();
});

// --- Test: files under .claude/ are exempt ---
test("files under .claude/ are exempt", () => {
  const proj = createTempProject();
  const claudeDir = path.join(proj.dir, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });

  const result = runHook(HOOK, {
    tool_name: "Write",
    tool_input: { file_path: path.join(claudeDir, "some-config.json"), content: "{}" },
    cwd: proj.dir,
  });
  assert.deepStrictEqual(result.json, {});
  proj.cleanup();
});

// --- Test: files under tests/ are exempt ---
test("files under tests/ are exempt", () => {
  const proj = createTempProject();
  const testsDir = path.join(proj.dir, "tests", "hooks");
  fs.mkdirSync(testsDir, { recursive: true });

  const result = runHook(HOOK, {
    tool_name: "Write",
    tool_input: { file_path: path.join(testsDir, "new-hook.test.js"), content: "// test" },
    cwd: proj.dir,
  });
  assert.deepStrictEqual(result.json, {});

  // Also test tests/fixtures/
  const fixtureDir = path.join(proj.dir, "tests", "fixtures");
  fs.mkdirSync(fixtureDir, { recursive: true });
  const r2 = runHook(HOOK, {
    tool_name: "Write",
    tool_input: { file_path: path.join(fixtureDir, "sample.json"), content: "{}" },
    cwd: proj.dir,
  });
  assert.deepStrictEqual(r2.json, {});
  proj.cleanup();
});

// --- Test: new unreferenced file is blocked ---
test("new unreferenced file is blocked", () => {
  const proj = createTempProject();
  // Create one existing file that does NOT reference the new file
  fs.writeFileSync(path.join(proj.dir, "index.js"), "console.log('hello');\n");

  const result = runHook(HOOK, {
    tool_name: "Write",
    tool_input: { file_path: path.join(proj.dir, "orphan-utils.js"), content: "// orphan" },
    cwd: proj.dir,
  });
  assert.ok(result.json.hookSpecificOutput, "should have hookSpecificOutput");
  assert.strictEqual(result.json.hookSpecificOutput.permissionDecision, "deny");
  assert.ok(result.json.hookSpecificOutput.permissionDecisionReason.includes("not referenced"));
  proj.cleanup();
});

// --- Test: new referenced file is allowed ---
test("new referenced file is allowed", () => {
  const proj = createTempProject();
  // Create a file that references the new file
  fs.writeFileSync(
    path.join(proj.dir, "index.js"),
    'const utils = require("./my-helper.js");\n'
  );

  const result = runHook(HOOK, {
    tool_name: "Write",
    tool_input: { file_path: path.join(proj.dir, "my-helper.js"), content: "module.exports = {};" },
    cwd: proj.dir,
  });
  assert.deepStrictEqual(result.json, {});
  proj.cleanup();
});

// --- Test: reference in markdown counts ---
test("reference in markdown counts", () => {
  const proj = createTempProject();
  fs.writeFileSync(
    path.join(proj.dir, "docs.md"),
    "See [the diagram](architecture.svg) for details.\n"
  );

  const result = runHook(HOOK, {
    tool_name: "Write",
    tool_input: { file_path: path.join(proj.dir, "architecture.svg"), content: "<svg/>" },
    cwd: proj.dir,
  });
  assert.deepStrictEqual(result.json, {});
  proj.cleanup();
});

// --- Test: isExempt function ---
test("isExempt correctly identifies exempt paths", () => {
  const { isExempt } = require("../../templates/hooks/orphan-file-guard");
  assert.ok(isExempt(".gitignore"));
  assert.ok(isExempt("package.json"));
  assert.ok(isExempt("/some/path/.claude/config.json"));
  assert.ok(isExempt("/some/path/node_modules/pkg/index.js"));
  assert.ok(isExempt("/some/path/tests/fixtures/data.json"));
  assert.ok(isExempt("/some/path/tests/hooks/new-hook.test.js"));
  assert.ok(!isExempt("/some/path/src/utils.js"));
  assert.ok(!isExempt("/some/path/new-feature.ts"));
});

// --- Test: malformed JSON produces empty output ---
test("malformed JSON produces empty output", () => {
  const { runHookRaw } = require("./test-helpers");
  const result = runHookRaw(HOOK, "not json at all");
  assert.strictEqual(result.status, 0);
  assert.deepStrictEqual(result.json, {});
});

// --- Test: missing file_path passes through ---
test("missing file_path passes through", () => {
  const result = runHook(HOOK, {
    tool_name: "Write",
    tool_input: { content: "data" },
    cwd: "/tmp",
  });
  assert.deepStrictEqual(result.json, {});
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
