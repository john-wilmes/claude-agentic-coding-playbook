---
name: continue
description: Continue work from where the last session left off. Use when user says "where was I", "pick up where I left off", or "what was I working on". Checks inbox, reads memory, and detects whether you're in a dev project or research context to show the right information.
compatibility: claude-code
disable-model-invocation: false
allowed-tools: Read, Glob, Grep, Bash, Task
argument-hint: "[investigation-id]"
---

# Continue

Pick up where the last session left off. Check inbox first, then detect context (dev project vs research) and present the appropriate information.

## Install Root Discovery

Before any step, determine where the playbook's `.claude/` directory is installed:

Run the install-root discovery helper:

```bash
INSTALL_ROOT=$(bash ~/.claude/scripts/skills/find-install-root.sh)
```

The investigations directory is `<INSTALL_ROOT>/.claude/investigations/`.

## Steps

### 0. Session recovery

Before doing anything else, check whether the previous session ended without `/checkpoint`.

**Determine the project directory and check for a stale marker:**

```bash
PROJECT_DIR=$(ls -dt ~/.claude/projects/*/ 2>/dev/null | head -1)
if [ -f "$PROJECT_DIR/session-marker.json" ]; then
  cat "$PROJECT_DIR/session-marker.json"
else
  echo "NO_MARKER"
fi
```

**If `NO_MARKER`** — no recovery needed. Skip to step 0d (write new marker).

**If marker exists** — the previous session didn't checkpoint. Recover:

a. Parse the `sessionId` from the marker JSON.

b. Check for the JSONL transcript at `$PROJECT_DIR/<sessionId>.jsonl`:

```bash
JSONL="$PROJECT_DIR/<sessionId>.jsonl"
if [ -f "$JSONL" ]; then
  grep -c '"type":"assistant"' "$JSONL"
else
  echo "NO_JSONL"
fi
```

c. If the JSONL doesn't exist or has fewer than 5 assistant messages, skip recovery (session too short). Delete the stale marker and proceed to step 0d.

d. Spawn a **haiku** subagent (Task tool, `model: "haiku"`, `subagent_type: "general-purpose"`) with this prompt:
   - Read the JSONL file at `<path>`
   - Filter to lines containing `"type":"assistant"` — these are the agent's responses
   - Take the **last 25 matching lines** (to stay under ~50KB)
   - From the assistant content, extract: key decisions made, diagnoses reached, proposed fixes, action items discussed with the user
   - Return a concise summary (10-20 lines max, plain text, no JSON)

e. Append the recovered summary to the project's `MEMORY.md` under a `## Recovered from previous session` heading. If that heading already exists, replace it.

f. Delete the stale marker: `rm -f "$PROJECT_DIR/session-marker.json"`

g. Present to the user: "Previous session didn't checkpoint. Recovered context:" followed by the summary.

### Step 0s — Recover incomplete subagent tasks

Scan `/tmp/claude-subagent-recovery/` for `.json` files modified within the last 24 hours. For each file found:

1. Read the JSON contents (fields: `taskDescription`, `reason`, `timestamp`, `key`)
2. Delete the file after reading
3. Present a summary to the user: which subagent tasks were interrupted and why

If running under `claude-loop` (check `CLAUDE_LOOP_ID` env var), automatically retry each recovered task with reduced scope (suggest breaking into smaller pieces). In interactive mode, present the list and let the user decide which tasks to retry.

If the directory does not exist or contains no recent files, skip silently.

**Step 0d — Write new session marker:**

```bash
# Get the current session's JSONL filename (most recently created)
CURRENT_JSONL=$(ls -t "$PROJECT_DIR"/*.jsonl 2>/dev/null | head -1)
SESSION_ID=$(basename "$CURRENT_JSONL" .jsonl)
echo "{\"sessionId\": \"$SESSION_ID\", \"timestamp\": \"$(date -Iseconds)\"}" > "$PROJECT_DIR/session-marker.json"
```

### 1. Detect context

Determine whether this is a dev or research session:

- **Research context**: If `$ARGUMENTS` contains an investigation ID, OR if the current directory is inside `<INSTALL_ROOT>/.claude/investigations/`, this is a research session. Go to step 2R.
- **Dev context**: Otherwise, this is a dev session. Go to step 2D.

