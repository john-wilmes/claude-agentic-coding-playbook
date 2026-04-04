// Dual-mode context guard: PreToolUse (pass-through) + PostToolUse (measure & warn).
//
// PostToolUse (no matcher — fires on ALL tools):
//   Reads transcript, computes usage, warns at 35%/50%, advisory at 60%.
//   Writes context-high flag at 60% (for /checkpoint). Failsafe sentinel at 75% (claude-loop only).
//
// PreToolUse (no matcher — fires on ALL tools):
//   Pure pass-through. Always returns {}. No hard blocks — all enforcement is
//   advisory via PostToolUse. This avoids deadlocks where the agent is in a
//   mode (e.g. plan mode) that requires tools not on an allowlist.
//
// Primary: reads actual token counts from the session transcript JSONL.
// Fallback: estimates from tool I/O sizes when transcript is unavailable.

function respond(payload = {}) {
  process.stdout.write(JSON.stringify(payload), () => process.exit(0));
}

const fs = require("fs");
const path = require("path");
const os = require("os");

let log;
try { log = require("./log"); } catch { log = { writeLog() {}, promptHead(t) { return t; } }; }

let modelConfig;
try { modelConfig = require("./model-config"); } catch { modelConfig = null; }

// Approximate tokens per character (conservative estimate, used in fallback only)
const CHARS_PER_TOKEN = 4;
// Fallback context window when model-config is unavailable
const DEFAULT_CONTEXT_WINDOW = 200_000;

const SUBAGENT_THRESHOLD = 0.35;
const PERSIST_THRESHOLD = 0.42; // One-shot: persist unsaved findings before pressure hits
const WARN_THRESHOLD = 0.57;
const BLOCK_THRESHOLD = 0.60;
const FAILSAFE_THRESHOLD = 0.75; // Last resort: write sentinel directly under claude-loop

// Minimum tool calls before BLOCK/FAILSAFE can trigger.
// At claude-loop wakeup, SessionStart injects a large context (memory, CLAUDE.md,
// lessons) that can push usage past 60% before any real work is done — causing an
// immediate checkpoint that restarts the loop endlessly. This grace period lets the
// agent do at least a few turns of work before being forced to checkpoint.
// WARN thresholds still fire immediately so the agent is aware.
const MIN_CALLS_BEFORE_BLOCK = 5;
// When baseline context at session start is already above BLOCK_THRESHOLD,
// only block when context grows this many percentage points above the baseline.
// Prevents infinite restart loops when SessionStart injects large context.
const BASELINE_HEADROOM = 0.08;

// State file tracks warning flags and fallback accumulator across invocations
function getStateFile(sessionId) {
  const dir = path.join(os.tmpdir(), "claude-context-guard");
  try { fs.mkdirSync(dir, { mode: 0o700, recursive: true }); } catch {}
  return path.join(dir, `${path.basename(sessionId)}.json`);
}

function loadState(stateFile) {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      subagentWarned: raw.subagentWarned || false,
      persistWarned: raw.persistWarned || false,
      warned: raw.warned || false,
      warnedAtCall: raw.warnedAtCall || 0,
      cumulativeEstimatedTokens: raw.cumulativeEstimatedTokens || 0,
      toolCalls: raw.toolCalls || 0,
      baselineRatio: raw.baselineRatio || 0,
    };
  } catch {
    return { subagentWarned: false, persistWarned: false, warned: false, warnedAtCall: 0, cumulativeEstimatedTokens: 0, toolCalls: 0, baselineRatio: 0 };
  }
}

function saveState(stateFile, state) {
  try {
    fs.writeFileSync(stateFile, JSON.stringify(state));
  } catch {}
}

/**
 * Read the most recent assistant message's usage from the transcript JSONL.
 * Reads only the last 512KB (512 * 1024 bytes) to handle large transcripts efficiently.
 *
 * NOTE: The transcript JSONL schema is undocumented and may change between
 * Claude Code versions. This function gracefully returns null on any parse
 * failure, falling back to tool I/O estimation.
 */
