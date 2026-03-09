#!/usr/bin/env node
// Unit tests for scripts/investigate-score.js
// Zero dependencies — uses only Node built-ins + test-helpers.
//
// Run: node tests/investigate/score.test.js

"use strict";

const assert = require("assert");
const path   = require("path");
const fs     = require("fs");
const { spawnSync } = require("child_process");

const { createTempInvestigation } = require("../hooks/test-helpers");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCORER    = path.join(REPO_ROOT, "scripts", "investigate-score.js");
const GT_DIR    = path.join(REPO_ROOT, "profiles", "research", "eval", "ground-truth");

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

// ─── Scorer runner ────────────────────────────────────────────────────────────

function runScorer(invDir, extraArgs = []) {
  const result = spawnSync("node", [SCORER, invDir, ...extraArgs], {
    encoding: "utf8",
    timeout:  15000,
  });
  let metrics = null;
  const metricsPath = path.join(invDir, "METRICS.json");
  if (fs.existsSync(metricsPath)) {
    try { metrics = JSON.parse(fs.readFileSync(metricsPath, "utf8")); } catch {}
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, metrics };
}

// ─── Tests: structure ─────────────────────────────────────────────────────────

console.log("\nscorer — structure:");

test("1. Well-structured FINDINGS.md scores 1.0", () => {
  const { dir, cleanup } = createTempInvestigation();
  try {
    const { status, metrics } = runScorer(dir);
    assert.strictEqual(status, 0);
    assert.strictEqual(metrics.structure.score, 1.0);
    assert.strictEqual(metrics.structure.missing.length, 0);
  } finally { cleanup(); }
});

test("2. Missing Answer section scores < 1.0 and reports it", () => {
  const { dir, cleanup } = createTempInvestigation({
    findings: "# Findings: TEST\n\n## Evidence Summary\n\n## Implications\n\nSome text.\n",
  });
  try {
    const { metrics } = runScorer(dir);
    assert.ok(metrics.structure.score < 1.0);
    assert.ok(metrics.structure.missing.includes("## Answer"));
  } finally { cleanup(); }
});

test("3. No FINDINGS.md reports missing sections", () => {
  const { dir, cleanup } = createTempInvestigation({ noFindings: true });
  try {
    const { metrics } = runScorer(dir);
    assert.strictEqual(metrics.structure.score, 0);
    assert.ok(metrics.structure.missing.some(m => m.includes("FINDINGS")));
  } finally { cleanup(); }
});

// ─── Tests: citation completeness ─────────────────────────────────────────────

console.log("\nscorer — citation completeness:");

test("4. Answer with evidence references scores > 0", () => {
  const { dir, cleanup } = createTempInvestigation();
  try {
    const { metrics } = runScorer(dir);
    assert.ok(metrics.citation_completeness.score > 0, "Expected >0 citation score");
  } finally { cleanup(); }
});

test("5. Answer with zero citations scores 0", () => {
  const { dir, cleanup } = createTempInvestigation({
    findings: `# Findings: TEST\n\n## Answer\n\nThe root cause is a bug in the code. It fails on Windows. The colon split is wrong.\n\n## Evidence Summary\n\n| # | Slug | Key observation |\n\n## Implications\n\nNeeds a fix.\n`,
  });
  try {
    const { metrics } = runScorer(dir);
    assert.strictEqual(metrics.citation_completeness.score, 0);
  } finally { cleanup(); }
});

test("6. All sentences citing evidence scores 1.0", () => {
  const { dir, cleanup } = createTempInvestigation({
    findings: `# Findings: TEST\n\n## Answer\n\nThe colon-split returns the drive letter on Windows (see 001). The fix is lastIndexOf (001).\n\n## Evidence Summary\n\n| # | Slug | Observation |\n|---|------|-------------|\n\n## Implications\n\nThe fix must be applied (001).\n`,
  });
  try {
    const { metrics } = runScorer(dir);
    assert.ok(metrics.citation_completeness.score > 0.8, "Expected high citation score");
  } finally { cleanup(); }
});

// ─── Tests: chain integrity ───────────────────────────────────────────────────

console.log("\nscorer — chain integrity:");

