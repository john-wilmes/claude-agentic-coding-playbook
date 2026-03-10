---
name: create-project
description: Scaffold a new project with git, .gitignore, CLAUDE.md, GitHub repo, and memory directory. Run from ~/Documents.
disable-model-invocation: false
allowed-tools: Bash, Write, Read, Glob, AskUserQuestion, mcp__coderabbitai__*
argument-hint: "<project-name>"
---

# Create Project

Scaffold a new project following all global CLAUDE.md conventions.

## Input

- `$ARGUMENTS` = project name (required, kebab-case)

If no arguments provided, ask the user for a project name.

## Steps

### 1. Gather requirements

Ask the user (single AskUserQuestion call):
- **Project type**: Node/TypeScript, Python, static site, or other
- **Description**: one-line summary for package.json and GitHub

### 2. Create directory

```
~/Documents/<project-name>/
```

Fail if directory already exists.

### 3. Initialize git

```bash
cd ~/Documents/<project-name> && git init
```

### 4. Create .gitignore

Minimum entries per global CLAUDE.md Repository Hygiene rules:
- `node_modules/`, `dist/`, `.env*`, `*.log`, `.DS_Store`, `Thumbs.db`

Add language-specific entries based on project type (e.g., `__pycache__/` for Python, `.next/` for Next.js).

### 5. Create project CLAUDE.md

Must include:
- Project name and one-line description
- **Quality gate commands** (type-check, lint, test) appropriate to the project type
- Any project-specific conventions

Example for Node/TypeScript:
```markdown
# <project-name>

<description>

## Quality Gates

- Type-check: `npx tsc --noEmit`
- Lint: `npx eslint .`
- Test: `npm test`
```

### 6. Create AGENTS.md

Generate an `AGENTS.md` file at the project root. This is a cross-tool convention (60k+ repos) that tells any AI coding assistant how to build, test, and lint the project.

Populate sections from the quality gate commands chosen in step 5:

```markdown
# AGENTS.md

## Build

<build command from quality gates, or "No build step configured.">

## Test

<test command from quality gates, e.g. "npm test">

## Lint

<lint command from quality gates, e.g. "npx eslint .">

## General

- Follow existing code style and naming conventions.
- Write tests for new functionality.
- Do not commit credentials or secrets.
```

### 7. Create package.json or equivalent

Use `npm init -y` for Node projects. Set name, description, and version. For Python, create `pyproject.toml`. For static sites, create a minimal `package.json` with dev scripts (e.g., a `start` or `serve` script) — this is optional if no tooling is needed. For "other" project types, skip this step or add the appropriate manifest for that ecosystem.

### 8. Install pre-commit hook

First, check if `core.hooksPath` is configured:
```bash
git config core.hooksPath
```

If `~/.claude/templates/hooks/pre-commit` exists:

**If `core.hooksPath` is set** (e.g., `~/.git-hooks`):
- Use that directory instead of `.git/hooks/`
- If a pre-commit hook already exists there, do NOT overwrite — inform the user they need to manually merge
- Otherwise, copy the template there and make it executable
- Warn the user that this is a global hook directory

**If `core.hooksPath` is NOT set:**
```bash
cp ~/.claude/templates/hooks/pre-commit ~/Documents/<project-name>/.git/hooks/pre-commit
chmod +x ~/Documents/<project-name>/.git/hooks/pre-commit
```

This hook blocks files >5MB, common credential patterns, and .env files from being committed.

### 9. Create GitHub repo and push

```bash
cd ~/Documents/<project-name>
git add -A
git commit -m "Initial project scaffold"
gh repo create <project-name> --private --source . --push
```

Always use `--private`. Only use `--public` if the user has explicitly and unprompted requested a public repo. Never infer public visibility from context.

### 10. Run CodeRabbit initial review

Use the CodeRabbit MCP tools to run a full review of the initial codebase. For each finding:
- Apply the suggestion immediately if it improves the code.
- Skip only if it introduces a regression or conflicts with project conventions. Document the reason.

After applying fixes, commit and push again:
```bash
cd ~/Documents/<project-name>
git add -A
git commit -m "Apply CodeRabbit initial review suggestions"
git push
```

If there are no findings or no applicable fixes, skip this commit.

### 11. Set up project memory

Claude Code automatically creates the project memory directory at `~/.claude/projects/<project-key>/memory/` on first session in that directory. No manual setup needed.

### 12. Report

Tell the user:
- The project path
- The GitHub repo URL (from `gh repo view --json url -q .url`)
- CodeRabbit review summary (findings applied, findings skipped with reasons)
- Next step: `cd ~/Documents/<project-name>` and start a new Claude Code session there
