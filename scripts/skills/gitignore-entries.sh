#!/usr/bin/env bash
# scripts/skills/gitignore-entries.sh — .gitignore generator for create-project
#
# Prints language-specific .gitignore lines for a project type.
#
# Usage: bash scripts/skills/gitignore-entries.sh <type>
#   type: node | python | nextjs | static | other (default: other)
# Exit 0 always.

set -euo pipefail

TYPE="${1:-other}"

# Baseline entries always included per repo hygiene rules
BASELINE="node_modules/
dist/
.env*
*.log
.DS_Store
Thumbs.db"

case "$TYPE" in
  node)
    echo "$BASELINE"
    echo "coverage/"
    echo ".nyc_output/"
    ;;
  python)
    echo "$BASELINE"
    echo "__pycache__/"
    echo "*.pyc"
    echo ".venv/"
    echo "*.egg-info/"
    echo ".pytest_cache/"
    ;;
  nextjs)
    echo "$BASELINE"
    echo ".next/"
    echo "out/"
    echo "coverage/"
    ;;
  static)
    echo "$BASELINE"
    ;;
  *)
    echo "$BASELINE"
    ;;
esac
