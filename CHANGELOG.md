# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `--status-json` flag for claude-loop programmatic status checks
- Implicit task completion in claude-loop (exit 0 + uncommitted changes = success)
- `--version` flag, `--report` task queue section, and `[FAIL]` recovery for claude-loop
- Task-too-big detection and task-sizing guidelines for claude-loop
- Auto-commit on task completion in claude-loop Ralph Loop mode
- Access tracking and decay for knowledge entries
- Retrieval miss detection at session end (knowledge system)
- Enriched knowledge retrieval with Current Work terms from MEMORY.md
- Read-once deduplication hook for 38-40% file-read context savings
- Block 6 additional credential directories per Trail of Bits recommendations
- Close readiness gaps: --uninstall flag, Node v18+ version check, session-end tests, analyze-logs tests, sanitize tests
- Sycophancy-detector PostToolUse hook with three behavioral signals
- Session timeline (`--timeline`) and aggregate metrics (`--aggregate`) for analyze-logs

### Fixed

- Leading dash in CWD path encoding for project memory lookup
- Auto-send initial prompt in claude-loop interactive mode
- Knowledge scoring category bias removed
- claude-loop advances to next task after failed task exhausts retries
- Correct 5 misattributed citations, add 5 orphan citations, fix model routing advice
- MCP registry test count mismatch

## [1.0.0] - 2026-02-24

Initial public release.

### Added

- Evidence-based best practices guide with 54 verified citations
- 22 hooks for safety, quality, and resource management
- 6 skills: /checkpoint, /create-project, /playbook, /learn, /promote, /investigate
- CLI tools: q, qa, claude-loop, knowledge-consolidate, repo-fleet-index
- Cross-platform install script with --dry-run, --wizard, --force modes
- Pre-commit hook with secret detection and large file blocking
- Structured investigation workflow for research
- Comprehensive CI with markdown lint, link checking, and install validation
- Dogfooding methodology with worked examples
- SWE-Bench benchmark harness