### 2D. Dev context — Find and present memory

Check for a project-level memory file first, then fall back to the most recent global memory:

1. Look for `MEMORY.md` in the project's memory directory (the path Claude Code auto-creates under `~/.claude/projects/`)
2. If not in a project, scan `~/.claude/projects/*/memory/MEMORY.md` and pick the most recently modified one

If no memory file was found, or the file has no `## Current Work` section, tell the user:

```text
No prior session found. This looks like a fresh start.
Suggestions:
  - Start working on your task directly
  - Run /playbook to set up project conventions
  - Run /checkpoint when you're ready to save progress
```

Then skip to step 4D.

Otherwise, read the memory file and locate the `## Current Work` section. Present it to the user with clear formatting:

```text
Last session: <date from Current Work>

What was done:
  <summary>

Current state:
  <state>

Next steps:
  <next steps>
```

### 3D. Scan for context

Check for additional context that might be relevant:
- Run `git status` to see if there are uncommitted changes from the previous session
- Run `git log --oneline -3` to see recent commits
- If the project has a task list, check for in-progress or blocked tasks

### 3.5D. Check for incomplete work

Run these quick checks directly (no subagent needed):

1. **Check for incomplete work**: `git status` and `git diff --stat` were already run in 3D. Summarize:
   - Unstaged modifications (partially completed edits)
   - Untracked source files (exclude build artifacts like `node_modules/`, `dist/`, `*.log`)
   - Staged but uncommitted changes

2. **Check knowledge candidates**: Run `ls ~/.claude/knowledge/staged/ 2>/dev/null | wc -l`. If > 0, note pending knowledge sessions.

Integrate results into step 4D:

