# Interactive Dogfood Playbook

A structured checklist for manually testing the agentic coding playbook in a real Claude Code session. Each step has an action, exact command, and pass criterion.

Run this in a **temp HOME** to avoid touching your real config. Expect ~30 minutes for a full run.

For automated E2E testing using `claude -p` (headless mode), see [`scripts/dogfood-e2e.sh`](../scripts/dogfood-e2e.sh). That script simulates a realistic investigation: a trouble ticket about images being cropped too tightly in a livestock auction app, with a multi-file project to trace through. It must run from a **normal terminal** (not inside Claude Code) because nested sessions are not supported.

## Prerequisites

- Claude Code CLI installed and authenticated
- Node.js 18+
- Git configured with user.name and user.email
- This repo checked out locally

---

## 1. Setup — Isolated Environment

| # | Action | Command | Pass Criterion |
|---|--------|---------|----------------|
| 1.1 | Create temp HOME | `export TEST_HOME=$(mktemp -d)` | Directory created |
| 1.2 | Override HOME | `export HOME=$TEST_HOME` | `echo $HOME` shows temp path |
| 1.3 | Set git identity | `git config --global user.email "dogfood@test"` | No error |
|     |                  | `git config --global user.name "Dogfood"` | No error |
| 1.4 | Verify clean state | `ls ~/.claude 2>/dev/null` | "No such file or directory" |

## 2. Dev Profile Install

| # | Action | Command | Pass Criterion |
|---|--------|---------|----------------|
| 2.1 | Install dev profile | `bash install.sh --profile dev --force` | Exits 0, lists installed files |
| 2.2 | Verify CLAUDE.md | `grep "Explore, Plan, Code, Verify" ~/.claude/CLAUDE.md` | Match found |
| 2.3 | Verify skills | `ls ~/.claude/skills/` | checkpoint, continue, create-project, learn, playbook, promote |
| 2.4 | Verify hooks | `ls ~/.claude/hooks/` | session-start.js, session-end.js |
| 2.5 | Verify templates | `ls ~/.claude/templates/` | hooks/, knowledge/, project-CLAUDE.md |
| 2.6 | Smoke-test session-start | `echo '{"session_id":"test","cwd":"/tmp"}' \| node ~/.claude/hooks/session-start.js` | Valid JSON with `hookEventName: "SessionStart"` |

## 3. Knowledge Setup

