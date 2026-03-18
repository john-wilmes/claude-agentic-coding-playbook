#!/usr/bin/env node
// Integration tests for session-start.js and session-end.js hooks.
// Zero dependencies — uses only Node built-ins + local test-helpers.
//
// Run: node tests/hooks/session-hooks.test.js
//
// Tests run each hook as a subprocess with spawnSync + piped stdin,
// exactly as Claude Code does. Each test gets an isolated temp HOME.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { spawnSync } = require("child_process");

const {
  createTempHome,
  createKnowledgeEntry,
  createMemoryFile,
  runHook,
  createProjectDir,
} = require("./test-helpers");

// Resolve hook paths relative to repo root
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SESSION_START = path.join(REPO_ROOT, "templates", "hooks", "session-start.js");
const SESSION_END = path.join(REPO_ROOT, "templates", "hooks", "session-end.js");

// ─── Test runner ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

function test(name, fn) {
  const env = createTempHome();
  try {
    fn(env);
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message });
    console.log(`  \u2717 ${name}`);
    console.log(`    ${err.message}`);
  } finally {
    env.cleanup();
  }
}

/**
 * Extract functions from a hook source by writing them to a temp module file.
 * Returns the requested function ready to call. Dependencies (other functions
 * from the same file) are included automatically.
 */
let _extractCounter = 0;
function extractFunction(hookPath, funcName) {
  const src = fs.readFileSync(hookPath, "utf8");

  // Take everything before the stdin handler — all function declarations live there
  const boundary = src.indexOf("process.stdin.resume()");
  const declarations = boundary > 0 ? src.slice(0, boundary) : src;

  // Write a temp module that re-exports the needed function
  const tmpFile = path.join(os.tmpdir(), `hook-extract-${Date.now()}-${_extractCounter++}.js`);
  fs.writeFileSync(tmpFile, `${declarations}\nmodule.exports = { ${funcName} };\n`);

  try {
    const mod = require(tmpFile);
    if (typeof mod[funcName] !== "function") {
      throw new Error(`${funcName} not found or not a function in ${hookPath}`);
    }
    return mod[funcName];
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

// ─── session-start.js tests ─────────────────────────────────────────────────

console.log("\nsession-start.js:");

test("1. Minimal valid input → valid JSON with SessionStart event", (env) => {
  const projDir = createProjectDir();
  const result = runHook(SESSION_START, {
    session_id: "test-session-1234",
    cwd: projDir,
  }, { HOME: env.home, USERPROFILE: env.home });

  assert.strictEqual(result.status, 0, `Exit code should be 0, got ${result.status}`);
  assert.ok(result.json, "Should output valid JSON");
  assert.strictEqual(
    result.json.hookSpecificOutput.hookEventName,
    "SessionStart",
    "hookEventName should be SessionStart"
  );
  assert.ok(
    typeof result.json.hookSpecificOutput.additionalContext === "string",
    "additionalContext should be a string"
  );
});

test("2. Injects memory when MEMORY.md exists", (env) => {
  const projDir = createProjectDir({ git: true });
  const memContent = `# Project Memory

## Current Work

Working on session hook tests.

## Lessons Learned

- Always test path encoding on Windows.
`;
  createMemoryFile(env.home, projDir, memContent);

  const result = runHook(SESSION_START, {
    session_id: "test-session-mem",
    cwd: projDir,
  }, { HOME: env.home, USERPROFILE: env.home });

  const ctx = result.json.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes("Working on session hook tests"), "Should inject Current Work");
  assert.ok(ctx.includes("Always test path encoding"), "Should inject Lessons Learned");
});

test("4. Path encoding: produces Claude Code-compatible project key", (env) => {
  // Claude Code encodes C:\Users\foo\project as C--Users-foo-project
  // On Unix, /home/user/project becomes home-user-project
  const projDir = createProjectDir({ git: true });

  // Compute expected encoding (same algorithm as the fix)
  const expected = projDir.replace(/:/g, "-").replace(/[\\/]/g, "-").replace(/^-/, "");

  const memContent = "## Current Work\n\nPath encoding test marker.\n";
  createMemoryFile(env.home, projDir, memContent);

  const result = runHook(SESSION_START, {
    session_id: "test-path-enc",
    cwd: projDir,
  }, { HOME: env.home, USERPROFILE: env.home });

  const ctx = result.json.hookSpecificOutput.additionalContext;
  assert.ok(
    ctx.includes("Path encoding test marker"),
    `Memory not injected — path encoding may be wrong. Expected key: ${expected}`
  );
});

test("5. Knowledge injection: entry with tool=git injected for project with .git/", (env) => {
  const projDir = createProjectDir({ git: true });
  createKnowledgeEntry(env.home, {
    id: "git-gotcha-1",
    tool: "git",
    category: "gotcha",
    context: "Branch protection blocks merges when threads unresolved.",
    fix: "Resolve threads via GraphQL API.",
  });

  const result = runHook(SESSION_START, {
    session_id: "test-knowledge",
    cwd: projDir,
  }, { HOME: env.home, USERPROFILE: env.home });

  const ctx = result.json.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes("knowledge entries"), "Should have knowledge entries section");
  assert.ok(
    ctx.includes("Branch protection") || ctx.includes("git"),
    "Should include the git knowledge entry"
  );
});

