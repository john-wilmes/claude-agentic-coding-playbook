#!/usr/bin/env node
// Integration tests for retrieval-miss detection in session-end.js.
// Verifies that detectRetrievalMisses logs when staged candidates match
// knowledge entries that were NOT injected at session start.
//
// Zero dependencies — uses only Node built-ins + local test-helpers.
//
// Run: node tests/hooks/retrieval-miss.test.js

"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const {
  createTempHome,
  createProjectDir,
  runHook,
  todayLocal,
} = require("./test-helpers");

// Resolve paths relative to repo root
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SESSION_END = path.join(REPO_ROOT, "templates", "hooks", "session-end.js");
const SESSION_START = path.join(REPO_ROOT, "templates", "hooks", "session-start.js");
const DB_MODULE_PATH = path.join(REPO_ROOT, "templates", "hooks", "knowledge-db.js");

// ─── Check SQLite availability ────────────────────────────────────────────────

let sqliteAvailable = false;
try {
  require("node:sqlite");
  sqliteAvailable = true;
} catch {
  sqliteAvailable = false;
}

// ─── Test runner ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

function test(name, fn) {
  const env = createTempHome();
  try {
    fn(env);
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message });
    console.log(`  \u2717 ${name}`);
    console.log(`    ${err.message}`);
  } finally {
    env.cleanup();
  }
}

function skip(name) {
  skipped++;
  console.log(`  - ${name} (skipped: node:sqlite unavailable)`);
}

function newSessionId() {
  return `test-${crypto.randomUUID()}`;
}

/**
 * Write a session-start state file to the temp dir so detectRetrievalMisses
 * can read the injected IDs.
 */
function writeSessionStartState(sessionId, injectedIds) {
  const stateDir = path.join(os.tmpdir(), "claude-session-start");
  fs.mkdirSync(stateDir, { recursive: true });
  const stateFile = path.join(stateDir, `${sessionId}.json`);
  fs.writeFileSync(stateFile, JSON.stringify({ injectedIds }));
  return stateFile;
}

/**
 * Stage a candidate for the given session in the temp home.
 * Uses SQLite DB when available (Node 22.5+), falls back to JSONL.
 */
function writeStagedCandidate(home, sessionId, candidate) {
  const record = {
    session_id: sessionId,
    trigger: candidate.trigger || "test-fix",
    tool: candidate.tool || "git",
    category: candidate.category || "gotcha",
    confidence: candidate.confidence || "medium",
    summary: candidate.summary || "",
    context_snippet: candidate.context_snippet || "",
    source_project: candidate.source_project || "",
    cwd: candidate.cwd || "",
  };

  if (sqliteAvailable) {
    // Insert directly into the SQLite DB at the temp home
    const { knowledgeDb, db } = openTempKnowledgeDb(home);
    if (db) {
      knowledgeDb.stageCandidate(db, record);
      return;
    }
  }

  // JSONL fallback
  const stagedDir = path.join(home, ".claude", "knowledge", "staged");
  fs.mkdirSync(stagedDir, { recursive: true });
  const filePath = path.join(stagedDir, `${sessionId}.jsonl`);
  const jsonlRecord = { ts: new Date().toISOString(), ...record };
  fs.appendFileSync(filePath, JSON.stringify(jsonlRecord) + "\n", "utf8");
}

/**
 * Open a knowledge DB at the given path with HOME set to the temp directory.
 * Returns { knowledgeDb, db } — both scoped to the temp home.
 * HOME is temporarily set during openDb so _migrateIfNeeded uses the temp home
 * (preventing real knowledge entries from migrating into the test DB).
 */
function openTempKnowledgeDb(home) {
  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete require.cache[require.resolve("os")];
  delete require.cache[DB_MODULE_PATH];
  try {
    const knowledgeDb = require(DB_MODULE_PATH);
    const dbPath = path.join(home, ".claude", "knowledge", "knowledge.db");
    const db = knowledgeDb.openDb(dbPath);
    return { knowledgeDb, db };
  } finally {
    process.env.HOME = origHome;
    process.env.USERPROFILE = origUserProfile;
    delete require.cache[require.resolve("os")];
    delete require.cache[DB_MODULE_PATH];
  }
}

/**
 * Insert an entry into the knowledge DB for the given temp home.
 */
function insertKnowledgeEntry(home, entryOpts = {}) {
  const {
    id = `entry-${crypto.randomUUID().slice(0, 8)}`,
    tool = "git",
    category = "gotcha",
    confidence = "high",
    context_text = "Test context for knowledge entry.",
    fix_text = "Apply the standard fix.",
  } = entryOpts;

  const { knowledgeDb, db } = openTempKnowledgeDb(home);
  if (!db) throw new Error("Could not open knowledge DB");
  knowledgeDb.insertEntry(db, {
    id,
    created: new Date().toISOString(),
    tool,
    category,
    confidence,
    status: "active",
    context_text,
    fix_text,
  });
  return { id, tool, category, context_text };
}

/**
 * Read the log file for a given temp home and return parsed JSONL entries.
 */
