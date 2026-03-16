#!/usr/bin/env node
// Integration tests for templates/hooks/md-size-guard.js
// Zero dependencies — uses only Node built-ins + test-helpers.
//
// Run: node tests/hooks/md-size-guard.test.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

const { createTempHome, createMemoryFile } = require("./test-helpers");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const HOOK_PATH = path.join(REPO_ROOT, "templates", "hooks", "md-size-guard.js");

// ─── Test runner ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  const env = createTempHome();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-proj-"));
  try {
    fn(env, projectDir);
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message });
    console.log(`  \u2717 ${name}`);
    console.log(`    ${err.message}`);
  } finally {
    env.cleanup();
    try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch {}
  }
}

// ─── Helper: run hook with controlled HOME and cwd ───────────────────────────

function runGuardHook(stdinJson, { home, cwd } = {}) {
  // Inject cwd into the event JSON so the hook receives it as input.cwd
  const eventJson = cwd ? { cwd, ...stdinJson } : stdinJson;
  const result = spawnSync("node", [HOOK_PATH], {
    input: JSON.stringify(eventJson),
    env: { ...process.env, CLAUDE_HOOK_SOURCE: "test", HOME: home },
    cwd: cwd || process.cwd(),
    timeout: 10000,
    encoding: "utf8",
  });

  let json = null;
  try {
    if (result.stdout && result.stdout.trim()) {
      json = JSON.parse(result.stdout.trim());
    }
  } catch {}

  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    json,
  };
}

function runGuardHookRaw(rawStdin, { home, cwd } = {}) {
  const result = spawnSync("node", [HOOK_PATH], {
    input: rawStdin,
    env: { ...process.env, CLAUDE_HOOK_SOURCE: "test", HOME: home },
    cwd: cwd || process.cwd(),
    timeout: 10000,
    encoding: "utf8",
  });

  let json = null;
  try {
    if (result.stdout && result.stdout.trim()) {
      json = JSON.parse(result.stdout.trim());
    }
  } catch {}

  return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "", json };
}

/**
 * Generate N lines of content.
 */
function genLines(n, prefix = "line") {
  return Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n") + "\n";
}

// ─── Tests ───────────────────────────────────────────────────────────────────

console.log("\nmd-size-guard.test.js");

test("1. Non-Edit/Write tool → empty JSON", (env, cwd) => {
  const result = runGuardHook(
    { tool_name: "Read", tool_input: { file_path: "/some/file.md" } },
    { home: env.home, cwd },
  );
  assert.strictEqual(result.status, 0);
  assert.deepStrictEqual(result.json, {});
});

test("2. Edit on non-MEMORY.md file → empty JSON", (env, cwd) => {
  const result = runGuardHook(
    { tool_name: "Edit", tool_input: { file_path: "/some/other/file.md" } },
    { home: env.home, cwd },
  );
  assert.strictEqual(result.status, 0);
  assert.deepStrictEqual(result.json, {});
});

test("3. MEMORY.md within limit (100 lines) → empty JSON, file unchanged", (env, cwd) => {
  const content = genLines(100);
  const memPath = createMemoryFile(env.home, cwd, content);

  const result = runGuardHook(
    { tool_name: "Write", tool_input: { file_path: memPath } },
    { home: env.home, cwd },
  );
  assert.strictEqual(result.status, 0);
  assert.deepStrictEqual(result.json, {});
  assert.strictEqual(fs.readFileSync(memPath, "utf8"), content);
});

test("4. MEMORY.md at exactly 150 lines → no overflow", (env, cwd) => {
  const content = genLines(150);
  const memPath = createMemoryFile(env.home, cwd, content);

  const result = runGuardHook(
    { tool_name: "Edit", tool_input: { file_path: memPath } },
    { home: env.home, cwd },
  );
  assert.strictEqual(result.status, 0);
  assert.deepStrictEqual(result.json, {});

  // No overflow files created
  const memDir = path.dirname(memPath);
  const overflows = fs.readdirSync(memDir).filter(f => f.startsWith("overflow-"));
  assert.strictEqual(overflows.length, 0);
});

