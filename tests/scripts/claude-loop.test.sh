#!/usr/bin/env bash
# tests/scripts/claude-loop.test.sh — Unit tests for claude-loop.sh
#
# Tests the script's structure, flag parsing, and helper functions WITHOUT
# actually running the `claude` CLI. Each test is isolated in a subshell to
# prevent state leakage.
#
# Run: bash tests/scripts/claude-loop.test.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="${REPO_ROOT}/scripts/claude-loop.sh"

# ─── Minimal test runner ──────────────────────────────────────────────────────

PASSED=0
FAILED=0
FAILURES=()

pass() { PASSED=$(( PASSED + 1 )); printf '  \u2713 %s\n' "$1"; }
fail() {
  FAILED=$(( FAILED + 1 ))
  FAILURES+=("$1: $2")
  printf '  \u2717 %s\n' "$1"
  printf '    %s\n' "$2"
}

run_test() {
  local name="$1"
  local fn="$2"
  local output
  local rc=0
  output="$("${fn}" 2>&1)" || rc=$?
  if [[ ${rc} -eq 0 ]]; then
    pass "${name}"
  else
    fail "${name}" "${output}"
  fi
}

# ─── Source helper functions in isolation ─────────────────────────────────────
# We cannot source the full script (it would start executing the main loop),
# so we extract and eval only the pure helper functions we need to unit-test.
# The helpers are: get_next_task, mark_task_done, mark_task_fail, get_task_attempts.

_load_helpers() {
  # Extract the four helper function definitions from the script and eval them.
  # This is safe because no network/disk side-effects occur in the definitions.
  local src
  src="$(awk '
    /^# get_next_task /,/^}$/ { print; next }
    /^# get_task_attempts /,/^}$/ { print; next }
    /^# mark_task_done /,/^}$/ { print; next }
    /^# mark_task_fail /,/^}$/ { print; next }
  ' "${SCRIPT}")"
  eval "${src}"
}

# ─── Test 1: --help exits 0 and prints usage ──────────────────────────────────

t_help() {
  local out
  out="$(bash "${SCRIPT}" --help 2>&1)"
  local rc=$?
  [[ ${rc} -eq 0 ]] || { echo "--help exit code was ${rc}, expected 0"; return 1; }
  echo "${out}" | grep -q "Usage: claude-loop" \
    || { echo "--help output did not contain 'Usage: claude-loop'"; return 1; }
  echo "${out}" | grep -q "\-\-task-queue" \
    || { echo "--help output did not list --task-queue"; return 1; }
}
run_test "--help exits 0 and prints usage" t_help

# ─── Test 2: --dry-run prints plan without running claude ─────────────────────

t_dry_run() {
  # Stub out `claude` so that if it were called it would fail loudly.
  local tmpbin
  tmpbin="$(mktemp -d)"
  cat > "${tmpbin}/claude" <<'EOF'
#!/usr/bin/env bash
echo "STUB claude CALLED — should not happen in dry-run" >&2
exit 99
EOF
  chmod +x "${tmpbin}/claude"

  local out rc=0
  out="$(PATH="${tmpbin}:${PATH}" bash "${SCRIPT}" --dry-run 2>&1)" || rc=$?

  rm -rf "${tmpbin}"

  [[ ${rc} -eq 0 ]] || { echo "--dry-run exit code was ${rc}, expected 0"; return 1; }
  echo "${out}" | grep -q "dry-run" \
    || { echo "--dry-run output missing 'dry-run' header"; return 1; }
  echo "${out}" | grep -qi "claude" \
    || { echo "--dry-run output should mention claude command"; return 1; }
  # Verify the stub was never called
  echo "${out}" | grep -q "STUB claude CALLED" \
    && { echo "--dry-run actually invoked claude (should not)"; return 1; }
  return 0
}
run_test "--dry-run shows plan without executing claude" t_dry_run

# ─── Test 3: get_next_task — finds first unchecked item ──────────────────────

t_get_next_task_basic() {
  _load_helpers

  local tmpfile
  tmpfile="$(mktemp)"
  cat > "${tmpfile}" <<'EOF'
- [x] Already done
- [ ] First pending task
- [ ] Second pending task
EOF

  local result
  result="$(get_next_task "${tmpfile}")"
  rm -f "${tmpfile}"

  [[ "${result}" == "First pending task" ]] \
    || { echo "Expected 'First pending task', got '${result}'"; return 1; }
}
run_test "get_next_task returns first unchecked task" t_get_next_task_basic

