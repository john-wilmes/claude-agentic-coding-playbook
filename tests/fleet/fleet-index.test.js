#!/usr/bin/env node
// Integration tests for templates/fleet/fleet-index.js
// Zero dependencies — uses only Node built-ins.
//
// Run: node tests/hooks/fleet-index.test.js

"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const MODULE_PATH = path.join(REPO_ROOT, "templates", "fleet", "fleet-index.js");

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

// ─── Module loader ────────────────────────────────────────────────────────────

function requireModule() {
  delete require.cache[require.resolve(MODULE_PATH)];
  return require(MODULE_PATH);
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

/**
 * Create a temp directory and return its path.
 * @returns {string}
 */
function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fleet-test-"));
}

/**
 * Create a fake repo directory with the given files, then init a git repo
 * with an initial commit so getHeadHash() works.
 *
 * @param {string} dir    — parent directory in which to create the repo dir
 * @param {string} name   — directory name for the repo (e.g. "org_myrepo")
 * @param {object} files  — map of relative path -> string content
 * @returns {string} absolute path to the created repo dir
 */
function createFakeRepo(dir, name, files = {}) {
  const repoDir = path.join(dir, name);
  fs.mkdirSync(repoDir, { recursive: true });

  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(repoDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf8");
  }

  // Initialize git and create a commit so HEAD is resolvable.
  const gitOpts = { cwd: repoDir, stdio: "pipe", encoding: "utf8" };
  spawnSync("git", ["init"], gitOpts);
  spawnSync("git", ["config", "user.email", "test@test.com"], gitOpts);
  spawnSync("git", ["config", "user.name", "Test"], gitOpts);

  // Add a placeholder file so git commit succeeds even when files = {}.
  if (Object.keys(files).length === 0) {
    fs.writeFileSync(path.join(repoDir, ".gitkeep"), "");
  }

  spawnSync("git", ["add", "."], gitOpts);
  spawnSync("git", ["commit", "-m", "initial commit", "--allow-empty"], gitOpts);

  return repoDir;
}

/**
 * Remove a temp directory recursively.
 * @param {string} dir
 */
function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

// ─── Tests ────────────────────────────────────────────────────────────────────

console.log("\nfleet-index.js:");

// ─── 1. parseFleetYaml ────────────────────────────────────────────────────────

test("1. parseFleetYaml parses simple key-value pairs", () => {
  const { parseFleetYaml } = requireModule();
  const result = parseFleetYaml(`name: my-service\nlanguage: typescript\nframework: express\n`);
  assert.strictEqual(result.name, "my-service", "name should parse");
  assert.strictEqual(result.language, "typescript", "language should parse");
  assert.strictEqual(result.framework, "express", "framework should parse");
});

test("2. parseFleetYaml parses inline arrays", () => {
  const { parseFleetYaml } = requireModule();
  const result = parseFleetYaml(`tags: [tier:backend, domain:payments]\n`);
  assert.ok(Array.isArray(result.tags), "tags should be an array");
  assert.ok(result.tags.includes("tier:backend"), "tags should include tier:backend");
  assert.ok(result.tags.includes("domain:payments"), "tags should include domain:payments");
});

test("3. parseFleetYaml parses depends_on sequences", () => {
  const { parseFleetYaml } = requireModule();
  const yaml = `
depends_on:
  - repo: org/auth-service
    via: http
    confidence: high
  - repo: org/db-proxy
    via: env
    confidence: medium
`.trim();
  const result = parseFleetYaml(yaml);
  assert.ok(Array.isArray(result.depends_on), "depends_on should be an array");
  assert.strictEqual(result.depends_on.length, 2, "should have 2 depends_on entries");
  assert.strictEqual(result.depends_on[0].repo, "org/auth-service", "first repo should match");
  assert.strictEqual(result.depends_on[0].via, "http", "first via should match");
  assert.strictEqual(result.depends_on[0].confidence, "high", "first confidence should match");
  assert.strictEqual(result.depends_on[1].repo, "org/db-proxy", "second repo should match");
});

