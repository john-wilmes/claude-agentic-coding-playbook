# Global Claude Code Instructions (Investigation Profile)

These rules apply to all projects. Optimized for structured investigations: understanding systems, diagnosing issues, and building retrievable knowledge.

## The Workflow: Question, Collect, Synthesize, Close

Follow this lifecycle for non-trivial investigations:
1. **Question**: Define a scoped question in a brief (10 lines max). Use `/investigate <id> new`.
2. **Collect**: Gather evidence one piece at a time. Each observation is 3 lines max with source and relevance.
3. **Synthesize**: Condense evidence into findings that answer the question. Cite evidence by number.
4. **Close**: Classify with tags, extract reusable patterns, sanitize PII/PHI.

Investigations live at `~/.claude/investigations/<id>/`. Use `/investigate` to manage the lifecycle.

## Reasoning Standards

- Read code before making claims about it. Cite file:line when referencing specific behavior.
- When debugging, state your hypothesis and the evidence. Check at least two possible causes before committing to a diagnosis.
- Explain why something happens, not just that it happens.
- Distinguish verified facts ("confirmed at file:line") from inferences ("based on the pattern, likely...").
- Do not cargo-cult explanations. Verify that patterns from other projects actually apply to this codebase.
- When something fails unexpectedly, investigate root cause before retrying or working around it.

## Evidence Discipline

- Each evidence file captures one observation: source, relevance, and 3-line max description.
- Number evidence sequentially (001, 002, ...). Reference by number in findings.
- Record what you found, not what it means. Interpretation belongs in synthesis.
- Always include the source (file:line, URL, command output) so evidence is verifiable.

## Efficiency and Cost Optimization

- Make independent tool calls in parallel within a single response.
- Do not re-read files already in context. Track what you have read this session.
- Do not echo tool output or restate what the user can already see.
- Use targeted search (Glob for filenames, Grep for content) before spawning exploration agents.
- Keep responses concise. No preamble, no recaps unless asked.
- After two failed attempts at the same approach, switch strategies or ask the user.

### Model Routing

When spawning subagents via the Task tool, ALWAYS set the `model` parameter.
Never rely on inheritance — it defaults to the parent model (usually the most
expensive). Cost ratios are 1x (haiku) : 3x (sonnet) : 5x (opus).

Decision tree:
1. Task reads logs, scans files, or searches for patterns? -> `model: "haiku"`
2. Task analyzes evidence, summarizes findings, or matches patterns? -> `model: "sonnet"`
3. Task performs root cause analysis, cross-system debugging, or architectural investigation? -> `model: "opus"`

When in doubt, choose the cheaper option. A model-router hook auto-selects
when you forget, but explicit is better than implicit.

## Context and Session Management

- Start fresh sessions at natural breakpoints rather than pushing context to its limits.
- Run `/compact` when context reaches ~70%.
- Use subagents for exploration-heavy work to protect parent context size.
- Never read multiple image files in the same turn -- use a subagent for bulk image examination.
- Use `/continue` at session start to see open investigations and project state.

## PII/PHI Protection

- When recording evidence or findings, use placeholders for identifiers: `[PATIENT]`, `[MRN]`, `[SSN]`, `[DOB]`.
- At close time, Presidio auto-sanitization runs if installed. Otherwise, review manually before sharing.
- Never commit unsanitized investigation files to shared repositories.

## File Discipline

- Investigation files belong in `~/.claude/investigations/`, not in project repos.
- This profile is read-focused for project code. Prefer reading and analyzing over modifying.
- If code changes are needed, confirm with the user before editing.
- Never create one-off scripts, logs, or analysis documents as files in project repos.
- Present analysis directly in the conversation. Use investigation files for persistent artifacts only.
