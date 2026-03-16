#!/usr/bin/env node
// Integration tests for sanitize-guard.js (PreToolUse + PostToolUse dual-mode hook).
// Zero dependencies — uses only Node built-ins + local test-helpers.
//
// Run: node tests/hooks/sanitize-guard.test.js

"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { runHook, runHookRaw, createTempHome } = require("./test-helpers");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SANITIZE_GUARD = path.join(REPO_ROOT, "templates", "hooks", "sanitize-guard.js");

// ─── Test runner ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Create a .claude/sanitize.yaml in the given project directory.
 * @param {string} projectDir
 * @param {object} config - { enabled, entities, exclude_paths, custom_patterns }
 */
function createSanitizeConfig(projectDir, config = {}) {
  const claudeDir = path.join(projectDir, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });

  let yaml = "sanitization:\n";
  yaml += `  enabled: ${config.enabled !== false}\n`;

  if (config.entities) {
    yaml += "  entities:\n";
    for (const e of config.entities) yaml += `    - ${e}\n`;
  }

  if (config.exclude_paths) {
    yaml += "  exclude_paths:\n";
    for (const p of config.exclude_paths) yaml += `    - "${p}"\n`;
  }

  if (config.custom_patterns) {
    yaml += "  custom_patterns:\n";
    for (const cp of config.custom_patterns) {
      yaml += `    - name: ${cp.name}\n`;
      yaml += `      regex: "${cp.regex}"\n`;
      yaml += `      placeholder: "${cp.placeholder}"\n`;
    }
  }

  fs.writeFileSync(path.join(claudeDir, "sanitize.yaml"), yaml);
  return projectDir;
}

/**
 * Create a temporary project directory.
 */
function createProjectDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sg-test-"));
}

// ─── Tests ───────────────────────────────────────────────────────────────────

console.log("\nsanitize-guard.js");

// 1. PostToolUse with PII in tool_response → emits redacted additionalContext
test("PostToolUse with PII in tool_response emits redacted additionalContext", (env) => {
  const projectDir = createProjectDir();
  createSanitizeConfig(projectDir, { enabled: true });

  const hookInput = {
    tool_name: "Read",
    tool_input: { file_path: "/tmp/test.txt" },
    tool_response: { content: "Patient SSN: 123-45-6789 email: patient@hospital.com" },
    cwd: projectDir,
    session_id: "test-session",
  };

  const result = runHook(SANITIZE_GUARD, hookInput);
  assert.ok(result.json, `Expected JSON output, got: ${result.stdout}`);
  const out = result.json.hookSpecificOutput;
  assert.ok(out, "Expected hookSpecificOutput");
  assert.strictEqual(out.hookEventName, "PostToolUse");
  assert.ok(out.additionalContext, "Expected additionalContext");
  assert.ok(out.additionalContext.includes("[SSN]"), `Expected [SSN] in: ${out.additionalContext}`);
  assert.ok(out.additionalContext.includes("[EMAIL]"), `Expected [EMAIL] in: ${out.additionalContext}`);

  try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch {}
});

// 2. PostToolUse with clean tool_response → returns {}
test("PostToolUse with clean tool_response returns {}", (env) => {
  const projectDir = createProjectDir();
  createSanitizeConfig(projectDir, { enabled: true });

  const hookInput = {
    tool_name: "Read",
    tool_input: { file_path: "/tmp/clean.txt" },
    tool_response: { content: "This is a completely clean response with no sensitive data." },
    cwd: projectDir,
    session_id: "test-session",
  };

  const result = runHook(SANITIZE_GUARD, hookInput);
  assert.ok(result.json, `Expected JSON output, got: ${result.stdout}`);
  assert.deepStrictEqual(result.json, {});

  try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch {}
});