test("4. parseFleetYaml returns empty object for empty input", () => {
  const { parseFleetYaml } = requireModule();
  assert.deepStrictEqual(parseFleetYaml(""), {}, "empty string should yield empty object");
  assert.deepStrictEqual(parseFleetYaml(null), {}, "null should yield empty object");
});

// ─── 2. computeQuality ────────────────────────────────────────────────────────

test("5. computeQuality returns 100 for fully-populated manifest", () => {
  const { computeQuality } = requireModule();
  const manifest = {
    kind: "service",
    name: "payment-api",
    repo: "org/payment-api",
    description: "Handles payments",
    language: "typescript",
    framework: "express",
    runtime: "docker",
    owner: "@payments-team",
    lifecycle: "production",
  };
  assert.strictEqual(computeQuality(manifest), 100, "fully-populated manifest should score 100");
});

test("6. computeQuality returns low score for sparse manifest", () => {
  const { computeQuality } = requireModule();
  // Only 'kind' and 'name' are present (2 of 9 QUALITY_FIELDS)
  const manifest = { kind: "tool", name: "my-tool" };
  const score = computeQuality(manifest);
  assert.ok(score > 0, "score should be > 0 when some fields present");
  assert.ok(score < 100, "score should be < 100 for sparse manifest");
  // 2/9 = ~22%
  assert.strictEqual(score, Math.round(2 / 9 * 100), `expected ${Math.round(2 / 9 * 100)}, got ${score}`);
});

test("7. computeQuality returns 0 for empty manifest", () => {
  const { computeQuality } = requireModule();
  assert.strictEqual(computeQuality({}), 0, "empty manifest should score 0");
});

// ─── 3. generateDigest ────────────────────────────────────────────────────────

test("8. generateDigest returns empty string for empty manifests", () => {
  const { generateDigest } = requireModule();
  assert.strictEqual(generateDigest([]), "", "empty array should produce empty string");
  assert.strictEqual(generateDigest(null), "", "null should produce empty string");
});

test("9. generateDigest produces columnar format with header", () => {
  const { generateDigest } = requireModule();
  const manifests = [
    { repo: "org/api", kind: "service", language: "typescript", framework: "express", tags: ["domain:payments"], quality: 88 },
    { repo: "org/worker", kind: "tool", language: "python", framework: "", tags: [], quality: 44, stub: true },
  ];
  const digest = generateDigest(manifests);
  assert.ok(digest.includes("Fleet Index"), "digest should contain 'Fleet Index' header");
  assert.ok(digest.includes("org/api"), "digest should contain first repo");
  assert.ok(digest.includes("org/worker"), "digest should contain second repo");
  assert.ok(digest.includes("Q:88"), "digest should contain quality score for first repo");
  assert.ok(digest.includes("Q:44"), "digest should contain quality score for second repo");
  assert.ok(digest.includes("warning stub"), "digest should mark stub repos");
  assert.ok(digest.includes("|"), "digest should use pipe column separator");
});

test("10. generateDigest uses lang/framework combo when framework is set", () => {
  const { generateDigest } = requireModule();
  const manifests = [
    { repo: "org/api", kind: "service", language: "typescript", framework: "express", tags: [], quality: 80 },
  ];
  const digest = generateDigest(manifests);
  assert.ok(digest.includes("typescript/express"), "should combine language/framework");
});

// ─── 4. extractSignals ────────────────────────────────────────────────────────

test("11. extractSignals detects language and name from package.json", () => {
  const { extractSignals } = requireModule();
  const tmpDir = createTempDir();
  try {
    createFakeRepo(tmpDir, "org_myapp", {
      "package.json": JSON.stringify({ name: "myapp", dependencies: { express: "^4.18.0" } }),
    });
    const signals = extractSignals(path.join(tmpDir, "org_myapp"));
    assert.strictEqual(signals.name, "myapp", "name should come from package.json");
    assert.strictEqual(signals.language, "javascript", "language should be javascript");
    assert.strictEqual(signals.framework, "express", "framework should be express");
  } finally {
    cleanup(tmpDir);
  }
});

