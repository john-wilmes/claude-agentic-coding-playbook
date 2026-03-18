#!/usr/bin/env bash
# scripts/skills/next-evidence-number.sh
#
# Counts EVIDENCE/NNN-*.md files in a given investigation directory and prints
# the next zero-padded 3-digit number after the highest existing one.
#
# Usage: next-evidence-number.sh <investigation-dir>
#   investigation-dir  Path to an investigation directory (must contain EVIDENCE/).
#
# Prints the next evidence number (e.g. 004) to stdout.
# Exit 0 on success, exit 1 if EVIDENCE/ dir doesn't exist.

set -euo pipefail

INV_DIR="${1:?Usage: next-evidence-number.sh <investigation-dir>}"
EVIDENCE_DIR="$INV_DIR/EVIDENCE"

if [ ! -d "$EVIDENCE_DIR" ]; then
  echo "ERROR: $EVIDENCE_DIR not found" >&2
  exit 1
fi

# Find highest existing number
highest=0
for f in "$EVIDENCE_DIR"/[0-9][0-9][0-9]-*.md; do
  [ -f "$f" ] || continue
  num=$(basename "$f" | grep -oE '^[0-9]+' | sed 's/^0*//')
  [ -z "$num" ] && num=0
  [ "$num" -gt "$highest" ] && highest="$num"
done

next=$((highest + 1))
printf "%03d\n" "$next"
