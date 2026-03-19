// PostCompact hook: re-injects memory context after auto-compaction.
//
// After Claude Code compacts the conversation, the agent loses its
// pre-compact state. This hook reads the MEMORY.md snapshot (written by
// pre-compact.js) and surfaces it as additionalContext so the agent can
// resume where it left off.
//
// On any error, outputs {} and exits 0 — never blocks post-compaction.

const fs = require("fs");
const path = require("path");
const os = require("os");

// Convert a cwd path to the ~/.claude/projects/ key format:
//   /home/user/Documents/myproject  ->  -home-user-Documents-myproject
function cwdToProjectKey(cwd) {
  return cwd.replace(/:/g, "-").replace(/[\\/]/g, "-").replace(/^-/, "");
}

function findMemoryPath(cwd) {
  const home = os.homedir();
  const key = cwdToProjectKey(cwd);
  return path.join(home, ".claude", "projects", key, "memory", "MEMORY.md");
}

/**
 * Read MEMORY.md and return the Pre-compact snapshot section if present,
 * falling back to the Current Work section. Returns null if neither exists
 * or the file is not found.
 */
function readCurrentWork(memFile) {
  let content;
  try {
    content = fs.readFileSync(memFile, "utf8");
  } catch {
    return null;
  }

  // Extract a named ## section: from the header line to the next ## header or EOF
  function extractSection(text, header) {
    const idx = text.indexOf(header);
    if (idx === -1) return null;
    // Find the next ## header after this one
    const rest = text.slice(idx);
    const nextMatch = rest.match(/\n## /);
    const section = nextMatch ? rest.slice(0, nextMatch.index) : rest;
    return section.trim() || null;
  }

  const snapshot = extractSection(content, "## Pre-compact snapshot");
  if (snapshot) return snapshot;

  const currentWork = extractSection(content, "## Current Work");
  if (currentWork) return currentWork;

  return null;
}

/**
 * Build the additionalContext string from the extracted section and optional
 * sentinel path. Returns null if currentWork is null/empty.
 */
function buildContext(currentWork, sentinel) {
  if (!currentWork) return null;
  let ctx = currentWork;
  if (sentinel) {
    ctx += `\nTask queue: ${sentinel}`;
  }
  return ctx;
}

let input = "";
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    const hookInput = JSON.parse(input);
    const cwd = hookInput.cwd || process.cwd();
    const sentinel = process.env.CLAUDE_LOOP_SENTINEL || null;

    const memFile = findMemoryPath(cwd);
    const currentWork = readCurrentWork(memFile);
    const ctx = buildContext(currentWork, sentinel);

    if (!ctx) {
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        additionalContext: ctx,
      },
    }));
    process.exit(0);
  } catch {
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }
});

if (typeof module !== "undefined") {
  module.exports = { cwdToProjectKey, findMemoryPath, readCurrentWork, buildContext };
}
