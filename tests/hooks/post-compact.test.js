#!/usr/bin/env node
// Integration and unit tests for post-compact.js (PostCompact hook).
// Zero dependencies — uses only Node built-ins + local test-helpers.
//
// Run: node tests/hooks/post-compact.test.js

"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { createTempHome, createMemoryFile, runHook, runHookRaw } = require("./test-helpers");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const HOOK_PATH = path.join(REPO_ROOT, "templates", "hooks", "post-compact.js");

const {
  cwdToProjectKey,
  findMemoryPath,
  readCurrentWork,
  buildContext,
} = require(HOOK_PATH);

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

console.log("\npost-compact.js:");

// ── Unit tests ────────────────────────────────────────────────────────────────

test("cwdToProjectKey converts path separators to dashes", () => {
  const key = cwdToProjectKey("/home/user/Documents/myproject");
  assert.strictEqual(key, "home-user-Documents-myproject");
});

test("cwdToProjectKey strips leading dash", () => {
  const key = cwdToProjectKey("/foo/bar");
  assert.strictEqual(key, "foo-bar");
});

test("findMemoryPath returns path under homedir", () => {
  const cwd = "/home/user/myproject";
  const memPath = findMemoryPath(cwd);
  const home = os.homedir();
  assert.ok(memPath.startsWith(home), "Should be under homedir");
  assert.ok(memPath.endsWith("MEMORY.md"), "Should end with MEMORY.md");
  assert.ok(memPath.includes("home-user-myproject"), "Should encode cwd in path");
});

test("readCurrentWork returns null when file does not exist", () => {
  const result = readCurrentWork("/nonexistent/path/MEMORY.md");
  assert.strictEqual(result, null);
});

test("readCurrentWork returns Pre-compact snapshot section when present", () => {
  const tmpFile = path.join(os.tmpdir(), `post-compact-test-${Date.now()}.md`);
  fs.writeFileSync(tmpFile, [
    "# Memory",
    "",
    "## Pre-compact snapshot",
    "",
    "- Branch: main",
    "- Modified: foo.js",
    "",
    "## Current Work",
    "",
    "Working on feature X",
    "",
  ].join("\n"));
  try {
    const result = readCurrentWork(tmpFile);
    assert.ok(result !== null, "Should not be null");
    assert.ok(result.includes("Pre-compact snapshot"), "Should include snapshot header");
    assert.ok(result.includes("Branch: main"), "Should include snapshot content");
  } finally {
    try { fs.rmSync(tmpFile); } catch {}
  }
});

test("readCurrentWork falls back to Current Work when no snapshot", () => {
  const tmpFile = path.join(os.tmpdir(), `post-compact-test-${Date.now()}.md`);
  fs.writeFileSync(tmpFile, [
    "# Memory",
    "",
    "## Current Work",
    "",
    "Working on feature X",
    "",
    "## Lessons",
    "",
    "Some lessons here.",
    "",
  ].join("\n"));
  try {
    const result = readCurrentWork(tmpFile);
    assert.ok(result !== null, "Should not be null");
    assert.ok(result.includes("Working on feature X"), "Should include current work content");
  } finally {
    try { fs.rmSync(tmpFile); } catch {}
  }
});

test("readCurrentWork returns null when no relevant sections exist", () => {
  const tmpFile = path.join(os.tmpdir(), `post-compact-test-${Date.now()}.md`);
  fs.writeFileSync(tmpFile, [
    "# Memory",
    "",
    "## Overview",
    "",
    "Some overview content.",
    "",
  ].join("\n"));
  try {
    const result = readCurrentWork(tmpFile);
    assert.strictEqual(result, null);
  } finally {
    try { fs.rmSync(tmpFile); } catch {}
  }
});

test("buildContext returns null when currentWork is null", () => {
  assert.strictEqual(buildContext(null, null), null);
  assert.strictEqual(buildContext(null, "/tmp/sentinel"), null);
});

test("buildContext returns currentWork when no sentinel", () => {
  const result = buildContext("## Current Work\n\nDoing stuff", null);
  assert.strictEqual(result, "## Current Work\n\nDoing stuff");
});

