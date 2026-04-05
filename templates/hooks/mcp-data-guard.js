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

const SCHEMA_BASE = "model-repository/src/luma/models";

const COLLECTIONS = {
  users: { schema: "user.ts", orgField: "user", orgType: "objectId", notes: "Discriminated by type: 'doctor'|'patient'|'staff'. No separate providers/patients collection." },
  appointments: { schema: "appointment.ts", orgField: "org", orgType: "string", notes: "org field is a plain string (not ObjectId). Status: unconfirmed|confirmed|cancelled. Two external IDs: externalId and secondaryExternalId." },
  integrators: { schema: "integrator.ts", orgField: "user", orgType: "objectId", notes: "hl7InboundInterceptor is customer-specific JS code." },
  messages: { schema: "message.ts", orgField: "user", orgType: "objectId", notes: "ref + refId pattern for entity linking. Phone numbers in E.164 format." },
  facilities: { schema: "facility.ts", orgField: "user", orgType: "objectId" },
  settings: { schema: "setting.ts", orgField: "user", orgType: "objectId" },
  patientforms: { schema: "patient-form.ts", orgField: "root", orgType: "objectId" },
  appointmenttypes: { schema: "appointment-type.ts", orgField: "user", orgType: "objectId" },
  hl7messages: { schema: "hl7-message.ts", notes: "Collection name is all lowercase (not hl7Messages)." },
};

const PHANTOM_COLLECTIONS = {
  providers: { real: "users", filter: '{ type: "doctor" }', schema: "provider.ts" },
  patients: { real: "users", filter: '{ type: "patient" }', schema: "patient.ts" },
  hl7Messages: { real: "hl7messages", note: "Collection name is all lowercase — not camelCase." },
};

// Fields known to store plain strings (not ObjectIds) across collections
const STRING_ID_FIELDS = ["org", "externalId", "secondaryExternalId", "source"];

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
    // Claude Code may serialize object parameters as JSON strings; use directly to avoid double-stringify
    if (typeof toolInput.filter === "string") {
      json = toolInput.filter;
    } else {
      try { json = JSON.stringify(toolInput.filter); } catch { return null; }
    }
  } else if (toolName === "mcp__mongodb__aggregate") {
    if (!toolInput.pipeline) return null;
    if (typeof toolInput.pipeline === "string") {
      json = toolInput.pipeline;
    } else {
      try { json = JSON.stringify(toolInput.pipeline); } catch { return null; }
    }
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

  const BLOCKED_RANGES = ["14d"];
  if (BLOCKED_RANGES.includes(range)) {
    return {
      action: "deny",
      reason: `Query range "${range}" is too wide. Use 1h, 4h, 8h, 1d, 7d, or 30d.`,
    };
  }
  return null;
}

/**
 * Block appointment queries using status values that don't exist in Luma.
 * Valid statuses: unconfirmed | confirmed | cancelled.
 * @returns {{ action: "deny", reason: string } | null}
 */
function checkAppointmentStatus(toolName, toolInput) {
  if (toolName !== "mcp__mongodb__find" && toolName !== "mcp__mongodb__aggregate") return null;
  if (toolInput.collection !== "appointments") return null;

  let json;
  if (toolName === "mcp__mongodb__find") {
    if (!toolInput.filter) return null;
    try { json = JSON.stringify(toolInput.filter); } catch { return null; }
  } else {
    if (!toolInput.pipeline) return null;
    try { json = JSON.stringify(toolInput.pipeline); } catch { return null; }
  }

  const INVALID_STATUSES = ["completed", "pending", "scheduled", "no-show", "noshow", "checked-in", "checkedin", "arrived"];
  for (const status of INVALID_STATUSES) {
    if (json.includes(`"${status}"`)) {
      return {
        action: "deny",
        reason: `Invalid appointment status \`${status}\`. Valid statuses are: unconfirmed, confirmed, cancelled. There is no 'completed' or 'pending' status in Luma.`,
      };
    }
  }
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

  const PHANTOM_KEYS = { "@rootId": "@user", "@orgId": "@user" };
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