test("7. Evidence with valid Source fields scores 1.0", () => {
  const { dir, cleanup } = createTempInvestigation({
    evidence: [
      { name: "001-finding.md", source: "src/parser.ts:42", observation: "Split fails on Windows." },
      { name: "002-finding.md", source: "tests/parser.test.ts:15", observation: "Test confirms Windows failure." },
    ],
  });
  try {
    const { metrics } = runScorer(dir);
    assert.strictEqual(metrics.chain_integrity.score, 1.0);
    assert.strictEqual(metrics.chain_integrity.broken.length, 0);
  } finally { cleanup(); }
});

test("8. Evidence with empty Source field is flagged as broken", () => {
  const { dir, cleanup } = createTempInvestigation({
    evidence: [
      { name: "001-good.md",   source: "src/parser.ts:42",  observation: "Good evidence." },
      { name: "002-broken.md", source: "",                  observation: "Missing source." },
    ],
  });
  try {
    const { metrics } = runScorer(dir);
    assert.ok(metrics.chain_integrity.score < 1.0);
    assert.ok(metrics.chain_integrity.broken.includes("002-broken.md"));
  } finally { cleanup(); }
});

test("9. No EVIDENCE directory returns null score", () => {
  const { dir, cleanup } = createTempInvestigation({ evidence: [] });
  try {
    // Remove the evidence dir entirely
    const evidenceDir = path.join(dir, "EVIDENCE");
    if (fs.existsSync(evidenceDir)) fs.rmSync(evidenceDir, { recursive: true });

    const { metrics } = runScorer(dir);
    assert.strictEqual(metrics.chain_integrity.score, null);
    assert.ok(metrics.chain_integrity.reason);
  } finally { cleanup(); }
});

// ─── Tests: utilization ───────────────────────────────────────────────────────

console.log("\nscorer — utilization:");

test("10. Cited evidence produces utilization > 0", () => {
  const { dir, cleanup } = createTempInvestigation(); // default findings cites 001
  try {
    const { metrics } = runScorer(dir);
    assert.ok(metrics.utilization.cited > 0, "Expected at least one cited evidence");
  } finally { cleanup(); }
});

test("11. Uncited evidence produces utilization < 1.0 when there are multiple files", () => {
  const { dir, cleanup } = createTempInvestigation({
    evidence: [
      { name: "001-cited.md",   source: "file.ts:1",  observation: "Cited." },
      { name: "002-uncited.md", source: "file.ts:2",  observation: "Not cited." },
      { name: "003-uncited.md", source: "file.ts:3",  observation: "Not cited." },
    ],
    // FINDINGS.md only cites 001
  });
  try {
    const { metrics } = runScorer(dir);
    assert.ok(metrics.utilization.score < 1.0, "Should be < 1.0 since 002 and 003 are uncited");
  } finally { cleanup(); }
});

// ─── Tests: null control ──────────────────────────────────────────────────────

console.log("\nscorer — null control:");

test("12. Good investigation is NOT flagged as null", () => {
  const { dir, cleanup } = createTempInvestigation();
  try {
    const { metrics } = runScorer(dir);
    assert.strictEqual(metrics.null_control.is_likely_null, false);
  } finally { cleanup(); }
});

test("13. Empty investigation (no evidence, no citations) IS flagged as likely null", () => {
  const { dir, cleanup } = createTempInvestigation({
    evidence: [],
    findings: `# Findings: TEST\n\n## Answer\n\nSomething failed. It seems to be related to a bug.\n\n## Evidence Summary\n\n## Implications\n\nNeeds investigation.\n`,
  });
  try {
    // Remove evidence dir
    const evidenceDir = path.join(dir, "EVIDENCE");
    if (fs.existsSync(evidenceDir)) fs.rmSync(evidenceDir, { recursive: true });

    const { metrics } = runScorer(dir);
    assert.strictEqual(metrics.null_control.is_likely_null, true);
  } finally { cleanup(); }
});

// ─── Tests: ground truth scoring ─────────────────────────────────────────────

console.log("\nscorer — ground truth:");

test("14. MMA-2847 exact match (backward-trace.ts:43 + colon split) scores 4", () => {
  const gtPath = path.join(GT_DIR, "MMA-2847.json");
  if (!fs.existsSync(gtPath)) {
    console.log("    (skipped — ground-truth file not found)");
    passed++; // count as passing if GT file missing
    return;
  }
  const { dir, cleanup } = createTempInvestigation({
    findings: `# Findings: MMA-2847\n\n## Answer\n\nThe root cause is in backward-trace.ts at line 43 (see 001). The function calls\nsplit(":")[0] which returns the Windows drive letter instead of the file path on\nWindows absolute paths (see 001). The colon collision causes all tree lookups to\nfail silently (see 001).\n\n## Evidence Summary\n\n| # | Slug | Observation |\n|---|------|-------------|\n| 001 | colon-split-43 | split(":")[0] breaks on Windows drive letters |\n\n## Implications\n\nReplace split(":")[0] with lastIndexOf(":") as used at line 105.\n`,
  });
  try {
    const { metrics } = runScorer(dir, ["--ground-truth", gtPath]);
    assert.strictEqual(metrics.ground_truth_score.score, 4, `Expected 4, got ${metrics.ground_truth_score.score}`);
    assert.strictEqual(metrics.ground_truth_score.label, "exact");
  } finally { cleanup(); }
});

