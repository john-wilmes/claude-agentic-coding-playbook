#!/usr/bin/env bash
# scripts/skills/find-install-root.sh
#
# Walk-up algorithm: from a starting directory upward, check for .claude/ with
# investigations/, skills/, or templates/ subdirs. Falls back to $HOME.
#
# Usage: find-install-root.sh [starting-dir]
#   starting-dir  Optional. Defaults to $PWD.
#
# Prints the install root (parent of .claude/) to stdout. Exit 0 always.

set -euo pipefail

dir="${1:-$(pwd)}"

# Resolve to absolute path
dir="$(cd "$dir" && pwd)"

while [ "$dir" != "/" ]; do
  if [ -d "$dir/.claude" ]; then
    for sub in investigations skills templates; do
      if [ -d "$dir/.claude/$sub" ]; then
        echo "$dir"
        exit 0
      fi
    done
  fi
  dir="$(dirname "$dir")"
done

# Fallback: check $HOME
if [ -d "$HOME/.claude" ]; then
  for sub in investigations skills templates; do
    if [ -d "$HOME/.claude/$sub" ]; then
      echo "$HOME"
      exit 0
    fi
  done
fi

echo "$HOME"
