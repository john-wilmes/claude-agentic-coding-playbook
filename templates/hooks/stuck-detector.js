// PreToolUse hook: detects when the agent is stuck in a repetition loop.
//
// Maintains a sliding window of the last 5 action hashes per session.
// Counts consecutive identical hashes from the end of the window.
//
//   3+ consecutive identical: warns the agent to try a different approach
//   5  consecutive identical: blocks the tool call entirely
//
// On any error: outputs {} and exits 0 — never blocks unexpectedly.

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

let log;
try { log = require("./log"); } catch { log = { writeLog() {} }; }

const WINDOW_SIZE = 5;
const WARN_THRESHOLD = 3;
const BLOCK_THRESHOLD = 5;

// Commands that are legitimately repeated (test/lint/typecheck cycles).
// Matched against the start of the command string after trimming.
const WHITELISTED_PREFIXES = [
  "npm test", "npm run test", "npm run lint", "npm run check",
  "npx jest", "npx vitest", "npx eslint", "npx tsc",
  "node tests/", "node test/",
  "pytest", "python -m pytest",
  "cargo test", "cargo clippy",
  "go test",
  "make test", "make check", "make lint",
];

function getStateDir() {
  const dir = path.join(os.tmpdir(), "claude-stuck-detector");
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

function getStateFile(sessionId) {
  return path.join(getStateDir(), `${sessionId}.json`);
}

function loadState(stateFile) {
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return { window: [] };
  }
}

function saveState(stateFile, state) {
  try {
    fs.writeFileSync(stateFile, JSON.stringify(state));
  } catch {}
}

function hashAction(toolName, toolInput) {
  const raw = toolName + JSON.stringify(toolInput);
  return crypto.createHash("sha256").update(raw).digest("hex");
}

// Count how many entries at the END of the window are the same hash.
function countConsecutiveTail(window, hash) {
  let count = 0;
  for (let i = window.length - 1; i >= 0; i--) {
    if (window[i] === hash) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

let input = "";
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    const hookInput = JSON.parse(input);

    // Subagents have disposable context — skip stuck detection.
    if (hookInput.agent_id) {
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    const sessionId = hookInput.session_id || "unknown";
    const toolName = hookInput.tool_name || "";
    const toolInput = hookInput.tool_input || {};

    // Skip stuck detection for whitelisted test/lint commands
    if (toolName === "Bash" && toolInput.command) {
      const cmd = toolInput.command.trim();
      if (WHITELISTED_PREFIXES.some((prefix) => cmd.startsWith(prefix))) {
        process.stdout.write(JSON.stringify({}));
        process.exit(0);
      }
    }

    const hash = hashAction(toolName, toolInput);

    const stateFile = getStateFile(sessionId);
    const state = loadState(stateFile);

    // Append to window, keep last WINDOW_SIZE entries
    state.window.push(hash);
    if (state.window.length > WINDOW_SIZE) {
      state.window = state.window.slice(state.window.length - WINDOW_SIZE);
    }

    // Count consecutive identical hashes from the tail BEFORE saving,
    // so the count reflects the state after this call is added.
    const consecutive = countConsecutiveTail(state.window, hash);

    saveState(stateFile, state);

    if (consecutive >= BLOCK_THRESHOLD) {
      log.writeLog({
        hook: "stuck-detector",
        event: "block",
        session_id: hookInput.session_id,
        tool_use_id: hookInput.tool_use_id,
        details: `Blocked: ${consecutive} identical actions (${toolName})`,
        context: { consecutive, tool: toolName },
      });
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "Stuck detector: 5 identical actions in a row. You appear to be stuck. " +
            "Try a completely different approach or ask the user for help.",
        },
      }));
      process.exit(0);
    }

    if (consecutive >= WARN_THRESHOLD) {
      log.writeLog({
        hook: "stuck-detector",
        event: "warn",
        session_id: hookInput.session_id,
        tool_use_id: hookInput.tool_use_id,
        details: `Warning: ${consecutive} identical actions (${toolName})`,
        context: { consecutive, tool: toolName },
      });
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext:
            "Stuck detector: you have repeated the same action 3 times. " +
            "Try a different approach or ask the user.",
        },
      }));
      process.exit(0);
    }

    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  } catch {
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }
});
