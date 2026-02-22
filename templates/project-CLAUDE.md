# <project-name>

<one-line description>

## Quality Gates

- Type-check: `npx tsc --noEmit`
- Lint: `npx eslint .`
- Test: `npm test`

## Code Review

- Run CodeRabbit (or your review tool) on staged changes before every commit.
- Apply all suggestions unless they introduce a regression or conflict with project architecture.

## Testing Strategy

Test at the lowest level that can verify the behavior. Do not duplicate coverage across levels.

1. **Unit test**: Pure logic, utilities, component rendering in isolation.
2. **Integration test**: Cross-component interactions, service calls with mocked backends.
3. **E2E test**: Full user workflows requiring routing, auth, or real backends.

## Project Conventions

- <framework/architecture notes>
- <naming conventions>
- <any project-specific rules>
