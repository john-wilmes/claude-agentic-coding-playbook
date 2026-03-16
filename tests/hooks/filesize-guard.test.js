#!/usr/bin/env node
/**
 * filesize-guard.test.js — Integration tests for filesize-guard.js
 */

"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { runHook, runHookRaw, createTempHome } = require("./test-helpers");

const HOOK = path.resolve(__dirname, "../../templates/hooks/filesize-guard.js");

// ---------------------------------------------------------------------------
// Simple test runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInput(toolName, toolInput) {
  // runHook calls JSON.stringify internally, so pass an object
  return { tool_name: toolName, tool_input: toolInput };
}

function readInput(filePath) {
  return makeInput("Read", { file_path: filePath });
}

function bashInput(command) {
  return makeInput("Bash", { command });
}

// runHook returns { status, stdout, stderr, json } where json is the parsed hook output.
// These helpers accept either the runHook result wrapper or a bare parsed object.
function unwrap(result) {
  if (result && Object.prototype.hasOwnProperty.call(result, "json")) {
    return result.json || {};
  }
  return result || {};
}

function isDenied(result) {
  const obj = unwrap(result);
  return (
    obj &&
    obj.hookSpecificOutput &&
    obj.hookSpecificOutput.permissionDecision === "deny"
  );
}

function isAllowed(result) {
  return !isDenied(result);
}

function denyReason(result) {
  const obj = unwrap(result);
  return (
    obj &&
    obj.hookSpecificOutput &&
    obj.hookSpecificOutput.permissionDecisionReason
  );
}

// ---------------------------------------------------------------------------
// Read tool tests
// ---------------------------------------------------------------------------

console.log("\nRead tool tests:");

