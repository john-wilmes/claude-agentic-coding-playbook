// SessionStart hook: injects memory, knowledge entries, and git context into session.
// Also checks MEMORY.md and CLAUDE.md size thresholds and warns when exceeded.
// No agent decision needed -- this runs automatically on every session start.

function respond(payload = {}) {
  process.stdout.write(JSON.stringify(payload), () => process.exit(0));
}

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

let log;
try { log = require("./log"); } catch { log = { writeLog() {} }; }

let modelConfig;
try { modelConfig = require("./model-config"); } catch { modelConfig = null; }

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

// Legacy: parse YAML frontmatter from an entry file.
// No longer used in production (production scoring uses knowledgeDb.queryRelevant()).
// Retained because session-start.test.js and session-hooks.test.js test this function directly.
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

// Legacy: score a knowledge entry for relevance to the current project.
// No longer used in production (production scoring uses knowledgeDb.queryRelevant()).
// Retained because session-start.test.js and session-hooks.test.js test this function directly.
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

// Dangerous env var names that must never be overridden by project env.yaml.
// A malicious project could override PATH, LD_PRELOAD, etc. to hijack execution.
const BLOCKED_ENV_VARS = new Set([
  "PATH", "HOME", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES",
  "BASH_ENV", "ENV",
  "NODE_PATH", "NODE_OPTIONS", "PYTHONPATH", "PRESIDIO_AVAILABLE",
  "MCP_QUERY_INTERCEPT", "CLAUDE_LOOP", "CLAUDE_LOOP_PID",
  "CLAUDE_LOOP_SENTINEL", "SHELL", "USER", "LOGNAME", "TERM", "SSH_AUTH_SOCK",
  "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL",
  "GH_TOKEN", "GITHUB_TOKEN", "GH_HOST",
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
  "CLAUDE_ENV_FILE",
  "npm_config_registry", "PIP_INDEX_URL", "PIP_EXTRA_INDEX_URL",
  "DOCKER_HOST", "KUBECONFIG",
]);

// Parse simple YAML key-value pairs (one level deep, no nested objects/arrays)
function parseEnvYaml(content) {
  const result = {};
  const KEY_RE = /^([A-Z_][A-Z0-9_]*):\s*(.*)$/;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(KEY_RE);
    if (!m) continue;
    const key = m[1];
    // Block dangerous env var names
    if (BLOCKED_ENV_VARS.has(key)) {
      process.stderr.write(`session-start: blocked dangerous env var "${key}" from project env.yaml\n`);
      continue;
    }
    let val = m[2].trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  return result;
}

// Extract salient terms from free text (e.g. Current Work) for FTS5 query enrichment.
// Returns up to maxTerms unique lowercase tokens, filtering stopwords and short words.
function extractSalientTerms(text, maxTerms = 8) {
  if (!text) return [];
  const stopwords = new Set([
    "the", "and", "for", "with", "from", "this", "that", "was", "were", "been",
    "have", "has", "had", "not", "but", "all", "can", "her", "his", "its",
    "our", "you", "are", "will", "would", "could", "should", "into", "about",
    "after", "before", "between", "each", "also", "than", "then", "when",
    "what", "which", "who", "how", "done", "work", "next", "steps", "session",
    "current", "state", "clean", "commit", "commits", "ahead", "origin",
    "master", "working", "tree", "saved", "memory", "files", "file", "open",
    "updated", "added", "removed", "fixed", "ran", "running", "using", "used",
  ]);
  // Extract words, kebab-case tokens, and dot-separated identifiers
  const tokens = text.toLowerCase().match(/[a-z][a-z0-9]+(?:[-_.][a-z0-9]+)*/g) || [];
  const seen = new Set();
  const result = [];
  for (const t of tokens) {
    if (t.length < 3 || stopwords.has(t) || seen.has(t)) continue;
    seen.add(t);
    result.push(t);
    if (result.length >= maxTerms) break;
  }
  return result;
}

