'use strict';

/**
 * sanitizer.js
 *
 * PHI sanitizer for MongoDB documents.
 *
 * Uses phi-config-loader.js for field-level blocking and sanitizer-core.js
 * for string redaction. Supports batch Presidio processing for efficiency.
 *
 * Exported:
 *   sanitizeDocument(doc, tableName)          — sanitize a single document
 *   sanitizeDocuments(docs, tableName)        — sanitize an array of documents
 *   sanitizeProjection(projection, tableName) — remove PHI fields from projection
 *   filterPipeline(pipeline)                  — throw if $out/$merge found
 */

const {
  isPHIInContext,
  isEntityTable,
  PHI_COLUMNS,
} = require('../shared/phi-config-loader.js');

const {
  collectStrings,
  applyRedacted,
  redactString,
  redactStringsWithPresidio,
} = require('../shared/sanitizer-core.js');

// ── Field-level PHI removal ───────────────────────────────────────────────────

/**
 * Recursively drop PHI fields from a document object. Nested objects are
 * processed recursively; arrays and scalar values are passed through unchanged.
 *
 * @param {object} doc
 * @param {string} tableName
 * @returns {object}
 */
function dropPHIFields(doc, tableName) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return doc;
  const out = {};
  for (const [key, val] of Object.entries(doc)) {
    if (isPHIInContext(key, [tableName])) continue;
    if (
      val !== null &&
      typeof val === 'object' &&
      !Array.isArray(val) &&
      !(val instanceof Date) &&
      !(val instanceof Buffer)
    ) {
      out[key] = dropPHIFields(val, tableName);
    } else {
      out[key] = val;
    }
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
  if (val instanceof Date || val instanceof Buffer) return val;
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
 * Sanitize a single document:
 *   1. Drop PHI fields (field-level blocking via isPHIInContext)
 *   2. Redact remaining string leaves via redactString (regex + openredaction)
 *
 * For bulk processing prefer sanitizeDocuments, which batches Presidio across
 * all documents in a single subprocess call.
 *
 * @param {object} doc
 * @param {string} tableName
 * @returns {Promise<object>}
 */
async function sanitizeDocument(doc, tableName) {
  if (!doc || typeof doc !== 'object') return doc;
  const cleaned = dropPHIFields(doc, tableName);
  if (isEntityTable(tableName)) return cleaned;
  return redactStringsInValue(cleaned);
}

/**
 * Sanitize an array of documents efficiently:
 *   1. Drop PHI fields from each document
 *   2. Collect all string leaves from all documents into one flat array
 *   3. Attempt batch Presidio redaction on the entire flat array
 *   4. On Presidio failure, fall back to per-string redactString
 *   5. Splice redacted strings back into each document tree
 *
 * @param {object[]} docs
 * @param {string} tableName
 * @returns {Promise<object[]>}
 */
async function sanitizeDocuments(docs, tableName) {
  if (!Array.isArray(docs) || docs.length === 0) return docs;

  // Step 1: drop PHI fields
  const cleaned = docs.map(doc => dropPHIFields(doc, tableName));

  // Entity tables: skip string redaction
  if (isEntityTable(tableName)) return cleaned;

  // Step 2: collect all string leaves across all docs
  const allStrings = [];
  for (const doc of cleaned) collectStrings(doc, allStrings);
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

  // Step 5: splice back into document trees
  const cursor = { i: 0 };
  return cleaned.map(doc => applyRedacted(doc, redacted, cursor));
}

/**
 * Given a user-supplied MongoDB projection object, mark any PHI fields as
 * excluded (value 0). Returns an augmented copy. If no projection was provided,
 * returns an object containing only the PHI exclusions.
 *
 * @param {object|null|undefined} projection
 * @param {string} tableName
 * @returns {object}
 */
function sanitizeProjection(projection, tableName) {
  const out = projection ? Object.assign({}, projection) : {};
  // Check every field the caller explicitly included, plus all known PHI columns
  const allFields = new Set([...Object.keys(out), ...PHI_COLUMNS]);
  for (const field of allFields) {
    if (isPHIInContext(field, [tableName])) {
      out[field] = 0;
    }
  }
  return out;
}

/**
 * Scan a MongoDB aggregation pipeline and throw if any stage is $out or $merge.
 * Enforces read-only access to the database.
 *
 * @param {Array} pipeline
 * @throws {Error} if $out or $merge stage is present
 */
function filterPipeline(pipeline) {
  if (!Array.isArray(pipeline)) {
    throw new Error('Pipeline must be an array');
  }
  for (const stage of pipeline) {
    if (stage && typeof stage === 'object') {
      if ('$out' in stage) throw new Error('Pipeline stage $out is not allowed (read-only)');
      if ('$merge' in stage) throw new Error('Pipeline stage $merge is not allowed (read-only)');
    }
  }
}

module.exports = {
  sanitizeDocument,
  sanitizeDocuments,
  sanitizeProjection,
  filterPipeline,
};
