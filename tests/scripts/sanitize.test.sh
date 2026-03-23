#!/usr/bin/env bash
# sanitize.test.sh — Tests for scripts/sanitize.sh
#
# Run: bash tests/scripts/sanitize.test.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SANITIZE="${REPO_ROOT}/scripts/sanitize.sh"

passed=0
failed=0
failures=()

# ─── Helpers ──────────────────────────────────────────────────────────────────

pass() { echo "  PASS  $1"; passed=$((passed + 1)); }
fail() { echo "  FAIL  $1"; failures+=("$1"); failed=$((failed + 1)); }

assert_exit() {
  local name="$1" expected="$2"
  shift 2
  local actual
  set +e
  "$@" >/dev/null 2>&1
  actual=$?
  set -e
  if [[ "${actual}" -eq "${expected}" ]]; then
    pass "${name}"
  else
    fail "${name} (expected exit ${expected}, got ${actual})"
  fi
}

assert_stdout_contains() {
  local name="$1" pattern="$2"
  shift 2
  local output
  set +e
  output="$("$@" 2>/dev/null)"
  set -e
  if echo "${output}" | grep -qF -- "${pattern}"; then
    pass "${name}"
  else
    fail "${name} (pattern '${pattern}' not found in: ${output})"
  fi
}

assert_file_contains() {
  local name="$1" file="$2" pattern="$3"
  if grep -qF -- "${pattern}" "${file}" 2>/dev/null; then
    pass "${name}"
  else
    fail "${name} (pattern '${pattern}' not found in file ${file})"
  fi
}

assert_file_not_contains() {
  local name="$1" file="$2" pattern="$3"
  if grep -qF -- "${pattern}" "${file}" 2>/dev/null; then
    fail "${name} (pattern '${pattern}' should NOT appear in file ${file})"
  else
    pass "${name}"
  fi
}

# Create a temp file with given content; prints the path
make_temp_file() {
  local content="$1"
  local tmp
  tmp="$(mktemp /tmp/sanitize-test-XXXXX.txt)"
  printf '%s\n' "${content}" > "${tmp}"
  echo "${tmp}"
}

# ─── Test: script exists and is executable ────────────────────────────────────

echo ""
echo "sanitize.sh — setup:"

if [[ -f "${SANITIZE}" ]]; then
  pass "script exists"
else
  fail "script missing at ${SANITIZE}"
fi

if [[ -x "${SANITIZE}" ]]; then
  pass "script is executable"
else
  fail "script is not executable"
fi

# ─── Test: missing arguments ──────────────────────────────────────────────────

echo ""
echo "sanitize.sh — argument handling:"

assert_exit "no args exits 1" 1 "${SANITIZE}"
assert_stdout_contains "no args prints Usage to stdout" "Usage:" "${SANITIZE}"

# ─── Test: file-not-found warning ─────────────────────────────────────────────

echo ""
echo "sanitize.sh — file handling:"

assert_stdout_contains "missing file prints WARNING" "WARNING" \
  "${SANITIZE}" /nonexistent/file/xyz.txt

# A missing file should not exit non-zero (just warn)
assert_exit "missing file exits 0" 0 "${SANITIZE}" /nonexistent/file/xyz.txt

# ─── Test: clean file ─────────────────────────────────────────────────────────

echo ""
echo "sanitize.sh — clean files:"

TMP_CLEAN="$(make_temp_file "This file has no PII. Just plain text with nothing sensitive.")"

assert_stdout_contains "clean file prints CLEAN" "CLEAN" "${SANITIZE}" "${TMP_CLEAN}"
assert_exit "clean file exits 0" 0 "${SANITIZE}" "${TMP_CLEAN}"

# Content should be unchanged
CONTENT_AFTER="$(cat "${TMP_CLEAN}")"
if [[ "${CONTENT_AFTER}" == *"CLEAN"* ]]; then
  fail "clean file content should not be modified"
else
  pass "clean file content is unchanged"
fi
rm -f "${TMP_CLEAN}"

# ─── Test: --check mode on clean file ─────────────────────────────────────────

TMP_CLEAN2="$(make_temp_file "No sensitive data here at all.")"
assert_exit "--check clean file exits 0" 0 "${SANITIZE}" --check "${TMP_CLEAN2}"
rm -f "${TMP_CLEAN2}"

# ─── Test: SSN redaction ──────────────────────────────────────────────────────

echo ""
echo "sanitize.sh — SSN redaction:"

TMP_SSN="$(make_temp_file "Patient SSN is 123-45-6789 and should be redacted.")"

