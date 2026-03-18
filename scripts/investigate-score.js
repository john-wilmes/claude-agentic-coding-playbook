#!/usr/bin/env node
/**
 * investigate-score.js — Score an investigation against quality metrics and
 * optional ground-truth JSON.
 *
 * Usage:
 *   node scripts/investigate-score.js <investigation-dir>
 *   node scripts/investigate-score.js <investigation-dir> --ground-truth <json-path>
 *   node scripts/investigate-score.js <investigation-dir> --ground-truth <json-path> --repo <repo-dir>
 *
 * Output:
 *   Writes METRICS.json to <investigation-dir>
 *   Prints summary to stdout
 *
 * Exit codes:
 *   0 = metrics computed (even if quality is low)
 *   1 = fatal error (missing dir, bad args)
 */

"use strict";

const fs   = require("fs");
const path = require("path");

// ─── Argument parsing ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === "--help") {
  console.error(
    "Usage: investigate-score.js <investigation-dir> [--ground-truth <json>] [--repo <dir>]"
  );
  process.exit(1);
}

const invDir = path.resolve(args[0]);
let groundTruthPath = null;
let repoDir = null;

for (let i = 1; i < args.length; i++) {
  if (args[i] === "--ground-truth" && args[i + 1]) { groundTruthPath = path.resolve(args[++i]); }
  if (args[i] === "--repo" && args[i + 1])          { repoDir = path.resolve(args[++i]); }
}

if (!fs.existsSync(invDir)) {
  console.error(`Investigation directory not found: ${invDir}`);
  process.exit(1);
}

// ─── File utilities ───────────────────────────────────────────────────────────

function readFile(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
}

function listMdFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith(".md"));
}

// ─── Metric: required sections ────────────────────────────────────────────────

const REQUIRED_SECTIONS = ["## Answer", "## Evidence Summary", "## Implications"];

function computeStructure(findings) {
  if (!findings) {
    return { score: 0, present: 0, total: REQUIRED_SECTIONS.length, missing: ["FINDINGS.md not found"] };
  }
  const missing = REQUIRED_SECTIONS.filter(s => !findings.includes(s));
  const present = REQUIRED_SECTIONS.length - missing.length;
  return {
    score: Math.round((present / REQUIRED_SECTIONS.length) * 100) / 100,
    present,
    total: REQUIRED_SECTIONS.length,
    missing,
  };
}

// ─── Metric: citation completeness ───────────────────────────────────────────
// Looks for evidence ID patterns: "001", "E001", "R03-ARCH-001", "Evidence 003"

const EVIDENCE_ID_RE = /\b(?:Evidence\s+)?\d{3}\b|R\d{2}-[A-Z]+-\d{3}/g;