// 3. PreToolUse Edit with PII in new_string → blocks with deny
test("PreToolUse Edit with PII in new_string blocks with deny", (env) => {
  const projectDir = createProjectDir();
  createSanitizeConfig(projectDir, { enabled: true });

  const hookInput = {
    tool_name: "Edit",
    tool_input: {
      file_path: "/tmp/test.txt",
      new_string: "SSN: 123-45-6789",
    },
    cwd: projectDir,
    session_id: "test-session",
  };

  const result = runHook(SANITIZE_GUARD, hookInput);
  assert.ok(result.json, `Expected JSON output, got: ${result.stdout}`);
  const out = result.json.hookSpecificOutput;
  assert.ok(out, "Expected hookSpecificOutput");
  assert.strictEqual(out.hookEventName, "PreToolUse");
  assert.strictEqual(out.permissionDecision, "deny");
  assert.ok(out.permissionDecisionReason, "Expected permissionDecisionReason");

  try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch {}
});

// 4. PreToolUse Write with PII in content → blocks with deny
test("PreToolUse Write with PII in content blocks with deny", (env) => {
  const projectDir = createProjectDir();
  createSanitizeConfig(projectDir, { enabled: true });

  const hookInput = {
    tool_name: "Write",
    tool_input: {
      file_path: "/tmp/report.txt",
      content: "Patient record: SSN 123-45-6789, contact: john@example-hospital.org",
    },
    cwd: projectDir,
    session_id: "test-session",
  };

  const result = runHook(SANITIZE_GUARD, hookInput);
  assert.ok(result.json, `Expected JSON output, got: ${result.stdout}`);
  const out = result.json.hookSpecificOutput;
  assert.ok(out, "Expected hookSpecificOutput");
  assert.strictEqual(out.permissionDecision, "deny");

  try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch {}
});

// 5. PreToolUse with clean content → returns {}
test("PreToolUse Edit with clean content returns {}", (env) => {
  const projectDir = createProjectDir();
  createSanitizeConfig(projectDir, { enabled: true });

  const hookInput = {
    tool_name: "Edit",
    tool_input: {
      file_path: "/tmp/clean.txt",
      new_string: "This is perfectly safe content with no PII.",
    },
    cwd: projectDir,
    session_id: "test-session",
  };

  const result = runHook(SANITIZE_GUARD, hookInput);
  assert.ok(result.json, `Expected JSON output, got: ${result.stdout}`);
  assert.deepStrictEqual(result.json, {});

  try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch {}
});

// 6. PreToolUse for non-Edit/Write tool → returns {}
test("PreToolUse for non-Edit/Write tool (Read) returns {}", (env) => {
  const projectDir = createProjectDir();
  createSanitizeConfig(projectDir, { enabled: true });

  // No tool_response → this is PreToolUse, but tool is Read
  const hookInput = {
    tool_name: "Read",
    tool_input: { file_path: "/tmp/test.txt" },
    cwd: projectDir,
    session_id: "test-session",
  };

  const result = runHook(SANITIZE_GUARD, hookInput);
  assert.ok(result.json, `Expected JSON output, got: ${result.stdout}`);
  assert.deepStrictEqual(result.json, {});

  try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch {}
});

// 7. No config file → returns {} (opt-in behavior)
test("No config file returns {} (opt-in)", (env) => {
  const projectDir = createProjectDir();
  // Intentionally no sanitize.yaml

  const hookInput = {
    tool_name: "Read",
    tool_input: { file_path: "/tmp/test.txt" },
    tool_response: { content: "SSN: 123-45-6789" },
    cwd: projectDir,
    session_id: "test-session",
  };

  const result = runHook(SANITIZE_GUARD, hookInput);
  assert.ok(result.json, `Expected JSON output, got: ${result.stdout}`);
  assert.deepStrictEqual(result.json, {});

  try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch {}
});

// 8. Config with enabled: false → returns {}
test("Config with enabled: false returns {}", (env) => {
  const projectDir = createProjectDir();
  createSanitizeConfig(projectDir, { enabled: false });

  const hookInput = {
    tool_name: "Read",
    tool_input: { file_path: "/tmp/test.txt" },
    tool_response: { content: "SSN: 123-45-6789" },
    cwd: projectDir,
    session_id: "test-session",
  };

  const result = runHook(SANITIZE_GUARD, hookInput);
  assert.ok(result.json, `Expected JSON output, got: ${result.stdout}`);
  assert.deepStrictEqual(result.json, {});

  try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch {}
});

