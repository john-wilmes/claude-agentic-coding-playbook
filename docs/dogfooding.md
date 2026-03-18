# Dogfooding Agentic Coding Workflows

How to empirically validate that your agentic coding setup actually works — not in a demo, but on real codebases under real constraints.

## Why Dogfood

Every practice in a playbook is a claim: "session checkpointing prevents context loss," "model routing saves cost," "quality gates catch regressions." These claims need evidence. Dogfooding is the empirical validation loop — you use your own tooling on your own projects and measure whether the claims hold.

A manual feature checklist (see [dogfood-playbook.md](dogfood-playbook.md)) verifies that things *work*. Dogfooding verifies that things *help*. The difference is between "the checkpoint skill runs without errors" and "the agent actually preserves enough state across 50 multi-session tasks that work isn't lost."

### What dogfooding catches that checklists don't

- **Interaction effects**: hooks that work individually but conflict in combination
- **Threshold tuning**: context limits that are too aggressive or too lenient
- **Emergent behavior**: whether agents spontaneously use features like knowledge capture, or ignore them
- **Scaling failures**: infrastructure that works for 5 tasks but breaks at 50
- **Real-world friction**: setup steps that seem clear but confuse agents in practice

## Designing a Dogfood Campaign

### 1. Choose your projects

Pick 2-3 real codebases you actively maintain. Ideal characteristics:

- **Diverse tech stacks** — a frontend app, a backend service, a monorepo. Different stacks exercise different failure modes.
- **Existing test suites** — you need tests to validate the quality gate loop. Projects with zero tests make it hard to measure whether the agent breaks things.
- **Real backlog** — actual bugs, TODOs, and feature requests. Synthetic tasks don't stress the workflow the same way.
- **Non-trivial size** — large enough that context limits matter and multi-session work is required.

### 2. Identify features under test

List every playbook feature you want to validate. Assign each a short code for tagging tasks.

**Example feature legend:**

| Code | Feature | What it proves |
|------|---------|---------------|
| L1 | Session lifecycle (checkpoint → exit → respawn) | Autonomous exit and respawn works |
| L2 | Context limit handling (auto-checkpoint at threshold) | Thresholds are calibrated correctly |
| L3 | Multi-session continuity (memory handoff) | SessionStart picks up cleanly across sessions |
| H1 | Hook chain (multiple hooks firing together) | Hooks don't conflict |
| H2 | Pre-compaction safety net | Emergency checkpoint fires before context is destroyed |
| Q1 | Quality gate loop (edit → test fail → fix → pass) | Agent iterates on failures instead of skipping them |
| Q2 | Automated code review (pre-commit) | Review catches real issues, not just noise |
| R1 | Research workflow (investigation lifecycle) | Full question → evidence → synthesis → close cycle works |
| A1 | Multi-agent coordination | Cross-agent messaging delivers and agents respond usefully |
| P1 | Plan mode for multi-file changes | Agent plans before coding on complex tasks |
| S1 | Subagent delegation with model routing | Cheaper models handle exploration; expensive models handle architecture |
| E1 | Error recovery | Agent recovers from hook failures, test failures, git conflicts |
| K1 | Knowledge capture and injection | Agent learns from experience and reuses lessons |

### 3. Build the task queue

Design tasks in **phases** that progress from safe to risky:

1. **Stabilize** — run tests, fix existing failures, establish baseline
2. **Test coverage** — add missing tests to create safety nets for later phases
3. **Build** — implement features, fix bugs, add functionality
4. **Infrastructure** — CI, performance, security, accessibility
5. **Stress tests** — intentionally push limits (long sessions, conflict resolution, cross-agent work)

This ordering matters. Phase 1-2 creates the test coverage that protects phase 3-4 work. Phase 5 deliberately tests failure modes. Adapt phase names to your project — a web app might split "Build" into "Backend" and "Frontend" phases.

**Tag every task** with the features it exercises:

```
- [ ] 1. Run full test suite, verify all pass, fix failures (Q1, E1)
- [ ] 2. Add unit tests for payment processing module (Q1)
- [ ] 3. Add unit tests for email handler [SEEDED] (Q1, E1, K1)
```