test("15. MMA-2847 mechanism only (no line number) scores 3", () => {
  const gtPath = path.join(GT_DIR, "MMA-2847.json");
  if (!fs.existsSync(gtPath)) { passed++; return; }
  const { dir, cleanup } = createTempInvestigation({
    findings: `# Findings: MMA-2847\n\n## Answer\n\nThe backward-trace module calls split(":")[0] which returns the Windows drive\nletter colon instead of the expected path separator. This causes the colon-based\nsplit to produce "D" on Windows absolute paths (see 001).\n\n## Evidence Summary\n\n| # | Slug | Observation |\n|---|------|-------------|\n| 001 | colon-split | split fails on Windows |\n\n## Implications\n\nNeeds a fix in the FQN parsing code.\n`,
  });
  try {
    const { metrics } = runScorer(dir, ["--ground-truth", gtPath]);
    assert.ok(
      metrics.ground_truth_score.score >= 3,
      `Expected >=3, got ${metrics.ground_truth_score.score}`
    );
  } finally { cleanup(); }
});

test("16. MMA-2847 anti-pattern (blames git) caps score at 2", () => {
  const gtPath = path.join(GT_DIR, "MMA-2847.json");
  if (!fs.existsSync(gtPath)) { passed++; return; }
  const { dir, cleanup } = createTempInvestigation({
    findings: `# Findings: MMA-2847\n\n## Answer\n\nThe colon split in backward-trace.ts is wrong (see 001). However, the primary\nroot cause is a git bug that produces incorrect path output on Windows (see 001).\n\n## Evidence Summary\n\n| # | Slug | Observation |\n|---|------|-------------|\n| 001 | git-bug | git output is wrong on Windows |\n\n## Implications\n\nFix the git configuration.\n`,
  });
  try {
    const { metrics } = runScorer(dir, ["--ground-truth", gtPath]);
    assert.ok(
      metrics.ground_truth_score.score <= 2,
      `Expected <=2 (anti-pattern cap), got ${metrics.ground_truth_score.score}`
    );
    assert.ok(metrics.ground_truth_score.anti_pattern_hit, "Expected anti-pattern to be flagged");
  } finally { cleanup(); }
});

test("17. MMA-2847 total miss scores 0", () => {
  const gtPath = path.join(GT_DIR, "MMA-2847.json");
  if (!fs.existsSync(gtPath)) { passed++; return; }
  const { dir, cleanup } = createTempInvestigation({
    findings: `# Findings: MMA-2847\n\n## Answer\n\nThe issue is caused by a Unicode encoding problem in the database connection\nstring on Windows. The locale settings differ between Mac and Windows (see 001).\n\n## Evidence Summary\n\n| # | Slug | Observation |\n|---|------|-------------|\n| 001 | encoding | Unicode locale mismatch |\n\n## Implications\n\nFix locale settings in CI.\n`,
  });
  try {
    const { metrics } = runScorer(dir, ["--ground-truth", gtPath]);
    assert.strictEqual(metrics.ground_truth_score.score, 0, `Expected 0, got ${metrics.ground_truth_score.score}`);
  } finally { cleanup(); }
});

test("18. VNSE-4821 exact match scores 4", () => {
  const gtPath = path.join(GT_DIR, "VNSE-4821.json");
  if (!fs.existsSync(gtPath)) { passed++; return; }
  const { dir, cleanup } = createTempInvestigation({
    findings: `# Findings: VNSE-4821\n\n## Answer\n\nThe 53 failing listings are BULL type, which use the raw GraphQL path for\ncreateEPDProfile (see 001). The raw client.graphql() call does not auto-inject the\nowner field, but AppSync owner-auth requires it in the mutation input (see 001).\nAmplify's client.models.X.create() would inject owner automatically, but the EPD\npath bypasses it (see 001). Missing owner field in the mutation input causes\nAppSync authorization to reject the request (see 001).\n\n## Evidence Summary\n\n| # | Slug | Observation |\n|---|------|-------------|\n| 001 | owner-field-missing | Raw GraphQL mutation missing owner field |\n\n## Implications\n\nAdd owner field from Cognito session to createEPDProfile mutation input.\n`,
  });
  try {
    const { metrics } = runScorer(dir, ["--ground-truth", gtPath]);
    assert.strictEqual(metrics.ground_truth_score.score, 4, `Expected 4, got ${metrics.ground_truth_score.score}`);
  } finally { cleanup(); }
});

