---
name: continue
description: Continue work from where the last session left off. Checks inbox, reads Current Work from memory, and presents context.
disable-model-invocation: false
allowed-tools: Read, Glob, Grep, Bash
argument-hint: ""
---

# Continue

Pick up where the last session left off. Check inbox first, then read memory, then propose action.

## Steps

### 1. Find the memory file

Check for a project-level memory file first, then fall back to the most recent global memory:

1. Look for `MEMORY.md` in the project's memory directory (the path Claude Code auto-creates under `~/.claude/projects/`)
2. If not in a project, scan `~/.claude/projects/*/memory/MEMORY.md` and pick the most recently modified one

### 2. Extract Current Work

If no memory file was found in step 2, or the file has no `## Current Work` section, tell the user:

```text
No prior session found. This looks like a fresh start.
Suggestions:
  - Start working on your task directly
  - Run /playbook to set up project conventions
  - Run /checkpoint when you're ready to save progress
```

Then skip to step 4.

Otherwise, read the memory file and locate the `## Current Work` section. Present it to the user with clear formatting:

```text
Last session: <date from Current Work>

What was done:
  <summary>

Current state:
  <state>

Next steps:
  <next steps>
```

### 3. Scan for context

Check for additional context that might be relevant:
- Run `git status` to see if there are uncommitted changes from the previous session
- Run `git log --oneline -3` to see recent commits
- If the project has a task list, check for in-progress or blocked tasks

### 4. Propose action

Based on the Current Work section and context scan, propose what to work on next. Ask the user to confirm or redirect.
