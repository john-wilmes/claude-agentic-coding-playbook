#!/usr/bin/env node
// Integration tests for subagent-context.js (SubagentStart hook).
// Zero dependencies — uses only Node built-ins + local test-helpers.
//
// Run: node tests/hooks/subagent-context.test.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { runHook, runHookRaw } = require("./test-helpers");

// Resolve hook path relative to repo root
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const HOOK = path.join(REPO_ROOT, "templates", "hooks", "subagent-context.js");

// Import pure functions for unit tests
const {
  extractQualityGatesSection,
  extractTestCommand,
  buildAdditionalContext,
  detectToolHints,
} = require(HOOK);

// ─── Test runner ─────────────────────────────────────────────────────────────

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

// ─── Unit tests: extractQualityGatesSection ───────────────────────────────────

console.log("\nsubagent-context.js:");

test("1. extractQualityGatesSection: extracts section between ## Quality Gates and next ## heading", () => {
  const content = `# Project\n\n## Quality Gates\n\n- Test: \`npm test\`\n- Lint: \`eslint src/\`\n\n## Architecture\n\nSome architecture notes.\n`;
  const section = extractQualityGatesSection(content);
  assert.ok(section !== null, "Should return non-null for present section");
  assert.ok(section.includes("npm test"), "Should include the test command line");
  assert.ok(!section.includes("## Architecture"), "Should not include the next heading");
});

test("2. extractQualityGatesSection: returns null when no Quality Gates section", () => {
  const content = `# Project\n\n## Architecture\n\nSome notes.\n\n## Usage\n\nHow to use it.\n`;
  const section = extractQualityGatesSection(content);
  assert.strictEqual(section, null);
});

test("3. extractQualityGatesSection: returns null for empty section body", () => {
  const content = `# Project\n\n## Quality Gates\n\n## Architecture\n\nSome notes.\n`;
  const section = extractQualityGatesSection(content);
  assert.strictEqual(section, null);
});

test("4. extractQualityGatesSection: handles section at end of file (no trailing ## heading)", () => {
  const content = `# Project\n\n## Quality Gates\n\n- Test: \`npm test\`\n`;
  const section = extractQualityGatesSection(content);
  assert.ok(section !== null, "Should return non-null when section is at end of file");
  assert.ok(section.includes("npm test"), "Should include the test command line");
});

// ─── Unit tests: extractTestCommand ──────────────────────────────────────────

test("5. extractTestCommand: finds Test: `npm test` format", () => {
  const sectionBody = `- Test: \`npm test\`\n- Lint: \`eslint src/\`\n`;
  const cmd = extractTestCommand(sectionBody);
  assert.strictEqual(cmd, "npm test");
});

test("6. extractTestCommand: finds lowercase test: `pytest` format", () => {
  const sectionBody = `- test: \`pytest -x\`\n`;
  const cmd = extractTestCommand(sectionBody);
  assert.strictEqual(cmd, "pytest -x");
});

test("7. extractTestCommand: returns null when no test command in section", () => {
  const sectionBody = `- Lint: \`eslint src/\`\n- Format: \`prettier --check .\`\n`;
  const cmd = extractTestCommand(sectionBody);
  assert.strictEqual(cmd, null);
});

// ─── Unit tests: buildAdditionalContext ──────────────────────────────────────

test("8. buildAdditionalContext: returns loop warning when isLoopSession is true", () => {
  const result = buildAdditionalContext({ isLoopSession: true, testCommand: null });
  assert.ok(result !== null, "Should return non-null string");
  assert.ok(result.includes("claude-loop"), "Should mention claude-loop");
  assert.ok(result.includes("summarize"), "Should mention summarizing partial work");
});

test("9. buildAdditionalContext: returns quality gate reminder when testCommand provided", () => {
  const result = buildAdditionalContext({ isLoopSession: false, testCommand: "npm test" });
  assert.ok(result !== null, "Should return non-null string");
  assert.ok(result.includes("npm test"), "Should include the test command");
  assert.ok(result.includes("Quality gates"), "Should mention quality gates");
});

test("10. buildAdditionalContext: returns both when both are present", () => {
  const result = buildAdditionalContext({ isLoopSession: true, testCommand: "pytest" });
  assert.ok(result !== null, "Should return non-null string");
  assert.ok(result.includes("claude-loop"), "Should mention claude-loop");
  assert.ok(result.includes("pytest"), "Should include the test command");
});

