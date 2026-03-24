#!/usr/bin/env node
/**
 * orphan-file-guard.js — PreToolUse hook
 * Blocks creation of files that are not referenced by any existing file.
 *
 * CLAUDE.md rule: "Every new file must be referenced by at least one existing file.
 * Orphan files are not allowed."
 *
 * Only triggers on Write tool for NEW files (that don't already exist).
 * Searches the repo for references to the new file's basename.
 *
 * Exempt paths (never blocked):
 *   - .gitignore, .env*, package.json, package-lock.json, tsconfig*.json
 *   - Files under .claude/, .git/, node_modules/, tests/fixtures/
 *   - CLAUDE.md, README.md, LICENSE, CHANGELOG.md
 *   - Investigation files (~/.claude/investigations/)
 */

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

let log;
try { log = require("./log"); } catch { log = { writeLog() {} }; }

// Files that are inherently root-level and don't need references
const EXEMPT_BASENAMES = new Set([
  ".gitignore", ".env", ".env.local", ".env.example",
  "package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
  "tsconfig.json", "tsconfig.build.json",
  "CLAUDE.md", "README.md", "LICENSE", "LICENSE.md", "CHANGELOG.md",
  "Dockerfile", "docker-compose.yml", "docker-compose.yaml",
  "Makefile", ".editorconfig", ".prettierrc", ".eslintrc.json",
  "MEMORY.md",
]);

// Directory prefixes that are always exempt
const EXEMPT_DIR_PATTERNS = [
  ".claude/", ".git/", "node_modules/", "tests/", "test/", "__tests__/",
];

/**
 * Check if a file path is exempt from orphan detection.
 */
function isExempt(filePath) {
  const basename = path.basename(filePath);

  // Exempt basenames
  if (EXEMPT_BASENAMES.has(basename)) return true;

  // Exempt patterns by name
  if (basename.startsWith(".env")) return true;
  if (basename.startsWith("tsconfig") && basename.endsWith(".json")) return true;

  // Exempt directory patterns
  const normalized = filePath.replace(/\\/g, "/");
  for (const pattern of EXEMPT_DIR_PATTERNS) {
    if (normalized.includes(`/${pattern}`) || normalized.startsWith(pattern)) return true;
  }

  // Investigation files
  const claudeInvDir = path.join(os.homedir(), ".claude", "investigations");
  if (filePath.startsWith(claudeInvDir)) return true;

  // Memory files
  const claudeMemDir = path.join(os.homedir(), ".claude", "projects");
  if (filePath.startsWith(claudeMemDir)) return true;

  return false;
}

/**
 * Search for references to a filename in the repo at cwd.
 * Uses grep -r for speed. Returns true if at least one reference found.
 */
function hasReference(basename, cwd) {
  if (!cwd) return true; // Can't search without cwd, allow

  try {
    // Use grep -rl for fast "exists" check. Exclude binary and common noise dirs.
    // execFileSync avoids shell injection via unsanitized basename.
    const result = execFileSync("grep", [
      "-rl",
      "--include=*.js", "--include=*.ts", "--include=*.tsx", "--include=*.jsx",
      "--include=*.json", "--include=*.md", "--include=*.yaml", "--include=*.yml",
      "--include=*.sh", "--include=*.html", "--include=*.css", "--include=*.toml",
      "--exclude-dir=node_modules", "--exclude-dir=.git", "--exclude-dir=dist",
      "-m", "1", "--", basename, cwd,
    ], { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] });
    return result.trim().length > 0;
  } catch (err) {
    // grep exit 1 = no matches found (expected, return false to trigger deny)
    // Any other error (timeout, permission, etc.) — return true to avoid false blocks
    if (err.status === 1) return false;
    return true;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let input = "";
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const event = JSON.parse(input);
    const toolName = event.tool_name;
    const toolInput = event.tool_input || {};

    // Only inspect Write tool calls
    if (toolName !== "Write") {
      process.stdout.write("{}");
      process.exit(0);
    }

    const filePath = toolInput.file_path || "";
    if (!filePath) {
      process.stdout.write("{}");
      process.exit(0);
    }

    // Only block NEW file creation (file doesn't exist yet)
    if (fs.existsSync(filePath)) {
      process.stdout.write("{}");
      process.exit(0);
    }

    // Check exemptions
    if (isExempt(filePath)) {
      process.stdout.write("{}");
      process.exit(0);
    }

    const basename = path.basename(filePath);
    const cwd = event.cwd || "";

    // Search for references
    if (hasReference(basename, cwd)) {
      process.stdout.write("{}");
      process.exit(0);
    }

    // No reference found — deny
    const reason =
      `BLOCKED: "${basename}" is not referenced by any existing file. ` +
      `CLAUDE.md rule: "Every new file must be referenced by at least one existing file." ` +
      `Add an import, require, or reference to this file before creating it.`;

    log.writeLog({
      hook: "orphan-file-guard",
      event: "deny",
      details: reason,
      context: { filePath, basename, cwd },
    });

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }));
    process.exit(0);
  } catch {
    process.stdout.write("{}");
    process.exit(0);
  }
});

// ---------------------------------------------------------------------------
// Exports (for tests)
// ---------------------------------------------------------------------------
if (typeof module !== "undefined") {
  module.exports = { isExempt, hasReference, EXEMPT_BASENAMES };
}
