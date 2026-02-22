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

**macOS / Linux:**
```bash
git clone https://github.com/john-wilmes/agentic-coding-playbook.git
cd agentic-coding-playbook
chmod +x install.sh
./install.sh
```

**Windows (PowerShell):**
```powershell
git clone https://github.com/john-wilmes/agentic-coding-playbook.git
cd agentic-coding-playbook
.\install.ps1
```

### Install Options

| Flag | Description |
|------|-------------|
| `--profile dev` | Development workflow (default) -- quality gates, code review, testing |
| `--profile research` | Investigation workflow -- structured evidence collection, tagging, PHI sanitization |
| `--wizard` | Interactive merge with your existing configuration |
| `--force` | Overwrite existing files without prompting |
| `--dry-run` | Preview what would be installed |

### What Gets Installed

Dev profile:
```
~/.claude/
  CLAUDE.md                          # Global instruction file
  skills/
    checkpoint/SKILL.md              # /checkpoint - save state and end session
    continue/SKILL.md                  # /continue - pick up where you left off
    playbook/SKILL.md                # /playbook - analyze and improve your config
  templates/
    project-CLAUDE.md                # Template for new project CLAUDE.md files
```

Research (investigation) profile:
```
~/.claude/
  CLAUDE.md                          # Investigation-focused instruction file
  skills/
    investigate/SKILL.md             # /investigate - full investigation lifecycle
    continue/SKILL.md                  # /continue - list open investigations, resume work
  templates/
    investigation/                   # Templates for investigation files
  investigations/                    # Investigation storage (created on first use)
```

The installer **will not overwrite** existing skills or configuration without prompting. Use `--wizard` to analyze your current setup and merge intelligently.

## What You Get

### Skills

- **`/checkpoint`** -- Save all work, update memory with Current Work section, run quality gates, commit, push. Designed for clean session handoffs.
- **`/continue`** -- Read the Current Work section from memory and present what was done, current state, and next steps. Start every session here.
- **`/playbook`** -- Analyze your CLAUDE.md configuration and suggest improvements. Modes: `global` (default), `project`, `cursor`, `check`. Uses LLM understanding to merge sections intelligently rather than simple file replacement.

### CLAUDE.md Rules

The dev profile CLAUDE.md includes:

- **Explore-Plan-Code-Verify-Commit workflow** -- Anthropic's recommended task lifecycle
- **Reasoning standards** -- evidence-based debugging, two-hypothesis minimum, no cargo-culting
- **Model routing** -- use Haiku for exploration, Sonnet for implementation, Opus for planning
- **Testing as feedback loop** -- verify continuously, not just at the end
- **Code review enforcement** -- review staged changes before every commit
- **Security baseline** -- sandbox mode, credential protection, MCP server restrictions
- **Efficiency rules** -- parallel tool calls, no re-reads, two-attempt limit
- **Memory discipline** -- Current Work tracking for session continuity

### Both Tools, One Install

The installer sets up both Claude Code and Cursor configurations:

| Tool | What gets installed | Scope |
|------|-------------------|-------|
| **Claude Code** | `~/.claude/CLAUDE.md`, skills, hooks | Global -- works in every project automatically |
| **Cursor** | Templates in `~/.claude/templates/cursor/` | Per-project -- copy into each project's `.cursor/` |

Claude Code has a global config layer; Cursor does not. See [docs/tool-comparison.md](docs/tool-comparison.md) for the full architectural comparison, including where agents can run, how rules activate, and pricing differences.

### Installation Profiles

| Profile | Focus | Status |
|---------|-------|--------|
| **dev** | Full development workflow with quality gates, code review, testing, security | Available |
| **research** | Structured investigations with evidence collection, tagging, and PHI sanitization | Available |

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
- **[Claude Code vs Cursor](docs/tool-comparison.md)** -- architectural differences, where agents can run, installation scope, pricing
- **[Project CLAUDE.md Template](templates/project-CLAUDE.md)** -- starting point for per-project instructions
- **[Cursor Rules Template](templates/cursor/rules/)** -- `.mdc` rules for Cursor projects

## Contributing

Issues and PRs welcome. If you have evidence-based practices to add (with citations), open a PR against `docs/best-practices.md`.

## License

MIT
