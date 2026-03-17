// SubagentStart hook: injects helpful context into spawned subagents.
//
// Fires when a subagent is spawned. Returns additionalContext to help the
// subagent stay on-track without requiring manual instructions each time.
//
// Skips read-only agent types (Explore, Plan) — they don't write code and
// don't need quality gate reminders.
//
// Context injected (when applicable):
//   1. claude-loop warning — if CLAUDE_LOOP_PID is set, remind the agent
//      to summarize partial work before hitting max turns.
//   2. Quality gates — reads CLAUDE.md from cwd, extracts the "Quality
//      Gates" section (lines between the heading and the next ##), and
//      injects a reminder with the test command.
//
// Returns {} when there is nothing to inject (read-only agents, no context
// available, or any error).
//
// On any error: outputs {} and exits 0 — never blocks agent spawn.

const fs = require("fs");
const path = require("path");

// Agent types that only read/explore — no code changes, no quality gate needed.
const READ_ONLY_AGENT_TYPES = new Set(["Explore", "Plan"]);

/**
 * Extract the "Quality Gates" section from CLAUDE.md content.
 * Matches the section between "## Quality Gates" and the next "## " heading.
 * Returns the trimmed section body, or null if the section is absent.
 * @param {string} content
 * @returns {string|null}
 */
function extractQualityGatesSection(content) {
  const lines = content.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Quality Gates\s*$/i.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const body = lines.slice(start, end).join("\n").trim();
  return body.length > 0 ? body : null;
}

/**
 * Extract the test command from a Quality Gates section body.
 * Matches lines like:  - Test: `npm test`  or  test: `pytest`
 * @param {string} sectionBody
 * @returns {string|null}
 */
function extractTestCommand(sectionBody) {
  const match = sectionBody.match(/(?:Test|test):\s*`([^`]+)`/);
  return match ? match[1] : null;
}

/**
 * Build the additionalContext string to inject into the subagent.
 * Returns null if there is nothing to inject.
 * @param {{ isLoopSession: boolean, testCommand: string|null }} opts
 * @returns {string|null}
 */
function buildAdditionalContext({ isLoopSession, testCommand }) {
  const parts = [];

  if (isLoopSession) {
    parts.push(
      "Running under claude-loop. " +
      "If you hit max turns before finishing, summarize partial work " +
      "and next steps in your last message so the session can resume."
    );
  }

  if (testCommand) {
    parts.push(
      `Quality gates: \`${testCommand}\`. Run before finalizing your work.`
    );
  }

  return parts.length > 0 ? parts.join("\n\n") : null;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

let input = "";
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    const hookInput = JSON.parse(input);

    // Skip read-only agent types — no code changes, no quality gate needed.
    const agentType = hookInput.agent_type || "";
    if (READ_ONLY_AGENT_TYPES.has(agentType)) {
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    const cwd = hookInput.cwd || process.cwd();
    const isLoopSession = Boolean(process.env.CLAUDE_LOOP_PID);

    // Try to read CLAUDE.md and extract quality gates section.
    let testCommand = null;
    try {
      const claudeMdPath = path.join(cwd, "CLAUDE.md");
      const claudeMdContent = fs.readFileSync(claudeMdPath, "utf8");
      const section = extractQualityGatesSection(claudeMdContent);
      if (section) {
        testCommand = extractTestCommand(section);
      }
    } catch {
      // CLAUDE.md absent or unreadable — skip quality gate context.
    }

    const additionalContext = buildAdditionalContext({ isLoopSession, testCommand });

    if (!additionalContext) {
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { additionalContext },
    }));
    process.exit(0);
  } catch {
    // Never block agent spawn on hook errors.
    process.stdout.write("{}");
    process.exit(0);
  }
});

// Export pure functions for testability.
if (typeof module !== "undefined") {
  module.exports = { extractQualityGatesSection, extractTestCommand, buildAdditionalContext };
}