test("12. extractSignals detects docker signals from Dockerfile", () => {
  const { extractSignals } = requireModule();
  const tmpDir = createTempDir();
  try {
    createFakeRepo(tmpDir, "org_svc", {
      "Dockerfile": "FROM node:18\nEXPOSE 3000\n",
    });
    const signals = extractSignals(path.join(tmpDir, "org_svc"));
    assert.strictEqual(signals.hasDockerfile, true, "hasDockerfile should be true");
    assert.strictEqual(signals.runtime, "docker", "runtime should be docker");
    assert.ok(signals.ports.includes(3000), "ports should include 3000");
  } finally {
    cleanup(tmpDir);
  }
});

test("13. extractSignals reads README description", () => {
  const { extractSignals } = requireModule();
  const tmpDir = createTempDir();
  try {
    createFakeRepo(tmpDir, "org_mylib", {
      "README.md": "# My Library\n\nA utility library for parsing things.\n\nMore detail here.",
    });
    const signals = extractSignals(path.join(tmpDir, "org_mylib"));
    assert.ok(
      signals.description.includes("utility library"),
      `description should contain README first paragraph, got: "${signals.description}"`
    );
  } finally {
    cleanup(tmpDir);
  }
});

test("14. extractSignals reads env var names from .env.example", () => {
  const { extractSignals } = requireModule();
  const tmpDir = createTempDir();
  try {
    createFakeRepo(tmpDir, "org_svc", {
      ".env.example": "DATABASE_URL=postgres://localhost/mydb\nREDIS_URL=redis://localhost\nAPP_PORT=3000\n",
    });
    const signals = extractSignals(path.join(tmpDir, "org_svc"));
    assert.ok(signals.envVars.includes("DATABASE_URL"), "envVars should include DATABASE_URL");
    assert.ok(signals.envVars.includes("REDIS_URL"), "envVars should include REDIS_URL");
    assert.ok(signals.envVars.includes("APP_PORT"), "envVars should include APP_PORT");
  } finally {
    cleanup(tmpDir);
  }
});

test("15. extractSignals reads owner from CODEOWNERS", () => {
  const { extractSignals } = requireModule();
  const tmpDir = createTempDir();
  try {
    createFakeRepo(tmpDir, "org_svc", {
      "CODEOWNERS": "* @platform-team\n",
    });
    const signals = extractSignals(path.join(tmpDir, "org_svc"));
    assert.strictEqual(signals.owner, "@platform-team", "owner should be extracted from CODEOWNERS");
  } finally {
    cleanup(tmpDir);
  }
});

test("16. extractSignals returns empty signals for empty repo", () => {
  const { extractSignals } = requireModule();
  const tmpDir = createTempDir();
  try {
    createFakeRepo(tmpDir, "org_empty", {});
    const signals = extractSignals(path.join(tmpDir, "org_empty"));
    assert.strictEqual(typeof signals, "object", "should return an object");
    assert.strictEqual(signals.language, "", "language should be empty string");
    assert.strictEqual(signals.hasDockerfile, false, "hasDockerfile should be false");
    assert.deepStrictEqual(signals.ports, [], "ports should be empty");
  } finally {
    cleanup(tmpDir);
  }
});

// ─── 5. generateManifest ─────────────────────────────────────────────────────

test("17. generateManifest has correct schema fields", () => {
  const { generateManifest } = requireModule();
  const signals = {
    name: "payment-api",
    language: "typescript",
    framework: "express",
    description: "Handles payments",
    owner: "@payments-team",
    runtime: "docker",
    ports: [3000],
    envVars: [],
    dependsOnRaw: [],
    provides_apis: [],
    tags: [],
    lifecycle: "production",
    deployTargets: [],
    environments: [],
    hasDockerfile: true,
    hasDockerCompose: false,
    fleetYaml: null,
  };
  const manifest = generateManifest("org/payment-api", signals, []);
  assert.ok("schemaVersion" in manifest, "should have schemaVersion");
  assert.ok("kind" in manifest, "should have kind");
  assert.ok("name" in manifest, "should have name");
  assert.ok("repo" in manifest, "should have repo");
  assert.ok("description" in manifest, "should have description");
  assert.ok("language" in manifest, "should have language");
  assert.ok("quality" in manifest, "should have quality");
  assert.ok("lastIndexed" in manifest, "should have lastIndexed");
  assert.ok("sourceHash" in manifest, "should have sourceHash");
  assert.strictEqual(manifest.repo, "org/payment-api", "repo should be set correctly");
  assert.strictEqual(manifest.name, "payment-api", "name should come from signals");
  assert.ok(manifest.quality >= 0 && manifest.quality <= 100, "quality should be 0-100");
});

