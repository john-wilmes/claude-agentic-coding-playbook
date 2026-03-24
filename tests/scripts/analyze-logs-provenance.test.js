#!/usr/bin/env node
/**
 * analyze-logs-provenance.test.js — Tests for buildTimeline, printProvenance,
 * and printFailureChains in scripts/analyze-logs.js.
 *
 * All tests use mock data (no real log files needed).
 *
 * Run: node tests/scripts/analyze-logs-provenance.test.js
 */

"use strict";

const assert = require("assert");
const fs     = require("fs");
const path   = require("path");
const os     = require("os");

const REPO_ROOT    = path.resolve(__dirname, "..", "..");
const ANALYZE_LOGS = path.join(REPO_ROOT, "scripts", "analyze-logs.js");
const TRANSCRIPT_MOD = path.join(REPO_ROOT, "scripts", "transcript-parser.js");

const { buildTimeline, printProvenance, printFailureChains } = require(ANALYZE_LOGS);
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

function hookEntry(hook, event, sessionId, extra = {}) {
  return {
    ts: extra.ts || "2026-01-01T10:00:00Z",
    hook,
    event,
    session_id: sessionId,
    ...extra,
  };
}

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

/**
 * Create a transcript session file at the location transcriptParser expects.
 * Returns a cleanup function.
 */
function createTranscriptFile(projectCwd, sessionId, entries) {
  const encoded = encodeCwd(projectCwd);
  const projectsDir = path.join(os.homedir(), ".claude", "projects", encoded);
  fs.mkdirSync(projectsDir, { recursive: true });
  const filePath = path.join(projectsDir, `${sessionId}.jsonl`);
  fs.writeFileSync(filePath, entries.map(e => JSON.stringify(e)).join("\n") + "\n");
  return function cleanup() {
    try { fs.rmSync(filePath); } catch {}
    try { fs.rmdirSync(projectsDir); } catch {}
  };
}

// ─── Tests: buildTimeline ─────────────────────────────────────────────────────

console.log("\nanalyze-logs buildTimeline:");

test("1. returns empty timeline when no entries and no projectDir", () => {
  const { timeline, toolResultMap } = buildTimeline("sess-none", null, []);
  assert.strictEqual(timeline.length, 0, "Expected empty timeline");
  assert.ok(toolResultMap instanceof Map, "Expected toolResultMap to be a Map");
  assert.strictEqual(toolResultMap.size, 0, "Expected empty toolResultMap");
});

test("2. includes hook events in timeline", () => {
  const entries = [
    hookEntry("stuck-detector", "warn", "sess-bt", {
      ts: "2026-01-01T10:00:00Z",
      details: "Bash",
    }),
    hookEntry("context-guard", "block", "sess-bt", {
      ts: "2026-01-01T10:01:00Z",
      context: { pct: 80.0 },
    }),
  ];
  const { timeline } = buildTimeline("sess-bt", null, entries);
  assert.strictEqual(timeline.length, 2, `Expected 2 events, got ${timeline.length}`);
  assert.strictEqual(timeline[0].type, "hook");
  assert.strictEqual(timeline[0].hook, "stuck-detector");
  assert.strictEqual(timeline[1].hook, "context-guard");
});

test("3. sorts timeline by timestamp", () => {
  // hook at 10:02 comes before hook at 10:03 after sorting
  const entries = [
    hookEntry("stuck-detector", "warn", "sess-sort", { ts: "2026-01-01T10:02:00Z" }),
    hookEntry("context-guard", "warn", "sess-sort", { ts: "2026-01-01T10:01:00Z" }),
  ];
  const { timeline } = buildTimeline("sess-sort", null, entries);
  assert.strictEqual(timeline.length, 2);
  assert.strictEqual(timeline[0].hook, "context-guard", "Earlier event should be first");
  assert.strictEqual(timeline[1].hook, "stuck-detector", "Later event should be second");
});

