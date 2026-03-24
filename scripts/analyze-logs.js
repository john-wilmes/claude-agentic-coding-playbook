#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const transcriptParser = require("./transcript-parser");

const LOG_DIR = path.join(os.homedir(), ".claude", "logs");
const KNOWLEDGE_DIR = path.join(os.homedir(), ".claude", "knowledge");
const STAGED_DIR = path.join(KNOWLEDGE_DIR, "staged");
const ENTRIES_DIR = path.join(KNOWLEDGE_DIR, "entries");

// Load BM25 from installed hooks first, fall back to templates path for development.
let bm25;
try {
  bm25 = require(path.join(os.homedir(), ".claude", "hooks", "bm25"));
} catch (_) {
  try {
    bm25 = require(path.join(__dirname, "..", "templates", "hooks", "bm25"));
  } catch (_) {
    bm25 = null;
  }
}

const MISS_THRESHOLD = 5.0;

function parseArgs(argv) {
  const args = { since: null, session: null, hook: null, excludeTests: false, project: null, retrievalMisses: false, timeline: null, projectDir: null, aggregate: false, provenance: null, failureChains: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--since" && argv[i + 1]) { args.since = argv[++i]; }
    else if (argv[i] === "--session" && argv[i + 1]) { args.session = argv[++i]; }
    else if (argv[i] === "--hook" && argv[i + 1]) { args.hook = argv[++i]; }
    else if (argv[i] === "--exclude-tests") { args.excludeTests = true; }
    else if (argv[i] === "--project" && argv[i + 1]) { args.project = argv[++i]; }
    else if (argv[i] === "--retrieval-misses") { args.retrievalMisses = true; }
    else if (argv[i] === "--timeline" && argv[i + 1]) { args.timeline = argv[++i]; }
    else if (argv[i] === "--project-dir" && argv[i + 1]) { args.projectDir = argv[++i]; }
    else if (argv[i] === "--aggregate") { args.aggregate = true; }
    else if (argv[i] === "--provenance" && argv[i + 1]) { args.provenance = argv[++i]; }
    else if (argv[i] === "--failure-chains" && argv[i + 1]) { args.failureChains = argv[++i]; }
    else if (argv[i] === "--help") {
      console.log("Usage: node scripts/analyze-logs.js [OPTIONS]");
      console.log("");
      console.log("Options:");
      console.log("  --since YYYY-MM-DD          Filter entries after date");
      console.log("  --session PREFIX             Filter by session ID prefix");
      console.log("  --hook NAME                  Filter by hook name");
      console.log("  --exclude-tests              Exclude test-sourced entries");
      console.log("  --project NAME               Filter by project name substring");
      console.log("  --retrieval-misses           Show BM25 retrieval miss analysis");
      console.log("  --timeline SESSION_ID        Show session timeline (requires --project-dir)");
      console.log("  --project-dir PATH           Project working directory for transcript lookup");
      console.log("  --aggregate                  Show cross-session aggregate metrics");
      console.log("  --provenance SESSION_ID      Show decision provenance for hook warnings (requires --project-dir)");
      console.log("  --failure-chains SESSION_ID  Show failure chain analysis for a session (requires --project-dir)");
      process.exit(0);
    }
  }
  return args;
}

function loadEntries(args) {
  if (!fs.existsSync(LOG_DIR)) return [];

  let files;
  try {
    files = fs.readdirSync(LOG_DIR).filter(f => f.endsWith(".jsonl")).sort();
  } catch (_) {
    return [];
  }

  if (args.since) {
    files = files.filter(f => {
      const date = path.basename(f, ".jsonl");
      return date >= args.since;
    });
  }

  const entries = [];
  for (const file of files) {
    const filePath = path.join(LOG_DIR, file);
    let lines;
    try {
      lines = fs.readFileSync(filePath, "utf8").split("\n");
    } catch (_) {
      continue;
    }
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (args.session && !String(entry.session_id || "").startsWith(args.session)) continue;
        if (args.hook && entry.hook !== args.hook) continue;
        if (args.excludeTests && entry.source === "test") continue;
        if (args.project && !String(entry.project || "").includes(args.project)) continue;
        entries.push(entry);
      } catch (_) {
        // skip malformed lines
      }
    }
  }
  return entries;
}

function printSummary(entries) {
  console.log("=== Overall Summary ===");
  if (entries.length === 0) {
    console.log("No log entries found.");
    console.log();
    return;
  }

  const timestamps = entries.map(e => e.ts).filter(Boolean).sort();
  const sessions = new Set(entries.map(e => e.session_id).filter(Boolean));

  console.log(`Total entries:    ${entries.length}`);
  console.log(`Date range:       ${timestamps[0] || "unknown"} — ${timestamps[timestamps.length - 1] || "unknown"}`);
  console.log(`Unique sessions:  ${sessions.size}`);
  console.log();
}

