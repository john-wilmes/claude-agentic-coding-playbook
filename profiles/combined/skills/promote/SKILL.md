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

### Install Root Discovery

```bash
INSTALL_ROOT=$(bash ~/.claude/scripts/skills/find-install-root.sh)
```

### 1. Find project lessons

Read the project's `MEMORY.md` file. It is located in the Claude Code auto-created project memory directory. To find it:

```bash
# The path is derived from the working directory
ls ${INSTALL_ROOT}/.claude/projects/*/memory/MEMORY.md 2>/dev/null
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

Search both stores for an existing entry covering the same topic. Track which store the duplicate came from:

1. Search the knowledge database (if available):
   ```bash
   node ${INSTALL_ROOT}/.claude/hooks/knowledge-db.js search "<topic keywords>" 2>/dev/null
   ```
   If a match is found here, set `duplicate_source = "knowledge.db"`.

2. Read `${INSTALL_ROOT}/.claude/CLAUDE.md` and scan for any existing entry covering the same topic.
   If a match is found here, set `duplicate_source = "CLAUDE.md"`.

If a near-duplicate is found in either store, tell the user (noting where it was found):

```text
A similar lesson already exists in global scope (<duplicate_source>):

  "<existing text>"

Options:
  s - skip (keep existing)
  u - update (replace existing with new lesson)
  a - add anyway (keep both)
```

Wait for the user's choice before continuing.

### 4. Promote the lesson

Route based on the user's choice and the duplicate's source:

**If the user chose "update" in step 3:**
- If `duplicate_source = "knowledge.db"`: Use `/learn` with the new lesson text. The `/learn` skill handles updating existing entries in the database.
- If `duplicate_source = "CLAUDE.md"`: Find the existing entry in `~/.claude/CLAUDE.md` and replace it with the new lesson text.

**If the user chose "add" (or no duplicate was found):**

- **If `${INSTALL_ROOT}/.claude/hooks/knowledge-db.js` exists** (preferred path): Use the `/learn` skill to create a structured knowledge entry. Pass the lesson text as the argument.
- **Otherwise**, append the lesson to `${INSTALL_ROOT}/.claude/CLAUDE.md`: Find or create a `## Cross-Project Lessons` section at the end of the file (before any trailing newline). Append the lesson as a bullet point: `- <lesson text>`

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
