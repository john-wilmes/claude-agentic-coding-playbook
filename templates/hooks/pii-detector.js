// PII detector module — shared utility for sanitize-guard.js and other hooks.
//
// Exports:
//   detectPII(text, enabledEntities) → [{ entity, match, index, length }]
//   redact(text, detections)         → string with PII replaced by [TYPE] placeholders
//   loadConfig(cwd)                  → parsed sanitize.yaml config object or null
//   DEFAULT_ENTITIES                 → array of all built-in entity type names
//   PATTERNS                         → map of entity name → { regex, placeholder }
//
// Zero npm dependencies — Node stdlib only.
// Exit 0 always — loadConfig returns null on any error; detectPII/redact never throw.

"use strict";

const fs   = require("fs");
const path = require("path");

// ─── Luhn check (credit card validation) ─────────────────────────────────────

function luhnCheck(digits) {
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i], 10);
    if (alternate) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

// ─── Private IP exclusion helper ─────────────────────────────────────────────

function isPrivateOrLoopbackIP(ip) {
  const parts = ip.split(".").map(Number);
  if (parts[0] === 127) return true;                          // 127.x.x.x loopback
  if (parts[0] === 0 && parts[1] === 0 && parts[2] === 0 && parts[3] === 0) return true; // 0.0.0.0
  if (parts[0] === 10) return true;                           // 10.x.x.x
  if (parts[0] === 192 && parts[1] === 168) return true;     // 192.168.x.x
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true; // 172.16-31.x.x
  return false;
}

// ─── Built-in patterns ───────────────────────────────────────────────────────

