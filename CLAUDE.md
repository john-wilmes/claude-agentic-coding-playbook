# Agentic Coding Playbook

Evidence-based practices for LLM-assisted software development. Hooks and scripts for Claude Code.

## Quality Gates

Run these before every commit:

- Test: `for t in tests/hooks/*.test.js; do node "$t" || exit 1; done && for t in tests/fleet/*.test.js; do node "$t" || exit 1; done && for t in tests/scripts/*.test.sh; do bash "$t" || exit 1; done && for t in tests/scripts/*.test.js; do node "$t" || exit 1; done && for t in tests/skills/*.test.sh; do bash "$t" || exit 1; done && for t in tests/skills/*.test.js; do node "$t" || exit 1; done && for t in tests/investigate/*.test.js; do node "$t" || exit 1; done`

No type-check or lint commands — this is a bash + Node scripting project.

## Architecture

- `templates/hooks/` — Hook scripts installed to `~/.claude/hooks/` by `install.sh`
- `profiles/combined/` — CLAUDE.md, skills, and settings for the combined dev+research profile
- `scripts/` — CLI tools (`q`, `qa`, `claude-loop`, `analyze-logs.js`)
- `templates/fleet/` — Fleet index scripts (`fleet-index.js`)
- `templates/mcp/` — MCP server scripts (`fleet-index-server.js`)
- `tests/hooks/` — Node.js integration tests for each hook (zero deps, stdlib only)
- `tests/fleet/` — Node.js integration tests for fleet scripts
- `tests/scripts/` — Bash integration tests for CLI scripts
- `tests/investigate/` — Node.js tests for investigation scoring
- `tests/skills/smoke/` — Smoke tests using `claude` CLI (gated behind `SKILL_SMOKE=1` env var)
- `docs/` — Best practices guide, case studies, methodology docs

## Dependencies and Build

- Install: `./install.sh` (symlinks hooks, skills, and config to `~/.claude/`)
- No build step — all scripts run directly
- No npm dependencies — Node stdlib only

## Project Conventions

- **Node.js 18+** for hooks and test scripts; **Node.js 22+** required for `knowledge-db.js` (uses `node:sqlite`) and the multi-model analyzer
- **Zero npm dependencies** — all hooks use Node stdlib only (`fs`, `path`, `os`, `crypto`, `child_process`)
- **JSON stdout** — hooks communicate with Claude Code via JSON on stdout
- **Exit 0 always** — hooks must never crash or exit non-zero; errors produce `{}` output
- **Bash + Node** — scripts are bash, hooks are Node.js
- File naming: kebab-case for hooks and scripts (e.g., `context-guard.js`, `stuck-detector.js`)
- Tests: one test file per hook, named `<hook-name>.test.js`, using Node `assert` module
- Test runner: custom inline runner (no test framework) — each test file is self-contained
