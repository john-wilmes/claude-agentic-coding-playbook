"use strict";

// PreToolUse hook: validates and auto-fixes MCP data tool calls (MongoDB, Datadog, Snowflake).
// Guards: phantom collections, bare ObjectIds, empty filters, missing LIMIT, wide Datadog ranges.
// Enforces: discover_collection before first query on unknown collections.
// Auto-fixes: missing find limit, missing aggregate $limit stage.

const fs = require("fs");
const path = require("path");
const os = require("os");

let log;
try { log = require("./log"); } catch { log = { writeLog() {} }; }

function respond(payload = {}) {
  process.stdout.write(JSON.stringify(payload), () => process.exit(0));
}

// ─── Reference data ──────────────────────────────────────────────────────────

// Path to your data model schemas. Set MCP_SCHEMA_BASE env var or replace this default.
const SCHEMA_BASE = process.env.MCP_SCHEMA_BASE || "YOUR_REPO/src/models";

// Fill in your own collections. Each entry tells the hook how to guide the agent
// when it queries without first calling discover_collection, and how to suggest
// an org/tenant filter. Structure:
//   collectionName: {
//     schema: "filename.ts",          // path relative to SCHEMA_BASE
//     orgField: "tenantId",           // field name for org/tenant filter
//     orgType: "objectId"|"string",   // whether the field is an ObjectId or plain string
//     notes: "anything the agent should know about this collection"
//   }
//
// Example:
//   users:   { schema: "user.ts",   orgField: "tenantId", orgType: "objectId" },
//   orders:  { schema: "order.ts",  orgField: "orgId",    orgType: "string",
//              notes: "status field: pending|fulfilled|cancelled" },
const COLLECTIONS = {
  // Example entries — replace with your own collections:
  users:   { schema: "user.ts",   orgField: "tenantId", orgType: "objectId" },
  orders:  { schema: "order.ts",  orgField: "orgId",    orgType: "string",
             notes: "status field: pending|fulfilled|cancelled" },
};

// Fill in collections that don't exist but agents commonly guess.
// For example, if your app uses discriminators on a base collection, list the
// non-existent subtypes here so the agent gets a helpful redirect instead of
// a confusing empty result.
// Structure:
//   phantomName: { real: "actualCollection", filter: '{ type: "..." }', schema: "subtype.ts" }
//   phantomName: { real: "actualCollection", note: "explanation of the correct name" }
//
// Example:
//   admins: { real: "users", filter: '{ type: "admin" }', schema: "admin.ts" },
const PHANTOM_COLLECTIONS = {
  // Example entries — replace with your own phantom collections:
  admins: { real: "users", filter: '{ type: "admin" }', schema: "admin.ts" },
};

// Fields in your schema that store plain strings (not ObjectIds).
// Bare 24-char hex values in these fields will NOT trigger the $oid warning.
// Add any field names your schema uses for external IDs, slugs, or string-typed refs.
const STRING_ID_FIELDS = ["org", "source"];

// ─── Collection discovery state ─────────────────────────────────────────────

