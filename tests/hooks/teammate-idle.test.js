#!/usr/bin/env node
// Integration and unit tests for teammate-idle.js (TeammateIdle hook).
// Zero dependencies — uses only Node built-ins + local test-helpers.
//
// Run: node tests/hooks/teammate-idle.test.js

"use strict";

const assert = require("assert");
const path = require("path");

const { runHook, runHookRaw } = require("./test-helpers");

const HOOK_PATH = path.join(__dirname, "..", "..", "templates", "hooks", "teammate-idle.js");

const { processHookInput } = require(HOOK_PATH);

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

// ─── Tests ───────────────────────────────────────────────────────────────────

console.log("\nteammate-idle.js:");

// ── Unit tests ────────────────────────────────────────────────────────────────

test("processHookInput returns exit code 2 for teammate", () => {
  const result = processHookInput({ agent_id: "agent-123" });
  assert.strictEqual(result.exitCode, 2);
});

test("processHookInput returns nudge message for teammate", () => {
  const result = processHookInput({ agent_id: "agent-123" });
  assert.ok(result.output.hookSpecificOutput, "Should have hookSpecificOutput");
  const ctx = result.output.hookSpecificOutput.additionalContext;
  assert.ok(typeof ctx === "string" && ctx.length > 0, "additionalContext should be a non-empty string");
  assert.ok(ctx.includes("TaskList"), "Nudge message should mention TaskList");
});

test("processHookInput returns exit code 0 for main agent", () => {
  const result = processHookInput({});
  assert.strictEqual(result.exitCode, 0);
});

test("processHookInput returns {} output for main agent", () => {
  const result = processHookInput({});
  assert.deepStrictEqual(result.output, {});
});

test("processHookInput handles null input", () => {
  const result = processHookInput(null);
  assert.strictEqual(result.exitCode, 0);
  assert.deepStrictEqual(result.output, {});
});

// ── Integration tests ─────────────────────────────────────────────────────────

test("exits with code 2 for teammate input", () => {
  const result = runHook(HOOK_PATH, { agent_id: "test-agent" });
  assert.strictEqual(result.status, 2, `Expected exit code 2, got ${result.status}`);
  assert.ok(result.json.hookSpecificOutput, "Should have hookSpecificOutput");
  assert.ok(
    result.json.hookSpecificOutput.additionalContext.includes("TaskList"),
    "Should include TaskList nudge"
  );
});

test("exits with code 0 for main agent input", () => {
  const result = runHook(HOOK_PATH, {});
  assert.strictEqual(result.status, 0, `Expected exit code 0, got ${result.status}`);
  assert.deepStrictEqual(result.json, {});
});

test("handles malformed JSON gracefully", () => {
  const result = runHookRaw(HOOK_PATH, "not json");
  assert.strictEqual(result.status, 0, "Should exit 0 on malformed input");
  assert.deepStrictEqual(result.json, {}, "Should return {}");
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
