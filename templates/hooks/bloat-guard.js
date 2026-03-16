#!/usr/bin/env node
/**
 * bloat-guard.js — PreToolUse hook
 * Warns when the agent creates new files to prevent orphan/throwaway files.
 *
 * Covers:
 *   - Write tool: checks file_path for new file creation
 *   - Warns on throwaway filename patterns (test-*, debug-*, tmp-*, scratch.*, untitled*)
 *   - Advisory warning for all new files (every new file must be referenced)
 *   - Escalates after 5+ new files per session
 */

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

let log;
try {
  log = require("./log");
} catch {
  log = { writeLog() {}, promptHead(t) { return t; } };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const THROWAWAY_PATTERNS = [
  /^test-.*\.js$/,
  /^debug-/,
  /^tmp-/,
  /^scratch\./,
  /^untitled/,
];

const STATE_DIR = path.join(os.tmpdir(), "claude-bloat-guard");
const ESCALATION_THRESHOLD = 5;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get a session-scoped state file path.
 * @param {string} sessionId - from hookInput.session_id
 */
function getStateFile(sessionId) {
  const id = sessionId || process.env.PPID || "default";
  return path.join(STATE_DIR, `${id}.json`);
}

/**
 * Load the list of files created this session.
 * Returns an array of file paths.
 */
function loadState(sessionId) {
  try {
    const data = fs.readFileSync(getStateFile(sessionId), "utf8");
    const parsed = JSON.parse(data);
    return Array.isArray(parsed.files) ? parsed.files : [];
  } catch {
    return [];
  }
}

/**
 * Save a new file path to the session state.
 */
function saveState(sessionId, files) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(getStateFile(sessionId), JSON.stringify({ files }));
  } catch {
    // Best-effort; don't crash the hook
  }
}

/**
 * Check if a filename matches throwaway patterns.
 */
function isThrowaway(filename) {
  return THROWAWAY_PATTERNS.some(re => re.test(filename));
}

/**
 * Expand leading ~ to the home directory.
 */
function expandTilde(filePath) {
  if (filePath.startsWith("~/") || filePath === "~") {
    return path.join(os.homedir(), filePath.slice(1));
  }
  return filePath;
}

/**
 * Check a file path for bloat. Returns null to allow silently,
 * or { decision, reason } for warn/deny.
 */
function checkNewFile(filePath, sessionId) {
  if (!filePath) return null;

  const expanded = expandTilde(filePath);

  // If file already exists, this is an edit — always allow
  try {
    fs.accessSync(expanded, fs.constants.F_OK);
    return null; // File exists, this is an edit
  } catch {
    // File doesn't exist — this is a new file creation
  }

  // Files in /tmp/ are exempt (legitimate temp usage)
  if (expanded.startsWith("/tmp/") || expanded.startsWith(os.tmpdir())) {
    return null;
  }

  const filename = path.basename(expanded);

  // Track creation count (before throwaway check so throwaway files count toward session total)
  const createdFiles = loadState(sessionId);
  createdFiles.push(expanded);
  saveState(sessionId, createdFiles);

  // Block throwaway filename patterns
  if (isThrowaway(filename)) {
    return {
      decision: "warn",
      reason:
        `BLOAT WARNING: "${filename}" matches a throwaway file pattern. ` +
        `One-off scripts, debug files, and scratch files should not be created as files. ` +
        `If this file is genuinely needed, ensure it is referenced by an existing file.`,
    };
  }

  const count = createdFiles.length;

  if (count > ESCALATION_THRESHOLD) {
    return {
      decision: "warn",
      reason:
        `BLOAT WARNING: ${count} new files created this session (threshold: ${ESCALATION_THRESHOLD}). ` +
        `Every new file must be referenced by an existing file. Consider editing existing files instead. ` +
        `New file: "${filename}"`,
    };
  }

  // Advisory warning for all new files
  return {
    decision: "warn",
    reason:
      `New file: "${filename}". Remember: every new file must be referenced by at least one existing file. ` +
      `Orphan files are not allowed.`,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const event = JSON.parse(input);
    const toolName = event.tool_name;
    const toolInput = event.tool_input || {};
    const sessionId = event.session_id || null;

    // Only inspect Write tool
    if (toolName !== "Write") {
      process.stdout.write("{}");
      return;
    }

    const filePath = toolInput.file_path || null;
    const result = checkNewFile(filePath, sessionId);

    if (result) {
      log.writeLog({ hook: "bloat-guard", event: result.decision, filePath, reason: result.reason });
      const output = {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: result.decision,
          permissionDecisionReason: result.reason,
        },
      };
      process.stdout.write(JSON.stringify(output));
    } else {
      process.stdout.write("{}");
    }
  } catch (_err) {
    process.stdout.write("{}");
  }
  process.exit(0);
});

// ---------------------------------------------------------------------------
// Exports (for tests)
// ---------------------------------------------------------------------------
if (typeof module !== "undefined") {
  module.exports = { checkNewFile, isThrowaway, THROWAWAY_PATTERNS, ESCALATION_THRESHOLD };
}
