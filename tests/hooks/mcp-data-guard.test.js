#!/usr/bin/env node
// Unit + integration tests for templates/hooks/mcp-data-guard.js
// Zero dependencies — uses only Node built-ins + test-helpers.
//
// Run: node tests/hooks/mcp-data-guard.test.js

"use strict";

const assert = require("assert");
const path = require("path");

const { runHook, runHookRaw, createTempHome } = require("./test-helpers");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const HOOK_PATH = path.join(REPO_ROOT, "templates", "hooks", "mcp-data-guard.js");

// Load exported functions for unit tests
const {
  checkMcpDataCall,
  checkPhantomCollection,
  checkBareObjectId,
  checkEmptyFilter,
  checkSnowflakeLimit,
  checkDatadogRange,
  checkDatadogPhantomFilters,
  checkAppointmentStatus,
  checkCollectionDiscovered,
  saveDiscovered,
  getDiscoveryStatePath,
  autoFixFindLimit,
  autoFixAggregateLimit,
  COLLECTIONS,
  PHANTOM_COLLECTIONS,
  STRING_ID_FIELDS,
} = require(HOOK_PATH);

const fs = require("fs");
const os = require("os");

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

// ─── Integration test helpers ─────────────────────────────────────────────────

function runGuard(toolName, toolInput, env) {
  return runHook(HOOK_PATH, {
    tool_name: toolName,
    tool_input: toolInput,
  }, { HOME: env.home, USERPROFILE: env.home });
}

function assertBlocked(result, label) {
  assert.strictEqual(result.status, 0, `${label}: exit 0`);
  assert.ok(result.json?.hookSpecificOutput?.permissionDecision === "deny",
    `${label}: expected deny, got: ${JSON.stringify(result.json)}`);
}

function assertAllowed(result, label) {
  assert.strictEqual(result.status, 0, `${label}: exit 0`);
  assert.ok(result.json && typeof result.json === "object",
    `${label}: expected valid JSON object, got: ${JSON.stringify(result.json)}`);
  const hso = result.json?.hookSpecificOutput;
  // Allowed means either no hookSpecificOutput, or permissionDecision is explicitly not "deny"
  if (hso && hso.permissionDecision) {
    assert.notStrictEqual(hso.permissionDecision, "deny",
      `${label}: expected allow, got: ${JSON.stringify(result.json)}`);
  }
}

function assertUpdated(result, label) {
  assert.strictEqual(result.status, 0, `${label}: exit 0`);
  assert.ok(result.json?.hookSpecificOutput?.updatedInput,
    `${label}: expected updatedInput, got: ${JSON.stringify(result.json)}`);
  return result.json.hookSpecificOutput.updatedInput;
}

function getDenyReason(result) {
  return result.json?.hookSpecificOutput?.permissionDecisionReason || "";
}

/**
 * Seed the discovery state for one or more collections by writing the state file
 * directly into the temp HOME. This is required before any find/aggregate test that
 * expects an allowed result, since ALL collections now require prior discovery.
 *
 * The hook reads from $HOME/.claude/projects/<cwd-slug>/discovered-collections.json
 * where cwd-slug is process.cwd() with "/" replaced by "-". We must create the
 * directory before writing, since saveDiscovered() silently ignores missing dirs.
 *
 * @param {object} env - createTempHome() result (with .home and .cleanup)
 * @param {string[]} collections - collection names to mark as discovered
 */
