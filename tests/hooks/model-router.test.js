#!/usr/bin/env node
// Integration tests for model-router.js (PreToolUse hook).
// Zero dependencies — uses only Node built-ins + local test-helpers.
//
// Run: node tests/hooks/model-router.test.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { runHook, createTempHome, todayLocal } = require("./test-helpers");

// Resolve hook path relative to repo root
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const MODEL_ROUTER = path.join(REPO_ROOT, "templates", "hooks", "model-router.js");

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

// ─── Helper ──────────────────────────────────────────────────────────────────

function runRouter(toolInput, env) {
  return runHook(MODEL_ROUTER, {
    tool_name: "Task",
    tool_input: toolInput,
  }, { HOME: env.home, USERPROFILE: env.home });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

console.log("\nmodel-router.js:");

test("1. Explore subagent_type -> haiku", (env) => {
  const result = runRouter({
    subagent_type: "Explore",
    prompt: "Find all TypeScript files in the project",
  }, env);

  assert.strictEqual(result.status, 0);
  assert.ok(result.json, "Should output valid JSON");
  assert.strictEqual(result.json.decision, undefined);
  assert.strictEqual(result.json.hookSpecificOutput.updatedInput.model, "haiku");
  assert.ok(result.json.hookSpecificOutput.additionalContext.includes("haiku"));
});

test("2. claude-code-guide subagent_type -> haiku", (env) => {
  const result = runRouter({
    subagent_type: "claude-code-guide",
    prompt: "How do I configure MCP servers?",
  }, env);

  assert.strictEqual(result.json.hookSpecificOutput.updatedInput.model, "haiku");
});

test("3. Prompt with only search keywords -> haiku", (env) => {
  const result = runRouter({
    subagent_type: "general-purpose",
    prompt: "Search the codebase and find all API endpoint definitions. List them.",
  }, env);

  assert.strictEqual(result.json.hookSpecificOutput.updatedInput.model, "haiku");
  assert.ok(result.json.hookSpecificOutput.additionalContext.includes("read-only"));
});

test("4. Prompt with write keywords -> sonnet", (env) => {
  const result = runRouter({
    subagent_type: "general-purpose",
    prompt: "Implement a new utility function that validates email addresses. Write tests.",
  }, env);

  assert.strictEqual(result.json.hookSpecificOutput.updatedInput.model, "sonnet");
  assert.ok(result.json.hookSpecificOutput.additionalContext.includes("sonnet"));
});

test("5. Prompt with architecture keywords -> opus", (env) => {
  const result = runRouter({
    subagent_type: "general-purpose",
    prompt: "Debug the root cause of the authentication failure across multiple files. Investigate the architectural issue.",
  }, env);

  assert.strictEqual(result.json.hookSpecificOutput.updatedInput.model, "opus");
  assert.ok(result.json.hookSpecificOutput.additionalContext.includes("opus"));
});

test("6. Explicit model set -> no override", (env) => {
  const result = runRouter({
    subagent_type: "general-purpose",
    model: "haiku",
    prompt: "Design the architecture for the new auth system",
  }, env);

  assert.strictEqual(result.json.decision, undefined);
  assert.strictEqual(result.json.hookSpecificOutput, undefined, "Should not set hookSpecificOutput when model is explicit");
});

test("7. Mixed signals (search + write) -> sonnet (conservative)", (env) => {
  const result = runRouter({
    subagent_type: "general-purpose",
    prompt: "Search for the validation logic and fix the bug in the email parser",
  }, env);

  assert.strictEqual(result.json.hookSpecificOutput.updatedInput.model, "sonnet");
});

test("8. Mixed signals (search + architecture) -> opus (highest wins)", (env) => {
  const result = runRouter({
    subagent_type: "general-purpose",
    prompt: "Find the database queries and debug the root cause of the performance issue",
  }, env);

  assert.strictEqual(result.json.hookSpecificOutput.updatedInput.model, "opus");
});

test("9. No model, no clear signals -> sonnet (safe default)", (env) => {
  const result = runRouter({
    subagent_type: "general-purpose",
    prompt: "Process the data according to the specifications",
  }, env);

  assert.strictEqual(result.json.hookSpecificOutput.updatedInput.model, "sonnet");
  assert.ok(result.json.hookSpecificOutput.additionalContext.includes("safe default"));
});

test("10. Non-Task tool -> allow without changes", (env) => {
  const result = runHook(MODEL_ROUTER, {
    tool_name: "Bash",
    tool_input: { command: "ls" },
  }, { HOME: env.home, USERPROFILE: env.home });

  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.json.decision, undefined);
  assert.strictEqual(result.json.hookSpecificOutput, undefined);
});

