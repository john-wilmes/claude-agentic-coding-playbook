# <project-name>

<one-line description>

## Quality Gates

Run these before every commit:

- Type-check: `<command>` (e.g., `npx tsc --noEmit`, `mypy .`, `go vet ./...`)
- Lint: `<command>` (e.g., `npx eslint .`, `ruff check .`, `golangci-lint run`)
- Test: `<command>` (e.g., `npm test`, `pytest`, `go test ./...`)

## Code Review

- Review: `coderabbit review --prompt-only --type uncommitted` (or your review tool)
- Apply all suggestions unless they introduce a regression or conflict with project architecture.

## Testing Strategy

Test at the lowest level that can verify the behavior. Do not duplicate coverage across levels.

1. **Unit test**: Pure logic, utilities, component rendering in isolation.
2. **Integration test**: Cross-component interactions, service calls with mocked backends.
3. **E2E test**: Full user workflows requiring routing, auth, or real backends.

## Architecture

- <high-level architecture: monorepo, microservices, monolith, etc.>
- <key directories and their purposes>
- <important abstractions or patterns used>

## Dependencies and Build

- Install: `<command>` (e.g., `npm install`, `pip install -e .`, `go mod download`)
- Build: `<command>` (e.g., `npm run build`, `python -m build`, `go build ./...`)
- Dev server: `<command>` (e.g., `npm run dev`, `flask run`, `go run .`)

## Project Conventions

- <language version and runtime requirements>
- <naming conventions: file names, variables, functions>
- <framework-specific patterns>
- <any project-specific rules>
