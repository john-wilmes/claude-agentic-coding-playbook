#!/usr/bin/env bash
# tests/skills/precommit-hook.test.sh — Tests for scripts/skills/install-precommit.sh
#
# Run: bash tests/skills/precommit-hook.test.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="${REPO_ROOT}/scripts/skills/install-precommit.sh"

# ─── Minimal test runner ──────────────────────────────────────────────────────

passed=0; failed=0; failures=()

pass() { echo "  PASS  $1"; passed=$((passed + 1)); }
fail() { echo "  FAIL  $1: $2"; failures+=("$1: $2"); failed=$((failed + 1)); }

# ─── Tmpdir setup ─────────────────────────────────────────────────────────────

TMPDIR_ROOT="$(mktemp -d)"
cleanup() { rm -rf "$TMPDIR_ROOT"; }
trap cleanup EXIT

# ─── Setup helpers ────────────────────────────────────────────────────────────

setup_git_repo() {
  local dir="$1"
  mkdir -p "$dir"
  git -C "$dir" init --quiet
  git -C "$dir" config user.email "test@test.com"
  git -C "$dir" config user.name "Test"
}

create_template() {
  local path="$1"
  echo '#!/bin/sh' > "$path"
  echo 'echo "pre-commit hook"' >> "$path"
}

# ─── Test 1: No hooksPath + no existing hook → INSTALLED ─────────────────────

t="no hooksPath, no existing hook installs hook"
repo="$TMPDIR_ROOT/t1/repo"
setup_git_repo "$repo"
tmpl="$TMPDIR_ROOT/t1/pre-commit.tmpl"
create_template "$tmpl"
result="$(bash "$SCRIPT" --template "$tmpl" --project "$repo")"
git_dir="$(git -C "$repo" rev-parse --git-dir)"
case "$git_dir" in
  /*) abs_git_dir="$git_dir" ;;
  *) abs_git_dir="$repo/$git_dir" ;;
esac
hook_file="$abs_git_dir/hooks/pre-commit"
if [ "$result" = "INSTALLED" ] && [ -f "$hook_file" ]; then
  pass "$t"
else
  fail "$t" "expected INSTALLED and hook file to exist; got '$result', file_exists=$([ -f "$hook_file" ] && echo yes || echo no)"
fi

# ─── Test 2: Existing hook → SKIPPED ─────────────────────────────────────────

t="existing pre-commit hook prints SKIPPED"
repo="$TMPDIR_ROOT/t2/repo"
setup_git_repo "$repo"
tmpl="$TMPDIR_ROOT/t2/pre-commit.tmpl"
create_template "$tmpl"
git_dir="$(git -C "$repo" rev-parse --git-dir)"
case "$git_dir" in
  /*) abs_git_dir="$git_dir" ;;
  *) abs_git_dir="$repo/$git_dir" ;;
esac
mkdir -p "$abs_git_dir/hooks"
echo '#!/bin/sh' > "$abs_git_dir/hooks/pre-commit"
result="$(bash "$SCRIPT" --template "$tmpl" --project "$repo")"
if [ "$result" = "SKIPPED" ]; then
  pass "$t"
else
  fail "$t" "expected SKIPPED, got '$result'"
fi

# ─── Test 3: hooksPath set → installs to global dir ──────────────────────────

t="hooksPath set installs to global dir"
repo="$TMPDIR_ROOT/t3/repo"
global_hooks="$TMPDIR_ROOT/t3/global-hooks"
setup_git_repo "$repo"
git -C "$repo" config core.hooksPath "$global_hooks"
tmpl="$TMPDIR_ROOT/t3/pre-commit.tmpl"
create_template "$tmpl"
result="$(bash "$SCRIPT" --template "$tmpl" --project "$repo")"
if [[ "$result" == "INSTALLED_GLOBAL:$global_hooks" ]] && [ -f "$global_hooks/pre-commit" ]; then
  pass "$t"
else
  fail "$t" "expected INSTALLED_GLOBAL:$global_hooks and hook file; got '$result', file_exists=$([ -f "$global_hooks/pre-commit" ] && echo yes || echo no)"
fi

# ─── Test 4: Template missing → NO_TEMPLATE ──────────────────────────────────

t="missing template prints NO_TEMPLATE"
repo="$TMPDIR_ROOT/t4/repo"
setup_git_repo "$repo"
result="$(bash "$SCRIPT" --template "$TMPDIR_ROOT/t4/nonexistent.tmpl" --project "$repo")"
if [ "$result" = "NO_TEMPLATE" ]; then
  pass "$t"
else
  fail "$t" "expected NO_TEMPLATE, got '$result'"
fi

# ─── Test 5: Not a git repo → NOT_A_REPO ─────────────────────────────────────

t="plain directory prints NOT_A_REPO"
plain_dir="$TMPDIR_ROOT/t5/notarepo"
mkdir -p "$plain_dir"
tmpl="$TMPDIR_ROOT/t5/pre-commit.tmpl"
create_template "$tmpl"
result="$(bash "$SCRIPT" --template "$tmpl" --project "$plain_dir")"
if [ "$result" = "NOT_A_REPO" ]; then
  pass "$t"
else
  fail "$t" "expected NOT_A_REPO, got '$result'"
fi

# ─── Test 6: Dry-run → prints INSTALLED but doesn't copy ─────────────────────

t="dry-run prints INSTALLED without copying file"
repo="$TMPDIR_ROOT/t6/repo"
setup_git_repo "$repo"
tmpl="$TMPDIR_ROOT/t6/pre-commit.tmpl"
create_template "$tmpl"
result="$(bash "$SCRIPT" --template "$tmpl" --project "$repo" --dry-run)"
git_dir="$(git -C "$repo" rev-parse --git-dir)"
case "$git_dir" in
  /*) abs_git_dir="$git_dir" ;;
  *) abs_git_dir="$repo/$git_dir" ;;
esac
hook_file="$abs_git_dir/hooks/pre-commit"
if [ "$result" = "INSTALLED" ] && [ ! -f "$hook_file" ]; then
  pass "$t"
else
  fail "$t" "expected INSTALLED + no file; got '$result', file_exists=$([ -f "$hook_file" ] && echo yes || echo no)"
fi

# ─── Test 7: hooksPath with existing hook → SKIPPED_GLOBAL ──────────────────

t="hooksPath with existing hook prints SKIPPED_GLOBAL"
repo="$TMPDIR_ROOT/t7/repo"
global_hooks="$TMPDIR_ROOT/t7/global-hooks"
setup_git_repo "$repo"
git -C "$repo" config core.hooksPath "$global_hooks"
mkdir -p "$global_hooks"
echo '#!/bin/sh' > "$global_hooks/pre-commit"
tmpl="$TMPDIR_ROOT/t7/pre-commit.tmpl"
create_template "$tmpl"
result="$(bash "$SCRIPT" --template "$tmpl" --project "$repo")"
if [[ "$result" == "SKIPPED_GLOBAL:$global_hooks" ]]; then
  pass "$t"
else
  fail "$t" "expected SKIPPED_GLOBAL:$global_hooks, got '$result'"
fi

# ─── Results ─────────────────────────────────────────────────────────────────

echo ""
echo "Results: ${passed} passed, ${failed} failed"
if [[ "${failed}" -gt 0 ]]; then
  for f in "${failures[@]}"; do echo "  - ${f}"; done
  exit 1
fi
exit 0
