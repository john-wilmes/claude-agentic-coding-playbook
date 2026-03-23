#!/usr/bin/env node
/**
 * transcript-parser.test.js — Unit tests for scripts/transcript-parser.js
 */

"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const {
  encodeCwd,
  getProjectDir,
  findSessionFile,
  findMostRecentSession,
  parseSessionFile,
  buildToolResultMap,
  extractToolUses,
  formatEntryToMarkdown,
  summarizeToolInput,
  truncate,
} = require("../../scripts/transcript-parser");

// ---------------------------------------------------------------------------
// Simple test runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(e && e.stack ? e.stack : `    ${String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create an isolated temp dir for project-dir tests.
 * Returns { tmpDir, projectDir, cleanup }.
 * projectDir is the encoded path: tmpDir/.claude/projects/<encoded-cwd>/
 */
function createTempProjectDir(cwd) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tp-test-"));
  // We need getProjectDir to resolve into our temp dir.
  // Since getProjectDir uses os.homedir(), we test it indirectly by building
  // the expected path ourselves for file-system tests.
  const encoded = encodeCwd(cwd);
  const projectDir = path.join(tmpDir, ".claude", "projects", encoded);
  fs.mkdirSync(projectDir, { recursive: true });
  return {
    tmpDir,
    projectDir,
    cleanup() {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    },
  };
}

/**
 * Write a JSONL session file into projectDir.
 * Returns the full file path.
 */
function writeSessionFile(projectDir, sessionId, lines = []) {
  const filePath = path.join(projectDir, sessionId + ".jsonl");
  const content = lines.map(l => JSON.stringify(l)).join("\n") + "\n";
  fs.writeFileSync(filePath, content);
  return filePath;
}

// ---------------------------------------------------------------------------
// encodeCwd
// ---------------------------------------------------------------------------

console.log("\nencodeCwd:");

test("Unix absolute path: replaces slashes with dashes, leading dash preserved", () => {
  assert.strictEqual(encodeCwd("/home/user/project"), "-home-user-project");
});

test("Root path: single slash becomes a single dash (leading dash preserved)", () => {
  assert.strictEqual(encodeCwd("/"), "-");
});

test("Path with no leading slash (relative): no stripping needed", () => {
  assert.strictEqual(encodeCwd("home/user/project"), "home-user-project");
});

test("Windows-style path with drive letter colon: colon becomes dash", () => {
  assert.strictEqual(encodeCwd("C:\\Users\\user\\project"), "C--Users-user-project");
});

test("Windows-style forward-slash path: C:/Users/user -> C--Users-user", () => {
  assert.strictEqual(encodeCwd("C:/Users/user"), "C--Users-user");
});

test("Path with multiple consecutive slashes: each slash becomes a dash", () => {
  assert.strictEqual(encodeCwd("/home//user///project"), "-home--user---project");
});

test("Path already dash-encoded: unchanged", () => {
  assert.strictEqual(encodeCwd("home-user-project"), "home-user-project");
});

test("Empty string: returns empty string", () => {
  assert.strictEqual(encodeCwd(""), "");
});

test("Path with mixed colon and slash (Windows UNC-like): both replaced, leading dashes preserved", () => {
  // //server/share -> --server-share (two slashes -> two dashes, both preserved)
  assert.strictEqual(encodeCwd("//server/share"), "--server-share");
});

test("Deep path: all slashes converted", () => {
  assert.strictEqual(encodeCwd("/a/b/c/d/e"), "-a-b-c-d-e");
});

// ---------------------------------------------------------------------------
// getProjectDir
// ---------------------------------------------------------------------------

console.log("\ngetProjectDir:");

test("Returns ~/.claude/projects/<encoded-cwd>", () => {
  const home = os.homedir();
  const result = getProjectDir("/home/user/myproject");
  const expected = path.join(home, ".claude", "projects", "-home-user-myproject");
  assert.strictEqual(result, expected);
});

