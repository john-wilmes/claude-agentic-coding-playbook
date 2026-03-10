#!/usr/bin/env node
// Integration tests for context-guard.js (PostToolUse hook).
// Zero dependencies — uses only Node built-ins + local test-helpers.
//
// Run: node tests/hooks/context-guard.test.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const { runHook } = require("./test-helpers");

// Resolve hook path relative to repo root
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const CONTEXT_GUARD = path.join(REPO_ROOT, "templates", "hooks", "context-guard.js");

// State directory used by the hook
const STATE_DIR = path.join(os.tmpdir(), "claude-context-guard");

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

function cleanupSession(sessionId) {
  const stateFile = path.join(STATE_DIR, `${sessionId}.json`);
  try { fs.rmSync(stateFile, { force: true }); } catch {}
}

/**
 * Create a fake transcript JSONL file with the given messages.
 */
function createFakeTranscript(messages) {
  const tmpFile = path.join(os.tmpdir(), `transcript-test-${crypto.randomUUID()}.jsonl`);
  const lines = messages.map(m => JSON.stringify(m));
  fs.writeFileSync(tmpFile, lines.join("\n") + "\n");
  return tmpFile;
}

/**
 * Create an assistant message entry with usage data for a fake transcript.
 */
function makeAssistantMessage(inputTokens, cacheRead = 0, cacheCreation = 0) {
  return {
    type: "assistant",
    message: {
      usage: {
        input_tokens: inputTokens,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreation,
        output_tokens: 500,
      },
    },
  };
}

/**
 * Run the context-guard hook with optional transcript path and tool payloads.
 */
function runGuard(sessionId, opts = {}) {
  const input = {
    session_id: sessionId,
    tool_input: opts.toolInput || {},
    tool_response: opts.toolResponse || {},
    transcript_path: opts.transcriptPath || undefined,
  };
  if (opts.agentId) input.agent_id = opts.agentId;
  return runHook(CONTEXT_GUARD, input);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

console.log("\ncontext-guard.js:");

// Test 1: Transcript below thresholds → no output
test("1. Transcript below thresholds: no output", () => {
  const sessionId = newSessionId();
  // 30% of 200k = 60,000 tokens
  const transcript = createFakeTranscript([makeAssistantMessage(60000)]);
  try {
    const result = runGuard(sessionId, { transcriptPath: transcript });
    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.ok(result.json, "Should output valid JSON");
    assert.strictEqual(result.json.decision, undefined, "Should not block");
    assert.strictEqual(result.json.hookSpecificOutput, undefined, "Should not warn");
  } finally {
    cleanupSession(sessionId);
    try { fs.rmSync(transcript); } catch {}
  }
});

// Test 2: Transcript at 40% → subagent warning fires once (not repeated)
test("2. Transcript at 40%: subagent warning fires once", () => {
  const sessionId = newSessionId();
  // 40% of 200k = 80,000 tokens
  const transcript = createFakeTranscript([makeAssistantMessage(80000)]);
  try {
    const result1 = runGuard(sessionId, { transcriptPath: transcript });
    assert.strictEqual(result1.status, 0);
    assert.ok(result1.json.hookSpecificOutput, "Should have hookSpecificOutput");
    assert.ok(
      result1.json.hookSpecificOutput.additionalContext.includes("Context note"),
      "Should be a context note"
    );
    assert.ok(
      result1.json.hookSpecificOutput.additionalContext.includes("subagent"),
      "Should mention subagent"
    );

    // Second call — should not warn again
    const result2 = runGuard(sessionId, { transcriptPath: transcript });
    assert.strictEqual(result2.status, 0);
    assert.strictEqual(result2.json.hookSpecificOutput, undefined, "Should not warn twice");
  } finally {
    cleanupSession(sessionId);
    try { fs.rmSync(transcript); } catch {}
  }
});

// Test 3: Transcript at 60% → compact warning fires once
test("3. Transcript at 60%: compact warning fires once", () => {
  const sessionId = newSessionId();
  // 60% of 200k = 120,000 tokens
  const transcript = createFakeTranscript([makeAssistantMessage(120000)]);
  try {
    const result1 = runGuard(sessionId, { transcriptPath: transcript });
    assert.strictEqual(result1.status, 0);
    assert.ok(result1.json.hookSpecificOutput, "Should have hookSpecificOutput");
    assert.ok(
      result1.json.hookSpecificOutput.additionalContext.includes("Context warning"),
      "Should be a context warning"
    );
    assert.ok(
      result1.json.hookSpecificOutput.additionalContext.includes("/compact"),
      "Should mention /compact"
    );

    // Second call — should not warn again
    const result2 = runGuard(sessionId, { transcriptPath: transcript });
    assert.strictEqual(result2.status, 0);
    assert.strictEqual(result2.json.hookSpecificOutput, undefined, "Should not warn twice");
    assert.strictEqual(result2.json.decision, undefined, "Should not block");
  } finally {
    cleanupSession(sessionId);
    try { fs.rmSync(transcript); } catch {}
  }
});

// Test 4: Transcript at 70% → block decision
test("4. Transcript at 70%: block decision", () => {
  const sessionId = newSessionId();
  // 70% of 200k = 140,000 tokens
  const transcript = createFakeTranscript([makeAssistantMessage(140000)]);
  try {
    const result = runGuard(sessionId, { transcriptPath: transcript });
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.json.decision, "block", "Should block");
    assert.ok(result.json.reason.includes("/checkpoint"), "Should mention /checkpoint");
  } finally {
    cleanupSession(sessionId);
    try { fs.rmSync(transcript); } catch {}
  }
});

