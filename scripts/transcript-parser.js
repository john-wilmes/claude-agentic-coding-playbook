#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

/**
 * Encode a cwd path to the directory name Claude Code uses for project storage.
 * e.g., "/home/user/project" -> "home-user-project"
 */
function encodeCwd(cwd) {
  return cwd.replace(/:/g, "-").replace(/[\\/]/g, "-");
}

/**
 * Get the projects directory for a given project working directory.
 * Returns: ~/.claude/projects/<encoded-cwd>/
 */
function getProjectDir(projectCwd) {
  return path.join(os.homedir(), ".claude", "projects", encodeCwd(projectCwd));
}

/**
 * Find a session JSONL file by session ID (or prefix).
 * @param {string} sessionId - Full or prefix session ID
 * @param {string} projectDir - Project working directory (will be encoded)
 * @returns {string|null} Full path to the JSONL file, or null
 */
function findSessionFile(sessionId, projectDir) {
  const dir = getProjectDir(projectDir);
  if (!fs.existsSync(dir)) return null;

  let files;
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith(".jsonl"));
  } catch { return null; }

  // Exact match first
  const exact = sessionId + ".jsonl";
  if (files.includes(exact)) return path.join(dir, exact);

  // Prefix match
  const matches = files.filter(f => f.startsWith(sessionId));
  if (matches.length === 1) return path.join(dir, matches[0]);
  if (matches.length > 1) {
    // Return most recent by mtime
    let best = null, bestTime = 0;
    for (const f of matches) {
      const fp = path.join(dir, f);
      try {
        const st = fs.statSync(fp);
        if (st.mtimeMs > bestTime) { bestTime = st.mtimeMs; best = fp; }
      } catch {}
    }
    return best;
  }
  return null;
}

/**
 * Find the most recently modified session JSONL file.
 * @param {string} projectDir - Project working directory
 * @returns {string|null}
 */
function findMostRecentSession(projectDir) {
  const dir = getProjectDir(projectDir);
  if (!fs.existsSync(dir)) return null;

  let files;
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith(".jsonl"));
  } catch { return null; }

  if (files.length === 0) return null;

  let best = null, bestTime = 0;
  for (const f of files) {
    const fp = path.join(dir, f);
    try {
      const st = fs.statSync(fp);
      if (st.mtimeMs > bestTime) { bestTime = st.mtimeMs; best = fp; }
    } catch {}
  }
  return best;
}

/**
 * Parse a session JSONL file into an array of entry objects.
 * Skips malformed lines silently.
 * @param {string} filePath
 * @returns {object[]}
 */
function parseSessionFile(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch { return []; }

  const entries = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {}
  }
  return entries;
}

/**
 * Build a map from tool_use_id to { content, is_error } from tool_result blocks.
 * Scans user entries for tool_result content blocks.
 * @param {object[]} entries
 * @returns {Map<string, {content: string, is_error: boolean}>}
 */
function buildToolResultMap(entries) {
  const map = new Map();
  for (const entry of entries) {
    if (entry.type !== "user") continue;
    const msg = entry.message;
    if (!msg || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "tool_result" && block.tool_use_id) {
        map.set(block.tool_use_id, {
          content: typeof block.content === "string" ? block.content : JSON.stringify(block.content),
          is_error: block.is_error === true,
        });
      }
    }
  }
  return map;
}

/**
 * Extract tool_use blocks from assistant entries.
 * @param {object[]} entries
 * @param {string[]} [toolNames] - Optional filter by tool name (e.g., ["Write", "Edit"])
 * @returns {Array<{entry: object, toolUse: object}>}
 */
function extractToolUses(entries, toolNames) {
  const results = [];
  const nameSet = toolNames ? new Set(toolNames) : null;

  for (const entry of entries) {
    if (entry.type !== "assistant") continue;
    const msg = entry.message;
    if (!msg || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type !== "tool_use") continue;
      if (nameSet && !nameSet.has(block.name)) continue;
      results.push({ entry, toolUse: block });
    }
  }
  return results;
}

/**
 * Format a single JSONL entry to markdown.
 * @param {object} entry
 * @param {object} opts
 * @param {boolean} opts.includeThinking - Include thinking blocks (default: false)
 * @param {boolean} opts.includeSidechain - Include sidechain entries (default: true)
 * @param {boolean} opts.includeToolResults - Include tool result content (default: true)
 * @param {number} opts.maxResultLength - Max chars for tool result content (default: 500)
 * @param {Map} opts.toolResultMap - Map from buildToolResultMap
 * @returns {string|null} Markdown string or null to skip
 */