// 9. Config with subset of entities → only detects those
test("Config with entities: [US_SSN] only detects SSN, not email", (env) => {
  const projectDir = createProjectDir();
  createSanitizeConfig(projectDir, { enabled: true, entities: ["US_SSN"] });

  const hookInput = {
    tool_name: "Read",
    tool_input: { file_path: "/tmp/test.txt" },
    // Text has both SSN and email — only SSN should be detected
    tool_response: { content: "SSN: 123-45-6789 and email: someone@real-hospital.com" },
    cwd: projectDir,
    session_id: "test-session",
  };

  const result = runHook(SANITIZE_GUARD, hookInput);
  assert.ok(result.json, `Expected JSON output, got: ${result.stdout}`);
  // SSN detected → should have output
  const out = result.json.hookSpecificOutput;
  assert.ok(out, "Expected hookSpecificOutput (SSN should be detected)");
  assert.ok(out.additionalContext.includes("[SSN]"), "Expected [SSN] placeholder");
  // EMAIL should NOT be replaced
  assert.ok(
    !out.additionalContext.includes("[EMAIL]"),
    "Expected EMAIL to be absent from redacted output (not in entity list)"
  );

  try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch {}
});

// 10. Config with exclude_paths → skips matching file paths
test("Config with exclude_paths skips matching file paths", (env) => {
  const projectDir = createProjectDir();
  createSanitizeConfig(projectDir, {
    enabled: true,
    exclude_paths: ["tests/fixtures/**"],
  });

  const hookInput = {
    tool_name: "Read",
    tool_input: { file_path: path.join(projectDir, "tests/fixtures/sample.txt") },
    tool_response: { content: "SSN: 123-45-6789" },
    cwd: projectDir,
    session_id: "test-session",
  };

  const result = runHook(SANITIZE_GUARD, hookInput);
  assert.ok(result.json, `Expected JSON output, got: ${result.stdout}`);
  assert.deepStrictEqual(result.json, {}, "Excluded path should return {}");

  try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch {}
});

// 11. Config with custom_patterns → detects custom entities
test("Config with custom_patterns detects custom entity PATIENT_ID", (env) => {
  const projectDir = createProjectDir();
  createSanitizeConfig(projectDir, {
    enabled: true,
    entities: [],  // no built-ins
    custom_patterns: [
      { name: "PATIENT_ID", regex: "PT-\\d{6}", placeholder: "[PATIENT_ID]" },
    ],
  });

  const hookInput = {
    tool_name: "Read",
    tool_input: { file_path: "/tmp/test.txt" },
    tool_response: { content: "Patient record PT-123456 was updated." },
    cwd: projectDir,
    session_id: "test-session",
  };

  const result = runHook(SANITIZE_GUARD, hookInput);
  assert.ok(result.json, `Expected JSON output, got: ${result.stdout}`);
  const out = result.json.hookSpecificOutput;
  assert.ok(out, "Expected hookSpecificOutput");
  assert.ok(out.additionalContext.includes("[PATIENT_ID]"), `Expected [PATIENT_ID] in: ${out.additionalContext}`);

  try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch {}
});

// 12. PostToolUse summary includes correct counts
test("PostToolUse summary includes correct detection counts", (env) => {
  const projectDir = createProjectDir();
  createSanitizeConfig(projectDir, { enabled: true });

  // 2 SSNs and 1 email
  const hookInput = {
    tool_name: "Read",
    tool_input: { file_path: "/tmp/test.txt" },
    tool_response: {
      content: "First SSN: 123-45-6789. Second SSN: 234-56-7890. Email: user@real-domain.com",
    },
    cwd: projectDir,
    session_id: "test-session",
  };

  const result = runHook(SANITIZE_GUARD, hookInput);
  assert.ok(result.json, `Expected JSON output, got: ${result.stdout}`);
  const out = result.json.hookSpecificOutput;
  assert.ok(out, "Expected hookSpecificOutput");
  // Should mention count of detections
  assert.ok(out.additionalContext.includes("US_SSN"), `Expected US_SSN in summary: ${out.additionalContext}`);

  try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch {}
});

