#!/usr/bin/env bash
# install.sh - Install agentic coding practices for Claude Code (macOS/Linux)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_DIR="$HOME/.claude"
PROFILE="dev"
WIZARD=false
FORCE=false
DRY_RUN=false
KNOWLEDGE_REPO=""

usage() {
  cat <<EOF
Usage: install.sh [OPTIONS]

Install agentic coding practices for Claude Code.

Options:
  --profile <name>         Installation profile: dev (default), research
  --wizard                 Interactive wizard to merge with existing configuration
  --force                  Overwrite existing files without prompting
  --dry-run                Show what would be installed without making changes
  --knowledge-repo <url>   Clone (or pull) a git repo into ~/.claude/knowledge
  -h, --help               Show this help message

Examples:
  ./install.sh                          # Install dev profile, prompt on conflicts
  ./install.sh --wizard                 # Interactive merge with existing config
  ./install.sh --force                   # Overwrite everything
  ./install.sh --dry-run                # Preview what would be installed
  ./install.sh --knowledge-repo https://github.com/org/knowledge
EOF
  exit 0
}

# Parse arguments
while [[ "$#" -gt 0 ]]; do
  case $1 in
    --profile)
      if [[ "$#" -lt 2 || "$2" == --* ]]; then
        echo "ERROR: --profile requires a value (dev, research)"; exit 1
      fi
      PROFILE="$2"; shift ;;
    --wizard) WIZARD=true ;;
    --force) FORCE=true ;;
    --dry-run) DRY_RUN=true ;;
    --knowledge-repo)
      if [[ "$#" -lt 2 || "$2" == --* ]]; then
        echo "ERROR: --knowledge-repo requires a URL"; exit 1
      fi
      KNOWLEDGE_REPO="$2"; shift ;;
    -h|--help) usage ;;
    *) echo "Unknown parameter: $1"; usage ;;
  esac
  shift
done

# Validate profile (whitelist to prevent path traversal)
case "$PROFILE" in
  dev|research) ;;
  *) echo "ERROR: Unknown profile '$PROFILE'. Available: dev, research"; exit 1 ;;
esac
if [ ! -d "$SCRIPT_DIR/profiles/$PROFILE" ]; then
  echo "ERROR: Profile '$PROFILE' directory not found."
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
      if [ "$DRY_RUN" = true ]; then
        echo "  -> [DRY RUN] Would back up existing CLAUDE.md."
      else
        cp "$CLAUDE_DIR/CLAUDE.md" "$CLAUDE_DIR/CLAUDE.md.backup.$(date +%Y%m%d%H%M%S)"
        echo "  -> Existing CLAUDE.md backed up."
      fi
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
  if [ "$DRY_RUN" = true ]; then
    echo "[DRY RUN] Would install: CLAUDE.md"
  else
    cp "$SCRIPT_DIR/profiles/$PROFILE/CLAUDE.md" "$CLAUDE_DIR/CLAUDE.md"
    echo "INSTALLED: CLAUDE.md"
  fi
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
if [ "$DRY_RUN" != true ]; then
  mkdir -p "$CLAUDE_DIR/templates"
fi

# Project CLAUDE.md template
if [ -f "$SCRIPT_DIR/templates/project-CLAUDE.md" ]; then
  install_file "$SCRIPT_DIR/templates/project-CLAUDE.md" "$CLAUDE_DIR/templates/project-CLAUDE.md" "template: project-CLAUDE.md"
fi