test("6. No injection for empty project (no recognized files)", (env) => {
  // Create a project with nothing recognizable
  const projDir = createProjectDir();
  createKnowledgeEntry(env.home, {
    id: "git-gotcha-2",
    tool: "git",
    category: "gotcha",
    context: "Should not appear.",
  });

  const result = runHook(SESSION_START, {
    session_id: "test-empty-proj",
    cwd: projDir,
  }, { HOME: env.home, USERPROFILE: env.home });

  const ctx = result.json.hookSpecificOutput.additionalContext;
  assert.ok(
    !ctx.includes("knowledge entries"),
    "Should NOT inject knowledge for project with no recognized tools"
  );
});

test("7. Graceful when knowledge dir has no .git", (env) => {
  const projDir = createProjectDir({ git: true });
  // Create knowledge entries dir but no .git in knowledge root
  createKnowledgeEntry(env.home, {
    id: "no-git-entry",
    tool: "git",
    category: "gotcha",
    context: "Entry without knowledge .git.",
  });

  // Ensure there's NO .git in the knowledge root
  const knowledgeGit = path.join(env.home, ".claude", "knowledge", ".git");
  try { fs.rmSync(knowledgeGit, { recursive: true, force: true }); } catch {}

  const result = runHook(SESSION_START, {
    session_id: "test-no-git-knowledge",
    cwd: projDir,
  }, { HOME: env.home, USERPROFILE: env.home });

  assert.strictEqual(result.status, 0, "Should exit 0 even without knowledge .git");
  assert.ok(result.json, "Should still produce valid JSON output");
});

// ─── session-end.js tests ────────────────────────────────────────────────────

console.log("\nsession-end.js:");

test("8. Minimal valid input → exits 0", (env) => {
  const projDir = createProjectDir();
  const result = runHook(SESSION_END, {
    session_id: "test-session-end-1",
    cwd: projDir,
  }, { HOME: env.home, USERPROFILE: env.home });

  assert.strictEqual(result.status, 0, `Exit code should be 0, got ${result.status}`);
});

test("9. Graceful when ~/.claude is not a git repo (exits 0)", (env) => {
  const projDir = createProjectDir();

  // Ensure ~/.claude exists but is NOT a git repo
  fs.mkdirSync(path.join(env.home, ".claude"), { recursive: true });

  const result = runHook(SESSION_END, {
    session_id: "test-no-git",
    cwd: projDir,
  }, { HOME: env.home, USERPROFILE: env.home });

  assert.strictEqual(result.status, 0, "Should exit 0 even without git repo at ~/.claude");

  // Check the log file for the expected entries
  const logFile = path.join(env.home, ".claude", "hooks.log");
  if (fs.existsSync(logFile)) {
    const log = fs.readFileSync(logFile, "utf8");
    assert.ok(
      log.includes("session-end:"),
      "Should have log entries from session-end"
    );
  }
});

// ─── Unit-level tests (extracted functions) ──────────────────────────────────

console.log("\nUnit tests (extracted functions):");

