# Agentic Coding Playbook: Evidence-Based Practices for LLM-Assisted Development

## TL;DR

LLM-assisted coding delivers real productivity gains -- but only when teams manage
its well-documented failure modes. The evidence:

- **Quality gap**: AI code contains 1.7x more issues than human code [11]; enterprise
  teams see 10x more security findings with AI-assisted development [23].
- **Prompt injection**: Succeeds 94% of the time against lightweight commercial
  models in controlled medical LLM studies (n=216) [19]; all 12 published defenses
  bypassed at 90%+ under adaptive attacks [18].
- **Context economics**: Fresh sessions cost ~10x less per message than exhausted
  ones (5K vs 50K tokens) [1].
- **Model routing**: Using Haiku for exploration vs Opus for planning reduces
  per-operation costs 5-20x [4].
- **Prompt caching**: Reduces instruction overhead by 90% on cache hits
  [4].
- **Code review**: AI review catches 44-82% of defects depending on tool; reduces
  PR completion time 10-20% at scale [Greptile, Macroscope, Microsoft]. Developers
  using Copilot report 15% faster code reviews and 85% confidence in code quality [7].
- **Productivity**: Developer gains range from -19% to +55% depending on
  experience level and measurement method [METR, GitHub Copilot, Faros AI].
  Stack Overflow's 2025 survey confirms broad adoption: 84% of developers use or
  plan to use AI tools, though 46% distrust accuracy [33].
- **MCP tool cost**: Every MCP tool definition is re-sent every turn. MCP Tool
  Search activates automatically at >10% context to mitigate overhead [35].
- **Instruction ceiling**: LLMs follow ~150-200 instructions reliably; Claude
  Code's system prompt uses ~50 of that budget [5].
- **Flow state**: 73% of developers report flow state with AI tools; 87% preserve
  mental effort on repetitive tasks [6].
- **Review discipline**: Teams with AI code review see quality improvements 81% of
  the time vs 55% among fast-shipping teams without [10].

The practices in this document are derived from peer-reviewed research, large-scale
industry data, and official vendor documentation. Every statistic includes its
source; every recommendation is grounded in evidence.

---

## Table of Contents

