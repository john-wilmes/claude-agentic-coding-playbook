// PreToolUse hook: enforces evidence citation in findings and memory files.
//
// - FINDINGS.md: hard deny if zero "Evidence NNN" citations
// - project_*.md in memory dirs: soft warn if content looks like investigation
//   findings but contains no source citations (file:line, Evidence NNN, URL)
//
// Pattern: "deny on strict contract, warn on heuristic"

"use strict";

const fs = require("fs");
const path = require("path");

// Evidence citation patterns
const EVIDENCE_CITATION = /Evidence\s+\d{3}/;
const SOURCE_CITATION = /(?:Evidence\s+\d{3})|(?:[\w./-]+:\d+)|(?:https?:\/\/\S+)/;

// Patterns that indicate investigation/research content (heuristic)
const INVESTIGATION_PATTERNS = [
  /root\s*cause/i,
  /finding[s]?\s*:/i,
  /investigation/i,
  /determined\s+that/i,
  /confirmed\s+(?:at|that|by)/i,
  /evidence\s+(?:shows|suggests|indicates)/i,
  /analysis\s+(?:shows|reveals|indicates)/i,
];

// Minimum content length to trigger heuristic check (avoid false positives on stubs)
const MIN_CONTENT_LENGTH = 200;

function respond(payload = {}) {
  process.stdout.write(JSON.stringify(payload));
}

let input = "";
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    const hookInput = JSON.parse(input);
    const toolName = hookInput.tool_name || "";

    // Only gate Write and Edit
    if (toolName !== "Write" && toolName !== "Edit") {
      return respond({});
    }

    const toolInput = hookInput.tool_input || {};
    const filePath = toolInput.file_path || "";
    const basename = path.basename(filePath);

    // Route to appropriate check
    if (basename === "FINDINGS.md") {
      checkFindings(toolName, toolInput, filePath);
    } else if (basename.startsWith("project_") && basename.endsWith(".md") && isInMemoryDir(filePath)) {
      checkMemoryFile(toolName, toolInput, filePath);
    } else {
      return respond({});
    }
  } catch {
    return respond({});
  }
});

function checkFindings(toolName, toolInput, filePath) {
  const content = resolveContent(toolName, toolInput, filePath);
  // Hard-deny on read failure — we cannot verify citations without the full content,
  // so fail-closed rather than fail-open.
  if (content === null) {
    return respond({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "Unable to validate FINDINGS.md content for required evidence citations.",
      },
    });
  }

  // Only enforce once there's substantive content with an answer section
  const hasSubstantiveSection = /^#{1,6}\s*(answer|findings|root cause|conclusion|summary|analysis)\b/mi.test(content);
  if (!hasSubstantiveSection) {
    return respond({});
  }

  if (!EVIDENCE_CITATION.test(content)) {
    return respond({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "FINDINGS.md must cite collected evidence. Use 'Evidence NNN' " +
          "(e.g., 'Evidence 001') to reference evidence files. Every factual " +
          "claim should cite at least one evidence file.",
      },
    });
  }

  return respond({});
}

function checkMemoryFile(toolName, toolInput, filePath) {
  const content = resolveContent(toolName, toolInput, filePath);
  if (content === null || content.length < MIN_CONTENT_LENGTH) {
    return respond({});
  }

  // Check if content looks like investigation findings
  const matchCount = INVESTIGATION_PATTERNS.filter((p) => p.test(content)).length;
  if (matchCount < 2) {
    // Doesn't look like research conclusions — allow silently
    return respond({});
  }

  // Content looks like findings — check for source citations
  if (!SOURCE_CITATION.test(content)) {
    return respond({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext:
          "EVIDENCE REMINDER: This memory file appears to record investigation " +
          "findings but cites no sources. Consider adding file:line references, " +
          "Evidence NNN citations, or URLs to support the claims.",
      },
    });
  }

  return respond({});
}

function resolveContent(toolName, toolInput, filePath) {
  if (toolName === "Write") {
    return toolInput.content || "";
  }
  if (toolName === "Edit") {
    const oldStr = toolInput.old_string || "";
    const newStr = toolInput.new_string || "";
    try {
      const current = fs.readFileSync(filePath, "utf8");
      return current.replace(oldStr, newStr);
    } catch {
      return null;
    }
  }
  return null;
}

function isInMemoryDir(filePath) {
  // Match both absolute paths (/foo/memory/bar) and relative paths (memory/bar or memory\bar)
  return /(?:^|[\\/])memory[\\/]/i.test(filePath);
}