const PATTERNS = {
  US_SSN: {
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
    placeholder: "[SSN]",
  },
  EMAIL: {
    // Standard email — excludes user@example.com, config@localhost, noreply@example.com, etc.
    regex: /\b[a-zA-Z0-9._%+\-]+@(?!example\.com\b|localhost\b|example\.org\b|example\.net\b)[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/g,
    placeholder: "[EMAIL]",
  },
  PHONE_US: {
    // \b before the area code only applies when it starts with a digit (no parens).
    // The alternation handles both "(555) 867-5309" and "555-867-5309".
    // Dot removed from separators to avoid matching version strings like "2.0.0-1234".
    regex: /(?<!\d)(?:\+?1[-\s]?)?(?:\(\d{3}\)[-\s]?|\b\d{3}[-\s])\d{3}[-\s]?\d{4}\b/g,
    placeholder: "[PHONE]",
  },
  CREDIT_CARD: {
    // Requires separator pattern (spaces or hyphens between groups) like real card numbers.
    // Matches: 4111-1111-1111-1111, 4111 1111 1111 1111
    // Does NOT match: 4111111111111111 (unseparated digits — too many false positives in code)
    regex: /\b\d{4}[- ]\d{4}[- ]\d{4}[- ]\d{1,7}(?:[- ]\d{1,4})?\b/g,
    placeholder: "[CREDIT_CARD]",
    validate(match) {
      const digits = match.replace(/[ -]/g, "");
      return /^\d{13,19}$/.test(digits) && luhnCheck(digits);
    },
  },
  IP_ADDRESS: {
    regex: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
    placeholder: "[IP_ADDRESS]",
    validate(match) {
      return !isPrivateOrLoopbackIP(match);
    },
  },
  MRN: {
    regex: /\bMRN[:\s#]+\d{4,10}\b/g,
    placeholder: "[MRN]",
  },
  DOB: {
    regex: /\b(?:DOB|Date of Birth|Birth\s?Date)[:\s]+\d{1,2}[/\-]\d{1,2}[/\-]\d{2,4}\b/g,
    placeholder: "[DOB]",
  },
};

const DEFAULT_ENTITIES = Object.keys(PATTERNS);

// ─── detectPII ────────────────────────────────────────────────────────────────

/**
 * Scan text for PII entities.
 *
 * @param {string} text
 * @param {string[]|null|undefined} enabledEntities - entity types to scan; null = all
 * @param {Array} [customPatterns] - additional patterns from config
 * @returns {Array<{entity: string, match: string, index: number, length: number}>}
 */
function detectPII(text, enabledEntities, customPatterns) {
  if (!text || typeof text !== "string") return [];

  const entities = Array.isArray(enabledEntities) ? enabledEntities : DEFAULT_ENTITIES;
  const detections = [];

  // Built-in patterns
  for (const entity of entities) {
    const pattern = PATTERNS[entity];
    if (!pattern) continue;

    // Clone regex with global flag to reset lastIndex each call
    const re = new RegExp(pattern.regex.source, pattern.regex.flags.includes("g") ? pattern.regex.flags : pattern.regex.flags + "g");
    let m;
    while ((m = re.exec(text)) !== null) {
      const match = m[0];
      // Run optional validator (Luhn, private IP exclusion)
      if (pattern.validate && !pattern.validate(match)) continue;
      detections.push({ entity, match, index: m.index, length: match.length });
    }
  }

  // Custom patterns (from config)
  if (Array.isArray(customPatterns)) {
    for (const cp of customPatterns) {
      if (!cp.name || !cp.regex) continue;
      try {
        const re = new RegExp(cp.regex, "g");
        let m;
        while ((m = re.exec(text)) !== null) {
          detections.push({
            entity: cp.name,
            match: m[0],
            index: m.index,
            length: m[0].length,
          });
        }
      } catch {
        // Invalid regex — skip this pattern
      }
    }
  }

  detections.sort((a, b) => a.index - b.index);
  return detections;
}

// ─── redact ──────────────────────────────────────────────────────────────────

/**
 * Replace detected PII with typed placeholders.
 * Processes detections in reverse order to preserve indices.
 *
 * @param {string} text
 * @param {Array} detections - output of detectPII
 * @returns {string}
 */
function redact(text, detections) {
  if (!text || typeof text !== "string") return text;
  if (!detections || detections.length === 0) return text;

  // Work in reverse index order to keep earlier indices valid
  const sorted = [...detections].sort((a, b) => b.index - a.index);
  let result = text;
  for (const d of sorted) {
    // Determine placeholder: built-in pattern or entity name fallback
    let placeholder;
    if (PATTERNS[d.entity]) {
      placeholder = PATTERNS[d.entity].placeholder;
    } else {
      placeholder = `[${d.entity}]`;
    }
    result = result.slice(0, d.index) + placeholder + result.slice(d.index + d.length);
  }
  return result;
}

// ─── YAML parser (hand-rolled, handles sanitize.yaml structure only) ─────────

/**
 * Minimal YAML parser for sanitize.yaml.
 *
 * Handles:
 *   key: value          (string / boolean)
 *   - item              (array of strings under a key)
 *   - name: value       (array of objects)
 *   # comments
 *
 * Returns a plain JS object or throws on structural errors.
 */
function parseSimpleYaml(text) {
  const lines = text.split("\n");
  const root = {};
  // Stack: each entry is { obj, indent }
  // We only need two levels: top-level keys + one nested level
  let currentKey = null;         // top-level key currently active
  let currentArray = null;       // array being populated (if value is a list)
  let currentArrayIndent = -1;
  let inCustomPatterns = false;  // inside custom_patterns array of objects
  let currentObj = null;         // current object being built inside an array

  function setValue(obj, key, value) {
    if (value === "true") obj[key] = true;
    else if (value === "false") obj[key] = false;
    else obj[key] = value;
  }

  for (let raw of lines) {
    // Strip inline comments, but not # characters inside quoted strings.
    // Walk the raw line: track whether we are inside single or double quotes;
    // if we encounter " #" (space + hash) outside any quote, that starts a comment.
    let stripped = raw;
    {
      let inSingle = false;
      let inDouble = false;
      let commentStart = -1;
      for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];
        if (ch === "'" && !inDouble) { inSingle = !inSingle; }
        else if (ch === '"' && !inSingle) { inDouble = !inDouble; }
        else if (!inSingle && !inDouble && ch === "#" && i > 0 && raw[i - 1] === " ") {
          commentStart = i - 1; // include the preceding space
          break;
        }
      }
      if (commentStart >= 0) stripped = raw.slice(0, commentStart);
    }
    const line = stripped.trimEnd();
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const indent = line.length - line.trimStart().length;
    const trimmed = line.trimStart();

    if (trimmed.startsWith("- ")) {
      // Array item
      const itemContent = trimmed.slice(2).trim();

      if (itemContent.includes(": ")) {
        // Object item: "- key: value"
        const colonIdx = itemContent.indexOf(": ");
        const k = itemContent.slice(0, colonIdx).trim();
        const v = stripQuotes(itemContent.slice(colonIdx + 2).trim());

        if (currentArray !== null) {
          // Starting a new object or continuing?
          // Each "- name:" starts a new object
          if (k === "name" || currentObj === null) {
            currentObj = {};
            currentArray.push(currentObj);
          }
          currentObj[k] = v;
        }
      } else {
        // String item: "- value"
        const v = stripQuotes(itemContent);
        if (currentArray !== null) {
          currentArray.push(v);
        }
      }
    } else if (trimmed.includes(": ")) {
      const colonIdx = trimmed.indexOf(": ");
      const k = trimmed.slice(0, colonIdx).trim();
      const v = stripQuotes(trimmed.slice(colonIdx + 2).trim());

      if (indent === 0) {
        // Top-level key with a value on the same line (e.g., "sanitization:")
        // If value is empty, it's a map key
        if (v === "") {
          root[k] = {};
          currentKey = k;
          currentArray = null;
          currentObj = null;
        } else {
          setValue(root, k, v);
          currentKey = null;
          currentArray = null;
        }
      } else if (indent > 0 && currentKey !== null) {
        // Nested key under currentKey
        if (v === "") {
          // Start of nested array/map
          root[currentKey][k] = [];
          currentArray = root[currentKey][k];
          currentArrayIndent = indent;
          currentObj = null;
        } else if (currentObj !== null && indent > currentArrayIndent) {
          // Continuation key on current object in array (e.g., regex: / placeholder:)
          currentObj[k] = v;
        } else {
          setValue(root[currentKey], k, v);
        }
      }
    } else if (trimmed.endsWith(":")) {
      // Key with no value — start of a block
      const k = trimmed.slice(0, -1).trim();
      if (indent === 0) {
        root[k] = {};
        currentKey = k;
        currentArray = null;
        currentObj = null;
      } else if (currentKey !== null) {
        root[currentKey][k] = [];
        currentArray = root[currentKey][k];
        currentArrayIndent = indent;
        currentObj = null;
      }
    }
  }

  return root;
}

