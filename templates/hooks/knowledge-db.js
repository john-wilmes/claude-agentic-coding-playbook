#!/usr/bin/env node
// Central SQLite knowledge store for agentic coding playbook.
// Uses node:sqlite (DatabaseSync) — requires Node 22.5+.
//
// All exported functions are non-throwing (try/catch, return defaults on error).
// JSON stdout for CLI interface. Exit 0 always.

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync, spawnSync } = require("child_process");

let DatabaseSync;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch (err) {
  // Node < 22.5 or sqlite not available — degrade gracefully
  DatabaseSync = null;
}

// Detect FTS5 support at module load time (node:sqlite may lack it)
let hasFts5 = false;
if (DatabaseSync) {
  let _probe;
  try {
    _probe = new DatabaseSync(":memory:");
    _probe.exec("CREATE VIRTUAL TABLE _fts5_probe USING fts5(x);");
    hasFts5 = true;
  } catch {
    hasFts5 = false;
  } finally {
    try { if (_probe) _probe.close(); } catch {}
  }
}

const DEFAULT_DB_PATH = path.join(os.homedir(), ".claude", "knowledge", "knowledge.db");

// ─── Schema ──────────────────────────────────────────────────────────────────

const CORE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS entries (
  id             TEXT PRIMARY KEY,
  created        TEXT NOT NULL,
  author         TEXT DEFAULT '',
  source_project TEXT DEFAULT '',
  tool           TEXT DEFAULT '',
  category       TEXT DEFAULT '',
  tags           TEXT DEFAULT '[]',
  confidence     TEXT DEFAULT 'medium',
  visibility     TEXT DEFAULT 'global',
  verified_at    TEXT DEFAULT '',
  status         TEXT DEFAULT 'active',
  archived_at    TEXT,
  context_text   TEXT DEFAULT '',
  fix_text       TEXT DEFAULT '',
  evidence_text  TEXT DEFAULT '',
  repo_url       TEXT DEFAULT '',
  commit_sha     TEXT DEFAULT '',
  branch         TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS staged_candidates (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  trigger         TEXT DEFAULT '',
  tool            TEXT DEFAULT '',
  category        TEXT DEFAULT '',
  confidence      TEXT DEFAULT 'medium',
  summary         TEXT DEFAULT '',
  context_snippet TEXT DEFAULT '',
  source_project  TEXT DEFAULT '',
  cwd             TEXT DEFAULT ''
);
`;

const FTS5_SCHEMA_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
  entry_id UNINDEXED,
  context_text, fix_text, evidence_text, tags,
  content=entries, content_rowid=rowid,
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
  INSERT INTO knowledge_fts(rowid, entry_id, context_text, fix_text, evidence_text, tags)
  VALUES (new.rowid, new.id, new.context_text, new.fix_text, new.evidence_text, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, entry_id, context_text, fix_text, evidence_text, tags)
  VALUES ('delete', old.rowid, old.id, old.context_text, old.fix_text, old.evidence_text, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, entry_id, context_text, fix_text, evidence_text, tags)
  VALUES ('delete', old.rowid, old.id, old.context_text, old.fix_text, old.evidence_text, old.tags);
  INSERT INTO knowledge_fts(rowid, entry_id, context_text, fix_text, evidence_text, tags)
  VALUES (new.rowid, new.id, new.context_text, new.fix_text, new.evidence_text, new.tags);
END;
`;

// ─── openDb ──────────────────────────────────────────────────────────────────

/**
 * Open (or create) the knowledge database, run PRAGMAs, create schema.
 * Also performs one-time migration from filesystem entries if they exist.
 *
 * @param {string} [dbPath] - Defaults to DEFAULT_DB_PATH. Use ':memory:' for tests.
 * @returns {object|null} DatabaseSync instance, or null if sqlite unavailable.
 */
function openDb(dbPath) {
  if (!DatabaseSync) return null;
  try {
    const resolvedPath = dbPath || DEFAULT_DB_PATH;

    // Ensure parent directory exists (skip for :memory:)
    if (resolvedPath !== ":memory:") {
      fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    }

    const db = new DatabaseSync(resolvedPath);

    // PRAGMAs
    db.exec("PRAGMA journal_mode=WAL;");
    db.exec("PRAGMA synchronous=NORMAL;");
    db.exec("PRAGMA foreign_keys=ON;");

    // Create core schema (idempotent — uses IF NOT EXISTS)
    db.exec(CORE_SCHEMA_SQL);

    // FTS5 is optional — node:sqlite may not include it
    try { db.exec(FTS5_SCHEMA_SQL); } catch { /* FTS5 unavailable, search falls back to full scan */ }

    // Schema migration: add access tracking columns if they don't exist yet
    try { db.exec("ALTER TABLE entries ADD COLUMN last_accessed TEXT"); } catch {}
    try { db.exec("ALTER TABLE entries ADD COLUMN access_count INTEGER DEFAULT 0"); } catch {}

    // One-time migration from filesystem entries
    if (resolvedPath !== ":memory:") {
      _migrateIfNeeded(db);
    }

    return db;
  } catch {
    return null;
  }
}

// ─── insertEntry ─────────────────────────────────────────────────────────────

/**
 * INSERT OR REPLACE an entry into the entries table.
 *
 * @param {object} db - DatabaseSync instance
 * @param {object} entry - Entry object matching the entries schema
 */
function insertEntry(db, entry) {
  try {
    if (!db || !entry || !entry.id) return;
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO entries
        (id, created, author, source_project, tool, category, tags, confidence,
         visibility, verified_at, status, archived_at, context_text, fix_text,
         evidence_text, repo_url, commit_sha, branch)
      VALUES
        ($id, $created, $author, $source_project, $tool, $category, $tags, $confidence,
         $visibility, $verified_at, $status, $archived_at, $context_text, $fix_text,
         $evidence_text, $repo_url, $commit_sha, $branch)
    `);
    stmt.run({
      $id:             entry.id,
      $created:        entry.created || new Date().toISOString(),
      $author:         entry.author || "",
      $source_project: entry.source_project || "",
      $tool:           entry.tool || "",
      $category:       entry.category || "",
      $tags:           Array.isArray(entry.tags) ? JSON.stringify(entry.tags) : (entry.tags || "[]"),
      $confidence:     entry.confidence || "medium",
      $visibility:     entry.visibility || "global",
      $verified_at:    entry.verified_at || "",
      $status:         entry.status || "active",
      $archived_at:    entry.archived_at || null,
      $context_text:   entry.context_text || "",
      $fix_text:       entry.fix_text || "",
      $evidence_text:  entry.evidence_text || "",
      $repo_url:       entry.repo_url || "",
      $commit_sha:     entry.commit_sha || "",
      $branch:         entry.branch || "",
    });
  } catch {
    // Non-throwing
  }
}

// ─── queryRelevant ───────────────────────────────────────────────────────────

/**
 * FTS5 search + metadata hybrid scoring + staleness demotion.
 *
 * @param {object} db - DatabaseSync instance
 * @param {object} opts
 * @param {string|string[]} [opts.projectTool] - Tool(s) in use by the current project
 * @param {string} [opts.sourceProject] - Current project name
 * @param {string[]} [opts.queryTerms] - Search terms
 * @param {string} [opts.cwd] - Current working directory
 * @param {string} [opts.repoUrl] - Current repo URL (for staleness check)
 * @param {number} [limit=5] - Max results to return
 * @returns {{ results: object[], status: "ok"|"error", error?: string }}
 */
function queryRelevant(db, opts = {}, limit = 5) {
  try {
    if (!db) return { results: [], status: "error", error: "database unavailable" };

    const projectTools = Array.isArray(opts.projectTool)
      ? opts.projectTool.map(t => t.toLowerCase())
      : (opts.projectTool ? [opts.projectTool.toLowerCase()] : []);
    const sourceProject = (opts.sourceProject || "").toLowerCase();
    const queryTerms = Array.isArray(opts.queryTerms) ? opts.queryTerms.filter(Boolean) : [];
    const cwd = opts.cwd || process.cwd();

    // Detect current repo URL for staleness check
    let currentRepoUrl = opts.repoUrl || "";
    if (!currentRepoUrl) {
      try {
        currentRepoUrl = execSync("git remote get-url origin", {
          cwd,
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 2000,
          encoding: "utf8",
        }).trim();
      } catch {}
    }

    let rows;

    if (queryTerms.length > 0) {
      // Sanitize query for FTS5: remove special characters that FTS5 interprets
      const safeQuery = queryTerms
        .map(t => t.replace(/["':*^()[\]{}\\]/g, " ").trim())
        .filter(Boolean)
        .join(" ");

      if (safeQuery.trim()) {
        try {
          const ftsStmt = db.prepare(`
            SELECT e.*, knowledge_fts.rank AS fts_rank
            FROM knowledge_fts
            JOIN entries e ON e.id = knowledge_fts.entry_id
            WHERE knowledge_fts MATCH $query
              AND e.status = 'active'
          `);
          rows = ftsStmt.all({ $query: safeQuery });
        } catch {
          // FTS query failed (e.g. bad query) — fall back to all active entries
          rows = null;
        }
      }
    }

    if (!rows) {
      // No FTS query or it failed — return all active entries
      const allStmt = db.prepare(`SELECT * FROM entries WHERE status = 'active'`);
      rows = allStmt.all();
      // Add dummy fts_rank
      for (const r of rows) r.fts_rank = 0;
    }

    // Score each entry
    const scored = rows.map(row => {
      let metaScore = 0;
      const entryTool = (row.tool || "").toLowerCase();
      const entryCategory = (row.category || "").toLowerCase();
      const entryConfidence = (row.confidence || "").toLowerCase();
      const entrySourceProject = (row.source_project || "").toLowerCase();

      // Parse tags
      let tags = [];
      try { tags = JSON.parse(row.tags || "[]"); } catch {}
      const lcTags = tags.map(t => String(t).toLowerCase());

      // Tool match: +10
      if (projectTools.length > 0 && projectTools.includes(entryTool)) {
        metaScore += 10;
      }

      // Tag overlap: +3 per matching tag
      for (const tag of lcTags) {
        if (projectTools.includes(tag)) metaScore += 3;
      }

      // Category boosts
      if (entryCategory === "security") metaScore += 2;

      // Confidence boost
      if (entryConfidence === "high") metaScore += 1;

      // Source project mismatch penalty
      if (sourceProject && entrySourceProject && entrySourceProject !== sourceProject) {
        metaScore -= 3;
      }

      // FTS rank: negative in FTS5 (more negative = better). Use abs().
      const ftsScore = row.fts_rank ? Math.abs(row.fts_rank) : 0;

      let combined = metaScore + ftsScore * 0.5;

      // Staleness penalty: if entry has repo_url matching current repo and commit_sha,
      // penalize by -1 per 100 commits ahead (capped at -5)
      if (
        currentRepoUrl &&
        row.repo_url &&
        row.commit_sha &&
        row.repo_url === currentRepoUrl
      ) {
        try {
          const result = spawnSync(
            "git",
            ["rev-list", "--count", `${row.commit_sha}..HEAD`],
            { cwd, stdio: ["pipe", "pipe", "pipe"], timeout: 2000, encoding: "utf8" }
          );
          if (result.status === 0) {
            const commitCount = parseInt(result.stdout.trim(), 10);
            if (!isNaN(commitCount) && commitCount > 0) {
              const penalty = Math.min(5, Math.floor(commitCount / 100));
              combined -= penalty;
            }
          }
        } catch {}
      }

      // Access-based staleness penalty: entries not accessed in 14+ days get a small penalty
      // New entries (access_count === 0 or null) are not penalized — they're fresh captures
      if (row.access_count && row.access_count > 0 && row.last_accessed) {
        try {
          const lastAccessedMs = new Date(row.last_accessed).getTime();
          const daysSinceAccess = (Date.now() - lastAccessedMs) / (1000 * 60 * 60 * 24);
          if (daysSinceAccess > 14) {
            combined -= 1;
          }
          if (daysSinceAccess > 30) {
            combined -= 1; // additional -1 for very stale entries (total -2)
          }
        } catch {}
      }

      return { ...row, _combined: combined };
    });

    // Sort descending by combined score, take top limit
    scored.sort((a, b) => b._combined - a._combined);
    const results = scored.slice(0, limit);

    // Clean up internal field
    for (const r of results) delete r._combined;

    // Update access tracking for returned entries
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const updateStmt = db.prepare(
      `UPDATE entries SET last_accessed = $last_accessed, access_count = COALESCE(access_count, 0) + 1 WHERE id = $id`
    );
    for (const entry of results) {
      try {
        updateStmt.run({ $last_accessed: today, $id: entry.id });
      } catch {}
    }

    return { results, status: "ok" };
  } catch (e) {
    return { results: [], status: "error", error: (e && e.message) || "query failed" };
  }
}

// ─── captureProvenance ───────────────────────────────────────────────────────

/**
 * Auto-detect repo_url, commit_sha, branch from git in cwd.
 *
 * @param {string} [cwd] - Directory to run git in. Defaults to process.cwd().
 * @returns {{ repo_url: string, commit_sha: string, branch: string }}
 */
function captureProvenance(cwd) {
  const defaults = { repo_url: "", commit_sha: "", branch: "" };
  try {
    const dir = cwd || process.cwd();

    const repoUrl = spawnSync("git", ["remote", "get-url", "origin"], {
      cwd: dir, stdio: ["pipe", "pipe", "pipe"], timeout: 2000, encoding: "utf8",
    });
    if (repoUrl.status !== 0) return defaults;

    const sha = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: dir, stdio: ["pipe", "pipe", "pipe"], timeout: 2000, encoding: "utf8",
    });

    const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: dir, stdio: ["pipe", "pipe", "pipe"], timeout: 2000, encoding: "utf8",
    });

    return {
      repo_url:   (repoUrl.stdout || "").trim(),
      commit_sha: sha.status === 0 ? (sha.stdout || "").trim() : "",
      branch:     branch.status === 0 ? (branch.stdout || "").trim() : "",
    };
  } catch {
    return { repo_url: "", commit_sha: "", branch: "" };
  }
}

// ─── stageCandidate ──────────────────────────────────────────────────────────

/**
 * INSERT a staged candidate into staged_candidates table.
 *
 * @param {object} db
 * @param {object} candidate
 */
function stageCandidate(db, candidate) {
  try {
    if (!db || !candidate) return;
    const stmt = db.prepare(`
      INSERT INTO staged_candidates
        (ts, session_id, trigger, tool, category, confidence, summary, context_snippet, source_project, cwd)
      VALUES
        ($ts, $session_id, $trigger, $tool, $category, $confidence, $summary, $context_snippet, $source_project, $cwd)
    `);
    stmt.run({
      $ts:              new Date().toISOString(),
      $session_id:      candidate.session_id || "",
      $trigger:         candidate.trigger || "",
      $tool:            candidate.tool || "",
      $category:        candidate.category || "",
      $confidence:      candidate.confidence || "medium",
      $summary:         candidate.summary || "",
      $context_snippet: candidate.context_snippet || "",
      $source_project:  candidate.source_project || "",
      $cwd:             candidate.cwd || "",
    });
  } catch {
    // Non-throwing
  }
}

// ─── readStagedCandidates ────────────────────────────────────────────────────

/**
 * Return all staged candidates for a session.
 *
 * @param {object} db
 * @param {string} sessionId
 * @returns {object[]}
 */
function readStagedCandidates(db, sessionId) {
  try {
    if (!db) return [];
    const stmt = db.prepare(`SELECT * FROM staged_candidates WHERE session_id = $session_id`);
    return stmt.all({ $session_id: sessionId });
  } catch {
    return [];
  }
}

// ─── clearStagedCandidates ───────────────────────────────────────────────────

/**
 * Delete all staged candidates for a session.
 *
 * @param {object} db
 * @param {string} sessionId
 */
function clearStagedCandidates(db, sessionId) {
  try {
    if (!db) return;
    const stmt = db.prepare(`DELETE FROM staged_candidates WHERE session_id = $session_id`);
    stmt.run({ $session_id: sessionId });
  } catch {
    // Non-throwing
  }
}

// ─── pruneStagedRows ─────────────────────────────────────────────────────────

/**
 * Delete staged candidates older than maxAgeDays.
 *
 * @param {object} db
 * @param {number} maxAgeDays
 */
function pruneStagedRows(db, maxAgeDays) {
  try {
    if (!db) return;
    const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const cutoff = new Date(cutoffMs).toISOString();
    const stmt = db.prepare(`DELETE FROM staged_candidates WHERE ts < $cutoff`);
    stmt.run({ $cutoff: cutoff });
  } catch {
    // Non-throwing
  }
}

// ─── archiveEntry ────────────────────────────────────────────────────────────

/**
 * Set status='archived' and archived_at=now for the given entry id.
 *
 * @param {object} db
 * @param {string} id
 */
function archiveEntry(db, id) {
  try {
    if (!db || !id) return;
    const stmt = db.prepare(`
      UPDATE entries SET status = 'archived', archived_at = $archived_at WHERE id = $id
    `);
    stmt.run({ $archived_at: new Date().toISOString(), $id: id });
  } catch {
    // Non-throwing
  }
}

// ─── archiveStale ────────────────────────────────────────────────────────────

/**
 * Archive entries that have not been accessed in daysThreshold or more days.
 * Uses last_accessed if present; falls back to created column if last_accessed is NULL.
 * Only archives active entries.
 *
 * @param {object} db - DatabaseSync instance
 * @param {number} [daysThreshold=30] - Number of days of inactivity before archiving
 * @returns {number} Count of archived entries
 */
function archiveStale(db, daysThreshold = 30) {
  try {
    if (!db) return 0;
    const cutoffMs = Date.now() - daysThreshold * 24 * 60 * 60 * 1000;
    const cutoff = new Date(cutoffMs).toISOString().slice(0, 10); // YYYY-MM-DD
    const now = new Date().toISOString();

    // Find active entries where last_accessed < cutoff, OR last_accessed is NULL
    // and created < cutoff (ISO date string comparison works for both date and datetime)
    const findStmt = db.prepare(`
      SELECT id FROM entries
      WHERE status = 'active'
        AND (
          (last_accessed IS NOT NULL AND last_accessed < $cutoff)
          OR
          (last_accessed IS NULL AND created < $cutoff)
        )
    `);
    const staleRows = findStmt.all({ $cutoff: cutoff });

    if (staleRows.length === 0) return 0;

    const archiveStmt = db.prepare(`
      UPDATE entries SET status = 'archived', archived_at = $archived_at WHERE id = $id
    `);
    for (const row of staleRows) {
      try {
        archiveStmt.run({ $archived_at: now, $id: row.id });
      } catch {}
    }

    return staleRows.length;
  } catch {
    return 0;
  }
}

// ─── exportToJsonl ───────────────────────────────────────────────────────────

/**
 * Write active entries as JSONL to outPath (or stdout if outPath is null/'-').
 *
 * @param {object} db
 * @param {string|null} [outPath]
 */
function exportToJsonl(db, outPath) {
  try {
    if (!db) return;
    const stmt = db.prepare(`SELECT * FROM entries WHERE status = 'active'`);
    const rows = stmt.all();
    const lines = rows.map(r => JSON.stringify(r)).join("\n");
    if (!outPath || outPath === "-") {
      process.stdout.write(lines + "\n");
    } else {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, lines + "\n", "utf8");
    }
  } catch {
    // Non-throwing
  }
}

// ─── importFromJsonl ─────────────────────────────────────────────────────────

/**
 * Read JSONL from inPath and upsert each entry into db.
 *
 * @param {object} db
 * @param {string} inPath
 */
function importFromJsonl(db, inPath) {
  try {
    if (!db || !inPath) return;
    const raw = fs.readFileSync(inPath, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed);
        insertEntry(db, entry);
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    // Non-throwing
  }
}

// ─── migrateFromFilesystem ───────────────────────────────────────────────────

/**
 * One-time import of existing entry.md files from filesystem.
 * Parses YAML frontmatter + ## Context / ## Fix / ## Evidence sections.
 *
 * @param {object} db
 * @param {string} entriesDir - Path to ~/.claude/knowledge/entries/
 */
function migrateFromFilesystem(db, entriesDir) {
  try {
    if (!db || !entriesDir) return;
    if (!fs.existsSync(entriesDir)) return;

    const dirs = fs.readdirSync(entriesDir);
    for (const dir of dirs) {
      const entryPath = path.join(entriesDir, dir, "entry.md");
      try {
        if (!fs.existsSync(entryPath)) continue;
        const content = fs.readFileSync(entryPath, "utf8");
        const entry = _parseEntryMd(content, dir);
        if (entry) insertEntry(db, entry);
      } catch {
        // Skip unparseable entries
      }
    }
  } catch {
    // Non-throwing
  }
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Parse an entry.md file into an entry object.
 *
 * @param {string} content - Raw file content
 * @param {string} dirName - Directory name used as fallback id
 * @returns {object|null}
 */
function _parseEntryMd(content, dirName) {
  try {
    // Extract YAML frontmatter between --- markers
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return null;

    const fm = {};
    for (const line of fmMatch[1].split("\n")) {
      const kv = line.match(/^(\w+):\s*(.+)/);
      if (!kv) continue;
      let val = kv[2].trim();
      // Parse inline arrays: ["a", "b"] or [a, b]
      if (val.startsWith("[") && val.endsWith("]")) {
        val = val.slice(1, -1).split(",").map(s => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
      } else {
        // Strip surrounding quotes
        val = val.replace(/^["']|["']$/g, "");
      }
      fm[kv[1]] = val;
    }

    // Extract markdown sections
    const ctxMatch  = content.match(/## Context\n\n?([\s\S]*?)(?=\n## |\n*$)/);
    const fixMatch  = content.match(/## Fix\n\n?([\s\S]*?)(?=\n## |\n*$)/);
    const evMatch   = content.match(/## Evidence\n\n?([\s\S]*?)(?=\n## |\n*$)/);

    return {
      id:            fm.id || dirName,
      created:       fm.created || new Date().toISOString(),
      author:        fm.author || "",
      source_project: fm.source_project || "",
      tool:          fm.tool || "",
      category:      fm.category || "",
      tags:          Array.isArray(fm.tags) ? fm.tags : (fm.tags ? [fm.tags] : []),
      confidence:    fm.confidence || "medium",
      visibility:    fm.visibility || "global",
      verified_at:   fm.verified_at || "",
      status:        fm.status || "active",
      archived_at:   fm.archived_at || null,
      context_text:  ctxMatch ? ctxMatch[1].trim() : "",
      fix_text:      fixMatch ? fixMatch[1].trim() : "",
      evidence_text: evMatch  ? evMatch[1].trim()  : "",
      repo_url:      fm.repo_url || "",
      commit_sha:    fm.commit_sha || "",
      branch:        fm.branch || "",
    };
  } catch {
    return null;
  }
}

/**
 * Check if migration is needed (no rows in entries) and run it.
 *
 * @param {object} db
 */
function _migrateIfNeeded(db) {
  try {
    const countStmt = db.prepare(`SELECT COUNT(*) AS cnt FROM entries`);
    const row = countStmt.get();
    if (row && row.cnt === 0) {
      const entriesDir = path.join(os.homedir(), ".claude", "knowledge", "entries");
      migrateFromFilesystem(db, entriesDir);
    }
  } catch {
    // Non-throwing
  }
}

// ─── querySubgraph ──────────────────────────────────────────────────────────

/**
 * Two-hop retrieval: get primary results, then follow their tags to find
 * related entries, building a small knowledge subgraph.
 *
 * @param {object} db - DatabaseSync instance
 * @param {object} opts - Same options as queryRelevant
 * @param {number} [primaryLimit=5] - Max primary results
 * @param {number} [relatedLimit=5] - Max related results
 * @returns {{ primary: object[], related: object[], tags: string[], status: string, error?: string }}
 */
function querySubgraph(db, opts = {}, primaryLimit = 5, relatedLimit = 5) {
  try {
    if (!db) return { primary: [], related: [], tags: [], status: "error", error: "database unavailable" };

    // Step 1: Get primary results via existing queryRelevant
    const primaryResult = queryRelevant(db, opts, primaryLimit);
    if (primaryResult.status !== "ok") {
      return { primary: [], related: [], tags: [], status: primaryResult.status, error: primaryResult.error };
    }

    const primary = primaryResult.results;
    if (primary.length === 0) {
      return { primary: [], related: [], tags: [], status: "ok" };
    }

    // Step 2: Collect all unique tags from primary results
    const primaryIds = new Set(primary.map(e => e.id));
    const tagSet = new Set();
    for (const entry of primary) {
      let tags = [];
      try { tags = JSON.parse(entry.tags || "[]"); } catch {}
      for (const tag of tags) tagSet.add(String(tag).toLowerCase());
      // Also include tool as a traversal link
      if (entry.tool) tagSet.add(entry.tool.toLowerCase());
    }

    const allTags = Array.from(tagSet);
    if (allTags.length === 0) {
      return { primary, related: [], tags: [], status: "ok" };
    }

    // Step 3: Find entries sharing tags with primary results
    const allStmt = db.prepare(`SELECT * FROM entries WHERE status = 'active'`);
    const allRows = allStmt.all();

    const candidates = [];
    for (const row of allRows) {
      if (primaryIds.has(row.id)) continue; // skip primary results

      let entryTags = [];
      try { entryTags = JSON.parse(row.tags || "[]"); } catch {}
      const lcTags = entryTags.map(t => String(t).toLowerCase());
      const entryTool = (row.tool || "").toLowerCase();

      // Count tag overlap with primary result tag set
      let overlap = 0;
      for (const tag of lcTags) {
        if (tagSet.has(tag)) overlap++;
      }
      if (entryTool && tagSet.has(entryTool)) overlap++;

      if (overlap > 0) {
        candidates.push({ ...row, _overlap: overlap });
      }
    }

    // Step 4: Sort by overlap count (desc), take top relatedLimit
    candidates.sort((a, b) => b._overlap - a._overlap);
    const related = candidates.slice(0, relatedLimit);
    for (const r of related) delete r._overlap;

    // Update access tracking for related entries
    const today = new Date().toISOString().slice(0, 10);
    const updateStmt = db.prepare(
      `UPDATE entries SET last_accessed = $last_accessed, access_count = COALESCE(access_count, 0) + 1 WHERE id = $id`
    );
    for (const entry of related) {
      try { updateStmt.run({ $last_accessed: today, $id: entry.id }); } catch {}
    }

    return { primary, related, tags: allTags, status: "ok" };
  } catch (e) {
    return { primary: [], related: [], tags: [], status: "error", error: (e && e.message) || "subgraph query failed" };
  }
}

// ─── CLI interface ────────────────────────────────────────────────────────────

if (require.main === module) {
  const [,, command, ...args] = process.argv;

  try {
    const db = openDb();
    if (!db) {
      process.stderr.write("Error: SQLite not available (requires Node 22.5+)\n");
      process.exit(0);
    }

    switch (command) {
      case "export": {
        const outPath = args[0] || null;
        exportToJsonl(db, outPath);
        break;
      }
      case "import": {
        const inPath = args[0];
        if (!inPath) { process.stderr.write("Usage: import <inPath>\n"); break; }
        importFromJsonl(db, inPath);
        process.stdout.write(JSON.stringify({ ok: true }) + "\n");
        break;
      }
      case "archive": {
        const id = args[0];
        if (!id) { process.stderr.write("Usage: archive <id>\n"); break; }
        archiveEntry(db, id);
        process.stdout.write(JSON.stringify({ ok: true, id }) + "\n");
        break;
      }
      case "insert": {
        const jsonStr = args[0];
        if (!jsonStr) { process.stderr.write("Usage: insert '<json>'\n"); break; }
        try {
          const entry = JSON.parse(jsonStr);
          // Validate required fields
          if (!entry.id || typeof entry.id !== "string") {
            process.stderr.write("Error: entry.id is required and must be a string\n"); break;
          }
          if (!entry.category || typeof entry.category !== "string") {
            process.stderr.write("Error: entry.category is required and must be a string\n"); break;
          }
          if (!entry.context_text || typeof entry.context_text !== "string") {
            process.stderr.write("Error: entry.context_text is required and must be a string\n"); break;
          }
          // Enforce reasonable max length on text fields (100KB)
          const MAX_TEXT = 100 * 1024;
          let oversizeField = null;
          for (const field of ["context_text", "fix_text", "evidence_text"]) {
            if (typeof entry[field] === "string" && Buffer.byteLength(entry[field], "utf8") > MAX_TEXT) {
              oversizeField = field;
              break;
            }
          }
          if (oversizeField) {
            process.stderr.write(`Error: ${oversizeField} exceeds maximum length of ${MAX_TEXT} bytes\n`); break;
          }
          insertEntry(db, entry);
          process.stdout.write(JSON.stringify({ ok: true, id: entry.id }) + "\n");
        } catch (e) {
          process.stderr.write(`Invalid JSON: ${e.message}\n`);
        }
        break;
      }
      case "staged": {
        const sessionId = args[0];
        if (!sessionId) { process.stderr.write("Usage: staged <sessionId>\n"); break; }
        const candidates = readStagedCandidates(db, sessionId);
        process.stdout.write(JSON.stringify(candidates) + "\n");
        break;
      }
      default: {
        process.stderr.write(
          "Commands: export [outPath] | import <inPath> | archive <id> | insert '<json>' | staged <sessionId>\n"
        );
      }
    }
  } catch {
    // Never crash
  }
  process.exit(0);
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  DEFAULT_DB_PATH,
  hasFts5,
  openDb,
  insertEntry,
  queryRelevant,
  querySubgraph,
  captureProvenance,
  stageCandidate,
  readStagedCandidates,
  clearStagedCandidates,
  pruneStagedRows,
  archiveEntry,
  archiveStale,
  exportToJsonl,
  importFromJsonl,
  migrateFromFilesystem,
};
