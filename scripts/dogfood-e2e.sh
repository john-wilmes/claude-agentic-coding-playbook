#!/usr/bin/env bash
# End-to-end dogfood test using claude -p (headless mode).
# Must be run OUTSIDE of Claude Code (from a normal terminal).
#
# Usage: bash scripts/dogfood-e2e.sh
#
# Prerequisites:
#   - claude CLI on PATH and authenticated
#   - node 18+ on PATH
#   - git configured

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMP_HOME="$(mktemp -d)"
LOG="$TEMP_HOME/dogfood.log"
PASS=0
FAIL=0

cleanup() {
  rm -rf "$TEMP_HOME"
}
trap cleanup EXIT

say() {
  echo "$1" | tee -a "$LOG"
}

check() {
  local label="$1"
  shift
  if "$@" > /dev/null 2>&1; then
    say "  OK: $label"
    PASS=$((PASS + 1))
  else
    say "  FAIL: $label"
    FAIL=$((FAIL + 1))
  fi
}

run_claude() {
  local prompt="$1"
  local cwd="${2:-$TEMP_HOME}"
  local tools="${3:-Read,Glob,Grep,Write,Edit,Bash}"
  local model="${4:-haiku}"

  # Strip ALL Claude Code env vars to avoid nesting issues
  env -u CLAUDECODE \
      -u CLAUDE_CODE_ENTRYPOINT \
      -u CLAUDE_CODE_SSE_PORT \
      -u CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS \
    HOME="$TEMP_HOME" \
    USERPROFILE="$TEMP_HOME" \
    claude -p "$prompt" \
      --model "$model" \
      --allowedTools "$tools" \
      2>/dev/null
}

say "============================================================"
say "DOGFOOD E2E TEST"
say "START: $(date)"
say "REPO: $REPO_ROOT"
say "TEMP HOME: $TEMP_HOME"
say ""

# ── Test 1: Install research profile ─────────────────────────
say "--- Test 1: Install research profile ---"
HOME="$TEMP_HOME" bash "$REPO_ROOT/install.sh" --profile research --force > "$TEMP_HOME/install.log" 2>&1
check "install exit code" test $? -eq 0
check "CLAUDE.md exists" test -f "$TEMP_HOME/.claude/CLAUDE.md"
check "investigate skill exists" test -f "$TEMP_HOME/.claude/skills/investigate/SKILL.md"
check "investigations dir exists" test -d "$TEMP_HOME/.claude/investigations"

# ── Test 2: Create sample project ────────────────────────────
say ""
say "--- Test 2: Create sample project ---"
PROJ="$TEMP_HOME/projects/weather-api"
mkdir -p "$PROJ/.git"
cat > "$PROJ/package.json" << 'PKG'
{"name": "weather-api", "version": "1.0.0", "dependencies": {"express": "^4", "axios": "^1"}}
PKG
cat > "$PROJ/README.md" << 'README'
# Weather API
A REST API that fetches weather data from OpenWeatherMap and caches it in Redis.
README
cat > "$PROJ/server.js" << 'SERVER'
const express = require('express');
const axios = require('axios');
const app = express();

app.get('/weather/:city', async (req, res) => {
  const { city } = req.params;
  const resp = await axios.get(`https://api.openweathermap.org/data/2.5/weather?q=${city}`);
  res.json(resp.data);
});

app.listen(3000, () => console.log('Weather API on :3000'));
SERVER
check "project created" test -f "$PROJ/server.js"
say ""

# ── Test 3: claude -p basic sanity ───────────────────────────
say "--- Test 3: claude -p basic sanity ---"
PONG=$(run_claude "Reply with just the word PONG" "$PROJ" "Read" "haiku")
check "claude responds" echo "$PONG" | grep -qi "PONG"
say ""

# ── Test 4: claude -p reads project files ────────────────────
say "--- Test 4: claude reads project ---"
ANALYSIS=$(run_claude \
  "Read the files in this directory. What framework does server.js use? Reply in one word." \
  "$PROJ" "Read,Glob" "haiku")