test("buildContext appends task queue when sentinel is set", () => {
  const result = buildContext("## Current Work\n\nDoing stuff", "/tmp/test-sentinel");
  assert.ok(result.includes("Doing stuff"), "Should include work content");
  assert.ok(result.includes("Task queue: /tmp/test-sentinel"), "Should include task queue path");
});

// ── Integration tests ─────────────────────────────────────────────────────────

test("returns {} when no MEMORY.md exists", () => {
  const { home, cleanup } = createTempHome();
  const cwd = "/tmp/nonexistent-project-" + Date.now();
  try {
    const result = runHook(HOOK_PATH, { cwd }, { HOME: home, USERPROFILE: home });
    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.deepStrictEqual(result.json, {}, "Should return {}");
  } finally {
    cleanup();
  }
});

test("returns {} when MEMORY.md has no relevant sections", () => {
  const { home, cleanup } = createTempHome();
  const cwd = "/tmp/test-project-" + Date.now();
  try {
    createMemoryFile(home, cwd, "# Memory\n\n## Overview\n\nSome overview.\n");
    const result = runHook(HOOK_PATH, { cwd }, { HOME: home, USERPROFILE: home });
    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.deepStrictEqual(result.json, {}, "Should return {}");
  } finally {
    cleanup();
  }
});

test("injects Pre-compact snapshot when present", () => {
  const { home, cleanup } = createTempHome();
  const cwd = "/tmp/test-project-" + Date.now();
  try {
    createMemoryFile(home, cwd, [
      "## Pre-compact snapshot",
      "",
      "- Branch: main",
      "- Modified: foo.js",
      "",
      "## Other Section",
      "",
      "Other content.",
      "",
    ].join("\n"));
    const result = runHook(HOOK_PATH, { cwd }, { HOME: home, USERPROFILE: home });
    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.ok(result.json.hookSpecificOutput, "Should have hookSpecificOutput");
    const ctx = result.json.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes("Pre-compact snapshot"), "additionalContext should contain snapshot header");
    assert.ok(ctx.includes("Branch: main"), "additionalContext should contain snapshot content");
  } finally {
    cleanup();
  }
});

test("falls back to Current Work when no snapshot", () => {
  const { home, cleanup } = createTempHome();
  const cwd = "/tmp/test-project-" + Date.now();
  try {
    createMemoryFile(home, cwd, [
      "## Current Work",
      "",
      "Working on feature X",
      "",
      "## Lessons",
      "",
      "Some lessons.",
      "",
    ].join("\n"));
    const result = runHook(HOOK_PATH, { cwd }, { HOME: home, USERPROFILE: home });
    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.ok(result.json.hookSpecificOutput, "Should have hookSpecificOutput");
    const ctx = result.json.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes("Working on feature X"), "additionalContext should contain current work content");
  } finally {
    cleanup();
  }
});

test("prefers Pre-compact snapshot over Current Work", () => {
  const { home, cleanup } = createTempHome();
  const cwd = "/tmp/test-project-" + Date.now();
  try {
    createMemoryFile(home, cwd, [
      "## Pre-compact snapshot",
      "",
      "- Branch: main",
      "- Modified: foo.js",
      "",
      "## Current Work",
      "",
      "Working on feature X",
      "",
    ].join("\n"));
    const result = runHook(HOOK_PATH, { cwd }, { HOME: home, USERPROFILE: home });
    assert.strictEqual(result.status, 0, "Should exit 0");
    const ctx = result.json.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes("Pre-compact snapshot"), "Should prefer Pre-compact snapshot");
    // Snapshot section ends before Current Work — snapshot content should be there
    assert.ok(ctx.includes("Branch: main"), "Should include snapshot content");
  } finally {
    cleanup();
  }
});