function printContextGuard(entries) {
  const cg = entries.filter(e => e.hook === "context-guard");
  console.log("=== Context-Guard Progression ===");
  if (cg.length === 0) {
    console.log("No context-guard entries.");
    console.log();
    return;
  }

  // Group by session
  const bySession = {};
  for (const entry of cg) {
    const sid = entry.session_id || "unknown";
    if (!bySession[sid]) bySession[sid] = [];
    bySession[sid].push(entry);
  }

  for (const [sid, sessionEntries] of Object.entries(bySession)) {
    const short = sid.length > 12 ? sid.slice(0, 12) + "..." : sid;
    console.log(`  Session ${short}:`);

    // Track threshold crossings: 35%, 50%, 60%
    const thresholds = [35, 50, 60];
    const fired = {};
    let callNum = 0;

    for (const entry of sessionEntries) {
      callNum++;
      const pct = entry.context && entry.context.pct != null ? entry.context.pct : null;
      if (pct == null) continue;
      for (const t of thresholds) {
        if (!(t in fired) && pct >= t) {
          fired[t] = { callNum, pct };
        }
      }
    }

    for (const t of thresholds) {
      if (fired[t]) {
        console.log(`    ${t}% threshold: tool call #${fired[t].callNum} (actual ${fired[t].pct.toFixed(1)}%)`);
      } else {
        console.log(`    ${t}% threshold: not reached`);
      }
    }

    const warns = sessionEntries.filter(e => e.event === "warn").length;
    const blocks = sessionEntries.filter(e => e.event === "block").length;
    console.log(`    Events: ${warns} warn, ${blocks} block`);
  }
  console.log();
}

function printStuckDetector(entries) {
  const sd = entries.filter(e => e.hook === "stuck-detector");
  console.log("=== Stuck-Detector Triggers ===");
  if (sd.length === 0) {
    console.log("No stuck-detector entries.");
    console.log();
    return;
  }

  const byTool = {};
  for (const entry of sd) {
    const tool = (entry.context && entry.context.tool) || entry.details || "unknown";
    byTool[tool] = (byTool[tool] || 0) + 1;
  }

  const sorted = Object.entries(byTool).sort((a, b) => b[1] - a[1]);
  for (const [tool, count] of sorted) {
    console.log(`  ${tool}: ${count}`);
  }
  console.log(`  Total: ${sd.length}`);
  console.log();
}

function printSycophancyDetector(entries) {
  const sd = entries.filter(e => e.hook === "sycophancy-detector");
  console.log("=== Sycophancy-Detector ===");
  if (sd.length === 0) {
    console.log("No sycophancy-detector entries.");
    console.log();
    return;
  }

  const warnings = sd.filter(e => e.event === "warn");
  const escalations = sd.filter(e => e.event === "escalate");
  const scores = sd.filter(e => e.event === "score");

  console.log(`Total warnings:    ${warnings.length}`);
  console.log(`Total escalations: ${escalations.length}`);

  // Breakdown by warning reason type
  const reasonCounts = {};
  for (const entry of [...warnings, ...escalations]) {
    const reason = (entry.context && entry.context.reason) || entry.details || "unknown";
    reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
  }
  if (Object.keys(reasonCounts).length > 0) {
    console.log("  Breakdown by reason:");
    const sorted = Object.entries(reasonCounts).sort((a, b) => b[1] - a[1]);
    for (const [reason, count] of sorted) {
      console.log(`    ${reason}: ${count}`);
    }
  }

  // Average session metrics from score events
  if (scores.length > 0) {
    const quickEdits = scores.map(e => e.context && e.context.quick_edits).filter(v => v != null);
    const complianceRuns = scores.map(e => e.context && e.context.compliance_run).filter(v => v != null);
    const ratios = scores.map(e => e.context && e.context.ratio).filter(v => v != null);

    if (quickEdits.length > 0 || complianceRuns.length > 0 || ratios.length > 0) {
      console.log("  Avg session metrics (from score events):");
      if (quickEdits.length > 0) {
        const avg = quickEdits.reduce((a, b) => a + b, 0) / quickEdits.length;
        console.log(`    avg quick_edits:     ${avg.toFixed(2)}`);
      }
      if (complianceRuns.length > 0) {
        const avg = complianceRuns.reduce((a, b) => a + b, 0) / complianceRuns.length;
        console.log(`    avg compliance_run:  ${avg.toFixed(2)}`);
      }
      if (ratios.length > 0) {
        const avg = ratios.reduce((a, b) => a + b, 0) / ratios.length;
        console.log(`    avg ratio:           ${avg.toFixed(3)}`);
      }
    }
  }

  console.log();
}

