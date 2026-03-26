'use strict';

/**
 * sanitizer-core.js
 *
 * Shared string redaction engine used by mongodb-sanitizer and
 * snowflake-sanitizer (and optionally datadog-sanitizer).
 *
 * Provides three redaction layers, applied in order:
 *   1. openredaction (npm) — ML-based, catches names/values regex misses
 *   2. Presidio (Python subprocess, optional) — NLP-based entity recognition
 *   3. Legacy regex — always available, zero dependencies
 *
 * Exported:
 *   PRESIDIO_SCRIPT          — inline Python script string
 *   collectStrings(val, out) — collect all string leaves into a flat array
 *   applyRedacted(val, arr, cursor) — substitute redacted values back into tree
 *   checkPresidioAvailable() — probe once, cache result
 *   redactStringsWithPresidio(strings) — batch Presidio call
 *   redactStringLegacy(s)    — regex fallback
 *   redactString(s)          — tries openredaction, falls back to legacy
 */

const { spawnSync } = require('child_process');

// ── Regex patterns for the legacy redaction pass ─────────────────────────────
// Applied in order. Each entry is [RegExp, replacement string].
const REDACT_PATTERNS_LEGACY = [
  [/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,        '[EMAIL]'],
  [/\(?\b\d{3}\)?[\s\-\.]?\d{3}[\s\-\.]\d{4}\b/g,               '[PHONE]'],
  [/\b\d{3}-\d{2}-\d{4}\b/g,                                     '[SSN]'],
  [/authorization:\s*bearer\s+[A-Za-z0-9\-\._~\+\/]+=*/gi,      'Authorization: Bearer [REDACTED]'],
  [/\bbearer\s+[A-Za-z0-9\-\._~\+\/]+=*/gi,                     'Bearer [REDACTED]'],
  [/\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/g, '[JWT]'],
  [/\b(mongodb(?:\+srv)?|postgres(?:ql)?|mysql):\/\/[^\s/]+:[^\s@]+@/gi, '[URI-CREDS]'],
];

// ── openredaction lazy singleton ─────────────────────────────────────────────
let _openRedaction = null;

// ── Presidio availability cache ──────────────────────────────────────────────
// null = unchecked, true = available, false = unavailable
let _presidioAvailable = null;

// ── Presidio inline Python script ────────────────────────────────────────────
/**
 * Python script that reads a JSON array of strings from stdin and writes a JSON
 * array of redacted strings to stdout. Batches all values in one subprocess
 * invocation to amortize Presidio model-load cost.
 *
 * Usage: python3 -c PRESIDIO_SCRIPT <<< '["text1", "text2"]'
 */
const PRESIDIO_SCRIPT = `
import sys, json
from presidio_analyzer import AnalyzerEngine
from presidio_anonymizer import AnonymizerEngine
a = AnalyzerEngine()
an = AnonymizerEngine()
texts = json.loads(sys.stdin.read())
out = []
for t in texts:
    try:
        r = a.analyze(text=t, language='en')
        out.append(an.anonymize(text=t, analyzer_results=r).text if r else t)
    except Exception:
        out.append(t)
print(json.dumps(out))
`.trim();

// ── Tree walker utilities ─────────────────────────────────────────────────────

/**
 * Collect all string leaf values from a value tree into a flat array.
 * Populates `out` in-place and returns it.
 *
 * Compatible with MongoDB BSON types: Date and Buffer pass through unchanged.
 *
 * @param {*} val
 * @param {string[]} out
 * @returns {string[]}
 */
function collectStrings(val, out) {
  if (val === null || val === undefined) return out;
  if (typeof val === 'string') { out.push(val); return out; }
  if (Array.isArray(val)) { for (const item of val) collectStrings(item, out); return out; }
  if (val instanceof Date || val instanceof Buffer) return out;
  if (typeof val === 'object') { for (const v of Object.values(val)) collectStrings(v, out); }
  return out;
}

/**
 * Walk a value tree and replace string leaf values using the flat `redacted`
 * array, consumed in document order via a shared `cursor` object `{ i: 0 }`.
 *
 * Must be called with the same tree structure that was passed to collectStrings
 * so string positions match.
 *
 * @param {*} val
 * @param {string[]} redacted
 * @param {{ i: number }} cursor
 * @returns {*}
 */
function applyRedacted(val, redacted, cursor) {
  if (val === null || val === undefined) return val;
  if (typeof val === 'string') { return redacted[cursor.i++]; }
  if (Array.isArray(val)) { return val.map(item => applyRedacted(item, redacted, cursor)); }
  if (val instanceof Date || val instanceof Buffer) return val;
  if (typeof val === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(val)) out[k] = applyRedacted(v, redacted, cursor);
    return out;
  }
  return val;
}

// ── Presidio ─────────────────────────────────────────────────────────────────

/**
 * Check once whether python3 + presidio are importable.
 * Result is cached in _presidioAvailable.
 *
 * @returns {boolean}
 */
function checkPresidioAvailable() {
  if (_presidioAvailable !== null) return _presidioAvailable;
  try {
    const probe = spawnSync('python3', ['-c', 'from presidio_analyzer import AnalyzerEngine'], {
      timeout: 5000,
      encoding: 'utf8',
    });
    _presidioAvailable = probe.status === 0;
  } catch (_) {
    _presidioAvailable = false;
  }
  return _presidioAvailable;
}

/**
 * Redact an array of strings through Presidio in a single subprocess call.
 * Returns the redacted array, or null if Presidio is unavailable / errors.
 *
 * @param {string[]} strings
 * @returns {string[]|null}
 */
function redactStringsWithPresidio(strings) {
  if (!checkPresidioAvailable()) return null;
  if (!strings || strings.length === 0) return strings;
  try {
    const result = spawnSync('python3', ['-c', PRESIDIO_SCRIPT], {
      input: JSON.stringify(strings),
      timeout: 30000,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
    if (result.status !== 0) return null;
    const parsed = JSON.parse(result.stdout.trim());
    if (!Array.isArray(parsed) || parsed.length !== strings.length) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

// ── String redaction ─────────────────────────────────────────────────────────

/**
 * Redact a single string using regex patterns only.
 * Always available — no external dependencies.
 *
 * @param {string} s
 * @returns {string}
 */
function redactStringLegacy(s) {
  let out = s;
  for (const [pattern, replacement] of REDACT_PATTERNS_LEGACY) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Redact a single string. Tries openredaction (npm) for ML-based detection,
 * falls back to regex-only legacy redaction if openredaction is not installed
 * or throws.
 *
 * Note: the Presidio pass is applied separately as a batch operation over all
 * strings in a document set — see redactStringsWithPresidio.
 *
 * @param {string} s
 * @returns {Promise<string>}
 */
async function redactString(s) {
  try {
    if (!_openRedaction) {
      const { OpenRedaction } = require('openredaction');
      _openRedaction = new OpenRedaction();
    }
    const result = await _openRedaction.detect(s);
    return result && result.redacted != null ? result.redacted : s;
  } catch (_) {
    return redactStringLegacy(s);
  }
}

module.exports = {
  PRESIDIO_SCRIPT,
  REDACT_PATTERNS_LEGACY,
  collectStrings,
  applyRedacted,
  checkPresidioAvailable,
  redactStringsWithPresidio,
  redactStringLegacy,
  redactString,
};
