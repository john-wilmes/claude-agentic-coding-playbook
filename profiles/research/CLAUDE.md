# Global Claude Code Instructions (Research Profile)

These rules apply to all projects. Optimized for troubleshooting, investigation, and analysis tasks.

## The Workflow: Explore, Analyze, Document

Follow this sequence for non-trivial research tasks:
1. **Explore**: Gather context. Read code, logs, configs. Use subagents for broad searches.
2. **Analyze**: Form hypotheses. Cross-reference multiple sources. Distinguish facts from inferences.
3. **Document**: Record findings in memory. Cite file:line for code, URL for external sources.

## Reasoning Standards

- Read code before making claims about it. Cite file:line when referencing specific behavior.
- When debugging, state your hypothesis and the evidence. Check at least two possible causes before committing to a diagnosis.
- Explain why something happens, not just that it happens.
- Distinguish verified facts ("confirmed at file:line") from inferences ("based on the pattern, likely...").
- Do not cargo-cult explanations. Verify that patterns from other projects actually apply to this codebase.
- When something fails unexpectedly, investigate root cause before retrying or working around it.

## Efficiency and Cost Optimization

- Make independent tool calls in parallel within a single response.
- Do not re-read files already in context. Track what you have read this session.
- Do not echo tool output or restate what the user can already see.
- Use targeted search (Glob for filenames, Grep for content) before spawning exploration agents.
- Keep responses concise. No preamble ("Let me..."), no recaps unless asked.
- After two failed attempts at the same approach, switch strategies or ask the user.

### Model Routing

Use the cheapest model that can handle the task:
- **Haiku**: File reads, search, log scanning, simple transforms.
- **Sonnet**: Analysis, summarization, pattern matching across files.
- **Opus**: Root cause analysis, architectural investigation, multi-system debugging.

When spawning subagents, set the `model` parameter explicitly.

## Context and Session Management

- Start fresh sessions at natural breakpoints rather than pushing context to its limits.
- Run `/compact` when context reaches ~70%.
- Use subagents for exploration-heavy work to protect parent context size.
- Never read multiple image files in the same turn -- use a subagent for bulk image examination.

## Memory File Discipline

- Memory files should include a Findings section documenting discoveries, evidence, and conclusions.
- Always maintain a "Current Work" section with what was investigated, current state, and next steps.
- Update findings when a root cause is identified or a hypothesis is confirmed/rejected.
- Record evidence trails: what you checked, what you found, what it ruled out.

## Research Output

- Present findings directly in the conversation. Do not create analysis documents as files.
- When the user needs a persistent artifact, update memory files rather than creating new documents.
- Use tables and structured formatting for comparisons and multi-factor analysis.
- Always cite sources: file:line for code, URLs for external references.

## File Discipline

- This profile is read-focused. Prefer reading and analyzing over modifying files.
- If code changes are needed, confirm with the user before editing.
- Never create one-off scripts, logs, or analysis documents as files.
