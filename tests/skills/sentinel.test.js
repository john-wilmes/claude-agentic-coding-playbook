#!/usr/bin/env node
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "skills", "read-sentinel.js");

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message });
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}

function run(args = []) {
  const out = execFileSync("node", [SCRIPT, ...args], { encoding: "utf8", timeout: 5000 });
  return out.trim();
}

function withTmpFile(content, fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-test-"));
  const tmpFile = path.join(tmpDir, "flag.json");
  try {
    fs.writeFileSync(tmpFile, content, "utf8");
    fn(tmpFile);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
    try { fs.rmdirSync(tmpDir); } catch {}
  }
}

console.log("read-sentinel.js");

test("file missing → STAY", () => {
  const result = run(["/nonexistent/path/to/flag.json"]);
  assert.strictEqual(result, "STAY");
});

test("high ratio + recent → EXIT", () => {
  withTmpFile(JSON.stringify({ ratio: 0.7, timestamp: Date.now() }), (tmpFile) => {
    const result = run([tmpFile]);
    assert.strictEqual(result, "EXIT");
  });
});

test("low ratio → STAY", () => {
  withTmpFile(JSON.stringify({ ratio: 0.3, timestamp: Date.now() }), (tmpFile) => {
    const result = run([tmpFile]);
    assert.strictEqual(result, "STAY");
  });
});

test("old timestamp → STAY", () => {
  withTmpFile(JSON.stringify({ ratio: 0.8, timestamp: Date.now() - 700000 }), (tmpFile) => {
    const result = run([tmpFile]);
    assert.strictEqual(result, "STAY");
  });
});

test("malformed JSON → STAY", () => {
  withTmpFile("not json", (tmpFile) => {
    const result = run([tmpFile]);
    assert.strictEqual(result, "STAY");
  });
});

test("boundary ratio 0.5 → EXIT", () => {
  withTmpFile(JSON.stringify({ ratio: 0.5, timestamp: Date.now() }), (tmpFile) => {
    const result = run([tmpFile]);
    assert.strictEqual(result, "EXIT");
  });
});

test("no argument → STAY", () => {
  const result = run([]);
  assert.strictEqual(result, "STAY");
});

test("ratio just below 0.5 → STAY", () => {
  withTmpFile(JSON.stringify({ ratio: 0.49, timestamp: Date.now() }), (tmpFile) => {
    const result = run([tmpFile]);
    assert.strictEqual(result, "STAY");
  });
});

console.log("");
if (failed === 0) {
  console.log(`All ${passed} tests passed.`);
} else {
  console.log(`${passed} passed, ${failed} failed.`);
  process.exit(1);
}
