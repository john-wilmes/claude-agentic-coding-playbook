// PostToolUse hook: detects behavioral patterns indicating sycophancy
// (rubber-stamping, compliance without investigation, shallow reviews).
//
// Tracks per-session tool usage patterns in a sliding window of 30 actions.
// Warns when the agent shows signs of excessive compliance without challenge.
//
// Signals tracked:
// 1. Quick-edit: Edit/Write on a file that was just Read without intermediate
//    investigation (Grep, additional Read, Bash). Suggests rubber-stamping.
// 2. Compliance run: consecutive Edit/Write calls with no investigation between.
//    Long runs suggest the agent is blindly following instructions.
// 3. Session ratio: over the full session, a high modification-to-investigation
//    ratio after enough actions suggests shallow engagement.
//
// Thresholds:
//   Quick-edits: warn at 4 in window, escalate at 7
//   Compliance run: warn at 6, escalate at 10
//   Session ratio: warn when modifications >= 75% after 20+ actions
//
// Warnings only fire on modification actions — investigation actions are never warned.
//
// Integration:
//   - Logs all scores to JSONL via log.js for analyze-logs.js consumption
//   - Stages knowledge candidates via knowledge-capture.js on pattern transitions
//
// On any error: outputs {} and exits 0 — never blocks unexpectedly.

function respond(payload = {}) {
  process.stdout.write(JSON.stringify(payload), () => process.exit(0));
}

const fs = require("fs");
const path = require("path");
const os = require("os");

let log;
try { log = require("./log"); } catch { log = { writeLog() {} }; }

let capture;
try { capture = require("./knowledge-capture"); } catch { capture = null; }

const WINDOW_SIZE = 30;

// Quick-edit thresholds (Read → Edit same file with no investigation between)
const QUICK_EDIT_WARN = 4;
const QUICK_EDIT_ESCALATE = 7;

// Compliance run thresholds (consecutive Edit/Write with no investigation)
const COMPLIANCE_RUN_WARN = 6;
const COMPLIANCE_RUN_ESCALATE = 10;

// Session ratio threshold (modifications / total after MIN_ACTIONS actions)
const RATIO_THRESHOLD = 0.75;
const MIN_ACTIONS_FOR_RATIO = 20;

// State TTL: 4 hours (match stuck-detector)
const STATE_TTL_MS = 4 * 60 * 60 * 1000;

// Tool categorization
const MODIFICATION_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);
const INVESTIGATION_TOOLS = new Set(["Read", "Grep", "Glob", "Bash", "Agent"]);
const READ_TOOLS = new Set(["Read"]);

function getStateDir() {
  const dir = path.join(os.tmpdir(), "claude-sycophancy-detector");
  try { fs.mkdirSync(dir, { mode: 0o700, recursive: true }); } catch {}
  return dir;
}

function getStateKey(sessionId) {
  const loopPid = process.env.CLAUDE_LOOP_PID;
  return loopPid ? `loop-${loopPid}` : sessionId;
}

function getStateFile(sessionId) {
  const safeKey = (getStateKey(sessionId) || "default").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return path.join(getStateDir(), `${safeKey}.json`);
}

function loadState(stateFile) {
  try {
    const mtime = fs.statSync(stateFile).mtimeMs;
    if (Date.now() - mtime > STATE_TTL_MS) {
      try { fs.unlinkSync(stateFile); } catch {}
      return freshState();
    }
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return freshState();
  }
}

function freshState() {
  return {
    window: [],           // [{ tool, file, category, ts }]
    quickEditCount: 0,    // in current window
    complianceRun: 0,     // consecutive modifications without investigation
    totalModifications: 0,
    totalInvestigations: 0,
    totalActions: 0,
    wasWarned: false,
  };
}

function saveState(stateFile, state) {
  try {
    fs.writeFileSync(stateFile, JSON.stringify(state));
  } catch {}
}

