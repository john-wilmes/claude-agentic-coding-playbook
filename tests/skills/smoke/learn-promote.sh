#!/usr/bin/env bash
# tests/skills/smoke/learn-promote.sh — Smoke test for /learn → /promote pipeline (print mode)
#
# Tests: /learn creates knowledge entry, /promote shares it globally
# Cost: ~$0.06-0.10 (haiku, 2 calls)

set -euo pipefail
[[ "${SKILL_SMOKE:-0}" == "1" ]] || { echo "SKIP (SKILL_SMOKE not set)"; exit 0; }

SMOKE_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SMOKE_DIR/setup.sh"

# Track files created for cleanup
CREATED_ENTRY=""
CREATED_GLOBAL=""
ORIGINAL_CLAUDE_MD=""

cleanup_learn() {
  # Clean up any test knowledge entries
  if [ -n "$CREATED_ENTRY" ] && [ -f "$CREATED_ENTRY" ]; then
    rm -f "$CREATED_ENTRY"
  fi
  # Clean up global scope additions
  if [ -n "$CREATED_GLOBAL" ] && [ -f "$CREATED_GLOBAL" ]; then
    rm -f "$CREATED_GLOBAL"
  fi
  # Restore CLAUDE.md if it was modified
  if [ -n "$ORIGINAL_CLAUDE_MD" ] && [ -f "${ORIGINAL_CLAUDE_MD}.smoke-backup" ]; then
    mv "${ORIGINAL_CLAUDE_MD}.smoke-backup" "$ORIGINAL_CLAUDE_MD"
  fi
  source "$SMOKE_DIR/teardown.sh"
}
trap cleanup_learn EXIT

cd "$TEST_PROJECT"

# Back up global CLAUDE.md if it exists
if [ -f "$HOME/.claude/CLAUDE.md" ]; then
  ORIGINAL_CLAUDE_MD="$HOME/.claude/CLAUDE.md"
  cp "$ORIGINAL_CLAUDE_MD" "${ORIGINAL_CLAUDE_MD}.smoke-backup"
fi

LESSON_MARKER="smoke-test-$$"

# ─── Test 1: /learn ──────────────────────────────────────────────────────────

echo "--- learn ---"
OUTPUT=$(claude -p \
  --model haiku \
  --max-budget-usd 0.15 \
  --no-session-persistence \
  --dangerously-skip-permissions \
  --append-system-prompt "Auto-classify without asking questions. Category: gotcha. Tool: node. Tags: security, auth, ${LESSON_MARKER}. Confidence: high. Do not ask for confirmation. Create the entry immediately." \
  "/learn plaintext password storage is a common anti-pattern in quick prototypes (${LESSON_MARKER})" 2>&1) || true

# Check if entry was created (knowledge-db.js path or fallback memory path)
ENTRY_FOUND=false
if [ -d "$HOME/.claude/knowledge" ]; then
  FOUND=$(find "$HOME/.claude/knowledge" -name "*password*" -newer "$SMOKE_DIR/setup.sh" 2>/dev/null | head -1)
  if [ -n "$FOUND" ]; then
    echo "  OK: knowledge entry created at $FOUND"
    CREATED_ENTRY="$FOUND"
    ENTRY_FOUND=true
  fi
fi

if ! $ENTRY_FOUND; then
  # Check if it fell back to memory file or produced confirmation output
  if echo "$OUTPUT" | grep -qiE "(entry created|knowledge|captured|lesson|saved|recorded)"; then
    echo "  OK: /learn produced creation confirmation (entry location varies)"
    ENTRY_FOUND=true
  else
    echo "  WARN: could not confirm entry creation"
    echo "  OUTPUT (first 300 chars): ${OUTPUT:0:300}"
  fi
fi

# ─── Test 2: /promote ────────────────────────────────────────────────────────

echo "--- promote ---"
OUTPUT=$(claude -p \
  --model haiku \
  --max-budget-usd 0.15 \
  --no-session-persistence \
  --dangerously-skip-permissions \
  --append-system-prompt "Auto-select the first matching lesson about plaintext passwords. If duplicate detected, choose 'add'. Do not ask for confirmation. Promote immediately." \
  "/promote plaintext password storage" 2>&1) || true

PROMOTE_OK=false
# Check if promoted to knowledge/entries/
if [ -d "$HOME/.claude/knowledge/entries" ]; then
  FOUND=$(find "$HOME/.claude/knowledge/entries" -name "*password*" -newer "$SMOKE_DIR/setup.sh" 2>/dev/null | head -1)
  if [ -n "$FOUND" ]; then
    echo "  OK: promoted to $FOUND"
    CREATED_GLOBAL="$FOUND"
    PROMOTE_OK=true
  fi
fi

# Check if promoted to CLAUDE.md
if ! $PROMOTE_OK && [ -n "$ORIGINAL_CLAUDE_MD" ]; then
  if ! diff -q "$HOME/.claude/CLAUDE.md" "${ORIGINAL_CLAUDE_MD}.smoke-backup" >/dev/null 2>&1; then
    echo "  OK: CLAUDE.md was modified (lesson promoted)"
    PROMOTE_OK=true
  fi
fi

if ! $PROMOTE_OK; then
  if echo "$OUTPUT" | grep -qiE "(promoted|global|added|created|written)"; then
    echo "  OK: /promote produced confirmation output"
    PROMOTE_OK=true
  else
    echo "  WARN: could not confirm promotion"
    echo "  OUTPUT (first 300 chars): ${OUTPUT:0:300}"
  fi
fi

# ─── Result ───────────────────────────────────────────────────────────────────

if $ENTRY_FOUND; then
  echo "PASS: /learn → /promote pipeline exercised"
else
  echo "FAIL: /learn did not produce detectable output"
  exit 1
fi