Tasks tagged with multiple features generate more data per task. A seeded bug task tagged `(Q1, E1, K1)` simultaneously tests whether the quality gate catches the bug (Q1), whether the agent recovers from the initial failure (E1), and whether it captures the lesson afterward (K1).

### 4. Balance bug fixes and enhancements

A 50/50 split between bug fixes and new features tests different cognitive modes:

- **Bug fixes** exercise debugging, hypothesis formation, error recovery
- **Enhancements** exercise planning, architecture, multi-file coordination

Don't invent synthetic bugs for the fix half. Search your actual codebase for TODOs, known issues, tech debt, and error handling gaps. Real bugs produce more realistic agent behavior than contrived ones.

### 5. Design the coverage matrix

Map features to tasks so you can verify that every feature gets exercised multiple times across both projects:

| Feature | Project A Tasks | Project B Tasks |
|---------|----------------|----------------|
| Q1 | 1-50 (most) | 1-50 (most) |
| Q2 | 12, 18, 21, 31 | 2, 7, 19, 22 |
| P1 | 13, 17, 27, 31 | 3, 19, 23, 31 |
| L1 | 12, 46 | 7, 21, 45 |
| E1 | 1, 16, 20, 47 | 1, 46, 47, 50 |
| K1 | 3, 9, 16, 28 | 10, 13, 20, 36 |

Features like Q1 (quality gates) fire on nearly every task. Features like A1 (multi-agent coordination) only fire on specific tasks designed for them. Both are valid — ubiquitous features need breadth, rare features need deliberate coverage.

### 6. Define success criteria

Set pass/fail criteria **before** starting execution so you're not rationalizing results after the fact:

- Zero unrecovered session state losses (L1, L3)
- Sentinel exit works on all lifecycle tasks (L1)
- Emergency checkpoint fires correctly (H2)
- Memory handoff preserves enough context for continuation (L3)
- Model router routes correctly — verify in hook logs (S1)
- Automated review catches at least 1 real issue per review task (Q2)
- Knowledge entries are spontaneously created on at least some seeded-bug tasks (K1)

The K1 threshold depends on how explicitly your CLAUDE.md instructs knowledge capture. If you get zero spontaneous captures, that's a clear signal to strengthen the instructions. Set your own bar based on how directive your workflow rules are.

## Seeded Bugs

Plant intentional errors in the codebase before starting seeded-bug tasks. The agent doesn't know the error exists — it must discover and fix it through normal work.

### Why seed bugs

- **Tests error recovery (E1)** — the agent hits a real failure during a seemingly routine task
- **Tests knowledge capture (K1)** — a non-obvious bug is exactly the kind of thing `/learn` should capture
- **Provides ground truth** — you know the bug, so you can objectively score whether the agent found it, fixed it correctly, and captured the lesson

### Good seeded bugs

Bugs should be **plausible** — the kind of mistake a human might actually make:

| Type | Example | What it tests |
|------|---------|---------------|
| Off-by-one decimal | Confidence threshold `0.9` → `9.0` | Tests notice threshold is out of range |
| Catastrophic regex | `([a-zA-Z0-9]+\.)*` (backtracking) | Performance analysis or input validation |
| Missing dependency | `useEffect` with stale closure | Lint integration and React knowledge |
| Import bloat | Full `lodash` instead of `lodash-es` | Bundle analysis tooling |
| Trailing whitespace in path | `'config.json '` (file-not-found) | Debugging file resolution errors |
| Unanchored regex | `str.match(pattern)` without `^`/`$` | Pattern matching correctness |
| Import shadowing | Module import shadows local variable | Static analysis or careful reading |

**Do not** seed bugs that would be caught by a compiler or type checker before the agent even runs tests. The bug should survive initial compilation and only surface during testing, analysis, or runtime.

### When to plant seeds

**Plant each seed just before its task, not all at once.** If Task 1 is "run the full test suite," any seed that causes a test or build failure will be found immediately — before the agent reaches the intended [SEEDED] task. This burns the seed (E1/K1 data is lost for that task) and worse, the agent may log "fixed seeded bug" in its memory, priming it to look for planted bugs in all future tasks.