function seedDiscovery(env, collections) {
  // Replicate getDiscoveryStatePath logic from the hook:
  // slug = cwd.replace(/\//g, "-"), stored under $HOME/.claude/projects/<slug>/
  const cwd = process.cwd();
  const slug = cwd.replace(/\//g, "-");
  const projectDir = path.join(env.home, ".claude", "projects", slug);
  const statePath = path.join(projectDir, "discovered-collections.json");
  // Load existing state (may already have some collections from previous seedDiscovery calls)
  let existing = [];
  try { existing = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch {}
  const merged = [...new Set([...existing, ...collections])];
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(merged), "utf8");
}

// ─── Unit tests: checkPhantomCollection ──────────────────────────────────────

console.log("\nmcp-data-guard.js (unit: checkPhantomCollection):");

unitTest("U1. providers -> deny with users guidance", () => {
  const r = checkPhantomCollection("mcp__mongodb__find", { collection: "providers" });
  assert.ok(r, "Expected deny result");
  assert.strictEqual(r.action, "deny");
  assert.ok(r.reason.includes("users"), `Missing 'users': ${r.reason}`);
  assert.ok(r.reason.includes('type: "doctor"'), `Missing type filter: ${r.reason}`);
});

unitTest("U2. patients -> deny with users guidance", () => {
  const r = checkPhantomCollection("mcp__mongodb__find", { collection: "patients" });
  assert.ok(r, "Expected deny result");
  assert.strictEqual(r.action, "deny");
  assert.ok(r.reason.includes("users"), `Missing 'users': ${r.reason}`);
  assert.ok(r.reason.includes('type: "patient"'), `Missing type filter: ${r.reason}`);
});

unitTest("U3. users collection -> null (allow)", () => {
  const r = checkPhantomCollection("mcp__mongodb__find", { collection: "users" });
  assert.strictEqual(r, null);
});

unitTest("U4. appointments collection -> null (allow)", () => {
  const r = checkPhantomCollection("mcp__mongodb__find", { collection: "appointments" });
  assert.strictEqual(r, null);
});

unitTest("U5. aggregate on providers -> deny", () => {
  const r = checkPhantomCollection("mcp__mongodb__aggregate", { collection: "providers", pipeline: [] });
  assert.ok(r && r.action === "deny", "Expected deny");
});

unitTest("U6. deny reason mentions type filter", () => {
  const r = checkPhantomCollection("mcp__mongodb__find", { collection: "providers" });
  assert.ok(r.reason.includes("type"), `Missing type mention: ${r.reason}`);
});

// ─── Unit tests: checkBareObjectId ───────────────────────────────────────────

console.log("\nmcp-data-guard.js (unit: checkBareObjectId):");

const SAMPLE_HEX = "5f43a2b1c8d9e7f6a0b1c2d3";

unitTest("U7. bare hex in _id filter -> deny", () => {
  const r = checkBareObjectId("mcp__mongodb__find", {
    filter: { _id: SAMPLE_HEX },
  });
  assert.ok(r && r.action === "deny", `Expected deny, got: ${JSON.stringify(r)}`);
  assert.ok(r.reason.includes(SAMPLE_HEX), `Missing hex in reason: ${r.reason}`);
});

unitTest("U8. hex wrapped in $oid -> null (allow)", () => {
  const r = checkBareObjectId("mcp__mongodb__find", {
    filter: { _id: { $oid: SAMPLE_HEX } },
  });
  assert.strictEqual(r, null, `Expected null, got: ${JSON.stringify(r)}`);
});

unitTest("U9. hex in org field -> null (string exception)", () => {
  const r = checkBareObjectId("mcp__mongodb__find", {
    filter: { org: SAMPLE_HEX },
  });
  assert.strictEqual(r, null, `Expected null (org is string field), got: ${JSON.stringify(r)}`);
});

unitTest("U10. bare hex in $in array -> deny", () => {
  const r = checkBareObjectId("mcp__mongodb__find", {
    filter: { _id: { $in: [SAMPLE_HEX] } },
  });
  assert.ok(r && r.action === "deny", `Expected deny, got: ${JSON.stringify(r)}`);
});

unitTest("U11. no hex strings in filter -> null (allow)", () => {
  const r = checkBareObjectId("mcp__mongodb__find", {
    filter: { status: "confirmed", org: "some-org-id" },
  });
  assert.strictEqual(r, null);
});

unitTest("U12. bare hex in aggregate pipeline $match -> deny", () => {
  const r = checkBareObjectId("mcp__mongodb__aggregate", {
    pipeline: [{ $match: { provider: SAMPLE_HEX } }],
  });
  assert.ok(r && r.action === "deny", `Expected deny, got: ${JSON.stringify(r)}`);
});

unitTest("U13. short hex (not 24 chars) -> null (allow)", () => {
  const r = checkBareObjectId("mcp__mongodb__find", {
    filter: { _id: "abc123" },
  });
  assert.strictEqual(r, null);
});

unitTest("U14. externalId hex -> null (string exception)", () => {
  const r = checkBareObjectId("mcp__mongodb__find", {
    filter: { externalId: SAMPLE_HEX },
  });
  assert.strictEqual(r, null, `Expected null (externalId is string field), got: ${JSON.stringify(r)}`);
});

// ─── Unit tests: checkEmptyFilter ────────────────────────────────────────────

console.log("\nmcp-data-guard.js (unit: checkEmptyFilter):");

unitTest("U15. empty object filter -> deny", () => {
  const r = checkEmptyFilter("mcp__mongodb__find", { collection: "users", filter: {} });
  assert.ok(r && r.action === "deny", `Expected deny, got: ${JSON.stringify(r)}`);
});

unitTest("U16. missing filter -> deny", () => {
  const r = checkEmptyFilter("mcp__mongodb__find", { collection: "users" });
  assert.ok(r && r.action === "deny", `Expected deny, got: ${JSON.stringify(r)}`);
});

unitTest("U17. null filter -> deny", () => {
  const r = checkEmptyFilter("mcp__mongodb__find", { collection: "users", filter: null });
  assert.ok(r && r.action === "deny", `Expected deny, got: ${JSON.stringify(r)}`);
});

unitTest("U18. non-empty filter -> null (allow)", () => {
  const r = checkEmptyFilter("mcp__mongodb__find", { collection: "users", filter: { type: "doctor" } });
  assert.strictEqual(r, null);
});

unitTest("U19. aggregate with empty pipeline -> null (not find, don't guard)", () => {
  const r = checkEmptyFilter("mcp__mongodb__aggregate", { collection: "users", pipeline: [] });
  assert.strictEqual(r, null);
});

unitTest("U20. deny reason includes collection schema hint", () => {
  const r = checkEmptyFilter("mcp__mongodb__find", { collection: "users", filter: {} });
  assert.ok(r.reason.includes("user.ts"), `Missing schema hint: ${r.reason}`);
});

// ─── Unit tests: checkSnowflakeLimit ─────────────────────────────────────────

console.log("\nmcp-data-guard.js (unit: checkSnowflakeLimit):");

unitTest("U21. SELECT without LIMIT -> deny", () => {
  const r = checkSnowflakeLimit("mcp__snowflake__run_sql", { sql: "SELECT * FROM appointments" });
  assert.ok(r && r.action === "deny", `Expected deny, got: ${JSON.stringify(r)}`);
});

unitTest("U22. SELECT with LIMIT -> null (allow)", () => {
  const r = checkSnowflakeLimit("mcp__snowflake__run_sql", { sql: "SELECT * FROM appointments LIMIT 20" });
  assert.strictEqual(r, null);
});

unitTest("U23. SELECT with TOP -> null (allow)", () => {
  const r = checkSnowflakeLimit("mcp__snowflake__run_sql", { sql: "SELECT TOP 10 * FROM appointments" });
  assert.strictEqual(r, null);
});

unitTest("U24. DESCRIBE table -> null (not SELECT)", () => {
  const r = checkSnowflakeLimit("mcp__snowflake__run_sql", { sql: "DESCRIBE TABLE appointments" });
  assert.strictEqual(r, null);
});

unitTest("U25. select count(*) without LIMIT -> deny", () => {
  const r = checkSnowflakeLimit("mcp__snowflake__run_sql", { sql: "select count(*) from users" });
  assert.ok(r && r.action === "deny", `Expected deny, got: ${JSON.stringify(r)}`);
});

unitTest("U26. case insensitive SELECT -> deny", () => {
  const r = checkSnowflakeLimit("mcp__snowflake__run_sql", { sql: "SELECT id FROM messages WHERE org = 'abc'" });
  assert.ok(r && r.action === "deny", `Expected deny, got: ${JSON.stringify(r)}`);
});

// ─── Unit tests: checkDatadogRange ───────────────────────────────────────────

console.log("\nmcp-data-guard.js (unit: checkDatadogRange):");

unitTest("U27. time_range: 7d -> deny", () => {
  const r = checkDatadogRange("mcp__datadog__get_logs", { time_range: "7d" });
  assert.ok(r && r.action === "deny", `Expected deny, got: ${JSON.stringify(r)}`);
});

unitTest("U28. time_range: 30d -> deny", () => {
  const r = checkDatadogRange("mcp__datadog__get_logs", { time_range: "30d" });
  assert.ok(r && r.action === "deny", `Expected deny, got: ${JSON.stringify(r)}`);
});

unitTest("U29. time_range: 1h -> null (allow)", () => {
  const r = checkDatadogRange("mcp__datadog__get_logs", { time_range: "1h" });
  assert.strictEqual(r, null);
});

unitTest("U30. time_range: 1d -> null (allow, edge)", () => {
  const r = checkDatadogRange("mcp__datadog__get_logs", { time_range: "1d" });
  assert.strictEqual(r, null);
});

unitTest("U31. time_range: 8h -> null (allow)", () => {
  const r = checkDatadogRange("mcp__datadog__get_logs", { time_range: "8h" });
  assert.strictEqual(r, null);
});

unitTest("U32. time_range: 14d -> deny", () => {
  const r = checkDatadogRange("mcp__datadog__get_logs", { time_range: "14d" });
  assert.ok(r && r.action === "deny", `Expected deny, got: ${JSON.stringify(r)}`);
});

unitTest("U32b. no time_range (default 1h) -> null (allow)", () => {
  const r = checkDatadogRange("mcp__datadog__get_logs", {});
  assert.strictEqual(r, null);
});

// ─── Unit tests: checkDatadogPhantomFilters ─────────────────────────────────

console.log("\nmcp-data-guard.js (unit: checkDatadogPhantomFilters):");

unitTest("U50. @rootId filter -> rewrite to @user", () => {
  const r = checkDatadogPhantomFilters("mcp__datadog__get_logs", {
    filters: { "@rootId": "abc123", service: "integrator" },
  });
  assert.ok(r);
  assert.strictEqual(r.action, "update");
  assert.deepStrictEqual(r.updatedInput.filters, { "@user": "abc123", service: "integrator" });
  assert.ok(r.warning.includes("@rootId"));
});

unitTest("U51. @orgId filter -> rewrite to @user", () => {
  const r = checkDatadogPhantomFilters("mcp__datadog__get_logs", {
    filters: { "@orgId": "def456" },
  });
  assert.ok(r);
  assert.strictEqual(r.action, "update");
  assert.deepStrictEqual(r.updatedInput.filters, { "@user": "def456" });
  assert.ok(r.warning.includes("@orgId"));
});

unitTest("U52. @user filter -> null (no rewrite needed)", () => {
  const r = checkDatadogPhantomFilters("mcp__datadog__get_logs", {
    filters: { "@user": "abc123" },
  });
  assert.strictEqual(r, null);
});

unitTest("U53. no filters -> null", () => {
  const r = checkDatadogPhantomFilters("mcp__datadog__get_logs", {});
  assert.strictEqual(r, null);
});

unitTest("U54. non-datadog tool -> null", () => {
  const r = checkDatadogPhantomFilters("mcp__mongodb__find", {
    filters: { "@rootId": "abc" },
  });
  assert.strictEqual(r, null);
});

unitTest("U55. both @rootId and @orgId -> both rewritten, last wins for @user value", () => {
  const r = checkDatadogPhantomFilters("mcp__datadog__get_logs", {
    filters: { "@rootId": "aaa", "@orgId": "bbb" },
  });
  assert.ok(r);
  assert.strictEqual(r.action, "update");
  // Both map to @user; last one overwrites
  assert.ok(r.updatedInput.filters["@user"]);
  assert.ok(r.warning.includes("@rootId"));
  assert.ok(r.warning.includes("@orgId"));
});

// ─── Unit tests: autoFixFindLimit ────────────────────────────────────────────

console.log("\nmcp-data-guard.js (unit: autoFixFindLimit):");

unitTest("U33. missing limit -> returns toolInput with limit:20", () => {
  const r = autoFixFindLimit("mcp__mongodb__find", { collection: "users", filter: { type: "doctor" } });
  assert.ok(r, "Expected non-null");
  assert.strictEqual(r.limit, 20);
  assert.strictEqual(r.collection, "users");
});

unitTest("U34. existing limit:5 -> null (no update)", () => {
  const r = autoFixFindLimit("mcp__mongodb__find", { collection: "users", filter: {}, limit: 5 });
  assert.strictEqual(r, null);
});

unitTest("U35. limit:0 treated as present -> null (no update)", () => {
  const r = autoFixFindLimit("mcp__mongodb__find", { collection: "users", filter: {}, limit: 0 });
  assert.strictEqual(r, null);
});

unitTest("U36. non-find tool -> null", () => {
  const r = autoFixFindLimit("mcp__mongodb__aggregate", { collection: "users", pipeline: [] });
  assert.strictEqual(r, null);
});

// ─── Unit tests: autoFixAggregateLimit ───────────────────────────────────────

console.log("\nmcp-data-guard.js (unit: autoFixAggregateLimit):");

unitTest("U37. pipeline without $limit -> appends { $limit: 20 }", () => {
  const r = autoFixAggregateLimit("mcp__mongodb__aggregate", {
    collection: "users",
    pipeline: [{ $match: { type: "doctor" } }],
  });
  assert.ok(r, "Expected non-null");
  const last = r.pipeline[r.pipeline.length - 1];
  assert.strictEqual(last.$limit, 20);
  assert.strictEqual(r.pipeline.length, 2);
});

unitTest("U38. pipeline with $limit:10 -> null (no update)", () => {
  const r = autoFixAggregateLimit("mcp__mongodb__aggregate", {
    collection: "users",
    pipeline: [{ $match: {} }, { $limit: 10 }],
  });
  assert.strictEqual(r, null);
});

unitTest("U39. empty pipeline -> appends $limit", () => {
  const r = autoFixAggregateLimit("mcp__mongodb__aggregate", {
    collection: "users",
    pipeline: [],
  });
  assert.ok(r, "Expected non-null");
  assert.strictEqual(r.pipeline.length, 1);
  assert.strictEqual(r.pipeline[0].$limit, 20);
});

unitTest("U40. non-aggregate tool -> null", () => {
  const r = autoFixAggregateLimit("mcp__mongodb__find", { collection: "users", filter: {} });
  assert.strictEqual(r, null);
});

// ─── Unit tests: checkMcpDataCall (priority) ─────────────────────────────────

console.log("\nmcp-data-guard.js (unit: checkMcpDataCall priority):");

unitTest("U41. phantom collection + missing limit -> deny (guard before autofix)", () => {
  const r = checkMcpDataCall("mcp__mongodb__find", { collection: "providers", filter: { type: "doctor" } });
  assert.ok(r && r.action === "deny", `Expected deny, got: ${JSON.stringify(r)}`);
});

unitTest("U42. empty filter + missing limit -> deny (guard before autofix)", () => {
  const r = checkMcpDataCall("mcp__mongodb__find", { collection: "users", filter: {} });
  assert.ok(r && r.action === "deny", `Expected deny, got: ${JSON.stringify(r)}`);
});

unitTest("U43. clean find without limit -> update action (with discovery seeded)", () => {
  // getDiscoveryStatePath uses os.homedir() internally; seed against the real cwd path
  const statePath = getDiscoveryStatePath(process.cwd());
  const stateDir = require("path").dirname(statePath);
  let preExisting = null;
  try { preExisting = fs.readFileSync(statePath, "utf8"); } catch {}
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(["users"]), "utf8");
    const r = checkMcpDataCall("mcp__mongodb__find", {
      collection: "users",
      filter: { type: "doctor" },
    }, process.cwd());
    assert.ok(r && r.action === "update", `Expected update, got: ${JSON.stringify(r)}`);
    assert.strictEqual(r.updatedInput.limit, 20);
  } finally {
    // Restore original state
    if (preExisting !== null) {
      fs.writeFileSync(statePath, preExisting, "utf8");
    } else {
      try { fs.unlinkSync(statePath); } catch {}
    }
  }
});

