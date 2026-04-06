#!/usr/bin/env node
// Integration tests for templates/hooks/session-start.js
// Zero dependencies — uses only Node built-ins + local test-helpers.
//
// Run: node tests/hooks/session-start.test.js

"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const {
  createTempHome,
  createKnowledgeEntry,
  createProjectDir,
  runHook,
} = require("./test-helpers");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const HOOK_MODULE = path.join(REPO_ROOT, "templates", "hooks", "session-start.js");

// ─── Test runner ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message });
    console.log(`  \u2717 ${name}`);
    console.log(`    ${err.message}`);
  }
}

// ─── Module helpers ───────────────────────────────────────────────────────────

/**
 * Require a fresh (uncached) copy of session-start.js.
 * Does NOT patch os.homedir — the module calls os.homedir() at runtime, not
 * load time, so patches must wrap the actual function calls (use withFakeHome).
 */
function requireModule() {
  delete require.cache[require.resolve(HOOK_MODULE)];
  return require(HOOK_MODULE);
}

/**
 * Call fn() with os.homedir temporarily replaced to return fakeHome.
 * Restores the original after fn returns (or throws).
 */
function withFakeHome(fakeHome, fn) {
  const real = os.homedir;
  os.homedir = () => fakeHome;
  try {
    return fn();
  } finally {
    os.homedir = real;
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

console.log("\nsession-start.js:");

// Test 1: detectProjectContext — package.json → includes npm, node
test("1. detectProjectContext with package.json includes npm and node", () => {
  const dir = createProjectDir({ packageJson: {} });
  try {
    const { detectProjectContext } = requireModule();
    const ctx = detectProjectContext(dir);
    assert.ok(ctx.tools.includes("npm"), "tools should include npm");
    assert.ok(ctx.tools.includes("node"), "tools should include node");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Test 2: detectProjectContext — Dockerfile → includes docker
test("2. detectProjectContext with Dockerfile includes docker", () => {
  const dir = createProjectDir({ dockerfile: true });
  try {
    const { detectProjectContext } = requireModule();
    const ctx = detectProjectContext(dir);
    assert.ok(ctx.tools.includes("docker"), "tools should include docker");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Test 3: detectProjectContext — .git dir → includes git
test("3. detectProjectContext with .git dir includes git", () => {
  const dir = createProjectDir({ git: true });
  try {
    const { detectProjectContext } = requireModule();
    const ctx = detectProjectContext(dir);
    assert.ok(ctx.tools.includes("git"), "tools should include git");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Test 4: detectProjectContext — pyproject.toml → includes python
test("4. detectProjectContext with pyproject.toml includes python", () => {
  const dir = createProjectDir({ pyproject: true });
  try {
    const { detectProjectContext } = requireModule();
    const ctx = detectProjectContext(dir);
    assert.ok(ctx.tools.includes("python"), "tools should include python");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Test 5: detectProjectContext — empty dir → empty tools and tags
test("5. detectProjectContext with empty dir returns empty tools and tags", () => {
  const dir = createProjectDir();
  try {
    const { detectProjectContext } = requireModule();
    const ctx = detectProjectContext(dir);
    assert.strictEqual(ctx.tools.length, 0, "tools should be empty");
    assert.strictEqual(ctx.tags.length, 0, "tags should be empty");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Test 5a: detectSessionType — default → coding
test("5a. detectSessionType default returns coding", () => {
  const { detectSessionType } = requireModule();
  const result = detectSessionType("/some/project", {});
  assert.strictEqual(result.type, "coding", "default type should be coding");
});

// Test 5b: detectSessionType — investigations dir → research
test("5b. detectSessionType in investigations dir returns research", () => {
  const { detectSessionType } = requireModule();
  const investigationsDir = path.join(os.homedir(), ".claude", "investigations", "test-inv");
  const result = detectSessionType(investigationsDir, {});
  assert.strictEqual(result.type, "research", "investigations dir should be research");
  assert.ok(result.reason.includes("investigations"), "reason should mention investigations");
});

// Test 5c: detectSessionType — CLAUDE_LOOP set → autonomous
test("5c. detectSessionType with CLAUDE_LOOP returns autonomous", () => {
  const { detectSessionType } = requireModule();
  const result = detectSessionType("/some/project", { CLAUDE_LOOP: "1" });
  assert.strictEqual(result.type, "autonomous", "CLAUDE_LOOP should trigger autonomous");
});

// Test 5d: detectSessionType — investigations dir takes priority over CLAUDE_LOOP
test("5d. detectSessionType research takes priority over autonomous", () => {
  const { detectSessionType } = requireModule();
  const investigationsDir = path.join(os.homedir(), ".claude", "investigations", "test-inv");
  const result = detectSessionType(investigationsDir, { CLAUDE_LOOP: "1" });
  assert.strictEqual(result.type, "research", "research should take priority over autonomous");
});

// Test 6: parseFrontmatter — valid entry → returns parsed fields
test("6. parseFrontmatter with valid frontmatter returns parsed fields", () => {
  const { parseFrontmatter } = requireModule();
  const content = `---
id: "test-001"
tool: "git"
category: "gotcha"
confidence: "high"
---
## Context

Some content here.
`;
  const fm = parseFrontmatter(content);
  assert.ok(fm !== null, "Should return non-null");
  assert.strictEqual(fm.id, "test-001", "id should be parsed");
  assert.strictEqual(fm.tool, "git", "tool should be parsed");
  assert.strictEqual(fm.category, "gotcha", "category should be parsed");
  assert.strictEqual(fm.confidence, "high", "confidence should be parsed");
});

// Test 7: parseFrontmatter — no frontmatter → returns null
test("7. parseFrontmatter with no frontmatter returns null", () => {
  const { parseFrontmatter } = requireModule();
  const content = `## Context\n\nNo frontmatter here.\n`;
  const fm = parseFrontmatter(content);
  assert.strictEqual(fm, null, "Should return null when no frontmatter");
});

// Test 8: parseFrontmatter — array tags → parsed as array
test("8. parseFrontmatter with array tags parses them as array", () => {
  const { parseFrontmatter } = requireModule();
  const content = `---
id: "test-002"
tool: "node"
tags: ["auth", "security", "jwt"]
---
## Context

Array tags test.
`;
  const fm = parseFrontmatter(content);
  assert.ok(fm !== null, "Should return non-null");
  assert.ok(Array.isArray(fm.tags), "tags should be an array");
  assert.ok(fm.tags.includes("auth"), "tags should include 'auth'");
  assert.ok(fm.tags.includes("security"), "tags should include 'security'");
  assert.ok(fm.tags.includes("jwt"), "tags should include 'jwt'");
});

// Test 9: scoreEntry — matching tool → score > 0
test("9. scoreEntry with matching tool returns score > 0", () => {
  const { scoreEntry } = requireModule();
  const fm = { tool: "git", category: "gotcha", tags: [], confidence: "medium" };
  const projectContext = { tools: ["git", "node"], tags: [] };
  const score = scoreEntry(fm, projectContext);
  assert.ok(score > 0, `score should be > 0, got ${score}`);
});

// Test 10: scoreEntry — no match → score 0
test("10. scoreEntry with no matching tool or tags returns score 0", () => {
  const { scoreEntry } = requireModule();
  const fm = { tool: "docker", category: "workflow", tags: [], confidence: "medium" };
  const projectContext = { tools: ["git", "node"], tags: [] };
  const score = scoreEntry(fm, projectContext);
  assert.strictEqual(score, 0, `score should be 0, got ${score}`);
});

// Test 11: scoreEntry — security category → baseline boost
test("11. scoreEntry with security category gets baseline boost", () => {
  const { scoreEntry } = requireModule();
  // Two entries with no tool match but different categories
  const fmSecurity = { tool: "nonexistent", category: "security", tags: [], confidence: "medium" };
  const fmOther = { tool: "nonexistent", category: "workflow", tags: [], confidence: "medium" };
  const projectContext = { tools: ["git"], tags: [] };
  const scoreWithSecurity = scoreEntry(fmSecurity, projectContext);
  const scoreWithoutSecurity = scoreEntry(fmOther, projectContext);
  assert.ok(
    scoreWithSecurity > scoreWithoutSecurity,
    `security score (${scoreWithSecurity}) should exceed non-security score (${scoreWithoutSecurity})`
  );
});

// Test 12: getRelevantKnowledge — with matching entries → returns sorted by score
test("12. getRelevantKnowledge with matching entries returns sorted by score", () => {
  const { home, cleanup } = createTempHome();
  try {
    const knowledgeDb = require("../../templates/hooks/knowledge-db");
    const dbPath = path.join(home, ".claude", "knowledge", "knowledge.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const mod = requireModule();
    const dir = createProjectDir({ git: true });
    try {
      // Open DB and insert entries inside withFakeHome so _migrateIfNeeded
      // uses the fake home (empty entries dir → no real entries imported)
      const entries = withFakeHome(home, () => {
        const db = knowledgeDb.openDb(dbPath);
        // High-scoring: tool 'git' match (+10) + category 'security' (+2) + confidence 'high' (+1) = 13
        knowledgeDb.insertEntry(db, {
          id: "high-scorer",
          created: new Date().toISOString(),
          tool: "git",
          category: "security",
          tags: "[]",
          confidence: "high",
          context_text: "High-scoring entry.",
          fix_text: "Apply the fix.",
        });
        // Low-scoring: tool no match, tag 'git' overlap (+3) + category 'gotcha' (+1) = 4
        knowledgeDb.insertEntry(db, {
          id: "low-scorer",
          created: new Date().toISOString(),
          tool: "python",
          category: "gotcha",
          tags: '["git"]',
          confidence: "medium",
          context_text: "Low-scoring entry.",
          fix_text: "Other fix.",
        });
        return mod.getRelevantKnowledge(dir);
      });
      assert.ok(entries.length >= 1, "Should return at least one entry");
      assert.ok(entries.length >= 2, "Should return both matching entries");
      assert.strictEqual(entries[0].fm.id, "high-scorer", "High-scorer should be first");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    cleanup();
  }
});

// Test 13: getRelevantKnowledge — no knowledge DB → returns []
test("13. getRelevantKnowledge with no knowledge DB returns empty array", () => {
  const { home, cleanup } = createTempHome();
  try {
    // No entries inserted — openDb creates empty DB, queryRelevant returns []
    // Open DB inside withFakeHome so _migrateIfNeeded uses fake home (no real entries)
    const mod = requireModule();
    const dir = createProjectDir({ git: true });
    try {
      const entries = withFakeHome(home, () => mod.getRelevantKnowledge(dir));
      assert.deepStrictEqual(entries, [], "Should return empty array when DB has no entries");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    cleanup();
  }
});

// Test 14: getRelevantKnowledge — no project context → returns []
test("14. getRelevantKnowledge with no project context returns empty array", () => {
  const { home, cleanup } = createTempHome();
  try {
    const knowledgeDb = require("../../templates/hooks/knowledge-db");
    const dbPath = path.join(home, ".claude", "knowledge", "knowledge.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const mod = requireModule();
    // Empty project dir — no context detected
    const dir = createProjectDir();
    try {
      const entries = withFakeHome(home, () => {
        const db = knowledgeDb.openDb(dbPath);
        knowledgeDb.insertEntry(db, {
          id: "git-entry",
          created: new Date().toISOString(),
          tool: "git",
          category: "gotcha",
          tags: "[]",
          confidence: "high",
          context_text: "Some entry.",
          fix_text: "Some fix.",
        });
        return mod.getRelevantKnowledge(dir);
      });
      assert.deepStrictEqual(entries, [], "Should return empty array when project context is empty");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    cleanup();
  }
});

// Test 15: Full hook via runHook — git project → outputs additionalContext with commits
test("15. runHook with git project outputs additionalContext", () => {
  const { home, cleanup } = createTempHome();
  try {
    const dir = createProjectDir({ git: true });
    try {
      // Initialize a real git repo with a commit so 'git log' succeeds
      const { spawnSync } = require("child_process");
      spawnSync("git", ["init"], { cwd: dir, stdio: "pipe" });
      spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "pipe" });
      spawnSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "pipe" });
      fs.writeFileSync(path.join(dir, "README.md"), "# Test\n");
      spawnSync("git", ["add", "."], { cwd: dir, stdio: "pipe" });
      spawnSync("git", ["commit", "-m", "initial commit"], { cwd: dir, stdio: "pipe" });

      const result = runHook(
        HOOK_MODULE,
        { session_id: "test-session-1", cwd: dir },
        { HOME: home, USERPROFILE: home }
      );

      assert.strictEqual(result.status, 0, "Hook should exit 0");
      assert.ok(result.json, "Should output valid JSON");
      assert.ok(result.json.hookSpecificOutput, "Should have hookSpecificOutput");
      assert.ok(
        typeof result.json.hookSpecificOutput.additionalContext === "string",
        "additionalContext should be a string"
      );
      assert.ok(
        result.json.hookSpecificOutput.additionalContext.includes("Recent commits"),
        "additionalContext should mention recent commits"
      );
      assert.ok(
        result.json.hookSpecificOutput.additionalContext.includes("initial commit"),
        "additionalContext should include the commit message"
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    cleanup();
  }
});

// Test 16: Full hook via runHook — with knowledge entries → injects matching entries
test("16. runHook with matching knowledge entries injects them into context", () => {
  const { home, cleanup } = createTempHome();
  try {
    createKnowledgeEntry(home, {
      id: "git-rebase-gotcha",
      tool: "git",
      category: "gotcha",
      tags: [],
      confidence: "high",
      context: "Always use --rebase when pulling to avoid merge commits.",
      fix: "git pull --rebase",
    });

    const dir = createProjectDir({ git: true });
    try {
      const { spawnSync } = require("child_process");
      spawnSync("git", ["init"], { cwd: dir, stdio: "pipe" });
      spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "pipe" });
      spawnSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "pipe" });
      fs.writeFileSync(path.join(dir, "file.txt"), "content\n");
      spawnSync("git", ["add", "."], { cwd: dir, stdio: "pipe" });
      spawnSync("git", ["commit", "-m", "add file"], { cwd: dir, stdio: "pipe" });

      const result = runHook(
        HOOK_MODULE,
        { session_id: "test-session-2", cwd: dir },
        { HOME: home, USERPROFILE: home }
      );

      assert.strictEqual(result.status, 0, "Hook should exit 0");
      assert.ok(result.json, "Should output valid JSON");
      const ctx = result.json.hookSpecificOutput.additionalContext;
      assert.ok(
        ctx.includes("Relevant knowledge entries"),
        "context should include knowledge entries section"
      );
      assert.ok(
        ctx.includes("rebase"),
        "context should include knowledge entry content"
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    cleanup();
  }
});

// Test 17: Full hook via runHook — malformed JSON → exits 0 with {}
test("17. runHook with malformed JSON on stdin exits 0 and outputs {}", () => {
  const { spawnSync } = require("child_process");
  const result = spawnSync("node", [HOOK_MODULE], {
    input: "this is not valid JSON }{",
    env: { ...process.env, CLAUDE_HOOK_SOURCE: "test" },
    timeout: 10000,
    encoding: "utf8",
  });

  assert.strictEqual(result.status, 0, "Hook should exit 0 even with malformed input");

  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    assert.fail("Hook should output valid JSON even on error");
  }
  assert.deepStrictEqual(parsed, {}, "Output should be empty object {}");
});

// Test 18: FTS5 boost surfaces entries matching query content
test("18. FTS5 boost surfaces entries matching query content", () => {
  const { home, cleanup } = createTempHome();
  try {
    const knowledgeDb = require("../../templates/hooks/knowledge-db");
    const dbPath = path.join(home, ".claude", "knowledge", "knowledge.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const mod = requireModule();
    const dir = createProjectDir({ git: true });
    try {
      const entries = withFakeHome(home, () => {
        const db = knowledgeDb.openDb(dbPath);
        // Entry whose content mentions "git" repeatedly (should get FTS5 boost)
        knowledgeDb.insertEntry(db, {
          id: "git-content-match",
          created: new Date().toISOString(),
          tool: "git",
          category: "gotcha",
          tags: "[]",
          confidence: "high",
          context_text: "git rebase git pull git push — always use git with caution.",
          fix_text: "git pull --rebase",
        });
        return mod.getRelevantKnowledge(dir);
      });
      assert.ok(entries.length >= 1, "Should return at least one entry");
      assert.strictEqual(entries[0].fm.id, "git-content-match", "Content-matched entry should be returned");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    cleanup();
  }
});

// Test 19: FTS5 surfaces zero-tag-score entries via content match
test("19. FTS5 surfaces zero-tag-score entries via content match", () => {
  const { home, cleanup } = createTempHome();
  try {
    const knowledgeDb = require("../../templates/hooks/knowledge-db");
    const dbPath = path.join(home, ".claude", "knowledge", "knowledge.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    // Create the project dir first so we know its name
    const dir = createProjectDir({ git: true });
    const projectName = path.basename(dir);

    const mod = requireModule();
    try {
      const entries = withFakeHome(home, () => {
        const db = knowledgeDb.openDb(dbPath);
        // Entry with tool "docker" — no match for a git-only project (tag score = 0)
        // but content mentions the project name multiple times for FTS5 boost
        knowledgeDb.insertEntry(db, {
          id: "zero-tag-fts-match",
          created: new Date().toISOString(),
          tool: "docker",
          category: "workflow",
          tags: "[]",
          confidence: "medium",
          context_text: `${projectName} ${projectName} ${projectName} — this entry is about this specific project.`,
          fix_text: "Use project-specific config.",
        });
        return mod.getRelevantKnowledge(dir);
      });
      // FTS5 should boost this entry since project name appears in content
      assert.ok(entries.length >= 1, "FTS5 boost should surface the zero-tag-score entry");
      assert.strictEqual(entries[0].fm.id, "zero-tag-fts-match", "The content-matched entry should be returned");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    cleanup();
  }
});

// Test 20: knowledge retrieval works via SQLite without bm25 module
test("20. knowledge retrieval works via SQLite (no bm25 dependency)", () => {
  // Verifies that getRelevantKnowledge returns matching entries using the
  // DB-backed implementation that no longer depends on the bm25 module.
  const { home, cleanup } = createTempHome();
  try {
    const knowledgeDb = require("../../templates/hooks/knowledge-db");
    const dbPath = path.join(home, ".claude", "knowledge", "knowledge.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const mod = requireModule();
    const dir = createProjectDir({ git: true });
    try {
      const entries = withFakeHome(home, () => {
        const db = knowledgeDb.openDb(dbPath);
        knowledgeDb.insertEntry(db, {
          id: "sqlite-entry",
          created: new Date().toISOString(),
          tool: "git",
          category: "gotcha",
          tags: "[]",
          confidence: "high",
          context_text: "SQLite-backed retrieval test.",
          fix_text: "No fix needed.",
        });
        return mod.getRelevantKnowledge(dir);
      });
      assert.ok(entries.length >= 1, "Should return entries from SQLite DB");
      assert.strictEqual(entries[0].fm.id, "sqlite-entry", "Should return the inserted entry");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    cleanup();
  }
});

// Test 21: source_project penalty reduces score for foreign entries
test("21. source_project penalty reduces score for foreign entries", () => {
  const { scoreEntry } = requireModule();
  const fm = { tool: "git", category: "gotcha", tags: [], confidence: "high", source_project: "other-project" };
  const projectContext = { tools: ["git"], tags: [], projectName: "my-project" };
  const scoreWithPenalty = scoreEntry(fm, projectContext);
  // Without penalty: tool match (+10) + gotcha (+1) + high (+1) = 12
  // With penalty: 12 - 3 = 9
  assert.strictEqual(scoreWithPenalty, 9, `Score should be 9 (12 - 3 penalty), got ${scoreWithPenalty}`);
});

// Test 22: source_project matching current project has no penalty
test("22. source_project matching current project has no penalty", () => {
  const { scoreEntry } = requireModule();
  const fm = { tool: "git", category: "gotcha", tags: [], confidence: "high", source_project: "my-project" };
  const projectContext = { tools: ["git"], tags: [], projectName: "my-project" };
  const score = scoreEntry(fm, projectContext);
  // No penalty: tool match (+10) + gotcha (+1) + high (+1) = 12
  assert.strictEqual(score, 12, `Score should be 12 with no penalty, got ${score}`);
});


// Test 23: extractSalientTerms — extracts meaningful terms, skips stopwords
test("23. extractSalientTerms extracts meaningful terms from Current Work text", () => {
  const { extractSalientTerms } = requireModule();
  const text = "Fixed claude-loop task-advance bug and ran dogfood v3 on vnse project";
  const terms = extractSalientTerms(text);
  assert.ok(terms.includes("claude-loop"), "should include claude-loop");
  assert.ok(terms.includes("task-advance"), "should include task-advance");
  assert.ok(terms.includes("bug"), "should include bug");
  assert.ok(terms.includes("dogfood"), "should include dogfood");
  assert.ok(terms.includes("vnse"), "should include vnse");
  assert.ok(terms.includes("project"), "should include project");
  // Stopwords should be filtered
  assert.ok(!terms.includes("and"), "should not include stopword 'and'");
  assert.ok(!terms.includes("the"), "should not include stopword 'the'");
});

// Test 24: extractSalientTerms — empty/null input returns empty array
test("24. extractSalientTerms returns empty array for empty input", () => {
  const { extractSalientTerms } = requireModule();
  assert.deepStrictEqual(extractSalientTerms(""), []);
  assert.deepStrictEqual(extractSalientTerms(null), []);
  assert.deepStrictEqual(extractSalientTerms(undefined), []);
});

// Test 25: extractSalientTerms — respects maxTerms limit
test("25. extractSalientTerms respects maxTerms limit", () => {
  const { extractSalientTerms } = requireModule();
  const text = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima";
  const terms = extractSalientTerms(text, 3);
  assert.strictEqual(terms.length, 3, "should return exactly 3 terms");
});

// Test 26: extractSalientTerms — deduplicates tokens
test("26. extractSalientTerms deduplicates repeated tokens", () => {
  const { extractSalientTerms } = requireModule();
  const text = "hook hook hook testing testing testing";
  const terms = extractSalientTerms(text);
  const hookCount = terms.filter(t => t === "hook").length;
  assert.strictEqual(hookCount, 1, "should only include 'hook' once");
});

// Test 27: getRelevantKnowledge returns empty array when queryRelevant returns error status
test("27. getRelevantKnowledge returns empty array when queryRelevant returns error status", () => {
  // Arrange: create a DB with a broken schema (drop entries table) so queryRelevant returns { status: "error" }
  const { home, cleanup } = createTempHome();
  try {
    const knowledgeDb = require("../../templates/hooks/knowledge-db");
    const dbPath = path.join(home, ".claude", "knowledge", "knowledge.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const mod = requireModule();
    const dir = createProjectDir({ git: true });
    try {
      const entries = withFakeHome(home, () => {
        // Open a valid DB first so the file exists
        const db = knowledgeDb.openDb(dbPath);
        // Drop the entries table to force queryRelevant to return { status: "error" }
        db.prepare("DROP TABLE IF EXISTS entries").run();
        db.prepare("DROP TABLE IF EXISTS knowledge_fts").run();
        db.close();
        // Now call getRelevantKnowledge — it opens the DB file and queries it
        return mod.getRelevantKnowledge(dir);
      });
      assert.deepStrictEqual(entries, [], "Should return empty array when queryRelevant returns error status");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    cleanup();
  }
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed (${passed + failed} total)`);

if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) {
    console.log(`  \u2717 ${f.name}: ${f.error}`);
  }
}

process.exit(failed > 0 ? 1 : 0);
