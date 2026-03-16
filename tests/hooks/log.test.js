#!/usr/bin/env node
// Integration tests for templates/hooks/log.js
// Zero dependencies — uses only Node built-ins.
//
// Run: node tests/hooks/log.test.js

"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

// Resolve module path relative to repo root
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const LOG_MODULE = path.join(REPO_ROOT, "templates", "hooks", "log.js");

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Create an isolated temp directory that mimics ~/.claude/logs.
 * Returns { logDir, cleanup }.
 */
function createTempLogDir() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "log-test-"));
  const logDir = path.join(base, ".claude", "logs");
  return {
    logDir,
    cleanup() {
      try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
    },
  };
}

/**
 * Require a fresh (uncached) copy of log.js with LOG_DIR overridden to logDir.
 *
 * We monkey-patch os.homedir inside the module's closure by temporarily
 * replacing it before require(), then restoring it.  Because require() caches
 * modules we delete the cache entry first so each test gets a clean state
 * (including a reset lastPruneDate).
 */
function requireLog(logDir) {
  // Remove cached copy so we get a fresh module (clean lastPruneDate)
  delete require.cache[require.resolve(LOG_MODULE)];

  // Patch os.homedir for the duration of the require() call
  const realHomedir = os.homedir;
  // logDir is <base>/.claude/logs; homedir should be <base>
  const fakeHome = path.resolve(logDir, "..", "..");
  os.homedir = () => fakeHome;
  try {
    return require(LOG_MODULE);
  } finally {
    os.homedir = realHomedir;
  }
}

/**
 * Return today's date string YYYY-MM-DD in local time (mirrors module logic).
 */
function todayString() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Produce a date string N days in the past, YYYY-MM-DD.
 */
