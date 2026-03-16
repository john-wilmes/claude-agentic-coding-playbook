#!/usr/bin/env bash
# tests/skills/evidence-numbering.test.sh — Tests for scripts/skills/next-evidence-number.sh
#
# Run: bash tests/skills/evidence-numbering.test.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="${REPO_ROOT}/scripts/skills/next-evidence-number.sh"

# ─── Minimal test runner ──────────────────────────────────────────────────────

passed=0; failed=0; failures=()

pass() { echo "  PASS  $1"; passed=$((passed + 1)); }
fail() { echo "  FAIL  $1: $2"; failures+=("$1: $2"); failed=$((failed + 1)); }

# ─── Tmpdir setup ─────────────────────────────────────────────────────────────

TMPDIR_ROOT="$(mktemp -d)"
cleanup() { rm -rf "$TMPDIR_ROOT"; }
trap cleanup EXIT

# ─── Test 1: Empty EVIDENCE dir → prints 001 ─────────────────────────────────

t="empty EVIDENCE dir prints 001"
inv="$TMPDIR_ROOT/t1/INV-001"
mkdir -p "$inv/EVIDENCE"
result="$(bash "$SCRIPT" "$inv")"
if [ "$result" = "001" ]; then
  pass "$t"
else
  fail "$t" "expected '001', got '$result'"
fi

# ─── Test 2: Sequential files (001, 002, 003) → prints 004 ───────────────────

t="sequential files 001-003 print 004"
inv="$TMPDIR_ROOT/t2/INV-002"
mkdir -p "$inv/EVIDENCE"
touch "$inv/EVIDENCE/001-first.md"
touch "$inv/EVIDENCE/002-second.md"
touch "$inv/EVIDENCE/003-third.md"
result="$(bash "$SCRIPT" "$inv")"
if [ "$result" = "004" ]; then
  pass "$t"
else
  fail "$t" "expected '004', got '$result'"
fi

# ─── Test 3: Gap in numbering (001, 003) → prints 004 (after highest) ────────

t="gap in numbering (001, 003) prints 004"
inv="$TMPDIR_ROOT/t3/INV-003"
mkdir -p "$inv/EVIDENCE"
touch "$inv/EVIDENCE/001-first.md"
touch "$inv/EVIDENCE/003-third.md"
result="$(bash "$SCRIPT" "$inv")"
if [ "$result" = "004" ]; then
  pass "$t"
else
  fail "$t" "expected '004', got '$result'"
fi

# ─── Test 4: No EVIDENCE directory → exit 1 with error ───────────────────────

t="missing EVIDENCE dir exits 1"
inv="$TMPDIR_ROOT/t4/INV-004"
mkdir -p "$inv"
rc=0
err_out="$(bash "$SCRIPT" "$inv" 2>&1)" || rc=$?
if [ "$rc" -eq 1 ]; then
  pass "$t"
else
  fail "$t" "expected exit 1, got exit $rc (output: $err_out)"
fi

# ─── Test 5: Single file 001 → prints 002 ────────────────────────────────────

t="single file 001 prints 002"
inv="$TMPDIR_ROOT/t5/INV-005"
mkdir -p "$inv/EVIDENCE"
touch "$inv/EVIDENCE/001-only.md"
result="$(bash "$SCRIPT" "$inv")"
if [ "$result" = "002" ]; then
  pass "$t"
else
  fail "$t" "expected '002', got '$result'"
fi

# ─── Results ─────────────────────────────────────────────────────────────────

echo ""
echo "Results: ${passed} passed, ${failed} failed"
if [[ "${failed}" -gt 0 ]]; then
  for f in "${failures[@]}"; do echo "  - ${f}"; done
  exit 1
fi
exit 0
