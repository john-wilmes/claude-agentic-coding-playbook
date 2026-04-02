"use strict";

const assert = require("assert");
const { runHook, runHookRaw } = require("./test-helpers");
const fs = require("fs");
const path = require("path");
const os = require("os");

const HOOK = path.join(__dirname, "../../templates/hooks/memory-accumulation-guard.js");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL  ${name}: ${e.message}`);
    failed++;
  }
}

function createTempMemory(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memaccum-"));
  const filePath = path.join(dir, "MEMORY.md");
  fs.writeFileSync(filePath, content);
  return { dir, filePath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// --- Write tests ---

test("Write with single date stamp is allowed", () => {
  const content = "# Memory\n\n**Date:** 2026-03-30\n\n### What was done\n- stuff\n";
  const { json: result } = runHook(HOOK, {
    tool_name: "Write",
    tool_input: { file_path: "/tmp/test/MEMORY.md", content },
  });
  assert.ok(!result.hookSpecificOutput || result.hookSpecificOutput.permissionDecision !== "deny");
});

test("Write with no session state is allowed", () => {
  const content = "# Memory\n\n- [Topic](topic.md) — description\n";
  const { json: result } = runHook(HOOK, {
    tool_name: "Write",
    tool_input: { file_path: "/tmp/test/MEMORY.md", content },
  });
  assert.ok(!result.hookSpecificOutput || result.hookSpecificOutput.permissionDecision !== "deny");
});

test("Write with two date stamps is denied", () => {
  const content = "# Memory\n\n**Date:** 2026-03-29\n\n### What was done\n- old\n\n**Date:** 2026-03-30\n\n### What was done\n- new\n";
  const { json: result } = runHook(HOOK, {
    tool_name: "Write",
    tool_input: { file_path: "/tmp/test/MEMORY.md", content },
  });
  assert.strictEqual(result.hookSpecificOutput.permissionDecision, "deny");
  assert.ok(result.hookSpecificOutput.permissionDecisionReason.includes("2 session date stamps"));
});

test("Write with duplicate 'What was done' headers is denied", () => {
  const content = "# Memory\n\n**Date:** 2026-03-30\n\n### What was done\n- first\n\n### What was done\n- second\n";
  const { json: result } = runHook(HOOK, {
    tool_name: "Write",
    tool_input: { file_path: "/tmp/test/MEMORY.md", content },
  });
  assert.strictEqual(result.hookSpecificOutput.permissionDecision, "deny");
});

test("Write with duplicate 'Next Steps' headers is denied", () => {
  const content = "# Memory\n\n### Next Steps\n1. a\n\n### Next Steps\n1. b\n";
  const { json: result } = runHook(HOOK, {
    tool_name: "Write",
    tool_input: { file_path: "/tmp/test/MEMORY.md", content },
  });
  assert.strictEqual(result.hookSpecificOutput.permissionDecision, "deny");
});

test("Write to non-MEMORY.md is always allowed", () => {
  const content = "**Date:** 2026-03-29\n**Date:** 2026-03-30\n### What was done\n### What was done\n";
  const { json: result } = runHook(HOOK, {
    tool_name: "Write",
    tool_input: { file_path: "/tmp/test/current_work.md", content },
  });
  assert.ok(!result.hookSpecificOutput || result.hookSpecificOutput.permissionDecision !== "deny");
});

// --- Edit tests ---

test("Edit that introduces accumulation is denied", () => {
  const tmp = createTempMemory("# Memory\n\n**Date:** 2026-03-29\n\n### What was done\n- old\n");
  try {
    // Appending a second session instead of replacing
    const { json: result } = runHook(HOOK, {
      tool_name: "Edit",
      tool_input: {
        file_path: tmp.filePath,
        old_string: "- old\n",
        new_string: "- old\n\n**Date:** 2026-03-30\n\n### What was done\n- new\n",
      },
    });
    assert.strictEqual(result.hookSpecificOutput.permissionDecision, "deny");
  } finally {
    tmp.cleanup();
  }
});

test("Edit that replaces session state is allowed", () => {
  const tmp = createTempMemory("# Memory\n\n**Date:** 2026-03-29\n\n### What was done\n- old\n");
  try {
    const { json: result } = runHook(HOOK, {
      tool_name: "Edit",
      tool_input: {
        file_path: tmp.filePath,
        old_string: "**Date:** 2026-03-29\n\n### What was done\n- old",
        new_string: "**Date:** 2026-03-30\n\n### What was done\n- new",
      },
    });
    assert.ok(!result.hookSpecificOutput || result.hookSpecificOutput.permissionDecision !== "deny");
  } finally {
    tmp.cleanup();
  }
});

// --- Edge cases ---

test("Non-Write/Edit tool is ignored", () => {
  const { json: result } = runHook(HOOK, {
    tool_name: "Read",
    tool_input: { file_path: "/tmp/test/MEMORY.md" },
  });
  assert.ok(!result.hookSpecificOutput || result.hookSpecificOutput.permissionDecision !== "deny");
});

test("Malformed JSON input exits cleanly", () => {
  const { status } = runHookRaw(HOOK, "not json");
  assert.strictEqual(status, 0);
});

// --- Unit tests for checkForAccumulation ---

const { checkForAccumulation } = require(HOOK);

test("checkForAccumulation: single date returns null", () => {
  assert.strictEqual(checkForAccumulation("**Date:** 2026-03-30\n### What was done\n"), null);
});

test("checkForAccumulation: two dates returns error string", () => {
  const result = checkForAccumulation("**Date:** 2026-03-29\n**Date:** 2026-03-30\n");
  assert.ok(result !== null);
  assert.ok(result.includes("2 session date stamps"));
});

test("checkForAccumulation: no session state returns null", () => {
  assert.strictEqual(checkForAccumulation("# Just an index\n- [Topic](t.md)\n"), null);
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
