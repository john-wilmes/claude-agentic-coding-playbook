# Hook Templates

Claude Code hook scripts that run automatically during sessions. These are installed to `~/.claude/hooks/` by the install script.

## Session Lifecycle Hooks

| File | Event | Description |
|------|-------|-------------|
| `session-start.js` | `SessionStart` | Injects memory, knowledge entries, and git context into the session. Warns when MEMORY.md or CLAUDE.md exceed size thresholds. |
| `session-end.js` | `SessionEnd` | Auto-commits memory file changes to the `~/.claude` git repo and pushes to remote (best-effort). |
| `pre-compact.js` | `PreCompact` | Saves an emergency snapshot (branch, modified files) to MEMORY.md before compaction so the next session can resume from known state. |
| `post-compact.js` | `PostCompact` | Re-injects memory and task context after auto-compaction so the agent can resume where it left off. |
| `subagent-context.js` | `SubagentStart` | Injects project context and claude-loop warnings into spawned subagents. |

## PreToolUse Hooks

| File | Matcher | Description |
|------|---------|-------------|
| `model-router.js` | `Task` | Auto-selects Haiku/Sonnet/Opus for Task and Agent tool calls based on prompt content signals. Saves cost by routing simple tasks to cheaper models. |
| `prompt-injection-guard.js` | `Bash` | Blocks high-confidence prompt injection patterns in Bash commands. Designed for zero false positives. |
| `pr-review-guard.js` | `Bash` | Blocks `gh pr merge` until CodeRabbit has reviewed the PR. Gracefully degrades if `gh` is unavailable. |
| `stuck-detector.js` | all tools | Detects when the agent repeats the same action 3+ times. Warns at 3, blocks at 5. Whitelists test/lint commands. |
| `bloat-guard.js` | `Write` | Warns when the agent creates new files. Blocks throwaway filename patterns. Escalates after 5+ new files per session. |
| `filesize-guard.js` | `Read\|Bash` | Blocks oversized and binary file reads before they waste context tokens. |
| `sanitize-guard.js` | `Edit\|Write` | Blocks writes containing PII/PHI detected by pii-detector. Returns a redacted version for retry. Opt-in per repo via `.claude/sanitize.yaml`. |
| `skill-guard.js` | `Skill` | Blocks invocation of skills not found in `~/.claude/skills/`. |
| `read-once-dedup.js` | `Read` | Blocks re-reads of unchanged files to prevent redundant context consumption. 38-40% context savings in typical sessions. |
| `context-guard.js` | all tools | Pure pass-through (always returns `{}`). Registered to enable the PostToolUse half of the dual-mode setup. |

## PostToolUse Hooks

| File | Matcher | Description |
|------|---------|-------------|
| `post-tool-verify.js` | `Edit\|Write` | Auto-runs project tests after file edits with debouncing to avoid redundant runs. |
| `md-size-guard.js` | `Edit\|Write` | Enforces MEMORY.md line limit (150 lines) by overflowing excess content to a dated file. Warns when CLAUDE.md files grow too large. |
| `sanitize-guard.js` | all tools | Scans tool output for PII/PHI. If found, emits a redacted copy as additionalContext. Opt-in per repo via `.claude/sanitize.yaml`. |
| `sycophancy-detector.js` | all tools | Detects behavioral patterns indicating sycophancy — rubber-stamping, compliance without investigation, shallow reviews. Warns via PostToolUse advisory. |
| `context-guard.js` | all tools | Reads transcript token usage and advises at 35%/50%, warns at 60%, writes failsafe sentinel at 75% for claude-loop restart. |
| `subagent-recovery.js` | `Task` | Detects truncated subagent output and writes recovery state for the parent agent to act on. |

## PostToolUseFailure Hooks

| File | Matcher | Description |
|------|---------|-------------|
| `tool-failure-logger.js` | all tools | Logs tool errors to `~/.claude/logs/tool-failures.jsonl` for post-session analysis. |

## TaskCompleted Hooks

| File | Description |
|------|-------------|
| `task-completed-gate.js` | Quality gate for agent teams. Blocks teammate task completion if project tests fail. |

## TeammateIdle Hooks

| File | Description |
|------|-------------|
| `teammate-idle.js` | Nudges idle teammate agents to check their TaskList for remaining work before going idle. |

## Git Hooks (template, not Claude Code hooks)

| File | Trigger | Description |
|------|---------|-------------|
| `pre-commit` | git pre-commit | Blocks commits containing secrets (API keys, tokens) or files over 5 MB. Copy to `.git/hooks/` in each project. |

## Shared Modules

These are helper modules required by the hooks above. They are not registered as hooks themselves.

| File | Used By | Description |
|------|---------|-------------|
| `log.js` | all hooks | Structured log writer for hook diagnostic output. |
| `bm25.js` | `session-start.js` | BM25 text ranking algorithm for knowledge entry scoring. |
| `knowledge-db.js` | `session-start.js`, `knowledge-capture.js` | SQLite-backed knowledge entry storage. |
| `knowledge-capture.js` | `session-start.js`, other hooks | Stages knowledge candidates detected by hooks (e.g., test fail→pass, stuck→resolved). |
| `pii-detector.js` | `sanitize-guard.js` | PII/PHI pattern detection and redaction utility. |
