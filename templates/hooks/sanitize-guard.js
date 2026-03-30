// sanitize-guard.js — Dual-mode PII/PHI sanitization hook (PreToolUse + PostToolUse).
//
// PostToolUse (when tool_response exists):
//   Scans tool response text for PII/PHI. If found, emits redacted additionalContext.
//
// PreToolUse (when tool_response absent):
//   Only fires for Edit and Write tools. Scans write content for PII/PHI.
//   If found, blocks the tool with a deny decision and provides redacted content.
//
// Config: <cwd>/.claude/sanitize.yaml (opt-in — no config = no scanning).
// Exclude paths: glob patterns relative to cwd (supports ** and *).
//
// Zero npm dependencies. Exit 0 always.

"use strict";

const path = require("path");

let log;
try { log = require("./log"); } catch { log = { writeLog() {} }; }

const piiDetector = require("./pii-detector");

// ─── Glob matching ───────────────────────────────────────────────────────────

// Supported glob syntax: * (single segment), ** (any depth), ? (single char).
// Does not support brace expansion ({a,b}), character classes ([abc]), or negation (!pattern).
function globToRegex(glob) {
  // Escape regex special chars except * and ? which we handle manually
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\{\{GLOBSTAR\}\}/g, ".*");
  return new RegExp("^" + escaped + "$");
}

function isExcluded(filePath, excludePatterns, cwd) {
  if (!filePath || !excludePatterns || excludePatterns.length === 0) return false;
  const resolved = path.resolve(filePath);
  const rel = path.relative(path.resolve(cwd || ""), resolved);
  return excludePatterns.some(p => {
    try { return globToRegex(p).test(rel); } catch { return false; }
  });
}

// ─── Summary string ──────────────────────────────────────────────────────────

/**
 * Build a human-readable summary of detections grouped by entity type.
 * E.g. "2 US_SSNs, 1 EMAIL"
 */
function buildSummary(detections) {
  const counts = {};
  for (const d of detections) {
    counts[d.entity] = (counts[d.entity] || 0) + 1;
  }
  return Object.entries(counts)
    .map(([type, n]) => `${n} ${type}${n > 1 ? "s" : ""}`)
    .join(", ");
}

// ─── Truncate helper ─────────────────────────────────────────────────────────

const MAX_REDACTED_CHARS = 50000;

function truncate(text) {
  if (text.length <= MAX_REDACTED_CHARS) return text;
  return text.slice(0, MAX_REDACTED_CHARS) + "... [truncated]";
}

// ─── Main ────────────────────────────────────────────────────────────────────

let input = "";
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    const hookInput = JSON.parse(input);
    const isPostToolUse = "tool_response" in hookInput;

    const cwd = hookInput.cwd || "";

    if (isPostToolUse) {
      // ── PostToolUse path ──────────────────────────────────────────────────

      // Extract text content from tool_response for PII scanning.
      // Always use JSON.stringify to ensure no response keys (rows, data, etc.) are missed.
      function extractText(response) {
        if (!response) return "";
        if (typeof response === "string") return response;
        return JSON.stringify(response);
      }

      const text = extractText(hookInput.tool_response);

      const config = piiDetector.loadConfig(cwd);
      if (!config || config.enabled === false) {
        process.stdout.write(JSON.stringify({}));
        process.exit(0);
      }

      // Check exclude_paths against the tool's file_path (if any)
      const filePath = hookInput.tool_input && hookInput.tool_input.file_path;
      if (isExcluded(filePath, config.exclude_paths, cwd)) {
        process.stdout.write(JSON.stringify({}));
        process.exit(0);
      }

      // Scan both tool_response and tool_input for PII
      const responseDetections = piiDetector.detectPII(text, config.entities, config.custom_patterns);
      const inputText = extractText(hookInput.tool_input);
      const inputDetections = piiDetector.detectPII(inputText, config.entities, config.custom_patterns);
      const detections = [...responseDetections, ...inputDetections];
      if (detections.length === 0) {
        process.stdout.write(JSON.stringify({}));
        process.exit(0);
      }

      const summary = buildSummary(detections);
      const redacted = truncate(piiDetector.redact(text, responseDetections));

      log.writeLog({
        hook: "sanitize-guard",
        event: "pii-detected",
        mode: "post",
        session_id: hookInput.session_id,
        tool_use_id: hookInput.tool_use_id,
        tool_name: hookInput.tool_name,
        project: cwd,
        details: `PostToolUse: ${detections.length} detections (${summary})`,
      });

      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext:
            `\u26a0\ufe0f PII/PHI detected and redacted (${detections.length} items: ${summary}). Use this sanitized version:\n${redacted}`,
        },
      }));
      process.exit(0);
    }

    // ── PreToolUse path ───────────────────────────────────────────────────────

    const toolName = hookInput.tool_name || "";
    if (toolName !== "Edit" && toolName !== "Write") {
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    // Extract write content
    const content = toolName === "Edit"
      ? (hookInput.tool_input && hookInput.tool_input.new_string)
      : (hookInput.tool_input && hookInput.tool_input.content);

    if (!content) {
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    const config = piiDetector.loadConfig(cwd);
    if (!config || config.enabled === false) {
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    const filePath = hookInput.tool_input && hookInput.tool_input.file_path;
    if (isExcluded(filePath, config.exclude_paths, cwd)) {
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    const detections = piiDetector.detectPII(content, config.entities, config.custom_patterns);
    if (detections.length === 0) {
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    const summary = buildSummary(detections);

    log.writeLog({
      hook: "sanitize-guard",
      event: "pii-detected",
      mode: "pre",
      session_id: hookInput.session_id,
      tool_use_id: hookInput.tool_use_id,
      tool_name: toolName,
      project: cwd,
      details: `PreToolUse: ${detections.length} detections (${summary}) — blocked`,
    });

    const redacted = truncate(piiDetector.redact(content, detections));
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          `BLOCKED: PII/PHI detected in content (${detections.length} items: ${summary}). Use this redacted version instead:\n${redacted}`,
      },
    }));
    process.exit(0);

  } catch {
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }
});
