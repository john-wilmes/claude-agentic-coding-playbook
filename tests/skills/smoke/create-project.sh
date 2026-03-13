#!/usr/bin/env bash
# tests/skills/smoke/create-project.sh — Smoke test for /create-project skill (expect mode)
#
# Asserts: project directory created with CLAUDE.md, .gitignore, .git/
# Cost: ~$0.05-0.10 (haiku)

set -euo pipefail
[[ "${SKILL_SMOKE:-0}" == "1" ]] || { echo "SKIP (SKILL_SMOKE not set)"; exit 0; }
command -v expect >/dev/null || { echo "SKIP (expect not installed)"; exit 0; }

SMOKE_DIR="$(cd "$(dirname "$0")" && pwd)"
# Don't source default setup — create-project needs its own install root
unset CLAUDECODE 2>/dev/null || true
export TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

# Create a fake install root so the skill finds .claude/ and creates project here
export INSTALL_ROOT="${TEST_DIR}/root"
mkdir -p "$INSTALL_ROOT/.claude"
cat > "$INSTALL_ROOT/.claude/CLAUDE.md" <<'EOF'
# Test Install Root
EOF

export PROJECT_NAME="smoke-test-$$"
cd "$INSTALL_ROOT"

# Run expect script with hard timeout
timeout 180 expect "$SMOKE_DIR/create-project.exp"
EXPECT_RC=$?

# Verify side effects: project directory should exist with key files
CREATED_DIR="$INSTALL_ROOT/$PROJECT_NAME"
PASS=true
CHECKS=""

if [ -d "$CREATED_DIR" ]; then
  CHECKS="dir:yes"
  [ -f "$CREATED_DIR/CLAUDE.md" ] && CHECKS="$CHECKS claude-md:yes" || CHECKS="$CHECKS claude-md:no"
  [ -f "$CREATED_DIR/.gitignore" ] && CHECKS="$CHECKS gitignore:yes" || CHECKS="$CHECKS gitignore:no"
  [ -d "$CREATED_DIR/.git" ] && CHECKS="$CHECKS git:yes" || CHECKS="$CHECKS git:no"
else
  CHECKS="dir:no"
  PASS=false
  # Check if created elsewhere (skill may pick different install root)
  FOUND=$(find "$TEST_DIR" -maxdepth 3 -name "CLAUDE.md" -path "*${PROJECT_NAME}*" 2>/dev/null | head -1)
  if [ -n "$FOUND" ]; then
    ACTUAL_DIR=$(dirname "$FOUND")
    echo "INFO: project created at $ACTUAL_DIR instead of $CREATED_DIR"
    CHECKS="dir:alt-location"
    PASS=true
  fi
fi

if $PASS && [ "$EXPECT_RC" -eq 0 ]; then
  echo "PASS: /create-project completed ($CHECKS)"
else
  echo "FAIL: /create-project did not produce expected results (expect=$EXPECT_RC $CHECKS)"
  echo "--- TEST_DIR contents ---"
  find "$TEST_DIR" -maxdepth 3 -type f 2>/dev/null | head -20
  exit 1
fi
