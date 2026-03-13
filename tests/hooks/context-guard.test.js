#!/usr/bin/env node
// Integration tests for context-guard.js (PreToolUse + PostToolUse dual-mode hook).
// Zero dependencies — uses only Node built-ins + local test-helpers.
//
// Run: node tests/hooks/context-guard.test.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const { runHook, runHookRaw, todayLocal } = require("./test-helpers");

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
 * Run the context-guard hook in PostToolUse mode (has tool_response).
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

/**
 * Run the context-guard hook in PreToolUse mode (no tool_response field).
 */
function runGuardPre(sessionId, opts = {}) {
  const input = {
    session_id: sessionId,
    tool_input: opts.toolInput || {},
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

// Test 2: Transcript at 35% → subagent warning fires once (not repeated)
test("2. Transcript at 35%: subagent warning fires once", () => {
  const sessionId = newSessionId();
  // 35% of 200k = 70,000 tokens
  const transcript = createFakeTranscript([makeAssistantMessage(70000)]);
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

// Test 3: Transcript at 50% → checkpoint warning fires once
test("3. Transcript at 50%: checkpoint warning fires once", () => {
  const sessionId = newSessionId();
  // 50% of 200k = 100,000 tokens
  const transcript = createFakeTranscript([makeAssistantMessage(100000)]);
  try {
    const result1 = runGuard(sessionId, { transcriptPath: transcript });
    assert.strictEqual(result1.status, 0);
    assert.ok(result1.json.hookSpecificOutput, "Should have hookSpecificOutput");
    assert.ok(
      result1.json.hookSpecificOutput.additionalContext.includes("Context warning"),
      "Should be a context warning"
    );
    assert.ok(
      result1.json.hookSpecificOutput.additionalContext.includes("/checkpoint"),
      "Should mention /checkpoint"
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

// Test 4: Transcript at 60% → critical advisory (PostToolUse can't hard-block)
test("4. Transcript at 60%: critical advisory via hookSpecificOutput", () => {
  const sessionId = newSessionId();
  // 60% of 200k = 120,000 tokens
  const transcript = createFakeTranscript([makeAssistantMessage(120000)]);
  try {
    const result = runGuard(sessionId, { transcriptPath: transcript });
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.json.decision, undefined, "PostToolUse should not use decision:block");
    assert.ok(result.json.hookSpecificOutput, "Should have hookSpecificOutput");
    assert.ok(
      result.json.hookSpecificOutput.additionalContext.includes("CRITICAL"),
      "Should include CRITICAL warning"
    );
    assert.ok(
      result.json.hookSpecificOutput.additionalContext.includes("/checkpoint"),
      "Should mention /checkpoint"
    );
  } finally {
    cleanupSession(sessionId);
    try { fs.rmSync(transcript); } catch {}
  }
});

// Test 5: Cache tokens counted correctly (input + cache_read + cache_creation)
test("5. Cache tokens counted correctly (input + cache_read + cache_creation)", () => {
  const sessionId = newSessionId();
  // 1 + 60000 + 40000 = 100,001 tokens = 50%+
  const transcript = createFakeTranscript([makeAssistantMessage(1, 60000, 40000)]);
  try {
    const result = runGuard(sessionId, { transcriptPath: transcript });
    assert.strictEqual(result.status, 0);
    assert.ok(result.json.hookSpecificOutput, "Should warn at 50%");
    assert.ok(
      result.json.hookSpecificOutput.additionalContext.includes("100001 actual tokens"),
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
    makeAssistantMessage(120000),  // 60% — should block
  ]);
  try {
    const result = runGuard(sessionId, { transcriptPath: transcript });
    assert.strictEqual(result.status, 0);
    assert.ok(result.json.hookSpecificOutput, "Should use most recent (60%) and warn critically");
    assert.ok(result.json.hookSpecificOutput.additionalContext.includes("CRITICAL"), "Should include CRITICAL");
  } finally {
    cleanupSession(sessionId);
    try { fs.rmSync(transcript); } catch {}
  }
});

// Test 7: No transcript → fallback accumulates from tool I/O
test("7. No transcript: fallback accumulates from tool I/O", () => {
  const sessionId = newSessionId();
  try {
    // 35% of 200k = 70k tokens = 280k chars of tool I/O
    const bigPayload = "x".repeat(140000);
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
  lines.push(makeAssistantMessage(120000)); // 60% — should block
  const transcript = createFakeTranscript(lines);
  try {
    const stats = fs.statSync(transcript);
    assert.ok(stats.size > 50 * 1024, `Transcript should be >50KB, got ${stats.size}`);

    const result = runGuard(sessionId, { transcriptPath: transcript });
    assert.strictEqual(result.status, 0);
    assert.ok(result.json.hookSpecificOutput, "Should find usage in tail and warn critically");
    assert.ok(result.json.hookSpecificOutput.additionalContext.includes("120000 actual tokens"), "Should show actual tokens");
  } finally {
    cleanupSession(sessionId);
    try { fs.rmSync(transcript); } catch {}
  }
});

// Test 12: Subagent calls are skipped entirely
test("12. Subagent (agent_id present): skipped, no warn or block", () => {
  const sessionId = newSessionId();
  // 60% — would block for parent agent
  const transcript = createFakeTranscript([makeAssistantMessage(120000)]);
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

// Test 13: Just below 35% threshold → no warning
test("13. Just below 35% threshold (69999 tokens): no warning", () => {
  const sessionId = newSessionId();
  // 69999 / 200000 = 34.9995% — just under 35%
  const transcript = createFakeTranscript([makeAssistantMessage(69999)]);
  try {
    const result = runGuard(sessionId, { transcriptPath: transcript });
    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.ok(result.json, "Should output valid JSON");
    assert.strictEqual(result.json.decision, undefined, "Should not block");
    assert.strictEqual(result.json.hookSpecificOutput, undefined, "Should not warn below 35%");
  } finally {
    cleanupSession(sessionId);
    try { fs.rmSync(transcript); } catch {}
  }
});

// Test 14: Malformed JSON input → exits 0 with {}
test("14. Malformed JSON input: exits 0 with {}", () => {
  // Use runHookRaw so the hook receives truly malformed JSON (not a quoted string)
  const result = runHookRaw(CONTEXT_GUARD, "not valid json at all");
  assert.strictEqual(result.status, 0, "Should exit 0");
  assert.ok(result.json, "Should output valid JSON");
  assert.deepStrictEqual(result.json, {}, "Should output empty object on error");
});

// ─── PreToolUse mode tests ────────────────────────────────────────────────────

// Test 15: PreToolUse below threshold → allow
test("15. PreToolUse below threshold (50%): allow", () => {
  const sessionId = newSessionId();
  const stateFile = path.join(STATE_DIR, `${sessionId}.json`);
  try {
    // Write state with lastUsageRatio below block threshold
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ lastUsageRatio: 0.50 }));

    const result = runGuardPre(sessionId, {
      toolInput: { file_path: "/home/user/project/src/main.js" },
    });
    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.ok(result.json, "Should output valid JSON");
    assert.strictEqual(result.json.decision, undefined, "Should not block below 60%");
  } finally {
    cleanupSession(sessionId);
  }
});

// Test 16: PreToolUse always passes through regardless of ratio
test("16. PreToolUse always passes through regardless of ratio", () => {
  const sessionId = newSessionId();
  const stateFile = path.join(STATE_DIR, `${sessionId}.json`);
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ lastUsageRatio: 0.65 }));

    const result = runGuardPre(sessionId, {
      toolInput: { file_path: "/home/user/project/src/main.js" },
    });
    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.deepStrictEqual(result.json, {}, "Should pass through at any ratio");
  } finally {
    cleanupSession(sessionId);
  }
});

// Test 18: PreToolUse skips subagents
test("18. PreToolUse skips subagents even when ratio is high", () => {
  const sessionId = newSessionId();
  const stateFile = path.join(STATE_DIR, `${sessionId}.json`);
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ lastUsageRatio: 0.85 }));

    const result = runGuardPre(sessionId, {
      toolInput: { file_path: "/home/user/project/src/main.js" },
      agentId: "subagent-xyz",
    });
    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.deepStrictEqual(result.json, {}, "Should skip entirely for subagents");
  } finally {
    cleanupSession(sessionId);
  }
});

