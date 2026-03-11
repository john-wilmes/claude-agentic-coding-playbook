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

// Resolve module paths relative to repo root
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const MODULE_PATH = path.join(REPO_ROOT, "templates", "hooks", "knowledge-capture.js");
const DB_MODULE_PATH = path.join(REPO_ROOT, "templates", "hooks", "knowledge-db.js");

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
 * Load knowledge-capture module with HOME overridden to a temp location.
 * Clears both knowledge-capture and knowledge-db from require cache so
 * os.homedir() is re-evaluated with the patched HOME.
 *
 * @param {string} home - Temp HOME directory
 * @returns {{ stageCandidate, readStagedCandidates, clearStagedCandidates, pruneStagedFiles, STAGED_DIR, DB_PATH }}
 */
function loadModule(home) {
  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;

  // Clear module caches so os.homedir() and DB paths are re-evaluated
  delete require.cache[require.resolve("os")];
  delete require.cache[require.resolve(MODULE_PATH)];
  try { delete require.cache[require.resolve(DB_MODULE_PATH)]; } catch {}

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

// Test 1: stageCandidate succeeds without throwing
test("1. stageCandidate succeeds without throwing", () => {
  const env = createTempHome();
  try {
    const mod = loadModule(env.home);
    const sessionId = newSessionId();

    assert.doesNotThrow(() => {
      mod.stageCandidate(makeCandidate(sessionId));
    }, "stageCandidate should not throw");

    // Verify entry is retrievable — confirms storage was written
    const results = mod.readStagedCandidates(sessionId);
    assert.strictEqual(results.length, 1, "Should have 1 staged candidate after staging");
  } finally {
    env.cleanup();
  }
});

// Test 2: stageCandidate stores data correctly (round-trip)
test("2. stageCandidate stores data correctly (round-trip)", () => {
  const env = createTempHome();
  try {
    const mod = loadModule(env.home);
    const sessionId = newSessionId();
    const candidate = makeCandidate(sessionId, { summary: "unique-summary-abc" });

    mod.stageCandidate(candidate);

    const results = mod.readStagedCandidates(sessionId);
    assert.strictEqual(results.length, 1, "Should have exactly 1 staged candidate");
    const stored = results[0];
    assert.strictEqual(stored.summary, "unique-summary-abc", "Summary should be stored");
    assert.ok(stored.ts, "Timestamp should be present");
    assert.strictEqual(stored.session_id, sessionId, "session_id should be stored");
  } finally {
    env.cleanup();
  }
});

// Test 3: different session_ids are isolated
test("3. different session_ids are isolated", () => {
  const env = createTempHome();
  try {
    const mod = loadModule(env.home);
    const sessionA = newSessionId();
    const sessionB = newSessionId();

    mod.stageCandidate(makeCandidate(sessionA, { summary: "entry-for-A" }));
    mod.stageCandidate(makeCandidate(sessionB, { summary: "entry-for-B" }));

    const resultsA = mod.readStagedCandidates(sessionA);
    const resultsB = mod.readStagedCandidates(sessionB);

    assert.strictEqual(resultsA.length, 1, "Session A should have exactly 1 candidate");
    assert.strictEqual(resultsB.length, 1, "Session B should have exactly 1 candidate");
    assert.strictEqual(resultsA[0].session_id, sessionA, "Session A entry should have correct session_id");
    assert.strictEqual(resultsB[0].session_id, sessionB, "Session B entry should have correct session_id");
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

// Test 5: readStagedCandidates returns [] for unknown session
test("5. readStagedCandidates returns [] for unknown session", () => {
  const env = createTempHome();
  try {
    const mod = loadModule(env.home);
    const sessionId = newSessionId();

    const result = mod.readStagedCandidates(sessionId);
    assert.ok(Array.isArray(result), "Should return an array");
    assert.strictEqual(result.length, 0, "Should return empty array for unknown session");
  } finally {
    env.cleanup();
  }
});

// Test 6: clearStagedCandidates removes entries for the session
test("6. clearStagedCandidates removes entries for the session", () => {
  const env = createTempHome();
  try {
    const mod = loadModule(env.home);
    const sessionId = newSessionId();

    mod.stageCandidate(makeCandidate(sessionId));
    assert.strictEqual(mod.readStagedCandidates(sessionId).length, 1, "Should have 1 entry before clear");

    mod.clearStagedCandidates(sessionId);

    assert.strictEqual(mod.readStagedCandidates(sessionId).length, 0, "Should have 0 entries after clear");
  } finally {
    env.cleanup();
  }
});

// Test 7: clearStagedCandidates does not throw for missing session
test("7. clearStagedCandidates does not throw for missing session", () => {
  const env = createTempHome();
  try {
    const mod = loadModule(env.home);
    const sessionId = newSessionId();

    // Session was never staged — should not throw
    assert.doesNotThrow(() => {
      mod.clearStagedCandidates(sessionId);
    }, "clearStagedCandidates should not throw for missing session");
  } finally {
    env.cleanup();
  }
});

// Test 8: pruneStagedFiles deletes old rows, keeps recent ones
test("8. pruneStagedFiles deletes old rows, keeps recent ones", () => {
  const env = createTempHome();
  try {
    const mod = loadModule(env.home);

    const oldSession = newSessionId();
    const newSession = newSessionId();

    if (mod.DB_PATH) {
      // DB-backed path: insert an old-ts row directly via knowledge-db, then stage a recent one
      // Re-require knowledge-db with same HOME so it uses the same DB file
      const origHome = process.env.HOME;
      const origUserProfile = process.env.USERPROFILE;
      process.env.HOME = env.home;
      process.env.USERPROFILE = env.home;
      delete require.cache[require.resolve("os")];
      delete require.cache[require.resolve(DB_MODULE_PATH)];
      let kdb;
      try {
        kdb = require(DB_MODULE_PATH);
      } finally {
        process.env.HOME = origHome !== undefined ? origHome : "";
        if (origUserProfile !== undefined) process.env.USERPROFILE = origUserProfile;
        else delete process.env.USERPROFILE;
        delete require.cache[require.resolve("os")];
      }
      const testDb = kdb.openDb(mod.DB_PATH);

      // Insert old row with ts 10 days ago directly via SQL (kdb.stageCandidate always
      // uses new Date(), so we bypass it and use the raw DB connection instead)
      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      testDb.prepare(`
        INSERT INTO staged_candidates (ts, session_id, trigger, tool, category, confidence, summary, context_snippet, source_project, cwd)
        VALUES ($ts, $session_id, $trigger, $tool, $category, $confidence, $summary, $context_snippet, $source_project, $cwd)
      `).run({
        $ts: tenDaysAgo,
        $session_id: oldSession,
        $trigger: "test-fix",
        $tool: "Bash",
        $category: "gotcha",
        $confidence: "medium",
        $summary: "old-entry",
        $context_snippet: "",
        $source_project: "my-project",
        $cwd: "/home/user/my-project",
      });

      // Insert recent row via the public API (ts = now)
      mod.stageCandidate(makeCandidate(newSession, { summary: "new-entry" }));

      // Prune rows older than 5 days
      mod.pruneStagedFiles(5);

      assert.strictEqual(
        mod.readStagedCandidates(oldSession).length, 0,
        "Old row (10 days) should be pruned"
      );
      assert.strictEqual(
        mod.readStagedCandidates(newSession).length, 1,
        "Recent row should be kept"
      );
    } else {
      // JSONL fallback path: write files with manipulated mtimes
      const stagedDir = mod.STAGED_DIR;
      fs.mkdirSync(stagedDir, { recursive: true });

      const oldFile = path.join(stagedDir, `${oldSession}.jsonl`);
      const newFile = path.join(stagedDir, `${newSession}.jsonl`);

      fs.writeFileSync(oldFile, `{"session_id":"${oldSession}"}\n`, "utf8");
      fs.writeFileSync(newFile, `{"session_id":"${newSession}"}\n`, "utf8");

      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
      fs.utimesSync(oldFile, tenDaysAgo, tenDaysAgo);

      mod.pruneStagedFiles(5);

      assert.ok(!fs.existsSync(oldFile), "Old file (10 days) should be deleted");
      assert.ok(fs.existsSync(newFile), "Recent file should be kept");
    }
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
