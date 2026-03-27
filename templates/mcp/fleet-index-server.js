#!/usr/bin/env node
// fleet-index-server.js — MCP stdio server for the repo fleet index.
//
// Reads pre-built fleet manifests and serves them via the Model Context
// Protocol (JSON-RPC 2.0 over stdio). Does NOT trigger indexing.
//
// Tools exposed:
//   search_repos   BM25 search over fleet manifests
//   get_manifest   Full manifest JSON for a specific repo
//   list_repos     List all indexed repos with optional filters
//   get_digest     Return the compact fleet-digest.txt contents
//
// Usage (MCP settings.json):
//   { "command": "node", "args": ["~/.claude/mcp/fleet-index-server.js"] }

"use strict";

const fs   = require("fs");
const path = require("path");
const os   = require("os");
const rl   = require("readline");

// ─── Default paths ───────────────────────────────────────────────────────────

const HOME          = os.homedir();
const DEFAULT_FLEET = path.join(HOME, ".claude", "fleet");
const MANIFESTS_DIR = process.env.FLEET_MANIFESTS_DIR
  || path.join(DEFAULT_FLEET, "manifests");
const DIGEST_FILE   = process.env.FLEET_DIGEST_FILE
  || path.join(DEFAULT_FLEET, "fleet-digest.txt");

// ─── Load fleet-index module (try installed path first, then source tree) ────

let fleetIndex = null;

// ─── Client info (captured during initialize) ────────────────────────────────

let clientCapabilities = null;
let clientInfo = null;

function loadFleetIndex() {
  if (fleetIndex) return fleetIndex;

  const candidates = [
    path.join(HOME, ".claude", "fleet", "fleet-index.js"),
    path.join(__dirname, "..", "fleet", "fleet-index.js"),
  ];

  for (const candidate of candidates) {
    try {
      fleetIndex = require(candidate);
      return fleetIndex;
    } catch {
      // try next
    }
  }

  // Return a stub so the server still starts but tools degrade gracefully.
  // This is a transient degradation — fleet-index.js failed to load (missing or corrupt).
  fleetIndex = {
    searchRepos: () => [],
    listRepos: () => [],
    getManifest: () => null,
  };
  return fleetIndex;
}

// ─── BM25 search helpers (inline — no fleet-index dependency for pure search) ─

// If fleet-index provides searchRepos, use it.  Otherwise fall back to a
// lightweight in-process BM25 built from the manifests on disk.

const STOPWORDS = new Set([
  "the", "is", "at", "which", "on", "a", "an", "in", "for", "to", "of",
  "and", "or", "but", "not", "with", "by", "from", "as", "be", "was",
  "were", "been", "are", "have", "has", "had", "do", "does", "did",
  "will", "would", "could", "should", "may", "might", "can", "shall",
  "this", "that", "these", "those", "it", "its", "i", "you", "he", "she",
  "we", "they", "me", "him", "her", "us", "them", "my", "your", "his",
  "our", "their", "what", "who", "how", "when", "where", "why", "if",
  "then", "else", "so", "no", "yes", "all", "each", "every", "both",
  "few", "more", "most", "other", "some", "such", "only", "same", "than",
  "too", "very",
]);

const BM25_K1 = 1.2;
const BM25_B  = 0.75;

