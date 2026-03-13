#!/usr/bin/env bash
# tests/skills/smoke/playbook.sh — Smoke test for /playbook skill (print mode)
#
# Tests: /playbook check and /playbook project
# Cost: ~$0.06-0.10 (haiku, 2 calls)

set -euo pipefail
[[ "${SKILL_SMOKE:-0}" == "1" ]] || { echo "SKIP (SKILL_SMOKE not set)"; exit 0; }

SMOKE_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SMOKE_DIR/setup.sh"
trap 'source "$SMOKE_DIR/teardown.sh"' EXIT

# Override the default CLAUDE.md with a bare one (missing sections)
cat > "$TEST_PROJECT/CLAUDE.md" <<'EOF'
# Test Project

A test project for playbook smoke tests.
EOF

cd "$TEST_PROJECT"

# ─── Test 1: /playbook check ─────────────────────────────────────────────────

echo "--- playbook check ---"
OUTPUT=$(claude -p \
  --model haiku \
  --max-budget-usd 0.15 \
  --no-session-persistence \
  --dangerously-skip-permissions \
  "/playbook check" 2>&1) || true

CHECK_OK=false
if echo "$OUTPUT" | grep -qE '\[[ x]\]'; then
  echo "  OK: output contains checkbox pattern"
  CHECK_OK=true
elif echo "$OUTPUT" | grep -qiE "(missing|present|installed|not found|section|coverage|audit)"; then
  echo "  OK: output contains audit-style language"
  CHECK_OK=true
fi

OUTPUT_LEN=${#OUTPUT}
if [ "$OUTPUT_LEN" -gt 100 ]; then
  echo "  OK: output is substantial ($OUTPUT_LEN chars)"
else
  echo "  WARN: output is short ($OUTPUT_LEN chars)"
  if ! $CHECK_OK; then
    echo "  OUTPUT: ${OUTPUT:0:500}"
  fi
fi

# ─── Test 2: /playbook project ───────────────────────────────────────────────

echo "--- playbook project ---"
OUTPUT=$(claude -p \
  --model haiku \
  --max-budget-usd 0.15 \
  --no-session-persistence \
  --dangerously-skip-permissions \
  --append-system-prompt "Analyze the project CLAUDE.md and report what sections are missing. Do not make changes - just report. Do not ask any questions." \
  "/playbook project" 2>&1) || true

PROJECT_OK=false
if echo "$OUTPUT" | grep -qiE "(quality gates|testing|missing|gap|section|convention|incomplete)"; then
  echo "  OK: output mentions missing sections or gaps"
  PROJECT_OK=true
fi

OUTPUT_LEN=${#OUTPUT}
if [ "$OUTPUT_LEN" -gt 100 ]; then
  echo "  OK: output is substantial ($OUTPUT_LEN chars)"
  PROJECT_OK=true
else
  echo "  WARN: output is short ($OUTPUT_LEN chars)"
fi

# ─── Result ───────────────────────────────────────────────────────────────────

if $CHECK_OK || $PROJECT_OK; then
  echo "PASS: /playbook check and project exercised"
else
  echo "FAIL: /playbook produced no recognizable output"
  echo "--- check output (first 300 chars) ---"
  echo "${OUTPUT:0:300}"
  exit 1
fi
