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
cd agentic-coding-playbook
chmod +x install.sh
./install.sh
```

### Prerequisites

- **Node.js 18+** (for hooks and test scripts)
- **git** (for version control and install script)

### Install Options

| Flag | Description |
|------|-------------|
| `--root <path>` | Install root directory (default: `~/Documents`). Config goes to `<root>/.claude/`, projects are siblings |
| `--knowledge-repo <url>` | Git URL for a shared knowledge repository (cloned to `<root>/.claude/knowledge/`) |
| `--wizard` | Interactive merge with your existing configuration |
| `--force` | Overwrite existing files without prompting |
| `--dry-run` | Preview what would be installed |

### What Gets Installed

```
<install-root>/                        # e.g. ~/Documents
  .claude/                             # Playbook configuration
    CLAUDE.md                          #   Combined dev + research workflows
    skills/
      checkpoint/SKILL.md             #   /checkpoint - save state, commit, end session
      continue/SKILL.md               #   /continue - resume work (auto-detects dev vs research)
      create-project/SKILL.md         #   /create-project - scaffold a new project
      investigate/SKILL.md            #   /investigate - full investigation lifecycle
      learn/SKILL.md                  #   /learn - capture knowledge entries
      playbook/SKILL.md              #   /playbook - analyze and improve config
      promote/SKILL.md               #   /promote - promote lessons to global scope
    hooks/                             #   Session start/end hooks, model router
    templates/
      project-CLAUDE.md              #   Template for project-level CLAUDE.md
      hooks/pre-commit               #   Git pre-commit hook (blocks secrets, large files)
      investigation/                 #   Templates for investigation files
      knowledge/                     #   Knowledge entry format
  research/                           # Research/investigation workspace
  project-a/                          # Dev project (created with /create-project)
  project-b/                          # Dev project
```

The installer **will not overwrite** existing skills or configuration without prompting. Use `--wizard` to analyze your current setup and merge intelligently.

## What You Get

### Skills

**Development:**
- **`/checkpoint`** -- Save all work, update memory with Current Work section, run quality gates, commit, push. Designed for clean session handoffs.
- **`/continue`** -- Read the Current Work section from memory and present what was done, current state, and next steps. Start every session here.
- **`/create-project`** -- Scaffold a new project with git, .gitignore, CLAUDE.md, AGENTS.md, GitHub repo. Projects are created as siblings to `.claude/`.
- **`/playbook`** -- Analyze your CLAUDE.md configuration and suggest improvements. Modes: `global`, `project`, `check`.
- **`/learn`** -- Capture a non-obvious lesson as a structured knowledge entry for future sessions.
- **`/promote`** -- Promote a project-level lesson to global scope.
**Research:**
- **`/investigate`** -- Full investigation lifecycle with multi-agent evidence collection, synthesis, tagging, and PHI sanitization. Subcommands: `new`, `run`, `collect`, `synthesize`, `close`, `status`, `list`, `search`.
- **`/continue`** -- Lists open investigations and resumes work. Same skill as above — auto-detects context.

### Hooks

- **Session start** -- Injects memory, knowledge entries, and git context. Warns when MEMORY.md or CLAUDE.md exceed size thresholds.
- **Model router** -- Auto-selects Haiku/Sonnet/Opus for Task tool calls based on prompt signals.
- **Prompt injection guard** -- Blocks high-confidence injection patterns in Bash commands (zero false positives by design).
- **Post-tool verify** -- Auto-runs project tests after Edit/Write on code files with debouncing.

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

The playbook ships with three profile variants in `profiles/`:

| Profile | CLAUDE.md Focus | Skills | Use Case |
|---------|----------------|--------|----------|
| `combined` | Dual workflow (dev + research) | checkpoint, continue, create-project, investigate, learn, playbook, promote | Default install — covers both development and investigation workflows |
| `dev` | Development workflow only | checkpoint, continue, create-project, learn, playbook, promote | Lighter config for pure development work |
| `research` | Investigation workflow only | continue, investigate | Structured investigations with evidence discipline and PII/PHI sanitization |

The install script uses the `combined` profile by default. Each profile includes its own `CLAUDE.md`, `skills/`, and (for research) evaluation templates and sanitization scripts.

## Benchmarks

The playbook includes a SWE-Bench benchmarking script that compares Claude Code's performance on real-world bug fixes with and without the playbook installed.

```bash
# Validate setup (no API calls)
bash scripts/swe-bench.sh --dry-run

# Run 5 SWE-Bench Lite tasks (~$10-25 in API costs)
bash scripts/swe-bench.sh

# Full 25-task run (~$100-250)
bash scripts/swe-bench.sh --full
```

See [docs/swe-bench-methodology.md](docs/swe-bench-methodology.md) for task selection, scoring, and limitations.

## Contributing

Issues and PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for citation standards, style guide, and local testing instructions.

## License

MIT
