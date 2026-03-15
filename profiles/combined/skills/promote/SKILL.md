---
name: promote
description: Promote a project-level lesson to global scope so it's available across all projects. Use when user says "make this global", "share this across projects", or "promote this lesson". Use when a lesson discovered in one project would benefit others.
compatibility: claude-code
disable-model-invocation: false
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
argument-hint: "[lesson description or 'list' to see candidates]"
---

# Promote

Promote a lesson from this project's memory to global scope so it applies to all future projects.

## Steps

### 1. Find project lessons

Read the project's `MEMORY.md` file. It is located in the Claude Code auto-created project memory directory. To find it:

```bash
# The path is derived from the working directory
ls ~/.claude/projects/*/memory/MEMORY.md 2>/dev/null
```

Pick the one that corresponds to the current project (match the encoded project path in the directory name).

Extract the `## Lessons Learned` section. Collect each lesson as a candidate.

If `$ARGUMENTS` is provided and is not "list", use it directly as the lesson text — skip to step 3.

### 2. Present candidates

Show the lessons found, numbered:

```text
Lessons found in project memory:

  1. <lesson 1>
  2. <lesson 2>
  ...

Which lesson would you like to promote to global scope? (enter number or paste text)
```

Wait for the user to select one. If there is only one lesson, proceed with it automatically.

If no lessons section exists, tell the user and offer to accept a freeform lesson from them.

### 3. Check global scope for duplicates

Read `~/.claude/CLAUDE.md`. Scan it for any existing entry that covers the same topic as the selected lesson. Also search the knowledge database if available:

```bash
node ~/.claude/hooks/knowledge-db.js search "<topic keywords>" 2>/dev/null
```

If a near-duplicate is found, tell the user:

```text
A similar lesson already exists in global scope:

  "<existing text>"

Options:
  s - skip (keep existing)
  u - update (replace existing with new lesson)
  a - add anyway (keep both)
```

Wait for the user's choice before continuing.

### 4. Promote the lesson

**If `~/.claude/hooks/knowledge-db.js` exists** (preferred path — if it does not exist, use the fallback below):

Use the `/learn` skill to create a structured knowledge entry for the lesson. Pass the lesson text as the argument.

**Otherwise**, append the lesson to `~/.claude/CLAUDE.md`:

- Find or create a `## Cross-Project Lessons` section at the end of the file (before any trailing newline).
- Append the lesson as a bullet point: `- <lesson text>`

If the user chose "update" in step 3, replace the existing entry instead of appending.

### 5. Confirm

Tell the user what was promoted and where:

```text
Promoted to global scope:
  "<lesson text>"

Location: ~/.claude/CLAUDE.md (Cross-Project Lessons)
```

or

```text
Promoted to global scope:
  "<lesson text>"

Location: ~/.claude/knowledge/knowledge.db
```