// 13. PreToolUse denial includes redacted version
test("PreToolUse denial includes redacted version of the content", (env) => {
  const projectDir = createProjectDir();
  createSanitizeConfig(projectDir, { enabled: true });

  const hookInput = {
    tool_name: "Edit",
    tool_input: {
      file_path: "/tmp/test.txt",
      new_string: "Patient SSN is 123-45-6789, please handle carefully.",
    },
    cwd: projectDir,
    session_id: "test-session",
  };

  const result = runHook(SANITIZE_GUARD, hookInput);
  assert.ok(result.json, `Expected JSON output, got: ${result.stdout}`);
  const out = result.json.hookSpecificOutput;
  assert.ok(out, "Expected hookSpecificOutput");
  assert.strictEqual(out.permissionDecision, "deny");
  // The reason should include the redacted text with placeholder
  assert.ok(
    out.permissionDecisionReason.includes("[SSN]"),
    `Expected [SSN] placeholder in reason: ${out.permissionDecisionReason}`
  );
  // The original SSN should NOT appear in the reason
  assert.ok(
    !out.permissionDecisionReason.includes("123-45-6789"),
    "Expected raw SSN to be absent from reason"
  );

  try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch {}
});

// 14. Subagent calls are NOT skipped (unlike context-guard)
test("Subagent calls are not skipped — agent_id present still scans", (env) => {
  const projectDir = createProjectDir();
  createSanitizeConfig(projectDir, { enabled: true });

  const hookInput = {
    tool_name: "Read",
    tool_input: { file_path: "/tmp/test.txt" },
    tool_response: { content: "SSN: 123-45-6789" },
    cwd: projectDir,
    session_id: "test-session",
    agent_id: "subagent-abc-123",  // This is a subagent call
  };

  const result = runHook(SANITIZE_GUARD, hookInput);
  assert.ok(result.json, `Expected JSON output, got: ${result.stdout}`);
  // Sanitize-guard should still fire for subagents
  const out = result.json.hookSpecificOutput;
  assert.ok(out, "Expected hookSpecificOutput — subagent calls should not be skipped");
  assert.ok(out.additionalContext.includes("[SSN]"), "Expected SSN to be redacted in subagent call");

  try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch {}
});

// 15. Empty tool_response → returns {}
test("Empty tool_response object returns {}", (env) => {
  const projectDir = createProjectDir();
  createSanitizeConfig(projectDir, { enabled: true });

  const hookInput = {
    tool_name: "Write",
    tool_input: { file_path: "/tmp/out.txt" },
    tool_response: {},
    cwd: projectDir,
    session_id: "test-session",
  };

  const result = runHook(SANITIZE_GUARD, hookInput);
  assert.ok(result.json, `Expected JSON output, got: ${result.stdout}`);
  assert.deepStrictEqual(result.json, {});

  try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch {}
});

// 16. PreToolUse Bash tool with PII in command → blocks with deny
// (Bash scanning added to prevent SSNs/emails being echoed or curl'd out)
test("PreToolUse Bash tool with PII in command blocks", (env) => {
  const projectDir = createProjectDir();
  createSanitizeConfig(projectDir, { enabled: true });

  const hookInput = {
    tool_name: "Bash",
    tool_input: { command: "echo 'SSN: 123-45-6789'" },
    cwd: projectDir,
    session_id: "test-session",
  };

  const result = runHook(SANITIZE_GUARD, hookInput);
  assert.ok(result.json, `Expected JSON output, got: ${result.stdout}`);
  const out = result.json.hookSpecificOutput || {};
  assert.strictEqual(out.permissionDecision, "deny", "Should block Bash command containing PII");
  assert.ok(out.permissionDecisionReason.includes("BLOCKED"), "Reason should include BLOCKED");
  assert.ok(out.permissionDecisionReason.includes("Bash command"), "Reason should reference Bash command");
  assert.ok(out.permissionDecisionReason.includes("US_SSN"), "Reason should include detected entity type");
  assert.ok(out.permissionDecisionReason.includes("Rewrite"), "Reason should instruct user to rewrite the command");
  assert.ok(!out.permissionDecisionReason.includes("echo"), "Reason must not contain a fake echo replacement command");

  try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch {}
});

