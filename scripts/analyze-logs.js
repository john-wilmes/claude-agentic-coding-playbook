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
  const args = { since: null, session: null, hook: null, excludeTests: false, project: null, retrievalMisses: false, timeline: null, projectDir: null, aggregate: false };
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
    else if (argv[i] === "--help") {
      console.log("Usage: node scripts/analyze-logs.js [OPTIONS]");
      console.log("");
      console.log("Options:");
      console.log("  --since YYYY-MM-DD     Filter entries after date");
      console.log("  --session PREFIX       Filter by session ID prefix");
      console.log("  --hook NAME            Filter by hook name");
      console.log("  --exclude-tests        Exclude test-sourced entries");
      console.log("  --project NAME         Filter by project name substring");
      console.log("  --retrieval-misses     Show BM25 retrieval miss analysis");
      console.log("  --timeline SESSION_ID  Show session timeline (requires --project-dir)");
      console.log("  --project-dir PATH     Project working directory for transcript lookup");
      console.log("  --aggregate            Show cross-session aggregate metrics");
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

function printTimeline(sessionId, projectDir, hookEntries) {
  console.log(`=== Session Timeline: ${sessionId} ===`);

  // Load transcript entries if project dir provided
  let transcriptEntries = [];
  if (projectDir) {
    const sessionFile = transcriptParser.findSessionFile(sessionId, projectDir);
    if (sessionFile) {
      transcriptEntries = transcriptParser.parseSessionFile(sessionFile);
    } else {
      // Try most recent session if exact match fails
      const recent = transcriptParser.findMostRecentSession(projectDir);
      if (recent) {
        console.log(`  (session file not found for "${sessionId}", showing most recent)`);
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
    });
  }

  if (timeline.length === 0) {
    console.log("  No timeline events found.");
    if (!projectDir) {
      console.log("  Tip: use --project-dir <path> to include transcript tool calls.");
    }
    console.log();
    return;
  }

  // Sort by timestamp
  timeline.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));

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
  printTimeline,
  printAggregate,
  printSummary,
  formatTime,
  formatToolSummary,
};