test("Read: small file is allowed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fg-test-"));
  const file = path.join(dir, "small.txt");
  try {
    fs.writeFileSync(file, "hello world");
    const result = runHook(HOOK, readInput(file));
    assert.ok(isAllowed(result), `Expected allow, got: ${JSON.stringify(result)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Read: 10MB exact is allowed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fg-test-"));
  const file = path.join(dir, "exact10mb.bin.txt");
  try {
    const buf = Buffer.alloc(10 * 1024 * 1024, 0x41); // 10MB of 'A'
    fs.writeFileSync(file, buf);
    const result = runHook(HOOK, readInput(file));
    assert.ok(isAllowed(result), `Expected allow at exactly 10MB, got: ${JSON.stringify(result)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Read: 10MB+1 is denied", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fg-test-"));
  const file = path.join(dir, "over10mb.txt");
  try {
    const buf = Buffer.alloc(10 * 1024 * 1024 + 1, 0x41);
    fs.writeFileSync(file, buf);
    const result = runHook(HOOK, readInput(file));
    assert.ok(isDenied(result), `Expected deny for oversized file, got: ${JSON.stringify(result)}`);
    assert.ok(
      denyReason(result).includes("10.0MB") || denyReason(result).includes("MB"),
      `Expected size in reason, got: ${denyReason(result)}`
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Read: binary extension .mp4 is denied", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fg-test-"));
  const file = path.join(dir, "video.mp4");
  try {
    fs.writeFileSync(file, "fake video content");
    const result = runHook(HOOK, readInput(file));
    assert.ok(isDenied(result), `Expected deny for .mp4, got: ${JSON.stringify(result)}`);
    assert.ok(
      denyReason(result).includes("binary extension"),
      `Expected 'binary extension' in reason, got: ${denyReason(result)}`
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Read: binary extension .arw is denied", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fg-test-"));
  const file = path.join(dir, "photo.arw");
  try {
    fs.writeFileSync(file, "fake raw photo");
    const result = runHook(HOOK, readInput(file));
    assert.ok(isDenied(result), `Expected deny for .arw, got: ${JSON.stringify(result)}`);
    assert.ok(
      denyReason(result).includes("binary extension"),
      `Expected 'binary extension' in reason, got: ${denyReason(result)}`
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Read: nonexistent file is allowed", () => {
  const filePath = path.join(os.tmpdir(), "fg-test-does-not-exist-" + Date.now() + ".txt");
  const result = runHook(HOOK, readInput(filePath));
  assert.ok(isAllowed(result), `Expected allow for missing file, got: ${JSON.stringify(result)}`);
});

test("Read: directory is denied", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fg-test-"));
  try {
    const result = runHook(HOOK, readInput(dir));
    assert.ok(isDenied(result), `Expected deny for directory, got: ${JSON.stringify(result)}`);
    assert.ok(
      denyReason(result).includes("directory"),
      `Expected 'directory' in reason, got: ${denyReason(result)}`
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Read: ~/.claude/ path is always allowed", () => {
  const { home, claudeDir, cleanup } = createTempHome();
  try {
    // Create an oversized file inside the ~/.claude/ dir
    const bigFile = path.join(claudeDir, "big-memory.md");
    const buf = Buffer.alloc(20 * 1024 * 1024, 0x41); // 20MB
    fs.writeFileSync(bigFile, buf);
    // Use tilde path so the allow-list check matches after tilde expansion
    const tildePath = "~/.claude/big-memory.md";
    const result = runHook(HOOK, readInput(tildePath), { HOME: home });
    assert.ok(isAllowed(result), `Expected ~/.claude/ to be always allowed, got: ${JSON.stringify(result)}`);
  } finally {
    cleanup();
  }
});

test("Read: .jpg is allowed when small", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fg-test-"));
  const file = path.join(dir, "photo.jpg");
  try {
    fs.writeFileSync(file, "fake jpeg data");
    const result = runHook(HOOK, readInput(file));
    assert.ok(isAllowed(result), `Expected .jpg to be allowed (multimodal), got: ${JSON.stringify(result)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Read: .pdf is allowed when small", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fg-test-"));
  const file = path.join(dir, "doc.pdf");
  try {
    fs.writeFileSync(file, "%PDF-1.4 fake content");
    const result = runHook(HOOK, readInput(file));
    assert.ok(isAllowed(result), `Expected .pdf to be allowed (text-extractable), got: ${JSON.stringify(result)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Read: .png is allowed when small", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fg-test-"));
  const file = path.join(dir, "image.png");
  try {
    fs.writeFileSync(file, "fake png data");
    const result = runHook(HOOK, readInput(file));
    assert.ok(isAllowed(result), `Expected .png to be allowed (multimodal), got: ${JSON.stringify(result)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Read: /dev/stdin is allowed", () => {
  const result = runHook(HOOK, readInput("/dev/stdin"));
  assert.ok(isAllowed(result), `Expected /dev/stdin to be allowed, got: ${JSON.stringify(result)}`);
});

test("Read: /proc/cpuinfo is allowed", () => {
  const result = runHook(HOOK, readInput("/proc/cpuinfo"));
  assert.ok(isAllowed(result), `Expected /proc/cpuinfo to be allowed, got: ${JSON.stringify(result)}`);
});

// ---------------------------------------------------------------------------
// Bash tool tests
// ---------------------------------------------------------------------------

console.log("\nBash tool tests:");

test("Bash: cat small file is allowed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fg-test-"));
  const file = path.join(dir, "small.txt");
  try {
    fs.writeFileSync(file, "hello");
    const result = runHook(HOOK, bashInput(`cat ${file}`));
    assert.ok(isAllowed(result), `Expected allow for cat small file, got: ${JSON.stringify(result)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Bash: cat oversized file is denied", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fg-test-"));
  const file = path.join(dir, "big.log");
  try {
    const buf = Buffer.alloc(15 * 1024 * 1024, 0x41); // 15MB
    fs.writeFileSync(file, buf);
    const result = runHook(HOOK, bashInput(`cat ${file}`));
    assert.ok(isDenied(result), `Expected deny for cat oversized file, got: ${JSON.stringify(result)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Bash: cat binary extension is denied", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fg-test-"));
  const file = path.join(dir, "clip.mp4");
  try {
    fs.writeFileSync(file, "fake video");
    const result = runHook(HOOK, bashInput(`cat ${file}`));
    assert.ok(isDenied(result), `Expected deny for cat .mp4, got: ${JSON.stringify(result)}`);
    assert.ok(
      denyReason(result).includes("binary extension"),
      `Expected 'binary extension' in reason, got: ${denyReason(result)}`
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Bash: cat with shell variable is allowed", () => {
  const result = runHook(HOOK, bashInput("cat $SOME_VAR"));
  assert.ok(isAllowed(result), `Expected allow for shell variable, got: ${JSON.stringify(result)}`);
});

test("Bash: cat /dev/stdin is allowed", () => {
  const result = runHook(HOOK, bashInput("cat /dev/stdin"));
  assert.ok(isAllowed(result), `Expected /dev/stdin to be allowed in bash, got: ${JSON.stringify(result)}`);
});

test("Bash: head oversized file is denied", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fg-test-"));
  const file = path.join(dir, "huge.txt");
  try {
    const buf = Buffer.alloc(15 * 1024 * 1024, 0x41);
    fs.writeFileSync(file, buf);
    const result = runHook(HOOK, bashInput(`head ${file}`));
    assert.ok(isDenied(result), `Expected deny for head on oversized file, got: ${JSON.stringify(result)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Bash: tail with flags allowed for small file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fg-test-"));
  const file = path.join(dir, "small.log");
  try {
    fs.writeFileSync(file, "line1\nline2\n");
    const result = runHook(HOOK, bashInput(`tail -n 200 ${file}`));
    assert.ok(isAllowed(result), `Expected allow for tail -n 200 on small file, got: ${JSON.stringify(result)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Bash: non-read commands are allowed", () => {
  const result = runHook(HOOK, bashInput("ls -la /tmp"));
  assert.ok(isAllowed(result), `Expected allow for ls, got: ${JSON.stringify(result)}`);
});

test("Bash: git commands are allowed", () => {
  const result = runHook(HOOK, bashInput("git status"));
  assert.ok(isAllowed(result), `Expected allow for git status, got: ${JSON.stringify(result)}`);
});

test("Bash: piped command checks first segment", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fg-test-"));
  const file = path.join(dir, "huge.log");
  try {
    const buf = Buffer.alloc(15 * 1024 * 1024, 0x41);
    fs.writeFileSync(file, buf);
    const result = runHook(HOOK, bashInput(`cat ${file} | head -10`));
    assert.ok(isDenied(result), `Expected deny for oversized file in piped cat, got: ${JSON.stringify(result)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// General tests
// ---------------------------------------------------------------------------

console.log("\nGeneral tests:");

test("malformed JSON input is allowed", () => {
  const result = runHookRaw(HOOK, "not valid json {{{{");
  assert.strictEqual(result.stdout.trim(), "{}", `Expected '{}' stdout for malformed input, got: ${result.stdout}`);
  assert.ok(isAllowed(result), `Expected allow for malformed JSON, got: ${result.stdout}`);
});

test("unknown tool is allowed", () => {
  const result = runHook(HOOK, makeInput("Write", { file_path: "/tmp/foo.txt", content: "hello" }));
  assert.ok(isAllowed(result), `Expected allow for Write tool, got: ${JSON.stringify(result)}`);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