function printModelRouter(entries) {
  const mr = entries.filter(e => e.hook === "model-router" && e.event === "route");
  console.log("=== Model-Router Distribution ===");
  if (mr.length === 0) {
    console.log("No model-router route entries.");
    console.log();
    return;
  }

  const counts = { haiku: 0, sonnet: 0, opus: 0, other: 0 };
  for (const entry of mr) {
    const model = (entry.context && entry.context.model) || "";
    if (model.includes("haiku")) counts.haiku++;
    else if (model.includes("sonnet")) counts.sonnet++;
    else if (model.includes("opus")) counts.opus++;
    else counts.other++;
  }

  const total = mr.length;
  for (const [tier, count] of Object.entries(counts)) {
    if (count === 0 && tier === "other") continue;
    const pct = ((count / total) * 100).toFixed(1);
    console.log(`  ${tier.padEnd(8)}: ${count} (${pct}%)`);
  }
  console.log(`  Total:    ${total}`);
  console.log();
}

function printInjectionGuard(entries) {
  const pig = entries.filter(e => e.hook === "prompt-injection-guard" && e.event === "block");
  console.log("=== Prompt-Injection Blocks ===");
  if (pig.length === 0) {
    console.log("Count: 0 (expected in normal operation)");
    console.log();
    return;
  }

  console.log(`Count: ${pig.length} (UNEXPECTED — review details below)`);
  for (const entry of pig) {
    const ts = entry.ts || "unknown time";
    const details = entry.details || "(no details)";
    console.log(`  [${ts}] ${details}`);
  }
  console.log();
}

function loadStagedCandidates() {
  if (!fs.existsSync(STAGED_DIR)) return [];
  let files;
  try {
    files = fs.readdirSync(STAGED_DIR).filter(f => f.endsWith(".jsonl"));
  } catch (_) {
    return [];
  }
  const candidates = [];
  for (const file of files) {
    const filePath = path.join(STAGED_DIR, file);
    let lines;
    try {
      lines = fs.readFileSync(filePath, "utf8").split("\n");
    } catch (_) {
      continue;
    }
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        candidates.push(JSON.parse(line));
      } catch (_) {
        // skip malformed lines
      }
    }
  }
  return candidates;
}

function loadKnowledgeEntries() {
  if (!fs.existsSync(ENTRIES_DIR)) return [];
  let dirs;
  try {
    dirs = fs.readdirSync(ENTRIES_DIR);
  } catch (_) {
    return [];
  }
  const entries = [];
  for (const dir of dirs) {
    const entryPath = path.join(ENTRIES_DIR, dir, "entry.md");
    try {
      const text = fs.readFileSync(entryPath, "utf8");
      entries.push({ id: dir, text });
    } catch (_) {
      // skip missing or unreadable entries
    }
  }
  return entries;
}

function printRetrievalMisses() {
  console.log("=== Retrieval Miss Analysis ===");

  if (!bm25) {
    console.log("BM25 module not available — skipping analysis.");
    console.log("Install hooks via install.sh or ensure templates/hooks/bm25.js exists.");
    console.log();
    return;
  }

  const candidates = loadStagedCandidates();
  const knowledgeEntries = loadKnowledgeEntries();

  console.log(`Staged candidates found: ${candidates.length}`);
  console.log(`Existing knowledge entries: ${knowledgeEntries.length}`);

  if (candidates.length === 0) {
    console.log("No staged candidates to analyze.");
    console.log();
    return;
  }

  if (knowledgeEntries.length === 0) {
    console.log("No existing knowledge entries to compare against.");
    console.log();
    return;
  }

  const index = bm25.buildIndex(knowledgeEntries);

  let missCount = 0;
  let newCount = 0;
  let noContextCount = 0;

  console.log();
  console.log("Potential retrieval misses (staged candidates similar to existing entries):");
  console.log();

  for (const candidate of candidates) {
    const summary = candidate.summary || "";
    const snippet = candidate.context_snippet || "";
    const trigger = candidate.trigger || "unknown";
    const queryText = [summary, snippet].filter(Boolean).join(" ");

    if (!queryText.trim()) {
      noContextCount++;
      console.log(`  No context: (${trigger}) — no summary or context_snippet`);
      continue;
    }

    const results = bm25.query(index, queryText, 1);

    if (results.length > 0 && results[0].score > MISS_THRESHOLD) {
      missCount++;
      const match = results[0];
      console.log(`  Candidate: "${summary}" (${trigger})`);
      console.log(`    → Similar to entry: ${match.id} (score: ${match.score.toFixed(1)})`);
      console.log(`    → Action: Consider if the existing entry needs updating or if this is a duplicate`);
    } else {
      newCount++;
      const scoreInfo = results.length > 0 ? ` (best score: ${results[0].score.toFixed(1)})` : "";
      console.log(`  No match: "${summary}" (${trigger})`);
      console.log(`    → No similar existing entry found above threshold${scoreInfo}`);
    }
    console.log();
  }

  console.log(`Summary: ${missCount} potential miss${missCount !== 1 ? "es" : ""}, ${newCount} new candidate${newCount !== 1 ? "s" : ""}, ${noContextCount} staged event${noContextCount !== 1 ? "s" : ""} without context`);
  console.log();
}

