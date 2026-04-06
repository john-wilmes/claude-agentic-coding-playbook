#!/usr/bin/env node
/**
 * knowledge-to-vault.js — Transform knowledge-db JSONL export into arscontexta vault notes.
 *
 * Usage:
 *   node scripts/knowledge-to-vault.js --output-dir <path> [file.jsonl]
 *   cat export.jsonl | node scripts/knowledge-to-vault.js --output-dir <path>
 *
 * Input: JSONL on stdin or file path argument (one JSON object per line)
 * Output: Markdown files with YAML frontmatter in arscontexta format
 */

"use strict";

const fs   = require("fs");
const path = require("path");

// ─── Exported helpers ─────────────────────────────────────────────────────────

/**
 * Returns true if the confidence level should be included (medium or high).
 * Low confidence entries are skipped.
 */
function confidencePasses(confidence) {
  return confidence === "medium" || confidence === "high";
}

/**
 * Maps knowledge-db category to arscontexta type.
 */
function mapCategoryToType(category) {
  const map = {
    gotcha:   "tension",
    pattern:  "pattern",
    security: "insight",
    tip:      "preference",
  };
  return map[category] || "insight";
}

/**
 * Parse tags field which is a JSON string like '["git","ci"]'.
 * Returns array of strings (empty array on failure).
 */
function parseTags(tagsField) {
  if (!tagsField) return [];
  try {
    const parsed = JSON.parse(tagsField);
    if (Array.isArray(parsed)) return parsed.filter(t => typeof t === "string");
    return [];
  } catch {
    return [];
  }
}

/**
 * Extract first sentence from context_text for use as title.
 * Strips markdown formatting, capitalizes, removes trailing punctuation,
 * truncates to 100 chars.
 */
function titleFromContextText(contextText) {
  if (!contextText || !contextText.trim()) return "Unknown entry";

  // Split on first sentence boundary
  const raw = contextText.trim();
  let sentence = raw;

  // Split on `. ` (period + space) or newline
  const dotMatch  = raw.match(/^(.*?)\.\s/);
  const nlMatch   = raw.match(/^([^\n]+)/);

  if (dotMatch && nlMatch) {
    // Take the shorter of the two (whichever comes first)
    sentence = dotMatch[1].length <= nlMatch[1].length ? dotMatch[1] : nlMatch[1];
  } else if (dotMatch) {
    sentence = dotMatch[1];
  } else if (nlMatch) {
    sentence = nlMatch[1];
  }

  // Strip markdown backticks (inline code)
  sentence = sentence.replace(/`[^`]*`/g, match => match.slice(1, -1));

  // Strip bold/italic markers
  sentence = sentence.replace(/\*\*([^*]+)\*\*/g, "$1");
  sentence = sentence.replace(/\*([^*]+)\*/g, "$1");
  sentence = sentence.replace(/__([^_]+)__/g, "$1");
  sentence = sentence.replace(/_([^_]+)_/g, "$1");

  // Strip markdown links [text](url) → text
  sentence = sentence.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

  // Remove trailing punctuation
  sentence = sentence.replace(/[.!?,;:]+$/, "");

  // Capitalize first character
  sentence = sentence.trim();
  if (sentence.length > 0) {
    sentence = sentence[0].toUpperCase() + sentence.slice(1);
  }

  // Truncate to 100 chars
  if (sentence.length > 100) {
    sentence = sentence.slice(0, 100);
  }

  return sentence || "Unknown entry";
}

/**
 * Generate description from context_text: first sentence, ≤150 chars.
 * Appends ellipsis if truncated.
 */
function descriptionFromContextText(contextText) {
  if (!contextText || !contextText.trim()) return "Unknown entry";

  const raw = contextText.trim();
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
 * Build topic wiki links from tool and tags.
 * Returns string like "[[tool]] [[tag1]] [[tag2]]"
 */
function buildTopicLinks(tool, tags) {
  const items = [];
  if (tool && tool.trim()) items.push(`[[${tool.trim()}]]`);
  for (const tag of tags) {
    if (tag.trim()) items.push(`[[${tag.trim()}]]`);
  }
  return items.join(" ");
}

/**
 * Slugify a title for use as a filename.
 * Lowercase, non-alphanumeric → "-", max 80 chars, no leading/trailing dashes.
 */
function slugify(title) {
  let slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length > 80) slug = slug.slice(0, 80).replace(/-+$/, "");
  return slug || "unknown-entry";
}

/**
 * Build the full markdown note content for one entry.
 */
function buildNote(entry) {
  const tags       = parseTags(entry.tags);
  const type       = mapCategoryToType(entry.category);
  const title      = titleFromContextText(entry.context_text);
  const desc       = descriptionFromContextText(entry.context_text);
  const topics     = buildTopicLinks(entry.tool, tags);

  // YYYY-MM-DD from created timestamp
  let created = "";
  if (entry.created) {
    try {
      created = new Date(entry.created).toISOString().slice(0, 10);
    } catch {
      created = "";
    }
  }

  const lines = [];
  lines.push("---");
  lines.push(`description: "${desc}"`);
  lines.push(`type: ${type}`);
  if (created) lines.push(`created: ${created}`);
  lines.push(`topics: ${topics}`);
  lines.push("---");
  lines.push("");
  lines.push(`# ${title}`);
  lines.push("");

  const body = (entry.context_text || "").trim();
  if (body) {
    lines.push(body);
    lines.push("");
  }

  if (entry.fix_text && entry.fix_text.trim()) {
    lines.push("## Fix");
    lines.push("");
    lines.push(entry.fix_text.trim());
    lines.push("");
  }

  if (entry.evidence_text && entry.evidence_text.trim()) {
    lines.push("## Evidence");
    lines.push("");
    lines.push(entry.evidence_text.trim());
    lines.push("");
  }

  lines.push("---");
  lines.push(`*Source: ${entry.source_project || "unknown"} · Confidence: ${entry.confidence || "unknown"}*`);
  lines.push("");

  return lines.join("\n");
}

