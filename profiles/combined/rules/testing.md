---
description: Test conventions for the agentic coding playbook
globs:
  - "tests/**"
---

# Test Conventions

- Each test file is self-contained with an inline runner (no test framework)
- Use Node.js `assert` module for assertions
- One test file per hook/module, named `<module>.test.js`
- Tests must be non-throwing — catch errors and report them
- Test helper: `tests/hooks/test-helpers.js` provides `runHook()` and `runHookRaw()`
- Strip CLAUDE_LOOP* env vars from test environment to prevent leakage
- Fixtures in `tests/fixtures/` — exclude from sanitize-guard scanning