test("4. includes transcript tool calls when projectDir is provided", () => {
  const sessionId = `bt-tools-${Date.now()}`;
  const fakeProjectCwd = `/tmp/bt-test-${Date.now()}`;
  const transcriptEntries = [
    assistantEntry("Read", { file_path: "/src/foo.js" }, "tu_r1", "2026-01-01T10:00:05Z"),
    toolResultEntry("tu_r1", "contents", false),
  ];
  const cleanup = createTranscriptFile(fakeProjectCwd, sessionId, transcriptEntries);
  try {
    const { timeline, toolResultMap } = buildTimeline(sessionId, fakeProjectCwd, []);
    assert.strictEqual(timeline.length, 1, `Expected 1 tool event, got ${timeline.length}`);
    assert.strictEqual(timeline[0].type, "tool");
    assert.strictEqual(timeline[0].tool, "Read");
    assert.strictEqual(toolResultMap.size, 1, "Expected one result in map");
    assert.strictEqual(toolResultMap.get("tu_r1").is_error, false);
  } finally {
    cleanup();
  }
});

test("5. toolResultMap marks errors correctly", () => {
  const sessionId = `bt-errors-${Date.now()}`;
  const fakeProjectCwd = `/tmp/bt-err-${Date.now()}`;
  const transcriptEntries = [
    assistantEntry("Bash", { command: "npm test" }, "tu_b1", "2026-01-01T10:00:01Z"),
    toolResultEntry("tu_b1", "Error: failed", true),
  ];
  const cleanup = createTranscriptFile(fakeProjectCwd, sessionId, transcriptEntries);
  try {
    const { toolResultMap } = buildTimeline(sessionId, fakeProjectCwd, []);
    assert.ok(toolResultMap.has("tu_b1"), "Expected tu_b1 in toolResultMap");
    assert.strictEqual(toolResultMap.get("tu_b1").is_error, true);
  } finally {
    cleanup();
  }
});

test("6. filters hook entries to matching session only", () => {
  const entries = [
    hookEntry("stuck-detector", "warn", "sess-A", { ts: "2026-01-01T10:00:00Z" }),
    hookEntry("stuck-detector", "warn", "sess-B", { ts: "2026-01-01T10:01:00Z" }),
  ];
  const { timeline } = buildTimeline("sess-A", null, entries);
  assert.strictEqual(timeline.length, 1, `Expected 1 event for sess-A, got ${timeline.length}`);
  assert.strictEqual(timeline[0].hook, "stuck-detector");
});

// ─── Tests: printProvenance ───────────────────────────────────────────────────

console.log("\nanalyze-logs printProvenance:");

test("7. no timeline events shows appropriate message", () => {
  const output = captureOutput(() => {
    printProvenance("sess-empty-prov", null, []);
  });
  assert.ok(output.includes("No timeline events found"), `Expected 'No timeline events found': ${output}`);
});

test("8. no warn/block events shows 'No warn/block/escalate hook events'", () => {
  const entries = [
    hookEntry("model-router", "route", "sess-nowarns", { ts: "2026-01-01T10:00:00Z" }),
  ];
  const output = captureOutput(() => {
    printProvenance("sess-nowarns", null, entries);
  });
  assert.ok(output.includes("No warn/block/escalate"), `Expected no-warn message: ${output}`);
});

test("9. stuck-detector: same tool next → IGNORED", () => {
  const sessionId = `prov-ignored-${Date.now()}`;
  const fakeProjectCwd = `/tmp/prov-ignored-${Date.now()}`;
  // Timeline: stuck-detector warn about Bash at T1, then Bash call at T2
  const transcriptEntries = [
    assistantEntry("Bash", { command: "npm test" }, "tu_b2", "2026-01-01T10:00:10Z"),
    toolResultEntry("tu_b2", "ok", false),
  ];
  const cleanup = createTranscriptFile(fakeProjectCwd, sessionId, transcriptEntries);
  try {
    const hookEntries = [
      hookEntry("stuck-detector", "warn", sessionId, {
        ts: "2026-01-01T10:00:05Z",
        context: { tool: "Bash" },
      }),
    ];
    const output = captureOutput(() => {
      printProvenance(sessionId, fakeProjectCwd, hookEntries);
    });
    assert.ok(output.includes("IGNORED"), `Expected IGNORED classification: ${output}`);
    assert.ok(output.includes("stuck-detector"), `Expected stuck-detector in output: ${output}`);
  } finally {
    cleanup();
  }
});