# Investigation templates (research profile only)
if [ "$PROFILE" = "research" ] && [ -d "$SCRIPT_DIR/profiles/research/templates" ]; then
  echo ""
  echo "--- Installing investigation templates ---"
  if [ "$DRY_RUN" != true ]; then
    mkdir -p "$CLAUDE_DIR/templates/investigation/hooks"
  fi
  for tmpl_file in "$SCRIPT_DIR/profiles/research/templates"/*; do
    [ -f "$tmpl_file" ] || continue
    tmpl_name=$(basename "$tmpl_file")
    install_file "$tmpl_file" "$CLAUDE_DIR/templates/investigation/$tmpl_name" "investigation template: $tmpl_name"
  done
  if [ -d "$SCRIPT_DIR/profiles/research/templates/hooks" ]; then
    for hook_file in "$SCRIPT_DIR/profiles/research/templates/hooks"/*; do
      [ -f "$hook_file" ] || continue
      hook_name=$(basename "$hook_file")
      install_file "$hook_file" "$CLAUDE_DIR/templates/investigation/hooks/$hook_name" "investigation hook: $hook_name"
      if [ "$DRY_RUN" != true ] && [ -f "$CLAUDE_DIR/templates/investigation/hooks/$hook_name" ]; then
        chmod +x "$CLAUDE_DIR/templates/investigation/hooks/$hook_name"
      fi
    done
  fi
  # Create investigations directory structure
  if [ "$DRY_RUN" = true ]; then
    echo "[DRY RUN] MKDIR: ~/.claude/investigations/_patterns/"
  else
    mkdir -p "$CLAUDE_DIR/investigations/_patterns"
    echo "CREATED: ~/.claude/investigations/_patterns/"
  fi

  # Install investigation scripts
  echo ""
  echo "--- Installing investigation scripts ---"
  if [ -f "$SCRIPT_DIR/profiles/research/scripts/sanitize.sh" ]; then
    if [ "$DRY_RUN" = true ]; then
      echo "[DRY RUN] INSTALL: sanitize.sh -> ~/.claude/scripts/sanitize.sh"
    else
      mkdir -p "$CLAUDE_DIR/scripts"
      cp "$SCRIPT_DIR/profiles/research/scripts/sanitize.sh" "$CLAUDE_DIR/scripts/sanitize.sh"
      chmod +x "$CLAUDE_DIR/scripts/sanitize.sh"
      echo "INSTALLED: sanitize.sh -> $CLAUDE_DIR/scripts/sanitize.sh"
    fi
  fi
fi

# Git hook templates
if [ -d "$SCRIPT_DIR/templates/hooks" ]; then
  echo ""
  echo "--- Installing git hook templates ---"
  if [ "$DRY_RUN" != true ]; then
    mkdir -p "$CLAUDE_DIR/templates/hooks"
  fi
  for hook_file in "$SCRIPT_DIR/templates/hooks"/*; do
    [ -f "$hook_file" ] || continue
    hook_name=$(basename "$hook_file")
    install_file "$hook_file" "$CLAUDE_DIR/templates/hooks/$hook_name" "git hook: $hook_name"
    if [ "$DRY_RUN" != true ] && [ -f "$CLAUDE_DIR/templates/hooks/$hook_name" ]; then
      chmod +x "$CLAUDE_DIR/templates/hooks/$hook_name"
    fi
  done
fi

# Claude session hooks (SessionStart, SessionEnd -- installed to ~/.claude/hooks/)
echo ""
echo "--- Installing Claude session hooks ---"
if [ "$DRY_RUN" != true ]; then
  mkdir -p "$CLAUDE_DIR/hooks"
fi
for hook_file in "$SCRIPT_DIR/templates/hooks"/session-*.js; do
  [ -f "$hook_file" ] || continue
  hook_name=$(basename "$hook_file")
  install_file "$hook_file" "$CLAUDE_DIR/hooks/$hook_name" "session hook: $hook_name"
done

# Cursor templates (rules + commands)
if [ -d "$SCRIPT_DIR/templates/cursor" ]; then
  echo ""
  echo "--- Installing Cursor templates ---"
  if [ "$DRY_RUN" != true ]; then
    mkdir -p "$CLAUDE_DIR/templates/cursor/rules" "$CLAUDE_DIR/templates/cursor/commands"
  fi
  for rule_file in "$SCRIPT_DIR/templates/cursor/rules"/*; do
    [ -f "$rule_file" ] || continue
    rule_name=$(basename "$rule_file")
    install_file "$rule_file" "$CLAUDE_DIR/templates/cursor/rules/$rule_name" "cursor rule: $rule_name"
  done
  for cmd_file in "$SCRIPT_DIR/templates/cursor/commands"/*; do
    [ -f "$cmd_file" ] || continue
    cmd_name=$(basename "$cmd_file")
    install_file "$cmd_file" "$CLAUDE_DIR/templates/cursor/commands/$cmd_name" "cursor command: $cmd_name"
  done
fi

# --- Knowledge repo setup ---
if [ -n "$KNOWLEDGE_REPO" ]; then
  echo ""
  echo "--- Setting up knowledge repository ---"
  KNOWLEDGE_DIR="$CLAUDE_DIR/knowledge"
  if [ "$DRY_RUN" = true ]; then
    echo "[DRY RUN] Would clone $KNOWLEDGE_REPO -> $KNOWLEDGE_DIR"
  elif [ -d "$KNOWLEDGE_DIR/.git" ]; then
    echo "Knowledge repo already exists at $KNOWLEDGE_DIR"
    echo "Pulling latest..."
    git -C "$KNOWLEDGE_DIR" pull --rebase 2>/dev/null || echo "  Pull failed (may need manual resolution)"
  else
    echo "Cloning knowledge repo..."
    git clone "$KNOWLEDGE_REPO" "$KNOWLEDGE_DIR"
    echo "INSTALLED: knowledge repo -> $KNOWLEDGE_DIR"
  fi
  # Ensure entries directory exists
  if [ "$DRY_RUN" != true ]; then
    mkdir -p "$KNOWLEDGE_DIR/entries"
  fi
fi

# --- Cleanup skills from other profile ---

# Skills exclusive to each profile (continue is shared)
DEV_ONLY_SKILLS=("checkpoint" "create-project" "learn" "playbook" "promote")
RESEARCH_ONLY_SKILLS=("investigate")
LEGACY_SKILLS=("findings")

if [ "$PROFILE" = "dev" ]; then
  OTHER_SKILLS=("${RESEARCH_ONLY_SKILLS[@]}")
elif [ "$PROFILE" = "research" ]; then
  OTHER_SKILLS=("${DEV_ONLY_SKILLS[@]}" "${LEGACY_SKILLS[@]}")
fi

for other_skill in "${OTHER_SKILLS[@]}"; do
  other_dir="$CLAUDE_DIR/skills/$other_skill"
  if [ -d "$other_dir" ]; then
    if [ "$DRY_RUN" = true ]; then
      echo "[DRY RUN] OTHER PROFILE SKILL: /$other_skill (would offer removal)"
    elif [ "$FORCE" = true ]; then
      rm -rf "$other_dir"
      echo "REMOVED: /$other_skill (not part of $PROFILE profile)"
    else
      echo ""
      echo "OTHER PROFILE SKILL: /$other_skill is not part of the $PROFILE profile."
      read -r -p "  Remove $other_dir? [y/N] " remove_choice
      case $remove_choice in
        y|Y)
          rm -rf "$other_dir"
          echo "  -> Removed."
          ;;
        *)
          echo "  -> Kept."
          ;;
      esac
    fi
  fi
done

# --- Summary ---

echo ""
echo "=== Installation complete ==="
echo "Profile: $PROFILE"
echo ""
echo "What was installed:"
echo "  CLAUDE.md        -> $CLAUDE_DIR/CLAUDE.md (global, loads every session)"
for skill_dir in "$SCRIPT_DIR/profiles/$PROFILE/skills"/*/; do
  [ -d "$skill_dir" ] || continue
  echo "  /$(basename "$skill_dir") skill  -> $CLAUDE_DIR/skills/$(basename "$skill_dir")/"