test("12. detectProjectContext: recognizes Node project (package.json)", () => {
  const detectProjectContext = extractFunction(SESSION_START, "detectProjectContext");
  const projDir = createProjectDir({ packageJson: { dependencies: { react: "^18" } } });

  const ctx = detectProjectContext(projDir);
  assert.ok(ctx.tools.includes("npm"), "Should detect npm");
  assert.ok(ctx.tools.includes("node"), "Should detect node");
  assert.ok(ctx.tags.includes("react"), "Should detect react tag");
});

test("13. detectProjectContext: recognizes Python project (pyproject.toml)", () => {
  const detectProjectContext = extractFunction(SESSION_START, "detectProjectContext");
  const projDir = createProjectDir({ pyproject: true });

  const ctx = detectProjectContext(projDir);
  assert.ok(ctx.tools.includes("python"), "Should detect python");
});

test("14. detectProjectContext: recognizes Docker project (Dockerfile)", () => {
  const detectProjectContext = extractFunction(SESSION_START, "detectProjectContext");
  const projDir = createProjectDir({ dockerfile: true });

  const ctx = detectProjectContext(projDir);
  assert.ok(ctx.tools.includes("docker"), "Should detect docker");
});

test("15. scoreEntry: tool match (10pts) > tag match (3pts)", () => {
  const scoreEntry = extractFunction(SESSION_START, "scoreEntry");

  const toolScore = scoreEntry(
    { tool: "git", tags: [], category: "gotcha" },
    { tools: ["git"], tags: [] }
  );
  const tagScore = scoreEntry(
    { tool: "unknown", tags: ["git"], category: "gotcha" },
    { tools: ["git"], tags: [] }
  );

  assert.ok(toolScore > tagScore, `Tool match (${toolScore}) should score higher than tag match (${tagScore})`);
  assert.ok(toolScore >= 10, `Tool match should be >= 10, got ${toolScore}`);
  assert.ok(tagScore >= 3, `Tag match should be >= 3, got ${tagScore}`);
});

test("16. parseFrontmatter: parses array tags [\"a\", \"b\"]", () => {
  const parseFrontmatter = extractFunction(SESSION_START, "parseFrontmatter");
  const content = `---
id: "test-1"
tool: "git"
tags: ["alpha", "beta"]
---
Body text.`;

  const fm = parseFrontmatter(content);
  assert.ok(fm, "Should parse frontmatter");
  assert.strictEqual(fm.id, "test-1");
  assert.strictEqual(fm.tool, "git");
  assert.ok(Array.isArray(fm.tags), "tags should be an array");
  assert.deepStrictEqual(fm.tags, ["alpha", "beta"]);
});

test("17. parseFrontmatter: handles unquoted values", () => {
  const parseFrontmatter = extractFunction(SESSION_START, "parseFrontmatter");
  const content = `---
tool: git
category: gotcha
confidence: high
---
Body text.`;

  const fm = parseFrontmatter(content);
  assert.ok(fm, "Should parse frontmatter");
  assert.strictEqual(fm.tool, "git");
  assert.strictEqual(fm.category, "gotcha");
  assert.strictEqual(fm.confidence, "high");
});

// ─── Size warning tests ─────────────────────────────────────────────────────

console.log("\nsession-start.js size warnings:");

test("18. MEMORY.md >120 lines triggers size warning", (env) => {
  const projDir = createProjectDir({ git: true });
  // Create a MEMORY.md with 130 lines
  const lines = ["# Memory\n", "## Current Work\n", "Working on tests.\n"];
  for (let i = 0; i < 130; i++) lines.push(`Line ${i}\n`);
  createMemoryFile(env.home, projDir, lines.join(""));

  const result = runHook(SESSION_START, {
    session_id: "test-size-warn",
    cwd: projDir,
  }, { HOME: env.home, USERPROFILE: env.home });

  const ctx = result.json.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes("MEMORY.md is"), "Should warn about MEMORY.md size");
  assert.ok(ctx.includes("/checkpoint"), "Should suggest /checkpoint");
});

test("19. MEMORY.md <120 lines does NOT trigger size warning", (env) => {
  const projDir = createProjectDir({ git: true });
  const memContent = "# Memory\n\n## Current Work\n\nSmall file.\n";
  createMemoryFile(env.home, projDir, memContent);

  const result = runHook(SESSION_START, {
    session_id: "test-no-warn",
    cwd: projDir,
  }, { HOME: env.home, USERPROFILE: env.home });

  const ctx = result.json.hookSpecificOutput.additionalContext;
  assert.ok(!ctx.includes("MEMORY.md is"), "Should NOT warn about small MEMORY.md");
});