function readTranscriptUsage(transcriptPath) {
  if (!transcriptPath) return null;
  try {
    const stats = fs.statSync(transcriptPath);
    const size = stats.size;
    const TAIL_SIZE = 512 * 1024;
    const start = Math.max(0, size - TAIL_SIZE);

    const fd = fs.openSync(transcriptPath, "r");
    const bufSize = Math.min(size, TAIL_SIZE);
    const buffer = Buffer.alloc(bufSize);
    fs.readSync(fd, buffer, 0, bufSize, start);
    fs.closeSync(fd);

    const text = buffer.toString("utf8");
    const lines = text.split("\n");

    // Skip first partial line if we started mid-file
    if (start > 0) {
      lines.shift();
    }

    // Scan in reverse for most recent assistant message with usage
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === "assistant" && entry.message && entry.message.usage &&
            typeof entry.message.usage.input_tokens === "number") {
          return entry.message.usage;
        }
      } catch {}
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Get context usage ratio and stats string.
 * Primary: transcript-based actual token counts.
 * Fallback: cumulative estimation from tool I/O sizes.
 */
function getContextUsage(hookInput, state, contextWindow) {
  const usage = readTranscriptUsage(hookInput.transcript_path);

  if (usage) {
    // Fields are additive: input_tokens is the uncached portion only.
    // Verified against real transcripts — total context = all three summed.
    const totalTokens = (usage.input_tokens || 0) +
                        (usage.cache_read_input_tokens || 0) +
                        (usage.cache_creation_input_tokens || 0) +
                        (usage.output_tokens || 0);
    return {
      ratio: totalTokens / contextWindow,
      tokens: totalTokens,
      stats: `(${totalTokens} actual tokens, ${contextWindow / 1000}k window)`,
    };
  }

  // Fallback: estimate from tool I/O (both input and response).
  // Tool I/O is only a fraction of total context — system prompt, conversation
  // history, and assistant turns typically add ~2x overhead. Apply a 2x
  // multiplier so the estimate is conservative rather than severely low.
  const IO_OVERHEAD_MULTIPLIER = 2;
  const inputStr = JSON.stringify(hookInput.tool_input || {});
  const responseStr = JSON.stringify(hookInput.tool_response || {});
  const ioChars = inputStr.length + responseStr.length;

  state.cumulativeEstimatedTokens += Math.round((ioChars / CHARS_PER_TOKEN) * IO_OVERHEAD_MULTIPLIER);

  return {
    ratio: state.cumulativeEstimatedTokens / contextWindow,
    tokens: state.cumulativeEstimatedTokens,
    stats: `(~${state.cumulativeEstimatedTokens} tokens estimated from tool I/O x${IO_OVERHEAD_MULTIPLIER}, ${state.toolCalls} calls, ${contextWindow / 1000}k window)`,
  };
}

