#!/usr/bin/env bash
# ec2-dogfood.sh — End-to-end dogfood test on a fresh Ubuntu EC2 instance.
#
# Usage:
#   1. Launch a t3.micro Ubuntu 22.04 LTS instance
#   2. SSH in and run:
#      curl -fsSL https://raw.githubusercontent.com/john-wilmes/agentic-coding-playbook/master/scripts/ec2-dogfood.sh | bash
#
# Or clone first:
#   git clone https://github.com/john-wilmes/agentic-coding-playbook.git
#   cd agentic-coding-playbook
#   bash scripts/ec2-dogfood.sh
#
# What this script does:
#   - Installs prerequisites (git, node)
#   - Clones the repo (if not already in it)
#   - Runs the installer for both profiles
#   - Scaffolds a test project with pre-commit hooks
#   - Runs hook integration tests
#   - Tests knowledge repo integration
#   - Reports results
#
# Referenced from: docs/best-practices.md Section 14 (Getting Started)

set -euo pipefail

PASS=0
FAIL=0
FINDINGS=""

pass() {
  echo "  PASS: $1"
  PASS=$((PASS + 1))
}

fail() {
  echo "  FAIL: $1"
  FAIL=$((FAIL + 1))
  FINDINGS="${FINDINGS}\n  - FAIL: $1"
}

section() {
  echo ""
  echo "=== $1 ==="
}

# ── Step 1: Prerequisites ───────────────────────────────────────

section "Step 1: Install prerequisites"

install_prereqs() {
  if command -v apt-get &>/dev/null; then
    sudo apt-get update -qq
    sudo apt-get install -y -qq git curl
    # Install Node.js via NodeSource if not present
    if ! command -v node &>/dev/null; then
      curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
      sudo apt-get install -y -qq nodejs
    fi
  else
    echo "WARNING: Not a Debian/Ubuntu system. Skipping apt install."
    echo "  Ensure git, node, and curl are available."
  fi
}

if ! command -v git &>/dev/null || ! command -v node &>/dev/null; then
  echo "Installing missing prerequisites..."
  install_prereqs
fi

command -v git &>/dev/null && pass "git available: $(git --version)" || fail "git not found"
command -v node &>/dev/null && pass "node available: $(node --version)" || fail "node not found"

# ── Step 2: Clone repo ──────────────────────────────────────────

section "Step 2: Ensure repo is available"

REPO_DIR=""
if [ -f "install.sh" ] && [ -d "profiles/dev" ]; then
  REPO_DIR="$(pwd)"
  pass "Already in repo directory"
else
  REPO_DIR=$(mktemp -d)/agentic-coding-playbook
  git clone https://github.com/john-wilmes/agentic-coding-playbook.git "$REPO_DIR"
  pass "Cloned repo to $REPO_DIR"
fi

# ── Step 3: Dev profile install ─────────────────────────────────

section "Step 3: Install dev profile"

# Use isolated HOME for clean-room testing
export ORIG_HOME="$HOME"
export HOME=$(mktemp -d)
echo "Using isolated HOME=$HOME"

bash "$REPO_DIR/install.sh" --profile dev --force

[ -f "$HOME/.claude/CLAUDE.md" ] && pass "CLAUDE.md installed" || fail "CLAUDE.md missing"
[ -d "$HOME/.claude/skills/checkpoint" ] && pass "checkpoint skill" || fail "checkpoint skill missing"
[ -d "$HOME/.claude/skills/continue" ] && pass "continue skill" || fail "continue skill missing"
[ -d "$HOME/.claude/skills/playbook" ] && pass "playbook skill" || fail "playbook skill missing"
[ -d "$HOME/.claude/skills/create-project" ] && pass "create-project skill" || fail "create-project skill missing"
[ -f "$HOME/.claude/templates/hooks/pre-commit" ] && pass "pre-commit template" || fail "pre-commit template missing"
[ -x "$HOME/.claude/templates/hooks/pre-commit" ] && pass "pre-commit executable" || fail "pre-commit not executable"
[ -f "$HOME/.claude/hooks/session-start.js" ] && pass "session-start hook" || fail "session-start hook missing"
[ -f "$HOME/.claude/hooks/session-end.js" ] && pass "session-end hook" || fail "session-end hook missing"

grep -q "Explore, Plan, Code, Verify, Commit" "$HOME/.claude/CLAUDE.md" && \
  pass "CLAUDE.md has dev workflow" || fail "CLAUDE.md missing dev workflow"

# ── Step 4: Project scaffold + hook tests ────────────────────────

section "Step 4: Project scaffolding and hook tests"

