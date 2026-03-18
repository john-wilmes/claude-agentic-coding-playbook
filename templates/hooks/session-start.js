// SessionStart hook: injects memory, knowledge entries, and git context into session.
// Also checks MEMORY.md and CLAUDE.md size thresholds and warns when exceeded.
// No agent decision needed -- this runs automatically on every session start.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

let log;
try { log = require("./log"); } catch { log = { writeLog() {} }; }

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
  context.projectName = path.basename(cwd);
  return { tools: [...context.tools], tags: [...context.tags], projectName: context.projectName };
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
  // Source project penalty: entries from a different project are less relevant
  if (frontmatter.source_project && projectContext.projectName) {
    if (frontmatter.source_project.toLowerCase() !== projectContext.projectName.toLowerCase()) {
      score -= 3;
    }
  }

  return score;
}

function safeParseJson(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

// Parse simple YAML key-value pairs (one level deep, no nested objects/arrays)
function parseEnvYaml(content) {
  const result = {};
  const KEY_RE = /^([A-Z_][A-Z0-9_]*):\s*(.*)$/;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(KEY_RE);
    if (!m) continue;
    let val = m[2].trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    result[m[1]] = val;
  }
  return result;
}

// Read and score knowledge entries via SQLite DB, return top N
function getRelevantKnowledge(cwd, maxEntries = 5) {
  try {
    let knowledgeDb;
    try { knowledgeDb = require("./knowledge-db"); } catch { return []; }

    const projectContext = detectProjectContext(cwd);
    if (projectContext.tools.length === 0 && projectContext.tags.length === 0) {
      return [];
    }

    // Compute DB path at call time so withFakeHome patches take effect
    const dbPath = path.join(os.homedir(), ".claude", "knowledge", "knowledge.db");
    const db = knowledgeDb.openDb(dbPath);

    // Build query terms from project context
    const queryTerms = [...projectContext.tools, ...projectContext.tags, projectContext.projectName]
      .filter(Boolean);

    const entries = knowledgeDb.queryRelevant(db, {
      projectTool: projectContext.tools,
      sourceProject: projectContext.projectName,
      queryTerms,
      cwd,
    }, maxEntries);

    // Map DB results to the format expected by the output formatter
    return entries.map(e => ({
      fm: {
        id: e.id,
        tool: e.tool,
        category: e.category,
        tags: safeParseJson(e.tags, []),
        confidence: e.confidence,
        source_project: e.source_project,
      },
      score: e._score || 0,
      summary: (e.context_text || "").split("\n")[0] || e.id,
      fix: (e.fix_text || "").split("\n")[0] || "",
    }));
  } catch {
    return [];
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
    const sessionId = hookInput.session_id || "";
    const cwd = hookInput.cwd || process.cwd();

    // Clear stale hook state directories so a fresh session starts clean
    const hookStateDirs = [
      "claude-context-guard",
      "claude-stuck-detector",
      "claude-bloat-guard",
      "claude-post-tool-verify",
      "claude-subagent-recovery",
      "claude-tool-failures",
      "claude-pre-compact",
    ];
    for (const dirName of hookStateDirs) {
      try {
        const dir = path.join(os.tmpdir(), dirName);
        if (fs.existsSync(dir)) {
          for (const f of fs.readdirSync(dir)) {
            fs.unlinkSync(path.join(dir, f));
          }
        }
      } catch {}
    }

    // Import knowledge entries from JSONL if available
    try {
      let knowledgeDb;
      try { knowledgeDb = require("./knowledge-db"); } catch {}
      if (knowledgeDb) {
        const knowledgeDir = path.join(os.homedir(), ".claude", "knowledge");
        const jsonlPath = path.join(knowledgeDir, "entries.jsonl");
        if (fs.existsSync(jsonlPath)) {
          const dbPath = path.join(knowledgeDir, "knowledge.db");
          const db = knowledgeDb.openDb(dbPath);
          knowledgeDb.importFromJsonl(db, jsonlPath);
        }
      }
    } catch {}

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

    // Load env vars from project or global env.yaml
    let envVars = {};
    let envFilePath = "";
    try {
      const projectEnvPath = path.join(cwd, ".claude", "env.yaml");
      const globalEnvPath = path.join(os.homedir(), ".claude", "env.yaml");

      if (fs.existsSync(projectEnvPath)) {
        envFilePath = projectEnvPath;
      } else if (fs.existsSync(globalEnvPath)) {
        envFilePath = globalEnvPath;
      }

      if (envFilePath) {
        const content = fs.readFileSync(envFilePath, "utf8");
        envVars = parseEnvYaml(content);

        // Write to CLAUDE_ENV_FILE if available (Claude Code env injection)
        const claudeEnvFile = process.env.CLAUDE_ENV_FILE;
        if (claudeEnvFile && Object.keys(envVars).length > 0) {
          const exports = Object.entries(envVars)
            .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
            .join("\n");
          fs.appendFileSync(claudeEnvFile, exports + "\n");
        }
      }
    } catch {}

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

    // Inject recent git commits for context
    let recentCommits = "";
    try {
      recentCommits = execSync("git log --oneline -5", {
        cwd,
        timeout: 3000,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
      }).trim();
    } catch {}

    // Build context string
    const parts = [];

    if (recentCommits) {
      parts.push(`Recent commits:\n${recentCommits}`);
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

    if (envFilePath && Object.keys(envVars).length > 0) {
      const varNames = Object.keys(envVars).join(", ");
      parts.push(`Environment variables loaded from ${envFilePath}: ${varNames}`);
    }

    // Inject relevant knowledge entries
    const relevantEntries = getRelevantKnowledge(cwd);
    if (relevantEntries.length > 0) {
      const entryLines = relevantEntries.map((e) => {
        const line = `  **[${e.fm.category}] ${e.fm.tool}:** ${e.summary}`;
        return e.fix ? `${line}\n    Fix: ${e.fix}` : line;
      });
      parts.push(`Relevant knowledge entries:\n${entryLines.join("\n")}`);
    }

    // Inject fleet digest if available
    try {
      const fleetDigestPath = path.join(os.homedir(), ".claude", "fleet", "fleet-digest.txt");
      if (fs.existsSync(fleetDigestPath)) {
        const digest = fs.readFileSync(fleetDigestPath, "utf8").trim();
        if (digest) {
          parts.push(`Fleet index:\n${digest}`);
        }
      }
    } catch {}

    const context = parts.join("\n\n");

    log.writeLog({
      hook: "session-start",
      event: "init",
      session_id: sessionId,
      project: cwd,
      details: `Injected ${parts.length} context sections, ${relevantEntries.length} knowledge entries (fleet digest included if available)`,
    });

    // Output JSON that Claude Code injects into agent context
    const output = {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: context,
      },
    };

    process.stdout.write(JSON.stringify(output));
    process.exit(0);
  } catch {
    // Don't block session start on errors
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }
});

// Export for testing
if (typeof module !== "undefined") {
  module.exports = { detectProjectContext, parseFrontmatter, scoreEntry, getRelevantKnowledge, parseEnvYaml };
}
