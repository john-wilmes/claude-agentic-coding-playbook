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

### 1b. Audit memory file sizes

Check the MEMORY.md line count for the current project. If over 120 lines, suggest splitting:

```text
MEMORY.md is <N>/150 lines. Suggest splitting:
  - Move Lessons Learned → lessons-learned.md
  - Move stable reference data → data-facts.md
  - Keep only Current Work + Key Pointers in MEMORY.md

Split now? [y/N]
```

If the user confirms, perform the split using the topic file pattern documented in global CLAUDE.md (create topic files in the same memory directory, link from MEMORY.md).

If under 120 lines, skip silently.

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

### 2c. Evolve CLAUDE.md (opt-in)

Check the Lessons Learned section of MEMORY.md. For each lesson, check whether it describes a constraint not already captured in the project's CLAUDE.md. If a candidate rule is found:

```text
Lessons Learned contains a pattern not yet in CLAUDE.md:
  Lesson: "<lesson summary>"
  Suggested rule: "<candidate rule text>"
  Target section: <section name in CLAUDE.md>

Add this rule? [y/N]
```

Only apply on user confirmation. Skip if no new patterns are found or if MEMORY.md has no Lessons Learned section.

### 3. Commit and push

Check `git status` for uncommitted changes. If there are changes:
- Stage relevant files (not build artifacts, logs, or secrets)
- Commit with a descriptive message
- Push to remote

If there are no changes, skip. If not in a git repo, skip.

### 3b. Sync knowledge repo (if applicable)

If `~/.claude/knowledge` is a git repo, commit any uncommitted entries and push to remote:

```bash
cd ~/.claude/knowledge
# Commit any uncommitted entries
if [ -n "$(git status --porcelain)" ]; then
  git add entries/
  git commit -m "checkpoint: sync entries"
fi
# Push if remote is configured
if git remote get-url origin &>/dev/null; then
  git push origin HEAD 2>/dev/null || echo "Knowledge repo push failed -- will sync on next session start"
fi
```

If `~/.claude/knowledge` is not a git repo, skip this step.

### 4. Verify push

Run `git status` to confirm the working tree is clean and the branch is up to date with remote.

### 4b. Suggest devil's advocate review (if applicable)

Check how far ahead the current branch is from the default branch:
```bash
base=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||') || base="main"
git rev-list --count "$base"..HEAD 2>/dev/null
```

Trigger the suggestion when **either** condition is met:
1. The branch is **5+ commits ahead** and any changed files are documentation or configuration (`.md`, `.yaml`, `.json`, `.toml`, `.mdc`).
2. The branch has **3+ code files changed** (`.js`, `.ts`, `.py`, `.go`, `.rs`, `.java`, `.tsx`, `.jsx`).

For condition 1:
```text
This branch has <N> commits with doc/config changes. Consider a devil's advocate review before creating a PR:
- Verify external claims (URLs, prices, versions) against live sources
- Check file paths and cross-references
- Challenge assumptions and cite file:line for findings
```

For condition 2:
```text
This branch changes <N> code files. Consider a writer/reviewer split:
- Writer (this session): focused on forward progress
- Reviewer (fresh session): read the diff, check edge cases, naming, test coverage

Alternatively, run a self-review now focusing on accidental complexity and test gaps.
```

Both are optional. If the user declines or the conditions are not met, skip.

### 5. Suggest new session

Tell the user:

```text
Checkpoint complete. Consider starting a new session (`/exit`) rather than `/clear` -- it re-runs hooks and gets a fully clean context window.
```

Do NOT invoke `/exit` -- it is a built-in CLI command that the user must run themselves.