test("Encodes cwd before joining", () => {
  const home = os.homedir();
  const result = getProjectDir("/foo/bar");
  assert.strictEqual(result, path.join(home, ".claude", "projects", "-foo-bar"));
});

test("Uses os.homedir() as base", () => {
  const result = getProjectDir("/any/path");
  assert.ok(result.startsWith(os.homedir()), "Should start with home dir");
});

test("Contains .claude/projects in path", () => {
  const result = getProjectDir("/any/path");
  assert.ok(result.includes(path.join(".claude", "projects")), "Should include .claude/projects");
});

// ---------------------------------------------------------------------------
// findSessionFile
// ---------------------------------------------------------------------------

console.log("\nfindSessionFile:");

test("Returns null when project dir does not exist", () => {
  // Use a nonexistent cwd so the encoded dir won't exist under real homedir
  const result = findSessionFile("abc123", "/nonexistent-cwd-" + Date.now());
  assert.strictEqual(result, null);
});

test("Exact match: returns full path to matching .jsonl file", () => {
  // Use isolated temp HOME so we don't write to the real ~/.claude/projects/
  const origHome = process.env.HOME;
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "tp-home-"));
  process.env.HOME = tmpHome;
  const fakeCwd = "/tp-test-exact";
  const encoded = encodeCwd(fakeCwd);
  const dir = path.join(tmpHome, ".claude", "projects", encoded);
  fs.mkdirSync(dir, { recursive: true });
  const sessionId = "sess-exact-abc123";
  const filePath = path.join(dir, sessionId + ".jsonl");
  fs.writeFileSync(filePath, '{"type":"user"}\n');
  try {
    const result = findSessionFile(sessionId, fakeCwd);
    assert.strictEqual(result, filePath);
  } finally {
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("Prefix match (single): returns file when prefix uniquely matches", () => {
  const origHome = process.env.HOME;
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "tp-home-"));
  process.env.HOME = tmpHome;
  const fakeCwd = "/tp-test-prefix";
  const encoded = encodeCwd(fakeCwd);
  const dir = path.join(tmpHome, ".claude", "projects", encoded);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "session-abc123def.jsonl"), "");
  fs.writeFileSync(path.join(dir, "session-xyz999.jsonl"), "");
  try {
    const result = findSessionFile("session-abc", fakeCwd);
    assert.ok(result !== null, "Should find a match");
    assert.ok(result.endsWith("session-abc123def.jsonl"), `Got: ${result}`);
  } finally {
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("Prefix match (multiple): returns most recently modified file", () => {
  const origHome = process.env.HOME;
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "tp-home-"));
  process.env.HOME = tmpHome;
  const fakeCwd = "/tp-test-multi";
  const encoded = encodeCwd(fakeCwd);
  const dir = path.join(tmpHome, ".claude", "projects", encoded);
  fs.mkdirSync(dir, { recursive: true });
  const older = path.join(dir, "sess-aaa111.jsonl");
  const newer = path.join(dir, "sess-aaa222.jsonl");
  fs.writeFileSync(older, "");
  const oldTime = new Date(Date.now() - 2000);
  fs.utimesSync(older, oldTime, oldTime);
  fs.writeFileSync(newer, "");
  try {
    const result = findSessionFile("sess-aaa", fakeCwd);
    assert.ok(result !== null, "Should find a match");
    assert.ok(result.endsWith("sess-aaa222.jsonl"), `Expected newer file, got: ${result}`);
  } finally {
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("No match: returns null", () => {
  const origHome = process.env.HOME;
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "tp-home-"));
  process.env.HOME = tmpHome;
  const fakeCwd = "/tp-test-nomatch";
  const encoded = encodeCwd(fakeCwd);
  const dir = path.join(tmpHome, ".claude", "projects", encoded);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "session-xyz.jsonl"), "");
  try {
    const result = findSessionFile("session-abc", fakeCwd);
    assert.strictEqual(result, null);
  } finally {
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("Ignores non-.jsonl files", () => {
  const origHome = process.env.HOME;
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "tp-home-"));
  process.env.HOME = tmpHome;
  const fakeCwd = "/tp-test-nonjsonl";
  const encoded = encodeCwd(fakeCwd);
  const dir = path.join(tmpHome, ".claude", "projects", encoded);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "session-abc.txt"), "");
  fs.writeFileSync(path.join(dir, "session-abc.json"), "");
  try {
    const result = findSessionFile("session-abc", fakeCwd);
    assert.strictEqual(result, null);
  } finally {
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// findMostRecentSession
// ---------------------------------------------------------------------------

console.log("\nfindMostRecentSession:");

test("Returns null when project dir does not exist", () => {
  const result = findMostRecentSession("/nonexistent-cwd-" + Date.now());
  assert.strictEqual(result, null);
});

test("Returns null for empty dir (no .jsonl files)", () => {
  const origHome = process.env.HOME;
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "tp-home-"));
  process.env.HOME = tmpHome;
  try {
    const fakeCwd = "/tp-test-empty-" + Date.now();
    const encoded = encodeCwd(fakeCwd);
    const dir = path.join(tmpHome, ".claude", "projects", encoded);
    fs.mkdirSync(dir, { recursive: true });
    const result = findMostRecentSession(fakeCwd);
    assert.strictEqual(result, null);
  } finally {
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("Returns the most recently modified .jsonl file", () => {
  const origHome = process.env.HOME;
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "tp-home-"));
  process.env.HOME = tmpHome;
  try {
    const fakeCwd = "/tp-test-recent-" + Date.now();
    const encoded = encodeCwd(fakeCwd);
    const dir = path.join(tmpHome, ".claude", "projects", encoded);
    fs.mkdirSync(dir, { recursive: true });
    const older = path.join(dir, "session-old.jsonl");
    const newer = path.join(dir, "session-new.jsonl");
    fs.writeFileSync(older, "");
    fs.writeFileSync(newer, "");
    const oldTime = new Date(Date.now() - 5000);
    fs.utimesSync(older, oldTime, oldTime);
    const result = findMostRecentSession(fakeCwd);
    assert.strictEqual(result, newer);
  } finally {
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("Returns single file when only one .jsonl exists", () => {
  const origHome = process.env.HOME;
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "tp-home-"));
  process.env.HOME = tmpHome;
  try {
    const fakeCwd = "/tp-test-single-" + Date.now();
    const encoded = encodeCwd(fakeCwd);
    const dir = path.join(tmpHome, ".claude", "projects", encoded);
    fs.mkdirSync(dir, { recursive: true });
    const only = path.join(dir, "session-only.jsonl");
    fs.writeFileSync(only, "");
    const result = findMostRecentSession(fakeCwd);
    assert.strictEqual(result, only);
  } finally {
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("Ignores non-.jsonl files when finding most recent", () => {
  const origHome = process.env.HOME;
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "tp-home-"));
  process.env.HOME = tmpHome;
  try {
    const fakeCwd = "/tp-test-recnonjsonl-" + Date.now();
    const encoded = encodeCwd(fakeCwd);
    const dir = path.join(tmpHome, ".claude", "projects", encoded);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "readme.txt"), "");
    const jsonl = path.join(dir, "session-a.jsonl");
    fs.writeFileSync(jsonl, "");
    const result = findMostRecentSession(fakeCwd);
    assert.strictEqual(result, jsonl);
  } finally {
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// parseSessionFile
// ---------------------------------------------------------------------------

console.log("\nparseSessionFile:");

test("Parses valid JSONL into array of objects", () => {
  const tmpFile = path.join(os.tmpdir(), "tp-parse-" + Date.now() + ".jsonl");
  fs.writeFileSync(tmpFile, '{"type":"user"}\n{"type":"assistant"}\n');
  try {
    const entries = parseSessionFile(tmpFile);
    assert.strictEqual(entries.length, 2);
    assert.strictEqual(entries[0].type, "user");
    assert.strictEqual(entries[1].type, "assistant");
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test("Skips malformed lines silently", () => {
  const tmpFile = path.join(os.tmpdir(), "tp-parse-malformed-" + Date.now() + ".jsonl");
  fs.writeFileSync(tmpFile, '{"type":"user"}\nnot valid json\n{"type":"assistant"}\n');
  try {
    const entries = parseSessionFile(tmpFile);
    assert.strictEqual(entries.length, 2);
    assert.strictEqual(entries[0].type, "user");
    assert.strictEqual(entries[1].type, "assistant");
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test("Returns empty array for empty file", () => {
  const tmpFile = path.join(os.tmpdir(), "tp-parse-empty-" + Date.now() + ".jsonl");
  fs.writeFileSync(tmpFile, "");
  try {
    const entries = parseSessionFile(tmpFile);
    assert.deepStrictEqual(entries, []);
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test("Returns empty array for nonexistent file", () => {
  const entries = parseSessionFile("/nonexistent/path/session.jsonl");
  assert.deepStrictEqual(entries, []);
});

test("Skips blank lines", () => {
  const tmpFile = path.join(os.tmpdir(), "tp-parse-blank-" + Date.now() + ".jsonl");
  fs.writeFileSync(tmpFile, '\n\n{"type":"user"}\n\n\n{"type":"assistant"}\n\n');
  try {
    const entries = parseSessionFile(tmpFile);
    assert.strictEqual(entries.length, 2);
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test("Handles file where all lines are malformed: returns empty array", () => {
  const tmpFile = path.join(os.tmpdir(), "tp-parse-allbad-" + Date.now() + ".jsonl");
  fs.writeFileSync(tmpFile, "bad\n{also bad\nnot json\n");
  try {
    const entries = parseSessionFile(tmpFile);
    assert.deepStrictEqual(entries, []);
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

// ---------------------------------------------------------------------------
// buildToolResultMap
// ---------------------------------------------------------------------------

console.log("\nbuildToolResultMap:");

test("Extracts tool_result blocks from user entries into a Map", () => {
  const entries = [
    {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "id-001", content: "output text", is_error: false },
        ],
      },
    },
  ];
  const map = buildToolResultMap(entries);
  assert.ok(map.has("id-001"), "Should have id-001");
  assert.strictEqual(map.get("id-001").content, "output text");
  assert.strictEqual(map.get("id-001").is_error, false);
});

test("Sets is_error: true when block has is_error: true", () => {
  const entries = [
    {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "id-002", content: "error msg", is_error: true },
        ],
      },
    },
  ];
  const map = buildToolResultMap(entries);
  assert.strictEqual(map.get("id-002").is_error, true);
});

test("Ignores non-user entries", () => {
  const entries = [
    {
      type: "assistant",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "id-003", content: "should be ignored" },
        ],
      },
    },
  ];
  const map = buildToolResultMap(entries);
  assert.strictEqual(map.size, 0);
});

test("Ignores non-tool_result blocks within user entries", () => {
  const entries = [
    {
      type: "user",
      message: {
        content: [
          { type: "text", text: "hello" },
          { type: "tool_result", tool_use_id: "id-004", content: "ok" },
        ],
      },
    },
  ];
  const map = buildToolResultMap(entries);
  assert.strictEqual(map.size, 1);
  assert.ok(map.has("id-004"));
});

test("Handles non-string block content: JSON-stringifies it", () => {
  const entries = [
    {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "id-005", content: [{ text: "nested" }] },
        ],
      },
    },
  ];
  const map = buildToolResultMap(entries);
  assert.strictEqual(map.get("id-005").content, JSON.stringify([{ text: "nested" }]));
});

test("Returns empty map for empty entries array", () => {
  const map = buildToolResultMap([]);
  assert.strictEqual(map.size, 0);
});

test("Skips blocks without tool_use_id", () => {
  const entries = [
    {
      type: "user",
      message: {
        content: [
          { type: "tool_result", content: "no id here" },
        ],
      },
    },
  ];
  const map = buildToolResultMap(entries);
  assert.strictEqual(map.size, 0);
});

test("Handles user entry with string content (not array): no results", () => {
  const entries = [
    { type: "user", message: { content: "plain string" } },
  ];
  const map = buildToolResultMap(entries);
  assert.strictEqual(map.size, 0);
});

// ---------------------------------------------------------------------------
// extractToolUses
// ---------------------------------------------------------------------------

console.log("\nextractToolUses:");

const sampleAssistantEntry = (tools) => ({
  type: "assistant",
  message: {
    content: [
      { type: "text", text: "Here is what I will do." },
      ...tools,
    ],
  },
});

test("Extracts tool_use blocks from assistant entries", () => {
  const entries = [
    sampleAssistantEntry([
      { type: "tool_use", id: "tu-1", name: "Read", input: { file_path: "/foo.txt" } },
    ]),
  ];
  const results = extractToolUses(entries);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].toolUse.name, "Read");
  assert.strictEqual(results[0].toolUse.id, "tu-1");
});

test("Ignores non-assistant entries", () => {
  const entries = [
    { type: "user", message: { content: [{ type: "tool_use", id: "tu-2", name: "Write", input: {} }] } },
  ];
  const results = extractToolUses(entries);
  assert.strictEqual(results.length, 0);
});

test("Filters by toolNames when provided", () => {
  const entries = [
    sampleAssistantEntry([
      { type: "tool_use", id: "tu-3", name: "Write", input: {} },
      { type: "tool_use", id: "tu-4", name: "Read", input: {} },
      { type: "tool_use", id: "tu-5", name: "Bash", input: {} },
    ]),
  ];
  const results = extractToolUses(entries, ["Write", "Bash"]);
  assert.strictEqual(results.length, 2);
  const names = results.map(r => r.toolUse.name);
  assert.ok(names.includes("Write"), "Should include Write");
  assert.ok(names.includes("Bash"), "Should include Bash");
  assert.ok(!names.includes("Read"), "Should not include Read");
});

test("Returns all tool_uses when toolNames is not provided", () => {
  const entries = [
    sampleAssistantEntry([
      { type: "tool_use", id: "tu-6", name: "Write", input: {} },
      { type: "tool_use", id: "tu-7", name: "Read", input: {} },
    ]),
  ];
  const results = extractToolUses(entries);
  assert.strictEqual(results.length, 2);
});

test("Ignores non-tool_use blocks in assistant entries", () => {
  const entries = [
    sampleAssistantEntry([
      { type: "text", text: "just text" },
      { type: "thinking", thinking: "internal thought" },
    ]),
  ];
  const results = extractToolUses(entries);
  assert.strictEqual(results.length, 0);
});

test("Returns empty array when entries is empty", () => {
  const results = extractToolUses([]);
  assert.strictEqual(results.length, 0);
});

test("Each result contains both entry and toolUse references", () => {
  const entry = sampleAssistantEntry([
    { type: "tool_use", id: "tu-8", name: "Glob", input: { pattern: "*.js" } },
  ]);
  const results = extractToolUses([entry]);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].entry, entry);
  assert.strictEqual(results[0].toolUse.name, "Glob");
});

// ---------------------------------------------------------------------------
// formatEntryToMarkdown
// ---------------------------------------------------------------------------

console.log("\nformatEntryToMarkdown:");

test("User entry with string content: produces ## User header and text", () => {
  const entry = { type: "user", message: { content: "Hello there" } };
  const result = formatEntryToMarkdown(entry);
  assert.ok(result.includes("## User"), "Should have User header");
  assert.ok(result.includes("Hello there"), "Should include message text");
});

test("User entry with text block: extracts text content", () => {
  const entry = {
    type: "user",
    message: { content: [{ type: "text", text: "What is this?" }] },
  };
  const result = formatEntryToMarkdown(entry);
  assert.ok(result.includes("## User"), "Should have User header");
  assert.ok(result.includes("What is this?"), "Should include text block content");
});

test("User entry with tool_result block: renders details summary", () => {
  const entry = {
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: "tu-1", content: "file content here", is_error: false },
      ],
    },
  };
  const result = formatEntryToMarkdown(entry);
  assert.ok(result.includes("<details>"), "Should have details element");
  assert.ok(result.includes("Result: success"), "Should show success status");
  assert.ok(result.includes("file content here"), "Should include content");
});

