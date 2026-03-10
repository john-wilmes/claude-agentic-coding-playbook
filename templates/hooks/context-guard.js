// PostToolUse hook: tracks cumulative tool result size per session.
// Three thresholds:
//   40% — warn to use subagents for remaining multi-file work
//   60% — warn to compact or checkpoint soon
//   70% — BLOCK further edits until agent checkpoints
//
// This catches the "multi-file edit blowout" where an agent edits 14 files
// in rapid succession, each returning file contents, and blows past the
// checkpoint threshold in a single turn.

const fs = require("fs");
const path = require("path");
const os = require("os");

// Approximate tokens per character (conservative estimate)
const CHARS_PER_TOKEN = 4;
// Default context window size in tokens
const CONTEXT_WINDOW = 200000;

const SUBAGENT_THRESHOLD = 0.40;
const WARN_THRESHOLD = 0.60;
const BLOCK_THRESHOLD = 0.70;

// State file tracks cumulative size across hook invocations within a session
function getStateFile(sessionId) {
  const dir = path.join(os.tmpdir(), "claude-context-guard");
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return path.join(dir, `${sessionId}.json`);
}

function loadState(stateFile) {
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return { totalChars: 0, toolCalls: 0, subagentWarned: false, warned: false };
  }
}

function saveState(stateFile, state) {
  try {
    fs.writeFileSync(stateFile, JSON.stringify(state));
  } catch {}
}

let input = "";
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    const hookInput = JSON.parse(input);
    const sessionId = hookInput.session_id || "unknown";
    const toolResponse = hookInput.tool_response || {};

    // Estimate size of tool response
    const responseStr = JSON.stringify(toolResponse);
    const responseChars = responseStr.length;

    const stateFile = getStateFile(sessionId);
    const state = loadState(stateFile);

    state.totalChars += responseChars;
    state.toolCalls += 1;

    const estimatedTokens = state.totalChars / CHARS_PER_TOKEN;
    const usage = estimatedTokens / CONTEXT_WINDOW;

    saveState(stateFile, state);

    const pct = Math.round(usage * 100);
    const stats = `(${state.toolCalls} tool calls, ~${Math.round(estimatedTokens)} tokens from results)`;

    // Per-call size warning: flag individual large tool results
    const PER_CALL_WARN_CHARS = 10000;
    const perCallWarning = responseChars > PER_CALL_WARN_CHARS
      ? ` Large tool output (~${Math.round(responseChars / CHARS_PER_TOKEN)} tokens this call). Delegate multi-file work to subagents.`
      : "";

    if (usage >= BLOCK_THRESHOLD) {
      saveState(stateFile, state);
      process.stdout.write(JSON.stringify({
        decision: "block",
        reason:
          `Context guard: estimated usage is ${pct}% ${stats}. ` +
          `Run /checkpoint before continuing. No more edits until context is saved.`,
      }));
    } else if (usage >= WARN_THRESHOLD && !state.warned) {
      state.warned = true;
      saveState(stateFile, state);
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext:
            `Context warning: estimated usage is ${pct}% ${stats}. ` +
            `Run /compact or /checkpoint soon. Do not start new multi-file work.` + perCallWarning,
        },
      }));
    } else if (usage >= SUBAGENT_THRESHOLD && !state.subagentWarned) {
      state.subagentWarned = true;
      saveState(stateFile, state);
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext:
            `Context note: estimated usage is ${pct}% ${stats}. ` +
            `If remaining work touches 3+ files, delegate to a subagent to protect parent context.` + perCallWarning,
        },
      }));
    } else if (perCallWarning) {
      saveState(stateFile, state);
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: `Context note:${perCallWarning}`,
        },
      }));
    } else {
      process.stdout.write(JSON.stringify({}));
    }
    process.exit(0);
  } catch {
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }
});