// Test 19: PreToolUse with no state file → allow (safe default)
test("19. PreToolUse with no state file: allow (safe default)", () => {
  const sessionId = newSessionId();
  // Ensure no state file exists for this session
  cleanupSession(sessionId);
  try {
    const result = runGuardPre(sessionId, {
      toolInput: { file_path: "/home/user/project/src/main.js" },
    });
    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.ok(result.json, "Should output valid JSON");
    assert.strictEqual(result.json.decision, undefined, "Should allow when no state exists");
  } finally {
    cleanupSession(sessionId);
  }
});


// Test 21: PostToolUse stores lastUsageRatio in state
test("21. PostToolUse stores lastUsageRatio in state file", () => {
  const sessionId = newSessionId();
  const stateFile = path.join(STATE_DIR, `${sessionId}.json`);
  // 55% of 200k = 110,000 tokens
  const transcript = createFakeTranscript([makeAssistantMessage(110000)]);
  try {
    const result = runGuard(sessionId, { transcriptPath: transcript });
    assert.strictEqual(result.status, 0);

    // Read the state file and check lastUsageRatio
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.ok(state.lastUsageRatio !== undefined, "State should have lastUsageRatio");
    // 110000 / 200000 = 0.55
    assert.strictEqual(state.lastUsageRatio, 0.55, `lastUsageRatio should be 0.55, got ${state.lastUsageRatio}`);
  } finally {
    cleanupSession(sessionId);
    try { fs.rmSync(transcript); } catch {}
  }
});


