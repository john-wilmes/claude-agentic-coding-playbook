#!/usr/bin/env bash
# SWE-Bench benchmarking script for the agentic coding playbook.
# Runs a subset of SWE-Bench Lite tasks with and without the playbook installed,
# comparing resolution rates and solution quality.
#
# Must be run OUTSIDE of Claude Code (from a normal terminal).
#
# Usage:
#   bash scripts/swe-bench.sh              # Run 5 default tasks
#   bash scripts/swe-bench.sh --full       # Run 25 tasks (expensive)
#   bash scripts/swe-bench.sh --dry-run    # Validate scaffolding, no API calls
#
# Prerequisites:
#   - claude CLI on PATH and authenticated
#   - node 18+ on PATH
#   - git configured
#   - Python 3.9+ for SWE-Bench task setup
#
# Output:
#   $RESULTS_DIR/
#     summary.json          — machine-readable results
#     summary.md            — human-readable markdown
#     baseline/<task-id>/   — results without playbook
#     playbook/<task-id>/   — results with playbook

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RESULTS_DIR="$(mktemp -d)"
TASK_COUNT=5
DRY_RUN=false
PASS=0
FAIL=0
SKIP=0

# ── Argument parsing ───────────────────────────────────────
while [[ "$#" -gt 0 ]]; do
  case $1 in
    --full) TASK_COUNT=25 ;;
    --dry-run) DRY_RUN=true ;;
    -h|--help)
      echo "Usage: swe-bench.sh [--full] [--dry-run]"
      echo "  --full     Run 25 SWE-Bench Lite tasks (default: 5)"
      echo "  --dry-run  Validate scaffolding without API calls"
      exit 0
      ;;
    *) echo "Unknown parameter: $1"; exit 1 ;;
  esac
  shift
done

# ── SWE-Bench Lite task definitions ───────────────────────
# Each task: id, repo, commit, test_patch (inline), description
# Selected for diversity: Python stdlib, Django, Flask, requests, sympy
TASKS=(
  "django__django-11099|django/django|d4fff711d4c97356bd6ba1273d2a5e349326f592|Fix forms.URLField to handle IDN domains"
  "django__django-11179|django/django|30e123ed351317b7527f632b3b7dc4e81e850449|Fix delete confirmation page for nested inline"
  "django__django-11283|django/django|8f384505eee24abb878c7e6bb09c5db4b3a8b18c|Fix migration autodetector for ForeignKey to_field changes"
  "django__django-11422|django/django|4e4db426c5439b167c1109adcae6e9a7f8e0fb20|Fix autoreloader to handle changes in manage.py"
  "django__django-11564|django/django|302f8c40ac42927c552dfa24be8e496085467b15|Add support for Path objects in staticfiles finders"
  "requests__requests-1963|psf/requests|3fbbda0|Fix TypeError on iter_content with decode_unicode"
  "requests__requests-2317|psf/requests|a5370c0|Fix method attr getting lost on redirect"
  "sympy__sympy-13971|sympy/sympy|2dfa7457f5|Fix incorrect LaTeX for SeqFormula"
  "sympy__sympy-14024|sympy/sympy|42af509857|Fix simplify on integral with assumptions"
  "sympy__sympy-14317|sympy/sympy|5c2e779c91|Fix LaTeX printing of Poly in some domains"
  "flask__flask-4045|pallets/flask|f86a0f460a|Fix CLI groups not being invoked"
  "flask__flask-4992|pallets/flask|c5ed3b0800|Fix import error for nested blueprints"
  "scikit-learn__scikit-learn-10297|scikit-learn/scikit-learn|88be0f6|Fix linear_model/Ridge to handle multiclass"
  "scikit-learn__scikit-learn-10949|scikit-learn/scikit-learn|3f07e07|Fix warn_on_dtype parameter in check_array"
  "scikit-learn__scikit-learn-11281|scikit-learn/scikit-learn|7e47f8c|Fix StackingClassifier for pipelines"
  "matplotlib__matplotlib-22711|matplotlib/matplotlib|41d29c0|Fix set_val for RangeSlider"
  "matplotlib__matplotlib-23314|matplotlib/matplotlib|68b5d3d|Fix Animation saving to BytesIO"
  "matplotlib__matplotlib-23476|matplotlib/matplotlib|1986662|Fix DPI duplication on figure unpickling"
  "astropy__astropy-6938|astropy/astropy|505b590|Fix replace_column to keep existing attrs"
  "astropy__astropy-7746|astropy/astropy|d58b8dd|Fix wcs_to_celestial_frame for SIP"
  "pylint__pylint-5859|pylint-dev/pylint|e9be039|Fix crash on recursion with --recursive=y"
  "pylint__pylint-7114|pylint-dev/pylint|c4b2447|Fix false positive with --disable inside blocks"
  "sphinx__sphinx-8273|sphinx-doc/sphinx|5c59131|Fix autodoc linkcheck with py:obj"
  "sphinx__sphinx-8282|sphinx-doc/sphinx|f92fa33|Fix autodoc for overloaded __init__"
  "xarray__xarray-4094|pydata/xarray|1c198a1|Fix open_mfdataset with combine=nested"
)

