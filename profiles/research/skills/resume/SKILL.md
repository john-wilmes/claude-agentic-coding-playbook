---
name: resume
description: Resume work by listing open investigations and project memory state. Optionally resume or reopen a specific investigation.
disable-model-invocation: false
allowed-tools: Read, Glob, Grep, Bash
argument-hint: "[investigation-id]"
---

# Resume (Investigation Profile)

Pick up where the last session left off. Lists open investigations and project memory state.

## Steps

### 1. Check for arguments

If `$ARGUMENTS` contains an investigation ID, jump to step 4 (resume specific investigation).

### 2. List open investigations

Glob for `~/.claude/investigations/*/STATUS.md` (exclude `_patterns/`).

For each, read the current phase from STATUS.md. Filter to non-closed investigations. Present:

```
Open investigations:
  <id>    <phase>    <handoff notes summary>
  <id>    <phase>    <handoff notes summary>
```

Also show a count of closed investigations if any exist.

If no open investigations exist, say so and suggest `/investigate <id> new` to start one.

### 3. Check project memory

Check for a project-level memory file:
1. Look for `MEMORY.md` in the project's memory directory (under `~/.claude/projects/`)
2. If not in a project, check `~/.claude/projects/C--Users-johnw-Documents/memory/MEMORY.md`

If found, extract and present the "Current Work" section:

```
Project memory (last session):
  <summary from Current Work>
```

Scan for additional context:
- Run `git status` to check for uncommitted changes
- Run `git log --oneline -3` to see recent commits

### 4. Resume specific investigation

If an investigation ID was provided (from argument or user choice):

1. Read `~/.claude/investigations/<id>/STATUS.md`
2. If phase is "closed": ask if user wants to reopen. If yes, update phase to "collecting" and add history entry: `| <today> | reopen | Reopened by user |`
3. Read BRIEF.md for the investigation question.
4. Read the most recent evidence files (last 3).
5. Read FINDINGS.md if it has content beyond the template defaults.
6. Present:

```
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

### 5. Propose action

Based on available context (open investigations + project memory), propose what to do next. Ask the user to confirm or redirect.