t_get_next_task_empty_queue() {
  _load_helpers

  local tmpfile
  tmpfile="$(mktemp)"
  cat > "${tmpfile}" <<'EOF'
- [x] All done
- [x] Also done
EOF

  local rc=0
  get_next_task "${tmpfile}" > /dev/null 2>&1 || rc=$?
  rm -f "${tmpfile}"

  [[ ${rc} -ne 0 ]] \
    || { echo "Expected non-zero exit when queue is exhausted, got 0"; return 1; }
}
run_test "get_next_task returns non-zero when queue is empty" t_get_next_task_empty_queue

t_get_next_task_skips_fail() {
  _load_helpers

  local tmpfile
  tmpfile="$(mktemp)"
  cat > "${tmpfile}" <<'EOF'
- [x] Done
- [FAIL] Failed task (attempts: 3)
- [ ] Next viable task
EOF

  local result
  result="$(get_next_task "${tmpfile}")"
  rm -f "${tmpfile}"

  [[ "${result}" == "Next viable task" ]] \
    || { echo "Expected 'Next viable task', got '${result}'"; return 1; }
}
run_test "get_next_task skips [FAIL] and [x] entries" t_get_next_task_skips_fail

# ─── Test 4: mark_task_done — marks first matching unchecked task ─────────────

t_mark_task_done() {
  _load_helpers

  local tmpfile
  tmpfile="$(mktemp)"
  cat > "${tmpfile}" <<'EOF'
- [x] Already done
- [ ] Implement login endpoint
- [ ] Add validation
EOF

  mark_task_done "${tmpfile}" "Implement login endpoint"

  local content
  content="$(cat "${tmpfile}")"
  rm -f "${tmpfile}"

  echo "${content}" | grep -q "\- \[x\] Implement login endpoint" \
    || { echo "Task was not marked [x]; content:\n${content}"; return 1; }
  # Second task should remain unchecked
  echo "${content}" | grep -q "\- \[ \] Add validation" \
    || { echo "Second task was incorrectly modified; content:\n${content}"; return 1; }
}
run_test "mark_task_done marks the correct task [x]" t_mark_task_done

# ─── Test 5: mark_task_fail — marks task [FAIL] with attempt count ────────────

t_mark_task_fail_first() {
  _load_helpers

  local tmpfile
  tmpfile="$(mktemp)"
  cat > "${tmpfile}" <<'EOF'
- [ ] Fix authentication bug
- [ ] Other task
EOF

  mark_task_fail "${tmpfile}" "Fix authentication bug" 1

  local content
  content="$(cat "${tmpfile}")"
  rm -f "${tmpfile}"

  echo "${content}" | grep -q "\[FAIL\] Fix authentication bug (attempts: 1)" \
    || { echo "Task not marked [FAIL] correctly; content:\n${content}"; return 1; }
  echo "${content}" | grep -q "\- \[ \] Other task" \
    || { echo "Other task was incorrectly modified; content:\n${content}"; return 1; }
}
run_test "mark_task_fail marks task [FAIL] with attempt count" t_mark_task_fail_first

t_mark_task_fail_increment() {
  _load_helpers

  local tmpfile
  tmpfile="$(mktemp)"
  cat > "${tmpfile}" <<'EOF'
- [FAIL] Fix authentication bug (attempts: 2)
EOF

  mark_task_fail "${tmpfile}" "Fix authentication bug" 3

  local content
  content="$(cat "${tmpfile}")"
  rm -f "${tmpfile}"

  echo "${content}" | grep -q "(attempts: 3)" \
    || { echo "Attempt count not updated to 3; content:\n${content}"; return 1; }
}
run_test "mark_task_fail updates existing [FAIL] attempt count" t_mark_task_fail_increment

# ─── Test 6: Lock file — second invocation cannot acquire lock ────────────────

