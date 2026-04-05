#!/usr/bin/env node
/**
 * Tests for mcp-server-guard.js PreToolUse hook.
 * Validates: MCP server setting detection, once-per-session warning, advisory (not deny).
 */

"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { runHook, createTempHome } = require("./test-helpers");

const HOOK = path.resolve(__dirname, "../../templates/hooks/mcp-server-guard.js");
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

// Helper: clean up warning flag for a session
function cleanFlag(sessionId) {
  const p = path.join(os.tmpdir(), "claude-mcp-server-guard", `claude-mcp-warned-${sessionId}`);
  try { fs.unlinkSync(p); } catch {}
}

console.log("mcp-server-guard.js tests:");

// --- Test: no warning when setting is false ---
test("no warning when enableAllProjectMcpServers is false", () => {
  const { home, claudeDir, cleanup } = createTempHome();
  const sessionId = `test-mcp-${Date.now()}-1`;
  cleanFlag(sessionId);

  fs.writeFileSync(
    path.join(claudeDir, "settings.json"),
    JSON.stringify({ enableAllProjectMcpServers: false })
  );

  const result = runHook(HOOK, {
    tool_name: "Read",
    tool_input: { file_path: "/tmp/foo.js" },
    session_id: sessionId,
    cwd: "/tmp",
  }, { HOME: home });

  assert.strictEqual(result.status, 0);
  assert.deepStrictEqual(result.json, {});
  cleanFlag(sessionId);
  cleanup();
});

// --- Test: no warning when setting is absent ---
test("no warning when setting is absent", () => {
  const { home, claudeDir, cleanup } = createTempHome();
  const sessionId = `test-mcp-${Date.now()}-2`;
  cleanFlag(sessionId);

  fs.writeFileSync(path.join(claudeDir, "settings.json"), "{}");

  const result = runHook(HOOK, {
    tool_name: "Read",
    tool_input: {},
    session_id: sessionId,
    cwd: "/tmp",
  }, { HOME: home });

  assert.strictEqual(result.status, 0);
  assert.deepStrictEqual(result.json, {});
  cleanFlag(sessionId);
  cleanup();
});

// --- Test: warning when setting is true ---
test("warns when enableAllProjectMcpServers is true", () => {
  const { home, claudeDir, cleanup } = createTempHome();
  const sessionId = `test-mcp-${Date.now()}-3`;
  cleanFlag(sessionId);

  fs.writeFileSync(
    path.join(claudeDir, "settings.json"),
    JSON.stringify({ enableAllProjectMcpServers: true })
  );

  const result = runHook(HOOK, {
    tool_name: "Read",
    tool_input: {},
    session_id: sessionId,
    cwd: "/tmp",
  }, { HOME: home });

  assert.strictEqual(result.status, 0);
  assert.ok(result.json.hookSpecificOutput, "should have hookSpecificOutput");
  assert.ok(result.json.hookSpecificOutput.additionalContext);
  assert.ok(result.json.hookSpecificOutput.additionalContext.includes("enableAllProjectMcpServers"));
  // Should NOT be a deny — advisory only
  assert.strictEqual(result.json.hookSpecificOutput.permissionDecision, undefined);
  cleanFlag(sessionId);
  cleanup();
});

// --- Test: warns only once per session ---
test("warns only once per session", () => {
  const { home, claudeDir, cleanup } = createTempHome();
  const sessionId = `test-mcp-${Date.now()}-4`;
  cleanFlag(sessionId);

  fs.writeFileSync(
    path.join(claudeDir, "settings.json"),
    JSON.stringify({ enableAllProjectMcpServers: true })
  );

  // First call — warning
  const r1 = runHook(HOOK, {
    tool_name: "Read",
    tool_input: {},
    session_id: sessionId,
    cwd: "/tmp",
  }, { HOME: home });
  assert.ok(r1.json.hookSpecificOutput);

  // Second call — no warning (already warned)
  const r2 = runHook(HOOK, {
    tool_name: "Read",
    tool_input: {},
    session_id: sessionId,
    cwd: "/tmp",
  }, { HOME: home });
  assert.deepStrictEqual(r2.json, {});

  cleanFlag(sessionId);
  cleanup();
});

