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

const ENTITIES = {
  // ── Regex-based (always available) ──────────────────────────────────────────
  US_SSN: {
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
    placeholder: "[SSN]",
  },
  EMAIL: {
    // Standard email — excludes user@example.com, config@localhost, noreply@example.com,
    // and *.invalid TLD (RFC 2606 reserved for testing, e.g. canary tokens).
    regex: /\b[a-zA-Z0-9._%+\-]+@(?!example\.com\b|localhost\b|example\.org\b|example\.net\b|[a-zA-Z0-9.\-]+\.invalid\b)[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/g,
    placeholder: "[EMAIL]",
  },
  PHONE_US: {
    // \b before the area code only applies when it starts with a digit (no parens).
    // The alternation handles both paren-prefix and plain-digit area code formats.
    // Dot removed from separators to avoid matching version strings like "2.0.0-1234".
    // Negative lookbehind (?<![.\d]) rejects matches like "v1.800.555.1234" where
    // the area code is preceded by a dot (version-string context).
    regex: /(?<![.\d])(?:\+?1[-\s])?(?:\(\d{3}\)[-\s]?|\d{3}[-\s])\d{3}[-\s]\d{4}\b/g,
    placeholder: "[PHONE]",
    validate(match) {
      // Reject if the match looks like a version segment: all separators are dots
      // (already excluded by regex) or if it's a pure digit run with no separators.
      // Additional guard: require at least one hyphen, space, or paren in the match.
      return /[-\s()]/.test(match);
    },
  },
  CREDIT_CARD: {
    // Requires separator pattern (spaces or hyphens between groups) like real card numbers.
    // Matches: digit groups separated by spaces or hyphens (e.g. NNNN-NNNN-NNNN-NNNN).
    // Does NOT match unseparated digit strings — too many false positives in code.
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
  IBAN_CODE: {
    // International Bank Account Number: 2-letter country code, 2 check digits, up to 30 alphanum
    regex: /\b[A-Z]{2}\d{2}[A-Z0-9]{4,30}\b/g,
    placeholder: "[IBAN_CODE]",
    validate(match) {
      // Valid IBANs are 15–34 chars total
      return match.length >= 15 && match.length <= 34;
    },
  },
  US_ITIN: {
    // Individual Taxpayer ID: starts with 9, middle two digits in 70-88, 90-92, or 94-99
    regex: /\b9\d{2}[-\s]?(?:7[0-9]|8[0-8]|9[0-2]|9[4-9])[-\s]?\d{4}\b/g,
    placeholder: "[US_ITIN]",
  },
  US_PASSPORT: {
    // US passport: one uppercase letter followed by 8 digits
    regex: /\b[A-Z]\d{8}\b/g,
    placeholder: "[US_PASSPORT]",
  },
  CRYPTO: {
    // Ethereum address (0x + 40 hex chars), Bitcoin legacy (25–34 base58 chars), Bech32 (bc1 prefix)
    regex: /\b(?:0x[a-fA-F0-9]{40}|[13][a-km-zA-HJ-NP-Z1-9]{25,34}|bc1[a-z0-9]{39,59})\b/g,
    placeholder: "[CRYPTO]",
  },
  DATE_TIME: {
    // Bare date patterns without a label: MM/DD/YYYY, DD-MM-YY, etc.
    // Also matches spelled-out month formats: Jan 15, 2024 / January 15, 2024
    regex: /\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b/gi,
    placeholder: "[DATE_TIME]",
  },
  URL: {
    // HTTP/HTTPS URLs — excludes localhost and example domains
    regex: /https?:\/\/(?!localhost\b|127\.0\.0\.1\b|example\.com\b|example\.org\b|example\.net\b)[^\s"'<>]+/g,
    placeholder: "[URL]",
  },
  UK_NHS: {
    // NHS number: three groups of digits (3-3-4) separated by spaces or hyphens
    regex: /\b\d{3}[-\s]\d{3}[-\s]\d{4}\b/g,
    placeholder: "[UK_NHS]",
  },
  SG_NRIC_FIN: {
    // Singapore NRIC/FIN: S/T/F/G/M prefix + 7 digits + checksum letter
    regex: /\b[STFGM]\d{7}[A-Z]\b/g,
    placeholder: "[SG_NRIC_FIN]",
  },
  AU_ABN: {
    // Australian Business Number: 11 digits optionally space-grouped as NN NNN NNN NNN
    regex: /\b\d{2}\s?\d{3}\s?\d{3}\s?\d{3}\b/g,
    placeholder: "[AU_ABN]",
    validate(match) {
      return match.replace(/\s/g, "").length === 11;
    },
  },
  AU_TFN: {
    // Australian Tax File Number: 9 digits optionally grouped as NNN NNN NNN
    regex: /\b\d{3}[-\s]?\d{3}[-\s]?\d{3}\b/g,
    placeholder: "[AU_TFN]",
    validate(match) {
      return match.replace(/[-\s]/g, "").length === 9;
    },
  },
  IN_PAN: {
    // Indian Permanent Account Number: 5 uppercase letters + 4 digits + 1 uppercase letter
    regex: /\b[A-Z]{5}\d{4}[A-Z]\b/g,
    placeholder: "[IN_PAN]",
  },
  IN_AADHAAR: {
    // Indian Aadhaar: 12 digits optionally in XXXX XXXX XXXX format
    regex: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g,
    placeholder: "[IN_AADHAAR]",
    validate(match) {
      return match.replace(/[-\s]/g, "").length === 12;
    },
  },
  AU_MEDICARE: {
    // Australian Medicare card: 10 digits optionally followed by a sub-number digit
    regex: /\b\d{10}[\/\s]?\d?\b/g,
    placeholder: "[AU_MEDICARE]",
    validate(match) {
      const digits = match.replace(/[\/\s]/g, "");
      return digits.length === 10 || digits.length === 11;
    },
  },
  IN_VEHICLE_REGISTRATION: {
    // Indian vehicle registration plate: state code + district number + series + number
    regex: /\b[A-Z]{2}[-\s]\d{1,2}[-\s][A-Z]{1,3}[-\s]\d{4}\b/g,
    placeholder: "[IN_VEHICLE_REGISTRATION]",
  },

  // ── NLP-only types (presidioOnly: true) ─────────────────────────────────────
  // Require the Presidio MCP server. Set PRESIDIO_AVAILABLE=1 in environment to enable.
  // These are skipped by detectPII() unless { includePresidioOnly: true } is passed.
  PERSON: {
    presidioOnly: true,
    placeholder: "[PERSON]",
  },
  LOCATION: {
    presidioOnly: true,
    placeholder: "[LOCATION]",
  },
  NRP: {
    // Nationality, religion, or political group
    presidioOnly: true,
    placeholder: "[NRP]",
  },
  ORGANIZATION: {
    presidioOnly: true,
    placeholder: "[ORGANIZATION]",
  },
  PHONE_NUMBER: {
    // International phone numbers — NLP preferred to avoid high false positive rate
    presidioOnly: true,
    placeholder: "[PHONE_NUMBER]",
  },
  MEDICAL_LICENSE: {
    // Medical license numbers vary by jurisdiction — NLP preferred
    presidioOnly: true,
    placeholder: "[MEDICAL_LICENSE]",
  },
  US_DRIVER_LICENSE: {
    // US driver's license numbers vary by state — NLP preferred
    presidioOnly: true,
    placeholder: "[US_DRIVER_LICENSE]",
  },
  AU_ACN: {
    // Australian Company Number — NLP preferred for context disambiguation
    presidioOnly: true,
    placeholder: "[AU_ACN]",
  },
};

// PATTERNS is an alias for ENTITIES kept for backward compatibility.
const PATTERNS = ENTITIES;

// DEFAULT_ENTITIES: regex-capable types only (excludes presidioOnly).
// Used when no explicit entity list is provided to detectPII().
const DEFAULT_ENTITIES = Object.keys(ENTITIES).filter(k => !ENTITIES[k].presidioOnly);

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
  const presidioAvailable = process.env.PRESIDIO_AVAILABLE === "1";
  for (const entity of entities) {
    const pattern = PATTERNS[entity];
    if (!pattern) continue;

    // Skip presidioOnly entities unless PRESIDIO_AVAILABLE=1 is set
    if (pattern.presidioOnly && !presidioAvailable) continue;
    // presidioOnly entities have no regex — nothing to do without Presidio
    if (!pattern.regex) continue;

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
