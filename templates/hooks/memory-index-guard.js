// PreToolUse hook: enforces MEMORY.md line limit.
//
// MEMORY.md is an index of one-line pointers, not a knowledge base.
// Detailed content belongs in topic files (project_*.md, feedback_*.md, etc.).
//
// Denies Write/Edit operations on MEMORY.md that would exceed MAX_LINES.
// Only checks files whose basename is "MEMORY.md".

"use strict";

function respond(payload = {}) {
  process.stdout.write(JSON.stringify(payload), () => process.exit(0));
}

const fs = require("fs");
const path = require("path");

const MAX_LINES = 50;

let input = "";
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    const hookInput = JSON.parse(input);
    const toolName = hookInput.tool_name || "";

    // Only gate Write and Edit
    if (toolName !== "Write" && toolName !== "Edit") {
      return respond();
    }

    const toolInput = hookInput.tool_input || {};
    const filePath = toolInput.file_path || "";

    // Only guard MEMORY.md files
    if (path.basename(filePath) !== "MEMORY.md") {
      return respond();
    }

    let resultLines = 0;

    if (toolName === "Write") {
      // For Write, we know the exact content
      const content = toolInput.content || "";
      resultLines = content.split("\n").length;
    } else if (toolName === "Edit") {
      // For Edit, read current file and estimate result
      const oldStr = toolInput.old_string || "";
      const newStr = toolInput.new_string || "";
      try {
        const current = fs.readFileSync(filePath, "utf8");
        const currentLines = current.split("\n").length;
        const removedLines = oldStr.split("\n").length;
        const addedLines = newStr.split("\n").length;
        resultLines = currentLines - removedLines + addedLines;
      } catch {
        // File doesn't exist yet or can't read — allow
        return respond();
      }
    }

    if (resultLines > MAX_LINES) {
      const reason = `MEMORY.md would be ${resultLines} lines (limit: ${MAX_LINES}). ` +
        "MEMORY.md is an index — each entry should be one line under 150 chars. " +
        "Move detailed content to topic files (project_*.md, feedback_*.md) and " +
        "keep only one-line pointers in MEMORY.md.";
      return respond({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      });
    }

    return respond();
  } catch {
    // Never block on errors
    return respond();
  }
});
