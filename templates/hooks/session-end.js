// SessionEnd hook: auto-commits memory changes to the ~/.claude git repo.
// Runs automatically when a session closes -- all agents, all projects.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

let capture;
try { capture = require("./knowledge-capture"); } catch { capture = null; }

const LOG_DIR = path.join(os.homedir(), ".claude");
const LOG_FILE = path.join(LOG_DIR, "hooks.log");

function log(msg) {
  try {
    const line = `[${new Date().toISOString()}] session-end: ${msg}\n`;
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line);
  } catch {}
}

let input = "";
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    const hookInput = JSON.parse(input);
    const sessionId = hookInput.session_id || "";
    const cwd = hookInput.cwd || process.cwd();
    const agentName = path.basename(cwd) || "unknown";

    log(`session ${sessionId.slice(0, 8)} ended for ${agentName}`);

    // Auto-commit THIS session's memory file only.
    // Using "git add -A" would stage other agents' memory files when multiple
    // projects are open simultaneously, causing wrong attribution and git index
    // contention. Stage only the path owned by this session.
    try {
      const claudeDir = path.join(os.homedir(), ".claude");
      const gitOpts = { cwd: claudeDir, timeout: 5000, stdio: "pipe" };

      // Initialize ~/.claude as a git repo if it isn't one yet
      try {
        execSync("git rev-parse --git-dir", gitOpts);
      } catch {
        execSync("git init", gitOpts);
        log("memory auto-commit: initialized ~/.claude as git repo");
      }

      // Encode cwd to the project key Claude Code uses for memory paths
      const encodedCwd = cwd.replace(/:/g, "-").replace(/[\\/]/g, "-").replace(/^-/, "");
      const memoryPath = `projects/${encodedCwd}/memory/MEMORY.md`;

      try {
        execSync("git add -- " + JSON.stringify(memoryPath), gitOpts);
      } catch {
        // Memory file may not exist yet -- skip
      }

      // Check if there are staged changes before committing
      try {
        execSync("git diff --cached --quiet", gitOpts);
        // No staged changes -- skip commit
        log("memory auto-commit: no changes");
      } catch {
        // diff --quiet exits non-zero when there ARE staged changes
        const msg = `auto: ${agentName.replace(/[`$"\\]/g, "")} session ${sessionId.slice(0, 8)}`;
        execSync(`git commit -m "${msg}"`, gitOpts);
        log("memory auto-commit: committed");
        // Push to remote (non-blocking, best-effort)
        try {
          execSync("git push", { ...gitOpts, timeout: 8000 });
          log("memory auto-push: pushed to remote");
        } catch (pushErr) {
          log(`memory auto-push skipped: ${pushErr.message}`);
        }
      }
    } catch (commitErr) {
      log(`memory auto-commit error: ${commitErr.message}`);
    }

    // Prune old staged knowledge candidates (older than 7 days)
    if (capture) {
      try { capture.pruneStagedFiles(7); } catch {}
    }
  } catch (err) {
    log(`error: ${err.message}`);
  }

  process.exit(0);
});
