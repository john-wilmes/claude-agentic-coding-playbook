# Shared Knowledge Base

A git-based knowledge base for AI coding agents. Entries are agent-authored,
human-reviewed, and auto-injected into agent context at session start.

## Setup

### For individual use (local only)

```bash
mkdir -p ~/.claude/knowledge/entries
cd ~/.claude/knowledge
git init
```

### For team use (shared repo)

```bash
# During playbook installation:
./install.sh --knowledge-repo https://github.com/your-org/knowledge

# Or manually:
git clone https://github.com/your-org/knowledge ~/.claude/knowledge
```

## Creating entries

Run `/learn` in any Claude Code session to capture a lesson:

```
/learn git hooks installed to .git/hooks/ are silently ignored when core.hooksPath is set
```

The skill auto-classifies the entry and creates a structured file in `entries/`.

## Entry format

Each entry is a markdown file with YAML frontmatter:

```yaml
---
id: "20260222-143052-git-hookspath-override"
created: "2026-02-22T14:30:52Z"
author: "agent-name"
source_project: "my-project"
tool: "git"
category: "gotcha"
tags: ["hooks", "config", "silent-failure"]
confidence: "high"
visibility: "local"
verified_at: "2026-02-22T14:30:52Z"
---

## Context
<what situation triggers this lesson>

## Fix
<concrete steps to resolve>

## Evidence
<how this was discovered>
```

## Categories

| Category | Use when... |
|---|---|
| `gotcha` | Surprising behavior, silent failure, or common mistake |
| `pattern` | Reusable approach or best practice worth repeating |
| `workaround` | Temporary fix for a known issue |
| `config` | Configuration requirement or setting that's easy to miss |
| `security` | Security-related finding |
| `performance` | Optimization insight or bottleneck diagnosis |

## Contributing (team repos)

1. Create entries with `/learn` — they commit to a branch automatically
2. A PR is created via `gh pr create` if the GitHub CLI is available
3. Team members review the PR for accuracy and relevance
4. Merge to main — the entry becomes available to all team members on next session start

### Review checklist

- [ ] Entry describes a real, verified issue (not speculation)
- [ ] Category and tool are accurate
- [ ] No credentials, API keys, or internal paths in the content
- [ ] Not a duplicate of an existing entry
- [ ] Fix section is actionable

## How injection works

At session start, the hook:
1. Pulls latest entries from the remote (if configured)
2. Detects the current project's tools from package.json, config files, etc.
3. Scores entries by relevance (tool match, tag overlap)
4. Injects the top 5 matching entries into the agent's context (~1,500 tokens)

Entries that don't match the current project are not injected — they stay on disk
for on-demand search.

## Security

Entries are informational context, not instructions. They describe what happened
and what to do, framed as "This lesson describes..." rather than "Always do X."
This reduces prompt injection risk.

Additional safeguards:
- Pre-commit hook validates format and scans for sensitive content
- CI workflow checks for credentials, email addresses, and user paths
- PR review gate for shared repos catches injection attempts
- `visibility` field controls sharing scope (local/team/public)

## File structure

```
~/.claude/knowledge/
  entries/
    20260222-143052-git-hookspath-override/
      entry.md
    20260222-150000-amplify-iam-auth/
      entry.md
    ...
  .github/
    workflows/
      validate-entries.yml    (copy from playbook templates)
  .git/hooks/
    pre-commit               (copy from playbook templates)
  README.md                  (this file)
```
