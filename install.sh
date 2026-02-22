#!/usr/bin/env bash
# install.sh - Install agentic coding practices for Claude Code (macOS/Linux)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_DIR="$HOME/.claude"
PROFILE="dev"
WIZARD=false
FORCE=false
AUTO_EXIT=false
DRY_RUN=false

usage() {
  cat <<EOF
Usage: install.sh [OPTIONS]

Install agentic coding practices for Claude Code.

Options:
  --profile <name>    Installation profile: dev (default), research
  --wizard            Interactive wizard to merge with existing configuration
  --force             Overwrite existing files without prompting
  --auto-exit         Enable auto-exit after /checkpoint completes
  --dry-run           Show what would be installed without making changes
  -h, --help          Show this help message

Examples:
  ./install.sh                          # Install dev profile, prompt on conflicts
  ./install.sh --wizard                 # Interactive merge with existing config
  ./install.sh --force --auto-exit      # Overwrite everything, enable auto-exit
  ./install.sh --dry-run                # Preview what would be installed
EOF
  exit 0
}

# Parse arguments
while [[ "$#" -gt 0 ]]; do
  case $1 in
    --profile) PROFILE="$2"; shift ;;
    --wizard) WIZARD=true ;;
    --force) FORCE=true ;;
    --auto-exit) AUTO_EXIT=true ;;
    --dry-run) DRY_RUN=true ;;
    -h|--help) usage ;;
    *) echo "Unknown parameter: $1"; usage ;;
  esac
  shift
done

# Validate profile
if [ ! -d "$SCRIPT_DIR/profiles/$PROFILE" ]; then
  echo "ERROR: Profile '$PROFILE' not found."
  echo "Available profiles:"
  ls -1 "$SCRIPT_DIR/profiles/"
  exit 1
fi

echo "=== Agentic Coding Playbook Installer ==="
echo "Profile: $PROFILE"
echo "Target:  $CLAUDE_DIR"
echo ""

# --- Helper functions ---

install_file() {
  local src="$1"
  local dest="$2"
  local label="$3"

  if [ "$DRY_RUN" = true ]; then
    if [ -f "$dest" ]; then
      echo "[DRY RUN] CONFLICT: $label -> $dest (exists)"
    else
      echo "[DRY RUN] INSTALL:  $label -> $dest"
    fi
    return
  fi

  if [ -f "$dest" ] && [ "$FORCE" != true ]; then
    echo "EXISTS: $dest"
    if [ "$WIZARD" = true ]; then
      echo "  Your existing file will be preserved. The new content can be appended."
    fi
    read -r -p "  [s]kip, [o]verwrite, [b]ackup+overwrite? " choice
    case $choice in
      o|O)
        cp "$src" "$dest"
        echo "  -> Overwritten."
        ;;
      b|B)
        cp "$dest" "$dest.backup.$(date +%Y%m%d%H%M%S)"
        cp "$src" "$dest"
        echo "  -> Backed up and overwritten."
        ;;
      *)
        echo "  -> Skipped."
        ;;
    esac
  else
    mkdir -p "$(dirname "$dest")"
    cp "$src" "$dest"
    echo "INSTALLED: $label -> $dest"
  fi
}

install_skill() {
  local skill_name="$1"
  local src="$SCRIPT_DIR/profiles/$PROFILE/skills/$skill_name/SKILL.md"
  local dest_dir="$CLAUDE_DIR/skills/$skill_name"
  local dest="$dest_dir/SKILL.md"

  if [ ! -f "$src" ]; then
    return
  fi

  if [ "$DRY_RUN" = true ]; then
    if [ -d "$dest_dir" ]; then
      echo "[DRY RUN] SKILL EXISTS: $skill_name (would skip)"
    else
      echo "[DRY RUN] INSTALL SKILL: $skill_name"
    fi
    return
  fi

  if [ -d "$dest_dir" ] && [ "$FORCE" != true ]; then
    echo "SKILL EXISTS: $skill_name"
    read -r -p "  [s]kip, [o]verwrite, [b]ackup+overwrite? " choice
    case $choice in
      o|O)
        cp "$src" "$dest"
        echo "  -> Overwritten."
        ;;
      b|B)
        cp "$dest" "$dest.backup.$(date +%Y%m%d%H%M%S)" 2>/dev/null || true
        cp "$src" "$dest"
        echo "  -> Backed up and overwritten."
        ;;
      *)
        echo "  -> Skipped."
        ;;
    esac
  else
    mkdir -p "$dest_dir"
    cp "$src" "$dest"
    echo "INSTALLED SKILL: $skill_name"
  fi
}

