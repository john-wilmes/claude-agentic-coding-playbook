// Dual-mode context guard: PreToolUse (hard block) + PostToolUse (measure & warn).
//
// PostToolUse (no matcher — fires on ALL tools):
//   Reads transcript, computes usage, warns at 35%/50%, advisory block at 60%.
//   Writes lastUsageRatio to state file for PreToolUse to read.
//
// PreToolUse (no matcher — fires on ALL tools):
//   Reads state file only (~100 bytes). If lastUsageRatio >= 60%, hard-blocks
//   the tool (prevents execution). Allows:
//   - Skill, Bash, Task tools (so /checkpoint can fire, run git ops, delegate)
//   - Tools with file_path under ~/.claude/ (so /checkpoint can update memory)
//
// Primary: reads actual token counts from the session transcript JSONL.
// Fallback: estimates from tool I/O sizes when transcript is unavailable.

const fs = require("fs");
const path = require("path");
const os = require("os");

let log;
try { log = require("./log"); } catch { log = { writeLog() {}, promptHead(t) { return t; } }; }

// Approximate tokens per character (conservative estimate, used in fallback only)
const CHARS_PER_TOKEN = 4;
// Default context window size in tokens
const CONTEXT_WINDOW = 200000;

const SUBAGENT_THRESHOLD = 0.35;
const WARN_THRESHOLD = 0.50;
const BLOCK_THRESHOLD = 0.60;

// State file tracks warning flags and fallback accumulator across invocations
function getStateFile(sessionId) {
  const dir = path.join(os.tmpdir(), "claude-context-guard");
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return path.join(dir, `${sessionId}.json`);
}

function loadState(stateFile) {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      subagentWarned: raw.subagentWarned || false,
      warned: raw.warned || false,
      cumulativeEstimatedTokens: raw.cumulativeEstimatedTokens || 0,
      toolCalls: raw.toolCalls || 0,
      lastUsageRatio: raw.lastUsageRatio || 0,
    };
  } catch {
    return { subagentWarned: false, warned: false, cumulativeEstimatedTokens: 0, toolCalls: 0, lastUsageRatio: 0 };
  }
}

function saveState(stateFile, state) {
  try {
    fs.writeFileSync(stateFile, JSON.stringify(state));
  } catch {}
}