// Extract the primary file path from tool_input (if any)
function extractFile(toolName, toolInput) {
  if (toolInput.file_path) return toolInput.file_path;
  if (toolInput.path) return toolInput.path;
  if (toolName === "Bash" && toolInput.command) {
    // Try to extract a file path from simple commands
    const m = toolInput.command.match(/(?:cat|less|head|tail|vim|nano)\s+["']?([^\s"'|;]+)/);
    return m ? m[1] : null;
  }
  return null;
}

function categorize(toolName) {
  if (MODIFICATION_TOOLS.has(toolName)) return "modify";
  if (INVESTIGATION_TOOLS.has(toolName)) return "investigate";
  return "other";
}

// Count quick-edits in the window: a modification on a file that was Read
// with no investigation tools between the Read and the modification.
function countQuickEdits(window) {
  let count = 0;
  for (let i = 1; i < window.length; i++) {
    if (window[i].category !== "modify" || !window[i].file) continue;
    // Walk backward to find if the same file was Read recently
    // with no investigation between
    let sawInvestigation = false;
    for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
      if (window[j].category === "investigate") {
        // If the investigation is a Read of a DIFFERENT file, it counts
        // If it's Grep/Bash/Glob, it counts as real investigation
        if (READ_TOOLS.has(window[j].tool) && window[j].file === window[i].file) {
          // Same file Read — this is the "read then immediately edit" pattern
          if (!sawInvestigation) count++;
          break;
        }
        sawInvestigation = true;
        break;
      }
      if (window[j].category === "modify") break; // Another modification — stop looking
    }
  }
  return count;
}

// Count the current compliance run (consecutive modifications from the tail)
function countComplianceRun(window) {
  let run = 0;
  for (let i = window.length - 1; i >= 0; i--) {
    if (window[i].category === "modify") {
      run++;
    } else if (window[i].category === "investigate") {
      break;
    }
    // "other" tools (meta tools) don't break the run
  }
  return run;
}

let input = "";
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    const hookInput = JSON.parse(input);

    // Skip for subagents — they have disposable context
    if (hookInput.agent_id) {
      return respond();
    }

    const sessionId = hookInput.session_id || "unknown";
    const toolName = hookInput.tool_name || "";
    const toolInput = hookInput.tool_input || {};

    const category = categorize(toolName);
    const file = extractFile(toolName, toolInput);

    // Skip uncategorized tools entirely (meta tools, etc.)
    if (category === "other") {
      return respond();
    }

    const stateFile = getStateFile(sessionId);
    const state = loadState(stateFile);

    // Add to window
    state.window.push({
      tool: toolName,
      file: file,
      category: category,
      ts: Date.now(),
    });
    if (state.window.length > WINDOW_SIZE) {
      state.window = state.window.slice(state.window.length - WINDOW_SIZE);
    }

    // Update counters
    state.totalActions++;
    if (category === "modify") state.totalModifications++;
    if (category === "investigate") state.totalInvestigations++;

    // Compute signals
    const quickEdits = countQuickEdits(state.window);
    const complianceRun = countComplianceRun(state.window);
    const ratio = state.totalActions >= MIN_ACTIONS_FOR_RATIO
      ? state.totalModifications / state.totalActions
      : 0;

    state.quickEditCount = quickEdits;
    state.complianceRun = complianceRun;

    // Detect warned→cleared transition for knowledge capture
    if (state.wasWarned && category === "investigate") {
      if (capture) {
        capture.stageCandidate({
          session_id: sessionId,
          trigger: "sycophancy-resolved",
          tool: toolName,
          category: "pattern",
          confidence: "medium",
          summary: "Agent switched from compliance pattern to investigation after sycophancy warning",
          context_snippet: `Was in compliance run of ${complianceRun}, broke pattern with ${toolName}`,
          source_project: path.basename(hookInput.cwd || process.cwd()),
          cwd: hookInput.cwd || process.cwd(),
        });
      }
      state.wasWarned = false;
    }

    // Only warn on modification actions — investigation should not trigger warnings
    let warningLevel = null; // null, "warn", "escalate"
    let warningReason = "";

    if (category !== "modify") {
      // Skip warning checks — agent is investigating, not rubber-stamping
    } else if (quickEdits >= QUICK_EDIT_ESCALATE) {
      warningLevel = "escalate";
      warningReason = `${quickEdits} files edited immediately after reading without investigation. ` +
        "You may be rubber-stamping changes. Read related code, check tests, or explore alternatives before editing.";
    } else if (quickEdits >= QUICK_EDIT_WARN) {
      warningLevel = "warn";
      warningReason = `${quickEdits} files edited right after reading without deeper investigation. ` +
        "Consider reviewing related code or tests before making more changes.";
    } else if (complianceRun >= COMPLIANCE_RUN_ESCALATE) {
      warningLevel = "escalate";
      warningReason = `${complianceRun} consecutive modifications without any investigation. ` +
        "You may be blindly following instructions. Read code, check tests, or verify assumptions before continuing.";
    } else if (complianceRun >= COMPLIANCE_RUN_WARN) {
      warningLevel = "warn";
      warningReason = `${complianceRun} consecutive modifications without investigation. ` +
        "Consider pausing to verify your changes are correct.";
    } else if (ratio >= RATIO_THRESHOLD && state.totalActions >= MIN_ACTIONS_FOR_RATIO) {
      warningLevel = "warn";
      warningReason = `${Math.round(ratio * 100)}% of your actions are modifications (${state.totalModifications}/${state.totalActions}). ` +
        "A healthy session balances editing with investigation. Consider reading more code or running tests.";
    }

    // Log the score on every action (for analyze-logs.js)
    log.writeLog({
      hook: "sycophancy-detector",
      event: warningLevel || "score",
      session_id: sessionId,
      tool_use_id: hookInput.tool_use_id,
      details: warningLevel
        ? `${warningLevel}: ${warningReason}`
        : `score: quickEdits=${quickEdits} complianceRun=${complianceRun} ratio=${ratio.toFixed(2)}`,
      project: hookInput.cwd,
      context: {
        quick_edits: quickEdits,
        compliance_run: complianceRun,
        ratio: Math.round(ratio * 100) / 100,
        total_actions: state.totalActions,
        total_modifications: state.totalModifications,
        total_investigations: state.totalInvestigations,
        tool: toolName,
        category: category,
      },
    });

    if (warningLevel) {
      state.wasWarned = true;
    }

    saveState(stateFile, state);

    if (warningLevel) {
      return respond({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext:
            `Sycophancy detector (${warningLevel}): ${warningReason}`,
        },
      });
    }

    return respond();
  } catch {
    return respond();
  }
});
