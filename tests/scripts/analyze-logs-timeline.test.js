#!/usr/bin/env node
/**
 * analyze-logs-timeline.test.js — Tests for --timeline and --aggregate features
 *
 * Tests printTimeline() and printAggregate() by requiring analyze-logs.js as a
 * module (safe after the require.main guard) and calling the exported functions
 * directly with constructed mock data, capturing console.log output.
 *
 * Run: node tests/scripts/analyze-logs-timeline.test.js
 */

"use strict";

const assert = require("assert");
const fs     = require("fs");
const path   = require("path");
const os     = require("os");

const REPO_ROOT      = path.resolve(__dirname, "..", "..");
const ANALYZE_LOGS   = path.join(REPO_ROOT, "scripts", "analyze-logs.js");
const TRANSCRIPT_MOD = path.join(REPO_ROOT, "scripts", "transcript-parser.js");

const { printTimeline, printAggregate, formatTime, formatToolSummary } = require(ANALYZE_LOGS);
const { encodeCwd } = require(TRANSCRIPT_MOD);

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
 * Capture console.log output produced by fn().
 * Returns the captured string.
 */
function captureOutput(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => lines.push(args.map(a => String(a)).join(" "));
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return lines.join("\n");
}

/**
 * Create a temp directory and return { dir, cleanup }.
 */
function makeTempDir(prefix = "al-tl-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    cleanup() {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

/**
 * Create a minimal transcript JSONL session file at the path that
 * transcriptParser.findSessionFile() will look for.
 *
 * projectCwd is the fake project directory whose encoded form becomes the
 * project storage directory under homeDir.
 *
 * Returns the full path to the created JSONL file.
 */
function createTranscriptFile(homeDir, projectCwd, sessionId, entries) {
  const encoded = encodeCwd(projectCwd);
  const projectsDir = path.join(homeDir, ".claude", "projects", encoded);
  fs.mkdirSync(projectsDir, { recursive: true });
  const filePath = path.join(projectsDir, `${sessionId}.jsonl`);
  const lines = entries.map(e => JSON.stringify(e)).join("\n") + "\n";
  fs.writeFileSync(filePath, lines);
  return filePath;
}

// ─── Hook entry factory ───────────────────────────────────────────────────────

function hookEntry(hook, event, sessionId, extra = {}) {
  return {
    ts: extra.ts || "2026-01-01T10:00:00Z",
    hook,
    event,
    session_id: sessionId,
    ...extra,
  };
}

// ─── Transcript entry factories ───────────────────────────────────────────────

function assistantEntry(toolName, toolInput, toolId, ts) {
  return {
    type: "assistant",
    timestamp: ts || "2026-01-01T10:00:01Z",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: toolId || "tu_001",
          name: toolName,
          input: toolInput || {},
        },
      ],
    },
  };
}

function toolResultEntry(toolId, content, isError) {
  return {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolId,
          content: content || "ok",
          is_error: isError === true,
        },
      ],
    },
  };
}

// ─── Tests: printTimeline ──────────────────────────────────────────────────────

console.log("\nanalyze-logs printTimeline:");

test("1. --timeline with no matching session and no hook entries shows 'No timeline events'", () => {
  const output = captureOutput(() => {
    printTimeline("sess-xyz-nomatch", null, []);
  });
  assert.ok(output.includes("No timeline events"), `Expected 'No timeline events', got: ${output}`);
});

test("2. --timeline with hook log entries shows hook events", () => {
  const entries = [
    hookEntry("context-guard", "warn", "sess-001", {
      ts: "2026-01-01T10:00:00Z",
      context: { pct: 45.3 },
    }),
    hookEntry("stuck-detector", "trigger", "sess-001", {
      ts: "2026-01-01T10:01:00Z",
      details: "Bash",
    }),
  ];
  const output = captureOutput(() => {
    printTimeline("sess-001", null, entries);
  });
  assert.ok(output.includes("context-guard"), `Expected 'context-guard' in output: ${output}`);
  assert.ok(output.includes("stuck-detector"), `Expected 'stuck-detector' in output: ${output}`);
  assert.ok(output.includes("10:00:00"), `Expected timestamp in output: ${output}`);
  assert.ok(output.includes("10:01:00"), `Expected second timestamp in output: ${output}`);
});

