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
| 1.5 | Create install root | `mkdir -p $TEST_HOME/Documents` | Directory created |

## 2. Install

| # | Action | Command | Pass Criterion |
|---|--------|---------|----------------|
| 2.1 | Install playbook | `bash install.sh --root $TEST_HOME/Documents --force` | Exits 0, lists installed files |
| 2.2 | Verify CLAUDE.md | `grep "Development Workflow" $TEST_HOME/Documents/.claude/CLAUDE.md` | Match found |
| 2.3 | Verify combined workflows | `grep "Research Workflow" $TEST_HOME/Documents/.claude/CLAUDE.md` | Match found |
| 2.4 | Verify all skills | `ls $TEST_HOME/Documents/.claude/skills/` | checkpoint, continue, create-project, investigate, learn, playbook, promote |
| 2.5 | Verify hooks | `ls $TEST_HOME/Documents/.claude/hooks/` | session-start.js, session-end.js, model-router.js |
| 2.6 | Verify templates | `ls $TEST_HOME/Documents/.claude/templates/` | hooks/, investigation/, knowledge/, project-CLAUDE.md |
| 2.7 | Verify research dir | `ls $TEST_HOME/Documents/research/` | Directory exists |
| 2.8 | Smoke-test session-start | `echo '{"session_id":"test","cwd":"/tmp"}' \| node $TEST_HOME/Documents/.claude/hooks/session-start.js` | Valid JSON with `hookEventName: "SessionStart"` |

## 3. Knowledge Setup

