[![Test Install Script](https://github.com/YOUR_ORG/claude-agentic-coding-playbook/actions/workflows/test-install.yml/badge.svg)](https://github.com/YOUR_ORG/claude-agentic-coding-playbook/actions/workflows/test-install.yml)

# Agentic Coding Playbook

Evidence-based practices for LLM-assisted software development. Built for [Claude Code](https://claude.com/claude-code). The principles in [best-practices.md](docs/best-practices.md) are conceptually portable, but all hooks, skills, and scripts target Claude Code specifically.

## Why This Exists

AI-assisted code contains 1.7x more issues than human-written code and introduces 10x more security findings in enterprise settings. Developer productivity gains range from -19% (experienced OSS developers) to +55% (controlled tasks) depending on task type, tool, and developer experience. The practices in this playbook are designed to capture the upside while mitigating the documented risks.

Key findings from the research:

| Metric | Value | Source |
|--------|-------|--------|
| AI code issues vs human code | 1.7x more | CodeRabbit (470 PRs) |
| Security findings in AI-assisted teams | 10x increase | Apiiro (Fortune 50) |
| Prompt injection success rate | 94% | PMC controlled study |
| AI code review defect detection | 44-82% | Greptile, Macroscope benchmarks |
| Fresh session vs exhausted session cost | ~10x cheaper | Anthropic |
| Model routing savings (Haiku vs Opus) | 5-20x | Anthropic pricing |
| Prompt cache hit savings | 90% | Anthropic |
| Teams with AI review seeing quality gains | 81% vs 55% | Qodo |

Full details with citations: [docs/best-practices.md](docs/best-practices.md)

## How This Works

Most Claude Code setups rely on CLAUDE.md instructions alone. Instructions are advisory — compliance ranges from ~50-90% in our testing (published research reports lower rates for complex instruction sets). This playbook takes a different approach:

- **Designed for bypass mode.** The biggest productivity gains come from running Claude Code autonomously (`--dangerously-skip-permissions` or `bypassPermissions` in settings). Without guardrails, bypass mode means no safety net — destructive commands, runaway file creation, and context exhaustion go unchecked. With this playbook's hooks, you get deterministic enforcement of safety rules even when the agent has full permissions: prompt injection is blocked, context limits are enforced, destructive git operations are caught, and PII is redacted — all without permission prompts interrupting flow.
- **Hooks enforce rules deterministically.** 35+ hooks — each fires on the relevant tool calls (not all on every call) — catching context exhaustion, prompt injection, sycophantic compliance patterns, and file bloat before they cause problems. Hooks achieve near-100% enforcement for deny rules and >95% for advisory rules — where instructions alone cannot.
- **Structured logging makes agent behavior observable.** Every hook decision is logged to JSONL. Analysis tools (`analyze-logs.js`) report context usage, stuck loops, model routing, and hook effectiveness per session — so you can measure what's working and what isn't.
- **Practices are validated by running them.** The playbook is [dogfooded](docs/dogfooding.md) against real codebases with a 100-task framework. Bugs found during dogfooding (context guard effectiveness, task queue edge cases, implicit completion detection) feed directly back into the hooks and scripts.
- **Zero npm dependencies.** All hooks use Node.js stdlib only. No `node_modules`, no build step, no supply chain risk.

## Try a Single Hook

Want to test the waters before a full install? Copy `context-guard.js` (context window monitoring) and its logger dependency:

```bash
mkdir -p ~/.claude/hooks
curl -fsSL https://raw.githubusercontent.com/YOUR_ORG/claude-agentic-coding-playbook/master/templates/hooks/context-guard.js -o ~/.claude/hooks/context-guard.js
curl -fsSL https://raw.githubusercontent.com/YOUR_ORG/claude-agentic-coding-playbook/master/templates/hooks/log.js -o ~/.claude/hooks/log.js
chmod +x ~/.claude/hooks/context-guard.js ~/.claude/hooks/log.js
```

Then add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/context-guard.js" }] }
    ]
  }
}
```

This gives you context window warnings after every tool call. The full install also registers `context-guard.js` on `SessionStart` and wires up the remaining hooks.

## Quick Install

```bash
git clone https://github.com/YOUR_ORG/claude-agentic-coding-playbook.git
cd claude-agentic-coding-playbook
chmod +x install.sh
./install.sh
```

### Prerequisites

- **Bash on Linux or macOS** (Windows requires [WSL](https://learn.microsoft.com/en-us/windows/wsl/install) — native CMD/PowerShell is not supported. The install script, hooks, and test suite all assume a POSIX environment.)
- **Node.js 20+** (for hooks and test scripts)
- **git** (for version control and install script)

### Install Options

| Flag | Description |
|------|-------------|
| `--root <path>` | Controls where `research/` is created (default: `~/Documents`). Config always goes to `~/.claude/` |
| `--knowledge-repo <url>` | Git URL for a shared knowledge repository (cloned to `~/.claude/knowledge/`) |
| `--wizard` | Interactive merge with your existing configuration |
| `--force` | Overwrite existing files without prompting |
| `--dry-run` | Preview what would be installed |
| `--extras` | Install optional extras (e.g., SWE-Bench scripts, fleet indexer) |
| `--uninstall` | Remove all installed playbook files from `~/.claude/` |

### What Gets Installed

```
~/.claude/                             # Playbook configuration (always here)
  CLAUDE.md                            #   Combined dev + research workflows
  skills/
    checkpoint/SKILL.md               #   /checkpoint - save state, commit, end session
    create-project/SKILL.md           #   /create-project - scaffold a new project
    investigate/SKILL.md              #   /investigate - full investigation lifecycle
    learn/SKILL.md                    #   /learn - capture knowledge entries
    playbook/SKILL.md                 #   /playbook - analyze and improve config
    promote/SKILL.md                  #   /promote - promote lessons to global scope
  hooks/                               #   35+ hooks — safety, quality, resource management (see docs/hooks.md)
  rules/
    hooks.md                          #   Hook development conventions (globs: templates/hooks/**)
    testing.md                        #   Test conventions (globs: tests/**)
    codebase-reference.md             #   Template: org-specific repo ownership (populate for your team)
    operations.md                     #   Template: MCP tool/data access policy (populate for your org)
  templates/
    project-CLAUDE.md                 #   Template for project-level CLAUDE.md
    knowledge/
      pre-commit                      #   Git pre-commit hook (blocks secrets, large files)

