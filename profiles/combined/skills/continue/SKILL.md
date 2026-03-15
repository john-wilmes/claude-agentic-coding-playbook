---
name: continue
description: Continue work from where the last session left off. Use when user says "where was I", "pick up where I left off", or "what was I working on". Checks inbox, reads memory, and detects whether you're in a dev project or research context to show the right information.
compatibility: claude-code
disable-model-invocation: false
allowed-tools: Read, Glob, Grep, Bash, Task
argument-hint: "[investigation-id]"
---

# Continue

Pick up where the last session left off. Check inbox first, then detect context (dev project vs research) and present the appropriate information.

## Install Root Discovery

Before any step, determine where the playbook's `.claude/` directory is installed:

Run the install-root discovery helper:

```bash
INSTALL_ROOT=$(bash ~/.claude/scripts/skills/find-install-root.sh)
```

The investigations directory is `<INSTALL_ROOT>/.claude/investigations/`.

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

### 3.5D. Run quality gates (subagent)

Spawn a subagent (Task tool, subagent_type: "general-purpose", model: "haiku") to run quality checks without consuming parent context. Give it these instructions:

> **Quality gate check for /continue**
>
> 1. **Run project quality gates**: Read the project's CLAUDE.md and find any test/lint/type-check commands listed under "Quality Gates" or similar. Run each command. For each, report pass/fail and the first 20 lines of failure output.
>
> 2. **Check for incomplete work**: Run `git status` and `git diff --stat`. Report:
>    - Unstaged modifications (partially completed edits)
>    - Untracked source files (exclude build artifacts like `node_modules/`, `dist/`, `*.log`)
>    - Staged but uncommitted changes
>
> 3. **Check knowledge candidates**: Run `test -f ~/.claude/hooks/knowledge-db.js && node ~/.claude/hooks/knowledge-db.js staged || echo "no-knowledge-db"`. If candidates exist, report the count.
>
> 4. **Return a structured summary**: gates pass/fail (with failure details), incomplete work list, knowledge candidate count.

After the subagent returns, integrate results into step 4D:

- **Quality gates failed** → Fixing failures becomes the first priority, before memory's next steps.
- **Incomplete work detected** → Flag it as context for deciding what to do next.
- **Knowledge candidates exist** → Mention them briefly (don't block on them).

### 4D. Propose action

Check whether this session is running under `claude-loop`:

```bash
echo "${CLAUDE_LOOP:-0}"
```

**If `1` (running under claude-loop):** This is an autonomous session — there is no interactive user. Do NOT ask questions or wait for confirmation. Instead:
- If `$ARGUMENTS` contains a task after `--` (e.g. `/continue -- Next task: ...`), work on that task instead of memory's next steps.
- After completing the task, run `/checkpoint` to signal completion to claude-loop.
- If Next Steps exist in Current Work, immediately begin working on the first one.
- If there are no next steps and no task argument, print "claude-loop: no work to do — exiting." and STOP. Do NOT run `/checkpoint`. Do NOT write any sentinel file. Stopping without a sentinel tells claude-loop to end the loop gracefully.

**If `0` (interactive session):** Present the summary briefly, then **immediately start working** on the first Next Step from Current Work. Do NOT ask the user for confirmation — just begin. The user can always interrupt (Ctrl+C, new message) to redirect.

**CRITICAL — Context conservation:** After presenting the summary, do NOT read large files (100+ lines) directly into parent context. Use subagents (Task tool with Explore or general-purpose type) for any exploration that touches multiple files or large files. The /continue skill itself consumed context; protect what remains.

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

**If `0` (interactive session):** Present the summary briefly, then **immediately start working** on the most relevant next action (resume investigation, continue from memory). Do NOT ask the user for confirmation — just begin. The user can always interrupt to redirect.

**CRITICAL — Context conservation:** Do NOT read large files directly into parent context after the summary. Use subagents for exploration.
