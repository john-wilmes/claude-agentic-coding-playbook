# Hook Templates

Claude Code hook scripts that run automatically during sessions. These are installed to `~/.claude/hooks/` by the install script.

## Files

| File | Trigger | Description |
|------|---------|-------------|
| `session-start.js` | `SessionStart` | Injects memory, knowledge entries, and git context into the session. Warns when MEMORY.md or CLAUDE.md exceed size thresholds. |
| `session-end.js` | `SessionEnd` | Auto-commits memory file changes to the `~/.claude` git repo and pushes to remote (best-effort). |
| `model-router.js` | `PreToolUse` (Task) | Auto-selects Haiku/Sonnet/Opus for Task tool calls based on prompt content signals. Saves cost by routing simple tasks to cheaper models. |
| `prompt-injection-guard.js` | `PreToolUse` (Bash) | Blocks high-confidence prompt injection patterns in Bash commands. Designed for zero false positives. |
| `post-tool-verify.js` | `PostToolUse` (Edit/Write) | Auto-runs project tests after file edits with debouncing to avoid redundant runs. |
| `context-guard.js` | `PreToolUse` (all tools) + `PostToolUse` (all tools) | Dual-mode context guard. PostToolUse reads transcript token usage, warns at 35%/50%, advisory at 60%, failsafe sentinel at 75%. PreToolUse is a pure pass-through (returns {}). |
| `stuck-detector.js` | `PreToolUse` (all tools) | Detects when the agent repeats the same action 3+ times. Warns at 3, blocks at 5. Whitelists test/lint commands. |
| `pre-compact.js` | `PreCompact` | Saves an emergency snapshot (branch, modified files) to MEMORY.md before compaction so the next session can resume from known state. |
| `pre-commit` | git pre-commit | Blocks commits containing secrets (API keys, tokens) or files over 5 MB. |
| `bloat-guard.js` | `PreToolUse` (Write) | Warns when the agent creates new files. Blocks throwaway filename patterns. Escalates after 5+ new files per session. |
| `filesize-guard.js` | `PreToolUse` (Read) | Blocks oversized and binary file reads before they waste context tokens. |
| `md-size-guard.js` | `PostToolUse` (Edit/Write) | Enforces MEMORY.md line limit (150 lines) by overflowing excess content to a dated file. Warns when CLAUDE.md files grow too large. |
| `sanitize-guard.js` | `PreToolUse` (Edit/Write) + `PostToolUse` (all tools) | Runtime PII/PHI detection and redaction. Scans tool output and blocks writes containing PII. Opt-in per repo via `.claude/sanitize.yaml`. |
| `pr-review-guard.js` | `PreToolUse` (Bash) | Blocks `gh pr merge` until CodeRabbit has reviewed the PR. Gracefully degrades if `gh` is unavailable. |
| `skill-guard.js` | `PreToolUse` (Skill) | Blocks invocation of unregistered skills not found in `~/.claude/skills/`. |
| `knowledge-capture.js` | shared module | Stages knowledge candidates detected by other hooks (e.g., test fail→pass, stuck→resolved). Used by session-start and other hooks. |
| `knowledge-db.js` | shared module | SQLite-backed knowledge entry storage. Used by knowledge-capture and session-start. |
| `pii-detector.js` | shared module | PII/PHI pattern detection and redaction utility. Used by sanitize-guard. |
| `bm25.js` | shared module | BM25 text ranking algorithm. Used by session-start for knowledge entry scoring. |
| `log.js` | shared module | Structured log writer for hook diagnostic output. |
