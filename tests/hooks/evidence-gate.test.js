"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { runHook, runHookRaw } = require("./test-helpers");

const HOOK = path.resolve(__dirname, "../../templates/hooks/evidence-gate.js");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

console.log("evidence-gate.js tests:");

// --- Pass-through tests ---

test("passes through non-Write/Edit tools", () => {
  const result = runHook(HOOK, { tool_name: "Read", tool_input: {} });
  assert.strictEqual(result.status, 0);
  assert.deepStrictEqual(result.json, {});
});

test("passes through Write to non-findings/non-memory files", () => {
  const result = runHook(HOOK, {
    tool_name: "Write",
    tool_input: { file_path: "/tmp/random.md", content: "hello" },
  });
  assert.strictEqual(result.status, 0);
  assert.deepStrictEqual(result.json, {});
});

test("passes through Write to memory files that are not project_*.md", () => {
  const result = runHook(HOOK, {
    tool_name: "Write",
    tool_input: {
      file_path: "/home/user/.claude/projects/test/memory/feedback_test.md",
      content: "Root cause investigation determined that the issue was complex",
    },
  });
  assert.strictEqual(result.status, 0);
  assert.deepStrictEqual(result.json, {});
});

// --- FINDINGS.md deny tests ---

test("denies FINDINGS.md Write with Answer section but no evidence citations", () => {
  const result = runHook(HOOK, {
    tool_name: "Write",
    tool_input: {
      file_path: "/tmp/investigations/test/FINDINGS.md",
      content: "# Findings\n\n## Answer\n\nThe root cause is a race condition in the scheduler.",
    },
  });
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.json?.hookSpecificOutput?.permissionDecision, "deny");
  assert.ok(result.json?.hookSpecificOutput?.permissionDecisionReason?.includes("Evidence NNN"));
});

test("denies FINDINGS.md with Findings section but no citations", () => {
  const result = runHook(HOOK, {
    tool_name: "Write",
    tool_input: {
      file_path: "/tmp/investigations/test/FINDINGS.md",
      content: "# Report\n\n## Findings\n\nWe found the bug in the auth middleware.",
    },
  });
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.json?.hookSpecificOutput?.permissionDecision, "deny");
});

test("allows FINDINGS.md with proper evidence citations", () => {
  const result = runHook(HOOK, {
    tool_name: "Write",
    tool_input: {
      file_path: "/tmp/investigations/test/FINDINGS.md",
      content: "# Findings\n\n## Answer\n\nThe root cause is a race condition (Evidence 001). The scheduler locks are not held across the await boundary (Evidence 003).",
    },
  });
  assert.strictEqual(result.status, 0);
  assert.deepStrictEqual(result.json, {});
});

test("allows FINDINGS.md without Answer/Findings section (still scaffolding)", () => {
  const result = runHook(HOOK, {
    tool_name: "Write",
    tool_input: {
      file_path: "/tmp/investigations/test/FINDINGS.md",
      content: "---\ntags:\n  domain: []\n---\n# Investigation: TEST-001\n\n(Investigation in progress)",
    },
  });
  assert.strictEqual(result.status, 0);
  assert.deepStrictEqual(result.json, {});
});

// --- FINDINGS.md Edit tests ---

test("denies Edit to FINDINGS.md that adds Answer without citations", () => {
  const tmpFindings = path.join(os.tmpdir(), `findings-test-${Date.now()}.md`);
  fs.writeFileSync(tmpFindings, "# Findings\n\n(placeholder)\n");
  try {
    // Rename to FINDINGS.md in a temp dir
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ev-test-"));
    const findingsPath = path.join(dir, "FINDINGS.md");
    fs.writeFileSync(findingsPath, "# Findings\n\n(placeholder)\n");

    const result = runHook(HOOK, {
      tool_name: "Edit",
      tool_input: {
        file_path: findingsPath,
        old_string: "(placeholder)",
        new_string: "## Answer\n\nThe bug is in the parser.",
      },
    });
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.json?.hookSpecificOutput?.permissionDecision, "deny");

    fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    try { fs.unlinkSync(tmpFindings); } catch { /* ignore */ }
  }
});

test("allows Edit to FINDINGS.md that adds Answer with citations", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ev-test-"));
  const findingsPath = path.join(dir, "FINDINGS.md");
  fs.writeFileSync(findingsPath, "# Findings\n\n(placeholder)\n");

  const result = runHook(HOOK, {
    tool_name: "Edit",
    tool_input: {
      file_path: findingsPath,
      old_string: "(placeholder)",
      new_string: "## Answer\n\nThe bug is in the parser (Evidence 001).",
    },
  });
  assert.strictEqual(result.status, 0);
  assert.deepStrictEqual(result.json, {});

  fs.rmSync(dir, { recursive: true, force: true });
});

// --- Memory file warn tests ---

