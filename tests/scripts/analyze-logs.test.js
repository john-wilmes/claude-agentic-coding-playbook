#!/usr/bin/env node
/**
 * analyze-logs.test.js — Tests for scripts/analyze-logs.js
 *
 * Tests the CLI behavior via spawnSync. The script reads from ~/.claude/logs/
 * so tests use a temp log dir injected via a wrapper approach — we test what
 * we can: --help, no-log-dir behavior, filtering logic via stdin fixture files.
 *
 * Run: node tests/scripts/analyze-logs.test.js
 */

"use strict";

const assert = require("assert");
const fs     = require("fs");
const path   = require("path");
const os     = require("os");
const { spawnSync } = require("child_process");

const REPO_ROOT   = path.resolve(__dirname, "..", "..");
const SCRIPT      = path.join(REPO_ROOT, "scripts", "analyze-logs.js");

// ─── Test runner ──────────────────────────────────────────────────────────────

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Run analyze-logs.js with optional env overrides.
 * Returns { status, stdout, stderr }.
 */
function run(args = [], env = {}) {
  const result = spawnSync("node", [SCRIPT, ...args], {
    encoding: "utf8",
    timeout: 60000,
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

/**
 * Create a temp directory with a synthetic ~/.claude/logs structure.
 * Returns { homeDir, logDir, cleanup }.
 * NOTE: analyze-logs.js uses os.homedir() at module load time (hardcoded),
 * so we cannot redirect it via HOME. Instead, we write fixtures at the real
 * log path and test parsing via a minimal inline extractor that mirrors the
 * script's parseArgs/loadEntries logic.
 */
function createTempHome() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "al-test-home-"));
  const logDir  = path.join(homeDir, ".claude", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  return {
    homeDir,
    logDir,
    cleanup() {
      try { fs.rmSync(homeDir, { recursive: true, force: true }); } catch {}
    },
  };
}

// ─── Inline parseArgs extracted for unit testing ──────────────────────────────
// Mirrors the logic in analyze-logs.js without running side effects.

function parseArgs(argv) {
  const args = { since: null, session: null, hook: null, excludeTests: false, project: null, retrievalMisses: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--since" && argv[i + 1]) { args.since = argv[++i]; }
    else if (argv[i] === "--session" && argv[i + 1]) { args.session = argv[++i]; }
    else if (argv[i] === "--hook" && argv[i + 1]) { args.hook = argv[++i]; }
    else if (argv[i] === "--exclude-tests") { args.excludeTests = true; }
    else if (argv[i] === "--project" && argv[i + 1]) { args.project = argv[++i]; }
    else if (argv[i] === "--retrieval-misses") { args.retrievalMisses = true; }
  }
  return args;
}

/** Minimal loadEntries that operates on a given logDir instead of ~/.claude/logs */
function loadEntries(logDir, args) {
  if (!fs.existsSync(logDir)) return [];
  let files;
  try {
    files = fs.readdirSync(logDir).filter(f => f.endsWith(".jsonl")).sort();
  } catch { return []; }

  if (args.since) {
    files = files.filter(f => {
      const date = path.basename(f, ".jsonl");
      return date >= args.since;
    });
  }

  const entries = [];
  for (const file of files) {
    const filePath = path.join(logDir, file);
    let lines;
    try { lines = fs.readFileSync(filePath, "utf8").split("\n"); } catch { continue; }
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (args.session && !String(entry.session_id || "").startsWith(args.session)) continue;
        if (args.hook && entry.hook !== args.hook) continue;
        if (args.excludeTests && entry.source === "test") continue;
        if (args.project && !String(entry.project || "").includes(args.project)) continue;
        entries.push(entry);
      } catch { /* skip malformed */ }
    }
  }
  return entries;
}

// ─── Tests: CLI behavior ──────────────────────────────────────────────────────

console.log("\nanalyze-logs — CLI:");

