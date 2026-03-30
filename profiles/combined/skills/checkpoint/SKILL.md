---
name: checkpoint
description: Save all work, update memory, commit, push, and prepare to end the session. Use when user says "save my work", "wrap up", or "I'm done for now". Use at natural breakpoints or when context is getting large.
compatibility: claude-code
disable-model-invocation: false
allowed-tools: Bash, Task
argument-hint: "[next-steps summary]"
---

# Checkpoint

Save all session state and prepare for a clean handoff to the next session.
Delegates heavy work to a subagent to keep parent context lean.

## Steps

### 1. Delegate save work to a subagent

Spawn a subagent (model: "sonnet") using the Task tool to perform all the heavy I/O.
Pass it the following context:

- The project's memory file path (e.g. `~/.claude/projects/<project>/memory/MEMORY.md`)
- What was accomplished this session (summarize briefly)
- `$ARGUMENTS` if provided (use as next-steps summary)
- The current working directory

The subagent prompt should instruct it to:

1. **Update memory**: Read the project's `MEMORY.md`. Update the "Current Work" section with what was done, current state, and next steps. Replace the previous entry (do not accumulate). Add date stamp. Add any non-obvious discoveries to Lessons Learned. Do not duplicate existing entries. **Clear the `## Recovered from previous session` section entirely if it exists** — its content has been incorporated into Current Work.

2. **Commit and push**: Run `git status`. If there are uncommitted changes, stage relevant files (not build artifacts, logs, or secrets), commit with a descriptive message, and push to remote. If no changes or not a git repo, skip.

3. **Sync knowledge repo** (if applicable): If `~/.claude/knowledge` exists and has a `.git` directory:
   ```
   if [ -f "$HOME/.claude/hooks/knowledge-db.js" ]; then
     node ~/.claude/hooks/knowledge-db.js export ~/.claude/knowledge/entries.jsonl 2>/dev/null
   fi
   bash ~/.claude/scripts/skills/sync-knowledge-repo.sh --knowledge-dir ~/.claude/knowledge
   ```

4. **Verify**: Run `git status` to confirm clean working tree.

5. **Clear session state**: Delete the session marker and loop detector to indicate a clean exit:
   ```bash
   # Derive the project dir from cwd — Claude Code encodes the path with slashes as dashes.
   PROJECT_SLUG=$(pwd | sed 's|/|-|g')
   PROJECT_DIR=$(echo "$HOME/.claude/projects/${PROJECT_SLUG}" | sed 's|//|/|g')
   # Fall back to most-recently-modified project dir if the derived path doesn't exist.
   if [ ! -d "$PROJECT_DIR" ]; then
     PROJECT_DIR=$(ls -dt ~/.claude/projects/*/ 2>/dev/null | head -1)
   fi
   rm -f "$PROJECT_DIR/session-marker.json"
   rm -f "$PROJECT_DIR/loop-detector.json"
   # Only delete session-specific state, not the entire shared recovery directory
   # (other concurrent sessions may be using it)
   if [ -n "${CLAUDE_LOOP_PID:-}" ] && [[ "${CLAUDE_LOOP_PID}" =~ ^[0-9]+$ ]]; then
     rm -f "/tmp/claude-subagent-recovery/recovery-${CLAUDE_LOOP_PID}.json"
   fi
   ```

6. **Return a one-line summary** of what was done (e.g. "Memory updated, committed abc1234, pushed to origin").

### 2. Exit decision

After the subagent returns, print exactly:
```
CHECKPOINT COMPLETE
```

Check if running under claude-loop:

```bash
echo "CLAUDE_LOOP=${CLAUDE_LOOP:-0} SENTINEL=${CLAUDE_LOOP_SENTINEL:-}"
```

**If `CLAUDE_LOOP=1` (headless/task-queue mode):** Write the sentinel and exit.

```bash
[[ "${CLAUDE_LOOP_PID}" =~ ^[0-9]+$ ]] || exit 0
SENTINEL="/tmp/claude-checkpoint-exit-${CLAUDE_LOOP_PID}"
echo '{"reason":"checkpoint","timestamp":'$(date +%s)'}' > "${SENTINEL}"
```

Print exactly "Exiting — claude-loop will respawn." Then STOP. Do not make any more tool calls or produce any more output.

**If `CLAUDE_LOOP_SENTINEL` is set (interactive mode under claude-loop):** Write the sentinel.

```bash
[[ "${CLAUDE_LOOP_PID}" =~ ^[0-9]+$ ]] || exit 0
SENTINEL="/tmp/claude-checkpoint-exit-${CLAUDE_LOOP_PID}"
echo '{"reason":"checkpoint","timestamp":'$(date +%s)'}' > "${SENTINEL}"
```

Print exactly:

```text
Checkpoint complete. Session will restart with fresh context.
```

Then STOP. Do not make any more tool calls or produce any more output.

**If neither is set (standalone session, no claude-loop):** Print exactly:

```text
Checkpoint complete. Exiting session.
```

Then STOP. Do not make any more tool calls or produce any more output. The session is over.
