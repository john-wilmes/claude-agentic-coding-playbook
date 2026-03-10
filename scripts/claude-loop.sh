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

SENTINEL_FILE="/tmp/claude-checkpoint-exit"
LOG_DIR="${HOME}/.claude/logs"
LOG_FILE="${LOG_DIR}/claude-loop-$(date +%Y-%m-%d).jsonl"
MAX_TASK_ATTEMPTS=3

# Lock file is project-scoped: hash of cwd prevents cross-project collisions.
_CWD_HASH="$(pwd | md5sum | cut -c1-8)"
LOCK_FILE="/tmp/claude-loop-${_CWD_HASH}.lock"

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

Sentinel file: /tmp/claude-checkpoint-exit
  When the checkpoint skill writes this file, claude-loop restarts.
  Natural exit (no sentinel) stops the loop.

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

# ─── Cleanup / signal handling ────────────────────────────────────────────────

LOOP_RUNNING=false

cleanup() {
  LOOP_RUNNING=false
  log_event "event=loop_event" "message=loop stopped by signal" "pid=$$" 2>/dev/null || true
  echo ""
  echo "claude-loop: received signal, stopping."
  exit 0
}

trap cleanup SIGINT SIGTERM

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
    echo "  claude command: claude -p \"/continue\""
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
  CLAUDE_CMD=("claude" "-p" "/continue")

  if [[ -n "${TASK_QUEUE_FILE}" ]]; then
    if ! CURRENT_TASK="$(get_next_task "${TASK_QUEUE_FILE}")"; then
      log_event "event=loop_event" "message=task queue exhausted"
      echo "claude-loop: task queue exhausted, stopping."
      break
    fi
    CLAUDE_CMD=("claude" "-p" "/continue -- Next task: ${CURRENT_TASK}")
  fi

  # ── Get attempt count for this task ────────────────────────────────────────
  ATTEMPT=1
  if [[ -n "${CURRENT_TASK}" ]]; then
    PREV_ATTEMPTS="$(get_task_attempts "${TASK_QUEUE_FILE}" "${CURRENT_TASK}")"
    ATTEMPT="$(( PREV_ATTEMPTS + 1 ))"
  fi

  # ── Remove stale sentinel ──────────────────────────────────────────────────
  rm -f "${SENTINEL_FILE}"

  # ── Log session start ──────────────────────────────────────────────────────
  log_event "event=session_start" "task=${CURRENT_TASK:-}" "attempt=${ATTEMPT}"
  echo "claude-loop: starting session $((SESSION_COUNT + 1))${CURRENT_TASK:+ — task: ${CURRENT_TASK}}"

  # ── Run claude ─────────────────────────────────────────────────────────────
  SESSION_START_MS="$(python3 -c "import time; print(int(time.time() * 1000))")"
  EXIT_CODE=0
  "${CLAUDE_CMD[@]}" || EXIT_CODE=$?
  SESSION_END_MS="$(python3 -c "import time; print(int(time.time() * 1000))")"
  DURATION_MS="$(( SESSION_END_MS - SESSION_START_MS ))"

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

  # ── Decide whether to restart ─────────────────────────────────────────────
  if [[ "${SENTINEL_DETECTED}" == "true" ]]; then
    echo "claude-loop: sentinel restart — cooling down 5s..."
    sleep 5
    # Loop continues (restart)
  else
    # Natural exit or Ctrl+C handled by trap — stop the loop.
    log_event "event=loop_event" "message=natural exit, loop stopped" "exit_code=${EXIT_CODE}"
    echo "claude-loop: claude exited without sentinel (exit ${EXIT_CODE}), stopping."
    LOOP_RUNNING=false
  fi

done

log_event "event=loop_event" "message=loop finished" "sessions=${SESSION_COUNT}"
echo "claude-loop: finished after ${SESSION_COUNT} session(s)."