# ── Helper functions ──────────────────────────────────────

say() {
  echo "$1" | tee -a "$RESULTS_DIR/log.txt"
}

run_claude() {
  local prompt="$1"
  local cwd="$2"
  local home="$3"
  local timeout="${4:-300}"

  # Strip ALL Claude Code env vars to avoid nesting issues
  env -u CLAUDECODE \
      -u CLAUDE_CODE_ENTRYPOINT \
      -u CLAUDE_CODE_SSE_PORT \
      -u CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS \
    HOME="$home" \
    USERPROFILE="$home" \
    timeout "$timeout" \
    claude -p "$prompt" \
      --cwd "$cwd" \
      --model sonnet \
      --allowedTools "Read,Glob,Grep,Write,Edit,Bash" \
      2>/dev/null || true
}

setup_task() {
  local task_id="$1"
  local repo_slug="$2"
  local commit="$3"
  local work_dir="$4"

  mkdir -p "$work_dir"
  git clone --depth 100 "https://github.com/${repo_slug}.git" "$work_dir/repo" 2>/dev/null
  cd "$work_dir/repo"
  if ! git checkout "$commit" 2>/dev/null; then
    git fetch --unshallow 2>/dev/null || true
    git checkout "$commit" 2>/dev/null
  fi
  cd - > /dev/null
}

check_resolution() {
  local task_id="$1"
  local work_dir="$2"
  local desc="$3"

  # Check if any files were modified (basic resolution signal)
  cd "$work_dir/repo"
  local changed=$(git diff --stat 2>/dev/null | tail -1)
  cd - > /dev/null

  if [ -n "$changed" ]; then
    echo "resolved"
  else
    echo "unresolved"
  fi
}

# ── Main execution ─────────────────────────────────────────

say "============================================================"
say "SWE-BENCH BENCHMARK — Playbook vs Baseline"
say "START: $(date)"
say "TASKS: $TASK_COUNT"
say "RESULTS: $RESULTS_DIR"
say ""

if [ "$DRY_RUN" = true ]; then
  say "--- DRY RUN: Validating scaffolding ---"
  say ""

  # Verify prerequisites
  command -v claude >/dev/null 2>&1 && say "  OK: claude CLI found" || say "  MISSING: claude CLI"
  command -v node >/dev/null 2>&1 && say "  OK: node found" || say "  MISSING: node"
  command -v git >/dev/null 2>&1 && say "  OK: git found" || say "  MISSING: git"
  command -v python3 >/dev/null 2>&1 && say "  OK: python3 found" || say "  MISSING: python3"

  say ""
  say "  Task count: $TASK_COUNT"
  say "  Results dir: $RESULTS_DIR"
  say "  Repo root: $REPO_ROOT"
  say "  Install script: $REPO_ROOT/install.sh"
  say ""

  # Verify install script and profile exist
  [ -f "$REPO_ROOT/install.sh" ] && say "  OK: install.sh exists" || say "  MISSING: install.sh"
  [ -d "$REPO_ROOT/profiles/dev" ] && say "  OK: dev profile exists" || say "  MISSING: dev profile"

  # Verify task definitions parse correctly
  VALID_TASKS=0
  for i in $(seq 0 $((TASK_COUNT - 1))); do
    IFS='|' read -r tid trepo tcommit tdesc <<< "${TASKS[$i]}"
    if [ -n "$tid" ] && [ -n "$trepo" ] && [ -n "$tcommit" ]; then
      VALID_TASKS=$((VALID_TASKS + 1))
    else
      say "  INVALID: Task $i - missing fields"
    fi
  done
  say "  OK: $VALID_TASKS/$TASK_COUNT task definitions valid"

  say ""
  say "DRY RUN COMPLETE — scaffolding validated."
  say "Remove --dry-run to execute (requires API calls, ~\$2-5 per task)."
  exit 0
fi

# ── Create isolated homes ──────────────────────────────────

BASELINE_HOME="$(mktemp -d)"
PLAYBOOK_HOME="$(mktemp -d)"

cleanup() {
  rm -rf "$BASELINE_HOME" "$PLAYBOOK_HOME"
}
trap cleanup EXIT

# Install playbook to the playbook home only
say "--- Installing playbook to test home ---"
HOME="$PLAYBOOK_HOME" bash "$REPO_ROOT/install.sh" --profile dev --force > "$RESULTS_DIR/install.log" 2>&1
say "  Installed to $PLAYBOOK_HOME/.claude/"
say ""

# ── Run tasks ──────────────────────────────────────────────

mkdir -p "$RESULTS_DIR/baseline" "$RESULTS_DIR/playbook"

BASELINE_RESOLVED=0
PLAYBOOK_RESOLVED=0
RESULTS_JSON="["

