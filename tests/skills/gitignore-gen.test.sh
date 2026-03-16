#!/usr/bin/env bash
# tests/skills/gitignore-gen.test.sh — Tests for scripts/skills/gitignore-entries.sh
#
# Run: bash tests/skills/gitignore-gen.test.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="${REPO_ROOT}/scripts/skills/gitignore-entries.sh"

passed=0
failed=0
failures=()

pass() { echo "  PASS  $1"; passed=$((passed + 1)); }
fail() { echo "  FAIL  $1: $2"; failures+=("$1: $2"); failed=$((failed + 1)); }

assert_contains() {
  local name="$1" pattern="$2" output="$3"
  if echo "$output" | grep -qF -- "$pattern"; then
    pass "$name"
  else
    fail "$name" "expected '${pattern}' in output"
  fi
}

assert_not_contains() {
  local name="$1" pattern="$2" output="$3"
  if echo "$output" | grep -qF -- "$pattern"; then
    fail "$name" "unexpected '${pattern}' found in output"
  else
    pass "$name"
  fi
}

# ─── Tests ───────────────────────────────────────────────────────────────────

echo "gitignore-entries.sh"

# Test 1: python includes __pycache__/
out="$(bash "$SCRIPT" python)"
assert_contains "python includes __pycache__/" "__pycache__/" "$out"

# Test 2: node includes node_modules/
out="$(bash "$SCRIPT" node)"
assert_contains "node includes node_modules/" "node_modules/" "$out"

# Test 3: all types include .env* baseline
for type in node python nextjs static other; do
  out="$(bash "$SCRIPT" "$type")"
  assert_contains "type=${type} includes .env*" ".env*" "$out"
done

# Test 4: unknown type → baseline only (has .env* and node_modules/, no __pycache__/)
out="$(bash "$SCRIPT" foobar)"
assert_contains "unknown type has .env*" ".env*" "$out"
assert_contains "unknown type has node_modules/" "node_modules/" "$out"
assert_not_contains "unknown type has no __pycache__/" "__pycache__/" "$out"

# Test 5: no argument → baseline (other)
out="$(bash "$SCRIPT")"
assert_contains "no arg includes .env*" ".env*" "$out"
assert_contains "no arg includes node_modules/" "node_modules/" "$out"
assert_not_contains "no arg has no __pycache__/" "__pycache__/" "$out"

# Test 6: nextjs includes .next/
out="$(bash "$SCRIPT" nextjs)"
assert_contains "nextjs includes .next/" ".next/" "$out"

# Test 7: python does NOT include .next/
out="$(bash "$SCRIPT" python)"
assert_not_contains "python has no .next/" ".next/" "$out"

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
