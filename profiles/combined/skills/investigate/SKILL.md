---
name: investigate
description: Manage structured investigations with multi-agent evidence collection, synthesis, tagging, and PHI sanitization. Subcommands: new, run, collect, synthesize, close, status, list, search.
disable-model-invocation: false
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Task
argument-hint: "<id> [new|run|collect|synthesize|close|status] | list | search <query>"
---

# Investigate (v2)

Manage structured investigations.

## Install Root Discovery

Before any subcommand, determine where the playbook's `.claude/` directory is installed. The install root may differ from `~/.claude/` if the user ran `install.sh --root <path>`.

1. Walk up from the current working directory, checking each ancestor for a `.claude/` directory that contains `investigations/`, `skills/`, or `templates/`.
2. Also check `~/.claude/` as a candidate.
3. Prefer the candidate closest to the current working directory.
4. Fall back to `~/.claude/` if no candidate is found.

Set `INSTALL_ROOT` to the discovered path (the parent of `.claude/`).
Set `INVESTIGATIONS_DIR` to `<INSTALL_ROOT>/.claude/investigations`.
Set `TEMPLATES_DIR` to `<INSTALL_ROOT>/.claude/templates/investigation`.

---

## Argument Parsing

Parse `$ARGUMENTS` into:
- **id**: The investigation identifier (e.g., `AUTH-001`, `SLOW-QUERY`). Required for all subcommands except `list` and `search`.
- **subcommand**: One of `new`, `run`, `collect`, `synthesize`, `close`, `status`. If omitted, auto-detect from STATUS.md.

Special forms:
- `/investigate list` -- no id needed
- `/investigate search <query>` -- query is everything after "search"
- `/investigate <id>` -- auto-detect phase
- `/investigate <id> <subcommand>` -- explicit phase

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
3. Ask the user:
   - What is the investigation question? (one sentence)
   - What is the absolute path to the repository being investigated? (leave blank if not a code investigation)
   - Any scope constraints? (optional)
   - Any additional context?

4. Create initial files:

