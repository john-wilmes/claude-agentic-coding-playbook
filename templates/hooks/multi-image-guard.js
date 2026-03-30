#!/usr/bin/env node
/**
 * multi-image-guard.js — PreToolUse hook
 * Blocks reading multiple image files in the same turn.
 *
 * CLAUDE.md rule: "Never read multiple image files in the same turn —
 * use a subagent for bulk image examination."
 *
 * Tracks image reads per session via a temp file. On the 2nd+ image read,
 * denies the tool call with guidance to use a subagent instead.
 *
 * Subagents (agent_id present) are always skipped — they ARE the delegation target.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

let log;
try { log = require("./log"); } catch { log = { writeLog() {} }; }

// Raster image extensions that consume multimodal tokens.
// SVG and ICO are excluded — they're text-readable, not multimodal image input.
const IMAGE_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff", ".tif",
]);

/**
 * Get the tracking file path for this session's image reads.
 * Uses session_id to isolate per-session state.
 */
function getMultiImageDir() {
  const dir = path.join(os.tmpdir(), "claude-multi-image-guard");
  try { fs.mkdirSync(dir, { mode: 0o700, recursive: true }); } catch {}
  return dir;
}

function trackingPath(sessionId) {
  return path.join(getMultiImageDir(), `claude-image-reads-${path.basename(sessionId)}`);
}

/**
 * Check if a file path points to an image.
 */
function isImagePath(filePath) {
  if (!filePath) return false;
  const ext = path.extname(filePath).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

/**
 * Read the current image read count from the tracking file.
 */
function getImageCount(sessionId) {
  try {
    const content = fs.readFileSync(trackingPath(sessionId), "utf8").trim();
    return parseInt(content, 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * Increment and persist the image read count.
 */
function incrementImageCount(sessionId) {
  const count = getImageCount(sessionId) + 1;
  fs.writeFileSync(trackingPath(sessionId), String(count));
  return count;
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

    // Skip subagents — they are the delegation target
    if (event.agent_id) {
      process.stdout.write("{}");
      process.exit(0);
    }

    const toolName = event.tool_name;
    const toolInput = event.tool_input || {};

    // Only inspect Read tool calls
    if (toolName !== "Read") {
      process.stdout.write("{}");
      process.exit(0);
    }

    const filePath = toolInput.file_path || "";
    if (!isImagePath(filePath)) {
      process.stdout.write("{}");
      process.exit(0);
    }

    // This is an image read — check count.
    // NOTE: Known TOCTOU race between getImageCount and incrementImageCount.
    // Accepted limitation: Claude Code serializes tool calls within a session,
    // so concurrent increments from the same session cannot occur in practice.
    const sessionId = event.session_id || "unknown";
    const count = getImageCount(sessionId);

    if (count >= 1) {
      // Already read one image this turn — deny
      const reason =
        `BLOCKED: Already read ${count} image file(s) this session. ` +
        `CLAUDE.md rule: "Never read multiple image files in the same turn — ` +
        `use a subagent for bulk image examination." ` +
        `Delegate image reads to a subagent via the Agent tool.`;

      log.writeLog({
        hook: "multi-image-guard",
        event: "deny",
        session_id: sessionId,
        details: reason,
        context: { filePath, count },
      });

      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      }));
      process.exit(0);
    }

    // First image read — allow and increment
    incrementImageCount(sessionId);
    process.stdout.write("{}");
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
  module.exports = { IMAGE_EXTENSIONS, isImagePath, trackingPath, getImageCount, incrementImageCount };
}
