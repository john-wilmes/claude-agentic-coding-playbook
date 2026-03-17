#!/usr/bin/env node
/**
 * Tests for skill-guard.js — PreToolUse hook for the Skill tool.
 *
 * Covers:
 *   - Non-Skill tool calls pass through
 *   - Registered skills pass
 *   - Unregistered skills are denied
 *   - SKILL_GUARD_ALLOWLIST env var
 *   - Qualified name normalization (e.g., "ms-office-suite:pdf" → "pdf")
 *   - Repeat invocation warnings
 *   - Malformed/empty input passes gracefully
 */

"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { createTempHome, runHook } = require("./test-helpers");

const HOOK = path.resolve(__dirname, "..", "..", "templates", "hooks", "skill-guard.js");

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message });
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}

/**
 * Helper: create a temp HOME with skill directories installed.
 * @param {string[]} skillNames - Directory names to create under ~/.claude/skills/
 * @returns {{ home, cleanup }}
 */
function setupSkills(skillNames = []) {
  const { home, claudeDir, cleanup } = createTempHome();
  const skillsDir = path.join(claudeDir, "skills");
  fs.mkdirSync(skillsDir, { recursive: true });
  for (const name of skillNames) {
    fs.mkdirSync(path.join(skillsDir, name));
  }
  return { home, cleanup };
}

/**
 * Helper: run skill-guard with a Skill tool event.
 */
function runSkillGuard(skillName, sessionId, home, extraEnv = {}) {
  return runHook(
    HOOK,
    {
      tool_name: "Skill",
      tool_input: { skill: skillName },
      session_id: sessionId,
    },
    { HOME: home, ...extraEnv }
  );
}

/**
 * Clean up any state files left by tests.
 */
function cleanStateFile(sessionId) {
  try {
    fs.unlinkSync(path.join(os.tmpdir(), `skill-guard-${sessionId}.json`));
  } catch {}
  try {
    fs.unlinkSync(path.join(os.tmpdir(), `skill-active-${sessionId}.json`));
  } catch {}
}

/**
 * Helper: create a SKILL.md with allowed-tools frontmatter in a skill directory.
 */
function createSkillMd(home, skillName, allowedTools) {
  const skillDir = path.join(home, ".claude", "skills", skillName);
  fs.mkdirSync(skillDir, { recursive: true });
  const content = `---
allowed-tools: ${allowedTools.join(", ")}
---
# ${skillName}

Skill description.
`;
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), content);
}

/**
 * Helper: run skill-guard with a non-Skill tool event.
 */
function runToolGuard(toolName, sessionId, home) {
  return runHook(
    HOOK,
    {
      tool_name: toolName,
      tool_input: {},
      session_id: sessionId,
    },
    { HOME: home }
  );
}

// ---------------------------------------------------------------------------
console.log("\nskill-guard.js tests\n");

// --- Pass-through tests ---

test("non-Skill tool calls pass through", () => {
  const { home, cleanup } = setupSkills(["continue"]);
  try {
    const result = runHook(
      HOOK,
      { tool_name: "Bash", tool_input: { command: "ls" }, session_id: "t1" },
      { HOME: home }
    );
    assert.strictEqual(result.status, 0);
    assert.deepStrictEqual(result.json, {});
  } finally {
    cleanup();
    cleanStateFile("t1");
  }
});

test("empty skill name passes through", () => {
  const { home, cleanup } = setupSkills(["continue"]);
  try {
    const result = runHook(
      HOOK,
      { tool_name: "Skill", tool_input: {}, session_id: "t2" },
      { HOME: home }
    );
    assert.strictEqual(result.status, 0);
    assert.deepStrictEqual(result.json, {});
  } finally {
    cleanup();
    cleanStateFile("t2");
  }
});

test("malformed JSON input passes gracefully", () => {
  const { runHookRaw } = require("./test-helpers");
  const result = runHookRaw(HOOK, "not valid json {{{");
  assert.strictEqual(result.status, 0);
  assert.deepStrictEqual(result.json, {});
});

// --- Registered skill tests ---

test("registered skill passes on first invocation", () => {
  const { home, cleanup } = setupSkills(["continue", "checkpoint"]);
  const sid = "t-reg-1";
  try {
    const result = runSkillGuard("continue", sid, home);
    assert.strictEqual(result.status, 0);
    assert.deepStrictEqual(result.json, {});
  } finally {
    cleanup();
    cleanStateFile(sid);
  }
});

// --- Unregistered skill tests ---

test("unregistered skill is denied", () => {
  const { home, cleanup } = setupSkills(["continue"]);
  const sid = "t-unreg-1";
  try {
    const result = runSkillGuard("nonexistent-skill", sid, home);
    assert.strictEqual(result.status, 0);
    const decision =
      result.json &&
      result.json.hookSpecificOutput &&
      result.json.hookSpecificOutput.permissionDecision;
    assert.strictEqual(decision, "deny", "Should deny unregistered skill");
    const reason = result.json.hookSpecificOutput.permissionDecisionReason;
    assert.ok(
      reason.includes("nonexistent-skill"),
      "Deny reason should mention the skill name"
    );
    assert.ok(
      reason.includes("not a registered skill"),
      "Deny reason should explain why"
    );
  } finally {
    cleanup();
    cleanStateFile(sid);
  }
});

