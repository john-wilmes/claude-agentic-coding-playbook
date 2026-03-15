# Combined Review Findings — 2026-03-15

Two independent reviews of the full codebase at commit d9e7275 (master).

- **Devil's Advocate (DA)**: `/docs/reviews/2026-03-15-da-review.md` — 34 findings
- **CodeRabbit-style (CR)**: `/docs/reviews/2026-03-15-cr-review.md` — 17 findings
- **Unique after dedup**: ~41

## Overlapping Findings

| Issue | DA ID | CR ID | Severity |
|-------|-------|-------|----------|
| md-size-guard malformed output (missing hookSpecificOutput wrapper) | C2 | LOW-1 | CRITICAL |
| bloat-guard uses PPID instead of hookInput.session_id | M1 | MED-2 | MEDIUM |
| session-start dead code exports (parseFrontmatter, scoreEntry) | M4 | CODE-1 | MEDIUM |
| context-guard "hard block" naming vs actual pass-through | C4 | CODE-2 | CRITICAL (DA) / LOW (CR) |
| `q` script stale model ID | L4 | LOW-4 | LOW |
| session-end push failures not surfaced | M2 | LOW-5 | MEDIUM |

## CRITICAL (4) — all from DA

| ID | File | Issue |
|----|------|-------|
| C1 | `templates/hooks/md-size-guard.js:164` | Uses `process.cwd()` instead of `hookInput.cwd` — wrong project path |
| C2 | `templates/hooks/md-size-guard.js:178` | Emits `{ additionalContext }` without `hookSpecificOutput` wrapper — agent never sees warnings |
| C3 | `install.sh:1239` | `local` keyword outside a function body |
| C4 | `install.sh:763` | Comment claims "hard-blocks ALL tools at 60%" but code is pure pass-through |

## HIGH (9) — 8 DA + 1 CR

| ID | Source | File | Issue |
|----|--------|------|-------|
| H1 | DA | `templates/hooks/README.md` | Lists 9 hooks; 16+ exist. Stale hard-block claim. |
| H2 | DA | `README.md:120` | Test count claim inaccurate; test command omits skills tests |
| H3 | DA | `README.md:53-74` | Install tree shows config under `<install-root>/.claude/` — actually `~/.claude/` |
| H4 | DA | `profiles/dev/`, `profiles/research/` | Orphaned profiles, never installed, never tested |
| H5 | DA | `tests/hooks/session-hooks.test.js` | No tests for session-end git auto-commit/push |
| H6 | DA | `README.md:45` | Claims `--root` sends config to `<root>/.claude/` |
| H7 | DA | `scripts/claude-loop.sh` | Requires python3 but install.sh doesn't check |
| H8 | DA | `.github/workflows/test-install.yml` | CI runs only 2 of 19+ hook test suites |
| H9 | CR | `templates/hooks/bloat-guard.js:122-147` | Throwaway files not counted in session escalation — early return skips state tracking |

## MEDIUM (15) — 10 DA + 5 CR (after dedup)

| ID | Source | File | Issue |
|----|--------|------|-------|
| M1 | Both | `templates/hooks/bloat-guard.js:50` | Uses env vars for session ID; counter resets every call |
| M2 | Both | `templates/hooks/session-end.js:80` | Auto-pushes without opt-out; push failures silent |
| M3 | DA | `install.sh:1304` | Knowledge repo clone without `--depth=1` |
| M4 | Both | `templates/hooks/session-start.js:44-92` | Dead code exports (parseFrontmatter, scoreEntry) |
| M5 | DA | `templates/hooks/pre-commit:32` | Credential pattern false-positives on documentation |
| M6 | DA | `README.md:83` | Says `/checkpoint` runs quality gates — it does not |
| M7 | DA | `templates/hooks/context-guard.js:62,73` | Comment says 200KB, code reads 512KB |
| M8 | DA | `templates/hooks/knowledge-capture.js:24` | DB path computed at require() time — stale HOME in tests |
| M9 | DA | `profiles/combined/skills/promote/SKILL.md:51` | References obsolete filesystem knowledge entries path |
| M10 | DA | `profiles/combined/skills/create-project/SKILL.md:27` | Different install root discovery than other skills |
| M11 | DA | `profiles/combined/skills/investigate/SKILL.md:306` | Ambiguous relative path for check-citations.sh |
| M12 | DA | `scripts/claude-loop.sh:563-564,632-633` | Duplicate signal-state reset |
| M13 | CR | `templates/hooks/sanitize-guard.js:147` | Bash PreToolUse deny emits broken redacted commands |
| M14 | CR | `templates/hooks/context-guard.js:119-122` | Omits output_tokens — underestimates usage 5-15% |
| M15 | CR | `templates/hooks/session-start.js:174` | `openDb()` called without path argument |

## LOW (13) — 8 DA + 5 CR (after dedup)

| ID | Source | File | Issue |
|----|--------|------|-------|
| L1 | DA | Various hooks | Inconsistent stdin reading patterns |
| L2 | DA | `bloat-guard.js`, `filesize-guard.js` | Unreachable `process.exit(0)` at module level |
| L3 | DA | `templates/hooks/session-end.js:18` | Shadows `log` naming convention |
| L4 | Both | `scripts/q:18` | Date-pinned model ID |
| L5 | DA | `templates/hooks/md-size-guard.js` | Uses `console.log` instead of `process.stdout.write` |
| L6 | DA | `templates/registry/mcp-servers.json` | Content not validated by tests |
| L7 | DA | `profiles/research/README.md` | Suggests active maintenance for orphaned profile |
| L8 | DA | `README.md:209-213` | Unverified cost estimates |
| L9 | DA | `tests/hooks/fleet-index.test.js` | Test in hooks/ for source in fleet/ |
| L10 | CR | `templates/hooks/pii-detector.js:212` | YAML ` #` stripping breaks regex values |
| L11 | CR | `templates/hooks/stuck-detector.js` | Missing modern test runners (bun, deno, rspec) |
| L12 | CR | `templates/hooks/pr-review-guard.js` | 8s timeout too tight for slow networks |
| L13 | CR | `profiles/combined/skills/continue/SKILL.md:89` | References `knowledge-db.js staged` CLI mode that doesn't exist |

## Code Quality (not bugs, improvement opportunities)

| Source | File | Issue |
|--------|------|-------|
| CR | `templates/hooks/post-tool-verify.js:119` | Non-atomic read-write of shared state file |
| CR | `scripts/claude-loop.sh:533-537` | Subshell PID sources undocumented |
| CR | `install.sh` | 10+ repeated `node -e` blocks for settings.json — should consolidate |
| CR | `templates/hooks/prompt-injection-guard.js:14` | `.env` match pattern too narrow |
| CR | `templates/hooks/pre-compact.js:80` | Snapshot regex edge case at EOF |