test("18. generateManifest marks low-quality manifests as stub", () => {
  const { generateManifest } = requireModule();
  // Minimal signals — will produce quality < 50
  const signals = {
    name: "", language: "", framework: "", description: "", owner: "",
    runtime: "", ports: [], envVars: [], dependsOnRaw: [], provides_apis: [],
    tags: [], lifecycle: "", deployTargets: [], environments: [],
    hasDockerfile: false, hasDockerCompose: false, fleetYaml: null,
  };
  const manifest = generateManifest("org/sparse", signals, []);
  assert.ok(manifest.stub === true, "sparse manifest should be marked as stub");
});

test("19. generateManifest applies .fleet.yaml overrides", () => {
  const { generateManifest } = requireModule();
  const signals = {
    name: "auto-name", language: "javascript", framework: "", description: "",
    owner: "", runtime: "", ports: [], envVars: [], dependsOnRaw: [],
    provides_apis: [], tags: [], lifecycle: "", deployTargets: [], environments: [],
    hasDockerfile: false, hasDockerCompose: false,
    fleetYaml: { name: "manual-name", kind: "library", lifecycle: "production" },
  };
  const manifest = generateManifest("org/mylib", signals, []);
  assert.strictEqual(manifest.name, "manual-name", ".fleet.yaml name should override auto-detected name");
  assert.strictEqual(manifest.kind, "library", ".fleet.yaml kind should override inferred kind");
  assert.strictEqual(manifest.lifecycle, "production", ".fleet.yaml lifecycle should override");
});

// ─── 6. buildIndex ────────────────────────────────────────────────────────────

test("20. buildIndex creates manifest files and fleet-digest.txt", () => {
  const { buildIndex } = requireModule();
  const reposDir = createTempDir();
  const outputDir = createTempDir();
  try {
    createFakeRepo(reposDir, "org_alpha", {
      "package.json": JSON.stringify({ name: "alpha", dependencies: { express: "^4" } }),
      "README.md": "# Alpha\n\nThe alpha service.\n",
    });
    createFakeRepo(reposDir, "org_beta", {
      "Dockerfile": "FROM python:3.11\nEXPOSE 8080\n",
      "README.md": "# Beta\n\nThe beta service.\n",
    });

    const result = buildIndex(reposDir, outputDir, { verbose: false });

    assert.strictEqual(result.stats.indexed, 2, "should have indexed 2 repos");
    assert.strictEqual(result.stats.errors, 0, "should have 0 errors");
    assert.ok(
      fs.existsSync(path.join(outputDir, "fleet-digest.txt")),
      "fleet-digest.txt should be created"
    );
    assert.ok(
      fs.existsSync(path.join(outputDir, "org_alpha.json")),
      "org_alpha.json manifest should be created"
    );
    assert.ok(
      fs.existsSync(path.join(outputDir, "org_beta.json")),
      "org_beta.json manifest should be created"
    );
  } finally {
    cleanup(reposDir);
    cleanup(outputDir);
  }
});