/**
 * Build a merged timeline of tool calls (from transcript) and hook events (from log entries)
 * for a given session. Returns { timeline, toolResultMap, fallbackUsed }.
 *
 * timeline: array of events sorted by timestamp:
 *   - type "tool": { ts, sortKey, type, tool, summary, id }
 *   - type "hook": { ts, sortKey, type, icon, hook, event, detail }
 * toolResultMap: Map<tool_use_id, { is_error, content }>
 * fallbackUsed: true if the most-recent session was used instead of the requested one
 */
function buildTimeline(sessionId, projectDir, hookEntries) {
  // Load transcript entries if project dir provided
  let transcriptEntries = [];
  let fallbackUsed = false;
  if (projectDir) {
    const sessionFile = transcriptParser.findSessionFile(sessionId, projectDir);
    if (sessionFile) {
      transcriptEntries = transcriptParser.parseSessionFile(sessionFile);
    } else {
      const recent = transcriptParser.findMostRecentSession(projectDir);
      if (recent) {
        fallbackUsed = true;
        transcriptEntries = transcriptParser.parseSessionFile(recent);
      }
    }
  }

  // Build timeline events from transcript (tool calls)
  const timeline = [];
  let entryIndex = 0;
  for (const entry of transcriptEntries) {
    entryIndex++;
    if (entry.type !== "assistant") continue;
    const msg = entry.message;
    if (!msg || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type !== "tool_use") continue;
      const ts = entry.timestamp || `step-${entryIndex}`;
      const inputSummary = formatToolSummary(block.name, block.input);
      timeline.push({
        ts,
        sortKey: entry.timestamp || `${String(entryIndex).padStart(6, "0")}`,
        type: "tool",
        tool: block.name,
        summary: inputSummary,
        id: block.id,
      });
    }
  }

  // Build tool result map for error tracking
  const toolResultMap = transcriptParser.buildToolResultMap(transcriptEntries);

  // Add hook events from log entries for this session
  const sessionHooks = hookEntries.filter(e => {
    const sid = String(e.session_id || "");
    return sid === sessionId || sid.startsWith(sessionId);
  });

  for (const entry of sessionHooks) {
    const ts = entry.ts || "unknown";
    const hook = entry.hook || "unknown";
    const event = entry.event || "";
    let detail = "";

    if (hook === "context-guard" && entry.context && entry.context.pct != null) {
      detail = `context at ${entry.context.pct.toFixed(1)}%`;
    } else if (hook === "stuck-detector") {
      detail = entry.details || (entry.context && entry.context.tool) || "";
    } else if (hook === "sycophancy-detector" && entry.context) {
      detail = entry.context.reason || "";
    } else if (hook === "model-router" && entry.context) {
      detail = `→ ${entry.context.model || "?"}`;
    } else if (hook === "prompt-injection-guard") {
      detail = entry.details || "";
    } else {
      detail = entry.details || "";
    }

    const icon = event === "block" || event === "escalate" ? "!!!" : event === "warn" ? "<!>" : "---";
    timeline.push({
      ts,
      sortKey: ts,
      type: "hook",
      icon,
      hook,
      event,
      detail,
      // keep original entry for provenance analysis
      _entry: entry,
    });
  }

  // Sort by timestamp
  timeline.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));

  return { timeline, toolResultMap, fallbackUsed };
}

