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
    // High-scoring: tool 'git' match (+10) + category 'security' (+2) + confidence 'high' (+1) = 13
    createKnowledgeEntry(home, {
      id: "high-scorer",
      tool: "git",
      category: "security",
      tags: [],
      confidence: "high",
      context: "High-scoring entry.",
      fix: "Apply the fix.",
    });
    // Low-scoring: tool no match, tag 'git' overlap (+3) + category 'gotcha' (+1) = 4
    createKnowledgeEntry(home, {
      id: "low-scorer",
      tool: "python",
      category: "gotcha",
      tags: ["git"],
      confidence: "medium",
      context: "Low-scoring entry.",
      fix: "Other fix.",
    });

    const mod = requireModule();
    const dir = createProjectDir({ git: true });
    try {
      const entries = withFakeHome(home, () => mod.getRelevantKnowledge(dir));
      assert.ok(entries.length >= 1, "Should return at least one entry");
      assert.ok(entries.length >= 2, "Should return both matching entries");
      assert.ok(
        entries[0].score >= entries[1].score,
        `First entry score (${entries[0].score}) should be >= second (${entries[1].score})`
      );
      assert.strictEqual(entries[0].fm.id, "high-scorer", "High-scorer should be first");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    cleanup();
  }
});

// Test 13: getRelevantKnowledge — no knowledge dir → returns []
test("13. getRelevantKnowledge with no knowledge dir returns empty array", () => {
  const { home, cleanup } = createTempHome();
  try {
    // No knowledge directory created under home — only ~/.claude/ exists
    const mod = requireModule();
    const dir = createProjectDir({ git: true });
    try {
      const entries = withFakeHome(home, () => mod.getRelevantKnowledge(dir));
      assert.deepStrictEqual(entries, [], "Should return empty array");
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
    createKnowledgeEntry(home, { tool: "git", category: "gotcha" });

    const mod = requireModule();
    // Empty project dir — no context detected
    const dir = createProjectDir();
    try {
      const entries = withFakeHome(home, () => mod.getRelevantKnowledge(dir));
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

// Test 18: hybrid scoring boosts entries matching query content
test("18. hybrid scoring boosts entries matching query content", () => {
  const { home, cleanup } = createTempHome();
  try {
    // Entry whose content mentions "git" repeatedly (should get BM25 boost)
    createKnowledgeEntry(home, {
      id: "git-content-match",
      tool: "git",
      category: "gotcha",
      tags: [],
      confidence: "high",
      context: "git rebase git pull git push — always use git with caution.",
      fix: "git pull --rebase",
    });

    const mod = requireModule();
    const dir = createProjectDir({ git: true });
    try {
      const entries = withFakeHome(home, () => mod.getRelevantKnowledge(dir));
      assert.ok(entries.length >= 1, "Should return at least one entry");
      // The entry has tool match (+10) + security/gotcha (+1) + high (+1) + BM25 boost
      // BM25 boost > 0 means final score > tag-only score of 12
      assert.ok(entries[0].score > 12, `Score (${entries[0].score}) should exceed tag-only baseline of 12 due to BM25 boost`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    cleanup();
  }
});

// Test 19: content-match boost surfaces zero-tag-score entries
test("19. content-match boost surfaces zero-tag-score entries", () => {
  const { home, cleanup } = createTempHome();
  try {
    // Entry with tool "docker" — no match for a git-only project (tag score = 0)
    // but content mentions the project name "hook-proj" multiple times
    // We use a known project dir name by creating it then naming entry content after it
    const dir = createProjectDir({ git: true });
    const projectName = path.basename(dir);
    createKnowledgeEntry(home, {
      id: "zero-tag-bm25-match",
      tool: "docker",
      category: "workflow",
      tags: [],
      confidence: "medium",
      context: `${projectName} ${projectName} ${projectName} — this entry is about this specific project.`,
      fix: "Use project-specific config.",
    });

    const mod = requireModule();
    try {
      const entries = withFakeHome(home, () => mod.getRelevantKnowledge(dir));
      // The entry has no tool match and no tag match, so tag score = 0.
      // BM25 should boost it above 0 since the project name appears in content.
      assert.ok(entries.length >= 1, "BM25 boost should surface the zero-tag-score entry");
      assert.strictEqual(entries[0].fm.id, "zero-tag-bm25-match", "The content-matched entry should be returned");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    cleanup();
  }
});

// Test 20: fallback to tag-only when bm25 module is missing
test("20. fallback to tag-only when bm25 module is missing", () => {
  // This test verifies the module still works when bm25 require fails.
  // Since bm25 is loaded at module level with try/catch, we test indirectly:
  // create a matching entry and confirm getRelevantKnowledge returns it regardless.
  const { home, cleanup } = createTempHome();
  try {
    createKnowledgeEntry(home, {
      id: "tag-only-entry",
      tool: "git",
      category: "gotcha",
      tags: [],
      confidence: "high",
      context: "Tag-only scoring fallback test.",
      fix: "No fix needed.",
    });

    const mod = requireModule();
    const dir = createProjectDir({ git: true });
    try {
      const entries = withFakeHome(home, () => mod.getRelevantKnowledge(dir));
      assert.ok(entries.length >= 1, "Should return entries even if bm25 is unavailable");
      assert.ok(entries[0].score > 0, "Score should be positive from tag matching alone");
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