test("includes task queue path when CLAUDE_LOOP_SENTINEL is set", () => {
  const { home, cleanup } = createTempHome();
  const cwd = "/tmp/test-project-" + Date.now();
  try {
    createMemoryFile(home, cwd, "## Current Work\n\nWorking on stuff.\n");
    const result = runHook(
      HOOK_PATH,
      { cwd },
      { HOME: home, USERPROFILE: home, CLAUDE_LOOP_SENTINEL: "/tmp/test-sentinel" }
    );
    assert.strictEqual(result.status, 0, "Should exit 0");
    const ctx = result.json.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes("Task queue: /tmp/test-sentinel"), "Should include task queue path");
  } finally {
    cleanup();
  }
});

test("handles malformed JSON gracefully", () => {
  const result = runHookRaw(HOOK_PATH, "not json");
  assert.strictEqual(result.status, 0, "Should exit 0");
  assert.deepStrictEqual(result.json, {}, "Should return {}");
});

// ── Round-trip and edge case tests ───────────────────────────────────────────

const PRE_COMPACT_PATH = path.join(REPO_ROOT, "templates", "hooks", "pre-compact.js");

test("pre-compact → post-compact round-trip: snapshot written by pre-compact is read by readCurrentWork", () => {
  const { home, cleanup } = createTempHome();
  const cwd = "/tmp/test-project-" + Date.now();
  // Seed an existing MEMORY.md so pre-compact has something to upsert into
  createMemoryFile(home, cwd, "# Memory\n\n## Current Work\n\nInitial work.\n");
  const sessionId = "test-session-" + Date.now();
  try {
    // Run pre-compact to write the snapshot into the MEMORY.md
    const preResult = runHook(
      PRE_COMPACT_PATH,
      { session_id: sessionId, cwd, trigger: "test" },
      { HOME: home, USERPROFILE: home }
    );
    assert.strictEqual(preResult.status, 0, "pre-compact should exit 0");

    // Determine the MEMORY.md path using the same encoding as the hooks
    const cwdEncoded = cwd.replace(/:/g, "-").replace(/[\\/]/g, "-").replace(/^-/, "");
    const memPath = path.join(home, ".claude", "projects", cwdEncoded, "memory", "MEMORY.md");

    // post-compact's readCurrentWork should find and return the Pre-compact snapshot section
    const content = readCurrentWork(memPath);
    assert.ok(content !== null, "readCurrentWork should not return null after pre-compact ran");
    assert.ok(content.includes("Pre-compact snapshot"), "Should contain snapshot header");
    assert.ok(content.includes("Trigger"), "Should contain Trigger field written by pre-compact");
    assert.ok(content.includes("Branch"), "Should contain Branch field written by pre-compact");
  } finally {
    // Clean up pre-compact state file so it doesn't affect other tests
    const stateFile = path.join(os.tmpdir(), "claude-pre-compact", `${sessionId}.done`);
    try { fs.rmSync(stateFile); } catch {}
    cleanup();
  }
});

test("readCurrentWork returns null for completely empty file", () => {
  const tmpFile = path.join(os.tmpdir(), `post-compact-empty-${Date.now()}.md`);
  fs.writeFileSync(tmpFile, "");
  try {
    const result = readCurrentWork(tmpFile);
    assert.strictEqual(result, null, "Should return null for empty file");
  } finally {
    try { fs.rmSync(tmpFile); } catch {}
  }
});

test("readCurrentWork returns header-only string when Current Work section body is empty", () => {
  // extractSection trims to the header alone when no body lines exist before the
  // next ## header; the non-empty header string is returned (not null).
  const tmpFile = path.join(os.tmpdir(), `post-compact-empty-section-${Date.now()}.md`);
  fs.writeFileSync(tmpFile, "## Current Work\n\n## Next Section\n\nHas content.\n");
  try {
    const result = readCurrentWork(tmpFile);
    assert.strictEqual(result, "## Current Work", "Should return header-only string for empty section body");
  } finally {
    try { fs.rmSync(tmpFile); } catch {}
  }
});

test("buildContext treats empty string sentinel same as null (no task queue appended)", () => {
  const result = buildContext("## Current Work\n\nDoing stuff", "");
  assert.ok(result !== null, "Should return content, not null");
  assert.ok(result.includes("Doing stuff"), "Should include work content");
  assert.ok(!result.includes("Task queue:"), "Should NOT append Task queue for empty string sentinel");
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