function computeCitationCompleteness(findings) {
  if (!findings) return { score: null, cited: 0, total: 0, reason: "FINDINGS.md not found" };

  // Only scan Answer and Implications (not the Evidence Summary table itself)
  const answerBlock     = (findings.match(/## Answer\n([\s\S]*?)(?=\n##|$)/) || [])[1] || "";
  const implBlock       = (findings.match(/## Implications\n([\s\S]*?)(?=\n##|$)/) || [])[1] || "";
  const body            = `${answerBlock}\n${implBlock}`;

  // Rough sentence split on terminal punctuation
  const sentences = body
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 15);  // ignore very short fragments

  if (sentences.length === 0) return { score: 0, cited: 0, total: 0, reason: "No substantive sentences found" };

  const cited = sentences.filter(s => { EVIDENCE_ID_RE.lastIndex = 0; return EVIDENCE_ID_RE.test(s); }).length;
  EVIDENCE_ID_RE.lastIndex = 0;

  return {
    score: Math.round((cited / sentences.length) * 100) / 100,
    cited,
    total: sentences.length,
  };
}

// ─── Metric: chain integrity ──────────────────────────────────────────────────

const SOURCE_PLACEHOLDER = "{file:line, URL, log entry, or command output}";

function computeChainIntegrity(evidenceDir, repoRoot) {
  const files = listMdFiles(evidenceDir);
  if (files.length === 0) return { score: null, verified: 0, total: 0, broken: [], reason: "No evidence files" };

  const broken     = [];
  const unresolved = [];
  let verified = 0;

  for (const file of files) {
    const content = readFile(path.join(evidenceDir, file));
    if (!content) continue;

    const sourceMatch = content.match(/\*\*Source:?\*\*:?[ \t]*([^\n]+)/i);
    const source      = sourceMatch?.[1]?.trim();

    if (!source || source === SOURCE_PLACEHOLDER) {
      broken.push(file);
      continue;
    }

    // Optional: check that any "file.ts:NN" reference resolves in repo
    if (repoRoot) {
      const fileRef = source.match(/^([^:\s]+\.\w+):/);
      if (fileRef) {
        const candidate = path.join(repoRoot, fileRef[1]);
        if (!fs.existsSync(candidate)) {
          unresolved.push({ file, source: fileRef[1] });
        }
      }
    }

    verified++;
  }

  return {
    score:      Math.round((verified / files.length) * 100) / 100,
    verified,
    total:      files.length,
    broken,
    unresolved, // only populated with --repo
  };
}

// ─── Metric: evidence utilization ────────────────────────────────────────────

function computeUtilization(evidenceDir, findings) {
  const files = listMdFiles(evidenceDir);
  if (files.length === 0) return { score: null, total: 0, cited: 0, reason: "No evidence files" };

  // Collect all evidence IDs that appear in FINDINGS.md
  const cited = new Set();
  if (findings) {
    EVIDENCE_ID_RE.lastIndex = 0;
    let m;
    while ((m = EVIDENCE_ID_RE.exec(findings)) !== null) cited.add(m[0]);
    EVIDENCE_ID_RE.lastIndex = 0;
  }

  return {
    score:       Math.round((cited.size / files.length) * 100) / 100,
    total:       files.length,
    cited:       cited.size,
    cited_ids:   [...cited],
  };
}

// ─── Null control ─────────────────────────────────────────────────────────────
// Flags investigations that look like they just parroted symptoms.

function detectNull(structure, citationCompleteness, utilization) {
  const warnings = [];

  if (utilization.total === 0)                             warnings.push("No evidence files collected");
  if (citationCompleteness.score === 0)                    warnings.push("Answer section has zero evidence citations");
  if (structure.missing.includes("## Answer"))             warnings.push("Missing Answer section");
  if (utilization.total > 0 && utilization.cited === 0)   warnings.push("Evidence collected but none cited in findings");

  return { is_likely_null: warnings.length >= 2, warnings };
}

// ─── Ground truth scoring ─────────────────────────────────────────────────────
//
// Scoring rubric (0–4):
//   4 = exact (correct file + line + mechanism confirmed)
//   3 = mechanism (correct mechanism, location may be approximate)
//   2 = subsystem (correct subsystem, mechanism not identified)
//   1 = symptom (correct symptom characterization, wrong root cause)
//   0 = miss
//
// Anti-patterns cap the score at 2.

const SCORE_LABELS = { 0: "miss", 1: "symptom", 2: "subsystem", 3: "mechanism", 4: "exact" };

function computeGroundTruth(findings, gt) {
  if (!findings || !gt) return null;

  const text = findings.toLowerCase();

  // Check anti-patterns
  let antiHit = null;
  for (const ap of (gt.anti_patterns || [])) {
    if (!ap.pattern) continue;
    if (new RegExp(ap.pattern, "i").test(text)) {
      antiHit = ap.description || ap.pattern;
      break;
    }
  }

  // Score by highest matched required_finding
  let maxLevel  = 0;
  const matched = [];
  const missed  = [];

  for (const rf of (gt.required_findings || [])) {
    if (!rf.pattern) continue;
    if (new RegExp(rf.pattern, "i").test(text)) {
      const level = rf.score_level || 1;
      matched.push({ level, description: rf.description || rf.pattern });
      if (level > maxLevel) maxLevel = level;
    } else {
      missed.push({ description: rf.description || rf.pattern });
    }
  }

  const score = antiHit && maxLevel > 2 ? 2 : maxLevel;

  return {
    score,
    label:           SCORE_LABELS[score] || "unknown",
    anti_pattern_hit: antiHit,
    matched,
    missed,
  };
}

// ─── Assemble metrics ─────────────────────────────────────────────────────────

const findingsPath = path.join(invDir, "FINDINGS.md");
const evidenceDir  = path.join(invDir, "EVIDENCE");
const findings     = readFile(findingsPath);

const structure            = computeStructure(findings);
const citationCompleteness = computeCitationCompleteness(findings);
const chainIntegrity       = computeChainIntegrity(evidenceDir, repoDir);
const utilization          = computeUtilization(evidenceDir, findings);
const nullControl          = detectNull(structure, citationCompleteness, utilization);

const metrics = {
  investigation_dir:    invDir,
  timestamp:            new Date().toISOString(),
  structure,
  citation_completeness: citationCompleteness,
  chain_integrity:      chainIntegrity,
  utilization,
  null_control:         nullControl,
};

// Optional ground truth scoring
if (groundTruthPath) {
  if (!fs.existsSync(groundTruthPath)) {
    console.error(`Ground truth file not found: ${groundTruthPath}`);
    process.exit(1);
  }
  let gt;
  try {
    gt = JSON.parse(readFile(groundTruthPath));
  } catch (e) {
    console.error(`Invalid JSON in ground truth file: ${groundTruthPath}`);
    process.exit(1);
  }
  metrics.ground_truth_id    = gt.investigation_id || path.basename(groundTruthPath, ".json");
  metrics.ground_truth_score = computeGroundTruth(findings, gt);
}

// ─── Write METRICS.json ───────────────────────────────────────────────────────

const metricsPath = path.join(invDir, "METRICS.json");
fs.writeFileSync(metricsPath, JSON.stringify(metrics, null, 2));

// ─── Console summary ──────────────────────────────────────────────────────────

const HR = "─".repeat(60);

function pct(score) { return score == null ? "N/A" : `${Math.round(score * 100)}%`; }
function flag(score, good = 0.7, ok = 0.4) {
  if (score == null) return "";
  return score >= good ? "✓" : score >= ok ? "~" : "✗";
}

console.log(`\n${HR}`);
console.log(`Investigation Scorer: ${path.basename(invDir)}`);
console.log(HR);

console.log(`\nStructure        : ${pct(structure.score)} ${flag(structure.score)}`);
if (structure.missing.length) console.log(`  Missing: ${structure.missing.join(", ")}`);

console.log(`Citation complete: ${pct(citationCompleteness.score)} ${flag(citationCompleteness.score)}`);
if (citationCompleteness.total > 0)
  console.log(`  ${citationCompleteness.cited}/${citationCompleteness.total} sentences cite evidence`);

console.log(`Chain integrity  : ${pct(chainIntegrity.score)} ${flag(chainIntegrity.score)}`);
if (chainIntegrity.broken?.length)
  console.log(`  Missing source: ${chainIntegrity.broken.join(", ")}`);
if (chainIntegrity.unresolved?.length)
  console.log(`  Unresolved file refs: ${chainIntegrity.unresolved.map(u => u.source).join(", ")}`);

console.log(`Utilization      : ${pct(utilization.score)} ${flag(utilization.score)}`);
console.log(`  Evidence: ${utilization.total} files, ${utilization.cited} cited`);

if (nullControl.is_likely_null) {
  console.log("\n⚠  NULL CONTROL WARNING: investigation may contain no real analysis");
  nullControl.warnings.forEach(w => console.log(`  - ${w}`));
}

if (metrics.ground_truth_score) {
  const gt = metrics.ground_truth_score;
  const scoreFlag = ["✗", "~", "~", "~", "✓"][gt.score] || "?";
  console.log(`\nGround truth [${metrics.ground_truth_id}]: ${gt.score}/4 — ${gt.label} ${scoreFlag}`);
  if (gt.anti_pattern_hit) console.log(`  ⚠ Anti-pattern triggered: ${gt.anti_pattern_hit}`);
  if (gt.matched.length)   console.log(`  Matched: ${gt.matched.map(m => `L${m.level}`).join(", ")}`);
  if (gt.missed.length)    console.log(`  Missed : ${gt.missed.map(m => m.description).join("; ")}`);
}

console.log(`\n${HR}`);
console.log(`Metrics written: ${metricsPath}`);
console.log(HR);
