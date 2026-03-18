// Shared test utilities for session hook integration tests.
// Zero dependencies — uses only Node built-ins.

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

/**
 * Create an isolated temp HOME with ~/.claude/ pre-created.
 * Returns { home, claudeDir, cleanup }.
 */
function createTempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hook-test-"));
  const claudeDir = path.join(home, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });

  return {
    home,
    claudeDir,
    cleanup() {
      try {
        fs.rmSync(home, { recursive: true, force: true });
      } catch {}
    },
  };
}

/**
 * Create a knowledge entry directory with entry.md under ~/.claude/knowledge/entries/.
 * @param {string} home - The temp HOME directory
 * @param {object} opts - { id, tool, category, tags, confidence, context, fix }
 * @returns {string} path to the entry directory
 */
function createKnowledgeEntry(home, opts = {}) {
  const {
    id = `test-${crypto.randomUUID().slice(0, 8)}`,
    tool = "git",
    category = "gotcha",
    tags = ["test"],
    confidence = "high",
    context = "Test knowledge entry for CI.",
    fix = "Apply the fix.",
  } = opts;

  const entriesDir = path.join(home, ".claude", "knowledge", "entries", id);
  fs.mkdirSync(entriesDir, { recursive: true });

  const tagsStr = JSON.stringify(tags);
  const content = `---
id: "${id}"
tool: "${tool}"
category: "${category}"
tags: ${tagsStr}
confidence: "${confidence}"
---
## Context

${context}

## Fix

${fix}
`;
  fs.writeFileSync(path.join(entriesDir, "entry.md"), content);
  return entriesDir;
}

/**
 * Create a MEMORY.md file at the correct project-encoded path.
 * @param {string} home - The temp HOME directory
 * @param {string} cwd - The project working directory
 * @param {string} content - The MEMORY.md content
 * @returns {string} path to the MEMORY.md file
 */
function createMemoryFile(home, cwd, content) {
  // Replicate Claude Code's encoding: colon→dash, separators→dash, strip leading dash
  const cwdEncoded = cwd.replace(/:/g, "-").replace(/[\\/]/g, "-").replace(/^-/, "");
  const memDir = path.join(home, ".claude", "projects", cwdEncoded, "memory");
  fs.mkdirSync(memDir, { recursive: true });
  const memPath = path.join(memDir, "MEMORY.md");
  fs.writeFileSync(memPath, content);
  return memPath;
}

/**
 * Run a hook script as a subprocess with JSON on stdin.
 * @param {string} hookPath - Absolute path to the hook .js file
 * @param {object} stdinJson - Object to JSON.stringify and pipe to stdin
 * @param {object} env - Additional environment variables (merged with process.env)
 * @returns {{ status, stdout, stderr, json }}
 */
function runHook(hookPath, stdinJson = {}, env = {}) {
  // Strip claude-loop env vars to prevent leakage from the parent session.
  // Tests that need these vars pass them explicitly via the env parameter.
  const baseEnv = { ...process.env };
  delete baseEnv.CLAUDE_LOOP;
  delete baseEnv.CLAUDE_LOOP_PID;
  delete baseEnv.CLAUDE_LOOP_SENTINEL;

  const result = spawnSync("node", [hookPath], {
    input: JSON.stringify(stdinJson),
    env: { ...baseEnv, CLAUDE_HOOK_SOURCE: "test", ...env },
    timeout: 10000,
    encoding: "utf8",
  });

  let json = null;
  try {
    if (result.stdout && result.stdout.trim()) {
      json = JSON.parse(result.stdout.trim());
    }
  } catch {}

  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    json,
  };
}

/**
 * Run a hook script as a subprocess with a raw string on stdin (no JSON.stringify).
 * Use this to test how hooks handle truly malformed JSON input.
 * @param {string} hookPath - Absolute path to the hook .js file
 * @param {string} rawStdin - Raw string to pipe to stdin as-is
 * @param {object} env - Additional environment variables (merged with process.env)
 * @returns {{ status, stdout, stderr, json }}
 */
