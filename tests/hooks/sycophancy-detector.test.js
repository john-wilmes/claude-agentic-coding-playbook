#!/usr/bin/env node
// Integration tests for sycophancy-detector.js (PostToolUse hook).
// Zero dependencies — uses only Node built-ins + local test-helpers.
//
// Run: node tests/hooks/sycophancy-detector.test.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const { runHook, runHookRaw } = require("./test-helpers");

const HOOK_PATH = path.resolve(__dirname, "../../templates/hooks/sycophancy-detector.js");

// State directory used by the hook
const STATE_DIR = path.join(os.tmpdir(), "claude-sycophancy-detector");

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

function newSessionId() {
  return `test-${crypto.randomUUID()}`;
}

function getStateFile(sessionId) {
  return path.join(STATE_DIR, `${sessionId}.json`);
}

function cleanupSession(sessionId) {
  try { fs.rmSync(getStateFile(sessionId), { force: true }); } catch {}
}

function runDetector(sessionId, toolName, toolInput, extra = {}) {
  return runHook(HOOK_PATH, {
    session_id: sessionId,
    tool_name: toolName,
    tool_input: toolInput,
    ...extra,
  });
}

/**
 * Run the hook N times with the same payload. Returns only the last result.
 */
function runDetectorN(sessionId, toolName, toolInput, n) {
  let result;
  for (let i = 0; i < n; i++) {
    result = runDetector(sessionId, toolName, toolInput);
  }
  return result;
}

/**
 * Simulate a Read→Edit pattern on the same file (no investigation between).
 * Returns the result of the Edit call.
 */
function readThenEdit(sessionId, filePath) {
  runDetector(sessionId, "Read", { file_path: filePath });
  return runDetector(sessionId, "Edit", { file_path: filePath });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

console.log("\nsycophancy-detector.js:");

// Test 1: Normal operation — single Read returns {} (no warning)
test("1. Single Read returns {} — no warning", () => {
  const sessionId = newSessionId();
  try {
    const result = runDetector(sessionId, "Read", { file_path: "/src/foo.js" });

    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.ok(result.json, "Should output valid JSON");
    assert.strictEqual(result.json.hookSpecificOutput, undefined, "Should not warn on a single Read");
  } finally {
    cleanupSession(sessionId);
  }
});

// Test 2: Normal operation — investigation tools (Read, Grep, Bash) return {}
test("2. Investigation tools (Read, Grep, Bash) return {} with no warning", () => {
  const sessionId = newSessionId();
  try {
    const r1 = runDetector(sessionId, "Read", { file_path: "/src/foo.js" });
    const r2 = runDetector(sessionId, "Grep", { pattern: "function", path: "/src" });
    const r3 = runDetector(sessionId, "Bash", { command: "ls /src" });

    for (const [label, result] of [["Read", r1], ["Grep", r2], ["Bash", r3]]) {
      assert.strictEqual(result.status, 0, `${label} should exit 0`);
      assert.ok(result.json, `${label} should output valid JSON`);
      assert.strictEqual(result.json.hookSpecificOutput, undefined, `${label} should not warn`);
    }
  } finally {
    cleanupSession(sessionId);
  }
});

// Test 3: Quick-edit detection — 4 Read→Edit pairs trigger "warn" at threshold
test("3. Quick-edit: 4 same-file Read→Edit pairs trigger warn", () => {
  const sessionId = newSessionId();
  try {
    // First three Read→Edit pairs (below threshold QUICK_EDIT_WARN=4)
    readThenEdit(sessionId, "/src/a.js");
    readThenEdit(sessionId, "/src/b.js");
    const r3 = readThenEdit(sessionId, "/src/c.js");
    assert.strictEqual(r3.json.hookSpecificOutput, undefined, "Third quick-edit should not warn");

    // Fourth Read→Edit (at threshold QUICK_EDIT_WARN=4)
    const r4 = readThenEdit(sessionId, "/src/d.js");
    assert.ok(r4.json.hookSpecificOutput, "Fourth quick-edit should produce a warning");
    const ctx = r4.json.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes("warn") || ctx.includes("Sycophancy"), "Warning should be present");
    assert.ok(!ctx.includes("escalate"), "Should be warn level, not escalate");
  } finally {
    cleanupSession(sessionId);
  }
});

