#!/usr/bin/env node
/**
 * skill-guard.js — PreToolUse hook for all tool invocations.
 *
 * For Skill tool invocations:
 *   1. Blocks invocation of unregistered skills (not found in ~/.claude/skills/).
 *   2. Runs prereqs commands from SKILL.md frontmatter; blocks if any fail.
 *   3. Warns on repeat invocations of the same skill within a session.
 *   4. Parses allowed-tools from SKILL.md frontmatter and saves active skill state.
 *
 * For all other tool invocations:
 *   5. If an active skill has an allowed-tools list, warns (advisory, not block)
 *      when the tool is not in the list.
 *
 * Environment variables:
 *   SKILL_GUARD_ALLOWLIST — comma-separated extra skill names to allow
 *                           (for built-in or MCP-provided skills)
 */

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

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

function getSkillGuardDir() {
  const dir = path.join(os.tmpdir(), "claude-skill-guard");
  try { fs.mkdirSync(dir, { mode: 0o700, recursive: true }); } catch {}
  return dir;
}

function getStateFile(sessionId) {
  return path.join(getSkillGuardDir(), `skill-guard-${path.basename(sessionId)}.json`);
}

function getActiveSkillFile(sessionId) {
  return path.join(getSkillGuardDir(), `skill-active-${path.basename(sessionId)}.json`);
}

function getGlobalActiveSkillFile() {
  return path.join(getSkillGuardDir(), "skill-active-global.json");
}

/**
 * Parse a comma-separated frontmatter field from a skill's SKILL.md.
 * Returns an array of trimmed, non-empty values.
 */