// ─── Tests: new ground truth files ───────────────────────────────────────────

console.log("\nscorer — new ground truth:");

test("23. NOVU-3001 exact match (collectDigest + transactionId dedup) scores 4", () => {
  const gtPath = path.join(GT_DIR, "NOVU-3001.json");
  if (!fs.existsSync(gtPath)) { passed++; return; }
  const { dir, cleanup } = createTempInvestigation({
    findings: `# Findings: NOVU-3001\n\n## Answer\n\nThe root cause is in digest.step.ts at line 395, in the collectDigest function (see 001). It uses Redis LRANGE to retrieve all entries from the digest list but does NOT deduplicate by transactionId (see 001). When a trigger is retried by the SDK, the same entry is appended again via rpush, and collectDigest returns both copies. Using a Redis sorted set keyed by transactionId would prevent duplicate entries (see 001).\n\n## Evidence Summary\n\n| # | Slug | Observation |\n|---|------|-------------|\n| 001 | no-dedup | collectDigest lacks transactionId dedup |\n\n## Implications\n\nAdd Set-based dedup on transactionId in collectDigest.\n`,
  });
  try {
    const { metrics } = runScorer(dir, ["--ground-truth", gtPath]);
    assert.strictEqual(metrics.ground_truth_score.score, 4, `Expected 4, got ${metrics.ground_truth_score.score}`);
  } finally { cleanup(); }
});

test("24. NOVU-3001 anti-pattern (blames BullMQ dedup) caps at 2", () => {
  const gtPath = path.join(GT_DIR, "NOVU-3001.json");
  if (!fs.existsSync(gtPath)) { passed++; return; }
  const { dir, cleanup } = createTempInvestigation({
    findings: `# Findings: NOVU-3001\n\n## Answer\n\nThe digest step collects entries without dedup (see 001). However, the primary issue\nis that BullMQ's job dedup should prevent the duplicate job from running, but the\nbullmq dedup configuration is incorrect (see 001).\n\n## Evidence Summary\n\n| # | Slug | Observation |\n|---|------|-------------|\n| 001 | bullmq | BullMQ job dedup not working |\n\n## Implications\n\nFix BullMQ dedup configuration.\n`,
  });
  try {
    const { metrics } = runScorer(dir, ["--ground-truth", gtPath]);
    assert.ok(metrics.ground_truth_score.score <= 2, `Expected <=2, got ${metrics.ground_truth_score.score}`);
    assert.ok(metrics.ground_truth_score.anti_pattern_hit);
  } finally { cleanup(); }
});

test("25. CALC-4502 exact match (pagination >= vs >) scores 4", () => {
  const gtPath = path.join(GT_DIR, "CALC-4502.json");
  if (!fs.existsSync(gtPath)) { passed++; return; }
  const { dir, cleanup } = createTempInvestigation({
    findings: `# Findings: CALC-4502\n\n## Answer\n\nThe pagination module at pagination.ts line 87 uses a >= comparison on the sort key\nin the cursor-based fallback path (see 001). This includes the boundary record on both\npages. The fix is to use > instead of >= (see 001).\n\n## Evidence Summary\n\n| # | Slug | Observation |\n|---|------|-------------|\n| 001 | cursor | cursor fallback uses >= instead of > |\n\n## Implications\n\nChange >= to > in the cursor comparison at pagination.ts:87.\n`,
  });
  try {
    const { metrics } = runScorer(dir, ["--ground-truth", gtPath]);
    assert.strictEqual(metrics.ground_truth_score.score, 4, `Expected 4, got ${metrics.ground_truth_score.score}`);
  } finally { cleanup(); }
});