/**
 * Read the most recent assistant message's usage from the transcript JSONL.
 * Reads only the last 200KB to handle large transcripts efficiently.
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
    const TAIL_SIZE = 200 * 1024;
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
function getContextUsage(hookInput, state) {
  const usage = readTranscriptUsage(hookInput.transcript_path);

  if (usage) {
    // Fields are additive: input_tokens is the uncached portion only.
    // Verified against real transcripts — total context = all three summed.
    const totalTokens = (usage.input_tokens || 0) +
                        (usage.cache_read_input_tokens || 0) +
                        (usage.cache_creation_input_tokens || 0);
    return {
      ratio: totalTokens / CONTEXT_WINDOW,
      tokens: totalTokens,
      stats: `(${totalTokens} actual tokens)`,
    };
  }

  // Fallback: estimate from tool I/O (both input and response)
  const inputStr = JSON.stringify(hookInput.tool_input || {});
  const responseStr = JSON.stringify(hookInput.tool_response || {});
  const ioChars = inputStr.length + responseStr.length;

  state.cumulativeEstimatedTokens += Math.round(ioChars / CHARS_PER_TOKEN);

  return {
    ratio: state.cumulativeEstimatedTokens / CONTEXT_WINDOW,
    tokens: state.cumulativeEstimatedTokens,
    stats: `(~${state.cumulativeEstimatedTokens} tokens estimated from tool I/O, ${state.toolCalls} calls)`,
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
      log.writeLog({ hook: "context-guard", event: "skip", details: "Subagent call skipped", session_id: hookInput.session_id, tool_use_id: hookInput.tool_use_id, agent_id: hookInput.agent_id });
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    // Mode detection: PreToolUse has no tool_response field.
    const isPreToolUse = !("tool_response" in hookInput);

    const sessionId = hookInput.session_id || "unknown";
    const stateFile = getStateFile(sessionId);

    // ── PreToolUse fast path ──────────────────────────────────────────────
    // Reads only the state file (~100 bytes). Hard-blocks ALL tools when
    // usage >= 60%. Allows Skill tool and ~/.claude/ file paths for checkpoint.
    if (isPreToolUse) {
      const state = loadState(stateFile);
      if (state.lastUsageRatio >= BLOCK_THRESHOLD) {
        // Allow Skill, Bash, Task so /checkpoint can fire, run git, and delegate
        const toolName = hookInput.tool_name || "";
        if (toolName === "Skill" || toolName === "Bash" || toolName === "Task") {
          process.stdout.write(JSON.stringify({}));
          process.exit(0);
        }
        // Allow tools targeting ~/.claude/ paths (memory/config needed for checkpoint)
        const filePath = (hookInput.tool_input && hookInput.tool_input.file_path) || "";
        if (filePath) {
          const homeDir = os.homedir();
          const claudeDir = path.join(homeDir, ".claude");
          const normalizedFile = path.normalize(filePath);
          const normalizedClaude = path.normalize(claudeDir);
          if (normalizedFile.startsWith(normalizedClaude + path.sep)) {
            process.stdout.write(JSON.stringify({}));
            process.exit(0);
          }
        }
        const pct = Math.round(state.lastUsageRatio * 100);
        log.writeLog({
          hook: "context-guard",
          event: "block",
          session_id: hookInput.session_id,
          tool_use_id: hookInput.tool_use_id,
          details: `PreToolUse block: ${pct}% context used`,
          context: { mode: "pre", ratio: state.lastUsageRatio, pct },
        });
        process.stdout.write(JSON.stringify({
          decision: "block",
          reason:
            `BLOCKED: ${pct}% context used. Run /checkpoint now.`,
        }));
        process.exit(0);
      }
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    // ── PostToolUse path ──────────────────────────────────────────────────
    const state = loadState(stateFile);
    state.toolCalls += 1;

    const ctx = getContextUsage(hookInput, state);
    const pct = Math.round(ctx.ratio * 100);

    // Store ratio for PreToolUse to read on next call
    state.lastUsageRatio = ctx.ratio;

    // Per-call size warning: flag individual large tool results
    const responseStr = JSON.stringify(hookInput.tool_response || {});
    const responseChars = responseStr.length;
    const PER_CALL_WARN_CHARS = 10000;
    const perCallWarning = responseChars > PER_CALL_WARN_CHARS
      ? ` Large tool output (~${Math.round(responseChars / CHARS_PER_TOKEN)} tokens this call). Delegate multi-file work to subagents.`
      : "";

    let output;
    if (ctx.ratio >= BLOCK_THRESHOLD) {
      // Write flag file so /checkpoint can deterministically decide to exit.
      // Uses a fixed path — checkpoint reads this instead of guessing usage.
      try {
        fs.writeFileSync(
          path.join(os.tmpdir(), "claude-checkpoint-exit"),
          JSON.stringify({ ratio: ctx.ratio, timestamp: Date.now() })
        );
      } catch {}
      log.writeLog({
        hook: "context-guard",
        event: "block",
        session_id: hookInput.session_id,
        tool_use_id: hookInput.tool_use_id,
        details: `PostToolUse block: ${pct}% context used`,
        context: { mode: "post", ratio: ctx.ratio, pct, tokens: ctx.tokens },
      });
      output = {
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext:
            `CRITICAL: ${pct}% context used ${ctx.stats}. Run /checkpoint NOW. Do not start new work.`,
        },
      };
    } else if (ctx.ratio >= WARN_THRESHOLD && !state.warned) {
      state.warned = true;
      state.subagentWarned = true; // 50% implies 35% already passed
      log.writeLog({
        hook: "context-guard",
        event: "warn",
        session_id: hookInput.session_id,
        tool_use_id: hookInput.tool_use_id,
        details: `PostToolUse warn: ${pct}% context used`,
        context: { mode: "post", ratio: ctx.ratio, pct, tokens: ctx.tokens },
      });
      output = {
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext:
            `Context warning: ${pct}% used ${ctx.stats}. ` +
            `Finish current subtask, externalize state, then run /checkpoint.` + perCallWarning,
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

    saveState(stateFile, state);
    process.stdout.write(JSON.stringify(output));
    process.exit(0);
  } catch {
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }
});
