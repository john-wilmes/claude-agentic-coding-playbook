#!/usr/bin/env node
/**
 * investigation-to-vault.test.js — Tests for scripts/investigation-to-vault.js
 *
 * Tests CLI behavior via spawnSync and exported module functions directly.
 *
 * Run: node tests/scripts/investigation-to-vault.test.js
 */

"use strict";

const assert        = require("assert");
const fs            = require("fs");
const path          = require("path");
const os            = require("os");
const { spawnSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT    = path.join(REPO_ROOT, "scripts", "investigation-to-vault.js");

const {
  parseYamlFrontmatter,
  extractSection,
  extractPhase,
  extractQuestion,
  extractRepo,
  extractClosedDate,
  mapTypeToVaultType,
  buildTopics,
  descriptionFromAnswer,
  buildInvestigationNote,
  findFileInsensitive,
  processInvestigations,
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
  return fs.mkdtempSync(path.join(os.tmpdir(), "invault-"));
}

function cleanupDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

/**
 * Run the CLI script with given args.
 * Returns { status, stdout, stderr }.
 */
function run(args = []) {
  const opts = {
    encoding: "utf8",
    timeout:  30000,
    env:      { ...process.env },
  };
  const result = spawnSync("node", [SCRIPT, ...args], opts);
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

/**
 * Build a temp investigation directory tree for integration tests.
 */
function buildInvestigation(baseDir, id, { phase, question, repo, answer, evidenceTable, implications, tags }) {
  const dir = path.join(baseDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, "EVIDENCE"), { recursive: true });

  // BRIEF.md
  const briefLines = ["# Investigation Brief", ""];
  if (question) {
    briefLines.push("## Question");
    briefLines.push("");
    briefLines.push(question);
    briefLines.push("");
  }
  if (repo) {
    briefLines.push("## Repo");
    briefLines.push("");
    briefLines.push(repo);
    briefLines.push("");
  }
  fs.writeFileSync(path.join(dir, "BRIEF.md"), briefLines.join("\n"), "utf8");

  // STATUS.md
  const statusLines = ["# Investigation Status", ""];
  if (phase) {
    statusLines.push("## Current Phase");
    statusLines.push("");
    statusLines.push(phase);
    statusLines.push("");
  }
  fs.writeFileSync(path.join(dir, "STATUS.md"), statusLines.join("\n"), "utf8");

  // FINDINGS.md
  const findingsLines = [];
  if (tags) {
    findingsLines.push("---");
    findingsLines.push("tags:");
    if (tags.domain && tags.domain.length) {
      findingsLines.push(`  domain: [${tags.domain.join(", ")}]`);
    }
    if (tags.type && tags.type.length) {
      findingsLines.push(`  type: [${tags.type.join(", ")}]`);
    }
    if (tags.components && tags.components.length) {
      findingsLines.push(`  components: [${tags.components.join(", ")}]`);
    }
    findingsLines.push("---");
    findingsLines.push("");
  }
  if (answer) {
    findingsLines.push("## Answer");
    findingsLines.push("");
    findingsLines.push(answer);
    findingsLines.push("");
  }
  if (evidenceTable) {
    findingsLines.push("## Evidence Summary");
    findingsLines.push("");
    findingsLines.push(evidenceTable);
    findingsLines.push("");
  }
  if (implications) {
    findingsLines.push("## Implications");
    findingsLines.push("");
    findingsLines.push(implications);
    findingsLines.push("");
  }
  fs.writeFileSync(path.join(dir, "FINDINGS.md"), findingsLines.join("\n"), "utf8");
}

// ─── Tests: unit — parseYamlFrontmatter ──────────────────────────────────────

console.log("\ninvestigation-to-vault — parseYamlFrontmatter:");

test("1. standard tags block with inline arrays", () => {
  const text = [
    "---",
    "tags:",
    "  domain: [infrastructure, lambda]",
    "  type: [debugging]",
    "  severity: [high]",
    "  components: [api-gateway]",
    "---",
    "## Answer",
    "",
    "The answer is here.",
  ].join("\n");
  const { tags, rest } = parseYamlFrontmatter(text);
  assert.deepStrictEqual(tags.domain, ["infrastructure", "lambda"]);
  assert.deepStrictEqual(tags.type, ["debugging"]);
  assert.deepStrictEqual(tags.severity, ["high"]);
  assert.deepStrictEqual(tags.components, ["api-gateway"]);
  assert.ok(rest.includes("## Answer"), "Expected rest to contain body content");
});

test("2. empty arrays parse to empty arrays", () => {
  const text = [
    "---",
    "tags:",
    "  domain: []",
    "  type: []",
    "---",
    "body",
  ].join("\n");
  const { tags } = parseYamlFrontmatter(text);
  assert.deepStrictEqual(tags.domain, []);
  assert.deepStrictEqual(tags.type, []);
});

test("3. no frontmatter returns empty tags and full text as rest", () => {
  const text = "## Answer\n\nSome content here.";
  const { tags, rest } = parseYamlFrontmatter(text);
  assert.deepStrictEqual(tags.domain, []);
  assert.deepStrictEqual(tags.type, []);
  assert.strictEqual(rest, text);
});

test("4. preserves rest content after frontmatter", () => {
  const text = [
    "---",
    "tags:",
    "  domain: [git]",
    "---",
    "## Answer",
    "",
    "Rest content here.",
  ].join("\n");
  const { rest } = parseYamlFrontmatter(text);
  assert.ok(rest.includes("## Answer"));
  assert.ok(rest.includes("Rest content here."));
  assert.ok(!rest.includes("---"), "rest should not include frontmatter delimiters");
});

// ─── Tests: unit — extractSection ─────────────────────────────────────────────

console.log("\ninvestigation-to-vault — extractSection:");

test("5. extracts Answer section", () => {
  const md = "## Answer\n\nThis is the answer.\n\n## Next Section\n\nOther content.";
  const result = extractSection(md, "Answer");
  assert.ok(result.includes("This is the answer."));
  assert.ok(!result.includes("Other content."));
});

test("6. returns empty string for missing section", () => {
  const md = "## Introduction\n\nSome content.";
  const result = extractSection(md, "Nonexistent");
  assert.strictEqual(result, "");
});

test("7. stops at next ## heading", () => {
  const md = "## Answer\n\nFirst paragraph.\n\n## Evidence Summary\n\nTable here.";
  const result = extractSection(md, "Answer");
  assert.ok(result.includes("First paragraph."));
  assert.ok(!result.includes("Table here."));
});

test("8. case insensitive heading match", () => {
  const md = "## ANSWER\n\nContent here.";
  const result = extractSection(md, "answer");
  assert.ok(result.includes("Content here."));
});

// ─── Tests: unit — extractPhase ───────────────────────────────────────────────

console.log("\ninvestigation-to-vault — extractPhase:");

test("9. extractPhase from ## Current Phase section", () => {
  const status = "# Status\n\n## Current Phase\n\nclosed\n\n## History\n\nsome history.";
  const phase = extractPhase(status);
  assert.strictEqual(phase, "closed");
});

test("10. extractPhase from phase: key-value format", () => {
  const status = "phase: closed\nclosed: 2024-03-15";
  const phase = extractPhase(status);
  assert.strictEqual(phase, "closed");
});

test("11. extractPhase returns null when no phase found", () => {
  const status = "# Status\n\nNo phase info here.";
  const phase = extractPhase(status);
  assert.strictEqual(phase, null);
});

// ─── Tests: unit — extractQuestion / extractRepo ──────────────────────────────

console.log("\ninvestigation-to-vault — extractQuestion / extractRepo:");

test("12. extractQuestion from BRIEF.md", () => {
  const brief = "# Brief\n\n## Question\n\nWhy do cold starts happen?\n\n## Repo\n\nhttps://github.com/example/repo";
  const q = extractQuestion(brief);
  assert.strictEqual(q, "Why do cold starts happen?");
});

test("13. extractRepo from BRIEF.md", () => {
  const brief = "# Brief\n\n## Question\n\nSome question.\n\n## Repo\n\nhttps://github.com/example/repo";
  const repo = extractRepo(brief);
  assert.strictEqual(repo, "https://github.com/example/repo");
});

// ─── Tests: unit — extractClosedDate ──────────────────────────────────────────

console.log("\ninvestigation-to-vault — extractClosedDate:");

test("14. extractClosedDate from history table", () => {
  const status = "| 2024-03-15 | closed | investigation resolved |";
  const date = extractClosedDate(status);
  assert.strictEqual(date, "2024-03-15");
});

test("15. extractClosedDate from key-value format", () => {
  const status = "closed: 2024-06-01\nsome other content";
  const date = extractClosedDate(status);
  assert.strictEqual(date, "2024-06-01");
});

test("16. extractClosedDate returns empty string when not found", () => {
  const status = "# Status\n\nNo date here.";
  const date = extractClosedDate(status);
  assert.strictEqual(date, "");
});

// ─── Tests: unit — mapTypeToVaultType ─────────────────────────────────────────

console.log("\ninvestigation-to-vault — mapTypeToVaultType:");

test("17. mapTypeToVaultType — all known mappings", () => {
  assert.strictEqual(mapTypeToVaultType(["exploration"]),  "insight");
  assert.strictEqual(mapTypeToVaultType(["performance"]),  "pattern");
  assert.strictEqual(mapTypeToVaultType(["debugging"]),    "tension");
  assert.strictEqual(mapTypeToVaultType(["root-cause"]),   "tension");
  assert.strictEqual(mapTypeToVaultType(["security"]),     "insight");
  assert.strictEqual(mapTypeToVaultType(["architecture"]), "pattern");
});

test("18. mapTypeToVaultType — empty array returns default insight", () => {
  assert.strictEqual(mapTypeToVaultType([]), "insight");
});

// ─── Tests: unit — buildTopics ────────────────────────────────────────────────

console.log("\ninvestigation-to-vault — buildTopics:");

test("19. buildTopics combines domain + components + investigation id", () => {
  const tags = { domain: ["infrastructure"], components: ["lambda"] };
  const result = buildTopics(tags, "lambda-cold-starts");
  assert.ok(result.includes("[[infrastructure]]"));
  assert.ok(result.includes("[[lambda]]"));
  assert.ok(result.includes("[[investigation-lambda-cold-starts]]"));
});

test("20. buildTopics with empty tags produces only investigation id link", () => {
  const tags = { domain: [], components: [] };
  const result = buildTopics(tags, "my-investigation");
  assert.strictEqual(result, "[[investigation-my-investigation]]");
});

// ─── Tests: unit — descriptionFromAnswer ──────────────────────────────────────

console.log("\ninvestigation-to-vault — descriptionFromAnswer:");

test("21. descriptionFromAnswer extracts first sentence truncated to 150", () => {
  const answer = "Cold starts are caused by container initialization. More detail follows here.";
  const desc = descriptionFromAnswer(answer);
  assert.ok(desc.length <= 153, `Expected ≤153 chars, got ${desc.length}`);
  assert.ok(desc.includes("Cold starts"), "Expected first sentence content");
});

test("22. descriptionFromAnswer empty input returns default", () => {
  assert.strictEqual(descriptionFromAnswer(""), "Unknown entry");
  assert.strictEqual(descriptionFromAnswer(null), "Unknown entry");
});

// ─── Tests: unit — findFileInsensitive ────────────────────────────────────────

console.log("\ninvestigation-to-vault — findFileInsensitive:");

test("23. findFileInsensitive finds case-insensitive match", () => {
  const tmpDir = makeTempDir();
  try {
    fs.writeFileSync(path.join(tmpDir, "STATUS.md"), "content", "utf8");
    const found = findFileInsensitive(tmpDir, "status.md");
    assert.strictEqual(found, "STATUS.md");
  } finally { cleanupDir(tmpDir); }
});

test("24. findFileInsensitive returns null when not found", () => {
  const tmpDir = makeTempDir();
  try {
    const found = findFileInsensitive(tmpDir, "MISSING.md");
    assert.strictEqual(found, null);
  } finally { cleanupDir(tmpDir); }
});

// ─── Tests: unit — buildInvestigationNote ─────────────────────────────────────

console.log("\ninvestigation-to-vault — buildInvestigationNote:");

test("25. buildInvestigationNote produces valid frontmatter", () => {
  const brief = "## Question\n\nWhy do cold starts happen?\n\n## Repo\n\nhttps://github.com/example/repo";
  const status = "## Current Phase\n\nclosed\n\n| 2024-03-15 | closed | resolved |";
  const findings = [
    "---",
    "tags:",
    "  domain: [lambda]",
    "  type: [debugging]",
    "---",
    "## Answer",
    "",
    "Cold starts happen due to container initialization overhead.",
    "",
    "## Implications",
    "",
    "Use provisioned concurrency.",
  ].join("\n");

  const note = buildInvestigationNote("lambda-cold-starts", brief, status, findings);
  assert.ok(note.startsWith("---\n"), "Expected frontmatter start");
  assert.ok(note.includes("type: tension"), "Expected type: tension (debugging → tension)");
  assert.ok(note.includes("created: 2024-03-15"), "Expected created date");
  assert.ok(note.includes("[[lambda]]"), "Expected domain topic");
  assert.ok(note.includes("[[investigation-lambda-cold-starts]]"), "Expected investigation id topic");
  assert.ok(note.includes("## Answer"), "Expected Answer section");
  assert.ok(note.includes("## Implications"), "Expected Implications section");
  assert.ok(note.includes("*Source:"), "Expected source footer");
});

// ─── Tests: CLI ───────────────────────────────────────────────────────────────

console.log("\ninvestigation-to-vault — CLI:");

test("26. --help exits 0 and prints usage to stderr", () => {
  const { status, stderr } = run(["--help"]);
  assert.strictEqual(status, 0, `Expected exit 0, got ${status}`);
  assert.ok(stderr.includes("Usage:"), `Expected 'Usage:' in stderr, got: ${stderr.slice(0, 200)}`);
});

test("27. missing --output-dir exits 0 with error to stderr", () => {
  const { status, stderr } = run([]);
  assert.strictEqual(status, 0, `Expected exit 0, got ${status}`);
  assert.ok(
    stderr.includes("--output-dir") || stderr.includes("required"),
    `Expected error message in stderr, got: ${stderr.slice(0, 200)}`
  );
});

// ─── Tests: integration (filesystem) ─────────────────────────────────────────

console.log("\ninvestigation-to-vault — integration:");

test("28. creates vault note for closed investigation", () => {
  const invDir = makeTempDir();
  const outDir = makeTempDir();
  try {
    buildInvestigation(invDir, "cold-start-001", {
      phase:        "closed",
      question:     "Why do Lambda cold starts exceed 2 seconds?",
      repo:         "https://github.com/example/repo",
      answer:       "Cold starts exceed 2 seconds due to JVM initialization in large packages.",
      evidenceTable: "| ID | Finding |\n|----|---------|\n| 001 | JVM adds 1.8s |",
      implications:  "Use smaller deployment packages.",
      tags:          { domain: ["lambda"], type: ["debugging"], components: ["api"] },
    });

    const { status, stderr } = run(["--output-dir", outDir, invDir]);
    assert.strictEqual(status, 0);
    assert.ok(stderr.includes("Exported: 1"), `Expected 'Exported: 1' in stderr, got: ${stderr}`);

    const files = fs.readdirSync(outDir).filter(f => f.endsWith(".md"));
    assert.strictEqual(files.length, 1, "Expected exactly one output file");

    const content = fs.readFileSync(path.join(outDir, files[0]), "utf8");
    assert.ok(content.startsWith("---\n"), "Expected frontmatter");
    assert.ok(content.includes("type: tension"), "Expected type mapped from debugging");
    assert.ok(content.includes("[[lambda]]"), "Expected domain topic");
    assert.ok(content.includes("## Answer"), "Expected Answer section");
    assert.ok(content.includes("## Evidence Summary"), "Expected Evidence Summary section");
    assert.ok(content.includes("## Implications"), "Expected Implications section");
  } finally {
    cleanupDir(invDir);
    cleanupDir(outDir);
  }
});

test("29. skips non-closed investigation (phase=running)", () => {
  const invDir = makeTempDir();
  const outDir = makeTempDir();
  try {
    buildInvestigation(invDir, "open-investigation", {
      phase:    "running",
      question: "What causes the memory leak?",
      answer:   "Still investigating.",
    });

    const { status, stderr } = run(["--output-dir", outDir, invDir]);
    assert.strictEqual(status, 0);
    assert.ok(stderr.includes("Exported: 0"), `Expected 'Exported: 0', got: ${stderr}`);
    assert.ok(stderr.includes("Skipped: 1"),  `Expected 'Skipped: 1', got: ${stderr}`);

    const files = fs.readdirSync(outDir).filter(f => f.endsWith(".md"));
    assert.strictEqual(files.length, 0, "Expected no output files");
  } finally {
    cleanupDir(invDir);
    cleanupDir(outDir);
  }
});

test("30. skips _patterns directory", () => {
  const invDir = makeTempDir();
  const outDir = makeTempDir();
  try {
    // Create a _patterns directory — should be skipped
    const patternsDir = path.join(invDir, "_patterns");
    fs.mkdirSync(patternsDir, { recursive: true });
    fs.writeFileSync(path.join(patternsDir, "STATUS.md"), "## Current Phase\n\nclosed\n", "utf8");
    fs.writeFileSync(path.join(patternsDir, "BRIEF.md"),  "## Question\n\nPattern question.\n", "utf8");
    fs.writeFileSync(path.join(patternsDir, "FINDINGS.md"), "## Answer\n\nPattern answer.\n", "utf8");

    // Also add a real closed investigation
    buildInvestigation(invDir, "real-investigation", {
      phase:    "closed",
      question: "What is the real question here?",
      answer:   "This is the real answer.",
    });

    const { stderr } = run(["--output-dir", outDir, invDir]);
    assert.ok(stderr.includes("Exported: 1"), `Expected only 1 exported (not _patterns), got: ${stderr}`);
  } finally {
    cleanupDir(invDir);
    cleanupDir(outDir);
  }
});

test("31. dedup: existing slug in output dir not overwritten", () => {
  const invDir = makeTempDir();
  const outDir = makeTempDir();
  try {
    buildInvestigation(invDir, "cold-start-dup", {
      phase:    "closed",
      question: "Why do cold starts happen here?",
      answer:   "Cold starts are caused by initialization.",
    });

    // Pre-create the slug file in output
    const { slugify: s } = require(path.join(REPO_ROOT, "scripts", "knowledge-to-vault.js"));
    const slug = s("Why do cold starts happen here?");
    const existing = path.join(outDir, `${slug}.md`);
    fs.writeFileSync(existing, "# Pre-existing content\n", "utf8");

    const { stderr } = run(["--output-dir", outDir, invDir]);
    assert.ok(stderr.includes("Duplicates: 1"), `Expected 'Duplicates: 1', got: ${stderr}`);

    // Original file should not be overwritten
    const content = fs.readFileSync(existing, "utf8");
    assert.ok(content.includes("Pre-existing content"), "File should not have been overwritten");
  } finally {
    cleanupDir(invDir);
    cleanupDir(outDir);
  }
});

test("32. multiple closed investigations — correct count", () => {
  const invDir = makeTempDir();
  const outDir = makeTempDir();
  try {
    buildInvestigation(invDir, "inv-001", {
      phase:    "closed",
      question: "First investigation question about performance?",
      answer:   "First answer explaining the performance issue.",
    });
    buildInvestigation(invDir, "inv-002", {
      phase:    "closed",
      question: "Second investigation question about memory?",
      answer:   "Second answer explaining the memory issue.",
    });
    buildInvestigation(invDir, "inv-003", {
      phase:    "running",
      question: "Third investigation still in progress?",
      answer:   "Not yet answered.",
    });

    const { status, stderr } = run(["--output-dir", outDir, invDir]);
    assert.strictEqual(status, 0);
    assert.ok(stderr.includes("Exported: 2"), `Expected 'Exported: 2', got: ${stderr}`);
    assert.ok(stderr.includes("Skipped: 1"),  `Expected 'Skipped: 1', got: ${stderr}`);

    const files = fs.readdirSync(outDir).filter(f => f.endsWith(".md"));
    assert.strictEqual(files.length, 2, "Expected exactly 2 output files");
  } finally {
    cleanupDir(invDir);
    cleanupDir(outDir);
  }
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed (${passed + failed} total)`);

if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) {
    console.log(`  ✗ ${f.name}: ${f.error}`);
  }
}

process.exit(failed > 0 ? 1 : 0);
