// PreToolUse hook: detects when the agent is stuck in a repetition loop.
//
// Maintains a sliding window of the last 20 action hashes per session.
//
// Consecutive detection (cycle length 1):
//   3+ consecutive identical: warns the agent to try a different approach
//   5  consecutive identical: blocks the tool call entirely
//
// Cycle detection (cycle length 2–6):
//   2 full repetitions of a cycle: warns
//   3 full repetitions of a cycle: blocks
//
// Cross-session persistence: when CLAUDE_LOOP_PID is set, state is keyed by
// loop PID instead of session_id, so restarts within one claude-loop run
// share the same action window.
//
// On any error: outputs {} and exits 0 — never blocks unexpectedly.

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

let log;
try { log = require("./log"); } catch { log = { writeLog() {} }; }

let capture;
try { capture = require("./knowledge-capture"); } catch { capture = null; }

const WINDOW_SIZE = 20;
const WARN_THRESHOLD = 3;
const BLOCK_THRESHOLD = 5;

// Cycle detection thresholds (for cycles of length 2–MAX_CYCLE_LEN)
const CYCLE_WARN_REPS = 2;
const CYCLE_BLOCK_REPS = 3;
const MAX_CYCLE_LEN = 6;

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
  "bun test",
  "deno test",
  "rspec",
];

function getStateDir() {
  const dir = path.join(os.tmpdir(), "claude-stuck-detector");
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

function getStateKey(sessionId) {
  const loopPid = process.env.CLAUDE_LOOP_PID;
  return loopPid ? `loop-${loopPid}` : sessionId;
}

function getStateFile(sessionId) {
  return path.join(getStateDir(), `${getStateKey(sessionId)}.json`);
}

const STATE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

function loadState(stateFile) {
  try {
    const mtime = fs.statSync(stateFile).mtimeMs;
    if (Date.now() - mtime > STATE_TTL_MS) {
      // State file is stale (PID recycled or leftover from a previous run).
      // Delete it and start fresh rather than inheriting a stale action window.
      try { fs.unlinkSync(stateFile); } catch {}
      return { window: [], wasStuck: false, stuckTool: "" };
    }
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return { window: [], wasStuck: false, stuckTool: "" };
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

// Detect repeating cycles of length 2..MAX_CYCLE_LEN in the window.
// Returns { length, repetitions } for the shortest cycle with the most
// repetitions, or null if no cycle meets CYCLE_WARN_REPS.
function detectCycle(window) {
  if (window.length < 4) return null; // Need at least 2 reps of length 2
  let best = null;
  const maxLen = Math.min(MAX_CYCLE_LEN, Math.floor(window.length / 2));
  for (let len = 2; len <= maxLen; len++) {
    // Reference pattern = last `len` elements
    const ref = window.slice(window.length - len);
    let reps = 1; // the reference itself counts as 1
    // Walk backward in len-sized chunks
    for (let pos = window.length - 2 * len; pos >= 0; pos -= len) {
      const chunk = window.slice(pos, pos + len);
      let match = true;
      for (let k = 0; k < len; k++) {
        if (chunk[k] !== ref[k]) { match = false; break; }
      }
      if (match) reps++;
      else break;
    }
    if (reps >= CYCLE_WARN_REPS) {
      if (!best || reps > best.repetitions || (reps === best.repetitions && len < best.length)) {
        best = { length: len, repetitions: reps };
      }
    }
  }
  return best;
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

    // Detect stuck→unstuck transition before updating wasStuck
    if (consecutive < WARN_THRESHOLD && state.wasStuck === true) {
      if (capture) {
        capture.stageCandidate({
          session_id: sessionId,
          trigger: "stuck-resolved",
          tool: state.stuckTool || toolName,
          category: "pattern",
          confidence: "medium",
          summary: `Recovered from stuck loop on ${state.stuckTool || toolName}`,
          context_snippet: `Was stuck repeating ${state.stuckTool || toolName}, resolved by switching to ${toolName}`,
          source_project: path.basename(hookInput.cwd || process.cwd()),
          cwd: hookInput.cwd || process.cwd(),
        });
        log.writeLog({
          hook: "stuck-detector",
          event: "knowledge-staged",
          session_id: hookInput.session_id,
          details: `stuck-resolved transition staged (was stuck on ${state.stuckTool || toolName})`,
          project: hookInput.cwd,
        });
      }
      state.wasStuck = false;
      state.stuckTool = "";
    }

    // Track stuck state
    if (consecutive >= WARN_THRESHOLD) {
      state.wasStuck = true;
      state.stuckTool = toolName;
    }

    saveState(stateFile, state);

    if (consecutive >= BLOCK_THRESHOLD) {
      log.writeLog({
        hook: "stuck-detector",
        event: "block",
        session_id: hookInput.session_id,
        tool_use_id: hookInput.tool_use_id,
        details: `Blocked: ${consecutive} identical actions (${toolName})`,
        project: hookInput.cwd,
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
        project: hookInput.cwd,
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

    // Cycle detection: look for repeating patterns of length 2–6
    const cycle = detectCycle(state.window);
    if (cycle) {
      if (cycle.repetitions >= CYCLE_BLOCK_REPS) {
        log.writeLog({
          hook: "stuck-detector",
          event: "cycle-block",
          session_id: hookInput.session_id,
          tool_use_id: hookInput.tool_use_id,
          details: `Blocked: repeating pattern of ${cycle.length} actions, repeated ${cycle.repetitions} times`,
          project: hookInput.cwd,
          context: { cycle_length: cycle.length, repetitions: cycle.repetitions, tool: toolName },
        });
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason:
              `Stuck detector: repeating pattern of ${cycle.length} actions, ` +
              `repeated ${cycle.repetitions} times. You are in a loop. ` +
              "Try a completely different approach or ask the user for help.",
          },
        }));
        process.exit(0);
      }
      if (cycle.repetitions >= CYCLE_WARN_REPS) {
        log.writeLog({
          hook: "stuck-detector",
          event: "cycle-warn",
          session_id: hookInput.session_id,
          tool_use_id: hookInput.tool_use_id,
          details: `Warning: repeating pattern of ${cycle.length} actions, repeated ${cycle.repetitions} times`,
          project: hookInput.cwd,
          context: { cycle_length: cycle.length, repetitions: cycle.repetitions, tool: toolName },
        });
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            additionalContext:
              `Stuck detector: repeating pattern of ${cycle.length} actions, ` +
              `repeated ${cycle.repetitions} times. You may be in a loop. ` +
              "Try a different approach or ask the user.",
          },
        }));
        process.exit(0);
      }
    }

    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  } catch {
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }
});
