---
name: create-project
description: Scaffold a new project with git, .gitignore, CLAUDE.md, AGENTS.md, GitHub repo, and memory directory. Use when user says "start a new project", "create a repo", or "scaffold an app". Creates the project as a sibling to the .claude/ config directory.
compatibility: claude-code
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

### 1. Determine install root

Run the install-root discovery helper:

```bash
INSTALL_ROOT=$(bash ~/.claude/scripts/skills/find-install-root.sh)
```

### 2. Gather requirements

Ask the user (single AskUserQuestion call):
- **Project type**: Node/TypeScript, Python, static site, or other
- **Description**: one-line summary for package.json and GitHub

### 3. Create directory

```
<INSTALL_ROOT>/<project-name>/
```

Fail if directory already exists.

### 4. Initialize git

```bash
cd <INSTALL_ROOT>/<project-name> && git init
```

### 5. Create .gitignore

Minimum entries per global CLAUDE.md Repository Hygiene rules:
- `node_modules/`, `dist/`, `.env*`, `*.log`, `.DS_Store`, `Thumbs.db`

Add language-specific entries based on project type (e.g., `__pycache__/` for Python, `.next/` for Next.js).

### 6. Create project CLAUDE.md

Read the template at `<INSTALL_ROOT>/.claude/templates/project-CLAUDE.md` if available, otherwise use the built-in template.

Must include:
- Project name and one-line description
- **Quality gate commands** (type-check, lint, test) appropriate to the project type
- Language and framework conventions
- Architecture notes section (even if initially empty)
- Build and dependency instructions

### 7. Create AGENTS.md

Generate an `AGENTS.md` file at the project root. This is a cross-tool convention (60k+ repos) that tells any AI coding assistant how to build, test, and lint the project.

Populate sections from the quality gate commands chosen in step 6:

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

### 8. Create package.json or equivalent

Use `npm init -y` for Node projects. Set name, description, and version. For Python, create `pyproject.toml`. For static sites, create a minimal `package.json` with dev scripts (e.g., a `start` or `serve` script) — this is optional if no tooling is needed. For "other" project types, skip this step or add the appropriate manifest for that ecosystem.

### 9. Install pre-commit hook

First, check if `core.hooksPath` is configured:
```bash
git config core.hooksPath
```

If `<INSTALL_ROOT>/.claude/templates/hooks/pre-commit` exists:

**If `core.hooksPath` is set** (e.g., `~/.git-hooks`):
- Use that directory instead of `.git/hooks/`
- If a pre-commit hook already exists there, do NOT overwrite — inform the user they need to manually merge
- Otherwise, copy the template there and make it executable
- Warn the user that this is a global hook directory

**If `core.hooksPath` is NOT set:**
```bash
cp <INSTALL_ROOT>/.claude/templates/hooks/pre-commit <INSTALL_ROOT>/<project-name>/.git/hooks/pre-commit
chmod +x <INSTALL_ROOT>/<project-name>/.git/hooks/pre-commit
```

This hook blocks files >5MB, common credential patterns, and .env files from being committed.

### 10. Create GitHub repo and push

First verify `gh` is available:
```bash
command -v gh
```

If not installed, skip this step and tell the user to install GitHub CLI (`https://cli.github.com/`) and run `gh repo create` manually.

```bash
cd <INSTALL_ROOT>/<project-name>
git add -A
git commit -m "Initial project scaffold"
gh repo create <project-name> --private --source . --push
```

Always use `--private`. Only use `--public` if the user has explicitly and unprompted requested a public repo. Never infer public visibility from context.

### 11. Run CodeRabbit initial review

If CodeRabbit MCP tools are not available (tool calls fail), skip this step. Tell the user they can install the CodeRabbit GitHub App for automatic PR reviews (`https://github.com/apps/coderabbitai`).

Use the CodeRabbit MCP tools to run a full review of the initial codebase. For each finding:
- Apply the suggestion immediately if it improves the code.
- Skip only if it introduces a regression or conflicts with project conventions. Document the reason.

After applying fixes, commit and push again:
```bash
cd <INSTALL_ROOT>/<project-name>
git add -A
git commit -m "Apply CodeRabbit initial review suggestions"
git push
```

If there are no findings or no applicable fixes, skip this commit.

### 12. Set up project memory

Claude Code automatically creates the project memory directory at `~/.claude/projects/<project-key>/memory/` on first session in that directory. No manual setup needed.

### 13. Report

Tell the user:
- The project path
- The GitHub repo URL (from `gh repo view --json url -q .url`)
- CodeRabbit review summary (findings applied, findings skipped with reasons)
- Next step: `cd <INSTALL_ROOT>/<project-name>` and start a new Claude Code session there
