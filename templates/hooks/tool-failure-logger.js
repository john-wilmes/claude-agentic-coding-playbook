// PostToolUseFailure hook: logs tool errors and warns on repeated failures.
// Writes structured entries via the shared log.js module.
// Tracks per-session failure counts and injects context when a tool fails repeatedly.

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

let log;
try { log = require("./log"); } catch { log = { writeLog() {}, promptHead(t) { return String(t || "").slice(0, 100); } }; }

// ─── Configuration ──────────────────────────────────────────────────────────

const REPEAT_THRESHOLD = 3; // warn after this many failures of same tool
const SESSION_DIR = path.join(os.tmpdir(), "claude-tool-failures");

// ─── Session failure tracking ───────────────────────────────────────────────

function getSessionFile(sessionId) {
  try { fs.mkdirSync(SESSION_DIR, { recursive: true }); } catch {}
  return path.join(SESSION_DIR, `${sessionId || "unknown"}.json`);
}

function loadSessionCounts(sessionId) {
  const file = getSessionFile(sessionId);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function saveSessionCounts(sessionId, counts) {
  const file = getSessionFile(sessionId);
  try {
    fs.writeFileSync(file, JSON.stringify(counts), "utf8");
  } catch {}
}

// ─── Input sanitization ────────────────────────────────────────────────────

/**
 * Create a safe summary of tool_input, redacting potentially sensitive values.
 */
function summarizeInput(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return null;
  const summary = {};
  for (const [key, val] of Object.entries(toolInput)) {
    if (/content|body|source|new_source|new_string|old_string/i.test(key)) {
      summary[key] = log.promptHead(String(val), 80);
    } else if (typeof val === "string" && val.length > 200) {
      summary[key] = log.promptHead(val, 120);
    } else {
      summary[key] = val;
    }
  }
  return summary;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  if (!raw.trim()) { process.stdout.write("{}"); return; }

  let input;
  try { input = JSON.parse(raw); } catch { process.stdout.write("{}"); return; }

  const {
    tool_name = "unknown",
    tool_input,
    error = "",
    session_id,
    tool_use_id,
    cwd,
    is_interrupt,
  } = input;

  // Skip interrupt failures — those are user-initiated, not errors
  if (is_interrupt) {
    process.stdout.write("{}");
    return;
  }

  // Log the failure
  try {
    log.writeLog({
      hook: "tool-failure-logger",
      event: "tool-failure",
      session_id,
      tool_use_id,
      tool_name,
      error: log.promptHead(error, 500),
      tool_input_summary: summarizeInput(tool_input),
      project: cwd,
    });
  } catch {}

  // Track per-session failure counts
  const counts = loadSessionCounts(session_id);
  counts[tool_name] = (counts[tool_name] || 0) + 1;
  saveSessionCounts(session_id, counts);

  // Warn if a tool is failing repeatedly
  if (counts[tool_name] >= REPEAT_THRESHOLD) {
    const msg = `${tool_name} has failed ${counts[tool_name]} times this session. Consider a different approach.`;
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUseFailure",
        additionalContext: msg,
      },
    }));
    return;
  }

  process.stdout.write("{}");
}

// Allow requiring for testing
if (require.main === module) {
  main().catch(() => { process.stdout.write("{}"); });
}

module.exports = { summarizeInput, REPEAT_THRESHOLD };