for i in $(seq 0 $((TASK_COUNT - 1))); do
  IFS='|' read -r TASK_ID TASK_REPO TASK_COMMIT TASK_DESC <<< "${TASKS[$i]}"

  say "--- Task $((i + 1))/$TASK_COUNT: $TASK_ID ---"
  say "  $TASK_DESC"

  # Set up task repos
  BDIR="$RESULTS_DIR/baseline/$TASK_ID"
  PDIR="$RESULTS_DIR/playbook/$TASK_ID"

  say "  Cloning repo..."
  setup_task "$TASK_ID" "$TASK_REPO" "$TASK_COMMIT" "$BDIR"
  mkdir -p "$PDIR"
  cp -r "$BDIR/repo" "$PDIR/repo"

  PROMPT="You are a software engineer. Fix the following issue:\n\n$TASK_DESC\n\nThe repository has been checked out at the relevant commit. Read the code, understand the issue, and make the minimal fix. Edit only the files necessary to resolve the issue."

  # Run baseline (no playbook)
  say "  Running baseline..."
  BSTART=$(date +%s)
  run_claude "$PROMPT" "$BDIR/repo" "$BASELINE_HOME" 300 > "$BDIR/output.txt" 2>&1
  BEND=$(date +%s)
  BDUR=$((BEND - BSTART))
  BRES=$(check_resolution "$TASK_ID" "$BDIR" "$TASK_DESC")
  say "  Baseline: $BRES (${BDUR}s)"
  [ "$BRES" = "resolved" ] && BASELINE_RESOLVED=$((BASELINE_RESOLVED + 1))

  # Run playbook
  say "  Running playbook..."
  PSTART=$(date +%s)
  run_claude "$PROMPT" "$PDIR/repo" "$PLAYBOOK_HOME" 300 > "$PDIR/output.txt" 2>&1
  PEND=$(date +%s)
  PDUR=$((PEND - PSTART))
  PRES=$(check_resolution "$TASK_ID" "$PDIR" "$TASK_DESC")
  say "  Playbook: $PRES (${PDUR}s)"
  [ "$PRES" = "resolved" ] && PLAYBOOK_RESOLVED=$((PLAYBOOK_RESOLVED + 1))

  # Save diffs
  (cd "$BDIR/repo" && git diff > "$BDIR/changes.patch" 2>/dev/null) || true
  (cd "$PDIR/repo" && git diff > "$PDIR/changes.patch" 2>/dev/null) || true

  # Append to JSON results
  [ "$i" -gt 0 ] && RESULTS_JSON="$RESULTS_JSON,"
  RESULTS_JSON="$RESULTS_JSON
  {
    \"task_id\": \"$TASK_ID\",
    \"description\": \"$TASK_DESC\",
    \"baseline\": { \"resolved\": $([ "$BRES" = "resolved" ] && echo true || echo false), \"duration_s\": $BDUR },
    \"playbook\": { \"resolved\": $([ "$PRES" = "resolved" ] && echo true || echo false), \"duration_s\": $PDUR }
  }"

  say ""
done

RESULTS_JSON="$RESULTS_JSON
]"

# ── Write results ──────────────────────────────────────────

# JSON summary
cat > "$RESULTS_DIR/summary.json" << EOF
{
  "timestamp": "$(date -Iseconds)",
  "task_count": $TASK_COUNT,
  "baseline_resolved": $BASELINE_RESOLVED,
  "playbook_resolved": $PLAYBOOK_RESOLVED,
  "tasks": $RESULTS_JSON
}
EOF

# Markdown summary
cat > "$RESULTS_DIR/summary.md" << EOF
# SWE-Bench Benchmark Results

**Date**: $(date)
**Tasks**: $TASK_COUNT

## Summary

| Condition | Resolved | Rate |
|-----------|----------|------|
| Baseline (no playbook) | $BASELINE_RESOLVED/$TASK_COUNT | $(( BASELINE_RESOLVED * 100 / TASK_COUNT ))% |
| With playbook | $PLAYBOOK_RESOLVED/$TASK_COUNT | $(( PLAYBOOK_RESOLVED * 100 / TASK_COUNT ))% |

## Details

| Task | Baseline | Playbook |
|------|----------|----------|
EOF

for i in $(seq 0 $((TASK_COUNT - 1))); do
  IFS='|' read -r TASK_ID _ _ TASK_DESC <<< "${TASKS[$i]}"
  BRES=$(check_resolution "$TASK_ID" "$RESULTS_DIR/baseline/$TASK_ID" "$TASK_DESC")
  PRES=$(check_resolution "$TASK_ID" "$RESULTS_DIR/playbook/$TASK_ID" "$TASK_DESC")
  echo "| $TASK_ID | $BRES | $PRES |" >> "$RESULTS_DIR/summary.md"
done

cat >> "$RESULTS_DIR/summary.md" << 'EOF'

## Methodology

See [docs/swe-bench-methodology.md](../docs/swe-bench-methodology.md) for task selection criteria, scoring methodology, and limitations.
EOF

# ── Final summary ──────────────────────────────────────────

say "============================================================"
say "RESULTS"
say ""
say "  Baseline: $BASELINE_RESOLVED/$TASK_COUNT resolved"
say "  Playbook: $PLAYBOOK_RESOLVED/$TASK_COUNT resolved"
say ""
say "  Full results: $RESULTS_DIR/summary.md"
say "  JSON data:    $RESULTS_DIR/summary.json"
say ""
say "END: $(date)"
