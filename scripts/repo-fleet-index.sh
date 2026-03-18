#!/usr/bin/env bash
# repo-fleet-index.sh — CLI wrapper for the repo fleet indexer and MCP server.
#
# Usage:
#   repo-fleet-index --build                 Full build: scan all repos
#   repo-fleet-index --refresh               Incremental: re-index changed repos
#   repo-fleet-index --refresh <repo>        Refresh a single repo
#   repo-fleet-index --search "query"        Search manifests
#   repo-fleet-index --list                  List all indexed repos
#   repo-fleet-index --serve                 Start MCP server
#
# Options:
#   --repos-dir <path>   Override repos directory (default: ~/.claude/repos)
#   --output-dir <path>  Override output directory (default: ~/.claude/fleet)
#   --verbose            Show detailed progress
#   -h, --help           Show this help

set -euo pipefail

# ─── Resolve script location ──────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ─── Defaults ─────────────────────────────────────────────────────────────────

REPOS_DIR="${HOME}/.claude/repos"
OUTPUT_DIR="${HOME}/.claude/fleet"
VERBOSE=false
COMMAND=""
SINGLE_REPO=""
SEARCH_QUERY=""

# ─── Node module lookup ───────────────────────────────────────────────────────
# Try installed path (~/.claude/...) first; fall back to source tree.

find_fleet_index() {
  local installed="${HOME}/.claude/fleet/fleet-index.js"
  local source_tree="${SCRIPT_DIR}/../templates/fleet/fleet-index.js"
  if [[ -f "${installed}" ]]; then
    printf '%s' "${installed}"
  elif [[ -f "${source_tree}" ]]; then
    printf '%s' "$(realpath "${source_tree}")"
  else
    echo "repo-fleet-index: fleet-index.js not found" >&2
    echo "  Checked: ${installed}" >&2
    echo "  Checked: ${source_tree}" >&2
    exit 1
  fi
}

find_mcp_server() {
  local installed="${HOME}/.claude/mcp/fleet-index-server.js"
  local source_tree="${SCRIPT_DIR}/../templates/mcp/fleet-index-server.js"
  if [[ -f "${installed}" ]]; then
    printf '%s' "${installed}"
  elif [[ -f "${source_tree}" ]]; then
    printf '%s' "$(realpath "${source_tree}")"
  else
    echo "repo-fleet-index: fleet-index-server.js not found" >&2
    echo "  Checked: ${installed}" >&2
    echo "  Checked: ${source_tree}" >&2
    exit 1
  fi
}

# ─── Usage ────────────────────────────────────────────────────────────────────

usage() {
  cat <<'EOF'
Usage: repo-fleet-index [OPTIONS] COMMAND

Commands:
  --build                Full build: scan all repos, generate manifests + digest
  --refresh              Incremental: only re-index repos where HEAD changed
  --refresh <repo>       Refresh a single repo (e.g., org/repo-name)
  --search "query"       Search manifests using BM25
  --list                 List all indexed repos
  --serve                Start MCP server (for claude settings.json)

Options:
  --repos-dir <path>     Override repos directory (default: ~/.claude/repos)
  --output-dir <path>    Override output directory (default: ~/.claude/fleet)
  --verbose              Show detailed progress
  -h, --help             Show this help message

Examples:
  repo-fleet-index --build
  repo-fleet-index --refresh org/payment-service
  repo-fleet-index --search "payment stripe"
  repo-fleet-index --list
  repo-fleet-index --serve
EOF
}

# ─── Argument parsing ─────────────────────────────────────────────────────────

