#!/usr/bin/env bash
# scripts/skills/da-check.sh — Devil's Advocate check for checkpoint
#
# Counts commits ahead of base branch and checks if any changed files are
# docs/config types. Prints DA_NEEDED or DA_NOT_NEEDED to stdout.
#
# Usage: bash scripts/skills/da-check.sh
# Exit 0 always.

set -euo pipefail

# Guard: not in a git repo
if ! git rev-parse --git-dir &>/dev/null; then
  echo "DA_NOT_NEEDED"
  exit 0
fi

# Detect base branch from remote HEAD, then fall back to common names
base=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||') || base=""
if [ -z "$base" ]; then
  for candidate in main master; do
    if git rev-parse --verify "origin/$candidate" &>/dev/null; then
      base="$candidate"
      break
    fi
  done
fi

if [ -z "$base" ]; then
  echo "DA_NOT_NEEDED"
  exit 0
fi

# Count commits ahead of remote base
count=$(git rev-list --count "origin/$base..HEAD" 2>/dev/null) || count=0

if [ "$count" -lt 5 ]; then
  echo "DA_NOT_NEEDED"
  exit 0
fi

# Check for doc/config files in the diff
doc_files=$(git diff --name-only "origin/$base..HEAD" 2>/dev/null | grep -iE '\.(md|yaml|yml|json|toml|mdc)$' || true)

if [ -n "$doc_files" ]; then
  echo "DA_NEEDED"
else
  echo "DA_NOT_NEEDED"
fi