test("deny message lists registered skills", () => {
  const { home, cleanup } = setupSkills(["alpha", "beta"]);
  const sid = "t-unreg-2";
  try {
    const result = runSkillGuard("gamma", sid, home);
    const reason = result.json.hookSpecificOutput.permissionDecisionReason;
    assert.ok(reason.includes("alpha"), "Should list registered skill alpha");
    assert.ok(reason.includes("beta"), "Should list registered skill beta");
  } finally {
    cleanup();
    cleanStateFile(sid);
  }
});

// --- SKILL_GUARD_ALLOWLIST tests ---

test("SKILL_GUARD_ALLOWLIST allows extra skills", () => {
  const { home, cleanup } = setupSkills([]);
  const sid = "t-allow-1";
  try {
    const result = runSkillGuard("my-custom-skill", sid, home, {
      SKILL_GUARD_ALLOWLIST: "my-custom-skill,another-skill",
    });
    assert.strictEqual(result.status, 0);
    assert.deepStrictEqual(result.json, {});
  } finally {
    cleanup();
    cleanStateFile(sid);
  }
});

test("SKILL_GUARD_ALLOWLIST handles whitespace", () => {
  const { home, cleanup } = setupSkills([]);
  const sid = "t-allow-2";
  try {
    const result = runSkillGuard("spaced-skill", sid, home, {
      SKILL_GUARD_ALLOWLIST: " spaced-skill , other ",
    });
    assert.strictEqual(result.status, 0);
    assert.deepStrictEqual(result.json, {});
  } finally {
    cleanup();
    cleanStateFile(sid);
  }
});

// --- Qualified name normalization tests ---

test("qualified name 'suite:skill' matches installed 'skill'", () => {
  const { home, cleanup } = setupSkills(["pdf"]);
  const sid = "t-qual-1";
  try {
    const result = runSkillGuard("ms-office-suite:pdf", sid, home);
    assert.strictEqual(result.status, 0);
    assert.deepStrictEqual(result.json, {});
  } finally {
    cleanup();
    cleanStateFile(sid);
  }
});

test("qualified name denied when normalized name not registered", () => {
  const { home, cleanup } = setupSkills(["continue"]);
  const sid = "t-qual-2";
  try {
    const result = runSkillGuard("suite:unknown", sid, home);
    const decision =
      result.json.hookSpecificOutput.permissionDecision;
    assert.strictEqual(decision, "deny");
  } finally {
    cleanup();
    cleanStateFile(sid);
  }
});

// --- Repeat invocation detection ---

test("second invocation of same skill produces warning", () => {
  const { home, cleanup } = setupSkills(["checkpoint"]);
  const sid = "t-repeat-1";
  try {
    // First invocation — should pass
    const r1 = runSkillGuard("checkpoint", sid, home);
    assert.deepStrictEqual(r1.json, {}, "First call should pass cleanly");

    // Second invocation — should warn
    const r2 = runSkillGuard("checkpoint", sid, home);
    assert.strictEqual(r2.status, 0);
    const ctx =
      r2.json &&
      r2.json.hookSpecificOutput &&
      r2.json.hookSpecificOutput.additionalContext;
    assert.ok(ctx, "Second call should produce additionalContext warning");
    assert.ok(
      ctx.includes("2 times"),
      "Warning should mention invocation count"
    );
    assert.ok(
      ctx.includes("checkpoint"),
      "Warning should mention skill name"
    );
  } finally {
    cleanup();
    cleanStateFile(sid);
  }
});

test("different skills do not trigger repeat warning", () => {
  const { home, cleanup } = setupSkills(["alpha", "beta"]);
  const sid = "t-repeat-2";
  try {
    const r1 = runSkillGuard("alpha", sid, home);
    assert.deepStrictEqual(r1.json, {});

    const r2 = runSkillGuard("beta", sid, home);
    assert.deepStrictEqual(r2.json, {}, "Different skill should not warn");
  } finally {
    cleanup();
    cleanStateFile(sid);
  }
});

test("different sessions do not share repeat state", () => {
  const { home, cleanup } = setupSkills(["continue"]);
  const sidA = "t-repeat-3a";
  const sidB = "t-repeat-3b";
  try {
    runSkillGuard("continue", sidA, home);
    const r2 = runSkillGuard("continue", sidB, home);
    assert.deepStrictEqual(
      r2.json,
      {},
      "Different session should not trigger repeat warning"
    );
  } finally {
    cleanup();
    cleanStateFile(sidA);
    cleanStateFile(sidB);
  }
});

// --- No skills directory ---

