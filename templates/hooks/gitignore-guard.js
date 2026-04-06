// PreToolUse hook: warns before git commit if .gitignore is missing from the project root.
// Enforces CLAUDE.md rule: "Every project must have a .gitignore before first commit."
// Advisory only — does not block the commit.

function respond(payload = {}) {
  process.stdout.write(JSON.stringify(payload), () => process.exit(0));
}

const fs = require("fs");
const path = require("path");

let log;
try { log = require("./log"); } catch { log = { writeLog() {} }; }

let input = "";
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    const hookInput = JSON.parse(input);
    const toolName = hookInput.tool_name || "";
    const toolInput = hookInput.tool_input || {};

    // Only check on Bash tool calls that look like git commit
    if (toolName !== "Bash") return respond();
    const cmd = toolInput.command || "";
    if (!/\bgit\s+commit\b/.test(cmd)) return respond();

    const cwd = hookInput.cwd || process.cwd();

    // Check if .gitignore exists in project root
    const gitignorePath = path.join(cwd, ".gitignore");
    if (fs.existsSync(gitignorePath)) return respond();

    // Also check if this is actually a git repo (avoid false positives in non-git dirs)
    const gitDir = path.join(cwd, ".git");
    if (!fs.existsSync(gitDir)) return respond();

    // .gitignore missing in a git project — warn
    log.writeLog({ hook: "gitignore-guard", event: "warn", details: "No .gitignore in project root" });
    return respond({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: "⚠ No .gitignore found in project root. Create one before committing to avoid tracking node_modules/, .env*, dist/, and OS files. At minimum include: node_modules/, dist/, .env*, *.log, .DS_Store, Thumbs.db",
      },
    });
  } catch {
    return respond();
  }
});

if (typeof module !== "undefined") {
  module.exports = {};
}