test("21. buildIndex manifests have correct sourceHash", () => {
  const { buildIndex } = requireModule();
  const reposDir = createTempDir();
  const outputDir = createTempDir();
  try {
    createFakeRepo(reposDir, "org_myhash", {
      "README.md": "# Hash Test\n\nTests sourceHash.\n",
    });

    buildIndex(reposDir, outputDir, {});

    const manifest = JSON.parse(
      fs.readFileSync(path.join(outputDir, "org_myhash.json"), "utf8")
    );
    assert.ok(
      typeof manifest.sourceHash === "string" && manifest.sourceHash.length > 0,
      "sourceHash should be a non-empty string (git commit hash)"
    );
    // Git SHA-1 hashes are 40 hex chars
    assert.ok(
      /^[0-9a-f]{40}$/.test(manifest.sourceHash),
      `sourceHash should be a 40-char hex string, got: ${manifest.sourceHash}`
    );
  } finally {
    cleanup(reposDir);
    cleanup(outputDir);
  }
});

test("22. buildIndex returns empty result for missing repos dir", () => {
  const { buildIndex } = requireModule();
  const outputDir = createTempDir();
  try {
    const result = buildIndex("/nonexistent/path/that/does/not/exist", outputDir, {});
    assert.strictEqual(result.stats.indexed, 0, "should index 0 repos when dir missing");
    assert.deepStrictEqual(result.manifests, [], "manifests should be empty array");
  } finally {
    cleanup(outputDir);
  }
});

// ─── 7. refreshIndex ─────────────────────────────────────────────────────────

test("23. refreshIndex skips unchanged repos and updates changed repos", () => {
  const { buildIndex, refreshIndex } = requireModule();
  const reposDir = createTempDir();
  const outputDir = createTempDir();
  try {
    // Create two repos
    const alphaDir = createFakeRepo(reposDir, "org_alpha", {
      "README.md": "# Alpha\n\nInitial.\n",
    });
    createFakeRepo(reposDir, "org_beta", {
      "README.md": "# Beta\n\nInitial beta.\n",
    });

    // Initial build
    buildIndex(reposDir, outputDir, {});

    // Read initial manifest for beta (unchanged repo)
    const betaManifestBefore = JSON.parse(
      fs.readFileSync(path.join(outputDir, "org_beta.json"), "utf8")
    );

    // Modify alpha by adding a new commit
    fs.writeFileSync(path.join(alphaDir, "NEWFILE.md"), "# New\n");
    const gitOpts = { cwd: alphaDir, stdio: "pipe", encoding: "utf8" };
    spawnSync("git", ["add", "."], gitOpts);
    spawnSync("git", ["commit", "-m", "second commit"], gitOpts);

    // Refresh
    const refreshResult = refreshIndex(reposDir, outputDir, { verbose: false });

    assert.ok(
      refreshResult.updated.includes("org/alpha"),
      "alpha should be in updated list after new commit"
    );
    assert.ok(
      refreshResult.skipped.includes("org/beta"),
      "beta should be in skipped list (unchanged)"
    );
    assert.strictEqual(refreshResult.stats.updated, 1, "should have updated 1 repo");
    assert.strictEqual(refreshResult.stats.skipped, 1, "should have skipped 1 repo");

    // Beta manifest should have the same sourceHash
    const betaManifestAfter = JSON.parse(
      fs.readFileSync(path.join(outputDir, "org_beta.json"), "utf8")
    );
    assert.strictEqual(
      betaManifestBefore.sourceHash,
      betaManifestAfter.sourceHash,
      "beta sourceHash should be unchanged after refresh"
    );
  } finally {
    cleanup(reposDir);
    cleanup(outputDir);
  }
});

test("24. refreshIndex re-generates fleet-digest.txt", () => {
  const { buildIndex, refreshIndex } = requireModule();
  const reposDir = createTempDir();
  const outputDir = createTempDir();
  try {
    createFakeRepo(reposDir, "org_gamma", { "README.md": "# Gamma\n\nService.\n" });

    buildIndex(reposDir, outputDir, {});
    refreshIndex(reposDir, outputDir, {});

    assert.ok(
      fs.existsSync(path.join(outputDir, "fleet-digest.txt")),
      "fleet-digest.txt should exist after refresh"
    );
    const digest = fs.readFileSync(path.join(outputDir, "fleet-digest.txt"), "utf8");
    assert.ok(digest.includes("org/gamma"), "digest should include gamma repo after refresh");
  } finally {
    cleanup(reposDir);
    cleanup(outputDir);
  }
});