| # | Action | Command | Pass Criterion |
|---|--------|---------|----------------|
| 3.1 | Create knowledge repo | `mkdir -p ~/.claude/knowledge/entries && cd ~/.claude/knowledge && git init` | Git repo initialized |
| 3.2 | Seed a test entry | See [entry template](#knowledge-entry-template) below | entry.md created |
| 3.3 | Commit entry | `cd ~/.claude/knowledge && git add . && git commit -m "seed"` | Commit succeeds |
| 3.4 | Verify injection | `echo '{"session_id":"test","cwd":"'$(pwd)'"}' \| node ~/.claude/hooks/session-start.js \| python3 -m json.tool` | Output includes "knowledge entries" section |

### Knowledge Entry Template

Create `~/.claude/knowledge/entries/20260223-test-gotcha/entry.md`:

```markdown
---
id: "20260223-test-gotcha"
tool: "git"
category: "gotcha"
tags: ["test", "dogfood"]
confidence: "high"
---
## Context

Test entry: git rebase --autostash silently drops stash on conflict.

## Fix

Use `git stash` explicitly before rebase, then `git stash pop` after resolving conflicts.
```

## 4. First Session

| # | Action | Command | Pass Criterion |
|---|--------|---------|----------------|
| 4.1 | Launch Claude Code | `cd /path/to/test-project && claude` | Session starts |
| 4.2 | Check hook fired | Look for "Registered as" in session context | Registration message visible |
| 4.3 | Check agent-comm log | `cat ~/.claude/agent-comm/agent-comm.log` | Shows "registered" entry |
| 4.4 | Check state.json | `cat ~/.claude/agent-comm/state.json \| python3 -m json.tool` | Agent listed in `agents` |

## 5. Knowledge Injection

| # | Action | Command | Pass Criterion |
|---|--------|---------|----------------|
| 5.1 | Ask Claude | "What knowledge entries were injected into this session?" | Lists the git gotcha entry from step 3.2 |
| 5.2 | Verify relevance | Create a non-git project (no .git/), start new session | No knowledge entries injected |

## 6. `/continue` Skill

| # | Action | Command | Pass Criterion |
|---|--------|---------|----------------|
| 6.1 | Run /continue | Type `/continue` in Claude Code | Either loads prior session context OR reports "no prior session found" |
| 6.2 | After some work, exit and re-enter | Exit, restart Claude Code, run `/continue` | Shows context from previous session |

## 7. `/playbook` Skill

| # | Action | Command | Pass Criterion |
|---|--------|---------|----------------|
| 7.1 | Run /playbook check | Type `/playbook check` | Analyzes CLAUDE.md, reports findings |
| 7.2 | Run /playbook project | Type `/playbook project` | Analyzes project CLAUDE.md or offers to create one |

## 8. `/learn` Skill

| # | Action | Command | Pass Criterion |
|---|--------|---------|----------------|
| 8.1 | Capture a lesson | Type `/learn` and describe a lesson | Creates entry file under ~/.claude/knowledge/entries/ |
| 8.2 | Verify entry format | Read the created entry.md | Has YAML frontmatter with id, tool, category, tags |
| 8.3 | Verify git commit | `cd ~/.claude/knowledge && git log --oneline -1` | Shows commit for the new entry |

## 9. `/checkpoint` Skill

| # | Action | Command | Pass Criterion |
|---|--------|---------|----------------|
| 9.1 | Make a code change | Edit a file in the test project | File modified |
| 9.2 | Run /checkpoint | Type `/checkpoint` | Updates memory, commits, pushes (or reports no remote) |
| 9.3 | Verify memory updated | Read MEMORY.md for the project | "Current Work" section updated |
| 9.4 | Verify git commit | `git log --oneline -1` | Shows checkpoint commit |

## 10. Session End

| # | Action | Command | Pass Criterion |
|---|--------|---------|----------------|
| 10.1 | Exit Claude Code | Type `/exit` or Ctrl+C | Session ends cleanly |
| 10.2 | Check deregistration | `cat ~/.claude/agent-comm/state.json \| python3 -m json.tool` | Agent removed from `agents` |
| 10.3 | Check broadcast | Look for "Session ended" in messages array | Message present with session ID |
| 10.4 | Check auto-commit | `cd ~/.claude && git log --oneline -1` | Shows auto-commit with session ID (session-end hook auto-inits git repo if needed) |

## 11. Research Profile

| # | Action | Command | Pass Criterion |
|---|--------|---------|----------------|
| 11.1 | Install research | `bash install.sh --profile research --force` | Exits 0 |
| 11.2 | Verify skills switched | `ls ~/.claude/skills/` | investigate, continue (no checkpoint, playbook, etc.) |
| 11.3 | New investigation | Type `/investigate new` | Creates investigation directory with BRIEF.md |
| 11.4 | Collect evidence | Type `/investigate collect` | Adds numbered evidence file |
| 11.5 | Synthesize | Type `/investigate synthesize` | Creates findings summary |
| 11.6 | Close investigation | Type `/investigate close` | Marks investigation complete |

## 12. Cross-Profile Switching

| # | Action | Command | Pass Criterion |
|---|--------|---------|----------------|
| 12.1 | Switch back to dev | `bash install.sh --profile dev --force` | Exits 0 |
| 12.2 | Verify investigation preserved | `ls ~/.claude/investigations/` | Investigation directory still exists |
| 12.3 | Verify knowledge preserved | `ls ~/.claude/knowledge/entries/` | Knowledge entries still present |
| 12.4 | Verify dev skills restored | `ls ~/.claude/skills/` | checkpoint, continue, create-project, learn, playbook, promote |

## 13. Summary Checklist

| Section | Status |
|---------|--------|
| 1. Setup | [ ] |
| 2. Dev install | [ ] |
| 3. Knowledge setup | [ ] |
| 4. First session | [ ] |
| 5. Knowledge injection | [ ] |
| 6. /continue | [ ] |
| 7. /playbook | [ ] |
| 8. /learn | [ ] |
| 9. /checkpoint | [ ] |
| 10. Session end | [ ] |
| 11. Research profile | [ ] |
| 12. Cross-profile | [ ] |

---

## Known Expected Failures

1. **`/create-project` hardcodes `~/Documents/`**: Fails on Linux servers without a Documents directory. Must be run from the desired parent directory manually.

2. **`project-CLAUDE.md` template is Node-specific**: Python/Go users need to manually edit the testing and quality gate sections after scaffolding.