proj=$(mktemp -d)
git init "$proj"
git -C "$proj" config user.email "dogfood@test"
git -C "$proj" config user.name "Dogfood"
cp "$HOME/.claude/templates/project-CLAUDE.md" "$proj/CLAUDE.md"
cp "$HOME/.claude/templates/hooks/pre-commit" "$proj/.git/hooks/pre-commit"
chmod +x "$proj/.git/hooks/pre-commit"

# Clean commit should pass
echo "# Test" > "$proj/README.md"
git -C "$proj" add README.md CLAUDE.md
git -C "$proj" commit -m "initial commit" && pass "clean commit passes" || fail "clean commit blocked"

# AWS key should be blocked
echo 'aws_key = AKIAIOSFODNN7EXAMPLE' > "$proj/creds.txt"
git -C "$proj" add creds.txt
if git -C "$proj" commit -m "bad" 2>&1; then
  fail "AWS key not blocked"
else
  pass "AWS key blocked by hook"
fi
git -C "$proj" reset HEAD -- creds.txt && rm "$proj/creds.txt"

# .env file should be blocked
echo "SECRET=foo" > "$proj/.env"
git -C "$proj" add .env
if git -C "$proj" commit -m "bad" 2>&1; then
  fail ".env file not blocked"
else
  pass ".env file blocked by hook"
fi
git -C "$proj" reset HEAD -- .env && rm "$proj/.env"

# Large file should be blocked
dd if=/dev/zero of="$proj/big.bin" bs=1M count=6 2>/dev/null
git -C "$proj" add big.bin
if git -C "$proj" commit -m "bad" 2>&1; then
  fail "large file not blocked"
else
  pass "large file (6MB) blocked by hook"
fi
git -C "$proj" reset HEAD -- big.bin && rm "$proj/big.bin"

# ── Step 5: Knowledge repo integration ───────────────────────────

section "Step 5: Knowledge repo integration"

bare=$(mktemp -d)
git init --bare "$bare"

work=$(mktemp -d)
git clone "$bare" "$work"
git -C "$work" config user.email "dogfood@test"
git -C "$work" config user.name "Dogfood"
mkdir -p "$work/entries/20260222-test"
cat > "$work/entries/20260222-test/entry.md" << 'EOF'
---
id: "20260222-test"
tool: "git"
category: "gotcha"
tags: ["test"]
confidence: "high"
---
# Test
Test knowledge entry.
EOF
if git -C "$work" add . && git -C "$work" commit -m "seed" && git -C "$work" push; then
  pass "seeded knowledge entry pushed"
else
  fail "failed to seed knowledge entry"
fi

bash "$REPO_DIR/install.sh" --profile dev --force --knowledge-repo "$bare"

[ -d "$HOME/.claude/knowledge/.git" ] && pass "knowledge repo cloned" || fail "knowledge repo not cloned"
[ -f "$HOME/.claude/knowledge/entries/20260222-test/entry.md" ] && pass "seeded entry present" || fail "seeded entry missing"

# ── Step 6: Cross-profile switching ──────────────────────────────

section "Step 6: Cross-profile switching (dev → research → dev)"

bash "$REPO_DIR/install.sh" --profile research --force
[ -d "$HOME/.claude/skills/investigate" ] && pass "investigate skill present" || fail "investigate missing"
[ ! -d "$HOME/.claude/skills/checkpoint" ] && pass "checkpoint removed on switch" || fail "checkpoint still present"
grep -q "Question, Collect, Synthesize, Close" "$HOME/.claude/CLAUDE.md" && \
  pass "CLAUDE.md has research workflow" || fail "CLAUDE.md missing research workflow"

bash "$REPO_DIR/install.sh" --profile dev --force
[ ! -d "$HOME/.claude/skills/investigate" ] && pass "investigate removed on switch back" || fail "investigate still present"
[ -d "$HOME/.claude/skills/checkpoint" ] && pass "checkpoint restored" || fail "checkpoint not restored"

# ── Step 7: Idempotency ─────────────────────────────────────────

section "Step 7: Idempotency check"

bash "$REPO_DIR/install.sh" --profile dev --force
[ -f "$HOME/.claude/CLAUDE.md" ] && pass "CLAUDE.md survives re-install" || fail "CLAUDE.md missing after re-install"

# ── Summary ──────────────────────────────────────────────────────

echo ""
echo "=============================="
echo "  Dogfood Results"
echo "=============================="
echo "  PASS: $PASS"
echo "  FAIL: $FAIL"

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "  Findings:"
  echo -e "$FINDINGS"
  echo ""
  echo "  ACTION: Fix the failures above before release."
  exit 1
else
  echo ""
  echo "  All tests passed. EC2 dogfood complete."
fi
