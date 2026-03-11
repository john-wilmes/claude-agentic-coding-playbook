---
name: continue
description: Continue work from where the last session left off. Use when user says "where was I", "pick up where I left off", or "what was I working on". Checks inbox, reads memory, and detects whether you're in a dev project or research context to show the right information.
compatibility: claude-code
disable-model-invocation: false
allowed-tools: Read, Glob, Grep, Bash
argument-hint: "[investigation-id]"
---

# Continue

Pick up where the last session left off. Check inbox first, then detect context (dev project vs research) and present the appropriate information.

## Install Root Discovery

Before any step, determine where the playbook's `.claude/` directory is installed:

1. Walk up from the current working directory, checking each ancestor for a `.claude/` directory that contains `investigations/`, `skills/`, or `templates/`.
2. Also check `~/.claude/` as a candidate.
3. Prefer the candidate closest to the current working directory. Fall back to `~/.claude/`.

Set `INSTALL_ROOT` to the discovered path. The investigations directory is `<INSTALL_ROOT>/.claude/investigations/`.

## Steps

### 1. Detect context

Determine whether this is a dev or research session:

- **Research context**: If `$ARGUMENTS` contains an investigation ID, OR if the current directory is inside `<INSTALL_ROOT>/.claude/investigations/`, this is a research session. Go to step 2R.
- **Dev context**: Otherwise, this is a dev session. Go to step 2D.

### 2D. Dev context — Find and present memory

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

Then skip to step 4D.

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

### 3D. Scan for context

Check for additional context that might be relevant:
- Run `git status` to see if there are uncommitted changes from the previous session
- Run `git log --oneline -3` to see recent commits
- If the project has a task list, check for in-progress or blocked tasks

### 4D. Propose action

Check whether this session is running under `claude-loop`:

```bash
echo "${CLAUDE_LOOP:-0}"
```

**If `1` (running under claude-loop):** This is an autonomous session — there is no interactive user. Do NOT ask questions or wait for confirmation. Instead:
- If `$ARGUMENTS` contains a task after `--` (e.g. `/continue -- Next task: ...`), work on that task instead of memory's next steps.
- If Next Steps exist in Current Work, immediately begin working on the first one.
- If there are no next steps and no task argument, present the full status summary including all pending items that require external action. Do NOT run `/checkpoint`. Do NOT write any sentinel file. The session will remain open for user interaction.

**If `0` (interactive session):** Propose what to work on next based on the Current Work section and context scan. Ask the user to confirm or redirect.

---

### 2R. Research context — Check for arguments

If `$ARGUMENTS` contains an investigation ID, jump to step 4R (resume specific investigation).

### 3R. List open investigations

Glob for `<INSTALL_ROOT>/.claude/investigations/*/STATUS.md` (exclude `_patterns/`).

For each, read the current phase from STATUS.md. Filter to non-closed investigations. Present:

```text
Open investigations:
  <id>    <phase>    <handoff notes summary>
  <id>    <phase>    <handoff notes summary>
```

Also show a count of closed investigations if any exist.

If no open investigations exist, say so and suggest `/investigate <id> new` to start one.

### 3R-b. Check project memory

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

### 4R. Resume specific investigation

If an investigation ID was provided (from argument or user choice):

1. Read `<INSTALL_ROOT>/.claude/investigations/<id>/STATUS.md`
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

### 5R. Propose action

Check whether this session is running under `claude-loop`:

```bash
echo "${CLAUDE_LOOP:-0}"
```

**If `1` (running under claude-loop):** Do NOT ask questions. If `$ARGUMENTS` contains a task, work on that. If there is an open investigation, resume it. If nothing to do, print "claude-loop: no work to do — exiting." and STOP. Do NOT run `/checkpoint` or write any sentinel.

**If `0` (interactive session):** Propose what to do next based on available context (open investigations + project memory). Ask the user to confirm or redirect.
