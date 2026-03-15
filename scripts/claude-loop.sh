#!/usr/bin/env bash
# claude-loop.sh — Supervisor that wraps `claude` CLI sessions with auto-restart
# and optional markdown task queue.
#
# Usage:
#   claude-loop                            # basic loop, no task queue
#   claude-loop --task-queue tasks.md      # feed tasks from markdown file
#   claude-loop --status                   # show loop status
#   claude-loop --report                   # show session report from logs
#   claude-loop --dry-run                  # show what would be done
#   claude-loop --help

set -euo pipefail

# ─── Constants ────────────────────────────────────────────────────────────────

# Project-scoped hash: prevents cross-project collisions for lock file.
_CWD_HASH="$(pwd | md5sum | cut -c1-8)"
# Sentinel is PID-scoped (not CWD-scoped) because Claude Code overrides
# CLAUDE_LOOP_SENTINEL after changing process.cwd() to the project directory.
# PID is stable for the lifetime of this claude-loop instance.
SENTINEL_FILE="/tmp/claude-checkpoint-exit-$$"
CLAUDE_PID_FILE="/tmp/claude-loop-cpid-$$"
SENTINEL_POLL_INTERVAL="${SENTINEL_POLL_INTERVAL:-2}"
LOCK_FILE="/tmp/claude-loop-${_CWD_HASH}.lock"
LOG_DIR="${HOME}/.claude/logs"
LOG_FILE="${LOG_DIR}/claude-loop-$(date +%Y-%m-%d).jsonl"
MAX_TASK_ATTEMPTS=3

# ─── Defaults ─────────────────────────────────────────────────────────────────

TASK_QUEUE_FILE=""
MAX_SESSIONS=0          # 0 = unlimited
DRY_RUN=false
STATUS_MODE=false
REPORT_MODE=false

# ─── Argument parsing ─────────────────────────────────────────────────────────

usage() {
  cat <<'EOF'
Usage: claude-loop [OPTIONS]

Supervisor that wraps `claude` CLI sessions with auto-restart.

Options:
  --task-queue FILE    Markdown checklist file to drive tasks
  --max-sessions N     Stop after N sessions (default: unlimited)
  --status             Print current loop status and exit
  --report             Summarize today's log and exit
  --dry-run            Show what would be done without running claude
  --help               Show this message

Sentinel file: /tmp/claude-checkpoint-exit-<pid>
  PID-scoped sentinel. When the checkpoint skill writes this file,
  claude-loop restarts. Natural exit (no sentinel) stops the loop.
  Exported as CLAUDE_LOOP_SENTINEL and CLAUDE_LOOP_PID so hooks and
  skills can find it (CLAUDE_LOOP_PID is the fallback if Claude Code
  overrides CLAUDE_LOOP_SENTINEL).

Task queue format (tasks.md):
  - [ ] Task not yet done
  - [x] Completed task
  - [FAIL] Failed task (attempts: 3)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help)
      usage
      exit 0
      ;;
    --task-queue)
      if [[ $# -lt 2 || "$2" == --* ]]; then
        echo "claude-loop: --task-queue requires a FILE argument" >&2
        exit 1
      fi
      TASK_QUEUE_FILE="$2"
      shift 2
      ;;
    --max-sessions)
      if [[ $# -lt 2 || "$2" == --* ]]; then
        echo "claude-loop: --max-sessions requires a number" >&2
        exit 1
      fi
      MAX_SESSIONS="$2"
      shift 2
      ;;
    --status)
      STATUS_MODE=true
      shift
      ;;
    --report)
      REPORT_MODE=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -*)
      echo "claude-loop: unknown option: $1" >&2
      echo "Run 'claude-loop --help' for usage." >&2
      exit 1
      ;;
    *)
      echo "claude-loop: unexpected argument: $1" >&2
      echo "Run 'claude-loop --help' for usage." >&2
      exit 1
      ;;
  esac
done

# ─── Logging ──────────────────────────────────────────────────────────────────

