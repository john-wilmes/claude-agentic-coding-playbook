#!/usr/bin/env node
/**
 * investigation-to-vault.js — Transform closed investigation directories into arscontexta vault notes.
 *
 * Usage:
 *   node scripts/investigation-to-vault.js --output-dir <path> [investigations-dir]
 *
 * investigations-dir defaults to ~/.claude/investigations/
 * Output: Markdown files with YAML frontmatter in arscontexta format
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const os   = require("os");

const { slugify, loadExistingSlugs } = require("./knowledge-to-vault.js");

// ─── Exported helpers ─────────────────────────────────────────────────────────

/**
 * Extract YAML frontmatter between `---` delimiters from FINDINGS.md.
 * Returns { tags: { domain, type, severity, components, symptoms, root_cause }, rest }
 * Handles inline arrays: `key: [val1, val2]` and nested under `tags:` parent.
 */
function parseYamlFrontmatter(text) {
  const emptyTags = { domain: [], type: [], severity: [], components: [], symptoms: [], root_cause: [] };

  if (!text || !text.trim()) {
    return { tags: emptyTags, rest: text || "" };
  }

  // Check for frontmatter delimiters
  const lines = text.split("\n");
  if (lines[0].trim() !== "---") {
    return { tags: emptyTags, rest: text };
  }

  // Find closing ---
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      closeIdx = i;
      break;
    }
  }

  if (closeIdx === -1) {
    return { tags: emptyTags, rest: text };
  }

  const frontmatterLines = lines.slice(1, closeIdx);
  const rest = lines.slice(closeIdx + 1).join("\n");

  // Parse the frontmatter YAML
  const tags = { domain: [], type: [], severity: [], components: [], symptoms: [], root_cause: [] };
  const tagKeys = new Set(Object.keys(tags));

  let inTagsBlock = false;
  let currentTagKey = null;

  for (const line of frontmatterLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Check if we're entering the tags: block
    if (trimmed === "tags:") {
      inTagsBlock = true;
      currentTagKey = null;
      continue;
    }

    // Detect indentation level
    const indent = line.length - line.trimStart().length;

    if (inTagsBlock) {
      // Top-level key would have indent 0; anything indented is under tags:
      if (indent === 0 && !trimmed.startsWith("-")) {
        // Left the tags block
        inTagsBlock = false;
        currentTagKey = null;
      } else {
        // Parse tag sub-keys: `  domain: [val1, val2]` or `  domain:`
        const kvMatch = trimmed.match(/^([a-z_]+):\s*(.*)/);
        if (kvMatch) {
          const key = kvMatch[1];
          const val = kvMatch[2].trim();
          if (tagKeys.has(key)) {
            currentTagKey = key;
            if (val && val !== "[]") {
              // Inline array: [val1, val2]
              if (val.startsWith("[") && val.endsWith("]")) {
                const inner = val.slice(1, -1).trim();
                if (inner) {
                  tags[key] = inner.split(",").map(s => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
                }
              } else {
                // Single inline value
                tags[key] = [val.replace(/^["']|["']$/g, "")];
              }
            }
          }
          continue;
        }

        // Array item: `  - value`
        const listMatch = trimmed.match(/^-\s+(.*)/);
        if (listMatch && currentTagKey) {
          const val = listMatch[1].trim().replace(/^["']|["']$/g, "");
          if (val) tags[currentTagKey].push(val);
          continue;
        }
      }
    }

    // Outside tags block: look for direct key: [array] patterns relevant to tags
    if (!inTagsBlock) {
      const kvMatch = trimmed.match(/^([a-z_]+):\s*(.*)/);
      if (kvMatch) {
        const key = kvMatch[1];
        const val = kvMatch[2].trim();
        if (tagKeys.has(key)) {
          if (val && val !== "[]") {
            if (val.startsWith("[") && val.endsWith("]")) {
              const inner = val.slice(1, -1).trim();
              if (inner) {
                tags[key] = inner.split(",").map(s => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
              }
            } else {
              tags[key] = [val.replace(/^["']|["']$/g, "")];
            }
          }
        }
      }
    }
  }

  return { tags, rest };
}

/**
 * Extract content from `## Heading` to next `## ` or end of text.
 * Case-insensitive heading match. Trims leading/trailing blank lines.
 * Returns empty string if heading not found.
 */
function extractSection(markdown, heading) {
  if (!markdown) return "";

  const lines = markdown.split("\n");
  const headingLower = heading.toLowerCase().trim();

  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("## ") && line.slice(3).trim().toLowerCase() === headingLower) {
      startIdx = i + 1;
      break;
    }
  }

  if (startIdx === -1) return "";

  // Find the next ## heading
  let endIdx = lines.length;
  for (let i = startIdx; i < lines.length; i++) {
    if (lines[i].trim().startsWith("## ")) {
      endIdx = i;
      break;
    }
  }

  const sectionLines = lines.slice(startIdx, endIdx);

  // Trim leading/trailing blank lines
  let lo = 0;
  while (lo < sectionLines.length && !sectionLines[lo].trim()) lo++;
  let hi = sectionLines.length - 1;
  while (hi >= lo && !sectionLines[hi].trim()) hi--;

  return sectionLines.slice(lo, hi + 1).join("\n");
}

/**
 * Get investigation phase from STATUS.md text.
 * Format 1: `## Current Phase` section, first non-empty line below.
 * Format 2: `phase: closed` key-value line.
 * Returns null if neither found.
 */
function extractPhase(statusText) {
  if (!statusText) return null;

  // Format 1: ## Current Phase section
  const section = extractSection(statusText, "Current Phase");
  if (section) {
    const firstLine = section.split("\n").find(l => l.trim());
    if (firstLine) return firstLine.trim().toLowerCase();
  }

  // Format 2: phase: value key-value line
  const kvMatch = statusText.match(/^phase:\s*(.+)$/im);
  if (kvMatch) return kvMatch[1].trim().toLowerCase();

  return null;
}

/**
 * Extract question from `## Question` section of BRIEF.md.
 */
function extractQuestion(briefText) {
  return extractSection(briefText, "Question");
}

/**
 * Extract repo from `## Repo` section of BRIEF.md.
 */
function extractRepo(briefText) {
  return extractSection(briefText, "Repo");
}

/**
 * Get date when investigation was closed.
 * Looks for `closed` entry in history table: `| YYYY-MM-DD | closed | ... |`
 * Or `closed: YYYY-MM-DD` key-value line.
 * Returns ISO date string or empty string.
 */
function extractClosedDate(statusText) {
  if (!statusText) return "";

  // History table format: | YYYY-MM-DD | closed | ... |
  const tableMatch = statusText.match(/\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*closed\s*\|/i);
  if (tableMatch) return tableMatch[1];

  // Key-value format: closed: YYYY-MM-DD
  const kvMatch = statusText.match(/^closed:\s*(\d{4}-\d{2}-\d{2})/im);
  if (kvMatch) return kvMatch[1];

  return "";
}

/**
 * Map investigation type tags to arscontexta type.
 * Takes first matching tag from array. Default: "insight".
 */
function mapTypeToVaultType(typeTags) {
  const TYPE_MAP = {
    exploration:  "insight",
    performance:  "pattern",
    debugging:    "tension",
    "root-cause": "tension",
    security:     "insight",
    architecture: "pattern",
  };

  if (!Array.isArray(typeTags)) return "insight";

  for (const tag of typeTags) {
    if (TYPE_MAP[tag]) return TYPE_MAP[tag];
  }

  return "insight";
}

/**
 * Build topic wiki links from tags and investigation id.
 * Includes tags.domain values as [[val]], tags.components values as [[val]],
 * and always includes [[investigation-{id}]].
 * Returns string like `[[infrastructure]] [[lambda]] [[investigation-lambda-cold-starts]]`
 */
function buildTopics(tagObj, investigationId) {
  const items = [];

  const domain     = (tagObj && tagObj.domain)     ? tagObj.domain     : [];
  const components = (tagObj && tagObj.components) ? tagObj.components : [];

  for (const d of domain) {
    if (d && d.trim()) items.push(`[[${d.trim()}]]`);
  }
  for (const c of components) {
    if (c && c.trim()) items.push(`[[${c.trim()}]]`);
  }

  items.push(`[[investigation-${investigationId}]]`);

  return items.join(" ");
}

/**
 * First sentence of Answer section, ≤150 chars, stripped of markdown.
 * Same logic as knowledge-to-vault's descriptionFromContextText but takes raw markdown paragraph.
 */
function descriptionFromAnswer(answerText) {
  if (!answerText || !answerText.trim()) return "Unknown entry";

  const raw = answerText.trim();
  let sentence = raw;

  const dotMatch = raw.match(/^(.*?)\.\s/);
  const nlMatch  = raw.match(/^([^\n]+)/);

  if (dotMatch && nlMatch) {
    sentence = dotMatch[1].length <= nlMatch[1].length ? dotMatch[1] : nlMatch[1];
  } else if (dotMatch) {
    sentence = dotMatch[1];
  } else if (nlMatch) {
    sentence = nlMatch[1];
  }

  // Strip markdown formatting
  sentence = sentence.replace(/`[^`]*`/g, match => match.slice(1, -1));
  sentence = sentence.replace(/\*\*([^*]+)\*\*/g, "$1");
  sentence = sentence.replace(/\*([^*]+)\*/g, "$1");
  sentence = sentence.replace(/__([^_]+)__/g, "$1");
  sentence = sentence.replace(/_([^_]+)_/g, "$1");
  sentence = sentence.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  sentence = sentence.replace(/[.!?,;:]+$/, "").trim();

  if (sentence.length > 150) {
    return sentence.slice(0, 150) + "...";
  }

  return sentence || "Unknown entry";
}

/**
 * Build full vault note from investigation files.
 * @param {string} id - Investigation directory name (used as ID)
 * @param {string} brief - Raw text of BRIEF.md
 * @param {string} status - Raw text of STATUS.md
 * @param {string} findings - Raw text of FINDINGS.md
 * @returns {string} Markdown note in arscontexta format
 */
function buildInvestigationNote(id, brief, status, findings) {
  const { tags } = parseYamlFrontmatter(findings);

  const question   = extractQuestion(brief) || id;
  const repo       = extractRepo(brief);
  const closedDate = extractClosedDate(status);

  // Extract sections from findings body (after stripping frontmatter)
  const { rest: findingsBody } = parseYamlFrontmatter(findings);
  const answerSection   = extractSection(findingsBody, "Answer");
  const evidenceSection = extractSection(findingsBody, "Evidence Summary");
  const implSection     = extractSection(findingsBody, "Implications");

  const type   = mapTypeToVaultType(tags.type);
  const desc   = descriptionFromAnswer(answerSection);
  const topics = buildTopics(tags, id);

  const lines = [];
  lines.push("---");
  lines.push(`description: "${desc}"`);
  lines.push(`type: ${type}`);
  if (closedDate) lines.push(`created: ${closedDate}`);
  lines.push(`topics: ${topics}`);
  lines.push("---");
  lines.push("");
  lines.push(`# ${question}`);
  lines.push("");

  if (answerSection) {
    lines.push("## Answer");
    lines.push("");
    lines.push(answerSection);
    lines.push("");
  }

  if (evidenceSection) {
    lines.push("## Evidence Summary");
    lines.push("");
    lines.push(evidenceSection);
    lines.push("");
  }

  if (implSection) {
    lines.push("## Implications");
    lines.push("");
    lines.push(implSection);
    lines.push("");
  }

  lines.push("---");
  const sourceRef = repo ? `${repo} · Investigation: ${id}` : `Investigation: ${id}`;
  lines.push(`*Source: ${sourceRef}*`);
  lines.push("");

  return lines.join("\n");
}

/**
 * Case-insensitive file lookup in a directory.
 * Returns the actual filename that matches case-insensitively, or null if not found.
 */
function findFileInsensitive(dir, name) {
  try {
    const entries = fs.readdirSync(dir);
    const lower   = name.toLowerCase();
    const found   = entries.find(e => e.toLowerCase() === lower);
    return found || null;
  } catch {
    return null;
  }
}

/**
 * Main processing: read investigationsDir, process closed investigations, write vault notes.
 * @param {string} investigationsDir - Path to investigations directory
 * @param {string} outputDir - Path to write vault notes
 * @returns {{ exported: number, skipped: number, duplicates: number }}
 */
function processInvestigations(investigationsDir, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });

  const existingSlugs = loadExistingSlugs(outputDir);
  const seenSlugs     = new Set();

  let exported   = 0;
  let skipped    = 0;
  let duplicates = 0;

  let subdirs;
  try {
    subdirs = fs.readdirSync(investigationsDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name !== "_patterns")
      .map(e => e.name);
  } catch {
    return { exported, skipped, duplicates };
  }

  for (const id of subdirs) {
    const invDir = path.join(investigationsDir, id);

    // Read STATUS.md (case-insensitive)
    const statusFile = findFileInsensitive(invDir, "STATUS.md");
    if (!statusFile) {
      skipped++;
      continue;
    }

    let statusText;
    try {
      statusText = fs.readFileSync(path.join(invDir, statusFile), "utf8");
    } catch {
      skipped++;
      continue;
    }

    // Check phase = closed
    const phase = extractPhase(statusText);
    if (!phase || phase !== "closed") {
      skipped++;
      continue;
    }

    // Read BRIEF.md
    const briefFile = findFileInsensitive(invDir, "BRIEF.md");
    let briefText = "";
    if (briefFile) {
      try {
        briefText = fs.readFileSync(path.join(invDir, briefFile), "utf8");
      } catch { /* use empty */ }
    }

    // Read FINDINGS.md
    const findingsFile = findFileInsensitive(invDir, "FINDINGS.md");
    let findingsText = "";
    if (findingsFile) {
      try {
        findingsText = fs.readFileSync(path.join(invDir, findingsFile), "utf8");
      } catch { /* use empty */ }
    }

    // Build note and determine slug from question
    const question = extractQuestion(briefText) || id;
    const slug     = slugify(question);

    if (existingSlugs.has(slug) || seenSlugs.has(slug)) {
      duplicates++;
      continue;
    }

    seenSlugs.add(slug);

    const content  = buildInvestigationNote(id, briefText, statusText, findingsText);
    const filePath = path.join(outputDir, `${slug}.md`);

    try {
      fs.writeFileSync(filePath, content, "utf8");
      exported++;
    } catch {
      skipped++;
    }
  }

  return { exported, skipped, duplicates };
}

// ─── CLI entrypoint ───────────────────────────────────────────────────────────

function printUsage() {
  process.stderr.write([
    "Usage: investigation-to-vault.js --output-dir <path> [investigations-dir]",
    "",
    "Transform closed investigation directories into arscontexta vault notes.",
    "",
    "Options:",
    "  --output-dir <path>   Required. Directory to write output .md files.",
    "  --help                Print this usage message.",
    "",
    "Arguments:",
    "  investigations-dir    Optional. Defaults to ~/.claude/investigations/",
    "",
    "Output:",
    "  One .md file per closed investigation.",
    "  Summary printed to stderr: Exported: N, Skipped: N, Duplicates: N",
    "",
  ].join("\n"));
}

function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help")) {
    printUsage();
    process.exit(0);
  }

  // Parse --output-dir and optional positional investigations-dir
  let outputDir         = null;
  let investigationsDir = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--output-dir" && args[i + 1]) {
      outputDir = args[++i];
    } else if (!args[i].startsWith("--")) {
      investigationsDir = args[i];
    }
  }

  if (!outputDir) {
    process.stderr.write("Error: --output-dir <path> is required.\n\n");
    printUsage();
    process.exit(0);
    return;
  }

  if (!investigationsDir) {
    investigationsDir = path.join(os.homedir(), ".claude", "investigations");
  }

  const result = processInvestigations(investigationsDir, outputDir);
  process.stderr.write(`Exported: ${result.exported}, Skipped: ${result.skipped}, Duplicates: ${result.duplicates}\n`);
}

// Only run main() when executed directly (not when required by tests)
if (require.main === module) {
  main();
}

module.exports = {
  parseYamlFrontmatter,
  extractSection,
  extractPhase,
  extractQuestion,
  extractRepo,
  extractClosedDate,
  mapTypeToVaultType,
  buildTopics,
  descriptionFromAnswer,
  buildInvestigationNote,
  findFileInsensitive,
  processInvestigations,
};
