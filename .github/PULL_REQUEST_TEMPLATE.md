## Summary

<!-- 1-3 bullet points describing what changed and why -->

## Test plan

<!-- How did you verify this works? -->
- [ ] Ran affected test suite(s)
- [ ] Tested with `install.sh --dry-run`
- [ ] Manual verification: ...

## Checklist

- [ ] No new npm dependencies added
- [ ] All hooks exit 0 and output valid JSON
- [ ] Tests pass: `for t in tests/hooks/*.test.js; do node "$t" || exit 1; done && for t in tests/fleet/*.test.js; do node "$t" || exit 1; done && for t in tests/scripts/*.test.sh; do bash "$t" || exit 1; done && for t in tests/skills/*.test.sh; do bash "$t" || exit 1; done && for t in tests/skills/*.test.js; do node "$t" || exit 1; done && for t in tests/investigate/*.test.js; do node "$t" || exit 1; done`
- [ ] No secrets or credentials in committed files
