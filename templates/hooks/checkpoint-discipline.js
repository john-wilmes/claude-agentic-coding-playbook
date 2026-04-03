// PreToolUse hook: checkpoint discipline — two guards in one.
//
// Guard 1 (Agent): When an Agent tool call looks like checkpoint delegation,
// checks whether memory topic files were recently written. If not, warns
// to run Step 0 first. Allows bypass via ack marker.
//
// Guard 2 (Write/Edit): When the parent context writes to current_work.md
// directly (not via a subagent), warns that /checkpoint should be used
// instead of manual memory updates. The checkpoint skill delegates this
// to a subagent — parent writes are a "fake checkpoint" that skip commit,
// push, sentinel, and clean handoff.

"use strict";

function respond(payload = {}) {
  process.stdout.write(JSON.stringify(payload), () => process.exit(0));
}

const fs = require("fs");
const path = require("path");
const os = require("os");

// --- Guard 1 constants ---
const RECENCY_WINDOW_MS = 120_000; // 2 minutes
const ACK_MARKER = path.join(os.tmpdir(), "checkpoint-preflight-ack");
const ACK_MAX_AGE_MS = 60_000; // 1 minute
const CHECKPOINT_KEYWORDS = /checkpoint|save.?work|wrap.?up|session.?end/i;

let input = "";
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    const hookInput = JSON.parse(input);
    const toolName = hookInput.tool_name || "";

    // Skip subagents — both guards only apply to parent context
    if (hookInput.agent_id) {
      return respond();
    }

    if (toolName === "Agent") {
      guardCheckpointDelegation(hookInput);
    } else if (toolName === "Write" || toolName === "Edit") {
      guardManualCheckpoint(hookInput);
    } else {
      return respond();
    }
  } catch {
    return respond();
  }
});

// --- Guard 1: checkpoint delegation without persisting findings ---

function guardCheckpointDelegation(hookInput) {
  const toolInput = hookInput.tool_input || {};
  const prompt = toolInput.prompt || "";

  if (!CHECKPOINT_KEYWORDS.test(prompt)) {
    return respond();
  }

  if (checkBypassMarker()) {
    return respond();
  }

  if (hasRecentMemoryWrites()) {
    return respond();
  }

  return respond({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext:
        "CHECKPOINT PREFLIGHT: No memory topic files were written in the last 2 minutes. " +
        "Step 0 requires persisting unsaved findings to memory topic files before delegating. " +
        "If all findings are already saved, acknowledge by writing a JSON ack file and then retry:\n" +
        '  Bash: echo \'{"persisted":["file1.md","file2.md"]}\' > /tmp/checkpoint-preflight-ack\n' +
        "If there is genuinely nothing to persist:\n" +
        '  Bash: echo \'{"nothing_to_persist":true}\' > /tmp/checkpoint-preflight-ack',
    },
  });
}

// --- Guard 2: parent writing current_work.md directly ---

function guardManualCheckpoint(hookInput) {
  const toolInput = hookInput.tool_input || {};
  const filePath = toolInput.file_path || "";
  const basename = path.basename(filePath);

  // Only guard current_work.md in memory directories
  if (basename !== "current_work.md" || !filePath.includes("/memory/")) {
    return respond();
  }

  // Check if context is elevated — look for context-guard signal files
  const pid = process.env.CLAUDE_LOOP_PID || "";
  const contextHigh = pid && /^\d+$/.test(pid) &&
    fs.existsSync(path.join(os.tmpdir(), `claude-context-high-${pid}`));

  // At high context, this is almost certainly a fake checkpoint — warn strongly
  if (contextHigh) {
    return respond({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext:
          "CHECKPOINT DISCIPLINE: You are writing current_work.md directly at high context. " +
          "Use /checkpoint instead — it handles commit, push, sentinel, and clean session handoff. " +
          "Manual memory updates skip all of that. Run: /checkpoint",
      },
    });
  }

  // At normal context, give a lighter reminder
  return respond({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext:
        "CHECKPOINT REMINDER: Writing current_work.md directly. If you are checkpointing, " +
        "use /checkpoint instead — it ensures commit, push, and clean handoff. " +
        "If you are just updating status mid-session, ignore this message.",
    },
  });
}

// --- Shared helpers ---

function checkBypassMarker() {
  try {
    const stat = fs.statSync(ACK_MARKER);
    const age = Date.now() - stat.mtimeMs;
    if (age < ACK_MAX_AGE_MS) {
      // Validate JSON ack — must have either persisted[] or nothing_to_persist:true
      try {
        const content = fs.readFileSync(ACK_MARKER, "utf8").trim();
        const ack = JSON.parse(content);
        const valid = ack.nothing_to_persist === true ||
          (Array.isArray(ack.persisted) && ack.persisted.length > 0);
        if (!valid) return false;
      } catch {
        // Not valid JSON — reject the bypass
        return false;
      }
      try { fs.unlinkSync(ACK_MARKER); } catch { /* ignore */ }
      return true;
    }
  } catch {
    // Marker doesn't exist
  }
  return false;
}

function hasRecentMemoryWrites() {
  const now = Date.now();
  const memoryDirs = findMemoryDirs();

  for (const dir of memoryDirs) {
    try {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (file === "MEMORY.md") continue;
        if (!file.endsWith(".md")) continue;

        const filePath = path.join(dir, file);
        try {
          const stat = fs.statSync(filePath);
          if (now - stat.mtimeMs < RECENCY_WINDOW_MS) {
            return true;
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  return false;
}

function findMemoryDirs() {
  const dirs = [];
  const projectsRoot = path.join(os.homedir(), ".claude", "projects");
  try {
    for (const project of fs.readdirSync(projectsRoot)) {
      const memDir = path.join(projectsRoot, project, "memory");
      try {
        if (fs.statSync(memDir).isDirectory()) {
          dirs.push(memDir);
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return dirs;
}