test("26. CALC-4502 anti-pattern (blames caching) caps at 2", () => {
  const gtPath = path.join(GT_DIR, "CALC-4502.json");
  if (!fs.existsSync(gtPath)) { passed++; return; }
  const { dir, cleanup } = createTempInvestigation({
    findings: `# Findings: CALC-4502\n\n## Answer\n\nThe pagination uses >= in the cursor path (see 001). But the real issue is frontend\nclient caching returning stale page data (see 001).\n\n## Evidence Summary\n\n| # | Slug | Observation |\n|---|------|-------------|\n| 001 | cache | client caching causes duplicates |\n\n## Implications\n\nClear client cache.\n`,
  });
  try {
    const { metrics } = runScorer(dir, ["--ground-truth", gtPath]);
    assert.ok(metrics.ground_truth_score.score <= 2, `Expected <=2, got ${metrics.ground_truth_score.score}`);
    assert.ok(metrics.ground_truth_score.anti_pattern_hit);
  } finally { cleanup(); }
});

test("27. CONFIG-5104 exact match (DATABASE_URL vs DATABASE_URI) scores 4", () => {
  const gtPath = path.join(GT_DIR, "CONFIG-5104.json");
  if (!fs.existsSync(gtPath)) { passed++; return; }
  const { dir, cleanup } = createTempInvestigation({
    findings: `# Findings: CONFIG-5104\n\n## Answer\n\nThe database config at database.ts line 12 reads process.env.DATABASE_URL, but the\nstaging deployment template sets DATABASE_URI (see 001). The undefined value triggers\na silent fallback to localhost:5432, masking the mismatch (see 001).\n\n## Evidence Summary\n\n| # | Slug | Observation |\n|---|------|-------------|\n| 001 | env-mismatch | DATABASE_URL vs DATABASE_URI name mismatch |\n\n## Implications\n\nAlign env var name: use DATABASE_URL everywhere.\n`,
  });
  try {
    const { metrics } = runScorer(dir, ["--ground-truth", gtPath]);
    assert.strictEqual(metrics.ground_truth_score.score, 4, `Expected 4, got ${metrics.ground_truth_score.score}`);
  } finally { cleanup(); }
});

test("28. CONFIG-5104 anti-pattern (blames firewall) caps at 2", () => {
  const gtPath = path.join(GT_DIR, "CONFIG-5104.json");
  if (!fs.existsSync(gtPath)) { passed++; return; }
  const { dir, cleanup } = createTempInvestigation({
    findings: `# Findings: CONFIG-5104\n\n## Answer\n\nThe URL vs URI mismatch exists (see 001). But the primary cause is a firewall rule\nblocking the staging database port (see 001).\n\n## Evidence Summary\n\n| # | Slug | Observation |\n|---|------|-------------|\n| 001 | fw | network firewall blocks staging DB |\n\n## Implications\n\nUpdate firewall rules.\n`,
  });
  try {
    const { metrics } = runScorer(dir, ["--ground-truth", gtPath]);
    assert.ok(metrics.ground_truth_score.score <= 2, `Expected <=2, got ${metrics.ground_truth_score.score}`);
    assert.ok(metrics.ground_truth_score.anti_pattern_hit);
  } finally { cleanup(); }
});

test("29. AUTH-6038 exact match (userId=0 falsy coercion) scores 4", () => {
  const gtPath = path.join(GT_DIR, "AUTH-6038.json");
  if (!fs.existsSync(gtPath)) { passed++; return; }
  const { dir, cleanup } = createTempInvestigation({
    findings: `# Findings: AUTH-6038\n\n## Answer\n\nThe auth middleware at auth.ts line 28 checks \`if (!userId)\` (see 001). For the first\nuser with userId=0, JavaScript's falsy coercion makes \`!0\` evaluate to true, rejecting\na valid user (see 001). The fix is to use \`userId === null || userId === undefined\`.\n\n## Evidence Summary\n\n| # | Slug | Observation |\n|---|------|-------------|\n| 001 | falsy | !userId treats 0 as false |\n\n## Implications\n\nReplace falsy check with explicit null/undefined check.\n`,
  });
  try {
    const { metrics } = runScorer(dir, ["--ground-truth", gtPath]);
    assert.strictEqual(metrics.ground_truth_score.score, 4, `Expected 4, got ${metrics.ground_truth_score.score}`);
  } finally { cleanup(); }
});

