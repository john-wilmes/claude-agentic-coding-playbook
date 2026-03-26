'use strict';

/**
 * sanitizer.js
 *
 * PHI/PII sanitizer for Slack API responses.
 *
 * Slack is not a database with field-level PHI columns, so this module
 * performs string-level redaction only (no field blocking). Uses sanitizer-core.js
 * for the batch Presidio pass and per-string regex fallback.
 *
 * Exported:
 *   sanitizeValue(value) — async function that sanitizes any JSON-serializable
 *                          value (object, array, string, etc.) using the batch
 *                          Presidio → per-string redactString pattern.
 */

const {
  collectStrings,
  applyRedacted,
  redactString,
  redactStringsWithPresidio,
} = require('../shared/sanitizer-core.js');

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
 * Sanitize any JSON-serializable value:
 *   1. Collect all string leaves into one flat array
 *   2. Attempt batch Presidio redaction on the entire flat array
 *   3. On Presidio failure, fall back to per-string redactString
 *   4. Splice redacted strings back into the value tree
 *
 * @param {*} value
 * @returns {Promise<*>}
 */
async function sanitizeValue(value) {
  if (value === null || value === undefined) return value;

  // Collect all string leaves
  const allStrings = [];
  collectStrings(value, allStrings);
  if (allStrings.length === 0) return value;

  // Try batch Presidio
  const presidioResult = redactStringsWithPresidio(allStrings);

  let redacted;
  if (presidioResult) {
    redacted = presidioResult;
  } else {
    // Fallback: redact each string individually
    redacted = await Promise.all(allStrings.map(s => redactString(s)));
  }

  // Splice redacted strings back into the value tree
  const cursor = { i: 0 };
  return applyRedacted(value, redacted, cursor);
}

module.exports = { sanitizeValue };