test("3. --timeline with transcript + hook data shows merged timeline", () => {
  // We need a real temp home dir so transcript-parser can find the session file.
  // Monkey-patch os.homedir() temporarily for this test by writing to a path
  // under the real home, then passing --project-dir so findSessionFile resolves it.

  // Strategy: create the transcript in the real ~/.claude/projects/ with a unique
  // test session ID, then clean it up after.
  const uniqueSession = `test-tl-merge-${Date.now()}`;
  const fakeProjectCwd = `/tmp/test-project-${Date.now()}`;
  const encoded = encodeCwd(fakeProjectCwd);
  const projectsDir = path.join(os.homedir(), ".claude", "projects", encoded);

  try {
    fs.mkdirSync(projectsDir, { recursive: true });
    const filePath = path.join(projectsDir, `${uniqueSession}.jsonl`);
    const transcriptEntries = [
      assistantEntry("Read", { file_path: "/src/foo.js" }, "tu_r01", "2026-01-01T10:00:05Z"),
      toolResultEntry("tu_r01", "contents", false),
    ];
    fs.writeFileSync(filePath, transcriptEntries.map(e => JSON.stringify(e)).join("\n") + "\n");

    const hookEntries = [
      hookEntry("context-guard", "warn", uniqueSession, {
        ts: "2026-01-01T10:00:10Z",
        context: { pct: 55.0 },
      }),
    ];

    const output = captureOutput(() => {
      printTimeline(uniqueSession, fakeProjectCwd, hookEntries);
    });

    assert.ok(output.includes("Tool: Read"), `Expected 'Tool: Read' in merged output: ${output}`);
    assert.ok(output.includes("context-guard"), `Expected 'context-guard' hook in merged output: ${output}`);

    // Cleanup
    try { fs.rmSync(filePath); } catch {}
    try { fs.rmdirSync(projectsDir); } catch {}
  } catch (e) {
    // Cleanup on failure too
    try { fs.rmSync(projectsDir, { recursive: true, force: true }); } catch {}
    throw e;
  }
});

test("4. Tool errors are marked with [ERROR]", () => {
  const uniqueSession = `test-tl-error-${Date.now()}`;
  const fakeProjectCwd = `/tmp/test-project-err-${Date.now()}`;
  const encoded = encodeCwd(fakeProjectCwd);
  const projectsDir = path.join(os.homedir(), ".claude", "projects", encoded);

  try {
    fs.mkdirSync(projectsDir, { recursive: true });
    const filePath = path.join(projectsDir, `${uniqueSession}.jsonl`);
    const transcriptEntries = [
      assistantEntry("Bash", { command: "npm test" }, "tu_b01", "2026-01-01T10:00:01Z"),
      toolResultEntry("tu_b01", "Error: tests failed", true),  // is_error = true
    ];
    fs.writeFileSync(filePath, transcriptEntries.map(e => JSON.stringify(e)).join("\n") + "\n");

    const output = captureOutput(() => {
      printTimeline(uniqueSession, fakeProjectCwd, []);
    });

    assert.ok(output.includes("[ERROR]"), `Expected '[ERROR]' mark on failed tool call: ${output}`);
    assert.ok(output.includes("Tool: Bash"), `Expected 'Tool: Bash' in output: ${output}`);

    try { fs.rmSync(filePath); } catch {}
    try { fs.rmdirSync(projectsDir); } catch {}
  } catch (e) {
    try { fs.rmSync(projectsDir, { recursive: true, force: true }); } catch {}
    throw e;
  }
});

test("5. Hook events show correct icons", () => {
  const entries = [
    hookEntry("context-guard", "warn", "sess-ico", {
      ts: "2026-01-01T10:00:00Z",
      context: { pct: 52.0 },
    }),
    hookEntry("stuck-detector", "block", "sess-ico", {
      ts: "2026-01-01T10:01:00Z",
    }),
    hookEntry("sycophancy-detector", "escalate", "sess-ico", {
      ts: "2026-01-01T10:02:00Z",
      context: { reason: "compliance_run" },
    }),
    hookEntry("model-router", "info", "sess-ico", {
      ts: "2026-01-01T10:03:00Z",
      context: { model: "claude-haiku" },
    }),
  ];
  const output = captureOutput(() => {
    printTimeline("sess-ico", null, entries);
  });

  assert.ok(output.includes("<!>"), `Expected '<!>' warn icon in output: ${output}`);
  assert.ok(output.includes("!!!"), `Expected '!!!' block/escalate icon in output: ${output}`);
  assert.ok(output.includes("---"), `Expected '---' info icon in output: ${output}`);
});

