---
name: playbook
description: Analyze your Claude Code configuration and suggest improvements based on the agentic coding playbook. Works on both global and project-level CLAUDE.md files.
disable-model-invocation: false
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, AskUserQuestion
argument-hint: "[global | project | cursor | check]"
---

# Playbook Configurator

Analyze the user's Claude Code configuration and intelligently merge playbook best practices. Unlike the install script's `--wizard` mode (which does simple file-level skip/overwrite/backup), this skill understands the semantic content of CLAUDE.md files and merges section-by-section.

## Modes

Parse `$ARGUMENTS` to determine the mode:
- **`global`** (default if no argument): Analyze and improve `~/.claude/CLAUDE.md`
- **`project`**: Analyze and improve the current project's `CLAUDE.md`
- **`cursor`**: Set up Cursor rules and commands in the current project
- **`check`**: Audit current configuration and report what is missing or outdated

## Steps for `global` mode

### 1. Read the user's global CLAUDE.md

Read `~/.claude/CLAUDE.md`. If it does not exist, offer to create one from scratch using the playbook template.

### 2. Analyze existing sections

Identify the sections in the user's file. Map them to the playbook's recommended sections:

**Playbook recommended sections:**
- The Workflow (Explore, Plan, Code, Verify, Commit)
- Reasoning Standards (evidence-based debugging, hypothesis-driven, cite sources)
- Efficiency and Cost Optimization (parallel calls, no re-reads, model routing)
- Context and Session Management (fresh sessions, /compact, subagents)
- Quality Gates (type-check, lint before commit)
- Testing and Verification (lowest-level tests, continuous feedback loop)
- Code Review (automated review on every commit)
- Security (no credentials, sandbox mode, MCP server restrictions)
- Git Discipline (no --no-verify, no force-push)
- File Creation Rules (no orphan files, no one-off scripts)
- Memory File Discipline (Current Work tracking, lessons learned)
- Repository Hygiene (.gitignore, no large files)

### 3. Generate a comparison report

For each playbook section, classify the user's coverage:
- **Covered**: The user has equivalent rules (possibly under a different heading). Note any differences.
- **Partially covered**: Some rules present, others missing. List what is missing.
- **Missing**: The section is not addressed. Explain what it provides and why it matters.
- **Extra**: The user has sections not in the playbook. These are preserved as-is.

Present this as a table:

```
Section                    | Status            | Notes
---------------------------|-------------------|------
Reasoning Standards        | Covered           | Your "Debugging" section covers this
Efficiency                 | Partially covered | Missing: model routing, two-attempt limit
Quality Gates              | Missing           | Enforces type-check and lint before commits
...                        | ...               | ...
```

### 4. Offer merge options

Use AskUserQuestion to let the user choose:
1. **Add all missing sections** -- append playbook sections the user does not have
2. **Interactive section-by-section** -- go through each missing/partial section and ask to add, skip, or customize
3. **Just show me the diff** -- display what would change without modifying anything
4. **Skip** -- make no changes

### 5. Apply changes

If the user chose to merge:
- Preserve all existing user sections, including "Extra" sections not in the playbook
- For "Missing" sections: append the playbook version at the end of the file
- For "Partially covered" sections: suggest specific lines to add within the existing section. Show the proposed edit and confirm before applying.
- Never remove or overwrite user content without explicit confirmation
- After editing, show a summary of what changed

### 6. Check skills

After handling CLAUDE.md, check if recommended skills are installed:
- `/checkpoint` at `~/.claude/skills/checkpoint/SKILL.md`
- `/resume` at `~/.claude/skills/resume/SKILL.md`

Report any missing skills and offer to note them for the user to install via the install script.

## Steps for `project` mode

### 1. Check for project CLAUDE.md

Look for `CLAUDE.md` in the current working directory.

### 2. If no project CLAUDE.md exists

Offer to create one using the playbook template. Read `~/.claude/templates/project-CLAUDE.md` if available, otherwise use the built-in template structure:

```markdown
# <project-name>

<one-line description>

## Quality Gates

- Type-check: `<command>`
- Lint: `<command>`
- Test: `<command>`

## Code Review

- Run <tool> on staged changes before every commit.
- Apply all suggestions unless they introduce a regression.

## Testing Strategy

Test at the lowest level that can verify the behavior.

1. Unit test: Pure logic, utilities, isolated components.
2. Integration test: Cross-component interactions, mocked backends.
3. E2E test: Full user workflows with real backends.

## Project Conventions

- <framework/architecture notes>
- <naming conventions>
- <project-specific rules>
```

Ask the user to fill in project-specific values (name, commands, conventions).

### 3. If project CLAUDE.md exists

Analyze it against the template. Check for:
- Quality gate commands defined
- Code review rules present
- Testing strategy documented
- Project conventions documented

Report gaps and offer to add missing sections.

## Steps for `cursor` mode

### 1. Check for Cursor config

Look for `.cursor/` directory in the current project.

### 2. Check for templates

Look for Cursor templates at `~/.claude/templates/cursor/`. If not found, inform the user they need to run the install script first.

### 3. Copy templates

If templates exist:
- Copy `~/.claude/templates/cursor/rules/*.mdc` to `.cursor/rules/`
- Copy `~/.claude/templates/cursor/commands/*.md` to `.cursor/commands/`
- Create `.cursor/rules/` and `.cursor/commands/` directories if needed
- Skip files that already exist (report them)

### 4. Report

Show what was installed and what was skipped.

## Steps for `check` mode

Run a quick audit without making changes:

1. **Global CLAUDE.md**: Does it exist? How many sections match the playbook? What is missing?
2. **Skills**: Are /checkpoint, /resume, and /playbook installed?
3. **Project CLAUDE.md** (if in a project): Does it exist? Does it have quality gates, review rules, test strategy?
4. **Cursor** (if in a project): Are .cursor rules and commands set up?
5. **Memory**: Does the project have a memory directory with a MEMORY.md file?

Present results as a checklist:
```
[x] Global CLAUDE.md (12/12 sections)
[x] /checkpoint skill installed
[x] /resume skill installed
[x] /playbook skill installed
[ ] Project CLAUDE.md (no quality gates defined)
[ ] Cursor rules (not installed)
[x] Memory file exists
```
