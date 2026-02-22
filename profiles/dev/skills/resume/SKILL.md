---
name: resume
description: Resume work from where the last session left off. Reads Current Work from memory and presents context.
disable-model-invocation: false
allowed-tools: Read, Glob, Grep
argument-hint: ""
---

# Resume

Pick up where the last session left off by reading the Current Work section from memory.

## Steps

### 1. Find the memory file

Check for a project-level memory file first, then fall back to the global Documents memory:

1. Look for `MEMORY.md` in the project's memory directory (the path Claude Code auto-creates under `~/.claude/projects/`)
2. If not in a project, read `~/.claude/projects/C--Users-johnw-Documents/memory/MEMORY.md`

### 2. Extract Current Work

Read the memory file and locate the `## Current Work` section. Present it to the user with clear formatting:

```
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

Based on the Current Work section and the context scan, propose what to work on next. Ask the user to confirm or redirect.