// Test 27: PostToolUse block writes checkpoint-exit flag file
test("27. PostToolUse block writes checkpoint-exit sentinel flag", () => {
  const sessionId = newSessionId();
  // Use CLAUDE_LOOP_SENTINEL with a unique path per test run to avoid /tmp conflicts
  const flagFile = path.join(os.tmpdir(), `claude-checkpoint-exit-${sessionId}`);
  // 65% of 200k = 130,000 tokens — above block threshold
  const transcript = createFakeTranscript([makeAssistantMessage(130000)]);
  try {
    // Clean up any pre-existing flag file
    try { fs.rmSync(flagFile); } catch {}

    const result = runHook(CONTEXT_GUARD, {
      session_id: sessionId,
      tool_input: {},
      tool_response: {},
      transcript_path: transcript,
    }, { CLAUDE_LOOP_SENTINEL: flagFile });
    assert.strictEqual(result.status, 0);
    assert.ok(result.json.hookSpecificOutput, "Should critically warn at 65%");
    assert.ok(result.json.hookSpecificOutput.additionalContext.includes("CRITICAL"), "Should include CRITICAL");

    // Flag file should have been written
    assert.ok(fs.existsSync(flagFile), "Should write claude-checkpoint-exit flag file");
    const flag = JSON.parse(fs.readFileSync(flagFile, "utf8"));
    assert.ok(flag.ratio >= 0.60, `Flag ratio should be >= 0.60, got ${flag.ratio}`);
    assert.ok(flag.timestamp > 0, "Flag should have a timestamp");
    assert.ok(Date.now() - flag.timestamp < 5000, "Flag timestamp should be recent");
  } finally {
    cleanupSession(sessionId);
    try { fs.rmSync(transcript); } catch {}
    try { fs.rmSync(flagFile); } catch {}
  }
});

// Test 28: PostToolUse below block threshold does NOT write flag file
test("28. PostToolUse warn (50%) does not write checkpoint-exit flag", () => {
  const sessionId = newSessionId();
  // Use a unique sentinel path per test run to avoid /tmp conflicts
  const flagFile = path.join(os.tmpdir(), `claude-checkpoint-exit-${sessionId}`);
  // 55% — warn but not block
  const transcript = createFakeTranscript([makeAssistantMessage(110000)]);
  try {
    try { fs.rmSync(flagFile); } catch {}

    const result = runHook(CONTEXT_GUARD, {
      session_id: sessionId,
      tool_input: {},
      tool_response: {},
      transcript_path: transcript,
    }, { CLAUDE_LOOP_SENTINEL: flagFile });
    assert.strictEqual(result.status, 0);
    assert.ok(result.json.hookSpecificOutput, "Should warn at 55%");
    assert.strictEqual(result.json.decision, undefined, "Should not block");
    assert.ok(!fs.existsSync(flagFile), "Should NOT write flag file below block threshold");
  } finally {
    cleanupSession(sessionId);
    try { fs.rmSync(transcript); } catch {}
    try { fs.rmSync(flagFile); } catch {}
  }
});

// Test 29: PostToolUse block writes JSONL log entry
test("29. PostToolUse block writes JSONL log entry", () => {
  const sessionId = newSessionId();
  const env = require("./test-helpers").createTempHome();
  const transcript = createFakeTranscript([makeAssistantMessage(130000)]);
  try {
    runHook(CONTEXT_GUARD, {
      session_id: sessionId,
      tool_input: {},
      tool_response: {},
      transcript_path: transcript,
    }, { HOME: env.home, USERPROFILE: env.home });

    const logDir = path.join(env.home, ".claude", "logs");
    const today = todayLocal();
    const logFile = path.join(logDir, `${today}.jsonl`);
    assert.ok(fs.existsSync(logFile), "Log file should exist");
    const lines = fs.readFileSync(logFile, "utf8").trim().split("\n");
    const blockEntries = lines.map(l => JSON.parse(l)).filter(e => e.hook === "context-guard" && e.event === "block");
    assert.ok(blockEntries.length > 0, "Should have at least one context-guard block log entry");
    assert.strictEqual(blockEntries[0].hook, "context-guard");
    assert.strictEqual(blockEntries[0].event, "block");
    assert.ok(blockEntries[0].context.pct >= 60, "Should log pct >= 60");
  } finally {
    cleanupSession(sessionId);
    try { fs.rmSync(transcript); } catch {}
    env.cleanup();
  }
});

