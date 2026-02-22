---
name: checkpoint
description: Save all work, update memory, commit, push, and prepare to end the session. Use at natural breakpoints or when context is getting large.
disable-model-invocation: false
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
argument-hint: "[next-steps summary]"
---

# Checkpoint

Save all session state and prepare for a clean handoff to the next session.

## Steps

### 1. Update memory files

Review what was accomplished this session. Update the project's `MEMORY.md` (or the global Documents memory if not in a project) with:
- Non-obvious discoveries, bugs, or workarounds (Lessons Learned)
- Any new infrastructure, patterns, or conventions worth preserving

**Always update the "Current Work" section** with:
- What was done this session (brief, not a journal entry)
- Current state if work is in progress
- Next steps for the follow-up session
- Date stamp (e.g. "Last session (2026-02-21 evening)")

Replace the previous Current Work entry -- this section should only reflect the most recent session, not accumulate history.

If `$ARGUMENTS` is provided, use it as the next-steps summary.

Do not duplicate information already in memory. Read the current memory file first.

### 2. Run quality gates (if applicable)

Check if the project has type-check, lint, or test commands defined in its CLAUDE.md. If so, run them. Report results but do not block the checkpoint on failures -- document failures in memory instead.

If there is no project CLAUDE.md (e.g. Documents session), skip this step.

### 3. Commit and push

Check `git status` for uncommitted changes. If there are changes:
- Stage relevant files (not build artifacts, logs, or secrets)
- Commit with a descriptive message
- Push to remote

If there are no changes, skip. If not in a git repo, skip.

### 4. Verify push

Run `git status` to confirm the working tree is clean and the branch is up to date with remote.

### 5. End session

Tell the user:

```
Checkpoint complete. To continue with a fresh context, exit and start a new session:
  cd <current-directory>
  claude
```

Do not run `/clear`. A new session is better -- it re-runs hooks (fresh agent-comm registration, recent messages) and gets a fully clean context window.

If auto-exit is enabled (the file `~/.claude/.auto-exit-after-checkpoint` exists), exit the session automatically after displaying the checkpoint summary.
