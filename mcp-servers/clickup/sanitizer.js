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
  redactStringsWithPresidio,
} = require('../shared/sanitizer-core.js');

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Sanitize any JSON-serializable value:
 *   1. Collect all string leaves into one flat array
 *   2. Batch Presidio redaction on the entire flat array (throws if unavailable)
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

  // Batch Presidio redaction (throws if unavailable)
  const redacted = redactStringsWithPresidio(allStrings);

  // Splice redacted strings back into the value tree
  const cursor = { i: 0 };
  return applyRedacted(value, redacted, cursor);
}

module.exports = { sanitizeValue };
