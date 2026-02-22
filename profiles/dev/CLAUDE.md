# Global Claude Code Instructions

These rules apply to all projects.

## The Workflow: Explore, Plan, Code, Verify, Commit

Follow this sequence for non-trivial tasks:
1. **Explore**: Read relevant code. Use Plan Mode or subagents for investigation.
2. **Plan**: Design the approach before writing code. Use Plan Mode for multi-file changes.
3. **Code**: Implement the plan. Batch edits per file.
4. **Verify**: Run tests, type-check, lint. Verification is the primary feedback loop, not a gate.
5. **Commit**: Update memory, commit, push.

Skip Explore/Plan for trivial changes (typos, single-line fixes).

## Reasoning Standards

- Read code before modifying or making claims about it. Cite file:line when referencing specific behavior.
- When debugging, state your hypothesis and the evidence. Check at least two possible causes before committing to a fix.
- Explain why a fix works, not just that it works. If you cannot explain the mechanism, the fix is suspect.
- Distinguish verified facts ("confirmed at file:line") from inferences ("based on the pattern, likely...").
- Do not cargo-cult solutions. Verify that patterns from other projects actually apply to this codebase.
- When something fails unexpectedly, investigate root cause before retrying or working around it.

## Efficiency and Cost Optimization

- Make independent tool calls in parallel within a single response.
- Do not re-read files already in context. Track what you have read this session.
- Do not echo tool output or restate what the user can already see.
- Use targeted search (Glob for filenames, Grep for content) before spawning exploration agents.
- Plan all changes to a file before editing. Fewer larger edits, not many small ones.
- Keep responses concise. No preamble ("Let me..."), no recaps unless asked.
- After two failed attempts at the same approach, switch strategies or ask the user.

### Model Routing

Use the cheapest model that can handle the task:
- **Haiku**: Exploration, search, file reads, linting, simple transforms.
- **Sonnet**: Implementation, test writing, refactoring, code review.
- **Opus**: Architecture, planning, complex debugging, multi-file coordination.

When spawning subagents, set the `model` parameter explicitly.

## Context and Session Management

- Start fresh sessions at natural breakpoints rather than pushing context to its limits.
- Run `/compact` when context reaches ~70%. Use custom focus instructions (e.g., `/compact Focus on the API changes`).
- Use subagents for exploration-heavy work to protect parent context size.
- Never read multiple image files in the same turn -- use a subagent for bulk image examination.
- Use `/rewind` or double-Escape to undo actions and roll back context.

## Quality Gates

- Run the project's type-check and lint commands before committing (see project CLAUDE.md for specific commands).
- Fix test failures -- do not bypass, skip, or suppress them.
- All `.skip` additions to tests require a code comment documenting the root cause.

## Testing and Verification

Verification is the single highest-leverage practice. Give the agent a way to check its own work.

- Write tests at the lowest level that can verify the behavior (unit > integration > E2E).
- Do not duplicate coverage across levels.
- Use tests as a continuous feedback loop, not just a terminal gate: write code, run tests, fix, iterate.
- When reviewing existing tests, flag any that test at a higher level than necessary.

## Code Review

If `coderabbit` CLI is available:
- On project creation, run `coderabbit review --plain` on the full codebase. Fix all findings before continuing.
- Before every commit, run `coderabbit review --prompt-only --type uncommitted`. Apply all suggestions unless they introduce a regression or conflict with project architecture. Document the reason when declining a suggestion.
- When reviewing a PR, run `coderabbit review --plain --base main`. Address all findings before merging.

If no CLI tool is available, use whatever automated review is configured (MCP, GitHub app, manual).

## Security

- Never pipe untrusted content directly to the agent.
- Never commit credentials, API keys, or secrets. Use `.env` files excluded by `.gitignore`.
- Review proposed changes to security-critical files (auth, permissions, crypto) line by line.
- Enable `/sandbox` mode when working with untrusted repositories or running unfamiliar scripts.
- Disable project-level MCP servers by default (`enableAllProjectMcpServers: false`) to prevent supply chain injection.

## Git Discipline

- Never use `--no-verify` on git commit or git push commands.
- Never amend published commits without explicit human approval.
- Never force-push to main or master without explicit human approval.

## File Creation Rules

- Never create one-off scripts, build logs, or analysis documents as files.
- Every new file must be referenced by at least one existing file. Orphan files are not allowed.

## Memory File Discipline

- Memory files should include a Lessons Learned section documenting bugs, root causes, and fixes.
- Update lessons learned when a non-obvious bug is resolved or a workaround is discovered.
- Always maintain a "Current Work" section with what was done, current state, and next steps.

## Repository Hygiene

- Every project must have a `.gitignore` before first commit. At minimum: `node_modules/`, `dist/`, `.env*`, `*.log`, OS files.
- Never commit files over 5MB. Host large files externally and reference by URL.
