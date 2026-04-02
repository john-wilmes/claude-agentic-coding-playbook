// PreToolUse hook: enforces session boundaries after checkpoint or context-critical events.
//
// Two sentinel files control behavior:
//   /tmp/claude-checkpoint-exit-<PID>  — written by /checkpoint skill after saving state
//   /tmp/claude-context-high-<PID>     — written by context-guard at 60%+ usage
//
// When checkpoint sentinel exists: deny ALL tool calls (session is done, loop restarts).
// When context-high flag exists: deny all tools EXCEPT those needed for /checkpoint
//   (Bash, Skill, Task, Agent, Read, Write, Edit).
//
// Only active inside claude-loop sessions (CLAUDE_LOOP_PID must be set).
// Subagents (agent_id present) are always skipped.

"use strict";

function respond(payload = {}) {
  process.stdout.write(JSON.stringify(payload), () => process.exit(0));
}

const fs = require("fs");
const path = require("path");
const os = require("os");

let log;
try { log = require("./log"); } catch { log = { writeLog() {} }; }

// Tools that are allowed when context is critical (needed to run /checkpoint).
// Bash + Skill: invoke /checkpoint itself.
// Task + Agent: /checkpoint delegates heavy I/O to a subagent.
// Read + Write + Edit: /checkpoint Step 0 persists unsaved findings before delegating.
const CHECKPOINT_ALLOWED_TOOLS = new Set([
  "Bash", "Skill", "Task", "Agent", "Read", "Write", "Edit",
]);

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
      return respond();
    }

    // Only active inside claude-loop sessions
    const pid = process.env.CLAUDE_LOOP_PID;
    if (!pid || !/^\d+$/.test(pid)) {
      return respond();
    }

    const checkpointSentinel = path.join(os.tmpdir(), `claude-checkpoint-exit-${pid}`);
    const contextHighFlag = path.join(os.tmpdir(), `claude-context-high-${pid}`);

    const checkpointExists = fs.existsSync(checkpointSentinel);
    const contextHighExists = fs.existsSync(contextHighFlag);

    // No active sentinel — allow
    if (!checkpointExists && !contextHighExists) {
      return respond();
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
      return respond({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      });
    }

    // contextHighExists: check for stale flag from a previous session first.
    // If the flag carries a session_id that doesn't match the current session,
    // it was written before claude-loop restarted — delete it and allow the call.
    try {
      const flagContent = JSON.parse(fs.readFileSync(contextHighFlag, "utf8"));
      if (flagContent.session_id && flagContent.session_id !== (hookInput.session_id || "")) {
        fs.unlinkSync(contextHighFlag);
        log.writeLog({
          hook: "checkpoint-gate",
          event: "stale-flag-cleared",
          session_id: hookInput.session_id,
          tool_use_id: hookInput.tool_use_id,
          details: `Stale context-high flag cleared (flag session: ${flagContent.session_id}, current: ${hookInput.session_id})`,
          project: hookInput.cwd,
          context: { tool: toolName },
        });
        return respond();
      }
    } catch {}

    // Allow tools needed for /checkpoint.
    // For Write/Edit, only allow unconditionally if the target is a checkpoint-related file
    // (memory files, current_work.md, MEMORY.md). Other Write/Edit calls get a reminder
    // as additionalContext but are still allowed to proceed.
    if (CHECKPOINT_ALLOWED_TOOLS.has(toolName)) {
      if (toolName === "Write" || toolName === "Edit") {
        const targetPath = (hookInput.tool_input || {}).file_path || "";
        const targetBasename = path.basename(targetPath);
        const isCheckpointFile =
          targetBasename === "MEMORY.md" ||
          targetBasename === "current_work.md" ||
          /(?:^|[\\/])memory[\\/]/.test(targetPath);
        if (!isCheckpointFile) {
          // Non-checkpoint write — allow but remind
          return respond({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              additionalContext:
                "Context is critical (60%+). Only /checkpoint is permitted — run it now. " +
                "This write is being allowed, but please run /checkpoint immediately after.",
            },
          });
        }
      }
      return respond();
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
    return respond({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    });
  } catch {
    // Never block tool execution on errors
    return respond();
  }
});