test("User entry with error tool_result: shows error status", () => {
  const entry = {
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: "tu-2", content: "error output", is_error: true },
      ],
    },
  };
  const result = formatEntryToMarkdown(entry);
  assert.ok(result.includes("Result: error"), "Should show error status");
});

test("User tool_result content truncated when over maxResultLength", () => {
  const longContent = "x".repeat(600);
  const entry = {
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: "tu-3", content: longContent, is_error: false },
      ],
    },
  };
  const result = formatEntryToMarkdown(entry, { maxResultLength: 100 });
  assert.ok(result.includes("(truncated)"), "Should truncate long content");
  assert.ok(!result.includes(longContent), "Should not include full content");
});

test("User tool_result hidden when includeToolResults: false", () => {
  const entry = {
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: "tu-4", content: "hidden output" },
      ],
    },
  };
  const result = formatEntryToMarkdown(entry, { includeToolResults: false });
  assert.strictEqual(result, null, "Should return null when no visible content");
});

test("Assistant entry with string content: produces ## Assistant header", () => {
  const entry = { type: "assistant", message: { content: "I will help you." } };
  const result = formatEntryToMarkdown(entry);
  assert.ok(result.includes("## Assistant"), "Should have Assistant header");
  assert.ok(result.includes("I will help you."), "Should include message text");
});

