#!/usr/bin/env bash
# knowledge-consolidate.sh — Deduplicate and consolidate knowledge entries in the SQLite DB.
#
# Usage:
#   knowledge-consolidate.sh [--dry-run] [--apply] [--help]
#
# Default mode is --dry-run. Pass --apply to actually archive overlapping entries.

set -euo pipefail

KNOWLEDGE_DB="${HOME}/.claude/knowledge/knowledge.db"
KNOWLEDGE_DB_JS="${HOME}/.claude/hooks/knowledge-db.js"
DRY_RUN=true

log()  { echo "[consolidate] $*"; }
warn() { echo "[consolidate] WARNING: $*" >&2; }

usage() {
  cat <<'EOF'
Usage: knowledge-consolidate.sh [--dry-run] [--apply] [--help]

Deduplicate knowledge entries in the SQLite DB at ~/.claude/knowledge/knowledge.db.

Options:
  --dry-run   Show recommendations without making changes (default)
  --apply     Archive overlapping entries in the DB
  --help      Show this help message

Behavior:
  1. Exports active entries from the SQLite DB.
  2. Groups entries by the "tool" field.
  3. For each tool group with 2+ entries, uses the claude CLI to identify
     high-overlap pairs that could be merged.
  4. In dry-run mode: prints recommendations only.
  5. In apply mode: archives duplicate entries in the DB.

The script is idempotent — safe to run multiple times.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --apply)   DRY_RUN=false; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; echo "Run with --help for usage." >&2; exit 1 ;;
  esac
done

# ─── Preflight checks ─────────────────────────────────────────────────────────

if [[ ! -f "${KNOWLEDGE_DB}" ]]; then
  log "Knowledge DB not found: ${KNOWLEDGE_DB}"
  log "Run install.sh to set up the knowledge system."
  exit 0
fi

if [[ ! -f "${KNOWLEDGE_DB_JS}" ]]; then
  log "knowledge-db.js not found: ${KNOWLEDGE_DB_JS}"
  exit 0
fi

CLAUDE_CMD=""
if command -v q >/dev/null 2>&1; then
  CLAUDE_CMD="q"
elif command -v claude >/dev/null 2>&1; then
  CLAUDE_CMD="claude --print"
fi

if [[ -z "${CLAUDE_CMD}" ]]; then
  warn "Neither 'q' nor 'claude' CLI found in PATH."
  warn "Cannot perform AI-assisted overlap analysis."
  exit 0
fi

# ─── Export entries from DB ───────────────────────────────────────────────────

JSONL_TMP="$(mktemp)"
trap 'rm -f "${JSONL_TMP}"' EXIT

node "${KNOWLEDGE_DB_JS}" export "${JSONL_TMP}"

TOTAL=$(wc -l < "${JSONL_TMP}" | tr -d ' ')
log "Found ${TOTAL} active entries in DB"

if [[ "${TOTAL}" -lt 2 ]]; then
  log "Fewer than 2 entries — nothing to consolidate."
  exit 0
fi

# ─── Group entries by tool field using Node ───────────────────────────────────

GROUPS_JSON="$(node -e "
const fs = require('fs');
const lines = fs.readFileSync('${JSONL_TMP}', 'utf8').split('\n').filter(Boolean);
const groups = {};
for (const line of lines) {
  try {
    const entry = JSON.parse(line);
    const tool = (entry.tool || '__unknown__').trim() || '__unknown__';
    if (!groups[tool]) groups[tool] = [];
    groups[tool].push({ id: entry.id, context_text: entry.context_text || '', fix_text: entry.fix_text || '' });
  } catch {}
}
process.stdout.write(JSON.stringify(groups));
")"

log "Grouped into $(echo "${GROUPS_JSON}" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); process.stdout.write(String(Object.keys(d).length));") tool categories"

if "${DRY_RUN}"; then
  log "=== DRY RUN mode — no entries will be archived ==="
