// SessionStart hook: auto-registers with agent-comm and injects recent messages into context.
// Also injects Lessons Learned from memory and relevant knowledge entries.
// No agent decision needed -- this runs automatically on every session start.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { execSync } = require("child_process");

const STATE_DIR = path.join(os.homedir(), ".claude", "agent-comm");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const LOG_FILE = path.join(STATE_DIR, "agent-comm.log");

function log(msg) {
  try {
    const line = `[${new Date().toISOString()}] session-start: ${msg}\n`;
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line);
  } catch {}
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { agents: {}, messages: [], tasks: [] };
  }
}

function writeState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = path.join(os.tmpdir(), `agent-comm-${crypto.randomUUID()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

// Detect project context from working directory
function detectProjectContext(cwd) {
  const context = { tools: new Set(), tags: new Set() };
  try {
    // Check for package.json (node/npm)
    if (fs.existsSync(path.join(cwd, "package.json"))) {
      context.tools.add("npm").add("node");
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
        const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (allDeps.typescript) context.tools.add("typescript");
        if (allDeps.vitest || allDeps.jest) context.tools.add("vitest");
        if (allDeps.next) context.tools.add("nextjs");
        if (allDeps["aws-amplify"] || allDeps["@aws-amplify/backend"]) context.tools.add("amplify");
        if (allDeps.react) context.tags.add("react");
        if (allDeps.docker || allDeps.dockerode) context.tools.add("docker");
      } catch {}
    }
    // Check for common config files
    if (fs.existsSync(path.join(cwd, "Dockerfile"))) context.tools.add("docker");
    if (fs.existsSync(path.join(cwd, ".github"))) context.tools.add("git").add("github");
    if (fs.existsSync(path.join(cwd, ".git"))) context.tools.add("git");
    if (fs.existsSync(path.join(cwd, "amplify"))) context.tools.add("amplify");
    if (fs.existsSync(path.join(cwd, "pyproject.toml")) || fs.existsSync(path.join(cwd, "requirements.txt"))) {
      context.tools.add("python");
    }
  } catch {}
  return { tools: [...context.tools], tags: [...context.tags] };
}

// Parse YAML frontmatter from an entry file
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fm = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.+)/);
    if (kv) {
      let val = kv[2].trim();
      // Parse arrays: ["a", "b"] or [a, b]
      if (val.startsWith("[") && val.endsWith("]")) {
        val = val.slice(1, -1).split(",").map(s => s.trim().replace(/^["']|["']$/g, ""));
      }
      // Strip quotes
      if (typeof val === "string") val = val.replace(/^["']|["']$/g, "");
      fm[kv[1]] = val;
    }
  }
  return fm;
}

// Score a knowledge entry for relevance to the current project
function scoreEntry(frontmatter, projectContext) {
  let score = 0;
  const tool = (frontmatter.tool || "").toLowerCase();
  const tags = Array.isArray(frontmatter.tags) ? frontmatter.tags.map(t => t.toLowerCase()) : [];
  const category = (frontmatter.category || "").toLowerCase();

  // Tool match is strongest signal
  if (projectContext.tools.some(t => t.toLowerCase() === tool)) score += 10;
  // Tag overlap
  for (const tag of tags) {
    if (projectContext.tools.some(t => t.toLowerCase() === tag)) score += 3;
    if (projectContext.tags.some(t => t.toLowerCase() === tag)) score += 3;
  }
  // Security and gotcha entries get a baseline boost (broadly useful)
  if (category === "security") score += 2;
  if (category === "gotcha") score += 1;
  // High confidence entries preferred
  if ((frontmatter.confidence || "").toLowerCase() === "high") score += 1;

  return score;
}

// Read and score knowledge entries, return top N
function getRelevantKnowledge(cwd, maxEntries = 5) {
  const knowledgeDir = path.join(os.homedir(), ".claude", "knowledge", "entries");
  try {
    if (!fs.existsSync(knowledgeDir)) return [];
  } catch { return []; }

  const projectContext = detectProjectContext(cwd);
  if (projectContext.tools.length === 0 && projectContext.tags.length === 0) {
    // No context detected — skip injection rather than inject randomly
    return [];
  }

  const entries = [];
  try {
    const dirs = fs.readdirSync(knowledgeDir);
    for (const dir of dirs) {
      const entryPath = path.join(knowledgeDir, dir, "entry.md");
      try {
        const content = fs.readFileSync(entryPath, "utf8");
        const fm = parseFrontmatter(content);
        if (!fm) continue;
        const score = scoreEntry(fm, projectContext);
        if (score > 0) {
          // Extract one-line summary from Context section
          const ctxMatch = content.match(/## Context\n\n?([\s\S]*?)(?=\n## |\n$|$)/);
          const fixMatch = content.match(/## Fix\n\n?([\s\S]*?)(?=\n## |\n$|$)/);
          const summary = ctxMatch ? ctxMatch[1].trim().split("\n")[0] : fm.id || dir;
          const fix = fixMatch ? fixMatch[1].trim().split("\n")[0] : "";
          entries.push({ fm, score, summary, fix });
        }
      } catch {}
    }
  } catch {}

  // Sort by score descending, take top N
  entries.sort((a, b) => b.score - a.score);
  return entries.slice(0, maxEntries);
}

// Read hook input from stdin
let input = "";
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    const hookInput = JSON.parse(input);
    const sessionId = hookInput.session_id || "";
    const cwd = hookInput.cwd || process.cwd();

    // Derive agent name from working directory
    const agentName = path.basename(cwd) || "unknown";

    const state = readState();
    const now = new Date().toISOString();

    // Auto-register
    const existing = state.agents[agentName];
    state.agents[agentName] = {
      name: agentName,
      role: existing?.role || "auto",
      workingOn: `session ${sessionId.slice(0, 8)}`,
      workingDirectory: cwd,
      lastSeen: now,
      registeredAt: existing?.registeredAt || now,
    };

    // Get recent messages (last 2 hours, max 15)
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    const recent = state.messages
      .filter((m) => new Date(m.timestamp).getTime() > cutoff)
      .slice(-15);

    // Get active agents (seen in last 30 minutes, excluding self)
    const activeCutoff = Date.now() - 30 * 60 * 1000;
    const activeAgents = Object.values(state.agents).filter(
      (a) =>
        a.name !== agentName &&
        new Date(a.lastSeen).getTime() > activeCutoff
    );

    writeState(state);
    log(`registered ${agentName} (session ${sessionId.slice(0, 8)})`);

    // Pull latest knowledge entries if knowledge repo exists
    try {
      const knowledgeDir = path.join(os.homedir(), ".claude", "knowledge");
      if (fs.existsSync(path.join(knowledgeDir, ".git"))) {
        execSync("git pull --rebase --quiet", {
          cwd: knowledgeDir,
          timeout: 5000,
          stdio: "pipe",
        });
        log("knowledge repo: pulled latest");
      }
    } catch (pullErr) {
      log(`knowledge repo pull skipped: ${pullErr.message}`);
    }

    // Read Current Work and Lessons Learned from memory file
    let currentWork = "";
    let lessonsLearned = "";
    let memorySizeWarning = "";
    try {
      const cwdEncoded = cwd.replace(/:/g, "-").replace(/[\\/]/g, "-").replace(/^-/, "");
      const memoryPath = path.join(os.homedir(), ".claude", "projects", cwdEncoded, "memory", "MEMORY.md");
      const memoryContent = fs.readFileSync(memoryPath, "utf8");
      const cwMatch = memoryContent.match(/## Current Work\n([\s\S]*?)(?=\n## |\n$|$)/);
      if (cwMatch) {
        currentWork = cwMatch[1].trim();
      }
      const llMatch = memoryContent.match(/## Lessons Learned\n([\s\S]*?)(?=\n## |\n$|$)/);
      if (llMatch) {
        lessonsLearned = llMatch[1].trim();
      }
      // Check MEMORY.md size — warn before silent truncation
      const memLineCount = memoryContent.split("\n").length;
      if (memLineCount > 120) {
        memorySizeWarning = `\u26a0 MEMORY.md is ${memLineCount} lines (limit: 150, truncation: 200). Run /checkpoint to split topic files.`;
      }
    } catch {
      // No memory file for this project -- that's fine
    }

    // Check combined CLAUDE.md size
    let claudeSizeWarning = "";
    try {
      let totalClaudeLines = 0;
      const globalClaudePath = path.join(os.homedir(), ".claude", "CLAUDE.md");
      if (fs.existsSync(globalClaudePath)) {
        totalClaudeLines += fs.readFileSync(globalClaudePath, "utf8").split("\n").length;
      }
      const projectClaudePath = path.join(cwd, "CLAUDE.md");
      if (fs.existsSync(projectClaudePath)) {
        totalClaudeLines += fs.readFileSync(projectClaudePath, "utf8").split("\n").length;
      }
      if (totalClaudeLines > 700) {
        claudeSizeWarning = `\u26a0 Combined CLAUDE.md is ${totalClaudeLines} lines. Consider moving stable sections to .claude/rules/ files.`;
      }
    } catch {}

    // Build context string
    const parts = [`Registered as "${agentName}" with agent-comm.`];

    if (activeAgents.length > 0) {
      const agentLines = activeAgents.map(
        (a) => `  ${a.name} (${a.role}) -- ${a.workingOn}`
      );
      parts.push(`Active agents:\n${agentLines.join("\n")}`);
    }

    if (recent.length > 0) {
      const msgLines = recent.map((m) => {
        const target = m.to ? ` -> ${m.to}` : "";
        const time = m.timestamp.slice(11, 19);
        return `  [${time}] ${m.from}${target}: ${m.content}`;
      });
      parts.push(`Recent cross-session messages:\n${msgLines.join("\n")}`);
    }

    if (currentWork) {
      parts.push(`Current Work (from last session):\n${currentWork}`);
    }

    if (lessonsLearned) {
      parts.push(`Lessons Learned (from memory):\n${lessonsLearned}`);
    }

    if (memorySizeWarning) {
      parts.push(memorySizeWarning);
    }
    if (claudeSizeWarning) {
      parts.push(claudeSizeWarning);
    }

    // Inject relevant knowledge entries
    const relevantEntries = getRelevantKnowledge(cwd);
    if (relevantEntries.length > 0) {
      const entryLines = relevantEntries.map((e) => {
        const line = `  **[${e.fm.category}] ${e.fm.tool}:** ${e.summary}`;
        return e.fix ? `${line}\n    Fix: ${e.fix}` : line;
      });
      parts.push(`Relevant knowledge entries:\n${entryLines.join("\n")}`);
      log(`injected ${relevantEntries.length} knowledge entries`);
    }

    const context = parts.join("\n\n");

    // Output JSON that Claude Code injects into agent context
    const output = {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: context,
      },
    };

    process.stdout.write(JSON.stringify(output));
    process.exit(0);
  } catch (err) {
    log(`error: ${err.message}`);
    // Don't block session start on errors
    process.exit(0);
  }
});