let input = "";
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    const hookInput = JSON.parse(input);

    // Subagents have their own disposable context — skip the guard entirely.
    // agent_id is present only when the hook fires inside a subagent.
    if (hookInput.agent_id) {
      log.writeLog({ hook: "context-guard", event: "skip", details: "Subagent call skipped", session_id: hookInput.session_id, tool_use_id: hookInput.tool_use_id, agent_id: hookInput.agent_id, project: hookInput.cwd });
      return respond();
    }

    // Mode detection: PreToolUse has no tool_response field.
    const isPreToolUse = !("tool_response" in hookInput);

    const sessionId = hookInput.session_id || "unknown";
    const stateFile = getStateFile(sessionId);

    // ── PreToolUse pass-through ─────────────────────────────────────────
    // No hard blocks. All enforcement is advisory via PostToolUse.
    if (isPreToolUse) {
      return respond();
    }

    // ── PostToolUse path ──────────────────────────────────────────────────
    const state = loadState(stateFile);
    state.toolCalls += 1;

    // Derive context window from session model (set by session-start hook).
    // Falls back to 200k if model-config is unavailable or session has no model state.
    const sessionModelCfg = modelConfig
      ? modelConfig.getSessionModel(sessionId)
      : { contextWindow: DEFAULT_CONTEXT_WINDOW };
    const contextWindow = sessionModelCfg.contextWindow || DEFAULT_CONTEXT_WINDOW;

    const ctx = getContextUsage(hookInput, state, contextWindow);

    if (state.toolCalls === 1) {
      state.baselineRatio = ctx.ratio;
    }
    const pct = Math.round(ctx.ratio * 100);

    // Per-call size warning: flag individual large tool results.
    // Scale threshold with context window: 25k chars at 200k window → 125k at 1M.
    const responseStr = JSON.stringify(hookInput.tool_response || {});
    const responseChars = responseStr.length;
    const PER_CALL_WARN_CHARS = Math.round(25000 * (contextWindow / DEFAULT_CONTEXT_WINDOW));
    const perCallWarning = responseChars > PER_CALL_WARN_CHARS
      ? ` Large tool output (~${Math.round(responseChars / CHARS_PER_TOKEN)} tokens this call). Delegate multi-file work to subagents.`
      : "";

    let output;
    // Failsafe: at 75% under claude-loop, write sentinel directly.
    // This fires if Claude ignored the 60% checkpoint instruction.
    // We lose the handoff (no memory update/commit), but it's better
    // than hitting 80% auto-compaction which destroys context entirely.
    if (ctx.ratio >= FAILSAFE_THRESHOLD && process.env.CLAUDE_LOOP === "1" && state.toolCalls >= MIN_CALLS_BEFORE_BLOCK) {
      try {
        // Use CLAUDE_LOOP_PID to compute sentinel path — Claude Code may override
        // CLAUDE_LOOP_SENTINEL after changing process.cwd() to the project directory.
        // Validate PID is numeric to prevent path traversal.
        const rawPid = process.env.CLAUDE_LOOP_PID;
        const validPid = rawPid && /^\d+$/.test(rawPid) ? rawPid : null;
        // Validate CLAUDE_LOOP_SENTINEL path to prevent path traversal.
        // Resolve to canonical path before checking prefix to defeat /tmp/../../ attacks.
        const rawSentinel = process.env.CLAUDE_LOOP_SENTINEL;
        const resolvedSentinel = rawSentinel ? path.resolve(rawSentinel) : null;
        const tmpDir = path.resolve(os.tmpdir());
        const validSentinel = resolvedSentinel && resolvedSentinel.startsWith(tmpDir + path.sep)
          ? resolvedSentinel : null;
        const sentinelPath = validPid
          ? path.join(os.tmpdir(), `claude-checkpoint-exit-${validPid}`)
          : (validSentinel || path.join(os.tmpdir(), "claude-checkpoint-exit"));
        fs.writeFileSync(
          sentinelPath,
          JSON.stringify({ reason: "failsafe", ratio: ctx.ratio, timestamp: Date.now() })
        );
      } catch {}
      log.writeLog({
        hook: "context-guard",
        event: "failsafe",
        session_id: hookInput.session_id,
        tool_use_id: hookInput.tool_use_id,
        details: `Failsafe sentinel: ${pct}% context, checkpoint instruction was ignored`,
        project: hookInput.cwd,
        context: { mode: "post", ratio: ctx.ratio, pct, tokens: ctx.tokens },
      });
      output = {
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext:
            `FAILSAFE: ${pct}% context used. Sentinel written directly — claude-loop will restart. Run /exit NOW.`,
        },
      };
    } else {
      // Compute effective block threshold: if baseline was already above 60%,
      // only block when context grows 8pp above that baseline (avoids infinite
      // restart loops when SessionStart injects large context).
      const effectiveBlockThreshold = (state.baselineRatio >= BLOCK_THRESHOLD)
        ? state.baselineRatio + BASELINE_HEADROOM
        : BLOCK_THRESHOLD;
      if (ctx.ratio >= effectiveBlockThreshold && state.toolCalls >= MIN_CALLS_BEFORE_BLOCK) {
        // Write the context-high flag so /checkpoint can decide EXIT vs STAY.
        // This is NOT the sentinel — claude-loop does NOT watch this file.
        try {
          const rawFlagPid = process.env.CLAUDE_LOOP_PID;
          const validFlagPid = rawFlagPid && /^\d+$/.test(rawFlagPid) ? rawFlagPid : null;
          const flagPath = validFlagPid
            ? path.join(os.tmpdir(), `claude-context-high-${validFlagPid}`)
            : path.join(os.tmpdir(), "claude-context-high");
          fs.writeFileSync(
            flagPath,
            JSON.stringify({ reason: "context-high", ratio: ctx.ratio, session_id: hookInput.session_id, timestamp: Date.now() })
          );
        } catch {}
        log.writeLog({
          hook: "context-guard",
          event: "block",
          session_id: hookInput.session_id,
          tool_use_id: hookInput.tool_use_id,
          details: `PostToolUse block: ${pct}% context used`,
          project: hookInput.cwd,
          context: { mode: "post", ratio: ctx.ratio, pct, tokens: ctx.tokens },
        });
        output = {
          hookSpecificOutput: {
            hookEventName: "PostToolUse",
            additionalContext:
              `CRITICAL: ${pct}% context used ${ctx.stats}. ` +
              `Invoke the /checkpoint skill NOW — do not ask the user, do not read new files, do not start new work. ` +
              `After checkpoint completes, stop all output immediately.`,
          },
        };
      } else if (ctx.ratio >= WARN_THRESHOLD) {
        // Re-fire every WARN_REFIRE_INTERVAL calls after first warning to maintain pressure.
        // One-shot warnings have 0% effectiveness — agents ignore and forget them.
        const WARN_REFIRE_INTERVAL = 15;
        const shouldFire = !state.warned || (state.toolCalls - (state.warnedAtCall || 0)) % WARN_REFIRE_INTERVAL === 0;
        if (!state.warned) {
          state.warned = true;
          state.warnedAtCall = state.toolCalls;
        }
        state.subagentWarned = true; // 50% implies 35% already passed
        if (shouldFire) {
          log.writeLog({
            hook: "context-guard",
            event: "warn",
            session_id: hookInput.session_id,
            tool_use_id: hookInput.tool_use_id,
            details: `PostToolUse warn: ${pct}% context used`,
            project: hookInput.cwd,
            context: { mode: "post", ratio: ctx.ratio, pct, tokens: ctx.tokens },
          });
          output = {
            hookSpecificOutput: {
              hookEventName: "PostToolUse",
              additionalContext:
                `Context warning: ${pct}% used ${ctx.stats}. ` +
                `Finish your current subtask, then invoke /checkpoint automatically — do not ask the user.` + perCallWarning,
            },
          };
        } else {
          output = perCallWarning ? {
            hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: `Context note:${perCallWarning}` },
          } : {};
        }
      } else if (ctx.ratio >= PERSIST_THRESHOLD && !state.persistWarned) {
        state.persistWarned = true;
        state.subagentWarned = true; // 42% implies 35% already passed
        output = {
          hookSpecificOutput: {
            hookEventName: "PostToolUse",
            additionalContext:
              `Context at ${pct}% ${ctx.stats}. If you have unsaved findings from this session, ` +
              `write them to topic files now while you have comfortable headroom — before checkpoint pressure hits.` + perCallWarning,
          },
        };
      } else if (ctx.ratio >= SUBAGENT_THRESHOLD && !state.subagentWarned) {
        state.subagentWarned = true;
        log.writeLog({
          hook: "context-guard",
          event: "warn",
          session_id: hookInput.session_id,
          tool_use_id: hookInput.tool_use_id,
          details: `PostToolUse note: ${pct}% context used — delegate to subagents`,
          project: hookInput.cwd,
          context: { mode: "post", ratio: ctx.ratio, pct, tokens: ctx.tokens },
        });
        output = {
          hookSpecificOutput: {
            hookEventName: "PostToolUse",
            additionalContext:
              `Context note: usage is ${pct}% ${ctx.stats}. ` +
              `If remaining work touches 3+ files, delegate to a subagent to protect parent context.` + perCallWarning,
          },
        };
      } else if (perCallWarning) {
        output = {
          hookSpecificOutput: {
            hookEventName: "PostToolUse",
            additionalContext: `Context note:${perCallWarning}`,
          },
        };
      } else {
        output = {};
      }
    }

    saveState(stateFile, state);
    return respond(output);
  } catch {
    return respond();
  }
});