- **Incomplete work detected** → Flag it as context for deciding what to do next.
- **Knowledge candidates exist** → Mention them briefly (don't block on them).

Do NOT run the full quality gate test suite here — that belongs in the pre-commit workflow, not session resume. Running hundreds of tests on `/continue` wastes context and can crash the session.

### 3.6D. Loop detection

Check whether /continue is repeating the same work across sessions without making progress.

1. Extract the "Next steps" text from the Current Work section of MEMORY.md (already in context from step 2D).
2. Compute a hash and check the loop detector file:
   ```bash
   NEXT_STEPS_HASH=$(echo "<next steps text>" | md5sum | cut -d' ' -f1)
   PROJECT_DIR=$(ls -dt ~/.claude/projects/*/ 2>/dev/null | head -1)
   LOOP_FILE="$PROJECT_DIR/loop-detector.json"
   cat "$LOOP_FILE" 2>/dev/null || echo '{"hash":"","attempts":0}'
   ```
3. Compare the stored hash with the current hash:
   - **Hash matches and `attempts >= 3`**: Loop detected.
     - If running under **claude-loop**: Print "claude-loop: stuck in loop — same next steps attempted 3+ times without checkpoint. Exiting." and STOP. Do NOT run `/checkpoint`. Do NOT write any sentinel.
     - If **interactive**: Warn the user:
       ```text
       Loop detected: The same next steps have been attempted 3+ times
       without reaching checkpoint. Sessions are likely crashing before
       completing the work.

       Options:
         1. Simplify the next step (break it into smaller pieces)
         2. Clear the loop counter: rm <loop-file-path>
         3. Work on something else entirely
       ```
       Then STOP — do not auto-start the work.
   - **Hash matches and `attempts < 3`**: Increment `attempts`, write updated file.
   - **Hash doesn't match**: Reset to `{"hash":"<new-hash>","attempts":1,"timestamp":"<now>"}`.
4. Write the updated loop-detector.json:
   ```bash
   echo '{"hash":"'"$NEXT_STEPS_HASH"'","attempts":<N>,"timestamp":"'"$(date -Iseconds)"'"}' > "$LOOP_FILE"
   ```

### 4D. Propose action

Check whether this session is running under `claude-loop`:

```bash
echo "${CLAUDE_LOOP:-0}"
```

**If `1` (running under claude-loop):** This is an autonomous session — there is no interactive user. Do NOT ask questions or wait for confirmation. Instead:
- If `$ARGUMENTS` contains a task after `--` (e.g. `/continue -- Next task: ...`), work on that task instead of memory's next steps.
- After completing the task, run `/checkpoint` to signal completion to claude-loop.
- If Next Steps exist in Current Work, immediately begin working on the first one.
- If there are no next steps and no task argument, print "claude-loop: no work to do — exiting." and STOP. Do NOT run `/checkpoint`. Do NOT write any sentinel file. Stopping without a sentinel tells claude-loop to end the loop gracefully.

**If `0` (interactive session):** Present the summary briefly, then **immediately start working** on the first Next Step from Current Work. Do NOT ask the user for confirmation — just begin. The user can always interrupt (Ctrl+C, new message) to redirect.

**CRITICAL — Context conservation:** After presenting the summary, do NOT read large files (100+ lines) directly into parent context. Use subagents (Task tool with Explore or general-purpose type) for any exploration that touches multiple files or large files. The /continue skill itself consumed context; protect what remains.

---

### 2R. Research context — Check for arguments

If `$ARGUMENTS` contains an investigation ID, jump to step 4R (resume specific investigation).

### 3R. List open investigations

Glob for `<INSTALL_ROOT>/.claude/investigations/*/STATUS.md` (exclude `_patterns/`).

For each, read the current phase from STATUS.md. Filter to non-closed investigations. Present:

```text
Open investigations:
  <id>    <phase>    <handoff notes summary>
  <id>    <phase>    <handoff notes summary>
```

Also show a count of closed investigations if any exist.

If no open investigations exist, say so and suggest `/investigate <id> new` to start one.

### 3R-b. Check project memory

Check for a project-level memory file:
1. Look for `MEMORY.md` in the project's memory directory (under `~/.claude/projects/`)
2. If not in a project, scan `~/.claude/projects/*/memory/MEMORY.md` and pick the most recently modified one

If no memory file was found, or it has no `## Current Work` section, say:

```text
No prior project session found.
Suggestions:
  - Run /investigate <id> new to start an investigation
  - Start working on your task directly
```

If found, extract and present the "Current Work" section:

```text
Project memory (last session):
  <summary from Current Work>
```

Scan for additional context:
- Run `git status` to check for uncommitted changes
- Run `git log --oneline -3` to see recent commits

### 4R. Resume specific investigation

If an investigation ID was provided (from argument or user choice):

1. Read `<INSTALL_ROOT>/.claude/investigations/<id>/STATUS.md`
2. If phase is "closed": ask if user wants to reopen. If yes, update phase to "collecting" and add history entry: `| <today> | reopen | Reopened by user |`
3. Read BRIEF.md for the investigation question.
4. Read the most recent evidence files (last 3).
5. Read FINDINGS.md if it has content beyond the template defaults.
6. Present:

```text
Resuming: <id>
  Question: <from brief>
  Phase: <current phase>
  Evidence collected: <count>
  Last activity: <date and summary from most recent history entry>

Handoff notes:
  <from STATUS.md>
```

7. Suggest next action based on phase:
   - `new` -> "Fill in the brief, then start collecting evidence"
   - `collecting` -> "Continue collecting evidence or synthesize what you have"
   - `synthesizing` -> "Review and refine findings, then close"
   - `closed` (reopened) -> "Continue collecting new evidence"

### 5R. Propose action

Check whether this session is running under `claude-loop`:

```bash
echo "${CLAUDE_LOOP:-0}"
```

**If `1` (running under claude-loop):** Do NOT ask questions. If `$ARGUMENTS` contains a task, work on that. If there is an open investigation, resume it. If nothing to do, print "claude-loop: no work to do — exiting." and STOP. Do NOT run `/checkpoint` or write any sentinel.

**If `0` (interactive session):** Present the summary briefly, then **immediately start working** on the most relevant next action (resume investigation, continue from memory). Do NOT ask the user for confirmation — just begin. The user can always interrupt to redirect.

**CRITICAL — Context conservation:** Do NOT read large files directly into parent context after the summary. Use subagents for exploration.
