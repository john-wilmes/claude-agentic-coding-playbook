#!/usr/bin/env bash
# tests/skills/smoke/run-all.sh — Runner for skill smoke tests
#
# Usage: SKILL_SMOKE=1 bash tests/skills/smoke/run-all.sh
#
# Prerequisites: claude CLI on PATH, expect (for interactive tests)
# Cost: ~$0.10-0.30 per full run (haiku model)

set -uo pipefail
[[ "${SKILL_SMOKE:-0}" == "1" ]] || { echo "SKIP: set SKILL_SMOKE=1 to run smoke tests"; exit 0; }
command -v claude >/dev/null || { echo "FAIL: claude CLI not found on PATH"; exit 1; }

SMOKE_DIR="$(cd "$(dirname "$0")" && pwd)"
PASS=0
FAIL=0
SKIP=0

for test in "$SMOKE_DIR"/*.sh; do
  name="$(basename "$test")"
  # Skip infrastructure scripts
  [[ "$name" =~ ^(setup|teardown|run-all)\.sh$ ]] && continue

  echo "--- $name ---"
  set +e
  output=$(bash "$test" 2>&1)
  rc=$?
  set -e
  echo "$output"

  if [ $rc -eq 0 ]; then
    if echo "$output" | grep -q "^SKIP"; then
      SKIP=$((SKIP + 1))
    else
      PASS=$((PASS + 1))
    fi
  else
    FAIL=$((FAIL + 1))
  fi
  echo ""
done

echo "=== Results: $PASS passed, $FAIL failed, $SKIP skipped ==="
[[ $FAIL -eq 0 ]]
