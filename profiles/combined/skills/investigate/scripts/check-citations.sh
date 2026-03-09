#!/usr/bin/env bash
# check-citations.sh — Deterministic citation rate checker for investigations.
# Usage: check-citations.sh <INVESTIGATIONS_DIR> <ID>
# Output: JSON with total_evidence, cited_count, citation_rate, uncited_files

set -euo pipefail

INVESTIGATIONS_DIR="${1:?Usage: check-citations.sh <INVESTIGATIONS_DIR> <ID>}"
ID="${2:?Usage: check-citations.sh <INVESTIGATIONS_DIR> <ID>}"

EVIDENCE_DIR="$INVESTIGATIONS_DIR/$ID/EVIDENCE"
FINDINGS="$INVESTIGATIONS_DIR/$ID/FINDINGS.md"

if [ ! -d "$EVIDENCE_DIR" ]; then
  echo '{"error": "EVIDENCE directory not found"}'
  exit 1
fi

if [ ! -f "$FINDINGS" ]; then
  echo '{"error": "FINDINGS.md not found"}'
  exit 1
fi

# Count evidence files with numeric prefixes
evidence_files=()
while IFS= read -r -d '' f; do
  evidence_files+=("$(basename "$f")")
done < <(find "$EVIDENCE_DIR" -maxdepth 1 -name '[0-9][0-9][0-9]-*.md' -print0 2>/dev/null | sort -z)

total=${#evidence_files[@]}

if [ "$total" -eq 0 ]; then
  echo '{"total_evidence": 0, "cited_count": 0, "citation_rate": 0, "uncited_files": []}'
  exit 0
fi

# Extract all cited evidence numbers from FINDINGS.md Answer section
# Matches patterns like (Evidence 001), (Evidence 001, 002), (inferred from Evidence 003)
cited_numbers=$(grep -oE 'Evidence[[:space:]]+[0-9]{3}' "$FINDINGS" | grep -oE '[0-9]{3}$' | sort -u)

cited_count=$(echo "$cited_numbers" | grep -c '[0-9]' 2>/dev/null || echo 0)

# Find uncited files
uncited=()
for f in "${evidence_files[@]}"; do
  num="${f:0:3}"
  if ! echo "$cited_numbers" | grep -qx "$num" 2>/dev/null; then
    uncited+=("$f")
  fi
done

uncited_count=${#uncited[@]}

# Compute citation rate
if [ "$total" -gt 0 ]; then
  citation_rate=$(( (cited_count * 100 + total / 2) / total ))
else
  citation_rate=0
fi

# Output JSON
if [ ${#uncited[@]} -eq 0 ]; then
  uncited_json="[]"
else
  uncited_json=$(printf '%s\n' "${uncited[@]}" | jq -R . | jq -s .)
fi
echo "{\"total_evidence\": $total, \"cited_count\": $cited_count, \"citation_rate\": $citation_rate, \"uncited_count\": $uncited_count, \"uncited_files\": $uncited_json}"
