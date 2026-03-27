#!/usr/bin/env node
// Unit tests for templates/hooks/dedicated-tool-guard.js
// Zero dependencies — uses only Node built-ins + test-helpers.
//
// Run: node tests/hooks/dedicated-tool-guard.test.js

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");

const { runHook, createTempHome } = require("./test-helpers");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const HOOK_PATH = path.join(REPO_ROOT, "templates", "hooks", "dedicated-tool-guard.js");

// ─── Load checkCommand for unit tests ────────────────────────────────────────

let _extractCounter = 0;
function extractFunction(hookPath, funcName) {
  const src = fs.readFileSync(hookPath, "utf8");
  const boundary = src.indexOf("process.stdin.resume()");
  const declarations = boundary > 0 ? src.slice(0, boundary) : src;
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

function unitTest(name, fn) {
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

// ─── Helper ──────────────────────────────────────────────────────────────────

function runGuard(command, env) {
  return runHook(HOOK_PATH, {
    tool_name: "Bash",
    tool_input: { command },
  }, { HOME: env.home, USERPROFILE: env.home });
}

function assertBlocked(result, label) {
  assert.strictEqual(result.status, 0, `${label}: exit status should be 0`);
  assert.ok(
    result.json && result.json.hookSpecificOutput &&
    result.json.hookSpecificOutput.permissionDecision === "deny",
    `${label}: expected deny but got: ${JSON.stringify(result.json)}`
  );
}

function assertAllowed(result, label) {
  assert.strictEqual(result.status, 0, `${label}: exit status should be 0`);
  assert.ok(
    !result.json || !result.json.hookSpecificOutput,
    `${label}: expected allow but got: ${JSON.stringify(result.json)}`
  );
}

// ─── cat tests ───────────────────────────────────────────────────────────────

console.log("\ndedicated-tool-guard.js (cat):");

test("cat.1 cat /path/to/file -> block", (env) => {
  assertBlocked(runGuard("cat /path/to/file.txt", env), "cat file");
  assert.ok(runGuard("cat /path/to/file.txt", env).json.hookSpecificOutput.permissionDecisionReason.includes("Read"));
});

test("cat.2 cat ./relative/file.js -> block", (env) => {
  assertBlocked(runGuard("cat ./src/index.ts", env), "cat relative");
});

test("cat.3 cat file.txt (bare name) -> block", (env) => {
  assertBlocked(runGuard("cat file.txt", env), "cat bare name");
});

test("cat.4 echo foo | cat -> allow (pipe, no file arg)", (env) => {
  assertAllowed(runGuard("echo foo | cat", env), "echo | cat");
});

test("cat.5 cat (no args) -> allow", (env) => {
  assertAllowed(runGuard("cat", env), "cat no args");
});

test("cat.6 command && cat file.txt -> block (after &&)", (env) => {
  assertBlocked(runGuard("true && cat file.txt", env), "cat after &&");
});

test("cat.7 cat <<'EOF' (heredoc) -> allow", (env) => {
  assertAllowed(runGuard("cat <<'EOF'\nhello\nEOF", env), "cat heredoc single-quote");
});

test("cat.8 cat <<EOF (unquoted heredoc) -> allow", (env) => {
  assertAllowed(runGuard("cat <<EOF\nhello\nEOF", env), "cat heredoc unquoted");
});

// ─── head tests ──────────────────────────────────────────────────────────────

console.log("\ndedicated-tool-guard.js (head):");

test("head.1 head file.txt -> block", (env) => {
  assertBlocked(runGuard("head file.txt", env), "head file");
  assert.ok(runGuard("head file.txt", env).json.hookSpecificOutput.permissionDecisionReason.includes("limit"));
});

test("head.2 head -n 20 src/index.ts -> block", (env) => {
  assertBlocked(runGuard("head -n 20 src/index.ts", env), "head -n N file");
});

test("head.3 git log | head -n 5 -> allow (piped)", (env) => {
  assertAllowed(runGuard("git log | head -n 5", env), "git log | head");
});

test("head.4 git log | head -20 -> allow (piped)", (env) => {
  assertAllowed(runGuard("git log | head -20", env), "git log | head -20");
});

// ─── tail tests ──────────────────────────────────────────────────────────────

console.log("\ndedicated-tool-guard.js (tail):");

test("tail.1 tail file.txt -> block", (env) => {
  assertBlocked(runGuard("tail file.txt", env), "tail file");
  assert.ok(runGuard("tail file.txt", env).json.hookSpecificOutput.permissionDecisionReason.includes("offset"));
});

test("tail.2 tail -n 50 /var/log/app.log -> block", (env) => {
  assertBlocked(runGuard("tail -n 50 /var/log/app.log", env), "tail -n N file");
});

test("tail.3 npm run build | tail -n 20 -> allow (piped)", (env) => {
  assertAllowed(runGuard("npm run build | tail -n 20", env), "build | tail");
});

// ─── grep tests ──────────────────────────────────────────────────────────────

console.log("\ndedicated-tool-guard.js (grep):");

test("grep.1 grep pattern file.txt -> block", (env) => {
  assertBlocked(runGuard("grep pattern file.txt", env), "grep file");
  assert.ok(runGuard("grep pattern file.txt", env).json.hookSpecificOutput.permissionDecisionReason.includes("Grep"));
});

test("grep.2 grep -r 'pattern' ./src -> block", (env) => {
  assertBlocked(runGuard("grep -r 'pattern' ./src", env), "grep -r dir");
});

test("grep.3 grep -rn TODO src/ -> block", (env) => {
  assertBlocked(runGuard("grep -rn TODO src/", env), "grep -rn dir");
});

test("grep.4 rg pattern src/ -> block", (env) => {
  assertBlocked(runGuard("rg pattern src/", env), "rg file");
});

test("grep.5 git diff | grep foo -> allow (stdin pipe)", (env) => {
  assertAllowed(runGuard("git diff | grep foo", env), "git diff | grep");
});

test("grep.6 git log | grep -i error -> allow (stdin pipe with flags)", (env) => {
  assertAllowed(runGuard("git log | grep -i error", env), "git log | grep -i");
});

// ─── sed tests ───────────────────────────────────────────────────────────────

console.log("\ndedicated-tool-guard.js (sed):");

test("sed.1 sed 's/foo/bar/' file.txt -> block", (env) => {
  assertBlocked(runGuard("sed 's/foo/bar/' file.txt", env), "sed file");
  assert.ok(runGuard("sed 's/foo/bar/' file.txt", env).json.hookSpecificOutput.permissionDecisionReason.includes("Edit"));
});

test("sed.2 sed -n '1,10p' src/index.ts -> block", (env) => {
  assertBlocked(runGuard("sed -n '1,10p' src/index.ts", env), "sed -n file");
});

test("sed.3 cat file | sed 's/foo/bar/' -> block (cat reads a file)", (env) => {
  // cat file is itself a file read — block fires on the cat, not the sed
  assertBlocked(runGuard("cat file | sed 's/foo/bar/'", env), "cat | sed");
});

test("sed.4 echo hello | sed 's/hello/world/' -> allow (echo pipe)", (env) => {
  assertAllowed(runGuard("echo hello | sed 's/hello/world/'", env), "echo | sed");
});

// ─── find tests ──────────────────────────────────────────────────────────────

console.log("\ndedicated-tool-guard.js (find):");

test("find.1 find /absolute/path -name '*.ts' -> block", (env) => {
  assertBlocked(runGuard("find /absolute/path -name '*.ts'", env), "find absolute");
  assert.ok(runGuard("find /absolute/path -name '*.ts'", env).json.hookSpecificOutput.permissionDecisionReason.includes("Glob"));
});

test("find.2 find ./subdir -name '*.js' -> block", (env) => {
  assertBlocked(runGuard("find ./subdir -name '*.js'", env), "find relative subdir");
});

test("find.3 find src/ -name '*.ts' -> block", (env) => {
  assertBlocked(runGuard("find src/ -name '*.ts'", env), "find named dir");
});

test("find.4 find . -name '*.ts' -> allow (current dir)", (env) => {
  assertAllowed(runGuard("find . -name '*.ts'", env), "find .");
});

test("find.5 find -name '*.ts' -> allow (no dir arg, starts with flag)", (env) => {
  assertAllowed(runGuard("find -name '*.ts'", env), "find -name no dir");
});

// ─── ls tests ────────────────────────────────────────────────────────────────

console.log("\ndedicated-tool-guard.js (ls):");

test("ls.1 ls /some/path -> block", (env) => {
  assertBlocked(runGuard("ls /some/path", env), "ls absolute");
  assert.ok(runGuard("ls /some/path", env).json.hookSpecificOutput.permissionDecisionReason.includes("Glob"));
});

test("ls.2 ls ./subdir -> block", (env) => {
  assertBlocked(runGuard("ls ./subdir", env), "ls relative");
});

test("ls.3 ls src/ -> block", (env) => {
  assertBlocked(runGuard("ls src/", env), "ls named dir");
});

test("ls.4 ls (no args) -> allow", (env) => {
  assertAllowed(runGuard("ls", env), "ls no args");
});

test("ls.5 ls -la -> allow (flags only)", (env) => {
  assertAllowed(runGuard("ls -la", env), "ls -la");
});

test("ls.6 ls -l -> allow (flag only)", (env) => {
  assertAllowed(runGuard("ls -l", env), "ls -l");
});

// ─── Non-Bash tool pass-through ──────────────────────────────────────────────

console.log("\ndedicated-tool-guard.js (non-Bash pass-through):");

test("pt.1 Read tool -> allow without interception", (env) => {
  const result = runHook(HOOK_PATH, {
    tool_name: "Read",
    tool_input: { file_path: "/tmp/test.txt" },
  }, { HOME: env.home, USERPROFILE: env.home });
  assertAllowed(result, "Read tool");
});

test("pt.2 Grep tool -> allow without interception", (env) => {
  const result = runHook(HOOK_PATH, {
    tool_name: "Grep",
    tool_input: { pattern: "foo", path: "." },
  }, { HOME: env.home, USERPROFILE: env.home });
  assertAllowed(result, "Grep tool");
});

test("pt.3 Glob tool -> allow without interception", (env) => {
  const result = runHook(HOOK_PATH, {
    tool_name: "Glob",
    tool_input: { pattern: "**/*.ts" },
  }, { HOME: env.home, USERPROFILE: env.home });
  assertAllowed(result, "Glob tool");
});

test("pt.4 Malformed JSON input -> exits 0 with allow (never crash)", (env) => {
  const result = runHook(HOOK_PATH, "not valid json", { HOME: env.home, USERPROFILE: env.home });
  assert.strictEqual(result.status, 0);
  assert.ok(result.json, "Should output valid JSON");
});

// ─── Legitimate Bash commands that must not be blocked ───────────────────────

console.log("\ndedicated-tool-guard.js (false-positive avoidance):");

test("fp.1 git diff | grep pattern -> allow", (env) => {
  assertAllowed(runGuard("git diff | grep pattern", env), "git diff | grep");
});

test("fp.2 npm run build -> allow", (env) => {
  assertAllowed(runGuard("npm run build", env), "npm run build");
});

test("fp.3 git status -> allow", (env) => {
  assertAllowed(runGuard("git status", env), "git status");
});

test("fp.4 grep -E 'pattern' -> allow (no file, no -r)", (env) => {
  assertAllowed(runGuard("grep -E 'pattern'", env), "grep -E no file");
});

test("fp.5 npx tsc --build -> allow", (env) => {
  assertAllowed(runGuard("npx tsc --build", env), "npx tsc");
});

// ─── Unit tests (checkCommand) ────────────────────────────────────────────────

console.log("\ndedicated-tool-guard.js (checkCommand unit tests):");

const checkCommand = extractFunction(HOOK_PATH, "checkCommand");

unitTest("U1. checkCommand returns null for clean command", () => {
  assert.strictEqual(checkCommand("git status"), null);
});

unitTest("U2. checkCommand returns null for null input", () => {
  assert.strictEqual(checkCommand(null), null);
});

unitTest("U3. checkCommand returns null for empty string", () => {
  assert.strictEqual(checkCommand(""), null);
});

unitTest("U4. checkCommand detects cat file.txt", () => {
  const reason = checkCommand("cat file.txt");
  assert.ok(reason, "Should return a reason");
  assert.ok(reason.includes("Read"), `Reason: ${reason}`);
});

unitTest("U5. checkCommand detects head file.txt", () => {
  const reason = checkCommand("head file.txt");
  assert.ok(reason, "Should return a reason");
  assert.ok(reason.includes("limit"), `Reason: ${reason}`);
});

unitTest("U6. checkCommand detects tail file.txt", () => {
  const reason = checkCommand("tail file.txt");
  assert.ok(reason, "Should return a reason");
  assert.ok(reason.includes("offset"), `Reason: ${reason}`);
});

unitTest("U7. checkCommand detects grep pattern file.txt", () => {
  const reason = checkCommand("grep pattern file.txt");
  assert.ok(reason, "Should return a reason");
  assert.ok(reason.includes("Grep"), `Reason: ${reason}`);
});

unitTest("U8. checkCommand detects rg pattern ./src", () => {
  const reason = checkCommand("rg pattern ./src");
  assert.ok(reason, "Should return a reason");
  assert.ok(reason.includes("Grep"), `Reason: ${reason}`);
});

unitTest("U9. checkCommand detects sed 's/a/b/' file.txt", () => {
  const reason = checkCommand("sed 's/a/b/' file.txt");
  assert.ok(reason, "Should return a reason");
  assert.ok(reason.includes("Edit"), `Reason: ${reason}`);
});

unitTest("U10. checkCommand detects find ./src -name", () => {
  const reason = checkCommand("find ./src -name '*.ts'");
  assert.ok(reason, "Should return a reason");
  assert.ok(reason.includes("Glob"), `Reason: ${reason}`);
});

unitTest("U11. checkCommand detects ls ./src", () => {
  const reason = checkCommand("ls ./src");
  assert.ok(reason, "Should return a reason");
  assert.ok(reason.includes("Glob"), `Reason: ${reason}`);
});

unitTest("U12. checkCommand allows find . -name (cwd is fine)", () => {
  assert.strictEqual(checkCommand("find . -name '*.ts'"), null);
});

unitTest("U13. checkCommand allows ls -la (flags only)", () => {
  assert.strictEqual(checkCommand("ls -la"), null);
});

unitTest("U14. checkCommand allows git diff | grep pattern (piped)", () => {
  assert.strictEqual(checkCommand("git diff | grep pattern"), null);
});

unitTest("U15. checkCommand allows echo foo | cat (piped)", () => {
  assert.strictEqual(checkCommand("echo foo | cat"), null);
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed (${passed + failed} total)`);

if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) {
    console.log(`  \u2717 ${f.name}: ${f.error}`);
  }
}

process.exit(failed > 0 ? 1 : 0);
