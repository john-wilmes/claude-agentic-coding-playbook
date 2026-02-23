---
name: continue
description: Continue work from where the last session left off. Checks inbox, reads Current Work from memory, and presents context.
disable-model-invocation: false
allowed-tools: Read, Glob, Grep, Bash, mcp__agent-comm__read_messages, mcp__agent-comm__list_agents
argument-hint: ""
---

# Continue

Pick up where the last session left off. Check inbox first, then read memory, then propose action.

## Steps

### 1. Check inbox (agent-comm)

Before reading memory, check for messages from other agents:

1. Call `read_messages` with `agent` set to the current project name (derived from the working directory basename) and `unread_only: true`.
2. If there are unread messages, present them prominently:

```text
Inbox (N unread messages):
  [time] sender: message content
  ...
```

3. Also call `list_agents` to see who else is active and if anyone is waiting.

If agent-comm is not available (MCP server not running), skip silently and continue to step 2.

### 2. Find the memory file

Check for a project-level memory file first, then fall back to the most recent global memory:

1. Look for `MEMORY.md` in the project's memory directory (the path Claude Code auto-creates under `~/.claude/projects/`)
2. If not in a project, scan `~/.claude/projects/*/memory/MEMORY.md` and pick the most recently modified one

### 3. Extract Current Work

If no memory file was found in step 2, or the file has no `## Current Work` section, tell the user:

```text
No prior session found. This looks like a fresh start.
Suggestions:
  - Start working on your task directly
  - Run /playbook to set up project conventions
  - Run /checkpoint when you're ready to save progress
```

Then skip to step 5.

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

### 4. Reconcile inbox with memory

If there were unread messages (step 1) AND a Current Work section (step 3), briefly note any conflicts or dependencies:
- Messages that relate to the planned next steps
- Urgent messages that should take priority over the planned work
- Requests from other agents that are still pending

### 5. Scan for context

Check for additional context that might be relevant:
- Run `git status` to see if there are uncommitted changes from the previous session
- Run `git log --oneline -3` to see recent commits
- If the project has a task list, check for in-progress or blocked tasks

### 6. Propose action

Based on the inbox, Current Work section, and context scan, propose what to work on next. If there are urgent unread messages, propose addressing those first. Ask the user to confirm or redirect.
