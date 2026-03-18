// PreToolUse hook: blocks high-confidence prompt injection patterns in Bash commands.
// Philosophy: zero false positives. Only blocks patterns that never appear in legitimate commands.

const INJECTION_PATTERNS = [
  { pattern: /ignore\s+(all\s+)?previous\s+instructions/i, reason: "Prompt injection: instruction override attempt" },
  { pattern: /disregard\s+(all\s+)?previous/i, reason: "Prompt injection: instruction disregard attempt" },
  { pattern: /forget\s+everything/i, reason: "Prompt injection: memory wipe attempt" },
  { pattern: /you\s+are\s+now\s+a/i, reason: "Prompt injection: role assignment attempt" },
  // Credential exfiltration via network tools (curl/wget sending secret env vars or credential files)
  { pattern: /curl\s+.*\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)\w*\}?/i, reason: "Potential credential exfiltration via curl" },
  { pattern: /wget\s+.*\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)\w*\}?/i, reason: "Potential credential exfiltration via wget" },
  // Reading sensitive credential files and piping/sending them out
  { pattern: /\b(?:cat|head|tail|less|more)\s+(?:\S*\/)?(?:~\/)?(?:\.ssh\/|\.aws\/credentials|\.gnupg\/)/, reason: "Potential credential exfiltration: reading sensitive credential file" },
  { pattern: /\b(?:cat|head|tail|less|more)\s+(?:\/etc\/shadow|\/etc\/passwd)/, reason: "Potential credential exfiltration: reading system credential file" },
  { pattern: /\b(?:cat|head|tail|less|more)\s+\S*\.env\b/, reason: "Potential credential exfiltration: reading .env file" },
  // Dumping full environment to network tools
  { pattern: /\b(?:env|printenv)\b.*\|\s*\b(?:curl|wget|nc|ncat|netcat)\b/, reason: "Potential credential exfiltration: piping environment to network tool" },
  // One-liner file reads in scripting languages used to exfiltrate
  { pattern: /python3?\s+-c\s+['"].*open\s*\(.*(?:\.env|credentials|shadow|\.ssh)/, reason: "Potential credential exfiltration via Python one-liner" },
  { pattern: /ruby\s+-e\s+['"].*File\.read.*(?:\.env|credentials|shadow|\.ssh)/, reason: "Potential credential exfiltration via Ruby one-liner" },
  { pattern: /perl\s+-e\s+['"].*(?:open|read).*(?:\.env|credentials|shadow|\.ssh)/, reason: "Potential credential exfiltration via Perl one-liner" },
  // Netcat/ncat used as exfiltration channel
  { pattern: /\b(?:nc|ncat|netcat)\b.*\d{1,5}\s*</, reason: "Potential data exfiltration via netcat" },
  { pattern: /\|\s*(?:nc|ncat|netcat)\b/, reason: "Potential data exfiltration via netcat pipe" },
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
  // rm -rf targeting root, home, /* glob, or using sudo on broad paths
  {
    test(cmd) {
      // Match rm with any combination of -r/-f flags (e.g. -rf, -fr, -r -f, --recursive)
      const hasRmRf = /\brm\b/.test(cmd) && (
        /\brm\s+(?:\S+\s+)*-[a-zA-Z]*r[a-zA-Z]*f/.test(cmd) ||
        /\brm\s+(?:\S+\s+)*-[a-zA-Z]*f[a-zA-Z]*r/.test(cmd) ||
        /\brm\s+(?:\S+\s+)*--recursive/.test(cmd) ||
        /\brm\s+(?:\S+\s+)*-r\b/.test(cmd)
      );
      if (!hasRmRf) return false;
      // Block: root (/), home (~/), /* glob, /tmp/* equivalent to root, sudo rm -rf
      return (
        /\brm\s.*\s(\/|~\/)\s*($|;|&&|\|)/.test(cmd) ||
        /\brm\s.*\s\/\*/.test(cmd) ||
        /\brm\s.*\s~\/\*/.test(cmd) ||
        /\bsudo\s+rm\b/.test(cmd)
      );
    },
    reason: "Destructive command: rm -rf on root, home, or broad glob would cause irreversible data loss",
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
        project: hookInput.cwd,
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
