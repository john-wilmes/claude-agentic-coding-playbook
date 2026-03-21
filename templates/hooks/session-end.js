// SessionEnd hook: auto-commits memory changes to the ~/.claude git repo.
// Runs automatically when a session closes -- all agents, all projects.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

let capture;
try { capture = require("./knowledge-capture"); } catch { capture = null; }

let logModule;
try { logModule = require("./log"); } catch { logModule = null; }

let knowledgeDb;
try { knowledgeDb = require("./knowledge-db"); } catch { knowledgeDb = null; }

const LOG_DIR = path.join(os.homedir(), ".claude");
const LOG_FILE = path.join(LOG_DIR, "hooks.log");

// ─── Retrieval miss detection ─────────────────────────────────────────────────

function extractSalientTerms(text, maxTerms = 8) {
  if (!text) return [];
  const stops = new Set(["the","a","an","is","are","was","were","be","been","being","have","has","had","do","does","did","will","would","shall","should","may","might","can","could","must","to","of","in","for","on","at","by","with","from","as","into","through","during","before","after","above","below","between","under","about","against","not","no","nor","but","or","and","if","then","else","when","up","out","off","over","that","this","it","its","all","each","every","both","few","more","most","other","some","such","only","own","same","than","too","very","just","also","now","here","there","where","how","what","which","who","whom","whose"]);
  const tokens = text.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter(t => t.length > 2 && !stops.has(t));
  const seen = new Set();
  const unique = [];
  for (const t of tokens) { if (!seen.has(t)) { seen.add(t); unique.push(t); } }
  return unique.slice(0, maxTerms);
}

/**
 * Detect knowledge retrieval misses: candidates observed this session that
 * match a knowledge entry NOT in the injected set at session start.
 * Logs each miss via logModule.writeLog. Never throws.
 *
 * @param {string} sessionId
 * @param {string} cwd
 */
function detectRetrievalMisses(sessionId, cwd) {
  try {
    if (!capture || !logModule || !knowledgeDb) return;

    // Read injected IDs from session-start state file
    let injectedIds = [];
    try {
      const stateFile = path.join(os.tmpdir(), "claude-session-start", `${sessionId}.json`);
      const raw = fs.readFileSync(stateFile, "utf8");
      const state = JSON.parse(raw);
      injectedIds = Array.isArray(state.injectedIds) ? state.injectedIds : [];
    } catch {
      // No state file — cannot determine what was injected
      return;
    }

    const candidates = capture.readStagedCandidates(sessionId);
    if (!candidates || candidates.length === 0) return;

    const db = knowledgeDb.openDb(path.join(os.homedir(), ".claude", "knowledge", "knowledge.db"));
    if (!db) return;

    const injectedSet = new Set(injectedIds);

    for (const candidate of candidates) {
      try {
        const text = [candidate.summary || "", candidate.context_snippet || ""].join(" ");
        const queryTerms = extractSalientTerms(text);
        if (queryTerms.length === 0) continue;

        // Try FTS-powered query first; fall back to direct LIKE search if FTS
        // returns nothing (FTS5 content tables may return 0 rows cross-connection).
        const candidateTool = candidate.tool || "";
        let matched = knowledgeDb.queryRelevant(db, {
          queryTerms,
          projectTool: candidateTool ? [candidateTool] : [],
          cwd,
        }, 10);

        if (matched.length === 0) {
          // Direct LIKE fallback: find active entries matching at least one term in context
          // (FTS5 cross-connection returns empty without error on some SQLite versions)
          try {
            const likeClause = queryTerms.map(() => "(context_text LIKE ? OR fix_text LIKE ?)").join(" OR ");
            const params = queryTerms.flatMap(t => [`%${t}%`, `%${t}%`]);
            const toolFilter = candidateTool ? "tool = ? AND " : "";
            const toolParams = candidateTool ? [candidateTool] : [];
            const stmt = db.prepare(
              `SELECT * FROM entries WHERE status = 'active' AND ${toolFilter}(${likeClause}) LIMIT 10`
            );
            matched = stmt.all(...toolParams, ...params);
          } catch {
            // Direct query also failed — skip this candidate
          }
        }

        for (const entry of matched) {
          // Only flag a miss if the entry's tool matches the candidate's tool
          // (avoids false positives from broad text matches across unrelated tools)
          const entryTool = (entry.tool || "").toLowerCase();
          const toolMatch = !candidateTool || !entryTool ||
            entryTool === candidateTool.toLowerCase();
          if (entry.id && !injectedSet.has(entry.id) && toolMatch) {
            logModule.writeLog({
              hook: "session-end",
              event: "retrieval-miss",
              session_id: sessionId,
              details: `Knowledge entry "${entry.id}" matched candidate but was not injected at session start`,
              context: {
                candidate_summary: candidate.summary || "",
                candidate_tool: candidate.tool || "",
                matched_entry_id: entry.id,
                injected_ids: injectedIds,
              },
            });
          }
        }
      } catch {
        // Skip individual candidate errors
      }
    }
  } catch {
    // Never throw
  }
}

