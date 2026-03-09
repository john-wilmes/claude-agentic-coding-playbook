# Tests

Unit tests for hooks and investigation scoring. All tests use Node's built-in `assert` module with no external dependencies.

## Running Tests

```bash
node tests/hooks/model-router.test.js
node tests/hooks/session-hooks.test.js
node tests/hooks/prompt-injection-guard.test.js
node tests/hooks/post-tool-verify.test.js
node tests/investigate/score.test.js
```

Or run all tests at once:

```bash
for f in tests/hooks/*.test.js tests/investigate/*.test.js; do node "$f"; done
```

## Structure

- `hooks/` -- Tests for Claude Code hook scripts (model router, session lifecycle, prompt injection guard, post-tool verification)
- `hooks/test-helpers.js` -- Shared test utilities
- `investigate/` -- Tests for investigation scoring logic
