"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { createTempHome, runHook, runHookRaw } = require("./test-helpers");

const HOOK = path.resolve(__dirname, "../../templates/hooks/checkpoint-discipline.js");
const TEST_TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-test-"));
const ACK_MARKER = path.join(TEST_TMPDIR, "checkpoint-preflight-ack");

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

// Clean up any stale ack marker before tests
try { fs.unlinkSync(ACK_MARKER); } catch { /* ignore */ }

console.log("checkpoint-discipline.js tests:");
console.log("\n  Guard 1: checkpoint delegation preflight");

// --- Guard 1: Pass-through tests ---

test("passes through non-Agent/Write/Edit tools", () => {
  const result = runHook(HOOK, { tool_name: "Read", tool_input: {} });
  assert.strictEqual(result.status, 0);
  assert.deepStrictEqual(result.json, {});
});

test("passes through Agent calls without checkpoint keywords", () => {
  const result = runHook(HOOK, {
    tool_name: "Agent",
    tool_input: { prompt: "Search for all TypeScript files in src/" },
  });
  assert.strictEqual(result.status, 0);
  assert.deepStrictEqual(result.json, {});
});

test("passes through when agent_id is present (subagent context)", () => {
  const result = runHook(HOOK, {
    tool_name: "Agent",
    agent_id: "sub-123",
    tool_input: { prompt: "Run checkpoint delegation" },
  });
  assert.strictEqual(result.status, 0);
  assert.deepStrictEqual(result.json, {});
});

// --- Guard 1: Warn tests ---

test("warns when checkpoint delegation has no recent memory writes", () => {
  const { home, cleanup } = createTempHome();
  try {
    const result = runHook(HOOK, {
      tool_name: "Agent",
      tool_input: { prompt: "Delegate to subagent for checkpoint save" },
    }, { HOME: home });
    assert.strictEqual(result.status, 0);
    const ctx = result.json?.hookSpecificOutput?.additionalContext || "";
    assert.ok(ctx.includes("CHECKPOINT PREFLIGHT"), "should contain preflight warning");
    assert.ok(ctx.includes("Step 0"), "should mention Step 0");
  } finally { cleanup(); }
});

test("warns on 'save work' keyword", () => {
  const { home, cleanup } = createTempHome();
  try {
    const result = runHook(HOOK, {
      tool_name: "Agent",
      tool_input: { prompt: "Save work and prepare for session end" },
    }, { HOME: home });
    assert.strictEqual(result.status, 0);
    assert.ok(result.json?.hookSpecificOutput?.additionalContext?.includes("CHECKPOINT PREFLIGHT"));
  } finally { cleanup(); }
});

test("warns on 'wrap up' keyword", () => {
  const { home, cleanup } = createTempHome();
  try {
    const result = runHook(HOOK, {
      tool_name: "Agent",
      tool_input: { prompt: "Let's wrap up and commit everything" },
    }, { HOME: home });
    assert.strictEqual(result.status, 0);
    assert.ok(result.json?.hookSpecificOutput?.additionalContext?.includes("CHECKPOINT PREFLIGHT"));
  } finally { cleanup(); }
});

test("warns on 'session end' keyword", () => {
  const { home, cleanup } = createTempHome();
  try {
    const result = runHook(HOOK, {
      tool_name: "Agent",
      tool_input: { prompt: "Prepare for session-end" },
    }, { HOME: home });
    assert.strictEqual(result.status, 0);
    assert.ok(result.json?.hookSpecificOutput?.additionalContext?.includes("CHECKPOINT PREFLIGHT"));
  } finally { cleanup(); }
});

// --- Guard 1: Bypass marker tests ---

test("allows when bypass marker exists and is fresh", () => {
  fs.writeFileSync(ACK_MARKER, JSON.stringify({ nothing_to_persist: true }));
  const result = runHook(HOOK, {
    tool_name: "Agent",
    tool_input: { prompt: "Run checkpoint" },
  }, { TMPDIR: TEST_TMPDIR });
  assert.strictEqual(result.status, 0);
  assert.deepStrictEqual(result.json, {});
  assert.ok(!fs.existsSync(ACK_MARKER), "marker should be deleted after use");
});

test("ignores stale bypass marker (>60s old)", () => {
  const { home, cleanup } = createTempHome();
  try {
    fs.writeFileSync(ACK_MARKER, "");
    const oldTime = new Date(Date.now() - 120_000);
    fs.utimesSync(ACK_MARKER, oldTime, oldTime);

    const result = runHook(HOOK, {
      tool_name: "Agent",
      tool_input: { prompt: "Run checkpoint" },
    }, { HOME: home, TMPDIR: TEST_TMPDIR });
    assert.strictEqual(result.status, 0);
    assert.ok(result.json?.hookSpecificOutput?.additionalContext?.includes("CHECKPOINT PREFLIGHT"));
  } finally {
    try { fs.unlinkSync(ACK_MARKER); } catch { /* ignore */ }
    cleanup();
  }
});

// --- Guard 1: Recent memory writes tests ---

