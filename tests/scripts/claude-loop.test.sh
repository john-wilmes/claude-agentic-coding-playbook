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
    /^# task_is_checked /,/^}$/ { print; next }
    /^# auto_commit_task /,/^}$/ { print; next }
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

# ─── Test 1b: --version exits 0 and prints a version string ──────────────────

t_version() {
  local out rc=0
  out="$(bash "${SCRIPT}" --version 2>&1)" || rc=$?
  [[ ${rc} -eq 0 ]] || { echo "--version exit code was ${rc}, expected 0"; return 1; }
  [[ -n "${out}" ]] || { echo "--version produced no output"; return 1; }
}
run_test "--version exits 0 and prints version string" t_version

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

# ─── Test 4b: mark_task_done converts [FAIL] entry to [x] ───────────────────

t_mark_task_done_from_fail() {
  _load_helpers

  local tmpfile
  tmpfile="$(mktemp)"
  cat > "${tmpfile}" <<'EOF'
- [FAIL] Fix authentication bug (attempts: 3)
- [ ] Other task
EOF

  mark_task_done "${tmpfile}" "Fix authentication bug"

  local content
  content="$(cat "${tmpfile}")"
  rm -f "${tmpfile}"

  echo "${content}" | grep -q "\- \[x\] Fix authentication bug" \
    || { echo "[FAIL] entry not converted to [x]; content: ${content}"; return 1; }
  # Should NOT still have [FAIL]
  if echo "${content}" | grep -q "\[FAIL\]"; then
    echo "[FAIL] marker still present after mark_task_done; content: ${content}"; return 1
  fi
  # Other task should remain unchecked
  echo "${content}" | grep -q "\- \[ \] Other task" \
    || { echo "Other task was incorrectly modified; content: ${content}"; return 1; }
}
run_test "mark_task_done converts [FAIL] entry to [x]" t_mark_task_done_from_fail

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
  # Run from a tmpdir so the lock hash won't collide with any active claude-loop
  # running in the repo directory.
  local tmpbin tmpdir
  tmpbin="$(mktemp -d)"
  tmpdir="$(mktemp -d)"

  local cwd_hash
  cwd_hash="$(echo "${tmpdir}" | md5sum | cut -c1-8)"
  local lock_file="/tmp/claude-loop-${cwd_hash}.lock"

  # Open lock file on fd 8 and hold it for the duration of this subshell.
  exec 8>"${lock_file}"
  flock -x 8

  # Stub claude so it won't actually run.
  cat > "${tmpbin}/claude" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  chmod +x "${tmpbin}/claude"

  local out rc=0
  out="$(cd "${tmpdir}" && PATH="${tmpbin}:${PATH}" bash "${SCRIPT}" 2>&1)" || rc=$?

  # Release lock and clean up
  exec 8>&-
  rm -f "${lock_file}"
  rm -rf "${tmpbin}" "${tmpdir}"

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
  # Stub claude: writes sentinel using CLAUDE_LOOP_PID then exits 130
  cat > "${tmpbin}/claude" <<'STUBEOF'
#!/usr/bin/env bash
if [[ -n "${CLAUDE_LOOP_PID:-}" ]]; then
  touch "/tmp/claude-checkpoint-exit-${CLAUDE_LOOP_PID}"
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
  # Stub claude: writes sentinel using CLAUDE_LOOP_PID then hangs (simulates interactive session)
  cat > "${tmpbin}/claude" <<'STUBEOF'
#!/usr/bin/env bash
# Write sentinel file using PID (simulating /checkpoint writing it)
# CLAUDE_LOOP_PID is the stable identifier; CLAUDE_LOOP_SENTINEL may be overridden.
if [[ -n "${CLAUDE_LOOP_PID:-}" ]]; then
  echo '{"reason":"checkpoint"}' > "/tmp/claude-checkpoint-exit-${CLAUDE_LOOP_PID}"
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

# ─── Test 12: task_is_checked — detects [x] tasks ───────────────────────────

