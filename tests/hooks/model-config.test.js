#!/usr/bin/env node
// Unit tests for model-config.js shared module.
// Zero dependencies — uses only Node built-ins.
//
// Run: node tests/hooks/model-config.test.js

"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

// Resolve module path relative to repo root
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const modelConfig = require(path.join(REPO_ROOT, "templates", "hooks", "model-config.js"));

const { getModelConfig, saveSessionModel, getSessionModel, DEFAULT_CONFIG, MODEL_DB } = modelConfig;

// State directory used by the module
const STATE_DIR = path.join(os.tmpdir(), "claude-model-config");

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function newSessionId() {
  return `test-${crypto.randomUUID()}`;
}

function cleanupSession(sessionId) {
  const stateFile = path.join(STATE_DIR, `${sessionId}.json`);
  try { fs.rmSync(stateFile, { force: true }); } catch {}
}

// ─── getModelConfig tests ─────────────────────────────────────────────────────

console.log("\nmodel-config.js — getModelConfig:");

test("opus model returns contextWindow 1_000_000, costTier 5, displayName Opus", () => {
  const cfg = getModelConfig("claude-opus-4-6");
  assert.strictEqual(cfg.contextWindow, 1_000_000);
  assert.strictEqual(cfg.costTier, 5);
  assert.strictEqual(cfg.displayName, "Opus");
});

test("sonnet model returns contextWindow 200_000, costTier 3, displayName Sonnet", () => {
  const cfg = getModelConfig("claude-sonnet-4-6");
  assert.strictEqual(cfg.contextWindow, 200_000);
  assert.strictEqual(cfg.costTier, 3);
  assert.strictEqual(cfg.displayName, "Sonnet");
});

test("haiku model returns contextWindow 200_000, costTier 1, displayName Haiku", () => {
  const cfg = getModelConfig("claude-haiku-4-5");
  assert.strictEqual(cfg.contextWindow, 200_000);
  assert.strictEqual(cfg.costTier, 1);
  assert.strictEqual(cfg.displayName, "Haiku");
});

test("empty string returns DEFAULT_CONFIG", () => {
  const cfg = getModelConfig("");
  assert.deepStrictEqual(cfg, DEFAULT_CONFIG);
});

test("unrecognized model string returns DEFAULT_CONFIG", () => {
  const cfg = getModelConfig("some-future-model");
  assert.deepStrictEqual(cfg, DEFAULT_CONFIG);
});

test("null returns DEFAULT_CONFIG", () => {
  const cfg = getModelConfig(null);
  assert.deepStrictEqual(cfg, DEFAULT_CONFIG);
});

test("undefined returns DEFAULT_CONFIG", () => {
  const cfg = getModelConfig(undefined);
  assert.deepStrictEqual(cfg, DEFAULT_CONFIG);
});

test("DEFAULT_CONFIG has contextWindow 200_000, costTier 3, displayName Unknown", () => {
  assert.strictEqual(DEFAULT_CONFIG.contextWindow, 200_000);
  assert.strictEqual(DEFAULT_CONFIG.costTier, 3);
  assert.strictEqual(DEFAULT_CONFIG.displayName, "Unknown");
});

test("MODEL_DB is an array with at least 3 entries", () => {
  assert.ok(Array.isArray(MODEL_DB));
  assert.ok(MODEL_DB.length >= 3);
});

test("opus pattern is case-insensitive — OPUS matches", () => {
  const cfg = getModelConfig("CLAUDE-OPUS-4");
  assert.strictEqual(cfg.displayName, "Opus");
});

test("getModelConfig returns a plain object (not the MODEL_DB entry itself)", () => {
  const cfg = getModelConfig("claude-opus-4-6");
  // Should not have a `pattern` field — it's a derived plain object
  assert.ok(!("pattern" in cfg), "Should not expose pattern from MODEL_DB");
});

// ─── saveSessionModel / getSessionModel tests ─────────────────────────────────

console.log("\nmodel-config.js — saveSessionModel / getSessionModel:");

test("round-trip: save opus, read back as Opus config", () => {
  const sessionId = newSessionId();
  try {
    saveSessionModel(sessionId, "claude-opus-4-6");
    const cfg = getSessionModel(sessionId);
    assert.strictEqual(cfg.contextWindow, 1_000_000);
    assert.strictEqual(cfg.costTier, 5);
    assert.strictEqual(cfg.displayName, "Opus");
  } finally {
    cleanupSession(sessionId);
  }
});

test("round-trip: save sonnet, read back as Sonnet config", () => {
  const sessionId = newSessionId();
  try {
    saveSessionModel(sessionId, "claude-sonnet-4-6");
    const cfg = getSessionModel(sessionId);
    assert.strictEqual(cfg.contextWindow, 200_000);
    assert.strictEqual(cfg.costTier, 3);
    assert.strictEqual(cfg.displayName, "Sonnet");
  } finally {
    cleanupSession(sessionId);
  }
});

test("round-trip: save haiku, read back as Haiku config", () => {
  const sessionId = newSessionId();
  try {
    saveSessionModel(sessionId, "claude-haiku-4-5");
    const cfg = getSessionModel(sessionId);
    assert.strictEqual(cfg.contextWindow, 200_000);
    assert.strictEqual(cfg.costTier, 1);
    assert.strictEqual(cfg.displayName, "Haiku");
  } finally {
    cleanupSession(sessionId);
  }
});

test("getSessionModel with nonexistent session returns DEFAULT_CONFIG", () => {
  const sessionId = newSessionId();
  // Do NOT save anything — file won't exist
  const cfg = getSessionModel(sessionId);
  assert.deepStrictEqual(cfg, DEFAULT_CONFIG);
});

test("getSessionModel with null sessionId returns DEFAULT_CONFIG", () => {
  const cfg = getSessionModel(null);
  assert.deepStrictEqual(cfg, DEFAULT_CONFIG);
});

test("saveSessionModel with null sessionId is a no-op (does not throw)", () => {
  // Should silently return without writing anything
  assert.doesNotThrow(() => saveSessionModel(null, "claude-opus-4-6"));
});

test("state files go to /tmp/claude-model-config/", () => {
  const sessionId = newSessionId();
  try {
    saveSessionModel(sessionId, "claude-sonnet-4-6");
    const expectedFile = path.join(os.tmpdir(), "claude-model-config", `${sessionId}.json`);
    assert.ok(fs.existsSync(expectedFile), `State file should exist at ${expectedFile}`);
    const raw = JSON.parse(fs.readFileSync(expectedFile, "utf8"));
    assert.strictEqual(raw.modelId, "claude-sonnet-4-6");
    assert.ok(typeof raw.savedAt === "number", "savedAt should be a number (timestamp)");
  } finally {
    cleanupSession(sessionId);
  }
});

test("overwrite: save opus then sonnet, reads back as Sonnet", () => {
  const sessionId = newSessionId();
  try {
    saveSessionModel(sessionId, "claude-opus-4-6");
    saveSessionModel(sessionId, "claude-sonnet-4-6");
    const cfg = getSessionModel(sessionId);
    assert.strictEqual(cfg.displayName, "Sonnet");
  } finally {
    cleanupSession(sessionId);
  }
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed\n`);

if (failures.length > 0) {
  console.log("FAILURES:");
  for (const f of failures) {
    console.log(`  - ${f.name}: ${f.error}`);
  }
  process.exit(1);
}