function printTimeline(sessionId, projectDir, hookEntries) {
  console.log(`=== Session Timeline: ${sessionId} ===`);

  const { timeline, toolResultMap, fallbackUsed } = buildTimeline(sessionId, projectDir, hookEntries);

  if (fallbackUsed) {
    console.log(`  (session file not found for "${sessionId}", showing most recent)`);
  }

  if (timeline.length === 0) {
    console.log("  No timeline events found.");
    if (!projectDir) {
      console.log("  Tip: use --project-dir <path> to include transcript tool calls.");
    }
    console.log();
    return;
  }

  // Render
  for (const evt of timeline) {
    const time = formatTime(evt.ts);
    if (evt.type === "tool") {
      const result = toolResultMap.get(evt.id);
      const errMark = result && result.is_error ? " [ERROR]" : "";
      console.log(`  [${time}] Tool: ${evt.tool}${errMark}`);
      if (evt.summary) {
        console.log(`           ${evt.summary}`);
      }
    } else if (evt.type === "hook") {
      console.log(`  [${time}]   ${evt.icon} ${evt.hook}: ${evt.event}${evt.detail ? " — " + evt.detail : ""}`);
    }
  }

  // Summary stats
  const toolCount = timeline.filter(e => e.type === "tool").length;
  const hookCount = timeline.filter(e => e.type === "hook").length;
  const errors = timeline.filter(e => e.type === "tool" && toolResultMap.has(e.id) && toolResultMap.get(e.id).is_error).length;
  const warns = timeline.filter(e => e.type === "hook" && e.event === "warn").length;
  const blocks = timeline.filter(e => e.type === "hook" && (e.event === "block" || e.event === "escalate")).length;
  console.log();
  console.log(`  Summary: ${toolCount} tool calls, ${errors} errors, ${hookCount} hook events (${warns} warn, ${blocks} block/escalate)`);
  console.log();
}

function printProvenance(sessionId, projectDir, hookEntries) {
  console.log(`=== Decision Provenance: ${sessionId} ===`);

  const { timeline, toolResultMap, fallbackUsed } = buildTimeline(sessionId, projectDir, hookEntries);

  if (fallbackUsed) {
    console.log("  Warning: exact session transcript not found — tool call data may not match hook events.");
    console.log("  Use --timeline to verify transcript alignment first.");
    console.log();
  }

  if (timeline.length === 0) {
    console.log("  No timeline events found.");
    if (!projectDir) {
      console.log("  Tip: use --project-dir <path> to include transcript tool calls.");
    }
    console.log();
    return;
  }

  // Walk the timeline and classify agent response to each hook warn/block/escalate
  const classifications = []; // { ts, hook, event, detail, triggerTool, nextTool, nextSummary, outcome }

  for (let i = 0; i < timeline.length; i++) {
    const evt = timeline[i];
    if (evt.type !== "hook") continue;
    if (evt.event !== "warn" && evt.event !== "block" && evt.event !== "escalate") continue;

    // Find the next tool event after this hook event
    let nextToolEvt = null;
    for (let j = i + 1; j < timeline.length; j++) {
      if (timeline[j].type === "tool") {
        nextToolEvt = timeline[j];
        break;
      }
    }

    // Determine what tool triggered the hook (if any — from detail or context)
    const hookEntry = evt._entry || {};
    const triggerTool = (hookEntry.context && hookEntry.context.tool) || evt.detail || null;

    let outcome;
    if (!nextToolEvt) {
      outcome = "end_of_session";
    } else {
      const nextTool = nextToolEvt.tool;
      if (evt.hook === "stuck-detector") {
        // triggerTool is the repeated tool; if next call is same → ignored
        if (triggerTool && nextTool === triggerTool) {
          outcome = "ignored";
        } else {
          outcome = "changed";
        }
      } else if (evt.hook === "context-guard") {
        // Look for checkpoint/compact signals: Skill tool or any tool related to wrapping up
        const isWrapUp =
          nextTool === "Skill" ||
          (nextTool === "Bash" && nextToolEvt.summary && /git commit|checkpoint|compact/i.test(nextToolEvt.summary));
        outcome = isWrapUp ? "changed" : "ignored";
      } else if (evt.hook === "prompt-injection-guard") {
        // triggerTool is the blocked command; if next call is different → changed
        if (triggerTool && nextTool === triggerTool) {
          outcome = "ignored";
        } else {
          outcome = "changed";
        }
      } else {
        // Generic: if next tool differs from the triggering tool → changed
        if (triggerTool && nextTool === triggerTool) {
          outcome = "ignored";
        } else {
          outcome = "changed";
        }
      }
    }

    // Format display detail for the hook event
    let hookDisplay = evt.detail || "";
    if (evt.hook === "stuck-detector" && triggerTool) hookDisplay = triggerTool;
    else if (evt.hook === "context-guard" && hookEntry.context && hookEntry.context.pct != null) {
      hookDisplay = `${hookEntry.context.pct.toFixed(1)}%`;
    }

    const nextDesc = nextToolEvt
      ? `${nextToolEvt.tool}${nextToolEvt.summary ? ` (${nextToolEvt.summary})` : ""}`
      : "(none)";

    classifications.push({
      ts: evt.ts,
      hook: evt.hook,
      event: evt.event,
      hookDisplay,
      nextDesc,
      outcome,
    });
  }

  if (classifications.length === 0) {
    console.log("  No warn/block/escalate hook events found in this session.");
    console.log();
    return;
  }

  for (const c of classifications) {
    const time = formatTime(c.ts);
    const outcomeLabel = c.outcome === "changed" ? "CHANGED" : c.outcome === "ignored" ? "IGNORED" : "END_OF_SESSION";
    const hookLabel = c.hookDisplay ? ` (${c.hookDisplay})` : "";
    console.log(`  [${time}] ${c.hook} ${c.event}${hookLabel} → next: ${c.nextDesc} → ${outcomeLabel}`);
  }

  // Summary stats
  const withNextTool = classifications.filter(c => c.outcome !== "end_of_session");
  const changed = withNextTool.filter(c => c.outcome === "changed").length;
  const total = withNextTool.length;
  const pct = total > 0 ? ((changed / total) * 100).toFixed(1) : "0.0";
  console.log();
  console.log(`  Hook effectiveness: ${changed}/${total} warnings led to course changes (${pct}%)`);

  // By-hook breakdown
  const byHook = {};
  for (const c of withNextTool) {
    if (!byHook[c.hook]) byHook[c.hook] = { changed: 0, total: 0 };
    byHook[c.hook].total++;
    if (c.outcome === "changed") byHook[c.hook].changed++;
  }
  if (Object.keys(byHook).length > 0) {
    console.log("  By hook:");
    const maxLen = Math.max(...Object.keys(byHook).map(k => k.length));
    for (const [hook, stats] of Object.entries(byHook)) {
      const hookPct = stats.total > 0 ? ((stats.changed / stats.total) * 100).toFixed(1) : "0.0";
      console.log(`    ${hook.padEnd(maxLen + 2)} ${stats.changed}/${stats.total} (${hookPct}%)`);
    }
  }
  console.log();
}