"${SANITIZE}" "${TMP_SSN}" >/dev/null
assert_file_contains   "SSN replaced with [SSN]"  "${TMP_SSN}" "[SSN]"
assert_file_not_contains "original SSN removed"   "${TMP_SSN}" "123-45-6789"
rm -f "${TMP_SSN}"

# ─── Test: email redaction ────────────────────────────────────────────────────

echo ""
echo "sanitize.sh — email redaction:"

TMP_EMAIL="$(make_temp_file "Contact john.doe@example.com for more info.")"

"${SANITIZE}" "${TMP_EMAIL}" >/dev/null
assert_file_contains     "email replaced with [EMAIL]"  "${TMP_EMAIL}" "[EMAIL]"
assert_file_not_contains "original email removed"       "${TMP_EMAIL}" "john.doe@example.com"
rm -f "${TMP_EMAIL}"

# ─── Test: credit card redaction ──────────────────────────────────────────────

echo ""
echo "sanitize.sh — credit card redaction:"

TMP_CC="$(make_temp_file "Card number: 4111-1111-1111-1111 was charged.")"

"${SANITIZE}" "${TMP_CC}" >/dev/null
assert_file_contains     "CC replaced with [CC]"    "${TMP_CC}" "[CC]"
assert_file_not_contains "original CC removed"      "${TMP_CC}" "4111-1111-1111-1111"
rm -f "${TMP_CC}"

# ─── Test: --check mode detects PII ──────────────────────────────────────────

echo ""
echo "sanitize.sh — check mode:"

TMP_PII="$(make_temp_file "SSN: 987-65-4321 in this document.")"

assert_exit "--check with PII exits 1" 1 "${SANITIZE}" --check "${TMP_PII}"
assert_stdout_contains "--check prints PII_FOUND" "PII_FOUND" "${SANITIZE}" --check "${TMP_PII}"

# Verify --check does NOT modify the file
BEFORE_CHECK="$(cat "${TMP_PII}")"
set +e
"${SANITIZE}" --check "${TMP_PII}" >/dev/null 2>&1
set -e
AFTER_CHECK="$(cat "${TMP_PII}")"
if [[ "${BEFORE_CHECK}" == "${AFTER_CHECK}" ]]; then
  pass "--check does not modify file"
else
  fail "--check should not modify file"
fi
rm -f "${TMP_PII}"

# ─── Test: multiple files ─────────────────────────────────────────────────────

echo ""
echo "sanitize.sh — multiple files:"

TMP_A="$(make_temp_file "alice@test.com is here")"
TMP_B="$(make_temp_file "No PII in this file")"

"${SANITIZE}" "${TMP_A}" "${TMP_B}" >/dev/null

assert_file_contains     "file A: email replaced"    "${TMP_A}" "[EMAIL]"
assert_file_not_contains "file A: original removed"  "${TMP_A}" "alice@test.com"
assert_file_contains     "file B: unchanged text"    "${TMP_B}" "No PII"

rm -f "${TMP_A}" "${TMP_B}"

# ─── Test: multiple PII types in one file ────────────────────────────────────

echo ""
echo "sanitize.sh — multi-PII file:"

TMP_MULTI="$(make_temp_file "SSN: 111-22-3333, email: bob@example.org, card: 5500-0000-0000-0004")"

"${SANITIZE}" "${TMP_MULTI}" >/dev/null

assert_file_contains     "SSN placeholder present"   "${TMP_MULTI}" "[SSN]"
assert_file_contains     "email placeholder present" "${TMP_MULTI}" "[EMAIL]"
assert_file_contains     "CC placeholder present"    "${TMP_MULTI}" "[CC]"
assert_file_not_contains "original SSN gone"         "${TMP_MULTI}" "111-22-3333"
assert_file_not_contains "original email gone"       "${TMP_MULTI}" "bob@example.org"
assert_file_not_contains "original CC gone"          "${TMP_MULTI}" "5500-0000-0000-0004"

rm -f "${TMP_MULTI}"

# ─── Test: --check mode with email ───────────────────────────────────────────

echo ""
echo "sanitize.sh — check mode email:"

TMP_EMAIL2="$(make_temp_file "Contact: support@company.io")"
assert_exit "--check with email exits 1" 1 "${SANITIZE}" --check "${TMP_EMAIL2}"
rm -f "${TMP_EMAIL2}"

# ─── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo "──────────────────────────────────────────────────────────"
echo "Results: ${passed} passed, ${failed} failed ($((passed + failed)) total)"

if [[ ${#failures[@]} -gt 0 ]]; then
  echo ""
  echo "Failures:"
  for f in "${failures[@]}"; do
    echo "  FAIL  ${f}"
  done
fi

[[ ${failed} -eq 0 ]]
