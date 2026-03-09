---
name: export
description: Export CLAUDE.md rules to .cursorrules, AGENTS.md, and .windsurfrules for cross-tool portability.
disable-model-invocation: false
allowed-tools: Write, Read, Glob, Grep, AskUserQuestion
argument-hint: "[output-directory]"
---

# Export

Export universal rules from `~/.claude/CLAUDE.md` to formats used by other AI coding tools.

## Input

- `$ARGUMENTS` = output directory (optional, defaults to current project directory)

## Steps

### 1. Determine output directory

If `$ARGUMENTS` is provided, use it as the output directory. Otherwise, ask the user:

```
Where should the exported files be written?
Default: <current working directory>
[Enter path or press Enter to use default]
```

Resolve the directory to an absolute path before continuing.

### 2. Read source files

Read both:
- `~/.claude/CLAUDE.md` — global rules (source of universal sections)
- Project `CLAUDE.md` in the output directory (if it exists) — source for project name and quality gate commands

If no project CLAUDE.md exists, use the output directory's basename as the project name and leave build/test/lint commands as "Not configured."

### 3. Extract universal sections

From `~/.claude/CLAUDE.md`, extract the following sections verbatim:

**Include (universal — apply to any AI tool):**
- Reasoning Standards
- Quality Gates
- Testing and Verification
- Code Review
- Security
- Git Discipline
- Repository Hygiene
- File Creation Rules

**Exclude (Claude Code-specific — irrelevant to other tools):**
- Model Routing
- Context and Session Management (any section about `/compact`, `/checkpoint`, `/rewind`, subagent spawning, or token budget)
- Memory File Discipline
- Token Budget
- Session Lifecycle
- Auto-compaction / Auto-checkpoint
- Any section referencing slash commands, hooks, or MCP servers

If a section header appears in the exclude list, skip the entire section including its content.

### 4. Generate `.cursorrules`

Write flat text — no markdown headers, no H1/H2. Separate rule groups with a single blank line. Strip leading `##` and `###` header lines; preserve bullet points and code blocks as-is.

Format:

```
<content of Reasoning Standards, rules only>

<content of Quality Gates, rules only>

<content of Testing and Verification, rules only>

<content of Code Review, rules only>

<content of Security, rules only>

<content of Git Discipline, rules only>

<content of Repository Hygiene, rules only>

<content of File Creation Rules, rules only>
```

Write to `<output-directory>/.cursorrules`.

### 5. Generate `AGENTS.md`

Extract quality gate commands from the project CLAUDE.md (look for a "Quality Gates" section with type-check, lint, and test commands). If no project CLAUDE.md exists or the section is absent, use "Not configured."

Format:

```markdown
# <project-name>

## Build

<build command, or "Not configured.">

## Test

<test command, e.g. `npm test`>

## Lint

<lint command, e.g. `npx eslint .`>

## General

<universal rules as bullet points — same content as .cursorrules but keep bullet formatting>
```

Write to `<output-directory>/AGENTS.md`.

### 6. Generate `.windsurfrules`

Write identical content to `.cursorrules` (same flat text, same rules, same blank-line separators).

Write to `<output-directory>/.windsurfrules`.

### 7. Report

Tell the user:

```
Exported 3 files to <output-directory>:
  .cursorrules      — flat rule text for Cursor
  AGENTS.md         — structured rules for OpenAI Codex, Copilot, and compatible tools
  .windsurfrules    — flat rule text for Windsurf

Sections exported: Reasoning Standards, Quality Gates, Testing and Verification,
  Code Review, Security, Git Discipline, Repository Hygiene, File Creation Rules

Sections excluded (Claude Code-specific): Model Routing, Context and Session Management,
  Memory File Discipline, Token Budget
```