t_lock_prevents_double_run() {
  # Hold the lock ourselves, then verify the script exits non-zero with an error.
  local cwd_hash
  cwd_hash="$(pwd | md5sum | cut -c1-8)"
  local lock_file="/tmp/claude-loop-${cwd_hash}.lock"

  # Open lock file on fd 8 and hold it for the duration of this subshell.
  exec 8>"${lock_file}"
  flock -x 8

  local out rc=0
  # Run script without --dry-run so it tries to acquire the lock.
  # We must not let it actually exec claude, so stub it.
  local tmpbin
  tmpbin="$(mktemp -d)"
  cat > "${tmpbin}/claude" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  chmod +x "${tmpbin}/claude"

  out="$(PATH="${tmpbin}:${PATH}" bash "${SCRIPT}" 2>&1)" || rc=$?

  # Release lock and clean up
  exec 8>&-
  rm -f "${lock_file}"
  rm -rf "${tmpbin}"

  [[ ${rc} -ne 0 ]] \
    || { echo "Expected non-zero exit when lock is held, got 0"; return 1; }
  echo "${out}" | grep -qi "already running\|lock" \
    || { echo "Expected lock error message, got: ${out}"; return 1; }
}
run_test "lock prevents second claude-loop from starting" t_lock_prevents_double_run

# ─── Test 7: --dry-run with --task-queue shows next task ─────────────────────

t_dry_run_with_queue() {
  local tmpqueue
  tmpqueue="$(mktemp)"
  cat > "${tmpqueue}" <<'EOF'
- [x] Done already
- [ ] Build the widget
- [ ] Deploy to staging
EOF

  local out rc=0
  out="$(bash "${SCRIPT}" --dry-run --task-queue "${tmpqueue}" 2>&1)" || rc=$?
  rm -f "${tmpqueue}"

  [[ ${rc} -eq 0 ]] || { echo "Exit code was ${rc}, expected 0"; return 1; }
  echo "${out}" | grep -q "Build the widget" \
    || { echo "Expected next task 'Build the widget' in output; got:\n${out}"; return 1; }
}
run_test "--dry-run with --task-queue shows next pending task" t_dry_run_with_queue

# ─── Test 8: --status exits 0 ────────────────────────────────────────────────

t_status_exits_zero() {
  local out rc=0
  out="$(bash "${SCRIPT}" --status 2>&1)" || rc=$?
  [[ ${rc} -eq 0 ]] \
    || { echo "--status exit code was ${rc}, expected 0; output: ${out}"; return 1; }
  echo "${out}" | grep -q "claude-loop status" \
    || { echo "--status output missing header; got: ${out}"; return 1; }
}
run_test "--status exits 0 and prints status header" t_status_exits_zero

# ─── Test 9a: Signal without sentinel stops the loop ─────────────────────────

t_signal_no_sentinel_stops() {
  local tmpbin tmpdir
  tmpbin="$(mktemp -d)"
  tmpdir="$(mktemp -d)"
  # Stub claude: exits 130 (SIGINT) without writing sentinel
  cat > "${tmpbin}/claude" <<'STUBEOF'
#!/usr/bin/env bash
exit 130
STUBEOF
  chmod +x "${tmpbin}/claude"

  local out rc=0
  out="$(cd "${tmpdir}" && PATH="${tmpbin}:${PATH}" bash "${SCRIPT}" --max-sessions 3 2>&1)" || rc=$?
  rm -rf "${tmpbin}" "${tmpdir}"

  local session_count
  session_count="$(echo "${out}" | grep -c "starting session" || true)"
  [[ "${session_count}" -eq 1 ]] \
    || { echo "Expected 1 session, got ${session_count}; output: ${out}"; return 1; }

  echo "${out}" | grep -q "stopped by signal" \
    || { echo "Expected 'stopped by signal' message; output: ${out}"; return 1; }
}
run_test "signal without sentinel stops loop" t_signal_no_sentinel_stops

# ─── Test 9b: Signal with sentinel restarts (sentinel overrides signal) ──────

t_signal_with_sentinel_restarts() {
  local tmpbin tmpdir
  tmpbin="$(mktemp -d)"
  tmpdir="$(mktemp -d)"
  # Stub claude: writes sentinel then exits 130
  cat > "${tmpbin}/claude" <<'STUBEOF'
#!/usr/bin/env bash
if [[ -n "${CLAUDE_LOOP_SENTINEL:-}" ]]; then
  touch "${CLAUDE_LOOP_SENTINEL}"
fi
exit 130
STUBEOF
  chmod +x "${tmpbin}/claude"

  local out rc=0
  out="$(cd "${tmpdir}" && PATH="${tmpbin}:${PATH}" bash "${SCRIPT}" --max-sessions 3 2>&1)" || rc=$?
  rm -rf "${tmpbin}" "${tmpdir}"

  # Sentinel should override signal — loop restarts until max-sessions
  echo "${out}" | grep -q "sentinel found" \
    || { echo "Expected 'sentinel found' message; output: ${out}"; return 1; }
  echo "${out}" | grep -q "max sessions" \
    || { echo "Expected loop to restart until max-sessions; output: ${out}"; return 1; }
}
run_test "signal with sentinel restarts (sentinel overrides)" t_signal_with_sentinel_restarts