if [[ $# -eq 0 ]]; then
  usage
  exit 0
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --build)
      COMMAND="build"
      shift
      ;;
    --refresh)
      COMMAND="refresh"
      # Optional: next arg may be a repo name (not a flag)
      if [[ $# -gt 1 && "${2:-}" != --* ]]; then
        SINGLE_REPO="$2"
        shift
      fi
      shift
      ;;
    --search)
      COMMAND="search"
      if [[ $# -lt 2 || "${2:-}" == --* ]]; then
        echo "repo-fleet-index: --search requires a query argument" >&2
        exit 1
      fi
      SEARCH_QUERY="$2"
      shift 2
      ;;
    --list)
      COMMAND="list"
      shift
      ;;
    --serve)
      COMMAND="serve"
      shift
      ;;
    --repos-dir)
      if [[ $# -lt 2 || "${2:-}" == --* ]]; then
        echo "repo-fleet-index: --repos-dir requires a path argument" >&2
        exit 1
      fi
      REPOS_DIR="$2"
      shift 2
      ;;
    --output-dir)
      if [[ $# -lt 2 || "${2:-}" == --* ]]; then
        echo "repo-fleet-index: --output-dir requires a path argument" >&2
        exit 1
      fi
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --verbose)
      VERBOSE=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "repo-fleet-index: unknown option: $1" >&2
      echo "Run 'repo-fleet-index --help' for usage." >&2
      exit 1
      ;;
    *)
      echo "repo-fleet-index: unexpected argument: $1" >&2
      echo "Run 'repo-fleet-index --help' for usage." >&2
      exit 1
      ;;
  esac
done

if [[ -z "${COMMAND}" ]]; then
  echo "repo-fleet-index: no command specified" >&2
  echo "Run 'repo-fleet-index --help' for usage." >&2
  exit 1
fi

# ─── Verbose helper ───────────────────────────────────────────────────────────

log() {
  if [[ "${VERBOSE}" == "true" ]]; then
    echo "[repo-fleet-index] $*" >&2
  fi
}

info() {
  echo "[repo-fleet-index] $*" >&2
}

# ─── Validate repos-dir for commands that need it ────────────────────────────

require_repos_dir() {
  if [[ ! -d "${REPOS_DIR}" ]]; then
    echo "repo-fleet-index: repos directory not found: ${REPOS_DIR}" >&2
    echo "  Create it or pass --repos-dir <path>" >&2
    exit 1
  fi
}

# ─── Ensure node is available ─────────────────────────────────────────────────

if ! command -v node &>/dev/null; then
  echo "repo-fleet-index: node is required but not found on PATH" >&2
  exit 1
fi

# ─── Command dispatch ─────────────────────────────────────────────────────────

case "${COMMAND}" in

  build)
    require_repos_dir
    FLEET_INDEX="$(find_fleet_index)"
    info "Full build: ${REPOS_DIR} -> ${OUTPUT_DIR}"
    log "Using fleet-index: ${FLEET_INDEX}"
    node "${FLEET_INDEX}" \
      --build \
      --repos-dir "${REPOS_DIR}" \
      --output-dir "${OUTPUT_DIR}" \
      ${VERBOSE:+--verbose}
    info "Build complete."
    ;;

  refresh)
    FLEET_INDEX="$(find_fleet_index)"
    if [[ -n "${SINGLE_REPO}" ]]; then
      info "Refreshing single repo: ${SINGLE_REPO}"
      log "Using fleet-index: ${FLEET_INDEX}"
      node "${FLEET_INDEX}" \
        --refresh "${SINGLE_REPO}" \
        --repos-dir "${REPOS_DIR}" \
        --output-dir "${OUTPUT_DIR}" \
        ${VERBOSE:+--verbose}
    else
      require_repos_dir
      info "Incremental refresh: ${REPOS_DIR}"
      log "Using fleet-index: ${FLEET_INDEX}"
      node "${FLEET_INDEX}" \
        --refresh \
        --repos-dir "${REPOS_DIR}" \
        --output-dir "${OUTPUT_DIR}" \
        ${VERBOSE:+--verbose}
    fi
    info "Refresh complete."
    ;;

  search)
    FLEET_INDEX="$(find_fleet_index)"
    log "Searching: ${SEARCH_QUERY}"
    log "Using fleet-index: ${FLEET_INDEX}"
    node "${FLEET_INDEX}" \
      --search "${SEARCH_QUERY}" \
      --output-dir "${OUTPUT_DIR}"
    ;;

  list)
    FLEET_INDEX="$(find_fleet_index)"
    log "Listing all indexed repos"
    log "Using fleet-index: ${FLEET_INDEX}"
    node "${FLEET_INDEX}" \
      --list \
      --output-dir "${OUTPUT_DIR}"
    ;;

  serve)
    MCP_SERVER="$(find_mcp_server)"
    info "Starting MCP server (fleet: ${OUTPUT_DIR})"
    log "Using server: ${MCP_SERVER}"
    export FLEET_MANIFESTS_DIR="${OUTPUT_DIR}/manifests"
    export FLEET_DIGEST_FILE="${OUTPUT_DIR}/fleet-digest.txt"
    exec node "${MCP_SERVER}"
    ;;

esac