// ─── 8. searchRepos ───────────────────────────────────────────────────────────

test("25. searchRepos returns results ranked by relevance", () => {
  const { buildIndex, searchRepos } = requireModule();
  const reposDir = createTempDir();
  const outputDir = createTempDir();
  try {
    createFakeRepo(reposDir, "org_payments", {
      "package.json": JSON.stringify({ name: "payment-service", dependencies: { express: "^4" } }),
      "README.md": "# Payment Service\n\nHandles payment processing with Stripe.\n",
    });
    createFakeRepo(reposDir, "org_users", {
      "package.json": JSON.stringify({ name: "user-service", dependencies: { express: "^4" } }),
      "README.md": "# User Service\n\nHandles user accounts and authentication.\n",
    });

    buildIndex(reposDir, outputDir, {});

    const hits = searchRepos(outputDir, "payment stripe", 10);
    assert.ok(Array.isArray(hits), "searchRepos should return an array");
    assert.ok(hits.length > 0, "should return at least one result for 'payment stripe'");
    // The payment repo should rank higher than user repo
    assert.ok(
      hits[0].repo === "org/payments",
      `payment service should rank first, got: ${hits[0] && hits[0].repo}`
    );
    // Each hit should have repo, score, and manifest fields
    assert.ok("repo" in hits[0], "hit should have repo field");
    assert.ok("score" in hits[0], "hit should have score field");
    assert.ok("manifest" in hits[0], "hit should have manifest field");
  } finally {
    cleanup(reposDir);
    cleanup(outputDir);
  }
});

test("26. searchRepos returns empty array for empty output dir", () => {
  const { searchRepos } = requireModule();
  const outputDir = createTempDir();
  try {
    const hits = searchRepos(outputDir, "anything", 10);
    assert.deepStrictEqual(hits, [], "should return empty array when no manifests exist");
  } finally {
    cleanup(outputDir);
  }
});

// ─── 9. listRepos ─────────────────────────────────────────────────────────────

test("27. listRepos returns all repos with correct fields", () => {
  const { buildIndex, listRepos } = requireModule();
  const reposDir = createTempDir();
  const outputDir = createTempDir();
  try {
    createFakeRepo(reposDir, "acme_frontend", {
      "package.json": JSON.stringify({ name: "frontend", dependencies: { react: "^18" } }),
    });
    createFakeRepo(reposDir, "acme_backend", {
      "package.json": JSON.stringify({ name: "backend", dependencies: { express: "^4" } }),
      "Dockerfile": "FROM node:18\nEXPOSE 4000\n",
    });
    createFakeRepo(reposDir, "acme_infra", {
      "README.md": "# Infrastructure\n\nTerraform configs.\n",
    });

    buildIndex(reposDir, outputDir, {});

    const repos = listRepos(outputDir);
    assert.ok(Array.isArray(repos), "listRepos should return an array");
    assert.strictEqual(repos.length, 3, "should list 3 repos");

    const names = repos.map(r => r.repo);
    assert.ok(names.includes("acme/frontend"), "should include acme/frontend");
    assert.ok(names.includes("acme/backend"), "should include acme/backend");
    assert.ok(names.includes("acme/infra"), "should include acme/infra");

    // Each entry should have required summary fields
    for (const r of repos) {
      assert.ok("repo" in r, "each entry should have repo field");
      assert.ok("kind" in r, "each entry should have kind field");
      assert.ok("language" in r, "each entry should have language field");
      assert.ok("quality" in r, "each entry should have quality field");
    }
  } finally {
    cleanup(reposDir);
    cleanup(outputDir);
  }
});

test("28. listRepos returns empty array when output dir is empty", () => {
  const { listRepos } = requireModule();
  const outputDir = createTempDir();
  try {
    const repos = listRepos(outputDir);
    assert.deepStrictEqual(repos, [], "should return empty array when no manifests exist");
  } finally {
    cleanup(outputDir);
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
