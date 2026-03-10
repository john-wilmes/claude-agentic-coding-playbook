// Shared JSONL logging module for Claude Code hooks.
// Node.js stdlib only — no npm dependencies.
//
// Usage (from any hook in ~/.claude/hooks/):
//   const { writeLog, promptHead, pruneOldLogs } = require("./log");
//
// Log files rotate daily to ~/.claude/logs/YYYY-MM-DD.jsonl.
// Old files are pruned automatically (90-day retention) at most once per day.

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

// ─── Configuration ────────────────────────────────────────────────────────────

const LOG_DIR = path.join(os.homedir(), ".claude", "logs");
const DEFAULT_RETENTION_DAYS = 90;

// ─── Internal state ───────────────────────────────────────────────────────────

// Track which calendar date we last ran pruning so it fires at most once per day.
let lastPruneDate = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Return today's date string in YYYY-MM-DD format (local time).
 * @returns {string}
 */
function todayString() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Return the absolute path to today's log file.
 * @returns {string}
 */
function todayLogPath() {
  return path.join(LOG_DIR, `${todayString()}.jsonl`);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Write a single JSON line to the daily log file.
 *
 * Required fields in entry: `hook` and `event`.
 * `ts` is auto-populated with an ISO-8601 timestamp if not provided.
 * All other fields are optional.
 *
 * Also triggers pruneOldLogs() at most once per calendar day.
 *
 * @param {object} entry
 * @param {string} entry.hook        - Hook name (e.g. "context-guard")
 * @param {string} entry.event       - Event type: block|warn|allow|skip|error
 * @param {string} [entry.ts]        - ISO-8601 timestamp (auto-filled if absent)
 * @param {string} [entry.session_id]
 * @param {string} [entry.tool_use_id]
 * @param {string|null} [entry.agent_id]
 * @param {string} [entry.decision]  - block|allow|warn
 * @param {string} [entry.details]   - Human-readable summary
 * @param {object} [entry.context]   - Arbitrary structured data (e.g. { ratio, pct })
 */
function writeLog(entry) {
  if (!entry || typeof entry !== "object") {
    throw new TypeError("writeLog: entry must be an object");
  }
  if (typeof entry.hook !== "string" || !entry.hook) {
    throw new TypeError("writeLog: entry.hook is required");
  }
  if (typeof entry.event !== "string" || !entry.event) {
    throw new TypeError("writeLog: entry.event is required");
  }

  // Ensure log directory exists
  fs.mkdirSync(LOG_DIR, { recursive: true });

  // Auto-populate timestamp
  const record = Object.assign({ ts: new Date().toISOString() }, entry);

  const line = JSON.stringify(record) + "\n";
  fs.appendFileSync(todayLogPath(), line, "utf8");

  // Prune at most once per calendar day
  const today = todayString();
  if (lastPruneDate !== today) {
    lastPruneDate = today;
    try {
      pruneOldLogs(DEFAULT_RETENTION_DAYS);
    } catch {
      // Pruning failure must never crash the hook
    }
  }
}

/**
 * Return the first `maxLen` characters of `text`, appending "..." if truncated.
 * Designed for privacy: never log full prompt text.
 *
 * @param {string} text
 * @param {number} [maxLen=100]
 * @returns {string}
 */
function promptHead(text, maxLen = 100) {
  if (typeof text !== "string") {
    text = String(text == null ? "" : text);
  }
  if (maxLen <= 0) {
    return "";
  }
  if (text.length <= maxLen) {
    return text;
  }
  return text.slice(0, maxLen) + "...";
}

/**
 * Delete .jsonl files in the log directory older than `retentionDays`.
 * Files whose name does not match YYYY-MM-DD.jsonl are left untouched.
 *
 * Called automatically by writeLog() at most once per calendar day.
 * Can also be called directly for testing or maintenance.
 *
 * @param {number} [retentionDays=90]
 */
function pruneOldLogs(retentionDays = DEFAULT_RETENTION_DAYS) {
  let entries;
  try {
    entries = fs.readdirSync(LOG_DIR);
  } catch {
    // Log directory does not exist yet — nothing to prune
    return;
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);
  // Normalise to midnight so date-only comparison is stable
  cutoff.setHours(0, 0, 0, 0);
  const cutoffStr = cutoff.toISOString().slice(0, 10); // YYYY-MM-DD

  for (const name of entries) {
    if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) {
      continue;
    }
    const fileDate = name.slice(0, 10); // YYYY-MM-DD
    if (fileDate < cutoffStr) {
      try {
        fs.rmSync(path.join(LOG_DIR, name), { force: true });
      } catch {
        // Ignore individual file removal failures
      }
    }
  }
}

module.exports = { writeLog, promptHead, pruneOldLogs };
