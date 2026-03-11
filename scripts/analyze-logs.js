#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const LOG_DIR = path.join(os.homedir(), ".claude", "logs");

function parseArgs(argv) {
  const args = { since: null, session: null, hook: null, excludeTests: false, project: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--since" && argv[i + 1]) { args.since = argv[++i]; }
    else if (argv[i] === "--session" && argv[i + 1]) { args.session = argv[++i]; }
    else if (argv[i] === "--hook" && argv[i + 1]) { args.hook = argv[++i]; }
    else if (argv[i] === "--exclude-tests") { args.excludeTests = true; }
    else if (argv[i] === "--project" && argv[i + 1]) { args.project = argv[++i]; }
    else if (argv[i] === "--help") {
      console.log("Usage: node scripts/analyze-logs.js [--since YYYY-MM-DD] [--session PREFIX] [--hook NAME] [--exclude-tests] [--project NAME]");
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

const args = parseArgs(process.argv);
const entries = loadEntries(args);
printSummary(entries);
printContextGuard(entries);
printStuckDetector(entries);
printModelRouter(entries);
printInjectionGuard(entries);