In a real campaign, three of four seeds in one project were discovered during Task 1 because they caused test failures, build errors, or lint warnings when the existing suite ran. The fourth seed (an unanchored regex) survived because no tests exercised that code path yet.

**The rule:** a seed must only be discoverable by the new code the agent writes for its specific task. If the existing test suite would catch it, either:
- Plant it just before the [SEEDED] task starts (not at campaign start)
- Choose a bug type that requires new tests to surface (e.g., an unanchored regex in untested code, not a broken import that fails the build)

### Documenting seeds

Keep a private manifest mapping task numbers to planted bugs. Store it outside the project repos — in a separate coordinator directory or in the playbook's own memory. Agents working on the target projects should not have access to this file:

```markdown
## Seeded Bugs

| Task | Project | Bug | How planted |
|------|---------|-----|-------------|
| 3 | project-a | Confidence threshold 0.9 → 9.0 | Changed in media-validator.ts:47 |
| 16 | project-a | Catastrophic regex backtracking | Added to email-validation.ts:12 |
| 10 | project-b | Trailing space in config path | Changed in settings.ts:89 |
```

## Knowledge Capture Testing (K1)

K1 tests a two-part question: *does the agent learn?* and *does the infrastructure feed lessons back?*

### Observational testing (spontaneous learning)

On seeded-bug tasks, **do not** tell the agent to run `/learn`. Tag the task with K1 and check afterward whether it captured a knowledge entry. This tests whether your workflow instructions (CLAUDE.md rules, skill descriptions) are sufficient to trigger learning behavior without explicit prompting.

Score K1 on three criteria:
1. Did the agent run `/learn` after discovering something non-obvious?
2. Is the entry well-formed (structured frontmatter, context, fix)?
3. Is the content useful (not trivially obvious)?

### Infrastructure verification (injection pipeline)

On later tasks, explicitly instruct the agent to verify that prior `/learn` entries are being injected by the session-start hook. This tests the plumbing independently of agent behavior.

### The fallback pattern

These two signals have a dependency: if agents don't learn on early tasks, later verification tasks have nothing to check. Add a fallback to verification tasks:

> If no prior `/learn` entries exist for this project, score K1 as **fail** for the upstream tasks that should have produced them. Then manually create a test knowledge entry so you can still verify the injection infrastructure works. This separates the two signals — "does the agent learn spontaneously?" and "does the injection pipeline work?" — so one failure doesn't cascade into lost coverage on both.

This design ensures you always get data on both questions, even if one half fails.

## Result Collection

### Per-task reporting

After every task, the agent appends a structured result row:

```markdown
## Results

| Task | Feature | Result | Notes |
|------|---------|--------|-------|
| 1 | Q1 | pass | Tests failed on first run, fixed import path, all green |
| 1 | E1 | pass | Recovered from 3 test failures without manual intervention |
| 3 | Q1 | pass | Tests caught seeded bug (threshold 9.0), agent fixed it |
| 3 | E1 | pass | Agent debugged failing assertion, traced to config value |
| 3 | K1 | fail | Agent fixed bug but did not run /learn |
```

One row per feature exercised. If a feature was tagged but didn't activate (e.g., tests passed first try so Q1 never iterated), record it as `skip` with explanation.

### Aggregation

Write a script that reads result tables from all projects and tallies by feature.

Usage: `bash aggregate.sh project-a/dogfood-tasks.md project-b/dogfood-tasks.md`

```bash
#!/bin/bash
# Collect results from all project task queues and summarize by feature

for project_file in "$@"; do
    # Extract lines from the Results section (flag-based, POSIX-portable)
    awk 'found && /^\|/ && !/Task/ {print} /^## Results/ {found=1}' "$project_file"
done | awk -F'|' '{
    feature = $3; gsub(/^ +| +$/, "", feature)
    result = $4; gsub(/^ +| +$/, "", result)
    key = feature "," result
    counts[key]++
    if (!(feature in seen)) { seen[feature] = 1; features[++n] = feature }
} END {
    for (i = 1; i <= n; i++) {
        f = features[i]
        printf "%s: pass=%d fail=%d skip=%d\n", f,
            counts[f ",pass"]+0, counts[f ",fail"]+0, counts[f ",skip"]+0
    }
}'
```