// --- Test: different sessions get independent warnings ---
test("different sessions get independent warnings", () => {
  const { home, claudeDir, cleanup } = createTempHome();
  const sessionA = `test-mcp-${Date.now()}-A`;
  const sessionB = `test-mcp-${Date.now()}-B`;
  cleanFlag(sessionA);
  cleanFlag(sessionB);

  fs.writeFileSync(
    path.join(claudeDir, "settings.json"),
    JSON.stringify({ enableAllProjectMcpServers: true })
  );

  // Session A warns
  const rA = runHook(HOOK, {
    tool_name: "Read", tool_input: {}, session_id: sessionA, cwd: "/tmp",
  }, { HOME: home });
  assert.ok(rA.json.hookSpecificOutput);

  // Session B also warns (independent)
  const rB = runHook(HOOK, {
    tool_name: "Read", tool_input: {}, session_id: sessionB, cwd: "/tmp",
  }, { HOME: home });
  assert.ok(rB.json.hookSpecificOutput);

  cleanFlag(sessionA);
  cleanFlag(sessionB);
  cleanup();
});

// --- Test: project .mcp.json with global setting off is fine ---
test("project .mcp.json with global setting off produces no warning", () => {
  const { home, claudeDir, cleanup } = createTempHome();
  const sessionId = `test-mcp-${Date.now()}-5`;
  cleanFlag(sessionId);

  // Global setting is off
  fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({}));

  // But project has .mcp.json
  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-proj-"));
  fs.writeFileSync(path.join(projDir, ".mcp.json"), '{"servers": {}}');

  const result = runHook(HOOK, {
    tool_name: "Read", tool_input: {}, session_id: sessionId, cwd: projDir,
  }, { HOME: home });

  assert.deepStrictEqual(result.json, {});
  cleanFlag(sessionId);
  cleanup();
  try { fs.rmSync(projDir, { recursive: true, force: true }); } catch {}
});

// --- Test: exported functions ---
test("isProjectMcpEnabled detects setting correctly", () => {
  const { isProjectMcpEnabled } = require("../../templates/hooks/mcp-server-guard");
  const { home, claudeDir, cleanup } = createTempHome();

  fs.writeFileSync(
    path.join(claudeDir, "settings.json"),
    JSON.stringify({ enableAllProjectMcpServers: true })
  );
  assert.strictEqual(isProjectMcpEnabled(home), true);

  fs.writeFileSync(
    path.join(claudeDir, "settings.json"),
    JSON.stringify({ enableAllProjectMcpServers: false })
  );
  assert.strictEqual(isProjectMcpEnabled(home), false);

  fs.writeFileSync(path.join(claudeDir, "settings.json"), "{}");
  assert.strictEqual(isProjectMcpEnabled(home), false);

  cleanup();
});

// --- Test: enabled=true with project .mcp.json still warns ---
test("enabled=true with project .mcp.json still warns", () => {
  const { home, claudeDir, cleanup } = createTempHome();
  const sessionId = `test-mcp-${Date.now()}-6`;
  cleanFlag(sessionId);

  fs.writeFileSync(
    path.join(claudeDir, "settings.json"),
    JSON.stringify({ enableAllProjectMcpServers: true })
  );

  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-proj-"));
  fs.writeFileSync(path.join(projDir, ".mcp.json"), '{"servers": {}}');

  const result = runHook(HOOK, {
    tool_name: "Read", tool_input: {}, session_id: sessionId, cwd: projDir,
  }, { HOME: home });

  assert.ok(result.json.hookSpecificOutput);
  assert.ok(result.json.hookSpecificOutput.additionalContext.includes("enableAllProjectMcpServers"));
  cleanFlag(sessionId);
  cleanup();
  try { fs.rmSync(projDir, { recursive: true, force: true }); } catch {}
});

// --- Test: malformed JSON produces empty output ---
test("malformed JSON produces empty output", () => {
  const { runHookRaw } = require("./test-helpers");
  const result = runHookRaw(HOOK, "garbage");
  assert.strictEqual(result.status, 0);
  assert.deepStrictEqual(result.json, {});
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
