#!/usr/bin/env node
// Tests for skip-comment-guard.js — warns when .skip added without documenting comment.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { runHook, runHookRaw } = require("./test-helpers");

const HOOK_PATH = path.resolve(__dirname, "../../templates/hooks/skip-comment-guard.js");

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

console.log("skip-comment-guard.js:");

// Test 1: non-Edit/Write tool → no output
test("1. non-Edit/Write tool returns empty", () => {
  const result = runHook(HOOK_PATH, {
    tool_name: "Bash",
    tool_input: { command: "echo hello" },
  });
  assert.strictEqual(result.status, 0);
  assert.ok(!result.json || !result.json.hookSpecificOutput, "Should not have hookSpecificOutput");
});

// Test 2: Edit on non-test file → no output
test("2. Edit on non-test file returns empty", () => {
  const result = runHook(HOOK_PATH, {
    tool_name: "Edit",
    tool_input: {
      file_path: "/src/utils.js",
      new_string: "it.skip('broken', () => {});",
    },
  });
  assert.strictEqual(result.status, 0);
  assert.ok(!result.json || !result.json.hookSpecificOutput, "Should not have hookSpecificOutput");
});

// Test 3: Edit test file with .skip and no comment → warns
test("3. .skip without comment warns", () => {
  const result = runHook(HOOK_PATH, {
    tool_name: "Edit",
    tool_input: {
      file_path: "/tests/unit/auth.test.js",
      new_string: "  it.skip('handles expired tokens', () => {\n    expect(true).toBe(true);\n  });",
    },
  });
  assert.strictEqual(result.status, 0);
  assert.ok(result.json, "Should return JSON output");
  const ctx = result.json.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes(".skip"), "Warning should mention .skip");
  assert.ok(ctx.includes("root cause"), "Warning should mention documenting root cause");
});

// Test 4: Edit test file with .skip and inline comment → no warning
test("4. .skip with inline comment returns empty", () => {
  const result = runHook(HOOK_PATH, {
    tool_name: "Edit",
    tool_input: {
      file_path: "/tests/auth.test.js",
      new_string: "  it.skip('handles expired tokens', () => { // skip: flaky on CI #123",
    },
  });
  assert.strictEqual(result.status, 0);
  assert.ok(!result.json || !result.json.hookSpecificOutput, "Should not have hookSpecificOutput");
});

// Test 5: .skip with comment on preceding line → no warning
test("5. .skip with comment on preceding line returns empty", () => {
  const result = runHook(HOOK_PATH, {
    tool_name: "Edit",
    tool_input: {
      file_path: "/tests/auth.test.js",
      new_string: "  // skip: depends on external service that is flaky\n  it.skip('calls external API', () => {",
    },
  });
  assert.strictEqual(result.status, 0);
  assert.ok(!result.json || !result.json.hookSpecificOutput, "Should not have hookSpecificOutput");
});

// Test 6: Write tool with .skip in test file → warns
test("6. Write with .skip warns", () => {
  const result = runHook(HOOK_PATH, {
    tool_name: "Write",
    tool_input: {
      file_path: "/tests/payment.spec.ts",
      content: "describe('payments', () => {\n  test.skip('refund flow', () => {\n    expect(true).toBe(true);\n  });\n});",
    },
  });
  assert.strictEqual(result.status, 0);
  assert.ok(result.json, "Should warn on Write too");
  assert.ok(result.json.hookSpecificOutput.additionalContext.includes(".skip"));
});

// Test 7: describe.skip → warns
test("7. describe.skip without comment warns", () => {
  const result = runHook(HOOK_PATH, {
    tool_name: "Edit",
    tool_input: {
      file_path: "/tests/suite.test.js",
      new_string: "describe.skip('old suite', () => {",
    },
  });
  assert.strictEqual(result.status, 0);
  assert.ok(result.json, "Should warn for describe.skip");
});

// Test 8: xit (xdescribe/xtest) → warns
test("8. xit without comment warns", () => {
  const result = runHook(HOOK_PATH, {
    tool_name: "Edit",
    tool_input: {
      file_path: "/tests/legacy.test.js",
      new_string: "xit('old behavior', () => {",
    },
  });
  assert.strictEqual(result.status, 0);
  assert.ok(result.json, "Should warn for xit");
});

// Test 9: no .skip in content → no warning
test("9. no .skip in content returns empty", () => {
  const result = runHook(HOOK_PATH, {
    tool_name: "Edit",
    tool_input: {
      file_path: "/tests/basic.test.js",
      new_string: "it('works fine', () => {\n  expect(1 + 1).toBe(2);\n});",
    },
  });
  assert.strictEqual(result.status, 0);
  assert.ok(!result.json || !result.json.hookSpecificOutput, "Should not have hookSpecificOutput");
});

// Test 10: malformed JSON → exits 0
test("10. malformed JSON exits 0 gracefully", () => {
  const result = runHookRaw(HOOK_PATH, "{{{{not json");
  assert.strictEqual(result.status, 0);
});

// Test 11: isTestFile detects various test file patterns
test("11. isTestFile detects various patterns", () => {
  const mod = require("../../templates/hooks/skip-comment-guard");
  assert.ok(mod.isTestFile("/src/foo.test.js"));
  assert.ok(mod.isTestFile("/src/foo.spec.ts"));
  assert.ok(mod.isTestFile("/tests/unit/bar.js"));
  assert.ok(mod.isTestFile("/__tests__/baz.tsx"));
  assert.ok(!mod.isTestFile("/src/utils.js"));
  assert.ok(!mod.isTestFile("/lib/helpers.ts"));
  assert.ok(!mod.isTestFile(""));
  assert.ok(!mod.isTestFile(null));
});

// Test 12: multiple skips, only undocumented ones warned
test("12. only undocumented skips are warned", () => {
  const result = runHook(HOOK_PATH, {
    tool_name: "Edit",
    tool_input: {
      file_path: "/tests/mixed.test.js",
      new_string: [
        "// skip: known flaky",
        "it.skip('documented', () => {});",
        "it.skip('undocumented', () => {});",
        "test.skip('also undocumented', () => {});",
      ].join("\n"),
    },
  });
  assert.strictEqual(result.status, 0);
  assert.ok(result.json, "Should warn about undocumented skips");
  const ctx = result.json.hookSpecificOutput.additionalContext;
  // Should mention lines 3 and 4 (the undocumented ones), not line 2
  assert.ok(ctx.includes("undocumented"), "Should include the undocumented skip text");
  assert.ok(!ctx.includes("Line 2"), "Should NOT warn about line 2 (documented skip)");
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