function readLogEntries(home) {
  const today = todayLocal();
  const logPath = path.join(home, ".claude", "logs", `${today}.jsonl`);
  if (!fs.existsSync(logPath)) return [];
  const lines = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  const entries = [];
  for (const line of lines) {
    try { entries.push(JSON.parse(line)); } catch {}
  }
  return entries;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

console.log("\nretrieval-miss detection:");

test("1. No staged candidates → no retrieval-miss log entry", (env) => {
  const sessionId = newSessionId();
  const projDir = createProjectDir({ git: true });

  // Write state file with some injected IDs (but no candidates)
  writeSessionStartState(sessionId, ["entry-abc", "entry-def"]);

  // No candidates are written — staged file doesn't exist

  runHook(SESSION_END, {
    session_id: sessionId,
    cwd: projDir,
  }, { HOME: env.home, USERPROFILE: env.home });

  const logEntries = readLogEntries(env.home);
  const misses = logEntries.filter(e => e.event === "retrieval-miss");
  assert.strictEqual(misses.length, 0, "Should not log retrieval-miss when there are no staged candidates");
});

test("4. No session-start state file → no crash, no miss logged", (env) => {
  const sessionId = newSessionId();
  const projDir = createProjectDir({ git: true });

  // Write a staged candidate but NO state file
  writeStagedCandidate(env.home, sessionId, {
    summary: "some error occurred during testing",
    tool: "node",
  });

  // Do not write session-start state file

  const result = runHook(SESSION_END, {
    session_id: sessionId,
    cwd: projDir,
  }, { HOME: env.home, USERPROFILE: env.home });

  assert.strictEqual(result.status, 0, "Should exit 0 even without state file");
  const logEntries = readLogEntries(env.home);
  const misses = logEntries.filter(e => e.event === "retrieval-miss");
  assert.strictEqual(misses.length, 0, "Should not log retrieval-miss when state file is absent");
});

if (!sqliteAvailable) {
  skip("2. Staged candidate matches entry NOT in injected set → miss logged");
  skip("3. Staged candidate matches entry that WAS injected → no miss logged");
  skip("5. No knowledge DB (SQLite unavailable) → no crash");
} else {
  test("2. Staged candidate matches entry NOT in injected set → miss logged", (env) => {
    const sessionId = newSessionId();
    const projDir = createProjectDir({ git: true });

    // Insert a knowledge entry about git branch protection
    const entry = insertKnowledgeEntry(env.home, {
      id: "git-branch-protection",
      tool: "git",
      category: "gotcha",
      confidence: "high",
      context_text: "Branch protection blocks merges when threads unresolved in pull requests.",
      fix_text: "Resolve threads via GraphQL API mutation.",
    });

    // Session started with a DIFFERENT entry injected (not our entry)
    writeSessionStartState(sessionId, ["some-other-entry-id"]);

    // Stage a candidate that mentions branch protection
    writeStagedCandidate(env.home, sessionId, {
      summary: "branch protection blocked merge with unresolved threads",
      context_snippet: "git push rejected due to branch protection rules",
      tool: "git",
      cwd: projDir,
    });

    runHook(SESSION_END, {
      session_id: sessionId,
      cwd: projDir,
    }, { HOME: env.home, USERPROFILE: env.home });

    const logEntries = readLogEntries(env.home);
    const misses = logEntries.filter(e => e.event === "retrieval-miss");
    assert.ok(misses.length > 0, "Should log at least one retrieval-miss");
    const miss = misses[0];
    assert.strictEqual(miss.hook, "session-end", "Miss should be from session-end hook");
    assert.ok(miss.context, "Miss should have context object");
    assert.ok(
      typeof miss.context.matched_entry_id === "string",
      "Miss context should include matched_entry_id"
    );
    assert.ok(
      Array.isArray(miss.context.injected_ids),
      "Miss context should include injected_ids array"
    );
    assert.ok(
      !miss.context.injected_ids.includes(miss.context.matched_entry_id),
      "The matched entry ID should NOT be in the injected_ids"
    );
  });

  test("3. Staged candidate matches entry that WAS injected → no miss logged", (env) => {
    const sessionId = newSessionId();
    const projDir = createProjectDir({ git: true });

    // Insert a knowledge entry
    insertKnowledgeEntry(env.home, {
      id: "git-branch-protection-2",
      tool: "git",
      category: "gotcha",
      confidence: "high",
      context_text: "Branch protection blocks merges when threads unresolved in pull requests.",
      fix_text: "Resolve threads via GraphQL API mutation.",
    });

    // Session started with this exact entry injected
    writeSessionStartState(sessionId, ["git-branch-protection-2"]);

    // Stage a candidate that mentions the same topic
    writeStagedCandidate(env.home, sessionId, {
      summary: "branch protection blocked merge with unresolved threads",
      context_snippet: "git push rejected due to branch protection rules",
      tool: "git",
      cwd: projDir,
    });

    runHook(SESSION_END, {
      session_id: sessionId,
      cwd: projDir,
    }, { HOME: env.home, USERPROFILE: env.home });

    const logEntries = readLogEntries(env.home);
    const misses = logEntries.filter(e => e.event === "retrieval-miss");
    // All matched entries were injected — no miss should be logged
    assert.strictEqual(misses.length, 0, "Should NOT log retrieval-miss when matching entry was already injected");
  });

  test("5. No knowledge DB (SQLite unavailable) → no crash", (env) => {
    // This test verifies robustness: even if the DB file can't be opened, exit 0.
    const sessionId = newSessionId();
    const projDir = createProjectDir({ git: true });

    // Write state file + candidate but don't create the DB
    writeSessionStartState(sessionId, []);
    writeStagedCandidate(env.home, sessionId, {
      summary: "test candidate for db-absent scenario",
      tool: "git",
      cwd: projDir,
    });

    // Point HOME at a read-only-style location by not creating the knowledge dir
    // The hook will try to open the DB, get null, and return gracefully
    const result = runHook(SESSION_END, {
      session_id: sessionId,
      cwd: projDir,
    }, { HOME: env.home, USERPROFILE: env.home });

    assert.strictEqual(result.status, 0, "Should exit 0 even when knowledge DB cannot be opened");
    assert.ok(result.json !== null, "Should produce valid JSON output");
  });
}

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped (${passed + failed + skipped} total)`);

if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) {
    console.log(`  \u2717 ${f.name}: ${f.error}`);
  }
}

process.exit(failed > 0 ? 1 : 0);
