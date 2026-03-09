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
| `pre-commit` | git pre-commit | Blocks commits containing secrets (API keys, tokens) or files over 5 MB. |
