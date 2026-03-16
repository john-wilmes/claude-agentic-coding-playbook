#!/usr/bin/env bash
# tests/skills/check-citations.test.sh — Tests for investigate/scripts/check-citations.sh
#
# Run: bash tests/skills/check-citations.test.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="${REPO_ROOT}/profiles/combined/skills/investigate/scripts/check-citations.sh"

# ─── Prerequisites ────────────────────────────────────────────────────────────

if ! command -v jq >/dev/null 2>&1; then
  echo "SKIP: jq not installed (required by check-citations.sh)"
  exit 0
fi

# ─── Minimal test runner ──────────────────────────────────────────────────────

passed=0; failed=0; failures=()

pass() { echo "  PASS  $1"; passed=$((passed + 1)); }
fail() { echo "  FAIL  $1: $2"; failures+=("$1: $2"); failed=$((failed + 1)); }

# ─── JSON field checker (uses Node stdlib) ────────────────────────────────────

check_json_field() {
  local json="$1" field="$2" expected="$3"
  local actual
  actual=$(node -e "const o=JSON.parse(process.argv[1]); console.log(JSON.stringify(o[process.argv[2]]))" "$json" "$field")
  [ "$actual" = "$expected" ]
}

# ─── Tmpdir setup ─────────────────────────────────────────────────────────────

TMPDIR_ROOT="$(mktemp -d)"
cleanup() { rm -rf "$TMPDIR_ROOT"; }
trap cleanup EXIT

# ─── Test 1: No EVIDENCE dir → error JSON, exit 1 ────────────────────────────

t="missing EVIDENCE dir returns error"
inv="$TMPDIR_ROOT/t1"
mkdir -p "$inv/TEST-001"
touch "$inv/TEST-001/FINDINGS.md"
rc=0
result=$(bash "$SCRIPT" "$inv" "TEST-001" 2>&1) || rc=$?
if [ "$rc" -eq 1 ] && echo "$result" | grep -q '"error"'; then
  pass "$t"
else
  fail "$t" "expected exit 1 with error JSON, got exit=$rc output='$result'"
fi

# ─── Test 2: No FINDINGS.md → error JSON, exit 1 ─────────────────────────────

t="missing FINDINGS.md returns error"
inv="$TMPDIR_ROOT/t2"
mkdir -p "$inv/TEST-002/EVIDENCE"
rc=0
result=$(bash "$SCRIPT" "$inv" "TEST-002" 2>&1) || rc=$?
if [ "$rc" -eq 1 ] && echo "$result" | grep -q '"error"'; then
  pass "$t"
else
  fail "$t" "expected exit 1 with error JSON, got exit=$rc output='$result'"
fi

# ─── Test 3: Empty EVIDENCE dir → zero counts ────────────────────────────────

t="empty EVIDENCE dir returns zeros"
inv="$TMPDIR_ROOT/t3"
mkdir -p "$inv/TEST-003/EVIDENCE"
cat > "$inv/TEST-003/FINDINGS.md" <<'EOF'
# Findings
Nothing yet.
EOF
result=$(bash "$SCRIPT" "$inv" "TEST-003")
expected='{"total_evidence": 0, "cited_count": 0, "citation_rate": 0, "uncited_files": []}'
if [ "$result" = "$expected" ]; then
  pass "$t"
else
  fail "$t" "expected '$expected', got '$result'"
fi

# ─── Test 4: 3 evidence files, all cited → 100% rate ─────────────────────────

t="all 3 cited returns 100% rate"
inv="$TMPDIR_ROOT/t4"
mkdir -p "$inv/TEST-004/EVIDENCE"
touch "$inv/TEST-004/EVIDENCE/001-first.md"
touch "$inv/TEST-004/EVIDENCE/002-second.md"
touch "$inv/TEST-004/EVIDENCE/003-third.md"
cat > "$inv/TEST-004/FINDINGS.md" <<'EOF'
# Findings
The bug was caused by a null check (Evidence 001).
Further analysis showed a race condition (Evidence 002, Evidence 003).
EOF
result=$(bash "$SCRIPT" "$inv" "TEST-004")
if check_json_field "$result" "total_evidence" "3" &&
   check_json_field "$result" "cited_count" "3" &&
   check_json_field "$result" "citation_rate" "100" &&
   check_json_field "$result" "uncited_count" "0" &&
   check_json_field "$result" "uncited_files" "[]"; then
  pass "$t"