## Worked Example: 100-Task Campaign

This is a real dogfood campaign run against two production TypeScript projects (a web application and a monorepo analysis tool). Project-specific details are generalized.

### Scale

- 2 projects, 50 tasks each, 5 phases per project
- 13 features under test
- 8 seeded bugs (4 per project)
- Estimated ~100 session transitions (assuming ~2 sessions per task on average)

### Task queue structure (Project A — web application)

**Phase 1: Stabilize (tasks 1-12)**
```
- [ ] 1. Run full test suite, fix failures (Q1, E1)
- [ ] 2. Add unit tests for server-side handler A (Q1)
- [ ] 3. Add unit tests for server-side handler B [SEEDED] (Q1, E1, K1)
- [ ] 4-8. Add unit tests for remaining handlers (Q1)
- [ ] 9. Verify knowledge injection + add integration test (Q1, S1, K1)
- [ ] 10. Add integration test for secondary flow (Q1, S1)
- [ ] 11. Raise coverage threshold and make it pass (Q1, L2)
- [ ] 12. Full codebase review, fix all findings (Q2, L1)
```

**Phase 2: Backend improvements (tasks 13-22)**
```
- [ ] 13. Add retry logic with backoff (P1, Q1)
- [ ] 14. Add structured logging across all handlers (P1, L2)
- [ ] 15-16. Data lifecycle improvements [one SEEDED] (Q1, E1, K1)
- [ ] 17-22. API hardening — validation, rate limiting, error handling (P1, Q1, Q2)
```

**Phase 3: Frontend features (tasks 23-34)**
```
- [ ] 23-25. UI components — loading states, gallery, navigation (Q1)
- [ ] 26. Form validation improvements [SEEDED] (Q1, E1, K1)
- [ ] 27. Feature requiring multi-file coordination (P1, Q1)
- [ ] 28. Verify knowledge injection + search/filter feature (Q1, K1)
- [ ] 29-34. Remaining UI features and optimizations (Q1, P1, L2, Q2)
```

**Phase 4: Infrastructure (tasks 35-42)**
```
- [ ] 35-36. E2E test suites (Q1, S1)
- [ ] 37. CI pipeline improvements (P1, Q1)
- [ ] 38. Bundle analysis [SEEDED] (S1, Q1, E1, K1)
- [ ] 39-42. Performance, SEO, accessibility, security audits (R1, P1, Q2)
```

**Phase 5: Stress tests (tasks 43-50)**
```
- [ ] 43-45. Research investigations (R1, S1)
- [ ] 46. Cross-agent pipeline task (A1, L1)
- [ ] 47. Intentional merge conflict resolution (E1, Q1)
- [ ] 48. Expand regression suite (Q1, L3)
- [ ] 49. Load/stress testing (R1, E1)
- [ ] 50. Intentional long session — skip checkpointing to verify safety net (H2, L2, E1)
```

### Key design decisions

**Phased progression**: stabilize and add tests first (phases 1-2) so later phases have safety nets. If the agent breaks something in phase 3, existing tests catch it.

**Seeded bugs at phase boundaries**: place seeded bugs early enough that K1 verification tasks can check injection later. Task 3 seeds a bug → task 9 checks if the lesson was injected. Task 16 seeds → task 28 verifies.

**Stress tests last**: phase 5 deliberately pushes limits — long sessions, cross-agent work, conflict resolution. These are the highest-risk tasks and benefit from all the test coverage built in earlier phases.

**50/50 split**: roughly half the tasks are fixing bugs or adding tests (reactive), half are building features or improving infrastructure (proactive). This exercises both debugging and planning cognitive modes.

### Running execution

Each project gets its own agent session running in a loop. A session loop is a wrapper script that:
1. Launches a Claude Code session in the project directory
2. Waits for the session to end (via `/checkpoint` writing a sentinel exit file)
3. Respawns a new session, which picks up via SessionStart memory injection

The agent reads its task queue on startup (injected by SessionStart), finds the first unchecked task, works through it, appends results, and checkpoints. The loop respawns for the next task. No human intervention is needed during normal execution — review results periodically and investigate any failed features.

