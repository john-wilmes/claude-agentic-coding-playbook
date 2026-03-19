---
name: continue
description: Continue work from where the last session left off. Use when user says "where was I", "pick up where I left off", "what was I working on", "you died", "you crashed", "session died", "continue where you left off", or any indication the previous session was interrupted or crashed. Also use when the user's first message clearly expects you to already be working on something. Checks inbox, reads memory, and detects whether you're in a dev project or research context to show the right information.
compatibility: claude-code
disable-model-invocation: false
allowed-tools: Read, Bash, Glob
argument-hint: "[task to focus on]"
---

# Continue

Pick up where the last session left off. SessionStart already injected memory and
git context into this session. This skill just interprets it and starts working.

**Design principle:** Zero overhead. No subagents, no duplicate reads, no loop detection.
SessionStart did the heavy lifting — this skill is the trigger to act on it.

## Steps

### Install Root Discovery

```bash
INSTALL_ROOT=$(bash ~/.claude/scripts/skills/find-install-root.sh)
```

### 1. Determine context

If `$ARGUMENTS` is provided, use it as the task focus — skip to step 4.

Otherwise, check the working directory:
- If inside `~/.claude/investigations/`, context is **research**.
- Otherwise, context is **dev**.

### 2. Check for messages (dev context)

Run:
```bash
ls ${INSTALL_ROOT}/.claude/inbox/ 2>/dev/null | head -5
```

If inbox has files, read each one (they are short text messages from other agents or
claude-loop). Summarize any actionable items. Delete messages after reading:
```bash
rm ${INSTALL_ROOT}/.claude/inbox/<filename>
```

If no inbox directory or no files, skip silently.

### 3. Identify next steps

The SessionStart hook already injected the "Current Work" section from MEMORY.md
into this conversation's context. **Do not re-read MEMORY.md.**

Look at the SessionStart context above in this conversation. Find the "Next steps"
listed under "Current Work". These are your task list.

### 4. Start working

**Do not ask for confirmation. Do not summarize what you're about to do. Just start.**

- If `$ARGUMENTS` was provided, begin that specific task.
- If next steps exist in memory, begin the first incomplete step.
- In dev context, if neither, run `git status` and tell the user the repo is clean with no pending work.
- In research context, if neither, say no pending investigation steps were found and ask which question to resume.

For dev context: follow the Development Workflow (Explore, Plan, Code, Verify, Commit).
For research context: follow the Research Workflow (Question, Collect, Synthesize, Close).