function tokenize(text) {
  if (!text || typeof text !== "string") return [];
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

function buildBm25Index(docs) {
  const indexed = new Map();
  const df      = new Map();
  let totalLen  = 0;

  for (const doc of docs) {
    const tokens = tokenize(doc.text || "");
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    indexed.set(doc.id, { tokens, tf, length: tokens.length, meta: doc.meta });
    totalLen += tokens.length;
    for (const term of tf.keys()) df.set(term, (df.get(term) || 0) + 1);
  }

  const N     = docs.length;
  const avgdl = N > 0 ? totalLen / N : 0;
  return { indexed, df, avgdl, N };
}

function bm25Query(idx, queryText, topK = 10) {
  const { indexed, df, avgdl, N } = idx;
  if (N === 0) return [];

  const qTokens = tokenize(queryText);
  if (qTokens.length === 0) return [];

  const scores = new Map();
  for (const term of qTokens) {
    const n = df.get(term) || 0;
    if (n === 0) continue;
    const idf = Math.log((N - n + 0.5) / (n + 0.5) + 1);
    for (const [id, doc] of indexed) {
      const f = doc.tf.get(term) || 0;
      if (f === 0) continue;
      const denom = f + BM25_K1 * (1 - BM25_B + BM25_B * (doc.length / avgdl));
      scores.set(id, (scores.get(id) || 0) + idf * (f * (BM25_K1 + 1)) / denom);
    }
  }

  return Array.from(scores.entries())
    .map(([id, score]) => ({ id, score: Math.round(score * 1000) / 1000 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

// ─── Manifest helpers ─────────────────────────────────────────────────────────

function readManifests() {
  const results = [];
  try {
    if (!fs.existsSync(MANIFESTS_DIR)) return results;
    for (const entry of fs.readdirSync(MANIFESTS_DIR)) {
      if (!entry.endsWith(".json")) continue;
      try {
        const raw = fs.readFileSync(path.join(MANIFESTS_DIR, entry), "utf8");
        results.push(JSON.parse(raw));
      } catch {
        // skip malformed manifest
      }
    }
  } catch {
    // MANIFESTS_DIR unreadable
  }
  return results;
}

// Build search text for a manifest entry
function manifestToSearchText(m) {
  const parts = [
    m.repo || "",
    m.description || "",
    m.language || "",
    m.kind || "",
    ...(m.tags || []),
    ...(m.entryPoints || []),
    ...(m.exports || []),
    ...(m.dependencies || []),
  ];
  return parts.filter(Boolean).join(" ");
}

// ─── ClickUp HTTP helper ──────────────────────────────────────────────────────

function clickupRequest(apiPath) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.CLICKUP_API_KEY;
    if (!apiKey) {
      reject(new Error("CLICKUP_API_KEY environment variable is not set"));
      return;
    }
    const url = `https://api.clickup.com/api/v2${apiPath}`;
    const options = {
      headers: { Authorization: apiKey, "Content-Type": "application/json" },
    };
    const https = require("https");
    const req = https.get(url, options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(`ClickUp API error ${res.statusCode}: ${parsed.err || data}`));
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error(`Failed to parse ClickUp response: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

const CLICKUP_API_KEY_MISSING = {
  isError: true,
  errorCategory: "validation",
  isRetryable: false,
  description: "CLICKUP_API_KEY environment variable is not set",
};

// ─── Tool implementations ─────────────────────────────────────────────────────

function toolSearchRepos({ query, limit = 10 }) {
  if (!query || typeof query !== "string") {
    return { isError: true, errorCategory: "validation", isRetryable: false, description: "query is required and must be a string" };
  }

  const manifests = readManifests();
  if (manifests.length === 0) {
    return [];
  }

  // Prefer fleet-index.searchRepos if available
  const fi = loadFleetIndex();
  if (typeof fi.searchRepos === "function") {
    try {
      return fi.searchRepos(query, limit);
    } catch {
      // transient degradation — fall through to inline BM25
    }
  }

  // Inline BM25 fallback
  const docs = manifests.map((m) => ({
    id:   m.repo,
    text: manifestToSearchText(m),
    meta: m,
  }));
  const idx = buildBm25Index(docs);
  const hits = bm25Query(idx, query, limit);

  return hits.map(({ id, score }) => {
    const m = docs.find((d) => d.id === id);
    const meta = m ? m.meta : {};
    return {
      repo:        id,
      score,
      kind:        meta.kind        || null,
      language:    meta.language    || null,
      description: meta.description || null,
      quality:     meta.quality     || null,
    };
  });
}

function toolGetManifest({ repo }) {
  if (!repo || typeof repo !== "string") {
    return { isError: true, errorCategory: "validation", isRetryable: false, description: "repo is required and must be a string" };
  }

  const manifests = readManifests();
  const found = manifests.find((m) => m.repo === repo);
  if (!found) {
    return { isError: true, errorCategory: "validation", isRetryable: false, description: `No manifest found for repo: ${repo}` };
  }
  return found;
}

function toolListRepos({ kind, min_quality } = {}) {
  const manifests = readManifests();
  let results = manifests.map((m) => ({
    repo:        m.repo        || null,
    kind:        m.kind        || null,
    language:    m.language    || null,
    quality:     m.quality     || null,
    description: m.description || null,
  }));

  if (kind !== undefined && kind !== null) {
    results = results.filter((r) => r.kind === kind);
  }
  if (min_quality !== undefined && min_quality !== null) {
    const threshold = Number(min_quality);
    if (!Number.isNaN(threshold)) {
      results = results.filter((r) => (r.quality || 0) >= threshold);
    }
  }

  return results.sort((a, b) => (a.repo || "").localeCompare(b.repo || ""));
}

function toolGetDigest() {
  try {
    if (!fs.existsSync(DIGEST_FILE)) {
      return { isError: true, errorCategory: "validation", isRetryable: false, description: `Fleet digest not found at: ${DIGEST_FILE}` };
    }
    return fs.readFileSync(DIGEST_FILE, "utf8");
  } catch (err) {
    return { isError: true, errorCategory: "transient", isRetryable: true, description: `Failed to read digest: ${err.message}` };
  }
}

async function toolClickupGetSpaces({ team_id } = {}) {
  if (!process.env.CLICKUP_API_KEY) return CLICKUP_API_KEY_MISSING;
  const tid = team_id || process.env.CLICKUP_TEAM_ID;
  if (!tid) {
    return { isError: true, errorCategory: "validation", isRetryable: false, description: "team_id argument or CLICKUP_TEAM_ID environment variable is required" };
  }
  const data = await clickupRequest(`/team/${tid}/space?archived=false`);
  return (data.spaces || []).map((s) => ({
    id:                 s.id,
    name:               s.name,
    private:            s.private,
    status:             s.status,
    multiple_assignees: s.multiple_assignees,
  }));
}

async function toolClickupGetLists({ space_id } = {}) {
  if (!process.env.CLICKUP_API_KEY) return CLICKUP_API_KEY_MISSING;
  if (!space_id) {
    return { isError: true, errorCategory: "validation", isRetryable: false, description: "space_id is required" };
  }
  const data = await clickupRequest(`/space/${space_id}/list?archived=false`);
  return (data.lists || []).map((l) => ({
    id:         l.id,
    name:       l.name,
    task_count: l.task_count,
    status:     l.status,
  }));
}

async function toolClickupGetTasks({ list_id, page = 0, include_closed = false } = {}) {
  if (!process.env.CLICKUP_API_KEY) return CLICKUP_API_KEY_MISSING;
  if (!list_id) {
    return { isError: true, errorCategory: "validation", isRetryable: false, description: "list_id is required" };
  }
  const data = await clickupRequest(`/list/${list_id}/task?page=${page}&include_closed=${include_closed}&subtasks=false`);
  return (data.tasks || []).map((t) => ({
    id:        t.id,
    name:      t.name,
    status:    t.status?.status || null,
    priority:  t.priority?.priority || null,
    assignees: (t.assignees || []).map((a) => a.username),
    due_date:  t.due_date || null,
    tags:      (t.tags || []).map((tg) => tg.name),
    url:       t.url,
  }));
}

async function toolClickupGetTask({ task_id } = {}) {
  if (!process.env.CLICKUP_API_KEY) return CLICKUP_API_KEY_MISSING;
  if (!task_id) {
    return { isError: true, errorCategory: "validation", isRetryable: false, description: "task_id is required" };
  }
  const t = await clickupRequest(`/task/${task_id}`);
  return {
    id:          t.id,
    name:        t.name,
    description: t.description || null,
    status:      t.status?.status || null,
    priority:    t.priority?.priority || null,
    assignees:   (t.assignees || []).map((a) => a.username),
    due_date:    t.due_date || null,
    tags:        (t.tags || []).map((tg) => tg.name),
    url:         t.url,
    list:        t.list  ? { id: t.list.id,  name: t.list.name  } : null,
    space:       t.space ? { id: t.space.id, name: t.space.name } : null,
    creator:     t.creator?.username || null,
  };
}

async function toolClickupSearchTasks({ query, team_id, page = 0 } = {}) {
  if (!process.env.CLICKUP_API_KEY) return CLICKUP_API_KEY_MISSING;
  if (!query) {
    return { isError: true, errorCategory: "validation", isRetryable: false, description: "query is required" };
  }
  const tid = team_id || process.env.CLICKUP_TEAM_ID;
  if (!tid) {
    return { isError: true, errorCategory: "validation", isRetryable: false, description: "team_id argument or CLICKUP_TEAM_ID environment variable is required" };
  }
  const data = await clickupRequest(`/team/${tid}/task?query=${encodeURIComponent(query)}&page=${page}&subtasks=false`);
  return (data.tasks || []).map((t) => ({
    id:        t.id,
    name:      t.name,
    status:    t.status?.status || null,
    priority:  t.priority?.priority || null,
    assignees: (t.assignees || []).map((a) => a.username),
    due_date:  t.due_date || null,
    tags:      (t.tags || []).map((tg) => tg.name),
    url:       t.url,
  }));
}

// ─── Tool registry ────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name:        "search_repos",
    description: "BM25 full-text search over fleet manifests. Returns repos ranked by relevance.",
    inputSchema: {
      type:     "object",
      properties: {
        query: {
          type:        "string",
          description: "Search query (keywords, repo names, technologies, etc.)",
        },
        limit: {
          type:        "number",
          description: "Maximum number of results to return (default: 10)",
        },
      },
      required: ["query"],
    },
  },
  {
    name:        "get_manifest",
    description: "Get the full indexed manifest for a specific repo.",
    inputSchema: {
      type:     "object",
      properties: {
        repo: {
          type:        "string",
          description: "Repository identifier, e.g. \"org/payment-service\"",
        },
      },
      required: ["repo"],
    },
  },
  {
    name:        "list_repos",
    description: "List all indexed repos with optional kind and quality filters.",
    inputSchema: {
      type:       "object",
      properties: {
        kind: {
          type:        "string",
          description: "Filter by repo kind (e.g. \"service\", \"library\", \"tool\")",
        },
        min_quality: {
          type:        "number",
          description: "Minimum quality score (0–100) to include",
        },
      },
    },
  },
  {
    name:        "get_digest",
    description: "Return the compact fleet-digest.txt — a one-line-per-repo summary of all indexed repos.",
    inputSchema: {
      type:       "object",
      properties: {},
    },
  },
  {
    name:        "clickup_get_spaces",
    description: "List all spaces in the ClickUp workspace. Requires CLICKUP_API_KEY and CLICKUP_TEAM_ID.",
    inputSchema: {
      type:       "object",
      properties: {
        team_id: {
          type:        "string",
          description: "ClickUp team ID (overrides CLICKUP_TEAM_ID env var)",
        },
      },
    },
  },
  {
    name:        "clickup_get_lists",
    description: "List all lists in a ClickUp space (non-archived). Use clickup_get_spaces first to find space IDs.",
    inputSchema: {
      type:       "object",
      properties: {
        space_id: {
          type:        "string",
          description: "ClickUp space ID",
        },
      },
      required: ["space_id"],
    },
  },
  {
    name:        "clickup_get_tasks",
    description: "Get tasks from a ClickUp list. Returns up to 100 tasks with key fields.",
    inputSchema: {
      type:       "object",
      properties: {
        list_id: {
          type:        "string",
          description: "ClickUp list ID",
        },
        page: {
          type:        "number",
          description: "Page number for pagination (default: 0)",
        },
        include_closed: {
          type:        "boolean",
          description: "Include closed tasks (default: false)",
        },
      },
      required: ["list_id"],
    },
  },
  {
    name:        "clickup_get_task",
    description: "Get a single ClickUp task by ID with full details.",
    inputSchema: {
      type:       "object",
      properties: {
        task_id: {
          type:        "string",
          description: "ClickUp task ID",
        },
      },
      required: ["task_id"],
    },
  },
  {
    name:        "clickup_search_tasks",
    description: "Search tasks in the workspace by keyword. Requires CLICKUP_TEAM_ID.",
    inputSchema: {
      type:       "object",
      properties: {
        query: {
          type:        "string",
          description: "Search keyword(s)",
        },
        team_id: {
          type:        "string",
          description: "ClickUp team ID (overrides CLICKUP_TEAM_ID env var)",
        },
        page: {
          type:        "number",
          description: "Page number for pagination (default: 0)",
        },
      },
      required: ["query"],
    },
  },
];

// ─── JSON-RPC helpers ─────────────────────────────────────────────────────────

function reply(id, result) {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, result });
  process.stdout.write(msg + "\n");
}

function replyError(id, code, message) {
  const msg = JSON.stringify({
    jsonrpc: "2.0",
    id,
    error:  { code, message },
  });
  process.stdout.write(msg + "\n");
}

function log(msg) {
  process.stderr.write(`[fleet-index-server] ${msg}\n`);
}

// ─── Request dispatcher ───────────────────────────────────────────────────────

function dispatch(req) {
  const { id, method, params = {} } = req;

  try {
    switch (method) {
      case "initialize":
        clientCapabilities = params.capabilities || null;
        clientInfo = params.clientInfo || null;
        reply(id, {
          protocolVersion: "2025-03-26",
          capabilities:    { tools: {}, resources: {} },
          serverInfo:      { name: "fleet-index", version: "1.2.0" },
        });
        break;

      case "initialized":
        // Notification only — no response required
        break;

      case "tools/list":
        reply(id, { tools: TOOLS });
        break;

      case "tools/call": {
        const toolName = params.name;
        const args     = params.arguments || {};

        const runTool = () => {
          switch (toolName) {
            case "search_repos":           return toolSearchRepos(args);
            case "get_manifest":           return toolGetManifest(args);
            case "list_repos":             return toolListRepos(args);
            case "get_digest":             return toolGetDigest();
            case "clickup_get_spaces":     return toolClickupGetSpaces(args);
            case "clickup_get_lists":      return toolClickupGetLists(args);
            case "clickup_get_tasks":      return toolClickupGetTasks(args);
            case "clickup_get_task":       return toolClickupGetTask(args);
            case "clickup_search_tasks":   return toolClickupSearchTasks(args);
            default:
              replyError(id, -32601, `Unknown tool: ${toolName}`);
              return undefined;
          }
        };

        const result = runTool();
        if (result === undefined) break; // error already sent

        Promise.resolve(result).then((resolved) => {
          reply(id, {
            content: [{ type: "text", text: JSON.stringify(resolved, null, 2) }],
          });
        }).catch((err) => {
          replyError(id, -32603, `Tool error: ${err.message}`);
        });
        break;
      }

      case "resources/list": {
        const resources = [];
        // Always include digest
        resources.push({
          uri: "fleet://digest",
          name: "Fleet Digest",
          description: "One-line-per-repo summary of all indexed repos",
          mimeType: "text/plain",
        });
        // Add one resource per manifest
        const manifests = readManifests();
        for (const m of manifests) {
          if (m.repo) {
            resources.push({
              uri: `fleet://manifest/${m.repo}`,
              name: `Manifest: ${m.repo}`,
              description: m.description || `Fleet manifest for ${m.repo}`,
              mimeType: "application/json",
            });
          }
        }
        reply(id, { resources });
        break;
      }

      case "resources/read": {
        const uri = params.uri || "";
        if (uri === "fleet://digest") {
          const digest = toolGetDigest();
          if (typeof digest === "string") {
            reply(id, {
              contents: [{ uri, mimeType: "text/plain", text: digest }],
            });
          } else {
            replyError(id, -32602, digest.description || "Failed to read digest");
          }
        } else if (uri.startsWith("fleet://manifest/")) {
          const repo = uri.slice("fleet://manifest/".length);
          const manifest = toolGetManifest({ repo });
          if (manifest && !manifest.isError) {
            reply(id, {
              contents: [{
                uri,
                mimeType: "application/json",
                text: JSON.stringify(manifest, null, 2),
              }],
            });
          } else {
            replyError(id, -32602, manifest?.description || `Unknown manifest: ${repo}`);
          }
        } else {
          replyError(id, -32602, `Unknown resource URI: ${uri}`);
        }
        break;
      }

      case "ping":
        reply(id, {});
        break;

      default:
        replyError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    log(`Error handling ${method}: ${err.message}`);
    replyError(id, -32603, `Internal error: ${err.message}`);
  }
}

// ─── Stdin reader ─────────────────────────────────────────────────────────────

function main() {
  log("starting (manifests: " + MANIFESTS_DIR + ")");

  const reader = rl.createInterface({
    input:     process.stdin,
    crlfDelay: Infinity,
  });

  reader.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let req;
    try {
      req = JSON.parse(trimmed);
    } catch {
      // Malformed JSON — send parse error with null id
      replyError(null, -32700, "Parse error: invalid JSON");
      return;
    }

    if (!req.method) {
      replyError(req.id || null, -32600, "Invalid request: missing method");
      return;
    }

    dispatch(req);
  });

  reader.on("close", () => {
    log("stdin closed, shutting down");
    process.exit(0);
  });

  // Never crash on unhandled errors — log to stderr and continue
  process.on("uncaughtException", (err) => {
    log(`uncaughtException: ${err.message}`);
  });

  process.on("unhandledRejection", (reason) => {
    log(`unhandledRejection: ${reason}`);
  });
}

main();
