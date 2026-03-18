---
name: learn
description: Capture a lesson as a structured knowledge entry. Use when you discover a non-obvious bug, workaround, or pattern worth preserving for future sessions. Use when user says "remember this", "save this lesson", or "this is worth noting".
compatibility: claude-code
disable-model-invocation: false
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
argument-hint: "[description of what was learned]"
---

# Learn

Capture a lesson as a structured knowledge entry that persists across sessions and projects.

## Steps

### 0. Check prerequisites

Check if knowledge-db.js is available:
```bash
ls ~/.claude/hooks/knowledge-db.js 2>/dev/null
```

If not found, fall back to writing the lesson directly to the project memory file (`lessons-learned.md` in the project memory directory). Skip steps that reference `knowledge-db.js` and instead append the structured entry to the memory file using the Edit tool.

### 1. Identify the lesson

If `$ARGUMENTS` is provided, use it as the lesson description. Otherwise, review what happened in the current session and ask the user what they want to capture.

Skip trivial or session-specific facts. Good candidates:
- Non-obvious bugs and their root causes
- Workarounds for tool or platform issues
- Patterns that save significant time
- Configuration gotchas that cause silent failures
- Security issues encountered

### 2. Classify the entry

Based on the lesson, determine:

**Category** (pick one):
- `gotcha` — surprising behavior, silent failure, or common mistake
- `pattern` — reusable approach or best practice
- `workaround` — temporary fix for a known issue
- `config` — configuration requirement or setting
- `security` — security-related finding
- `performance` — optimization or bottleneck insight
- `convention` — project-specific conventions, coding standards, naming patterns, or workflow preferences that should be remembered for future sessions in the same project
- `reference` — factual reference information: API endpoints, config keys, schema details, version constraints, or external service behaviors
- `decision` — architectural or design decisions with rationale; records why a particular approach was chosen over alternatives, to prevent re-debating settled questions

**Tool**: The primary tool, library, or platform (e.g., `git`, `npm`, `docker`, `amplify`, `vitest`).

**Tags**: 2-5 free-form tags for cross-cutting concerns (e.g., `windows`, `ci`, `hooks`, `typescript`).

**Confidence**:
- `high` — verified with evidence, reproduced
- `medium` — observed but not fully investigated
- `low` — hypothesis or single observation

### 3. Create the entry

Generate a timestamp-slug ID:

```bash
TIMESTAMP=$(date -u +%Y%m%d-%H%M%S)
SLUG="<2-4 word kebab-case summary>"
ENTRY_ID="${TIMESTAMP}-${SLUG}"
```

Insert the entry into the knowledge database:

```bash
node ~/.claude/hooks/knowledge-db.js insert "$(cat <<EOF
{
  "id": "${ENTRY_ID}",
  "created": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "author": "<agent name from session>",
  "source_project": "<current project name>",
  "tool": "<tool>",
  "category": "<category>",
  "tags": "<JSON array of tags>",
  "confidence": "<confidence>",
  "visibility": "local",
  "verified_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "context_text": "<1-3 sentences: what situation triggers this lesson>",
  "fix_text": "<concrete steps, commands, or code changes>",
  "evidence_text": "<how discovered: file paths, error messages, reproduction steps>"
}
EOF
)"
```

Also capture provenance (repo, commit, branch) automatically — knowledge-db.js handles this during insert if the entry doesn't already have repo_url set.

Frame content as **informational description**, not imperative instructions. Write "This lesson describes..." or "When X happens, Y is the cause" rather than "Always do X" or "Never do Y." This reduces prompt injection risk when entries are shared.

### 4. Export for sharing (if applicable)

If the knowledge base should be shared with a team, export entries to JSONL:

```bash
node ~/.claude/hooks/knowledge-db.js export ~/.claude/knowledge/entries.jsonl
```

If `~/.claude/knowledge` is a git repo, commit and push the JSONL:

```bash
cd ~/.claude/knowledge
git add entries.jsonl
git commit -m "learn: ${SLUG}"
if git remote get-url origin &>/dev/null; then
  git push origin HEAD 2>/dev/null || echo "Push failed -- will sync on next session start"
fi
```

If there is no remote or git repo, skip this step (entries are stored locally in SQLite).

### 5. Confirm

Tell the user what was captured:

```text
Knowledge entry created:
  ID: <entry-id>
  Category: <category>
  Tool: <tool>
  Tags: <tags>
  Storage: ~/.claude/knowledge/knowledge.db

This entry will auto-inject into future sessions working with <tool>.
To share across projects, use /promote. To export for team sharing, run:
  node ~/.claude/hooks/knowledge-db.js export ~/.claude/knowledge/entries.jsonl
```