test("Assistant entry with text block: includes text", () => {
  const entry = {
    type: "assistant",
    message: {
      content: [{ type: "text", text: "Here is my answer." }],
    },
  };
  const result = formatEntryToMarkdown(entry);
  assert.ok(result.includes("Here is my answer."), "Should include text");
});

test("Assistant entry with tool_use: shows Tool header and summary", () => {
  const entry = {
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", id: "tu-10", name: "Read", input: { file_path: "/foo.txt" } },
      ],
    },
  };
  const result = formatEntryToMarkdown(entry);
  assert.ok(result.includes("**Tool: Read**"), "Should show tool name");
  assert.ok(result.includes("/foo.txt"), "Should include file path summary");
});

test("Assistant tool_use: includes result from toolResultMap when available", () => {
  const entry = {
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", id: "tu-20", name: "Bash", input: { command: "ls" } },
      ],
    },
  };
  const toolResultMap = new Map([
    ["tu-20", { content: "file1.txt\nfile2.txt", is_error: false }],
  ]);
  const result = formatEntryToMarkdown(entry, { toolResultMap });
  assert.ok(result.includes("file1.txt"), "Should include tool result content");
  assert.ok(result.includes("Result: success"), "Should show result status");
});

test("Assistant tool_use: result from toolResultMap truncated at maxResultLength", () => {
  const entry = {
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", id: "tu-21", name: "Bash", input: { command: "cat big-file" } },
      ],
    },
  };
  const toolResultMap = new Map([
    ["tu-21", { content: "y".repeat(600), is_error: false }],
  ]);
  const result = formatEntryToMarkdown(entry, { toolResultMap, maxResultLength: 100 });
  assert.ok(result.includes("(truncated)"), "Should truncate long result");
});

