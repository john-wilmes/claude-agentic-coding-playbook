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

### 2b. Run code review (if available)

Check if `coderabbit` is on PATH (`command -v coderabbit`). If available:
- Run `coderabbit review --prompt-only --type uncommitted`
- Apply actionable findings before committing
- If a finding is not actionable or conflicts with project architecture, skip it

If `coderabbit` is not on PATH, skip this step.

### 3. Commit and push

Check `git status` for uncommitted changes. If there are changes:
- Stage relevant files (not build artifacts, logs, or secrets)
- Commit with a descriptive message
- Push to remote

If there are no changes, skip. If not in a git repo, skip.

### 4. Verify push

Run `git status` to confirm the working tree is clean and the branch is up to date with remote.

### 4b. Suggest devil's advocate review (if applicable)

Check how far ahead the current branch is from main:
```bash
git rev-list --count main..HEAD 2>/dev/null
```

If the branch is **5+ commits ahead** and any of the changed files are documentation or configuration (`.md`, `.yaml`, `.json`, `.toml`, `.mdc`), suggest a devil's advocate review:

```text
This branch has <N> commits with doc/config changes. Consider a devil's advocate review before creating a PR:
- Verify external claims (URLs, prices, versions) against live sources
- Check file paths and cross-references
- Challenge assumptions and cite file:line for findings

This is optional but high-value for documentation-heavy changes. Run it? [y/N]
```

If the user declines or the conditions are not met, skip.

### 5. Exit session

Run `/exit` to end the session. A new session is better than `/clear` -- it re-runs hooks (fresh agent-comm registration, recent messages) and gets a fully clean context window.
