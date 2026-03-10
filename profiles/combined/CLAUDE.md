# Global Claude Code Instructions

These rules apply to all projects.

## Workflows

This playbook supports two workflows. Claude determines which applies based on the working directory.

### Development Workflow: Explore, Plan, Code, Verify, Commit

Active in project folders (any directory with a project-level CLAUDE.md or git repo).

Follow this sequence for non-trivial tasks:
1. **Explore**: Read relevant code. Use Plan Mode or subagents for investigation.
2. **Plan**: Design the approach before writing code. Use Plan Mode for multi-file changes.
3. **Code**: Implement the plan. Batch edits per file.
4. **Verify**: Run tests, type-check, lint. Verification is the primary feedback loop, not a gate.
5. **Commit**: Update memory, commit, push.

Skip Explore/Plan for trivial changes (typos, single-line fixes).

### Research Workflow: Question, Collect, Synthesize, Close

Active in the research/investigations folder (`~/.claude/investigations/`).

Follow this lifecycle for non-trivial investigations:
1. **Question**: Define a scoped question in a brief (10 lines max). Use `/investigate <id> new`.
2. **Collect**: Gather evidence one piece at a time. Each observation is 3 lines max with source and relevance.
3. **Synthesize**: Condense evidence into findings that answer the question. Cite evidence by number.
4. **Close**: Classify with tags, extract reusable patterns, sanitize PII/PHI.

Investigations live at `~/.claude/investigations/<id>/`. Use `/investigate` to manage the lifecycle.

## Reasoning Standards

- Read code before modifying or making claims about it. Cite file:line when referencing specific behavior.
- When debugging, state your hypothesis and the evidence. Check at least two possible causes before committing to a fix.
- Explain why a fix works, not just that it works. If you cannot explain the mechanism, the fix is suspect.
- Distinguish verified facts ("confirmed at file:line") from inferences ("based on the pattern, likely...").
- Do not cargo-cult solutions. Verify that patterns from other projects actually apply to this codebase.
- When something fails unexpectedly, investigate root cause before retrying or working around it.

## Evidence Discipline

When conducting investigations (research workflow):

- Each evidence file captures one observation: source, relevance, and 3-line max description.
- Number evidence sequentially (001, 002, ...). Reference by number in findings.
- Record what you found, not what it means. Interpretation belongs in synthesis.
- Always include the source (file:line, URL, command output) so evidence is verifiable.

## Efficiency and Cost Optimization

- Make independent tool calls in parallel within a single response.
- Do not re-read files already in context. Track what you have read this session.
- Do not echo tool output or restate what the user can already see.
- Use targeted search (Glob for filenames, Grep for content) before spawning exploration agents.
- Plan all changes to a file before editing. Fewer larger edits, not many small ones.
- Keep responses concise. No preamble ("Let me..."), no recaps unless asked.
- After two failed attempts at the same approach, switch strategies or ask the user.

### Model Routing

When spawning subagents via the Task tool, ALWAYS set the `model` parameter.
Never rely on inheritance — it defaults to the parent model (usually the most
expensive). Cost ratios are 1x (haiku) : 3x (sonnet) : 5x (opus).

Decision tree:
1. Task ONLY reads, searches, or explores? -> `model: "haiku"`
2. Task writes code, tests, or refactors? -> `model: "sonnet"`
3. Task requires cross-file reasoning, architecture, or complex debugging? -> `model: "opus"`

When in doubt, choose the cheaper option. A model-router hook auto-selects
when you forget, but explicit is better than implicit.

## Context and Session Management

- Start fresh sessions at natural breakpoints rather than pushing context to its limits.
- Run `/compact` when context reaches ~70%. Use custom focus instructions (e.g., `/compact Focus on the API changes`).
- Use subagents for exploration-heavy work to protect parent context size.
- Delegate multi-file edits (3+ files) to subagents. Each Edit/Read returns file contents that consume parent context. A subagent editing 14 files keeps those results in its own context; the parent only sees the summary.
- Never read multiple image files in the same turn -- use a subagent for bulk image examination.
- Use `/rewind` or double-Escape to undo actions and roll back context.
- Proactively suggest `/compact` when you notice context growing large (many tool results, long exploration).
- Proactively suggest `/checkpoint` at natural breakpoints: after completing a feature, fixing a bug, or finishing a refactor.
- Use `/continue` at session start to see open investigations and project state.

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

CodeRabbit reviews happen automatically on GitHub PRs via the CodeRabbit GitHub App.

**Agent workflow:**
- Create a PR using `gh pr create`. CodeRabbit will post review comments automatically within a few minutes.
- After creating a PR, check for CodeRabbit review comments: `gh pr view <number> --comments` or `gh api repos/{owner}/{repo}/pulls/{number}/comments`.
- Address all CodeRabbit findings before merging. Apply suggestions unless they introduce a regression or conflict with project architecture. Document the reason when declining a suggestion.
- If CodeRabbit hasn't reviewed yet, wait 2-3 minutes and check again. Do not merge without a review.

**User setup (one-time):**
- Install the CodeRabbit GitHub App: https://github.com/apps/coderabbitai
- Grant access to the repos you want reviewed.
- Add a `.coderabbit.yaml` to each repo to customize review behavior (optional but recommended).

### Devil's advocate review

When a branch is 5+ commits ahead of main and includes documentation or configuration changes, suggest a structured adversarial review before creating the PR. This means: verify external claims against live sources, check file paths and URLs, challenge assumptions, cite file:line for every finding. Do not run this on every commit -- it is high-value but high-cost.

## PII/PHI Protection

When recording evidence or findings during investigations:

- Use placeholders for identifiers: `[PATIENT]`, `[MRN]`, `[SSN]`, `[DOB]`.
- At close time, Presidio auto-sanitization runs if installed. Otherwise, review manually before sharing.
- Never commit unsanitized investigation files to shared repositories.

## Security

- Never pipe untrusted content directly to the agent.
- Never commit credentials, API keys, or secrets. Use `.env` files excluded by `.gitignore`.
- Review proposed changes to security-critical files (auth, permissions, crypto) line by line.
- Enable `/sandbox` mode when working with untrusted repositories or running unfamiliar scripts.
- Always create GitHub repos with `--private`. Only use `--public` if the user has explicitly and unprompted requested a public repo. Never infer public visibility from context.
- Disable project-level MCP servers by default (`enableAllProjectMcpServers: false`) to prevent supply chain injection.

## Git Discipline

- Never use `--no-verify` on git commit or git push commands.
- Never amend published commits without explicit human approval.
- Never force-push to main or master without explicit human approval.

## File Creation Rules

- Never create one-off scripts, build logs, or analysis documents as files.
- Every new file must be referenced by at least one existing file. Orphan files are not allowed.
- Investigation files belong in `~/.claude/investigations/`, not in project repos.

## Memory File Discipline

- Memory files should include a Lessons Learned section documenting bugs, root causes, and fixes.
- Update lessons learned when a non-obvious bug is resolved or a workaround is discovered.
- Always maintain a "Current Work" section with what was done, current state, and next steps.

## Repository Hygiene

- Every project must have a `.gitignore` before first commit. At minimum: `node_modules/`, `dist/`, `.env*`, `*.log`, OS files.
- Never commit files over 5MB. Host large files externally and reference by URL.