function daysAgoString(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

console.log("\nlog.js:");

// Test 1: Module can be required without errors
test("1. Module can be required without errors", () => {
  const { logDir, cleanup } = createTempLogDir();
  try {
    const mod = requireLog(logDir);
    assert.strictEqual(typeof mod.writeLog, "function", "writeLog should be a function");
    assert.strictEqual(typeof mod.promptHead, "function", "promptHead should be a function");
    assert.strictEqual(typeof mod.pruneOldLogs, "function", "pruneOldLogs should be a function");
  } finally {
    cleanup();
  }
});

// Test 2: writeLog creates log directory and writes valid JSONL
test("2. writeLog creates log directory and writes valid JSONL", () => {
  const { logDir, cleanup } = createTempLogDir();
  try {
    const { writeLog } = requireLog(logDir);

    // Directory should not exist yet
    assert.ok(!fs.existsSync(logDir), "Log dir should not exist before first write");

    writeLog({ hook: "context-guard", event: "block", details: "test entry" });

    assert.ok(fs.existsSync(logDir), "writeLog should create log directory");

    const today = todayString();
    const logFile = path.join(logDir, `${today}.jsonl`);
    assert.ok(fs.existsSync(logFile), `Log file ${today}.jsonl should exist`);

    const lines = fs.readFileSync(logFile, "utf8").trim().split("\n");
    assert.strictEqual(lines.length, 1, "Should have exactly one line");

    const record = JSON.parse(lines[0]);
    assert.strictEqual(record.hook, "context-guard", "hook field preserved");
    assert.strictEqual(record.event, "block", "event field preserved");
    assert.strictEqual(record.details, "test entry", "details field preserved");
  } finally {
    cleanup();
  }
});

// Test 3: writeLog auto-populates ts
test("3. writeLog auto-populates ts when not provided", () => {
  const { logDir, cleanup } = createTempLogDir();
  try {
    const { writeLog } = requireLog(logDir);
    const before = Date.now();
    writeLog({ hook: "model-router", event: "allow" });
    const after = Date.now();

    const logFile = path.join(logDir, `${todayString()}.jsonl`);
    const record = JSON.parse(fs.readFileSync(logFile, "utf8").trim());

    assert.ok(typeof record.ts === "string", "ts should be a string");
    const ts = new Date(record.ts).getTime();
    assert.ok(ts >= before && ts <= after, `ts ${record.ts} should be within test window`);
  } finally {
    cleanup();
  }
});

// Test 4: writeLog preserves explicit ts when provided
test("4. writeLog preserves explicit ts when provided", () => {
  const { logDir, cleanup } = createTempLogDir();
  try {
    const { writeLog } = requireLog(logDir);
    const explicitTs = "2025-01-15T12:00:00.000Z";
    writeLog({ hook: "session-end", event: "skip", ts: explicitTs });

    const logFile = path.join(logDir, `${todayString()}.jsonl`);
    const record = JSON.parse(fs.readFileSync(logFile, "utf8").trim());
    assert.strictEqual(record.ts, explicitTs, "Explicit ts should be preserved");
  } finally {
    cleanup();
  }
});

// Test 5: writeLog appends multiple entries, all valid JSONL
test("5. writeLog appends multiple entries as separate lines", () => {
  const { logDir, cleanup } = createTempLogDir();
  try {
    const { writeLog } = requireLog(logDir);

    writeLog({ hook: "context-guard", event: "warn", decision: "warn", context: { pct: 50 } });
    writeLog({ hook: "context-guard", event: "block", decision: "block", context: { pct: 65 } });
    writeLog({ hook: "context-guard", event: "allow", decision: "allow" });

    const logFile = path.join(logDir, `${todayString()}.jsonl`);
    const raw = fs.readFileSync(logFile, "utf8").trim();
    const lines = raw.split("\n");
    assert.strictEqual(lines.length, 3, "Should have three lines");

    const records = lines.map(l => JSON.parse(l));
    assert.strictEqual(records[0].event, "warn");
    assert.strictEqual(records[1].event, "block");
    assert.strictEqual(records[2].event, "allow");
    assert.deepStrictEqual(records[0].context, { pct: 50 });
  } finally {
    cleanup();
  }
});

// Test 6: writeLog throws when required fields are missing
test("6. writeLog throws TypeError when hook or event is missing", () => {
  const { logDir, cleanup } = createTempLogDir();
  try {
    const { writeLog } = requireLog(logDir);

    assert.throws(
      () => writeLog({ event: "block" }),
      /hook is required/,
      "Should throw when hook is missing"
    );
    assert.throws(
      () => writeLog({ hook: "context-guard" }),
      /event is required/,
      "Should throw when event is missing"
    );
    assert.throws(
      () => writeLog(null),
      /entry must be an object/,
      "Should throw when entry is not an object"
    );
  } finally {
    cleanup();
  }
});

// Test 7: promptHead truncates long strings and appends "..."
test("7. promptHead truncates correctly at maxLen", () => {
  // Reload module fresh (promptHead has no state, but keep pattern consistent)
  delete require.cache[require.resolve(LOG_MODULE)];
  const { promptHead } = require(LOG_MODULE);

  const long = "a".repeat(200);
  const result = promptHead(long, 100);
  assert.strictEqual(result.length, 103, "Truncated result should be maxLen + 3 (for ...)");
  assert.ok(result.endsWith("..."), "Should end with ...");
  assert.strictEqual(result.slice(0, 100), "a".repeat(100), "Should keep first 100 chars");
});

// Test 8: promptHead returns short strings unchanged
test("8. promptHead returns strings at or under maxLen unchanged", () => {
  delete require.cache[require.resolve(LOG_MODULE)];
  const { promptHead } = require(LOG_MODULE);

  assert.strictEqual(promptHead("hello", 100), "hello", "Short string unchanged");
  assert.strictEqual(promptHead("hello", 5), "hello", "Exactly maxLen — unchanged");
  assert.strictEqual(promptHead("", 100), "", "Empty string unchanged");
});

// Test 9: promptHead uses default maxLen of 100
test("9. promptHead default maxLen is 100", () => {
  delete require.cache[require.resolve(LOG_MODULE)];
  const { promptHead } = require(LOG_MODULE);

  const exactly100 = "x".repeat(100);
  assert.strictEqual(promptHead(exactly100), exactly100, "Exactly 100 chars unchanged");

  const over100 = "x".repeat(101);
  assert.ok(promptHead(over100).endsWith("..."), "101 chars should be truncated");
  assert.strictEqual(promptHead(over100).length, 103);
});

// Test 10: promptHead coerces non-string input
test("10. promptHead coerces non-string values to string", () => {
  delete require.cache[require.resolve(LOG_MODULE)];
  const { promptHead } = require(LOG_MODULE);

  assert.strictEqual(promptHead(null, 100), "", "null becomes empty string");
  assert.strictEqual(promptHead(undefined, 100), "", "undefined becomes empty string");
  assert.strictEqual(promptHead(42, 100), "42", "number becomes string");
});

// Test 11: pruneOldLogs removes files older than retentionDays, keeps recent ones
test("11. pruneOldLogs removes old files and keeps recent ones", () => {
  const { logDir, cleanup } = createTempLogDir();
  try {
    fs.mkdirSync(logDir, { recursive: true });

    // Create files: 91 days old (should be pruned), 89 days old (keep), today (keep)
    const oldFile   = path.join(logDir, `${daysAgoString(91)}.jsonl`);
    const recentFile = path.join(logDir, `${daysAgoString(89)}.jsonl`);
    const todayFile  = path.join(logDir, `${todayString()}.jsonl`);

    fs.writeFileSync(oldFile, '{"hook":"test","event":"allow"}\n');
    fs.writeFileSync(recentFile, '{"hook":"test","event":"allow"}\n');
    fs.writeFileSync(todayFile, '{"hook":"test","event":"allow"}\n');

    const { pruneOldLogs } = requireLog(logDir);
    pruneOldLogs(90);

    assert.ok(!fs.existsSync(oldFile),    "91-day-old file should be pruned");
    assert.ok(fs.existsSync(recentFile),  "89-day-old file should be kept");
    assert.ok(fs.existsSync(todayFile),   "Today's file should be kept");
  } finally {
    cleanup();
  }
});

// Test 12: pruneOldLogs ignores files that don't match YYYY-MM-DD.jsonl
test("12. pruneOldLogs ignores non-matching filenames", () => {
  const { logDir, cleanup } = createTempLogDir();
  try {
    fs.mkdirSync(logDir, { recursive: true });

    // These should never be touched regardless of age
    const readmeFile  = path.join(logDir, "README.txt");
    const badNameFile = path.join(logDir, "some-random-file.jsonl");

    fs.writeFileSync(readmeFile, "notes");
    fs.writeFileSync(badNameFile, "data");

    const { pruneOldLogs } = requireLog(logDir);
    pruneOldLogs(0); // zero retention — prune everything that qualifies

    assert.ok(fs.existsSync(readmeFile),  "README.txt should be untouched");
    assert.ok(fs.existsSync(badNameFile), "Non-date jsonl should be untouched");
  } finally {
    cleanup();
  }
});

// Test 13: pruneOldLogs is a no-op when log directory does not exist
test("13. pruneOldLogs is a no-op when log directory does not exist", () => {
  const { logDir, cleanup } = createTempLogDir();
  try {
    // logDir was never created
    assert.ok(!fs.existsSync(logDir), "Log dir should not exist");

    const { pruneOldLogs } = requireLog(logDir);
    assert.doesNotThrow(() => pruneOldLogs(90), "Should not throw on missing dir");
  } finally {
    cleanup();
  }
});

// Test 14: writeLog triggers pruning on first call of the day
test("14. writeLog auto-prunes old files on first call", () => {
  const { logDir, cleanup } = createTempLogDir();
  try {
    fs.mkdirSync(logDir, { recursive: true });

    const oldFile = path.join(logDir, `${daysAgoString(91)}.jsonl`);
    fs.writeFileSync(oldFile, '{"hook":"test","event":"allow"}\n');

    // writeLog should trigger pruning on its first call
    const { writeLog } = requireLog(logDir);
    writeLog({ hook: "context-guard", event: "allow" });

    assert.ok(!fs.existsSync(oldFile), "Old file should be pruned after writeLog");
  } finally {
    cleanup();
  }
});

// Test 15: writeLog auto-populates source from CLAUDE_HOOK_SOURCE env
test("15. writeLog auto-populates source from env", () => {
  const { logDir, cleanup } = createTempLogDir();
  try {
    const origSource = process.env.CLAUDE_HOOK_SOURCE;
    process.env.CLAUDE_HOOK_SOURCE = "test";

    const { writeLog } = requireLog(logDir);
    writeLog({ hook: "context-guard", event: "allow" });

    const logFile = path.join(logDir, `${todayString()}.jsonl`);
    const record = JSON.parse(fs.readFileSync(logFile, "utf8").trim());
    assert.strictEqual(record.source, "test", "source should be 'test' from env");

    if (origSource === undefined) delete process.env.CLAUDE_HOOK_SOURCE;
    else process.env.CLAUDE_HOOK_SOURCE = origSource;
  } finally {
    cleanup();
  }
});

// Test 16: writeLog defaults source to "live" when env is unset
test("16. writeLog defaults source to 'live' when env unset", () => {
  const { logDir, cleanup } = createTempLogDir();
  try {
    const origSource = process.env.CLAUDE_HOOK_SOURCE;
    delete process.env.CLAUDE_HOOK_SOURCE;

    const { writeLog } = requireLog(logDir);
    writeLog({ hook: "context-guard", event: "allow" });

    const logFile = path.join(logDir, `${todayString()}.jsonl`);
    const record = JSON.parse(fs.readFileSync(logFile, "utf8").trim());
    assert.strictEqual(record.source, "live", "source should default to 'live'");

    if (origSource !== undefined) process.env.CLAUDE_HOOK_SOURCE = origSource;
  } finally {
    cleanup();
  }
});

// Test 17: writeLog extracts project basename from entry.project path
test("17. writeLog extracts project basename from full path", () => {
  const { logDir, cleanup } = createTempLogDir();
  try {
    const { writeLog } = requireLog(logDir);
    writeLog({ hook: "model-router", event: "route", project: "/home/user/Documents/my-project" });

    const logFile = path.join(logDir, `${todayString()}.jsonl`);
    const record = JSON.parse(fs.readFileSync(logFile, "utf8").trim());
    assert.strictEqual(record.project, "my-project", "project should be basename only");
  } finally {
    cleanup();
  }
});

// Test 18: writeLog picks up task_id and task_step from env
test("18. writeLog auto-populates task_id and task_step from env", () => {
  const { logDir, cleanup } = createTempLogDir();
  try {
    const origId = process.env.CLAUDE_TASK_ID;
    const origStep = process.env.CLAUDE_TASK_STEP;
    process.env.CLAUDE_TASK_ID = "v3-round2";
    process.env.CLAUDE_TASK_STEP = "3";

    const { writeLog } = requireLog(logDir);
    writeLog({ hook: "stuck-detector", event: "warn" });

    const logFile = path.join(logDir, `${todayString()}.jsonl`);
    const record = JSON.parse(fs.readFileSync(logFile, "utf8").trim());
    assert.strictEqual(record.task_id, "v3-round2", "task_id from env");
    assert.strictEqual(record.task_step, "3", "task_step from env");

    if (origId === undefined) delete process.env.CLAUDE_TASK_ID;
    else process.env.CLAUDE_TASK_ID = origId;
    if (origStep === undefined) delete process.env.CLAUDE_TASK_STEP;
    else process.env.CLAUDE_TASK_STEP = origStep;
  } finally {
    cleanup();
  }
});

// Test 19: explicit entry fields override env defaults
test("19. explicit entry fields override env-based defaults", () => {
  const { logDir, cleanup } = createTempLogDir();
  try {
    const origSource = process.env.CLAUDE_HOOK_SOURCE;
    process.env.CLAUDE_HOOK_SOURCE = "test";

    const { writeLog } = requireLog(logDir);
    writeLog({ hook: "context-guard", event: "block", source: "custom", project: "/opt/other" });

    const logFile = path.join(logDir, `${todayString()}.jsonl`);
    const record = JSON.parse(fs.readFileSync(logFile, "utf8").trim());
    assert.strictEqual(record.source, "custom", "explicit source wins over env");
    assert.strictEqual(record.project, "other", "explicit project is basename-normalized");

    if (origSource === undefined) delete process.env.CLAUDE_HOOK_SOURCE;
    else process.env.CLAUDE_HOOK_SOURCE = origSource;
  } finally {
    cleanup();
  }
});

// Test 20: task_id/task_step omitted when env vars are unset
test("20. task_id and task_step omitted when env vars unset", () => {
  const { logDir, cleanup } = createTempLogDir();
  try {
    const origId = process.env.CLAUDE_TASK_ID;
    const origStep = process.env.CLAUDE_TASK_STEP;
    delete process.env.CLAUDE_TASK_ID;
    delete process.env.CLAUDE_TASK_STEP;

    const { writeLog } = requireLog(logDir);
    writeLog({ hook: "context-guard", event: "allow" });

    const logFile = path.join(logDir, `${todayString()}.jsonl`);
    const record = JSON.parse(fs.readFileSync(logFile, "utf8").trim());
    assert.strictEqual(record.task_id, undefined, "task_id should be absent");
    assert.strictEqual(record.task_step, undefined, "task_step should be absent");

    if (origId !== undefined) process.env.CLAUDE_TASK_ID = origId;
    if (origStep !== undefined) process.env.CLAUDE_TASK_STEP = origStep;
  } finally {
    cleanup();
  }
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
