#!/usr/bin/env node
// Tests for parseEnvYaml and the CLAUDE_ENV_FILE env-loading feature
// in templates/hooks/session-start.js
//
// Zero dependencies — uses only Node built-ins.
// Run: node tests/hooks/session-start-env.test.js

"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { runHook } = require("./test-helpers");

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

function requireModule() {
  delete require.cache[require.resolve(HOOK_MODULE)];
  return require(HOOK_MODULE);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

console.log("\nsession-start-env.js (parseEnvYaml + CLAUDE_ENV_FILE):");

// ── parseEnvYaml unit tests ───────────────────────────────────────────────────

test("1. parseEnvYaml: basic key-value pair", () => {
  const { parseEnvYaml } = requireModule();
  const result = parseEnvYaml("FOO: bar");
  assert.deepStrictEqual(result, { FOO: "bar" });
});

test("2. parseEnvYaml: double-quoted value strips quotes", () => {
  const { parseEnvYaml } = requireModule();
  const result = parseEnvYaml('FOO: "bar baz"');
  assert.deepStrictEqual(result, { FOO: "bar baz" });
});

test("3. parseEnvYaml: single-quoted value strips quotes", () => {
  const { parseEnvYaml } = requireModule();
  const result = parseEnvYaml("FOO: 'bar baz'");
  assert.deepStrictEqual(result, { FOO: "bar baz" });
});

test("4. parseEnvYaml: comment lines are ignored", () => {
  const { parseEnvYaml } = requireModule();
  const yaml = [
    "# This is a comment",
    "FOO: bar",
    "# Another comment",
  ].join("\n");
  const result = parseEnvYaml(yaml);
  assert.deepStrictEqual(result, { FOO: "bar" });
});

test("5. parseEnvYaml: empty lines are ignored", () => {
  const { parseEnvYaml } = requireModule();
  const yaml = "\nFOO: bar\n\nBAZ: qux\n\n";
  const result = parseEnvYaml(yaml);
  assert.deepStrictEqual(result, { FOO: "bar", BAZ: "qux" });
});

test("6. parseEnvYaml: multiple entries parsed correctly", () => {
  const { parseEnvYaml } = requireModule();
  const yaml = [
    "API_KEY: abc123",
    "BASE_URL: https://example.com",
    "MAX_RETRIES: 3",
  ].join("\n");
  const result = parseEnvYaml(yaml);
  assert.deepStrictEqual(result, {
    API_KEY: "abc123",
    BASE_URL: "https://example.com",
    MAX_RETRIES: "3",
  });
});

test("7. parseEnvYaml: lowercase key is ignored", () => {
  const { parseEnvYaml } = requireModule();
  const yaml = "foo: bar\nFOO: baz";
  const result = parseEnvYaml(yaml);
  // Only the uppercase key should be present
  assert.ok(!Object.prototype.hasOwnProperty.call(result, "foo"), "lowercase key should not be parsed");
  assert.strictEqual(result.FOO, "baz", "uppercase key should be parsed");
});

test("8. parseEnvYaml: mixed-case key is ignored", () => {
  const { parseEnvYaml } = requireModule();
  const yaml = "MyVar: value\nMY_VAR: value2";
  const result = parseEnvYaml(yaml);
  assert.ok(!Object.prototype.hasOwnProperty.call(result, "MyVar"), "mixed-case key should not be parsed");
  assert.strictEqual(result.MY_VAR, "value2", "UPPER_SNAKE key should be parsed");
});

test("9. parseEnvYaml: key starting with digit is ignored", () => {
  const { parseEnvYaml } = requireModule();
  const yaml = "1INVALID: value\nVALID_KEY: good";
  const result = parseEnvYaml(yaml);
  assert.ok(!Object.prototype.hasOwnProperty.call(result, "1INVALID"), "digit-leading key should not be parsed");
  assert.strictEqual(result.VALID_KEY, "good");
});

test("10. parseEnvYaml: empty content returns empty object", () => {
  const { parseEnvYaml } = requireModule();
  const result = parseEnvYaml("");
  assert.deepStrictEqual(result, {});
});

test("11. parseEnvYaml: only comments returns empty object", () => {
  const { parseEnvYaml } = requireModule();
  const result = parseEnvYaml("# just a comment\n# another comment\n");
  assert.deepStrictEqual(result, {});
});

test("12. parseEnvYaml: value with spaces preserved when quoted", () => {
  const { parseEnvYaml } = requireModule();
  const result = parseEnvYaml('GREETING: "hello world"');
  assert.strictEqual(result.GREETING, "hello world");
});

test("13. parseEnvYaml: unquoted value with leading/trailing whitespace trimmed", () => {
  const { parseEnvYaml } = requireModule();
  // After the colon+space, extra whitespace in the value should be trimmed
  const result = parseEnvYaml("FOO:   bar   ");
  assert.strictEqual(result.FOO, "bar");
});

// ── CLAUDE_ENV_FILE integration tests ────────────────────────────────────────

test("14. CLAUDE_ENV_FILE written with export statement for project env.yaml", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "env-hook-test-"));
  const claudeSubDir = path.join(tmpDir, ".claude");
  fs.mkdirSync(claudeSubDir, { recursive: true });

  const envYamlPath = path.join(claudeSubDir, "env.yaml");
  fs.writeFileSync(envYamlPath, "TEST_VAR: hello\n");

  const tmpEnvFile = path.join(tmpDir, "claude_env_output.sh");

  try {
    const result = runHook(
      HOOK_MODULE,
      { hookName: "SessionStart", cwd: tmpDir },
      { CLAUDE_ENV_FILE: tmpEnvFile, HOME: os.tmpdir() }
    );

    assert.strictEqual(result.status, 0, "Hook should exit 0");
    assert.ok(fs.existsSync(tmpEnvFile), "CLAUDE_ENV_FILE should have been created");

    const envFileContent = fs.readFileSync(tmpEnvFile, "utf8");
    assert.ok(
      envFileContent.includes('export TEST_VAR="hello"'),
      `CLAUDE_ENV_FILE should contain export statement, got: ${envFileContent}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("15. additionalContext mentions loaded env var names", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "env-hook-test-"));
  const claudeSubDir = path.join(tmpDir, ".claude");
  fs.mkdirSync(claudeSubDir, { recursive: true });

  fs.writeFileSync(path.join(claudeSubDir, "env.yaml"), "MY_TOKEN: secret\nBASE_URL: https://example.com\n");

  const tmpEnvFile = path.join(tmpDir, "claude_env_output.sh");

  try {
    const result = runHook(
      HOOK_MODULE,
      { hookName: "SessionStart", cwd: tmpDir },
      { CLAUDE_ENV_FILE: tmpEnvFile, HOME: os.tmpdir() }
    );

    assert.strictEqual(result.status, 0, "Hook should exit 0");
    assert.ok(result.json, "Hook should output valid JSON");

    const ctx = result.json.hookSpecificOutput && result.json.hookSpecificOutput.additionalContext;
    assert.ok(typeof ctx === "string", "additionalContext should be a string");
    assert.ok(
      ctx.includes("MY_TOKEN"),
      `additionalContext should mention MY_TOKEN, got: ${ctx}`
    );
    assert.ok(
      ctx.includes("BASE_URL"),
      `additionalContext should mention BASE_URL, got: ${ctx}`
    );
    assert.ok(
      ctx.includes("Environment variables loaded"),
      `additionalContext should say vars were loaded, got: ${ctx}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("16. CLAUDE_ENV_FILE receives multiple export lines for multiple vars", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "env-hook-test-"));
  const claudeSubDir = path.join(tmpDir, ".claude");
  fs.mkdirSync(claudeSubDir, { recursive: true });

  fs.writeFileSync(path.join(claudeSubDir, "env.yaml"), [
    "ALPHA: one",
    "BETA: two",
    "GAMMA: three",
  ].join("\n") + "\n");

  const tmpEnvFile = path.join(tmpDir, "claude_env_output.sh");

  try {
    runHook(
      HOOK_MODULE,
      { hookName: "SessionStart", cwd: tmpDir },
      { CLAUDE_ENV_FILE: tmpEnvFile, HOME: os.tmpdir() }
    );

    const content = fs.readFileSync(tmpEnvFile, "utf8");
    assert.ok(content.includes('export ALPHA="one"'), `Missing ALPHA export, got: ${content}`);
    assert.ok(content.includes('export BETA="two"'), `Missing BETA export, got: ${content}`);
    assert.ok(content.includes('export GAMMA="three"'), `Missing GAMMA export, got: ${content}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("17. no env.yaml present: CLAUDE_ENV_FILE not written, no env context", () => {
  // Project dir with no .claude/env.yaml
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "env-hook-test-"));
  // No .claude subdir at all — also use a throwaway HOME with no global env.yaml
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "env-hook-home-"));
  const tmpEnvFile = path.join(tmpDir, "claude_env_output.sh");

  try {
    const result = runHook(
      HOOK_MODULE,
      { hookName: "SessionStart", cwd: tmpDir },
      { CLAUDE_ENV_FILE: tmpEnvFile, HOME: tmpHome }
    );

    assert.strictEqual(result.status, 0, "Hook should exit 0");
    assert.ok(!fs.existsSync(tmpEnvFile), "CLAUDE_ENV_FILE should NOT be created when no env.yaml exists");

    // additionalContext should not mention env vars
    const ctx =
      result.json &&
      result.json.hookSpecificOutput &&
      result.json.hookSpecificOutput.additionalContext;
    if (typeof ctx === "string") {
      assert.ok(
        !ctx.includes("Environment variables loaded"),
        `additionalContext should not mention env loading, got: ${ctx}`
      );
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("18. no CLAUDE_ENV_FILE set: env vars parsed but not written to file", () => {
  // Hook should still report the vars in additionalContext but not crash
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "env-hook-test-"));
  const claudeSubDir = path.join(tmpDir, ".claude");
  fs.mkdirSync(claudeSubDir, { recursive: true });
  fs.writeFileSync(path.join(claudeSubDir, "env.yaml"), "SILENT_VAR: value\n");

  // Omit CLAUDE_ENV_FILE from env — pass a HOME with no global env.yaml
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "env-hook-home-"));
  // Must ensure CLAUDE_ENV_FILE is not inherited from the test process
  const envWithout = { HOME: tmpHome };
  // Explicitly delete CLAUDE_ENV_FILE in the subprocess env
  const { spawnSync } = require("child_process");
  const hookEnv = { ...process.env, CLAUDE_HOOK_SOURCE: "test", HOME: tmpHome };
  delete hookEnv.CLAUDE_ENV_FILE;

  try {
    const proc = spawnSync("node", [HOOK_MODULE], {
      input: JSON.stringify({ hookName: "SessionStart", cwd: tmpDir }),
      env: hookEnv,
      timeout: 10000,
      encoding: "utf8",
    });

    assert.strictEqual(proc.status, 0, "Hook should exit 0");

    let json = null;
    try { json = JSON.parse(proc.stdout.trim()); } catch {}
    assert.ok(json, "Should output valid JSON");

    const ctx =
      json &&
      json.hookSpecificOutput &&
      json.hookSpecificOutput.additionalContext;
    // additionalContext may or may not mention vars without a CLAUDE_ENV_FILE,
    // but the hook should not crash and should report env vars loaded
    if (typeof ctx === "string") {
      assert.ok(
        ctx.includes("SILENT_VAR"),
        `additionalContext should mention SILENT_VAR even without CLAUDE_ENV_FILE, got: ${ctx}`
      );
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("19. CLAUDE_ENV_FILE appends (does not overwrite) if file already has content", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "env-hook-test-"));
  const claudeSubDir = path.join(tmpDir, ".claude");
  fs.mkdirSync(claudeSubDir, { recursive: true });
  fs.writeFileSync(path.join(claudeSubDir, "env.yaml"), "NEW_VAR: added\n");

  const tmpEnvFile = path.join(tmpDir, "claude_env_output.sh");
  // Pre-populate the file with some existing content
  fs.writeFileSync(tmpEnvFile, "export EXISTING_VAR=\"already_here\"\n");

  try {
    runHook(
      HOOK_MODULE,
      { hookName: "SessionStart", cwd: tmpDir },
      { CLAUDE_ENV_FILE: tmpEnvFile, HOME: os.tmpdir() }
    );

    const content = fs.readFileSync(tmpEnvFile, "utf8");
    assert.ok(
      content.includes("EXISTING_VAR"),
      `Pre-existing content should be preserved, got: ${content}`
    );
    assert.ok(
      content.includes('export NEW_VAR="added"'),
      `New var should be appended, got: ${content}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("20. env.yaml with comments and blank lines: only valid vars exported", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "env-hook-test-"));
  const claudeSubDir = path.join(tmpDir, ".claude");
  fs.mkdirSync(claudeSubDir, { recursive: true });

  const yaml = [
    "# Database config",
    "",
    "DB_HOST: localhost",
    "# DB_PORT is intentionally commented out",
    "DB_NAME: mydb",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(claudeSubDir, "env.yaml"), yaml);

  const tmpEnvFile = path.join(tmpDir, "claude_env_output.sh");

  try {
    runHook(
      HOOK_MODULE,
      { hookName: "SessionStart", cwd: tmpDir },
      { CLAUDE_ENV_FILE: tmpEnvFile, HOME: os.tmpdir() }
    );

    const content = fs.readFileSync(tmpEnvFile, "utf8");
    assert.ok(content.includes('export DB_HOST="localhost"'), `DB_HOST missing, got: ${content}`);
    assert.ok(content.includes('export DB_NAME="mydb"'), `DB_NAME missing, got: ${content}`);
    // The comment's text "DB_PORT" should not appear as an export
    assert.ok(!content.includes("export DB_PORT"), `DB_PORT should not be exported, got: ${content}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
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