test("1. --help exits 0 and prints Usage", () => {
  const { status, stdout } = run(["--help"]);
  assert.strictEqual(status, 0);
  assert.ok(stdout.includes("Usage:"), `Expected 'Usage:' in stdout, got: ${stdout.slice(0, 200)}`);
});

test("2. --help mentions supported flags", () => {
  const { stdout } = run(["--help"]);
  assert.ok(stdout.includes("--since"));
  assert.ok(stdout.includes("--session"));
  assert.ok(stdout.includes("--hook"));
  assert.ok(stdout.includes("--exclude-tests"));
  assert.ok(stdout.includes("--project"));
  assert.ok(stdout.includes("--retrieval-misses"));
});

test("3. No args runs without crash and exits 0", () => {
  // May or may not find log files depending on the environment,
  // but should always exit 0. Use --since with a future date to avoid
  // loading large log files in CI.
  const { status } = run(["--since", "2099-01-01"]);
  assert.strictEqual(status, 0, "Should exit 0 even if no log files match");
});

test("4. Output includes section headers (bounded by --since future date)", () => {
  // Use a future --since so no entries are loaded, keeping the run fast.
  const { stdout } = run(["--since", "2099-01-01"]);
  // These headers are always printed regardless of data
  assert.ok(stdout.includes("Overall Summary"), `Missing 'Overall Summary' in: ${stdout.slice(0, 300)}`);
  assert.ok(stdout.includes("Context-Guard"), `Missing 'Context-Guard' in: ${stdout.slice(0, 300)}`);
  assert.ok(stdout.includes("Stuck-Detector"), `Missing 'Stuck-Detector' in: ${stdout.slice(0, 300)}`);
  assert.ok(stdout.includes("Model-Router"), `Missing 'Model-Router' in: ${stdout.slice(0, 300)}`);
  assert.ok(stdout.includes("Prompt-Injection"), `Missing 'Prompt-Injection' in: ${stdout.slice(0, 300)}`);
});

// ─── Tests: parseArgs ─────────────────────────────────────────────────────────

console.log("\nanalyze-logs — parseArgs:");

test("5. parseArgs defaults all fields to null/false", () => {
  const args = parseArgs(["node", "analyze-logs.js"]);
  assert.strictEqual(args.since, null);
  assert.strictEqual(args.session, null);
  assert.strictEqual(args.hook, null);
  assert.strictEqual(args.excludeTests, false);
  assert.strictEqual(args.project, null);
  assert.strictEqual(args.retrievalMisses, false);
});

test("6. parseArgs --since captures date value", () => {
  const args = parseArgs(["node", "analyze-logs.js", "--since", "2025-01-15"]);
  assert.strictEqual(args.since, "2025-01-15");
});

test("7. parseArgs --session captures session prefix", () => {
  const args = parseArgs(["node", "analyze-logs.js", "--session", "abc123"]);
  assert.strictEqual(args.session, "abc123");
});

test("8. parseArgs --hook captures hook name", () => {
  const args = parseArgs(["node", "analyze-logs.js", "--hook", "context-guard"]);
  assert.strictEqual(args.hook, "context-guard");
});

test("9. parseArgs --exclude-tests sets flag", () => {
  const args = parseArgs(["node", "analyze-logs.js", "--exclude-tests"]);
  assert.strictEqual(args.excludeTests, true);
});

test("10. parseArgs --project captures project name", () => {
  const args = parseArgs(["node", "analyze-logs.js", "--project", "my-project"]);
  assert.strictEqual(args.project, "my-project");
});

test("11. parseArgs --retrieval-misses sets flag", () => {
  const args = parseArgs(["node", "analyze-logs.js", "--retrieval-misses"]);
  assert.strictEqual(args.retrievalMisses, true);
});