log_event() {
  # log_event KEY=VALUE [KEY=VALUE ...]
  # Emits a JSONL record to LOG_FILE. Always adds "ts" field.
  mkdir -p "${LOG_DIR}"

  local pairs=("$@")
  local json
  # Build JSON manually; python3 is used to ensure proper escaping.
  json="$(python3 - "${pairs[@]}" <<'PYEOF'
import json, sys, datetime

pairs = sys.argv[1:]
record = {"ts": datetime.datetime.utcnow().isoformat() + "Z"}
for pair in pairs:
    if "=" in pair:
        key, _, val = pair.partition("=")
        # Attempt numeric conversion
        try:
            record[key] = int(val)
        except ValueError:
            try:
                record[key] = float(val)
            except ValueError:
                if val.lower() == "true":
                    record[key] = True
                elif val.lower() == "false":
                    record[key] = False
                else:
                    record[key] = val
print(json.dumps(record))
PYEOF
)"
  echo "${json}" >> "${LOG_FILE}"
}

# ─── Task queue helpers ────────────────────────────────────────────────────────

# get_next_task FILE
# Prints the text of the first unchecked task (- [ ] ...) to stdout.
# Returns exit code 1 if no unchecked task exists.
get_next_task() {
  local file="$1"
  local line
  while IFS= read -r line; do
    if [[ "${line}" =~ ^[[:space:]]*-[[:space:]]\[[[:space:]]\][[:space:]]+(.*) ]]; then
      printf '%s\n' "${BASH_REMATCH[1]}"
      return 0
    fi
  done < "${file}"
  return 1
}

# get_task_attempts FILE TASK_TEXT
# Prints the current attempt count for a task marked [FAIL].
# Returns 0 (count=0) if no failure record found.
get_task_attempts() {
  local file="$1"
  local task="$2"
  local line
  while IFS= read -r line; do
    # Match: - [FAIL] <task text> (attempts: N)
    if [[ "${line}" =~ -[[:space:]]\[FAIL\][[:space:]]+"${task//[/\\[}".*\(attempts:[[:space:]]*([0-9]+)\) ]]; then
      printf '%s\n' "${BASH_REMATCH[1]}"
      return 0
    fi
  done < "${file}"
  printf '0\n'
}

# mark_task_done FILE TASK_TEXT
# Replaces the first matching `- [ ] TASK` or `- [FAIL] TASK (attempts: N)` with `- [x] TASK`.
mark_task_done() {
  local file="$1"
  local task="$2"
  local tmp
  tmp="$(mktemp)"

  local marked=false
  local line
  while IFS= read -r line; do
    if [[ "${marked}" == "false" ]]; then
      # Match unchecked form
      if [[ "${line}" =~ ^([[:space:]]*-[[:space:]])\[[[:space:]]\]([[:space:]]+"${task//[/\\[}".*) ]]; then
        printf '%s[x]%s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" >> "${tmp}"
        marked=true
        continue
      fi
      # Match FAIL form (re-trying a previously failed task that now succeeded)
      if [[ "${line}" =~ ^([[:space:]]*-[[:space:]])\[FAIL\][[:space:]]+"${task//[/\\[}" ]]; then
        printf '%s[x] %s\n' "${BASH_REMATCH[1]}" "${task}" >> "${tmp}"
        marked=true
        continue
      fi
    fi
    printf '%s\n' "${line}" >> "${tmp}"
  done < "${file}"

  mv "${tmp}" "${file}"
}

# mark_task_fail FILE TASK_TEXT ATTEMPTS
# Replaces the first matching `- [ ] TASK` with `- [FAIL] TASK (attempts: N)`.
# If already marked [FAIL], updates the attempt count.
mark_task_fail() {
  local file="$1"
  local task="$2"
  local attempts="$3"
  local tmp
  tmp="$(mktemp)"

  local marked=false
  local line
  while IFS= read -r line; do
    if [[ "${marked}" == "false" ]]; then
      if [[ "${line}" =~ ^([[:space:]]*-[[:space:]])\[[[:space:]]\][[:space:]]+"${task//[/\\[}" ]]; then
        printf '%s[FAIL] %s (attempts: %s)\n' "${BASH_REMATCH[1]}" "${task}" "${attempts}" >> "${tmp}"
        marked=true
        continue
      fi
      if [[ "${line}" =~ ^([[:space:]]*-[[:space:]])\[FAIL\][[:space:]]+"${task//[/\\[}" ]]; then
        printf '%s[FAIL] %s (attempts: %s)\n' "${BASH_REMATCH[1]}" "${task}" "${attempts}" >> "${tmp}"
        marked=true
        continue
      fi
    fi
    printf '%s\n' "${line}" >> "${tmp}"
  done < "${file}"

  mv "${tmp}" "${file}"
}