function runHookRaw(hookPath, rawStdin = "", env = {}) {
  const baseEnv = { ...process.env };
  delete baseEnv.CLAUDE_LOOP;
  delete baseEnv.CLAUDE_LOOP_PID;
  delete baseEnv.CLAUDE_LOOP_SENTINEL;

  const result = spawnSync("node", [hookPath], {
    input: rawStdin,
    env: { ...baseEnv, CLAUDE_HOOK_SOURCE: "test", ...env },
    timeout: 10000,
    encoding: "utf8",
  });

  let json = null;
  try {
    if (result.stdout && result.stdout.trim()) {
      json = JSON.parse(result.stdout.trim());
    }
  } catch {}

  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    json,
  };
}

/**
 * Create a fake project directory with optional marker files.
 * @param {object} opts - { git, packageJson, dockerfile, pyproject }
 * @returns {string} path to the project directory
 */
function createProjectDir(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-proj-"));

  if (opts.git) {
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  }
  if (opts.packageJson) {
    const pkg = typeof opts.packageJson === "object" ? opts.packageJson : {};
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
  }
  if (opts.dockerfile) {
    fs.writeFileSync(path.join(dir, "Dockerfile"), "FROM node:18\n");
  }
  if (opts.pyproject) {
    fs.writeFileSync(path.join(dir, "pyproject.toml"), "[project]\nname = \"test\"\n");
  }

  return dir;
}

/**
 * Create a temp investigation directory with FINDINGS.md, EVIDENCE/ files,
 * and optional STATUS.md for scorer tests.
 *
 * @param {object} opts
 * @param {string}   opts.findings   - FINDINGS.md content (default: well-structured)
 * @param {object[]} opts.evidence   - Array of { name, source, observation } objects
 * @param {boolean}  opts.noFindings - Omit FINDINGS.md entirely
 * @returns {{ dir, cleanup }}
 */
function createTempInvestigation(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inv-test-"));
  const evidenceDir = path.join(dir, "EVIDENCE");
  fs.mkdirSync(evidenceDir, { recursive: true });

  // Default evidence
  const evidenceItems = opts.evidence || [
    {
      name: "001-test-finding.md",
      source: "src/utils/helper.ts:42",
      observation: "The function splits on colon, returning only the drive letter on Windows.",
    },
  ];

  for (const item of evidenceItems) {
    const content = `# ${item.name.replace(".md", "")}\n\n**Source**: ${item.source || ""}\n**Relevance**: ${item.relevance || "Directly related to the investigation question."}\n\n${item.observation || "Observation text."}\n`;
    fs.writeFileSync(path.join(evidenceDir, item.name), content);
  }

  if (!opts.noFindings) {
    const findings = opts.findings || `---
tags:
  domain: []
  type: []
---
# Findings: TEST-001

## Answer

The root cause is the colon-split at line 42 (see 001). On Windows, the drive letter
contains a colon, causing split(":")[0] to return "D" instead of the full path (see 001).

## Evidence Summary

| # | Slug | Key observation |
|---|------|-----------------|
| 001 | colon-split | split(":")[0] breaks on Windows drive letters |

## Implications

The fix is to use lastIndexOf(":") instead of split(":")[0].
`;
    fs.writeFileSync(path.join(dir, "FINDINGS.md"), findings);
  }

  return {
    dir,
    evidenceDir,
    cleanup() {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

/**
 * Return today's date string in YYYY-MM-DD format using **local** time.
 * Matches the todayString() logic in log.js so tests look for the correct log filename.
 * @returns {string}
 */
function todayLocal() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Create ~/.claude/knowledge/staged/ inside the given temp HOME.
 * @param {string} home - The temp HOME directory
 * @returns {string} path to the staged directory
 */
function createStagedDir(home) {
  const dir = path.join(home, ".claude", "knowledge", "staged");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Create an in-memory knowledge DB for test isolation.
 * @returns {object} The opened database (from knowledge-db.js openDb)
 */
function createKnowledgeDb() {
  const knowledgeDb = require("../../templates/hooks/knowledge-db");
  return knowledgeDb.openDb(":memory:");
}

module.exports = {
  createTempHome,
  createKnowledgeEntry,
  createMemoryFile,
  runHook,
  runHookRaw,
  createProjectDir,
  createTempInvestigation,
  createStagedDir,
  todayLocal,
  createKnowledgeDb,
};