**BRIEF.md:**
```markdown
# Investigation: <id>

## Question

{user's question}

## Repo

{absolute repo path, or "none"}

## Scope

{scope notes, or "Full codebase"}

## Context

{additional context provided by user}
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

Starting investigation. Run `/investigate <id> run` to dispatch specialist agents.
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

5. Search for related investigations:
   - Grep `$INVESTIGATIONS_DIR/*/FINDINGS.md` for keywords derived from the id
   - If matches found, mention them: "Related investigations: ..."

6. Tell the user: "Scaffold created. Run `/investigate <id> run` to start the investigation, or `/investigate <id> collect` to add evidence manually."

---

## Subcommand: `run`

Dispatch specialist agents in parallel, collect evidence, and synthesize findings in one cycle.

### Step 1: Pre-flight

Read STATUS.md.
- If phase is `"running"`: warn "A prior run appears to be in progress or was interrupted." Count existing evidence files and ask: "s = synthesize with existing evidence | r = re-run from scratch | q = quit". If `r`, confirm before deleting EVIDENCE/ contents.
- If phase is `"closed"`: confirm with user before continuing.

### Step 2: Load context

Read BRIEF.md. Extract:
- `QUESTION`: content of `## Question` section
- `REPO_PATH`: content of `## Repo` section (trim whitespace)

If `## Repo` is absent or contains `"none"` or is blank: set `HAS_REPO = false`. Otherwise `HAS_REPO = true`.

Count existing evidence files in EVIDENCE/ using Glob(`EVIDENCE/??-*.md`). Call this `EXISTING_COUNT`.

### Step 3: Detect repo capabilities

If `HAS_REPO = false`, skip to Step 4 with all capability flags false.

Run these checks in parallel (Bash):

```bash
# Has tests?
find "<REPO_PATH>" -maxdepth 4 \( -name "*.test.*" -o -name "*.spec.*" -o -name "test_*.py" \) 2>/dev/null | head -5

# Has logs?
find "<REPO_PATH>" -maxdepth 3 \( -name "*.log" -o -type d -name "logs" \) 2>/dev/null | head -3

# Has git history?
git -C "<REPO_PATH>" log --oneline -5 2>/dev/null

# Has config files?
find "<REPO_PATH>" -maxdepth 2 \( -name "*.yaml" -o -name "*.yml" -o -name "*.json" -o -name ".env*" \) 2>/dev/null | grep -v node_modules | head -5
```

If `REPO_PATH` directory does not exist: error out. "Repo path not found. Update BRIEF.md ## Repo with a valid path."

Derive flags:
- `HAS_TESTS`: test files found (≥1)
- `HAS_LOGS`: log files or logs directory found
- `HAS_GIT`: git log returns ≥1 commit
- `HAS_CONFIG`: config files found

### Step 4: Select specialists

Build the specialist list:

| Specialist | Include when | Evidence range | Model |
|---|---|---|---|
| code-archaeologist | `HAS_REPO = true` | 001–049 | `"haiku"` |
| test-reader | `HAS_TESTS = true` | 050–099 | `"haiku"` |
| git-historian | `HAS_GIT = true` | 100–149 | `"haiku"` |
| log-config-reader | `HAS_LOGS or HAS_CONFIG` | 150–199 | `"haiku"` |
| concept-analyst | `HAS_REPO = false` | 001–099 | `"sonnet"` |

Rules:
- If `HAS_REPO = false`: use concept-analyst only.
- If `HAS_REPO = true` but only one repo specialist qualifies: always add log-config-reader as a second (even if no logs, it can analyze config files).
- Maximum 4 specialists. Priority if capped: code-archaeologist > git-historian > test-reader > log-config-reader.

Present the plan before dispatching:

```
Repo capabilities detected:
  Has tests: yes/no
  Has git history: yes/no
  Has logs: yes/no
  Has config: yes/no

Dispatching N specialists:
  code-archaeologist   (evidence 001–049)
  test-reader          (evidence 050–099)
  ...

Proceed? [Y/n]
```

If user declines, stop.

### Step 5: Dispatch in parallel

Update STATUS.md: set phase to `"running"`, add history entry.

Spawn all selected specialists simultaneously as Task tool calls. Each call must be independent — agents share no context with each other or with the parent session.

**Task parameters for all specialists:**
- `subagent_type`: `"general-purpose"`
- `model`: as specified in the table above (always explicit — never rely on inheritance)
- The prompt must be fully self-contained

---

**Prompt template: code-archaeologist**

```
You are a code investigation specialist. Read source code to find evidence about the investigation question.

Investigation ID: {ID}
Investigation question: {QUESTION}
Repository: {REPO_PATH}
Your evidence range: 001–049

Tasks:
1. Read $INVESTIGATIONS_DIR/{ID}/BRIEF.md for full context.
2. Use Glob and Grep to find the 3–5 source files most relevant to the question.
3. Read each file. Write one evidence file per significant finding.
4. Write between 3 and 8 evidence files. Stop before file 050.

Evidence file path: $INVESTIGATIONS_DIR/{ID}/EVIDENCE/NNN-slug.md
Evidence file format (use exactly):

# NNN: slug

**Source**: relative/file/path.ts:lineNumber
**Relevance**: one sentence connecting this to the investigation question

Observation in 3 lines max. State what the code does, not what it means.

Rules:
- Source must be a real file:line. Never leave it empty or placeholder.
- Do not write FINDINGS.md or any synthesis.
- Do not write files outside your range (001–049).
```

---

**Prompt template: test-reader**

```
You are a test coverage investigation specialist. Read test files to find evidence about the investigation question.

Investigation ID: {ID}
Investigation question: {QUESTION}
Repository: {REPO_PATH}
Your evidence range: 050–099

Tasks:
1. Read $INVESTIGATIONS_DIR/{ID}/BRIEF.md for full context.
2. Use Glob to find test files related to the question (*.test.*, *.spec.*, test_*.py, __tests__/).
3. For each relevant test file: what does it assert, what is absent, are any tests skipped?
4. Write between 2 and 6 evidence files. Stop before file 100.

Evidence file path: $INVESTIGATIONS_DIR/{ID}/EVIDENCE/NNN-slug.md
Evidence file format (use exactly):

# NNN: slug

**Source**: test/file/path.ts:lineNumber
**Relevance**: one sentence connecting this test to the investigation question

Observation in 3 lines max. What does the test assert or reveal about coverage?

Rules:
- Source must be a real file:line.
- Do not write FINDINGS.md or any synthesis.
- Do not write files outside your range (050–099).
```

---

**Prompt template: git-historian**

```
You are a git history investigation specialist. Read commit history to find evidence about the investigation question.

Investigation ID: {ID}
Investigation question: {QUESTION}
Repository: {REPO_PATH}
Your evidence range: 100–149

Tasks:
1. Read $INVESTIGATIONS_DIR/{ID}/BRIEF.md for full context.
2. Run: git -C "{REPO_PATH}" log --oneline -50
3. Identify commits relevant to the question. For key commits run: git -C "{REPO_PATH}" show --stat <hash>
4. Write between 2 and 6 evidence files. Stop before file 150.

Evidence file path: $INVESTIGATIONS_DIR/{ID}/EVIDENCE/NNN-slug.md
Evidence file format (use exactly):

# NNN: slug

**Source**: git commit <short-hash> (<date>)
**Relevance**: one sentence connecting this commit to the investigation question

Observation in 3 lines max. What changed and when?

Rules:
- Source must be a real commit hash.
- Do not write FINDINGS.md or any synthesis.
- Do not write files outside your range (100–149).
```

---

**Prompt template: log-config-reader**

```
You are a log and configuration investigation specialist. Read config files and logs to find evidence about the investigation question.

Investigation ID: {ID}
Investigation question: {QUESTION}
Repository: {REPO_PATH}
Your evidence range: 150–199

Tasks:
1. Read $INVESTIGATIONS_DIR/{ID}/BRIEF.md for full context.
2. Find config files (*.yaml, *.yml, *.json, .env*) and log files (*.log, logs/) in the repo root, excluding node_modules/.
3. For each relevant config value or log entry: note the exact value, file, and line.
4. Write between 2 and 6 evidence files. Stop before file 200.

Evidence file path: $INVESTIGATIONS_DIR/{ID}/EVIDENCE/NNN-slug.md
Evidence file format (use exactly):

# NNN: slug

**Source**: config/file.yaml:lineNumber (or log/file.log:timestamp)
**Relevance**: one sentence connecting this config or log entry to the investigation question

Observation in 3 lines max. What does the config or log show?

Rules:
- Source must be a real file:line or log timestamp.
- Do not write FINDINGS.md or any synthesis.
- Do not write files outside your range (150–199).
```

---

**Prompt template: concept-analyst**

```
You are a conceptual investigation specialist. This investigation has no associated repository. Gather evidence from reasoning and known patterns.

Investigation ID: {ID}
Investigation question: {QUESTION}
Your evidence range: 001–099

Tasks:
1. Read $INVESTIGATIONS_DIR/{ID}/BRIEF.md for full context.
2. Identify 6–10 distinct aspects of the question: mechanisms, failure modes, trade-offs, known patterns, architectural principles.
3. Write one evidence file per aspect.
4. Write between 6 and 15 evidence files. Stop before file 100.

Evidence file path: $INVESTIGATIONS_DIR/{ID}/EVIDENCE/NNN-slug.md
Evidence file format (use exactly):

# NNN: slug

**Source**: conceptual analysis / known pattern / architectural principle
**Relevance**: one sentence connecting this to the investigation question

Observation in 3 lines max. State what is known about this aspect.

Rules:
- Do not write FINDINGS.md or any synthesis.
- Do not write files outside your range (001–099).
```

---

### Step 6: Collect and validate

After all Task calls complete:

1. Glob all files in EVIDENCE/ matching `??-*.md` and `???-*.md`.
2. For each specialist, count files written in its assigned range.
3. If a specialist wrote 0 files: log a warning in STATUS.md handoff notes. Do not halt.
4. Read all evidence files in numeric order. Note any with empty Source fields (chain integrity failures).

### Step 7: Synthesize

Read all evidence files. Write FINDINGS.md:

**Answer section rules:**
- First paragraph: direct answer to the investigation question.
- Every factual claim must cite at least one evidence file: `(Evidence NNN)`.
- Inferences must be labeled: `(inferred from Evidence NNN, NNN)`.
- Name the exact file and line number if the code-archaeologist found it.

**Evidence Summary:** one table row per evidence file.

**Implications:** broader consequences. Cite evidence where applicable.

### Step 8: Self-assess

After writing FINDINGS.md, run a mechanical check:

1. Count `.md` files in EVIDENCE/ with numeric prefixes 001–199. Call this `TOTAL_EVIDENCE`.
2. Read the `## Answer` section. Find every `(Evidence NNN)` citation. Collect distinct NNN values. Call the count `CITED_COUNT`.
3. Compute:
   - `CITATION_RATE` = CITED_COUNT ÷ TOTAL_EVIDENCE × 100 (round to nearest integer)
   - `UNCITED_COUNT` = TOTAL_EVIDENCE − CITED_COUNT

4. Decision:
   - `CITATION_RATE = 0`: force round 2 without offering a choice — "Citation rate is 0%. Findings do not reference collected evidence. Triggering round 2 automatically."
   - `CITATION_RATE ≥ 70 AND UNCITED_COUNT ≤ 1`: PASS. Present findings summary.
   - Otherwise: SOFT FAIL. Offer round 2.

On SOFT FAIL, present:

```
Self-assessment:
  Evidence collected:  {TOTAL_EVIDENCE} files
  Evidence cited:      {CITED_COUNT} ({CITATION_RATE}%)
  Uncited files:       {UNCITED_COUNT}

  [reason: citation rate below 70% / N files not referenced in answer]

  1  Accept findings as-is
  2  Run round 2 (targets uncited evidence, range 200+)
  3  Edit findings manually with /investigate <id> synthesize

Choice [1/2/3]:
```

### Step 9: Round 2 (if triggered)

List uncited evidence files (numbers + slugs). Dispatch a single synthesis specialist:
- `model`: `"sonnet"`
- Range: 200–249
- Prompt:

```
You are a synthesis gap-filling specialist. A multi-agent investigation has been completed but some evidence was not cited in the findings. Explain each uncited file and how it should update the findings.

Investigation ID: {ID}
Investigation question: {QUESTION}
Uncited evidence files: {LIST OF NNN-SLUG}

Tasks:
1. Read $INVESTIGATIONS_DIR/{ID}/BRIEF.md
2. Read $INVESTIGATIONS_DIR/{ID}/FINDINGS.md
3. For each uncited file listed above: read it, then write one new evidence file (range 200–249) containing:
   - What the uncited evidence says
   - How it relates to the investigation question
   - A specific suggested addition or correction to FINDINGS.md

Evidence file path: $INVESTIGATIONS_DIR/{ID}/EVIDENCE/NNN-slug.md
Evidence file format:

# NNN: synthesis-of-{original-number}

**Source**: synthesis of Evidence {original-number}
**Relevance**: why this evidence matters to the question

Suggested FINDINGS.md update in 3 lines max.

Rules:
- Do not modify FINDINGS.md directly.
- Write one file per uncited input. Stop before file 250.
```

After round 2 dispatch, re-run Steps 6–8 over the full evidence set (001–249). Offer round 2 only once — if self-assessment still fails, present findings as-is with a quality note.

### Step 10: Finalize

Update STATUS.md:
- Phase: `"synthesizing"`
- History entry: `| <today> | run | {N} evidence files, {CITATION_RATE}% citation rate |`
- Handoff notes: `"Synthesis complete. Review findings and run /investigate <id> close."`

Present to user:

```
Investigation <id> complete.
  Specialists: {list}
  Evidence: {TOTAL_EVIDENCE} files
  Citation rate: {CITATION_RATE}%
  Self-assessment: PASS / SOFT FAIL (round 2 run / declined)

Next: review findings, then /investigate <id> close
```

---

## Subcommand: `collect` (manual)

Gather one piece of evidence manually. Use when you have context agents cannot access (authenticated systems, operator queries, specific log lines).

### Steps

1. Read STATUS.md to confirm phase is `"new"`, `"collecting"`, or `"synthesizing"`. If `"closed"`, ask if user wants to reopen.
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
   - Set phase to `"collecting"` if not already
   - Add history entry: `| <today> | collect | Evidence NNN: slug |`
   - Update handoff notes with current state

7. Suggest next action:
   - If fewer than 3 evidence files: "Continue collecting or run `/investigate <id> run` to dispatch agents"
   - If 3+ evidence files: "Consider synthesizing with `/investigate <id> synthesize`, or run agents with `/investigate <id> run`"

---

## Subcommand: `synthesize`

Condense collected evidence into findings. Use after manual collection, or to re-synthesize after editing evidence files.

### Steps

1. Read BRIEF.md to recall the investigation question.
2. Read all evidence files in `EVIDENCE/` in order.
3. Read current FINDINGS.md.
4. Analyze the evidence to answer the question from the brief. Draft:
   - **Answer**: Direct response to the question. Every factual claim must cite evidence by number: `(Evidence NNN)`. Inferences must be labeled: `(inferred from Evidence NNN)`.
   - **Evidence Summary**: Table row for each evidence file with key observation
   - **Implications**: What this means beyond the immediate question
5. Present the draft findings to the user for review. Apply their feedback.
6. Write the updated FINDINGS.md (preserve the YAML frontmatter tags section unchanged; update the body).
7. Update STATUS.md:
   - Set phase to `"synthesizing"`
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
   - If no clear pattern, skip.

4. **PHI sanitization**:
   - Check if `<INSTALL_ROOT>/.claude/scripts/sanitize.sh` exists and is executable
   - If yes: run it on BRIEF.md, FINDINGS.md, STATUS.md, and all evidence files. Report what was sanitized.
   - If no: print "Review files manually for PII/PHI before sharing. Install the playbook for automated sanitization: install.sh --root <path>"

5. Update STATUS.md:
   - Set phase to `"closed"`
   - Add history entry with a one-line summary of the finding
   - Set handoff notes to "Investigation closed."

6. Print summary:
   ```
   Investigation <id> closed.
     Tags: domain:<values>, type:<values>, severity:<values>
     Pattern extracted: <yes (name) | no>
     PHI sanitized: <yes | not installed | no config>

     Findings: $INVESTIGATIONS_DIR/<id>/FINDINGS.md
   ```

---

## Subcommand: `status`

Show current investigation state.

### Steps

1. Read STATUS.md and present current phase, full history table, and handoff notes.
2. Count evidence files in `EVIDENCE/` and list them briefly (number + slug).
3. If FINDINGS.md has populated tags, show them.
4. If phase is not `"closed"`, suggest the next action.

---

## Auto-detect (no subcommand)

When `/investigate <id>` is called without a subcommand:

1. Check if `$INVESTIGATIONS_DIR/<id>/STATUS.md` exists.
2. If not: run `new`.
3. If yes: read the current phase and run the next logical subcommand:
   - `new` → run `run`
   - `collecting` → run `run`
   - `running` → run `status` (note: prior run in progress or interrupted)
   - `synthesizing` → run `synthesize`
   - `closed` → run `status` (show summary, ask if user wants to reopen)