test("10. stuck-detector: different tool next → CHANGED", () => {
  const sessionId = `prov-changed-${Date.now()}`;
  const fakeProjectCwd = `/tmp/prov-changed-${Date.now()}`;
  // Timeline: stuck-detector warn about Bash at T1, then Read call at T2
  const transcriptEntries = [
    assistantEntry("Read", { file_path: "/src/foo.js" }, "tu_r2", "2026-01-01T10:00:10Z"),
    toolResultEntry("tu_r2", "ok", false),
  ];
  const cleanup = createTranscriptFile(fakeProjectCwd, sessionId, transcriptEntries);
  try {
    const hookEntries = [
      hookEntry("stuck-detector", "warn", sessionId, {
        ts: "2026-01-01T10:00:05Z",
        context: { tool: "Bash" },
      }),
    ];
    const output = captureOutput(() => {
      printProvenance(sessionId, fakeProjectCwd, hookEntries);
    });
    assert.ok(output.includes("CHANGED"), `Expected CHANGED classification: ${output}`);
  } finally {
    cleanup();
  }
});

test("11. end_of_session when no tool follows hook", () => {
  // Only hook events, no tool calls
  const entries = [
    hookEntry("stuck-detector", "warn", "sess-eos", {
      ts: "2026-01-01T10:00:00Z",
      context: { tool: "Bash" },
    }),
  ];
  const output = captureOutput(() => {
    printProvenance("sess-eos", null, entries);
  });
  assert.ok(output.includes("END_OF_SESSION"), `Expected END_OF_SESSION: ${output}`);
});

test("12. context-guard: Skill tool next → CHANGED", () => {
  const sessionId = `prov-cg-skill-${Date.now()}`;
  const fakeProjectCwd = `/tmp/prov-cg-skill-${Date.now()}`;
  const transcriptEntries = [
    assistantEntry("Skill", { name: "checkpoint" }, "tu_sk1", "2026-01-01T10:00:10Z"),
    toolResultEntry("tu_sk1", "ok", false),
  ];
  const cleanup = createTranscriptFile(fakeProjectCwd, sessionId, transcriptEntries);
  try {
    const hookEntries = [
      hookEntry("context-guard", "warn", sessionId, {
        ts: "2026-01-01T10:00:05Z",
        context: { pct: 72.5 },
      }),
    ];
    const output = captureOutput(() => {
      printProvenance(sessionId, fakeProjectCwd, hookEntries);
    });
    assert.ok(output.includes("CHANGED"), `Expected CHANGED for Skill tool after context-guard: ${output}`);
  } finally {
    cleanup();
  }
});

test("13. context-guard: non-wrapup tool next → IGNORED", () => {
  const sessionId = `prov-cg-ignored-${Date.now()}`;
  const fakeProjectCwd = `/tmp/prov-cg-ignored-${Date.now()}`;
  const transcriptEntries = [
    assistantEntry("Read", { file_path: "/src/bar.js" }, "tu_r3", "2026-01-01T10:00:10Z"),
    toolResultEntry("tu_r3", "ok", false),
  ];
  const cleanup = createTranscriptFile(fakeProjectCwd, sessionId, transcriptEntries);
  try {
    const hookEntries = [
      hookEntry("context-guard", "warn", sessionId, {
        ts: "2026-01-01T10:00:05Z",
        context: { pct: 55.0 },
      }),
    ];
    const output = captureOutput(() => {
      printProvenance(sessionId, fakeProjectCwd, hookEntries);
    });
    assert.ok(output.includes("IGNORED"), `Expected IGNORED for Read after context-guard: ${output}`);
  } finally {
    cleanup();
  }
});

