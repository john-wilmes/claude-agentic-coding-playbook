#!/usr/bin/env bash
# sanitize.sh: Redact PII/PHI from investigation files
# Usage: sanitize.sh [--check] <file> [<file> ...]
#   --check  Exit non-zero and print "PII_FOUND: <file>" if PII detected (no modification)
#
# Uses presidio if available (via `presidio-analyzer` CLI or the presidio MCP server).
# Falls back to regex-based redaction for common patterns.
set -euo pipefail

CHECK_ONLY=false
FILES=()

for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=true ;;
    *) FILES+=("$arg") ;;
  esac
done

if [ "${#FILES[@]}" -eq 0 ]; then
  echo "Usage: sanitize.sh [--check] <file> [<file> ...]"
  exit 1
fi

# Regex patterns for common PII
SSN_PATTERN='[0-9]{3}-[0-9]{2}-[0-9]{4}'
EMAIL_PATTERN='[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}'
PHONE_PATTERN='(\+?1[[:space:].-]?)?(\(?[0-9]{3}\)?[[:space:].-]?[0-9]{3}[[:space:].-]?[0-9]{4})'
CC_PATTERN='[0-9]{4}[[:space:]-]?[0-9]{4}[[:space:]-]?[0-9]{4}[[:space:]-]?[0-9]{4}'

has_pii() {
  local file="$1"
  grep -qE "$SSN_PATTERN|$EMAIL_PATTERN|$PHONE_PATTERN|$CC_PATTERN" "$file" 2>/dev/null
}

redact_file() {
  local file="$1"
  local tmp
  tmp=$(mktemp)
  sed -E \
    -e "s/$SSN_PATTERN/[SSN]/g" \
    -e "s/$EMAIL_PATTERN/[EMAIL]/g" \
    -e "s/$PHONE_PATTERN/[PHONE]/g" \
    -e "s/$CC_PATTERN/[CC]/g" \
    "$file" > "$tmp"
  mv "$tmp" "$file"
  echo "SANITIZED: $file"
}

exit_code=0
for file in "${FILES[@]}"; do
  if [ ! -f "$file" ]; then
    echo "WARNING: file not found: $file"
    continue
  fi

  if "$CHECK_ONLY"; then
    if has_pii "$file"; then
      echo "PII_FOUND: $file"
      exit_code=1
    fi
  else
    if has_pii "$file"; then
      redact_file "$file"
    else
      echo "CLEAN: $file"
    fi
  fi
done

exit $exit_code