unitTest("U44. clean aggregate without $limit -> update action (with discovery seeded)", () => {
  const statePath = getDiscoveryStatePath(process.cwd());
  const stateDir = require("path").dirname(statePath);
  let preExisting = null;
  try { preExisting = fs.readFileSync(statePath, "utf8"); } catch {}
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(["users"]), "utf8");
    const r = checkMcpDataCall("mcp__mongodb__aggregate", {
      collection: "users",
      pipeline: [{ $match: { type: "doctor" } }],
    }, process.cwd());
    assert.ok(r && r.action === "update", `Expected update, got: ${JSON.stringify(r)}`);
    const last = r.updatedInput.pipeline[r.updatedInput.pipeline.length - 1];
    assert.strictEqual(last.$limit, 20);
  } finally {
    if (preExisting !== null) {
      fs.writeFileSync(statePath, preExisting, "utf8");
    } else {
      try { fs.unlinkSync(statePath); } catch {}
    }
  }
});

unitTest("U45. clean find with limit -> null (no action, with discovery seeded)", () => {
  const statePath = getDiscoveryStatePath(process.cwd());
  const stateDir = require("path").dirname(statePath);
  let preExisting = null;
  try { preExisting = fs.readFileSync(statePath, "utf8"); } catch {}
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(["users"]), "utf8");
    const r = checkMcpDataCall("mcp__mongodb__find", {
      collection: "users",
      filter: { type: "doctor" },
      limit: 10,
    }, process.cwd());
    assert.strictEqual(r, null);
  } finally {
    if (preExisting !== null) {
      fs.writeFileSync(statePath, preExisting, "utf8");
    } else {
      try { fs.unlinkSync(statePath); } catch {}
    }
  }
});