test("20. Combined CLAUDE.md >700 lines triggers size warning", (env) => {
  const projDir = createProjectDir({ git: true });
  // Create a large global CLAUDE.md
  const lines = ["# CLAUDE.md\n"];
  for (let i = 0; i < 400; i++) lines.push(`Rule ${i}\n`);
  fs.mkdirSync(path.join(env.home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(env.home, ".claude", "CLAUDE.md"), lines.join(""));
  // Create a large project CLAUDE.md
  const projLines = ["# Project\n"];
  for (let i = 0; i < 350; i++) projLines.push(`Project rule ${i}\n`);
  fs.writeFileSync(path.join(projDir, "CLAUDE.md"), projLines.join(""));

  const result = runHook(SESSION_START, {
    session_id: "test-claude-warn",
    cwd: projDir,
  }, { HOME: env.home, USERPROFILE: env.home });

  const ctx = result.json.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes("Combined CLAUDE.md"), "Should warn about combined CLAUDE.md size");
});

// ─── Cross-agent isolation test ──────────────────────────────────────────────

console.log("\nsession-end.js cross-agent isolation:");

test("21. session-end only stages its OWN project MEMORY.md, not other projects'", (env) => {
  // Set up a git repo in the temp ~/.claude dir (simulates a real multi-project install)
  const gitEnv = { HOME: env.home, USERPROFILE: env.home, GIT_AUTHOR_NAME: "Test", GIT_COMMITTER_NAME: "Test", GIT_AUTHOR_EMAIL: "t@t.com", GIT_COMMITTER_EMAIL: "t@t.com" };
  const gitIn = { cwd: env.claudeDir, encoding: "utf8", env: { ...process.env, ...gitEnv } };

  // Use simple predictable fake cwd paths so encoding is deterministic
  // Encoding: colons → dashes, separators → dashes, strip leading dash
  const projACwd = "C:\\projects\\alpha";   // encodes to: C--projects-alpha
  const projBCwd = "C:\\projects\\beta";    // encodes to: C--projects-beta
  const encA = projACwd.replace(/:/g, "-").replace(/[\\/]/g, "-").replace(/^-/, "");
  const encB = projBCwd.replace(/:/g, "-").replace(/[\\/]/g, "-").replace(/^-/, "");

  const memA = path.join(env.claudeDir, "projects", encA, "memory", "MEMORY.md");
  const memB = path.join(env.claudeDir, "projects", encB, "memory", "MEMORY.md");
  fs.mkdirSync(path.dirname(memA), { recursive: true });
  fs.mkdirSync(path.dirname(memB), { recursive: true });

  // Write initial content and commit both so they are tracked
  fs.writeFileSync(memA, "# Memory A initial\n");
  fs.writeFileSync(memB, "# Memory B initial\n");
  spawnSync("git", ["init"], gitIn);
  spawnSync("git", ["add", "-A"], gitIn);
  spawnSync("git", ["commit", "-m", "initial"], gitIn);

  // Simulate two concurrent agents: both modify their own MEMORY.md
  fs.writeFileSync(memA, "# Memory A — updated by project alpha session\n");
  fs.writeFileSync(memB, "# Memory B — updated by project beta session (must NOT be staged by alpha)\n");

  // Run session-end for project A only
  runHook(SESSION_END, { session_id: "aabbccdd", cwd: projACwd }, { HOME: env.home, USERPROFILE: env.home, ...gitEnv });

  // After hook: project B's MEMORY.md should still be unstaged (dirty).
  // If git add -A was used, B would have been committed and would appear clean.
  const statusOut = spawnSync("git", ["status", "--porcelain"], gitIn);
  const status = statusOut.stdout || "";

  // Normalise to forward slashes for cross-platform comparison
  const bRelPath = `projects/${encB}/memory/MEMORY.md`;
  assert.ok(
    status.replace(/\\/g, "/").includes(bRelPath),
    `Project B MEMORY.md should still be dirty after project A session-end.\nGit status:\n${status}`
  );
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped (${passed + failed + skipped} total)`);

if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) {
    console.log(`  \u2717 ${f.name}: ${f.error}`);
  }
}

process.exit(failed > 0 ? 1 : 0);
