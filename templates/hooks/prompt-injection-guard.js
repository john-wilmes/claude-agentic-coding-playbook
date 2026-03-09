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

function checkCommand(cmd) {
  if (!cmd) return null;
  for (const { pattern, reason } of INJECTION_PATTERNS) {
    if (pattern.test(cmd)) {
      return reason;
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
      process.stdout.write(JSON.stringify({ decision: "allow" }));
      process.exit(0);
    }

    const command = (hookInput.tool_input || {}).command || "";
    const reason = checkCommand(command);

    if (reason) {
      process.stdout.write(JSON.stringify({ decision: "block", reason }));
      process.exit(0);
    }

    process.stdout.write(JSON.stringify({ decision: "allow" }));
    process.exit(0);
  } catch {
    // Never block tool execution on errors
    process.stdout.write(JSON.stringify({ decision: "allow" }));
    process.exit(0);
  }
});

// Export for testing
if (typeof module !== "undefined") {
  module.exports = { checkCommand, INJECTION_PATTERNS };
}
