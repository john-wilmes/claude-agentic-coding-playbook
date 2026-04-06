#!/usr/bin/env node
/**
 * knowledge-to-vault.test.js — Tests for scripts/knowledge-to-vault.js
 *
 * Tests CLI behavior via spawnSync and exported module functions directly.
 *
 * Run: node tests/scripts/knowledge-to-vault.test.js
 */

"use strict";

const assert            = require("assert");
const fs                = require("fs");
const path              = require("path");
const os                = require("os");
const { spawnSync }     = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT    = path.join(REPO_ROOT, "scripts", "knowledge-to-vault.js");

const {
  confidencePasses,
  mapCategoryToType,
  titleFromContextText,
  descriptionFromContextText,
  buildTopicLinks,
  slugify,
  parseTags,
  buildNote,
  processLines,
  loadExistingSlugs,
} = require(SCRIPT);

// ─── Test runner ──────────────────────────────────────────────────────────────

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kvault-"));
}

function cleanupDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

/**
 * Run the CLI script with given args and optional stdin input.
 * Returns { status, stdout, stderr }.
 */
function run(args = [], stdinInput = null) {
  const opts = {
    encoding: "utf8",
    timeout:  30000,
    env:      { ...process.env },
  };
  if (stdinInput !== null) {
    opts.input = stdinInput;
  }
  const result = spawnSync("node", [SCRIPT, ...args], opts);
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

/**
 * Build a minimal valid JSONL entry string.
 */
function makeEntry(overrides = {}) {
  const defaults = {
    id:              "test-id-001",
    created:         "2024-06-01T12:00:00Z",
    author:          "user",
    source_project:  "my-project",
    tool:            "git",
    category:        "pattern",
    tags:            '["ci","deployment"]',
    confidence:      "high",
    visibility:      "private",
    verified_at:     null,
    status:          "active",
    archived_at:     null,
    context_text:    "Always run tests before merging. This prevents regressions.",
    fix_text:        "Add a pre-merge CI check.",
    evidence_text:   "Observed in 5 failed deployments.",
    repo_url:        "https://github.com/example/repo",
    commit_sha:      "abc123",
    branch:          "main",
  };
  return JSON.stringify({ ...defaults, ...overrides });
}

// ─── Tests: CLI behavior ──────────────────────────────────────────────────────

console.log("\nknowledge-to-vault — CLI:");

test("1. --help exits 0 and prints usage to stderr", () => {
  const { status, stderr } = run(["--help"]);
  assert.strictEqual(status, 0, `Expected exit 0, got ${status}`);
  assert.ok(stderr.includes("Usage:"), `Expected 'Usage:' in stderr, got: ${stderr.slice(0, 200)}`);
});

test("2. Missing --output-dir exits 0 with error to stderr", () => {
  const { status, stderr } = run([]);
  assert.strictEqual(status, 0, `Expected exit 0, got ${status}`);
  assert.ok(
    stderr.includes("--output-dir") || stderr.includes("required"),
    `Expected error message in stderr, got: ${stderr.slice(0, 200)}`
  );
});

test("3. Empty input produces 0 exported", () => {
  const tmpDir = makeTempDir();
  try {
    const { status, stderr } = run(["--output-dir", tmpDir], "\n\n\n");
    assert.strictEqual(status, 0);
    assert.ok(stderr.includes("Exported: 0"), `Expected 'Exported: 0' in stderr, got: ${stderr}`);
  } finally { cleanupDir(tmpDir); }
});

test("4. Low confidence entry is skipped", () => {
  const tmpDir = makeTempDir();
  try {
    const line   = makeEntry({ confidence: "low" });
    const { stderr } = run(["--output-dir", tmpDir], line + "\n");
    assert.ok(stderr.includes("Exported: 0"), `Expected 'Exported: 0' in stderr, got: ${stderr}`);
    assert.ok(stderr.includes("Skipped: 1"), `Expected 'Skipped: 1' in stderr, got: ${stderr}`);
  } finally { cleanupDir(tmpDir); }
});

test("5. Medium confidence entry is exported", () => {
  const tmpDir = makeTempDir();
  try {
    const line   = makeEntry({ confidence: "medium" });
    const { status, stderr } = run(["--output-dir", tmpDir], line + "\n");
    assert.strictEqual(status, 0);
    assert.ok(stderr.includes("Exported: 1"), `Expected 'Exported: 1' in stderr, got: ${stderr}`);
  } finally { cleanupDir(tmpDir); }
});

test("6. High confidence entry is exported", () => {
  const tmpDir = makeTempDir();
  try {
    const line   = makeEntry({ confidence: "high" });
    const { status, stderr } = run(["--output-dir", tmpDir], line + "\n");
    assert.strictEqual(status, 0);
    assert.ok(stderr.includes("Exported: 1"), `Expected 'Exported: 1' in stderr, got: ${stderr}`);
  } finally { cleanupDir(tmpDir); }
});

test("7. Malformed JSON line is skipped, valid lines still exported", () => {
  const tmpDir = makeTempDir();
  try {
    const valid1  = makeEntry({ context_text: "First valid entry about logging." });
    const valid2  = makeEntry({ context_text: "Second valid entry about testing." });
    const input   = [valid1, "NOT_VALID_JSON", valid2].join("\n") + "\n";
    const { stderr } = run(["--output-dir", tmpDir], input);
    assert.ok(stderr.includes("Exported: 2"), `Expected 'Exported: 2' in stderr, got: ${stderr}`);
    assert.ok(stderr.includes("Skipped: 1"), `Expected 'Skipped: 1' in stderr, got: ${stderr}`);
  } finally { cleanupDir(tmpDir); }
});

test("8. Category mapping: gotcha → tension in frontmatter", () => {
  const tmpDir = makeTempDir();
  try {
    const line = makeEntry({ category: "gotcha", context_text: "Watch out for this gotcha in async code." });
    run(["--output-dir", tmpDir], line + "\n");
    const files = fs.readdirSync(tmpDir).filter(f => f.endsWith(".md"));
    assert.ok(files.length > 0, "Expected at least one .md file");
    const content = fs.readFileSync(path.join(tmpDir, files[0]), "utf8");
    assert.ok(content.includes("type: tension"), `Expected 'type: tension' in frontmatter, got: ${content.slice(0, 300)}`);
  } finally { cleanupDir(tmpDir); }
});

test("9. Category mapping: pattern → pattern in frontmatter", () => {
  const tmpDir = makeTempDir();
  try {
    const line = makeEntry({ category: "pattern", context_text: "Use consistent naming patterns throughout." });
    run(["--output-dir", tmpDir], line + "\n");
    const files   = fs.readdirSync(tmpDir).filter(f => f.endsWith(".md"));
    assert.ok(files.length > 0, "Expected at least one .md file");
    const content = fs.readFileSync(path.join(tmpDir, files[0]), "utf8");
    assert.ok(content.includes("type: pattern"), `Expected 'type: pattern' in frontmatter, got: ${content.slice(0, 300)}`);
  } finally { cleanupDir(tmpDir); }
});

test("10. Category mapping: security → insight in frontmatter", () => {
  const tmpDir = makeTempDir();
  try {
    const line = makeEntry({ category: "security", context_text: "Never store credentials in source control." });
    run(["--output-dir", tmpDir], line + "\n");
    const files   = fs.readdirSync(tmpDir).filter(f => f.endsWith(".md"));
    assert.ok(files.length > 0, "Expected at least one .md file");
    const content = fs.readFileSync(path.join(tmpDir, files[0]), "utf8");
    assert.ok(content.includes("type: insight"), `Expected 'type: insight' in frontmatter, got: ${content.slice(0, 300)}`);
  } finally { cleanupDir(tmpDir); }
});

test("11. Slug deduplication: second identical entry increments duplicates", () => {
  const tmpDir = makeTempDir();
  try {
    // Two entries with identical context_text → same slug → second is a duplicate
    const line1 = makeEntry({ context_text: "Always run tests before merging to prevent regressions." });
    const line2 = makeEntry({ context_text: "Always run tests before merging to prevent regressions." });
    const { stderr } = run(["--output-dir", tmpDir], [line1, line2].join("\n") + "\n");
    assert.ok(stderr.includes("Exported: 1"),    `Expected 'Exported: 1' in stderr, got: ${stderr}`);
    assert.ok(stderr.includes("Duplicates: 1"),  `Expected 'Duplicates: 1' in stderr, got: ${stderr}`);
  } finally { cleanupDir(tmpDir); }
});

test("12. Existing file in output dir prevents overwrite", () => {
  const tmpDir = makeTempDir();
  try {
    const line    = makeEntry({ context_text: "Always run tests before merging to prevent regressions." });
    const slug    = slugify(titleFromContextText("Always run tests before merging to prevent regressions."));
    const filePath = path.join(tmpDir, `${slug}.md`);

    // Pre-create the file
    fs.writeFileSync(filePath, "# Pre-existing content\n", "utf8");

    const { stderr } = run(["--output-dir", tmpDir], line + "\n");
    assert.ok(stderr.includes("Duplicates: 1"), `Expected 'Duplicates: 1' in stderr, got: ${stderr}`);

    // Verify original content was not overwritten
    const content = fs.readFileSync(filePath, "utf8");
    assert.ok(content.includes("Pre-existing content"), "File should not have been overwritten");
  } finally { cleanupDir(tmpDir); }
});

test("13. Output file contains YAML frontmatter markers", () => {
  const tmpDir = makeTempDir();
  try {
    const line  = makeEntry({ context_text: "Use consistent naming conventions throughout the codebase." });
    run(["--output-dir", tmpDir], line + "\n");
    const files = fs.readdirSync(tmpDir).filter(f => f.endsWith(".md"));
    assert.ok(files.length > 0, "Expected at least one .md file");
    const content = fs.readFileSync(path.join(tmpDir, files[0]), "utf8");
    assert.ok(content.startsWith("---\n"), `Expected file to start with '---', got: ${content.slice(0, 50)}`);
    // Second --- closes frontmatter
    const secondDash = content.indexOf("---\n", 4);
    assert.ok(secondDash > 4, "Expected closing '---' for frontmatter");
  } finally { cleanupDir(tmpDir); }
});

test("14. fix_text section appears when non-empty", () => {
  const tmpDir = makeTempDir();
  try {
    const line  = makeEntry({ fix_text: "Run npm test before every commit." });
    run(["--output-dir", tmpDir], line + "\n");
    const files   = fs.readdirSync(tmpDir).filter(f => f.endsWith(".md"));
    const content = fs.readFileSync(path.join(tmpDir, files[0]), "utf8");
    assert.ok(content.includes("## Fix"),                         "Expected '## Fix' section");
    assert.ok(content.includes("Run npm test before every commit."), "Expected fix text in output");
  } finally { cleanupDir(tmpDir); }
});

test("15. fix_text section omitted when empty", () => {
  const tmpDir = makeTempDir();
  try {
    const line  = makeEntry({ fix_text: "" });
    run(["--output-dir", tmpDir], line + "\n");
    const files   = fs.readdirSync(tmpDir).filter(f => f.endsWith(".md"));
    const content = fs.readFileSync(path.join(tmpDir, files[0]), "utf8");
    assert.ok(!content.includes("## Fix"), "Expected no '## Fix' section when fix_text is empty");
  } finally { cleanupDir(tmpDir); }
});

test("16. Tags parsed from JSON string appear as wiki links in topics", () => {
  const tmpDir = makeTempDir();
  try {
    const line  = makeEntry({ tags: '["git","ci","deployment"]', tool: "bash" });
    run(["--output-dir", tmpDir], line + "\n");
    const files   = fs.readdirSync(tmpDir).filter(f => f.endsWith(".md"));
    const content = fs.readFileSync(path.join(tmpDir, files[0]), "utf8");
    assert.ok(content.includes("[[bash]]"),      "Expected [[bash]] in topics");
    assert.ok(content.includes("[[git]]"),       "Expected [[git]] in topics");
    assert.ok(content.includes("[[ci]]"),        "Expected [[ci]] in topics");
    assert.ok(content.includes("[[deployment]]"),"Expected [[deployment]] in topics");
  } finally { cleanupDir(tmpDir); }
});

test("17. Stdin input mode works (pipe JSONL via spawnSync stdin)", () => {
  const tmpDir = makeTempDir();
  try {
    const line   = makeEntry({ confidence: "high", context_text: "Stdin test entry for validation purposes." });
    const { status, stderr } = run(["--output-dir", tmpDir], line + "\n");
    assert.strictEqual(status, 0);
    assert.ok(stderr.includes("Exported: 1"), `Expected 'Exported: 1' in stderr, got: ${stderr}`);
    const files = fs.readdirSync(tmpDir).filter(f => f.endsWith(".md"));
    assert.strictEqual(files.length, 1, "Expected exactly one output file");
  } finally { cleanupDir(tmpDir); }
});

test("18. Title strips markdown backticks", () => {
  const title = titleFromContextText("`git commit` should always include a message. More detail follows.");
  assert.ok(!title.includes("`"), `Expected no backticks in title, got: ${title}`);
  // After backtick stripping the text is capitalized, so check case-insensitively
  assert.ok(title.toLowerCase().includes("git commit"), `Expected 'git commit' (case-insensitive) in title, got: ${title}`);
});

test("19. Description truncated to 150 chars with ellipsis", () => {
  const long = "A".repeat(200) + ". More content here.";
  const desc = descriptionFromContextText(long);
  assert.ok(desc.length <= 153, `Expected ≤153 chars (150 + ellipsis), got ${desc.length}`);
  assert.ok(desc.endsWith("..."), `Expected ellipsis at end, got: ${desc.slice(-10)}`);
});

test("20. Empty context_text produces 'Unknown entry' title", () => {
  const title = titleFromContextText("");
  assert.strictEqual(title, "Unknown entry");
});

// ─── Tests: module exports (unit) ────────────────────────────────────────────

console.log("\nknowledge-to-vault — module exports:");

test("21. confidencePasses: low → false", () => {
  assert.strictEqual(confidencePasses("low"), false);
});

test("22. confidencePasses: medium → true", () => {
  assert.strictEqual(confidencePasses("medium"), true);
});

test("23. confidencePasses: high → true", () => {
  assert.strictEqual(confidencePasses("high"), true);
});

test("24. mapCategoryToType: default → insight", () => {
  assert.strictEqual(mapCategoryToType("unknown-category"), "insight");
});

test("25. mapCategoryToType: tip → preference", () => {
  assert.strictEqual(mapCategoryToType("tip"), "preference");
});

test("26. parseTags: malformed JSON → empty array", () => {
  const result = parseTags("NOT_JSON");
  assert.deepStrictEqual(result, []);
});

test("27. parseTags: valid JSON array → string array", () => {
  const result = parseTags('["alpha","beta","gamma"]');
  assert.deepStrictEqual(result, ["alpha", "beta", "gamma"]);
});

test("28. buildTopicLinks: empty tool and no tags → empty string", () => {
  const result = buildTopicLinks("", []);
  assert.strictEqual(result, "");
});

test("29. slugify: special characters → dashes", () => {
  const slug = slugify("Hello, World! This is a test.");
  assert.ok(/^[a-z0-9-]+$/.test(slug), `Expected lowercase alphanumeric slug, got: ${slug}`);
  assert.ok(!slug.startsWith("-"), "Slug should not start with dash");
  assert.ok(!slug.endsWith("-"),   "Slug should not end with dash");
});

test("30. loadExistingSlugs: non-existent dir → empty Set", () => {
  const result = loadExistingSlugs("/nonexistent/path/xyz-kvault");
  assert.ok(result instanceof Set);
  assert.strictEqual(result.size, 0);
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed (${passed + failed} total)`);

if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) {
    console.log(`  ✗ ${f.name}: ${f.error}`);
  }
}

process.exit(failed > 0 ? 1 : 0);