test("Thinking block included when includeThinking: true", () => {
  const entry = {
    type: "assistant",
    message: {
      content: [
        { type: "thinking", thinking: "my internal reasoning" },
        { type: "text", text: "Final answer." },
      ],
    },
  };
  const result = formatEntryToMarkdown(entry, { includeThinking: true });
  assert.ok(result.includes("my internal reasoning"), "Should include thinking");
  assert.ok(result.includes("**Thinking:**"), "Should label thinking block");
});

test("Thinking block excluded when includeThinking: false (default)", () => {
  const entry = {
    type: "assistant",
    message: {
      content: [
        { type: "thinking", thinking: "my internal reasoning" },
        { type: "text", text: "Final answer." },
      ],
    },
  };
  const result = formatEntryToMarkdown(entry);
  assert.ok(!result.includes("my internal reasoning"), "Should exclude thinking");
  assert.ok(result.includes("Final answer."), "Should still include text");
});

test("Sidechain entry skipped when includeSidechain: false", () => {
  const entry = {
    type: "assistant",
    isSidechain: true,
    message: { content: "sidechain message" },
  };
  const result = formatEntryToMarkdown(entry, { includeSidechain: false });
  assert.strictEqual(result, null);
});

test("Sidechain entry included when includeSidechain: true (default)", () => {
  const entry = {
    type: "assistant",
    isSidechain: true,
    message: { content: "sidechain message" },
  };
  const result = formatEntryToMarkdown(entry, { includeSidechain: true });
  assert.ok(result !== null, "Should return non-null");
  assert.ok(result.includes("[sidechain]"), "Should label sidechain");
});

