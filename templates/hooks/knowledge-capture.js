// Shared module: stage knowledge candidates detected by hooks.
//
// Hooks call stageCandidate() when they observe a learning opportunity
// (e.g., test fail→pass, stuck→resolved). When knowledge-db.js is available
// (Node 22.5+ with node:sqlite), candidates are stored in the SQLite DB.
// Falls back to JSONL files in ~/.claude/knowledge/staged/ on older Node.
//
// All functions are non-throwing — errors are swallowed silently.

const fs = require("fs");
const path = require("path");
const os = require("os");

// ─── Fallback paths (backward compat) ────────────────────────────────────────

function getStagedDir() {
  return path.join(os.homedir(), ".claude", "knowledge", "staged");
}

// ─── DB setup (try knowledge-db; fall back to JSONL) ─────────────────────────

let knowledgeDb = null;
let db = null;
let DB_PATH = null;

try {
  knowledgeDb = require("./knowledge-db");
} catch {
  // knowledge-db unavailable (missing module, wrong Node version, etc.)
  knowledgeDb = null;
}

function _getDb() {
  if (!knowledgeDb) return null;
  if (!db) {
    DB_PATH = path.join(os.homedir(), ".claude", "knowledge", "knowledge.db");
    db = knowledgeDb.openDb(DB_PATH);
  }
  return db;
}

// ─── JSONL fallback helpers ───────────────────────────────────────────────────

function ensureStagedDir() {
  try {
    fs.mkdirSync(getStagedDir(), { recursive: true });
    return true;
  } catch {
    return false;
  }
}

function _jsonlStageCandidate(candidate) {
  if (!ensureStagedDir()) return;
  const record = {
    ts: new Date().toISOString(),
    session_id: candidate.session_id,
    trigger: candidate.trigger || "",
    tool: candidate.tool || "",
    category: candidate.category || "gotcha",
    confidence: candidate.confidence || "medium",
    summary: candidate.summary || "",
    context_snippet: candidate.context_snippet || "",
    source_project: candidate.source_project || "",
    cwd: candidate.cwd || "",
  };
  const filePath = path.join(getStagedDir(), `${candidate.session_id}.jsonl`);
  fs.appendFileSync(filePath, JSON.stringify(record) + "\n", "utf8");
}

function _jsonlReadStagedCandidates(sessionId) {
  try {
    const filePath = path.join(getStagedDir(), `${sessionId}.jsonl`);
    const raw = fs.readFileSync(filePath, "utf8");
    const results = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        results.push(JSON.parse(trimmed));
      } catch {
        // Skip malformed lines
      }
    }
    return results;
  } catch {
    return [];
  }
}

function _jsonlClearStagedCandidates(sessionId) {
  const filePath = path.join(getStagedDir(), `${sessionId}.jsonl`);
  fs.rmSync(filePath, { force: true });
}

function _jsonlPruneStagedFiles(maxAgeDays) {
  const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const entries = fs.readdirSync(getStagedDir(), { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const filePath = path.join(getStagedDir(), entry.name);
    try {
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoffMs) {
        fs.rmSync(filePath, { force: true });
      }
    } catch {
      // Skip files we can't stat
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Append a knowledge candidate to the session's staged store.
 *
 * @param {object} candidate
 * @param {string} candidate.session_id   - Required.
 * @param {string} candidate.trigger      - "test-fix" | "stuck-resolved"
 * @param {string} candidate.tool         - Tool name that triggered capture
 * @param {string} candidate.category     - "gotcha" | "pattern"
 * @param {string} candidate.confidence   - "medium" | "high" | "low"
 * @param {string} candidate.summary      - First line of failure output
 * @param {string} candidate.context_snippet - Up to 500 chars of context
 * @param {string} candidate.source_project  - basename of cwd
 * @param {string} candidate.cwd          - Full path to working directory
 */
function stageCandidate(candidate) {
  try {
    if (!candidate || !candidate.session_id) return;
    const activeDb = _getDb();
    if (activeDb) {
      knowledgeDb.stageCandidate(activeDb, candidate);
    } else {
      _jsonlStageCandidate(candidate);
    }
  } catch {
    // Never throw — hooks must exit 0
  }
}

/**
 * Read all staged candidates for the given session.
 *
 * @param {string} sessionId
 * @returns {object[]} Parsed candidates. Returns [] on any error or if missing.
 */
function readStagedCandidates(sessionId) {
  try {
    const activeDb = _getDb();
    if (activeDb) {
      return knowledgeDb.readStagedCandidates(activeDb, sessionId);
    }
    return _jsonlReadStagedCandidates(sessionId);
  } catch {
    return [];
  }
}

/**
 * Delete staged candidates for the given session.
 * Never throws.
 *
 * @param {string} sessionId
 */
function clearStagedCandidates(sessionId) {
  try {
    const activeDb = _getDb();
    if (activeDb) {
      knowledgeDb.clearStagedCandidates(activeDb, sessionId);
    } else {
      _jsonlClearStagedCandidates(sessionId);
    }
  } catch {
    // Never throw
  }
}

/**
 * Delete staged candidates/files older than maxAgeDays.
 * Name kept for backward compat; now delegates to DB prune when available.
 * Never throws.
 *
 * @param {number} maxAgeDays
 */
function pruneStagedFiles(maxAgeDays) {
  try {
    const activeDb = _getDb();
    if (activeDb) {
      knowledgeDb.pruneStagedRows(activeDb, maxAgeDays);
    } else {
      _jsonlPruneStagedFiles(maxAgeDays);
    }
  } catch {
    // Never throw
  }
}

module.exports = {
  getStagedDir,
  get DB_PATH() { return knowledgeDb ? path.join(os.homedir(), ".claude", "knowledge", "knowledge.db") : null; },
  stageCandidate,
  readStagedCandidates,
  clearStagedCandidates,
  pruneStagedFiles,
};