# task_is_checked FILE TASK_TEXT
# Returns 0 if the task is already marked [x] in the queue file.
task_is_checked() {
  local file="$1"
  local task="$2"
  grep -qE "^\s*-\s*\[x\]\s+${task//[/\\[}" "${file}" 2>/dev/null
}

# ─── Sentinel watcher ─────────────────────────────────────────────────────────

_start_sentinel_watcher() {
  local pid_file="$1"
  (
    # Wait for PID file to appear
    while [[ ! -s "${pid_file}" ]]; do sleep 0.5; done
    local target_pid
    target_pid="$(cat "${pid_file}")"
    # Poll for sentinel; kill claude when found
    while kill -0 "$target_pid" 2>/dev/null; do
      if [[ -f "${SENTINEL_FILE}" ]]; then
        kill -TERM "$target_pid" 2>/dev/null
        break
      fi
      sleep "${SENTINEL_POLL_INTERVAL}"
    done
  ) </dev/null >/dev/null 2>&1 &
  WATCHER_PID=$!
}

# ─── Status mode ──────────────────────────────────────────────────────────────

show_status() {
  echo "claude-loop status"
  echo "  Lock file : ${LOCK_FILE}"

  if [[ -f "${LOCK_FILE}" ]]; then
    # flock lock file exists; check if any process holds it
    if flock -n "${LOCK_FILE}" true 2>/dev/null; then
      echo "  Running   : no (lock file present but not held)"
    else
      echo "  Running   : yes"
    fi
  else
    echo "  Running   : no"
  fi

  echo "  Log file  : ${LOG_FILE}"

  if [[ -f "${LOG_FILE}" ]]; then
    local last_event
    last_event="$(tail -1 "${LOG_FILE}" 2>/dev/null || true)"
    echo "  Last event: ${last_event:-none}"
  else
    echo "  Last event: (no log today)"
  fi

  if [[ -n "${TASK_QUEUE_FILE}" && -f "${TASK_QUEUE_FILE}" ]]; then
    local next_task
    if next_task="$(get_next_task "${TASK_QUEUE_FILE}" 2>/dev/null)"; then
      echo "  Next task : ${next_task}"
    else
      echo "  Next task : (queue empty)"
    fi
  fi
}

# ─── Report mode ──────────────────────────────────────────────────────────────

show_report() {
  echo "claude-loop report — $(date +%Y-%m-%d)"
  echo "  Log: ${LOG_FILE}"
  echo ""

  if [[ ! -f "${LOG_FILE}" ]]; then
    echo "  No log file for today."
    return 0
  fi

  python3 - "${LOG_FILE}" <<'PYEOF'
import json, sys

log_file = sys.argv[1]
sessions = 0
sentinel_restarts = 0
tasks_done = 0
tasks_failed = 0
total_duration_ms = 0

try:
    with open(log_file) as f:
        for raw in f:
            raw = raw.strip()
            if not raw:
                continue
            try:
                rec = json.loads(raw)
            except json.JSONDecodeError:
                continue
            event = rec.get("event", "")
            if event == "session_start":
                sessions += 1
            elif event == "session_end":
                if rec.get("sentinel"):
                    sentinel_restarts += 1
                dur = rec.get("duration_ms", 0)
                total_duration_ms += dur
            elif event == "task_advance":
                tasks_done += 1
            elif event == "task_fail":
                tasks_failed += 1
except FileNotFoundError:
    print("  Log file not found.")
    sys.exit(0)

print(f"  Sessions started   : {sessions}")
print(f"  Sentinel restarts  : {sentinel_restarts}")
print(f"  Tasks completed    : {tasks_done}")
print(f"  Tasks failed       : {tasks_failed}")
if total_duration_ms > 0:
    mins = total_duration_ms // 60000
    secs = (total_duration_ms % 60000) // 1000
    print(f"  Total session time : {mins}m {secs}s")
PYEOF
}

