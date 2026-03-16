#!/usr/bin/env bash
# tests/skills/install-root.test.sh — Tests for scripts/skills/find-install-root.sh
#
# Run: bash tests/skills/install-root.test.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="${REPO_ROOT}/scripts/skills/find-install-root.sh"

# ─── Minimal test runner ──────────────────────────────────────────────────────

passed=0; failed=0; failures=()

pass() { echo "  PASS  $1"; passed=$((passed + 1)); }
fail() { echo "  FAIL  $1: $2"; failures+=("$1: $2"); failed=$((failed + 1)); }

# ─── Tmpdir setup ─────────────────────────────────────────────────────────────

TMPDIR_ROOT="$(mktemp -d)"
cleanup() { rm -rf "$TMPDIR_ROOT"; }
trap cleanup EXIT

# ─── Test 1: Deep subdir finds ancestor with .claude/skills/ ─────────────────

t="deep subdir finds ancestor with .claude/skills/"
root="$TMPDIR_ROOT/t1"
mkdir -p "$root/.claude/skills" "$root/a/b/c"
result="$(bash "$SCRIPT" "$root/a/b/c")"
if [ "$result" = "$root" ]; then
  pass "$t"
else
  fail "$t" "expected '$root', got '$result'"
fi

# ─── Test 2: /tmp random dir falls back to $HOME ─────────────────────────────

t="random dir with no .claude falls back to HOME"
nodir="$TMPDIR_ROOT/t2/no/claude/here"
mkdir -p "$nodir"
result="$(bash "$SCRIPT" "$nodir")"
if [ "$result" = "$HOME" ]; then
  pass "$t"
else
  fail "$t" "expected '$HOME', got '$result'"
fi

# ─── Test 3: Prefers closest ancestor when multiple exist ─────────────────────

t="prefers closest ancestor when multiple .claude/skills/ exist"
outer="$TMPDIR_ROOT/t3"
inner="$TMPDIR_ROOT/t3/a/b"
mkdir -p "$outer/.claude/skills" "$inner/.claude/skills" "$inner/deep"
result="$(bash "$SCRIPT" "$inner/deep")"
if [ "$result" = "$inner" ]; then
  pass "$t"
else
  fail "$t" "expected '$inner', got '$result'"
fi

# ─── Test 4: .claude/ without matching subdirs is not a match ─────────────────

t=".claude/ without skills/templates/investigations is not a match"
root4="$TMPDIR_ROOT/t4"
# Create a parent with .claude/skills/ and a child with only a bare .claude/ (no qualifying subdir)
parent="$root4/parent"
child="$root4/parent/child"
mkdir -p "$parent/.claude/skills" "$child/.claude" "$child/deep"
# child/.claude exists but has no qualifying subdir; should fall through to parent
result="$(bash "$SCRIPT" "$child/deep")"
if [ "$result" = "$parent" ]; then
  pass "$t"
else
  fail "$t" "expected '$parent', got '$result'"
fi

# ─── Test 5: No argument defaults to current directory behavior ───────────────

t="no argument defaults to current directory"
root5="$TMPDIR_ROOT/t5"
mkdir -p "$root5/.claude/investigations"
# Run script from inside root5 with no argument
result="$(cd "$root5" && bash "$SCRIPT")"
if [ "$result" = "$root5" ]; then
  pass "$t"
else
  fail "$t" "expected '$root5', got '$result'"
fi

# ─── Results ─────────────────────────────────────────────────────────────────

echo ""
echo "Results: ${passed} passed, ${failed} failed"
if [[ "${failed}" -gt 0 ]]; then
  for f in "${failures[@]}"; do echo "  - ${f}"; done
  exit 1
fi
exit 0
