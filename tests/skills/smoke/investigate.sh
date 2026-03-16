#!/usr/bin/env bash
# tests/skills/smoke/investigate.sh — Smoke test for /investigate skill (print mode)
#
# Tests: new, status, collect, list, search subcommands
# Cost: ~$0.10-0.25 (haiku, 5 calls)

set -euo pipefail
[[ "${SKILL_SMOKE:-0}" == "1" ]] || { echo "SKIP (SKILL_SMOKE not set)"; exit 0; }

SMOKE_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SMOKE_DIR/setup.sh"

# Determine where investigations go
INSTALL_ROOT=$(bash ~/.claude/scripts/skills/find-install-root.sh 2>/dev/null || echo "$HOME")
INVESTIGATIONS_DIR="$INSTALL_ROOT/.claude/investigations"
TEST_ID="SMOKE-$$"

cleanup_investigate() {
  rm -rf "${INVESTIGATIONS_DIR:?}/${TEST_ID}" 2>/dev/null || true
  source "$SMOKE_DIR/teardown.sh"
}
trap cleanup_investigate EXIT

cd "$TEST_PROJECT"

# ─── Test 1: /investigate new ─────────────────────────────────────────────────

echo "--- investigate new ---"
OUTPUT=$(claude -p \
  --model haiku \
  --max-budget-usd 0.15 \
  --no-session-persistence \
  --dangerously-skip-permissions \
  --append-system-prompt "You are in headless mode (CLAUDE_LOOP=1). Do NOT ask any questions. Create the investigation scaffold immediately. For the investigation question use: 'Why does math.js return null on division by zero?' For repo use 'none'. For observations use 'divide(1,0) returns null'. For hypothesis use 'No hypothesis provided.' For scope use 'math.js'. For context use 'test context'." \
  "/investigate ${TEST_ID} new" 2>&1) || true

PASS=true
if [ -f "$INVESTIGATIONS_DIR/$TEST_ID/BRIEF.md" ]; then
  echo "  OK: BRIEF.md exists"
else
  echo "  MISSING: BRIEF.md"
  PASS=false
fi

if [ -f "$INVESTIGATIONS_DIR/$TEST_ID/STATUS.md" ]; then
  if grep -qi "new" "$INVESTIGATIONS_DIR/$TEST_ID/STATUS.md"; then
    echo "  OK: STATUS.md exists with phase 'new'"
  else
    echo "  WARN: STATUS.md exists but phase not 'new'"
  fi
else
  echo "  MISSING: STATUS.md"
  PASS=false
fi

if [ -f "$INVESTIGATIONS_DIR/$TEST_ID/FINDINGS.md" ]; then
  echo "  OK: FINDINGS.md exists"
else
  echo "  MISSING: FINDINGS.md"
  PASS=false
fi

if [ -d "$INVESTIGATIONS_DIR/$TEST_ID/EVIDENCE" ]; then
  echo "  OK: EVIDENCE/ dir exists"
else
  echo "  MISSING: EVIDENCE/"
  PASS=false
fi

if ! $PASS; then
  echo "FAIL: /investigate new did not create expected scaffold"
  echo "--- OUTPUT (first 500 chars) ---"
  echo "${OUTPUT:0:500}"
  exit 1
fi

# ─── Test 2: /investigate status ──────────────────────────────────────────────

echo "--- investigate status ---"
OUTPUT=$(claude -p \
  --model haiku \
  --max-budget-usd 0.10 \
  --no-session-persistence \
  --dangerously-skip-permissions \
  "/investigate ${TEST_ID} status" 2>&1) || true

if echo "$OUTPUT" | grep -qi "$TEST_ID"; then
  echo "  OK: output mentions $TEST_ID"
else
  echo "  WARN: output does not mention $TEST_ID"
fi

# ─── Test 3: /investigate collect ─────────────────────────────────────────────

echo "--- investigate collect ---"
OUTPUT=$(claude -p \
  --model haiku \
  --max-budget-usd 0.15 \
  --no-session-persistence \
  --dangerously-skip-permissions \
  --append-system-prompt "Create evidence immediately without asking questions. The observation is: divide(1,0) returns null instead of throwing an error. Source: manual testing. Relevance: directly answers the investigation question." \
  "/investigate ${TEST_ID} collect" 2>&1) || true

EVIDENCE_COUNT=$(find "$INVESTIGATIONS_DIR/$TEST_ID/EVIDENCE" -name '[0-9][0-9][0-9]-*.md' 2>/dev/null | wc -l)
if [ "$EVIDENCE_COUNT" -gt 0 ]; then
  echo "  OK: $EVIDENCE_COUNT evidence file(s) created"
else
  echo "  WARN: no evidence files created (agent may not have written files)"
fi

# Check STATUS.md phase updated
if [ -f "$INVESTIGATIONS_DIR/$TEST_ID/STATUS.md" ]; then
  if grep -qi "collecting" "$INVESTIGATIONS_DIR/$TEST_ID/STATUS.md"; then
    echo "  OK: STATUS.md phase updated to 'collecting'"
  else
    echo "  WARN: STATUS.md phase not updated to 'collecting'"
  fi
fi

# ─── Test 4: /investigate list ────────────────────────────────────────────────

echo "--- investigate list ---"
OUTPUT=$(claude -p \
  --model haiku \
  --max-budget-usd 0.10 \
  --no-session-persistence \
  --dangerously-skip-permissions \
  "/investigate list" 2>&1) || true

if echo "$OUTPUT" | grep -qi "$TEST_ID"; then
  echo "  OK: list output mentions $TEST_ID"
else
  echo "  WARN: list output does not mention $TEST_ID"
fi

# ─── Test 5: /investigate search ──────────────────────────────────────────────

echo "--- investigate search ---"
OUTPUT=$(claude -p \
  --model haiku \
  --max-budget-usd 0.10 \
  --no-session-persistence \
  --dangerously-skip-permissions \
  "/investigate search math" 2>&1) || true

if echo "$OUTPUT" | grep -qi "$TEST_ID"; then
  echo "  OK: search found $TEST_ID"
else
  echo "  WARN: search did not find $TEST_ID (may depend on content matching)"
fi

# ─── Result ───────────────────────────────────────────────────────────────────

# Primary assertion: scaffold was created by /investigate new
echo "PASS: /investigate lifecycle completed (scaffold created, subcommands exercised)"
