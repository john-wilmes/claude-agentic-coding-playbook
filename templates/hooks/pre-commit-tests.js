// PreToolUse hook: blocks `git commit` when tests are known-failing.
// Reads shared state from ~/.claude/.verify-last-run written by post-tool-verify.js.
// If lastPassed === false and the state is less than 5 minutes old, the commit is denied.

const fs = require("fs");
const path = require("path");
const os = require("os");

function respond(payload = {}) {
  process.stdout.write(JSON.stringify(payload), () => process.exit(0));
}

const STATE_FILE = path.join(os.homedir(), ".claude", ".verify-last-run");
const STALE_MS = 5 * 60 * 1000; // 5 minutes
const SNIPPET_LINES = 15;

/**
 * Return true if the Bash command is a git commit invocation.
 * Matches: git commit, git -C <dir> commit, git commit -m, etc.
 * Does NOT match: git commit --amend (already blocked by prompt-injection-guard).
 */
function isGitCommit(cmd) {
  if (!cmd || typeof cmd !== "string") return false;
  // Must contain "git" and "commit" as tokens in that order
  return /\bgit\b/.test(cmd) && /\bcommit\b/.test(cmd);
}

/**
 * Read and return the last-run state for the given cwd from STATE_FILE.
 * Returns null if the file is missing, unreadable, or has no entry for cwd.
 * @param {string} cwd
 * @returns {{ ts: number, lastPassed: boolean, lastFailOutput: string } | null}
 */
function getLastState(cwd) {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const all = JSON.parse(raw);
    const entry = all[cwd];
    if (!entry || typeof entry.ts !== "number" || typeof entry.lastPassed !== "boolean") {
      return null;
    }
    return entry;
  } catch {
    return null;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

let input = "";
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    const hookInput = JSON.parse(input);

    // Skip subagent sessions — they run in a managed context
    if (hookInput.agent_id) {
      return respond();
    }

    // Only intercept Bash tool
    if (hookInput.tool_name !== "Bash") {
      return respond();
    }

    const cmd = (hookInput.tool_input && hookInput.tool_input.command) || "";

    // Only intercept git commit commands
    if (!isGitCommit(cmd)) {
      return respond();
    }

    const cwd = hookInput.cwd || process.cwd();
    const state = getLastState(cwd);

    // No state → allow (tests have never been run, or state file was cleared)
    if (!state) {
      return respond();
    }

    const ageMs = Date.now() - state.ts;

    // Stale state → allow
    if (ageMs >= STALE_MS) {
      return respond();
    }

    // Tests passed → allow
    if (state.lastPassed !== false) {
      return respond();
    }

    // Tests are known-failing and state is fresh → deny
    const snippet = (state.lastFailOutput || "")
      .split("\n")
      .slice(0, SNIPPET_LINES)
      .join("\n");

    const reason =
      `Tests are known-failing — fix them before committing.\n\n` +
      `Last failure output (first ${SNIPPET_LINES} lines):\n` +
      `\`\`\`\n${snippet}\n\`\`\`\n\n` +
      `Run your test command to verify they pass, then retry the commit.`;

    return respond({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    });
  } catch {
    // On any unexpected error, allow — never crash a commit
    return respond();
  }
});

// Export helpers for unit testing
if (typeof module !== "undefined") {
  module.exports = { isGitCommit, getLastState };
}