t_task_is_checked_true() {
  _load_helpers

  local tmpfile
  tmpfile="$(mktemp)"
  cat > "${tmpfile}" <<'EOF'
- [x] Build the widget
- [ ] Deploy to staging
EOF

  local rc=0
  task_is_checked "${tmpfile}" "Build the widget" || rc=$?
  rm -f "${tmpfile}"

  [[ ${rc} -eq 0 ]] \
    || { echo "Expected 0 for [x] task, got ${rc}"; return 1; }
}
run_test "task_is_checked returns 0 for [x] task" t_task_is_checked_true

t_task_is_checked_false_unchecked() {
  _load_helpers

  local tmpfile
  tmpfile="$(mktemp)"
  cat > "${tmpfile}" <<'EOF'
- [ ] Build the widget
- [x] Other task
EOF

  local rc=0
  task_is_checked "${tmpfile}" "Build the widget" || rc=$?
  rm -f "${tmpfile}"

  [[ ${rc} -ne 0 ]] \
    || { echo "Expected non-zero for [ ] task, got 0"; return 1; }
}
run_test "task_is_checked returns non-zero for [ ] task" t_task_is_checked_false_unchecked

t_task_is_checked_false_fail() {
  _load_helpers

  local tmpfile
  tmpfile="$(mktemp)"
  cat > "${tmpfile}" <<'EOF'
- [FAIL] Build the widget (attempts: 3)
EOF

  local rc=0
  task_is_checked "${tmpfile}" "Build the widget" || rc=$?
  rm -f "${tmpfile}"

  [[ ${rc} -ne 0 ]] \
    || { echo "Expected non-zero for [FAIL] task, got 0"; return 1; }
}
run_test "task_is_checked returns non-zero for [FAIL] task" t_task_is_checked_false_fail

# ─── Test 13: Task queue — checked-off task treated as success without sentinel

t_checked_task_no_sentinel_succeeds() {
  local tmpbin tmpdir tmpqueue
  tmpbin="$(mktemp -d)"
  tmpdir="$(mktemp -d)"
  tmpqueue="$(mktemp)"

  # Queue: first task already [x], second is pending
  cat > "${tmpqueue}" <<'EOF'
- [ ] Build the widget
- [ ] Deploy to staging
EOF

  # Stub claude: checks off the task in the queue file, then exits 0 (no sentinel)
  cat > "${tmpbin}/claude" <<STUBEOF
#!/usr/bin/env bash
# Simulate agent checking off the task in the queue file
sed -i 's/- \[ \] Build the widget/- [x] Build the widget/' "${tmpqueue}"
exit 0
STUBEOF
  chmod +x "${tmpbin}/claude"

  local out rc=0
  out="$(cd "${tmpdir}" && PATH="${tmpbin}:${PATH}" \
    bash "${SCRIPT}" --task-queue "${tmpqueue}" --max-sessions 2 2>&1)" || rc=$?

  local content
  content="$(cat "${tmpqueue}")"
  rm -rf "${tmpbin}" "${tmpdir}" "${tmpqueue}"

  # Should see "checked off, no sentinel" success message
  echo "${out}" | grep -q "checked off, no sentinel" \
    || { echo "Expected 'checked off, no sentinel' message; output: ${out}"; return 1; }

  # Should NOT see "attempt failed" for the first task
  if echo "${out}" | grep -q "attempt.*failed.*Build the widget"; then
    echo "First task should not be marked as failed; output: ${out}"; return 1
  fi
}
run_test "checked-off task without sentinel treated as success" t_checked_task_no_sentinel_succeeds

# ─── Test 14: Task queue advances to next task after failed task exhausts retries

