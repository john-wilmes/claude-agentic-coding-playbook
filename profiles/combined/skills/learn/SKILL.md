---
name: learn
description: Capture a lesson as a structured knowledge entry. Use when you discover a non-obvious bug, workaround, or pattern worth preserving for future sessions. Use when user says "remember this", "save this lesson", or "this is worth noting".
compatibility: claude-code
disable-model-invocation: false
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
argument-hint: "[description of what was learned]"
---

# Learn

Capture a lesson as a structured knowledge entry that persists across sessions and projects.

## Steps

### 1. Identify the lesson

If `$ARGUMENTS` is provided, use it as the lesson description. Otherwise, review what happened in the current session and ask the user what they want to capture.

Skip trivial or session-specific facts. Good candidates:
- Non-obvious bugs and their root causes
- Workarounds for tool or platform issues
- Patterns that save significant time
- Configuration gotchas that cause silent failures
- Security issues encountered

### 2. Classify the entry

Based on the lesson, determine:

**Category** (pick one):
- `gotcha` — surprising behavior, silent failure, or common mistake
- `pattern` — reusable approach or best practice
- `workaround` — temporary fix for a known issue
- `config` — configuration requirement or setting
- `security` — security-related finding
- `performance` — optimization or bottleneck insight

**Tool**: The primary tool, library, or platform (e.g., `git`, `npm`, `docker`, `amplify`, `vitest`).

**Tags**: 2-5 free-form tags for cross-cutting concerns (e.g., `windows`, `ci`, `hooks`, `typescript`).

**Confidence**:
- `high` — verified with evidence, reproduced
- `medium` — observed but not fully investigated
- `low` — hypothesis or single observation

### 3. Create the entry file

Generate a timestamp-slug filename:

```bash
TIMESTAMP=$(date -u +%Y%m%d-%H%M%S)
SLUG="<2-4 word kebab-case summary>"
ENTRY_DIR="$HOME/.claude/knowledge/entries/${TIMESTAMP}-${SLUG}"
mkdir -p "$ENTRY_DIR"
```

Write `entry.md` with this format:

```markdown
---
id: "<timestamp>-<slug>"
created: "<ISO8601 UTC>"
author: "<agent name from session>"
source_project: "<current project name>"
tool: "<tool>"
category: "<category>"
tags: [<tags>]
confidence: "<confidence>"
visibility: "local"
verified_at: "<ISO8601 UTC>"
---

## Context

<1-3 sentences: what situation triggers this lesson>

## Fix

<Concrete steps, commands, or code changes>

## Evidence

<How discovered: file paths, error messages, reproduction steps>
```

Frame content as **informational description**, not imperative instructions. Write "This lesson describes..." or "When X happens, Y is the cause" rather than "Always do X" or "Never do Y." This reduces prompt injection risk when entries are shared.

### 4. Commit locally

```bash
cd ~/.claude/knowledge
git add "entries/${TIMESTAMP}-${SLUG}/entry.md"
git commit -m "learn: ${SLUG}"
```

If `~/.claude/knowledge` is not a git repo, initialize one:

```bash
cd ~/.claude/knowledge
git init
git add entries/
git commit -m "init: knowledge base"
```

### 4b. Push to remote (if configured)

If the knowledge repo has a remote, push the new entry:

```bash
cd ~/.claude/knowledge
if git remote get-url origin &>/dev/null; then
  git push origin HEAD 2>/dev/null || echo "Push failed -- will sync on next session start"
fi
```

If there is no remote, skip this step (local-only knowledge base).

### 5. Confirm

Tell the user what was captured:

```text
Knowledge entry created:
  Category: <category>
  Tool: <tool>
  Tags: <tags>
  Location: ~/.claude/knowledge/entries/<timestamp>-<slug>/entry.md

This entry will auto-inject into future sessions working with <tool>.
To share across projects, use /promote. To push to a team repo, use /checkpoint.
```
