'use strict';

/**
 * sanitizer.js
 *
 * PHI/PII sanitizer for ClickUp API responses.
 *
 * ClickUp is not a database with field-level PHI columns, so this module
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
  redactStringLegacy,
} = require('../shared/sanitizer-core.js');

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Sanitize any JSON-serializable value using regex-only redaction.
 *
 * ClickUp tasks contain org names, person names, and location strings that are
 * not PHI — running Presidio NLP over them causes over-redaction. We apply only
 * the regex pass, which catches actual credentials: emails, phone numbers, SSNs,
 * JWTs, and bearer tokens.
 *
 *   1. Collect all string leaves into one flat array
 *   2. Apply regex redaction to each string
 *   3. Splice redacted strings back into the value tree
 *
 * @param {*} value
 * @returns {*}
 */
function sanitizeValue(value) {
  if (value === null || value === undefined) return value;

  // Collect all string leaves
  const allStrings = [];
  collectStrings(value, allStrings);
  if (allStrings.length === 0) return value;

  // Regex-only redaction — no NLP, no Presidio
  const redacted = allStrings.map(redactStringLegacy);

  // Splice redacted strings back into the value tree
  const cursor = { i: 0 };
  return applyRedacted(value, redacted, cursor);
}

module.exports = { sanitizeValue };