test("6. Context-guard events show percentage", () => {
  const entries = [
    hookEntry("context-guard", "warn", "sess-pct", {
      ts: "2026-01-01T10:00:00Z",
      context: { pct: 73.5 },
    }),
  ];
  const output = captureOutput(() => {
    printTimeline("sess-pct", null, entries);
  });
  assert.ok(output.includes("73.5%"), `Expected '73.5%' in context-guard event: ${output}`);
});

test("7. Summary line shows correct counts", () => {
  const uniqueSession = `test-tl-counts-${Date.now()}`;
  const fakeProjectCwd = `/tmp/test-project-counts-${Date.now()}`;
  const encoded = encodeCwd(fakeProjectCwd);
  const projectsDir = path.join(os.homedir(), ".claude", "projects", encoded);

  try {
    fs.mkdirSync(projectsDir, { recursive: true });
    const filePath = path.join(projectsDir, `${uniqueSession}.jsonl`);
    // 2 tool calls: 1 success, 1 error
    const transcriptEntries = [
      assistantEntry("Read", { file_path: "/foo.js" }, "tu_ok1", "2026-01-01T10:00:01Z"),
      toolResultEntry("tu_ok1", "content", false),
      assistantEntry("Bash", { command: "bad" }, "tu_err1", "2026-01-01T10:00:02Z"),
      toolResultEntry("tu_err1", "err", true),
    ];
    fs.writeFileSync(filePath, transcriptEntries.map(e => JSON.stringify(e)).join("\n") + "\n");

    // 3 hook events: 1 warn, 1 block, 1 info
    const hookEntries = [
      hookEntry("context-guard", "warn", uniqueSession, { ts: "2026-01-01T10:00:00Z", context: { pct: 40.0 } }),
      hookEntry("stuck-detector", "block", uniqueSession, { ts: "2026-01-01T10:00:03Z" }),
      hookEntry("model-router", "info", uniqueSession, { ts: "2026-01-01T10:00:04Z" }),
    ];

    const output = captureOutput(() => {
      printTimeline(uniqueSession, fakeProjectCwd, hookEntries);
    });

    // Summary should state: 2 tool calls, 1 error, 3 hook events (1 warn, 1 block/escalate)
    assert.ok(output.includes("2 tool calls"), `Expected '2 tool calls' in summary: ${output}`);
    assert.ok(output.includes("1 error"), `Expected '1 error' in summary: ${output}`);
    assert.ok(output.includes("3 hook events"), `Expected '3 hook events' in summary: ${output}`);
    assert.ok(output.includes("1 warn"), `Expected '1 warn' in summary: ${output}`);
    assert.ok(output.includes("1 block/escalate"), `Expected '1 block/escalate' in summary: ${output}`);

    try { fs.rmSync(filePath); } catch {}
    try { fs.rmdirSync(projectsDir); } catch {}
  } catch (e) {
    try { fs.rmSync(projectsDir, { recursive: true, force: true }); } catch {}
    throw e;
  }
});

// ─── Tests: printAggregate ─────────────────────────────────────────────────────

console.log("\nanalyze-logs printAggregate:");

test("8. --aggregate with no entries shows 'No entries to aggregate'", () => {
  const output = captureOutput(() => {
    printAggregate([]);
  });
  assert.ok(output.includes("No entries to aggregate"), `Expected 'No entries to aggregate', got: ${output}`);
});

test("9. --aggregate groups by session and shows session count", () => {
  const entries = [
    { hook: "context-guard", event: "warn", session_id: "s1", ts: "2026-01-01T10:00:00Z", context: { pct: 40 } },
    { hook: "context-guard", event: "warn", session_id: "s2", ts: "2026-01-01T10:01:00Z", context: { pct: 50 } },
    { hook: "stuck-detector", event: "trigger", session_id: "s3", ts: "2026-01-01T10:02:00Z" },
  ];
  const output = captureOutput(() => {
    printAggregate(entries);
  });
  assert.ok(output.includes("Sessions analyzed: 3"), `Expected 'Sessions analyzed: 3', got: ${output}`);
});

