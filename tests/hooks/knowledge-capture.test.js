#!/usr/bin/env node
// Integration tests for knowledge-capture.js shared module.
// Zero dependencies — uses only Node built-ins + local test-helpers.
//
// Run: node tests/hooks/knowledge-capture.test.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const { createTempHome } = require("./test-helpers");

// Resolve module path relative to repo root
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const MODULE_PATH = path.join(REPO_ROOT, "templates", "hooks", "knowledge-capture.js");

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

/**
 * Load knowledge-capture module with STAGED_DIR overridden to a temp location.
 * We reload the module fresh for each env so the STAGED_DIR constant picks up
 * the overridden HOME.
 *
 * @param {string} home - Temp HOME directory
 * @returns {{ stageCandidate, readStagedCandidates, clearStagedCandidates, pruneStagedFiles, STAGED_DIR }}
 */
function loadModule(home) {
  // Patch os.homedir for the duration of this require by clearing the cache,
  // temporarily overriding HOME, reloading, then restoring.
  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;

  // Clear the module cache so os.homedir() is re-evaluated
  delete require.cache[require.resolve("os")];
  delete require.cache[require.resolve(MODULE_PATH)];

  let mod;
  try {
    mod = require(MODULE_PATH);
  } finally {
    process.env.HOME = origHome !== undefined ? origHome : "";
    if (origUserProfile !== undefined) process.env.USERPROFILE = origUserProfile;
    else delete process.env.USERPROFILE;
    // Restore os cache
    delete require.cache[require.resolve("os")];
  }

  return mod;
}

/**
 * Build a minimal valid candidate object.
 */