test("Timestamp included in header when entry has timestamp", () => {
  const entry = {
    type: "user",
    timestamp: "2024-01-15T10:30:00Z",
    message: { content: "hello" },
  };
  const result = formatEntryToMarkdown(entry);
  assert.ok(result.includes("2024-01-15T10:30:00Z"), "Should include timestamp");
});

test("progress entry returns null", () => {
  const entry = { type: "progress", message: { content: "doing stuff" } };
  assert.strictEqual(formatEntryToMarkdown(entry), null);
});

test("file-history-snapshot entry returns null", () => {
  const entry = { type: "file-history-snapshot", message: { content: "snapshot" } };
  assert.strictEqual(formatEntryToMarkdown(entry), null);
});

test("queue-operation entry returns null", () => {
  const entry = { type: "queue-operation", message: { content: "queued" } };
  assert.strictEqual(formatEntryToMarkdown(entry), null);
});

test("Entry with no message returns null", () => {
  const entry = { type: "user" };
  assert.strictEqual(formatEntryToMarkdown(entry), null);
});

test("Assistant entry with only empty content array returns null", () => {
  const entry = { type: "assistant", message: { content: [] } };
  assert.strictEqual(formatEntryToMarkdown(entry), null);
});

// ---------------------------------------------------------------------------
// summarizeToolInput
// ---------------------------------------------------------------------------

