[![Test Install Script](https://github.com/john-wilmes/claude-agentic-coding-playbook/actions/workflows/test-install.yml/badge.svg)](https://github.com/john-wilmes/claude-agentic-coding-playbook/actions/workflows/test-install.yml)

# Agentic Coding Playbook

Evidence-based practices for LLM-assisted software development. Optimized for [Claude Code](https://claude.com/claude-code) with cross-tool principles that apply to Cursor, Copilot, and other AI coding tools.

## Why This Exists

AI-assisted code contains 1.7x more issues than human-written code and introduces 10x more security findings in enterprise settings. Developer productivity gains range from -19% to +55% depending on how you measure and who is coding. The practices in this playbook are designed to capture the upside while mitigating the documented risks.

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

## Quick Install

```bash
git clone https://github.com/john-wilmes/claude-agentic-coding-playbook.git
cd claude-agentic-coding-playbook
chmod +x install.sh
./install.sh
```

### Prerequisites

- **Bash on Linux or macOS** (Windows requires [WSL](https://learn.microsoft.com/en-us/windows/wsl/install) — native CMD/PowerShell is not supported. The install script, hooks, and test suite all assume a POSIX environment.)
- **Node.js 18+** (for hooks and test scripts)
- **git** (for version control and install script)

### Install Options

| Flag | Description |
|------|-------------|
| `--root <path>` | Controls where `research/` is created (default: `~/Documents`). Config always goes to `~/.claude/` |
| `--knowledge-repo <url>` | Git URL for a shared knowledge repository (cloned to `<root>/.claude/knowledge/`) |
| `--wizard` | Interactive merge with your existing configuration |
| `--force` | Overwrite existing files without prompting |
| `--dry-run` | Preview what would be installed |

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
  hooks/                               #   19 hooks — safety, quality, resource management (see docs/hooks.md)
  templates/
    project-CLAUDE.md                 #   Template for project-level CLAUDE.md
    hooks/pre-commit                  #   Git pre-commit hook (blocks secrets, large files)
    knowledge/                        #   Knowledge entry format

<install-root>/                        # e.g. ~/Documents (set with --root)
  research/                            # Research/investigation workspace
  project-a/                           # Dev project (created with /create-project)
  project-b/                           # Dev project
```

The installer **will not overwrite** existing skills or configuration without prompting. Use `--wizard` to analyze your current setup and merge intelligently.

## What You Get

### Skills

**Development:**
- **`/checkpoint`** -- Save all work, update memory with Current Work section, commit, push. Designed for clean session handoffs.
- **`/create-project`** -- Scaffold a new project with git, .gitignore, CLAUDE.md, AGENTS.md, GitHub repo. Projects are created as siblings to `.claude/`.
- **`/playbook`** -- Analyze your CLAUDE.md configuration and suggest improvements. Modes: `global`, `project`, `check`.
- **`/learn`** -- Capture a non-obvious lesson as a structured knowledge entry for future sessions.
- **`/promote`** -- Promote a project-level lesson to global scope.
**Research:**
- **`/investigate`** -- Full investigation lifecycle with multi-agent evidence collection, synthesis, tagging, and PHI sanitization. Subcommands: `new`, `run`, `collect`, `synthesize`, `close`, `status`, `list`, `search`.

### Hooks

CLAUDE.md rules are advisory (~50-90% compliance). Hooks are deterministic (>95%) — they run scripts at specific points in the agent's workflow, guaranteeing enforcement. See [Hook Reference](docs/hooks.md) for the full guide including configuration, customization, and the "why hooks" philosophy.

**Session lifecycle:**
- **Session start** -- Injects memory, knowledge entries, and git context. Warns when MEMORY.md or CLAUDE.md exceed size thresholds.
- **Session end** -- Captures session summary and updates knowledge database on exit.
- **Pre-compact** -- Saves context state before `/compact` runs, preserving critical information.

**Safety:**
- **Prompt injection guard** -- Blocks high-confidence injection patterns in Bash commands (zero false positives by design).
- **Sanitize guard** -- Runtime PII/PHI detection and redaction. Scans tool output (PostToolUse) and blocks writes containing PII (PreToolUse). Opt-in per repo via `.claude/sanitize.yaml`.
- **Skill guard** -- Validates skill invocations and prevents unauthorized skill execution.

**Quality:**
- **Post-tool verify** -- Auto-runs project tests after Edit/Write on code files with debouncing.
- **PR review guard** -- Enforces code review before pushing. Blocks `git push` if changes haven't been reviewed.
- **Context guard** -- Dual-mode context window monitoring. Warns at 35%/50%, blocks at 60%, failsafe sentinel at 75%.
- **Stuck detector** -- Detects and breaks agent loops when the same action repeats.

**Resource management:**
- **Model router** -- Auto-selects Haiku/Sonnet/Opus for Task tool calls based on prompt signals.
- **Filesize guard** -- Warns when reading or writing large files that waste context.
- **Bloat guard** -- Detects runaway file creation and flags unexpected project growth.
- **Markdown size guard** -- Warns when CLAUDE.md or MEMORY.md approach size thresholds.

**Knowledge:**
- **Knowledge capture** -- Extracts reusable lessons from session activity for the knowledge database.
- **Knowledge database** -- Retrieves relevant knowledge entries via BM25 search at session start.

Utility modules (`log.js`, `bm25.js`, `pii-detector.js`) are shared libraries used by the hooks above. See [Hook Reference](docs/hooks.md) for details on every hook.

### CLAUDE.md Rules

The combined CLAUDE.md includes:

- **Dual workflow** -- Development (Explore-Plan-Code-Verify-Commit) and Research (Question-Collect-Synthesize-Close), auto-selected by working directory
- **Reasoning standards** -- evidence-based debugging, two-hypothesis minimum, no cargo-culting
- **Model routing** -- use Haiku for exploration, Sonnet for implementation, Opus for planning
- **Testing as feedback loop** -- verify continuously, not just at the end
- **Code review enforcement** -- review staged changes before every commit
- **Evidence discipline** -- numbered observations with source, relevance, and 3-line max
- **PII/PHI protection** -- Presidio-based auto-sanitization for investigation files
- **Security baseline** -- sandbox mode, credential protection, MCP server restrictions
- **Efficiency rules** -- parallel tool calls, no re-reads, two-attempt limit
- **Memory discipline** -- Current Work tracking for session continuity

## Testing

Run the full test suite:

```bash
# Hook tests (Node.js)
for t in tests/hooks/*.test.js; do node "$t" || exit 1; done

# Script tests (Bash)
for t in tests/scripts/*.test.sh; do bash "$t" || exit 1; done

# Skills tests
for t in tests/skills/*.test.sh; do bash "$t" || exit 1; done && for t in tests/skills/*.test.js; do node "$t" || exit 1; done

# Fleet tests (Node.js)
for t in tests/fleet/*.test.js; do node "$t" || exit 1; done

# Investigation tests (Node.js)
for t in tests/investigate/*.test.js; do node "$t" || exit 1; done

# Or all at once
for t in tests/hooks/*.test.js; do node "$t" || exit 1; done && for t in tests/fleet/*.test.js; do node "$t" || exit 1; done && for t in tests/scripts/*.test.sh; do bash "$t" || exit 1; done && for t in tests/skills/*.test.sh; do bash "$t" || exit 1; done && for t in tests/skills/*.test.js; do node "$t" || exit 1; done && for t in tests/investigate/*.test.js; do node "$t" || exit 1; done
```

## CLI Scripts

Standalone tools installed to `~/.local/bin/`:

| Script | Description |
|--------|-------------|
| `q` | Lightweight CLI for direct Anthropic API Q&A. Uses Haiku by default for fast, cheap answers. |
| `qa` | File-capable agentic CLI using the Anthropic API with tool use (bash + text editor). No hooks or MCP. |
| `claude-loop` | Auto-restart wrapper for Claude Code sessions. Supports `--task-queue` for batch execution. |

## Log Analysis

Hooks log decisions to `~/.claude/logs/YYYY-MM-DD.jsonl`. Analyze with:

```bash
# Full report
node scripts/analyze-logs.js

# Filter by date range
node scripts/analyze-logs.js --since 2026-03-01

# Filter by session or hook
node scripts/analyze-logs.js --session abc123 --hook context-guard
```

Output includes context-guard progression per session, stuck-detector triggers, model-router distribution, and prompt-injection blocks.

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

- **[Best Practices Guide](docs/best-practices.md)** -- the full evidence-backed guide with 34 verified citations
- **[Project CLAUDE.md Template](templates/project-CLAUDE.md)** -- starting point for per-project instructions
- **[Dogfooding Guide](docs/dogfooding.md)** -- how to design and run a sustained dogfood campaign against real codebases, with a 100-task worked example
- **[Dogfood Playbook](docs/dogfood-playbook.md)** -- manual interactive testing checklist for verifying the full user experience

### Case Studies

- **[Agent Failure Analysis](docs/case-study-agent-failure.md)** -- detailed post-mortem of a production agent failure with root cause analysis
- **[Agent Failure Transcript](docs/transcript-2026-02-24-agent-failure.md)** -- raw session transcript from the failure event

### Architecture

The playbook uses a single `combined` profile in `profiles/combined/` that covers both development and research workflows. The install script copies its `CLAUDE.md` and `skills/` to `~/.claude/`.

## Benchmarks

The playbook includes a SWE-Bench benchmarking script that compares Claude Code's performance on real-world bug fixes with and without the playbook installed.

```bash
# Validate setup (no API calls)
bash scripts/swe-bench.sh --dry-run

# Run 5 SWE-Bench Lite tasks (estimate: $10-25 in API costs)
bash scripts/swe-bench.sh

# Full 25-task run (estimate: $100-250)
bash scripts/swe-bench.sh --full
```

See [docs/swe-bench-methodology.md](docs/swe-bench-methodology.md) for task selection, scoring, and limitations.

## Roadmap

- **Subagent overflow recovery (claude-loop)** -- When a subagent runs out of turns or context, detect the truncation via a PostToolUse hook on Task, write a state file with remaining work, and have claude-loop inject it as the prompt for a fresh session to finish the job.
- **Multi-agent coordination testing** -- Dogfood test team workflows (TeamCreate, SendMessage, shared task lists) in real coding sessions to validate coordination patterns and discover emergent issues.

## Contributing

Issues and PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for citation standards, style guide, and local testing instructions.

## License

Apache 2.0
