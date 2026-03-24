#!/usr/bin/env node
/**
 * Tests for multi-image-guard.js PreToolUse hook.
 * Validates: image read tracking, deny on 2nd+ image, subagent bypass, non-image pass-through.
 */

"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { runHook } = require("./test-helpers");

const HOOK = path.resolve(__dirname, "../../templates/hooks/multi-image-guard.js");
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

// Helper: clean up tracking file for a session
function cleanTracking(sessionId) {
  const p = path.join(os.tmpdir(), `claude-image-reads-${sessionId}`);
  try { fs.unlinkSync(p); } catch {}
}

console.log("multi-image-guard.js tests:");

// --- Test: non-image Read passes through ---
test("non-image Read passes through", () => {
  const sessionId = `test-mig-${Date.now()}-1`;
  cleanTracking(sessionId);
  const result = runHook(HOOK, {
    tool_name: "Read",
    tool_input: { file_path: "/tmp/foo.js" },
    session_id: sessionId,
  });
  assert.strictEqual(result.status, 0);
  assert.deepStrictEqual(result.json, {});
  cleanTracking(sessionId);
});

// --- Test: first image Read is allowed ---
test("first image Read is allowed", () => {
  const sessionId = `test-mig-${Date.now()}-2`;
  cleanTracking(sessionId);
  const result = runHook(HOOK, {
    tool_name: "Read",
    tool_input: { file_path: "/tmp/screenshot.png" },
    session_id: sessionId,
  });
  assert.strictEqual(result.status, 0);
  assert.deepStrictEqual(result.json, {});
  cleanTracking(sessionId);
});

// --- Test: second image Read is denied ---
test("second image Read is denied", () => {
  const sessionId = `test-mig-${Date.now()}-3`;
  cleanTracking(sessionId);

  // First read — allowed
  runHook(HOOK, {
    tool_name: "Read",
    tool_input: { file_path: "/tmp/img1.jpg" },
    session_id: sessionId,
  });

  // Second read — denied
  const result = runHook(HOOK, {
    tool_name: "Read",
    tool_input: { file_path: "/tmp/img2.png" },
    session_id: sessionId,
  });
  assert.strictEqual(result.status, 0);
  assert.ok(result.json.hookSpecificOutput);
  assert.strictEqual(result.json.hookSpecificOutput.permissionDecision, "deny");
  assert.ok(result.json.hookSpecificOutput.permissionDecisionReason.includes("subagent"));
  cleanTracking(sessionId);
});

// --- Test: third image Read is also denied ---
test("third image Read is also denied", () => {
  const sessionId = `test-mig-${Date.now()}-4`;
  cleanTracking(sessionId);

  // First read
  runHook(HOOK, {
    tool_name: "Read",
    tool_input: { file_path: "/tmp/a.png" },
    session_id: sessionId,
  });
  // Second read
  runHook(HOOK, {
    tool_name: "Read",
    tool_input: { file_path: "/tmp/b.jpg" },
    session_id: sessionId,
  });
  // Third read — still denied
  const result = runHook(HOOK, {
    tool_name: "Read",
    tool_input: { file_path: "/tmp/c.gif" },
    session_id: sessionId,
  });
  assert.strictEqual(result.json.hookSpecificOutput.permissionDecision, "deny");
  assert.ok(result.json.hookSpecificOutput.permissionDecisionReason.includes("subagent"));
  cleanTracking(sessionId);
});

// --- Test: subagent is always allowed ---
test("subagent image reads are always allowed", () => {
  const sessionId = `test-mig-${Date.now()}-5`;
  cleanTracking(sessionId);

  // First read from parent — allowed
  runHook(HOOK, {
    tool_name: "Read",
    tool_input: { file_path: "/tmp/img1.png" },
    session_id: sessionId,
  });

  // Subagent image read — always allowed (has agent_id)
  const result = runHook(HOOK, {
    tool_name: "Read",
    tool_input: { file_path: "/tmp/img2.png" },
    session_id: sessionId,
    agent_id: "subagent-123",
  });
  assert.strictEqual(result.status, 0);
  assert.deepStrictEqual(result.json, {});
  cleanTracking(sessionId);
});

// --- Test: non-Read tools pass through ---
test("non-Read tools pass through", () => {
  const sessionId = `test-mig-${Date.now()}-6`;
  const result = runHook(HOOK, {
    tool_name: "Write",
    tool_input: { file_path: "/tmp/output.png", content: "data" },
    session_id: sessionId,
  });
  assert.strictEqual(result.status, 0);
  assert.deepStrictEqual(result.json, {});
});

// --- Test: various image extensions are recognized ---
test("recognizes various image extensions", () => {
  const { isImagePath } = require("../../templates/hooks/multi-image-guard");
  assert.ok(isImagePath("/tmp/foo.jpg"));
  assert.ok(isImagePath("/tmp/foo.jpeg"));
  assert.ok(isImagePath("/tmp/foo.png"));
  assert.ok(isImagePath("/tmp/foo.gif"));
  assert.ok(isImagePath("/tmp/foo.webp"));
  assert.ok(isImagePath("/tmp/foo.svg"));
  assert.ok(isImagePath("/tmp/foo.ico"));
  assert.ok(isImagePath("/tmp/foo.bmp"));
  assert.ok(isImagePath("/tmp/foo.tiff"));
  assert.ok(!isImagePath("/tmp/foo.js"));
  assert.ok(!isImagePath("/tmp/foo.pdf"));
  assert.ok(!isImagePath("/tmp/foo.md"));
  assert.ok(!isImagePath(""));
  assert.ok(!isImagePath(null));
});

// --- Test: malformed JSON input produces empty output ---
test("malformed JSON produces empty output", () => {
  const { runHookRaw } = require("./test-helpers");
  const result = runHookRaw(HOOK, "not valid json");
  assert.strictEqual(result.status, 0);
  assert.deepStrictEqual(result.json, {});
});

// --- Test: separate sessions have independent counts ---
test("separate sessions have independent counts", () => {
  const sessionA = `test-mig-${Date.now()}-A`;
  const sessionB = `test-mig-${Date.now()}-B`;
  cleanTracking(sessionA);
  cleanTracking(sessionB);

  // Session A reads an image
  runHook(HOOK, {
    tool_name: "Read",
    tool_input: { file_path: "/tmp/img.png" },
    session_id: sessionA,
  });

  // Session B first image — should be allowed (independent count)
  const result = runHook(HOOK, {
    tool_name: "Read",
    tool_input: { file_path: "/tmp/img.png" },
    session_id: sessionB,
  });
  assert.strictEqual(result.status, 0);
  assert.deepStrictEqual(result.json, {});

  cleanTracking(sessionA);
  cleanTracking(sessionB);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