else
  fail "$t" "got '$result'"
fi

# ─── Test 5: 3 evidence files, 1 cited → 33% rate ────────────────────────────

t="1 of 3 cited returns 33% rate"
inv="$TMPDIR_ROOT/t5"
mkdir -p "$inv/TEST-005/EVIDENCE"
touch "$inv/TEST-005/EVIDENCE/001-first.md"
touch "$inv/TEST-005/EVIDENCE/002-second.md"
touch "$inv/TEST-005/EVIDENCE/003-third.md"
cat > "$inv/TEST-005/FINDINGS.md" <<'EOF'
# Findings
Only one piece was relevant (Evidence 002).
EOF
result=$(bash "$SCRIPT" "$inv" "TEST-005")
if check_json_field "$result" "total_evidence" "3" &&
   check_json_field "$result" "cited_count" "1" &&
   check_json_field "$result" "citation_rate" "33" &&
   check_json_field "$result" "uncited_count" "2"; then
  pass "$t"
else
  fail "$t" "got '$result'"
fi

# ─── Test 6: 3 evidence files, 0 cited → 0% rate ─────────────────────────────

t="none cited returns 0% rate"
inv="$TMPDIR_ROOT/t6"
mkdir -p "$inv/TEST-006/EVIDENCE"
touch "$inv/TEST-006/EVIDENCE/001-first.md"
touch "$inv/TEST-006/EVIDENCE/002-second.md"
touch "$inv/TEST-006/EVIDENCE/003-third.md"
cat > "$inv/TEST-006/FINDINGS.md" <<'EOF'
# Findings
No evidence was cited in this document.
EOF
rc=0
result=$(bash "$SCRIPT" "$inv" "TEST-006" 2>&1) || rc=$?
if [ "$rc" -ne 0 ]; then
  fail "$t" "script exited $rc (possible bug in cited_count when 0 citations)"
elif check_json_field "$result" "total_evidence" "3" &&
     check_json_field "$result" "cited_count" "0" &&
     check_json_field "$result" "citation_rate" "0" &&
     check_json_field "$result" "uncited_count" "3"; then
  pass "$t"
else
  fail "$t" "got '$result'"
fi

# ─── Test 7: Gaps in numbering (001, 003, 007) → counts correctly ────────────

t="gaps in numbering counted correctly"
inv="$TMPDIR_ROOT/t7"
mkdir -p "$inv/TEST-007/EVIDENCE"
touch "$inv/TEST-007/EVIDENCE/001-first.md"
touch "$inv/TEST-007/EVIDENCE/003-third.md"
touch "$inv/TEST-007/EVIDENCE/007-seventh.md"
cat > "$inv/TEST-007/FINDINGS.md" <<'EOF'
# Findings
The root cause is documented (Evidence 001, Evidence 007).
EOF
result=$(bash "$SCRIPT" "$inv" "TEST-007")
if check_json_field "$result" "total_evidence" "3" &&
   check_json_field "$result" "cited_count" "2" &&
   check_json_field "$result" "citation_rate" "67" &&
   check_json_field "$result" "uncited_count" "1"; then
  pass "$t"
else
  fail "$t" "got '$result'"
fi

# ─── Results ─────────────────────────────────────────────────────────────────

echo ""
echo "Results: ${passed} passed, ${failed} failed"
if [[ "${failed}" -gt 0 ]]; then
  for f in "${failures[@]}"; do echo "  - ${f}"; done
  exit 1
fi
exit 0
