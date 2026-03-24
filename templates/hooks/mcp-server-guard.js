#!/usr/bin/env node
/**
 * mcp-server-guard.js — PreToolUse hook (fires once per session)
 * Warns when project-level MCP servers are enabled without explicit approval.
 *
 * CLAUDE.md rule: "Disable project-level MCP servers by default
 * (enableAllProjectMcpServers: false) to prevent supply chain injection."
 *
 * Checks the user's global settings.json for enableAllProjectMcpServers.
 * If true, emits an advisory warning (not a deny — the user chose this setting).
 *
 * Uses a per-session temp file to fire only once per session.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

let log;
try { log = require("./log"); } catch { log = { writeLog() {} }; }

/**
 * Check if we already warned this session.
 */
function alreadyWarned(sessionId) {
  const flag = path.join(os.tmpdir(), `claude-mcp-warned-${sessionId}`);
  return fs.existsSync(flag);
}

/**
 * Mark that we warned this session.
 */
function markWarned(sessionId) {
  const flag = path.join(os.tmpdir(), `claude-mcp-warned-${sessionId}`);
  fs.writeFileSync(flag, "1");
}

/**
 * Check if enableAllProjectMcpServers is true in settings.
 * Checks global settings.json at ~/.claude/settings.json.
 */
function isProjectMcpEnabled(home) {
  const settingsPath = path.join(home || os.homedir(), ".claude", "settings.json");
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    return settings.enableAllProjectMcpServers === true;
  } catch {
    return false;
  }
}

/**
 * Check if the current project directory has .mcp.json (project-level MCP config).
 */
function hasProjectMcpConfig(cwd) {
  if (!cwd) return false;
  return fs.existsSync(path.join(cwd, ".mcp.json"));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let input = "";
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const event = JSON.parse(input);
    const sessionId = event.session_id || "unknown";

    // Only warn once per session
    if (alreadyWarned(sessionId)) {
      process.stdout.write("{}");
      process.exit(0);
    }

    // Check if project MCP servers are enabled globally
    const enabled = isProjectMcpEnabled();

    // Mark warned so we don't repeat regardless of outcome
    markWarned(sessionId);

    if (!enabled) {
      // Setting is off — no concern
      process.stdout.write("{}");
      process.exit(0);
    }

    const warning =
      "⚠ SECURITY: enableAllProjectMcpServers is TRUE in your global settings. " +
      "CLAUDE.md recommends keeping this false to prevent supply chain injection. " +
      "Project-level MCP servers should be explicitly approved per-project.";

    log.writeLog({
      hook: "mcp-server-guard",
      event: "warn",
      session_id: sessionId,
      details: warning,
      context: { enabled, cwd: event.cwd || "" },
    });

    // Advisory only — don't deny, just inform
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: warning,
      },
    }));
    process.exit(0);
  } catch {
    process.stdout.write("{}");
    process.exit(0);
  }
});

// ---------------------------------------------------------------------------
// Exports (for tests)
// ---------------------------------------------------------------------------
if (typeof module !== "undefined") {
  module.exports = { isProjectMcpEnabled, hasProjectMcpConfig, alreadyWarned, markWarned };
}
