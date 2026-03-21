# SWE-Bench Benchmarking Methodology

## Overview

This benchmark measures the impact of the agentic coding playbook on automated bug-fixing performance using tasks from [SWE-Bench Lite](https://www.swebench.com/). Each task is run twice: once with a vanilla Claude Code configuration (baseline) and once with the playbook installed.

## Task Selection

Tasks are drawn from SWE-Bench Lite (300 tasks from 12 Python repositories). The default set of 5 tasks is selected for diversity:

| Repository | Count | Bug Type |
|-----------|-------|----------|
| Django | 2 | Web framework (forms, migrations) |
| Requests | 1 | HTTP library (content decoding) |
| SymPy | 1 | Math library (LaTeX rendering) |
| Flask | 1 | Web framework (CLI, imports) |

The `--full` flag runs 25 tasks spanning 8 repositories: Django, Requests, SymPy, Flask, scikit-learn, Matplotlib, Astropy, and Sphinx.

## Execution

Each task follows this flow:

1. **Clone** the target repository at the specified commit.
2. **Prompt** Claude Code with the issue description and instructions to make a minimal fix.
3. **Record** whether any files were modified (resolution signal) and elapsed time.
4. **Save** the diff as a patch file for manual review.

### Environment Isolation

- **Baseline**: Uses a clean temporary HOME with no `.claude/` configuration.
- **Playbook**: Uses a temporary HOME with the playbook installed via `install.sh --force`.
- All Claude Code nesting env vars (`CLAUDE_CODE_SSE_PORT`, etc.) are stripped to prevent interaction with a parent session.

### Model and Tools

- Model: `sonnet` (consistent across both conditions)
- Allowed tools: `Read, Glob, Grep, Write, Edit, Bash`
- Timeout: 300 seconds per task

## Scoring

### Resolution Rate

A task is marked "resolved" if Claude Code modifies at least one file in the repository. This is a necessary but not sufficient condition — the change may not be correct.

### Limitations

1. **No automated test verification.** SWE-Bench Lite tasks include test patches, but running them requires environment-specific setup (virtualenvs, dependencies) that varies per repository. Future versions may add automated test execution.

2. **Resolution ≠ correctness.** The current scoring counts any file modification as a resolution. Manual review of the generated patches is required to assess correctness.

3. **Small sample size.** The default 5-task run is useful for regression testing but not statistically significant. Use `--full` (25 tasks) for more meaningful comparisons.

4. **Cost.** Each task costs approximately $2-5 in API usage. A full 25-task run costs $50-125 total ($100-250 for both conditions).

5. **Non-deterministic.** LLM outputs vary between runs. Results should be averaged across multiple runs for reliable conclusions.

## Interpreting Results

The benchmark is designed to detect large effects (>10% improvement in resolution rate). Expected patterns:

- **Playbook improves structured tasks**: Tasks requiring multi-file changes or debugging should benefit from the Explore-Plan-Code-Verify workflow.
- **Minimal effect on trivial fixes**: Single-line fixes won't benefit much from additional structure.
- **Time may increase**: The playbook encourages exploration before coding, which may increase time-to-resolution even when it improves correctness.

## Running the Benchmark

```bash
# Quick validation (no API calls)
bash scripts/swe-bench.sh --dry-run

# Default 5-task run (~$10-25)
bash scripts/swe-bench.sh

# Full 25-task run (~$100-250)
bash scripts/swe-bench.sh --full
```

Results are written to a temporary directory (printed at the end) as `summary.json` and `summary.md`.
