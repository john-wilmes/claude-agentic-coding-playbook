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

const {
  createTempHome,
  createKnowledgeEntry,
  createMemoryFile,
  runHook,
  readState,
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

test("2. Registers agent in state.json", (env) => {
  const projDir = createProjectDir();
  const projName = path.basename(projDir);

  runHook(SESSION_START, {
    session_id: "test-session-reg",
    cwd: projDir,
  }, { HOME: env.home, USERPROFILE: env.home });

  const state = readState(env.agentCommDir);
  assert.ok(state.agents[projName], `Agent '${projName}' should be registered`);
  assert.strictEqual(state.agents[projName].role, "auto");
  assert.ok(state.agents[projName].workingOn.includes("test-ses"));
});

test("3. Injects memory when MEMORY.md exists", (env) => {
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

test("9. Deregisters agent from state", (env) => {
  const projDir = createProjectDir();
  const projName = path.basename(projDir);

  // First, register via session-start
  runHook(SESSION_START, {
    session_id: "test-dereg",
    cwd: projDir,
  }, { HOME: env.home, USERPROFILE: env.home });

  // Confirm registered
  let state = readState(env.agentCommDir);
  assert.ok(state.agents[projName], "Agent should be registered before session-end");

  // Now run session-end
  runHook(SESSION_END, {
    session_id: "test-dereg",
    cwd: projDir,
  }, { HOME: env.home, USERPROFILE: env.home });

  state = readState(env.agentCommDir);
  assert.ok(!state.agents[projName], "Agent should be deregistered after session-end");
});

test("10. Posts 'Session ended' broadcast message", (env) => {
  const projDir = createProjectDir();
  const projName = path.basename(projDir);

  runHook(SESSION_END, {
    session_id: "abcd1234-rest",
    cwd: projDir,
  }, { HOME: env.home, USERPROFILE: env.home });

  const state = readState(env.agentCommDir);
  const endMsg = state.messages.find(
    (m) => m.from === projName && m.content.includes("Session ended")
  );
  assert.ok(endMsg, "Should post a 'Session ended' message");
  assert.ok(endMsg.content.includes("abcd1234"), "Message should include session ID prefix");
  assert.strictEqual(endMsg.to, null, "Message should be a broadcast (to: null)");
});

test("11. Graceful when ~/.claude is not a git repo (exits 0)", (env) => {
  const projDir = createProjectDir();

  // Ensure ~/.claude exists but is NOT a git repo
  fs.mkdirSync(path.join(env.home, ".claude"), { recursive: true });

  const result = runHook(SESSION_END, {
    session_id: "test-no-git",
    cwd: projDir,
  }, { HOME: env.home, USERPROFILE: env.home });

  assert.strictEqual(result.status, 0, "Should exit 0 even without git repo at ~/.claude");

  // Check the log file for the expected error
  const logFile = path.join(env.agentCommDir, "agent-comm.log");
  if (fs.existsSync(logFile)) {
    const log = fs.readFileSync(logFile, "utf8");
    // It should log an auto-commit error, but not crash
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