1. [Core Economics](#1-core-economics)
2. [The Workflow: Explore, Plan, Code, Verify, Commit](#2-the-workflow-explore-plan-code-verify-commit)
3. [When the Agent Fails](#3-when-the-agent-fails)
4. [Reasoning Standards](#4-reasoning-standards)
5. [Efficiency and Cost Optimization](#5-efficiency-and-cost-optimization)
6. [Context and Session Management](#6-context-and-session-management)
7. [Memory and Persistence](#7-memory-and-persistence)
8. [Instruction File Design](#8-instruction-file-design)
9. [Testing and Verification](#9-testing-and-verification)
10. [Code Review Automation](#10-code-review-automation)
11. [Security and Trust Boundaries](#11-security-and-trust-boundaries)
12. [Model Context Protocol (MCP)](#12-model-context-protocol-mcp)
13. [PII/PHI Sanitization](#13-piiphi-sanitization)
14. [Multi-Agent Coordination](#14-multi-agent-coordination)
15. [Shared Knowledge Base](#15-shared-knowledge-base)
16. [Getting Started](#16-getting-started)
17. [The Physics of Context](#17-the-physics-of-context)
- [Citations](#citations)

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
| Haiku 3 | $0.25 | $1.25 | $0.025 |

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
being modified [1] [26].

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

## 3. When the Agent Fails

The workflow above describes what happens when things go well. This section is
about what to do when they don't.

### Failure modes that guardrails don't catch

Instruction files, memory systems, and hooks prevent many classes of errors. But
some failure modes are invisible to automated checks because they involve the
agent misinterpreting intent, not violating a rule:

- **Confident misinterpretation.** The agent does the opposite of what you asked,
  with full confidence, because it inferred the wrong intent. Memory files make
  this worse: a wrong conclusion persisted across sessions becomes a wrong
  conviction acted on repeatedly.
- **Activity as a substitute for progress.** The agent generates analysis,
  options, and explanations instead of doing the task. A one-command request
  becomes a multi-paragraph discussion. This is the most common failure mode and
  the most expensive, because it looks like work.
- **Compounding verbosity.** The agent pads responses when uncertain. More words,
  more context, more detail -- not because you need it, but because sparse output
  feels insufficient to the model. Every extra token costs money and attention.
- **Rule-following decay.** Instruction files are suggestions, not constraints.
  The agent may follow 90% of your CLAUDE.md rules 90% of the time, but the 10%
  it drops are unpredictable. Adding more rules does not fix this -- it increases
  the surface area for selective non-compliance.

### Workflow instructions vs coding instructions

Not all instructions fail equally. Dogfood testing across two real codebases
(14 tasks each) revealed a consistent pattern: agents follow **coding**
instructions reliably (style, patterns, error handling) but **workflow**
instructions (when to use plan mode, when to spawn subagents, when to
checkpoint) are followed roughly 50% of the time.

| Instruction type | Example | Compliance |
|---|---|---|
| Coding convention | "Use ES modules, not CommonJS" | High (~90%) |
| Quality gate | "Run tests before committing" | High (~85%) |
| Workflow behavior | "Use plan mode for multi-file changes" | Low (~50%) |
| Process automation | "Advance through the task queue" | Very low (~25%) |

The implication: do not rely on CLAUDE.md to enforce workflow behaviors. Use
hooks for deterministic enforcement (see
[Hooks for deterministic actions](#hooks-for-deterministic-actions)) and
automation tooling (task queue runners, session managers) for process
requirements. Instructions work for *what* the agent produces; hooks and
automation work for *how* the agent works.

### The instruction hierarchy problem

LLM behavior is driven by a stack of instructions with different priorities:

1. **Built-in system prompt** (highest priority) -- set by the vendor, not
   editable. Claude Code's system prompt is ~500 lines. It explicitly instructs
   conciseness, simplicity, and avoiding over-engineering -- but it also contains
   extensive safety reasoning around irreversible actions. Verbosity comes from
   training weights (the model's base behavior), not primarily from the system
   prompt. This matters: you cannot fully override training-weight tendencies
   with CLAUDE.md rules, regardless of how well you write them.
2. **CLAUDE.md / instruction files** (medium priority) -- your rules. These
   augment the system prompt. When your instruction ("be concise") conflicts
   with a training-weight tendency, the tendency often wins under uncertainty.
3. **Conversation context** (lowest priority) -- what you say in the moment. This
   should override everything but sometimes doesn't, especially when memory files
   contain contradictory directives.

This means some agent behaviors cannot be fixed by writing better instructions.
If the built-in prompt drives verbosity and your CLAUDE.md says "be concise," you
get an agent that is concise most of the time but reverts under uncertainty. The
direct API with a custom system prompt gives you full control of the stack, at the
cost of losing Claude Code's tool integrations.

### Intervention over prevention

When the agent is going sideways, do not try to guide it back with explanation.
Interrupt it:

| Situation | Do this | Not this |
|---|---|---|
| Agent is explaining instead of doing | "Stop. Run this command: [command]" | "Could you maybe just run the command?" |
| Agent did the wrong thing | `/rewind` and restate with fewer words | Explain why it was wrong and ask it to redo |
| Agent is asking what you want | Give a direct instruction, not a discussion | Answer the question and wait for more questions |
| Agent keeps repeating the same mistake | Switch approaches or start a fresh session | Retry the same prompt hoping for different results |

The key insight: **the faster you interrupt, the less it costs.** Every message
in a wrong direction increases context size, which increases cost per message and
reduces response quality. Three words ("Stop. Do X.") are cheaper and more
effective than three paragraphs of correction.

`/rewind` is the most underused tool. It removes the failed exchange from context
entirely, so the agent does not carry forward the bad reasoning. A fresh attempt
from a clean state beats a corrected attempt from a polluted one.

### Memory is fallible

Memory files persist conclusions across sessions. When those conclusions are
correct, this is powerful. When they are wrong, the agent acts on bad information
with the confidence of established fact.

Protect against this:

- **Separate observations from interpretations.** "Removed claude-api from
  .bashrc" is a fact. "User doesn't want API key billing" is an interpretation.
  Label them differently. Wrong interpretations dressed as facts are the most
  dangerous memory entries.
- **Live instructions override stored memory.** If the user asks for something
  and memory says otherwise, the user wins. Always.
- **Directive memory entries are suspect.** Any memory entry that says "always do
  X" or "never do Y" should trace back to an explicit user instruction, not an
  agent inference. If it doesn't, it's a guess with persistence.

### You are the final guardrail

The more you integrate an agent into your workflow, the harder it becomes to spot
when it is failing. Automated checks catch rule violations. They do not catch
misunderstood intent, subtly wrong approaches, or confident mistakes.

This means:

- **The cost of adoption is attention, not just tokens.** You must keep watching.
  The more the agent gets right, the less you watch, and the more damage it does
  when it gets something wrong.
- **Factor human review into your productivity estimates.** If the agent saves
  you 30 minutes of coding but costs 10 minutes of review, the real gain is 20
  minutes. If review catches a mistake that would have cost an hour to debug
  later, the gain is higher -- but only because you were paying attention.
- **Simple tasks have negative ROI.** If you can type a command faster than you
  can describe it to the agent, type the command. The agent adds value on tasks
  where the thinking is hard, not where the typing is hard.

---

## 4. Reasoning Standards

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

## 5. Efficiency and Cost Optimization

### Parallel tool calls

When multiple independent pieces of information are needed, make all calls in the
same turn. Do not sequentially read five files when you can read them all at once.
This reduces round trips and avoids unnecessary context accumulation.

### No re-reads, no output echo, no preamble

- Do not re-read files already in context. Track what has been read this session.
- Do not echo tool output or restate what the user can already see.
- Do not use preamble phrases ("Let me...", "I'll now..."). Start with the
  action.

These practices eliminate an estimated 200-500 tokens of waste per turn. Over a
30-turn session, that is 6,000-15,000 tokens saved.

### Two-attempt limit

After two failed attempts at the same approach, switch strategies or ask for
clarification. Retry spirals can consume 3,000-10,000 tokens while making no
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

### Tool tier selection

Model routing selects which model to use for a subtask. Tool tier selection is
a higher-level decision: what kind of interface does this task need? Three tiers
with qualitatively different capabilities and trade-offs:

| Tier | When to use | System prompt control | Tools available |
|---|---|---|---|
| `q` (direct API, no tools) | Q&A, lookups, quick answers | Full -- you write it | None |
| `qa` (direct API + tool use) | File/shell work without hooks or MCP | Full -- you write it | bash + text editor |
| Claude Code | Multi-file coordination, hooks, MCP, subagents | None -- vendor-controlled | Full suite |

The decision tree:

```
Does the task need file or shell access?
  No  → q   (fastest, cheapest, fully predictable)
  Yes →
    Does it need hooks, MCP, or subagents?
      No  → qa  (file-capable, controlled system prompt)
      Yes → Claude Code
```

The routing signal is **capability requirements, not difficulty**. Features that
predict tier: file paths mentioned, shell commands implied, multi-repo context,
presence of architectural keywords (refactor, migrate, redesign), debugging
stack traces. A regex classifier over these features is sufficient for v1.

**Cost asymmetry**: Routing too cheap when a task needed more capability causes
compounding errors in agentic sessions -- silent failures, wrong edits,
corrupted state. Routing too expensive wastes money but produces correct output.
When uncertain, bias toward the higher tier.

**Do not cascade at session level.** Using a cheap model for the first few turns
and escalating on failure does not work for agentic tasks: the cheap model's
tool calls create state that is not free to discard. Cascade logic belongs at
the subtask level (individual tool calls), not the session level.

**Building a router**: Start with the decision tree above as a 20-line regex
script. After accumulating ~200 labeled sessions, a kNN classifier over prompt
embeddings reliably matches or outperforms more complex learned approaches [27].

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

### Cache-friendly instruction design

Prompt caching operates on a prefix match: the infrastructure reuses the cached KV
state only when the beginning of your prompt matches a previously cached version
byte-for-byte [4]. This means the order and stability of content in your
instruction files directly determines how often you pay full input cost versus the
10% cache-hit rate.

**The stable prefix rule.** Place the most stable content at the top of CLAUDE.md
and the most volatile content at the bottom. A single change anywhere in the file
invalidates the cache for every token after that point. If your frequently updated
"Current Work" section sits above your 200-line coding standards block, every
memory update forces a full re-tokenization of the standards. Moving volatile
sections to the bottom preserves cache hits on everything above the change point.

**Avoid dynamic values in instruction files.** Embedding a date
(`last updated: 2026-02-22`), a version number, or any computed value in CLAUDE.md
causes cache invalidation on every change, even when the substantive content is
identical. Keep instruction files static in content; record dynamic metadata in
memory files that are explicitly expected to change.

**Keep the system prompt consistent across turns.** The cached prefix is formed by
the concatenation of tool definitions, CLAUDE.md content, and any memory files
loaded at session start [4]. Adding or removing an MCP server, changing tool
availability, or editing a memory file mid-session all shift this prefix. Batch
instruction changes into a single session boundary rather than editing files while
actively working.

### Per-operation cache behavior

Not all agent actions break the cache. Tool calls -- file reads, grep, glob,
bash -- are appended to the conversation after the cached prefix and do not modify
it, making heavy tool use cache-neutral. Instruction file edits modify the prefix
itself, making them the primary source of unexpected invalidation [4, 27].

| Operation | Cache Impact | Reason |
|---|---|---|
| Tool call response (Read, Grep, Bash) | No invalidation | Result appended after cached prefix |
| New conversation turn (user message) | No invalidation | Extends conversation; prefix unchanged |
| Editing CLAUDE.md | Invalidates from edit point | Prefix content changes |
| Updating a memory file | Invalidates from change point | Memory loaded as part of prefix |
| Adding or removing an MCP server | Full invalidation | Tool definitions are part of the prefix |
| Running `/compact` | Full invalidation | Replaces conversation history with summary |
| Switching models | Full invalidation | Cache is per-model; no cross-model reuse |

The practical implication: the work most agents do most of the time -- reading
files, searching code, running commands -- is cache-friendly by design. The
operations that invalidate the cache are almost always human-initiated: editing
configuration, adjusting memory, changing the tool environment. Keep those changes
batched and infrequent during active sessions to preserve the cached state that
makes long investigative sessions economical.

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

## 6. Context and Session Management

### Fresh session advantage

A fresh session re-runs hooks, loads CLAUDE.md files, and starts with clean
context. At ~5K tokens per message versus ~50K in an exhausted session, a fresh
session is 10x cheaper per message and produces higher quality output because the
model is not distracted by accumulated irrelevant context [1, 27].

Start fresh sessions at natural breakpoints:
- Between unrelated tasks (use `/clear`)
- After completing a feature
- When context reaches ~70% (visible in the Claude Code status bar)
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

### Context spikes from multi-file edits

Instruction-based context thresholds ("compact at 60%") assume gradual context
growth. In practice, a single turn that edits 10+ files can spike context
20-30% because each Edit and Read tool call returns file contents that
accumulate within the turn. The threshold instruction cannot fire between tool
calls in the same turn -- by the time the agent's next reasoning step begins,
the context is already past the threshold.

The fix is structural, not instructional: a PostToolUse hook that reads the
session transcript to get actual token counts from the API, then warns or
blocks when thresholds are exceeded. Hooks execute after every tool call,
including mid-turn calls, providing the granularity that instructions cannot.

### Post-compaction recovery

After auto-compaction (~95% context), the agent loses awareness of task queues,
session state, and workflow context. Memory files survive on disk but the agent
does not re-read them unprompted. The result: the agent "goes freelance,"
working on whatever seems relevant rather than continuing its assigned task.

Mitigations:

- **Checkpoint before compaction.** Exit and restart the session at ~70%
  context rather than waiting for auto-compaction at ~95%. A fresh session with
  memory files is cheaper and more coherent than a compacted session without
  them.
- **Automated recovery.** Inject a memory re-read prompt after compaction is
  detected (via a PreCompact hook or session manager). This restores task queue
  awareness without human intervention.
- **Accept the limitation.** Post-compaction coherence is a known gap in all
  current agentic coding tools. Plan session boundaries proactively rather than
  relying on graceful degradation.

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

## 7. Memory and Persistence

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
| Claude Code Subagents | `.claude/agent-memory/<name>/` | Per-agent, with `user`, `project`, or `local` scope *(built-in to Claude Code; not managed by this playbook)* [3] |

---

## 8. Instruction File Design

### The instruction ceiling

Frontier thinking LLMs can follow approximately 150-200 instructions with
reasonable consistency. Smaller models handle significantly fewer. Performance
degrades as instruction count increases. All instructions are equally affected by
the overflow; larger models show linear decay, while smaller models show
exponential decay [5].

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

## 9. Testing and Verification

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

Research confirms that TDD significantly improves LLM code generation quality [28].
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

In one benchmark, the LLM-based tool ChatUniTest achieved **59.6% code coverage**
on four Java projects, compared to 38.2% for the evolutionary approach EvoSuite --
a 21.4 percentage point improvement [16]. Up to 85% of generated test cases proved relevant. Early results
from applying generative AI within TDD workflows show further promise for combining
these approaches [29].

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

## 10. Code Review Automation

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
- 65% report context issues during refactoring as a top AI challenge

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

Review the full codebase (useful for project creation or full audits):

```bash
coderabbit review --plain
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

## 11. Security and Trust Boundaries

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

These incidents reflect a broader trend of security exploits targeting AI coding
tools as adoption accelerates [25].

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

## 12. Model Context Protocol (MCP)

### What MCP is

Model Context Protocol (MCP) is an open standard that turns external services into
tool calls the agent can invoke [36]. Rather than building bespoke integrations for
every data source, MCP provides a common JSON-RPC 2.0 interface: define a server,
expose its capabilities, and any MCP-aware host (Claude Code, VS Code, Claude
Desktop) can consume it without code changes [36].

MCP defines three server-side primitives [36]:

| Primitive | What it does | Example |
|---|---|---|
| **Tools** | Executable functions the agent calls | Query a database, create a GitHub issue |
| **Resources** | Data sources attached as context | File contents, schema definitions, API responses |
| **Prompts** | Reusable interaction templates | System prompts, few-shot examples |

Two transport mechanisms are supported [36]:

- **Stdio**: Local process communicates over stdin/stdout. No network overhead;
  ideal for tools that need direct filesystem or system access.
- **Streamable HTTP** (recommended for remote): HTTP POST for client-to-server
  messages with optional Server-Sent Events for streaming. Supports OAuth 2.0,
  bearer tokens, and API key headers. The older SSE-only transport is deprecated
  [35].

### Installation scopes

Claude Code resolves MCP server configurations from three scopes [35]:

| Scope | Storage location | Who can see it | Use case |
|---|---|---|---|
| **Local** (default) | `~/.claude.json` under project path | You, current project only | Personal dev servers, experiments |
| **Project** | `.mcp.json` in project root (committed to git) | Entire team | Shared tools required for collaboration |
| **User** | `~/.claude.json` top-level | You, all projects | Personal utilities used across multiple repos |

When the same server name exists at multiple scopes, local overrides project,
which overrides user [35].

A minimal `.mcp.json` for a team-shared database server:

```json
{
  "mcpServers": {
    "analytics-db": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@bytebase/dbhub", "--dsn", "${DB_DSN}"],
      "env": {}
    }
  }
}
```

Environment variables expand using `${VAR}` or `${VAR:-default}` syntax in
`command`, `args`, `env`, `url`, and `headers` fields [35]. This lets teams commit
shared configurations without embedding credentials.

### Security model

Project-scope MCP servers represent a supply chain risk. The `.mcp.json` file
lives in version control, so a compromised repository can ship a malicious MCP
server to every developer who clones it [22].

Three controls address this:

1. **Disable project servers by default.** Set `enableAllProjectMcpServers: false`
   in your Claude Code settings -- Trail of Bits identified this as a critical
   hardening step [22]. Claude Code will prompt for per-server approval before
   any project-scoped server runs.

2. **Treat MCP tool output as untrusted input.** Any MCP server that fetches
   remote content (web pages, issue descriptions, PR comments) is a potential
   prompt injection vector. OWASP ranks prompt injection as the #1 LLM
   vulnerability [17]. Apply the same skepticism to MCP responses that you apply
   to user input.

3. **Review server commands before approving.** Claude Code displays a warning
   before using project-scoped servers from `.mcp.json` files. Read the
   `command` and `args` fields; a legitimate database server does not need
   `--exec` flags or network egress to arbitrary hosts.

To reset previously granted approvals:

```bash
claude mcp reset-project-choices
```

### MCP vs built-in tools

MCP is not a replacement for built-in tools. Use the right primitive for the job:

| Capability | Use built-in tools | Use MCP |
|---|---|---|
| Read/write files | Read, Write, Edit (no setup) | -- |
| Search code | Grep, Glob (fast, no latency) | -- |
| Run shell commands | Bash | -- |
| Query a SQL database | -- | Database MCP server |
| Create/read GitHub issues | -- | GitHub MCP server |
| Automate a browser | -- | Playwright MCP server |
| Access IDE state | -- | IDE integration MCP server |
| Call an internal API | -- | Custom MCP server |

Built-in tools have zero startup cost and no network round-trip. Prefer them for
file operations, search, and local commands. Reach for MCP when you need
capabilities the built-ins cannot provide -- external services, proprietary APIs,
or stateful browser sessions.

### Token cost

Every MCP tool definition is added to the system prompt and re-sent with every
API call, exactly like lines in a CLAUDE.md file (see
[Core Economics](#1-core-economics)). With many servers active, this overhead is
measurable.

Key limits from the Claude Code documentation [35]:

- MCP tool output exceeding **10,000 tokens** triggers a warning.
- The default maximum output is **25,000 tokens** (`MAX_MCP_OUTPUT_TOKENS`).
- Increase the limit only when a specific server requires it:
  ```bash
  export MAX_MCP_OUTPUT_TOKENS=50000
  ```

**MCP Tool Search** activates automatically when MCP tool definitions would
consume more than 10% of the context window [35]. Instead of loading all tool
schemas upfront, the agent uses a search tool to discover relevant MCP tools
on demand. Tool Search requires Sonnet 4 or Opus 4; it is not available on
Haiku models.

Practical rule: only enable the MCP servers you are actively using in a given
session. Disable servers that serve different projects or workflows before
starting a new task. Context budget spent on idle tool schemas is context
unavailable for code and reasoning.

### Scaling past built-in Tool Search

Claude Code's built-in MCP Tool Search handles moderate tool counts well. When
you have 40+ MCP tools and Tool Search still consumes significant context, the
**dynamic toolset** pattern offers further reduction [37].

The idea: replace N tool definitions with three meta-tools:

| Meta-tool | Purpose |
|---|---|
| `search_tools` | Semantic search over tool names and descriptions |
| `describe_tools` | Load full schema only for tools the agent will call |
| `execute_tool` | Run the selected tool with parameters |

This separates discovery from execution. The agent never loads schemas it does
not intend to use, cutting input tokens by 90-97% in benchmarks with 40-400
tools [37]. The tradeoff is 2-3x more tool calls per task and roughly 50%
longer wall-clock time.

**When to consider it:**

- You have **40+ MCP tools** active in a single session (multiple servers, large
  API surfaces).
- Token cost dominates your budget -- the per-call overhead matters less than
  the per-turn schema overhead.
- Built-in Tool Search is active but you still see high context consumption from
  tool definitions.

**When to skip it:**

- Fewer than 20 MCP tools. Built-in Tool Search or simply disabling unused
  servers is sufficient.
- Latency-sensitive workflows where the extra round-trips outweigh the token
  savings.
- You use mostly built-in tools (Read, Write, Bash, Grep, Glob). These are
  baked into the system prompt and cannot be dynamically loaded.

**Implementation approach:**

Build a proxy MCP server that wraps multiple downstream servers behind the three
meta-tools. The proxy maintains an index of all tool names and descriptions, and
forwards `execute_tool` calls to the appropriate downstream server. This is an
MCP server that serves other MCP servers -- the agent sees three tools instead
of hundreds.

Alternatively, if you control the MCP server, restructure it to expose a
categorical overview alongside semantic search rather than flat tool lists. This
restores discoverability -- without category hints, agents may not attempt to
search for tools they do not know exist [37].

### Common patterns

**Database access**: Connect to PostgreSQL, MySQL, or other databases with a
read-only credential. The agent can inspect schema, run analytical queries, and
identify data issues without shell access to the database host [35].

```bash
claude mcp add --transport stdio db -- npx -y @bytebase/dbhub \
  --dsn "postgresql://readonly:pass@db.prod:5432/analytics"
```

**Issue tracker integration**: Add the GitHub MCP server and the agent can read
ticket descriptions, create issues, and open PRs in a single workflow --
eliminating the copy-paste step between planning and implementation [35].

**Browser automation**: The Playwright MCP server gives the agent a real browser
it can navigate, screenshot, and test against. Useful for end-to-end test
authoring and UI regression checks without writing Playwright scripts from
scratch.

```bash
claude mcp add --transport stdio playwright -- npx -y @playwright/mcp@latest
```

**Semantic code navigation**: The Serena MCP server provides LSP-powered
symbol-level navigation (`find_symbol`, `find_referencing_symbols`,
`insert_after_symbol`) instead of grep-and-read-whole-file cycles [53]. This
cuts exploration tokens significantly in large codebases with deep type
hierarchies. Skip it for small projects where grep is sufficient.

```bash
claude mcp add serena -- uvx --from git+https://github.com/oraios/serena \
  serena start-mcp-server --context claude-code --project-from-cwd
```

The `--context claude-code` flag disables tools that duplicate Claude Code
built-ins. `--project-from-cwd` auto-detects the project from the working
directory at launch.

**IDE integration**: MCP servers can expose editor state -- open files, active
diagnostics, cursor position -- to the agent. This is how VS Code and Cursor
surface language server information that a standalone CLI cannot access.

### MCP server registry

The playbook ships a curated registry of production-grade MCP servers at
`templates/registry/mcp-servers.json`. Running `install.sh` merges registry
entries into your `settings.json` without overwriting existing configuration.

**What's included:**

| Server | Transport | Default state | Safety flags |
|---|---|---|---|
| GitHub | Docker (stdio) | **Enabled** | — |
| Datadog | npx (stdio) | Disabled | — |
| Snowflake | uvx (stdio) | Disabled | — |
| PostgreSQL | uvx (stdio) | Disabled | `--access-mode=restricted` |
| Sentry | HTTP (remote) | Disabled | OAuth |
| PagerDuty | uvx (stdio) | Disabled | No write tools |
| Atlassian | HTTP (remote) | Disabled | OAuth |
| Linear | HTTP (remote) | Disabled | OAuth |
| Slack | HTTP (remote) | Disabled | OAuth |
| CloudWatch | uvx (stdio) | Disabled | — |
| AWS API | uvx (stdio) | Disabled | — |
| Kubernetes | npx (stdio) | Disabled | `--read-only` |
| Grafana | uvx (stdio) | Disabled | — |
| Elasticsearch | uvx (stdio) | Disabled | — |
| Serena | uvx (stdio) | Disabled | `--context claude-code` |
| Zendesk | npx (stdio) | Disabled | — |
| ClickUp | HTTP (remote) | Disabled | OAuth |
| MongoDB | npx (stdio) | Disabled | `--readOnly` |
| Presidio | Docker (stdio) | Disabled | — |

**Enabling a server:**

1. Open `~/.claude/settings.json` (or your install root's `.claude/settings.json`)
2. Find the server entry under `mcpServers`
3. Set `"disabled": false`
4. Set any required environment variables (listed in the registry's `env_required` field)

Re-running `install.sh` never overwrites servers you have already configured.
New servers added to the registry in future updates are merged automatically.

**Managed repos:**

For fast local code search across related repositories, create
`~/.claude/resources.json`:

```json
{
  "repos": [
    "org/frontend",
    "org/backend",
    "org/shared-libs"
  ]
}
```

Running `install.sh` clones any repos not already present into `~/.claude/repos/`
(shallow clones via `gh repo clone`). A daily cron job keeps them fresh with
`git pull --ff-only`.

**Documentation as context:**

Teams hosting documentation on [Mintlify](https://mintlify.com) (or any platform
that exposes an MCP endpoint) can give agents direct search access. Add doc
endpoints to `resources.json`:

```json
{
  "docs": [
    {
      "name": "internal-docs",
      "url": "https://docs.yourcompany.com/mcp",
      "description": "Internal engineering documentation"
    }
  ]
}
```

Running `install.sh` registers each endpoint as an HTTP MCP server in
`settings.json`. Agents can then search documentation to understand system
architecture, locate functionality across repos, and find runbooks -- before
diving into code.

Any documentation platform that serves a remote MCP endpoint at a `/mcp` path
works with this pattern. Mintlify generates these automatically for hosted docs
sites.

---

## 13. PII/PHI Sanitization

Production systems handling personal data need defense in depth. Four
complementary layers cover different threat surfaces:

### Layer 1: MCP proxy (per-server wrapping)

[MCP Conceal](https://github.com/gbrigandi/mcp-server-conceal) wraps individual MCP
servers and redacts PII before it reaches the LLM. Configure it as a proxy in
front of any MCP server that returns sensitive data:

```json
{
  "mcpServers": {
    "zendesk-safe": {
      "command": "npx",
      "args": ["-y", "mcp-conceal", "--", "npx", "-y", "zd-mcp-server"],
      "disabled": false
    }
  }
}
```

This layer is **transparent to the agent** — PII is stripped before the agent
sees tool results. Best for always-on protection of specific data sources.

### Layer 2: LLM proxy (all traffic)

[LiteLLM](https://docs.litellm.ai/) with Presidio guardrails intercepts all
LLM API traffic, scanning both inputs and outputs for PII. Point Claude Code
at the proxy:

```bash
export ANTHROPIC_BASE_URL=http://localhost:4000  # LiteLLM proxy
```

This layer protects **all agent communication**, not just MCP tool results.
Best for organizations with blanket PII policies or compliance requirements.

### Layer 3: On-demand detection (agent-initiated)

The [Presidio MCP server](https://github.com/cmalpass/mcp-presidio) gives the
agent tools to scan text for PII/PHI entities on demand. Enable it in the
registry:

```bash
# In ~/.claude/settings.json, set presidio.disabled to false
```

The agent calls Presidio tools when it encounters text that might contain
sensitive data — investigation evidence, support tickets, log entries. This
layer is **agent-controlled** and works alongside the other two.

### Layer 4: Runtime Hook Detection

The `sanitize-guard` Claude Code hook provides regex-based PII detection directly in the agent loop — no external services required.

| Aspect | Detail |
|--------|--------|
| **Mechanism** | PostToolUse scans all tool output; PreToolUse blocks Edit/Write with PII |
| **Activation** | Opt-in per repo via `.claude/sanitize.yaml` |
| **Entities** | SSN, email, phone, credit card, IP, MRN, DOB + custom patterns |
| **Latency** | <50ms (regex, no network) |
| **False positives** | Luhn check on credit cards, private IP exclusion, labeled-only DOB/MRN |
| **Complements** | Layers 1-3 for defense in depth; Presidio for NLP-based recall |

Configuration example:
```yaml
# .claude/sanitize.yaml
sanitization:
  enabled: true
  entities: [US_SSN, EMAIL, PHONE_US, CREDIT_CARD, MRN]
  exclude_paths: ["tests/fixtures/**", "**/*.test.*"]
  custom_patterns:
    - name: PATIENT_ID
      regex: "PT-\\d{6}"
      placeholder: "[PATIENT_ID]"
```

No config file means no scanning — zero overhead for repos that don't handle sensitive data.

### Which layer for which scenario

| Scenario | Layer 1 (MCP proxy) | Layer 2 (LLM proxy) | Layer 3 (On-demand) | Layer 4 (Hook) |
|---|---|---|---|---|
| Redact PII from specific MCP servers | **Best fit** | Overkill | Manual | Partial |
| Blanket PII policy for all LLM traffic | Partial | **Best fit** | Partial | Partial |
| Agent-driven PII checks during investigations | No | No | **Best fit** | Complements |
| Compliance audit trail | Partial | **Best fit** | Partial | No |
| Zero-config protection | **Best fit** | Needs proxy setup | Needs agent awareness | Opt-in per repo |
| No external services | No | No | No | **Best fit** |

For maximum coverage, combine Layer 1 (wrap sensitive MCP servers) with Layer 3
(agent checks investigation evidence) and Layer 4 (hook catches PII before writes).
Layer 2 adds network-level protection when compliance requirements demand it.

---

## 14. Multi-Agent Coordination

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
| Cross-project awareness | Pattern discovered in one project applies elsewhere *(requires concurrent sessions; for cross-temporal transfer, use `/promote`)* |
| Workload rebalancing | Redirect work from blocked to available agents |

### When NOT to use multi-agent

- **Single task**: No benefit from coordination overhead
- **No shared files**: Independent work does not need synchronization
- **No cross-cutting discoveries**: Isolated tasks with no interdependencies
- **Simple exploration**: A single subagent is sufficient; full Agent Teams adds
  unnecessary complexity

### Task queue automation

Agents do not self-advance through task queues. The instruction "work through
tasks in order" is insufficient -- agents complete one task, then stop and wait
for user input rather than proceeding to the next item. This was consistent
across all dogfood testing: zero agents autonomously advanced through a
multi-task queue based solely on CLAUDE.md instructions.

The fix is external automation: a task queue runner that feeds the next task as
a new prompt when the previous task completes. The agent handles each task
well; the sequencing must come from outside the agent. This is another instance
of the broader pattern: instructions control *what* the agent produces, but
*process* requires tooling.

### Limitations of cross-session communication

The shared communication channel described above operates in real time between
concurrent sessions. It does **not** persist knowledge across time:

- Messages are pruned after 2 hours or 200 messages
- A lesson discovered on Monday is not available to a session on Tuesday
- No mechanism exists to search historical cross-session messages

For durable knowledge transfer across projects and time, use `/promote` to move
lessons to global scope, or `/learn` to capture them as structured knowledge
entries that persist and auto-inject into future sessions.

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

### The pipeline pattern

A pipeline chains agents in sequence, where the output of each becomes the input
to the next. Unlike parallel research (which fans out and collects), a pipeline
moves linearly through phases that have distinct requirements -- and where later
phases cannot begin until earlier ones complete.

Example: a four-stage feature implementation pipeline.

```
Stage 1 (Haiku  -- Explore):    Read codebase, identify affected files, document API surface
Stage 2 (Opus   -- Plan):       Design the implementation, identify risks, produce a spec
Stage 3 (Sonnet -- Implement):  Write code and tests against the spec
Stage 4 (Sonnet -- Review):     Security and correctness review of the diff
```

Each stage runs as a separate subagent with the model, tools, and system prompt
appropriate to its task. The lead session passes structured output (a markdown
file, a diff, a task list) as the input to the next stage.

When to use a pipeline:

- Multi-phase tasks where earlier phases produce structured artifacts (specs,
  plans, diffs)
- Tasks where you want to enforce a gate: stage 3 cannot start until stage 2
  produces an approved spec
- Tasks where different phases have genuinely different model requirements (cheap
  exploration, expensive planning)

When a pipeline is overkill: single-phase work, or tasks where stages are so
interdependent that passing structured artifacts between them is more friction
than a single coordinated session.

### Git worktree isolation

File ownership conflicts are the most common failure mode in parallel Agent
Teams [3]. Two agents editing the same file in the same working directory will
overwrite each other's changes without warning. The structural fix is to give
each agent a separate copy of the repository using git worktrees.

Claude Code supports this natively via the `isolation: "worktree"` parameter when
launching subagents:

```markdown
---
name: feature-agent
description: Implements a self-contained feature on an isolated branch
tools: Read, Write, Edit, Bash, Glob, Grep
model: sonnet
isolation: worktree
---
You are working on an isolated branch. Do not concern yourself with
other agents. Implement the assigned feature completely, then stop.
```

Each agent launched with worktree isolation receives:

- A fresh git branch created from the current HEAD
- A private working directory -- no shared file state
- Full read/write access within that directory

When work is complete, the lead session merges the branches. Conflicts, if any,
surface at merge time with full diff context rather than silently during parallel
writes.

Worktree isolation eliminates file conflict management entirely. Use it whenever
two or more agents will write to files in the same repository.

### Model routing per agent

The largest lever for controlling multi-agent cost is assigning each agent the
cheapest model that can handle its task [27]. Treat model selection as an
architecture decision, not a default.

| Role | Model | Rationale |
|---|---|---|
| Team lead / coordinator | Opus | Complex reasoning, cross-agent synthesis |
| Implementer | Sonnet | Code writing, test writing, refactoring |
| Explorer / searcher | Haiku | Read-only codebase search, grep, file reads |
| Reviewer (mechanical) | Haiku | Pattern matching, lint-style checks |
| Reviewer (substantive) | Sonnet | Logic errors, security, design review |

Cost comparison for a four-agent team running a 20K-token workload per agent
(input + output, no cache hits):

| Routing strategy | Per-agent cost | Team total |
|---|---|---|
| All Opus | ~$0.060 | ~$0.24 |
| All Sonnet | ~$0.036 | ~$0.14 |
| Mixed (1 Opus + 2 Sonnet + 1 Haiku) | ~$0.012-0.060 | ~$0.096 |

Source: Anthropic pricing [4]. Mixed routing yields roughly 60% cost reduction
versus all-Opus for a typical research-plan-implement-review team.

Set `model` explicitly in every custom subagent definition. Do not rely on
inheritance for cost-sensitive teams [3].

### Fan-out and consolidation

The fan-out pattern extends parallel research to its logical conclusion: the lead
spawns N specialized agents for independent tasks, waits for all to complete, then
synthesizes results into a unified output. Each agent's context is disposable --
it does its job, produces a structured artifact, and terminates. Only the artifact
survives.

**Concrete example**: adversarial review of this document with four parallel
specialized agents:

| Agent | Scope | Findings |
|---|---|---|
| Citations reviewer | Verified all 34 external URLs, checked claim accuracy | 8 dead links, 3 misattributed claims |
| Scripts reviewer | Audited install.sh, hooks, skill frontmatter | 7 bugs including credential regex false negatives |
| CI/docs verifier | Checked CI workflows, README accuracy, cross-references | 6 path errors, 2 broken badge references |
| Prose analyzer | Reviewed structure, duplication, unsupported assertions | 16+ structural findings |

Total: ~190K tokens, ~10 minutes, 30+ findings. The same review run sequentially
in a single session would have saturated the context window before completing [1].

The key insight: each agent is disposable. Its context window fills up and dies
when the task is done, but its findings -- captured in a structured markdown file
or task list -- persist. The lead session never sees the agent's internal
reasoning, only the output artifact. N agents can each use 100K+ tokens of
context with no accumulation in the parent session.

Design guidance:

- **Tasks must be independent.** Fan-out only works when agents do not need each
  other's intermediate results.
- **Outputs must be structured.** Tables, numbered findings, and severity labels
  are easy to synthesize. Prose summaries are not.
- **Agents should be disposable.** If you find yourself designing agents that
  need to persist state, the task is not a fan-out candidate.
- **Consolidation is the expensive step.** Budget Opus for the synthesis turn --
  it requires reasoning across all N outputs simultaneously.

---

## 15. Shared Knowledge Base

### The knowledge re-discovery problem

Agents independently re-discover the same lessons across projects. An audit of
9 project memory files found 73 lessons with 8 confirmed duplicates — each
representing 10-60 minutes of debugging time. Multiply by team size and the cost
compounds: 100 users re-discovering 12 lessons is ~600 person-hours wasted.

Google's internal wiki had ~90% of content unviewed after several months.
Documentation not co-located with the workflow gets ignored [20]. The fix: embed
knowledge where it's consumed. For AI agents, that means injecting relevant
lessons into the context window at session start — not storing them in a repo the
agent must browse.

### Entry format

Each lesson is a separate markdown file with YAML frontmatter:

```yaml
---
id: "20260222-143052-git-hookspath-override"
created: "2026-02-22T14:30:52Z"
author: "agent-name"
source_project: "my-project"
tool: "git"
category: "gotcha"
tags: ["hooks", "config", "silent-failure"]
confidence: "high"
visibility: "local"
verified_at: "2026-02-22T14:30:52Z"
---
```

Entries live at `~/.claude/knowledge/entries/<timestamp-slug>/entry.md`.

One file per entry with timestamp-slug naming structurally eliminates merge
conflicts. Two agents creating entries simultaneously produce two new files with
different names — no existing file is touched [11].

### Taxonomy

Six flat categories — no hierarchy deeper than one level. Hierarchical classifiers
show error cascade: wrong classification at level 1 propagates to all sublevels.
A flat taxonomy with clear definitions achieves >90% accuracy on auto-classification [7].

| Category | Description |
|---|---|
| `gotcha` | Surprising behavior, silent failure, common mistake |
| `pattern` | Reusable approach or best practice |
| `workaround` | Temporary fix for a known issue |
| `config` | Configuration requirement or setting |
| `security` | Security-related finding |
| `performance` | Optimization or bottleneck insight |

Tags provide the second dimension for cross-cutting concerns (e.g., `windows`,
`ci`, `typescript`).

### Contribution workflow

Agents author entries automatically — contribution friction is zero for humans:

1. **Capture**: Run `/learn` to describe a lesson. The skill auto-classifies
   (category, tool, tags) and creates an entry file.
2. **Checkpoint integration**: `/checkpoint` suggests running `/learn` when
   non-obvious discoveries are detected.
3. **Promote**: Run `/promote` to move a project-level lesson to global scope.
4. **Sync**: If the knowledge directory is a git repo, entries push on checkpoint
   and pull on session start.
5. **Review**: For shared (public) repos, entries go through PR review before
   merge — the human review gate that prevents hallucination amplification [13].

### Context-aware injection

The session-start hook scans `~/.claude/knowledge/entries/` and injects the top
5 entries matching the current project's tools and tags. Injection stays under
~1,500 tokens. The full knowledge base stays on disk for on-demand search.

Relevance scoring:
- Tool match (strongest signal): entry tool matches project dependencies
- Tag overlap: entry tags match project context
- Category boost: security and gotcha entries score higher (broadly useful)
- Confidence: high-confidence entries preferred

### Security model

A shared knowledge base is architecturally an untrusted input pipeline.
Natural-language injection is harder to detect than code injection [15].

Defenses:
- **Human review gate**: PRs for public repos catch obvious injection [13]
- **Informational framing**: entries describe what happened, not what to do.
  "This lesson describes X" rather than "Always do X" — reduces execution risk
- **Provenance metadata**: author, source_project, created date enable filtering
  by trust level
- **Sensitivity scan**: CI and pre-commit hooks check for API keys, credentials,
  email addresses, and absolute paths with usernames
- **Opt-in scope**: `visibility` field (local/team/public) controls sharing radius

### When to use a shared knowledge base

**Good fit:**
- Teams where multiple agents work on similar technology stacks
- Organizations with recurring platform-specific issues (Amplify, Docker, CI)
- Projects where onboarding cost is high (many lessons to re-discover)

**Not needed:**
- Solo developers with few projects (MEMORY.md Lessons Learned is sufficient)
- Teams using completely different tech stacks (low knowledge overlap)
- Short-lived projects (insufficient time to accumulate reusable lessons)

---

## 16. Getting Started

### Quick install

**macOS / Linux:**
```bash
git clone https://github.com/john-wilmes/claude-agentic-coding-playbook.git
cd claude-agentic-coding-playbook
chmod +x install.sh
./install.sh
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

### Next steps

1. Install the playbook using the quick install command above.
2. Review and customize `CLAUDE.md` for your project.
3. Add project-specific skills to `.claude/skills/`.
4. Configure hooks for deterministic actions (formatting, linting).
5. Set up credential denial rules from Trail of Bits [22].
6. Enable `/sandbox` for any work on untrusted code.
7. Run a baseline code review on your existing codebase.

### Verifying on a clean machine

For teams that need to validate the installer on a fresh environment (e.g., new
developer onboarding or CI infrastructure), the repository includes
`scripts/ec2-dogfood.sh` -- a standalone script that installs prerequisites, runs
both profiles, tests hooks, and verifies knowledge repo integration on a clean
Ubuntu instance.

---

## 17. The Physics of Context

Context windows are not uniform containers. Transformer architecture imposes non-uniform
internal topology: some positions accumulate more attention weight than others, and
performance degrades non-linearly as fill increases. This section synthesizes the
research so that design decisions — compaction thresholds, instruction placement,
evaluation methodology — have explicit empirical grounding.

### 16.1 Context Window Topology

#### Context rot

Chroma Research (2025) tested 18 frontier models across controlled fill levels and
found non-linear performance degradation in all of them [54]. Based on the reported
degradation curves, the practical ceiling appears to be roughly 60-70% of advertised maximum.
Counterintuitively, coherently structured content (e.g., a well-organized codebase)
degrades faster than shuffled haystacks, because the model's attention patterns over
coherent text are more sensitive to position than over random orderings.

#### Lost in the middle

Liu et al. (Stanford, TACL 2023/2024) documented a U-shaped retrieval performance
curve: information near the beginning and end of context is retrieved reliably;
information in the middle degrades 15-30%. At fill levels above 50%, models shift
to recency-only bias, effectively ignoring early context [39].

#### NUMA-aware context engineering

Conikee (Substack 2025) introduced a framework treating context windows as Non-Uniform
Memory Access (NUMA) in classical computing [52]. The mechanism:

- **Causal masking**: every token attends to all prior tokens; early tokens accumulate
  attention weight across the entire sequence
- **RoPE position encoding**: introduces long-term decay — tokens far from the query
  position receive attenuated attention

Practical consequence: anchor critical facts at front and end, compress the middle
aggressively. Semantic pruning (remove low-relevance content) outperforms recency
pruning (remove oldest content) because the middle zone accumulates regardless of
insertion order.

#### Context length alone hurts

arXiv:2510.05381 (2025) isolated the length effect from retrieval quality [48].
Even with perfect retrieval — all and only the relevant files present — performance
degrades 13.9-85% as input length increases. Adding relevant files still imposes a
context-length penalty from increased sequence processing burden.

#### Observation token concentration

JetBrains Research (arXiv:2508.21433, 2025) profiled SWE-bench agent runs and found
that tool observations (file reads, grep output, bash results) comprise approximately
84% of agent context tokens [38]. The implication is direct: multi-file edit sessions
spike context not because of agent reasoning, but because each tool call appends its
full output to the sequence. A single `/read` on a 500-line file adds ~3,000 tokens.

**Summary table**

| Finding | Source | Practical threshold |
|---------|--------|---------------------|
| Effective capacity 60-70% of maximum | Chroma [54] | Compact at 60% |
| 15-30% retrieval loss for mid-context | Liu et al. [39] | Put critical facts first/last |
| Length penalty 13.9-85% despite perfect retrieval | arXiv:2510.05381 [48] | Minimize total input |
| 84% of tokens are tool observations | JetBrains [38] | Mask old tool outputs |
| Auto-compaction fires at ~80% | Anthropic [1] (community-observed; official docs say "approaches the limit" without specifying a percentage) | 80% is already degraded |

The 60% compact threshold used in this playbook is validated by multiple independent
findings. The 80% auto-compaction threshold fires inside the already-degraded zone;
if compaction is not triggered manually, the agent is operating on degraded context
before the session ends.

---

### 16.2 Observation Management

Tool outputs are the dominant cost driver and the highest-leverage compression
target. The techniques below are ranked by token savings and performance impact.

| Technique | Token savings | Performance impact | Source | Status |
|-----------|--------------|-------------------|--------|--------|
| Observation masking (replace old tool outputs with summary placeholders) | ~50% cost reduction (52.7% for Qwen3-Coder 480B) | +1.4% solve rate (improved) | JetBrains [38] | Blocked — requires agent-level history modification before API submission; not implementable via Claude Code hooks |
| Read-once deduplication (block re-reads of unchanged files) | 38-40% file-read savings | Neutral | Community PreToolUse hook | Supported |
| Verbatim compaction (preserve exact text, drop redundancy) | 50-70% compression | 98% retention (vendor-reported, not independently verified) | Morph [40] | Blocked — Claude Code compaction is internal, not hookable |
| LLM summarization (Claude Code auto-compact at ~80%) | 80-90% compression | 37% multi-session retention (vendor-reported) | Morph [40] | Built-in |

The counterintuitive finding: LLM summarization — the method Claude Code uses at
auto-compaction — is the worst-performing approach for coding agents. It
destroys file paths, error codes, and variable names. The agent after auto-compaction
cannot reliably reconstruct the exact state it was in. Observation masking, by
contrast, *improves* solve rate while cutting costs, because it removes noise without
destroying precision.

Observation masking requires modifying `tool_result` content in conversation history
before API submission. This is not implementable via Claude Code hooks, which cannot
alter history already sent to the model. It is applicable to custom agent frameworks
(SWE-agent, OpenHands) that control message construction directly.

Verbatim compaction (Morph 2025) achieves claimed 98% retention at 50-70% compression
by dropping redundant content while preserving exact text for anything referenced.
These figures are vendor-reported (Morph marketing page) and have not been
independently verified. Morph is a commercial service; Claude Code `/compact` uses
LLM summarization, not deletion-based compaction. A PreCompact hook exists but cannot
modify compaction output. A PostCompact hook does not yet exist (GitHub #17237, open
as of March 2026).

#### The MemGPT mental model

Packer et al. (arXiv:2310.08560, 2023) framed LLM context management as operating
system memory paging [41]: main context is RAM, external storage is disk, and
explicit paging operations move content between them. This framework, which evolved
into the Letta platform, maps cleanly to Claude Code session management:

- **Page-out** = PreCompact hook writing task state, file hashes, and key findings
  to MEMORY.md before compaction discards them
- **Page-in** = session-start `/continue` reading MEMORY.md and restoring task state

The gap in most setups is that page-in is not automatic after auto-compaction. The
agent resumes with summarized context and no explicit re-read of MEMORY.md, producing
the post-compaction amnesia documented in the Lessons Learned section.

Cline's production finding is consistent: proactive session handoff at 50% fill, not
80%. Waiting for the model-enforced threshold means the agent is already in the
degraded zone when handoff occurs.

---

### 16.3 Instruction Reliability

Instructions in CLAUDE.md are text. Text is probabilistic. The research quantifies
how unreliable that is in agentic scenarios.

#### The reliability spectrum

| Level | Mechanism | Reliability | Example |
|-------|-----------|-------------|---------|
| 1. Pure instruction | CLAUDE.md text | 30-80% | "Use plan mode for multi-file changes" |
| 2. Hybrid (instruction + soft signal) | Hook injects warning at decision point | 60-90% | Context-guard 60% warning |
| 3. Hard enforcement | Hook blocks execution | >95% | Context-guard 70% block |
| 4. Architectural | System structure prevents violation | ~100% | claude-loop task queue, flock |

#### Research findings

**AgentIF** (Tsinghua University, arXiv:2505.16944, 2025): benchmark of 707
instructions across 50 real applications [42]. GPT-4o drops from 87% on the
standard IFEval benchmark to 58.5% on agentic instructions. Best models perfectly
follow fewer than 30% of instructions in real agentic scenarios. Performance
approaches zero when instructions exceed 6,000 words.

**Control Illusion** (arXiv:2502.15851, 2025): measured primary obedience rate
across six models [43]. Result: 9.6-45.8%. Larger models did not reliably outperform
smaller ones. System prompt vs user prompt separation provides weak enforcement —
the separation is a convention, not a barrier.

**Instruction ceiling** (HumanLayer 2025): uniform compliance degradation begins
around 150-200 instructions [50]. Claude Code's built-in system prompt uses
approximately 50 of that budget, leaving ~100-150 for user-defined rules before
degradation begins.

**Prompt brittleness** (ICLR 2024): semantically equivalent prompt variants produced
accuracy ranges spanning 76 percentage points [49]. The same instruction written
differently can fail or succeed depending on phrasing, not semantics.

#### Practical recommendations

- Place rationale clauses alongside instructions: compliance improves ~30% when the
  agent understands why a rule exists (BRICS Econ 2024).
- Make block messages directive, not explanatory. "BLOCKED. Run /checkpoint now."
  is more reliable than a paragraph explaining context degradation.
- Accept that any workflow behavior requiring >90% reliability must be enforced
  architecturally. "Guidelines live in prompts, fail-safes live in code" reflects
  industry consensus as of 2025-2026.
- AgentSpec (arXiv:2503.18666, ICSE 2026) provides a hook-based enforcement
  framework that prevents >90% of unsafe agent executions with millisecond overhead
  [51]. The context-guard hook in this playbook implements the same pattern,
  reading actual token counts from the session transcript rather than estimating
  from tool output sizes alone.

---

### 16.4 Process Supervision for Autonomous Agents

Autonomous agents introduce a class of failure that interactive sessions do not
have: the agent continues running after the user disengages. Two variants:

1. **Process orphans**: the agent process continues after the terminal closes or the
   user forgets about it. It may consume tokens indefinitely or take unintended
   actions.
2. **Semantic orphans**: the agent is alive but stuck in a loop — retrying the same
   failing action, or waiting for input that will never arrive.

#### Supervision patterns

**Registry + heartbeat**: on session start, write `{pid, task, started_at}` to a
known location. Update `last_seen` on each tool call. On read, prune entries where
`last_seen` is stale. A monitoring process can detect orphans by scanning the
registry. `claude-loop` implements this with `flock` for mutual exclusion.

**Stuck-detection**: OpenHands (arXiv:2511.03690, 2025) detects stuck agents by
monitoring for repeated identical actions [47]. An event-sourced log captures every
action with its full context; the supervisor scans for cycles and triggers auto-abort.
The pause/resume API allows human intervention without killing the process.

**Erlang/OTP "let it crash"**: do not write defensive error handling inside the
agent. Handle crashes externally in the supervisor process. An agent that catches
its own exceptions and retries silently is harder to supervise than one that fails
fast and lets the supervisor decide the restart policy.

**Exponential backoff**: Kubernetes CrashLoopBackOff is the canonical solution to
fast crash loops: 10s → 20s → 40s → 80s → 160s, capped at 300s, with a 10-minute
reset threshold. `claude-loop` adopts the same pattern with `MAX_TASK_ATTEMPTS=3`
before marking a task `[FAIL]` and advancing to the next one.

#### The thin orchestrator finding

NVIDIA (2025) found that a specialized small orchestrator — a deterministic process
routing tasks to workers — consistently outperformed larger monolithic LLMs at
orchestration tasks. The implication: keep routing, scheduling, and loop-control
logic in deterministic code, not in the LLM. The LLM is the worker; the shell
script is the supervisor.

---

### 16.5 Evaluation Without Confounding

Measuring agent capability without confounding infrastructure effects is harder than
it appears. The dominant failure mode: using automated test pass rates as a proxy
for actual output quality.

#### The holistic gap

METR (August 2025) evaluated agents on a coding benchmark and found 38% test-pass
rate but 0% of outputs mergeable as-is [44]. Automated tests passed; the code
required substantial rework. The gap between test-pass rate and mergeable-as-is is
the holistic gap — and it makes automated benchmarks unreliable predictors of real
deployment value.

#### Self-reporting is not evidence

Agents exhibit two distinct gaps: a knowledge-identification gap (cannot correctly
identify which instructions apply) and an identification-execution gap (correctly
identifies the instruction but does not execute it). An agent claiming "I used plan
mode for this change" is not evidence the Plan tool was invoked. Only the session
JSON — the actual tool call log — is evidence.

#### Isolating infrastructure effects

Cognition AI's "Devin-Base" approach (2024) uses a component-swap evaluation methodology [45]. The structure can be understood as a 2x2 factorial design:

|  | No infrastructure | Full infrastructure |
|--|------------------|---------------------|
| **Old model** | baseline | infra effect on old model |
| **New model** | model effect | combined effect |

The delta-of-deltas isolates infrastructure contribution from model capability
contribution. Without this isolation, a measured improvement could be entirely due
to a better base model, not the infrastructure changes under evaluation.

#### Metrics

**pass@k vs pass^k** (Anthropic 2025) [46]: for infrastructure evaluation, reliability
matters more than peak capability.

- `pass@k`: at least one of k runs succeeds. Measures capability ceiling.
- `pass^k`: all k runs succeed. Measures reliability floor.

An infrastructure change that improves `pass@k` but degrades `pass^k` increased
peak capability while reducing reliability. For production systems, `pass^k` is the
decision-relevant metric.

**IFEval principle**: if a behavior cannot be checked objectively, it cannot be
measured reliably. Redesign workflow instructions as verifiable constraints (a tool
was or was not called) rather than subjective assessments (the agent "followed
the workflow").

#### Recommended evaluation checklist

- Log `(task hash, model version, infrastructure commit SHA, outcome)` per run so
  results are reproducible and attributable.
- Pre-register expected behaviors before running to prevent post-hoc rationalization.
- Use a 5-point holistic score alongside test pass rate:
  - 0 = requires restart
  - 1 = major rework needed
  - 2 = minor rework needed
  - 3 = cosmetic changes only
  - 4 = merge as-is
- Track token consumption alongside task outcome. A solution that passes all tests
  but costs 10x the baseline is not an improvement for production use.

---

Last updated: 2026-03-10

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

30. **The Register -- Agile + AI Anniversary (Thoughtworks event).** https://www.theregister.com/2026/02/20/from_agile_to_ai_anniversary/ -- TDD prevents agents from writing tests that verify broken behavior; engineering discipline relocates rather than disappears; security practices "dangerously behind."

31. **Anthropic Code Review Plugin.** https://github.com/anthropics/claude-code/blob/main/plugins/code-review/README.md -- Official code review plugin for Claude Code.

32. **Human-Written vs AI-Generated Code (ISSRE 2025).** https://arxiv.org/abs/2508.21634 -- 500K+ code samples in Python and Java; AI code simpler but more security vulnerabilities; distinct defect profiles require specialized QA; Orthogonal Defect Classification methodology.

33. **Stack Overflow 2025 Developer Survey -- AI.** https://survey.stackoverflow.co/2025/ai -- 84% use or plan to use AI tools; 46% distrust accuracy; 52% report productivity gains; 66% cite "almost right but not quite" as top frustration; 69% of agent users report increased productivity.

34. **Langflow CVE-2025-3248 -- CISA KEV.** https://www.helpnetsecurity.com/2025/05/06/langflow-cve-2025-3248-exploited/ -- Critical RCE in Langflow < 1.3.0; no input validation or sandboxing; added to CISA KEV catalog May 5, 2025; actively exploited in the wild.

35. **Anthropic -- Claude Code MCP.** https://code.claude.com/docs/en/mcp -- MCP server configuration, scopes (project/user/local), environment variable expansion, Tool Search activation, MAX_MCP_OUTPUT_TOKENS, transport options (stdio/HTTP).

36. **Model Context Protocol -- Introduction.** https://modelcontextprotocol.io/introduction -- MCP architecture overview; primitives (tools/resources/prompts); JSON-RPC 2.0 transport; stdio and streamable HTTP transports; open standard specification.

37. **Speakeasy -- How We Reduced Token Usage by 100x: Dynamic Toolsets.** https://www.speakeasy.com/blog/how-we-reduced-token-usage-by-100x-dynamic-toolsets-v2 -- Three-tool pattern (search/describe/execute) replacing static MCP tool schemas; benchmarks showing 91-97% input token reduction at 40-400 tools; tradeoff analysis (2-3x more calls, ~50% longer execution).

54. **Chroma Research -- Context Rot.** https://research.trychroma.com/context-rot -- Non-linear performance degradation across 18 frontier models at controlled fill levels; practical ceiling at 60-70% of advertised maximum; coherent content degrades faster than shuffled haystacks.

38. **JetBrains Research -- Agent Observation Token Analysis (arXiv:2508.21433).** https://arxiv.org/abs/2508.21433 -- Tool observations comprise 84% of agent context tokens in SWE-bench runs; observation masking achieves 52.7% cost reduction with +1.4% solve rate.

39. **Liu et al. -- Lost in the Middle: How Language Models Use Long Contexts (Stanford, TACL 2024).** https://arxiv.org/abs/2307.03172 -- U-shaped retrieval performance curve; 15-30% degradation for mid-context information; recency-only bias above 50% fill; basis for NUMA-style context engineering frameworks.

40. **Morph -- Compaction vs Summarization.** https://www.morphllm.com/compaction-vs-summarization -- Verbatim compaction achieves 98% retention at 50-70% compression; LLM summarization achieves 37% multi-session retention at 80-90% compression; zero hallucination risk from deletion-based approach.

41. **Packer et al. -- MemGPT: Towards LLMs as Operating Systems (arXiv:2310.08560).** https://arxiv.org/abs/2310.08560 -- LLM context management framed as OS memory paging; main context as RAM, external storage as disk; explicit page-in/page-out operations; evolved into the Letta platform.

42. **AgentIF -- Benchmarking Agent Instruction Following (Tsinghua, arXiv:2505.16944).** https://arxiv.org/abs/2505.16944 -- 707 instructions across 50 real applications; GPT-4o drops from 87% (IFEval) to 58.5% on agentic instructions; best models follow fewer than 30% of instructions; performance approaches zero beyond 6,000 words.

43. **Control Illusion (arXiv:2502.15851).** https://arxiv.org/abs/2502.15851 -- Primary obedience rate of 9.6-45.8% across six models; larger models did not reliably outperform smaller ones; system/user prompt separation provides weak enforcement.

44. **METR -- Algorithmic vs Holistic Evaluation (August 2025).** https://metr.org/blog/2025-08-12-research-update-towards-reconciling-slowdown-with-time-horizons/ -- 38% test-pass rate but 0% of outputs mergeable as-is; gap between automated scoring and real-world code quality.

45. **Cognition AI -- Evaluating Coding Agents.** https://cognition.ai/blog/evaluating-coding-agents -- "Devin-Base" component-swap evaluation methodology; internal "cognition-golden" benchmark on production-scale codebases; isolating model contribution from infrastructure contribution.

46. **Yao et al. -- τ-bench: Tool-Agent-User Interaction Benchmark (arXiv:2406.12045).** https://arxiv.org/abs/2406.12045 -- pass^k metric measuring reliability (all k trials succeed) vs pass@k measuring capability (at least one succeeds); adopted by Anthropic for Claude evaluation.

47. **OpenHands -- Open Platform for AI Software Developers (arXiv:2511.03690).** https://arxiv.org/abs/2511.03690 -- SDK overview covering event-sourced action logging, agent runtime architecture, and platform extensibility. Stuck-detection via cycle monitoring is one component of the broader platform.

48. **Context Length Penalty (arXiv:2510.05381).** https://arxiv.org/abs/2510.05381 -- Isolated length effect from retrieval quality; 13.9-85% performance degradation from input length alone; adding only relevant files still imposes a processing penalty.

49. **Sclar et al. -- Prompt Format Sensitivity (ICLR 2024).** https://arxiv.org/abs/2310.11324 -- Up to 76 percentage point accuracy variation across semantically equivalent prompt formats; sensitivity persists across model sizes and instruction tuning.

50. **HumanLayer -- Instruction Ceiling.** https://www.humanlayer.dev/blog/writing-a-good-claude-md -- Uniform compliance degradation begins around 150-200 instructions; Claude Code's system prompt consumes ~50 of that budget. (See also [5].)

51. **AgentSpec -- Hook-Based Agent Enforcement (arXiv:2503.18666, ICSE 2026).** https://arxiv.org/abs/2503.18666 -- Prevents >90% of unsafe agent executions with millisecond overhead; hook-based enforcement framework; specification-driven safety guarantees.

52. **Conikee -- NUMA-Aware Context Engineering (Substack 2025).** https://substack.com/@conikee -- Framework treating LLM context windows as Non-Uniform Memory Access; causal masking and RoPE position encoding create position-dependent attention; anchor critical facts at front and end, compress the middle.

53. **Serena -- LSP-Powered Code Navigation MCP Server.** https://github.com/oraios/serena -- Symbol-level find, reference lookup, and scoped editing via Language Server Protocol; `--context claude-code` disables tools that duplicate built-ins; `--project-from-cwd` for automatic project detection.