function getDiscoveryStatePath(cwd) {
  const slug = (cwd || process.cwd()).replace(/\//g, "-");
  const projectDir = path.join(os.homedir(), ".claude", "projects", slug);
  return path.join(projectDir, "discovered-collections.json");
}

function loadDiscovered(cwd) {
  try {
    const data = fs.readFileSync(getDiscoveryStatePath(cwd), "utf8");
    return new Set(JSON.parse(data));
  } catch {
    return new Set();
  }
}

function saveDiscovered(cwd, collection) {
  const statePath = getDiscoveryStatePath(cwd);
  const discovered = loadDiscovered(cwd);
  discovered.add(collection);
  try {
    fs.writeFileSync(statePath, JSON.stringify([...discovered]), "utf8");
  } catch { /* project dir may not exist for non-project contexts */ }
}

// ─── Guard functions ─────────────────────────────────────────────────────────

/**
 * Block queries against phantom collections (providers, patients) that don't exist.
 * @returns {{ action: "deny", reason: string } | null}
 */
function checkPhantomCollection(toolName, toolInput) {
  if (toolName !== "mcp__mongodb__find" && toolName !== "mcp__mongodb__aggregate") return null;
  const collection = toolInput.collection;
  if (!collection || !PHANTOM_COLLECTIONS[collection]) return null;

  const { real, filter, schema, note } = PHANTOM_COLLECTIONS[collection];
  let reason;
  if (filter) {
    reason =
      `Collection "${collection}" does not exist. ` +
      `Use the "${real}" collection with filter ${filter}. ` +
      `Schema: ${SCHEMA_BASE}/${schema}`;
  } else {
    reason =
      `Collection \`${collection}\` does not exist. ` +
      `The correct name is \`${real}\` (all lowercase).` +
      (note ? ` ${note}` : "");
  }
  return { action: "deny", reason };
}

/**
 * Block queries with bare 24-char hex ObjectIds not wrapped in $oid.
 * Skips fields known to store plain strings (STRING_ID_FIELDS).
 * @returns {{ action: "deny", reason: string } | null}
 */
function checkBareObjectId(toolName, toolInput) {
  let json;
  if (toolName === "mcp__mongodb__find") {
    if (!toolInput.filter) return null;
    try { json = JSON.stringify(toolInput.filter); } catch { return null; }
  } else if (toolName === "mcp__mongodb__aggregate") {
    if (!toolInput.pipeline) return null;
    try { json = JSON.stringify(toolInput.pipeline); } catch { return null; }
  } else {
    return null;
  }

  const hexRe = /(?<![0-9a-f])[0-9a-f]{24}(?![0-9a-f])/gi;
  let match;
  while ((match = hexRe.exec(json)) !== null) {
    const hex = match[0];
    const start = match.index;
    const preceding = json.slice(Math.max(0, start - 20), start);

    // Allow if wrapped in $oid
    if (preceding.includes('"$oid"')) continue;

    // Allow if the immediate field key is in STRING_ID_FIELDS
    const fieldKeyMatch = preceding.match(/"(\w+)"\s*:\s*(?:"[^"]*"\s*:\s*)*$/);
    const fieldKey = fieldKeyMatch ? fieldKeyMatch[1] : null;
    if (fieldKey && STRING_ID_FIELDS.includes(fieldKey)) continue;

    // Also check wider context (e.g. hex in $in array) for the nearest enclosing field key
    const longerPreceding = json.slice(Math.max(0, start - 80), start);
    const longerKeyMatches = [...longerPreceding.matchAll(/"(\w+)"\s*:/g)];
    const longerKey = longerKeyMatches.length > 0 ? longerKeyMatches[longerKeyMatches.length - 1][1] : null;
    if (longerKey && STRING_ID_FIELDS.includes(longerKey)) continue;

    const reason =
      `Bare ObjectId "${hex}" found without $oid wrapper. ` +
      `MongoDB stores IDs as binary — plain hex strings silently return 0 results. ` +
      `Use: { "fieldName": { "$oid": "${hex}" } }. ` +
      `Exception: fields like org, externalId store plain strings and do not need $oid.`;
    return { action: "deny", reason };
  }
  return null;
}

/**
 * Block find queries with empty or missing filters (would scan entire collection).
 * @returns {{ action: "deny", reason: string } | null}
 */
function checkEmptyFilter(toolName, toolInput) {
  if (toolName !== "mcp__mongodb__find") return null;
  const filter = toolInput.filter;
  if (filter !== undefined && filter !== null) {
    try {
      if (JSON.stringify(filter) !== "{}") return null;
    } catch {
      return null;
    }
  }

  const collection = toolInput.collection;
  let schemaHint = "";
  if (collection && COLLECTIONS[collection]) {
    const { schema, notes } = COLLECTIONS[collection];
    schemaHint = ` Schema: ${SCHEMA_BASE}/${schema}.` + (notes ? ` Note: ${notes}` : "");
  }

  const reason =
    `Empty filter would scan entire collection "${collection || "unknown"}". Add a filter.` +
    schemaHint;
  return { action: "deny", reason };
}

/**
 * Block Snowflake SELECT queries without a LIMIT or TOP clause.
 * @returns {{ action: "deny", reason: string } | null}
 */
function checkSnowflakeLimit(toolName, toolInput) {
  if (toolName !== "mcp__snowflake__run_sql") return null;
  const sql = toolInput.sql || "";
  if (!/^\s*(select|with)\b/i.test(sql)) return null;
  if (/\blimit\b/i.test(sql)) return null;
  if (/\btop\b/i.test(sql)) return null;

  return {
    action: "deny",
    reason: "SELECT without LIMIT can return unbounded rows. Add a LIMIT clause.",
  };
}

/**
 * Block Datadog log queries with a range wider than 1 day.
 * The server accepts time_range as an enum: 1h | 4h | 8h | 1d | 7d | 14d | 30d.
 * @returns {{ action: "deny", reason: string } | null}
 */
function checkDatadogRange(toolName, toolInput) {
  if (toolName !== "mcp__datadog__get_logs") return null;
  const range = toolInput.time_range || "1h";

  const WIDE_RANGES = ["7d", "14d", "30d"];
  if (WIDE_RANGES.includes(range)) {
    return {
      action: "deny",
      reason: `Query range "${range}" is too wide. Use 1h, 4h, 8h, or 1d to reduce cost and timeout risk.`,
    };
  }
  return null;
}

/**
 * Placeholder for schema-specific field value validation.
 * Add your own checks here — for example, blocking queries that use status
 * values that don't exist in your schema.
 *
 * Example (uncomment and adapt):
 *   if (toolInput.collection !== "orders") return null;
 *   const INVALID_STATUSES = ["complete", "in_progress"];
 *   // ... deny with a helpful message listing valid values
 *
 * @returns {{ action: "deny", reason: string } | null}
 */
function checkAppointmentStatus(_toolName, _toolInput) {
  // No-op by default. Add your own schema-specific guards here.
  return null;
}

/**
 * Block find/aggregate on collections not yet discovered via discover_collection.
 * ALL collections require discovery — even well-known ones — to ensure index learning.
 * discover_collection calls record the collection; subsequent queries are allowed.
 * @returns {{ action: "deny", reason: string } | null}
 */
function checkCollectionDiscovered(toolName, toolInput, cwd) {
  if (toolName === "mcp__mongodb__discover_collection") {
    // Record the discovery — allow the call through
    if (toolInput.collection) saveDiscovered(cwd, toolInput.collection);
    return null;
  }
  if (toolName !== "mcp__mongodb__find" && toolName !== "mcp__mongodb__aggregate") return null;
  const collection = toolInput.collection;
  if (!collection) return null;
  // Check if previously discovered this session
  if (loadDiscovered(cwd).has(collection)) return null;
  // Well-known collections get a friendlier message with notes
  const known = COLLECTIONS[collection];
  if (known) {
    const notes = known.notes ? ` Note: ${known.notes}` : "";
    let orgHint = "";
    if (known.orgField) {
      const example = known.orgType === "objectId"
        ? `{ "${known.orgField}": { "$oid": "orgIdHere" } }`
        : `{ "${known.orgField}": "orgIdHere" }`;
      orgHint = ` Org filter: ${example}.`;
    }
    return {
      action: "deny",
      reason: `Call discover_collection("${collection}") first to learn its indexes, then retry with an appropriate hint.${orgHint}${notes}`,
    };
  }
  return {
    action: "deny",
    reason: `Collection "${collection}" is not in the known-collections map. Call discover_collection("${collection}") first to learn its indexes and field names, then retry your query with an appropriate hint.`,
  };
}

/**
 * Rewrite Datadog phantom filter keys (@rootId/@orgId → @user) with a warning.
 * These keys silently return 0 results in Datadog.
 * @returns {{ action: "update", updatedInput: object, warning: string } | null}
 */
function checkDatadogPhantomFilters(toolName, toolInput) {
  if (toolName !== "mcp__datadog__get_logs") return null;
  const filters = toolInput.filters;
  if (!filters || typeof filters !== "object") return null;

  // Fill in your own phantom Datadog attribute keys here.
  // These are attribute names that silently return 0 results because they don't
  // exist in your Datadog index. Map them to the real attribute name.
  // Example: { "@rootId": "@tenantId", "@orgId": "@tenantId" }
  const PHANTOM_KEYS = {
    // Example entries — replace with your own phantom Datadog keys:
    "@rootId": "@tenantId",
    "@orgId":  "@tenantId",
  };
  const rewrites = [];

  for (const k of Object.keys(filters)) {
    if (PHANTOM_KEYS[k]) rewrites.push(k);
  }
  if (rewrites.length === 0) return null;

  const corrected = {};
  for (const [k, v] of Object.entries(filters)) {
    corrected[PHANTOM_KEYS[k] || k] = v;
  }

  const warning = rewrites
    .map((k) => `"${k}" is a phantom Datadog key that silently returns 0 results — rewritten to "${PHANTOM_KEYS[k]}"`)
    .join("; ");

  return {
    action: "update",
    updatedInput: { ...toolInput, filters: corrected },
    warning,
  };
}

// ─── Auto-fix functions ──────────────────────────────────────────────────────

/**
 * Auto-add limit:20 to find queries missing a limit.
 * @returns {object | null} modified toolInput or null
 */
function autoFixFindLimit(toolName, toolInput) {
  if (toolName !== "mcp__mongodb__find") return null;
  if (toolInput.limit !== undefined && toolInput.limit !== null) return null;
  return { ...toolInput, limit: 20 };
}

/**
 * Auto-append { $limit: 20 } to aggregate pipelines without a $limit stage.
 * @returns {object | null} modified toolInput or null
 */
function autoFixAggregateLimit(toolName, toolInput) {
  if (toolName !== "mcp__mongodb__aggregate") return null;
  if (!Array.isArray(toolInput.pipeline)) return null;
  const hasLimit = toolInput.pipeline.some(
    (stage) => stage && typeof stage === "object" && "$limit" in stage
  );
  if (hasLimit) return null;
  return { ...toolInput, pipeline: [...toolInput.pipeline, { $limit: 20 }] };
}

// ─── Main dispatch ───────────────────────────────────────────────────────────

function checkMcpDataCall(toolName, toolInput, cwd) {
  // Guards first (deny takes priority over auto-fix)
  const guards = [checkPhantomCollection, (tn, ti) => checkCollectionDiscovered(tn, ti, cwd), checkBareObjectId, checkEmptyFilter, checkSnowflakeLimit, checkDatadogRange, checkDatadogPhantomFilters, checkAppointmentStatus];
  for (const guard of guards) {
    const result = guard(toolName, toolInput);
    if (result) return result;
  }
  // Auto-fixes
  const fixes = [autoFixFindLimit, autoFixAggregateLimit];
  for (const fix of fixes) {
    const result = fix(toolName, toolInput);
    if (result) return { action: "update", updatedInput: result };
  }
  return null;
}

// ─── stdin handler ───────────────────────────────────────────────────────────

let input = "";
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    const hookInput = JSON.parse(input);
    const toolName = hookInput.tool_name || "";

    // Fast-exit for non-data MCP tools
    if (!toolName.startsWith("mcp__mongodb__") &&
        !toolName.startsWith("mcp__datadog__") &&
        !toolName.startsWith("mcp__snowflake__")) {
      return respond();
    }

    const toolInput = hookInput.tool_input || {};
    const cwd = hookInput.cwd || process.cwd();
    const result = checkMcpDataCall(toolName, toolInput, cwd);

    if (!result) {
      return respond();
    }

    if (result.action === "deny") {
      try {
        log.writeLog({
          hook: "mcp-data-guard",
          event: "deny",
          session_id: hookInput.session_id,
          tool_use_id: hookInput.tool_use_id,
          details: result.reason,
          project: hookInput.cwd,
        });
      } catch { /* logging failure must not suppress the deny */ }
      return respond({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: result.reason,
        },
      });
    } else if (result.action === "update") {
      try {
        log.writeLog({
          hook: "mcp-data-guard",
          event: "autofix",
          session_id: hookInput.session_id,
          tool_use_id: hookInput.tool_use_id,
          details: toolName,
          project: hookInput.cwd,
        });
      } catch { /* logging failure must not suppress the update */ }
      return respond({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          updatedInput: result.updatedInput,
        },
      });
    }
    return respond();
  } catch {
    return respond();
  }
});

// ─── Exports ─────────────────────────────────────────────────────────────────

if (typeof module !== "undefined") {
  module.exports = {
    checkMcpDataCall, checkPhantomCollection, checkBareObjectId,
    checkEmptyFilter, checkSnowflakeLimit, checkDatadogRange, checkDatadogPhantomFilters, checkAppointmentStatus,
    checkCollectionDiscovered, loadDiscovered, saveDiscovered, getDiscoveryStatePath,
    autoFixFindLimit, autoFixAggregateLimit,
    COLLECTIONS, PHANTOM_COLLECTIONS, STRING_ID_FIELDS,
  };
}
