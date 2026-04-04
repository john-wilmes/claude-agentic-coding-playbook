// PostToolUse hook: recommends upgrading to opus when complexity signals accumulate.
// Fires once per session when the task outgrows sonnet's sweet spot.
// Lightweight: reads a small state file, checks a few counters, exits.

"use strict";

function respond(payload = {}) {
  process.stdout.write(JSON.stringify(payload), () => process.exit(0));
}

const fs = require("fs");
const path = require("path");
const os = require("os");

let log;
try { log = require("./log"); } catch { log = { writeLog() {} }; }

let modelConfig;
try { modelConfig = require("./model-config"); } catch { modelConfig = null; }

// Complexity signals detected from tool activity
const COMPLEXITY_SIGNALS = {
  uniqueFilesRead: 0,     // Reading many files = exploring unfamiliar code
  editRetries: 0,         // Edit failures = struggling with complex changes
  agentSpawns: 0,         // Spawning agents = multi-step reasoning
  errorCount: 0,          // Errors in bash/tool output = debugging
  filesEdited: 0,         // Editing many files = cross-file changes
};

// Thresholds — when total score exceeds this, recommend upgrade
const SCORE_THRESHOLD = 12;

// Scoring weights
const WEIGHTS = {
  uniqueFilesRead: 0.5,   // 24 files to max out alone
  editRetries: 3,         // 4 retries is a strong signal
  agentSpawns: 2,         // 6 agents is a strong signal
  errorCount: 1.5,        // 8 errors is a strong signal
  filesEdited: 1,         // 12 files is a strong signal
};

function getStateFile(sessionId) {
  const dir = path.join(os.tmpdir(), "claude-model-upgrade");
  try { fs.mkdirSync(dir, { mode: 0o700, recursive: true }); } catch {}
  return path.join(dir, `${path.basename(sessionId)}.json`);
}

function loadState(stateFile) {
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return { recommended: false, signals: { ...COMPLEXITY_SIGNALS }, filesRead: [], filesEdited: [] };
  }
}

function saveState(stateFile, state) {
  try { fs.writeFileSync(stateFile, JSON.stringify(state)); } catch {}
}

function computeScore(signals) {
  let score = 0;
  for (const [key, weight] of Object.entries(WEIGHTS)) {
    score += (signals[key] || 0) * weight;
  }
  return score;
}

let input = "";
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    const hookInput = JSON.parse(input);

    // Skip subagents
    if (hookInput.agent_id) return respond();

    const sessionId = hookInput.session_id || "unknown";

    // Skip if already on opus
    if (modelConfig) {
      const cfg = modelConfig.getSessionModel(sessionId);
      if (cfg.displayName === "Opus") return respond();
    }

    const stateFile = getStateFile(sessionId);
    const state = loadState(stateFile);

    // Already recommended this session
    if (state.recommended) return respond();

    const toolName = hookInput.tool_name || "";
    const toolInput = hookInput.tool_input || {};
    const toolResponse = hookInput.tool_response || {};
    const responseStr = typeof toolResponse === "string" ? toolResponse : JSON.stringify(toolResponse);

    // --- Accumulate signals ---

    // File reads
    if (toolName === "Read" && toolInput.file_path) {
      if (!state.filesRead.includes(toolInput.file_path)) {
        state.filesRead.push(toolInput.file_path);
        state.signals.uniqueFilesRead = state.filesRead.length;
      }
    }

    // File edits
    if ((toolName === "Edit" || toolName === "Write") && toolInput.file_path) {
      if (!state.filesEdited.includes(toolInput.file_path)) {
        state.filesEdited.push(toolInput.file_path);
        state.signals.filesEdited = state.filesEdited.length;
      }
    }

    // Edit failures (old_string not found, etc.)
    if (toolName === "Edit" && responseStr.includes("FAIL")) {
      state.signals.editRetries = (state.signals.editRetries || 0) + 1;
    }

    // Agent/Task spawns
    if (toolName === "Agent" || toolName === "Task") {
      state.signals.agentSpawns = (state.signals.agentSpawns || 0) + 1;
    }

    // Errors in bash output
    if (toolName === "Bash" && (responseStr.includes("Error") || responseStr.includes("error:") || responseStr.includes("FAILED"))) {
      state.signals.errorCount = (state.signals.errorCount || 0) + 1;
    }

    // --- Check score ---
    const score = computeScore(state.signals);

    if (score >= SCORE_THRESHOLD) {
      state.recommended = true;
      saveState(stateFile, state);

      log.writeLog({
        hook: "model-upgrade-advisor",
        event: "recommend",
        session_id: sessionId,
        details: `Score ${score.toFixed(1)} >= ${SCORE_THRESHOLD}`,
        context: { signals: state.signals },
      });

      return respond({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext:
            `This session shows complexity signals (${state.signals.uniqueFilesRead} files read, ` +
            `${state.signals.filesEdited} files edited, ${state.signals.agentSpawns} agents spawned). ` +
            `Consider upgrading: run \`/model opus[1m]\` for stronger cross-file reasoning and 1M context window. ` +
            `This is a one-time suggestion — ignore if the current model is handling the task well.`,
        },
      });
    }

    saveState(stateFile, state);
    return respond();
  } catch {
    return respond();
  }
});

if (typeof module !== "undefined") {
  module.exports = { SCORE_THRESHOLD, WEIGHTS, computeScore, COMPLEXITY_SIGNALS };
}