/**
 * Load existing slugs from output directory (filenames without .md extension).
 * Returns a Set of slug strings.
 */
function loadExistingSlugs(outputDir) {
  const existing = new Set();
  if (!fs.existsSync(outputDir)) return existing;
  try {
    const files = fs.readdirSync(outputDir);
    for (const f of files) {
      if (f.endsWith(".md")) existing.add(f.slice(0, -3));
    }
  } catch { /* ignore */ }
  return existing;
}

/**
 * Process JSONL lines and write output files.
 * Returns { exported, skipped, duplicates }.
 */
function processLines(lines, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });

  const existingSlugs = loadExistingSlugs(outputDir);
  const seenSlugs     = new Set();

  let exported   = 0;
  let skipped    = 0;
  let duplicates = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      skipped++;
      continue;
    }

    // Skip low confidence
    if (!confidencePasses(entry.confidence)) {
      skipped++;
      continue;
    }

    const title = titleFromContextText(entry.context_text);
    const slug  = slugify(title);

    // Check for duplicates: already on disk or seen in this run
    if (existingSlugs.has(slug) || seenSlugs.has(slug)) {
      duplicates++;
      continue;
    }

    seenSlugs.add(slug);

    const content  = buildNote(entry);
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
    "Usage: knowledge-to-vault.js --output-dir <path> [file.jsonl]",
    "",
    "Transform knowledge-db JSONL export into arscontexta vault notes.",
    "",
    "Options:",
    "  --output-dir <path>   Required. Directory to write output .md files.",
    "  --help                Print this usage message.",
    "",
    "Input:",
    "  Pass a file path as the last argument, or pipe JSONL to stdin.",
    "  Each line must be a JSON object matching the knowledge-db export format.",
    "",
    "Output:",
    "  One .md file per entry (skipping low-confidence entries).",
    "  Summary printed to stderr: Exported: N, Skipped: N, Duplicates: N",
    "",
  ].join("\n"));
}

function main() {
  const args      = process.argv.slice(2);

  if (args.includes("--help")) {
    printUsage();
    process.exit(0);
  }

  // Parse --output-dir
  let outputDir = null;
  let inputFile = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--output-dir" && args[i + 1]) {
      outputDir = args[++i];
    } else if (!args[i].startsWith("--")) {
      inputFile = args[i];
    }
  }

  if (!outputDir) {
    process.stderr.write("Error: --output-dir <path> is required.\n\n");
    printUsage();
    process.exit(0);
    return;
  }

  let input = "";

  if (inputFile) {
    try {
      input = fs.readFileSync(inputFile, "utf8");
    } catch (err) {
      process.stderr.write(`Error reading file: ${err.message}\n`);
      process.exit(0);
      return;
    }
    const lines  = input.split("\n");
    const result = processLines(lines, outputDir);
    process.stderr.write(`Exported: ${result.exported}, Skipped: ${result.skipped}, Duplicates: ${result.duplicates}\n`);
  } else {
    // Read from stdin
    const chunks = [];
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => chunks.push(chunk));
    process.stdin.on("end", () => {
      const lines  = chunks.join("").split("\n");
      const result = processLines(lines, outputDir);
      process.stderr.write(`Exported: ${result.exported}, Skipped: ${result.skipped}, Duplicates: ${result.duplicates}\n`);
    });
    process.stdin.on("error", err => {
      process.stderr.write(`Error reading stdin: ${err.message}\n`);
      process.exit(0);
    });
  }
}

// Only run main() when executed directly (not when required by tests)
if (require.main === module) {
  main();
}

module.exports = {
  confidencePasses,
  mapCategoryToType,
  titleFromContextText,
  descriptionFromContextText,
  buildTopicLinks,
  slugify,
  parseTags,
  buildNote,
  processLines,
  loadExistingSlugs,
};
