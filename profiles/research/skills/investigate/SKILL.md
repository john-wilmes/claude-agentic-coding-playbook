---
name: investigate
description: Manage structured investigations with evidence collection, synthesis, tagging, and PHI sanitization. Subcommands: new, collect, synthesize, close, status, list, search.
disable-model-invocation: false
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Task
argument-hint: "<id> [new|collect|synthesize|close|status] | list | search <query>"
---

# Investigate

Manage structured investigations in `~/.claude/investigations/`.

## Argument Parsing

Parse `$ARGUMENTS` into:
- **id**: The investigation identifier (e.g., `AUTH-001`, `SLOW-QUERY`). Required for all subcommands except `list` and `search`.
- **subcommand**: One of `new`, `collect`, `synthesize`, `close`, `status`. If omitted, auto-detect from STATUS.md.

Special forms:
- `/investigate list` -- no id needed
- `/investigate search <query>` -- query is everything after "search"
- `/investigate <id>` -- auto-detect phase
- `/investigate <id> <subcommand>` -- explicit phase

Set `INVESTIGATIONS_DIR` to `~/.claude/investigations`.
Set `TEMPLATES_DIR` to `~/.claude/templates/investigation`.

---

## Subcommand: `list`

List all investigations with their status and tags.

### Steps

1. Glob for `$INVESTIGATIONS_DIR/*/STATUS.md` (exclude `_patterns/`).
2. For each investigation, read STATUS.md to get current phase and FINDINGS.md frontmatter for tags.
3. Present as a table:

```
| ID | Phase | Domain | Type | Updated |
|----|-------|--------|------|---------|
```

If no investigations exist, say so and suggest `/investigate <id> new`.

---

## Subcommand: `search`

Search investigations by text content or tag values.

### Steps

1. Parse the query from `$ARGUMENTS` (everything after "search").
2. Check if query matches a tag pattern (e.g., `domain:ehr`, `type:root-cause`). If so, search FINDINGS.md YAML frontmatter for matching values.
3. Otherwise, grep across all investigation files for the query text.
4. Present matching investigations with context snippets.

---

## Subcommand: `new`

Create a new investigation scaffold.

### Steps

1. Check if `$INVESTIGATIONS_DIR/<id>/` already exists. If so, warn and suggest `/investigate <id>` to resume.
2. Create directory structure: `$INVESTIGATIONS_DIR/<id>/EVIDENCE/`
3. Create initial files:

**BRIEF.md:**
```markdown
# Investigation: <id>

## Question

{To be filled}

## Scope

{To be filled}

## Context

{To be filled}
```

**STATUS.md:**
```markdown
# Status: <id>

## Current Phase

new

## History

| Date | Phase | Summary |
|------|-------|---------|
| <today> | new | Investigation created |

## Handoff Notes

Starting investigation. Brief needs to be filled in.
```

**FINDINGS.md:**
```yaml
---
tags:
  domain: []
  type: []
  severity: []
  components: []
  symptoms: []
  root_cause: []
---
# Findings: <id>

## Answer

{Not yet determined.}

## Evidence Summary

| # | Slug | Key observation |
|---|------|-----------------|

## Implications

{To be determined.}
```

4. Search for related investigations:
   - Grep `$INVESTIGATIONS_DIR/*/FINDINGS.md` for keywords derived from the id
   - If matches found, mention them: "Related investigations: ..."

5. Ask the user to describe the investigation question, scope, and context. Write BRIEF.md based on their description. Keep it to 10 lines max.

6. After the brief is written, update STATUS.md: set phase to "collecting", add a history entry.

---

## Subcommand: `collect`

Gather one piece of evidence.

### Steps

1. Read STATUS.md to confirm phase is "new" or "collecting". If "closed", ask if user wants to reopen.
2. Read BRIEF.md to recall the investigation question.
3. Count existing evidence files in `EVIDENCE/` to determine the next number (zero-padded to 3 digits: 001, 002, ...).
4. Gather evidence. Either:
   - The user describes what they found and you format it
   - You actively search/read files based on the investigation question and the user's direction
   - You analyze what is currently in conversation context

5. Create the evidence file:

**EVIDENCE/NNN-slug.md:**
```markdown
# NNN: slug

**Source**: {file:line, URL, log entry, or command output}
**Relevance**: {How this connects to the investigation question}

{Observation -- 3 lines max. State what you found, not what it means.}
```