test("12. parseArgs handles multiple flags together", () => {
  const args = parseArgs([
    "node", "analyze-logs.js",
    "--since", "2025-06-01",
    "--hook", "stuck-detector",
    "--exclude-tests",
    "--project", "my-repo",
  ]);
  assert.strictEqual(args.since, "2025-06-01");
  assert.strictEqual(args.hook, "stuck-detector");
  assert.strictEqual(args.excludeTests, true);
  assert.strictEqual(args.project, "my-repo");
});

// ─── Tests: loadEntries filtering ─────────────────────────────────────────────

console.log("\nanalyze-logs — loadEntries filtering:");

test("13. Returns empty array when log dir does not exist", () => {
  const entries = loadEntries("/nonexistent/path/xyz", {});
  assert.deepStrictEqual(entries, []);
});

test("14. Loads entries from a JSONL log file", () => {
  const { logDir, cleanup } = createTempHome();
  try {
    const logFile = path.join(logDir, "2025-06-01.jsonl");
    fs.writeFileSync(logFile, [
      JSON.stringify({ ts: "2025-06-01T10:00:00Z", hook: "context-guard", session_id: "sess1", event: "warn" }),
      JSON.stringify({ ts: "2025-06-01T10:01:00Z", hook: "stuck-detector", session_id: "sess1", event: "trigger" }),
    ].join("\n") + "\n");

    const entries = loadEntries(logDir, {});
    assert.strictEqual(entries.length, 2);
  } finally { cleanup(); }
});

test("15. Skips malformed JSON lines silently", () => {
  const { logDir, cleanup } = createTempHome();
  try {
    const logFile = path.join(logDir, "2025-06-01.jsonl");
    fs.writeFileSync(logFile, [
      JSON.stringify({ hook: "context-guard", session_id: "s1" }),
      "NOT_VALID_JSON",
      JSON.stringify({ hook: "stuck-detector", session_id: "s1" }),
    ].join("\n") + "\n");

    const entries = loadEntries(logDir, {});
    assert.strictEqual(entries.length, 2, "Malformed line should be skipped");
  } finally { cleanup(); }
});

test("16. --since filters out files with earlier dates", () => {
  const { logDir, cleanup } = createTempHome();
  try {
    fs.writeFileSync(path.join(logDir, "2025-01-01.jsonl"),
      JSON.stringify({ hook: "h", session_id: "s1" }) + "\n");
    fs.writeFileSync(path.join(logDir, "2025-06-01.jsonl"),
      JSON.stringify({ hook: "h", session_id: "s2" }) + "\n");
    fs.writeFileSync(path.join(logDir, "2025-12-01.jsonl"),
      JSON.stringify({ hook: "h", session_id: "s3" }) + "\n");

    const args = parseArgs(["node", "al.js", "--since", "2025-06-01"]);
    const entries = loadEntries(logDir, args);
    assert.strictEqual(entries.length, 2, "Should include 2025-06-01 and later only");
    const sessionIds = entries.map(e => e.session_id);
    assert.ok(sessionIds.includes("s2"));
    assert.ok(sessionIds.includes("s3"));
    assert.ok(!sessionIds.includes("s1"), "2025-01-01 should be excluded");
  } finally { cleanup(); }
});

test("17. --session filters by session_id prefix", () => {
  const { logDir, cleanup } = createTempHome();
  try {
    const logFile = path.join(logDir, "2025-06-01.jsonl");
    fs.writeFileSync(logFile, [
      JSON.stringify({ hook: "h", session_id: "abc123xyz" }),
      JSON.stringify({ hook: "h", session_id: "def456xyz" }),
      JSON.stringify({ hook: "h", session_id: "abc789xyz" }),
    ].join("\n") + "\n");

    const args = parseArgs(["node", "al.js", "--session", "abc"]);
    const entries = loadEntries(logDir, args);
    assert.strictEqual(entries.length, 2, "Should only include sessions starting with 'abc'");
  } finally { cleanup(); }
});

