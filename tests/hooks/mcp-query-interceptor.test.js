#!/usr/bin/env node
// Unit + integration tests for templates/hooks/mcp-query-interceptor.js
// Zero dependencies — uses only Node built-ins + test-helpers.
//
// Run: node tests/hooks/mcp-query-interceptor.test.js

"use strict";

const assert = require("assert");
const path = require("path");

const { runHook, runHookRaw, createTempHome } = require("./test-helpers");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const HOOK_PATH = path.join(REPO_ROOT, "templates", "hooks", "mcp-query-interceptor.js");

// Load formatters directly from the module for unit tests
const {
  formatMongoFind,
  formatMongoAggregate,
  formatMongoDiscover,
  formatDatadogLogs,
  formatSnowflakeSQL,
  formatQuery,
  isInterceptedTool,
} = require(HOOK_PATH);

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function runInterceptor(toolName, toolInput, extraEnv = {}, env) {
  const baseHome = env ? { HOME: env.home, USERPROFILE: env.home } : {};
  return runHook(HOOK_PATH, {
    tool_name: toolName,
    tool_input: toolInput,
  }, { ...baseHome, ...extraEnv });
}

function assertBlocked(result, label) {
  assert.strictEqual(result.status, 0, `${label}: exit status should be 0`);
  assert.ok(
    result.json &&
    result.json.hookSpecificOutput &&
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

function getDenyReason(result) {
  return result.json &&
    result.json.hookSpecificOutput &&
    result.json.hookSpecificOutput.permissionDecisionReason || "";
}

// ─── Unit tests: formatMongoFind ─────────────────────────────────────────────

console.log("\nmcp-query-interceptor.js (formatMongoFind):");

unitTest("U1. find with all params", () => {
  const out = formatMongoFind({
    collection: "appointments",
    filter: { "org": "abc123" },
    projection: { "_id": 1, "status": 1 },
    sort: { "createdAt": -1 },
    limit: 20,
  });
  assert.ok(out.includes("db.appointments.find("), `Got: ${out}`);
  assert.ok(out.includes('"org"'), `Filter missing: ${out}`);
  assert.ok(out.includes('"_id"'), `Projection missing: ${out}`);
  assert.ok(out.includes(".sort("), `Sort missing: ${out}`);
  assert.ok(out.includes(".limit(20)"), `Limit missing: ${out}`);
});

unitTest("U2. find with minimal params (collection + filter only)", () => {
  const out = formatMongoFind({
    collection: "users",
    filter: { "__t": "Provider" },
  });
  assert.ok(out.startsWith("db.users.find("), `Got: ${out}`);
  assert.ok(!out.includes(".sort("), `Unexpected .sort(): ${out}`);
  assert.ok(!out.includes(".limit("), `Unexpected .limit(): ${out}`);
  // No second argument when no projection
  const match = out.match(/db\.users\.find\(([^)]+)\)/s);
  assert.ok(match, "Should match find() call");
  // Only one JSON object argument (no comma for projection)
  assert.ok(!out.match(/find\([^,)]+,/s), `Should not have projection arg: ${out}`);
});

unitTest("U3. find omits sort when not provided", () => {
  const out = formatMongoFind({ collection: "col", filter: {}, limit: 10 });
  assert.ok(!out.includes(".sort("), `Should not have sort: ${out}`);
  assert.ok(out.includes(".limit(10)"), `Should have limit: ${out}`);
});

unitTest("U4. find with null input doesn't crash", () => {
  const out = formatMongoFind(null);
  assert.ok(out.includes("db.unknown.find("), `Got: ${out}`);
});

// ─── Unit tests: formatMongoAggregate ────────────────────────────────────────

console.log("\nmcp-query-interceptor.js (formatMongoAggregate):");

unitTest("U5. aggregate with pipeline", () => {
  const out = formatMongoAggregate({
    collection: "appointments",
    pipeline: [
      { "$match": { "org": "abc" } },
      { "$limit": 5 },
    ],
  });
  assert.ok(out.startsWith("db.appointments.aggregate("), `Got: ${out}`);
  assert.ok(out.includes('"$match"'), `Pipeline missing: ${out}`);
  assert.ok(out.includes('"$limit"'), `Pipeline missing: ${out}`);
});

unitTest("U6. aggregate with null input doesn't crash", () => {
  const out = formatMongoAggregate(null);
  assert.ok(out.includes("db.unknown.aggregate("), `Got: ${out}`);
});

// ─── Unit tests: formatMongoDiscover ─────────────────────────────────────────

console.log("\nmcp-query-interceptor.js (formatMongoDiscover):");

unitTest("U7. discover_collection formats two commands", () => {
  const out = formatMongoDiscover({ collection: "patients" });
  assert.ok(out.includes("db.patients.findOne()"), `Got: ${out}`);
  assert.ok(out.includes("db.patients.getIndexes()"), `Got: ${out}`);
  const lines = out.split("\n");
  assert.strictEqual(lines.length, 2, `Expected 2 lines, got: ${lines.length}`);
});

unitTest("U8. discover_collection with null input doesn't crash", () => {
  const out = formatMongoDiscover(null);
  assert.ok(out.includes("db.unknown.findOne()"), `Got: ${out}`);
  assert.ok(out.includes("db.unknown.getIndexes()"), `Got: ${out}`);
});

// ─── Unit tests: formatDatadogLogs ───────────────────────────────────────────

console.log("\nmcp-query-interceptor.js (formatDatadogLogs):");

unitTest("U9. datadog with all params", () => {
  const out = formatDatadogLogs({
    query: "service:integrator-service @rootId:abc123",
    from: "now-1h",
    to: "now",
    limit: 50,
  });
  assert.ok(out.startsWith("Datadog Log Query:"), `Got: ${out}`);
  assert.ok(out.includes("query: service:integrator-service"), `Missing query: ${out}`);
  assert.ok(out.includes("from:  now-1h"), `Missing from: ${out}`);
  assert.ok(out.includes("to:    now"), `Missing to: ${out}`);
  assert.ok(out.includes("limit: 50"), `Missing limit: ${out}`);
});

unitTest("U10. datadog with partial params omits missing fields", () => {
  const out = formatDatadogLogs({ query: "service:foo", from: "now-2h" });
  assert.ok(out.includes("query: service:foo"), `Got: ${out}`);
  assert.ok(out.includes("from:  now-2h"), `Got: ${out}`);
  assert.ok(!out.includes("to:"), `Should not include 'to:': ${out}`);
  assert.ok(!out.includes("limit:"), `Should not include 'limit:': ${out}`);
});

unitTest("U11. datadog with null input doesn't crash", () => {
  const out = formatDatadogLogs(null);
  assert.ok(out.startsWith("Datadog Log Query:"), `Got: ${out}`);
});

// ─── Unit tests: formatSnowflakeSQL ──────────────────────────────────────────

console.log("\nmcp-query-interceptor.js (formatSnowflakeSQL):");

unitTest("U12. snowflake returns SQL as-is", () => {
  const sql = "SELECT * FROM appointments LIMIT 10";
  const out = formatSnowflakeSQL({ sql });
  assert.strictEqual(out, sql, `Got: ${out}`);
});

unitTest("U13. snowflake with null input returns empty string", () => {
  const out = formatSnowflakeSQL(null);
  assert.strictEqual(out, "", `Got: ${out}`);
});

// ─── Unit tests: formatQuery dispatch ────────────────────────────────────────

console.log("\nmcp-query-interceptor.js (formatQuery dispatch):");

unitTest("U14. formatQuery routes mcp__mongodb__find", () => {
  const out = formatQuery("mcp__mongodb__find", { collection: "c", filter: {} });
  assert.ok(out && out.includes("db.c.find("), `Got: ${out}`);
});

unitTest("U15. formatQuery routes mcp__mongodb__aggregate", () => {
  const out = formatQuery("mcp__mongodb__aggregate", { collection: "c", pipeline: [] });
  assert.ok(out && out.includes("db.c.aggregate("), `Got: ${out}`);
});

unitTest("U16. formatQuery routes mcp__mongodb__discover_collection", () => {
  const out = formatQuery("mcp__mongodb__discover_collection", { collection: "c" });
  assert.ok(out && out.includes("findOne()"), `Got: ${out}`);
});

unitTest("U17. formatQuery routes mcp__datadog__get_logs", () => {
  const out = formatQuery("mcp__datadog__get_logs", { query: "foo" });
  assert.ok(out && out.startsWith("Datadog"), `Got: ${out}`);
});

unitTest("U18. formatQuery routes mcp__snowflake__run_sql", () => {
  const out = formatQuery("mcp__snowflake__run_sql", { sql: "SELECT 1" });
  assert.strictEqual(out, "SELECT 1");
});

unitTest("U19. formatQuery returns null for unknown tool", () => {
  const out = formatQuery("mcp__mongodb__list_databases", {});
  assert.strictEqual(out, null, `Expected null, got: ${out}`);
});

// ─── Unit tests: isInterceptedTool ───────────────────────────────────────────

console.log("\nmcp-query-interceptor.js (isInterceptedTool):");

unitTest("U20. recognises mcp__mongodb__ prefix", () => {
  assert.ok(isInterceptedTool("mcp__mongodb__find"));
  assert.ok(isInterceptedTool("mcp__mongodb__aggregate"));
  assert.ok(isInterceptedTool("mcp__mongodb__anything_new"));
});

unitTest("U21. recognises mcp__datadog__ prefix", () => {
  assert.ok(isInterceptedTool("mcp__datadog__get_logs"));
});

unitTest("U22. recognises mcp__snowflake__ prefix", () => {
  assert.ok(isInterceptedTool("mcp__snowflake__run_sql"));
});

unitTest("U23. does not intercept other tools", () => {
  assert.ok(!isInterceptedTool("Read"));
  assert.ok(!isInterceptedTool("Bash"));
  assert.ok(!isInterceptedTool("mcp__clickup__get_task"));
  assert.ok(!isInterceptedTool("mcp__slack__send_message"));
  assert.ok(!isInterceptedTool(""));
});

// ─── Integration tests: MCP_QUERY_INTERCEPT not set → passes through ─────────

console.log("\nmcp-query-interceptor.js (MCP_QUERY_INTERCEPT not set):");

test("I1. mongodb find without flag → passes through", (env) => {
  const result = runInterceptor(
    "mcp__mongodb__find",
    { collection: "users", filter: {} },
    { HOME: env.home, USERPROFILE: env.home },
  );
  assertAllowed(result, "mongodb find without flag");
});

test("I2. datadog get_logs without flag → passes through", (env) => {
  const result = runInterceptor(
    "mcp__datadog__get_logs",
    { query: "foo", from: "now-1h", to: "now", limit: 10 },
    { HOME: env.home, USERPROFILE: env.home },
  );
  assertAllowed(result, "datadog without flag");
});

// ─── Integration tests: MCP_QUERY_INTERCEPT=1 with non-MCP tool → passes ─────

console.log("\nmcp-query-interceptor.js (non-MCP tool pass-through with flag):");

test("I3. Read tool with flag set → passes through", (env) => {
  const result = runInterceptor(
    "Read",
    { file_path: "/tmp/foo.txt" },
    { HOME: env.home, USERPROFILE: env.home, MCP_QUERY_INTERCEPT: "1" },
  );
  assertAllowed(result, "Read tool with flag");
});

test("I4. mcp__clickup__get_task with flag set → passes through", (env) => {
  const result = runInterceptor(
    "mcp__clickup__get_task",
    { task_id: "abc123" },
    { HOME: env.home, USERPROFILE: env.home, MCP_QUERY_INTERCEPT: "1" },
  );
  assertAllowed(result, "clickup tool with flag");
});

// ─── Integration tests: MCP_QUERY_INTERCEPT=1 with MCP tools → blocks ────────

console.log("\nmcp-query-interceptor.js (MCP_QUERY_INTERCEPT=1 blocks):");

test("I5. mongodb find with all params → blocks with mongosh command", (env) => {
  const result = runInterceptor(
    "mcp__mongodb__find",
    {
      collection: "appointments",
      filter: { "org": "abc123" },
      projection: { "_id": 1 },
      sort: { "createdAt": -1 },
      limit: 20,
    },
    { HOME: env.home, USERPROFILE: env.home, MCP_QUERY_INTERCEPT: "1" },
  );
  assertBlocked(result, "mongodb find full");
  const reason = getDenyReason(result);
  assert.ok(reason.includes("MCP query intercepted"), `Missing header: ${reason}`);
  assert.ok(reason.includes("db.appointments.find("), `Missing mongosh command: ${reason}`);
  assert.ok(reason.includes(".sort("), `Missing sort: ${reason}`);
  assert.ok(reason.includes(".limit(20)"), `Missing limit: ${reason}`);
});

test("I6. mongodb find with minimal params → blocks with valid command", (env) => {
  const result = runInterceptor(
    "mcp__mongodb__find",
    { collection: "users", filter: { "__t": "Provider" } },
    { HOME: env.home, USERPROFILE: env.home, MCP_QUERY_INTERCEPT: "1" },
  );
  assertBlocked(result, "mongodb find minimal");
  const reason = getDenyReason(result);
  assert.ok(reason.includes("db.users.find("), `Got: ${reason}`);
  assert.ok(!reason.includes(".sort("), `Unexpected sort: ${reason}`);
});

test("I7. mongodb aggregate → blocks with mongosh command", (env) => {
  const result = runInterceptor(
    "mcp__mongodb__aggregate",
    {
      collection: "appointments",
      pipeline: [{ "$match": { "org": "abc" } }, { "$limit": 5 }],
    },
    { HOME: env.home, USERPROFILE: env.home, MCP_QUERY_INTERCEPT: "1" },
  );
  assertBlocked(result, "mongodb aggregate");
  const reason = getDenyReason(result);
  assert.ok(reason.includes("db.appointments.aggregate("), `Got: ${reason}`);
  assert.ok(reason.includes('"$match"'), `Missing pipeline stage: ${reason}`);
});

test("I8. mongodb discover_collection → blocks with findOne + getIndexes", (env) => {
  const result = runInterceptor(
    "mcp__mongodb__discover_collection",
    { collection: "patients" },
    { HOME: env.home, USERPROFILE: env.home, MCP_QUERY_INTERCEPT: "1" },
  );
  assertBlocked(result, "mongodb discover");
  const reason = getDenyReason(result);
  assert.ok(reason.includes("db.patients.findOne()"), `Got: ${reason}`);
  assert.ok(reason.includes("db.patients.getIndexes()"), `Got: ${reason}`);
});

test("I9. datadog get_logs → blocks with formatted query block", (env) => {
  const result = runInterceptor(
    "mcp__datadog__get_logs",
    { query: "service:integrator-service @rootId:abc123", from: "now-1h", to: "now", limit: 50 },
    { HOME: env.home, USERPROFILE: env.home, MCP_QUERY_INTERCEPT: "1" },
  );
  assertBlocked(result, "datadog get_logs");
  const reason = getDenyReason(result);
  assert.ok(reason.includes("Datadog Log Query:"), `Got: ${reason}`);
  assert.ok(reason.includes("query: service:integrator-service"), `Got: ${reason}`);
  assert.ok(reason.includes("from:  now-1h"), `Got: ${reason}`);
  assert.ok(reason.includes("limit: 50"), `Got: ${reason}`);
});

test("I10. snowflake run_sql → blocks with SQL string", (env) => {
  const sql = "SELECT status, COUNT(*) FROM appointments WHERE org = 'abc' GROUP BY status LIMIT 10";
  const result = runInterceptor(
    "mcp__snowflake__run_sql",
    { sql },
    { HOME: env.home, USERPROFILE: env.home, MCP_QUERY_INTERCEPT: "1" },
  );
  assertBlocked(result, "snowflake run_sql");
  const reason = getDenyReason(result);
  assert.ok(reason.includes(sql), `SQL not in reason: ${reason}`);
});

// ─── Integration tests: error resilience ─────────────────────────────────────

console.log("\nmcp-query-interceptor.js (error resilience):");

test("I11. malformed JSON input → exits 0 with {} (never crash)", (env) => {
  const result = runHookRaw(HOOK_PATH, "not valid json", {
    HOME: env.home,
    USERPROFILE: env.home,
    MCP_QUERY_INTERCEPT: "1",
  });
  assert.strictEqual(result.status, 0, "Exit status must be 0");
  assert.ok(result.json, "Must output valid JSON");
  assert.ok(!result.json.hookSpecificOutput, "Must not block on error");
});

test("I12. missing tool_input → does not crash, returns block with fallback", (env) => {
  const result = runHook(HOOK_PATH, {
    tool_name: "mcp__mongodb__find",
    // tool_input intentionally omitted
  }, { HOME: env.home, USERPROFILE: env.home, MCP_QUERY_INTERCEPT: "1" });
  assert.strictEqual(result.status, 0, "Exit status must be 0");
  assert.ok(result.json, "Must output valid JSON");
  // Should still block (tool_input defaults to {})
  assertBlocked(result, "missing tool_input");
});

test("I13. unknown mcp__mongodb__ variant → blocks with raw JSON fallback", (env) => {
  const result = runInterceptor(
    "mcp__mongodb__list_databases",
    { someParam: "value" },
    { HOME: env.home, USERPROFILE: env.home, MCP_QUERY_INTERCEPT: "1" },
  );
  assertBlocked(result, "unknown mongodb variant");
  const reason = getDenyReason(result);
  // Falls back to raw JSON of tool_input
  assert.ok(reason.includes("someParam"), `Raw JSON fallback missing: ${reason}`);
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
