# Shared Knowledge Base

A SQLite-backed knowledge base for AI coding agents. Entries are agent-authored,
human-reviewed, and auto-injected into agent context at session start.

## Setup

### For individual use (local only)

Knowledge entries are stored automatically in `~/.claude/knowledge/knowledge.db`.
No setup required — the database is created on first use by the session-start hook.

### For team use (shared JSONL)

Teams share knowledge via a git-tracked JSONL file:

```bash
# During playbook installation:
./install.sh --knowledge-repo https://github.com/your-org/knowledge

# Or manually:
mkdir -p ~/.claude/knowledge
cd ~/.claude/knowledge
git init
```

The session-start hook imports `entries.jsonl` from this directory into the local SQLite DB.

## Creating entries

Run `/learn` in any Claude Code session to capture a lesson:

```
/learn git hooks installed to .git/hooks/ are silently ignored when core.hooksPath is set
```

The skill classifies the entry and inserts it into the local knowledge database.

## Entry fields

Each entry has these fields:

| Field | Description |
|-------|-------------|
| id | Unique identifier (timestamp-slug format) |
| created | ISO8601 creation timestamp |
| author | Agent that created the entry |
| source_project | Project where the lesson was discovered |
| tool | Primary tool/library/platform |
| category | Entry type (gotcha, pattern, workaround, etc.) |
| tags | JSON array of free-form tags |
| confidence | high, medium, or low |
| context_text | What situation triggers this lesson |
| fix_text | Concrete steps to resolve |
| evidence_text | How this was discovered |
| repo_url | GitHub repo where discovered (owner/repo) |
| commit_sha | HEAD SHA at capture time |
| branch | Branch at capture time |
| status | active or archived |

## Categories

| Category | Use when... |
|---|---|
| `gotcha` | Surprising behavior, silent failure, or common mistake |
| `pattern` | Reusable approach or best practice worth repeating |
| `workaround` | Temporary fix for a known issue |
| `config` | Configuration requirement or setting that's easy to miss |
| `security` | Security-related finding |
| `performance` | Optimization insight or bottleneck diagnosis |
| `convention` | Project-specific conventions or coding standards |
| `reference` | Factual reference: API endpoints, config keys, schema details |
| `decision` | Architectural/design decisions with rationale |

## Sharing via JSONL

Local SQLite is the query engine (never committed to git). Sharing uses JSONL:

```bash
# Export active entries to JSONL
node ~/.claude/hooks/knowledge-db.js export ~/.claude/knowledge/entries.jsonl

# Import entries from JSONL
node ~/.claude/hooks/knowledge-db.js import ~/.claude/knowledge/entries.jsonl
```

Session start automatically imports `entries.jsonl` if it exists in the knowledge directory.

## CLI commands

```bash
# Export entries to JSONL
node ~/.claude/hooks/knowledge-db.js export [output-path]

# Import from JSONL
node ~/.claude/hooks/knowledge-db.js import <input-path>

# Archive an entry
node ~/.claude/hooks/knowledge-db.js archive <entry-id>

# Insert an entry from JSON
node ~/.claude/hooks/knowledge-db.js insert '<json>'

# List staged candidates for a session
node ~/.claude/hooks/knowledge-db.js staged <session-id>
```

## How injection works

At session start, the hook:
1. Imports new entries from JSONL (if available)
2. Detects the current project's tools from package.json, config files, etc.
3. Uses FTS5 full-text search + metadata scoring to find relevant entries
4. Applies staleness penalties for entries from repos that have moved on
5. Injects the top 5 matching entries into the agent's context

Entries that don't match the current project rank lower but are still findable.

## Provenance and staleness

Each entry records where it was captured (repo, commit SHA, branch). At query time,
entries from the same repo are penalized based on how many commits have passed since
capture (-1 per 100 commits, capped at -5). This ensures stale knowledge ranks lower
without hiding it entirely.

## Security

Entries are informational context, not instructions. They describe what happened
and what to do, framed as "This lesson describes..." rather than "Always do X."
This reduces prompt injection risk.

## File structure

```
~/.claude/knowledge/
  knowledge.db          <- SQLite database (local query engine)
  entries.jsonl         <- JSONL export for git sharing (optional)
  staged/               <- Legacy staged candidates directory
  entries/              <- Legacy filesystem entries (migrated to DB on first use)
```