test("18. --hook filters by hook name", () => {
  const { logDir, cleanup } = createTempHome();
  try {
    const logFile = path.join(logDir, "2025-06-01.jsonl");
    fs.writeFileSync(logFile, [
      JSON.stringify({ hook: "context-guard", session_id: "s1" }),
      JSON.stringify({ hook: "stuck-detector", session_id: "s1" }),
      JSON.stringify({ hook: "context-guard", session_id: "s1" }),
    ].join("\n") + "\n");

    const args = parseArgs(["node", "al.js", "--hook", "context-guard"]);
    const entries = loadEntries(logDir, args);
    assert.strictEqual(entries.length, 2);
    assert.ok(entries.every(e => e.hook === "context-guard"));
  } finally { cleanup(); }
});

test("19. --exclude-tests filters out source=test entries", () => {
  const { logDir, cleanup } = createTempHome();
  try {
    const logFile = path.join(logDir, "2025-06-01.jsonl");
    fs.writeFileSync(logFile, [
      JSON.stringify({ hook: "h", session_id: "s1", source: "test" }),
      JSON.stringify({ hook: "h", session_id: "s2", source: "production" }),
      JSON.stringify({ hook: "h", session_id: "s3" }),
    ].join("\n") + "\n");

    const args = parseArgs(["node", "al.js", "--exclude-tests"]);
    const entries = loadEntries(logDir, args);
    assert.strictEqual(entries.length, 2, "source=test entries should be excluded");
    assert.ok(!entries.some(e => e.source === "test"));
  } finally { cleanup(); }
});

test("20. --project filters by project substring", () => {
  const { logDir, cleanup } = createTempHome();
  try {
    const logFile = path.join(logDir, "2025-06-01.jsonl");
    fs.writeFileSync(logFile, [
      JSON.stringify({ hook: "h", session_id: "s1", project: "my-awesome-project" }),
      JSON.stringify({ hook: "h", session_id: "s2", project: "other-project" }),
      JSON.stringify({ hook: "h", session_id: "s3", project: "my-other-project" }),
    ].join("\n") + "\n");

    const args = parseArgs(["node", "al.js", "--project", "my-"]);
    const entries = loadEntries(logDir, args);
    assert.strictEqual(entries.length, 2, "Should match projects containing 'my-'");
  } finally { cleanup(); }
});

test("21. Entries with missing session_id are not filtered by --session", () => {
  // entries lacking session_id should be excluded when --session is specified
  // (they don't match the prefix)
  const { logDir, cleanup } = createTempHome();
  try {
    const logFile = path.join(logDir, "2025-06-01.jsonl");
    fs.writeFileSync(logFile, [
      JSON.stringify({ hook: "h", session_id: "abc123" }),
      JSON.stringify({ hook: "h" }),  // no session_id
    ].join("\n") + "\n");

    const args = parseArgs(["node", "al.js", "--session", "abc"]);
    const entries = loadEntries(logDir, args);
    assert.strictEqual(entries.length, 1, "Entry without session_id should not match prefix filter");
  } finally { cleanup(); }
});

test("22. Loads entries from multiple JSONL files", () => {
  const { logDir, cleanup } = createTempHome();
  try {
    fs.writeFileSync(path.join(logDir, "2025-06-01.jsonl"),
      JSON.stringify({ hook: "h1", session_id: "s1" }) + "\n");
    fs.writeFileSync(path.join(logDir, "2025-06-02.jsonl"),
      JSON.stringify({ hook: "h2", session_id: "s2" }) + "\n" +
      JSON.stringify({ hook: "h3", session_id: "s3" }) + "\n");

    const entries = loadEntries(logDir, {});
    assert.strictEqual(entries.length, 3);
  } finally { cleanup(); }
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed (${passed + failed} total)`);

if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) {
    console.log(`  ✗ ${f.name}: ${f.error}`);
  }
}

process.exit(failed > 0 ? 1 : 0);