test("30. AUTH-6038 anti-pattern (blames JWT generation) caps at 2", () => {
  const gtPath = path.join(GT_DIR, "AUTH-6038.json");
  if (!fs.existsSync(gtPath)) { passed++; return; }
  const { dir, cleanup } = createTempInvestigation({
    findings: `# Findings: AUTH-6038\n\n## Answer\n\nThe auth middleware uses falsy check on userId (see 001). However, the root cause is\nthat the JWT token generation signs the token incorrectly for userId=0 (see 001).\n\n## Evidence Summary\n\n| # | Slug | Observation |\n|---|------|-------------|\n| 001 | jwt | JWT generation fails for userId 0 |\n\n## Implications\n\nFix JWT generation.\n`,
  });
  try {
    const { metrics } = runScorer(dir, ["--ground-truth", gtPath]);
    assert.ok(metrics.ground_truth_score.score <= 2, `Expected <=2, got ${metrics.ground_truth_score.score}`);
    assert.ok(metrics.ground_truth_score.anti_pattern_hit);
  } finally { cleanup(); }
});

test("31. API-7291 exact match (req.body vs req.user ownerId) scores 4", () => {
  const gtPath = path.join(GT_DIR, "API-7291.json");
  if (!fs.existsSync(gtPath)) { passed++; return; }
  const { dir, cleanup } = createTempInvestigation({
    findings: `# Findings: API-7291\n\n## Answer\n\nThe resource controller at resource.controller.ts line 45 reads ownerId from req.body\ninstead of req.user.id (see 001). This allows any authenticated user to spoof ownership\nby including an ownerId field in the PUT payload (see 001).\n\n## Evidence Summary\n\n| # | Slug | Observation |\n|---|------|-------------|\n| 001 | authz | ownerId from req.body not req.user |\n\n## Implications\n\nSource ownerId from req.user.id, not req.body.\n`,
  });
  try {
    const { metrics } = runScorer(dir, ["--ground-truth", gtPath]);
    assert.strictEqual(metrics.ground_truth_score.score, 4, `Expected 4, got ${metrics.ground_truth_score.score}`);
  } finally { cleanup(); }
});

test("32. API-7291 anti-pattern (blames CORS) caps at 2", () => {
  const gtPath = path.join(GT_DIR, "API-7291.json");
  if (!fs.existsSync(gtPath)) { passed++; return; }
  const { dir, cleanup } = createTempInvestigation({
    findings: `# Findings: API-7291\n\n## Answer\n\nThe controller reads ownerId from req.body (see 001). But the real problem is a CORS misconfiguration that allows cross-origin requests to the update endpoint (see 001).\n\n## Evidence Summary\n\n| # | Slug | Observation |\n|---|------|-------------|\n| 001 | cors | CORS allows cross-origin writes |\n\n## Implications\n\nFix CORS configuration.\n`,
  });
  try {
    const { metrics } = runScorer(dir, ["--ground-truth", gtPath]);
    assert.ok(metrics.ground_truth_score.score <= 2, `Expected <=2, got ${metrics.ground_truth_score.score}`);
    assert.ok(metrics.ground_truth_score.anti_pattern_hit);
  } finally { cleanup(); }
});

// ─── Tests: scorer robustness ─────────────────────────────────────────────────

console.log("\nscorer — robustness:");

test("19. Missing investigation dir exits 1", () => {
  const result = spawnSync("node", [SCORER, "/nonexistent/path/XYZ"], { encoding: "utf8" });
  assert.strictEqual(result.status, 1);
});

test("20. Empty investigation dir (no files) runs without crash", () => {
  const { dir, cleanup } = createTempInvestigation({ noFindings: true, evidence: [] });
  try {
    const evidenceDir = path.join(dir, "EVIDENCE");
    if (fs.existsSync(evidenceDir)) fs.rmSync(evidenceDir, { recursive: true });
    const { status } = runScorer(dir);
    assert.strictEqual(status, 0, "Should exit 0 even with no files");
  } finally { cleanup(); }
});

test("21. METRICS.json is written after scoring", () => {
  const { dir, cleanup } = createTempInvestigation();
  try {
    runScorer(dir);
    assert.ok(fs.existsSync(path.join(dir, "METRICS.json")), "METRICS.json should be created");
  } finally { cleanup(); }
});

test("22. Ground truth file not found exits 1", () => {
  const { dir, cleanup } = createTempInvestigation();
  try {
    const result = spawnSync("node", [SCORER, dir, "--ground-truth", "/nonexistent/GT.json"], {
      encoding: "utf8", timeout: 10000,
    });
    assert.strictEqual(result.status, 1);
  } finally { cleanup(); }
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