// Test 5: Cache tokens counted correctly (input + cache_read + cache_creation)
test("5. Cache tokens counted correctly (input + cache_read + cache_creation)", () => {
  const sessionId = newSessionId();
  // 1 + 80000 + 40000 = 120,001 tokens = 60%+
  const transcript = createFakeTranscript([makeAssistantMessage(1, 80000, 40000)]);
  try {
    const result = runGuard(sessionId, { transcriptPath: transcript });
    assert.strictEqual(result.status, 0);
    assert.ok(result.json.hookSpecificOutput, "Should warn at 60%");
    assert.ok(
      result.json.hookSpecificOutput.additionalContext.includes("120001 actual tokens"),
      `Should show actual token count, got: ${result.json.hookSpecificOutput.additionalContext}`
    );
  } finally {
    cleanupSession(sessionId);
    try { fs.rmSync(transcript); } catch {}
  }
});

// Test 6: Multiple assistant messages → uses most recent
test("6. Multiple assistant messages: uses most recent", () => {
  const sessionId = newSessionId();
  const transcript = createFakeTranscript([
    makeAssistantMessage(60000),   // 30% — below threshold
    { type: "user", message: { content: "do something" } },
    makeAssistantMessage(140000),  // 70% — should block
  ]);
  try {
    const result = runGuard(sessionId, { transcriptPath: transcript });
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.json.decision, "block", "Should use most recent (70%) and block");
  } finally {
    cleanupSession(sessionId);
    try { fs.rmSync(transcript); } catch {}
  }
});

// Test 7: No transcript → fallback accumulates from tool I/O
test("7. No transcript: fallback accumulates from tool I/O", () => {
  const sessionId = newSessionId();
  try {
    // 40% of 200k = 80k tokens = 320k chars of tool I/O
    const bigPayload = "x".repeat(160000);
    const result = runGuard(sessionId, {
      toolInput: { data: bigPayload },
      toolResponse: { data: bigPayload },
    });
    assert.strictEqual(result.status, 0);
    assert.ok(result.json.hookSpecificOutput, "Should have hookSpecificOutput from fallback");
    assert.ok(
      result.json.hookSpecificOutput.additionalContext.includes("estimated from tool I/O"),
      `Should use fallback stats, got: ${result.json.hookSpecificOutput.additionalContext}`
    );
  } finally {
    cleanupSession(sessionId);
  }
});

// Test 8: Transcript path doesn't exist → graceful fallback
test("8. Transcript path doesn't exist: graceful fallback", () => {
  const sessionId = newSessionId();
  try {
    const result = runGuard(sessionId, {
      transcriptPath: "/nonexistent/path/transcript.jsonl",
      toolResponse: { content: "small response" },
    });
    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.ok(result.json, "Should output valid JSON");
    // With small response, should not trigger any threshold
    assert.strictEqual(result.json.decision, undefined, "Should not block");
  } finally {
    cleanupSession(sessionId);
  }
});