<install-root>/                        # e.g. ~/Documents (set with --root)
  research/                            # Research/investigation workspace
  project-a/                           # Dev project (created with /create-project)
  project-b/                           # Dev project
```

The installer **will not overwrite** existing skills or configuration without prompting. Use `--wizard` to analyze your current setup and merge intelligently.

## What You Get

### Skills

**Development:**
- **`/checkpoint`** -- Save all work, update memory with Current Work section, commit, push, and run a devil's advocate check. Designed for clean session handoffs.
- **`/create-project`** -- Scaffold a new project with git, .gitignore, CLAUDE.md, AGENTS.md, GitHub repo. Projects are created as siblings to `.claude/`.
- **`/playbook`** -- Analyze your CLAUDE.md configuration and suggest improvements. Modes: `global`, `project`, `check`.
- **`/learn`** -- Capture a non-obvious lesson as a structured knowledge entry for future sessions.
- **`/promote`** -- Promote a project-level lesson to global scope.
**Research:**
- **`/investigate`** -- Full investigation lifecycle with multi-agent evidence collection, synthesis, tagging, and PHI sanitization. Subcommands: `new`, `run`, `collect`, `synthesize`, `close`, `status`, `list`, `search`.

### Hooks

CLAUDE.md rules are advisory (~50-90% compliance in our testing; published research reports lower rates for complex instruction sets). Hooks are deterministic (>95%) — they run scripts at specific points in the agent's workflow, guaranteeing enforcement. See [Hook Reference](docs/hooks.md) for the full guide including configuration, customization, and the "why hooks" philosophy.

**Session lifecycle:**
- **Session start** -- Injects memory, knowledge entries, and git context. Warns when MEMORY.md or CLAUDE.md exceed size thresholds.
- **Session end** -- Auto-commits memory changes, detects retrieval misses, archives stale knowledge entries.
- **Pre-compact** -- Saves context state before `/compact` runs, preserving critical information.
- **Post-compact** -- Re-injects memory and task context after auto-compaction.

**Safety:**
- **Prompt injection guard** -- Blocks high-confidence injection patterns in Bash commands (designed for zero false positives).
- **Sanitize guard** -- Runtime PII/PHI detection and redaction. Scans tool output (PostToolUse) and blocks writes containing PII (PreToolUse). Opt-in per repo via `.claude/sanitize.yaml`.
- **Skill guard** -- Validates skill invocations and prevents unauthorized skill execution.
- **MCP safety** -- `mcp-data-guard` blocks PHI field access in MCP tool calls; `mcp-query-interceptor` intercepts and sanitizes MCP queries before execution; `mcp-result-advisor` scans MCP results for PHI leakage and advises on safe handling.

**Quality:**
- **Post-tool verify** -- Auto-runs project tests after Edit/Write on code files with debouncing.
- **PR review guard** -- Enforces code review before merging. Blocks `gh pr merge` until CodeRabbit has reviewed the PR.
- **Context guard** -- Dual-mode context window monitoring. Warns at 35%/50%, advisory block at 60% (informational, not hard-blocking), failsafe sentinel at 75%.
- **Stuck detector** -- Detects and breaks agent loops when the same action repeats.
- **Sycophancy detector** -- Detects behavioral patterns indicating sycophancy — rubber-stamping, compliance without investigation, shallow reviews. Warns via PostToolUse advisory.
- **Evidence/reasoning** -- `evidence-gate` blocks research synthesis steps if supporting evidence is insufficient; `rejection-advisor` surfaces alternative interpretations when the agent accepts a framing without challenge.

**Resource management:**
- **Model router** -- Auto-selects Haiku/Sonnet/Opus for Task and Agent tool calls based on prompt signals. Warns when allowed-tools exceeds 10.
- **Filesize guard** -- Warns when reading or writing large files that waste context.
- **Bloat guard** -- Detects runaway file creation and flags unexpected project growth.
- **Markdown size guard** -- Warns when CLAUDE.md or MEMORY.md approach size thresholds.
- **Read-once dedup** -- Blocks re-reads of unchanged files (38-40% context savings, observed in author testing).
- **Dedicated tool guard** -- Warns when a general-purpose tool (Bash) is used where a dedicated tool (Glob, Grep, Read) would be more efficient.
- **Memory guards** -- `memory-accumulation-guard` warns when MEMORY.md grows faster than expected; `memory-index-guard` enforces structural conventions on the memory index to keep it navigable.
- **Checkpoint discipline** -- Enforces periodic checkpointing; warns when a long session has no checkpoint.
- **Protect main** -- Blocks direct commits and force-pushes to main/master.

**Enforcement:**
- **Checkpoint gate** -- Enforces checkpoint-exit and context-critical boundaries. Blocks sessions from continuing past failsafe thresholds without checkpointing.
- **Multi-image guard** -- Blocks reading 2+ image files per session, guiding to subagent delegation for bulk image work.
- **Orphan file guard** -- Blocks creating new files not referenced by any existing file. Prevents file bloat.
- **MCP server guard** -- Advisory warning when `enableAllProjectMcpServers: true` in global settings. Warns once per session.

**Knowledge:**
- **Knowledge capture** -- Extracts reusable lessons from session activity for the knowledge database.
- **Knowledge database** -- Retrieves relevant knowledge entries via BM25 search at session start.

**Subagent and failure handling:**
- **Subagent context** -- Injects project context and loop warnings into spawned subagents at SubagentStart.
- **Subagent recovery** -- Detects truncated subagent output after Task tool calls and writes recovery state.
- **Tool failure logger** -- Logs tool errors to `~/.claude/logs/tool-failures.jsonl` on PostToolUseFailure.
- **Task completed gate** -- Quality gate on TaskCompleted: blocks teammate task completion if tests fail.
- **Teammate idle** -- Nudges idle teammates to check their TaskList.

Utility modules (`log.js`, `bm25.js`, `pii-detector.js`, `knowledge-capture.js`, `knowledge-db.js`) are shared libraries used by the hooks above. See [Hook Reference](docs/hooks.md) for details on every hook.

### CLAUDE.md Rules

The `rules/` directory contains four files installed to `~/.claude/rules/`. `hooks.md` and `testing.md` are pre-populated conventions for this playbook. `codebase-reference.md` and `operations.md` are starter templates for org-specific customization: populate `codebase-reference.md` with your repo ownership map and key contacts, and `operations.md` with your MCP tool access policy and approved data sources. These files are included via Claude Code's glob-based rules system.

The combined CLAUDE.md includes:

- **Dual workflow** -- Development (Explore-Plan-Code-Verify-Commit) and Research (Question-Collect-Synthesize-Close), auto-selected by working directory
- **Reasoning standards** -- evidence-based debugging, two-hypothesis minimum, no cargo-culting
- **Model routing** -- use Haiku for exploration, Sonnet for implementation, Opus for planning
- **Testing as feedback loop** -- verify continuously, not just at the end
- **Code review enforcement** -- review staged changes before every commit
- **Evidence discipline** -- numbered observations with source, relevance, and 3-line max
- **PII/PHI protection** -- Regex-based PII auto-sanitization for investigation files
- **Security baseline** -- sandbox mode, credential protection, MCP server restrictions
- **Efficiency rules** -- parallel tool calls, no re-reads, two-attempt limit
- **Memory discipline** -- Current Work tracking for session continuity

## Testing

Run the full test suite:

```bash
# Hook tests (Node.js)
for t in tests/hooks/*.test.js; do node "$t" || exit 1; done

# Script tests (Bash and Node.js)
for t in tests/scripts/*.test.sh; do bash "$t" || exit 1; done
for t in tests/scripts/*.test.js; do node "$t" || exit 1; done

# Skills tests
for t in tests/skills/*.test.sh; do bash "$t" || exit 1; done && for t in tests/skills/*.test.js; do node "$t" || exit 1; done

# Fleet tests (Node.js)
for t in tests/fleet/*.test.js; do node "$t" || exit 1; done

# Investigation tests (Node.js)
for t in tests/investigate/*.test.js; do node "$t" || exit 1; done

# Or all at once
for t in tests/hooks/*.test.js; do node "$t" || exit 1; done && for t in tests/fleet/*.test.js; do node "$t" || exit 1; done && for t in tests/scripts/*.test.sh; do bash "$t" || exit 1; done && for t in tests/scripts/*.test.js; do node "$t" || exit 1; done && for t in tests/skills/*.test.sh; do bash "$t" || exit 1; done && for t in tests/skills/*.test.js; do node "$t" || exit 1; done && for t in tests/investigate/*.test.js; do node "$t" || exit 1; done
```

## CLI Scripts

Standalone tools installed to `~/.local/bin/`:

| Script | Description |
|--------|-------------|
| `q` | Lightweight CLI for direct Anthropic API Q&A. Uses Haiku by default for fast, cheap answers. |
| `qa` | File-capable agentic CLI using the Anthropic API with tool use (bash + text editor). No hooks or MCP. |
| `claude-loop` | Auto-restart wrapper for Claude Code sessions. Supports `--task-queue`, `--status-json`, `--log-file`, and `--report`. |
| `knowledge-consolidate` | Deduplicate and consolidate knowledge entries using the claude CLI for pairwise overlap analysis. |
| `repo-fleet-index` | CLI wrapper for the repo fleet indexer and MCP server. Builds manifests and a digest across your repos. |
| `sanitize.sh` | Redact PII/PHI from files using regex patterns (SSN, email, phone, credit card). Supports `--check` mode (detect without modifying) and falls back from Presidio to regex if Presidio is unavailable. |

## Log Analysis

Hooks log decisions to `~/.claude/logs/YYYY-MM-DD.jsonl`. Analyze with:

```bash
# Full report
node scripts/analyze-logs.js

# Filter by date range
node scripts/analyze-logs.js --since 2026-03-01

# Filter by session or hook
node scripts/analyze-logs.js --session abc123 --hook context-guard

# Session timeline — merges hook log events with transcript tool calls
node scripts/analyze-logs.js --timeline SESSION_ID --project-dir /path/to/project

# Cross-session aggregate metrics
node scripts/analyze-logs.js --aggregate
```

Output includes context-guard progression per session, stuck-detector triggers, model-router distribution, and prompt-injection blocks.

`--timeline SESSION_ID` requires `--project-dir PATH` to locate transcript files. The timeline shows tool calls (with `[ERROR]` markers), hook interventions (`<!>` warn, `!!!` block/escalate, `---` info), context-guard percentages, and a summary line.

`--aggregate` reports cross-session metrics: session count, context usage stats (avg/median/max), hook fire rates per session, and session health rates (stuck-detector triggers, sycophancy warnings, model routing distribution).

## Existing Users

If you already have a `~/.claude/CLAUDE.md` and custom skills:

```bash
# Preview what would change
./install.sh --dry-run

# Interactive merge -- backs up your files, shows conflicts, lets you choose
./install.sh --wizard
```

The wizard will:
1. Detect your existing CLAUDE.md and show its sections
2. Offer to backup + replace, skip, or abort
3. Skip skills that already exist (e.g., if you have your own `/checkpoint`)

## Documentation

- **[Best Practices Guide](docs/best-practices.md)** -- the full evidence-backed guide with 59 citations (58 with direct links, 1 via indirect reference)
- **[Project CLAUDE.md Template](templates/project-CLAUDE.md)** -- starting point for per-project instructions
- **[Dogfooding Guide](docs/dogfooding.md)** -- how to design and run a sustained dogfood campaign against real codebases, with a 100-task worked example
- **[Dogfood Playbook](docs/dogfood-playbook.md)** -- manual interactive testing checklist for verifying the full user experience

### Case Studies

- **[Agent Failure Analysis](docs/case-study-agent-failure.md)** -- detailed post-mortem of a production agent failure with root cause analysis
- **[Agent Failure Transcript](docs/transcript-2026-02-24-agent-failure.md)** -- raw session transcript from the failure event
- **[Feature + Debugging Walkthrough](docs/transcript-2026-03-22-feature-with-debugging.md)** -- annotated session showing the Explore-Code-Verify workflow with a real debugging detour

### Architecture

The playbook uses a single `combined` profile in `profiles/combined/` that covers both development and research workflows. The install script copies its `CLAUDE.md` and `skills/` to `~/.claude/`.

## Benchmarks

The playbook includes a SWE-Bench benchmarking script that compares Claude Code's performance on real-world bug fixes with and without the playbook installed.

```bash
# Validate setup (no API calls)
bash scripts/swe-bench.sh --dry-run

# Run 5 SWE-Bench Lite tasks (estimate: $10-25 in API costs; varies by model and pricing)
bash scripts/swe-bench.sh

# Full 25-task run (estimate: $100-250; varies by model and pricing)
bash scripts/swe-bench.sh --full
```

See [docs/swe-bench-methodology.md](docs/swe-bench-methodology.md) for task selection, scoring, and limitations.

## MCP Servers

PHI-sanitizing MCP servers for safe AI-assisted queries against healthcare data stores. See [`mcp-servers/`](mcp-servers/) for setup and configuration.

| Server | Data store | PHI protection |
|--------|-----------|----------------|
| `mongodb-sanitizer` | MongoDB | Drops PHI fields, redacts string values, Presidio NLP second pass |
| `snowflake-sanitizer` | Snowflake | Drops PHI columns from SELECT results, read-only enforcement |
| `datadog-sanitizer` | Datadog Logs | Strips names, emails, SSNs, tokens from log output (Python server) |
| `slack-sanitizer` | Slack | Regex + Presidio redaction of emails, phones, SSNs, tokens; read-only |

MongoDB, Snowflake, and Datadog use a shared `phi-config.yaml` to define which columns and tables are PHI — no code changes required to adapt to your data model. Slack applies string-level redaction (no field blocklist, as it is not a PHI database).

The Node.js servers (MongoDB, Slack, Snowflake) share modules in `mcp-servers/shared/`: `sanitizer-core.js`, `phi-config-loader.js`, and `phi-defaults.yaml` (with `phi-config.example.yaml` and `phi-defaults.json` for config scaffolding). These handle PHI config loading and sanitization centrally.

## Roadmap

- **Subagent overflow recovery (claude-loop)** -- When a subagent runs out of turns or context, detect the truncation via a PostToolUse hook on Task, write a state file with remaining work, and have claude-loop inject it as the prompt for a fresh session to finish the job.
- **Multi-agent coordination testing** -- Dogfood test team workflows (TeamCreate, SendMessage, shared task lists) in real coding sessions to validate coordination patterns and discover emergent issues.

## Limitations

- **Claude Code only**: All hooks, skills, and scripts target Claude Code. The principles in `best-practices.md` are conceptually portable to Cursor, Copilot, etc., but the tooling is not.
- **Hook startup overhead**: 35+ hooks are installed, but not all fire on every call — active hooks add ~50-100ms per tool call. Negligible for most workflows, noticeable in rapid-fire operations.
- **CLAUDE.md budget**: The combined profile's CLAUDE.md consumes instruction budget. Projects with large existing CLAUDE.md files may hit the ~150-200 instruction line ceiling.
- **Node.js 20+ required**: Hooks use modern Node.js APIs (ESM-style imports, `fs.promises`, etc.).
- **Single maintainer**: This is a personal project, not backed by a company or large team.

## Contributing

Issues and PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for citation standards, style guide, and local testing instructions.

## License

[MIT](LICENSE)