console.log("\nsummarizeToolInput:");

test("Write: shows file path and content length", () => {
  const result = summarizeToolInput("Write", { file_path: "/src/index.js", content: "hello world" });
  assert.ok(result.includes("/src/index.js"), "Should include file path");
  assert.ok(result.includes("11 chars"), "Should include content length");
});

test("Write: missing file_path shows ?", () => {
  const result = summarizeToolInput("Write", { content: "stuff" });
  assert.ok(result.includes("`?`"), "Should show ? for missing path");
});

test("Edit: shows file path, old string, new string", () => {
  const result = summarizeToolInput("Edit", {
    file_path: "/src/utils.js",
    old_string: "foo",
    new_string: "bar",
  });
  assert.ok(result.includes("/src/utils.js"), "Should include file path");
  assert.ok(result.includes("foo"), "Should include old string");
  assert.ok(result.includes("bar"), "Should include new string");
});

test("Edit: old/new strings truncated at 60 chars", () => {
  const long = "a".repeat(80);
  const result = summarizeToolInput("Edit", {
    file_path: "/f.js",
    old_string: long,
    new_string: long,
  });
  assert.ok(result.includes("..."), "Should truncate long strings");
  assert.ok(!result.includes(long), "Should not include full long string");
});

test("Read: shows file path", () => {
  const result = summarizeToolInput("Read", { file_path: "/config/settings.json" });
  assert.ok(result.includes("/config/settings.json"), "Should include file path");
});

test("Read: missing file_path shows ?", () => {
  const result = summarizeToolInput("Read", {});
  assert.ok(result.includes("`?`"), "Should show ? for missing path");
});

