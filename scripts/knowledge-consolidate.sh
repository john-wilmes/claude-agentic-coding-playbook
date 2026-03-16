#!/usr/bin/env bash
# knowledge-consolidate.sh — Deduplicate and consolidate knowledge entries using
# the claude CLI for pairwise overlap analysis.
#
# Usage:
#   knowledge-consolidate.sh [--dry-run] [--apply] [--help]
#
# Default mode is --dry-run. Pass --apply to actually archive overlapping entries.

set -euo pipefail

# ─── Constants ────────────────────────────────────────────────────────────────

KNOWLEDGE_DIR="${HOME}/.claude/knowledge"
ENTRIES_DIR="${KNOWLEDGE_DIR}/entries"
ARCHIVE_DIR="${KNOWLEDGE_DIR}/archived"

DRY_RUN=true

# ─── Helpers ──────────────────────────────────────────────────────────────────

log()  { echo "[consolidate] $*"; }
warn() { echo "[consolidate] WARNING: $*" >&2; }

usage() {
  cat <<'EOF'
Usage: knowledge-consolidate.sh [--dry-run] [--apply] [--help]

Scan ~/.claude/knowledge/entries/ for overlapping knowledge entries and
optionally archive duplicates.

Options:
  --dry-run   Show recommendations without making changes (default)
  --apply     Archive overlapping entries (move to ~/.claude/knowledge/archived/)
  --help      Show this help message

Behavior:
  1. Groups entries by the "tool" field in their frontmatter.
  2. For each tool group with 2+ entries, uses the claude CLI to identify
     high-overlap pairs that could be merged.
  3. In dry-run mode: prints recommendations only.
  4. In apply mode: moves overlapping entries to the archive directory.

The script is idempotent — safe to run multiple times.
EOF
}

# ─── Flag parsing ─────────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --apply)
      DRY_RUN=false
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Run with --help for usage." >&2
      exit 1
      ;;
  esac
done

# ─── Preflight checks ─────────────────────────────────────────────────────────

if [[ ! -d "${ENTRIES_DIR}" ]]; then
  log "Knowledge entries directory not found: ${ENTRIES_DIR}"
  log "Run install.sh or create the directory to get started."
  exit 0
fi

# Detect available claude CLI command
CLAUDE_CMD=""
if command -v q >/dev/null 2>&1; then
  CLAUDE_CMD="q"
elif command -v claude >/dev/null 2>&1; then
  CLAUDE_CMD="claude --print"
fi

if [[ -z "${CLAUDE_CMD}" ]]; then
  warn "Neither 'q' nor 'claude' CLI found in PATH."
  warn "Cannot perform AI-assisted overlap analysis."
  warn "Manual review recommended: ls ${ENTRIES_DIR}"
  exit 0
fi

# ─── Safety: create git tag before any changes ────────────────────────────────

if ! "${DRY_RUN}" && [[ -d "${KNOWLEDGE_DIR}/.git" ]]; then
  TAG="pre-consolidation-$(date +%Y%m%d)"
  if git -C "${KNOWLEDGE_DIR}" tag "${TAG}" 2>/dev/null; then
    log "Created git tag: ${TAG}"
  else
    log "Git tag ${TAG} already exists — skipping (already run today)"
  fi
fi

# ─── Scan entries ─────────────────────────────────────────────────────────────

mapfile -t ENTRY_FILES < <(find "${ENTRIES_DIR}" -name "entry.md" -type f | sort)

TOTAL="${#ENTRY_FILES[@]}"
log "Found ${TOTAL} knowledge entries in ${ENTRIES_DIR}"

if [[ "${TOTAL}" -lt 2 ]]; then
  log "Fewer than 2 entries — nothing to consolidate."
  exit 0
fi

# ─── Group by tool field ──────────────────────────────────────────────────────

declare -A TOOL_GROUPS  # tool -> space-separated list of entry file paths