done
echo "  Templates        -> $CLAUDE_DIR/templates/"
echo "    project-CLAUDE.md   (copy to new project roots)"
echo "    hooks/pre-commit    (copy to .git/hooks/ in each project)"
echo "      Note: If core.hooksPath is set globally, install the hook there instead of .git/hooks/"
echo "    cursor/rules/       (copy to .cursor/rules/ in each project)"
echo "    cursor/commands/    (copy to .cursor/commands/ in each project)"
echo ""
echo "Claude Code: ready to use globally (no per-project setup needed)."
echo "Cursor:      copy templates into each project:"
echo "  cp -r $CLAUDE_DIR/templates/cursor/rules/ .cursor/rules/"
echo "  cp -r $CLAUDE_DIR/templates/cursor/commands/ .cursor/commands/"
echo ""
echo "Next steps:"
echo "  1. Review $CLAUDE_DIR/CLAUDE.md and customize for your workflow"
echo "  2. Start a Claude Code session: claude"
if [ "$PROFILE" = "dev" ]; then
  echo "  3. Run /playbook to configure for your environment"
  echo "  4. Use /continue at session start, /checkpoint at session end"
else
  echo "  3. Run /investigate <id> new to start an investigation"
  echo "  4. Use /continue at session start to see open investigations"
fi
echo ""
echo "Docs: docs/best-practices.md (practices) and docs/tool-comparison.md (Claude vs Cursor)"
