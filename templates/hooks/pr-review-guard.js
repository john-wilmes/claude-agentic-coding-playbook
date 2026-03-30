// PreToolUse hook: blocks `gh pr merge` until CodeRabbit has reviewed the PR.
// Enforces the rule: "Do not merge without a review."
// Graceful degradation: allows merge if `gh` is unavailable or API call fails.

const { execFileSync } = require("child_process");

let log;
try { log = require("./log"); } catch { log = { writeLog() {} }; }

// ─── Command detection ──────────────────────────────────────────────────────

const GH_PR_MERGE_RE = /(?:^|\s|&&|\|\||;)gh\s+pr\s+merge(?:\s|$)/;

/**
 * Return true if the command contains `gh pr merge`.
 * Does NOT match `gh pr create`, `gh pr view`, etc.
 */
function isMergeCommand(cmd) {
  if (!cmd || typeof cmd !== "string") return false;
  return GH_PR_MERGE_RE.test(cmd);
}

// ─── PR number extraction ───────────────────────────────────────────────────

const PR_NUMBER_RE = /gh\s+pr\s+merge\s+(?:https?:\/\/\S+\/pull\/)?(\d+)/;

/**
 * Extract PR number from a `gh pr merge` command.
 * Handles: `gh pr merge 42`, `gh pr merge https://github.com/.../pull/42`
 * Returns null for bare `gh pr merge` (current branch).
 */
function extractPrNumber(cmd) {
  if (!cmd) return null;
  const m = cmd.match(PR_NUMBER_RE);
  return m ? m[1] : null;
}

// ─── Review check ───────────────────────────────────────────────────────────

/**
 * Check if CodeRabbit has reviewed the given PR.
 * @param {string|null} prNumber - PR number or null (uses current branch)
 * @returns {{ reviewed: boolean, error: boolean, reason: string }}
 */
function checkCodeRabbitReview(prNumber) {
  const prArg = prNumber || "";

  // Check reviews (formal review submissions)
  let reviewOutput = "";
  try {
    const reviewArgs = ["pr", "view"];
    if (prArg) reviewArgs.push(prArg);
    reviewArgs.push("--json", "reviews", "--jq", ".reviews[].author.login");
    reviewOutput = execFileSync("gh", reviewArgs,
      { encoding: "utf8", timeout: 15000, stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
  } catch {
    return { reviewed: false, error: true, reason: "gh API call failed (allowing merge)" };
  }

  const isCR = (l) => ["coderabbitai", "coderabbitai[bot]"].includes(l.trim());
  if (reviewOutput.split("\n").some(isCR)) {
    return { reviewed: true, error: false, reason: "CodeRabbit review found" };
  }

  // Check comments as fallback (CodeRabbit sometimes posts comments, not formal reviews)
  let commentOutput = "";
  try {
    const commentArgs = ["pr", "view"];
    if (prArg) commentArgs.push(prArg);
    commentArgs.push("--json", "comments", "--jq", ".comments[].author.login");
    commentOutput = execFileSync("gh", commentArgs,
      { encoding: "utf8", timeout: 15000, stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
  } catch {
    return { reviewed: false, error: true, reason: "gh API call failed on comments check (allowing merge)" };
  }

  if (commentOutput.split("\n").some(isCR)) {
    return { reviewed: true, error: false, reason: "CodeRabbit comment found" };
  }

  return {
    reviewed: false,
    error: false,
    reason: "CodeRabbit has not reviewed this PR yet. Wait 2-3 minutes and try again. Rule: Do not merge without a review.",
  };
}

// ─── stdin handler ──────────────────────────────────────────────────────────

let input = "";
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    const hookInput = JSON.parse(input);
    const toolName = hookInput.tool_name || "";

    // Only intercept Bash tool calls
    if (toolName !== "Bash") {
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    const command = (hookInput.tool_input || {}).command || "";

    if (!isMergeCommand(command)) {
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    // Skip check in subagent context (subagents don't merge PRs meaningfully)
    if (hookInput.agent_id) {
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    const prNumber = extractPrNumber(command);
    const result = checkCodeRabbitReview(prNumber);

    if (result.error) {
      // Graceful degradation: allow on API failure
      log.writeLog({
        hook: "pr-review-guard",
        event: "allow",
        session_id: hookInput.session_id,
        tool_use_id: hookInput.tool_use_id,
        details: result.reason,
        project: hookInput.cwd,
        context: { command: log.promptHead(command, 100) },
      });
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    if (!result.reviewed) {
      log.writeLog({
        hook: "pr-review-guard",
        event: "block",
        session_id: hookInput.session_id,
        tool_use_id: hookInput.tool_use_id,
        details: result.reason,
        project: hookInput.cwd,
        context: { command: log.promptHead(command, 100) },
      });
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: result.reason,
        },
      }));
      process.exit(0);
    }

    // CodeRabbit has reviewed — allow
    log.writeLog({
      hook: "pr-review-guard",
      event: "allow",
      session_id: hookInput.session_id,
      tool_use_id: hookInput.tool_use_id,
      details: result.reason,
      project: hookInput.cwd,
      context: { command: log.promptHead(command, 100) },
    });
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  } catch {
    // Never block tool execution on errors
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }
});

// Export for testing
if (typeof module !== "undefined") {
  module.exports = { isMergeCommand, extractPrNumber, checkCodeRabbitReview };
}
