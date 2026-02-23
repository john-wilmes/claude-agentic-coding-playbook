---
name: continue
description: Continue work by checking inbox, listing open investigations, and project memory state. Optionally resume or reopen a specific investigation.
disable-model-invocation: false
allowed-tools: Read, Glob, Grep, Bash, mcp__agent-comm__read_messages, mcp__agent-comm__list_agents
argument-hint: "[investigation-id]"
---

# Continue (Investigation Profile)

Pick up where the last session left off. Check inbox first, then list investigations and project memory.

## Steps

### 1. Check inbox (agent-comm)

Before anything else, check for messages from other agents:

1. Call `read_messages` with `agent` set to the current project name (derived from the working directory basename) and `unread_only: true`.
2. If there are unread messages, present them prominently:

```text
Inbox (N unread messages):
  [time] sender: message content
  ...
```

3. Also call `list_agents` to see who else is active and if anyone is waiting.

If agent-comm is not available (MCP server not running), skip silently and continue to step 2.

### 2. Check for arguments

If `$ARGUMENTS` contains an investigation ID, jump to step 5 (resume specific investigation).

### 3. List open investigations

Glob for `~/.claude/investigations/*/STATUS.md` (exclude `_patterns/`).

For each, read the current phase from STATUS.md. Filter to non-closed investigations. Present:

```text
Open investigations:
  <id>    <phase>    <handoff notes summary>
  <id>    <phase>    <handoff notes summary>
```

Also show a count of closed investigations if any exist.

If no open investigations exist, say so and suggest `/investigate <id> new` to start one.

### 4. Check project memory

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

### 5. Resume specific investigation

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

### 6. Propose action

Based on available context (open investigations + project memory), propose what to do next. Ask the user to confirm or redirect.
