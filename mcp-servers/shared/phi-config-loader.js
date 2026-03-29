'use strict';

/**
 * phi-config-loader.js
 *
 * Config-driven replacement for the static phi-columns.js blocklist.
 *
 * Exports the same interface as phi-columns.js so either module can be used as
 * a drop-in:
 *   { isPHI, isPHIInContext, isEntityTable,
 *     PHI_COLUMNS, PERSON_TABLES, ENTITY_TABLES, CONTEXTUAL_PHI, normalizeCol }
 *
 * Config resolution order:
 *   1. PHI_CONFIG_PATH environment variable (absolute path to config file)
 *   2. phi-config.yaml / phi-config.json — searched upward from process.cwd()
 *   3. Built-in generic healthcare defaults (no site-specific table names)
 *
 * YAML parsing: uses js-yaml if installed (npm install js-yaml).
 * Falls back to JSON if js-yaml is not available — name your config
 * phi-config.json in that case.
 */

const fs = require('fs');
const path = require('path');

// ── Built-in generic healthcare defaults ────────────────────────────────────
// These are intentionally generic — no product-specific table names.
// Customize via phi-config.yaml for your data model.

const DEFAULT_PERSON_TABLES = ['users', 'patients', 'providers'];

const DEFAULT_ENTITY_TABLES = [
  'facilities',
  'appointmenttypes',
  'procedures',
  'diagnoses',
  'departments',
  'insurancepayors',
];

const DEFAULT_CONTEXTUAL_PHI = ['name'];

const DEFAULT_PHI_COLUMNS = [
  // ── Person names ──────────────────────────────────────────────
  'firstname',
  'lastname',
  'middlename',
  // 'name' is handled contextually via CONTEXTUAL_PHI — see isPHIInContext()
  'normalizedname',
  'alternativename',
  'preferredname',
  'membername',         // insurance subscriber name on card
  'referringprovider',  // referrals: stored as a name string, not an ID

  // ── Contact information ────────────────────────────────────────
  'email',
  'phone',
  'displayphone',
  'sms',
  'voice',
  'contact',
  'from',
  'to',
  'homephone',
  'homeemailaddress',
  'donotcontactmessage',

  // ── Date of birth ──────────────────────────────────────────────
  'dob',
  'dateofbirth',
  'dateofbirthyear',  'dobyear',
  'dateofbirthmonth', 'dobmonth',
  'dateofbirthday',   'dobday',

  // ── Demographics ───────────────────────────────────────────────
  'gender',
  'birthsex',
  'race',
  'ethnicity',
  'ethnicitygroup',
  'maritalstatus',
  'veteran',
  'deceased',

  // ── Address ───────────────────────────────────────────────────
  'address',
  'address2',
  'city',
  'state',
  'postcode',
  'country',
  'previousaddress',

  // ── SSN ──────────────────────────────────────────────────────
  'ssn',

  // ── Free-text fields that may contain patient-identifying content ──
  'notes',
  'staffnotes',
  'text',
  'body',
  'alerts',
  'statusreason',

  // ── Clinical / medical data ────────────────────────────────────
  'medications',
  'immunizationhistory',
  'surgicalhistory',
  'allergies',
  'familyhistory',
  'socialhistory',
  'medicalhistory',
  'problems',

  // ── Insurance subscriber (may contain name + DOB) ──────────────
  'subscriber',

  // ── Auth / credential fields (not PHI but sensitive) ──────────
  'password',
  'passwordhash',
  'resetpasswordtoken',
  'token',
  'authtoken',
  'accesstoken',
  'refreshtoken',
  'twofactorauthsecret',
];

// ── YAML / JSON loader ──────────────────────────────────────────────────────

/**
 * Load the built-in phi-defaults.yaml (or phi-defaults.json fallback) from the
 * same directory as this file. Returns a validated config object or null.
 *
 * Called when no user-supplied config is found, so defaults live in one
 * canonical file rather than hardcoded arrays above.
 *
 * @returns {{ person_tables: string[], entity_tables: string[], phi_columns: string[], contextual_phi: string[] }|null}
 */
function loadDefaults() {
  const yamlPath = path.join(__dirname, 'phi-defaults.yaml');
  const jsonPath = path.join(__dirname, 'phi-defaults.json');
  const raw = parseConfigFile(yamlPath) || parseConfigFile(jsonPath);
  if (!raw || typeof raw !== 'object') return null;
  const toStringArray = (val) =>
    Array.isArray(val) ? val.filter(s => typeof s === 'string') : [];
  return {
    person_tables:  toStringArray(raw.person_tables),
    entity_tables:  toStringArray(raw.entity_tables),
    phi_columns:    toStringArray(raw.phi_columns),
    contextual_phi: toStringArray(raw.contextual_phi),
  };
}

/**
 * Try to load js-yaml. Returns null if not installed.
 * @returns {object|null}
 */
function tryLoadJsYaml() {
  try {
    return require('js-yaml');
  } catch (_) {
    return null;
  }
}

/**
 * Parse a config file. Supports YAML (if js-yaml is installed) and JSON.
 * Returns parsed object or null on failure.
 *
 * @param {string} filePath
 * @returns {object|null}
 */
function parseConfigFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return null;
  }

  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.json') {
    try { return JSON.parse(raw); } catch (_) { return null; }
  }

  // .yaml / .yml — try js-yaml, fall back to JSON attempt
  const jsYaml = tryLoadJsYaml();
  if (jsYaml) {
    try { return jsYaml.load(raw); } catch (_) { return null; }
  }

  // js-yaml not installed — try JSON parse in case user named it .yaml
  try { return JSON.parse(raw); } catch (_) { return null; }
}

/**
 * Search upward from dir for a file named phi-config.yaml or phi-config.json.
 * Returns the first found absolute path, or null.
 *
 * @param {string} dir
 * @returns {string|null}
 */
function findConfigUpward(dir) {
  const candidates = ['phi-config.yaml', 'phi-config.yml', 'phi-config.json'];
  let current = dir;
  while (true) {
    for (const name of candidates) {
      const candidate = path.join(current, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) break; // reached filesystem root
    current = parent;
  }
  return null;
}

/**
 * Load and validate the PHI config. Returns a plain object with arrays for
 * person_tables, entity_tables, phi_columns, contextual_phi — all guaranteed
 * to be string arrays (empty arrays if missing from config).
 *
 * @returns {{ person_tables: string[], entity_tables: string[], phi_columns: string[], contextual_phi: string[] }|null}
 */
function loadConfig() {
  let configPath = null;

  if (process.env.PHI_CONFIG_PATH) {
    configPath = process.env.PHI_CONFIG_PATH;
  } else {
    configPath = findConfigUpward(process.cwd());
  }

  if (!configPath) return null;

  const raw = parseConfigFile(configPath);
  if (!raw || typeof raw !== 'object') return null;

  const toStringArray = (val) =>
    Array.isArray(val) ? val.filter(s => typeof s === 'string') : [];

  return {
    person_tables:  toStringArray(raw.person_tables),
    entity_tables:  toStringArray(raw.entity_tables),
    phi_columns:    toStringArray(raw.phi_columns),
    contextual_phi: toStringArray(raw.contextual_phi),
  };
}

// ── Build exported values ───────────────────────────────────────────────────
// Resolution order:
//   1. User config (PHI_CONFIG_PATH env var or phi-config.yaml searched upward)
//   2. phi-defaults.yaml / phi-defaults.json co-located with this file
//   3. Hardcoded DEFAULT_* arrays above (absolute last resort)

const config = loadConfig() || loadDefaults();

/** @type {string[]} */
const PHI_COLUMNS = config ? config.phi_columns : DEFAULT_PHI_COLUMNS;

/** @type {Set<string>} */
const PERSON_TABLES = new Set(
  config ? config.person_tables : DEFAULT_PERSON_TABLES
);

/** @type {Set<string>} */
const ENTITY_TABLES = new Set(
  config ? config.entity_tables : DEFAULT_ENTITY_TABLES
);

/** @type {Set<string>} */
const CONTEXTUAL_PHI = new Set(
  config ? config.contextual_phi : DEFAULT_CONTEXTUAL_PHI
);

// ── Core functions ──────────────────────────────────────────────────────────

/**
 * Normalize a column name for comparison:
 * lowercase, underscores removed.
 * e.g. "FIRST_NAME" → "firstname", "dateOfBirth" → "dateofbirth"
 *
 * @param {string} name
 * @returns {string}
 */
function normalizeCol(name) {
  return name.toLowerCase().replace(/_/g, '');
}

const PHI_NORMALIZED = new Set(PHI_COLUMNS.map(normalizeCol));

/**
 * Returns true if the given column name is unconditionally PHI.
 *
 * @param {string} columnName
 * @returns {boolean}
 */
function isPHI(columnName) {
  return PHI_NORMALIZED.has(normalizeCol(columnName));
}

/**
 * Returns true if the column should be redacted given the set of table names
 * referenced in the query (lower-cased, qualifier-stripped).
 *
 * Unconditional PHI columns are always blocked.
 * Contextual columns (default: `name`) are blocked only when a person table
 * (default: users, patients, providers) appears in the query.
 *
 * @param {string} columnName
 * @param {Iterable<string>} tableNames
 * @returns {boolean}
 */
function isPHIInContext(columnName, tableNames) {
  if (isPHI(columnName)) return true;
  if (CONTEXTUAL_PHI.has(normalizeCol(columnName))) {
    return [...tableNames].some(t => PERSON_TABLES.has(t.toLowerCase()));
  }
  return false;
}

/**
 * Returns true if the table contains only entity metadata (no patient
 * free-text). Used to skip string-level PII redaction for these tables.
 *
 * @param {string} tableName
 * @returns {boolean}
 */
function isEntityTable(tableName) {
  return ENTITY_TABLES.has(tableName.toLowerCase());
}

module.exports = {
  PHI_COLUMNS,
  PERSON_TABLES,
  ENTITY_TABLES,
  CONTEXTUAL_PHI,
  normalizeCol,
  isPHI,
  isPHIInContext,
  isEntityTable,
};
