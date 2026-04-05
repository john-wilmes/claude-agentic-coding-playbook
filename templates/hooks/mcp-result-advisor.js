"use strict";

// PostToolUse hook: injects context after MCP data tool calls.
// 1. First MCP data call per session: inject cheat sheet of common gotchas.
// 2. MongoDB 0-result queries: inject troubleshooting tips.
// 3. Datadog empty results: suggest filter key corrections.

const fs = require("fs");
const path = require("path");
const os = require("os");

let log;
try { log = require("./log"); } catch { log = { writeLog() {} }; }

// ─── State tracking ─────────────────────────────────────────────────────────

const STATE_DIR = path.join(os.tmpdir(), "claude-hooks");
const STATE_FILE = path.join(STATE_DIR, "mcp-result-advisor.json");

// Unique per-process fallback so a missing session_id doesn't create a shared
// "default" marker that suppresses the cheat sheet across unrelated runs.
const FALLBACK_SESSION_ID = `pid-${process.ppid || process.pid}-${Date.now()}`;

function sanitizeId(id) {
  const raw = id ? String(id) : FALLBACK_SESSION_ID;
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "fallback";
}

/**
 * Atomically claim the cheat sheet for a session.
 * Returns true if this is the first call for this session (cheat sheet should be shown),
 * false if already shown. Fails open (returns true) on unexpected errors.
 */
function claimCheatSheet(sessionId) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  } catch { /* best effort */ }
  const marker = path.join(STATE_DIR, `${sanitizeId(sessionId)}.seen`);
  try {
    fs.writeFileSync(marker, "", { flag: "wx" });
    return true; // successfully created — first time
  } catch (err) {
    if (err.code === "EEXIST") return false; // already shown
    return true; // fail open on other errors
  }
}

// Keep readState/writeState for backward compatibility with tests
function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeState(state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch { /* best effort */ }
}

// ─── Cheat sheet (injected once per session) ────────────────────────────────

const CHEAT_SHEET = `MCP Data Access Reminders:
• MongoDB: projection is REQUIRED (inclusion-mode, value: 1). Default limit is 20 (max 100).
• MongoDB: use { "$oid": "hex" } for ObjectId fields. Plain hex strings silently return 0 results.
• MongoDB: no "providers" or "patients" collection — query "users" with type: "doctor" or "patient".
• MongoDB: hl7messages is all lowercase (not hl7Messages).
• Datadog: use time_range (enum: 1h|4h|8h|1d), filters (object), and optional query (free-text).
• Snowflake: always include LIMIT.`;

// ─── Zero-result troubleshooting ────────────────────────────────────────────

const MONGO_ZERO_RESULT_TIPS = `MongoDB returned 0 results. Common causes:
1. Bare ObjectId — did you wrap hex IDs in { "$oid": "..." }? Plain strings silently match nothing.
2. Wrong collection — "providers"/"patients" don't exist; use "users" with type filter.
3. Wrong org field — each collection uses a different field for the org reference:
   • appointments: "org" (plain string, NOT ObjectId)
   • users/integrators/facilities/settings/messages: "user" (ObjectId — use $oid)
   • patientforms: "root" (ObjectId — use $oid)
   Example: { "user": { "$oid": "orgIdHere" } } for integrators.
4. Field name casing — check the model schema in your data models repo.
5. Status values — appointments only have: unconfirmed, confirmed, cancelled.`;

const DATADOG_ZERO_RESULT_TIPS = `Datadog returned 0 results. Common causes:
1. Wrong service name — real names are: integrator, rest, chat, followup (NOT integrator-service or rest-service).
2. Phantom filter keys — @rootId and @orgId silently return 0 results. Use @user for org/root ID filtering.
3. Allowed filter keys: service, env, status, host, source, @user, @level, @http.method, @http.status_code.
4. Hex IDs in messages — full-text search doesn't reliably find embedded hex. Use @user filter for org IDs.
5. Time range too narrow — try expanding to 4h or 8h.`;

// ─── Per-collection query guidance (injected after discover_collection) ─────

