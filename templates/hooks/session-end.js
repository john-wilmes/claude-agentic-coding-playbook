// SessionEnd hook: auto-commits memory changes to the ~/.claude git repo.
// Runs automatically when a session closes -- all agents, all projects.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

let capture;
try { capture = require("./knowledge-capture"); } catch { capture = null; }

let logModule;
try { logModule = require("./log"); } catch { logModule = null; }

const LOG_DIR = path.join(os.homedir(), ".claude");
const LOG_FILE = path.join(LOG_DIR, "hooks.log");

function log(msg) {
  try {
    if (logModule) {
      logModule.writeLog({ hook: "session-end", event: "info", details: msg });
    } else {
      const line = `[${new Date().toISOString()}] session-end: ${msg}\n`;
      fs.mkdirSync(LOG_DIR, { recursive: true });
      fs.appendFileSync(LOG_FILE, line);
    }
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

    let pushFailureMsg = null;

    // Auto-commit THIS session's memory file only.
    // Using "git add -A" would stage other agents' memory files when multiple
    // projects are open simultaneously, causing wrong attribution and git index
    // contention. Stage only the path owned by this session.
    try {
      const claudeDir = path.join(os.homedir(), ".claude");
      const gitOpts = { cwd: claudeDir, timeout: 5000, stdio: "pipe" };

      // Initialize ~/.claude as a git repo if it isn't one yet
      try {
        execFileSync("git", ["rev-parse", "--git-dir"], gitOpts);
      } catch {
        execFileSync("git", ["init"], gitOpts);
        log("memory auto-commit: initialized ~/.claude as git repo");
      }

      // Encode cwd to the project key Claude Code uses for memory paths
      const encodedCwd = cwd.replace(/:/g, "-").replace(/[\\/]/g, "-").replace(/^-/, "");
      const memoryPath = `projects/${encodedCwd}/memory/MEMORY.md`;

      try {
        execFileSync("git", ["add", "--", memoryPath], gitOpts);
      } catch {
        // Memory file may not exist yet -- skip
      }

      // Check if there are staged changes before committing
      try {
        execFileSync("git", ["diff", "--cached", "--quiet"], gitOpts);
        // No staged changes -- skip commit
        log("memory auto-commit: no changes");
      } catch {
        // diff --quiet exits non-zero when there ARE staged changes
        const msg = `auto: ${agentName} session ${sessionId.slice(0, 8)}`;
        execFileSync("git", ["commit", "-m", msg], gitOpts);
        log("memory auto-commit: committed");
        // Push to remote (non-blocking, best-effort)
        // Set CLAUDE_NO_AUTO_PUSH=1 to skip the push entirely.
        if (process.env.CLAUDE_NO_AUTO_PUSH === "1") {
          log("memory auto-push: skipped (CLAUDE_NO_AUTO_PUSH=1)");
        } else {
          try {
            execFileSync("git", ["push"], { ...gitOpts, timeout: 8000 });
            log("memory auto-push: pushed to remote");
          } catch (pushErr) {
            const msg = pushErr.stderr ? pushErr.stderr.toString().trim() : pushErr.message;
            log(`memory auto-push failed: ${msg}`);
            pushFailureMsg = msg;
          }
        }
      }
    } catch (commitErr) {
      log(`memory auto-commit error: ${commitErr.message}`);
    }

    // Prune old staged knowledge candidates (older than 7 days)
    if (capture) {
      try { capture.pruneStagedFiles(7); } catch {}
    }

    if (pushFailureMsg) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionEnd",
          additionalContext: `WARNING: memory auto-push failed: ${pushFailureMsg}`,
        },
      }));
    }
  } catch (err) {
    log(`error: ${err.message}`);
  }

  process.exit(0);
});