// ─── Integration tests: phantom collections ───────────────────────────────────

console.log("\nmcp-data-guard.js (phantom collections):");

test("I1. providers collection -> deny with users guidance", (env) => {
  const result = runGuard("mcp__mongodb__find", { collection: "providers", filter: { type: "doctor" } }, env);
  assertBlocked(result, "providers collection");
  const reason = getDenyReason(result);
  assert.ok(reason.includes("users"), `Missing 'users': ${reason}`);
});

test("I2. patients collection -> deny with users guidance", (env) => {
  const result = runGuard("mcp__mongodb__find", { collection: "patients", filter: {} }, env);
  assertBlocked(result, "patients collection");
  const reason = getDenyReason(result);
  assert.ok(reason.includes("users"), `Missing 'users': ${reason}`);
  assert.ok(reason.includes("patient"), `Missing 'patient': ${reason}`);
});

test("I3. users collection -> allow", (env) => {
  seedDiscovery(env, ["users"]);
  const result = runGuard("mcp__mongodb__find", {
    collection: "users",
    filter: { type: "doctor" },
    limit: 10,
  }, env);
  assertAllowed(result, "users collection");
});

test("I4. appointments collection -> allow", (env) => {
  seedDiscovery(env, ["appointments"]);
  const result = runGuard("mcp__mongodb__find", {
    collection: "appointments",
    filter: { org: "abc123" },
    limit: 10,
  }, env);
  assertAllowed(result, "appointments collection");
});

