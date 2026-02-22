# Claude Code vs Cursor: Architecture and Installation Differences

## Configuration Scope

| Aspect | Claude Code | Cursor |
|--------|------------|--------|
| **Global config** | `~/.claude/CLAUDE.md` -- loads on every message in every project | None -- all config is per-project |
| **Project config** | `CLAUDE.md` in project root | `.cursor/rules/*.mdc` files, or legacy `.cursorrules` |
| **Custom commands** | `~/.claude/skills/<name>/SKILL.md` (global) or `.claude/skills/` (project) | `.cursor/commands/<name>.md` (project only) |
| **Hooks** | `~/.claude/settings.json` hooks (global) or `.claude/settings.json` (project) | Limited lifecycle hooks |
| **Memory** | `~/.claude/projects/<path>/memory/MEMORY.md` (auto-loaded per project) | `.cursor/memory/` or Memory Bank pattern (manual) |

### Key difference: global vs project scope

Claude Code has a **global layer** (`~/.claude/`) that applies to all projects automatically. Rules, skills, and hooks defined there work everywhere without per-project setup. This is the primary install target.

Cursor has **no global equivalent**. All configuration lives in the project directory (`.cursor/`). Every new project needs its own copy of the rules. This is why the playbook installs Cursor files as *templates* -- you copy them into each project.

## Agent Execution Model

| Capability | Claude Code | Cursor |
|------------|------------|--------|
| **Where agents run** | Terminal (CLI) -- any directory, any project, including top-level orchestration outside any project | IDE-embedded -- always within a project context |
| **Top-level orchestration** | Yes -- run Claude Code from `~/Documents` to manage multiple projects, scaffold new repos, coordinate cross-project work | No -- agents are scoped to the open workspace |
| **Subagents** | Built-in (`Task` tool) with model selection (Haiku/Sonnet/Opus), isolation modes (worktree), and custom definitions (`.claude/agents/`) | Background agents (beta) -- can work on branches and open PRs, but less configurable |
| **Multi-agent teams** | Agent Teams with shared task lists, inter-agent messaging, role-based coordination | Not supported natively |
| **Cross-session awareness** | Possible via MCP servers (e.g., agent-comm) or shared state files | Not supported |
| **Headless / CI** | `claude -p "prompt"` for non-interactive use in CI/CD pipelines | Background agents can run asynchronously |
| **MCP servers** | Global (`~/.claude/settings.json`) and per-project (`.claude.json`) | Per-project only |

### Key difference: top-level agent orchestration

Claude Code can run **outside any project** as a meta-agent. From `~/Documents`, you can:
- Scaffold new projects (`/create-project`)
- Manage global configuration (CLAUDE.md, skills, hooks)
- Send messages across active sessions (via agent-comm MCP)
- Coordinate multi-project workflows
- Run the `/playbook` configuration skill

Cursor agents are always **scoped to the open workspace**. There is no equivalent of a "Documents session" that operates above individual projects.

This architectural difference means:
- **Claude Code** is better for infrastructure management, multi-project orchestration, and CI/CD integration
- **Cursor** is better for in-IDE workflows where you want AI assistance alongside your editor, with features like inline diff review and codebase indexing

## Installation Targets

### What the playbook installer does

```
~/.claude/                          # Claude Code global config
  CLAUDE.md                         # <- installed directly (global)
  skills/
    checkpoint/SKILL.md             # <- installed directly (global)
    resume/SKILL.md                 # <- installed directly (global)
    playbook/SKILL.md               # <- installed directly (global)
  templates/
    project-CLAUDE.md               # <- template (copy to new projects)
    cursor/
      rules/standards.mdc           # <- template (copy to .cursor/rules/)
      rules/quality.mdc             # <- template (copy to .cursor/rules/)
      commands/checkpoint.md         # <- template (copy to .cursor/commands/)
```

### Claude Code: nothing else needed

After installation, Claude Code picks up the global CLAUDE.md and skills automatically in every project. No per-project setup required (though you should still create a project-level CLAUDE.md for project-specific rules).

### Cursor: copy templates into each project

```bash
# For each new project:
cp -r ~/.claude/templates/cursor/rules/ .cursor/rules/
cp -r ~/.claude/templates/cursor/commands/ .cursor/commands/
```

The `/playbook` skill can automate this when setting up a new project.

## Rule Activation

| Feature | Claude Code | Cursor |
|---------|------------|--------|
| **Always-on rules** | Everything in CLAUDE.md | `alwaysApply: true` in `.mdc` frontmatter |
| **File-pattern rules** | Not supported natively (use project CLAUDE.md or skills) | `globs: "*.tsx"` in `.mdc` frontmatter -- rules activate only for matching files |
| **On-demand rules** | Skills (`/checkpoint`, `/continue`) -- loaded only when invoked | Commands (`.cursor/commands/`) -- loaded on invocation |
| **Conditional loading** | Skills + hooks (deterministic triggers on events) | Agent-requested rules (`description` field, `alwaysApply: false`) |

### Key difference: Cursor's glob-based activation

Cursor rules can activate based on file patterns:

```yaml
---
description: React component conventions
globs: "src/components/**/*.tsx"
alwaysApply: false
---
```

This rule only loads when the agent is working with matching files, reducing token overhead. Claude Code has no equivalent -- all CLAUDE.md content loads on every message. Claude Code compensates with skills (on-demand loading) and the instruction file token budget discipline.

## Pricing Model

| Tool | Model | Cost basis |
|------|-------|------------|
| Claude Code | Pay-per-token (API) | Input + output tokens per message |
| Claude Code Max | Subscription ($100-200/mo) | Flat monthly fee, virtually unlimited |
| Cursor | Subscription ($20-200/mo) | Request credits that abstract token cost |

For pay-per-token users, every efficiency practice (fresh sessions, model routing, lean instruction files) directly reduces the bill. For subscription users, the same practices reduce latency and improve quality even though the dollar cost is fixed.

## Recommendation

Use both tools for what they do best:

- **Claude Code** for: project scaffolding, global configuration, multi-project orchestration, CI/CD integration, headless automation, multi-agent coordination
- **Cursor** for: in-IDE development, inline diff review, codebase-aware completions, visual debugging

The playbook installs both configurations. You do not need to choose.