# --- Wizard: analyze existing configuration ---

if [ "$WIZARD" = true ] && [ -f "$CLAUDE_DIR/CLAUDE.md" ]; then
  echo "=== Wizard: Analyzing existing configuration ==="
  echo ""
  echo "Found existing CLAUDE.md ($(wc -l < "$CLAUDE_DIR/CLAUDE.md") lines)."
  echo ""
  echo "Sections detected:"
  grep -E '^## ' "$CLAUDE_DIR/CLAUDE.md" | sed 's/^/  /' || echo "  (no sections found)"
  echo ""
  echo "The installer can:"
  echo "  1. Replace your CLAUDE.md with the playbook version (backup kept)"
  echo "  2. Skip CLAUDE.md and install only skills and templates"
  echo "  3. Abort and review manually"
  echo ""
  read -r -p "Choose [1/2/3]: " wiz_choice
  case $wiz_choice in
    1)
      cp "$CLAUDE_DIR/CLAUDE.md" "$CLAUDE_DIR/CLAUDE.md.backup.$(date +%Y%m%d%H%M%S)"
      echo "  -> Existing CLAUDE.md backed up."
      FORCE_CLAUDE=true
      ;;
    2)
      echo "  -> Skipping CLAUDE.md."
      FORCE_CLAUDE=skip
      ;;
    *)
      echo "  -> Aborting. Review the profiles/ directory and install manually."
      exit 0
      ;;
  esac
else
  FORCE_CLAUDE=false
fi

# --- Install files ---

echo ""
echo "--- Installing CLAUDE.md ---"
if [ "${FORCE_CLAUDE:-false}" = "skip" ]; then
  echo "SKIPPED: CLAUDE.md (wizard choice)"
elif [ "${FORCE_CLAUDE:-false}" = true ]; then
  cp "$SCRIPT_DIR/profiles/$PROFILE/CLAUDE.md" "$CLAUDE_DIR/CLAUDE.md"
  echo "INSTALLED: CLAUDE.md"
else
  install_file "$SCRIPT_DIR/profiles/$PROFILE/CLAUDE.md" "$CLAUDE_DIR/CLAUDE.md" "CLAUDE.md"
fi

echo ""
echo "--- Installing skills ---"
for skill_dir in "$SCRIPT_DIR/profiles/$PROFILE/skills"/*/; do
  [ -d "$skill_dir" ] || continue
  skill_name=$(basename "$skill_dir")
  install_skill "$skill_name"
done

echo ""
echo "--- Installing templates ---"
mkdir -p "$CLAUDE_DIR/templates"
for template_file in "$SCRIPT_DIR/templates"/*; do
  [ -f "$template_file" ] || continue
  template_name=$(basename "$template_file")
  install_file "$template_file" "$CLAUDE_DIR/templates/$template_name" "template: $template_name"
done

# --- Auto-exit option ---

if [ "$AUTO_EXIT" = true ] && [ "$DRY_RUN" != true ]; then
  touch "$CLAUDE_DIR/.auto-exit-after-checkpoint"
  echo ""
  echo "AUTO-EXIT: Enabled. The /checkpoint skill will exit the session automatically."
  echo "  To disable: rm $CLAUDE_DIR/.auto-exit-after-checkpoint"
fi

# --- Summary ---

echo ""
echo "=== Installation complete ==="
echo "Profile: $PROFILE"
echo ""
echo "What was installed:"
echo "  CLAUDE.md       -> $CLAUDE_DIR/CLAUDE.md"
for skill_dir in "$SCRIPT_DIR/profiles/$PROFILE/skills"/*/; do
  [ -d "$skill_dir" ] || continue
  echo "  /$(basename "$skill_dir") skill -> $CLAUDE_DIR/skills/$(basename "$skill_dir")/"
done
echo "  Templates       -> $CLAUDE_DIR/templates/"
echo ""
echo "Next steps:"
echo "  1. Review $CLAUDE_DIR/CLAUDE.md and customize for your workflow"
echo "  2. Start a Claude Code session: claude"
echo "  3. Try /resume to see session continuity in action"
echo "  4. Use /checkpoint at natural breakpoints"
echo ""
echo "Documentation: see docs/best-practices.md in this repo"
