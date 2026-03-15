// PostToolUse hook: enforces MEMORY.md line limit by overflowing excess content.
//
// When MEMORY.md exceeds 150 lines after an Edit/Write, the hook truncates in-place
// and writes overflow content to a dated file. This prevents silent data loss at
// Claude Code's 200-line hard truncation.
//
// Also provides advisory warnings when CLAUDE.md files grow too large.

const fs = require("fs");
const path = require("path");
const os = require("os");

const MEMORY_LIMIT = 150;
const CLAUDE_WARN = 700;

/**
 * Check if filePath points to the active project's MEMORY.md.
 * @param {string} filePath - absolute path from tool_input
 * @param {string} cwd - project working directory
 * @returns {boolean}
 */
function isMemoryFile(filePath, cwd) {
  if (!filePath || !cwd) return false;
  try {
    const cwdEncoded = cwd.replace(/:/g, "-").replace(/[\\/]/g, "-").replace(/^-/, "");
    const expectedPath = path.join(os.homedir(), ".claude", "projects", cwdEncoded, "memory", "MEMORY.md");
    return path.resolve(filePath) === path.resolve(expectedPath);
  } catch {
    return false;
  }
}

/**
 * Split content at a line limit.
 * @param {string} content
 * @param {number} limit
 * @returns {{ keep: string, overflow: string|null }}
 */
function splitLines(content, limit) {
  const lines = content.trimEnd().split("\n");
  if (lines.length <= limit) {
    return { keep: content, overflow: null };
  }
  const keepLines = lines.slice(0, limit);
  const overflowLines = lines.slice(limit);
  return {
    keep: keepLines.join("\n") + "\n",
    overflow: overflowLines.join("\n") + "\n",
  };
}

/**
 * Generate a dated overflow filename with collision avoidance.
 * @param {string} memDir - directory containing MEMORY.md
 * @returns {string} absolute path to overflow file
 */
function overflowFilename(memDir) {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const base = `overflow-${yyyy}-${mm}-${dd}`;

  let candidate = path.join(memDir, `${base}.md`);
  if (!fs.existsSync(candidate)) return candidate;

  let counter = 2;
  while (counter < 100) {
    candidate = path.join(memDir, `${base}-${counter}.md`);
    if (!fs.existsSync(candidate)) return candidate;
    counter++;
  }
  return candidate;
}

/**
 * Build overflow file content with header comment.
 * @param {string} overflow - the overflowed lines
 * @param {string} sourceFile - source filename
 * @param {string} timestamp - ISO timestamp
 * @returns {string}
 */
function buildOverflowContent(overflow, sourceFile, timestamp) {
  return `<!-- Overflow from ${sourceFile} at ${timestamp} -->\n<!-- Review and prune: merge useful content back into MEMORY.md, delete the rest -->\n\n${overflow}`;
}

/**
 * Enforce MEMORY.md line limit. Truncates in-place and writes overflow file.
 * @param {string} memFilePath - absolute path to MEMORY.md
 * @returns {string|null} message describing what happened, or null
 */
function enforceMemoryLimit(memFilePath) {
  try {
    const content = fs.readFileSync(memFilePath, "utf8");
    const { keep, overflow } = splitLines(content, MEMORY_LIMIT);
    if (!overflow) return null;

    const memDir = path.dirname(memFilePath);
    const overflowPath = overflowFilename(memDir);
    const timestamp = new Date().toISOString();
    const overflowContent = buildOverflowContent(overflow, "MEMORY.md", timestamp);

    fs.writeFileSync(overflowPath, overflowContent);
    fs.writeFileSync(memFilePath, keep);

    const overflowName = path.basename(overflowPath);
    const lineCount = content.trimEnd().split("\n").length;
    return `MEMORY.md exceeded ${MEMORY_LIMIT} lines (was ${lineCount}). Overflowed lines ${MEMORY_LIMIT + 1}+ to memory/${overflowName}. Review and prune the overflow file.`;
  } catch {
    return null;
  }
}

/**
 * Advisory check: warn if combined CLAUDE.md files exceed threshold.
 * @param {string} cwd - project working directory
 * @returns {string|null}
 */
function checkClaudeSize(cwd) {
  try {
    let totalLines = 0;

    const globalClaude = path.join(os.homedir(), ".claude", "CLAUDE.md");
    try {
      totalLines += fs.readFileSync(globalClaude, "utf8").trimEnd().split("\n").length;
    } catch {}

    const projectClaude = path.join(cwd, "CLAUDE.md");
    try {
      totalLines += fs.readFileSync(projectClaude, "utf8").trimEnd().split("\n").length;
    } catch {}

    if (totalLines > CLAUDE_WARN) {
      return `CLAUDE.md files total ${totalLines} lines (threshold: ${CLAUDE_WARN}). Consider splitting into smaller files.`;
    }
    return null;
  } catch {
    return null;
  }
}

// --- Stdin handler ---
process.stdin.resume();
process.stdin.setEncoding("utf8");
let inputData = "";
process.stdin.on("data", (chunk) => { inputData += chunk; });
process.stdin.on("end", () => {
  try {
    const input = JSON.parse(inputData);
    const toolName = input.tool_name;
    const toolInput = input.tool_input || {};
    const filePath = toolInput.file_path;

    if (toolName !== "Edit" && toolName !== "Write") {
      process.stdout.write(JSON.stringify({}));
      return;
    }

    if (!filePath) {
      process.stdout.write(JSON.stringify({}));
      return;
    }

    const cwd = input.cwd || process.cwd();
    const messages = [];

    if (isMemoryFile(filePath, cwd)) {
      const msg = enforceMemoryLimit(filePath);
      if (msg) messages.push(msg);
    }

    if (path.basename(filePath) === "CLAUDE.md") {
      const msg = checkClaudeSize(cwd);
      if (msg) messages.push(msg);
    }

    if (messages.length > 0) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: messages.join("\n\n"),
        },
      }));
    } else {
      process.stdout.write(JSON.stringify({}));
    }
  } catch {
    process.stdout.write(JSON.stringify({}));
  }
});

// Export for testing
if (typeof module !== "undefined") {
  module.exports = { isMemoryFile, splitLines, overflowFilename, buildOverflowContent, enforceMemoryLimit, checkClaudeSize, MEMORY_LIMIT, CLAUDE_WARN };
}
