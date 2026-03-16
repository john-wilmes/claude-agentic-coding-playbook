#!/usr/bin/env bash
# Tests for scripts/q — structural and flag-parsing tests only.
# Does NOT make real API calls.
#
# Run: bash tests/scripts/q.test.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
Q="${REPO_ROOT}/scripts/q"

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
  actual="$("$@" 2>/dev/null; echo $?)" || true
  # The above captures the exit code printed by the last echo
  # Re-do properly:
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

assert_stderr_contains() {
  local name="$1" pattern="$2"
  shift 2
  local output
  set +e
  output="$("$@" 2>&1 >/dev/null)"
  set -e
  if echo "${output}" | grep -qF -- "${pattern}"; then
    pass "${name}"
  else
    fail "${name} (pattern '${pattern}' not found in stderr: ${output})"
  fi
}

# ─── Test: script exists and is executable ────────────────────────────────────

if [[ -x "${Q}" ]]; then
  pass "script is executable"
else
  fail "script is not executable or missing at ${Q}"
fi

# ─── Test: --help exits 0 and prints usage ────────────────────────────────────

assert_exit       "--help exits 0"              0 "${Q}" --help
assert_stdout_contains "--help mentions Usage"  "Usage:" "${Q}" --help
assert_stdout_contains "--help mentions --model" "--model" "${Q}" --help
assert_stdout_contains "--help mentions --no-log" "--no-log" "${Q}" --help
assert_stdout_contains "--help mentions --system" "--system" "${Q}" --help
assert_stdout_contains "--help mentions ANTHROPIC_API_KEY" "ANTHROPIC_API_KEY" "${Q}" --help

# ─── Test: missing ANTHROPIC_API_KEY exits 1 with clear error ─────────────────

assert_exit "missing API key exits 1" 1 \
  env -u ANTHROPIC_API_KEY "${Q}" "test prompt"

assert_stderr_contains "missing API key prints ANTHROPIC_API_KEY in message" \
  "ANTHROPIC_API_KEY" \
  env -u ANTHROPIC_API_KEY "${Q}" "test prompt"

# ─── Test: unknown flag exits 1 with hint ─────────────────────────────────────

assert_exit "unknown flag exits 1" 1 \
  env ANTHROPIC_API_KEY=fake "${Q}" --unknown-flag "prompt"

assert_stderr_contains "unknown flag mentions --help" \
  "--help" \
  env ANTHROPIC_API_KEY=fake "${Q}" --unknown-flag "prompt"

# ─── Test: --no-log flag is recognized (reaches API key check, not flag error) ─

# With a fake key, it will fail at the API call stage, not at flag parsing.
# We verify the error message is about the API (or key), not about --no-log.
set +e
NOLOG_STDERR="$(env ANTHROPIC_API_KEY=fake "${Q}" --no-log "test prompt" 2>&1 >/dev/null)"
NOLOG_EXIT=$?
set -e

if [[ "${NOLOG_EXIT}" -ne 0 ]] && ! echo "${NOLOG_STDERR}" | grep -qF "unknown option"; then
  pass "--no-log flag is recognized (does not trigger unknown-flag error)"
else
  if [[ "${NOLOG_EXIT}" -eq 0 ]]; then
    fail "--no-log flag: expected non-zero exit with fake key"
  else
    fail "--no-log flag triggered unknown-flag error (flag not recognized)"
  fi
fi

# ─── Test: --model flag is recognized ────────────────────────────────────────

set +e
MODEL_STDERR="$(env ANTHROPIC_API_KEY=fake "${Q}" --model claude-sonnet-4-6 "test prompt" 2>&1 >/dev/null)"
MODEL_EXIT=$?
set -e

if [[ "${MODEL_EXIT}" -ne 0 ]] && ! echo "${MODEL_STDERR}" | grep -qF "unknown option"; then
  pass "--model flag is recognized"
else
  if [[ "${MODEL_EXIT}" -eq 0 ]]; then
    fail "--model flag: expected non-zero exit with fake key"
  else
    fail "--model flag triggered unknown-flag error (flag not recognized)"
  fi
fi

# ─── Test: --system flag is recognized ───────────────────────────────────────

set +e
SYS_STDERR="$(env ANTHROPIC_API_KEY=fake "${Q}" --system "Be helpful." "test prompt" 2>&1 >/dev/null)"
SYS_EXIT=$?
set -e

if [[ "${SYS_EXIT}" -ne 0 ]] && ! echo "${SYS_STDERR}" | grep -qF "unknown option"; then
  pass "--system flag is recognized"
else
  if [[ "${SYS_EXIT}" -eq 0 ]]; then
    fail "--system flag: expected non-zero exit with fake key"
  else
    fail "--system flag triggered unknown-flag error (flag not recognized)"
  fi
fi

# ─── Test: empty stdin with no args exits 1 ──────────────────────────────────

assert_exit "empty stdin and no prompt exits 1" 1 \
  bash -c "echo -n '' | env ANTHROPIC_API_KEY=fake '${Q}'"

# ─── Test: --model requires an argument ──────────────────────────────────────

assert_exit "--model with no value exits 1" 1 \
  env ANTHROPIC_API_KEY=fake "${Q}" --model

assert_stderr_contains "--model missing arg prints message" \
  "--model" \
  env ANTHROPIC_API_KEY=fake "${Q}" --model

# ─── Test: --system requires an argument ─────────────────────────────────────

assert_exit "--system with no value exits 1" 1 \
  env ANTHROPIC_API_KEY=fake "${Q}" --system

assert_stderr_contains "--system missing arg prints message" \
  "--system" \
  env ANTHROPIC_API_KEY=fake "${Q}" --system

# ─── Summary ─────────────────────────────────────────────────────────────────

echo ""
echo "Results: ${passed} passed, ${failed} failed"

if [[ "${failed}" -gt 0 ]]; then
  echo ""
  echo "Failures:"
  for f in "${failures[@]}"; do
    echo "  - ${f}"
  done
  exit 1
fi

exit 0