# ─── Signal handling ──────────────────────────────────────────────────────────
#
# Soft/hard signal strategy:
#   First signal  → sets SIGNAL_RECEIVED flag, lets main loop decide based on
#                   sentinel (restart if context-guard requested it, else stop).
#   Second signal → force-stops immediately (user really wants out).
#
# This prevents a propagated SIGINT (e.g. from `claude` exiting) from nuking
# the sentinel file that context-guard wrote for auto-restart.

LOOP_RUNNING=false
SIGNAL_RECEIVED=false
SIGNAL_COUNT=0

handle_signal() {
  SIGNAL_COUNT=$(( SIGNAL_COUNT + 1 ))
  SIGNAL_RECEIVED=true

  if [[ "${SIGNAL_COUNT}" -ge 2 ]]; then
    # Hard stop: user pressed Ctrl+C twice
    rm -f "${SENTINEL_FILE}"
    log_event "event=loop_event" "message=force stopped by repeated signal" "pid=$$" 2>/dev/null || true
    echo ""
    echo "claude-loop: force stopped."
    exit 0
  fi

  # Soft stop: flag it, let the main loop handle restart-vs-stop
  echo ""
  echo "claude-loop: signal received (Ctrl+C again to force stop)."
}

trap handle_signal SIGINT SIGTERM

# ─── Dry-run helper ───────────────────────────────────────────────────────────

dry_run_show() {
  echo "claude-loop dry-run:"
  echo "  Working dir   : $(pwd)"
  echo "  Lock file     : ${LOCK_FILE}"
  echo "  Sentinel file : ${SENTINEL_FILE}"
  echo "  Log file      : ${LOG_FILE}"
  echo "  Max sessions  : ${MAX_SESSIONS:-unlimited}"
  if [[ -n "${TASK_QUEUE_FILE}" ]]; then
    echo "  Task queue    : ${TASK_QUEUE_FILE}"
    if [[ -f "${TASK_QUEUE_FILE}" ]]; then
      local next_task
      if next_task="$(get_next_task "${TASK_QUEUE_FILE}" 2>/dev/null)"; then
        echo "  Next task     : ${next_task}"
        echo "  claude command: claude -p \"/continue -- Next task: ${next_task}\""
      else
        echo "  Next task     : (none — queue is empty or all tasks done)"
        echo "  claude command: (would not run)"
      fi
    else
      echo "  Task queue    : FILE NOT FOUND: ${TASK_QUEUE_FILE}"
    fi
  else
    echo "  Task queue    : (none)"
    echo "  claude command: claude --append-system-prompt \"...\" \"/continue\""
  fi
}

# ─── Validate task queue file ─────────────────────────────────────────────────

if [[ -n "${TASK_QUEUE_FILE}" && ! -f "${TASK_QUEUE_FILE}" ]]; then
  echo "claude-loop: task queue file not found: ${TASK_QUEUE_FILE}" >&2
  exit 1
fi

# ─── Handle informational modes (no locking needed) ──────────────────────────

if [[ "${STATUS_MODE}" == "true" ]]; then
  show_status
  exit 0
fi

if [[ "${REPORT_MODE}" == "true" ]]; then
  show_report
  exit 0
fi

if [[ "${DRY_RUN}" == "true" ]]; then
  dry_run_show
  exit 0
fi

# ─── Acquire lock ─────────────────────────────────────────────────────────────

# Open the lock file on fd 9 and attempt a non-blocking exclusive lock.
# The file descriptor stays open for the lifetime of this process.
exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
  echo "claude-loop: another loop is already running in this directory (lock: ${LOCK_FILE})" >&2
  exit 1
fi

# ─── Main loop ────────────────────────────────────────────────────────────────

# Clean stale sentinel files from previous runs (PID reuse protection)
find /tmp -maxdepth 1 -name 'claude-checkpoint-exit-*' -mmin +10 -delete 2>/dev/null || true

mkdir -p "${LOG_DIR}"
log_event "event=loop_event" "message=loop started" "pid=$$"

LOOP_RUNNING=true
SESSION_COUNT=0