test("I5. aggregate on providers -> deny", (env) => {
  const result = runGuard("mcp__mongodb__aggregate", {
    collection: "providers",
    pipeline: [{ $match: {} }, { $limit: 5 }],
  }, env);
  assertBlocked(result, "aggregate on providers");
});

test("I6. deny reason mentions type filter", (env) => {
  const result = runGuard("mcp__mongodb__find", { collection: "providers", filter: {} }, env);
  const reason = getDenyReason(result);
  assert.ok(reason.includes("type"), `Missing 'type' in reason: ${reason}`);
});

// ─── Integration tests: bare ObjectId ────────────────────────────────────────

console.log("\nmcp-data-guard.js (bare ObjectId):");

test("I7. bare hex in _id filter -> deny", (env) => {
  seedDiscovery(env, ["users"]);
  const result = runGuard("mcp__mongodb__find", {
    collection: "users",
    filter: { _id: SAMPLE_HEX },
    limit: 10,
  }, env);
  assertBlocked(result, "bare hex in _id");
  assert.ok(getDenyReason(result).includes(SAMPLE_HEX), "Hex in reason");
});

test("I8. hex wrapped in $oid -> allow", (env) => {
  seedDiscovery(env, ["users"]);
  const result = runGuard("mcp__mongodb__find", {
    collection: "users",
    filter: { _id: { $oid: SAMPLE_HEX } },
    limit: 10,
  }, env);
  assertAllowed(result, "hex in $oid");
});

test("I9. hex in org field -> allow (string exception)", (env) => {
  seedDiscovery(env, ["appointments"]);
  const result = runGuard("mcp__mongodb__find", {
    collection: "appointments",
    filter: { org: SAMPLE_HEX },
    limit: 10,
  }, env);
  assertAllowed(result, "hex in org field");
});

test("I10. bare hex in $in array -> deny", (env) => {
  const result = runGuard("mcp__mongodb__find", {
    collection: "users",
    filter: { _id: { $in: [SAMPLE_HEX] } },
    limit: 10,
  }, env);
  assertBlocked(result, "bare hex in $in");
});

test("I11. no hex strings in filter -> allow", (env) => {
  seedDiscovery(env, ["users"]);
  const result = runGuard("mcp__mongodb__find", {
    collection: "users",
    filter: { type: "doctor", status: "active" },
    limit: 10,
  }, env);
  assertAllowed(result, "no hex strings");
});

test("I12. bare hex in aggregate pipeline $match -> deny", (env) => {
  const result = runGuard("mcp__mongodb__aggregate", {
    collection: "appointments",
    pipeline: [{ $match: { provider: SAMPLE_HEX } }, { $limit: 5 }],
  }, env);
  assertBlocked(result, "bare hex in aggregate $match");
});

test("I13. short hex (not 24 chars) -> allow", (env) => {
  seedDiscovery(env, ["users"]);
  const result = runGuard("mcp__mongodb__find", {
    collection: "users",
    filter: { code: "abc123def" },
    limit: 10,
  }, env);
  assertAllowed(result, "short hex not blocked");
});

// ─── Integration tests: empty filter ─────────────────────────────────────────

console.log("\nmcp-data-guard.js (empty filter):");

test("I14. empty object filter -> deny", (env) => {
  const result = runGuard("mcp__mongodb__find", { collection: "users", filter: {} }, env);
  assertBlocked(result, "empty object filter");
});

test("I15. missing filter -> deny", (env) => {
  const result = runGuard("mcp__mongodb__find", { collection: "users" }, env);
  assertBlocked(result, "missing filter");
});

test("I16. null filter -> deny", (env) => {
  const result = runGuard("mcp__mongodb__find", { collection: "users", filter: null }, env);
  assertBlocked(result, "null filter");
});

test("I17. non-empty filter -> allow (will get auto-fixed limit)", (env) => {
  seedDiscovery(env, ["users"]);
  // non-empty filter passes the guard; may get limit autofix (that's an update, not deny)
  const result = runGuard("mcp__mongodb__find", { collection: "users", filter: { type: "doctor" } }, env);
  assert.strictEqual(result.status, 0, "exit 0");
  const hso = result.json?.hookSpecificOutput;
  assert.ok(!hso || hso.permissionDecision !== "deny",
    `Should not be denied: ${JSON.stringify(result.json)}`);
});

test("I18. aggregate with empty pipeline -> allow (not find)", (env) => {
  seedDiscovery(env, ["users"]);
  // aggregate doesn't check empty filter; empty pipeline gets $limit appended
  const result = runGuard("mcp__mongodb__aggregate", { collection: "users", pipeline: [] }, env);
  assert.strictEqual(result.status, 0, "exit 0");
  assert.ok(result.json?.hookSpecificOutput?.permissionDecision !== "deny",
    `Should not be denied: ${JSON.stringify(result.json)}`);
});