// Test 9: Transcript with no assistant messages → fallback
test("9. Transcript with no assistant messages: fallback", () => {
  const sessionId = newSessionId();
  const transcript = createFakeTranscript([
    { type: "user", message: { content: "hello" } },
    { type: "user", message: { content: "world" } },
  ]);
  try {
    const result = runGuard(sessionId, {
      transcriptPath: transcript,
      toolResponse: { content: "small" },
    });
    assert.strictEqual(result.status, 0);
    assert.ok(result.json, "Should output valid JSON");
    assert.strictEqual(result.json.decision, undefined, "Should not block with small fallback");
  } finally {
    cleanupSession(sessionId);
    try { fs.rmSync(transcript); } catch {}
  }
});

// Test 10: Per-call large-output warning fires independently
test("10. Per-call large-output warning fires independently", () => {
  const sessionId = newSessionId();
  // Transcript at 30% — below all thresholds
  const transcript = createFakeTranscript([makeAssistantMessage(60000)]);
  try {
    // Large tool_response > 10000 chars
    const bigResponse = "x".repeat(15000);
    const result = runGuard(sessionId, {
      transcriptPath: transcript,
      toolResponse: { data: bigResponse },
    });
    assert.strictEqual(result.status, 0);
    assert.ok(result.json.hookSpecificOutput, "Should have hookSpecificOutput");
    assert.ok(
      result.json.hookSpecificOutput.additionalContext.includes("Large tool output"),
      `Should mention large tool output, got: ${result.json.hookSpecificOutput.additionalContext}`
    );
  } finally {
    cleanupSession(sessionId);
    try { fs.rmSync(transcript); } catch {}
  }
});

// Test 11: Large transcript (>50KB) → tail read still finds usage
test("11. Large transcript (>50KB): tail read still finds usage", () => {
  const sessionId = newSessionId();
  // Create a transcript > 50KB with assistant message near the end
  const lines = [];
  for (let i = 0; i < 600; i++) {
    lines.push({ type: "user", message: { content: "padding " + "x".repeat(80) } });
  }
  lines.push(makeAssistantMessage(140000)); // 70% — should block
  const transcript = createFakeTranscript(lines);
  try {
    const stats = fs.statSync(transcript);
    assert.ok(stats.size > 50 * 1024, `Transcript should be >50KB, got ${stats.size}`);

    const result = runGuard(sessionId, { transcriptPath: transcript });
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.json.decision, "block", "Should find usage in tail and block");
    assert.ok(result.json.reason.includes("140000 actual tokens"), "Should show actual tokens");
  } finally {
    cleanupSession(sessionId);
    try { fs.rmSync(transcript); } catch {}
  }
});

// Test 12: Subagent calls are skipped entirely
test("12. Subagent (agent_id present): skipped, no warn or block", () => {
  const sessionId = newSessionId();
  // 70% — would block for parent agent
  const transcript = createFakeTranscript([makeAssistantMessage(140000)]);
  try {
    const result = runGuard(sessionId, {
      transcriptPath: transcript,
      agentId: "agent-abc123",
    });
    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.ok(result.json, "Should output valid JSON");
    assert.deepStrictEqual(result.json, {}, "Should skip entirely for subagents");
  } finally {
    cleanupSession(sessionId);
    try { fs.rmSync(transcript); } catch {}
  }
});

// Test 13: Just below 40% threshold → no warning
test("13. Just below 40% threshold (79999 tokens): no warning", () => {
  const sessionId = newSessionId();
  // 79999 / 200000 = 39.9995% — just under 40%
  const transcript = createFakeTranscript([makeAssistantMessage(79999)]);
  try {
    const result = runGuard(sessionId, { transcriptPath: transcript });
    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.ok(result.json, "Should output valid JSON");
    assert.strictEqual(result.json.decision, undefined, "Should not block");
    assert.strictEqual(result.json.hookSpecificOutput, undefined, "Should not warn below 40%");
  } finally {
    cleanupSession(sessionId);
    try { fs.rmSync(transcript); } catch {}
  }
});

// Test 14: Malformed JSON input → exits 0 with {}
test("14. Malformed JSON input: exits 0 with {}", () => {
  const result = runHook(CONTEXT_GUARD, "not valid json at all");
  assert.strictEqual(result.status, 0, "Should exit 0");
  assert.ok(result.json, "Should output valid JSON");
  assert.deepStrictEqual(result.json, {}, "Should output empty object on error");
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