test("14. effectiveness summary counts changed vs total", () => {
  const sessionId = `prov-eff-${Date.now()}`;
  const fakeProjectCwd = `/tmp/prov-eff-${Date.now()}`;
  // Two hooks: first followed by different tool (CHANGED), second followed by same tool (IGNORED)
  const transcriptEntries = [
    assistantEntry("Read", { file_path: "/a.js" }, "tu_r4", "2026-01-01T10:00:06Z"),
    toolResultEntry("tu_r4", "ok", false),
    assistantEntry("Bash", { command: "npm test" }, "tu_b3", "2026-01-01T10:00:12Z"),
    toolResultEntry("tu_b3", "ok", false),
  ];
  const cleanup = createTranscriptFile(fakeProjectCwd, sessionId, transcriptEntries);
  try {
    const hookEntries = [
      // Hook about Bash at T1, next tool is Read → CHANGED
      hookEntry("stuck-detector", "warn", sessionId, {
        ts: "2026-01-01T10:00:05Z",
        context: { tool: "Bash" },
      }),
      // Hook about Bash at T2, next tool is also Bash → IGNORED
      hookEntry("stuck-detector", "warn", sessionId, {
        ts: "2026-01-01T10:00:10Z",
        context: { tool: "Bash" },
      }),
    ];
    const output = captureOutput(() => {
      printProvenance(sessionId, fakeProjectCwd, hookEntries);
    });
    assert.ok(output.includes("Hook effectiveness:"), `Expected 'Hook effectiveness:' line: ${output}`);
    assert.ok(output.includes("1/2"), `Expected '1/2' in effectiveness: ${output}`);
    assert.ok(output.includes("50.0%"), `Expected '50.0%' in effectiveness: ${output}`);
  } finally {
    cleanup();
  }
});

test("15. by-hook breakdown shows per-hook stats", () => {
  const sessionId = `prov-byhook-${Date.now()}`;
  const fakeProjectCwd = `/tmp/prov-byhook-${Date.now()}`;
  const transcriptEntries = [
    assistantEntry("Read", { file_path: "/a.js" }, "tu_r5", "2026-01-01T10:00:06Z"),
    toolResultEntry("tu_r5", "ok", false),
  ];
  const cleanup = createTranscriptFile(fakeProjectCwd, sessionId, transcriptEntries);
  try {
    const hookEntries = [
      hookEntry("stuck-detector", "warn", sessionId, {
        ts: "2026-01-01T10:00:05Z",
        context: { tool: "Bash" },
      }),
    ];
    const output = captureOutput(() => {
      printProvenance(sessionId, fakeProjectCwd, hookEntries);
    });
    assert.ok(output.includes("By hook:"), `Expected 'By hook:' section: ${output}`);
    assert.ok(output.includes("stuck-detector"), `Expected 'stuck-detector' in by-hook: ${output}`);
  } finally {
    cleanup();
  }
});

// ─── Tests: printFailureChains ────────────────────────────────────────────────

console.log("\nanalyze-logs printFailureChains:");

test("16. no timeline events shows appropriate message", () => {
  const output = captureOutput(() => {
    printFailureChains("sess-empty-fc", null, []);
  });
  assert.ok(output.includes("No timeline events found"), `Expected 'No timeline events found': ${output}`);
});

test("17. no errors shows 'No failure episodes found'", () => {
  const sessionId = `fc-noerr-${Date.now()}`;
  const fakeProjectCwd = `/tmp/fc-noerr-${Date.now()}`;
  const transcriptEntries = [
    assistantEntry("Read", { file_path: "/src/ok.js" }, "tu_ok2", "2026-01-01T10:00:01Z"),
    toolResultEntry("tu_ok2", "content", false),
  ];
  const cleanup = createTranscriptFile(fakeProjectCwd, sessionId, transcriptEntries);
  try {
    const output = captureOutput(() => {
      printFailureChains(sessionId, fakeProjectCwd, []);
    });
    assert.ok(output.includes("No failure episodes found"), `Expected 'No failure episodes found': ${output}`);
  } finally {
    cleanup();
  }
});

