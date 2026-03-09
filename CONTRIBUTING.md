# Contributing to the Agentic Coding Playbook

Thank you for your interest in contributing. This guide explains how to submit issues, propose changes, and maintain the quality standards that make this resource trustworthy. See the [README](README.md) for an overview of the project.

---

## How to Contribute

**Reporting issues**
Open a GitHub issue with a clear title and description. For factual corrections, include the specific claim, why it is wrong, and a source supporting the correction.

**Submitting pull requests**
1. Fork the repository and create a branch from the default branch.
2. Make your changes following the style guide below.
3. Open a pull request with a concise description of what changed and why.
4. Address reviewer feedback promptly.

**Discussion etiquette**
- Be specific. Vague feedback is hard to act on.
- Cite sources when challenging a claim or proposing new content.
- Assume good faith. Disagreements should focus on evidence, not intent.

---

## Citation Standards

Every citation in this repository must include:

1. **Source URL** -- a stable, publicly accessible link.
2. **At least one key metric or finding** -- a concrete data point or conclusion from the source.

**Format** (numbered markdown list, matching `best-practices.md`):

```markdown
N. **Author/Org -- Title.** URL -- Key findings.
```

**Example:**

```markdown
35. **McKinsey -- The economic potential of generative AI.** https://example.com -- Developers using AI assistants completed tasks 55% faster in controlled studies.
```

Citations are numbered sequentially in order of first appearance in `best-practices.md`. Do not skip numbers. If a source is cited more than once, use the same number throughout. In body text, reference citations with bracket notation: `[N]`.

Before submitting a PR that adds or modifies citations, verify each URL is live and the quoted finding accurately reflects the source.

---

## Style Guide for best-practices.md

**Section numbering**
Top-level sections use integer headings (`## 1. Section Name`). Subsections use decimal notation (`### 1.1 Subsection Name`). Do not skip levels.

**Inline citations**
Place citation references immediately after the claim they support, using the format `[N]`. Multiple citations for a single claim are comma-separated: `[3, 7]`. Do not place citations inside code blocks.

**Direct quotes**
Use a blockquote with attribution on the line immediately following:

```markdown
> "Exact quoted text from the source."
>
> -- Author, *Title* [N]
```

Do not paraphrase inside a blockquote. If you are not quoting verbatim, use normal prose with a citation.

**Comparison tables**
Use a markdown table with a header row and alignment markers. Include a source row or caption below the table if the data comes from a specific study:

```markdown
| Approach | Metric A | Metric B |
|----------|----------|----------|
| Option 1 | ...      | ...      |
| Option 2 | ...      | ...      |

*Source: [N]*
```

**General prose**
- Use active voice.
- Keep sentences short and direct.
- Do not use emojis.
- Spell out abbreviations on first use.

---

## Code of Conduct

This project follows the [Contributor Covenant v2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/). By participating, you agree to uphold its standards. Report violations to the repository maintainers via a private GitHub message or email listed in the repository contact information.

---

## Local Testing

The install script supports a `--dry-run` flag that prints actions without modifying your system. Always test with dry-run before reporting an installation bug.

```bash
bash install.sh --profile dev --dry-run
```

CI runs automatically on every push to `master` and validates that the install script completes without error in a clean environment.

