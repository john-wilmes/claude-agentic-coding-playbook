// PostToolUse hook: tracks context usage via session transcript.
// Three thresholds:
//   40% — warn to use subagents for remaining multi-file work
//   60% — warn to compact or checkpoint soon
//   70% — BLOCK further edits until agent checkpoints
//
// Primary: reads actual token counts from the session transcript JSONL.
// Fallback: estimates from tool I/O sizes when transcript is unavailable.

const fs = require("fs");
const path = require("path");
const os = require("os");

// Approximate tokens per character (conservative estimate, used in fallback only)
const CHARS_PER_TOKEN = 4;
// Default context window size in tokens
const CONTEXT_WINDOW = 200000;

const SUBAGENT_THRESHOLD = 0.40;
const WARN_THRESHOLD = 0.60;
const BLOCK_THRESHOLD = 0.70;

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
    };
  } catch {
    return { subagentWarned: false, warned: false, cumulativeEstimatedTokens: 0, toolCalls: 0 };
  }
}

function saveState(stateFile, state) {
  try {
    fs.writeFileSync(stateFile, JSON.stringify(state));
  } catch {}
}

/**
 * Read the most recent assistant message's usage from the transcript JSONL.
 * Reads only the last 50KB to handle large transcripts efficiently.
 */
function readTranscriptUsage(transcriptPath) {
  if (!transcriptPath) return null;
  try {
    const stats = fs.statSync(transcriptPath);
    const size = stats.size;
    const TAIL_SIZE = 50 * 1024;
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
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    const sessionId = hookInput.session_id || "unknown";

    const stateFile = getStateFile(sessionId);
    const state = loadState(stateFile);
    state.toolCalls += 1;

    const ctx = getContextUsage(hookInput, state);
    const pct = Math.round(ctx.ratio * 100);

    // Per-call size warning: flag individual large tool results
    const responseStr = JSON.stringify(hookInput.tool_response || {});
    const responseChars = responseStr.length;
    const PER_CALL_WARN_CHARS = 10000;
    const perCallWarning = responseChars > PER_CALL_WARN_CHARS
      ? ` Large tool output (~${Math.round(responseChars / CHARS_PER_TOKEN)} tokens this call). Delegate multi-file work to subagents.`
      : "";

    let output;
    if (ctx.ratio >= BLOCK_THRESHOLD) {
      output = {
        decision: "block",
        reason:
          `Context guard: usage is ${pct}% ${ctx.stats}. ` +
          `Run /checkpoint before continuing. No more edits until context is saved.`,
      };
    } else if (ctx.ratio >= WARN_THRESHOLD && !state.warned) {
      state.warned = true;
      state.subagentWarned = true; // 60% implies 40% already passed
      output = {
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext:
            `Context warning: usage is ${pct}% ${ctx.stats}. ` +
            `Run /compact or /checkpoint soon. Do not start new multi-file work.` + perCallWarning,
        },
      };
    } else if (ctx.ratio >= SUBAGENT_THRESHOLD && !state.subagentWarned) {
      state.subagentWarned = true;
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