function printFailureChains(sessionId, projectDir, hookEntries) {
  console.log(`=== Failure Chains: ${sessionId} ===`);

  const { timeline, toolResultMap, fallbackUsed } = buildTimeline(sessionId, projectDir, hookEntries);

  if (fallbackUsed) {
    console.log("  Warning: exact session transcript not found — tool call data may not match hook events.");
    console.log();
  }

  if (timeline.length === 0) {
    console.log("  No timeline events found.");
    if (!projectDir) {
      console.log("  Tip: use --project-dir <path> to include transcript tool calls.");
    }
    console.log();
    return;
  }

  // Group consecutive tool errors into episodes
  const episodes = [];
  let currentEpisode = null;

  for (const evt of timeline) {
    if (evt.type === "tool") {
      const result = toolResultMap.get(evt.id);
      const isError = result && result.is_error === true;

      if (isError) {
        if (!currentEpisode) {
          currentEpisode = {
            start_ts: evt.ts,
            end_ts: evt.ts,
            error_tools: [],
            recovery_tool: null,
            hook_interventions: [],
            recovered: false,
          };
        }
        currentEpisode.end_ts = evt.ts;
        currentEpisode.error_tools.push({ tool: evt.tool, summary: evt.summary });
      } else {
        if (currentEpisode) {
          // This success is the recovery
          currentEpisode.recovery_tool = { tool: evt.tool, summary: evt.summary };
          currentEpisode.recovered = true;
          currentEpisode.end_ts = evt.ts;
          episodes.push(currentEpisode);
          currentEpisode = null;
        }
      }
    } else if (evt.type === "hook" && currentEpisode) {
      // Record hook interventions that occur during an episode
      currentEpisode.hook_interventions.push({ ts: evt.ts, hook: evt.hook, event: evt.event, detail: evt.detail });
    }
  }

  // If episode was never recovered, push it as unrecovered
  if (currentEpisode) {
    episodes.push(currentEpisode);
  }

  if (episodes.length === 0) {
    console.log("  No failure episodes found.");
    console.log();
    return;
  }

  // Render episodes
  for (let i = 0; i < episodes.length; i++) {
    const ep = episodes[i];
    const startTime = formatTime(ep.start_ts);
    const endTime = formatTime(ep.end_ts);
    const durationMs = computeDurationMs(ep.start_ts, ep.end_ts);
    const durationLabel = durationMs != null ? `${Math.round(durationMs / 1000)}s` : "?s";
    const recoveryLabel = ep.recovered ? "recovered" : "unrecovered";

    console.log(`  Episode ${i + 1} [${startTime} — ${endTime}] (${durationLabel}, ${recoveryLabel})`);

    // Interleave error tools with hook interventions in chronological order
    // Build a flat list sorted by ts
    const items = [];
    for (let j = 0; j < ep.error_tools.length; j++) {
      items.push({ kind: "error", ...ep.error_tools[j] });
    }
    for (const h of ep.hook_interventions) {
      items.push({ kind: "hook", ...h });
    }
    // We don't have ts on error_tools individually (only the episode start/end),
    // so just print errors first, hooks inline at the end of the errors section.
    // Actually, hooks ARE in the episode.hook_interventions as added in-order,
    // so we can interleave using the order they were encountered in the timeline.
    // Since we built ep.error_tools and ep.hook_interventions in timeline-walk order,
    // we reconstruct the interleaved order from the original timeline.
    const episodeItems = [];
    let errorIdx = 0;
    for (const evt of timeline) {
      if (evt.type === "tool") {
        const result = toolResultMap.get(evt.id);
        if (result && result.is_error) {
          // Check if this belongs to this episode (simple heuristic: match tool + summary order)
          if (errorIdx < ep.error_tools.length &&
              ep.error_tools[errorIdx].tool === evt.tool &&
              ep.error_tools[errorIdx].summary === evt.summary) {
            episodeItems.push({ kind: "error", tool: evt.tool, summary: evt.summary });
            errorIdx++;
          }
        } else if (ep.recovered && ep.recovery_tool &&
                   evt.tool === ep.recovery_tool.tool && evt.summary === ep.recovery_tool.summary &&
                   errorIdx === ep.error_tools.length) {
          episodeItems.push({ kind: "recovery", tool: evt.tool, summary: evt.summary });
        }
      } else if (evt.type === "hook") {
        // Include hook events that are in this episode's hook_interventions
        const isInEpisode = ep.hook_interventions.some(h => h.ts === evt.ts && h.hook === evt.hook && h.event === evt.event);
        if (isInEpisode && errorIdx > 0) {
          episodeItems.push({ kind: "hook", ts: evt.ts, hook: evt.hook, event: evt.event, detail: evt.detail });
        }
      }
    }

    for (const item of episodeItems) {
      if (item.kind === "error") {
        const summaryLabel = item.summary ? `: ${item.summary}` : "";
        console.log(`    ✗ ${item.tool}${summaryLabel}`);
      } else if (item.kind === "hook") {
        const icon = item.event === "block" || item.event === "escalate" ? "!!!" : "<!>";
        const detailLabel = item.detail ? ` — ${item.detail}` : "";
        console.log(`      ${icon} ${item.hook}: ${item.event}${detailLabel}`);
      } else if (item.kind === "recovery") {
        const summaryLabel = item.summary ? ` (${item.summary})` : "";
        console.log(`    ✓ ${item.tool}${summaryLabel} (recovery)`);
      }
    }
  }

  // Summary
  const recovered = episodes.filter(e => e.recovered).length;
  const unrecovered = episodes.length - recovered;
  const recoveredEpisodes = episodes.filter(e => e.recovered);
  let avgRecoveryLabel = "";
  if (recoveredEpisodes.length > 0) {
    const durations = recoveredEpisodes
      .map(e => computeDurationMs(e.start_ts, e.end_ts))
      .filter(d => d != null);
    if (durations.length > 0) {
      const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
      avgRecoveryLabel = `, avg recovery time: ${Math.round(avg / 1000)}s`;
    }
  }

  console.log();
  console.log(`  Summary: ${episodes.length} failure episode${episodes.length !== 1 ? "s" : ""}, ${recovered} recovered${avgRecoveryLabel}`);
  console.log();
}

