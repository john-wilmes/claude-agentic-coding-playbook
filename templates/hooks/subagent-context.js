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

function respond(payload = {}) {
  process.stdout.write(JSON.stringify(payload), () => process.exit(0));
}

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

// ─── Tool guidance based on prompt content ──────────────────────────────────

const MMA_HINT = `Tool: mcp__mma__* (Multi-Model Analyzer) is available for structural code analysis.
Use mma instead of grep+read when you need: callers/callees of a function, blast radius of a change, cross-repo dependencies, or architecture overview.
Key tools: get_callers, get_callees, get_blast_radius, get_cross_repo_impact, get_architecture, search.`;

const GH_HINT = `Tool: gh (GitHub CLI) is available for git history and PR context.
Use gh instead of git log when you need: PR details, review comments, CI status, issue context, or who changed what.
Key commands: gh pr view, gh pr list, gh pr checks, gh issue view, gh api repos/.../pulls/.../comments.`;

// Patterns that suggest the agent would benefit from mma.
// Written to match how a parent agent phrases tasks, not mma API names.
const MMA_SIGNALS = /\b(where is .{1,40} (used|called|imported|referenced)|what (uses|calls|imports|references|depends on)|how .{1,30} (get|got) called|what (breaks|would break|could break)|safe to (change|rename|remove|delete)|who (uses|consumes|calls)|used by|called from|depende?n|upstream|downstream|call.?(graph|chain|tree|path)|code.?path|trace .{0,20} (through|from|to|back)|find .{0,30} (usage|reference|consumer|import)|all (usages?|references?|consumers?)|integrator.?service.?(client)?)\b/i;

// Patterns that suggest the agent would benefit from gh.
const GH_SIGNALS = /\b(pull.?request|PR [#\d]|who (changed|modified|added|wrote|introduced|touched)|when (was|did) .{1,30} (changed|added|introduced|merged)|git (history|log|blame)|recent (changes?|commits?)|commit (that|which|where)|review comment|CI (status|pass|fail|green|red)|merge[d ]|changelog|last (changed|modified)|what changed)\b/i;

/**
 * Detect which tool hints to inject based on prompt content.
 * @param {string} prompt
 * @returns {string[]}
 */
function detectToolHints(prompt) {
  const hints = [];
  if (MMA_SIGNALS.test(prompt)) hints.push(MMA_HINT);
  if (GH_SIGNALS.test(prompt)) hints.push(GH_HINT);
  return hints;
}

/**
 * Build the additionalContext string to inject into the subagent.
 * Returns null if there is nothing to inject.
 * @param {{ isLoopSession: boolean, testCommand: string|null, prompt: string }} opts
 * @returns {string|null}
 */
function buildAdditionalContext({ isLoopSession, testCommand, prompt }) {
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

  if (prompt) {
    const toolHints = detectToolHints(prompt);
    if (toolHints.length > 0) {
      parts.push(toolHints.join("\n\n"));
    }
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
      return respond();
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

    const prompt = hookInput.prompt || hookInput.tool_input?.prompt || "";
    const additionalContext = buildAdditionalContext({ isLoopSession, testCommand, prompt });

    if (!additionalContext) {
      return respond();
    }

    return respond({
      hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext },
    });
  } catch {
    // Never block agent spawn on hook errors.
    return respond();
  }
});

// Export pure functions for testability.
if (typeof module !== "undefined") {
  module.exports = {
    extractQualityGatesSection, extractTestCommand, buildAdditionalContext,
    detectToolHints, MMA_SIGNALS, GH_SIGNALS, MMA_HINT, GH_HINT,
  };
}
