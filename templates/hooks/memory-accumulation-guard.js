// PreToolUse hook: detects accumulating session state in MEMORY.md.
//
// Checkpoint should REPLACE the previous Current Work entry, not accumulate.
// This hook denies Write/Edit operations on MEMORY.md that would result in
// multiple session date stamps or duplicate session headers — a sign that
// previous entries weren't replaced.

"use strict";

function respond(payload = {}) {
  process.stdout.write(JSON.stringify(payload), () => process.exit(0));
}

const fs = require("fs");
const path = require("path");

// Patterns that indicate session state entries
const DATE_PATTERN = /^\*\*Date:\*\*/gm;
const SESSION_HEADERS = [
  /^### What was done/gm,
  /^### Current State/gm,
  /^### Next Steps/gm,
];

function countMatches(text, regex) {
  // Reset lastIndex for global regexes
  regex.lastIndex = 0;
  const matches = text.match(regex);
  return matches ? matches.length : 0;
}

function checkForAccumulation(content) {
  const dateCount = countMatches(content, DATE_PATTERN);
  if (dateCount > 1) {
    return `Found ${dateCount} session date stamps (**Date:**) — checkpoint should replace, not accumulate.`;
  }

  for (const pattern of SESSION_HEADERS) {
    const count = countMatches(content, pattern);
    if (count > 1) {
      return `Found ${count} occurrences of "${pattern.source}" — checkpoint should replace, not accumulate.`;
    }
  }

  return null;
}

let input = "";
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    const hookInput = JSON.parse(input);
    const toolName = hookInput.tool_name || "";

    if (toolName !== "Write" && toolName !== "Edit") {
      return respond();
    }

    const toolInput = hookInput.tool_input || {};
    const filePath = toolInput.file_path || "";

    if (path.basename(filePath) !== "MEMORY.md") {
      return respond();
    }

    let resultContent = "";

    if (toolName === "Write") {
      resultContent = toolInput.content || "";
    } else if (toolName === "Edit") {
      const oldStr = toolInput.old_string || "";
      const newStr = toolInput.new_string || "";
      try {
        const current = fs.readFileSync(filePath, "utf8");
        resultContent = current.replace(oldStr, newStr);
      } catch {
        return respond();
      }
    }

    const issue = checkForAccumulation(resultContent);
    if (issue) {
      const reason = `MEMORY.md accumulation detected: ${issue} ` +
        "Move session state to a topic file (e.g. current_work.md) " +
        "or replace the existing entry instead of appending.";
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
    return respond();
  }
});

// Export for testing
if (typeof module !== "undefined") {
  module.exports = { checkForAccumulation, countMatches };
}
