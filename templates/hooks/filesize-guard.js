#!/usr/bin/env node
/**
 * filesize-guard.js — PreToolUse hook
 * Blocks oversized and binary file reads before they waste tokens.
 *
 * Covers:
 *   - Read tool: checks file_path directly
 *   - Bash tool: extracts target from cat/head/tail/less/more/strings commands
 *   - All other tools: pass through ({})
 */

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

let log;
try {
  log = require("./log");
} catch {
  log = { writeLog() {}, promptHead(t) { return t; } };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SIZE_LIMIT = 10 * 1024 * 1024; // 10 MB

const BINARY_EXTENSIONS = new Set([
  // Video
  ".mp4", ".mov", ".avi", ".mkv", ".wmv", ".flv", ".webm", ".m4v", ".mpg", ".mpeg",
  // Raw photos
  ".arw", ".cr2", ".cr3", ".nef", ".orf", ".rw2", ".dng", ".raf", ".pef", ".srw",
  // Audio
  ".wav", ".flac", ".mp3", ".aac", ".ogg", ".wma", ".aiff", ".m4a",
  // Archives
  ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar", ".zst", ".tgz",
  // Databases
  ".db", ".sqlite", ".sqlite3", ".mdb",
  // Compiled / native
  ".exe", ".dll", ".so", ".dylib", ".o", ".a", ".wasm", ".class", ".pyc",
  // Disk images
  ".iso", ".dmg", ".img", ".vhd", ".vmdk",
  // Big data
  ".parquet", ".avro", ".orc",
  // Other binary
  ".bin", ".dat", ".pak",
]);

// Notably NOT in the set (multimodal / text-extractable):
// .jpg .jpeg .png .gif .webp .svg .ico .pdf

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert bytes to human-readable string (e.g. "15.2MB", "1.1GB").
 */
function humanSize(bytes) {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }
  return `${bytes}B`;
}

/**
 * Expand leading ~ to the home directory.
 */
function expandTilde(filePath) {
  if (filePath.startsWith("~/") || filePath === "~") {
    return path.join(os.homedir(), filePath.slice(1));
  }
  return filePath;
}

/**
 * Check a single file path. Returns null to allow, or a denial reason string.
 */
function checkFile(filePath) {
  if (!filePath || filePath.includes("$")) {
    // Missing or contains shell variable — can't resolve, pass through
    return null;
  }

  const expanded = expandTilde(filePath);

  // Allow-list: anything under ~/.claude/
  const claudeDir = path.join(os.homedir(), ".claude") + path.sep;
  if (expanded.startsWith(claudeDir) || expanded === path.join(os.homedir(), ".claude")) {
    return null;
  }

  // Special kernel pseudo-paths — skip stat
  if (expanded.startsWith("/dev/") || expanded.startsWith("/proc/")) {
    return null;
  }

  // Binary extension check
  const ext = path.extname(expanded).toLowerCase();
  if (ext && BINARY_EXTENSIONS.has(ext)) {
    return (
      `BLOCKED: "${filePath}" has binary extension ${ext}. ` +
      `Use \`file ${filePath}\` to inspect or \`strings ${filePath} | head -50\` for text content.`
    );
  }

  // Stat check
  let stat;
  try {
    stat = fs.statSync(expanded);
  } catch (err) {
    // ENOENT, EACCES, etc. — let the tool itself report the error
    return null;
  }

  if (stat.isDirectory()) {
    return (
      `BLOCKED: "${filePath}" is a directory, not a file. ` +
      `Use \`ls -la ${filePath}\` or \`du -sh ${filePath}\` to explore.`
    );
  }

  if (stat.size > SIZE_LIMIT) {
    return (
      `BLOCKED: "${filePath}" is ${humanSize(stat.size)} (limit: 10MB). ` +
      `Use \`tail -n 200 ${filePath}\` or \`head -n 200 ${filePath}\` to read portions.`
    );
  }

  return null;
}

/**
 * Extract a file path from a bash command that starts with a read-style command.
 * Only inspects the first segment of a pipe.
 * Returns null if the command doesn't match or uses shell variables.
 */
function extractBashFilePath(command) {
  if (!command) return null;

  // Only look at the first segment before any pipe / semicolon / redirect
  const firstSegment = command.split(/[|;&>]/, 1)[0];

  // Match: cat/head/tail/less/more/strings [optional-flags] <file>
  const match = firstSegment.match(
    /^\s*(?:cat|head|tail|less|more|strings)\s+(?:-[^\s]+\s+)*([^\s|;>&]+)/
  );

  if (!match) return null;

  const candidate = match[1];
  // Skip shell variables
  if (candidate.includes("$")) return null;

  return candidate;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const event = JSON.parse(input);
    const toolName = event.tool_name;
    const toolInput = event.tool_input || {};

    let filePath = null;

    if (toolName === "Read") {
      filePath = toolInput.file_path || null;
    } else if (toolName === "Bash") {
      filePath = extractBashFilePath(toolInput.command || "");
    }

    if (filePath === null) {
      // Not a tool we inspect, or no extractable path
      process.stdout.write("{}");
      return;
    }

    const reason = checkFile(filePath);

    if (reason) {
      log.writeLog({ hook: "filesize-guard", event: "block", filePath, reason });
      const output = {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      };
      process.stdout.write(JSON.stringify(output));
    } else {
      process.stdout.write("{}");
    }
  } catch (_err) {
    process.stdout.write("{}");
  }
  process.exit(0);
});

// ---------------------------------------------------------------------------
// Exports (for tests)
// ---------------------------------------------------------------------------
if (typeof module !== "undefined") {
  module.exports = { checkFile, BINARY_EXTENSIONS };
}
