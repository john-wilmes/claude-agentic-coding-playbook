#!/usr/bin/env node
// Unit tests for auto-promote helpers in templates/hooks/session-end.js
// Zero dependencies — uses only Node built-ins.
//
// Run: node tests/hooks/session-end-promote.test.js

"use strict";

const assert = require("assert");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const HOOK_MODULE = path.join(REPO_ROOT, "templates", "hooks", "session-end.js");

// ─── Test runner ──────────────────────────────────────────────────────────────

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

// ─── Load helpers ─────────────────────────────────────────────────────────────

let _mapStagedToEntry;
let _generateEntryId;

try {
  const mod = require(HOOK_MODULE);
  _mapStagedToEntry = mod._mapStagedToEntry;
  _generateEntryId = mod._generateEntryId;
} catch (err) {
  console.error(`Failed to load ${HOOK_MODULE}: ${err.message}`);
  process.exit(1);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

console.log("\nsession-end-promote (auto-promote helpers):");

// Test 1: _mapStagedToEntry with valid input returns a well-formed entry
test("1. _mapStagedToEntry with valid input returns a well-formed entry", () => {
  const row = {
    summary: "Use execFileSync not exec to avoid shell injection",
    context_snippet: "When spawning subprocesses, prefer execFileSync over exec.",
    trigger: "shell-injection",
    category: "security",
    confidence: "high",
    source_project: "myproject",
    cwd: "/home/user/myproject",
    tool: "Bash",
  };

  const result = _mapStagedToEntry(row);

  assert.ok(result !== null, "Should return non-null for valid input");
  assert.strictEqual(typeof result.title, "string", "title should be a string");
  assert.ok(result.title.length > 0, "title should be non-empty");
  assert.strictEqual(result.title, row.summary.slice(0, 120), "title should be derived from summary");
  assert.ok(result.body.includes(row.context_snippet), "body should contain context_snippet");
  assert.ok(result.body.includes(row.trigger), "body should include trigger prefix");
  assert.ok(Array.isArray(result.tags), "tags should be an array");
  assert.ok(result.tags.includes("security"), "tags should include category");
  assert.ok(result.tags.includes("shell-injection"), "tags should include trigger");
  assert.ok(result.tags.includes("high"), "tags should include confidence when not 'medium'");
  assert.strictEqual(result.tool, "Bash", "tool should be preserved");
  assert.strictEqual(result.project, "myproject", "project should be preserved");
  assert.strictEqual(result.source, "/home/user/myproject", "source should be cwd");
  assert.strictEqual(result.category, "security", "category should be preserved");
  assert.strictEqual(result.confidence, "high", "confidence should be preserved");
});

// Test 2: _mapStagedToEntry with empty summary and empty snippet returns null
test("2. _mapStagedToEntry returns null when both summary and snippet are empty", () => {
  const row = {
    summary: "",
    context_snippet: "",
    trigger: "some-trigger",
    category: "pattern",
    confidence: "medium",
    source_project: "",
    cwd: "",
    tool: "Read",
  };

  const result = _mapStagedToEntry(row);
  assert.strictEqual(result, null, "Should return null when both summary and snippet are empty");
});

// Test 3: _mapStagedToEntry returns null when snippet is absent (summary alone is insufficient)
test("3. _mapStagedToEntry returns null when snippet is missing even if summary is present", () => {
  const row = {
    summary: "Some useful summary",
    context_snippet: "",
    trigger: null,
    category: "pattern",
    confidence: "medium",
    source_project: "",
    cwd: "",
    tool: "",
  };

  const result = _mapStagedToEntry(row);
  assert.strictEqual(result, null, "Should return null when context_snippet is empty");
});

// Test 4: _generateEntryId produces correct YYYYMMDD-slug format
test("4. _generateEntryId produces correct YYYYMMDD-slug format", () => {
  const id = _generateEntryId("Use execFileSync not exec");

  // Must match YYYYMMDD-slug pattern
  assert.ok(/^\d{8}-/.test(id), `ID should start with 8-digit date, got: ${id}`);

  const datePart = id.slice(0, 8);
  const year = parseInt(datePart.slice(0, 4), 10);
  const month = parseInt(datePart.slice(4, 6), 10);
  const day = parseInt(datePart.slice(6, 8), 10);
  assert.ok(year >= 2024, `Year should be >= 2024, got ${year}`);
  assert.ok(month >= 1 && month <= 12, `Month should be 1-12, got ${month}`);
  assert.ok(day >= 1 && day <= 31, `Day should be 1-31, got ${day}`);

  const slugPart = id.slice(9);
  assert.ok(slugPart.length > 0, "Slug part should be non-empty");
  assert.ok(/^[a-z0-9-]+$/.test(slugPart), `Slug should be lowercase alphanumeric with hyphens, got: ${slugPart}`);
  assert.ok(slugPart.includes("execfilesync"), "Slug should include normalized title text");
});

// Test 5: _generateEntryId truncates long titles to 40 chars in slug
test("5. _generateEntryId slug is at most 40 characters", () => {
  const longTitle = "this is a very long title that should be truncated because it exceeds forty characters for sure";
  const id = _generateEntryId(longTitle);
  const slugPart = id.slice(9); // after YYYYMMDD-
  assert.ok(slugPart.length <= 40, `Slug should be <= 40 chars, got ${slugPart.length}: ${slugPart}`);
});

// Test 6: _mapStagedToEntry omits 'medium' confidence from tags
test("6. _mapStagedToEntry does not add 'medium' confidence to tags", () => {
  const row = {
    summary: "Avoid using rm -rf in scripts",
    context_snippet: "Always use safer deletion patterns.",
    trigger: null,
    category: "pattern",
    confidence: "medium",
    source_project: "",
    cwd: "",
    tool: "Bash",
  };

  const result = _mapStagedToEntry(row);
  assert.ok(result !== null, "Should return non-null for valid input");
  assert.ok(!result.tags.includes("medium"), "Should not add 'medium' confidence to tags");
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed (${passed + failed} total)`);

if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) {
    console.log(`  \u2717 ${f.name}: ${f.error}`);
  }
}

process.exit(failed > 0 ? 1 : 0);
