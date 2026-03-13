#!/usr/bin/env bash
# tests/skills/smoke/continue.sh — Smoke test for /continue skill (print mode)
#
# Asserts: output contains structural markers (session info or "no prior session")
# Cost: ~$0.02-0.05 (haiku)

set -euo pipefail
[[ "${SKILL_SMOKE:-0}" == "1" ]] || { echo "SKIP (SKILL_SMOKE not set)"; exit 0; }

SMOKE_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SMOKE_DIR/setup.sh"
trap 'source "$SMOKE_DIR/teardown.sh"' EXIT

cd "$TEST_PROJECT"
OUTPUT=$(claude -p \
  --model haiku \
  --max-budget-usd 0.10 \
  --no-session-persistence \
  --dangerously-skip-permissions \
  "/continue" 2>&1) || true

# /continue in a fresh project should show "no prior session" or session info
if echo "$OUTPUT" | grep -qiE "(last session|no prior session|fresh start|current state|next steps|current work|suggestions|no .*memory|start working)"; then
  echo "PASS: /continue produced expected output"
else
  echo "FAIL: /continue output missing expected markers"
  echo "--- OUTPUT (first 500 chars) ---"
  echo "${OUTPUT:0:500}"
  exit 1
fi
