# Agentic Coding Playbook: Evidence-Based Practices for LLM-Assisted Development

## TL;DR

LLM-assisted coding delivers real productivity gains -- but only when teams manage
its well-documented failure modes. The evidence:

- **Quality gap**: AI code contains 1.7x more issues than human code; enterprise
  teams see 10x more security findings with AI-assisted development [CodeRabbit,
  Apiiro].
- **Prompt injection**: Succeeds 94% of the time against lightweight commercial
  models in controlled medical LLM studies (n=216); all 12 published defenses
  bypassed at 90%+ under adaptive attacks [PMC, "The Attacker Moves Second"].
- **Context economics**: Fresh sessions cost ~10x less per message than exhausted
  ones (5K vs 50K tokens) [Anthropic].
- **Model routing**: Using Haiku for exploration vs Opus for planning reduces
  per-operation costs 5-20x [Anthropic pricing].
- **Prompt caching**: Reduces instruction overhead by 90% on cache hits
  [Anthropic].
- **Code review**: AI review catches 44-82% of defects depending on tool; reduces
  PR completion time 10-20% at scale [Greptile, Macroscope, Microsoft].
- **Productivity**: Developer gains range from -19% to +55% depending on
  experience level and measurement method [METR, GitHub Copilot, Faros AI].
- **Instruction ceiling**: LLMs follow ~150-200 instructions reliably; Claude
  Code's system prompt uses ~50 of that budget [HumanLayer].
- **Flow state**: 73% of developers report flow state with AI tools; 87% preserve
  mental effort on repetitive tasks [GitHub].
- **Review discipline**: Teams with AI code review see quality improvements 81% of
  the time vs 55% among fast-shipping teams without [Qodo].

The practices in this document are derived from peer-reviewed research, large-scale
industry data, and official vendor documentation. Every statistic includes its
source; every recommendation is grounded in evidence.

---

## Table of Contents