test("11. Empty prompt -> sonnet (safe default)", (env) => {
  const result = runRouter({
    subagent_type: "general-purpose",
    prompt: "",
  }, env);

  assert.strictEqual(result.json.hookSpecificOutput.updatedInput.model, "sonnet");
});

test("12. Malformed JSON input -> exits 0 with {}", (env) => {
  const result = runHook(MODEL_ROUTER, "not valid json", { HOME: env.home, USERPROFILE: env.home });

  assert.strictEqual(result.status, 0);
  assert.ok(result.json, "Should still output JSON");
  assert.deepStrictEqual(result.json, {});
});

test("13. Agent tool name -> intercepted like Task", (env) => {
  const result = runHook(MODEL_ROUTER, {
    tool_name: "Agent",
    tool_input: {
      subagent_type: "general-purpose",
      prompt: "Find all TypeScript files in the project",
    },
  }, { HOME: env.home, USERPROFILE: env.home });

  assert.strictEqual(result.status, 0);
  assert.ok(result.json.hookSpecificOutput, "Should produce hookSpecificOutput for Agent tool");
  assert.ok(result.json.hookSpecificOutput.updatedInput.model, "Should inject a model");
});

test("14. allowed-tools >10 items (array) -> tool count advisory", (env) => {
  const manyTools = ["Bash","Read","Write","Edit","Glob","Grep","Task","WebFetch","WebSearch","Bash2","ExtraOne"];
  assert.ok(manyTools.length > 10, "Fixture must have >10 tools");

  const result = runRouter({
    subagent_type: "general-purpose",
    prompt: "Search the codebase for API definitions",
    "allowed-tools": manyTools,
  }, env);

  assert.ok(result.json.hookSpecificOutput, "Should have hookSpecificOutput");
  const ctx = result.json.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes("tool selection degrades above 10 tools"), `Advisory missing. Got: ${ctx}`);
  assert.ok(ctx.includes(`found ${manyTools.length}`), `Count missing. Got: ${ctx}`);
});

test("15. allowed-tools ≤10 items (string) -> no tool count advisory", (env) => {
  const fewTools = "Bash,Read,Write,Edit,Glob";
  const result = runRouter({
    subagent_type: "general-purpose",
    prompt: "Search the codebase for API definitions",
    "allowed-tools": fewTools,
  }, env);

  assert.ok(result.json.hookSpecificOutput, "Should have hookSpecificOutput");
  const ctx = result.json.hookSpecificOutput.additionalContext;
  assert.ok(!ctx.includes("tool selection degrades"), `Unexpected advisory present. Got: ${ctx}`);
});

test("16. Route event writes JSONL log entry", (env) => {
  const result = runRouter({
    subagent_type: "Explore",
    prompt: "Find all TypeScript files",
  }, env);

  assert.strictEqual(result.json.hookSpecificOutput.updatedInput.model, "haiku");

  const logDir = path.join(env.home, ".claude", "logs");
  const today = todayLocal();
  const logFile = path.join(logDir, `${today}.jsonl`);
  assert.ok(fs.existsSync(logFile), "Log file should exist");
  const lines = fs.readFileSync(logFile, "utf8").trim().split("\n");
  const entries = lines.map(l => JSON.parse(l)).filter(e => e.hook === "model-router");
  assert.ok(entries.length > 0, "Should have model-router log entry");
  assert.strictEqual(entries[0].event, "route");
  assert.ok(entries[0].details.includes("haiku"), `Details: ${entries[0].details}`);
  assert.ok(entries[0].context.model === "haiku");
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