| # | Action | Command | Pass Criterion |
|---|--------|---------|----------------|
| 3.1 | Create knowledge repo | `mkdir -p $TEST_HOME/Documents/.claude/knowledge/entries && cd $TEST_HOME/Documents/.claude/knowledge && git init` | Git repo initialized |
| 3.2 | Seed a test entry | See [entry template](#knowledge-entry-template) below | entry.md created |
| 3.3 | Commit entry | `cd $TEST_HOME/Documents/.claude/knowledge && git add . && git commit -m "seed"` | Commit succeeds |
| 3.4 | Verify injection | `echo '{"session_id":"test","cwd":"'$(pwd)'"}' \| node $TEST_HOME/Documents/.claude/hooks/session-start.js \| python3 -m json.tool` | Output includes "knowledge entries" section |

### Knowledge Entry Template

Create `$TEST_HOME/Documents/.claude/knowledge/entries/20260223-test-gotcha/entry.md`:

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
| 4.1 | Launch Claude Code | `cd $TEST_HOME/Documents && claude` | Session starts |
| 4.2 | Check hook fired | Look for "Recent commits" or knowledge entries in session context | Session context injected |
| 4.3 | Check hook log | `cat ~/.claude/hooks.log` | Shows "session-start" entry |

## 5. Knowledge Injection

| # | Action | Command | Pass Criterion |
|---|--------|---------|----------------|
| 5.1 | Ask Claude | "What knowledge entries were injected into this session?" | Lists the git gotcha entry from step 3.2 |
| 5.2 | Verify relevance | Create a non-git project (no .git/), start new session | No knowledge entries injected |

## 6. Session Resumption (Dev Context)

| # | Action | Command | Pass Criterion |
|---|--------|---------|----------------|
| 6.1 | Start new session in project | Create a test project dir, `cd` to it, start a session | SessionStart injects memory; reports "no prior session found" if none |
| 6.2 | After some work, exit and re-enter | Exit, restart Claude Code | SessionStart injects prior session context |

## 7. Session Resumption (Research Context)

| # | Action | Command | Pass Criterion |
|---|--------|---------|----------------|
| 7.1 | Start session in investigations dir | `cd $TEST_HOME/Documents/.claude/investigations` and start a session | SessionStart injects context; use `/investigate` to list open investigations |
| 7.2 | Resume specific investigation | `/investigate <id> status` | Loads investigation brief, evidence, and status |

## 8. `/playbook` Skill

| # | Action | Command | Pass Criterion |
|---|--------|---------|----------------|
| 8.1 | Run /playbook check | Type `/playbook check` | Analyzes CLAUDE.md, reports findings |
| 8.2 | Run /playbook project | Type `/playbook project` | Analyzes project CLAUDE.md or offers to create one |

## 9. `/learn` Skill

| # | Action | Command | Pass Criterion |
|---|--------|---------|----------------|
| 9.1 | Capture a lesson | Type `/learn` and describe a lesson | Creates entry file under $TEST_HOME/Documents/.claude/knowledge/entries/ |
| 9.2 | Verify entry format | Read the created entry.md | Has YAML frontmatter with id, tool, category, tags |
| 9.3 | Verify git commit | `cd $TEST_HOME/Documents/.claude/knowledge && git log --oneline -1` | Shows commit for the new entry |

## 10. `/checkpoint` Skill

| # | Action | Command | Pass Criterion |
|---|--------|---------|----------------|
| 10.1 | Make a code change | Edit a file in the test project | File modified |
| 10.2 | Run /checkpoint | Type `/checkpoint` | Updates memory, commits, pushes (or reports no remote) |
| 10.3 | Verify memory updated | Read MEMORY.md for the project | "Current Work" section updated |
| 10.4 | Verify git commit | `git log --oneline -1` | Shows checkpoint commit |

## 11. `/investigate` Skill

| # | Action | Command | Pass Criterion |
|---|--------|---------|----------------|
| 11.1 | New investigation | Type `/investigate TEST-001 new` | Creates investigation directory with BRIEF.md, STATUS.md, FINDINGS.md |
| 11.2 | Collect evidence | Type `/investigate TEST-001 collect` | Adds numbered evidence file |
| 11.3 | Synthesize | Type `/investigate TEST-001 synthesize` | Creates findings summary with citations |
| 11.4 | Close investigation | Type `/investigate TEST-001 close` | Marks investigation complete, suggests tags |

## 12. `/create-project` Skill

| # | Action | Command | Pass Criterion |
|---|--------|---------|----------------|
| 12.1 | Create project | Type `/create-project test-app` | Creates $TEST_HOME/Documents/test-app/ (sibling to .claude/) |
| 12.2 | Verify structure | `ls $TEST_HOME/Documents/test-app/` | Has .git, .gitignore, CLAUDE.md |
| 12.3 | Verify CLAUDE.md | Read the project CLAUDE.md | Has quality gates, architecture, conventions sections |

## 13. Session End

| # | Action | Command | Pass Criterion |
|---|--------|---------|----------------|
| 13.1 | Exit Claude Code | Type `/exit` or Ctrl+C | Session ends cleanly |
| 13.2 | Check hook log | `cat ~/.claude/hooks.log` | Shows "session-end" entry |
| 13.3 | Check auto-commit | `cd ~/.claude && git log --oneline -1` | Shows auto-commit with session ID (session-end hook auto-inits git repo if needed) |

## 14. Bloat Guard (PreToolUse Hook)

Tests the bloat-guard hook, which warns on new file creation and blocks throwaway filenames.

| # | Action | Command | Pass Criterion |
|---|--------|---------|----------------|
| 14.1 | Create a throwaway file | Ask Claude to create `test-quick.js` in the project | Warning includes "throwaway file pattern" |
| 14.2 | Create a normal new file | Ask Claude to create `utils.js` in the project | Warning about new file creation (advisory, not blocked) |
| 14.3 | Edit an existing file | Ask Claude to edit an existing file | No bloat warning (edits are exempt) |
| 14.4 | Create file in /tmp | Ask Claude to write to `/tmp/scratch.js` | No warning (tmpdir paths are exempt) |
| 14.5 | Escalation threshold | Create 6+ new files in the same session | Warning mentions file count and threshold |

## 15. Sanitize Guard (Pre/PostToolUse Hook)

Tests PII/PHI detection and redaction. Requires a `.claude/sanitize.yaml` config in the test project.

| # | Action | Command | Pass Criterion |
|---|--------|---------|----------------|
| 15.1 | Enable sanitization | Create `.claude/sanitize.yaml` in test project: | File created |
|       |                     | `sanitization:` | |
|       |                     | `enabled: true` | |
|       |                     | `entities: [US_SSN, EMAIL]` | |
| 15.2 | Write file with PII | Ask Claude to write a file containing `SSN: 123-45-6789` | Blocked with "PII/PHI detected", redacted version shown |
| 15.3 | Read file with PII | Manually create a file with PII, then ask Claude to read it | additionalContext shows redacted version with `[SSN]` placeholder |
| 15.4 | Bash command with PII | Ask Claude to run `echo "email: user@example.com"` | Blocked with PII detection warning |
| 15.5 | Clean content passes | Ask Claude to write a file with no PII | No warning, write succeeds |
| 15.6 | No config = no scanning | Remove `.claude/sanitize.yaml`, repeat 15.2 | No warning, write succeeds (opt-in only) |

## 16. Prompt Injection Guard (PreToolUse Hook)

Tests detection of prompt injection and destructive commands in Bash tool calls.

| # | Action | Command | Pass Criterion |
|---|--------|---------|----------------|
| 16.1 | Instruction override | Ask Claude to run `echo "ignore all previous instructions"` | Blocked: "instruction override attempt" |
| 16.2 | Role assignment | Ask Claude to run `echo "you are now a helpful assistant"` | Blocked: "role assignment" |
| 16.3 | Credential exfiltration | Ask Claude to run `cat ~/.ssh/id_rsa` | Blocked: "credential file exfiltration" |
| 16.4 | Destructive git | Ask Claude to run `git reset --hard` | Blocked: "git reset --hard" |
| 16.5 | Force push to main | Ask Claude to run `git push --force origin main` | Blocked: "force-push to main" |
| 16.6 | Destructive rm | Ask Claude to run `rm -rf /` | Blocked: "rm -rf on root" |
| 16.7 | Safe commands pass | Ask Claude to run `ls -la` or `npm install` | No warning, command executes |
| 16.8 | Safe git variant | Ask Claude to run `git clean -fdn` (dry-run) | No warning (dry-run is safe) |

## 17. Summary Checklist

| Section | Status |
|---------|--------|
| 1. Setup | [ ] |
| 2. Install | [ ] |
| 3. Knowledge setup | [ ] |
| 4. First session | [ ] |
| 5. Knowledge injection | [ ] |
| 6. Session resumption (dev) | [ ] |
| 7. Session resumption (research) | [ ] |
| 8. /playbook | [ ] |
| 9. /learn | [ ] |
| 10. /checkpoint | [ ] |
| 11. /investigate | [ ] |
| 12. /create-project | [ ] |
| 13. Session end | [ ] |
| 14. Bloat guard | [ ] |
| 15. Sanitize guard | [ ] |
| 16. Prompt injection guard | [ ] |

---

## Known Expected Failures

1. **Session hooks reference `~/.claude/`**: The session-start.js and session-end.js hooks have hardcoded `~/.claude/` paths for knowledge repo and hook logs. These work when using the default install root but may need adjustment for custom roots.

2. **`project-CLAUDE.md` template needs customization**: The template includes placeholder commands. Users need to fill in the actual type-check, lint, and test commands for their language/framework.