## Real-World Results: Focused Campaign (v2)

The following results come from a 14-task focused campaign run across two production projects (a React/Vite auction platform and a TypeScript monorepo static analysis toolchain). The campaign validated 7 playbook features using 7 tasks per project.

### Feature results

| Feature | Description | Project A | Project B |
|---------|-------------|-----------|-----------|
| K1 | Spontaneous `/learn` after discoveries | PASS | PASS |
| PR | `/promote` lesson to global scope | PASS | PASS |
| K2 | Knowledge injection in next session | PASS | SKIP (deferred) |
| R1 | `/investigate` full lifecycle | PASS | PASS |
| P1 | Plan mode for multi-file changes | PASS | pending |
| MR | Model-router auto-selects tier | PASS | pending |
| L1 | `/checkpoint` sentinel exit | PASS | pending |

Project A completed all 7 tasks (7/7 PASS). Project B completed 4/7 (3 pending due to session limits).

### Emergent findings

The most valuable outcomes were **unplanned discoveries** — behaviors not covered by any task's success criteria:

1. **Context safeguards fail on multi-file edits.** Instruction-based thresholds ("compact at 60%") are ignored when a single turn edits 14+ files. Each Edit/Read tool call returns file contents, spiking context 20-30% in one turn. **Fix:** System-level PostToolUse hooks that track cumulative tool result size, not instruction-based reminders.

2. **Post-compaction amnesia.** After auto-compaction, agents lose awareness of task queues and go freelance — working on whatever seems interesting rather than the next queued task. Memory files survive but the agent doesn't re-read them without a fresh session. **Fix:** Session loop (`claude-loop`) that respawns after compaction, relying on SessionStart to reinject memory.

3. **Agents don't self-advance through task queues.** "Work through tasks in order" is insufficient. Agents complete one task and wait for user input. **Fix:** `claude-loop --task-queue` flag that auto-advances, or explicit "after completing this task, read the queue and start the next one" instructions.

4. **Hook output structure is silently fragile.** The model-router hook's `updatedInput` field must be nested inside `hookSpecificOutput`, not at the top level of the JSON output. Top-level placement silently fails — the hook executes without error but the input modification is ignored. No warning, no log entry. **Fix:** Integration tests for hook output structure, not just hook execution.

5. **Seeded bug tags defeat their purpose.** Marking tasks with `[SEEDED]` tells the agent a bug exists, turning discovery into treasure hunting. The agent searches for anomalies rather than discovering them through normal work. **Fix:** Plant bugs silently before the session, or use naturally-occurring bugs instead.

### Implications for the playbook

These findings led to three new infrastructure components:
- **context-guard hook** — PostToolUse hook that tracks cumulative tool result size and warns/blocks at configurable thresholds
- **claude-loop --task-queue** — automation flag that advances through a task queue file across session boundaries
- **model-router fix** — corrected JSON nesting for `updatedInput` in `hookSpecificOutput`

## Interpreting Results

### Feature-level analysis

After the campaign, aggregate results by feature code. Look for:

- **Features with >10% failure rate** — these need investigation. Is the feature broken, or are the tasks poorly designed?
- **Features that never activated** (all `skip`) — the tasks didn't trigger the feature. Redesign those tasks.
- **E1 failures on seeded bugs** — the agent didn't recover from a known error. Check whether the quality gates caught the bug but the agent ignored the signal.
- **K1 failures** — the agent didn't learn. Consider whether your CLAUDE.md instructions about knowledge capture are clear enough.

### Cross-project comparison

If the same feature passes in one project but fails in another, the issue is likely project-specific (tech stack, test setup, codebase complexity) rather than a playbook problem.

### Iteration

Dogfooding is not one-and-done. After fixing issues found in the first campaign:

1. Update the playbook practices
2. Design a smaller follow-up campaign (20-30 tasks) targeting the failed features
3. Re-run and compare

The goal is convergence: each round should produce fewer failures than the last.

## Related

- [Dogfood Playbook](dogfood-playbook.md) — manual interactive testing checklist for verifying installation and basic feature functionality (~30 minutes)
- [Best Practices Guide](best-practices.md) — the evidence-backed practices being validated