test("warns on project_*.md in memory dir with investigation content but no sources", () => {
  const content = [
    "---",
    "name: test investigation",
    "type: project",
    "---",
    "",
    "## Investigation Results",
    "",
    "Root cause analysis of the scheduling issue. We determined that the",
    "appointment sync was failing due to a timezone conversion bug in the",
    "integrator service. The investigation revealed that UTC offsets were",
    "being applied twice during daylight saving transitions. The finding",
    "is that this affects all appointments created between 2-3 AM local time.",
    "This was confirmed by reviewing the production logs and database records.",
  ].join("\n");

  const result = runHook(HOOK, {
    tool_name: "Write",
    tool_input: {
      file_path: "/home/user/.claude/projects/test/memory/project_tz_bug.md",
      content,
    },
  });
  assert.strictEqual(result.status, 0);
  const ctx = result.json?.hookSpecificOutput?.additionalContext || "";
  assert.ok(ctx.includes("EVIDENCE REMINDER"), "should contain evidence reminder");
});

test("allows project_*.md with investigation content AND source citations", () => {
  const content = [
    "---",
    "name: test investigation",
    "type: project",
    "---",
    "",
    "## Investigation Results",
    "",
    "Root cause: timezone conversion bug in integrator-service/src/sync.ts:142.",
    "We determined that UTC offsets were applied twice during DST transitions.",
    "Investigation confirmed at integrator-service/src/tz-utils.ts:58 that the",
    "offset calculation uses Date.getTimezoneOffset() which changes during DST.",
  ].join("\n");

  const result = runHook(HOOK, {
    tool_name: "Write",
    tool_input: {
      file_path: "/home/user/.claude/projects/test/memory/project_tz_bug.md",
      content,
    },
  });
  assert.strictEqual(result.status, 0);
  assert.deepStrictEqual(result.json, {});
});

test("allows project_*.md with short content (below threshold)", () => {
  const result = runHook(HOOK, {
    tool_name: "Write",
    tool_input: {
      file_path: "/home/user/.claude/projects/test/memory/project_status.md",
      content: "---\nname: status\ntype: project\n---\n\nInvestigation in progress.",
    },
  });
  assert.strictEqual(result.status, 0);
  assert.deepStrictEqual(result.json, {});
});

test("allows project_*.md with long content but no investigation patterns", () => {
  const content = [
    "---",
    "name: wooster status",
    "type: project",
    "---",
    "",
    "## Session State (2026-03-30)",
    "",
    "### What was done this session:",
    "- Configured 3 new CAs for org XYZ using DR pattern",
    "- Updated settings for Morris pilot to use FHIR adapter",
    "- Tested availability sync and confirmed 200 OK responses",
    "- Created ClickUp task for follow-up work on scheduling rules",
    "- Ran full integration test suite — all passing",
    "",
    "### Next Steps:",
    "- Deploy Morris FHIR adapter to staging",
    "- Monitor sync logs for 24 hours",
  ].join("\n");

  const result = runHook(HOOK, {
    tool_name: "Write",
    tool_input: {
      file_path: "/home/user/.claude/projects/test/memory/project_wooster.md",
      content,
    },
  });
  assert.strictEqual(result.status, 0);
  assert.deepStrictEqual(result.json, {});
});

test("allows project_*.md with Evidence NNN citations", () => {
  const content = [
    "---",
    "name: fax investigation",
    "type: project",
    "---",
    "",
    "## Houston Thyroid Fax Investigation",
    "",
    "Root cause: missing eCW inbox routing rules. Investigation found that",
    "the fax was received (Evidence 001) but the routing table had no entry",
    "for this provider. Determined that the configuration was never created",
    "during onboarding (Evidence 003).",
  ].join("\n");

  const result = runHook(HOOK, {
    tool_name: "Write",
    tool_input: {
      file_path: "/home/user/.claude/projects/test/memory/project_fax.md",
      content,
    },
  });
  assert.strictEqual(result.status, 0);
  assert.deepStrictEqual(result.json, {});
});

test("allows project_*.md with URL citations", () => {
  const content = [
    "---",
    "name: auth investigation",
    "type: project",
    "---",
    "",
    "## Auth Token Investigation",
    "",
    "Root cause: the token rotation logic has a race condition.",
    "Investigation determined that concurrent requests can both read the",
    "same refresh token before either writes the replacement. Details at",
    "https://linear.app/luma/issue/AUTH-123 and confirmed by reviewing logs.",
  ].join("\n");

  const result = runHook(HOOK, {
    tool_name: "Write",
    tool_input: {
      file_path: "/home/user/.claude/projects/test/memory/project_auth.md",
      content,
    },
  });
  assert.strictEqual(result.status, 0);
  assert.deepStrictEqual(result.json, {});
});

// --- Edge cases ---

test("handles missing file_path gracefully", () => {
  const result = runHook(HOOK, {
    tool_name: "Write",
    tool_input: { content: "hello" },
  });
  assert.strictEqual(result.status, 0);
  assert.deepStrictEqual(result.json, {});
});

test("handles malformed JSON gracefully", () => {
  const result = runHookRaw(HOOK, "not json");
  assert.strictEqual(result.status, 0);
  assert.deepStrictEqual(result.json, {});
});

test("handles empty input gracefully", () => {
  const result = runHookRaw(HOOK, "");
  assert.strictEqual(result.status, 0);
  assert.deepStrictEqual(result.json, {});
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