for entry_file in "${ENTRY_FILES[@]}"; do
  tool="$(grep -m1 '^tool:' "${entry_file}" 2>/dev/null | sed 's/^tool:[[:space:]]*//' | tr -d '"' | xargs || true)"
  if [[ -z "${tool}" ]]; then
    tool="__unknown__"
  fi
  if [[ -v "TOOL_GROUPS[${tool}]" ]]; then
    TOOL_GROUPS["${tool}"]="${TOOL_GROUPS[${tool}]} ${entry_file}"
  else
    TOOL_GROUPS["${tool}"]="${entry_file}"
  fi
done

log "Grouped entries into ${#TOOL_GROUPS[@]} tool categories"

# ─── Analyze each group for overlap ──────────────────────────────────────────

if "${DRY_RUN}"; then
  log "=== DRY RUN mode — no files will be moved ==="
else
  log "=== APPLY mode — overlapping entries will be archived ==="
fi

RECOMMENDATION_COUNT=0
ARCHIVED_COUNT=0

for tool in "${!TOOL_GROUPS[@]}"; do
  read -ra entries <<< "${TOOL_GROUPS[${tool}]}"
  count="${#entries[@]}"

  if [[ "${count}" -lt 2 ]]; then
    continue
  fi

  log "Analyzing tool '${tool}': ${count} entries"

  # Build combined payload for claude
  PAYLOAD=""
  for entry_file in "${entries[@]}"; do
    entry_id="$(basename "$(dirname "${entry_file}")")"
    content="$(cat "${entry_file}" 2>/dev/null || true)"
    PAYLOAD+="=== ENTRY ID: ${entry_id} ===\n${content}\n\n"
  done

  PROMPT="$(printf '%b' "You are reviewing knowledge base entries for the tool '${tool}'. Identify pairs of entries that have HIGH overlap (>60%% similar content) and could be merged or where one supersedes the other. For each high-overlap pair, output a line in this exact format:\nOVERLAP: <id1> <id2> REASON: <one sentence>\nIf no high-overlap pairs exist, output: NO_OVERLAP\n\nEntries to review:\n\n${PAYLOAD}")"

  # Run claude CLI; capture output; tolerate errors
  set +e
  if [[ "${CLAUDE_CMD}" == "q" ]]; then
    ANALYSIS="$(echo "${PROMPT}" | q 2>/dev/null)"
  else
    ANALYSIS="$(echo "${PROMPT}" | claude --print 2>/dev/null)"
  fi
  CLI_EXIT=$?
  set -e

  if [[ "${CLI_EXIT}" -ne 0 ]] || [[ -z "${ANALYSIS}" ]]; then
    warn "claude CLI failed or returned empty output for tool '${tool}' — skipping"
    continue
  fi

  # Parse OVERLAP lines
  while IFS= read -r line; do
    if [[ "${line}" =~ ^OVERLAP:[[:space:]]*([^[:space:]]+)[[:space:]]+([^[:space:]]+)[[:space:]]+REASON:[[:space:]]*(.*) ]]; then
      id1="${BASH_REMATCH[1]}"
      id2="${BASH_REMATCH[2]}"
      reason="${BASH_REMATCH[3]}"

      RECOMMENDATION_COUNT=$((RECOMMENDATION_COUNT + 1))
      log "  OVERLAP: ${id1} + ${id2}"
      log "    Reason: ${reason}"

      if ! "${DRY_RUN}"; then
        # Archive the second entry (keep the first as canonical)
        # TODO: future update should read entries from the DB directly
        if node "${HOME}/.claude/hooks/knowledge-db.js" archive "${id2}" 2>/dev/null; then
          log "    Archived: ${id2} in knowledge database"
          ARCHIVED_COUNT=$((ARCHIVED_COUNT + 1))
        else
          warn "    Failed to archive ${id2} — skipping"
        fi
      fi
    fi
  done <<< "${ANALYSIS}"
done

# ─── Summary ──────────────────────────────────────────────────────────────────

echo ""
if "${DRY_RUN}"; then
  log "DRY RUN complete. ${RECOMMENDATION_COUNT} overlap recommendation(s) found."
  if [[ "${RECOMMENDATION_COUNT}" -gt 0 ]]; then
    log "Re-run with --apply to archive overlapping entries."
  fi
else
  log "Done. ${RECOMMENDATION_COUNT} overlap(s) found, ${ARCHIVED_COUNT} entries archived."
fi

exit 0
