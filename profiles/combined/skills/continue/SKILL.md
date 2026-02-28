---
name: continue
description: Continue work from where the last session left off. Checks inbox, reads memory, and detects whether you're in a dev project or research context to show the right information.
disable-model-invocation: false
allowed-tools: Read, Glob, Grep, Bash, mcp__agent-comm__read_messages, mcp__agent-comm__list_agents
argument-hint: "[investigation-id]"
---

# Continue

Pick up where the last session left off. Check inbox first, then detect context (dev project vs research) and present the appropriate information.

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

### 2. Detect context

Determine whether this is a dev or research session:

- **Research context**: If `$ARGUMENTS` contains an investigation ID, OR if the current directory is inside `~/.claude/investigations/`, this is a research session. Go to step 3R.
- **Dev context**: Otherwise, this is a dev session. Go to step 3D.

### 3D. Dev context — Find and present memory

Check for a project-level memory file first, then fall back to the most recent global memory:

1. Look for `MEMORY.md` in the project's memory directory (the path Claude Code auto-creates under `~/.claude/projects/`)
2. If not in a project, scan `~/.claude/projects/*/memory/MEMORY.md` and pick the most recently modified one

If no memory file was found, or the file has no `## Current Work` section, tell the user:

```text
No prior session found. This looks like a fresh start.
Suggestions:
  - Start working on your task directly
  - Run /playbook to set up project conventions
  - Run /checkpoint when you're ready to save progress
```

Then skip to step 5D.

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

### 4D. Reconcile inbox with memory

If there were unread messages (step 1) AND a Current Work section (step 3D), briefly note any conflicts or dependencies:
- Messages that relate to the planned next steps
- Urgent messages that should take priority over the planned work
- Requests from other agents that are still pending

### 5D. Scan for context

Check for additional context that might be relevant:
- Run `git status` to see if there are uncommitted changes from the previous session
- Run `git log --oneline -3` to see recent commits
- If the project has a task list, check for in-progress or blocked tasks

### 6D. Propose action

Based on the inbox, Current Work section, and context scan, propose what to work on next. If there are urgent unread messages, propose addressing those first. Ask the user to confirm or redirect.

---

### 3R. Research context — Check for arguments

If `$ARGUMENTS` contains an investigation ID, jump to step 5R (resume specific investigation).

### 4R. List open investigations

Glob for `~/.claude/investigations/*/STATUS.md` (exclude `_patterns/`).

For each, read the current phase from STATUS.md. Filter to non-closed investigations. Present:

```text
Open investigations:
  <id>    <phase>    <handoff notes summary>
  <id>    <phase>    <handoff notes summary>
```

Also show a count of closed investigations if any exist.

If no open investigations exist, say so and suggest `/investigate <id> new` to start one.

### 4R-b. Check project memory

Check for a project-level memory file:
1. Look for `MEMORY.md` in the project's memory directory (under `~/.claude/projects/`)
2. If not in a project, scan `~/.claude/projects/*/memory/MEMORY.md` and pick the most recently modified one

If no memory file was found, or it has no `## Current Work` section, say:

```text
No prior project session found.
Suggestions:
  - Run /investigate <id> new to start an investigation
  - Start working on your task directly
```

If found, extract and present the "Current Work" section:

```text
Project memory (last session):
  <summary from Current Work>
```

Scan for additional context:
- Run `git status` to check for uncommitted changes
- Run `git log --oneline -3` to see recent commits

### 5R. Resume specific investigation

If an investigation ID was provided (from argument or user choice):

1. Read `~/.claude/investigations/<id>/STATUS.md`
2. If phase is "closed": ask if user wants to reopen. If yes, update phase to "collecting" and add history entry: `| <today> | reopen | Reopened by user |`
3. Read BRIEF.md for the investigation question.
4. Read the most recent evidence files (last 3).
5. Read FINDINGS.md if it has content beyond the template defaults.
6. Present:

```text
Resuming: <id>
  Question: <from brief>
  Phase: <current phase>
  Evidence collected: <count>
  Last activity: <date and summary from most recent history entry>

Handoff notes:
  <from STATUS.md>
```

7. Suggest next action based on phase:
   - `new` -> "Fill in the brief, then start collecting evidence"
   - `collecting` -> "Continue collecting evidence or synthesize what you have"
   - `synthesizing` -> "Review and refine findings, then close"
   - `closed` (reopened) -> "Continue collecting new evidence"

### 6R. Propose action

Based on available context (open investigations + project memory), propose what to do next. Ask the user to confirm or redirect.