// Read and score knowledge entries via SQLite DB, return top N
function getRelevantKnowledge(cwd, maxEntries = 5, extraTerms = []) {
  try {
    let knowledgeDb;
    try { knowledgeDb = require("./knowledge-db"); } catch { return []; }

    const projectContext = detectProjectContext(cwd);
    if (projectContext.tools.length === 0 && projectContext.tags.length === 0 && extraTerms.length === 0) {
      return [];
    }

    // Compute DB path at call time so withFakeHome patches take effect
    const dbPath = path.join(os.homedir(), ".claude", "knowledge", "knowledge.db");
    const db = knowledgeDb.openDb(dbPath);

    // Build query terms from project context + current work terms
    const queryTerms = [...projectContext.tools, ...projectContext.tags, projectContext.projectName, ...extraTerms]
      .filter(Boolean);

    const result = knowledgeDb.queryRelevant(db, {
      projectTool: projectContext.tools,
      sourceProject: projectContext.projectName,
      queryTerms,
      cwd,
    }, maxEntries);
    const entries = result.results || [];

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

    // Persist model ID for downstream hooks (context-guard, etc.)
    if (modelConfig && sessionId) {
      modelConfig.saveSessionModel(sessionId, hookInput.model || "");
    }

    // Clear stale hook state directories — only delete files older than 2 hours
    // to preserve state for concurrent sessions.
    const hookStateDirs = [
      "claude-context-guard",
      "claude-stuck-detector",
      "claude-bloat-guard",
      "claude-post-tool-verify",
      "claude-subagent-recovery",
      "claude-tool-failures",
      "claude-pre-compact",
      "claude-model-config",
      "claude-model-upgrade",
    ];
    const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
    const now = Date.now();
    for (const dirName of hookStateDirs) {
      try {
        const dir = path.join(os.tmpdir(), dirName);
        if (fs.existsSync(dir)) {
          for (const f of fs.readdirSync(dir)) {
            const filePath = path.join(dir, f);
            try {
              const mtime = fs.statSync(filePath).mtimeMs;
              // Only delete files older than 2 hours or matching current session.
              // Use boundary-aware regex so a session id that is a substring of
              // another id does not accidentally delete unrelated files.
              // Only delete by session ID if we actually have one — an empty
              // sessionId would make "".includes(anything) always return true,
              // deleting every file regardless of age.
              const safeId = sessionId ? path.basename(sessionId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : null;
              const sessionPattern = safeId ? new RegExp("(^|[-._])" + safeId + "([-._]|$)") : null;
              if ((now - mtime) > TWO_HOURS_MS || (sessionPattern && sessionPattern.test(f))) {
                fs.unlinkSync(filePath);
              }
            } catch {
              // stat or unlink failed — skip
            }
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
      const cwdEncoded = cwd.replace(/:/g, "-").replace(/[\\/]/g, "-");
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
        memorySizeWarning = `\u26a0 MEMORY.md is ${memLineCount} lines (limit: 150, truncation: 200). Invoke /checkpoint to split topic files.`;
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
            .map(([k, v]) => `export ${k}='${String(v).replace(/'/g, "'\\''")}'`)
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

    // Inject relevant knowledge entries, enriched with Current Work terms
    const currentWorkTerms = extractSalientTerms(currentWork);
    const relevantEntries = getRelevantKnowledge(cwd, 5, currentWorkTerms);

    // Write injected IDs state file for retrieval-miss detection at session end
    try {
      const stateDir = path.join(os.tmpdir(), "claude-session-start");
      fs.mkdirSync(stateDir, { recursive: true });
      if (sessionId) {
        const stateFile = path.join(stateDir, `${sessionId}.json`);
        const injectedIds = relevantEntries.map(e => e.fm && e.fm.id).filter(Boolean);
        fs.writeFileSync(stateFile, JSON.stringify({ injectedIds }));
      }
    } catch {}

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

    return respond(output);
  } catch {
    // Don't block session start on errors
    return respond();
  }
});

// Export for testing
if (typeof module !== "undefined") {
  module.exports = { detectProjectContext, parseFrontmatter, scoreEntry, getRelevantKnowledge, parseEnvYaml, extractSalientTerms, BLOCKED_ENV_VARS };
}
