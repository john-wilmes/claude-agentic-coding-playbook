// TaskCompleted hook: quality gate that rejects task completion if tests fail.
//
// Only applies to teammate agents (hookInput.agent_id must be present).
// Reads CLAUDE.md from cwd, extracts test command, runs it with a 30s timeout.
// If tests fail, exits 0 with feedback JSON (hookSpecificOutput.additionalContext)
// to block the completion.
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
 * Validate that a test command does not contain known dangerous patterns.
 *
 * Defense-in-depth: CLAUDE.md is project configuration equivalent to
 * Makefile/package.json scripts — it is reviewed as part of the codebase and
 * inherently trusted by the user who checked it out. Shell interpretation of
 * the command is intentional (commands like `for t in tests/*.js; do …` require
 * it). This function rejects a narrow set of unambiguously malicious patterns
 * (network exfiltration, disk destruction, encoded payloads) without preventing
 * legitimate test commands.
 *
 * @param {string} cmd
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateTestCommand(cmd) {
  if (!cmd || typeof cmd !== "string") {
    return { valid: false, reason: "empty command" };
  }

  const dangerous = [
    // Network exfiltration via common tools
    { pattern: /\b(curl|wget|nc|ncat)\b.*[|>]/, label: "network exfiltration" },
    // Disk destruction
    { pattern: /\brm\s+-rf\s+\//, label: "destructive rm -rf /" },
    // Encoded payload execution
    { pattern: /\beval\b/, label: "eval execution" },
    { pattern: /\bbase64\s+-d\b/, label: "base64 decode execution" },
    // Arbitrary code execution via interpreter inline flags
    { pattern: /\bpython3?\s+-c\b/, label: "python -c arbitrary code execution" },
    { pattern: /\bnode\s+-e\b/, label: "node -e arbitrary code execution" },
    { pattern: /\bruby\s+-e\b/, label: "ruby -e arbitrary code execution" },
    { pattern: /\bperl\s+-e\b/, label: "perl -e arbitrary code execution" },
  ];

  for (const { pattern, label } of dangerous) {
    if (pattern.test(cmd)) {
      return { valid: false, reason: `dangerous pattern detected: ${label}` };
    }
  }

  return { valid: true };
}

/**
 * Validate that a directory path is safe to use as cwd for test execution.
 * Prevents path traversal and ensures the path is a real directory.
 * @param {string} dir
 * @returns {string|null} Resolved absolute path, or null if invalid.
 */
function validateCwd(dir) {
  if (!dir || typeof dir !== "string") return null;
  const resolved = path.resolve(dir);
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) return null;
  } catch {
    return null;
  }
  return resolved;
}

/**
 * Run the test command and return { passed, output }.
 *
 * Trust model: The test command is extracted from the project's CLAUDE.md,
 * which is project configuration equivalent to a Makefile or package.json
 * script — it is authored by the repo owner and reviewed by the user as part
 * of the codebase. Shell interpretation is intentional. validateTestCommand()
 * provides defense-in-depth against a narrow set of obviously malicious
 * patterns before this call.
 *
 * @param {string} testCommand
 * @param {string} cwd
 * @returns {{ passed: boolean, output: string }}
 */
function runTests(testCommand, cwd) {
  try {
    // CLAUDE.md is project config (equivalent to Makefile/package.json scripts)
    // reviewed as part of the codebase — shell: true is intentional here.
    execSync(testCommand, {
      cwd,
      timeout: TEST_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
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

    const cwd = validateCwd(hookInput.cwd || process.cwd());
    if (!cwd) {
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

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

    const validation = validateTestCommand(testCommand);
    if (!validation.valid) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          additionalContext: `Test command rejected: ${validation.reason}`,
        },
      }));
      process.exit(0);
    }

    const { passed, output } = runTests(testCommand, cwd);

    if (!passed) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          additionalContext: `Tests failed. Fix before completing:\n${output}`,
        },
      }));
      process.exit(0);
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
