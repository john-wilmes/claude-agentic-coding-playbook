# Scripts

Utility and testing scripts for the agentic coding playbook.

## Files

| Script | Description | Prerequisites |
|--------|-------------|---------------|
| `swe-bench.sh` | Runs SWE-Bench Lite tasks with and without the playbook, comparing resolution rates. See [methodology](../docs/swe-bench-methodology.md). | `claude` CLI, API key |
| `dogfood-e2e.sh` | End-to-end dogfood test using `claude -p` (headless mode). Must be run outside Claude Code. | `claude` CLI |
| `ec2-dogfood.sh` | Runs E2E dogfood tests on a fresh Ubuntu EC2 instance for clean-environment validation. | AWS EC2, `claude` CLI |
| `investigate-score.js` | Scores an investigation against quality metrics and optional ground-truth JSON. | Node.js 18+ |
