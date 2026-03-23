# Tests

Integration tests for hooks, scripts, fleet tools, skills, and investigation scoring. All tests use Node's built-in `assert` module or bash with no external dependencies.

## Directories

- `hooks/` — Tests for Claude Code hook scripts (model router, session lifecycle, prompt injection guard, post-tool verification, sanitize guard, and more). Shared utilities in `hooks/test-helpers.js`.
- `fleet/` — Tests for the fleet indexer and MCP server scripts.
- `scripts/` — Bash and Node.js tests for CLI scripts (`q`, `qa`, `claude-loop`, `analyze-logs`).
- `skills/` — Tests for skill definitions (bash smoke tests and Node.js unit tests).
- `investigate/` — Tests for investigation scoring logic.

## Running Tests

Run all tests at once (matches the quality gate in CLAUDE.md):

```bash
for t in tests/hooks/*.test.js; do node "$t" || exit 1; done && for t in tests/fleet/*.test.js; do node "$t" || exit 1; done && for t in tests/scripts/*.test.sh; do bash "$t" || exit 1; done && for t in tests/scripts/*.test.js; do node "$t" || exit 1; done && for t in tests/skills/*.test.sh; do bash "$t" || exit 1; done && for t in tests/skills/*.test.js; do node "$t" || exit 1; done && for t in tests/investigate/*.test.js; do node "$t" || exit 1; done
```

Or run a single directory:

```bash
for t in tests/hooks/*.test.js; do node "$t" || exit 1; done
for t in tests/scripts/*.test.sh; do bash "$t" || exit 1; done
```

Skill smoke tests (`tests/skills/smoke/`) require `SKILL_SMOKE=1` and a live `claude` CLI session. They are not included in the standard test run.