1. [Core Economics](#1-core-economics)
2. [The Workflow: Explore, Plan, Code, Verify, Commit](#2-the-workflow-explore-plan-code-verify-commit)
3. [Reasoning Standards](#3-reasoning-standards)
4. [Efficiency and Cost Optimization](#4-efficiency-and-cost-optimization)
5. [Context and Session Management](#5-context-and-session-management)
6. [Memory and Persistence](#6-memory-and-persistence)
7. [Instruction File Design](#7-instruction-file-design)
8. [Testing and Verification](#8-testing-and-verification)
9. [Code Review Automation](#9-code-review-automation)
10. [Security and Trust Boundaries](#10-security-and-trust-boundaries)
11. [Multi-Agent Coordination](#11-multi-agent-coordination)
12. [Getting Started](#12-getting-started)
13. [Citations](#citations)

---

## 1. Core Economics

### The mental model

Think of instruction files as **code that runs every turn** and context as **RAM
rented per-millisecond**. Every token in your system prompt, CLAUDE.md, and
conversation history is re-sent with every API call. A 50K-token session costs 50K
input tokens per message; a fresh session with good memory files starts at ~5K
[Anthropic].

This has two consequences:

1. **Instruction files have compounding cost.** A 15-token rule costs 15 tokens
   per message, every message, every session. Over a 30-message session, that is
   450 tokens. The rule pays for itself if it prevents even one 450-token retry
   loop.

2. **Long sessions grow quadratically in cost.** As context grows, every message
   costs more, and the model's performance degrades simultaneously. You pay more
   for worse output.

### Pricing table (Claude models, per million tokens)

| Model | Input | Output | Cache Hit (0.1x) |
|---|---|---|---|
| Opus 4.6 / 4.5 | $5 | $25 | $0.50 |
| Sonnet 4.6 / 4.5 / 4 | $3 | $15 | $0.30 |
| Haiku 4.5 | $1 | $5 | $0.10 |
| Haiku 3 | $0.25 | $1.25 | $0.03 |

Source: Anthropic Prompt Caching documentation [4].

### Why long sessions grow quadratically in cost

Each turn in a conversation sends the full conversation history. Turn 1 sends the
system prompt (~5K tokens). Turn 10 sends the system prompt plus 9 turns of
accumulated context. Turn 30 may send 50K+ tokens. The cost per message at turn 30
is 10x the cost at turn 1. Since per-message cost grows linearly with turn
number, total session cost grows quadratically -- and the model simultaneously
becomes more likely to "forget" earlier instructions or make mistakes because
the context window is saturated [Anthropic Best Practices, 1].

### Break-even math for instruction file rules

A rule that occupies N tokens costs `N * messages_per_session` tokens per session.
A rule that prevents one failure (which typically costs 300-3,000 tokens in retry
loops, re-reads, and corrections) pays for itself if:

```
N * messages_per_session < cost_of_one_prevented_failure
```

For a 30-message session:

| Rule size | Session cost | Breaks even if it prevents... |
|---|---|---|
| 15 tokens | 450 tokens | One minor retry (450+ tokens) |
| 50 tokens | 1,500 tokens | One moderate correction loop |
| 150 tokens | 4,500 tokens | One significant debugging spiral |

Rules that prevent re-reads, retry loops, or wasted tool calls have the highest
ROI. Rules that state obvious conventions the model already follows waste budget.

---

## 2. The Workflow: Explore, Plan, Code, Verify, Commit

Anthropic's officially recommended workflow separates research from execution to
avoid solving the wrong problem [1]. This five-phase pattern is the foundation of
effective agentic coding.

### Phase 1: Explore

Use Plan Mode or subagents to read files and understand the codebase without
making changes. Subagents run in separate context windows and return summaries,
keeping exploration output out of your main conversation [3].

```
# In Plan Mode
Read /src/auth and understand how we handle sessions and login.
Also look at how we manage environment variables for secrets.
```

Scope investigations narrowly. Unbounded exploration reads hundreds of files and
fills the context window. If the research is extensive, delegate to a subagent
running Haiku for cost efficiency -- Haiku costs 5-20x less than Opus per token
[4].

### Phase 2: Plan

Ask the agent to create a detailed implementation plan before writing code. Press
`Ctrl+G` to open the plan in your text editor for direct editing.

```
# In Plan Mode
I want to add Google OAuth. What files need to change?
What's the session flow? Create a plan.
```

**Skip planning for trivial changes.** If you could describe the diff in one
sentence (fixing a typo, adding a log line, renaming a variable), ask the agent to
do it directly. Planning adds overhead that is only justified when the approach is
uncertain, the change spans multiple files, or you are unfamiliar with the code
being modified [1].

### Phase 3: Code

Switch to Normal Mode and let the agent implement the plan. Batch edits -- fewer
larger changes rather than many small ones. The agent should follow the plan, not
invent new approaches.

```
# In Normal Mode
Implement the OAuth flow from your plan. Write tests for the
callback handler, run the test suite, and fix any failures.
```

### Phase 4: Verify

> "Give Claude a way to verify its work" is "the single highest-leverage thing you
> can do." -- Anthropic Best Practices [1]

Verification is a **continuous feedback loop**, not a terminal gate. The agent
should run tests, compare screenshots, and validate outputs throughout
implementation -- not just at the end.

| Strategy | Before | After |
|---|---|---|
| Provide verification criteria | "implement email validation" | "write validateEmail. Test cases: user@example.com -> true, invalid -> false. Run tests after." |
| Verify UI visually | "make the dashboard look better" | "[paste screenshot] implement this design. Take a screenshot and compare." |
| Address root causes | "the build is failing" | "the build fails with [error]. Fix it and verify. Address root cause, don't suppress." |

Without clear success criteria, the agent produces output that looks right but does
not work. You become the only feedback loop, and every mistake requires your
attention.

### Phase 5: Commit

Update memory files with any non-obvious discoveries, commit with a descriptive
message, and push.

### The Writer/Reviewer Pattern

A fresh session reviews code without bias toward the code it just wrote. Use two
sessions:

| Session A (Writer) | Session B (Reviewer) |
|---|---|
| Implement the feature | Review the implementation for edge cases, race conditions, consistency |
| Address review feedback | (optional) Second review pass |

This pattern exploits the fact that a fresh context avoids the sunk-cost bias that
develops during implementation. The reviewer session has clean context focused
entirely on finding problems [1].

---

## 3. Reasoning Standards

### Evidence-based debugging

Before modifying code or making claims about it, read the code. Cite specific
files and lines when referencing behavior. When debugging:

1. **State your hypothesis and the evidence.** "Based on the error at
   `auth.ts:134`, the token refresh is failing because the expiry check uses `<`
   instead of `<=`."
2. **Check at least two possible causes** before committing to a fix.
3. **Explain why a fix works**, not just that it works. If you cannot explain the
   mechanism, the fix is suspect.
4. **Distinguish verified facts from inferences.** "Confirmed at `auth.ts:134`"
   vs "based on the pattern, likely..."

### Model-specific failure modes

Different models fail in predictable ways. Knowing these patterns helps you
anticipate and mitigate errors:

| Model Family | Primary Failure Mode | Mitigation |
|---|---|---|
| Claude | Verbose output, over-explains, may add unrequested features | Use imperative instructions: "Do X. Do not do Y." |
| GPT | Hallucinates APIs, invents function signatures that do not exist | Require verification against actual docs/code before using any API |
| Gemini | Loses detail in long context, drops instructions mid-conversation | Keep prompts focused; use shorter sessions; repeat critical instructions |

These are tendencies, not guarantees. All models improve with each generation, and
specific failure modes shift. Treat this table as a starting heuristic, not a
permanent truth.

### The "no cargo-cult" rule

Do not copy solutions from other projects without verifying they apply to the
current codebase. LLMs are particularly prone to cargo-culting because they
generate plausible patterns from training data that may not match your specific
architecture, framework version, or configuration.

When the agent proposes a pattern, ask:

- Does this pattern exist elsewhere in this codebase?
- Does the dependency/API version match what we are using?
- Is the suggested approach consistent with our existing architecture?

When something fails unexpectedly, investigate root cause before retrying or
working around it. Blind retries compound context waste and often mask the real
problem.

---

## 4. Efficiency and Cost Optimization

### Parallel tool calls

When multiple independent pieces of information are needed, make all calls in the
same turn. Do not sequentially read five files when you can read them all at once.
This reduces round trips and avoids unnecessary context accumulation.

### No re-reads, no output echo, no preamble

- Do not re-read files already in context. Track what has been read this session.
- Do not echo tool output or restate what the user can already see.
- Do not use preamble phrases ("Let me...", "I'll now..."). Start with the
  action.

These practices eliminate 200-500 tokens of waste per turn. Over a 30-turn
session, that is 6,000-15,000 tokens saved.

### Two-attempt limit

After two failed attempts at the same approach, switch strategies or ask for
clarification. Retry spirals consume 3,000-10,000 tokens while making no
progress. The agent's context fills with failed approaches, degrading performance
on subsequent attempts.

### Model routing

Route tasks to the cheapest model that can handle them:

| Task Type | Recommended Model | Relative Cost |
|---|---|---|
| File search, codebase exploration | Haiku | 1x |
| Code implementation, refactoring | Sonnet | 3x |
| Architecture planning, complex debugging | Opus | 5x |
| Simple text transforms, status checks | Haiku 3 | 0.25x |

The Explore subagent in Claude Code already routes to Haiku by default for read-
only codebase exploration [3]. For custom subagents, set the `model` field in the
frontmatter:

```yaml
---
name: security-reviewer
model: opus
---
```

A codebase exploration task that costs $0.05 with Opus costs $0.01 with Haiku --
a 5x savings per operation. Across hundreds of exploration calls per day, this
compounds significantly [4, 27].

### Prompt caching mechanics and economics

Prompt caching stores the KV cache representation of your prompt prefix. On
subsequent requests with the same prefix, cached content is reused at 10% of the
base input price [4].

| Component | Base Cost | Cache Write (1.25x) | Cache Hit (0.1x) |
|---|---|---|---|
| Opus 4.6 input | $5/MTok | $6.25/MTok | $0.50/MTok |
| Sonnet 4.6 input | $3/MTok | $3.75/MTok | $0.30/MTok |
| Haiku 4.5 input | $1/MTok | $1.25/MTok | $0.10/MTok |

Cache hits reduce the cost of system prompts, tool definitions, and conversation
history by 90%. The cache has a 5-minute default TTL, refreshed on each use. A
1-hour TTL is available at 2x the base input price [4].

For multi-turn conversations, automatic caching moves the cache breakpoint forward
with each turn. Previous conversation content is read from cache; only new content
is written.

### Cost-benefit summary by practice

| Practice | Token savings per occurrence | Frequency | ROI |
|---|---|---|---|
| Parallel tool calls | 500-2,000 | Every multi-read turn | High |
| No preamble/echo | 200-500 | Every turn | High |
| Two-attempt limit | 3,000-10,000 | Per retry spiral avoided | Very high |
| Model routing (Haiku vs Opus) | 80-95% cost reduction | Per exploration task | Very high |
| Prompt caching | 90% on cached prefix | Every turn after first | Very high |
| Fresh sessions at breakpoints | 45K tokens saved per message | Per exhausted session | Critical |

---

## 5. Context and Session Management

### Fresh session advantage

A fresh session re-runs hooks, loads CLAUDE.md files, and starts with clean
context. At ~5K tokens per message versus ~50K in an exhausted session, a fresh
session is 10x cheaper per message and produces higher quality output because the
model is not distracted by accumulated irrelevant context [1, 27].

Start fresh sessions at natural breakpoints:
- Between unrelated tasks (use `/clear`)
- After completing a feature
- When context reaches ~70% (check with `/context`)
- After two or more failed correction attempts on the same issue

Before clearing context, record current state and next steps in memory files so the
new session picks up cleanly.

### /compact with custom focus instructions

When auto-compaction triggers (at approximately 95% context capacity), the agent
summarizes what matters most -- code patterns, file states, key decisions. For
more control:

```
/compact Focus on the API changes and the list of modified files
```

Customize compaction behavior in CLAUDE.md:
```markdown
When compacting, always preserve the full list of modified files
and any test commands.
```

### /rewind and double-Escape for rollback

Every action creates a checkpoint. Double-tap `Escape` or run `/rewind` to open
the rewind menu:

- Restore conversation only
- Restore code only
- Restore both
- Summarize from a selected message (compacts from that point forward)

Checkpoints persist across sessions. You can close your terminal and still rewind
later. This enables a "try and revert" workflow -- tell the agent to attempt
something risky, and rewind if it does not work [1].

### Session naming and resumption

```bash
claude --continue       # Resume most recent conversation
claude --resume         # Select from recent conversations
```

Use `/rename` to give sessions descriptive names: `oauth-migration`,
`debugging-memory-leak`. Treat sessions like branches -- different workstreams get
separate persistent contexts [1].

### Subagents for exploration

Since context is the fundamental constraint, subagents are among the most powerful
tools available. They run in separate context windows and report back summaries:

```
Use subagents to investigate how our authentication system handles
token refresh, and whether we have any existing OAuth utilities.
```

The subagent explores the codebase, reads files, and reports findings without
cluttering the main conversation. The built-in Explore subagent uses Haiku for
fast, low-cost read-only exploration [3].

### Image and large file handling

- Never read multiple image files in the same turn -- use a subagent for bulk
  image examination.
- For single images, run `/compact` first to minimize context before adding image
  data.
- Never commit files over 5MB to git. Host large files externally and reference
  by URL.

---

## 6. Memory and Persistence

### Memory is an index, not a journal

Memory files exist to give fresh sessions the context they need to continue work
effectively. They are not activity logs or session transcripts.

**Patterns, not episodes.** Record:
- Architectural decisions and their rationale
- Non-obvious bugs, root causes, and fixes
- Workarounds for tool limitations
- Environment-specific quirks

Do not record:
- Step-by-step session narratives
- Timestamps of individual actions
- Information the agent can infer from code

### Recommended memory file structure

```markdown
# Project Memory

## Architecture Decisions
- [Decision]: [Rationale]. See [file:line].

## Lessons Learned
- [Bug/Issue]: [Root cause]. [Fix/Workaround].

## Current Work
- [Feature/Task]: [Current state]. [Next steps].

## Environment
- [Quirk]: [Details].
```

### Current Work section for session continuity

Before ending a session, update the Current Work section:

```markdown
## Current Work
- OAuth migration: Routes implemented, callback handler tested.
  Next: wire up token refresh and add session persistence.
  Blocked: need GOOGLE_CLIENT_ID env var from ops team.
```

A new session reading this file knows exactly where to start, what is done, and
what is blocked.

### Lessons Learned for institutional knowledge

When a non-obvious bug is resolved or a workaround is discovered, record it:

```markdown
## Lessons Learned
- Amplify client returns AWSJSON as strings, needs JSON.parse.
  Discovered when auth tokens were being compared as string literals.
- PM2 process list can be empty after reboot even with
  pm2-windows-startup; use `pm2 start <path> && pm2 save`
  to re-register.
```

These entries save future sessions from re-discovering the same issues. Over time,
this section becomes the most valuable part of the memory file.

### Tool-specific implementations

| Tool | Memory Location | Scope |
|---|---|---|
| Claude Code | `MEMORY.md`, `CLAUDE.md` | Per-project or global (`~/.claude/`) |
| Claude Code Subagents | `.claude/agent-memory/<name>/` | Per-agent, with `user`, `project`, or `local` scope [3] |
| Cursor | `.cursor/memory/`, `.cursor/rules/*.mdc` | Per-project with glob-based activation |

---

## 7. Instruction File Design

### The instruction ceiling

Frontier thinking LLMs can follow approximately 150-200 instructions with
reasonable consistency. Smaller models handle significantly fewer. Performance
degrades uniformly across all instructions as count increases -- larger models show
linear decay, while smaller models show exponential decay [5].

Claude Code's system prompt already consumes approximately 50 of those 150-200
instructions. That leaves roughly 100-150 instructions for your CLAUDE.md, skills,
hooks, and user messages before reliability drops [5].

### Token budget guideline

Keep your root CLAUDE.md under 150 lines (~1,200 tokens). This file loads on
every message in every session. Each line has a compounding per-message cost.

HumanLayer's own root CLAUDE.md is under 60 lines. Their recommendation: "Less
(instructions) is more" [5].

### ROI formula for rules

A 15-token rule costs `15 * messages_per_session` tokens. In a 30-message session,
that is 450 tokens. The rule breaks even if it prevents one failure that would have
cost 450+ tokens (a single retry loop, a re-read, a correction cycle).

For each line in your instruction file, ask: "Would removing this cause the agent
to make mistakes?" If not, cut it. Bloated instruction files cause the agent to
ignore your actual instructions [1, 5].

### Skills for on-demand knowledge

Skills (`.claude/skills/`) extend the agent's knowledge without bloating the main
instruction file. They are loaded on demand when relevant, or invoked directly
with `/skill-name` [1].

```markdown
# .claude/skills/api-conventions/SKILL.md
---
name: api-conventions
description: REST API design conventions for our services
---
# API Conventions
- Use kebab-case for URL paths
- Use camelCase for JSON properties
- Always include pagination for list endpoints
```

Domain knowledge, framework-specific patterns, and workflows that are only
sometimes relevant belong in skills, not in CLAUDE.md.

### Hooks for deterministic actions

Hooks run scripts automatically at specific points in the agent's workflow. Unlike
instruction file rules (which are advisory), hooks are deterministic -- they
guarantee the action happens [1].

Use hooks for:
- Running eslint after every file edit
- Blocking writes to protected directories (e.g., migrations)
- Formatting code on save
- Pre-commit validation

```json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Edit|Write",
      "hooks": [{ "type": "command", "command": "eslint --fix $FILE" }]
    }]
  }
}
```

### Cursor-specific: glob-based rule activation

In Cursor, `.cursor/rules/*.mdc` files use frontmatter glob patterns to activate
rules only for matching files:

```markdown
---
description: React component conventions
globs: ["src/components/**/*.tsx"]
---
# Component Rules
- Use functional components with hooks
- Export named, not default
```

This provides the same on-demand loading benefit as Claude Code's skills system.

### Writing style for instructions

- **Imperative voice, concrete actions.** "Run eslint after edits" not "It would
  be good practice to consider running eslint."
- **Specific over general.** "Use ES modules (import/export), not CommonJS
  (require)" not "Use modern JavaScript patterns."
- **Include the 'why' when non-obvious.** "Commit with --no-ff to preserve merge
  history in git log" not just "Use --no-ff."

### Anti-pattern: auto-generating without curation

Running `/init` generates a starter instruction file by analyzing your codebase.
This is a useful starting point, but auto-generated files are typically over-
specified. They include obvious conventions the model already follows, bloating the
file and consuming instruction budget.

Always curate the output of `/init`. Delete anything the agent would do correctly
without the instruction. HumanLayer's research found that Claude biases toward
prompt peripheries (beginning and end), so critical rules should not be buried in
the middle of a long file [5].

---

## 8. Testing and Verification

### Tests as feedback loop, not terminal gate

Anthropic identifies verification as "the single highest-leverage thing you can do"
[1]. Tests are not a final quality check -- they are the continuous feedback
mechanism that prevents the agent from drifting off course.

The agent should run tests throughout implementation:
- Write a failing test first (when practical)
- Implement the feature
- Run the test to verify
- Fix failures immediately
- Run the broader test suite before committing

### The test pyramid

Write tests at the lowest level that verifies the behavior:

| Level | What it tests | When to use |
|---|---|---|
| Unit | Individual functions, pure logic | Default choice for business logic |
| Integration | Component interactions, API contracts | When behavior depends on component interaction |
| E2E | Full user flows | Critical paths only; expensive to maintain |

### TDD as force multiplier for agents

TDD prevents a specific failure mode unique to AI-assisted development:

> "TDD prevents a failure mode where agents write tests that verify broken
> behavior. When the tests exist before the code, agents cannot cheat by writing a
> test that simply confirms whatever incorrect implementation they produced."
> -- Thoughtworks [30]

When an agent writes both the code and the tests simultaneously, it can produce
tests that validate broken behavior -- creating a false sense of correctness. TDD
eliminates this by establishing the expected behavior before any implementation
exists.

### LLM test generation performance

Meta's TestGen-LLM achieved **73% acceptance rate** for production deployment at
industrial scale across Instagram and Facebook, improving 11.5% of all classes
where it was applied [15]. Key metrics:
- 75% of generated tests compiled successfully
- 57% passed reliably during execution
- 25% achieved measurable coverage increases

LLM-based test generation tools achieve **59.6% code coverage** compared to 38.2%
for traditional evolutionary approaches like EvoSuite -- a 21.4 percentage point
improvement [16]. Up to 85% of generated test cases proved relevant.

### AI code quality: the evidence

The quality gap between AI-generated and human-written code is well-documented:

| Metric | AI vs Human | Source |
|---|---|---|
| Total issues per PR | 1.7x more (10.83 vs 6.45) | CodeRabbit [11] |
| Logic errors | 75% more common | CodeRabbit [11] |
| Security issues | Up to 2.74x higher | CodeRabbit [11] |
| Excessive I/O operations | ~8x more common | CodeRabbit [11] |
| Error handling gaps | ~2x more common | CodeRabbit [11] |
| Readability violations | 3x more common | CodeRabbit [11] |
| Enterprise security findings | 10x increase | Apiiro [23] |
| Privilege escalation paths | 322% increase | Apiiro [23] |
| Architectural design flaws | 153% increase | Apiiro [23] |

Study at ISSRE 2025 across 500K+ code samples confirmed AI-generated code is
"generally simpler and more repetitive" but contains "more high-risk security
vulnerabilities" [32].

Developers who experience low AI hallucination rates (<20%) are 2.5x more likely
to merge code without review [10].

### Browser automation for E2E testing

Use Playwright MCP or Chrome DevTools for visual verification:

```
Take a screenshot of the result and compare it to the original.
List differences and fix them.
```

Claude Code's Chrome integration can open browser tabs, test UI interactions, and
iterate until the code works [1]. This provides a visual feedback loop equivalent
to running unit tests for backend code.

---

## 9. Code Review Automation

### Tool comparison: detection rates

Two independent benchmarks produced different rankings, demonstrating that
methodology determines outcomes:

**Greptile Benchmark** (50 real bugs, 5 languages, July 2025) [12]:

| Tool | Detection Rate | Critical | High | Medium+Low |
|---|---|---|---|---|
| Greptile | 82% | 58% | 100% | 88% |
| Cursor | 58% | 58% | 64% | 58% |
| Copilot | 54% | 50% | 57% | 55% |
| CodeRabbit | 44% | 33% | 36% | 55% |
| Graphite | 6% | 17% | 0% | 6% |

**Macroscope Benchmark** (different methodology, 2025) [13]:

| Tool | Detection Rate |
|---|---|
| Macroscope | 48% |
| CodeRabbit | 46% |
| Cursor Bugbot | 42% |
| Greptile | 24% |
| Graphite Diamond | 18% |

**Important caveat**: Both benchmarks were produced by competitors (Greptile and
Macroscope respectively). The Greptile benchmark required line-level comments
explaining impact; the Macroscope benchmark focused on self-contained runtime bugs.
Teams should run their own evaluations on their own codebases with their own
configurations.

### AI code review at scale: Microsoft

Microsoft's internal AI review system demonstrates enterprise-scale feasibility
[14]:

- Over 90% of PRs reviewed by AI across the company
- 600K+ pull requests per month impacted
- 10-20% median PR completion time improvement across 5,000 repositories
- AI provides initial feedback within minutes of PR creation

### Quality impact of AI review

From Qodo's State of AI Code Quality report [10]:

- 81% of teams using AI for code review saw quality improvements (vs 55% of fast-
  moving teams without AI review)
- 80% of PRs with AI review enabled had zero human review comments needed
- 82% of developers use AI coding tools daily or weekly
- 65% report at least 25% of commits influenced by AI

### The Writer/Reviewer pattern

Use a separate session to review code. The reviewer session has fresh context and
is not biased toward the code it just wrote. This is one of the highest-value
patterns for quality improvement [1].

For formal review workflows, Anthropic provides a code review plugin that can be
installed via `/plugin` [31].

### Small PR discipline

Review quality degrades with PR size. AI reviewers -- like human reviewers --
perform better on focused, small changes than on large, multi-concern PRs. Faros
AI found that AI adoption correlated with 154% increase in average PR size and
91% increase in PR review time [9].

Keep PRs small and focused. One concern per PR. This applies equally whether
the reviewer is human, AI, or both.

### Pre-commit review

Review staged changes before committing -- do not wait for the PR stage. A pre-
commit review catch is cheaper than a PR-level catch, which is cheaper than a
production catch.

### Running code review from the CLI

Tools like CodeRabbit offer a CLI that runs reviews locally, outside the PR
workflow. This is useful for pre-commit review and for agent-driven workflows
where the agent can act on findings immediately.

Install:

```bash
curl -fsSL https://cli.coderabbit.ai/install.sh | sh
```

Authenticate (one-time):

```bash
coderabbit auth login
```

Review uncommitted changes (human-readable):

```bash
coderabbit review --plain --type uncommitted
```

Review uncommitted changes (agent-optimized -- smaller, structured output
designed for LLM consumption):

```bash
coderabbit review --prompt-only --type uncommitted
```

Review a branch against main:

```bash
coderabbit review --plain --base main
```

The `--prompt-only` flag produces output optimized for LLM consumption -- less
prose, more structured findings. Use it when the agent is the consumer. Use
`--plain` when a human needs to read the output.

The CLI is free to use for basic reviews. No Pro subscription is required.

### Baseline review on project creation

When creating a new project or onboarding to an existing codebase, run a full
review. This establishes a quality baseline and catches existing issues before new
code is layered on top.

### Devil's advocate review for milestone changes

Standard code review catches line-level issues -- bugs, style, missing error
handling. It does not catch semantic drift: stale citations, broken URLs,
contradictory claims across files, or prices that changed since the code was
written. For that, you need an adversarial review pass.

**When the research says it works.** LLMs cannot self-correct through intrinsic
reflection alone -- asking "did I make a mistake?" without external signal often
degrades output [Huang et al., ICLR 2024]. But when the reviewer is given
concrete verification tasks (check this URL, confirm this file path, verify this
price), self-correction becomes effective because verification is easier than
generation [Kamoi et al., TACL 2025].

**When to run one:**

- A branch is 5+ commits ahead of main with documentation or configuration
  changes. Accumulated drift across sessions creates consistency problems.
- After completing or substantially updating any document with external
  references (citations, URLs, version numbers, pricing claims).
- After a major refactor that touches many files.

**When not to bother:**

- Every commit (that is what pre-commit review handles).
- Single-file code changes with good test coverage.
- The diminishing returns curve is steep: round 1 of reflection captures most
  gains; rounds 3+ yield single-digit-percent improvement at up to 50x the
  token cost of a single pass [Shinn et al., 2023].

**Structural requirements for effectiveness:**

1. **Forced disagreement.** The reviewer must raise a substantive concern each
   round. Without this, LLMs converge prematurely toward agreement.
2. **Priority ordering.** Correctness before style. Without ordering, reviews
   gravitate toward shallow nitpicks.
3. **Concrete evidence required.** Both parties must cite file:line or provide
   diffs, not abstract suggestions.
4. **External verification.** The reviewer must check claims against live
   sources, run commands, and read files -- not just re-read its own output.
5. **Early termination.** Stop when genuine consensus is reached rather than
   padding to a round count.

### Pre-commit hooks for mechanical enforcement

Some rules should not depend on the agent following instructions. A pre-commit
git hook can mechanically block:

- Files larger than 5MB (which should be hosted externally)
- AWS access keys and common credential patterns
- `.env` files that should be in `.gitignore`

The playbook includes a pre-commit hook template at `templates/hooks/pre-commit`.
Install it per project:

```bash
cp ~/.claude/templates/hooks/pre-commit .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

The `/playbook project` skill and `/create-project` skill install this
automatically.

---

## 10. Security and Trust Boundaries

### The threat landscape

The security risks of LLM-assisted coding are not theoretical. They are documented,
measured, and actively exploited.

**OWASP Top 10 for LLMs (2025)** identifies three entries directly relevant to
coding agents [17]:

| Rank | Vulnerability | Relevance to coding agents |
|---|---|---|
| #1 | Prompt Injection | Untrusted code/docs can hijack agent behavior |
| #2 | Sensitive Information Disclosure | Agents read credentials, env vars, secrets |
| #6 | Excessive Agency | Agents execute commands, modify files, access network |

### Prompt injection: the numbers

Prompt injection is not an edge case. It is the default outcome when untrusted
input reaches an LLM:

- **94.4% success rate** in controlled study (102 of 108 evaluations at turn 4,
  n=216) across lightweight commercial models. Even extreme-harm scenarios
  succeeded 91.7% of the time [19].
- **All 12 published defenses bypassed at 90%+ success rate** under adaptive
  attacks. Defenses that reported near-zero attack success against static attacks
  fell to 71-100% under adaptive evaluation. Human red-teaming achieved 100%
  success [18].
- **Injected recommendations persisted in 69.4%** of follow-up interactions [19].

The implication: no application-level prompt injection defense should be trusted as
a sole security control.

### The Rule of Two

The "Rule of Two" (originating from the Chromium security model) states that a
system should never combine more than two of: untrusted input, unsafe
implementation language, and elevated privilege. NVIDIA's analysis of agentic
systems [21] applies an analogous principle: systems that simultaneously
(1) process untrusted input, (2) access sensitive data, and (3) change state are
inherently unsafe.

Coding agents violate all three properties by design:
1. They **read untrusted code** -- any repository, PR, or issue could contain
   malicious instructions
2. They **access sensitive data** -- filesystem, credentials, environment variables
3. They **execute commands** -- shell access, file modification, network requests

This is not a flaw to be fixed -- it is an inherent property of the tool. The
mitigation is not to eliminate these capabilities but to **sandbox them**.

### Enterprise security data

Apiiro's enterprise study of AI-assisted development teams found [23]:

- **10x more security findings** per month (10,000+ by June 2025, up from
  ~1,000 in December 2024)
- **322% increase** in privilege escalation paths
- **153% spike** in architectural design flaws
- Azure credentials exposed nearly 2x more often
- Fewer, larger PRs concentrate risk in each merge

### Real incidents

- **IDEsaster (2025)**: Researchers discovered 30+ vulnerabilities across AI-
  powered IDEs, resulting in 24 CVEs across 10+ platforms including Cursor,
  Windsurf, GitHub Copilot, and Zed.dev. Attack vectors included prompt injection
  via JSON schema poisoning, autonomous agent actions without user approval, and
  configuration file manipulation for code execution [24].
- **Langflow RCE (CVE-2025-3248)**: Critical (CVSS 9.8) remote code execution in
  the Langflow AI workflow platform, added to CISA's Known Exploited Vulnerabilities
  catalog in May 2025. Attackers exploited the lack of input validation and
  sandboxing to execute arbitrary code on servers [34].

### Sandboxing: the only structural defense

NVIDIA's guidance is explicit: application-level filtering is insufficient. Once
execution passes to a subprocess, the application loses visibility and control.
Attackers exploit indirection -- invoking restricted tools via safer, approved
ones -- to bypass allowlists [20].

Only OS-level (kernel-enforced) sandboxing is structurally sound:
- **macOS**: Seatbelt profiles
- **Linux**: Bubblewrap, Landlock
- **Windows**: AppContainer
- **Best**: Fully virtualized environments (VMs, Kata containers, unikernels) that
  isolate the sandbox kernel from the host kernel [20]

NVIDIA's three mandatory technical controls for agentic systems [20]:
1. **Network egress controls** -- block arbitrary network access to prevent
   exfiltration
2. **Workspace-bounded file writes** -- prevent writes outside active workspaces
3. **Configuration file protection** -- block all writes to agent config, hooks,
   and extension files

### Anthropic's security architecture

Claude Code implements several structural protections [2]:

- **Permission-based architecture**: Read-only by default; all modifications
  require explicit approval
- **Write restriction**: Can only write to the folder where it was started and
  subfolders
- **Command blocklist**: Blocks risky commands (`curl`, `wget`) by default
- **Isolated context windows**: Web fetch uses a separate context to avoid
  injecting potentially malicious prompts
- **Command injection detection**: Suspicious commands require manual approval
  even if previously allowlisted
- **Trust verification**: First-time codebase runs and new MCP servers require
  verification

### Trail of Bits recommendations

Trail of Bits published a hardened Claude Code configuration [22] that provides:

- **Credential directory denial**: Block reads to `~/.ssh/`, `~/.aws/`,
  `~/.gnupg/`, `~/.azure/`, `~/.kube/`, `~/.docker/config.json`, `~/.npmrc`,
  `~/.git-credentials`, `~/.config/gh/`, and crypto wallets
- **Project MCP servers disabled by default**: `enableAllProjectMcpServers: false`
  -- project `.mcp.json` files live in git, so a compromised repo could ship
  malicious MCP servers
- **Hook-based guardrails**: Block `rm -rf` commands, prevent direct pushes to
  main branches
- **Shell config protection**: Block edits to `~/.bashrc`, `~/.zshrc`

### Practical security rules

1. **Enable `/sandbox` for untrusted repos.** OS-level isolation is the minimum
   when working with code you did not write.
2. **Review security-critical changes line by line.** AI review is insufficient
   for authentication, authorization, cryptography, and credential handling.
3. **Never pipe untrusted content to the agent.** Markdown files, issue
   descriptions, and PR comments can contain prompt injection payloads.
4. **Deny reads to credential directories.** Use Trail of Bits' configuration
   as a starting point [22].
5. **Block project MCP servers by default.** Only enable after manual review.
6. **Use VMs for maximum isolation.** Claude Code on the web runs in isolated VMs;
   replicate this locally for high-risk work.

---

## 11. Multi-Agent Coordination

### Within-session: subagents

Subagents run in their own context window with custom system prompts, specific
tool access, and independent permissions [3].

**Built-in subagents**:

| Agent | Model | Purpose |
|---|---|---|
| Explore | Haiku | Read-only codebase exploration (fast, cheap) |
| Plan | Inherits | Research for plan mode |
| General-purpose | Inherits | Complex multi-step tasks |

**Custom subagent definitions** (`.claude/agents/*.md`):

```markdown
---
name: security-reviewer
description: Reviews code for security vulnerabilities
tools: Read, Grep, Glob, Bash
model: opus
---
You are a senior security engineer. Review code for:
- Injection vulnerabilities (SQL, XSS, command injection)
- Authentication and authorization flaws
- Secrets or credentials in code
- Insecure data handling
```

Key design principles:
- Each subagent should excel at one specific task
- Grant only necessary tool permissions
- Write detailed descriptions so the agent knows when to delegate
- Set `model` explicitly to control costs

### Within-session: Agent Teams

Agent Teams coordinate multiple parallel sessions with shared task lists and
messaging. The team lead distributes work and synthesizes results.

**Task sizing**: 5-6 self-contained tasks per teammate. Each task should be
completable without dependencies on other in-progress tasks.

**File ownership discipline**: Two teammates editing the same file leads to
overwrites. Assign clear file ownership before starting parallel work. If work
touches files another teammate is modifying, message them first.

### Cross-session: shared communication

For agents running in separate sessions (on different terminals, machines, or
CI pipelines), a shared communication channel enables coordination:

- **Auto-register/deregister**: Agents register on session start and deregister
  on session end
- **Heartbeat with stale pruning**: Agents not seen in 30+ minutes are marked
  stale and eventually pruned
- **Broadcast and directed messages**: Post to all agents or target specific ones

### When peer communication adds value

| Scenario | Why communication helps |
|---|---|
| Shared discovery | Agent A finds a breaking change that affects Agent B's work |
| Conflict prevention | Two agents about to edit the same file |
| Cross-project awareness | Pattern discovered in one project applies elsewhere |
| Workload rebalancing | Redirect work from blocked to available agents |

### When NOT to use multi-agent

- **Single task**: No benefit from coordination overhead
- **No shared files**: Independent work does not need synchronization
- **No cross-cutting discoveries**: Isolated tasks with no interdependencies
- **Simple exploration**: A single subagent is sufficient; full Agent Teams adds
  unnecessary complexity

### Subagent patterns

**Parallel research**: Spawn multiple subagents to investigate independent areas
simultaneously:

```
Research the authentication, database, and API modules in parallel
using separate subagents.
```

**Chain subagents**: Use subagents in sequence where each step builds on the
previous:

```
Use the code-reviewer subagent to find performance issues,
then use the optimizer subagent to fix them.
```

**Background tasks**: Set `background: true` in the subagent frontmatter to run
concurrently while you continue working. Press `Ctrl+B` to background a running
task [3].

---

## 12. Getting Started

### Quick install

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

### Profile descriptions

The install script supports multiple profiles:

| Profile | Description |
|---|---|
| `dev` | Full development setup: CLAUDE.md, skills, templates, security config |
| `research` | Structured investigation workflow: evidence collection, tagging, PHI sanitization |

### Wizard mode for existing users

If you already have instruction files, the installer runs in wizard mode: it
analyzes your existing configuration and suggests targeted additions without
overwriting your customizations.

### Project template

The `templates/project-CLAUDE.md` file provides a starting point for new projects.
It includes:
- Quality gate commands (type-check, lint, test)
- Workflow rules
- Common code style overrides

Customize it for your specific project rather than using it as-is. Remove anything
the agent would do correctly without the instruction.

### Auto-exit option

For CI/CD integration, the installer supports `--auto-exit` to apply defaults
without interactive prompts.

### Next steps

1. Install the playbook using the quick install command above.
2. Review and customize `CLAUDE.md` for your project.
3. Add project-specific skills to `.claude/skills/`.
4. Configure hooks for deterministic actions (formatting, linting).
5. Set up credential denial rules from Trail of Bits [22].
6. Enable `/sandbox` for any work on untrusted code.
7. Run a baseline code review on your existing codebase.

---

Last updated: 2026-02-21

---

## Citations

1. **Anthropic -- Claude Code Best Practices.** https://code.claude.com/docs/en/best-practices -- Official workflow recommendations, context management, verification practices, and common failure patterns.

2. **Anthropic -- Claude Code Security.** https://code.claude.com/docs/en/security -- Permission-based architecture, sandboxing, prompt injection protections, command blocklist, and isolated context windows.

3. **Anthropic -- Claude Code Sub-Agents.** https://code.claude.com/docs/en/sub-agents -- Built-in and custom subagent configuration, tool restrictions, model selection, persistent memory, and hooks.

4. **Anthropic -- Prompt Caching.** https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching -- Cache pricing (0.1x on hits), TTL mechanics, automatic and explicit caching strategies, and per-model pricing.

5. **HumanLayer -- Writing a Good CLAUDE.md.** https://www.humanlayer.dev/blog/writing-a-good-claude-md -- 150-200 instruction ceiling research, system prompt analysis (~50 instructions), token budget guidelines, and instruction-following decay patterns.

6. **GitHub -- Copilot Productivity Research.** https://github.blog/news-insights/research/research-quantifying-github-copilots-impact-on-developer-productivity-and-happiness/ -- 55% faster task completion, 73% flow state, 87% mental effort preservation, study of 2,000+ developers and 95 controlled participants.

7. **GitHub -- Copilot Code Quality Research.** https://github.blog/news-insights/research/research-quantifying-github-copilots-impact-on-code-quality/ -- 85% developer confidence in code quality, 15% faster code reviews, 88% maintained flow state, 36-participant controlled study.

8. **METR -- AI Developer Productivity Study.** https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/ -- -19% productivity for experienced OSS developers (n=16, 246 tasks), randomized controlled trial, primarily Cursor Pro with Claude 3.5/3.7 Sonnet.

9. **Faros AI -- The AI Productivity Paradox.** https://www.faros.ai/blog/ai-software-engineering -- 21% more tasks completed but zero organizational throughput gain; 154% PR size increase; 91% review time increase; data from 1,255 teams and 10,000+ developers.

10. **Qodo -- State of AI Code Quality.** https://www.qodo.ai/reports/state-of-ai-code-quality/ -- 81% quality improvement with AI review (vs 55% among fast-shipping teams without); 80% of PRs need zero human comments; 82% daily/weekly AI usage; 65% context issues during refactoring.

11. **CodeRabbit -- State of AI vs Human Code Generation.** https://www.coderabbit.ai/blog/state-of-ai-vs-human-code-generation-report -- 1.7x more issues in AI PRs (10.83 vs 6.45); 75% more logic errors; 2.74x security issues; 8x excessive I/O; 470 PRs analyzed.

12. **Greptile -- AI Code Review Benchmark.** https://www.greptile.com/benchmarks -- Detection rates: Greptile 82%, Cursor 58%, Copilot 54%, CodeRabbit 44%, Graphite 6%; 50 real bugs across 5 languages; July 2025.

13. **DevTools Academy / Macroscope Benchmark.** https://www.devtoolsacademy.com/blog/state-of-ai-code-review-tools-2025/ -- Detection rates: Macroscope 48%, CodeRabbit 46%, Cursor 42%, Greptile 24%, Graphite 18%; focus on self-contained runtime bugs.

14. **Microsoft -- AI Code Reviews at Scale.** https://devblogs.microsoft.com/engineering-at-microsoft/enhancing-code-quality-at-scale-with-ai-powered-code-reviews/ -- 90% of PRs reviewed by AI; 600K PRs/month; 10-20% faster PR completion across 5,000 repositories.

15. **Meta TestGen-LLM (FSE 2024).** https://arxiv.org/abs/2402.09171 -- 73% acceptance rate for production deployment; 75% compilation success; 57% reliable execution; 11.5% class improvement rate at Instagram and Facebook.

16. **Frontiers in AI -- Test Pyramid 2.0.** https://www.frontiersin.org/journals/artificial-intelligence/articles/10.3389/frai.2025.1695965/full -- LLM-based testing achieves 59.6% coverage vs 38.2% for EvoSuite; 85% relevant test cases; five-layer security-integrated testing model.

17. **OWASP Top 10 for LLMs (2025).** https://genai.owasp.org/resource/owasp-top-10-for-llm-applications-2025/ -- Prompt Injection (#1), Sensitive Information Disclosure (#2), Excessive Agency (#6); industry-standard LLM vulnerability classification.

18. **"The Attacker Moves Second" (prompt injection defenses).** https://simonwillison.net/2025/Nov/2/new-prompt-injection-papers/ -- All 12 published defenses bypassed at 90%+ under adaptive attacks; human red-teaming achieved 100%; defenses that reported near-zero attack success fell to 71-100% under adaptive evaluation.

19. **Medical LLM Prompt Injection Study.** https://pmc.ncbi.nlm.nih.gov/articles/PMC12717619/ -- 94.4% attack success rate (102/108 evaluations); n=216; 12 clinical scenarios; injected recommendations persisted in 69.4% of follow-ups; extreme-harm scenarios succeeded 91.7%.

20. **NVIDIA -- Sandboxing Agentic Workflows.** https://developer.nvidia.com/blog/practical-security-guidance-for-sandboxing-agentic-workflows-and-managing-execution-risk -- Application-level filtering insufficient; kernel-enforced sandboxing required; three mandatory controls (network egress, workspace-bounded writes, config file protection); full virtualization recommended.

21. **NVIDIA -- Code Execution Risks in Agentic AI.** https://developer.nvidia.com/blog/how-code-execution-drives-key-risks-in-agentic-ai-systems/ -- Agents processing untrusted input while accessing sensitive data and changing state are inherently unsafe; AI-generated code must be treated as untrusted; sandboxing is a required security control.

22. **Trail of Bits -- claude-code-config.** https://github.com/trailofbits/claude-code-config -- Hardened Claude Code configuration: credential directory denial (~/.ssh, ~/.aws, ~/.gnupg, etc.), project MCP disabled by default, hook-based guardrails, shell config protection.

23. **Apiiro -- AI Coding Vulnerability Study.** https://apiiro.com/blog/4x-velocity-10x-vulnerabilities-ai-coding-assistants-are-shipping-more-risks/ -- 10x more security findings; 322% privilege escalation increase; 153% architectural flaw spike; Azure credentials 2x more exposed; enterprise-scale telemetry data.

24. **IDEsaster -- 30+ CVEs in AI IDEs.** https://thehackernews.com/2025/12/researchers-uncover-30-flaws-in-ai.html -- 30+ vulnerabilities, 24 CVEs, 10+ affected platforms; prompt injection via JSON schema poisoning; autonomous agent actions; configuration manipulation for code execution.

25. **Fortune -- AI Coding Security Exploits.** https://fortune.com/2025/12/15/ai-coding-tools-security-exploit-software/ -- Coverage of major AI coding tool security incidents and broader AI coding security landscape.

26. **Addy Osmani -- LLM Coding Workflow.** https://addyosmani.com/blog/ai-coding-workflow/ -- Planning before code, iterative chunking, human verification, version control discipline; ~90% of Claude Code written by Claude Code; model musical chairs for blind spot detection.

27. **Steve Kinney -- Cost Management.** https://stevekinney.com/courses/ai-development/cost-management -- Model routing strategies (Opus for planning, Haiku for implementation); /clear and /compact for token reduction; structured planning reduces wasted tokens; up to 70% token reduction through compression.

28. **TDD for Code Generation.** https://arxiv.org/abs/2402.13521 -- Research on test-driven development as a methodology for improving LLM code generation quality.

29. **GenAI for TDD Preliminary Results.** https://arxiv.org/abs/2405.10849 -- Early findings on using generative AI within TDD workflows.

30. **Thoughtworks -- Agile + AI Anniversary Workshop.** https://www.theregister.com/2026/02/20/from_agile_to_ai_anniversary/ -- TDD prevents agents from writing tests that verify broken behavior; engineering discipline relocates rather than disappears; security practices "dangerously behind."

31. **Anthropic Code Review Plugin.** https://github.com/anthropics/claude-code/blob/main/plugins/code-review/README.md -- Official code review plugin for Claude Code.

32. **Human-Written vs AI-Generated Code (ISSRE 2025).** https://arxiv.org/abs/2508.21634 -- 500K+ code samples in Python and Java; AI code simpler but more security vulnerabilities; distinct defect profiles require specialized QA; Orthogonal Defect Classification methodology.

33. **Stack Overflow 2025 Developer Survey -- AI.** https://survey.stackoverflow.co/2025/ai -- 84% use or plan to use AI tools; 46% distrust accuracy; 52% report productivity gains; 66% cite "almost right but not quite" as top frustration; 69% of agent users report increased productivity.

34. **Langflow CVE-2025-3248 -- CISA KEV.** https://www.helpnetsecurity.com/2025/05/06/langflow-cve-2025-3248-exploited/ -- Critical (CVSS 9.8) RCE in Langflow < 1.3.0; no input validation or sandboxing; added to CISA KEV catalog May 5, 2025; actively exploited to deploy Flodrix botnet.
