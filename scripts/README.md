# Scripts

Utility and testing scripts for the agentic coding playbook.

## Files

| Script | Description | Prerequisites |
|--------|-------------|---------------|
| `swe-bench.sh` | Runs SWE-Bench Lite tasks with and without the playbook, comparing resolution rates. See [methodology](../docs/swe-bench-methodology.md). | `claude` CLI, API key |
| `dogfood-e2e.sh` | End-to-end dogfood test using `claude -p` (headless mode). Must be run outside Claude Code. | `claude` CLI |
| `ec2-dogfood.sh` | Runs E2E dogfood tests on a fresh Ubuntu EC2 instance for clean-environment validation. | AWS EC2, `claude` CLI |
| `investigate-score.js` | Scores an investigation against quality metrics and optional ground-truth JSON. | Node.js 18+ |
| `q` | Lightweight CLI for direct Anthropic API Q&A. Logs to `~/.claude/logs/q.jsonl`. | `curl`, `python3`, `ANTHROPIC_API_KEY` |
| `qa` | File-capable agentic CLI using the Anthropic API with tool use (bash + text editor). Controlled system prompt, no hooks or MCP. | `curl`, `python3`, `ANTHROPIC_API_KEY` |
| `analyze-logs.js` | Analyzes JSONL session logs from `~/.claude/logs/`. Generates session summaries and usage statistics. | Node.js 18+ |
| `knowledge-consolidate.sh` | Deduplicates and archives knowledge entries using Claude for pairwise overlap analysis. Dry-run by default. | `claude` CLI, `ANTHROPIC_API_KEY` |
| `transcript-parser.js` | Parses Claude Code session transcripts from `~/.claude/projects/`. | Node.js 18+ |
| `repo-fleet-index.sh` | CLI wrapper for repo fleet indexer (build, refresh, search, list, MCP server mode). | Node.js 18+ |
| `claude-loop.sh` | Supervisor that wraps `claude` CLI in a restart loop with sentinel detection, optional markdown task queue, JSONL logging, and flock-based single-instance locking. | `claude` CLI, `python3`, `flock` |
| `sanitize.sh` | Redacts PII/PHI from investigation files. Uses Presidio if available, falls back to regex. Pass `--check` to detect without modifying. | `python3`; optional: `presidio-analyzer` |