test("Bash: shows command in code block", () => {
  const result = summarizeToolInput("Bash", { command: "npm test" });
  assert.ok(result.includes("```bash"), "Should use bash code block");
  assert.ok(result.includes("npm test"), "Should include command");
});

test("Bash: command truncated at 200 chars", () => {
  const long = "echo " + "x".repeat(250);
  const result = summarizeToolInput("Bash", { command: long });
  assert.ok(result.includes("..."), "Should truncate long command");
});

test("Glob: shows pattern and optional path", () => {
  const result = summarizeToolInput("Glob", { pattern: "**/*.js", path: "/src" });
  assert.ok(result.includes("**/*.js"), "Should include pattern");
  assert.ok(result.includes("/src"), "Should include path");
});

test("Glob: omits path line when path not provided", () => {
  const result = summarizeToolInput("Glob", { pattern: "*.ts" });
  assert.ok(result.includes("*.ts"), "Should include pattern");
  assert.ok(!result.includes("Path:"), "Should not include Path line");
});

test("Grep: shows pattern and optional path", () => {
  const result = summarizeToolInput("Grep", { pattern: "TODO", path: "/src" });
  assert.ok(result.includes("TODO"), "Should include pattern");
  assert.ok(result.includes("/src"), "Should include path");
});

test("Grep: missing pattern shows ?", () => {
  const result = summarizeToolInput("Grep", {});
  assert.ok(result.includes("`?`"), "Should show ? for missing pattern");
});

test("Task: shows description and subagent_type", () => {
  const result = summarizeToolInput("Task", {
    description: "Explore the codebase",
    subagent_type: "haiku",
  });
  assert.ok(result.includes("Explore the codebase"), "Should include description");
  assert.ok(result.includes("haiku"), "Should include subagent type");
});

test("Task: missing description shows ?", () => {
  const result = summarizeToolInput("Task", { subagent_type: "sonnet" });
  assert.ok(result.includes("Description: ?"), "Should show ? for missing description");
});

test("Unknown tool: shows all keys generically", () => {
  const result = summarizeToolInput("UnknownTool", { alpha: "value1", beta: "value2" });
  assert.ok(result.includes("alpha"), "Should include key alpha");
  assert.ok(result.includes("value1"), "Should include value1");
  assert.ok(result.includes("beta"), "Should include key beta");
});

test("Unknown tool with non-string value: JSON-stringifies it", () => {
  const result = summarizeToolInput("UnknownTool", { count: 42 });
  assert.ok(result.includes("42"), "Should include numeric value");
});

test("Unknown tool with empty input: returns empty string", () => {
  const result = summarizeToolInput("UnknownTool", {});
  assert.strictEqual(result, "", "Should return empty string for empty input");
});

test("Null input: returns empty string", () => {
  const result = summarizeToolInput("Read", null);
  assert.strictEqual(result, "");
});

// ---------------------------------------------------------------------------
// truncate
// ---------------------------------------------------------------------------

console.log("\ntruncate:");

test("String within limit: returned unchanged", () => {
  assert.strictEqual(truncate("hello", 10), "hello");
});

test("String exactly at limit: returned unchanged", () => {
  assert.strictEqual(truncate("hello", 5), "hello");
});

test("String over limit: truncated with ellipsis", () => {
  assert.strictEqual(truncate("hello world", 5), "hello...");
});

test("Empty string: returns empty string", () => {
  assert.strictEqual(truncate("", 10), "");
});

test("Null: returns empty string", () => {
  assert.strictEqual(truncate(null, 10), "");
});

test("Undefined: returns empty string", () => {
  assert.strictEqual(truncate(undefined, 10), "");
});

test("Limit of 0: truncates to empty string with ellipsis", () => {
  assert.strictEqual(truncate("hello", 0), "...");
});

test("Long string: truncated to exactly max chars plus ellipsis", () => {
  const str = "abcdefghij"; // 10 chars
  const result = truncate(str, 4);
  assert.strictEqual(result, "abcd...");
  assert.strictEqual(result.length, 7); // 4 + 3
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
