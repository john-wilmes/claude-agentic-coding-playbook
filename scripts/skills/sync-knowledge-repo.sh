#!/usr/bin/env bash
set -euo pipefail

KNOWLEDGE_DIR="${HOME}/.claude/knowledge"
DRY_RUN=false

while [[ "$#" -gt 0 ]]; do
  case $1 in
    --knowledge-dir) KNOWLEDGE_DIR="$2"; shift ;;
    --dry-run) DRY_RUN=true ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
  shift
done

# Check directory exists
if [ ! -d "$KNOWLEDGE_DIR" ]; then
  echo "NO_DIR"
  exit 0
fi

# Check it's a git repo
if ! git -C "$KNOWLEDGE_DIR" rev-parse --git-dir &>/dev/null; then
  echo "NO_GIT"
  exit 0
fi

# Check for changes
if [ -z "$(git -C "$KNOWLEDGE_DIR" status --porcelain)" ]; then
  echo "NO_CHANGES"
  exit 0
fi

if [ "$DRY_RUN" = true ]; then
  echo "COMMITTED"
  exit 0
fi

# Stage and commit
git -C "$KNOWLEDGE_DIR" add -A
git -C "$KNOWLEDGE_DIR" commit -m "checkpoint: sync knowledge entries" --quiet

# Try to push if remote exists
if git -C "$KNOWLEDGE_DIR" remote get-url origin &>/dev/null; then
  if git -C "$KNOWLEDGE_DIR" push origin HEAD --quiet 2>/dev/null; then
    echo "PUSHED"
  else
    echo "PUSH_FAILED"
  fi
else
  echo "COMMITTED"
fi
