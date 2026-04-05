"use strict";

const assert = require("assert");
const { runHook } = require("./test-helpers");
const fs = require("fs");
const path = require("path");
const os = require("os");

const HOOK = path.join(__dirname, "../../templates/hooks/memory-index-guard.js");

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

// Helper to create a temp MEMORY.md with N lines
function createTempMemory(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memguard-"));
  const filePath = path.join(dir, "MEMORY.md");
  const content = Array.from({ length: lines }, (_, i) => `Line ${i + 1}`).join("\n");
  fs.writeFileSync(filePath, content);
  return { dir, filePath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// --- Write tests ---

test("Write to MEMORY.md under limit is allowed", () => {
  const content = Array.from({ length: 30 }, (_, i) => `- [Topic ${i}](topic.md)`).join("\n");
  const { json: result } = runHook(HOOK, {
    tool_name: "Write",
    tool_input: { file_path: "/tmp/test/memory/MEMORY.md", content },
  });
  assert.ok(!result.hookSpecificOutput || result.hookSpecificOutput.permissionDecision !== "deny");
});

test("Write to MEMORY.md at exactly 50 lines is allowed", () => {
  const content = Array.from({ length: 50 }, (_, i) => `- [Topic ${i}](topic.md)`).join("\n");
  const { json: result } = runHook(HOOK, {
    tool_name: "Write",
    tool_input: { file_path: "/tmp/test/memory/MEMORY.md", content },
  });
  assert.ok(!result.hookSpecificOutput || result.hookSpecificOutput.permissionDecision !== "deny");
});

test("Write to MEMORY.md over limit is denied", () => {
  const content = Array.from({ length: 80 }, (_, i) => `- [Topic ${i}](topic.md)`).join("\n");
  const { json: result } = runHook(HOOK, {
    tool_name: "Write",
    tool_input: { file_path: "/tmp/test/memory/MEMORY.md", content },
  });
  assert.strictEqual(result.hookSpecificOutput.permissionDecision, "deny");
  assert.ok(result.hookSpecificOutput.permissionDecisionReason.includes("80 lines"));
});

test("Write to non-MEMORY.md file is allowed regardless of size", () => {
  const content = Array.from({ length: 200 }, (_, i) => `Line ${i}`).join("\n");
  const { json: result } = runHook(HOOK, {
    tool_name: "Write",
    tool_input: { file_path: "/tmp/test/memory/project_wte.md", content },
  });
  assert.ok(!result.hookSpecificOutput || result.hookSpecificOutput.permissionDecision !== "deny");
});

// --- Edit tests ---

test("Edit that keeps MEMORY.md under limit is allowed", () => {
  const tmp = createTempMemory(40);
  try {
    const { json: result } = runHook(HOOK, {
      tool_name: "Edit",
      tool_input: {
        file_path: tmp.filePath,
        old_string: "Line 1",
        new_string: "Line 1 updated",
      },
    });
    assert.ok(!result.hookSpecificOutput || result.hookSpecificOutput.permissionDecision !== "deny");
  } finally {
    tmp.cleanup();
  }
});

test("Edit that would push MEMORY.md over limit is denied", () => {
  const tmp = createTempMemory(48);
  try {
    // Replace 1 line with 5 lines → 48 - 1 + 5 = 52
    const { json: result } = runHook(HOOK, {
      tool_name: "Edit",
      tool_input: {
        file_path: tmp.filePath,
        old_string: "Line 1",
        new_string: "New line A\nNew line B\nNew line C\nNew line D\nNew line E",
      },
    });
    assert.strictEqual(result.hookSpecificOutput.permissionDecision, "deny");
  } finally {
    tmp.cleanup();
  }
});

test("Edit on nonexistent MEMORY.md is allowed (can't read file)", () => {
  const { json: result } = runHook(HOOK, {
    tool_name: "Edit",
    tool_input: {
      file_path: "/tmp/nonexistent-dir-12345/MEMORY.md",
      old_string: "foo",
      new_string: "bar",
    },
  });
  assert.ok(!result.hookSpecificOutput || result.hookSpecificOutput.permissionDecision !== "deny");
});

// --- Non-matching tools ---

test("Read tool is ignored", () => {
  const { json: result } = runHook(HOOK, {
    tool_name: "Read",
    tool_input: { file_path: "/tmp/test/MEMORY.md" },
  });
  assert.ok(!result.hookSpecificOutput || result.hookSpecificOutput.permissionDecision !== "deny");
});

test("Bash tool is ignored", () => {
  const { json: result } = runHook(HOOK, {
    tool_name: "Bash",
    tool_input: { command: "cat MEMORY.md" },
  });
  assert.ok(!result.hookSpecificOutput || result.hookSpecificOutput.permissionDecision !== "deny");
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
