---
name: checkpoint
description: Save investigation state, update memory with findings and current work, and prepare to end the session.
disable-model-invocation: false
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
argument-hint: "[next-steps summary]"
---

# Checkpoint (Research)

Save all session state and prepare for a clean handoff to the next session.

## Steps

### 1. Update memory files

Review what was investigated this session. Update the project's `MEMORY.md` (or the global Documents memory if not in a project) with:
- New findings, evidence trails, and conclusions (in the Findings section)
- Any hypotheses that were confirmed or rejected

**Always update the "Current Work" section** with:
- What was investigated this session (brief, not a journal entry)
- Current state of the investigation
- Next steps for the follow-up session
- Date stamp (e.g. "Last session (2026-02-21 evening)")

Replace the previous Current Work entry -- this section should only reflect the most recent session, not accumulate history.

If `$ARGUMENTS` is provided, use it as the next-steps summary.

Do not duplicate information already in memory. Read the current memory file first.

### 2. Commit and push (if applicable)

Check `git status` for uncommitted changes. If there are changes to memory files or documentation:
- Stage relevant files (not build artifacts, logs, or secrets)
- Commit with a descriptive message
- Push to remote

If there are no changes, skip. If not in a git repo, skip.

Note: Unlike the dev profile, this checkpoint does NOT run quality gates (no type-check, lint, or test). The research profile is read-focused.

### 3. End session

Tell the user:

```
Checkpoint complete. To continue with a fresh context, exit and start a new session:
  cd <current-directory>
  claude
```

If auto-exit is enabled (the file `~/.claude/.auto-exit-after-checkpoint` exists), exit the session automatically after displaying the checkpoint summary.