test("I19. deny reason includes collection schema hint", (env) => {
  // Seed discovery so the empty-filter guard fires (not the discovery guard).
  // checkEmptyFilter includes the schema hint (user.ts) in its deny reason.
  seedDiscovery(env, ["users"]);
  const result = runGuard("mcp__mongodb__find", { collection: "users", filter: {} }, env);
  const reason = getDenyReason(result);
  assert.ok(reason.includes("user.ts"), `Missing schema hint: ${reason}`);
});

// ─── Integration tests: Snowflake LIMIT ──────────────────────────────────────

console.log("\nmcp-data-guard.js (Snowflake LIMIT):");

test("I20. SELECT without LIMIT -> deny", (env) => {
  const result = runGuard("mcp__snowflake__run_sql", { sql: "SELECT * FROM appointments" }, env);
  assertBlocked(result, "SELECT without LIMIT");
});

test("I21. SELECT with LIMIT -> allow", (env) => {
  const result = runGuard("mcp__snowflake__run_sql", { sql: "SELECT * FROM appointments LIMIT 20" }, env);
  assertAllowed(result, "SELECT with LIMIT");
});

test("I22. SELECT with TOP -> allow", (env) => {
  const result = runGuard("mcp__snowflake__run_sql", { sql: "SELECT TOP 10 * FROM appointments" }, env);
  assertAllowed(result, "SELECT with TOP");
});

test("I23. DESCRIBE table -> allow (not SELECT)", (env) => {
  const result = runGuard("mcp__snowflake__run_sql", { sql: "DESCRIBE TABLE appointments" }, env);
  assertAllowed(result, "DESCRIBE not blocked");
});

test("I24. select count(*) without LIMIT -> deny", (env) => {
  const result = runGuard("mcp__snowflake__run_sql", { sql: "select count(*) from users" }, env);
  assertBlocked(result, "select count without LIMIT");
});

test("I25. case insensitive SELECT -> deny", (env) => {
  const result = runGuard("mcp__snowflake__run_sql", { sql: "SELECT id FROM messages WHERE org = 'abc'" }, env);
  assertBlocked(result, "case insensitive SELECT");
});

// ─── Integration tests: Datadog range ────────────────────────────────────────

console.log("\nmcp-data-guard.js (Datadog range):");

test("I26. time_range: 7d -> deny", (env) => {
  const result = runGuard("mcp__datadog__get_logs", {
    filters: { service: "integrator" },
    time_range: "7d",
  }, env);
  assertBlocked(result, "7d");
  assert.ok(getDenyReason(result).includes("7d"), "Range in reason");
});

test("I27. time_range: 30d -> deny", (env) => {
  const result = runGuard("mcp__datadog__get_logs", {
    filters: { service: "foo" },
    time_range: "30d",
  }, env);
  assertBlocked(result, "30d");
});

test("I28. time_range: 1h -> allow", (env) => {
  const result = runGuard("mcp__datadog__get_logs", {
    filters: { service: "foo" },
    time_range: "1h",
    limit: 50,
  }, env);
  assertAllowed(result, "1h");
});

test("I29. time_range: 1d -> allow (edge)", (env) => {
  const result = runGuard("mcp__datadog__get_logs", {
    filters: { service: "foo" },
    time_range: "1d",
  }, env);
  assertAllowed(result, "1d edge");
});

test("I30. time_range: 8h -> allow", (env) => {
  const result = runGuard("mcp__datadog__get_logs", {
    filters: { service: "foo" },
    time_range: "8h",
  }, env);
  assertAllowed(result, "8h");
});

test("I31. no time_range (default 1h) -> allow", (env) => {
  const result = runGuard("mcp__datadog__get_logs", {
    filters: { service: "foo" },
  }, env);
  assertAllowed(result, "default time_range");
});

// ─── Integration tests: auto-fix find limit ───────────────────────────────────

console.log("\nmcp-data-guard.js (auto-fix: find limit):");

test("I32. missing limit -> updatedInput with limit:20", (env) => {
  seedDiscovery(env, ["users"]);
  const result = runGuard("mcp__mongodb__find", {
    collection: "users",
    filter: { type: "doctor" },
  }, env);
  const updated = assertUpdated(result, "missing limit");
  assert.strictEqual(updated.limit, 20, `Expected limit:20, got: ${updated.limit}`);
});

test("I33. existing limit:5 -> no update (pass through)", (env) => {
  seedDiscovery(env, ["users"]);
  const result = runGuard("mcp__mongodb__find", {
    collection: "users",
    filter: { type: "doctor" },
    limit: 5,
  }, env);
  assert.strictEqual(result.status, 0, "exit 0");
  // Should be {} (no-op), not an update
  assert.ok(!result.json?.hookSpecificOutput?.updatedInput,
    `Should not have updatedInput: ${JSON.stringify(result.json)}`);
  assertAllowed(result, "existing limit not overwritten");
});

test("I34. limit:0 treated as present -> no update", (env) => {
  seedDiscovery(env, ["users"]);
  const result = runGuard("mcp__mongodb__find", {
    collection: "users",
    filter: { type: "doctor" },
    limit: 0,
  }, env);
  assert.ok(!result.json?.hookSpecificOutput?.updatedInput,
    `Should not have updatedInput: ${JSON.stringify(result.json)}`);
});

// ─── Integration tests: auto-fix aggregate limit ──────────────────────────────

console.log("\nmcp-data-guard.js (auto-fix: aggregate limit):");

