---
name: promote
description: Promote a project-level lesson to global scope so it's available across all projects. Use when a lesson discovered in one project would benefit others.
disable-model-invocation: false
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
argument-hint: "[lesson description or 'list' to see candidates]"
---

# Promote

Promote a lesson from this project's memory to global scope so it applies to all future projects.

## Steps

### 1. Find project lessons

Read the project's `MEMORY.md` file. It is located in the Claude Code auto-created project memory directory. To find it deterministically:

1. Run `pwd` to get the current working directory (e.g., `/home/user/Documents/my-project`).
2. Encode the path: replace `:` with `-`, replace each `/` with `-`, strip any leading `-`. For example, `/home/user/Documents/my-project` becomes `home-user-Documents-my-project`.
3. Store the project directory name (last path component, e.g., `my-project`) and the full path for use in the Source field later.
4. Look up `~/.claude/projects/<encoded>/memory/MEMORY.md` directly.
5. If that file does not exist, fall back to:
   ```bash
   ls ~/.claude/projects/*/memory/MEMORY.md 2>/dev/null
   ```
   If multiple candidates match, list them and prompt the user to select the correct one.

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

Read `~/.claude/CLAUDE.md`. Scan it for any existing entry that covers the same topic as the selected lesson. Also check `~/.claude/knowledge/entries/` if that directory exists.

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

**If `~/.claude/knowledge/entries/` exists** (preferred path):

Derive the filename from the lesson topic using these rules:
1. Take the first 5-7 words of the lesson topic or title.
2. Lowercase all characters.
3. Replace spaces with hyphens.
4. Strip all characters except lowercase letters, digits, and hyphens.
5. Truncate to 50 characters (before adding extension).
6. Append `.md`.
7. If the file already exists, append `-2`, `-3`, etc. before the `.md` extension until the name is unique.

For example, "Git hooks must use core.hooksPath on shared machines" → `git-hooks-must-use-core-hookspath-on-shared.md`.

Create the file with this format:

```markdown
# <Short title>

<Full lesson text>

Source: <project directory name captured in step 1>
Date: <today's date>
```

**Otherwise**, add the lesson to `~/.claude/CLAUDE.md`:

- Find or create a `## Cross-Project Lessons` section at the end of the file (before any trailing newline).
- Append the lesson as a bullet point: `- <lesson text>`

If the user chose "update" in step 3:
- **In `~/.claude/knowledge/entries/`**: locate the existing file by matching its ID or the lesson text it contains. Replace the entire file contents with the new lesson, keeping the same filename. If no matching file can be found, tell the user "Could not locate the existing entry to replace — please specify the filename." and do not write anything.
- **In `~/.claude/CLAUDE.md`**: locate the specific bullet in `## Cross-Project Lessons` that matches the existing lesson text. Replace only that bullet with the new lesson text. If the bullet cannot be found, tell the user "Could not locate the existing entry in CLAUDE.md — please check the file manually." and do not write anything.

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

Location: ~/.claude/knowledge/entries/<filename>.md
```