test("allows when memory topic file was recently written", () => {
  const { home, cleanup } = createTempHome();
  try {
    const memDir = path.join(home, ".claude", "projects", "test-project", "memory");
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, "project_test.md"), "# Test findings");

    const result = runHook(HOOK, {
      tool_name: "Agent",
      tool_input: { prompt: "Run checkpoint" },
    }, { HOME: home });
    assert.strictEqual(result.status, 0);
    assert.deepStrictEqual(result.json, {});
  } finally { cleanup(); }
});

test("ignores MEMORY.md when checking for recent writes", () => {
  const { home, cleanup } = createTempHome();
  try {
    const memDir = path.join(home, ".claude", "projects", "test-project", "memory");
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, "MEMORY.md"), "# Index");
    const topicPath = path.join(memDir, "project_old.md");
    fs.writeFileSync(topicPath, "# Old");
    const oldTime = new Date(Date.now() - 300_000);
    fs.utimesSync(topicPath, oldTime, oldTime);

    const result = runHook(HOOK, {
      tool_name: "Agent",
      tool_input: { prompt: "Run checkpoint" },
    }, { HOME: home });
    assert.strictEqual(result.status, 0);
    assert.ok(result.json?.hookSpecificOutput?.additionalContext?.includes("CHECKPOINT PREFLIGHT"));
  } finally { cleanup(); }
});

// --- Guard 2: manual current_work.md writes ---

console.log("\n  Guard 2: fake checkpoint detection");

test("warns when parent writes current_work.md in memory dir", () => {
  const result = runHook(HOOK, {
    tool_name: "Write",
    tool_input: {
      file_path: "/home/user/.claude/projects/test/memory/current_work.md",
      content: "## Session State\n\n### What was done:",
    },
  });
  assert.strictEqual(result.status, 0);
  const ctx = result.json?.hookSpecificOutput?.additionalContext || "";
  assert.ok(ctx.includes("CHECKPOINT REMINDER"), "should contain checkpoint reminder");
  assert.ok(ctx.includes("/checkpoint"), "should suggest /checkpoint");
});

test("warns strongly when parent writes current_work.md at high context", () => {
  const pid = "99999";
  const flag = path.join(TEST_TMPDIR, `claude-context-high-${pid}`);
  fs.writeFileSync(flag, "");
  try {
    const result = runHook(HOOK, {
      tool_name: "Write",
      tool_input: {
        file_path: "/home/user/.claude/projects/test/memory/current_work.md",
        content: "## Session State\n\n### What was done:",
      },
    }, { CLAUDE_LOOP_PID: pid, TMPDIR: TEST_TMPDIR });
    assert.strictEqual(result.status, 0);
    const ctx = result.json?.hookSpecificOutput?.additionalContext || "";
    assert.ok(ctx.includes("CHECKPOINT DISCIPLINE"), "should contain strong warning");
    assert.ok(ctx.includes("/checkpoint"), "should suggest /checkpoint");
  } finally {
    try { fs.unlinkSync(flag); } catch { /* ignore */ }
  }
});

test("skips guard 2 for subagent writing current_work.md", () => {
  const result = runHook(HOOK, {
    tool_name: "Write",
    agent_id: "checkpoint-subagent",
    tool_input: {
      file_path: "/home/user/.claude/projects/test/memory/current_work.md",
      content: "## Session State",
    },
  });
  assert.strictEqual(result.status, 0);
  assert.deepStrictEqual(result.json, {});
});

test("passes through Write to other memory files", () => {
  const result = runHook(HOOK, {
    tool_name: "Write",
    tool_input: {
      file_path: "/home/user/.claude/projects/test/memory/project_test.md",
      content: "# Test",
    },
  });
  assert.strictEqual(result.status, 0);
  assert.deepStrictEqual(result.json, {});
});

test("passes through Write to current_work.md outside memory dir", () => {
  const result = runHook(HOOK, {
    tool_name: "Write",
    tool_input: {
      file_path: "/tmp/current_work.md",
      content: "# Test",
    },
  });
  assert.strictEqual(result.status, 0);
  assert.deepStrictEqual(result.json, {});
});

test("warns on Edit to current_work.md in memory dir", () => {
  const result = runHook(HOOK, {
    tool_name: "Edit",
    tool_input: {
      file_path: "/home/user/.claude/projects/test/memory/current_work.md",
      old_string: "old",
      new_string: "new",
    },
  });
  assert.strictEqual(result.status, 0);
  const ctx = result.json?.hookSpecificOutput?.additionalContext || "";
  assert.ok(ctx.includes("CHECKPOINT REMINDER"));
});

// --- Error handling ---

console.log("\n  Error handling");

test("handles malformed JSON gracefully", () => {
  const result = runHookRaw(HOOK, "not json at all");
  assert.strictEqual(result.status, 0);
  assert.deepStrictEqual(result.json, {});
});

test("handles empty input gracefully", () => {
  const result = runHookRaw(HOOK, "");
  assert.strictEqual(result.status, 0);
  assert.deepStrictEqual(result.json, {});
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