t_advance_after_failed_task() {
  local tmpbin tmpdir tmpqueue
  tmpbin="$(mktemp -d)"
  tmpdir="$(mktemp -d)"
  tmpqueue="$(mktemp)"

  cat > "${tmpqueue}" <<'EOF'
- [ ] Failing task
- [ ] Second task
EOF

  # Stub claude: always exits 1 (never writes sentinel, never checks off task)
  cat > "${tmpbin}/claude" <<'STUBEOF'
#!/usr/bin/env bash
exit 1
STUBEOF
  chmod +x "${tmpbin}/claude"

  local out rc=0
  out="$(cd "${tmpdir}" && PATH="${tmpbin}:${PATH}" \
    bash "${SCRIPT}" --task-queue "${tmpqueue}" --max-sessions 10 2>&1)" || rc=$?

  local content
  content="$(cat "${tmpqueue}")"
  rm -rf "${tmpbin}" "${tmpdir}" "${tmpqueue}"

  # First task should be marked [FAIL]
  echo "${content}" | grep -q "\[FAIL\] Failing task" \
    || { echo "First task not marked [FAIL]; content: ${content}"; return 1; }

  # Should have attempted the second task after first failed
  echo "${out}" | grep -q "Second task" \
    || { echo "Expected loop to advance to 'Second task'; output: ${out}"; return 1; }
}
run_test "task queue advances after failed task exhausts retries" t_advance_after_failed_task

# ─── Test: auto_commit_task commits uncommitted changes ──────────────────────

t_auto_commit_commits() {
  _load_helpers
  local tmpdir
  tmpdir="$(mktemp -d)"
  git -C "${tmpdir}" init -q
  git -C "${tmpdir}" config user.email "test@test.com"
  git -C "${tmpdir}" config user.name "Test"
  # Initial commit so HEAD exists
  touch "${tmpdir}/initial.txt"
  git -C "${tmpdir}" add -A
  git -C "${tmpdir}" commit -q -m "initial"
  # Create an uncommitted file
  echo "new content" > "${tmpdir}/work.txt"
  # Run auto_commit_task from inside the repo
  (cd "${tmpdir}" && auto_commit_task "Test task")
  # Verify the commit was created
  local msg
  msg="$(git -C "${tmpdir}" log -1 --format=%s)"
  rm -rf "${tmpdir}"
  [[ "${msg}" == *"Test task"* ]] \
    || { echo "Expected commit message to contain 'Test task', got: ${msg}"; return 1; }
}
run_test "auto_commit_task commits uncommitted changes" t_auto_commit_commits

# ─── Test: auto_commit_task is no-op when tree is clean ──────────────────────

t_auto_commit_noop_clean() {
  _load_helpers
  local tmpdir
  tmpdir="$(mktemp -d)"
  git -C "${tmpdir}" init -q
  git -C "${tmpdir}" config user.email "test@test.com"
  git -C "${tmpdir}" config user.name "Test"
  touch "${tmpdir}/initial.txt"
  git -C "${tmpdir}" add -A
  git -C "${tmpdir}" commit -q -m "initial"
  local count_before
  count_before="$(git -C "${tmpdir}" rev-list --count HEAD)"
  # Run auto_commit_task on clean tree
  (cd "${tmpdir}" && auto_commit_task "Should not commit")
  local count_after
  count_after="$(git -C "${tmpdir}" rev-list --count HEAD)"
  rm -rf "${tmpdir}"
  [[ "${count_before}" == "${count_after}" ]] \
    || { echo "Expected no new commit, before=${count_before} after=${count_after}"; return 1; }
}
run_test "auto_commit_task is no-op when tree is clean" t_auto_commit_noop_clean

# ─── Test: auto_commit_task is no-op outside git repo ────────────────────────

t_auto_commit_noop_no_git() {
  _load_helpers
  local tmpdir
  tmpdir="$(mktemp -d)"
  # No git init — not a repo
  echo "file" > "${tmpdir}/test.txt"
  local rc=0
  (cd "${tmpdir}" && auto_commit_task "No repo") || rc=$?
  rm -rf "${tmpdir}"
  [[ ${rc} -eq 0 ]] \
    || { echo "Expected exit 0 outside git repo, got ${rc}"; return 1; }
}
run_test "auto_commit_task is no-op outside git repo" t_auto_commit_noop_no_git

