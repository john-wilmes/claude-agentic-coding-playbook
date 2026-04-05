// PostToolUse hook: detects truncated Task subagent output and writes recovery state.
//
// Fires on all PostToolUse events but only acts on tool_name === "Task".
// Skips subagent context (agent_id present) and PreToolUse (no tool_response).
//
// When truncation is detected:
//   1. Extracts original prompt and partial result
//   2. Classifies reason: "max_turns" | "context_overflow"
//   3. Writes state file for claude-loop recovery
//   4. Returns additionalContext warning to parent agent
//
// State file: /tmp/claude-subagent-recovery/{sessionKey}.json
//   sessionKey = loop-{CLAUDE_LOOP_PID} if under claude-loop, else session_id
//
// On any error: outputs {} and exits 0 — never crashes.

function respond(payload = {}) {
  process.stdout.write(JSON.stringify(payload), () => process.exit(0));
}

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");

let log;
try { log = require("./log"); } catch { log = { writeLog() {} }; }

// Truncation detection patterns.
// These are best-effort patterns based on known Claude Code behavior.
// Update after empirical capture of actual truncation messages.
const TRUNCATION_PATTERNS = [
  { pattern: /max.?turns?\b/i, reason: "max_turns" },
  { pattern: /maximum number of turns/i, reason: "max_turns" },
  { pattern: /exhausted.*turns/i, reason: "max_turns" },
  { pattern: /ran out of turns/i, reason: "max_turns" },
  { pattern: /reached.*turn.*limit/i, reason: "max_turns" },
  { pattern: /context.?window/i, reason: "context_overflow" },
  { pattern: /context.*exceeded/i, reason: "context_overflow" },
  { pattern: /context.*overflow/i, reason: "context_overflow" },
  { pattern: /token.*limit.*exceeded/i, reason: "context_overflow" },
  { pattern: /context.*truncat/i, reason: "context_overflow" },
];

function getStateDir() {
  const dir = path.join(os.tmpdir(), "claude-subagent-recovery");
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

function getStateKey(sessionId) {
  const loopPid = process.env.CLAUDE_LOOP_PID;
  const raw = loopPid ? `loop-${loopPid}` : sessionId;
  // Hash the key to prevent path traversal via crafted session IDs
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

function getStateFile(sessionId) {
  return path.join(getStateDir(), `${getStateKey(sessionId)}.json`);
}

/**
 * Check tool_response for truncation markers.
 * Returns { reason } if truncated, null otherwise.
 */
function detectTruncation(toolResponse) {
  if (!toolResponse || typeof toolResponse !== "string") return null;
  for (const { pattern, reason } of TRUNCATION_PATTERNS) {
    if (pattern.test(toolResponse)) {
      return { reason };
    }
  }
  return null;
}

/**
 * Write recovery state file for claude-loop.
 */
function writeRecoveryState(stateFile, data) {
  try {
    fs.writeFileSync(stateFile, JSON.stringify(data));
  } catch {}
}

let input = "";
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    const hookInput = JSON.parse(input);

    // Skip subagent context — only monitor from parent agent.
    if (hookInput.agent_id) {
      return respond();
    }

    // Only care about Task tool calls.
    if (hookInput.tool_name !== "Task") {
      return respond();
    }

    // Skip PreToolUse (no tool_response).
    if (!("tool_response" in hookInput)) {
      return respond();
    }

    const sessionId = hookInput.session_id || "unknown";
    const toolInput = hookInput.tool_input || {};
    const toolResponse = typeof hookInput.tool_response === "string"
      ? hookInput.tool_response
      : JSON.stringify(hookInput.tool_response || "");

    // Check for truncation.
    const truncation = detectTruncation(toolResponse);
    if (!truncation) {
      return respond();
    }

    // Truncation detected — extract context and write recovery state.
    const description = toolInput.description || toolInput.prompt?.slice(0, 80) || "unknown task";
    const prompt = toolInput.prompt || "";
    const model = toolInput.model || "";
    const stateFile = getStateFile(sessionId);

    writeRecoveryState(stateFile, {
      prompt,
      partialResult: toolResponse.slice(0, 5000), // Cap to avoid huge state files
      reason: truncation.reason,
      taskDescription: description,
      model,
      timestamp: Date.now(),
    });

    log.writeLog({
      hook: "subagent-recovery",
      event: "truncated",
      session_id: hookInput.session_id,
      tool_use_id: hookInput.tool_use_id,
      details: `Subagent truncated (${truncation.reason}): ${description}`,
      project: hookInput.cwd,
      context: { reason: truncation.reason, description, model },
    });

    const advice = truncation.reason === "max_turns"
      ? "Consider: (1) retry with smaller scope, (2) split into multiple subagents, or (3) increase max_turns."
      : "Consider: (1) retry with smaller scope, (2) split into multiple subagents, or (3) use /compact first.";

    return respond({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext:
          `Subagent truncated (${truncation.reason}). Original task: "${description}". ` +
          `Partial result preserved in recovery state. ${advice}`,
      },
    });
  } catch {
    return respond();
  }
});