function formatEntryToMarkdown(entry, opts = {}) {
  const {
    includeThinking = false,
    includeSidechain = true,
    includeToolResults = true,
    maxResultLength = 500,
    toolResultMap = new Map(),
  } = opts;

  // Skip non-message types
  if (entry.type === "progress" || entry.type === "file-history-snapshot" || entry.type === "queue-operation") {
    return null;
  }

  // Skip sidechain if requested
  if (!includeSidechain && entry.isSidechain) return null;

  const msg = entry.message;
  if (!msg) return null;

  const parts = [];
  const timestamp = entry.timestamp ? ` _(${entry.timestamp})_` : "";
  const sidechain = entry.isSidechain ? " [sidechain]" : "";

  if (entry.type === "user") {
    if (typeof msg.content === "string") {
      parts.push(`## User${sidechain}${timestamp}\n\n${msg.content}`);
    } else if (Array.isArray(msg.content)) {
      // Could be tool_result blocks or text blocks
      const textParts = [];
      const resultParts = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "tool_result" && includeToolResults) {
          const status = block.is_error ? "error" : "success";
          let content = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
          if (content && content.length > maxResultLength) {
            content = content.slice(0, maxResultLength) + "\n... (truncated)";
          }
          resultParts.push(`<details><summary>Result: ${status}</summary>\n\n\`\`\`\n${content}\n\`\`\`\n</details>`);
        }
      }
      if (textParts.length > 0) {
        parts.push(`## User${sidechain}${timestamp}\n\n${textParts.join("\n")}`);
      }
      if (resultParts.length > 0) {
        parts.push(resultParts.join("\n\n"));
      }
    }
  } else if (entry.type === "assistant") {
    if (typeof msg.content === "string") {
      parts.push(`## Assistant${sidechain}${timestamp}\n\n${msg.content}`);
    } else if (Array.isArray(msg.content)) {
      const textParts = [];
      const toolParts = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "thinking" && includeThinking) {
          textParts.push(`> **Thinking:**\n> ${block.thinking.replace(/\n/g, "\n> ")}`);
        } else if (block.type === "tool_use") {
          const inputSummary = summarizeToolInput(block.name, block.input);
          toolParts.push(`**Tool: ${block.name}**\n${inputSummary}`);

          // Include tool result if available
          if (includeToolResults && toolResultMap.has(block.id)) {
            const result = toolResultMap.get(block.id);
            const status = result.is_error ? "error" : "success";
            let content = result.content || "";
            if (content.length > maxResultLength) {
              content = content.slice(0, maxResultLength) + "\n... (truncated)";
            }
            toolParts.push(`<details><summary>Result: ${status}</summary>\n\n\`\`\`\n${content}\n\`\`\`\n</details>`);
          }
        }
      }
      if (textParts.length > 0 || toolParts.length > 0) {
        const header = `## Assistant${sidechain}${timestamp}\n\n`;
        const body = [...textParts, ...toolParts].join("\n\n");
        parts.push(header + body);
      }
    }
  }

  return parts.length > 0 ? parts.join("\n\n") : null;
}

/**
 * Summarize tool input for markdown display.
 */
function summarizeToolInput(toolName, input) {
  if (!input) return "";

  switch (toolName) {
    case "Write":
      return `- File: \`${input.file_path || "?"}\`\n- Content: ${(input.content || "").length} chars`;
    case "Edit":
      return `- File: \`${input.file_path || "?"}\`\n- Old: \`${truncate(input.old_string, 60)}\`\n- New: \`${truncate(input.new_string, 60)}\``;
    case "Read":
      return `- File: \`${input.file_path || "?"}\``;
    case "Bash":
      return `\`\`\`bash\n${truncate(input.command, 200)}\n\`\`\``;
    case "Glob":
      return `- Pattern: \`${input.pattern || "?"}\`${input.path ? `\n- Path: \`${input.path}\`` : ""}`;
    case "Grep":
      return `- Pattern: \`${input.pattern || "?"}\`${input.path ? `\n- Path: \`${input.path}\`` : ""}`;
    case "Task":
      return `- Description: ${input.description || "?"}\n- Type: ${input.subagent_type || "?"}`;
    case "NotebookEdit":
      return `- Notebook: \`${input.notebook_path || "?"}\``;
    default: {
      // Generic: show keys
      const keys = Object.keys(input);
      if (keys.length === 0) return "";
      const summary = keys.map(k => {
        const v = input[k];
        if (typeof v === "string") return `- ${k}: \`${truncate(v, 80)}\``;
        return `- ${k}: ${JSON.stringify(v)}`;
      });
      return summary.join("\n");
    }
  }
}

function truncate(str, max) {
  if (!str) return "";
  if (str.length <= max) return str;
  return str.slice(0, max) + "...";
}

module.exports = {
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
};