function makeCandidate(sessionId, overrides = {}) {
  return {
    session_id: sessionId,
    trigger: "test-fix",
    tool: "Bash",
    category: "gotcha",
    confidence: "medium",
    summary: "Test failed: expected 1 got 2",
    context_snippet: "assert.strictEqual(1, 2)",
    source_project: "my-project",
    cwd: "/home/user/my-project",
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

console.log("\nknowledge-capture.js:");

// Test 1: stageCandidate creates staged directory if missing
test("1. stageCandidate creates staged directory if missing", () => {
  const env = createTempHome();
  try {
    const mod = loadModule(env.home);
    const sessionId = newSessionId();

    // Staged dir should not exist yet
    assert.ok(!fs.existsSync(mod.STAGED_DIR), "Staged dir should not exist before first call");

    mod.stageCandidate(makeCandidate(sessionId));

    assert.ok(fs.existsSync(mod.STAGED_DIR), "Staged dir should be created");
  } finally {
    env.cleanup();
  }
});

// Test 2: stageCandidate appends JSON line to correct file
test("2. stageCandidate appends JSON line to correct file", () => {
  const env = createTempHome();
  try {
    const mod = loadModule(env.home);
    const sessionId = newSessionId();
    const candidate = makeCandidate(sessionId, { summary: "unique-summary-abc" });

    mod.stageCandidate(candidate);

    const filePath = path.join(mod.STAGED_DIR, `${sessionId}.jsonl`);
    assert.ok(fs.existsSync(filePath), "JSONL file should exist after stageCandidate");

    const content = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(content.trim());
    assert.strictEqual(parsed.summary, "unique-summary-abc", "Summary should be stored");
    assert.ok(parsed.ts, "Timestamp should be present");
    assert.strictEqual(parsed.session_id, sessionId, "session_id should be stored");
  } finally {
    env.cleanup();
  }
});

// Test 3: stageCandidate uses session_id for filename
test("3. stageCandidate uses session_id for filename", () => {
  const env = createTempHome();
  try {
    const mod = loadModule(env.home);
    const sessionA = newSessionId();
    const sessionB = newSessionId();

    mod.stageCandidate(makeCandidate(sessionA));
    mod.stageCandidate(makeCandidate(sessionB));

    const fileA = path.join(mod.STAGED_DIR, `${sessionA}.jsonl`);
    const fileB = path.join(mod.STAGED_DIR, `${sessionB}.jsonl`);
    assert.ok(fs.existsSync(fileA), "File for sessionA should exist");
    assert.ok(fs.existsSync(fileB), "File for sessionB should exist");

    // Each file should only contain its own session's entries
    const parsedA = JSON.parse(fs.readFileSync(fileA, "utf8").trim());
    assert.strictEqual(parsedA.session_id, sessionA, "FileA should contain sessionA entry");
    const parsedB = JSON.parse(fs.readFileSync(fileB, "utf8").trim());
    assert.strictEqual(parsedB.session_id, sessionB, "FileB should contain sessionB entry");
  } finally {
    env.cleanup();
  }
});

// Test 4: readStagedCandidates returns parsed array
test("4. readStagedCandidates returns parsed array", () => {
  const env = createTempHome();
  try {
    const mod = loadModule(env.home);
    const sessionId = newSessionId();

    mod.stageCandidate(makeCandidate(sessionId, { summary: "first" }));
    mod.stageCandidate(makeCandidate(sessionId, { summary: "second" }));
    mod.stageCandidate(makeCandidate(sessionId, { summary: "third" }));

    const candidates = mod.readStagedCandidates(sessionId);
    assert.strictEqual(candidates.length, 3, "Should return all 3 staged candidates");
    assert.strictEqual(candidates[0].summary, "first", "First entry should match");
    assert.strictEqual(candidates[1].summary, "second", "Second entry should match");
    assert.strictEqual(candidates[2].summary, "third", "Third entry should match");
  } finally {
    env.cleanup();
  }
});

// Test 5: readStagedCandidates returns [] for missing file
test("5. readStagedCandidates returns [] for missing file", () => {
  const env = createTempHome();
  try {
    const mod = loadModule(env.home);
    const sessionId = newSessionId();

    const result = mod.readStagedCandidates(sessionId);
    assert.ok(Array.isArray(result), "Should return an array");
    assert.strictEqual(result.length, 0, "Should return empty array for missing file");
  } finally {
    env.cleanup();
  }
});

// Test 6: clearStagedCandidates deletes the file
test("6. clearStagedCandidates deletes the file", () => {
  const env = createTempHome();
  try {
    const mod = loadModule(env.home);
    const sessionId = newSessionId();

    mod.stageCandidate(makeCandidate(sessionId));

    const filePath = path.join(mod.STAGED_DIR, `${sessionId}.jsonl`);
    assert.ok(fs.existsSync(filePath), "File should exist before clear");

    mod.clearStagedCandidates(sessionId);

    assert.ok(!fs.existsSync(filePath), "File should be deleted after clear");
  } finally {
    env.cleanup();
  }
});

// Test 7: clearStagedCandidates does not throw for missing file
test("7. clearStagedCandidates does not throw for missing file", () => {
  const env = createTempHome();
  try {
    const mod = loadModule(env.home);
    const sessionId = newSessionId();

    // File was never created — should not throw
    assert.doesNotThrow(() => {
      mod.clearStagedCandidates(sessionId);
    }, "clearStagedCandidates should not throw for missing file");
  } finally {
    env.cleanup();
  }
});

// Test 8: pruneStagedFiles deletes old files, keeps recent ones
test("8. pruneStagedFiles deletes old files, keeps recent ones", () => {
  const env = createTempHome();
  try {
    const mod = loadModule(env.home);

    // Write two files directly into the staged dir
    fs.mkdirSync(mod.STAGED_DIR, { recursive: true });

    const oldFile = path.join(mod.STAGED_DIR, "old-session.jsonl");
    const newFile = path.join(mod.STAGED_DIR, "new-session.jsonl");

    fs.writeFileSync(oldFile, '{"session_id":"old-session"}\n', "utf8");
    fs.writeFileSync(newFile, '{"session_id":"new-session"}\n', "utf8");

    // Back-date the old file to 10 days ago
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldFile, tenDaysAgo, tenDaysAgo);

    // Prune files older than 5 days
    mod.pruneStagedFiles(5);

    assert.ok(!fs.existsSync(oldFile), "Old file (10 days) should be deleted");
    assert.ok(fs.existsSync(newFile), "Recent file should be kept");
  } finally {
    env.cleanup();
  }
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