test("18. single error followed by success: 1 recovered episode", () => {
  const sessionId = `fc-single-${Date.now()}`;
  const fakeProjectCwd = `/tmp/fc-single-${Date.now()}`;
  const transcriptEntries = [
    assistantEntry("Bash", { command: "npm run build" }, "tu_fail1", "2026-01-01T10:00:01Z"),
    toolResultEntry("tu_fail1", "Error: build failed", true),
    assistantEntry("Read", { file_path: "/package.json" }, "tu_ok3", "2026-01-01T10:00:10Z"),
    toolResultEntry("tu_ok3", "ok", false),
  ];
  const cleanup = createTranscriptFile(fakeProjectCwd, sessionId, transcriptEntries);
  try {
    const output = captureOutput(() => {
      printFailureChains(sessionId, fakeProjectCwd, []);
    });
    assert.ok(output.includes("Episode 1"), `Expected 'Episode 1': ${output}`);
    assert.ok(output.includes("recovered"), `Expected 'recovered': ${output}`);
    assert.ok(output.includes("✗ Bash"), `Expected failed Bash in output: ${output}`);
    assert.ok(output.includes("✓ Read"), `Expected recovery Read in output: ${output}`);
    assert.ok(output.includes("1 failure episode"), `Expected summary: ${output}`);
    assert.ok(output.includes("1 recovered"), `Expected 1 recovered in summary: ${output}`);
  } finally {
    cleanup();
  }
});

test("19. consecutive errors then success: single episode with multiple failures", () => {
  const sessionId = `fc-multi-${Date.now()}`;
  const fakeProjectCwd = `/tmp/fc-multi-${Date.now()}`;
  const transcriptEntries = [
    assistantEntry("Bash", { command: "npm run build" }, "tu_f1", "2026-01-01T10:00:01Z"),
    toolResultEntry("tu_f1", "Error 1", true),
    assistantEntry("Bash", { command: "npm run build" }, "tu_f2", "2026-01-01T10:00:05Z"),
    toolResultEntry("tu_f2", "Error 2", true),
    assistantEntry("Edit", { file_path: "/config.json" }, "tu_f3", "2026-01-01T10:00:09Z"),
    toolResultEntry("tu_f3", "Error 3", true),
    assistantEntry("Read", { file_path: "/package.json" }, "tu_ok4", "2026-01-01T10:00:15Z"),
    toolResultEntry("tu_ok4", "ok", false),
  ];
  const cleanup = createTranscriptFile(fakeProjectCwd, sessionId, transcriptEntries);
  try {
    const output = captureOutput(() => {
      printFailureChains(sessionId, fakeProjectCwd, []);
    });
    // Should be 1 episode with 3 errors
    assert.ok(output.includes("Episode 1"), `Expected Episode 1: ${output}`);
    // Count ✗ markers — should have 3
    const failMarkers = (output.match(/✗/g) || []).length;
    assert.strictEqual(failMarkers, 3, `Expected 3 failure markers, got ${failMarkers}`);
    assert.ok(output.includes("1 failure episode"), `Expected 1 episode: ${output}`);
  } finally {
    cleanup();
  }
});

test("20. unrecovered episode: ends session without success", () => {
  const sessionId = `fc-unrecov-${Date.now()}`;
  const fakeProjectCwd = `/tmp/fc-unrecov-${Date.now()}`;
  const transcriptEntries = [
    assistantEntry("Bash", { command: "git push --force" }, "tu_bad1", "2026-01-01T10:00:01Z"),
    toolResultEntry("tu_bad1", "Error: blocked", true),
  ];
  const cleanup = createTranscriptFile(fakeProjectCwd, sessionId, transcriptEntries);
  try {
    const output = captureOutput(() => {
      printFailureChains(sessionId, fakeProjectCwd, []);
    });
    assert.ok(output.includes("unrecovered"), `Expected 'unrecovered': ${output}`);
    assert.ok(output.includes("✗ Bash"), `Expected failed Bash: ${output}`);
  } finally {
    cleanup();
  }
});