test("missing ~/.claude/skills/ directory denies all skills", () => {
  // Create a temp home WITHOUT a skills directory
  const { home, cleanup } = createTempHome();
  const sid = "t-nodir-1";
  try {
    const result = runSkillGuard("anything", sid, home);
    const decision =
      result.json.hookSpecificOutput.permissionDecision;
    assert.strictEqual(
      decision,
      "deny",
      "Should deny when skills directory is missing"
    );
  } finally {
    cleanup();
    cleanStateFile(sid);
  }
});

test("missing skills dir with SKILL_GUARD_ALLOWLIST still allows listed skills", () => {
  const { home, cleanup } = createTempHome();
  const sid = "t-nodir-2";
  try {
    const result = runSkillGuard("allowed-one", sid, home, {
      SKILL_GUARD_ALLOWLIST: "allowed-one",
    });
    assert.deepStrictEqual(result.json, {});
  } finally {
    cleanup();
    cleanStateFile(sid);
  }
});

// --- Allowed-tools enforcement tests ---

test("Skill invocation saves active skill with allowed-tools", () => {
  const { home, cleanup } = setupSkills(["deploy"]);
  const sid = "t-at-1";
  createSkillMd(home, "deploy", ["Bash", "Read"]);
  try {
    const r = runSkillGuard("deploy", sid, home);
    assert.deepStrictEqual(r.json, {});
    // Verify active skill file was written
    const active = JSON.parse(
      fs.readFileSync(
        path.join(os.tmpdir(), `skill-active-${sid}.json`),
        "utf8"
      )
    );
    assert.strictEqual(active.skill, "deploy");
    assert.deepStrictEqual(active.allowedTools, ["Bash", "Read"]);
  } finally {
    cleanup();
    cleanStateFile(sid);
  }
});

test("non-Skill tool allowed by active skill's allowed-tools passes", () => {
  const { home, cleanup } = setupSkills(["deploy"]);
  const sid = "t-at-2";
  createSkillMd(home, "deploy", ["Bash", "Read"]);
  try {
    // Activate the skill first
    runSkillGuard("deploy", sid, home);
    // Now call an allowed tool
    const r = runToolGuard("Bash", sid, home);
    assert.strictEqual(r.status, 0);
    assert.deepStrictEqual(r.json, {});
  } finally {
    cleanup();
    cleanStateFile(sid);
  }
});

test("non-Skill tool NOT in allowed-tools gets advisory warning", () => {
  const { home, cleanup } = setupSkills(["deploy"]);
  const sid = "t-at-3";
  createSkillMd(home, "deploy", ["Bash"]);
  try {
    runSkillGuard("deploy", sid, home);
    const r = runToolGuard("Grep", sid, home);
    assert.strictEqual(r.status, 0);
    const ctx =
      r.json &&
      r.json.hookSpecificOutput &&
      r.json.hookSpecificOutput.additionalContext;
    assert.ok(ctx, "Should produce an advisory warning");
    assert.ok(ctx.includes("Grep"), "Warning should mention the blocked tool");
    assert.ok(ctx.includes("deploy"), "Warning should mention the active skill");
  } finally {
    cleanup();
    cleanStateFile(sid);
  }
});

test("wildcard pattern in allowed-tools matches tool prefix", () => {
  const { home, cleanup } = setupSkills(["research"]);
  const sid = "t-at-4";
  createSkillMd(home, "research", ["mcp__*", "Read"]);
  try {
    runSkillGuard("research", sid, home);
    // mcp__ tool should match the wildcard
    const r1 = runToolGuard("mcp__serena__find_symbol", sid, home);
    assert.deepStrictEqual(r1.json, {}, "Wildcard should allow mcp__ tools");
    // Non-matching tool should warn
    const r2 = runToolGuard("Bash", sid, home);
    const ctx =
      r2.json &&
      r2.json.hookSpecificOutput &&
      r2.json.hookSpecificOutput.additionalContext;
    assert.ok(ctx, "Bash should not match mcp__* or Read");
  } finally {
    cleanup();
    cleanStateFile(sid);
  }
});

test("no active skill means non-Skill tools pass without checks", () => {
  const { home, cleanup } = setupSkills(["continue"]);
  const sid = "t-at-5";
  try {
    // No skill invoked — call a tool directly
    const r = runToolGuard("Bash", sid, home);
    assert.strictEqual(r.status, 0);
    assert.deepStrictEqual(r.json, {});
  } finally {
    cleanup();
    cleanStateFile(sid);
  }
});

test("skill with empty allowed-tools does not restrict tools", () => {
  const { home, cleanup } = setupSkills(["simple"]);
  const sid = "t-at-6";
  createSkillMd(home, "simple", []);
  try {
    runSkillGuard("simple", sid, home);
    const r = runToolGuard("Grep", sid, home);
    assert.strictEqual(r.status, 0);
    assert.deepStrictEqual(r.json, {}, "Empty allowed-tools should not restrict");
  } finally {
    cleanup();
    cleanStateFile(sid);
  }
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failures.length > 0) {
  console.log("Failures:");
  for (const f of failures) {
    console.log(`  ${f.name}: ${f.error}`);
  }
  process.exit(1);
}
