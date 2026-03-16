#!/usr/bin/env bash
# tests/skills/smoke/checkpoint.sh — Smoke test for /checkpoint skill (expect mode)
#
# Asserts: git commit created from staged changes (primary), "CHECKPOINT" in output (secondary)
# Cost: ~$0.05-0.10 (haiku)

set -euo pipefail
[[ "${SKILL_SMOKE:-0}" == "1" ]] || { echo "SKIP (SKILL_SMOKE not set)"; exit 0; }
command -v expect >/dev/null || { echo "SKIP (expect not installed)"; exit 0; }

SMOKE_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SMOKE_DIR/setup.sh"
trap 'source "$SMOKE_DIR/teardown.sh"' EXIT

cd "$TEST_PROJECT"
export TEST_PROJECT TEST_DIR

# Record commit count before checkpoint
COMMITS_BEFORE=$(git rev-list --count HEAD)

# Run expect script with hard timeout kill switch (6 min)
set +e
timeout 360 expect "$SMOKE_DIR/checkpoint.exp"
EXPECT_RC=$?
set -e

# Verify side effects: new commit should exist (primary assertion)
COMMITS_AFTER=$(git -C "$TEST_PROJECT" rev-list --count HEAD 2>/dev/null || echo "$COMMITS_BEFORE")

if [ "$EXPECT_RC" -eq 0 ]; then
  echo "PASS: /checkpoint completed (expect passed, commits: $COMMITS_BEFORE -> $COMMITS_AFTER)"
elif [ "$COMMITS_AFTER" -gt "$COMMITS_BEFORE" ]; then
  echo "PASS: /checkpoint committed changes (commits: $COMMITS_BEFORE -> $COMMITS_AFTER, expect=$EXPECT_RC)"
elif [ "$EXPECT_RC" -eq 124 ]; then
  echo "FAIL: /checkpoint timed out with no new commits"
  exit 1
else
  echo "FAIL: /checkpoint did not commit or produce expected output (expect=$EXPECT_RC, commits: $COMMITS_BEFORE -> $COMMITS_AFTER)"
  exit 1
fi