test("I35. pipeline without $limit -> updatedInput with $limit:20 appended", (env) => {
  seedDiscovery(env, ["users"]);
  const result = runGuard("mcp__mongodb__aggregate", {
    collection: "users",
    pipeline: [{ $match: { type: "doctor" } }],
  }, env);
  const updated = assertUpdated(result, "pipeline without $limit");
  const last = updated.pipeline[updated.pipeline.length - 1];
  assert.strictEqual(last.$limit, 20, `Expected $limit:20 as last stage, got: ${JSON.stringify(last)}`);
});

test("I36. pipeline with $limit:10 -> no update", (env) => {
  seedDiscovery(env, ["users"]);
  const result = runGuard("mcp__mongodb__aggregate", {
    collection: "users",
    pipeline: [{ $match: {} }, { $limit: 10 }],
  }, env);
  assert.ok(!result.json?.hookSpecificOutput?.updatedInput,
    `Should not have updatedInput: ${JSON.stringify(result.json)}`);
});

test("I37. empty pipeline -> appends $limit", (env) => {
  seedDiscovery(env, ["users"]);
  const result = runGuard("mcp__mongodb__aggregate", {
    collection: "users",
    pipeline: [],
  }, env);
  const updated = assertUpdated(result, "empty pipeline");
  assert.strictEqual(updated.pipeline.length, 1);
  assert.strictEqual(updated.pipeline[0].$limit, 20);
});

// ─── Integration tests: pass-through ─────────────────────────────────────────

console.log("\nmcp-data-guard.js (pass-through):");

test("I38. Read tool -> pass through {}", (env) => {
  const result = runHook(HOOK_PATH, {
    tool_name: "Read",
    tool_input: { file_path: "/tmp/foo.txt" },
  }, { HOME: env.home, USERPROFILE: env.home });
  assert.strictEqual(result.status, 0, "exit 0");
  assert.deepStrictEqual(result.json, {}, `Expected {}, got: ${JSON.stringify(result.json)}`);
});

test("I39. mcp__clickup__get_task -> pass through {}", (env) => {
  const result = runHook(HOOK_PATH, {
    tool_name: "mcp__clickup__get_task",
    tool_input: { task_id: "abc123" },
  }, { HOME: env.home, USERPROFILE: env.home });
  assert.strictEqual(result.status, 0, "exit 0");
  assert.deepStrictEqual(result.json, {}, `Expected {}, got: ${JSON.stringify(result.json)}`);
});

test("I40. Bash tool -> pass through {}", (env) => {
  const result = runHook(HOOK_PATH, {
    tool_name: "Bash",
    tool_input: { command: "echo hello" },
  }, { HOME: env.home, USERPROFILE: env.home });
  assert.strictEqual(result.status, 0, "exit 0");
  assert.deepStrictEqual(result.json, {}, `Expected {}, got: ${JSON.stringify(result.json)}`);
});

// ─── Integration tests: priority ─────────────────────────────────────────────

console.log("\nmcp-data-guard.js (priority):");

test("I41. phantom collection + missing limit -> deny (guard before autofix)", (env) => {
  const result = runGuard("mcp__mongodb__find", {
    collection: "providers",
    filter: { type: "doctor" },
    // no limit — but guard should fire first
  }, env);
  assertBlocked(result, "phantom + no limit -> deny");
});

test("I42. empty filter + missing limit -> deny (guard before autofix)", (env) => {
  const result = runGuard("mcp__mongodb__find", {
    collection: "users",
    filter: {},
    // no limit — but guard should fire first
  }, env);
  assertBlocked(result, "empty filter + no limit -> deny");
});

// ─── Integration tests: hl7Messages miscasing ────────────────────────────────

console.log("\nmcp-data-guard.js (hl7Messages miscasing):");

test("hl7Messages collection -> deny with lowercase correction", (env) => {
  const r = runGuard("mcp__mongodb__find", { collection: "hl7Messages", filter: { org: "123" } }, env);
  assertBlocked(r, "hl7Messages");
  assert.ok(getDenyReason(r).includes("hl7messages"), "should mention correct name");
});

test("hl7messages (correct) -> no deny from phantom guard", (env) => {
  seedDiscovery(env, ["hl7messages"]);
  // Will be auto-fixed for missing limit, but not denied
  const r = runGuard("mcp__mongodb__find", { collection: "hl7messages", filter: { org: "123" }, limit: 10 }, env);
  assertAllowed(r, "hl7messages correct");
});

// ─── Integration tests: appointment status ────────────────────────────────────

console.log("\nmcp-data-guard.js (appointment status):");

test("filter with status 'completed' -> deny", (env) => {
  const r = runGuard("mcp__mongodb__find", {
    collection: "appointments", filter: { status: "completed", org: "123" }, limit: 10
  }, env);
  assertBlocked(r, "completed status");
  assert.ok(getDenyReason(r).includes("unconfirmed"), "should list valid statuses");
});

test("filter with status 'pending' -> deny", (env) => {
  const r = runGuard("mcp__mongodb__find", {
    collection: "appointments", filter: { status: "pending", org: "123" }, limit: 10
  }, env);
  assertBlocked(r, "pending status");
});

test("filter with status 'confirmed' -> allow", (env) => {
  seedDiscovery(env, ["appointments"]);
  const r = runGuard("mcp__mongodb__find", {
    collection: "appointments", filter: { status: "confirmed", org: "123" }, limit: 10
  }, env);
  assertAllowed(r, "confirmed status");
});

test("filter with status 'cancelled' -> allow", (env) => {
  seedDiscovery(env, ["appointments"]);
  const r = runGuard("mcp__mongodb__find", {
    collection: "appointments", filter: { status: "cancelled", org: "123" }, limit: 10
  }, env);
  assertAllowed(r, "cancelled status");
});

