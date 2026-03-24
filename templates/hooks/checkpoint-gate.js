// PreToolUse hook: enforces session boundaries after checkpoint or context-critical events.
//
// Two sentinel files control behavior:
//   /tmp/claude-checkpoint-exit-<PID>  — written by /checkpoint skill after saving state
//   /tmp/claude-context-high-<PID>     — written by context-guard at 60%+ usage
//
// When checkpoint sentinel exists: deny ALL tool calls (session is done, loop restarts).
// When context-high flag exists: deny all tools EXCEPT Bash and Skill (needed for /checkpoint).
//
// Only active inside claude-loop sessions (CLAUDE_LOOP_PID must be set).
// Subagents (agent_id present) are always skipped.

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

let log;
try { log = require("./log"); } catch { log = { writeLog() {} }; }

// Tools that are allowed when context is critical (needed to run /checkpoint)
const CHECKPOINT_ALLOWED_TOOLS = new Set(["Bash", "Skill"]);

// Read hook input from stdin
let input = "";
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    const hookInput = JSON.parse(input);

    // Skip subagents entirely
    if (hookInput.agent_id) {
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    // Only active inside claude-loop sessions
    const pid = process.env.CLAUDE_LOOP_PID;
    if (!pid) {
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    const checkpointSentinel = path.join(os.tmpdir(), `claude-checkpoint-exit-${pid}`);
    const contextHighFlag = path.join(os.tmpdir(), `claude-context-high-${pid}`);

    const checkpointExists = fs.existsSync(checkpointSentinel);
    const contextHighExists = fs.existsSync(contextHighFlag);

    // No active sentinel — allow
    if (!checkpointExists && !contextHighExists) {
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    const toolName = hookInput.tool_name || "";

    if (checkpointExists) {
      // Checkpoint complete — deny all tools unconditionally
      const reason = "Session checkpoint complete — no further tool calls. Claude-loop will restart.";
      log.writeLog({
        hook: "checkpoint-gate",
        event: "deny",
        session_id: hookInput.session_id,
        tool_use_id: hookInput.tool_use_id,
        details: reason,
        project: hookInput.cwd,
        context: { tool: toolName, sentinel: "checkpoint" },
      });
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      }));
      process.exit(0);
    }

    // contextHighExists: allow Bash and Skill (for /checkpoint), deny everything else
    if (CHECKPOINT_ALLOWED_TOOLS.has(toolName)) {
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    const reason = "Context critical (60%+). Only /checkpoint is permitted — run it now.";
    log.writeLog({
      hook: "checkpoint-gate",
      event: "deny",
      session_id: hookInput.session_id,
      tool_use_id: hookInput.tool_use_id,
      details: reason,
      project: hookInput.cwd,
      context: { tool: toolName, sentinel: "context-high" },
    });
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }));
    process.exit(0);
  } catch {
    // Never block tool execution on errors
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }
});
