#!/usr/bin/env bash
# tests/skills/knowledge-export.test.sh — Tests for scripts/skills/sync-knowledge-repo.sh
#
# Run: bash tests/skills/knowledge-export.test.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="${REPO_ROOT}/scripts/skills/sync-knowledge-repo.sh"

# ─── Minimal test runner ──────────────────────────────────────────────────────

passed=0; failed=0; failures=()

pass() { echo "  PASS  $1"; passed=$((passed + 1)); }
fail() { echo "  FAIL  $1: $2"; failures+=("$1: $2"); failed=$((failed + 1)); }

# ─── Tmpdir setup ─────────────────────────────────────────────────────────────

TMPDIR_ROOT="$(mktemp -d)"
cleanup() { rm -rf "$TMPDIR_ROOT"; }
trap cleanup EXIT

# ─── Setup helper ─────────────────────────────────────────────────────────────

setup_knowledge_repo() {
  local dir="$1"
  mkdir -p "$dir"
  git -C "$dir" init --quiet
  git -C "$dir" config user.email "test@test.com"
  git -C "$dir" config user.name "Test"
  echo "init" > "$dir/init.txt"
  git -C "$dir" add .
  git -C "$dir" commit -m "init" --quiet
}

# ─── Test 1: Directory doesn't exist → NO_DIR ────────────────────────────────

t="nonexistent directory prints NO_DIR"
result="$(bash "$SCRIPT" --knowledge-dir "$TMPDIR_ROOT/t1/nonexistent")"
if [ "$result" = "NO_DIR" ]; then
  pass "$t"
else
  fail "$t" "expected NO_DIR, got '$result'"
fi

# ─── Test 2: Not a git repo → NO_GIT ─────────────────────────────────────────

t="plain directory prints NO_GIT"
plain_dir="$TMPDIR_ROOT/t2/notarepo"
mkdir -p "$plain_dir"
result="$(bash "$SCRIPT" --knowledge-dir "$plain_dir")"
if [ "$result" = "NO_GIT" ]; then
  pass "$t"
else
  fail "$t" "expected NO_GIT, got '$result'"
fi

# ─── Test 3: No changes → NO_CHANGES ─────────────────────────────────────────

t="clean git repo prints NO_CHANGES"
kdir="$TMPDIR_ROOT/t3/knowledge"
setup_knowledge_repo "$kdir"
result="$(bash "$SCRIPT" --knowledge-dir "$kdir")"
if [ "$result" = "NO_CHANGES" ]; then
  pass "$t"
else
  fail "$t" "expected NO_CHANGES, got '$result'"
fi

# ─── Test 4: Changes + no remote → COMMITTED ─────────────────────────────────

t="changes with no remote prints COMMITTED"
kdir="$TMPDIR_ROOT/t4/knowledge"
setup_knowledge_repo "$kdir"
echo "new entry" > "$kdir/entry.txt"
result="$(bash "$SCRIPT" --knowledge-dir "$kdir")"
if [ "$result" = "COMMITTED" ]; then
  pass "$t"
else
  fail "$t" "expected COMMITTED, got '$result'"
fi
# Verify it was actually committed (working tree should be clean)
if [ -z "$(git -C "$kdir" status --porcelain)" ]; then
  pass "$t (changes were committed)"
else
  fail "$t (changes were committed)" "working tree not clean after COMMITTED"
fi

# ─── Test 5: Dry-run with changes → COMMITTED but no actual commit ────────────

t="dry-run with changes prints COMMITTED without committing"
kdir="$TMPDIR_ROOT/t5/knowledge"
setup_knowledge_repo "$kdir"
echo "pending entry" > "$kdir/pending.txt"
result="$(bash "$SCRIPT" --knowledge-dir "$kdir" --dry-run)"
if [ "$result" = "COMMITTED" ]; then
  pass "$t"
else
  fail "$t" "expected COMMITTED, got '$result'"
fi
# Verify changes are still uncommitted
if [ -n "$(git -C "$kdir" status --porcelain)" ]; then
  pass "$t (changes remain uncommitted)"
else
  fail "$t (changes remain uncommitted)" "working tree is clean after dry-run, should still have changes"
fi

# ─── Test 6: Push succeeds → PUSHED ──────────────────────────────────────────

t="push to local bare remote prints PUSHED"
bare_remote="$TMPDIR_ROOT/t6/remote.git"
kdir="$TMPDIR_ROOT/t6/knowledge"
# Create bare remote first
git init --bare --quiet "$bare_remote"
# Set up knowledge repo cloned from bare remote
setup_knowledge_repo "$kdir"
# Add bare remote as origin and do an initial push to set up tracking
git -C "$kdir" remote add origin "$bare_remote"
git -C "$kdir" push --quiet origin HEAD:main 2>/dev/null || git -C "$kdir" push --quiet origin HEAD:master 2>/dev/null || true
# Now add a change and run sync
echo "new knowledge entry" > "$kdir/knowledge.txt"
result="$(bash "$SCRIPT" --knowledge-dir "$kdir")"
if [ "$result" = "PUSHED" ]; then
  pass "$t"
else
  fail "$t" "expected PUSHED, got '$result'"
fi

# ─── Results ─────────────────────────────────────────────────────────────────

echo ""
echo "Results: ${passed} passed, ${failed} failed"
if [[ "${failed}" -gt 0 ]]; then
  for f in "${failures[@]}"; do echo "  - ${f}"; done
  exit 1
fi
exit 0