test("5. MEMORY.md at 200 lines → overflow created, truncated to 150", (env, cwd) => {
  const content = genLines(200);
  const memPath = createMemoryFile(env.home, cwd, content);

  const result = runGuardHook(
    { tool_name: "Write", tool_input: { file_path: memPath } },
    { home: env.home, cwd },
  );
  assert.strictEqual(result.status, 0);
  const ctx = result.json.additionalContext;
  assert.ok(ctx, "should return additionalContext");
  assert.ok(ctx.includes("exceeded 150 lines"), "message mentions limit");
  assert.ok(ctx.includes("was 200"), "message mentions original count");

  // MEMORY.md truncated to 150 lines
  const truncated = fs.readFileSync(memPath, "utf8");
  assert.strictEqual(truncated.trimEnd().split("\n").length, 150);
  assert.ok(truncated.includes("line 1"), "first line preserved");
  assert.ok(truncated.includes("line 150"), "line 150 preserved");
  assert.ok(!truncated.includes("line 151"), "line 151 removed");

  // Overflow file exists
  const memDir = path.dirname(memPath);
  const overflows = fs.readdirSync(memDir).filter(f => f.startsWith("overflow-"));
  assert.strictEqual(overflows.length, 1);

  const overflowContent = fs.readFileSync(path.join(memDir, overflows[0]), "utf8");
  assert.ok(overflowContent.includes("line 151"), "overflow has line 151");
  assert.ok(overflowContent.includes("line 200"), "overflow has line 200");
  assert.ok(overflowContent.includes("<!-- Overflow from MEMORY.md"), "overflow has header");
});

test("6. Idempotency: fire again on 150-line file → no new overflow", (env, cwd) => {
  const content = genLines(200);
  const memPath = createMemoryFile(env.home, cwd, content);

  // First run: triggers overflow
  runGuardHook(
    { tool_name: "Write", tool_input: { file_path: memPath } },
    { home: env.home, cwd },
  );

  const memDir = path.dirname(memPath);
  const overflowsBefore = fs.readdirSync(memDir).filter(f => f.startsWith("overflow-"));
  assert.strictEqual(overflowsBefore.length, 1);

  // Second run: should be a no-op
  const result = runGuardHook(
    { tool_name: "Write", tool_input: { file_path: memPath } },
    { home: env.home, cwd },
  );
  assert.deepStrictEqual(result.json, {});

  const overflowsAfter = fs.readdirSync(memDir).filter(f => f.startsWith("overflow-"));
  assert.strictEqual(overflowsAfter.length, 1, "no new overflow file created");
});

test("7. Same-day collision: pre-existing overflow → counter suffix -2", (env, cwd) => {
  const content = genLines(200);
  const memPath = createMemoryFile(env.home, cwd, content);
  const memDir = path.dirname(memPath);

  // Pre-create today's overflow file
  const d = new Date();
  const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  fs.writeFileSync(path.join(memDir, `overflow-${dateStr}.md`), "existing overflow\n");

  const result = runGuardHook(
    { tool_name: "Write", tool_input: { file_path: memPath } },
    { home: env.home, cwd },
  );
  assert.ok(result.json.additionalContext, "should return additionalContext");

  const overflows = fs.readdirSync(memDir).filter(f => f.startsWith("overflow-"));
  assert.strictEqual(overflows.length, 2);
  assert.ok(overflows.some(f => f.includes("-2")), "collision file has -2 suffix");
});

test("8. Missing MEMORY.md → empty JSON, no crash", (env, cwd) => {
  // Construct the path that would be MEMORY.md but don't create the file
  const cwdEncoded = cwd.replace(/:/g, "-").replace(/[\\/]/g, "-").replace(/^-/, "");
  const fakePath = path.join(env.home, ".claude", "projects", cwdEncoded, "memory", "MEMORY.md");

  const result = runGuardHook(
    { tool_name: "Write", tool_input: { file_path: fakePath } },
    { home: env.home, cwd },
  );
  assert.strictEqual(result.status, 0);
  assert.deepStrictEqual(result.json, {});
});

