// PreToolUse hook: blocks high-confidence prompt injection patterns in Bash commands.
// Philosophy: zero false positives. Only blocks patterns that never appear in legitimate commands.

const INJECTION_PATTERNS = [
  { pattern: /ignore\s+(all\s+)?previous\s+instructions/i, reason: "Prompt injection: instruction override attempt" },
  { pattern: /disregard\s+(all\s+)?previous/i, reason: "Prompt injection: instruction disregard attempt" },
  { pattern: /forget\s+everything/i, reason: "Prompt injection: memory wipe attempt" },
  { pattern: /you\s+are\s+now\s+a/i, reason: "Prompt injection: role assignment attempt" },
  { pattern: /curl\s+.*\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)\w*\}?/i, reason: "Potential credential exfiltration via curl" },
  { pattern: /wget\s+.*\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)\w*\}?/i, reason: "Potential credential exfiltration via wget" },
];

// Destructive command patterns — ordered from most- to least-specific so
// broader guards do not shadow narrower allow-listed variants.
const DESTRUCTIVE_PATTERNS = [
  // git clean: block unless -n (dry-run) flag is present
  {
    test(cmd) {
      return /git\s+clean\s+\S*f\S*d/.test(cmd) && !/git\s+clean\s+\S*n/.test(cmd);
    },
    reason: "Destructive command: git clean -fd will delete untracked files (use -fdn to preview)",
  },
  // git reset --hard: always block
  {
    test(cmd) { return /git\s+reset\s+--hard/.test(cmd); },
    reason: "Destructive command: git reset --hard will permanently discard local changes",
  },
  // git push --force/-f to main or master only
  {
    test(cmd) {
      return /git\s+push\s+.*(?:-f\b|--force\b)/.test(cmd) &&
             /\b(main|master)\b/.test(cmd);
    },
    reason: "Destructive command: force-push to main/master is not allowed",
  },
  // rm -rf / or rm -rf ~/ (root or home deletion only — scoped paths pass)
  {
    test(cmd) {
      return /\brm\s+.*-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+(\/|~\/)\s*$/.test(cmd) ||
             /\brm\s+.*-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+(\/|~\/)\s*;/.test(cmd) ||
             /\brm\s+.*-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+(\/|~\/)$/.test(cmd);
    },
    reason: "Destructive command: rm -rf / or rm -rf ~/ would delete the root or home directory",
  },
  // DROP TABLE / DROP DATABASE / DROP SCHEMA (SQL, case-insensitive)
  {
    test(cmd) { return /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i.test(cmd); },
    reason: "Destructive command: DROP TABLE/DATABASE/SCHEMA detected",
  },
];

let log;
try { log = require("./log"); } catch { log = { writeLog() {} }; }

function checkCommand(cmd) {
  if (!cmd) return null;
  for (const { pattern, reason } of INJECTION_PATTERNS) {
    if (pattern.test(cmd)) {
      return reason;
    }
  }
  for (const guard of DESTRUCTIVE_PATTERNS) {
    if (guard.test(cmd)) {
      return guard.reason;
    }
  }
  return null;
}

// Read hook input from stdin
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
    const reason = checkCommand(command);

    if (reason) {
      log.writeLog({
        hook: "prompt-injection-guard",
        event: "block",
        session_id: hookInput.session_id,
        tool_use_id: hookInput.tool_use_id,
        details: reason,
        context: { command: log.promptHead(command, 100) },
      });
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      }));
      process.exit(0);
    }

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
  module.exports = { checkCommand, INJECTION_PATTERNS, DESTRUCTIVE_PATTERNS };
}
