// TaskCompleted hook: quality gate that rejects task completion if tests fail.
//
// Only applies to teammate agents (hookInput.agent_id must be present).
// Reads CLAUDE.md from cwd, extracts test command, runs it with a 30s timeout.
// If tests fail, exits 2 with feedback JSON to block the completion.
// If tests pass, no CLAUDE.md, or no test command, exits 0 with {}.
//
// On any error: outputs {} and exits 0 — never blocks unexpectedly.

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const TEST_TIMEOUT_MS = 30000;
const MAX_OUTPUT_LINES = 20;

/**
 * Extract the test command from CLAUDE.md content.
 * Matches lines like:  Test: `npm test`  or  test: `pytest`
 * @param {string} claudeMdContent
 * @returns {string|null}
 */
function extractTestCommand(claudeMdContent) {
  const match = claudeMdContent.match(/(?:Test|test):\s*`([^`]+)`/);
  return match ? match[1] : null;
}

/**
 * Run the test command and return { passed, output }.
 * @param {string} testCommand
 * @param {string} cwd
 * @returns {{ passed: boolean, output: string }}
 */
function runTests(testCommand, cwd) {
  try {
    execSync(testCommand, {
      cwd,
      timeout: TEST_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { passed: true, output: "" };
  } catch (err) {
    const rawOutput = [err.stdout, err.stderr]
      .filter(Boolean)
      .map((b) => (Buffer.isBuffer(b) ? b.toString("utf8") : String(b)))
      .join("\n")
      .trimEnd();
    const lines = rawOutput.split("\n").slice(0, MAX_OUTPUT_LINES).join("\n");
    return { passed: false, output: lines };
  }
}

// Read hook input from stdin
let input = "";
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    const hookInput = JSON.parse(input);

    // Only applies to teammate agents — main agent completions are not gated
    if (!hookInput.agent_id) {
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    const cwd = hookInput.cwd || process.cwd();

    // Read CLAUDE.md and extract test command
    const claudeMdPath = path.join(cwd, "CLAUDE.md");
    let claudeMdContent = "";
    try {
      claudeMdContent = fs.readFileSync(claudeMdPath, "utf8");
    } catch {
      // No CLAUDE.md — skip gate
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    const testCommand = extractTestCommand(claudeMdContent);
    if (!testCommand) {
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    const { passed, output } = runTests(testCommand, cwd);

    if (!passed) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          additionalContext: `Tests failed. Fix before completing:\n${output}`,
        },
      }));
      process.exit(2);
    }

    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  } catch {
    // Never block task completion on hook errors
    process.stdout.write("{}");
    process.exit(0);
  }
});

// Export pure functions for testability
if (typeof module !== "undefined") {
  module.exports = { extractTestCommand, runTests };
}