The slug should be a short kebab-case label (e.g., `auth-token-expiry`, `db-connection-pool`).

6. Update STATUS.md:
   - Set phase to "collecting" if not already
   - Add history entry: `| <today> | collect | Evidence NNN: slug |`
   - Update handoff notes with current state

7. Suggest next action:
   - If fewer than 3 evidence files: "Continue collecting with `/investigate <id> collect`"
   - If 3+ evidence files: "Consider synthesizing with `/investigate <id> synthesize`"
   - The user drives the pace -- these are suggestions, not requirements

---

## Subcommand: `synthesize`

Condense collected evidence into findings.

### Steps

1. Read BRIEF.md to recall the investigation question.
2. Read all evidence files in `EVIDENCE/` in order.
3. Read current FINDINGS.md.
4. Analyze the evidence to answer the question from the brief. Draft:
   - **Answer**: Direct response to the question, citing evidence by number (e.g., "Evidence 001 shows...")
   - **Evidence Summary**: Table row for each evidence file with key observation
   - **Implications**: What this means beyond the immediate question
5. Present the draft findings to the user for review. Apply their feedback.
6. Write the updated FINDINGS.md (preserve the YAML frontmatter tags section unchanged; update the body).
7. Update STATUS.md:
   - Set phase to "synthesizing"
   - Add history entry
   - Update handoff notes

8. Suggest: "When findings are complete, close with `/investigate <id> close`"

---

## Subcommand: `close`

Finalize the investigation: classify, tag, extract patterns, sanitize.

### Steps

1. Read BRIEF.md, all evidence files, and FINDINGS.md.

2. **Classify and tag**: Based on the investigation content, suggest YAML frontmatter tags.

   Controlled vocabulary:
   - `domain`: ehr, infrastructure, integration, auth, data-pipeline, ui, api
   - `type`: root-cause, exploration, how-it-works, incident, performance, security
   - `severity`: critical, high, medium, low, informational

   Free-form (suggest based on content):
   - `components`: service names, libraries, tools mentioned
   - `symptoms`: what was observed that triggered the investigation
   - `root_cause`: what was actually wrong (if determined)

   Present suggested tags to the user and ask them to confirm or adjust. Write confirmed tags to the FINDINGS.md YAML frontmatter.

3. **Extract patterns**: Assess whether the findings reveal a reusable pattern (common failure mode, architectural insight, debugging technique).
   - If yes, create or update a file in `$INVESTIGATIONS_DIR/_patterns/<pattern-slug>.md`:
     ```markdown
     # Pattern: <name>

     **Source**: Investigation <id>
     **Date**: <today>

     ## Description

     {What the pattern is and when it applies}

     ## Indicators

     {How to recognize this pattern in the future}

     ## Resolution

     {What to do about it}
     ```
   - If no clear pattern, skip. Not every investigation produces a pattern.

4. **PHI sanitization**:
   - Check if `~/.claude/scripts/sanitize.sh` exists and is executable
   - If yes: run it on BRIEF.md, FINDINGS.md, STATUS.md, and all evidence files. Report what was sanitized.
   - If no: print "Review files manually for PII/PHI before sharing. Install the research profile for automated sanitization: install.sh --profile research"

5. Update STATUS.md:
   - Set phase to "closed"
   - Add history entry with a one-line summary of the finding
   - Set handoff notes to "Investigation closed."

6. Print summary:
   ```
   Investigation <id> closed.
     Tags: domain:<values>, type:<values>, severity:<values>
     Pattern extracted: <yes (name) | no>
     PHI sanitized: <yes | not installed | no config>

     Findings: ~/.claude/investigations/<id>/FINDINGS.md
   ```

---

## Subcommand: `status`

Show current investigation state.

### Steps

1. Read STATUS.md and present current phase, full history table, and handoff notes.
2. Count evidence files in `EVIDENCE/` and list them briefly (number + slug).
3. If FINDINGS.md has populated tags, show them.
4. If phase is not "closed", suggest the next action.

---

## Auto-detect (no subcommand)

When `/investigate <id>` is called without a subcommand:

1. Check if `$INVESTIGATIONS_DIR/<id>/STATUS.md` exists.
2. If not: run `new`.
3. If yes: read the current phase and run the next logical subcommand:
   - `new` -> run `collect`
   - `collecting` -> run `collect`
   - `synthesizing` -> run `synthesize`
   - `closed` -> run `status` (show summary, ask if user wants to reopen)
