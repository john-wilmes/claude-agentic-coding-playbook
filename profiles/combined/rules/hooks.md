---
description: Hook development conventions
globs:
  - "templates/hooks/**"
---

# Hook Conventions

- Exit 0 always — hooks must never crash or exit non-zero
- Errors produce `{}` JSON output (empty object = no-op)
- JSON stdout for communication with Claude Code
- Zero npm dependencies — Node stdlib only
- Read hook input from stdin as JSON
- PreToolUse hooks can modify tool input via `hookSpecificOutput.updatedInput`
- PostToolUse hooks inject context via `hookSpecificOutput.additionalContext`
- File naming: kebab-case (e.g., `context-guard.js`, `stuck-detector.js`)