test("filter with status 'unconfirmed' -> allow", (env) => {
  seedDiscovery(env, ["appointments"]);
  const r = runGuard("mcp__mongodb__find", {
    collection: "appointments", filter: { status: "unconfirmed", org: "123" }, limit: 10
  }, env);
  assertAllowed(r, "unconfirmed status");
});

test("aggregate with 'no-show' status in $match -> deny", (env) => {
  const r = runGuard("mcp__mongodb__aggregate", {
    collection: "appointments",
    pipeline: [{ $match: { status: "no-show", org: "123" } }, { $limit: 10 }]
  }, env);
  assertBlocked(r, "no-show in aggregate");
});

test("non-appointments collection with 'completed' status -> allow", (env) => {
  seedDiscovery(env, ["messages"]);
  const r = runGuard("mcp__mongodb__find", {
    collection: "messages", filter: { status: "completed" }, limit: 10
  }, env);
  assertAllowed(r, "completed on non-appointments");
});

test("filter with status 'scheduled' -> deny", (env) => {
  const r = runGuard("mcp__mongodb__find", {
    collection: "appointments", filter: { status: "scheduled", org: "123" }, limit: 10
  }, env);
  assertBlocked(r, "scheduled status");
});

// ─── Unit tests: new guards ───────────────────────────────────────────────────

console.log("\nmcp-data-guard.js (unit: new guards):");

unitTest("U46. checkPhantomCollection detects hl7Messages", () => {
  const r = checkPhantomCollection("mcp__mongodb__find", { collection: "hl7Messages" });
  assert.ok(r !== null);
  assert.ok(r.reason.includes("hl7messages"));
});

unitTest("U47. checkAppointmentStatus detects 'completed'", () => {
  const r = checkAppointmentStatus("mcp__mongodb__find", { collection: "appointments", filter: { status: "completed" } });
  assert.ok(r !== null);
});

unitTest("U48. checkAppointmentStatus allows 'confirmed'", () => {
  const r = checkAppointmentStatus("mcp__mongodb__find", { collection: "appointments", filter: { status: "confirmed" } });
  assert.strictEqual(r, null);
});

unitTest("U49. checkAppointmentStatus skips non-appointments", () => {
  const r = checkAppointmentStatus("mcp__mongodb__find", { collection: "users", filter: { status: "completed" } });
  assert.strictEqual(r, null);
});

// ─── Integration tests: error handling ───────────────────────────────────────

console.log("\nmcp-data-guard.js (error handling):");

test("I43. malformed JSON -> exit 0 with {}", (env) => {
  const result = runHookRaw(HOOK_PATH, "not valid json", {
    HOME: env.home,
    USERPROFILE: env.home,
  });
  assert.strictEqual(result.status, 0, "Exit status must be 0");
  assert.ok(result.json, "Must output valid JSON");
  assert.deepStrictEqual(result.json, {}, `Expected {}, got: ${JSON.stringify(result.json)}`);
});

test("I44. missing tool_input -> no crash", (env) => {
  const result = runHook(HOOK_PATH, {
    tool_name: "mcp__mongodb__find",
    // tool_input intentionally omitted
  }, { HOME: env.home, USERPROFILE: env.home });
  assert.strictEqual(result.status, 0, "Exit status must be 0");
  assert.ok(result.json, "Must output valid JSON");
  // With no tool_input, filter is undefined -> empty filter guard fires
  assertBlocked(result, "missing tool_input triggers empty filter guard");
});

test("I45. empty input -> exit 0 with {}", (env) => {
  const result = runHookRaw(HOOK_PATH, "", {
    HOME: env.home,
    USERPROFILE: env.home,
  });
  assert.strictEqual(result.status, 0, "Exit status must be 0");
  assert.deepStrictEqual(result.json, {}, `Expected {}, got: ${JSON.stringify(result.json)}`);
});

// ─── Integration tests: collection discovery enforcement ──────────────────────

console.log("\nmcp-data-guard.js (collection discovery enforcement):");

test("I46. well-known collection blocked without prior discovery", (env) => {
  // appointments is a COLLECTIONS member; without discover_collection it should be denied
  const result = runGuard("mcp__mongodb__find", {
    collection: "appointments",
    filter: { org: "abc123" },
    limit: 10,
  }, env);
  assertBlocked(result, "appointments without discovery");
  const reason = getDenyReason(result);
  assert.ok(reason.includes("discover_collection"), `Reason should mention discover_collection: ${reason}`);
});

test("I47. aggregate on undiscovered well-known collection blocked", (env) => {
  const result = runGuard("mcp__mongodb__aggregate", {
    collection: "users",
    pipeline: [{ $match: { type: "doctor" } }, { $limit: 10 }],
  }, env);
  assertBlocked(result, "aggregate on users without discovery");
  const reason = getDenyReason(result);
  assert.ok(reason.includes("discover_collection"), `Reason should mention discover_collection: ${reason}`);
});

test("I48. discover_collection then find on well-known collection -> allow", (env) => {
  seedDiscovery(env, ["appointments"]);
  const result = runGuard("mcp__mongodb__find", {
    collection: "appointments",
    filter: { org: "abc123" },
    limit: 10,
  }, env);
  assertAllowed(result, "appointments after discovery");
});

test("I49. discover_collection then aggregate on well-known collection -> allow or update", (env) => {
  seedDiscovery(env, ["users"]);
  const result = runGuard("mcp__mongodb__aggregate", {
    collection: "users",
    pipeline: [{ $match: { type: "doctor" } }],
  }, env);
  // Should not be denied; may be updated with $limit
  assert.strictEqual(result.status, 0, "exit 0");
  assert.ok(result.json?.hookSpecificOutput?.permissionDecision !== "deny",
    `Should not be denied after discovery: ${JSON.stringify(result.json)}`);
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
