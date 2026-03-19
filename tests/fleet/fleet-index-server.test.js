#!/usr/bin/env node
// Integration tests for templates/mcp/fleet-index-server.js
// Zero dependencies — uses only Node built-ins.
//
// Run: node tests/fleet/fleet-index-server.test.js

"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

const SERVER_PATH = path.join(__dirname, "..", "..", "templates", "mcp", "fleet-index-server.js");

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

// ─── RPC helper ───────────────────────────────────────────────────────────────

/**
 * Send one or more JSON-RPC requests to the server and collect responses.
 * Each request is a line of JSON. The server reads line-by-line.
 */
function rpcCall(requests, env = {}) {
  const input = requests.map(r => JSON.stringify(r)).join("\n") + "\n";
  const baseEnv = { ...process.env };
  const result = spawnSync("node", [SERVER_PATH], {
    input,
    env: { ...baseEnv, ...env },
    timeout: 10000,
    encoding: "utf8",
  });
  // Parse each line of stdout as a JSON-RPC response
  const responses = (result.stdout || "")
    .split("\n")
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
  return { responses, stderr: result.stderr || "", status: result.status };
}

const INIT_REQUEST = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test" },
  },
};

// ─── Tests ────────────────────────────────────────────────────────────────────

console.log("\nfleet-index-server.js:");

test("1. initialize returns protocol version 2025-03-26", () => {
  const { responses } = rpcCall([INIT_REQUEST]);
  assert.ok(responses.length >= 1, "should receive at least one response");
  const init = responses[0];
  assert.ok(init.result, "response should have result");
  assert.strictEqual(
    init.result.protocolVersion,
    "2025-03-26",
    `protocolVersion should be 2025-03-26, got: ${init.result.protocolVersion}`
  );
});

test("2. initialize returns resources capability", () => {
  const { responses } = rpcCall([INIT_REQUEST]);
  const init = responses[0];
  assert.ok(init.result && init.result.capabilities, "response should have capabilities");
  assert.ok("tools" in init.result.capabilities, "capabilities should include tools key");
  assert.ok("resources" in init.result.capabilities, "capabilities should include resources key");
});

test("3. tools/list still returns tools (backward compat)", () => {
  const { responses } = rpcCall([
    INIT_REQUEST,
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ]);
  // Find the tools/list response (id: 2)
  const toolsResp = responses.find(r => r.id === 2);
  assert.ok(toolsResp, "should receive tools/list response");
  assert.ok(toolsResp.result, "tools/list response should have result");
  assert.ok(Array.isArray(toolsResp.result.tools), "result.tools should be an array");
  assert.ok(toolsResp.result.tools.length > 0, "tools array should be non-empty");
});

test("4. resources/list includes digest resource", () => {
  const { responses } = rpcCall([
    INIT_REQUEST,
    { jsonrpc: "2.0", id: 2, method: "resources/list", params: {} },
  ]);
  const listResp = responses.find(r => r.id === 2);
  assert.ok(listResp, "should receive resources/list response");
  assert.ok(listResp.result, "resources/list response should have result");
  assert.ok(Array.isArray(listResp.result.resources), "result.resources should be an array");
  const digestResource = listResp.result.resources.find(r => r.uri === "fleet://digest");
  assert.ok(digestResource, "resources should include fleet://digest");
  assert.strictEqual(digestResource.mimeType, "text/plain", "digest resource should be text/plain");
});

test("5. resources/list includes manifest resources", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-server-test-"));
  try {
    const manifestsDir = path.join(tmpDir, "manifests");
    fs.mkdirSync(manifestsDir, { recursive: true });
    fs.writeFileSync(path.join(manifestsDir, "test-repo.json"), JSON.stringify({
      repo: "org/test-repo",
      description: "A test repository",
      language: "javascript",
      kind: "library",
    }));

    const { responses } = rpcCall([
      INIT_REQUEST,
      { jsonrpc: "2.0", id: 2, method: "resources/list", params: {} },
    ], { FLEET_MANIFESTS_DIR: manifestsDir });

    const listResp = responses.find(r => r.id === 2);
    assert.ok(listResp, "should receive resources/list response");
    assert.ok(Array.isArray(listResp.result.resources), "result.resources should be an array");
    const manifestResource = listResp.result.resources.find(r => r.uri === "fleet://manifest/org/test-repo");
    assert.ok(manifestResource, "resources should include fleet://manifest/org/test-repo");
    assert.strictEqual(manifestResource.mimeType, "application/json", "manifest resource should be application/json");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("6. resources/read returns digest content", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-server-test-"));
  try {
    const digestFile = path.join(tmpDir, "fleet-digest.txt");
    fs.writeFileSync(digestFile, "org/test-repo  library  javascript  A test repository\n");

    const { responses } = rpcCall([
      INIT_REQUEST,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "resources/read",
        params: { uri: "fleet://digest" },
      },
    ], { FLEET_DIGEST_FILE: digestFile });

    const readResp = responses.find(r => r.id === 2);
    assert.ok(readResp, "should receive resources/read response");
    assert.ok(readResp.result, "resources/read response should have result");
    assert.ok(Array.isArray(readResp.result.contents), "result.contents should be an array");
    assert.ok(readResp.result.contents.length > 0, "contents should be non-empty");
    const content = readResp.result.contents[0];
    assert.strictEqual(content.mimeType, "text/plain", "content mimeType should be text/plain");
    assert.ok(
      content.text.includes("org/test-repo"),
      `content text should include repo name, got: ${content.text}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("7. resources/read returns error for unknown URI", () => {
  const { responses } = rpcCall([
    INIT_REQUEST,
    {
      jsonrpc: "2.0",
      id: 2,
      method: "resources/read",
      params: { uri: "fleet://unknown" },
    },
  ]);
  const readResp = responses.find(r => r.id === 2);
  assert.ok(readResp, "should receive resources/read response");
  assert.ok(readResp.error, "response should have error for unknown URI");
  assert.strictEqual(readResp.error.code, -32602, "error code should be -32602 (invalid params)");
  assert.ok(
    readResp.error.message.includes("fleet://unknown"),
    `error message should mention the unknown URI, got: ${readResp.error.message}`
  );
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