// Test 4: Compliance run — 6 consecutive Edits trigger "warn" at threshold
test("4. Compliance run: 6 consecutive Edits (no investigation) trigger warn", () => {
  const sessionId = newSessionId();
  try {
    // 5 consecutive Edits — below threshold COMPLIANCE_RUN_WARN=6
    for (let i = 0; i < 5; i++) {
      const r = runDetector(sessionId, "Edit", { file_path: `/src/file${i}.js` });
      assert.strictEqual(r.json.hookSpecificOutput, undefined, `Edit ${i + 1} should not warn`);
    }
    // 6th Edit — at threshold
    const r6 = runDetector(sessionId, "Edit", { file_path: "/src/file5.js" });
    assert.ok(r6.json.hookSpecificOutput, "6th consecutive Edit should warn");
    const ctx = r6.json.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes("6"), "Warning should mention the compliance run length");
  } finally {
    cleanupSession(sessionId);
  }
});

// Test 5: Compliance run escalation — 10+ consecutive Edits trigger "escalate"
test("5. Compliance run escalation: 10 consecutive Edits trigger escalate", () => {
  const sessionId = newSessionId();
  try {
    // 9 consecutive Edits — below COMPLIANCE_RUN_ESCALATE=10
    for (let i = 0; i < 9; i++) {
      runDetector(sessionId, "Edit", { file_path: `/src/file${i}.js` });
    }
    // 10th Edit — at escalation threshold COMPLIANCE_RUN_ESCALATE=10
    const r10 = runDetector(sessionId, "Edit", { file_path: "/src/file9.js" });
    assert.ok(r10.json.hookSpecificOutput, "10th consecutive Edit should warn");
    const ctx = r10.json.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes("escalate"), "Should be escalate level");
  } finally {
    cleanupSession(sessionId);
  }
});

// Test 6: Quick-edit escalation — 7 quick-edits trigger "escalate"
test("6. Quick-edit escalation: 7 quick-edit pairs trigger escalate", () => {
  const sessionId = newSessionId();
  try {
    // 6 quick-edits: 4th triggers warn, 5th and 6th still warn
    readThenEdit(sessionId, "/src/a.js");
    readThenEdit(sessionId, "/src/b.js");
    readThenEdit(sessionId, "/src/c.js");
    readThenEdit(sessionId, "/src/d.js");
    readThenEdit(sessionId, "/src/e.js");
    readThenEdit(sessionId, "/src/f.js");

    // 7th quick-edit — at QUICK_EDIT_ESCALATE=7
    const r7 = readThenEdit(sessionId, "/src/g.js");
    assert.ok(r7.json.hookSpecificOutput, "7th quick-edit should produce output");
    const ctx = r7.json.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes("escalate"), "7th quick-edit should escalate");
  } finally {
    cleanupSession(sessionId);
  }
});

// Test 7: Investigation resets compliance run — interleaving investigation prevents warning
test("7. Investigation between edits resets compliance run — no warning", () => {
  const sessionId = newSessionId();
  try {
    // Pattern: Edit, Edit, Grep (investigation), Edit, Edit — run never reaches 5
    runDetector(sessionId, "Edit", { file_path: "/src/a.js" });
    runDetector(sessionId, "Edit", { file_path: "/src/b.js" });
    runDetector(sessionId, "Grep", { pattern: "foo", path: "/src" }); // breaks run
    runDetector(sessionId, "Edit", { file_path: "/src/c.js" });
    const r = runDetector(sessionId, "Edit", { file_path: "/src/d.js" });

    // Compliance run after the Grep is only 2 — should not warn
    assert.strictEqual(r.json.hookSpecificOutput, undefined,
      "Interleaved investigation should prevent compliance run warning");
  } finally {
    cleanupSession(sessionId);
  }
});

