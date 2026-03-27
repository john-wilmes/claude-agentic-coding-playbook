// PreToolUse hook: blocks Bash commands that use CLI file-reading tools (cat, head, tail,
// sed, grep, find, ls) when dedicated Claude Code tools exist (Read, Grep, Glob).
// Philosophy: prefer false negatives over false positives — only block clear direct-operand
// usage, not piped/stdin usage.

/**
 * Detection rules.
 * Each entry has:
 *   - test(cmd): returns null (pass) or a block reason string
 *
 * Key heuristic: does the command have a file/path argument as a direct operand
 * (not coming via a pipe)? We detect this by checking whether the suspicious
 * invocation appears BEFORE any pipe symbol in the command.
 */

/**
 * Return the portion of the command before the first unquoted pipe character.
 * This is intentionally approximate (no full shell parse) — good enough for
 * the false-positive-avoidance goal.
 */
function beforePipe(cmd) {
  // Walk characters; skip pipe chars inside single or double quotes
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (!inSingle && !inDouble && ch === "|") return cmd.slice(0, i);
  }
  return cmd;
}

const RULES = [
  // cat <file> — only block when cat has a non-empty file argument (not pure stdin relay)
  // Pass: echo "..." | cat, cat (no args)
  // Block: cat /path/to/file, cat ./file.txt, cat file.txt
  {
    test(cmd) {
      const seg = beforePipe(cmd);
      // cat must appear as a command (start of segment, or after &&/;/||)
      // followed by optional flags then a non-empty path argument
      if (!/(?:^|[;&(]\s*|\|\|\s*|&&\s*)cat\s/.test(seg)) return null;
      // Require at least one non-flag token after cat
      const m = seg.match(/(?:^|[;&(]\s*|\|\|\s*|&&\s*)cat\s+((?:-\S+\s+)*)(\S+)/);
      if (!m) return null;
      const fileArg = m[2];
      // Allow heredoc redirection: cat <<'EOF', cat <<EOF, cat << EOF
      if (/^</.test(fileArg)) return null;
      return `\`cat ${fileArg}\` reads a file — use the Read tool instead`;
    },
  },

  // head <file> / head -n N <file>
  // Pass: ... | head -n 5
  // Block: head file.txt, head -n 20 ./src/index.ts
  {
    test(cmd) {
      const seg = beforePipe(cmd);
      if (!/(?:^|[;&(]\s*|\|\|\s*|&&\s*)head\s/.test(seg)) return null;
      // head with only flags and no non-flag argument — piped usage, allow
      const m = seg.match(/(?:^|[;&(]\s*|\|\|\s*|&&\s*)head\s+((?:-\S+\s+(?:\d+\s+)?)*)(\S+)/);
      if (!m) return null;
      const fileArg = m[2];
      // If the last token is a plain integer, it's a flag value not a file
      if (/^\d+$/.test(fileArg)) return null;
      return `\`head ${fileArg}\` reads a file — use the Read tool with the \`limit\` parameter instead`;
    },
  },

  // tail <file> / tail -n N <file>
  // Pass: ... | tail -n 5
  // Block: tail file.txt, tail -n 20 ./src/index.ts
  {
    test(cmd) {
      const seg = beforePipe(cmd);
      if (!/(?:^|[;&(]\s*|\|\|\s*|&&\s*)tail\s/.test(seg)) return null;
      const m = seg.match(/(?:^|[;&(]\s*|\|\|\s*|&&\s*)tail\s+((?:-\S+\s+(?:\d+\s+)?)*)(\S+)/);
      if (!m) return null;
      const fileArg = m[2];
      if (/^\d+$/.test(fileArg)) return null;
      return `\`tail ${fileArg}\` reads a file — use the Read tool with \`limit\` and \`offset\` parameters instead`;
    },
  },

  // grep pattern <file> / grep -r pattern <dir> / grep -flags pattern <file>
  // rg pattern <file>
  // Pass: ... | grep pattern (stdin), git diff | grep foo
  // Block: grep foo file.txt, grep -r "pattern" ./src, rg "foo" src/
  {
    test(cmd) {
      const seg = beforePipe(cmd);
      // grep or rg as a command (not preceded by a pipe in this segment)
      if (!/(?:^|[;&(]\s*|\|\|\s*|&&\s*)(?:grep|rg)\s/.test(seg)) return null;
      // Extract the grep/rg invocation: tool flags* pattern [file]
      const m = seg.match(/(?:^|[;&(]\s*|\|\|\s*|&&\s*)(grep|rg)\s+((?:-\S+\s+)*)(\S+)(\s+(\S+))?/);
      if (!m) return null;
      const tool = m[1];
      const flags = m[2] || "";
      const secondArg = m[5]; // file/dir argument after the pattern

      // If there's a second non-flag argument, that's the file/dir operand — block
      if (secondArg) {
        return `\`${tool} ... ${secondArg}\` searches a file — use the Grep tool instead`;
      }

      // With -r/-R (recursive dir search) and single non-flag arg: block
      if (/(?:^|\s)-[a-zA-Z]*[rR]/.test(flags)) {
        const patternArg = m[3];
        return `\`${tool} -r ... ${patternArg}\` searches a directory — use the Grep tool instead`;
      }

      return null;
    },
  },

  // sed 's/.../.../' <file> or sed -n '...' <file>
  // Pass: ... | sed 's/a/b/' (stdin transformer in pipeline)
  // Block: sed 's/foo/bar/' file.txt (file as last arg)
  {
    test(cmd) {
      const seg = beforePipe(cmd);
      if (!/(?:^|[;&(]\s*|\|\|\s*|&&\s*)sed\s/.test(seg)) return null;
      // sed with a file operand: [flags] script file
      // Require at least 3 tokens: sed, script, file
      const m = seg.match(/(?:^|[;&(]\s*|\|\|\s*|&&\s*)sed\s+((?:-\S+\s+)*)((?:'[^']*'|"[^"]*"|\S+)\s+)(\S+)/);
      if (!m) return null;
      const fileArg = m[3];
      // If last token looks like a sed script (starts with s/, /pattern/, address, etc.) — allow
      if (/^['"]?(?:s\/|\/|[0-9]|[$]|p$|d$|q$)/.test(fileArg)) return null;
      return `\`sed ... ${fileArg}\` reads a file — use the Read and Edit tools instead`;
    },
  },

  // find <dir> -name ...
  // Pass: find . -name (current dir), find -name (no dir)
  // Block: find /absolute/path -name, find ./subdir -name, find src/ -name
  {
    test(cmd) {
      const seg = beforePipe(cmd);
      if (!/(?:^|[;&(]\s*|\|\|\s*|&&\s*)find\s/.test(seg)) return null;
      const m = seg.match(/(?:^|[;&(]\s*|\|\|\s*|&&\s*)find\s+(\S+)/);
      if (!m) return null;
      const dirArg = m[1];
      // Allow: bare `.` (current dir), starts with `-` (flag)
      if (dirArg === "." || dirArg.startsWith("-")) return null;
      return `\`find ${dirArg} ...\` searches for files — use the Glob tool instead`;
    },
  },

  // ls <path>
  // Pass: ls, ls -la, ls -l (no path arg — listing cwd is fine)
  // Block: ls /some/path, ls ./subdir, ls src/
  {
    test(cmd) {
      const seg = beforePipe(cmd);
      if (!/(?:^|[;&(]\s*|\|\|\s*|&&\s*)ls(?:\s|$)/.test(seg)) return null;
      // Extract first non-flag argument after ls
      const m = seg.match(/(?:^|[;&(]\s*|\|\|\s*|&&\s*)ls\s+((?:-\S+\s+)*)(\S+)/);
      if (!m) return null;
      const pathArg = m[2];
      // If it starts with `-`, it's another flag — allow
      if (pathArg.startsWith("-")) return null;
      return `\`ls ${pathArg}\` lists a directory — use the Glob tool instead`;
    },
  },
];

let log;
try { log = require("./log"); } catch { log = { writeLog() {} }; }

/**
 * Check a command against all dedicated-tool rules.
 * Returns a reason string if the command should be blocked, null otherwise.
 */
function checkCommand(cmd) {
  if (!cmd || typeof cmd !== "string") return null;
  for (const rule of RULES) {
    const reason = rule.test(cmd);
    if (reason) return reason;
  }
  return null;
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
    const reason = checkCommand(command);

    if (reason) {
      log.writeLog({
        hook: "dedicated-tool-guard",
        event: "block",
        session_id: hookInput.session_id,
        tool_use_id: hookInput.tool_use_id,
        details: reason,
        project: hookInput.cwd,
        context: { command: log.promptHead ? log.promptHead(command, 100) : command.slice(0, 100) },
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
  module.exports = { checkCommand, RULES };
}