while [[ "${LOOP_RUNNING}" == "true" ]]; do

  # ── Enforce max-sessions limit ──────────────────────────────────────────────
  if [[ "${MAX_SESSIONS}" -gt 0 && "${SESSION_COUNT}" -ge "${MAX_SESSIONS}" ]]; then
    log_event "event=loop_event" "message=max sessions reached" "max_sessions=${MAX_SESSIONS}"
    echo "claude-loop: max sessions (${MAX_SESSIONS}) reached, stopping."
    break
  fi

  # ── Determine task and build claude command ─────────────────────────────────
  CURRENT_TASK=""
  # Default: interactive mode (no -p). Session stays open for user interaction.
  # User exits with Ctrl+C; sentinel from /checkpoint triggers loop restart.
  CLAUDE_CMD=("claude" "--append-system-prompt" "claude-loop started this session. Your first action must be to invoke the /continue skill using the Skill tool." "/continue")

  if [[ -n "${TASK_QUEUE_FILE}" ]]; then
    if ! CURRENT_TASK="$(get_next_task "${TASK_QUEUE_FILE}")"; then
      log_event "event=loop_event" "message=task queue exhausted"
      echo "claude-loop: task queue exhausted, stopping."
      break
    fi
    # Task queue mode: fully autonomous, -p exits after response
    CLAUDE_CMD=("claude" "-p" "/continue -- Next task: ${CURRENT_TASK}")
  fi

  # ── Get attempt count for this task ────────────────────────────────────────
  ATTEMPT=1
  if [[ -n "${CURRENT_TASK}" ]]; then
    PREV_ATTEMPTS="$(get_task_attempts "${TASK_QUEUE_FILE}" "${CURRENT_TASK}")"
    ATTEMPT="$(( PREV_ATTEMPTS + 1 ))"
  fi

  # ── Remove stale sentinel, context-high flag, and PID file ─────────────────
  rm -f "${SENTINEL_FILE}" "${CLAUDE_PID_FILE}" "/tmp/claude-context-high-$$"

  # ── Log session start ──────────────────────────────────────────────────────
  log_event "event=session_start" "task=${CURRENT_TASK:-}" "attempt=${ATTEMPT}"
  echo "claude-loop: starting session $((SESSION_COUNT + 1))${CURRENT_TASK:+ — task: ${CURRENT_TASK}}"

  # ── Run claude ─────────────────────────────────────────────────────────────
  # CLAUDE_LOOP=1 is only set for task-queue (headless -p) mode. It signals
  # skills to work autonomously and force-exit when there's no work, and
  # tells context-guard to write sentinel at 75% for auto-restart.
  # Interactive mode omits it: user is present, no auto-restart needed.
  SESSION_START_MS="$(python3 -c "import time; print(int(time.time() * 1000))")"

  # Start sentinel watcher (polls for sentinel file, kills claude when found)
  _start_sentinel_watcher "${CLAUDE_PID_FILE}"

  # Run claude in foreground via subshell + exec (preserves terminal access, records PID)
  EXIT_CODE=0
  (
    echo $BASHPID > "${CLAUDE_PID_FILE}"
    export CLAUDE_LOOP_PID=$$
    export CLAUDE_LOOP_SENTINEL="${SENTINEL_FILE}"
    [[ -n "${TASK_QUEUE_FILE}" ]] && export CLAUDE_LOOP=1
    exec "${CLAUDE_CMD[@]}"
  ) || EXIT_CODE=$?

  # Clean up watcher
  kill "${WATCHER_PID}" 2>/dev/null || true
  wait "${WATCHER_PID}" 2>/dev/null || true
  rm -f "${CLAUDE_PID_FILE}"
  SESSION_END_MS="$(python3 -c "import time; print(int(time.time() * 1000))")"
  DURATION_MS="$(( SESSION_END_MS - SESSION_START_MS ))"

  # ── Signal-death check ────────────────────────────────────────────────────
  # Exit code 130 = SIGINT (Ctrl+C), 143 = SIGTERM.
  # If a sentinel exists, context-guard requested a restart — honor it.
  # Only stop if there's no sentinel (user genuinely wants out).
  if [[ "${EXIT_CODE}" -eq 130 || "${EXIT_CODE}" -eq 143 ]]; then
    if [[ ! -f "${SENTINEL_FILE}" ]]; then
      log_event "event=loop_event" "message=stopped by signal, no sentinel" "exit_code=${EXIT_CODE}"
      echo "claude-loop: stopped by signal (exit ${EXIT_CODE})."
      break
    fi
    # Sentinel exists — fall through to the sentinel-detection logic below
    log_event "event=loop_event" "message=signal received but sentinel present, restarting" "exit_code=${EXIT_CODE}"
    echo "claude-loop: signal received but sentinel found — will restart."
  fi

  # Reset signal state for next iteration
  SIGNAL_RECEIVED=false
  SIGNAL_COUNT=0

  SESSION_COUNT="$(( SESSION_COUNT + 1 ))"

  # ── Check for sentinel ────────────────────────────────────────────────────
  SENTINEL_DETECTED=false
  if [[ -f "${SENTINEL_FILE}" ]]; then
    SENTINEL_DETECTED=true
    rm -f "${SENTINEL_FILE}"
  fi

  # ── Log session end ───────────────────────────────────────────────────────
  log_event "event=session_end" "task=${CURRENT_TASK:-}" "exit_code=${EXIT_CODE}" \
    "sentinel=${SENTINEL_DETECTED}" "duration_ms=${DURATION_MS}"

  # ── Handle task queue transitions ─────────────────────────────────────────
  if [[ -n "${CURRENT_TASK}" ]]; then
    if [[ "${SENTINEL_DETECTED}" == "true" ]]; then
      # Clean checkpoint exit = task completed successfully
      mark_task_done "${TASK_QUEUE_FILE}" "${CURRENT_TASK}"
      log_event "event=task_advance" "task=${CURRENT_TASK}" "status=done"
      echo "claude-loop: task completed: ${CURRENT_TASK}"
    else
      # No sentinel — check if agent already checked off the task
      if task_is_checked "${TASK_QUEUE_FILE}" "${CURRENT_TASK}"; then
        log_event "event=task_advance" "task=${CURRENT_TASK}" "status=done_no_sentinel"
        echo "claude-loop: task completed (checked off, no sentinel): ${CURRENT_TASK}"
      else
        # Non-sentinel exit = task did not finish cleanly
        if [[ "${ATTEMPT}" -ge "${MAX_TASK_ATTEMPTS}" ]]; then
          mark_task_fail "${TASK_QUEUE_FILE}" "${CURRENT_TASK}" "${ATTEMPT}"
          log_event "event=task_fail" "task=${CURRENT_TASK}" "attempts=${ATTEMPT}"
          echo "claude-loop: task failed after ${ATTEMPT} attempts: ${CURRENT_TASK}"
        else
          mark_task_fail "${TASK_QUEUE_FILE}" "${CURRENT_TASK}" "${ATTEMPT}"
          log_event "event=loop_event" "message=task attempt failed" \
            "task=${CURRENT_TASK}" "attempt=${ATTEMPT}" "max=${MAX_TASK_ATTEMPTS}"
          echo "claude-loop: task attempt ${ATTEMPT}/${MAX_TASK_ATTEMPTS} failed: ${CURRENT_TASK}"

          # Exponential backoff: 10s, 20s, 40s
          BACKOFF_S="$(( 10 * (1 << (ATTEMPT - 1)) ))"
          echo "claude-loop: retrying in ${BACKOFF_S}s..."
          sleep "${BACKOFF_S}"
          continue
        fi
      fi
    fi
  fi

  # ── Decide whether to restart ─────────────────────────────────────────────
  if [[ "${SENTINEL_DETECTED}" == "true" ]]; then
    echo "claude-loop: sentinel restart — cooling down 5s..."
    sleep 5
    # Loop continues (restart)
  elif [[ -z "${TASK_QUEUE_FILE}" && "${EXIT_CODE}" -eq 0 ]]; then
    # Interactive mode: normal exit (e.g. /exit) restarts with a new session.
    # Only signals (Ctrl+C) stop the loop — handled above.
    log_event "event=loop_event" "message=interactive restart (normal exit)" "exit_code=${EXIT_CODE}"
    echo "claude-loop: restarting session — cooling down 5s..."
    sleep 5
    # Loop continues (restart)
  else
    log_event "event=loop_event" "message=natural exit, loop stopped" "exit_code=${EXIT_CODE}"
    echo "claude-loop: claude exited without sentinel (exit ${EXIT_CODE}), stopping."
    LOOP_RUNNING=false
  fi

done

log_event "event=loop_event" "message=loop finished" "sessions=${SESSION_COUNT}"
echo "claude-loop: finished after ${SESSION_COUNT} session(s)."