// Test 8: Subagent bypass — agent_id present returns {} immediately
test("8. Subagent bypass: agent_id returns {} with no warning", () => {
  const sessionId = newSessionId();
  try {
    // Even 10 consecutive Edits with agent_id should not warn
    let result;
    for (let i = 0; i < 10; i++) {
      result = runDetector(sessionId, "Edit", { file_path: `/src/file${i}.js` }, {
        agent_id: "subagent-abc-123",
      });
    }
    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.ok(result.json, "Should output valid JSON");
    assert.strictEqual(result.json.hookSpecificOutput, undefined,
      "Subagent calls should never warn");
    // State file should not be created (hook exits early)
    assert.ok(!fs.existsSync(getStateFile(sessionId)),
      "No state file should be created for subagent calls");
  } finally {
    cleanupSession(sessionId);
  }
});

// Test 9: Meta tools (Agent, TaskCreate) return {} and do not affect counts
test("9. Meta tools return {} and do not affect compliance run counts", () => {
  const sessionId = newSessionId();
  try {
    // 4 Edits interspersed with meta tool calls — meta tools should not break or extend run
    runDetector(sessionId, "Edit", { file_path: "/src/a.js" });
    runDetector(sessionId, "Edit", { file_path: "/src/b.js" });

    // Meta tool (categorized as "other") — should return {} and not reset the run
    const meta1 = runDetector(sessionId, "Agent", { prompt: "do something" });
    assert.strictEqual(meta1.json.hookSpecificOutput, undefined, "Agent meta tool should not warn");

    const meta2 = runDetector(sessionId, "TaskCreate", { description: "new task" });
    assert.strictEqual(meta2.json.hookSpecificOutput, undefined, "TaskCreate should not warn");

    // 2 more Edits — run should still be 4 (meta tools don't count or break the run)
    runDetector(sessionId, "Edit", { file_path: "/src/c.js" });
    const r4 = runDetector(sessionId, "Edit", { file_path: "/src/d.js" });
    assert.strictEqual(r4.json.hookSpecificOutput, undefined,
      "4 Edits with meta tools interleaved should not reach warn threshold of 6");
  } finally {
    cleanupSession(sessionId);
  }
});

// Test 10: Session ratio warning — after 20+ actions with >=75% modifications, warn
test("10. Session ratio: >=75% modifications over 20+ actions triggers warn", () => {
  const sessionId = newSessionId();
  try {
    // Strategy: keep compliance run < 6 and quick-edits < 4 so neither threshold fires,
    // but drive modification ratio well above 75% over 20+ total actions.
    //
    // Pattern: 4 Writes (no prior Read on those files → no quick-edit), then 1 Read
    // of a fresh file (breaks compliance run, adds 1 investigation to ratio).
    // Write never has a file_path match from a prior Read, so no quick-edit counted.
    // After 4 rounds: 16 Writes + 4 Reads = 20 actions, ratio = 80% (>= 75%).
    // But MIN_ACTIONS_FOR_RATIO=20: 20 actions = exactly at min threshold.
    // One more Write: 17/21 = 81% >= 75% → triggers ratio warn.
    //
    // Compliance run after last Read = 1 (or 0 if last is Write at threshold boundary).
    // We emit 4 Writes then 1 Read per round: compliance run resets to 0 at each Read.
    // 4 consecutive Writes is below COMPLIANCE_RUN_WARN=6, so no compliance run warning.

    for (let round = 0; round < 4; round++) {
      for (let i = 0; i < 4; i++) {
        runDetector(sessionId, "Write", { file_path: `/out/r${round}f${i}.js` });
      }
      // Break the compliance run with a fresh-file Read (not a file we'll Edit next)
      runDetector(sessionId, "Read", { file_path: `/docs/check-r${round}.md` });
    }
    // At this point: 20 actions, 16 Write + 4 Read = 80% (at threshold, not above).
    // One more Write pushes to 17/21 = 81% — should trigger ratio warn.
    const r = runDetector(sessionId, "Write", { file_path: "/out/final.js" });

    assert.ok(r.json.hookSpecificOutput, "High modification ratio should produce a warning");
    const ctx = r.json.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes("%") || ctx.includes("modification") || ctx.includes("actions"),
      "Warning should mention the ratio or action counts");
  } finally {
    cleanupSession(sessionId);
  }
});