# ─── Test 15: --report shows task queue status section ───────────────────────

t_report_task_queue_section() {
  local tmplogdir today logfile
  tmplogdir="$(mktemp -d)"
  today="$(date +%Y-%m-%d)"
  logfile="${tmplogdir}/claude-loop-${today}.jsonl"

  # Write log entries simulating a 3-task run: one done, one failed, one pending
  python3 - "${logfile}" <<'PYEOF'
import json, sys, datetime

logfile = sys.argv[1]
def entry(**kw):
    kw["ts"] = datetime.datetime.utcnow().isoformat() + "Z"
    return json.dumps(kw)

lines = [
    entry(event="session_start",  task="Build the widget",  attempt=1),
    entry(event="session_end",    task="Build the widget",  exit_code=0, sentinel=True,  duration_ms=1000),
    entry(event="task_advance",   task="Build the widget",  status="done"),
    entry(event="session_start",  task="Deploy to staging", attempt=1),
    entry(event="session_end",    task="Deploy to staging", exit_code=1, sentinel=False, duration_ms=500),
    entry(event="task_fail",      task="Deploy to staging", attempts=3),
    entry(event="session_start",  task="Write tests",       attempt=1),
    entry(event="session_end",    task="Write tests",       exit_code=1, sentinel=False, duration_ms=200),
]
with open(logfile, "w") as f:
    for line in lines:
        f.write(line + "\n")
PYEOF

  local out rc=0
  out="$(LOG_DIR="${tmplogdir}" bash "${SCRIPT}" --report 2>&1)" || rc=$?
  rm -rf "${tmplogdir}"

  [[ ${rc} -eq 0 ]] || { echo "Exit code was ${rc}, expected 0; output: ${out}"; return 1; }

  echo "${out}" | grep -q "Task queue:" \
    || { echo "Expected 'Task queue:' section; output: ${out}"; return 1; }
  echo "${out}" | grep -q "\[x\].*Build the widget" \
    || { echo "Expected '[x] Build the widget'; output: ${out}"; return 1; }
  echo "${out}" | grep -q "\[FAIL\].*Deploy to staging" \
    || { echo "Expected '[FAIL] Deploy to staging'; output: ${out}"; return 1; }
  echo "${out}" | grep -q "\[ \].*Write tests" \
    || { echo "Expected '[ ] Write tests'; output: ${out}"; return 1; }
}
run_test "--report shows per-task status in Task queue section" t_report_task_queue_section

# ─── Test 16: --report omits task queue section when log has no task fields ───

t_report_no_task_queue_section() {
  local tmplogdir today logfile
  tmplogdir="$(mktemp -d)"
  today="$(date +%Y-%m-%d)"
  logfile="${tmplogdir}/claude-loop-${today}.jsonl"

  # Write log entries for an interactive (no task queue) run — empty task fields
  python3 - "${logfile}" <<'PYEOF'
import json, sys, datetime

logfile = sys.argv[1]
def entry(**kw):
    kw["ts"] = datetime.datetime.utcnow().isoformat() + "Z"
    return json.dumps(kw)

lines = [
    entry(event="session_start", task="", attempt=1),
    entry(event="session_end",   task="", exit_code=0, sentinel=False, duration_ms=3000),
]
with open(logfile, "w") as f:
    for line in lines:
        f.write(line + "\n")
PYEOF

  local out rc=0
  out="$(LOG_DIR="${tmplogdir}" bash "${SCRIPT}" --report 2>&1)" || rc=$?
  rm -rf "${tmplogdir}"

  [[ ${rc} -eq 0 ]] || { echo "Exit code was ${rc}, expected 0; output: ${out}"; return 1; }

  if echo "${out}" | grep -q "Task queue:"; then
    echo "Task queue section should not appear for interactive logs; output: ${out}"; return 1
  fi
}
run_test "--report omits task queue section for interactive (no-task) logs" t_report_no_task_queue_section

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
