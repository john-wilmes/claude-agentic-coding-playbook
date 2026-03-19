#!/usr/bin/env node
// Validates templates/registry/mcp-servers.json structure.
// Zero dependencies — uses only Node built-ins.
//
// Run: node tests/hooks/mcp-servers.test.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const REGISTRY_PATH = path.join(REPO_ROOT, "templates", "registry", "mcp-servers.json");

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

console.log("\nmcp-servers.json:");

let registry;

test("1. File exists", () => {
  assert.ok(fs.existsSync(REGISTRY_PATH), `Registry file not found at ${REGISTRY_PATH}`);
});

test("2. File is valid JSON", () => {
  const content = fs.readFileSync(REGISTRY_PATH, "utf8");
  registry = JSON.parse(content); // throws on invalid JSON
  assert.ok(registry !== null && typeof registry === "object", "Registry should be a JSON object");
});

test("3. Registry has at least one entry", () => {
  const keys = Object.keys(registry);
  assert.ok(keys.length > 0, "Registry should have at least one MCP server entry");
});

test("4. Every entry has required field: config", () => {
  const missing = [];
  for (const [name, entry] of Object.entries(registry)) {
    if (!entry.config || typeof entry.config !== "object") {
      missing.push(name);
    }
  }
  assert.deepStrictEqual(missing, [], `Entries missing 'config': ${missing.join(", ")}`);
});

test("5. Every entry has required field: description", () => {
  const missing = [];
  for (const [name, entry] of Object.entries(registry)) {
    if (!entry.description || typeof entry.description !== "string") {
      missing.push(name);
    }
  }
  assert.deepStrictEqual(missing, [], `Entries missing 'description': ${missing.join(", ")}`);
});

test("6. Every config has a command or type field (stdio vs http transport)", () => {
  const invalid = [];
  for (const [name, entry] of Object.entries(registry)) {
    const cfg = entry.config;
    if (!cfg.command && !cfg.type) {
      invalid.push(name);
    }
  }
  assert.deepStrictEqual(invalid, [], `Configs missing 'command' or 'type': ${invalid.join(", ")}`);
});

test("7. Every entry has env_required field (array)", () => {
  const invalid = [];
  for (const [name, entry] of Object.entries(registry)) {
    if (!Array.isArray(entry.env_required)) {
      invalid.push(name);
    }
  }
  assert.deepStrictEqual(invalid, [], `Entries with non-array 'env_required': ${invalid.join(", ")}`);
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
