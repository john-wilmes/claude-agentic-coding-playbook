#!/usr/bin/env bash
# tests/skills/da-check.test.sh — Tests for scripts/skills/da-check.sh
#
# Run: bash tests/skills/da-check.test.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="${REPO_ROOT}/scripts/skills/da-check.sh"

passed=0
failed=0
failures=()

pass() { echo "  PASS  $1"; passed=$((passed + 1)); }
fail() { echo "  FAIL  $1: $2"; failures+=("$1: $2"); failed=$((failed + 1)); }

assert_output() {
  local name="$1" expected="$2" actual="$3" rc="${4:-0}"
  if [ "$actual" = "$expected" ] && [ "$rc" -eq 0 ]; then
    pass "$name"
  else
    fail "$name" "expected output='${expected}' exit=0, got output='${actual}' exit=${rc}"
  fi
}

# ─── Git repo helper ──────────────────────────────────────────────────────────

TMPDIR_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_ROOT"' EXIT

setup_repo() {
  local dir="$1"
  mkdir -p "$dir"
  cd "$dir"
  git init -q
  git config user.email "test@test.com"
  git config user.name "Test"
  echo "init" > init.txt
  git add .
  git commit -q -m "init"
  local bare="${dir}-bare"
  git clone -q --bare "$dir" "$bare"
  git remote add origin "$bare"
  git fetch -q origin
  # Set remote HEAD so symbolic-ref resolution works
  git -C "$bare" symbolic-ref HEAD "refs/heads/$(git rev-parse --abbrev-ref HEAD)"
}

add_commit() {
  local file="$1" msg="$2"
  echo "$msg" >> "$file"
  git add "$file"
  git commit -q -m "$msg"
}

# ─── Tests ────────────────────────────────────────────────────────────────────

echo "da-check.sh"

# Test 1: Fewer than 5 commits → DA_NOT_NEEDED
DIR="${TMPDIR_ROOT}/few-commits"
setup_repo "$DIR"
add_commit "foo.js" "commit 2"
add_commit "foo.js" "commit 3"
add_commit "foo.js" "commit 4"
set +e; OUT="$(bash "$SCRIPT" 2>/dev/null)"; RC=$?; set -e
assert_output "few commits → DA_NOT_NEEDED" "DA_NOT_NEEDED" "$OUT" "$RC"
cd "$REPO_ROOT"

# Test 2: 5+ commits, all .js → DA_NOT_NEEDED
DIR="${TMPDIR_ROOT}/many-js"
setup_repo "$DIR"
for i in 2 3 4 5 6 7; do add_commit "app.js" "commit $i"; done
set +e; OUT="$(bash "$SCRIPT" 2>/dev/null)"; RC=$?; set -e
assert_output "5+ commits all .js → DA_NOT_NEEDED" "DA_NOT_NEEDED" "$OUT" "$RC"
cd "$REPO_ROOT"

# Test 3: 5+ commits with a .md file → DA_NEEDED
DIR="${TMPDIR_ROOT}/many-with-md"
setup_repo "$DIR"
for i in 2 3 4 5; do add_commit "app.js" "commit $i"; done
add_commit "README.md" "add readme"
set +e; OUT="$(bash "$SCRIPT" 2>/dev/null)"; RC=$?; set -e
assert_output "5+ commits with .md → DA_NEEDED" "DA_NEEDED" "$OUT" "$RC"
cd "$REPO_ROOT"

# Test 4: Not in a git repo → DA_NOT_NEEDED (graceful exit)
set +e; OUT="$(cd /tmp && bash "$SCRIPT" 2>/dev/null)"; RC=$?; set -e
assert_output "no git repo → DA_NOT_NEEDED" "DA_NOT_NEEDED" "$OUT" "$RC"

# Test 5: Git repo with no remote → DA_NOT_NEEDED
DIR="${TMPDIR_ROOT}/no-remote"
mkdir -p "$DIR"
cd "$DIR"
git init -q
git config user.email "test@test.com"
git config user.name "Test"
echo "init" > init.txt
git add .
git commit -q -m "init"
set +e; OUT="$(bash "$SCRIPT" 2>/dev/null)"; RC=$?; set -e
assert_output "no remote → DA_NOT_NEEDED" "DA_NOT_NEEDED" "$OUT" "$RC"
cd "$REPO_ROOT"

# ─── Summary ─────────────────────────────────────────────────────────────────

echo ""
echo "Results: ${passed} passed, ${failed} failed"
if [ "${failed}" -gt 0 ]; then
  echo "Failed tests:"
  for f in "${failures[@]}"; do
    echo "  - $f"
  done
  exit 1
fi
