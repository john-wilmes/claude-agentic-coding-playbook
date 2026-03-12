#!/usr/bin/env node
// Unit tests for pii-detector.js
// Run: node tests/hooks/pii-detector.test.js

"use strict";

const assert = require("assert");
const fs     = require("fs");
const path   = require("path");
const os     = require("os");
const crypto = require("crypto");

const REPO_ROOT    = path.resolve(__dirname, "..", "..");
const piiDetector  = require(path.join(REPO_ROOT, "templates", "hooks", "pii-detector"));

const { detectPII, redact, loadConfig, DEFAULT_ENTITIES, PATTERNS } = piiDetector;

// ─── Test runner ──────────────────────────────────────────────────────────────

let passed   = 0;
let failed   = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message });
    console.log(`  \u2717 ${name}`);
    console.log(`    ${err.message}`);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir() {
  const dir = path.join(os.tmpdir(), `pii-test-${crypto.randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeConfig(dir, yaml) {
  const claudeDir = path.join(dir, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "sanitize.yaml"), yaml, "utf8");
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ─── Tests ───────────────────────────────────────────────────────────────────

console.log("\npii-detector.js:");

// 1. Detects US SSN
test("1. Detects US SSN (123-45-6789)", () => {
  const text = "Patient SSN is 123-45-6789.";
  const results = detectPII(text);
  const ssns = results.filter(d => d.entity === "US_SSN");
  assert.strictEqual(ssns.length, 1, "Should detect one SSN");
  assert.strictEqual(ssns[0].match, "123-45-6789");
});

// 2. Detects email addresses
test("2. Detects email addresses", () => {
  const text = "Contact alice@hospital.org for details.";
  const results = detectPII(text);
  const emails = results.filter(d => d.entity === "EMAIL");
  assert.strictEqual(emails.length, 1, "Should detect one email");
  assert.strictEqual(emails[0].match, "alice@hospital.org");
});

// 3. Does NOT flag common false-positive emails
test("3. Does not flag user@example.com or config@localhost", () => {
  const text = "See user@example.com or config@localhost for docs.";
  const results = detectPII(text);
  const emails = results.filter(d => d.entity === "EMAIL");
  assert.strictEqual(emails.length, 0, "Should not flag example.com or localhost emails");
});

// 4. Detects US phone numbers — multiple formats
test("4. Detects US phone numbers (multiple formats)", () => {
  const formats = [
    "Call 555-867-5309",
    "Call (555) 867-5309",
    "Call +1 555 867 5309",
    "Call 555.867.5309",
  ];
  for (const text of formats) {
    const results = detectPII(text);
    const phones = results.filter(d => d.entity === "PHONE_US");
    assert.ok(phones.length >= 1, `Should detect phone in: ${text}`);
  }
});

// 5. Detects credit card with valid Luhn
test("5. Detects credit card with valid Luhn (4532015112830366)", () => {
  const text = "Card number: 4532015112830366";
  const results = detectPII(text);
  const cards = results.filter(d => d.entity === "CREDIT_CARD");
  assert.strictEqual(cards.length, 1, "Should detect valid Luhn card");
  assert.ok(cards[0].match.includes("4532015112830366"), "Match should include card number");
});

// 6. Rejects credit card with invalid Luhn (false positive resistance)
test("6. Rejects credit card with invalid Luhn", () => {
  // 4532015112830367 — last digit changed (invalid Luhn)
  const text = "Card number: 4532015112830367";
  const results = detectPII(text);
  const cards = results.filter(d => d.entity === "CREDIT_CARD");
  assert.strictEqual(cards.length, 0, "Should reject invalid Luhn number");
});

// 7. Detects public IP addresses
test("7. Detects public IP addresses", () => {
  const text = "Server at 203.0.113.42 is down.";
  const results = detectPII(text);
  const ips = results.filter(d => d.entity === "IP_ADDRESS");
  assert.strictEqual(ips.length, 1, "Should detect public IP");
  assert.strictEqual(ips[0].match, "203.0.113.42");
});

// 8. Ignores private/loopback IPs
test("8. Ignores private/loopback IPs (127.0.0.1, 192.168.1.1, 10.0.0.1)", () => {
  const text = "IPs: 127.0.0.1 192.168.1.1 10.0.0.1 172.16.0.1 0.0.0.0";
  const results = detectPII(text);
  const ips = results.filter(d => d.entity === "IP_ADDRESS");
  assert.strictEqual(ips.length, 0, "Should ignore all private/loopback IPs");
});

// 9. Detects MRN patterns
test("9. Detects MRN patterns", () => {
  const cases = [
    "MRN: 1234567",
    "MRN #9876543",
    "MRN 456789",
  ];
  for (const text of cases) {
    const results = detectPII(text);
    const mrns = results.filter(d => d.entity === "MRN");
    assert.ok(mrns.length >= 1, `Should detect MRN in: ${text}`);
  }
});

// 10. Detects DOB patterns (labeled only)
test("10. Detects DOB patterns (DOB: 01/15/1985)", () => {
  const cases = [
    "DOB: 01/15/1985",
    "Date of Birth: 3-22-90",
    "BirthDate: 12/01/2000",
  ];
  for (const text of cases) {
    const results = detectPII(text);
    const dobs = results.filter(d => d.entity === "DOB");
    assert.ok(dobs.length >= 1, `Should detect DOB in: ${text}`);
  }
});

// 11. redact() replaces all PII with typed placeholders
test("11. redact() replaces all PII with typed placeholders", () => {
  const text = "SSN: 123-45-6789, email: alice@hospital.org";
  const detections = detectPII(text);
  const redacted = redact(text, detections);
  assert.ok(!redacted.includes("123-45-6789"), "SSN should be redacted");
  assert.ok(!redacted.includes("alice@hospital.org"), "Email should be redacted");
  assert.ok(redacted.includes("[SSN]"), "Should have [SSN] placeholder");
  assert.ok(redacted.includes("[EMAIL]"), "Should have [EMAIL] placeholder");
});

// 12. redact() handles adjacent/overlapping detections
test("12. redact() handles adjacent detections correctly", () => {
  const text = "123-45-6789 and 987-65-4321";
  const detections = detectPII(text);
  const redacted = redact(text, detections);
  assert.ok(!redacted.includes("123-45-6789"), "First SSN should be redacted");
  assert.ok(!redacted.includes("987-65-4321"), "Second SSN should be redacted");
  const matches = redacted.match(/\[SSN\]/g) || [];
  assert.strictEqual(matches.length, 2, "Should have two [SSN] placeholders");
});

// 13. redact() with empty detections returns original text
test("13. redact() with empty detections returns original text", () => {
  const text = "No PII here, just normal text.";
  const result = redact(text, []);
  assert.strictEqual(result, text, "Should return original text unchanged");
});

// 14. detectPII with subset of entities only finds those types
test("14. detectPII with subset of entities only scans those types", () => {
  const text = "SSN: 123-45-6789, email: alice@hospital.org, phone: 555-867-5309";
  const results = detectPII(text, ["US_SSN"]);
  assert.ok(results.some(d => d.entity === "US_SSN"), "Should find SSN");
  assert.ok(!results.some(d => d.entity === "EMAIL"), "Should NOT find email");
  assert.ok(!results.some(d => d.entity === "PHONE_US"), "Should NOT find phone");
});

// 15. detectPII with empty text returns empty array
test("15. detectPII with empty text returns empty array", () => {
  assert.deepStrictEqual(detectPII(""), [], "Empty string → empty array");
  assert.deepStrictEqual(detectPII(null), [], "null → empty array");
  assert.deepStrictEqual(detectPII(undefined), [], "undefined → empty array");
});

// 16. loadConfig returns null when no config exists
test("16. loadConfig returns null when no config exists", () => {
  const dir = makeTempDir();
  try {
    const result = loadConfig(dir);
    assert.strictEqual(result, null, "Should return null when no sanitize.yaml");
  } finally {
    cleanup(dir);
  }
});

// 17. loadConfig parses valid config from .claude/sanitize.yaml
test("17. loadConfig parses valid sanitize.yaml", () => {
  const dir = makeTempDir();
  try {
    writeConfig(dir, [
      "sanitization:",
      "  enabled: true",
      "  entities:",
      "    - US_SSN",
      "    - EMAIL",
      "  exclude_paths:",
      "    - \"tests/fixtures/**\"",
      "  custom_patterns:",
      "    - name: PATIENT_ID",
      "      regex: \"PT-\\\\d{6}\"",
      "      placeholder: \"[PATIENT_ID]\"",
    ].join("\n"));

    const config = loadConfig(dir);
    assert.ok(config !== null, "Should return config object");
    assert.strictEqual(config.enabled, true);
    assert.deepStrictEqual(config.entities, ["US_SSN", "EMAIL"]);
    assert.deepStrictEqual(config.exclude_paths, ["tests/fixtures/**"]);
    assert.strictEqual(config.custom_patterns.length, 1);
    assert.strictEqual(config.custom_patterns[0].name, "PATIENT_ID");
  } finally {
    cleanup(dir);
  }
});

// 18. loadConfig walks up directories to find config
test("18. loadConfig walks up directories to find config", () => {
  const rootDir = makeTempDir();
  const subDir  = path.join(rootDir, "src", "components");
  fs.mkdirSync(subDir, { recursive: true });
  try {
    writeConfig(rootDir, [
      "sanitization:",
      "  enabled: true",
      "  entities:",
      "    - US_SSN",
    ].join("\n"));

    // Start from the deep subdirectory — should walk up and find config at root
    const config = loadConfig(subDir);
    assert.ok(config !== null, "Should find config by walking up");
    assert.deepStrictEqual(config.entities, ["US_SSN"]);
  } finally {
    cleanup(rootDir);
  }
});

// 19. loadConfig returns null on malformed yaml (does not crash)
test("19. loadConfig returns null on malformed YAML (does not crash)", () => {
  const dir = makeTempDir();
  try {
    const claudeDir = path.join(dir, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    // Write something that parses but has no sanitization key
    fs.writeFileSync(path.join(claudeDir, "sanitize.yaml"), "!!invalid: [yaml: {", "utf8");
    const result = loadConfig(dir);
    // Should return null since there's no sanitization key
    assert.strictEqual(result, null, "Should return null on malformed YAML");
  } finally {
    cleanup(dir);
  }
});

// 20. loadConfig respects enabled: false
test("20. loadConfig respects enabled: false", () => {
  const dir = makeTempDir();
  try {
    writeConfig(dir, [
      "sanitization:",
      "  enabled: false",
      "  entities:",
      "    - US_SSN",
    ].join("\n"));

    const config = loadConfig(dir);
    assert.ok(config !== null, "Should still return config object");
    assert.strictEqual(config.enabled, false, "enabled should be false");
  } finally {
    cleanup(dir);
  }
});

// 21. Custom patterns from config are detected
test("21. Custom patterns from config are detected", () => {
  const customPatterns = [{ name: "PATIENT_ID", regex: "PT-\\d{6}", placeholder: "[PATIENT_ID]" }];
  const text = "Patient ID: PT-123456";
  const results = detectPII(text, null, customPatterns);
  const custom = results.filter(d => d.entity === "PATIENT_ID");
  assert.strictEqual(custom.length, 1, "Should detect custom PATIENT_ID pattern");
  assert.strictEqual(custom[0].match, "PT-123456");
});

// 22. DEFAULT_ENTITIES contains all built-in types
test("22. DEFAULT_ENTITIES contains all built-in types", () => {
  const expected = ["US_SSN", "EMAIL", "PHONE_US", "CREDIT_CARD", "IP_ADDRESS", "MRN", "DOB"];
  for (const e of expected) {
    assert.ok(DEFAULT_ENTITIES.includes(e), `DEFAULT_ENTITIES should include ${e}`);
  }
  assert.strictEqual(DEFAULT_ENTITIES.length, expected.length, "Should have exactly the expected entities");
});

// 23. Multiple PII types in same text all detected
test("23. Multiple PII types in same text all detected", () => {
  const text = [
    "SSN: 123-45-6789",
    "Email: bob@clinic.com",
    "Phone: 555-234-5678",
    "IP: 203.0.113.42",
    "MRN: 8901234",
  ].join(", ");

  const results = detectPII(text);
  const entities = new Set(results.map(d => d.entity));
  assert.ok(entities.has("US_SSN"),    "Should detect SSN");
  assert.ok(entities.has("EMAIL"),     "Should detect EMAIL");
  assert.ok(entities.has("PHONE_US"),  "Should detect PHONE");
  assert.ok(entities.has("IP_ADDRESS"),"Should detect IP");
  assert.ok(entities.has("MRN"),       "Should detect MRN");
});

// 24. redact() with custom pattern uses entity name as placeholder
test("24. redact() with custom pattern uses [ENTITY_NAME] placeholder", () => {
  const customPatterns = [{ name: "PATIENT_ID", regex: "PT-\\d{6}", placeholder: "[PATIENT_ID]" }];
  const text = "Patient ID: PT-123456";
  const detections = detectPII(text, null, customPatterns);
  const redacted = redact(text, detections);
  assert.ok(!redacted.includes("PT-123456"), "Custom PII should be redacted");
  assert.ok(redacted.includes("[PATIENT_ID]"), "Should use [PATIENT_ID] placeholder");
});

// 25. detections are sorted by index
test("25. detectPII returns detections sorted by index", () => {
  const text = "SSN: 123-45-6789 then email alice@clinic.com";
  const results = detectPII(text);
  for (let i = 1; i < results.length; i++) {
    assert.ok(results[i].index >= results[i - 1].index,
      `Detection at position ${i} should have index >= previous`);
  }
});

// 26. PATTERNS map has regex and placeholder for each entity
test("26. PATTERNS map has regex and placeholder for each DEFAULT_ENTITY", () => {
  for (const entity of DEFAULT_ENTITIES) {
    assert.ok(PATTERNS[entity], `PATTERNS should have entry for ${entity}`);
    assert.ok(PATTERNS[entity].regex instanceof RegExp, `${entity} regex should be a RegExp`);
    assert.ok(typeof PATTERNS[entity].placeholder === "string", `${entity} placeholder should be a string`);
    assert.ok(PATTERNS[entity].placeholder.startsWith("["), `${entity} placeholder should start with [`);
  }
});

// 27. loadConfig with missing sanitization key returns null
test("27. loadConfig with missing sanitization key returns null", () => {
  const dir = makeTempDir();
  try {
    writeConfig(dir, "other_section:\n  enabled: true\n");
    const result = loadConfig(dir);
    assert.strictEqual(result, null, "Should return null when sanitization key is missing");
  } finally {
    cleanup(dir);
  }
});

// 28. detectPII with invalid custom pattern regex does not crash
test("28. detectPII with invalid custom pattern regex does not crash", () => {
  const customPatterns = [{ name: "BAD", regex: "[invalid(", placeholder: "[BAD]" }];
  const text = "Some text here.";
  let result;
  assert.doesNotThrow(() => {
    result = detectPII(text, null, customPatterns);
  }, "Should not throw on invalid regex");
  assert.ok(Array.isArray(result), "Should return an array");
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  console.log("Failures:");
  for (const f of failures) console.log(`  ${f.name}: ${f.error}`);
  process.exit(1);
}
