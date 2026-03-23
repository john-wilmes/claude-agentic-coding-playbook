// PreToolUse hook: blocks re-reads of unchanged files to save context tokens.
//
// Tracks every Read tool call per session. On a second read of the same file:
//   - If the file's mtime is unchanged: deny (file is already in context).
//   - If the file's mtime is newer: allow (file has changed since last read).
//   - If the read window differs (offset/limit): always allow.
//
// Context savings: 38–40% reduction in file-read token spend in practice.
//
// Cross-session persistence: when CLAUDE_LOOP_PID is set, state is keyed by
// loop PID so restarts within one claude-loop run share the read registry.
//
// Skips:
//   - Non-Read tool calls (pass through immediately)
//   - Subagents (agent_id present — disposable context, no dedup needed)
//   - Files under ~/.claude/ (legitimately re-read: memory, config, etc.)
//
// State TTL: 4 hours. On stale state the hook starts fresh.
// On any unexpected error: outputs {} and exits 0 — never blocks unexpectedly.

const fs = require("fs");
const path = require("path");
const os = require("os");

let log;
try { log = require("./log"); } catch { log = { writeLog() {} }; }

// ─── Constants ────────────────────────────────────────────────────────────────

const STATE_DIR = path.join(os.tmpdir(), "claude-read-once-dedup");
const STATE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

// ─── State management ─────────────────────────────────────────────────────────

function getStateKey(sessionId) {
  const loopPid = process.env.CLAUDE_LOOP_PID;
  return loopPid ? `loop-${loopPid}` : sessionId;
}

function getStateFile(sessionId) {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch {}
  return path.join(STATE_DIR, `${getStateKey(sessionId)}.json`);
}

function loadState(stateFile) {
  try {
    const mtime = fs.statSync(stateFile).mtimeMs;
    if (Date.now() - mtime > STATE_TTL_MS) {
      // Stale state — discard and start fresh.
      try { fs.unlinkSync(stateFile); } catch {}
      return { reads: {} };
    }
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return { reads: {} };
  }
}

function saveState(stateFile, state) {
  try {
    fs.writeFileSync(stateFile, JSON.stringify(state));
  } catch {}
}

// ─── Path normalization ───────────────────────────────────────────────────────

/**
 * Normalize a file path: expand leading ~ to homedir, then resolve to absolute.
 * @param {string} filePath
 * @returns {string}
 */
function normalizeFilePath(filePath) {
  if (!filePath) return filePath;
  if (filePath.startsWith("~/") || filePath === "~") {
    filePath = path.join(os.homedir(), filePath.slice(2));
  }
  return path.resolve(filePath);
}

// ─── Core check ───────────────────────────────────────────────────────────────

/**
 * Check whether a Read call should be allowed or denied.
 *
 * @param {object} params
 * @param {string} params.filePath       - Raw file_path from tool_input
 * @param {*}      params.offset         - offset from tool_input (may be absent)
 * @param {*}      params.limit          - limit from tool_input (may be absent)
 * @param {string} params.sessionId
 * @returns {{ decision: "allow"|"deny", reason?: string }}
 */
function checkRead({ filePath, offset, limit, sessionId }) {
  const normalizedPath = normalizeFilePath(filePath);

  // Always allow reads under ~/.claude/ (memory, config, skills, etc.)
  const claudeDir = path.join(os.homedir(), ".claude");
  if (normalizedPath.startsWith(claudeDir + path.sep) || normalizedPath === claudeDir) {
    return { decision: "allow" };
  }

  // Normalize offset/limit: treat null, undefined, absent as equivalent → null
  const normOffset = (offset === null || offset === undefined) ? null : offset;
  const normLimit = (limit === null || limit === undefined) ? null : limit;

  const stateFile = getStateFile(sessionId);
  const state = loadState(stateFile);

  const record = state.reads[normalizedPath];

  if (record) {
    // Different read window → always allow (user is reading a different slice)
    if (record.offset !== normOffset || record.limit !== normLimit) {
      // Update record for the new window
      let currentMtimeMs = null;
      try {
        currentMtimeMs = fs.statSync(normalizedPath).mtimeMs;
      } catch (err) {
        if (err.code === "ENOENT") {
          // File deleted — clear record, allow through
          delete state.reads[normalizedPath];
          saveState(stateFile, state);
          return { decision: "allow" };
        }
        // Other stat error — allow through conservatively
        return { decision: "allow" };
      }
      state.reads[normalizedPath] = {
        mtimeMs: currentMtimeMs,
        lastReadAt: Date.now(),
        offset: normOffset,
        limit: normLimit,
      };
      saveState(stateFile, state);
      return { decision: "allow" };
    }

    // Same window as before — check mtime
    let currentMtimeMs;
    try {
      currentMtimeMs = fs.statSync(normalizedPath).mtimeMs;
    } catch (err) {
      if (err.code === "ENOENT") {
        // File deleted — clear record, allow through
        delete state.reads[normalizedPath];
        saveState(stateFile, state);
        return { decision: "allow" };
      }
      // Other stat error — allow through conservatively
      return { decision: "allow" };
    }

    if (currentMtimeMs <= record.mtimeMs) {
      // File unchanged — block re-read
      return {
        decision: "deny",
        reason:
          "File already in context and unchanged. " +
          "Use the content already in context, or use a different offset/limit to read a new section.",
      };
    }

    // File has changed — allow and update record
    state.reads[normalizedPath] = {
      mtimeMs: currentMtimeMs,
      lastReadAt: Date.now(),
      offset: normOffset,
      limit: normLimit,
    };
    saveState(stateFile, state);
    return { decision: "allow" };
  }

  // First read of this file — record it
  let mtimeMs = null;
  try {
    mtimeMs = fs.statSync(normalizedPath).mtimeMs;
  } catch {
    // File not stat-able (may not exist yet) — allow through, don't record
    return { decision: "allow" };
  }

  state.reads[normalizedPath] = {
    mtimeMs,
    lastReadAt: Date.now(),
    offset: normOffset,
    limit: normLimit,
  };
  saveState(stateFile, state);
  return { decision: "allow" };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

let input = "";
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    const hookInput = JSON.parse(input);

    // Only intercept Read tool calls
    const toolName = hookInput.tool_name || "";
    if (toolName !== "Read") {
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    // Subagents have disposable context — skip dedup
    if (hookInput.agent_id) {
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    const sessionId = hookInput.session_id || "unknown";
    const toolInput = hookInput.tool_input || {};
    const filePath = toolInput.file_path || "";
    const offset = toolInput.offset;
    const limit = toolInput.limit;

    const result = checkRead({ filePath, offset, limit, sessionId });

    if (result.decision === "deny") {
      log.writeLog({
        hook: "read-once-dedup",
        event: "block",
        session_id: hookInput.session_id,
        tool_use_id: hookInput.tool_use_id,
        details: `Blocked re-read of unchanged file: ${filePath}`,
        project: hookInput.cwd,
        context: { file: filePath },
      });
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: result.reason,
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

// Export for testing
if (typeof module !== "undefined") {
  module.exports = { checkRead, normalizeFilePath, STATE_DIR, STATE_TTL_MS };
}