test("11. buildAdditionalContext: returns null when neither is present", () => {
  const result = buildAdditionalContext({ isLoopSession: false, testCommand: null });
  assert.strictEqual(result, null);
});

// ─── Integration tests ────────────────────────────────────────────────────────

test("12. Hook outputs {} for Explore agent type", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-test-explore-"));
  try {
    const result = runHook(HOOK, {
      session_id: "s1",
      agent_type: "Explore",
      cwd: tmpDir,
    }, { CLAUDE_LOOP_PID: "" });
    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.ok(result.json, "Should output valid JSON");
    assert.deepStrictEqual(result.json, {}, "Should output {} for Explore agent");
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test("13. Hook outputs {} for Plan agent type", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-test-plan-"));
  try {
    const result = runHook(HOOK, {
      session_id: "s2",
      agent_type: "Plan",
      cwd: tmpDir,
    }, { CLAUDE_LOOP_PID: "" });
    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.ok(result.json, "Should output valid JSON");
    assert.deepStrictEqual(result.json, {}, "Should output {} for Plan agent");
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test("14. Hook outputs {} when no CLAUDE.md exists", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-test-no-claude-"));
  try {
    const result = runHook(HOOK, {
      session_id: "s3",
      agent_type: "general-purpose",
      cwd: tmpDir,
    }, { CLAUDE_LOOP_PID: "" });
    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.deepStrictEqual(result.json, {}, "Should output {} when no CLAUDE.md");
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test("15. Hook injects quality gate context when CLAUDE.md has test command", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-test-gates-"));
  try {
    fs.writeFileSync(
      path.join(tmpDir, "CLAUDE.md"),
      "# Project\n\n## Quality Gates\n\n- Test: `npm test`\n\n## Next\n\nOther content.\n"
    );
    const result = runHook(HOOK, {
      session_id: "s4",
      agent_type: "general-purpose",
      cwd: tmpDir,
    });
    assert.strictEqual(result.status, 0, "Should exit 0");
    assert.ok(result.json, "Should output valid JSON");
    assert.ok(result.json.hookSpecificOutput, "Should have hookSpecificOutput");
    const ctx = result.json.hookSpecificOutput.additionalContext;
    assert.ok(typeof ctx === "string", "additionalContext should be a string");
    assert.ok(ctx.includes("npm test"), `Should include test command, got: ${ctx}`);
    assert.ok(ctx.includes("Quality gates"), `Should mention quality gates, got: ${ctx}`);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test("16. Hook injects loop warning when CLAUDE_LOOP_PID is set", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-test-loop-"));
  try {
  const result = runHook(
    HOOK,
    { session_id: "s5", agent_type: "general-purpose", cwd: tmpDir },
    { CLAUDE_LOOP_PID: "12345" }
  );
  assert.strictEqual(result.status, 0, "Should exit 0");
  assert.ok(result.json, "Should output valid JSON");
  assert.ok(result.json.hookSpecificOutput, "Should have hookSpecificOutput");
  const ctx = result.json.hookSpecificOutput.additionalContext;
  assert.ok(typeof ctx === "string", "additionalContext should be a string");
  assert.ok(ctx.includes("claude-loop"), `Should mention claude-loop, got: ${ctx}`);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test("17. Hook outputs {} on malformed JSON input", () => {
  const result = runHookRaw(HOOK, "not valid json");
  assert.strictEqual(result.status, 0, "Should exit 0 on parse error");
  assert.deepStrictEqual(result.json, {}, "Should output {} on parse error");
});

// ─── Unit tests: detectToolHints ─────────────────────────────────────────────

test("18. detectToolHints: 'where is X used' triggers mma hint", () => {
  const hints = detectToolHints("Find where is processAppointment used in the codebase");
  assert.strictEqual(hints.length, 1);
  assert.ok(hints[0].includes("mcp__mma__"), "Should suggest mma tools");
});

test("19. detectToolHints: 'what breaks if I change' triggers mma hint", () => {
  const hints = detectToolHints("What breaks if I rename this function?");
  assert.strictEqual(hints.length, 1);
  assert.ok(hints[0].includes("get_blast_radius"), "Should mention blast radius tool");
});

test("20. detectToolHints: 'pull request' triggers gh hint", () => {
  const hints = detectToolHints("Look at the pull request review comments");
  assert.strictEqual(hints.length, 1);
  assert.ok(hints[0].includes("gh"), "Should suggest gh");
});

test("21. detectToolHints: prompt with both structure and history triggers both", () => {
  const hints = detectToolHints("Find what calls this function and who changed it last week");
  assert.strictEqual(hints.length, 2, "Should return both hints");
});

test("22. detectToolHints: generic prompt triggers no hints", () => {
  const hints = detectToolHints("Fix the bug in the login form");
  assert.strictEqual(hints.length, 0);
});

test("23. detectToolHints: 'safe to remove' triggers mma hint", () => {
  const hints = detectToolHints("Is it safe to remove this helper function?");
  assert.strictEqual(hints.length, 1);
  assert.ok(hints[0].includes("mcp__mma__"));
});

test("24. detectToolHints: 'who changed' triggers gh hint", () => {
  const hints = detectToolHints("who changed the appointment model last week?");
  assert.strictEqual(hints.length, 1);
  assert.ok(hints[0].includes("gh"));
});

test("25. detectToolHints: 'how does X get called' triggers mma hint", () => {
  const hints = detectToolHints("how does handleFax get called?");
  assert.strictEqual(hints.length, 1);
  assert.ok(hints[0].includes("mcp__mma__"));
});

test("26. detectToolHints: 'when was X introduced' triggers gh hint", () => {
  const hints = detectToolHints("when was this endpoint introduced?");
  assert.strictEqual(hints.length, 1);
  assert.ok(hints[0].includes("gh"));
});

test("27. detectToolHints: 'find all usages' triggers mma hint", () => {
  const hints = detectToolHints("find all usages of this interface");
  assert.strictEqual(hints.length, 1);
  assert.ok(hints[0].includes("mcp__mma__"));
});

test("28. detectToolHints: 'what would break' triggers mma hint", () => {
  const hints = detectToolHints("what would break if I delete this export?");
  assert.strictEqual(hints.length, 1);
  assert.ok(hints[0].includes("mcp__mma__"));
});

test("29. buildAdditionalContext: includes tool hints when prompt has signals", () => {
  const result = buildAdditionalContext({ isLoopSession: false, testCommand: null, prompt: "where is processAppointment used?" });
  assert.ok(result !== null);
  assert.ok(result.includes("mcp__mma__"), "Should include mma hint");
});

test("30. buildAdditionalContext: no tool hints for empty prompt", () => {
  const result = buildAdditionalContext({ isLoopSession: false, testCommand: null, prompt: "" });
  assert.strictEqual(result, null);
});

// ─── Integration: tool hints via hook ───────────────────────────────────────

test("31. Hook injects mma hint when prompt asks about usage", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-test-mma-"));
  try {
    const result = runHook(HOOK, {
      session_id: "s6",
      agent_type: "general-purpose",
      cwd: tmpDir,
      prompt: "Find where is processAppointment used in integrator-service",
    }, { CLAUDE_LOOP_PID: "" });
    assert.strictEqual(result.status, 0);
    assert.ok(result.json.hookSpecificOutput, "Should have hookSpecificOutput");
    const ctx = result.json.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes("mcp__mma__"), `Should include mma hint, got: ${ctx}`);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test("32. Hook injects gh hint when prompt asks about PR", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-test-gh-"));
  try {
    const result = runHook(HOOK, {
      session_id: "s7",
      agent_type: "general-purpose",
      cwd: tmpDir,
      prompt: "Look at the pull request review comments for this change",
    }, { CLAUDE_LOOP_PID: "" });
    assert.strictEqual(result.status, 0);
    assert.ok(result.json.hookSpecificOutput, "Should have hookSpecificOutput");
    const ctx = result.json.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes("gh"), `Should include gh hint, got: ${ctx}`);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test("33. Hook outputs {} for generic prompt with no signals", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-test-generic-"));
  try {
    const result = runHook(HOOK, {
      session_id: "s8",
      agent_type: "general-purpose",
      cwd: tmpDir,
      prompt: "Fix the typo in the error message",
    }, { CLAUDE_LOOP_PID: "" });
    assert.strictEqual(result.status, 0);
    assert.deepStrictEqual(result.json, {});
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
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