check "detects express" echo "$ANALYSIS" | grep -qi "express"
say "  Response: $ANALYSIS"
say ""

# ── Test 5: Investigation scaffold via claude -p ─────────────
say "--- Test 5: Create investigation via claude -p ---"
INV_DIR="$TEMP_HOME/.claude/investigations"
run_claude \
  "Create a new investigation called WEATHER-001. Create directory $INV_DIR/WEATHER-001/EVIDENCE/ and these files:
   - $INV_DIR/WEATHER-001/BRIEF.md with question 'How does the weather API work?', scope 'source files', context 'dogfood test'
   - $INV_DIR/WEATHER-001/STATUS.md with phase 'new' and a history table with today's date
   - $INV_DIR/WEATHER-001/FINDINGS.md with empty YAML tags frontmatter
   Use markdown format." \
  "$PROJ" "Write,Bash" "haiku" > /dev/null

check "BRIEF.md created" test -f "$INV_DIR/WEATHER-001/BRIEF.md"
check "STATUS.md created" test -f "$INV_DIR/WEATHER-001/STATUS.md"
check "FINDINGS.md created" test -f "$INV_DIR/WEATHER-001/FINDINGS.md"
check "EVIDENCE/ dir created" test -d "$INV_DIR/WEATHER-001/EVIDENCE"

if [ -f "$INV_DIR/WEATHER-001/BRIEF.md" ]; then
  check "BRIEF mentions weather" grep -qi "weather" "$INV_DIR/WEATHER-001/BRIEF.md"
fi
say ""

# ── Test 6: Collect evidence via claude -p ───────────────────
say "--- Test 6: Collect evidence via claude -p ---"
run_claude \
  "Read the files in $PROJ and create an evidence file at $INV_DIR/WEATHER-001/EVIDENCE/001-project-overview.md.
   Format it with: # 001: project-overview, then **Source**: the files you read, **Relevance**: how it relates to understanding the API, then a 3-line observation.
   Also update $INV_DIR/WEATHER-001/STATUS.md to change phase to 'collecting' and add a history entry." \
  "$PROJ" "Read,Glob,Write,Edit" "haiku" > /dev/null

check "evidence 001 created" test -f "$INV_DIR/WEATHER-001/EVIDENCE/001-project-overview.md"

if [ -f "$INV_DIR/WEATHER-001/EVIDENCE/001-project-overview.md" ]; then
  check "evidence mentions express or weather" grep -qiE "express|weather|api" "$INV_DIR/WEATHER-001/EVIDENCE/001-project-overview.md"
fi

if [ -f "$INV_DIR/WEATHER-001/STATUS.md" ]; then
  check "STATUS updated to collecting" grep -qi "collecting" "$INV_DIR/WEATHER-001/STATUS.md"
fi
say ""

# ── Test 7: Switch to dev profile, verify preservation ───────
say "--- Test 7: Cross-profile preservation ---"
HOME="$TEMP_HOME" bash "$REPO_ROOT/install.sh" --profile dev --force > "$TEMP_HOME/install-dev.log" 2>&1
check "dev install succeeds" test -f "$TEMP_HOME/.claude/skills/checkpoint/SKILL.md"
check "investigate skill removed" test ! -d "$TEMP_HOME/.claude/skills/investigate"
check "investigation data preserved" test -f "$INV_DIR/WEATHER-001/FINDINGS.md"
check "evidence preserved" test -f "$INV_DIR/WEATHER-001/EVIDENCE/001-project-overview.md"
say ""

# ── Summary ──────────────────────────────────────────────────
say "============================================================"
say "RESULTS: $PASS passed, $FAIL failed"
say "END: $(date)"

if [ "$FAIL" -gt 0 ]; then
  say ""
  say "Investigation files (if created):"
  find "$INV_DIR" -type f 2>/dev/null | while read -r f; do
    say "  $f"
  done
  exit 1
fi