/**
 * Parse two ISO timestamps and return duration in milliseconds, or null if unparseable.
 */
function computeDurationMs(startTs, endTs) {
  try {
    const start = new Date(startTs).getTime();
    const end = new Date(endTs).getTime();
    if (isNaN(start) || isNaN(end)) return null;
    return Math.max(0, end - start);
  } catch (_) {
    return null;
  }
}

function formatToolSummary(toolName, input) {
  if (!input) return "";
  switch (toolName) {
    case "Read": return input.file_path ? path.basename(input.file_path) : "";
    case "Write": return input.file_path ? path.basename(input.file_path) : "";
    case "Edit": return input.file_path ? path.basename(input.file_path) : "";
    case "Bash": return (input.command || "").slice(0, 60);
    case "Glob": return input.pattern || "";
    case "Grep": return input.pattern || "";
    case "Task": return input.description || "";
    default: return "";
  }
}

function formatTime(ts) {
  if (!ts) return "??:??:??";
  // Handle ISO timestamps — extract HH:MM:SS
  const match = String(ts).match(/(\d{2}:\d{2}:\d{2})/);
  if (match) return match[1];
  // Handle step-N fallback
  if (ts.startsWith("step-")) return ts;
  return ts.slice(0, 8);
}

function printAggregate(entries) {
  console.log("=== Aggregate Metrics ===");
  if (entries.length === 0) {
    console.log("No entries to aggregate.");
    console.log();
    return;
  }

  // Group all entries by session
  const bySession = {};
  for (const entry of entries) {
    const sid = entry.session_id || "unknown";
    if (!bySession[sid]) bySession[sid] = [];
    bySession[sid].push(entry);
  }

  const sessionCount = Object.keys(bySession).length;
  console.log(`Sessions analyzed: ${sessionCount}`);
  console.log();

  // Context usage at session end
  const contextAtEnd = [];
  for (const [, sessionEntries] of Object.entries(bySession)) {
    const cgEntries = sessionEntries.filter(e => e.hook === "context-guard" && e.context && e.context.pct != null);
    if (cgEntries.length > 0) {
      const last = cgEntries[cgEntries.length - 1];
      contextAtEnd.push(last.context.pct);
    }
  }

  if (contextAtEnd.length > 0) {
    contextAtEnd.sort((a, b) => a - b);
    const avg = contextAtEnd.reduce((a, b) => a + b, 0) / contextAtEnd.length;
    const median = contextAtEnd[Math.floor(contextAtEnd.length / 2)];
    const max = contextAtEnd[contextAtEnd.length - 1];
    console.log("Context usage at last checkpoint:");
    console.log(`  avg: ${avg.toFixed(1)}%  median: ${median.toFixed(1)}%  max: ${max.toFixed(1)}%  (${contextAtEnd.length} sessions with data)`);
    console.log();
  }

  // Hook fire rates per session
  const hookNames = new Set(entries.map(e => e.hook).filter(Boolean));
  const hookStats = {};
  for (const hook of hookNames) {
    const sessionsWithHook = new Set();
    let totalFires = 0;
    for (const entry of entries) {
      if (entry.hook === hook) {
        totalFires++;
        if (entry.session_id) sessionsWithHook.add(entry.session_id);
      }
    }
    hookStats[hook] = { sessions: sessionsWithHook.size, fires: totalFires };
  }

  console.log("Hook activity:");
  const sorted = Object.entries(hookStats).sort((a, b) => b[1].fires - a[1].fires);
  for (const [hook, stats] of sorted) {
    const perSession = (stats.fires / stats.sessions).toFixed(1);
    console.log(`  ${hook.padEnd(28)} ${String(stats.fires).padStart(5)} fires across ${String(stats.sessions).padStart(3)} sessions (${perSession}/session)`);
  }
  console.log();

  // Stuck-detector and sycophancy rates
  const stuckSessions = new Set();
  const sycophancySessions = new Set();
  for (const entry of entries) {
    if (entry.hook === "stuck-detector" && entry.session_id) stuckSessions.add(entry.session_id);
    if (entry.hook === "sycophancy-detector" && (entry.event === "warn" || entry.event === "escalate") && entry.session_id) {
      sycophancySessions.add(entry.session_id);
    }
  }

  console.log("Session health:");
  console.log(`  Sessions with stuck-detector triggers:  ${stuckSessions.size}/${sessionCount} (${((stuckSessions.size / sessionCount) * 100).toFixed(0)}%)`);
  console.log(`  Sessions with sycophancy warnings:      ${sycophancySessions.size}/${sessionCount} (${((sycophancySessions.size / sessionCount) * 100).toFixed(0)}%)`);

  // Model routing distribution
  const routeEntries = entries.filter(e => e.hook === "model-router" && e.event === "route");
  if (routeEntries.length > 0) {
    const models = {};
    for (const e of routeEntries) {
      const m = (e.context && e.context.model) || "unknown";
      const tier = m.includes("haiku") ? "haiku" : m.includes("sonnet") ? "sonnet" : m.includes("opus") ? "opus" : "other";
      models[tier] = (models[tier] || 0) + 1;
    }
    console.log(`  Model routing: ${Object.entries(models).map(([k, v]) => `${k}=${v}`).join(", ")} (${routeEntries.length} total)`);
  }

  console.log();
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  const entries = loadEntries(args);

  if (args.timeline) {
    printTimeline(args.timeline, args.projectDir, entries);
  } else if (args.provenance) {
    printProvenance(args.provenance, args.projectDir, entries);
  } else if (args.failureChains) {
    printFailureChains(args.failureChains, args.projectDir, entries);
  } else {
    printSummary(entries);
    printContextGuard(entries);
    printStuckDetector(entries);
    printSycophancyDetector(entries);
    printModelRouter(entries);
    printInjectionGuard(entries);
    if (args.aggregate) {
      printAggregate(entries);
    }
    if (args.retrievalMisses) {
      printRetrievalMisses();
    }
  }
}

module.exports = {
  parseArgs,
  loadEntries,
  buildTimeline,
  printTimeline,
  printProvenance,
  printFailureChains,
  printAggregate,
  printSummary,
  formatTime,
  formatToolSummary,
};
