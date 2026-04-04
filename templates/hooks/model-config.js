// Shared model configuration module for hooks.
// Maps model IDs to context window size, cost tier, and display name.
// Persists the active model per session so PreToolUse/PostToolUse hooks
// (which don't receive model in their input) can look it up.
//
// Usage from any hook:
//   let modelConfig;
//   try { modelConfig = require("./model-config"); } catch { modelConfig = null; }
//   const cfg = modelConfig ? modelConfig.getSessionModel(sessionId) : { contextWindow: 200_000 };

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

// Model database: regex patterns matched against the resolved model ID.
// Ordered most-specific first; first match wins.
//
// Opus defaults to 1M: the [1m] suffix from Claude Code's model selector
// does not survive into hook payloads (hookInput.model is the resolved ID,
// e.g. "claude-opus-4-6"). Since 1M is the default for Max/Team/Enterprise,
// we default opus to 1M. Worst case for a 200k opus user: checkpoint warnings
// fire later than intended, but the failsafe still works via auto-compaction.
const MODEL_DB = [
  { pattern: /opus/i,   contextWindow: 1_000_000, costTier: 5, displayName: "Opus" },
  { pattern: /sonnet/i, contextWindow: 200_000,   costTier: 3, displayName: "Sonnet" },
  { pattern: /haiku/i,  contextWindow: 200_000,   costTier: 1, displayName: "Haiku" },
];

const DEFAULT_CONFIG = Object.freeze({
  contextWindow: 200_000,
  costTier: 3,
  displayName: "Unknown",
});

/**
 * Pure lookup: map a model ID string to its config.
 * Returns DEFAULT_CONFIG for unrecognized models.
 */
function getModelConfig(modelId) {
  if (!modelId) return DEFAULT_CONFIG;
  for (const entry of MODEL_DB) {
    if (entry.pattern.test(modelId)) {
      return {
        contextWindow: entry.contextWindow,
        costTier: entry.costTier,
        displayName: entry.displayName,
      };
    }
  }
  return DEFAULT_CONFIG;
}

// --- Per-session state persistence ---

function getStateDir() {
  const dir = path.join(os.tmpdir(), "claude-model-config");
  try { fs.mkdirSync(dir, { mode: 0o700, recursive: true }); } catch {}
  return dir;
}

function getStateFile(sessionId) {
  return path.join(getStateDir(), `${path.basename(sessionId)}.json`);
}

/**
 * Called by session-start to persist the active model for the session.
 */
function saveSessionModel(sessionId, modelId) {
  if (!sessionId) return;
  try {
    fs.writeFileSync(
      getStateFile(sessionId),
      JSON.stringify({ modelId, savedAt: Date.now() })
    );
  } catch {}
}

/**
 * Called by other hooks (context-guard, etc.) to read the session's model config.
 * Returns DEFAULT_CONFIG if the state file is missing or unreadable.
 */
function getSessionModel(sessionId) {
  if (!sessionId) return DEFAULT_CONFIG;
  try {
    const raw = JSON.parse(fs.readFileSync(getStateFile(sessionId), "utf8"));
    return getModelConfig(raw.modelId || "");
  } catch {
    return DEFAULT_CONFIG;
  }
}

module.exports = { getModelConfig, saveSessionModel, getSessionModel, DEFAULT_CONFIG, MODEL_DB };