function stripQuotes(s) {
  if (!s) return s;
  if ((s.startsWith('"') && s.endsWith('"')) ||
      (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

// ─── loadConfig ───────────────────────────────────────────────────────────────

/**
 * Walk up from cwd looking for .claude/sanitize.yaml.
 * Returns parsed config object or null on any error / not found.
 *
 * Config structure returned:
 * {
 *   enabled: boolean,
 *   entities: string[],
 *   exclude_paths: string[],
 *   custom_patterns: [{ name, regex, placeholder }],
 * }
 */
function loadConfig(cwd) {
  try {
    if (!cwd || typeof cwd !== "string") return null;

    let dir = path.resolve(cwd);
    const root = path.parse(dir).root;

    while (true) {
      const candidate = path.join(dir, ".claude", "sanitize.yaml");
      try {
        const raw = fs.readFileSync(candidate, "utf8");
        const parsed = parseSimpleYaml(raw);
        const san = parsed.sanitization;
        if (!san) return null;

        // Normalize: enabled defaults to true
        const enabled = san.enabled !== false;

        return {
          enabled,
          entities: Array.isArray(san.entities) ? san.entities : DEFAULT_ENTITIES,
          exclude_paths: Array.isArray(san.exclude_paths) ? san.exclude_paths : [],
          custom_patterns: Array.isArray(san.custom_patterns) ? san.custom_patterns : [],
        };
      } catch {
        // File not found or parse error at this level — keep walking up
      }

      if (dir === root) break;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }

    return null;
  } catch {
    return null;
  }
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  detectPII,
  redact,
  loadConfig,
  DEFAULT_ENTITIES,
  PATTERNS,
  // Exposed for testing
  _luhnCheck: luhnCheck,
  _isPrivateOrLoopbackIP: isPrivateOrLoopbackIP,
};