function logEntry(msg) {
  try {
    if (logModule) {
      logModule.writeLog({ hook: "session-end", event: "info", details: msg });
    } else {
      const line = `[${new Date().toISOString()}] session-end: ${msg}\n`;
      fs.mkdirSync(LOG_DIR, { recursive: true });
      fs.appendFileSync(LOG_FILE, line);
    }
  } catch {}
}

let input = "";
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    const hookInput = JSON.parse(input);
    const sessionId = hookInput.session_id || "";
    const cwd = hookInput.cwd || process.cwd();
    const agentName = path.basename(cwd) || "unknown";

    logEntry(`session ${sessionId.slice(0, 8)} ended for ${agentName}`);

    let pushFailureMsg = null;

    // Auto-commit THIS session's memory file only.
    // Using "git add -A" would stage other agents' memory files when multiple
    // projects are open simultaneously, causing wrong attribution and git index
    // contention. Stage only the path owned by this session.
    try {
      const claudeDir = path.join(os.homedir(), ".claude");
      const gitOpts = { cwd: claudeDir, timeout: 5000, stdio: "pipe" };

      // Initialize ~/.claude as a git repo if it isn't one yet
      try {
        execFileSync("git", ["rev-parse", "--git-dir"], gitOpts);
      } catch {
        execFileSync("git", ["init"], gitOpts);
        logEntry("memory auto-commit: initialized ~/.claude as git repo");
      }

      // Encode cwd to the project key Claude Code uses for memory paths
      const encodedCwd = cwd.replace(/:/g, "-").replace(/[\\/]/g, "-").replace(/^-/, "");
      const memoryPath = `projects/${encodedCwd}/memory/MEMORY.md`;

      try {
        execFileSync("git", ["add", "--", memoryPath], gitOpts);
      } catch {
        // Memory file may not exist yet -- skip
      }

      // Check if there are staged changes before committing
      try {
        execFileSync("git", ["diff", "--cached", "--quiet"], gitOpts);
        // No staged changes -- skip commit
        logEntry("memory auto-commit: no changes");
      } catch {
        // diff --quiet exits non-zero when there ARE staged changes
        const msg = `auto: ${agentName} session ${sessionId.slice(0, 8)}`;
        execFileSync("git", ["commit", "-m", msg], gitOpts);
        logEntry("memory auto-commit: committed");
        // Push to remote (non-blocking, best-effort)
        // Set CLAUDE_NO_AUTO_PUSH=1 to skip the push entirely.
        if (process.env.CLAUDE_NO_AUTO_PUSH === "1") {
          logEntry("memory auto-push: skipped (CLAUDE_NO_AUTO_PUSH=1)");
        } else {
          // Check if any remotes are configured before attempting push
          let hasRemote = false;
          try {
            const remoteOut = execFileSync("git", ["remote"], gitOpts).toString().trim();
            hasRemote = remoteOut.length > 0;
          } catch {}

          if (!hasRemote) {
            logEntry("memory auto-push: skipped (no remote configured)");
          } else {
            try {
              execFileSync("git", ["push"], { ...gitOpts, timeout: 8000 });
              logEntry("memory auto-push: pushed to remote");
            } catch (pushErr) {
              const msg = pushErr.stderr ? pushErr.stderr.toString().trim() : pushErr.message;
              logEntry(`memory auto-push failed: ${msg}`);
              pushFailureMsg = msg;
            }
          }
        }
      }
    } catch (commitErr) {
      logEntry(`memory auto-commit error: ${commitErr.message}`);
    }

    // Detect retrieval misses, then prune old staged knowledge candidates
    if (capture) {
      try { detectRetrievalMisses(sessionId, cwd); } catch {}
      try { capture.pruneStagedFiles(7); } catch {}
    }

    // Run stale archive once per day
    try {
      const archiveStateFile = path.join(os.tmpdir(), "claude-knowledge-archive-last.txt");
      const today = new Date().toISOString().slice(0, 10);
      let lastRun = "";
      try { lastRun = fs.readFileSync(archiveStateFile, "utf8").trim(); } catch {}
      if (lastRun !== today && knowledgeDb) {
        const db = knowledgeDb.openDb();
        if (db) {
          const count = knowledgeDb.archiveStale(db);
          if (count > 0) {
            if (logModule) {
              logModule.writeLog({
                hook: "session-end",
                event: "stale-archive",
                details: `Archived ${count} stale entries`,
                context: { count },
              });
            } else {
              logEntry(`stale-archive: archived ${count} entries`);
            }
          }
          fs.writeFileSync(archiveStateFile, today);
        }
      }
    } catch {}

    if (pushFailureMsg) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionEnd",
          additionalContext: `WARNING: memory auto-push failed: ${pushFailureMsg}`,
        },
      }));
    } else {
      process.stdout.write("{}");
    }
  } catch (err) {
    logEntry(`error: ${err.message}`);
    process.stdout.write("{}");
  }

  process.exit(0);
});
