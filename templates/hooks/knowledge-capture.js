// Shared module: stage knowledge candidates detected by hooks.
//
// Hooks call stageCandidate() when they observe a learning opportunity
// (e.g., test fail→pass, stuck→resolved). Candidates are written as
// JSON lines to ~/.claude/knowledge/staged/<session-id>.jsonl for later
// review and promotion into the knowledge store.
//
// All functions are non-throwing — errors are swallowed silently.

const fs = require("fs");
const path = require("path");
const os = require("os");

const STAGED_DIR = path.join(os.homedir(), ".claude", "knowledge", "staged");

/**
 * Ensure the staged directory exists.
 * @returns {boolean} true if directory is ready, false on error
 */
function ensureStagedDir() {
  try {
    fs.mkdirSync(STAGED_DIR, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Append a knowledge candidate as a JSON line to the session's staged file.
 *
 * @param {object} candidate
 * @param {string} candidate.session_id   - Required. Used as the filename stem.
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

    const filePath = path.join(STAGED_DIR, `${candidate.session_id}.jsonl`);
    fs.appendFileSync(filePath, JSON.stringify(record) + "\n", "utf8");
  } catch {
    // Never throw — hooks must exit 0
  }
}

/**
 * Read all staged candidates for the given session.
 *
 * @param {string} sessionId
 * @returns {object[]} Parsed candidates. Returns [] on any error or if file missing.
 */
function readStagedCandidates(sessionId) {
  try {
    const filePath = path.join(STAGED_DIR, `${sessionId}.jsonl`);
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

/**
 * Delete the staged file for the given session.
 * Never throws.
 *
 * @param {string} sessionId
 */
function clearStagedCandidates(sessionId) {
  try {
    const filePath = path.join(STAGED_DIR, `${sessionId}.jsonl`);
    fs.rmSync(filePath, { force: true });
  } catch {
    // Never throw
  }
}

/**
 * Delete staged .jsonl files older than maxAgeDays.
 * Never throws.
 *
 * @param {number} maxAgeDays
 */
function pruneStagedFiles(maxAgeDays) {
  try {
    const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const entries = fs.readdirSync(STAGED_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const filePath = path.join(STAGED_DIR, entry.name);
      try {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < cutoffMs) {
          fs.rmSync(filePath, { force: true });
        }
      } catch {
        // Skip files we can't stat
      }
    }
  } catch {
    // Never throw
  }
}

module.exports = {
  STAGED_DIR,
  stageCandidate,
  readStagedCandidates,
  clearStagedCandidates,
  pruneStagedFiles,
};