// 16b. PreToolUse Bash tool with no PII → passes through
test("PreToolUse Bash tool with clean command returns {}", (env) => {
  const projectDir = createProjectDir();
  createSanitizeConfig(projectDir, { enabled: true });

  const hookInput = {
    tool_name: "Bash",
    tool_input: { command: "ls -la /tmp" },
    cwd: projectDir,
    session_id: "test-session",
  };

  const result = runHook(SANITIZE_GUARD, hookInput);
  assert.ok(result.json, `Expected JSON output, got: ${result.stdout}`);
  assert.deepStrictEqual(result.json, {});

  try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch {}
});

// 17. Exclude path with single-segment wildcard (*)
test("Config with exclude_paths * wildcard skips matching file", (env) => {
  const projectDir = createProjectDir();
  createSanitizeConfig(projectDir, {
    enabled: true,
    exclude_paths: ["*.log"],
  });

  const hookInput = {
    tool_name: "Read",
    tool_input: { file_path: path.join(projectDir, "debug.log") },
    tool_response: { content: "SSN: 123-45-6789" },
    cwd: projectDir,
    session_id: "test-session",
  };

  const result = runHook(SANITIZE_GUARD, hookInput);
  assert.ok(result.json, `Expected JSON output, got: ${result.stdout}`);
  assert.deepStrictEqual(result.json, {}, "*.log path should be excluded");

  try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch {}
});

// 18. Malformed JSON input → exits 0 with {} (H2: true malformed JSON via runHookRaw)
test("Malformed JSON input exits 0 with {} (runHookRaw)", (env) => {
  // runHookRaw sends the raw string to stdin — not wrapped in JSON.stringify
  const result = runHookRaw(SANITIZE_GUARD, "{ this is not : valid json !!");
  assert.strictEqual(result.status, 0, "Should exit 0 on malformed JSON");
  assert.ok(result.json, "Should output valid JSON");
  assert.deepStrictEqual(result.json, {}, "Should output empty object on parse error");
});

// 19. PostToolUse Bash output containing PII (SSN) → detected and redacted (H3)
test("PostToolUse Bash tool response containing SSN is detected", (env) => {
  const projectDir = createProjectDir();
  createSanitizeConfig(projectDir, { enabled: true });

  // Simulate a Bash tool that returned command output containing a SSN
  const hookInput = {
    tool_name: "Bash",
    tool_input: { command: "cat /etc/config" },
    tool_response: { content: "user_ssn=123-45-6789 status=active" },
    cwd: projectDir,
    session_id: "test-session",
  };

  const result = runHook(SANITIZE_GUARD, hookInput);
  assert.ok(result.json, `Expected JSON output, got: ${result.stdout}`);
  // Bash is PostToolUse — PII in the response should be detected
  const out = result.json.hookSpecificOutput;
  assert.ok(out, "Expected hookSpecificOutput — Bash output with SSN should be detected");
  assert.ok(out.additionalContext, "Expected additionalContext with redacted output");
  assert.ok(
    out.additionalContext.includes("[SSN]"),
    `Expected [SSN] placeholder in: ${out.additionalContext}`
  );
  // The raw SSN should NOT appear in the context presented to Claude
  assert.ok(
    !out.additionalContext.includes("123-45-6789"),
    "Raw SSN should not appear in additionalContext"
  );

  try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch {}
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n  ${passed} passed, ${failed} failed\n`);

if (failures.length > 0) {
  console.log("Failures:");
  for (const f of failures) {
    console.log(`  - ${f.name}: ${f.error}`);
  }
  process.exit(1);
}
