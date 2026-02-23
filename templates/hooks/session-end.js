// SessionEnd hook: writes session-ended message to agent-comm state, deregisters,
// and auto-commits memory/config changes to the ~/.claude git repo.
// Runs automatically when a session closes -- all agents, all projects.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { execSync } = require("child_process");

const STATE_DIR = path.join(os.homedir(), ".claude", "agent-comm");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const LOG_FILE = path.join(STATE_DIR, "agent-comm.log");
const MAX_MESSAGES = 200;

function log(msg) {
  try {
    const line = `[${new Date().toISOString()}] session-end: ${msg}\n`;
    fs.appendFileSync(LOG_FILE, line);
  } catch {}
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { agents: {}, messages: [], tasks: [] };
  }
}

function writeState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  if (state.messages.length > MAX_MESSAGES) {
    state.messages = state.messages.slice(-MAX_MESSAGES);
  }
  const tmp = path.join(os.tmpdir(), `agent-comm-${crypto.randomUUID()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
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

    const state = readState();
    const now = new Date().toISOString();

    // Post a session-ended message so other agents know
    state.messages.push({
      id: crypto.randomUUID(),
      from: agentName,
      to: null,
      content: `Session ended (${sessionId.slice(0, 8)})`,
      timestamp: now,
    });

    // Remove agent registration
    delete state.agents[agentName];

    writeState(state);
    log(`deregistered ${agentName} (session ${sessionId.slice(0, 8)})`);

    // Auto-commit memory/config changes to ~/.claude git repo
    try {
      const claudeDir = path.join(os.homedir(), ".claude");
      const gitOpts = { cwd: claudeDir, timeout: 5000, stdio: "pipe" };
      execSync("git add -A", gitOpts);
      // Unstage files matching sensitive patterns
      const sensitivePatterns = [
        "*.env", "*.env.*", ".env*",
        "*credential*", "*secret*",
        "*.pem", "*.key", "*.p12", "*.pfx",
        "**/id_rsa*", "**/id_ed25519*"
      ];
      for (const pattern of sensitivePatterns) {
        try {
          execSync(`git reset HEAD -- "${pattern}"`, { ...gitOpts, stdio: "pipe" });
        } catch {
          // Pattern didn't match anything -- that's fine
        }
      }
      // Check if there are staged changes before committing
      try {
        execSync("git diff --cached --quiet", gitOpts);
        // No changes -- skip commit
        log("memory auto-commit: no changes");
      } catch {
        // diff --quiet exits non-zero when there ARE changes
        const msg = `auto: ${agentName} session ${sessionId.slice(0, 8)}`;
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
  } catch (err) {
    log(`error: ${err.message}`);
  }

  process.exit(0);
});
