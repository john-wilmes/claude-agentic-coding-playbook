---
name: checkpoint
description: Save all work, update memory, commit, push, and prepare to end the session. Use when user says "save my work", "wrap up", or "I'm done for now". Use at natural breakpoints or when context is getting large.
compatibility: claude-code
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

### 1b. Review staged knowledge candidates (if applicable)

Run the following command to check for knowledge candidates staged by hooks this session:

```bash
node ~/.claude/hooks/knowledge-db.js staged "$SESSION_ID" 2>/dev/null
```

Where $SESSION_ID is the current session ID. The output is JSON array of staged candidates.

If the command fails or returns an empty array, skip this step silently.

If there is output, parse each line as a JSON object and present the candidates in a formatted table:

```
### Staged Knowledge Candidates

The following learning opportunities were detected this session:

| # | Trigger | Tool | Summary |
|---|---------|------|---------|
| 1 | test-fix | Edit | first line of failure output... |
| 2 | stuck-resolved | Bash | Recovered from stuck loop on Bash |

Review each candidate. For worthy entries, run `/learn` with the appropriate category and details.
To discard all staged candidates, they will be automatically pruned after 7 days.
```

Populate the table from the JSON fields: use `trigger` for the Trigger column, `tool` for Tool, and the first line of `context` (or `summary` if present) for Summary. Number rows sequentially starting at 1.

Only show this block when at least one candidate exists. Do not mention staged candidates if the directory is empty or absent.

### 1c. Capture knowledge entries (if applicable)

If non-obvious discoveries, bugs, or workarounds were encountered this session — things a future agent working with the same tools would benefit from knowing — suggest capturing them:

```text
This session involved some non-trivial findings. Consider capturing them as
knowledge entries with /learn so they auto-inject into future sessions.

Candidates:
  - <brief description of finding 1>
  - <brief description of finding 2>

Run /learn now? [y/N]
```

Only suggest this when there are genuine discoveries worth preserving. Do not prompt for routine work, trivial changes, or facts already in MEMORY.md. If the user declines, continue to step 2.

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

### 3b. Sync knowledge repo (if applicable)

If `~/.claude/knowledge` exists, export entries to JSONL and push to remote:

```bash
# Export entries to JSONL for sharing
if [ -f "$HOME/.claude/hooks/knowledge-db.js" ]; then
  node ~/.claude/hooks/knowledge-db.js export ~/.claude/knowledge/entries.jsonl 2>/dev/null
fi
cd ~/.claude/knowledge
if [ -d ".git" ]; then
  if [ -n "$(git status --porcelain)" ]; then
    git add entries.jsonl
    git commit -m "checkpoint: sync entries"
  fi
  if git remote get-url origin &>/dev/null; then
    git push origin HEAD 2>/dev/null || echo "Knowledge repo push failed -- will sync on next session start"
  fi
fi
```

### 4. Verify push

Run `git status` to confirm the working tree is clean and the branch is up to date with remote.

### 4b. Suggest devil's advocate review (if applicable)

Check how far ahead the current branch is from the default branch:
```bash
base=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||') || base="main"
git rev-list --count "$base"..HEAD 2>/dev/null
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

### 5. Suggest new session

Tell the user:

```text
Checkpoint complete. Consider starting a new session (`/exit`) rather than `/clear` -- it re-runs hooks and gets a fully clean context window.
```

Do NOT invoke `/exit` -- it is a built-in CLI command that the user must run themselves.
