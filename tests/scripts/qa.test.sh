#!/usr/bin/env bash
# tests/scripts/qa.test.sh - Unit tests for scripts/qa
# Tests flag parsing and error handling. Does NOT make API calls.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
QA="$SCRIPT_DIR/scripts/qa"

PASS=0
FAIL=0

pass() { echo "PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "FAIL: $1"; FAIL=$((FAIL + 1)); }

# ---------------------------------------------------------------------------
# Test 1: --help exits 0 and prints usage
# ---------------------------------------------------------------------------
if output=$("$QA" --help 2>&1); then
  if echo "$output" | grep -q "Usage:"; then
    pass "--help exits 0 and prints Usage:"
  else
    fail "--help output missing 'Usage:'"
  fi
else
  fail "--help exited non-zero"
fi

# ---------------------------------------------------------------------------
# Test 2: Missing ANTHROPIC_API_KEY exits 1 with clear error
# ---------------------------------------------------------------------------
if output=$(env -u ANTHROPIC_API_KEY "$QA" "hello" 2>&1); then
  fail "Missing API key should exit non-zero but exited 0"
else
  exit_code=$?
  if [[ "$exit_code" -eq 1 ]] && echo "$output" | grep -q "ANTHROPIC_API_KEY"; then
    pass "Missing API key exits 1 with ANTHROPIC_API_KEY in message"
  else
    fail "Missing API key: exit=$exit_code output=$output"
  fi
fi

# ---------------------------------------------------------------------------
# Test 3: --max-turns flag is recognised (wrong key → rejected before API call)
# ---------------------------------------------------------------------------
if output=$(env ANTHROPIC_API_KEY="invalid-key-no-call" "$QA" --max-turns 3 "hello" 2>&1); then
  fail "--max-turns with bad key should exit non-zero"
else
  # Should fail at API call (bad key), not at flag parsing — so no "Unknown flag" error
  if echo "$output" | grep -q "Unknown flag"; then
    fail "--max-turns was not recognised (got 'Unknown flag')"
  else
    pass "--max-turns flag is recognised (no 'Unknown flag' error)"
  fi
fi

# ---------------------------------------------------------------------------
# Test 4: --yes flag is recognised (wrong key → rejected before API call)
# ---------------------------------------------------------------------------
if output=$(env ANTHROPIC_API_KEY="invalid-key-no-call" "$QA" --yes "hello" 2>&1); then
  fail "--yes with bad key should exit non-zero"
else
  if echo "$output" | grep -q "Unknown flag"; then
    fail "--yes was not recognised (got 'Unknown flag')"
  else
    pass "--yes flag is recognised (no 'Unknown flag' error)"
  fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "Results: $PASS passed, $FAIL failed"
if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
