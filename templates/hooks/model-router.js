// PreToolUse hook: auto-selects model for Task tool calls missing an explicit model.
// Classifies task prompts by keyword signals and injects the cheapest sufficient model.
// Cost ratios: 1x (haiku) : 3x (sonnet) : 5x (opus).

const HAIKU_AGENT_TYPES = new Set(["Explore", "claude-code-guide"]);

const READ_SIGNALS = [
  "search", "find", "read", "list", "grep", "explore", "scan", "check",
  "look", "locate", "browse", "inspect", "review", "examine",
];

const WRITE_SIGNALS = [
  "implement", "write", "create", "build", "refactor", "fix", "add",
  "update", "edit", "modify", "change", "replace", "remove", "delete",
  "test", "migrate",
];

const ARCH_SIGNALS = [
  "architect", "design", "debug", "plan", "coordinate", "cross-file",
  "root cause", "strategy", "complex", "multi-file", "architectural",
  "investigate", "diagnose",
];

let log;
try { log = require("./log"); } catch { log = { writeLog() {}, promptHead(t) { return t; } }; }

function classifyTask(input) {
  const agentType = (input.subagent_type || "").trim();
  if (HAIKU_AGENT_TYPES.has(agentType)) {
    return { model: "haiku", reason: `${agentType} agent type` };
  }

  const prompt = (input.prompt || "").toLowerCase();
  if (!prompt) {
    return { model: "sonnet", reason: "no prompt (safe default)" };
  }

  // Use word-boundary matching to avoid substring false positives
  // (e.g. "fixed" matching "fix", "searching" matching "search")
  function matchesAny(signals) {
    return signals.some((s) => {
      // Multi-word signals (e.g. "root cause", "cross-file") use simple includes
      // since word boundaries don't apply to phrases with spaces/hyphens
      if (/[\s-]/.test(s)) return prompt.includes(s);
      const re = new RegExp("\\b" + s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b");
      return re.test(prompt);
    });
  }

  const hasRead = matchesAny(READ_SIGNALS);
  const hasWrite = matchesAny(WRITE_SIGNALS);
  const hasArch = matchesAny(ARCH_SIGNALS);

  if (hasArch) {
    return { model: "opus", reason: "architecture/planning signals" };
  }
  if (hasWrite) {
    return { model: "sonnet", reason: "write/implementation signals" };
  }
  if (hasRead) {
    return { model: "haiku", reason: "read-only signals" };
  }

  return { model: "sonnet", reason: "no clear signals (safe default)" };
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
    const toolInput = hookInput.tool_input || {};

    // Only intercept Task tool calls
    if (toolName !== "Task") {
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    // If model is already set, respect the agent's explicit choice
    if (toolInput.model) {
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    // Classify and inject model
    const { model, reason } = classifyTask(toolInput);

    log.writeLog({
      hook: "model-router",
      event: "route",
      session_id: hookInput.session_id,
      tool_use_id: hookInput.tool_use_id,
      details: `Auto-selected ${model} (${reason})`,
      project: hookInput.cwd,
      context: { model, reason, prompt_head: log.promptHead((toolInput.prompt || ""), 80) },
    });

    const output = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: { ...toolInput, model },
        additionalContext: `Model auto-selected: ${model} (${reason}). Override with explicit model parameter.`,
      },
    };

    process.stdout.write(JSON.stringify(output));
    process.exit(0);
  } catch {
    // Never block tool execution on errors
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }
});

// Export for testing
if (typeof module !== "undefined") {
  module.exports = { classifyTask, READ_SIGNALS, WRITE_SIGNALS, ARCH_SIGNALS, HAIKU_AGENT_TYPES };
}
