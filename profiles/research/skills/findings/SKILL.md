---
name: findings
description: Record investigation findings to memory with evidence trails. Use when you have reached a conclusion or want to preserve intermediate results.
disable-model-invocation: false
allowed-tools: Read, Write, Edit, Glob, Grep
argument-hint: "[summary of what was found]"
---

# Findings

Record investigation findings to the project's memory file with proper evidence trails.

## Steps

### 1. Find the memory file

Check for a project-level memory file first, then fall back to the global Documents memory:

1. Look for `MEMORY.md` in the project's memory directory (the path Claude Code auto-creates under `~/.claude/projects/`)
2. If not in a project, read `~/.claude/projects/C--Users-johnw-Documents/memory/MEMORY.md`

### 2. Read existing memory

Read the memory file to understand what is already documented. Do not duplicate existing findings.

### 3. Format the finding

Structure the finding as:

```markdown
### <Short descriptive title>

**Date**: <today's date>
**Status**: Confirmed | Hypothesis | Inconclusive

**Question/Problem**: What was being investigated.

**Finding**: What was discovered. Be specific and cite evidence.

**Evidence**:
- <file:line or URL> -- what it showed
- <file:line or URL> -- what it showed

**Implications**: What this means for the broader investigation or project.
```

If `$ARGUMENTS` is provided, use it as the basis for the finding title and summary.

### 4. Update memory

Add the finding to a `## Findings` section in the memory file. Create the section if it does not exist.

Also update the `## Current Work` section to reflect the current state of the investigation.

### 5. Confirm

Tell the user what was recorded and where. If the finding changes the direction of the investigation, suggest next steps.