// Test 11: Malformed JSON input — returns {} gracefully, exits 0
test("11. Malformed JSON input returns {} gracefully", () => {
  const result = runHookRaw(HOOK_PATH, "not valid json at all {{{");

  assert.strictEqual(result.status, 0, "Should exit 0 on malformed input");
  assert.ok(result.json, "Should output valid JSON");
  assert.deepStrictEqual(result.json, {}, "Should return empty object on parse error");
});

// Test 12: Pattern resolution — after warning, investigation tool clears wasWarned
test("12. Pattern resolution: investigation after warning clears wasWarned", () => {
  const sessionId = newSessionId();
  try {
    // Trigger a compliance run warning (6 consecutive Edits at COMPLIANCE_RUN_WARN=6)
    for (let i = 0; i < 6; i++) {
      runDetector(sessionId, "Edit", { file_path: `/src/file${i}.js` });
    }

    // Verify warning fired
    const stateAfterWarning = JSON.parse(fs.readFileSync(getStateFile(sessionId), "utf8"));
    assert.strictEqual(stateAfterWarning.wasWarned, true, "wasWarned should be true after warning");

    // Now run an investigation tool — should clear wasWarned
    const rGrep = runDetector(sessionId, "Grep", { pattern: "TODO", path: "/src" });
    assert.strictEqual(rGrep.json.hookSpecificOutput, undefined,
      "Investigation after warning should not itself warn");

    // wasWarned should be cleared in state
    const stateAfterInvestigation = JSON.parse(fs.readFileSync(getStateFile(sessionId), "utf8"));
    assert.strictEqual(stateAfterInvestigation.wasWarned, false,
      "wasWarned should be cleared after investigation tool clears it");
  } finally {
    cleanupSession(sessionId);
  }
});

// Test 13: Investigation actions never trigger warnings even with high scores
test("13. Investigation actions never trigger warnings even with high scores", () => {
  const sessionId = newSessionId();
  try {
    // Build up quick-edit count above QUICK_EDIT_WARN=4 by doing 5 Read→Edit pairs
    readThenEdit(sessionId, "/src/a.js");
    readThenEdit(sessionId, "/src/b.js");
    readThenEdit(sessionId, "/src/c.js");
    readThenEdit(sessionId, "/src/d.js");
    readThenEdit(sessionId, "/src/e.js");
    // At this point quickEditCount >= 4, so a modification would warn.
    // But a Read (investigation) must NOT produce a warning — investigation actions
    // are exempt from warnings even when scores exceed thresholds.
    const rRead = runDetector(sessionId, "Read", { file_path: "/src/f.js" });
    assert.strictEqual(rRead.json.hookSpecificOutput, undefined,
      "Investigation action (Read) should never warn even when quick-edit count is high");

    // Likewise, Grep and Bash should not warn
    const rGrep = runDetector(sessionId, "Grep", { pattern: "TODO", path: "/src" });
    assert.strictEqual(rGrep.json.hookSpecificOutput, undefined,
      "Grep (investigation) should never warn");

    const rBash = runDetector(sessionId, "Bash", { command: "ls /src" });
    assert.strictEqual(rBash.json.hookSpecificOutput, undefined,
      "Bash (investigation) should never warn");
  } finally {
    cleanupSession(sessionId);
  }
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n  ${passed} passed, ${failed} failed\n`);

if (failures.length > 0) {
  console.log("Failures:");
  for (const { name, error } of failures) {
    console.log(`  - ${name}: ${error}`);
  }
  process.exit(1);
}
