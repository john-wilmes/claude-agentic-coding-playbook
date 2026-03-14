#!/usr/bin/env node
/**
 * skill-guard.js — PreToolUse hook for the Skill tool.
 *
 * 1. Blocks invocation of unregistered skills (not found in ~/.claude/skills/).
 * 2. Warns on repeat invocations of the same skill within a session.
 *
 * Environment variables:
 *   SKILL_GUARD_ALLOWLIST — comma-separated extra skill names to allow
 *                           (for built-in or MCP-provided skills)
 */

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function output(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

function pass() {
  output({});
}

function deny(reason) {
  output({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
}

function warn(message) {
  output({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: message,
    },
  });
}

// ---------------------------------------------------------------------------
// Skill discovery
// ---------------------------------------------------------------------------

/**
 * Scan ~/.claude/skills/ for installed skill directories.
 * Each subdirectory name is a valid skill.
 */
function getInstalledSkills(home) {
  const skillsDir = path.join(home, ".claude", "skills");
  try {
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Build the full set of allowed skill names.
 * Sources: installed skills + SKILL_GUARD_ALLOWLIST env var.
 */
function getAllowedSkills(home) {
  const installed = getInstalledSkills(home);
  const extra = (process.env.SKILL_GUARD_ALLOWLIST || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return new Set([...installed, ...extra]);
}

/**
 * Normalize a skill name for matching.
 * Handles qualified names like "ms-office-suite:pdf" → "pdf".
 */
function normalizeSkillName(name) {
  if (name.includes(":")) {
    return name.split(":").pop();
  }
  return name;
}

// ---------------------------------------------------------------------------
// Session state (repeat detection)
// ---------------------------------------------------------------------------

function getStateFile(sessionId) {
  return path.join(os.tmpdir(), `skill-guard-${sessionId}.json`);
}

function loadState(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(getStateFile(sessionId), "utf8"));
  } catch {
    return { invocations: {} };
  }
}

function saveState(sessionId, state) {
  fs.writeFileSync(getStateFile(sessionId), JSON.stringify(state));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    const event = JSON.parse(input);
    const toolName = event.tool_name || "";
    const toolInput = event.tool_input || {};
    const sessionId = event.session_id || "unknown";

    // Only process Skill tool invocations
    if (toolName !== "Skill") return pass();

    const skillName = toolInput.skill || "";
    if (!skillName) return pass();

    const home = process.env.HOME || os.homedir();
    const normalizedName = normalizeSkillName(skillName);
    const allowedSkills = getAllowedSkills(home);

    // Check 1: Block unregistered skills
    if (!allowedSkills.has(skillName) && !allowedSkills.has(normalizedName)) {
      const registered = [...allowedSkills].sort().join(", ");
      return deny(
        `Skill guard: "${skillName}" is not a registered skill. ` +
          `Registered: ${registered || "(none)"}. ` +
          `Add it to SKILL_GUARD_ALLOWLIST env var if it should be allowed.`
      );
    }

    // Check 2: Detect repeat invocations
    const state = loadState(sessionId);
    const count = (state.invocations[normalizedName] || 0) + 1;
    state.invocations[normalizedName] = count;
    saveState(sessionId, state);

    if (count > 1) {
      return warn(
        `Skill guard: "${normalizedName}" has been invoked ${count} times this session. ` +
          `This may indicate a loop or unintended repeat.`
      );
    }

    pass();
  } catch {
    pass();
  }
});
