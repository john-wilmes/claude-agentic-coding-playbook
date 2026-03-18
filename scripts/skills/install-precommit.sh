#!/usr/bin/env bash
set -euo pipefail

TEMPLATE=""
PROJECT=""
DRY_RUN=false

while [[ "$#" -gt 0 ]]; do
  case $1 in
    --template) TEMPLATE="$2"; shift ;;
    --project) PROJECT="$2"; shift ;;
    --dry-run) DRY_RUN=true ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
  shift
done

if [ -z "$TEMPLATE" ] || [ -z "$PROJECT" ]; then
  echo "Usage: install-precommit.sh --template <path> --project <path> [--dry-run]" >&2
  exit 1
fi

# Check template exists
if [ ! -f "$TEMPLATE" ]; then
  echo "NO_TEMPLATE"
  exit 0
fi

# Check project is a git repo
if ! git -C "$PROJECT" rev-parse --git-dir &>/dev/null; then
  echo "NOT_A_REPO"
  exit 0
fi

# Check for core.hooksPath
hooks_path=$(git -C "$PROJECT" config core.hooksPath 2>/dev/null || true)

if [ -n "$hooks_path" ]; then
  # Expand ~ manually
  case "$hooks_path" in
    "~/"*) hooks_path="$HOME/${hooks_path#\~/}" ;;
    "~") hooks_path="$HOME" ;;
  esac

  target="$hooks_path/pre-commit"
  if [ -f "$target" ]; then
    echo "SKIPPED_GLOBAL:$hooks_path"
    exit 0
  fi

  if [ "$DRY_RUN" = true ]; then
    echo "INSTALLED_GLOBAL:$hooks_path"
    exit 0
  fi

  mkdir -p "$hooks_path"
  cp "$TEMPLATE" "$target"
  chmod +x "$target"
  echo "INSTALLED_GLOBAL:$hooks_path"
else
  git_dir=$(git -C "$PROJECT" rev-parse --git-dir 2>/dev/null)
  # Make absolute if relative
  case "$git_dir" in
    /*) ;;
    *) git_dir="$PROJECT/$git_dir" ;;
  esac
  target="$git_dir/hooks/pre-commit"

  if [ -f "$target" ]; then
    echo "SKIPPED"
    exit 0
  fi

  if [ "$DRY_RUN" = true ]; then
    echo "INSTALLED"
    exit 0
  fi

  mkdir -p "$(dirname "$target")"
  cp "$TEMPLATE" "$target"
  chmod +x "$target"
  echo "INSTALLED"
fi