# ─── Test 10: Interactive mode restarts on normal exit (no sentinel) ──────────
# In interactive mode (no task queue), exit code 0 should restart the loop.
# Only signals (Ctrl+C) should stop it.

t_interactive_restart_on_exit0() {
  local tmpbin tmpdir
  tmpbin="$(mktemp -d)"
  tmpdir="$(mktemp -d)"
  # Stub claude: exits 0 immediately (simulates /exit)
  cat > "${tmpbin}/claude" <<'STUBEOF'
#!/usr/bin/env bash
exit 0
STUBEOF
  chmod +x "${tmpbin}/claude"

  local out rc=0
  # Run from tmpdir to avoid lock conflict with any active claude-loop.
  # No --task-queue = interactive mode. --max-sessions 3 caps the loop.
  out="$(cd "${tmpdir}" && PATH="${tmpbin}:${PATH}" bash "${SCRIPT}" --max-sessions 3 2>&1)" || rc=$?
  rm -rf "${tmpbin}" "${tmpdir}"

  # Should have started 3 sessions (restarted twice), then hit max-sessions
  echo "${out}" | grep -q "max sessions" \
    || { echo "Expected 'max sessions' stop; output: ${out}"; return 1; }

  # Should mention interactive restart
  echo "${out}" | grep -q "restarting session" \
    || { echo "Expected 'restarting session' message; output: ${out}"; return 1; }

  # Should NOT mention "exited without sentinel" (old stopping behavior)
  # Use if/then instead of && to avoid set -e + pipefail killing the function
  if echo "${out}" | grep -q "exited without sentinel"; then
    echo "Should not stop on exit 0 in interactive mode; output: ${out}"; return 1
  fi
}
run_test "interactive mode restarts on exit 0 (no sentinel needed)" t_interactive_restart_on_exit0

# ─── Test 11: Sentinel watcher kills claude and triggers restart ─────────

t_sentinel_watcher_kills_claude() {
  local tmpbin tmpdir
  tmpbin="$(mktemp -d)"
  tmpdir="$(mktemp -d)"
  # Stub claude: writes sentinel then hangs (simulates interactive session)
  cat > "${tmpbin}/claude" <<'STUBEOF'
#!/usr/bin/env bash
# Write sentinel file (simulating /checkpoint writing it)
if [[ -n "${CLAUDE_LOOP_SENTINEL:-}" ]]; then
  echo '{"reason":"checkpoint"}' > "${CLAUDE_LOOP_SENTINEL}"
fi
# Hang until killed (simulates interactive session waiting for input)
sleep 60
STUBEOF
  chmod +x "${tmpbin}/claude"

  local out rc=0
  # SENTINEL_POLL_INTERVAL=0.5 for fast test; --max-sessions 2 to verify restart
  out="$(cd "${tmpdir}" && SENTINEL_POLL_INTERVAL=0.5 PATH="${tmpbin}:${PATH}" \
    bash "${SCRIPT}" --max-sessions 2 2>&1)" || rc=$?
  rm -rf "${tmpbin}" "${tmpdir}"

  # Should have started 2 sessions (watcher killed first, loop restarted)
  local session_count
  session_count="$(echo "${out}" | grep -c "starting session" || true)"
  [[ "${session_count}" -ge 2 ]] \
    || { echo "Expected at least 2 sessions, got ${session_count}; output: ${out}"; return 1; }

  # Should mention sentinel restart
  echo "${out}" | grep -q "sentinel" \
    || { echo "Expected 'sentinel' in output; output: ${out}"; return 1; }
}
run_test "sentinel watcher kills claude and triggers restart" t_sentinel_watcher_kills_claude

# ─── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo "Results: ${PASSED} passed, ${FAILED} failed"

if [[ ${FAILED} -gt 0 ]]; then
  echo ""
  echo "Failures:"
  for f in "${FAILURES[@]}"; do
    echo "  - ${f}"
  done
  exit 1
fi

exit 0