function parseFrontmatterField(home, skillName, fieldName) {
  try {
    const skillDir = path.join(home, ".claude", "skills", skillName);
    const skillMd = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
    const parts = skillMd.split("---");
    if (parts.length < 3) return [];
    const frontmatter = parts[1];
    const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^${escaped}:\\s*(.+)`);
    for (const line of frontmatter.split("\n")) {
      const match = line.match(re);
      if (match) {
        return match[1].split(",").map((s) => s.trim()).filter(Boolean);
      }
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Parse the allowed-tools list from a skill's SKILL.md frontmatter.
 * Returns an array of tool name patterns (may include wildcards).
 */
function parseAllowedTools(home, skillName) {
  return parseFrontmatterField(home, skillName, "allowed-tools");
}

/**
 * Parse prereqs commands from a skill's SKILL.md frontmatter.
 * Returns an array of shell commands to run before the skill activates.
 */
function parsePrereqs(home, skillName) {
  return parseFrontmatterField(home, skillName, "prereqs");
}

/**
 * Check if a prereq command is safe to execute.
 * Only allows: command -v, which, tool --version/-v,
 * test -f, [ -f ... ]. Rejects pipes, backticks, $(), eval, exec, curl, wget, bash -c, sh -c.
 */
function isAllowedPrereq(cmd) {
  if (!cmd || typeof cmd !== "string") return false;
  const trimmed = cmd.trim();

  // Reject dangerous shell constructs
  if (/[|`]/.test(trimmed)) return false;
  if (/\$\(/.test(trimmed)) return false;
  if (/\beval\b/.test(trimmed)) return false;
  if (/\bexec\b/.test(trimmed)) return false;
  if (/\bcurl\b/.test(trimmed)) return false;
  if (/\bwget\b/.test(trimmed)) return false;
  if (/\bbash\s+-c\b/.test(trimmed)) return false;
  if (/\bsh\s+-c\b/.test(trimmed)) return false;

  // Block shell metacharacters that chain commands (;, &&, ||, newlines, $())
  if (/[;&|`\n\r$]/.test(trimmed)) return false;

  // Allow: command -v <name> (alphanumeric/dash/underscore only)
  if (/^command\s+-v\s+[\w.-]+$/.test(trimmed)) return true;
  // Allow: which <name>
  if (/^which\s+[\w.-]+$/.test(trimmed)) return true;
  // Allow: <tool> --version or <tool> -v
  if (/^[\w.-]+\s+--version$/.test(trimmed) || /^[\w.-]+\s+-v$/.test(trimmed)) return true;
  // Allow: test -f <path> (no metacharacters in path)
  if (/^test\s+-[fedr]\s+[\w.\/~-]+$/.test(trimmed)) return true;
  // Allow: [ -f <path> ]
  if (/^\[\s+-[fedr]\s+[\w.\/~-]+\s+\]$/.test(trimmed)) return true;

  return false;
}

/**
 * Run prereqs commands. Returns { ok: true } or { ok: false, failed: string, error: string }.
 */
function runPrereqs(prereqs) {
  for (const cmd of prereqs) {
    // Validate command against allowlist before executing
    if (!isAllowedPrereq(cmd)) {
      return {
        ok: false,
        failed: cmd,
        error: "Prereq command not in allowlist. Only version checks (--version, -v), existence checks (which, command -v, test -f), and bracket tests are allowed.",
      };
    }
    try {
      execSync(cmd, { stdio: "pipe", timeout: 10000 });
    } catch (err) {
      return {
        ok: false,
        failed: cmd,
        error: (err.stderr || err.message || "").toString().trim().slice(0, 200),
      };
    }
  }
  return { ok: true };
}

function loadActiveSkill(sessionId) {
  // Try session-keyed file first (own session or already propagated).
  try {
    return JSON.parse(fs.readFileSync(getActiveSkillFile(sessionId), "utf8"));
  } catch {}
  // Fall back to global file so subagents inherit the parent's active skill.
  try {
    return JSON.parse(fs.readFileSync(getGlobalActiveSkillFile(), "utf8"));
  } catch {}
  return null;
}

function saveActiveSkill(sessionId, skillName, allowedTools) {
  const data = JSON.stringify({ skill: skillName, allowedTools });
  // Write session-keyed file for this session's own lookups.
  fs.writeFileSync(getActiveSkillFile(sessionId), data);
  // Write global fallback so subagents (with different session IDs) inherit
  // the active skill state without needing parent_session_id propagation.
  fs.writeFileSync(getGlobalActiveSkillFile(), data);
}

/**
 * Check if a tool name matches an allowed-tools pattern.
 * Supports exact match and trailing wildcard (e.g., "mcp__*").
 */
function matchesToolPattern(toolName, pattern) {
  if (pattern.endsWith("*")) {
    return toolName.startsWith(pattern.slice(0, -1));
  }
  return toolName === pattern;
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
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    const event = JSON.parse(input);
    const toolName = event.tool_name || "";
    const toolInput = event.tool_input || {};
    const sessionId = event.session_id || "unknown";

    const home = process.env.HOME || os.homedir();

    // Non-Skill tools: check against active skill's allowed-tools list
    if (toolName !== "Skill") {
      const active = loadActiveSkill(sessionId);
      if (active && active.allowedTools && active.allowedTools.length > 0) {
        const allowed = active.allowedTools.some((p) =>
          matchesToolPattern(toolName, p)
        );
        if (!allowed) {
          return warn(
            `Skill guard: tool "${toolName}" is not in the allowed-tools ` +
              `list for active skill "${active.skill}". ` +
              `Allowed: ${active.allowedTools.join(", ")}`
          );
        }
      }
      return pass();
    }

    const skillName = toolInput.skill || "";
    if (!skillName) return pass();

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

    // Check 2: Run prereqs commands (if any)
    const prereqs = parsePrereqs(home, normalizedName);
    if (prereqs.length > 0) {
      const result = runPrereqs(prereqs);
      if (!result.ok) {
        return deny(
          `Skill guard: prereq failed for "${normalizedName}": ` +
            `command "${result.failed}" failed: ${result.error}`
        );
      }
    }

    // Check 3: Detect repeat invocations
    const state = loadState(sessionId);
    const count = (state.invocations[normalizedName] || 0) + 1;
    state.invocations[normalizedName] = count;
    saveState(sessionId, state);

    // Check 4: Parse allowed-tools and save active skill state
    const allowedTools = parseAllowedTools(home, normalizedName);
    saveActiveSkill(sessionId, normalizedName, allowedTools);

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