test("21. hook intervention during episode is shown inline", () => {
  const sessionId = `fc-hook-${Date.now()}`;
  const fakeProjectCwd = `/tmp/fc-hook-${Date.now()}`;
  const transcriptEntries = [
    assistantEntry("Bash", { command: "npm run build" }, "tu_fb1", "2026-01-01T10:00:01Z"),
    toolResultEntry("tu_fb1", "Error", true),
    assistantEntry("Read", { file_path: "/ok.js" }, "tu_ok5", "2026-01-01T10:00:15Z"),
    toolResultEntry("tu_ok5", "ok", false),
  ];
  const cleanup = createTranscriptFile(fakeProjectCwd, sessionId, transcriptEntries);
  try {
    const hookEntries = [
      hookEntry("stuck-detector", "warn", sessionId, {
        ts: "2026-01-01T10:00:08Z",
        context: { tool: "Bash" },
      }),
    ];
    const output = captureOutput(() => {
      printFailureChains(sessionId, fakeProjectCwd, hookEntries);
    });
    assert.ok(output.includes("stuck-detector"), `Expected stuck-detector in episode: ${output}`);
  } finally {
    cleanup();
  }
});

test("22. multiple separate episodes are each reported", () => {
  const sessionId = `fc-twoepisodes-${Date.now()}`;
  const fakeProjectCwd = `/tmp/fc-twoepisodes-${Date.now()}`;
  // Episode 1: Bash fails, Edit recovers
  // Episode 2: Grep fails, Read recovers
  const transcriptEntries = [
    assistantEntry("Bash", { command: "npm test" }, "tu_e1f1", "2026-01-01T10:00:01Z"),
    toolResultEntry("tu_e1f1", "Err", true),
    assistantEntry("Edit", { file_path: "/fix.js" }, "tu_e1r1", "2026-01-01T10:00:05Z"),
    toolResultEntry("tu_e1r1", "ok", false),
    assistantEntry("Grep", { pattern: "TODO" }, "tu_e2f1", "2026-01-01T10:00:10Z"),
    toolResultEntry("tu_e2f1", "Err", true),
    assistantEntry("Read", { file_path: "/todo.js" }, "tu_e2r1", "2026-01-01T10:00:14Z"),
    toolResultEntry("tu_e2r1", "ok", false),
  ];
  const cleanup = createTranscriptFile(fakeProjectCwd, sessionId, transcriptEntries);
  try {
    const output = captureOutput(() => {
      printFailureChains(sessionId, fakeProjectCwd, []);
    });
    assert.ok(output.includes("Episode 1"), `Expected Episode 1: ${output}`);
    assert.ok(output.includes("Episode 2"), `Expected Episode 2: ${output}`);
    assert.ok(output.includes("2 failure episodes"), `Expected '2 failure episodes' in summary: ${output}`);
    assert.ok(output.includes("2 recovered"), `Expected '2 recovered' in summary: ${output}`);
  } finally {
    cleanup();
  }
});

test("23. summary includes avg recovery time for recovered episodes", () => {
  const sessionId = `fc-avgtime-${Date.now()}`;
  const fakeProjectCwd = `/tmp/fc-avgtime-${Date.now()}`;
  // Failure at 10:00:00, recovery at 10:00:30 → 30s
  const transcriptEntries = [
    assistantEntry("Bash", { command: "fail" }, "tu_at1", "2026-01-01T10:00:00Z"),
    toolResultEntry("tu_at1", "Err", true),
    assistantEntry("Read", { file_path: "/ok.js" }, "tu_at2", "2026-01-01T10:00:30Z"),
    toolResultEntry("tu_at2", "ok", false),
  ];
  const cleanup = createTranscriptFile(fakeProjectCwd, sessionId, transcriptEntries);
  try {
    const output = captureOutput(() => {
      printFailureChains(sessionId, fakeProjectCwd, []);
    });
    assert.ok(output.includes("avg recovery time:"), `Expected 'avg recovery time:' in summary: ${output}`);
    assert.ok(output.includes("30s"), `Expected '30s' recovery time: ${output}`);
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
    console.log(`  ✗ ${f.name}: ${f.error}`);
  }
}

process.exit(failed > 0 ? 1 : 0);