const COLLECTION_QUERY_GUIDE = {
  users: `Query guide for "users":
  • Org field: "user" (ObjectId — use $oid). Example: { "user": { "$oid": "orgId" } }
  • Discriminated by "type": "doctor" (providers), "patient" (patients), "staff"
  • No separate providers/patients collection — always query users with type filter.`,
  appointments: `Query guide for "appointments":
  • Org field: "org" (plain string — do NOT use $oid). Example: { "org": "orgId" }
  • Status: unconfirmed | confirmed | cancelled (no "completed" or "pending")
  • Two external IDs: externalId and secondaryExternalId — check both when looking up by EHR ID.`,
  integrators: `Query guide for "integrators":
  • Org field: "user" (ObjectId — use $oid). Example: { "user": { "$oid": "orgId" } }
  • hl7InboundInterceptor is customer-specific JS code — content varies per account.`,
  messages: `Query guide for "messages":
  • Org field: "user" (ObjectId — use $oid). Example: { "user": { "$oid": "orgId" } }
  • Uses ref + refId pattern for entity linking (e.g. ref: "appointment", refId: appointmentObjectId).
  • Phone numbers stored in E.164/INTERNATIONAL format.`,
  facilities: `Query guide for "facilities":
  • Org field: "user" (ObjectId — use $oid). Example: { "user": { "$oid": "orgId" } }`,
  settings: `Query guide for "settings":
  • Org field: "user" (ObjectId — use $oid). Example: { "user": { "$oid": "orgId" } }`,
  patientforms: `Query guide for "patientforms":
  • Org field: "root" (ObjectId — use $oid). Example: { "root": { "$oid": "orgId" } }`,
  appointmenttypes: `Query guide for "appointmenttypes":
  • Org field: "user" (ObjectId — use $oid). Example: { "user": { "$oid": "orgId" } }`,
  hl7messages: `Query guide for "hl7messages":
  • Collection name is all lowercase (not hl7Messages).
  • Integrator types: mi7 | hl7 | raw-hl7 | lyniate. Scheduling types: SIU_S12–SIU_S26.`,
};

// ─── Result analysis ────────────────────────────────────────────────────────

/**
 * Check if a tool result indicates zero results were returned.
 * @param {string} toolName
 * @param {string|object} toolResult - the tool_result from hookInput
 * @returns {boolean}
 */
function isZeroResult(toolName, toolResult) {
  if (!toolResult) return false;
  const text = typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult);

  if (toolName.startsWith("mcp__mongodb__")) {
    if (text.includes("No documents found")) return true;
    if (text.includes("0 documents")) return true;
    if (/\[\s*\]/.test(text) && text.length < 50) return true;
  }

  if (toolName.startsWith("mcp__datadog__")) {
    if (text.includes("No logs found")) return true;
    if (text.includes("0 logs")) return true;
    if (text.includes("no matching logs")) return true;
  }

  return false;
}

// ─── Main ───────────────────────────────────────────────────────────────────

function buildAdvice(toolName, toolResult, sessionId, toolInput) {
  const messages = [];

  // Check if this is the first MCP data call this session (atomic marker)
  if (claimCheatSheet(sessionId)) {
    messages.push(CHEAT_SHEET);
  }

  // After discover_collection: inject collection-specific query guide
  if (toolName === "mcp__mongodb__discover_collection") {
    const collection = toolInput && toolInput.collection;
    if (collection && COLLECTION_QUERY_GUIDE[collection]) {
      messages.push(COLLECTION_QUERY_GUIDE[collection]);
    }
  }

  // Zero-result troubleshooting
  if (isZeroResult(toolName, toolResult)) {
    if (toolName.startsWith("mcp__mongodb__")) {
      messages.push(MONGO_ZERO_RESULT_TIPS);
    } else if (toolName.startsWith("mcp__datadog__")) {
      messages.push(DATADOG_ZERO_RESULT_TIPS);
    }
  }

  return messages.length > 0 ? messages.join("\n\n") : null;
}

// ─── Output helper ──────────────────────────────────────────────────────────

function writeJson(payload) {
  process.stdout.write(JSON.stringify(payload));
}

// ─── stdin handler ──────────────────────────────────────────────────────────

if (require.main === module) {
  let input = "";
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("error", () => { writeJson({}); });
  process.stdin.on("end", () => {
    try {
      const hookInput = JSON.parse(input);
      const toolName = hookInput.tool_name || "";

      // Fast-exit for non-data MCP tools
      if (!toolName.startsWith("mcp__mongodb__") &&
          !toolName.startsWith("mcp__datadog__") &&
          !toolName.startsWith("mcp__snowflake__")) {
        return writeJson({});
      }

      const toolResult = hookInput.tool_response || "";
      const sessionId = hookInput.session_id || "";
      const toolInput = hookInput.tool_input || {};

      const advice = buildAdvice(toolName, toolResult, sessionId, toolInput);

      if (!advice) {
        return writeJson({});
      }

      try {
        log.writeLog({
          hook: "mcp-result-advisor",
          event: "inject",
          session_id: sessionId,
          tool_use_id: hookInput.tool_use_id,
          details: toolName,
          project: hookInput.cwd,
        });
      } catch { /* log failure must not suppress the cheat sheet */ }

      return writeJson({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: advice,
        },
      });
    } catch {
      return writeJson({});
    }
  });
}

// ─── Exports ────────────────────────────────────────────────────────────────

if (typeof module !== "undefined") {
  module.exports = {
    buildAdvice, isZeroResult, readState, writeState, claimCheatSheet, sanitizeId,
    CHEAT_SHEET, MONGO_ZERO_RESULT_TIPS, DATADOG_ZERO_RESULT_TIPS, COLLECTION_QUERY_GUIDE,
    STATE_FILE, STATE_DIR,
  };
}