else
  log "=== APPLY mode — overlapping entries will be archived ==="
fi

RECOMMENDATION_COUNT=0
ARCHIVED_COUNT=0

# ─── Analyze each group ───────────────────────────────────────────────────────

# Extract tool names
TOOLS="$(echo "${GROUPS_JSON}" | node -e "
const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
process.stdout.write(Object.keys(d).join('\n'));
")"

while IFS= read -r tool; do
  # Get entries for this tool
  ENTRIES_JSON="$(echo "${GROUPS_JSON}" | node -e "
const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
process.stdout.write(JSON.stringify(d[$(node -e "process.stdout.write(JSON.stringify('${tool//\'/\\'}')")] || []));
  ")"

  COUNT="$(echo "${ENTRIES_JSON}" | node -e "
const arr = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
process.stdout.write(String(arr.length));
  ")"

  if [[ "${COUNT}" -lt 2 ]]; then
    continue
  fi

  log "Analyzing tool '${tool}': ${COUNT} entries"

  # Build payload for Claude
  PAYLOAD="$(echo "${ENTRIES_JSON}" | node -e "
const arr = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
let out = '';
for (const e of arr) {
  out += '=== ENTRY ID: ' + e.id + ' ===\n';
  if (e.context_text) out += e.context_text + '\n';
  if (e.fix_text) out += e.fix_text + '\n';
  out += '\n';
}
process.stdout.write(out);
  ")"

  PROMPT="You are reviewing knowledge base entries for the tool '${tool}'. Identify pairs of entries that have HIGH overlap (>60% similar content) and could be merged or where one supersedes the other. For each high-overlap pair, output a line in this exact format:
OVERLAP: <id1> <id2> REASON: <one sentence>
If no high-overlap pairs exist, output: NO_OVERLAP

Entries to review:

${PAYLOAD}"

  set +e
  if [[ "${CLAUDE_CMD}" == "q" ]]; then
    ANALYSIS="$(echo "${PROMPT}" | q 2>/dev/null)"
  else
    ANALYSIS="$(echo "${PROMPT}" | claude --print 2>/dev/null)"
  fi
  CLI_EXIT=$?
  set -e

  if [[ "${CLI_EXIT}" -ne 0 ]] || [[ -z "${ANALYSIS}" ]]; then
    warn "claude CLI failed for tool '${tool}' — skipping"
    continue
  fi

  while IFS= read -r line; do
    if [[ "${line}" =~ ^OVERLAP:[[:space:]]*([^[:space:]]+)[[:space:]]+([^[:space:]]+)[[:space:]]+REASON:[[:space:]]*(.*) ]]; then
      id1="${BASH_REMATCH[1]}"
      id2="${BASH_REMATCH[2]}"
      reason="${BASH_REMATCH[3]}"
      RECOMMENDATION_COUNT=$((RECOMMENDATION_COUNT + 1))
      log "  OVERLAP: ${id1} + ${id2}"
      log "    Reason: ${reason}"
      if ! "${DRY_RUN}"; then
        if node "${KNOWLEDGE_DB_JS}" archive "${id2}" >/dev/null 2>&1; then
          log "    Archived: ${id2}"
          ARCHIVED_COUNT=$((ARCHIVED_COUNT + 1))
        else
          warn "    Failed to archive ${id2}"
        fi
      fi
    fi
  done <<< "${ANALYSIS}"

done <<< "${TOOLS}"

# ─── Summary ──────────────────────────────────────────────────────────────────

echo ""
if "${DRY_RUN}"; then
  log "DRY RUN complete. ${RECOMMENDATION_COUNT} overlap recommendation(s) found."
  [[ "${RECOMMENDATION_COUNT}" -gt 0 ]] && log "Re-run with --apply to archive overlapping entries."
else
  log "Done. ${RECOMMENDATION_COUNT} overlap(s) found, ${ARCHIVED_COUNT} entries archived."
fi

exit 0