test("9. Section integrity: '## Current Work' in first 50 lines survives", (env, cwd) => {
  // Build content with ## Current Work at line 30, overflow happens at 151+
  const headerLines = Array.from({ length: 29 }, (_, i) => `header ${i + 1}`);
  const cwSection = ["## Current Work", "Working on feature X"];
  const filler = Array.from({ length: 170 }, (_, i) => `filler ${i + 1}`);
  const content = [...headerLines, ...cwSection, ...filler].join("\n") + "\n";

  const memPath = createMemoryFile(env.home, cwd, content);
  runGuardHook(
    { tool_name: "Write", tool_input: { file_path: memPath } },
    { home: env.home, cwd },
  );

  const truncated = fs.readFileSync(memPath, "utf8");
  assert.ok(truncated.includes("## Current Work"), "Current Work section preserved");
  assert.ok(truncated.includes("Working on feature X"), "Current Work content preserved");
});

test("10. CLAUDE.md advisory fires when combined > 700 lines", (env, cwd) => {
  // Create global CLAUDE.md (400 lines)
  const globalClaude = path.join(env.claudeDir, "CLAUDE.md");
  fs.writeFileSync(globalClaude, genLines(400, "global"));

  // Create project CLAUDE.md (400 lines)
  fs.writeFileSync(path.join(cwd, "CLAUDE.md"), genLines(400, "project"));

  const result = runGuardHook(
    { tool_name: "Edit", tool_input: { file_path: path.join(cwd, "CLAUDE.md") } },
    { home: env.home, cwd },
  );
  const ctx = result.json.additionalContext;
  assert.ok(ctx, "should return additionalContext");
  assert.ok(ctx.includes("800 lines"), "mentions combined count");
  assert.ok(ctx.includes("700"), "mentions threshold");
});

test("11. CLAUDE.md advisory silent when combined <= 700 lines", (env, cwd) => {
  // Create global CLAUDE.md (200 lines)
  const globalClaude = path.join(env.claudeDir, "CLAUDE.md");
  fs.writeFileSync(globalClaude, genLines(200, "global"));

  // Create project CLAUDE.md (200 lines)
  fs.writeFileSync(path.join(cwd, "CLAUDE.md"), genLines(200, "project"));

  const result = runGuardHook(
    { tool_name: "Edit", tool_input: { file_path: path.join(cwd, "CLAUDE.md") } },
    { home: env.home, cwd },
  );
  assert.deepStrictEqual(result.json, {});
});

test("12. Malformed/empty JSON input → empty JSON", (env, cwd) => {
  const result = runGuardHookRaw("not valid json", { home: env.home, cwd });
  assert.strictEqual(result.status, 0);
  assert.deepStrictEqual(result.json, {});
});

test("13. Missing cwd in hook event → empty JSON (no process.cwd() fallback)", (env, cwd) => {
  // Construct a MEMORY.md path that would match if cwd were provided, but
  // don't include cwd in the event — the hook must return {} rather than guess.
  const cwdEncoded = cwd.replace(/:/g, "-").replace(/[\\/]/g, "-").replace(/^-/, "");
  const memPath = path.join(env.home, ".claude", "projects", cwdEncoded, "memory", "MEMORY.md");
  fs.mkdirSync(path.dirname(memPath), { recursive: true });
  fs.writeFileSync(memPath, genLines(200));

  // Pass only home — omit cwd so the helper does not inject it into the event
  const result = runGuardHook(
    { tool_name: "Write", tool_input: { file_path: memPath } },
    { home: env.home },
  );
  assert.strictEqual(result.status, 0);
  assert.deepStrictEqual(result.json, {}, "hook must return {} when cwd is absent");
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failures.length > 0) {
  console.log("Failures:");
  for (const f of failures) {
    console.log(`  - ${f.name}: ${f.error}`);
  }
  process.exit(1);
}