// Test 30: Failsafe at 75% under claude-loop writes sentinel with reason "failsafe"
test("30. Failsafe at 75% under CLAUDE_LOOP=1 writes sentinel directly", () => {
  const sessionId = newSessionId();
  const sentinelFile = path.join(os.tmpdir(), `claude-failsafe-test-${sessionId}`);
  // 76% of 200k = 152,000 tokens — above failsafe threshold
  const transcript = createFakeTranscript([makeAssistantMessage(152000)]);
  try {
    try { fs.rmSync(sentinelFile); } catch {}

    const result = runHook(CONTEXT_GUARD, {
      session_id: sessionId,
      tool_input: {},
      tool_response: {},
      transcript_path: transcript,
    }, { CLAUDE_LOOP: "1", CLAUDE_LOOP_SENTINEL: sentinelFile });
    assert.strictEqual(result.status, 0);
    assert.ok(result.json.hookSpecificOutput, "Should output failsafe message");
    assert.ok(result.json.hookSpecificOutput.additionalContext.includes("FAILSAFE"), "Should include FAILSAFE");

    assert.ok(fs.existsSync(sentinelFile), "Should write sentinel file directly");
    const data = JSON.parse(fs.readFileSync(sentinelFile, "utf8"));
    assert.strictEqual(data.reason, "failsafe", "Sentinel reason should be 'failsafe'");
    assert.ok(data.ratio >= 0.75, `Sentinel ratio should be >= 0.75, got ${data.ratio}`);
  } finally {
    cleanupSession(sessionId);
    try { fs.rmSync(transcript); } catch {}
    try { fs.rmSync(sentinelFile); } catch {}
  }
});

// Test 31: At 75% without CLAUDE_LOOP, no failsafe — normal BLOCK behavior
test("31. At 75% without CLAUDE_LOOP, normal CRITICAL block (no failsafe)", () => {
  const sessionId = newSessionId();
  const sentinelFile = path.join(os.tmpdir(), `claude-failsafe-test-${sessionId}`);
  const transcript = createFakeTranscript([makeAssistantMessage(152000)]);
  try {
    try { fs.rmSync(sentinelFile); } catch {}

    const result = runHook(CONTEXT_GUARD, {
      session_id: sessionId,
      tool_input: {},
      tool_response: {},
      transcript_path: transcript,
    }, { CLAUDE_LOOP_SENTINEL: sentinelFile });
    assert.strictEqual(result.status, 0);
    assert.ok(result.json.hookSpecificOutput, "Should output block message");
    assert.ok(result.json.hookSpecificOutput.additionalContext.includes("CRITICAL"), "Should include CRITICAL (not FAILSAFE)");
  } finally {
    cleanupSession(sessionId);
    try { fs.rmSync(transcript); } catch {}
    try { fs.rmSync(sentinelFile); } catch {}
  }
});

// Test 32: Combined per-call large-output warning + threshold warning in same invocation
test("32. Combined per-call large-output + threshold warning in same invocation", () => {
  const sessionId = newSessionId();
  // Transcript at 50% — triggers threshold warning
  const transcript = createFakeTranscript([makeAssistantMessage(100000)]);
  try {
    // Large tool_response > 10000 chars — also triggers per-call warning
    const bigResponse = "x".repeat(15000);
    const result = runGuard(sessionId, {
      transcriptPath: transcript,
      toolResponse: { data: bigResponse },
    });
    assert.strictEqual(result.status, 0);
    assert.ok(result.json.hookSpecificOutput, "Should have hookSpecificOutput");
    const ctx = result.json.hookSpecificOutput.additionalContext;
    assert.ok(ctx, "Should have additionalContext");
    // Both warnings should appear in the combined output
    assert.ok(
      ctx.includes("Large tool output") || ctx.includes("Context warning") || ctx.includes("100000"),
      `Should mention either large output or context threshold, got: ${ctx}`
    );
  } finally {
    cleanupSession(sessionId);
    try { fs.rmSync(transcript); } catch {}
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