test("10. --aggregate computes context usage stats (avg, median, max)", () => {
  // Three sessions with different last context-guard pct values:
  // sess1: last pct = 40.0, sess2: last pct = 60.0, sess3: last pct = 80.0
  // avg = 60.0, median = 60.0 (index 1 of sorted [40,60,80]), max = 80.0
  const entries = [
    { hook: "context-guard", event: "warn", session_id: "sess1", context: { pct: 30.0 } },
    { hook: "context-guard", event: "warn", session_id: "sess1", context: { pct: 40.0 } },
    { hook: "context-guard", event: "warn", session_id: "sess2", context: { pct: 60.0 } },
    { hook: "context-guard", event: "block", session_id: "sess3", context: { pct: 80.0 } },
  ];
  const output = captureOutput(() => {
    printAggregate(entries);
  });
  assert.ok(output.includes("Context usage at last checkpoint"), `Expected context heading: ${output}`);
  assert.ok(output.includes("avg: 60.0%"), `Expected avg 60.0%: ${output}`);
  assert.ok(output.includes("median: 60.0%"), `Expected median 60.0%: ${output}`);
  assert.ok(output.includes("max: 80.0%"), `Expected max 80.0%: ${output}`);
  assert.ok(output.includes("(3 sessions with data)"), `Expected 3 sessions with data: ${output}`);
});

test("11. --aggregate shows hook fire rates", () => {
  const entries = [
    { hook: "context-guard", event: "warn", session_id: "s1" },
    { hook: "context-guard", event: "warn", session_id: "s1" },
    { hook: "context-guard", event: "warn", session_id: "s2" },
    { hook: "stuck-detector", event: "trigger", session_id: "s1" },
  ];
  const output = captureOutput(() => {
    printAggregate(entries);
  });
  assert.ok(output.includes("Hook activity:"), `Expected 'Hook activity:' heading: ${output}`);
  assert.ok(output.includes("context-guard"), `Expected 'context-guard' in hook activity: ${output}`);
  assert.ok(output.includes("stuck-detector"), `Expected 'stuck-detector' in hook activity: ${output}`);
  // context-guard: 3 fires across 2 sessions (1.5/session)
  assert.ok(output.includes("3"), `Expected fire count 3 for context-guard: ${output}`);
  // stuck-detector: 1 fire across 1 session (1.0/session)
  assert.ok(output.includes("1.0/session"), `Expected '1.0/session' for stuck-detector: ${output}`);
});

test("12. --aggregate shows stuck/sycophancy session health rates", () => {
  const entries = [
    // 4 sessions total
    { hook: "stuck-detector", event: "trigger", session_id: "s1" },
    { hook: "sycophancy-detector", event: "warn", session_id: "s2" },
    { hook: "sycophancy-detector", event: "escalate", session_id: "s3" },
    // s4 has no stuck or sycophancy events — just another hook to make it exist
    { hook: "context-guard", event: "warn", session_id: "s4", context: { pct: 30 } },
  ];
  const output = captureOutput(() => {
    printAggregate(entries);
  });
  assert.ok(output.includes("Session health:"), `Expected 'Session health:' heading: ${output}`);
  // 1 stuck session out of 4
  assert.ok(output.includes("1/4"), `Expected '1/4' stuck sessions: ${output}`);
  // 2 sycophancy sessions out of 4
  assert.ok(output.includes("2/4"), `Expected '2/4' sycophancy sessions: ${output}`);
});

// ─── Tests: helpers ───────────────────────────────────────────────────────────

console.log("\nanalyze-logs helpers:");

test("13. formatTime extracts HH:MM:SS from ISO timestamp", () => {
  assert.strictEqual(formatTime("2026-01-01T14:30:45Z"), "14:30:45");
  assert.strictEqual(formatTime("2026-01-01T00:00:00.000Z"), "00:00:00");
});

test("14. formatTime handles step-N fallback", () => {
  assert.strictEqual(formatTime("step-3"), "step-3");
});

test("15. formatTime returns ??:??:?? for null/undefined", () => {
  assert.strictEqual(formatTime(null), "??:??:??");
  assert.strictEqual(formatTime(undefined), "??:??:??");
});

test("16. formatToolSummary returns basename for Read/Write/Edit", () => {
  assert.strictEqual(formatToolSummary("Read", { file_path: "/home/user/project/foo.js" }), "foo.js");
  assert.strictEqual(formatToolSummary("Write", { file_path: "/tmp/bar.txt" }), "bar.txt");
  assert.strictEqual(formatToolSummary("Edit", { file_path: "/src/baz.ts" }), "baz.ts");
});

test("17. formatToolSummary returns truncated command for Bash", () => {
  const longCmd = "a".repeat(80);
  const result = formatToolSummary("Bash", { command: longCmd });
  assert.ok(result.length <= 60, `Expected <=60 chars, got ${result.length}`);
});

test("18. formatToolSummary returns empty string for null input", () => {
  assert.strictEqual(formatToolSummary("Read", null), "");
  assert.strictEqual(formatToolSummary("Bash", null), "");
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
