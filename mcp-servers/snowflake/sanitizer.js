'use strict';

/**
 * sanitizer.js
 *
 * PHI sanitizer for Snowflake query results.
 *
 * Uses phi-config-loader.js for field-level blocking and sanitizer-core.js
 * for string redaction. Supports batch Presidio processing for efficiency.
 *
 * Exported:
 *   sanitizeRows(rows, tableName)  — sanitize an array of row objects
 *   validateQuery(sql)             — throw if the query is not safe/read-only
 */

const {
  isPHIInContext,
  isEntityTable,
} = require('../shared/phi-config-loader.js');

const {
  collectStrings,
  applyRedacted,
  redactString,
  redactStringsWithPresidio,
} = require('../shared/sanitizer-core.js');

// ── Field-level PHI removal ───────────────────────────────────────────────────

/**
 * Drop PHI fields from a single row object.
 * Snowflake rows are flat objects (no nested documents), so no recursion needed.
 *
 * @param {object} row
 * @param {string} tableName
 * @returns {object}
 */
function dropPHIFields(row, tableName) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return row;
  const out = {};
  for (const [key, val] of Object.entries(row)) {
    if (isPHIInContext(key, [tableName])) continue;
    out[key] = val;
  }
  return out;
}

// ── Per-value string redaction (fallback) ─────────────────────────────────────

/**
 * Walk a value tree and redact all string leaves using redactString.
 * Used as a fallback when batch Presidio is unavailable.
 *
 * @param {*} val
 * @returns {Promise<*>}
 */
async function redactStringsInValue(val) {
  if (val === null || val === undefined) return val;
  if (typeof val === 'string') return redactString(val);
  if (val instanceof Date) return val;
  if (Array.isArray(val)) {
    return Promise.all(val.map(item => redactStringsInValue(item)));
  }
  if (typeof val === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      out[k] = await redactStringsInValue(v);
    }
    return out;
  }
  return val;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Sanitize an array of Snowflake row objects efficiently:
 *   1. Drop PHI fields from each row
 *   2. Collect all string leaves from all rows into one flat array
 *   3. Attempt batch Presidio redaction on the entire flat array
 *   4. On Presidio failure, fall back to per-string redactString
 *   5. Splice redacted strings back into each row tree
 *
 * String redaction is skipped for entity tables (lookup tables where values are
 * labels, not person data).
 *
 * @param {object[]} rows
 * @param {string} tableName
 * @returns {Promise<object[]>}
 */
async function sanitizeRows(rows, tableName) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;

  // Step 1: drop PHI fields
  const cleaned = rows.map(row => dropPHIFields(row, tableName));

  // Entity tables: skip string redaction
  if (isEntityTable(tableName)) return cleaned;

  // Step 2: collect all string leaves across all rows
  const allStrings = [];
  for (const row of cleaned) collectStrings(row, allStrings);
  if (allStrings.length === 0) return cleaned;

  // Step 3: try batch Presidio
  const presidioResult = redactStringsWithPresidio(allStrings);

  let redacted;
  if (presidioResult) {
    redacted = presidioResult;
  } else {
    // Step 4: fallback — redact each string individually
    redacted = await Promise.all(allStrings.map(s => redactString(s)));
  }

  // Step 5: splice back into row trees
  const cursor = { i: 0 };
  return cleaned.map(row => applyRedacted(row, redacted, cursor));
}

/**
 * Validate that a SQL query is safe to execute:
 *   - First non-whitespace keyword must be SELECT, DESCRIBE, SHOW, EXPLAIN,
 *     WITH, or USE (case-insensitive). All other first keywords are rejected to
 *     prevent INSERT, UPDATE, DELETE, DROP, CREATE, MERGE, etc.
 *   - Query must contain a LIMIT clause (case-insensitive) to prevent runaway
 *     full-table scans.
 *
 * @param {string} sql
 * @throws {Error} if the query is not allowed
 */
function validateQuery(sql) {
  if (typeof sql !== 'string' || sql.trim() === '') {
    throw new Error('sql must be a non-empty string');
  }

  const ALLOWED_KEYWORDS = new Set(['SELECT', 'DESCRIBE', 'SHOW', 'EXPLAIN', 'WITH', 'USE']);

  // Extract the first non-whitespace token
  const firstToken = sql.trim().split(/\s+/)[0].toUpperCase();
  if (!ALLOWED_KEYWORDS.has(firstToken)) {
    throw new Error(
      `Query type "${firstToken}" is not allowed. Only ${[...ALLOWED_KEYWORDS].join(', ')} queries are permitted (read-only).`
    );
  }

  // Require LIMIT clause (case-insensitive) — prevent unbounded result sets
  if (!/\bLIMIT\b/i.test(sql)) {
    throw new Error('Query must include a LIMIT clause to prevent runaway full-table scans.');
  }
}

module.exports = {
  sanitizeRows,
  validateQuery,
};
