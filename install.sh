#!/usr/bin/env bash
# install.sh - Install agentic coding practices for Claude Code (macOS/Linux)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_ROOT=""
CLAUDE_DIR=""
WIZARD=false
FORCE=false
DRY_RUN=false
KNOWLEDGE_REPO=""
EXTRAS=false
UNINSTALL=false

usage() {
  cat <<EOF
Usage: install.sh [OPTIONS]

Install agentic coding practices for Claude Code.

Options:
  --root <path>              Install root directory (default: ~/Documents)
                             The research/ dir goes here, projects are siblings
  --wizard                   Interactive wizard to merge with existing configuration
  --force                    Overwrite existing files without prompting
  --dry-run                  Show what would be installed without making changes
  --knowledge-repo <url>     Clone (or pull) a git repo into ~/.claude/knowledge
  --extras                   Install advanced features (fleet index, MCP registry, managed repos)
  --uninstall                Remove files installed by this script
  -h, --help                 Show this help message

Examples:
  ./install.sh                          # Install to ~/.claude/, research to ~/Documents/
  ./install.sh --root ~/projects        # Install to ~/.claude/, research to ~/projects/
  ./install.sh --wizard                 # Interactive merge with existing config
  ./install.sh --force                  # Overwrite everything
  ./install.sh --dry-run                # Preview what would be installed
  ./install.sh --knowledge-repo https://github.com/org/knowledge
  ./install.sh --uninstall              # Remove installed files
EOF
  exit 0
}

# Parse arguments
while [[ "$#" -gt 0 ]]; do
  case $1 in
    --root)
      if [[ "$#" -lt 2 || "$2" == --* ]]; then
        echo "ERROR: --root requires a path"; exit 1
      fi
      INSTALL_ROOT="$2"; shift ;;
    --wizard) WIZARD=true ;;
    --force) FORCE=true ;;
    --dry-run) DRY_RUN=true ;;
    --knowledge-repo)
      if [[ "$#" -lt 2 || "$2" == --* ]]; then
        echo "ERROR: --knowledge-repo requires a URL"; exit 1
      fi
      KNOWLEDGE_REPO="$2"; shift ;;
    --extras) EXTRAS=true ;;
    --uninstall) UNINSTALL=true ;;
    -h|--help) usage ;;
    *) echo "Unknown parameter: $1"; usage ;;
  esac
  shift
done

# Resolve install root
if [ -z "$INSTALL_ROOT" ]; then
  if [ -d "$HOME/Documents" ]; then
    INSTALL_ROOT="$HOME/Documents"
  else
    INSTALL_ROOT="$HOME"
  fi
fi

# Safe tilde expansion (no eval)
case "$INSTALL_ROOT" in
  "~/"*) INSTALL_ROOT="$HOME/${INSTALL_ROOT#\~/}" ;;
  "~")   INSTALL_ROOT="$HOME" ;;
esac
INSTALL_ROOT="$(cd "$INSTALL_ROOT" 2>/dev/null && pwd || echo "$INSTALL_ROOT")"
GLOBAL_CLAUDE_DIR="$HOME/.claude"
CLAUDE_DIR="$GLOBAL_CLAUDE_DIR"
LOCAL_BIN_EARLY="$HOME/.local/bin"

# --- Uninstall ---

do_uninstall() {
  echo "=== Agentic Coding Playbook Uninstaller ==="
  echo "Removing files installed by this script."
  echo ""

  # Hook files: remove if the source file exists in templates/hooks/
  echo "--- Removing Claude session hooks ---"
  for src in "$SCRIPT_DIR/templates/hooks"/*.js; do
    [ -f "$src" ] || continue
    hook_name=$(basename "$src")
    dest="$CLAUDE_DIR/hooks/$hook_name"
    if [ -f "$dest" ]; then
      rm -f "$dest"
      echo "REMOVED: $dest"
    fi
  done

  # Settings.json: strip all hook entries whose command references this repo's hooks dir
  SETTINGS_FILE="$CLAUDE_DIR/settings.json"
  if [ -f "$SETTINGS_FILE" ]; then
    echo ""
    echo "--- Removing hook entries from settings.json ---"
    node -e "
      const fs = require('fs');
      const settingsPath = process.argv[1];
      const hooksDir = process.argv[2];
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      let removed = 0;
      if (settings.hooks) {
        for (const event of Object.keys(settings.hooks)) {
          const before = settings.hooks[event].length;
          settings.hooks[event] = settings.hooks[event].filter(entry => {
            if (!entry.hooks) return true;
            return !entry.hooks.some(h => h.command && h.command.includes(hooksDir));
          });
          removed += before - settings.hooks[event].length;
          if (settings.hooks[event].length === 0) {
            delete settings.hooks[event];
          }
        }
        if (Object.keys(settings.hooks).length === 0) {
          delete settings.hooks;
        }
      }
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
      console.log('UPDATED: settings.json (' + removed + ' hook entries removed)');
    " "$SETTINGS_FILE" "$CLAUDE_DIR/hooks"
  fi

  # Skills: remove skill directories installed from this repo's profiles/combined/skills/
  echo ""
  echo "--- Removing skills ---"
  PROFILE_DIR_UNINSTALL="$SCRIPT_DIR/profiles/combined"
  if [ -d "$PROFILE_DIR_UNINSTALL/skills" ]; then
    for skill_src in "$PROFILE_DIR_UNINSTALL/skills"/*/; do
      [ -d "$skill_src" ] || continue
      skill_name=$(basename "$skill_src")
      skill_dest="$CLAUDE_DIR/skills/$skill_name"
      if [ -d "$skill_dest" ]; then
        rm -rf "$skill_dest"
        echo "REMOVED: $skill_dest"
      fi
    done
  fi

  # Rules: remove rule files installed from this repo's profiles/combined/rules/
  echo ""
  echo "--- Removing rules ---"
  if [ -d "$PROFILE_DIR_UNINSTALL/rules" ]; then
    for rule_file in "$PROFILE_DIR_UNINSTALL/rules"/*.md; do
      [ -f "$rule_file" ] || continue
      rule_name=$(basename "$rule_file")
      rule_dest="$CLAUDE_DIR/rules/$rule_name"
      if [ -f "$rule_dest" ]; then
        rm -f "$rule_dest"
        echo "REMOVED: $rule_dest"
      fi
    done
  fi

  # CLI symlinks: remove only if symlink target is inside SCRIPT_DIR
  echo ""
  echo "--- Removing CLI script symlinks ---"
  for link_name in q qa claude-loop knowledge-consolidate repo-fleet-index; do
    link_path="$LOCAL_BIN_EARLY/$link_name"
    if [ -L "$link_path" ]; then
      target=$(readlink "$link_path")
      if [[ "$target" == "$SCRIPT_DIR"* ]]; then
        rm -f "$link_path"
        echo "REMOVED: $link_path -> $target"
      else
        echo "SKIPPED: $link_path (points to $target, not this repo)"
      fi
    fi
  done

  # Skill helper scripts symlink
  skills_link="$CLAUDE_DIR/scripts/skills"
  if [ -L "$skills_link" ]; then
    target=$(readlink "$skills_link")
    if [[ "$target" == "$SCRIPT_DIR"* ]]; then
      rm -f "$skills_link"
      echo "REMOVED: $skills_link -> $target"
    else
      echo "SKIPPED: $skills_link (points to $target, not this repo)"
    fi
  fi

  echo ""
  echo "=== Uninstall complete ==="
  echo "Not removed: CLAUDE.md, settings.json (structure), ~/.claude/ directory"
  echo "Not removed: MCP server entries from --extras (remove manually if needed)"
}

if [ "$UNINSTALL" = true ]; then
  do_uninstall
  exit 0
fi

PROFILE_DIR="$SCRIPT_DIR/profiles/combined"
if [ ! -d "$PROFILE_DIR" ]; then
  echo "ERROR: Combined profile directory not found at $PROFILE_DIR."
  exit 1
fi

# --- Pre-install validation & auto-install ---

install_sys_package() {
  local pkg="$1"
  if [[ "$(uname -s)" == "Darwin" ]]; then
    if command -v brew &>/dev/null; then
      brew install "$pkg"
    else
      echo "  ERROR: Homebrew not found. Install $pkg manually:"
      echo "    /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
      echo "    brew install $pkg"
      return 1
    fi
  elif [[ "$(uname -s)" == "Linux" ]]; then
    local apt_pkg="$pkg"
    [[ "$pkg" == "node" ]] && apt_pkg="nodejs"
    if command -v apt-get &>/dev/null; then
      echo "  Installing $apt_pkg requires sudo. Proceed? [y/N]"
      read -r consent
      if [[ "$consent" =~ ^[Yy] ]]; then
        sudo apt-get update -qq && sudo apt-get install -y "$apt_pkg"
      else
        echo "  Skipped. Install $apt_pkg manually and re-run."
        return 1
      fi
    elif command -v dnf &>/dev/null; then
      echo "  Installing $apt_pkg requires sudo. Proceed? [y/N]"
      read -r consent
      if [[ "$consent" =~ ^[Yy] ]]; then
        sudo dnf install -y "$apt_pkg"
      else
        echo "  Skipped. Install $apt_pkg manually and re-run."
        return 1
      fi
    elif command -v pacman &>/dev/null; then
      echo "  Installing $apt_pkg requires sudo. Proceed? [y/N]"
      read -r consent
      if [[ "$consent" =~ ^[Yy] ]]; then
        sudo pacman -S --noconfirm "$apt_pkg"
      else
        echo "  Skipped. Install $apt_pkg manually and re-run."
        return 1
      fi
    elif command -v apk &>/dev/null; then
      echo "  Installing $apt_pkg requires sudo. Proceed? [y/N]"
      read -r consent
      if [[ "$consent" =~ ^[Yy] ]]; then
        sudo apk add "$apt_pkg"
      else
        echo "  Skipped. Install $apt_pkg manually and re-run."
        return 1
      fi
    else
      echo "  ERROR: No supported package manager found (need apt-get, dnf, pacman, or apk)."
      return 1
    fi
  else
    echo "  ERROR: Unsupported platform $(uname -s)."
    return 1
  fi
}

install_uv() {
  if ! command -v curl &>/dev/null; then
    echo "  ERROR: curl is required to install uv."
    return 1
  fi
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
}

ensure_command() {
  local cmd="$1"
  if command -v "$cmd" &>/dev/null; then
    return 0
  fi
  echo "'$cmd' not found on PATH. Attempting to install..."
  if [[ "$cmd" == "uv" ]]; then
    install_uv
  else
    install_sys_package "$cmd"
  fi
  if command -v "$cmd" &>/dev/null; then
    echo "  -> $cmd installed successfully."
    return 0
  else
    echo "  -> Failed to install $cmd."
    return 1
  fi
}

missing=0
ensure_command git || missing=1
ensure_command node || missing=1
ensure_command python3 || missing=1

if command -v node &>/dev/null; then
  node_version=$(node --version)  # e.g. "v20.11.0"
  node_major=${node_version%%.*}  # "v20"
  node_major=${node_major#v}      # "20"
  if [ "$node_major" -lt 18 ]; then
    echo "Error: Node.js v18+ required, found ${node_version}"
    missing=1
  fi
fi

if [ "$missing" -eq 1 ]; then
  echo ""
  echo "Required: git, node (v18+), python3 (required by claude-loop and q scripts). Could not auto-install. Install manually and re-run."
  exit 1
fi

echo "=== Agentic Coding Playbook Installer ==="
echo "Root:    $INSTALL_ROOT"
echo "Config:  $CLAUDE_DIR"
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

copy_skill_subdirs() {
  local skill_name="$1"
  local dest_dir="$2"
  for subdir in "$PROFILE_DIR/skills/$skill_name"/*/; do
    [ -d "$subdir" ] || continue
    local subdir_name
    subdir_name=$(basename "$subdir")
    if [ "$DRY_RUN" != true ]; then
      cp -r "$subdir" "$dest_dir/$subdir_name"
    fi
  done
}

install_skill() {
  local skill_name="$1"
  local src="$PROFILE_DIR/skills/$skill_name/SKILL.md"
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
        copy_skill_subdirs "$skill_name" "$dest_dir"
        echo "  -> Overwritten."
        ;;
      b|B)
        cp "$dest" "$dest.backup.$(date +%Y%m%d%H%M%S)" 2>/dev/null || true
        cp "$src" "$dest"
        copy_skill_subdirs "$skill_name" "$dest_dir"
        echo "  -> Backed up and overwritten."
        ;;
      *)
        echo "  -> Skipped."
        ;;
    esac
  else
    mkdir -p "$dest_dir"
    cp "$src" "$dest"
    copy_skill_subdirs "$skill_name" "$dest_dir"
    echo "INSTALLED SKILL: $skill_name"
  fi
}

# --- Wizard: analyze existing configuration ---

if [ "$WIZARD" = true ] && [ -f "$GLOBAL_CLAUDE_DIR/CLAUDE.md" ]; then
  echo "=== Wizard: Analyzing existing configuration ==="
  echo ""
  echo "Found existing CLAUDE.md ($(wc -l < "$GLOBAL_CLAUDE_DIR/CLAUDE.md") lines)."
  echo ""
  echo "Sections detected:"
  grep -E '^## ' "$GLOBAL_CLAUDE_DIR/CLAUDE.md" | sed 's/^/  /' || echo "  (no sections found)"
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
        cp "$GLOBAL_CLAUDE_DIR/CLAUDE.md" "$GLOBAL_CLAUDE_DIR/CLAUDE.md.backup.$(date +%Y%m%d%H%M%S)"
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
    echo "[DRY RUN] Would install: CLAUDE.md -> $GLOBAL_CLAUDE_DIR/CLAUDE.md"
  else
    mkdir -p "$GLOBAL_CLAUDE_DIR"
    cp "$PROFILE_DIR/CLAUDE.md" "$GLOBAL_CLAUDE_DIR/CLAUDE.md"
    echo "INSTALLED: CLAUDE.md -> $GLOBAL_CLAUDE_DIR/CLAUDE.md"
  fi
else
  install_file "$PROFILE_DIR/CLAUDE.md" "$GLOBAL_CLAUDE_DIR/CLAUDE.md" "CLAUDE.md"
fi

echo ""
echo "--- Installing skills ---"
for skill_dir in "$PROFILE_DIR/skills"/*/; do
  [ -d "$skill_dir" ] || continue
  skill_name=$(basename "$skill_dir")
  install_skill "$skill_name"
done

echo ""
echo "--- Installing rules ---"
RULES_SRC="$PROFILE_DIR/rules"
RULES_DEST="$CLAUDE_DIR/rules"
if [ -d "$RULES_SRC" ]; then
  for rule_file in "$RULES_SRC"/*.md; do
    [ -f "$rule_file" ] || continue
    rule_name=$(basename "$rule_file")
    install_file "$rule_file" "$RULES_DEST/$rule_name" "rule: $rule_name"
  done
else
  echo "SKIPPED: rules/ (not found in profile)"
fi

echo ""
echo "--- Installing templates ---"
if [ "$DRY_RUN" != true ]; then
  mkdir -p "$CLAUDE_DIR/templates"
fi

# Project CLAUDE.md template
if [ -f "$SCRIPT_DIR/templates/project-CLAUDE.md" ]; then
  install_file "$SCRIPT_DIR/templates/project-CLAUDE.md" "$CLAUDE_DIR/templates/project-CLAUDE.md" "template: project-CLAUDE.md"
fi

# sanitize.yaml template (copy to INSTALL_ROOT/.claude/ if not already present)
if [ -f "$SCRIPT_DIR/templates/sanitize.yaml" ]; then
  if [ "$DRY_RUN" = true ]; then
    echo "[DRY RUN] Would copy sanitize.yaml template to $INSTALL_ROOT/.claude/sanitize.yaml (if not exists)"
  else
    if [ ! -f "$INSTALL_ROOT/.claude/sanitize.yaml" ]; then
      mkdir -p "$INSTALL_ROOT/.claude"
      cp "$SCRIPT_DIR/templates/sanitize.yaml" "$INSTALL_ROOT/.claude/sanitize.yaml"
      echo "INSTALLED: sanitize.yaml template -> $INSTALL_ROOT/.claude/sanitize.yaml"
    else
      echo "EXISTS: $INSTALL_ROOT/.claude/sanitize.yaml (skipped)"
    fi
  fi
fi

# Create research directory as sibling
echo ""
echo "--- Creating research directory ---"
if [ "$DRY_RUN" = true ]; then
  echo "[DRY RUN] MKDIR: $INSTALL_ROOT/research/"
else
  mkdir -p "$INSTALL_ROOT/research"
  echo "CREATED: $INSTALL_ROOT/research/"
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

# Claude session hooks (SessionStart, SessionEnd -- installed to <root>/.claude/hooks/)
echo ""
echo "--- Installing Claude session hooks ---"
if [ "$DRY_RUN" != true ]; then
  mkdir -p "$CLAUDE_DIR/hooks"
fi

# Shared logging module (installed first; hooks require it)
if [ -f "$SCRIPT_DIR/templates/hooks/log.js" ]; then
  install_file "$SCRIPT_DIR/templates/hooks/log.js" "$CLAUDE_DIR/hooks/log.js" "shared logging module: log.js"
fi

# BM25 search module (installed before knowledge-db which depends on it)
if [ -f "$SCRIPT_DIR/templates/hooks/bm25.js" ]; then
  install_file "$SCRIPT_DIR/templates/hooks/bm25.js" "$CLAUDE_DIR/hooks/bm25.js" "bm25 search module: bm25.js"
fi

# Knowledge database module (installed before hooks that depend on it)
if [ -f "$SCRIPT_DIR/templates/hooks/knowledge-db.js" ]; then
  install_file "$SCRIPT_DIR/templates/hooks/knowledge-db.js" "$CLAUDE_DIR/hooks/knowledge-db.js" "knowledge database module: knowledge-db.js"
fi

# Knowledge capture module (installed before hooks that depend on it)
if [ -f "$SCRIPT_DIR/templates/hooks/knowledge-capture.js" ]; then
  install_file "$SCRIPT_DIR/templates/hooks/knowledge-capture.js" "$CLAUDE_DIR/hooks/knowledge-capture.js" "knowledge capture module: knowledge-capture.js"
fi

for hook_file in "$SCRIPT_DIR/templates/hooks"/session-*.js; do
  [ -f "$hook_file" ] || continue
  hook_name=$(basename "$hook_file")
  install_file "$hook_file" "$CLAUDE_DIR/hooks/$hook_name" "session hook: $hook_name"

  # Register session hooks in settings.json
  # Derive hook event from filename: session-start.js -> SessionStart
  base_name=$(basename "$hook_file" .js)           # session-start
  event_suffix="${base_name#session-}"              # start
  hook_event="Session$(echo "${event_suffix:0:1}" | tr '[:lower:]' '[:upper:]')${event_suffix:1}"  # SessionStart
  SETTINGS_FILE="$CLAUDE_DIR/settings.json"
  HOOK_CMD="node $CLAUDE_DIR/hooks/$hook_name"

  if [ "$DRY_RUN" = true ]; then
    echo "[DRY RUN] Would add $hook_event hook to $SETTINGS_FILE"
  else
    if [ ! -f "$SETTINGS_FILE" ]; then
      echo "{}" > "$SETTINGS_FILE"
    fi

    # Upsert: remove any existing entry for this hook, then add the new one
    node -e "
      const fs = require('fs');
      const path = require('path');
      const settingsPath = path.resolve(process.argv[1]);
      const hookEvent = process.argv[2];
      const hookCmd = process.argv[3];
      const hookFile = process.argv[4];
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (!settings.hooks) settings.hooks = {};
      if (!settings.hooks[hookEvent]) settings.hooks[hookEvent] = [];
      // Remove any existing entry for this hook file
      settings.hooks[hookEvent] = settings.hooks[hookEvent].filter(e =>
        !(e.hooks && e.hooks.some(h => h.command && h.command.includes(hookFile)))
      );
      settings.hooks[hookEvent].push({
        hooks: [{ type: 'command', command: hookCmd, timeout: 10 }]
      });
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    " "$SETTINGS_FILE" "$hook_event" "$HOOK_CMD" "$hook_name"
    echo "CONFIGURED: $hook_name hook in settings.json ($hook_event)"
  fi
done

# Model router hook (PreToolUse -- auto-selects model for Task tool calls)
if [ -f "$SCRIPT_DIR/templates/hooks/model-router.js" ]; then
  install_file "$SCRIPT_DIR/templates/hooks/model-router.js" "$CLAUDE_DIR/hooks/model-router.js" "model router hook: model-router.js"

  # Merge PreToolUse hook entry into settings.json
  echo ""
  echo "--- Configuring model-router in settings.json ---"
  SETTINGS_FILE="$CLAUDE_DIR/settings.json"
  HOOK_CMD="node $CLAUDE_DIR/hooks/model-router.js"
  HOOK_ENTRY="{\"matcher\":\"Task\",\"hooks\":[{\"type\":\"command\",\"command\":\"$HOOK_CMD\"}]}"

  if [ "$DRY_RUN" = true ]; then
    echo "[DRY RUN] Would add PreToolUse hook to $SETTINGS_FILE"
  else
    if [ ! -f "$SETTINGS_FILE" ]; then
      echo "{}" > "$SETTINGS_FILE"
    fi

    # Check if model-router is already configured
    if grep -q "model-router" "$SETTINGS_FILE" 2>/dev/null; then
      echo "ALREADY CONFIGURED: model-router hook in settings.json"
    else
      # Use node (guaranteed available) to merge the hook entry.
      # Pass paths via argv to handle Windows/Unix path differences.
      node -e "
        const fs = require('fs');
        const path = require('path');
        const settingsPath = path.resolve(process.argv[1]);
        const hookCmd = process.argv[2];
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        if (!settings.hooks) settings.hooks = {};
        if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];
        settings.hooks.PreToolUse.push({
          matcher: 'Task',
          hooks: [{ type: 'command', command: hookCmd }]
        });
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
      " "$SETTINGS_FILE" "$HOOK_CMD"
      echo "CONFIGURED: model-router hook in settings.json"
    fi
  fi
fi

# Prompt injection guard hook (PreToolUse -- blocks high-confidence injection patterns in Bash)
if [ -f "$SCRIPT_DIR/templates/hooks/prompt-injection-guard.js" ]; then
  install_file "$SCRIPT_DIR/templates/hooks/prompt-injection-guard.js" "$CLAUDE_DIR/hooks/prompt-injection-guard.js" "prompt injection guard: prompt-injection-guard.js"

  # Merge PreToolUse hook entry into settings.json
  echo ""
  echo "--- Configuring prompt-injection-guard in settings.json ---"
  SETTINGS_FILE="$CLAUDE_DIR/settings.json"
  GUARD_CMD="node $CLAUDE_DIR/hooks/prompt-injection-guard.js"

  if [ "$DRY_RUN" = true ]; then
    echo "[DRY RUN] Would add PreToolUse hook to $SETTINGS_FILE"
  else
    if [ ! -f "$SETTINGS_FILE" ]; then
      echo "{}" > "$SETTINGS_FILE"
    fi

    if grep -q "prompt-injection-guard" "$SETTINGS_FILE" 2>/dev/null; then
      echo "ALREADY CONFIGURED: prompt-injection-guard hook in settings.json"
    else
      node -e "
        const fs = require('fs');
        const path = require('path');
        const settingsPath = path.resolve(process.argv[1]);
        const hookCmd = process.argv[2];
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        if (!settings.hooks) settings.hooks = {};
        if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];
        settings.hooks.PreToolUse.push({
          matcher: 'Bash',
          hooks: [{ type: 'command', command: hookCmd }]
        });
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
      " "$SETTINGS_FILE" "$GUARD_CMD"
      echo "CONFIGURED: prompt-injection-guard hook in settings.json"
    fi
  fi
fi

# PR review guard hook (PreToolUse -- blocks gh pr merge until CodeRabbit has reviewed)
if [ -f "$SCRIPT_DIR/templates/hooks/pr-review-guard.js" ]; then
  install_file "$SCRIPT_DIR/templates/hooks/pr-review-guard.js" "$CLAUDE_DIR/hooks/pr-review-guard.js" "pr review guard: pr-review-guard.js"

  # Merge PreToolUse hook entry into settings.json
  echo ""
  echo "--- Configuring pr-review-guard in settings.json ---"
  SETTINGS_FILE="$CLAUDE_DIR/settings.json"
  PR_GUARD_CMD="node $CLAUDE_DIR/hooks/pr-review-guard.js"

  if [ "$DRY_RUN" = true ]; then
    echo "[DRY RUN] Would add PreToolUse hook to $SETTINGS_FILE"
  else
    if [ ! -f "$SETTINGS_FILE" ]; then
      echo "{}" > "$SETTINGS_FILE"
    fi

    if grep -q "pr-review-guard" "$SETTINGS_FILE" 2>/dev/null; then
      echo "ALREADY CONFIGURED: pr-review-guard hook in settings.json"
    else
      node -e "
        const fs = require('fs');
        const path = require('path');
        const settingsPath = path.resolve(process.argv[1]);
        const hookCmd = process.argv[2];
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        if (!settings.hooks) settings.hooks = {};
        if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];
        settings.hooks.PreToolUse.push({
          matcher: 'Bash',
          hooks: [{ type: 'command', command: hookCmd, timeout: 10 }]
        });
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
      " "$SETTINGS_FILE" "$PR_GUARD_CMD"
      echo "CONFIGURED: pr-review-guard hook in settings.json"
    fi
  fi
fi

# Post-tool verify hook (PostToolUse -- auto-runs tests after Edit/Write on code files)
if [ -f "$SCRIPT_DIR/templates/hooks/post-tool-verify.js" ]; then
  install_file "$SCRIPT_DIR/templates/hooks/post-tool-verify.js" "$CLAUDE_DIR/hooks/post-tool-verify.js" "post-tool verify: post-tool-verify.js"

  # Merge PostToolUse hook entries into settings.json
  echo ""
  echo "--- Configuring post-tool-verify in settings.json ---"
  SETTINGS_FILE="$CLAUDE_DIR/settings.json"
  VERIFY_CMD="node $CLAUDE_DIR/hooks/post-tool-verify.js"

  if [ "$DRY_RUN" = true ]; then
    echo "[DRY RUN] Would add PostToolUse hooks to $SETTINGS_FILE"
  else
    if [ ! -f "$SETTINGS_FILE" ]; then
      echo "{}" > "$SETTINGS_FILE"
    fi

    if grep -q "post-tool-verify" "$SETTINGS_FILE" 2>/dev/null; then
      echo "ALREADY CONFIGURED: post-tool-verify hook in settings.json"
    else
      node -e "
        const fs = require('fs');
        const path = require('path');
        const settingsPath = path.resolve(process.argv[1]);
        const hookCmd = process.argv[2];
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        if (!settings.hooks) settings.hooks = {};
        if (!settings.hooks.PostToolUse) settings.hooks.PostToolUse = [];
        settings.hooks.PostToolUse.push({
          matcher: 'Edit',
          hooks: [{ type: 'command', command: hookCmd }]
        });
        settings.hooks.PostToolUse.push({
          matcher: 'Write',
          hooks: [{ type: 'command', command: hookCmd }]
        });
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
      " "$SETTINGS_FILE" "$VERIFY_CMD"
      echo "CONFIGURED: post-tool-verify hook in settings.json"
    fi
  fi
fi

# MEMORY.md size guard hook (PostToolUse -- enforces line limit on MEMORY.md writes)
if [ -f "$SCRIPT_DIR/templates/hooks/md-size-guard.js" ]; then
  install_file "$SCRIPT_DIR/templates/hooks/md-size-guard.js" "$CLAUDE_DIR/hooks/md-size-guard.js" "md size guard: md-size-guard.js"

  echo ""
  echo "--- Configuring md-size-guard in settings.json ---"
  SETTINGS_FILE="$CLAUDE_DIR/settings.json"
  MDGUARD_CMD="node $CLAUDE_DIR/hooks/md-size-guard.js"

  if [ "$DRY_RUN" = true ]; then
    echo "[DRY RUN] Would add PostToolUse hooks to $SETTINGS_FILE"
  else
    if [ ! -f "$SETTINGS_FILE" ]; then
      echo "{}" > "$SETTINGS_FILE"
    fi

    if grep -q "md-size-guard" "$SETTINGS_FILE" 2>/dev/null; then
      echo "ALREADY CONFIGURED: md-size-guard hook in settings.json"
    else
      node -e "
        const fs = require('fs');
        const path = require('path');
        const settingsPath = path.resolve(process.argv[1]);
        const hookCmd = process.argv[2];
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        if (!settings.hooks) settings.hooks = {};
        if (!settings.hooks.PostToolUse) settings.hooks.PostToolUse = [];
        settings.hooks.PostToolUse.push({
          matcher: 'Edit',
          hooks: [{ type: 'command', command: hookCmd, timeout: 10 }]
        });
        settings.hooks.PostToolUse.push({
          matcher: 'Write',
          hooks: [{ type: 'command', command: hookCmd, timeout: 10 }]
        });
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
      " "$SETTINGS_FILE" "$MDGUARD_CMD"
      echo "CONFIGURED: md-size-guard hook in settings.json"
    fi
  fi
fi

# Context guard hook (dual-mode: PostToolUse all tools + PreToolUse Edit/Write)
if [ -f "$SCRIPT_DIR/templates/hooks/context-guard.js" ]; then
  install_file "$SCRIPT_DIR/templates/hooks/context-guard.js" "$CLAUDE_DIR/hooks/context-guard.js" "context guard: context-guard.js"

  echo ""
  echo "--- Configuring context-guard in settings.json ---"
  SETTINGS_FILE="$CLAUDE_DIR/settings.json"
  CTXGUARD_CMD="node $CLAUDE_DIR/hooks/context-guard.js"

  if [ "$DRY_RUN" = true ]; then
    echo "[DRY RUN] Would add context-guard hooks (PostToolUse + PreToolUse) to $SETTINGS_FILE"
  else
    if [ ! -f "$SETTINGS_FILE" ]; then
      echo "{}" > "$SETTINGS_FILE"
    fi

    # PostToolUse entry: no matcher (fires on ALL tools).
    # Upgrades old matcher-constrained entries to no-matcher.
    node -e "
      const fs = require('fs');
      const path = require('path');
      const settingsPath = path.resolve(process.argv[1]);
      const hookCmd = process.argv[2];
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (!settings.hooks) settings.hooks = {};
      if (!settings.hooks.PostToolUse) settings.hooks.PostToolUse = [];
      // Check if a no-matcher context-guard entry already exists
      const hasNoMatcher = settings.hooks.PostToolUse.some(e =>
        !e.matcher && e.hooks && e.hooks.some(h => h.command && h.command.includes('context-guard'))
      );
      if (!hasNoMatcher) {
        // Remove any old matcher-constrained context-guard entries
        settings.hooks.PostToolUse = settings.hooks.PostToolUse.filter(e =>
          !(e.hooks && e.hooks.some(h => h.command && h.command.includes('context-guard')))
        );
        settings.hooks.PostToolUse.push({
          hooks: [{ type: 'command', command: hookCmd, timeout: 3 }]
        });
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
        console.log('CONFIGURED: context-guard PostToolUse hook (no matcher, all tools)');
      } else {
        console.log('ALREADY CONFIGURED: context-guard PostToolUse hook in settings.json');
      }
    " "$SETTINGS_FILE" "$CTXGUARD_CMD"

    # PreToolUse entry: no matcher. Pure pass-through (returns {}). Kept for future use.
    # Upgrades old Edit|Write-only entries to no-matcher.
    node -e "
      const fs = require('fs');
      const path = require('path');
      const settingsPath = path.resolve(process.argv[1]);
      const hookCmd = process.argv[2];
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (!settings.hooks) settings.hooks = {};
      if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];
      // Check if a no-matcher context-guard entry already exists
      const hasNoMatcher = settings.hooks.PreToolUse.some(e =>
        !e.matcher && e.hooks && e.hooks.some(h => h.command && h.command.includes('context-guard'))
      );
      if (!hasNoMatcher) {
        // Remove any old matcher-constrained context-guard entries
        settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(e =>
          !(e.hooks && e.hooks.some(h => h.command && h.command.includes('context-guard')))
        );
        settings.hooks.PreToolUse.push({
          hooks: [{ type: 'command', command: hookCmd, timeout: 3 }]
        });
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
        console.log('CONFIGURED: context-guard PreToolUse hook (no matcher, all tools)');
      } else {
        console.log('ALREADY CONFIGURED: context-guard PreToolUse hook in settings.json');
      }
    " "$SETTINGS_FILE" "$CTXGUARD_CMD"
  fi
fi

# Checkpoint gate hook (PreToolUse all tools -- blocks tool calls after checkpoint/context-critical)
if [ -f "$SCRIPT_DIR/templates/hooks/checkpoint-gate.js" ]; then
  install_file "$SCRIPT_DIR/templates/hooks/checkpoint-gate.js" "$CLAUDE_DIR/hooks/checkpoint-gate.js" "checkpoint gate: checkpoint-gate.js"

  echo ""
  echo "--- Configuring checkpoint-gate in settings.json ---"
  SETTINGS_FILE="$CLAUDE_DIR/settings.json"
  CKGATE_CMD="node $CLAUDE_DIR/hooks/checkpoint-gate.js"

  if [ "$DRY_RUN" = true ]; then
    echo "[DRY RUN] Would add checkpoint-gate PreToolUse hook to $SETTINGS_FILE"
  else
    if [ ! -f "$SETTINGS_FILE" ]; then
      echo "{}" > "$SETTINGS_FILE"
    fi

    # PreToolUse entry: no matcher (fires on ALL tools).
    node -e "
      const fs = require('fs');
      const path = require('path');
      const settingsPath = path.resolve(process.argv[1]);
      const hookCmd = process.argv[2];
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (!settings.hooks) settings.hooks = {};
      if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];
      // Check if a no-matcher checkpoint-gate entry already exists
      const hasNoMatcher = settings.hooks.PreToolUse.some(e =>
        !e.matcher && e.hooks && e.hooks.some(h => h.command && h.command.includes('checkpoint-gate'))
      );
      if (!hasNoMatcher) {
        // Remove any old matcher-constrained checkpoint-gate entries
        settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(e =>
          !(e.hooks && e.hooks.some(h => h.command && h.command.includes('checkpoint-gate')))
        );
        settings.hooks.PreToolUse.push({
          hooks: [{ type: 'command', command: hookCmd, timeout: 5 }]
        });
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
        console.log('CONFIGURED: checkpoint-gate PreToolUse hook (no matcher, all tools)');
      } else {
        console.log('ALREADY CONFIGURED: checkpoint-gate PreToolUse hook in settings.json');
      }
    " "$SETTINGS_FILE" "$CKGATE_CMD"
  fi
fi

# Sycophancy detector hook (PostToolUse all tools -- detects sycophantic patterns)
if [ -f "$SCRIPT_DIR/templates/hooks/sycophancy-detector.js" ]; then
  install_file "$SCRIPT_DIR/templates/hooks/sycophancy-detector.js" "$CLAUDE_DIR/hooks/sycophancy-detector.js" "sycophancy detector: sycophancy-detector.js"

  echo ""
  echo "--- Configuring sycophancy-detector in settings.json ---"
  SETTINGS_FILE="$CLAUDE_DIR/settings.json"
  SYCO_CMD="node $CLAUDE_DIR/hooks/sycophancy-detector.js"

  if [ "$DRY_RUN" = true ]; then
    echo "[DRY RUN] Would add sycophancy-detector PostToolUse hook to $SETTINGS_FILE"
  else
    if [ ! -f "$SETTINGS_FILE" ]; then
      echo "{}" > "$SETTINGS_FILE"
    fi

    # PostToolUse entry: no matcher (fires on ALL tools).
    node -e "
      const fs = require('fs');
      const path = require('path');
      const settingsPath = path.resolve(process.argv[1]);
      const hookCmd = process.argv[2];
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (!settings.hooks) settings.hooks = {};
      if (!settings.hooks.PostToolUse) settings.hooks.PostToolUse = [];
      // Check if a no-matcher sycophancy-detector entry already exists
      const hasNoMatcher = settings.hooks.PostToolUse.some(e =>
        !e.matcher && e.hooks && e.hooks.some(h => h.command && h.command.includes('sycophancy-detector'))
      );
      if (!hasNoMatcher) {
        // Remove any old matcher-constrained sycophancy-detector entries
        settings.hooks.PostToolUse = settings.hooks.PostToolUse.filter(e =>
          !(e.hooks && e.hooks.some(h => h.command && h.command.includes('sycophancy-detector')))
        );
        settings.hooks.PostToolUse.push({
          hooks: [{ type: 'command', command: hookCmd, timeout: 3 }]
        });
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
        console.log('CONFIGURED: sycophancy-detector PostToolUse hook (no matcher, all tools)');
      } else {
        console.log('ALREADY CONFIGURED: sycophancy-detector PostToolUse hook in settings.json');
      }
    " "$SETTINGS_FILE" "$SYCO_CMD"
  fi
fi

# Multi-image guard hook (PreToolUse Read -- blocks reading multiple images in one session)
if [ -f "$SCRIPT_DIR/templates/hooks/multi-image-guard.js" ]; then
  install_file "$SCRIPT_DIR/templates/hooks/multi-image-guard.js" "$CLAUDE_DIR/hooks/multi-image-guard.js" "multi-image guard: multi-image-guard.js"

  echo ""
  echo "--- Configuring multi-image-guard in settings.json ---"
  SETTINGS_FILE="$CLAUDE_DIR/settings.json"
  MIG_CMD="node $CLAUDE_DIR/hooks/multi-image-guard.js"

  if [ "$DRY_RUN" = true ]; then
    echo "[DRY RUN] Would add multi-image-guard PreToolUse hook to $SETTINGS_FILE"
  else
    if [ ! -f "$SETTINGS_FILE" ]; then
      echo "{}" > "$SETTINGS_FILE"
    fi

    # PreToolUse entry: matcher=Read (only fires on Read tool).
    node -e "
      const fs = require('fs');
      const path = require('path');
      const settingsPath = path.resolve(process.argv[1]);
      const hookCmd = process.argv[2];
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (!settings.hooks) settings.hooks = {};
      if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];
      const exists = settings.hooks.PreToolUse.some(e =>
        e.hooks && e.hooks.some(h => h.command && h.command.includes('multi-image-guard'))
      );
      if (!exists) {
        settings.hooks.PreToolUse.push({
          matcher: 'Read',
          hooks: [{ type: 'command', command: hookCmd, timeout: 3 }]
        });
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
        console.log('CONFIGURED: multi-image-guard PreToolUse hook (matcher: Read)');
      } else {
        console.log('ALREADY CONFIGURED: multi-image-guard PreToolUse hook in settings.json');
      }
    " "$SETTINGS_FILE" "$MIG_CMD"
  fi
fi

# Orphan file guard hook (PreToolUse Write -- blocks creating unreferenced files)
if [ -f "$SCRIPT_DIR/templates/hooks/orphan-file-guard.js" ]; then
  install_file "$SCRIPT_DIR/templates/hooks/orphan-file-guard.js" "$CLAUDE_DIR/hooks/orphan-file-guard.js" "orphan file guard: orphan-file-guard.js"

  echo ""
  echo "--- Configuring orphan-file-guard in settings.json ---"
  SETTINGS_FILE="$CLAUDE_DIR/settings.json"
  OFG_CMD="node $CLAUDE_DIR/hooks/orphan-file-guard.js"

  if [ "$DRY_RUN" = true ]; then
    echo "[DRY RUN] Would add orphan-file-guard PreToolUse hook to $SETTINGS_FILE"
  else
    if [ ! -f "$SETTINGS_FILE" ]; then
      echo "{}" > "$SETTINGS_FILE"
    fi

    # PreToolUse entry: matcher=Write (only fires on Write tool).
    node -e "
      const fs = require('fs');
      const path = require('path');
      const settingsPath = path.resolve(process.argv[1]);
      const hookCmd = process.argv[2];
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (!settings.hooks) settings.hooks = {};
      if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];
      const exists = settings.hooks.PreToolUse.some(e =>
        e.hooks && e.hooks.some(h => h.command && h.command.includes('orphan-file-guard'))
      );
      if (!exists) {
        settings.hooks.PreToolUse.push({
          matcher: 'Write',
          hooks: [{ type: 'command', command: hookCmd, timeout: 8 }]
        });
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
        console.log('CONFIGURED: orphan-file-guard PreToolUse hook (matcher: Write)');
      } else {
        console.log('ALREADY CONFIGURED: orphan-file-guard PreToolUse hook in settings.json');
      }
    " "$SETTINGS_FILE" "$OFG_CMD"
  fi
fi

# MCP server guard hook (PreToolUse all -- warns when project MCP servers are enabled globally)
if [ -f "$SCRIPT_DIR/templates/hooks/mcp-server-guard.js" ]; then
  install_file "$SCRIPT_DIR/templates/hooks/mcp-server-guard.js" "$CLAUDE_DIR/hooks/mcp-server-guard.js" "MCP server guard: mcp-server-guard.js"

  echo ""
  echo "--- Configuring mcp-server-guard in settings.json ---"
  SETTINGS_FILE="$CLAUDE_DIR/settings.json"
  MSG_CMD="node $CLAUDE_DIR/hooks/mcp-server-guard.js"

  if [ "$DRY_RUN" = true ]; then
    echo "[DRY RUN] Would add mcp-server-guard PreToolUse hook to $SETTINGS_FILE"
  else
    if [ ! -f "$SETTINGS_FILE" ]; then
      echo "{}" > "$SETTINGS_FILE"
    fi

    # PreToolUse entry: no matcher (fires once per session on first tool call).
    node -e "
      const fs = require('fs');
      const path = require('path');
      const settingsPath = path.resolve(process.argv[1]);
      const hookCmd = process.argv[2];
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (!settings.hooks) settings.hooks = {};
      if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];
      const exists = settings.hooks.PreToolUse.some(e =>
        e.hooks && e.hooks.some(h => h.command && h.command.includes('mcp-server-guard'))
      );
      if (!exists) {
        settings.hooks.PreToolUse.push({
          hooks: [{ type: 'command', command: hookCmd, timeout: 3 }]
        });
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
        console.log('CONFIGURED: mcp-server-guard PreToolUse hook (no matcher, all tools)');
      } else {
        console.log('ALREADY CONFIGURED: mcp-server-guard PreToolUse hook in settings.json');
      }
    " "$SETTINGS_FILE" "$MSG_CMD"
  fi
fi

# Pre-compact snapshot hook (PreCompact -- saves emergency MEMORY.md snapshot before compaction)
if [ -f "$SCRIPT_DIR/templates/hooks/pre-compact.js" ]; then
  install_file "$SCRIPT_DIR/templates/hooks/pre-compact.js" "$CLAUDE_DIR/hooks/pre-compact.js" "pre-compact hook: pre-compact.js"

  echo ""
  echo "--- Configuring pre-compact in settings.json ---"
  SETTINGS_FILE="$CLAUDE_DIR/settings.json"
  PRECOMPACT_CMD="node $CLAUDE_DIR/hooks/pre-compact.js"

  if [ "$DRY_RUN" = true ]; then
    echo "[DRY RUN] Would add PreCompact hook to $SETTINGS_FILE"
  else
    if [ ! -f "$SETTINGS_FILE" ]; then
      echo "{}" > "$SETTINGS_FILE"
    fi

    if grep -q "pre-compact" "$SETTINGS_FILE" 2>/dev/null; then
      echo "ALREADY CONFIGURED: pre-compact hook in settings.json"
    else
      node -e "
        const fs = require('fs');
        const path = require('path');
        const settingsPath = path.resolve(process.argv[1]);
        const hookCmd = process.argv[2];
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        if (!settings.hooks) settings.hooks = {};
        if (!settings.hooks.PreCompact) settings.hooks.PreCompact = [];
        settings.hooks.PreCompact.push({
          hooks: [{ type: 'command', command: hookCmd }]
        });
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
      " "$SETTINGS_FILE" "$PRECOMPACT_CMD"
      echo "CONFIGURED: pre-compact hook in settings.json"
    fi
  fi
fi

# Post-compact context injection hook (PostCompact -- re-injects memory context after compaction)
if [ -f "$SCRIPT_DIR/templates/hooks/post-compact.js" ]; then
  install_file "$SCRIPT_DIR/templates/hooks/post-compact.js" "$CLAUDE_DIR/hooks/post-compact.js" "post-compact hook: post-compact.js"

  echo ""
  echo "--- Configuring post-compact in settings.json ---"
  SETTINGS_FILE="$CLAUDE_DIR/settings.json"
  POSTCOMPACT_CMD="node $CLAUDE_DIR/hooks/post-compact.js"

  if [ "$DRY_RUN" = true ]; then
    echo "[DRY RUN] Would add PostCompact hook to $SETTINGS_FILE"
  else
    if [ ! -f "$SETTINGS_FILE" ]; then
      echo "{}" > "$SETTINGS_FILE"
    fi

    if grep -q "post-compact" "$SETTINGS_FILE" 2>/dev/null; then
      echo "ALREADY CONFIGURED: post-compact hook in settings.json"
    else
      node -e "
        const fs = require('fs');
        const path = require('path');
        const settingsPath = path.resolve(process.argv[1]);
        const hookCmd = process.argv[2];
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        if (!settings.hooks) settings.hooks = {};
        if (!settings.hooks.PostCompact) settings.hooks.PostCompact = [];
        settings.hooks.PostCompact.push({
          hooks: [{ type: 'command', command: hookCmd, timeout: 5 }]
        });
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
      " "$SETTINGS_FILE" "$POSTCOMPACT_CMD"
      echo "CONFIGURED: post-compact hook in settings.json"
    fi
  fi
fi

# Stuck detector hook (PreToolUse -- blocks/warns when agent repeats the same action in a row)
if [ -f "$SCRIPT_DIR/templates/hooks/stuck-detector.js" ]; then
  install_file "$SCRIPT_DIR/templates/hooks/stuck-detector.js" "$CLAUDE_DIR/hooks/stuck-detector.js" "stuck detector: stuck-detector.js"

  echo ""
  echo "--- Configuring stuck-detector in settings.json ---"
  SETTINGS_FILE="$CLAUDE_DIR/settings.json"
  STUCK_CMD="node $CLAUDE_DIR/hooks/stuck-detector.js"

  if [ "$DRY_RUN" = true ]; then
    echo "[DRY RUN] Would add PreToolUse hook to $SETTINGS_FILE"
  else
    if [ ! -f "$SETTINGS_FILE" ]; then
      echo "{}" > "$SETTINGS_FILE"
    fi

    if grep -q "stuck-detector" "$SETTINGS_FILE" 2>/dev/null; then
      echo "ALREADY CONFIGURED: stuck-detector hook in settings.json"
    else
      node -e "
        const fs = require('fs');
        const path = require('path');
        const settingsPath = path.resolve(process.argv[1]);
        const hookCmd = process.argv[2];
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        if (!settings.hooks) settings.hooks = {};
        if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];
        settings.hooks.PreToolUse.push({
          hooks: [{ type: 'command', command: hookCmd }]
        });
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
      " "$SETTINGS_FILE" "$STUCK_CMD"
      echo "CONFIGURED: stuck-detector hook in settings.json"
    fi
  fi
fi

# Subagent recovery hook (PostToolUse Task -- detects truncated subagent output, writes recovery state)
if [ -f "$SCRIPT_DIR/templates/hooks/subagent-recovery.js" ]; then
  install_file "$SCRIPT_DIR/templates/hooks/subagent-recovery.js" "$CLAUDE_DIR/hooks/subagent-recovery.js" "subagent recovery: subagent-recovery.js"

  echo ""
  echo "--- Configuring subagent-recovery in settings.json ---"
  SETTINGS_FILE="$CLAUDE_DIR/settings.json"
  SUBAGENT_RECOVERY_CMD="node $CLAUDE_DIR/hooks/subagent-recovery.js"

  if [ "$DRY_RUN" = true ]; then
    echo "[DRY RUN] Would add PostToolUse Task hook to $SETTINGS_FILE"
  else
    if [ ! -f "$SETTINGS_FILE" ]; then
      echo "{}" > "$SETTINGS_FILE"
    fi

    if grep -q "subagent-recovery" "$SETTINGS_FILE" 2>/dev/null; then
      echo "ALREADY CONFIGURED: subagent-recovery hook in settings.json"
    else
      node -e "
        const fs = require('fs');
        const path = require('path');
        const settingsPath = path.resolve(process.argv[1]);
        const hookCmd = process.argv[2];
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        if (!settings.hooks) settings.hooks = {};
        if (!settings.hooks.PostToolUse) settings.hooks.PostToolUse = [];
        settings.hooks.PostToolUse.push({
          matcher: 'Task',
          hooks: [{ type: 'command', command: hookCmd, timeout: 5 }]
        });
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
      " "$SETTINGS_FILE" "$SUBAGENT_RECOVERY_CMD"
      echo "CONFIGURED: subagent-recovery hook in settings.json"
    fi
  fi
fi

# Subagent context hook (SubagentStart -- injects project context and loop warnings into spawned subagents)
if [ -f "$SCRIPT_DIR/templates/hooks/subagent-context.js" ]; then
  install_file "$SCRIPT_DIR/templates/hooks/subagent-context.js" "$CLAUDE_DIR/hooks/subagent-context.js" "subagent context: subagent-context.js"

  echo ""
  echo "--- Configuring subagent-context in settings.json ---"
  SETTINGS_FILE="$CLAUDE_DIR/settings.json"
  SUBAGENT_CONTEXT_CMD="node $CLAUDE_DIR/hooks/subagent-context.js"

  if [ "$DRY_RUN" = true ]; then
    echo "[DRY RUN] Would add SubagentStart hook to $SETTINGS_FILE"
  else
    if [ ! -f "$SETTINGS_FILE" ]; then
      echo "{}" > "$SETTINGS_FILE"
    fi

    if grep -q "subagent-context" "$SETTINGS_FILE" 2>/dev/null; then
      echo "ALREADY CONFIGURED: subagent-context hook in settings.json"
    else
      node -e "
        const fs = require('fs');
        const path = require('path');
        const settingsPath = path.resolve(process.argv[1]);
        const hookCmd = process.argv[2];
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        if (!settings.hooks) settings.hooks = {};
        if (!settings.hooks.SubagentStart) settings.hooks.SubagentStart = [];
        settings.hooks.SubagentStart.push({
          hooks: [{ type: 'command', command: hookCmd, timeout: 5 }]
        });
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
      " "$SETTINGS_FILE" "$SUBAGENT_CONTEXT_CMD"
      echo "CONFIGURED: subagent-context hook in settings.json"
    fi
  fi
fi

# Tool failure logger hook (PostToolUseFailure -- logs tool errors to ~/.claude/logs/tool-failures.jsonl)
if [ -f "$SCRIPT_DIR/templates/hooks/tool-failure-logger.js" ]; then
  install_file "$SCRIPT_DIR/templates/hooks/tool-failure-logger.js" "$CLAUDE_DIR/hooks/tool-failure-logger.js" "tool failure logger: tool-failure-logger.js"

  echo ""
  echo "--- Configuring tool-failure-logger in settings.json ---"
  SETTINGS_FILE="$CLAUDE_DIR/settings.json"
  TOOL_FAILURE_CMD="node $CLAUDE_DIR/hooks/tool-failure-logger.js"

  if [ "$DRY_RUN" = true ]; then
    echo "[DRY RUN] Would add PostToolUseFailure hook to $SETTINGS_FILE"
  else
    if [ ! -f "$SETTINGS_FILE" ]; then
      echo "{}" > "$SETTINGS_FILE"
    fi

    if grep -q "tool-failure-logger" "$SETTINGS_FILE" 2>/dev/null; then
      echo "ALREADY CONFIGURED: tool-failure-logger hook in settings.json"
    else
      node -e "
        const fs = require('fs');
        const path = require('path');
        const settingsPath = path.resolve(process.argv[1]);
        const hookCmd = process.argv[2];
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        if (!settings.hooks) settings.hooks = {};
        if (!settings.hooks.PostToolUseFailure) settings.hooks.PostToolUseFailure = [];
        settings.hooks.PostToolUseFailure.push({
          hooks: [{ type: 'command', command: hookCmd, timeout: 5 }]
        });
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
      " "$SETTINGS_FILE" "$TOOL_FAILURE_CMD"
      echo "CONFIGURED: tool-failure-logger hook in settings.json"
    fi
  fi
fi

# PII detector shared module (installed before sanitize-guard which depends on it)
if [ -f "$SCRIPT_DIR/templates/hooks/pii-detector.js" ]; then
  install_file "$SCRIPT_DIR/templates/hooks/pii-detector.js" "$CLAUDE_DIR/hooks/pii-detector.js" "pii detector module: pii-detector.js"
fi

# Sanitize guard hook (dual-mode: PostToolUse all tools + PreToolUse Edit/Write)
if [ -f "$SCRIPT_DIR/templates/hooks/sanitize-guard.js" ]; then
  install_file "$SCRIPT_DIR/templates/hooks/sanitize-guard.js" "$CLAUDE_DIR/hooks/sanitize-guard.js" "sanitize guard: sanitize-guard.js"

  echo ""
  echo "--- Configuring sanitize-guard in settings.json ---"
  SETTINGS_FILE="$CLAUDE_DIR/settings.json"
  SANITIZE_CMD="node $CLAUDE_DIR/hooks/sanitize-guard.js"

  if [ "$DRY_RUN" = true ]; then
    echo "[DRY RUN] Would add sanitize-guard hooks (PostToolUse + PreToolUse) to $SETTINGS_FILE"
  else
    if [ ! -f "$SETTINGS_FILE" ]; then
      echo "{}" > "$SETTINGS_FILE"
    fi

    # PostToolUse entry: no matcher (fires on ALL tools to scan responses)
    if grep -q "sanitize-guard" "$SETTINGS_FILE" 2>/dev/null; then
      echo "ALREADY CONFIGURED: sanitize-guard hook in settings.json"
    else
      node -e "
        const fs = require('fs');
        const path = require('path');
        const settingsPath = path.resolve(process.argv[1]);
        const hookCmd = process.argv[2];
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        if (!settings.hooks) settings.hooks = {};
        if (!settings.hooks.PostToolUse) settings.hooks.PostToolUse = [];
        settings.hooks.PostToolUse.push({
          hooks: [{ type: 'command', command: hookCmd, timeout: 5 }]
        });
        if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];
        settings.hooks.PreToolUse.push({
          matcher: 'Edit|Write',
          hooks: [{ type: 'command', command: hookCmd, timeout: 5 }]
        });
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
      " "$SETTINGS_FILE" "$SANITIZE_CMD"
      echo "CONFIGURED: sanitize-guard hooks in settings.json (PostToolUse + PreToolUse Edit|Write)"
    fi
  fi
fi

# Filesize guard hook (PreToolUse: blocks oversized/binary file reads)
if [ -f "$SCRIPT_DIR/templates/hooks/filesize-guard.js" ]; then
  install_file "$SCRIPT_DIR/templates/hooks/filesize-guard.js" "$CLAUDE_DIR/hooks/filesize-guard.js" "filesize guard: filesize-guard.js"

  echo ""
  echo "--- Configuring filesize-guard in settings.json ---"
  SETTINGS_FILE="$CLAUDE_DIR/settings.json"
  FILESIZE_CMD="node $CLAUDE_DIR/hooks/filesize-guard.js"

  if [ "$DRY_RUN" = true ]; then
    echo "[DRY RUN] Would add filesize-guard hook (PreToolUse Read|Bash) to $SETTINGS_FILE"
  else
    if [ ! -f "$SETTINGS_FILE" ]; then
      echo "{}" > "$SETTINGS_FILE"
    fi

    if grep -q "filesize-guard" "$SETTINGS_FILE" 2>/dev/null; then
      echo "ALREADY CONFIGURED: filesize-guard hook in settings.json"
    else
      node -e "
        const fs = require('fs');
        const path = require('path');
        const settingsPath = path.resolve(process.argv[1]);
        const hookCmd = process.argv[2];
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        if (!settings.hooks) settings.hooks = {};
        if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];
        settings.hooks.PreToolUse.push({
          matcher: 'Read|Bash',
          hooks: [{ type: 'command', command: hookCmd, timeout: 5 }]
        });
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
      " "$SETTINGS_FILE" "$FILESIZE_CMD"
      echo "CONFIGURED: filesize-guard hook in settings.json (PreToolUse Read|Bash)"
    fi
  fi
fi

# Read-once dedup hook (PreToolUse: blocks re-reads of unchanged files)
if [ -f "$SCRIPT_DIR/templates/hooks/read-once-dedup.js" ]; then
  install_file "$SCRIPT_DIR/templates/hooks/read-once-dedup.js" "$CLAUDE_DIR/hooks/read-once-dedup.js" "read-once dedup: read-once-dedup.js"

  echo ""
  echo "--- Configuring read-once-dedup in settings.json ---"
  SETTINGS_FILE="$CLAUDE_DIR/settings.json"
  DEDUP_CMD="node $CLAUDE_DIR/hooks/read-once-dedup.js"

  if [ "$DRY_RUN" = true ]; then
    echo "[DRY RUN] Would add read-once-dedup hook (PreToolUse Read) to $SETTINGS_FILE"
  else
    if [ ! -f "$SETTINGS_FILE" ]; then
      echo "{}" > "$SETTINGS_FILE"
    fi

    if grep -q "read-once-dedup" "$SETTINGS_FILE" 2>/dev/null; then
      echo "ALREADY CONFIGURED: read-once-dedup hook in settings.json"
    else
      node -e "
        const fs = require('fs');
        const path = require('path');
        const settingsPath = path.resolve(process.argv[1]);
        const hookCmd = process.argv[2];
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        if (!settings.hooks) settings.hooks = {};
        if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];
        settings.hooks.PreToolUse.push({
          matcher: 'Read',
          hooks: [{ type: 'command', command: hookCmd, timeout: 5 }]
        });
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
      " "$SETTINGS_FILE" "$DEDUP_CMD"
      echo "CONFIGURED: read-once-dedup hook in settings.json (PreToolUse Read)"
    fi
  fi
fi

# Bloat guard hook (PreToolUse: blocks oversized file writes)
if [ -f "$SCRIPT_DIR/templates/hooks/bloat-guard.js" ]; then
  install_file "$SCRIPT_DIR/templates/hooks/bloat-guard.js" "$CLAUDE_DIR/hooks/bloat-guard.js" "bloat guard: bloat-guard.js"

  echo ""
  echo "--- Configuring bloat-guard in settings.json ---"
  SETTINGS_FILE="$CLAUDE_DIR/settings.json"
  BLOAT_CMD="node $CLAUDE_DIR/hooks/bloat-guard.js"

  if [ "$DRY_RUN" = true ]; then
    echo "[DRY RUN] Would add bloat-guard hook (PreToolUse Write) to $SETTINGS_FILE"
  else
    if [ ! -f "$SETTINGS_FILE" ]; then
      echo "{}" > "$SETTINGS_FILE"
    fi

    if grep -q "bloat-guard" "$SETTINGS_FILE" 2>/dev/null; then
      echo "ALREADY CONFIGURED: bloat-guard hook in settings.json"
    else
      node -e "
        const fs = require('fs');
        const path = require('path');
        const settingsPath = path.resolve(process.argv[1]);
        const hookCmd = process.argv[2];
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        if (!settings.hooks) settings.hooks = {};
        if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];
        settings.hooks.PreToolUse.push({
          matcher: 'Write',
          hooks: [{ type: 'command', command: hookCmd, timeout: 5 }]
        });
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
      " "$SETTINGS_FILE" "$BLOAT_CMD"
      echo "CONFIGURED: bloat-guard hook in settings.json (PreToolUse Write)"
    fi
  fi
fi

# Skill guard hook (PreToolUse: blocks unregistered skills, warns on repeats)
if [ -f "$SCRIPT_DIR/templates/hooks/skill-guard.js" ]; then
  install_file "$SCRIPT_DIR/templates/hooks/skill-guard.js" "$CLAUDE_DIR/hooks/skill-guard.js" "skill guard: skill-guard.js"

  # Merge PreToolUse hook entry into settings.json (matcher: Skill)
  echo ""
  echo "--- Configuring skill-guard in settings.json ---"
  SETTINGS_FILE="$CLAUDE_DIR/settings.json"
  SKILLGUARD_CMD="node $CLAUDE_DIR/hooks/skill-guard.js"

  if [ "$DRY_RUN" = true ]; then
    echo "[DRY RUN] Would add skill-guard hook (PreToolUse Skill) to $SETTINGS_FILE"
  else
    if [ -f "$SETTINGS_FILE" ] && grep -q "skill-guard" "$SETTINGS_FILE" 2>/dev/null; then
      echo "ALREADY CONFIGURED: skill-guard hook in settings.json"
    else
      node -e "
        const fs = require('fs');
        const settingsPath = process.argv[1];
        const hookCmd = process.argv[2];
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        if (!settings.hooks) settings.hooks = {};
        if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];
        settings.hooks.PreToolUse.push({
          matcher: 'Skill',
          hooks: [{ type: 'command', command: hookCmd, timeout: 10 }]
        });
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
      " "$SETTINGS_FILE" "$SKILLGUARD_CMD"
      echo "CONFIGURED: skill-guard hook in settings.json (PreToolUse Skill)"
    fi
  fi
fi

# Task-completed gate hook (TaskCompleted -- quality gate that blocks teammate task completion if tests fail)
if [ -f "$SCRIPT_DIR/templates/hooks/task-completed-gate.js" ]; then
  install_file "$SCRIPT_DIR/templates/hooks/task-completed-gate.js" "$CLAUDE_DIR/hooks/task-completed-gate.js" "task completed gate: task-completed-gate.js"

  # Merge TaskCompleted hook entry into settings.json
  echo ""
  echo "--- Configuring task-completed-gate in settings.json ---"
  SETTINGS_FILE="$CLAUDE_DIR/settings.json"
  TASKGATE_CMD="node $CLAUDE_DIR/hooks/task-completed-gate.js"

  if [ "$DRY_RUN" = true ]; then
    echo "[DRY RUN] Would add task-completed-gate hook (TaskCompleted) to $SETTINGS_FILE"
  else
    if [ -f "$SETTINGS_FILE" ] && grep -q "task-completed-gate" "$SETTINGS_FILE" 2>/dev/null; then
      echo "ALREADY CONFIGURED: task-completed-gate hook in settings.json"
    else
      node -e "
        const fs = require('fs');
        const settingsPath = process.argv[1];
        const hookCmd = process.argv[2];
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        if (!settings.hooks) settings.hooks = {};
        if (!settings.hooks.TaskCompleted) settings.hooks.TaskCompleted = [];
        settings.hooks.TaskCompleted.push({
          hooks: [{ type: 'command', command: hookCmd, timeout: 35 }]
        });
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
      " "$SETTINGS_FILE" "$TASKGATE_CMD"
      echo "CONFIGURED: task-completed-gate hook in settings.json (TaskCompleted)"
    fi
  fi
fi

# Teammate idle nudge hook (TeammateIdle -- nudges idle teammates to check TaskList)
if [ -f "$SCRIPT_DIR/templates/hooks/teammate-idle.js" ]; then
  install_file "$SCRIPT_DIR/templates/hooks/teammate-idle.js" "$CLAUDE_DIR/hooks/teammate-idle.js" "teammate idle hook: teammate-idle.js"

  echo ""
  echo "--- Configuring teammate-idle in settings.json ---"
  SETTINGS_FILE="$CLAUDE_DIR/settings.json"
  TEAMIDLE_CMD="node $CLAUDE_DIR/hooks/teammate-idle.js"

  if [ "$DRY_RUN" = true ]; then
    echo "[DRY RUN] Would add TeammateIdle hook to $SETTINGS_FILE"
  else
    if [ -f "$SETTINGS_FILE" ] && grep -q "teammate-idle" "$SETTINGS_FILE" 2>/dev/null; then
      echo "ALREADY CONFIGURED: teammate-idle hook in settings.json"
    else
      node -e "
        const fs = require('fs');
        const settingsPath = process.argv[1];
        const hookCmd = process.argv[2];
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        if (!settings.hooks) settings.hooks = {};
        if (!settings.hooks.TeammateIdle) settings.hooks.TeammateIdle = [];
        settings.hooks.TeammateIdle.push({
          hooks: [{ type: 'command', command: hookCmd, timeout: 3 }]
        });
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
      " "$SETTINGS_FILE" "$TEAMIDLE_CMD"
      echo "CONFIGURED: teammate-idle hook in settings.json (TeammateIdle)"
    fi
  fi
fi

# --- Install CLI scripts (q, qa, claude-loop) ---

echo ""
echo "--- Installing CLI scripts ---"

LOCAL_BIN="$HOME/.local/bin"
if [ "$DRY_RUN" != true ]; then
  mkdir -p "$LOCAL_BIN"
fi

# q -- quick single-turn query script
if [ -f "$SCRIPT_DIR/scripts/q" ]; then
  if [ "$DRY_RUN" = true ]; then
    echo "[DRY RUN] SYMLINK: scripts/q -> $LOCAL_BIN/q"
  else
    ln -sf "$SCRIPT_DIR/scripts/q" "$LOCAL_BIN/q"
    chmod +x "$SCRIPT_DIR/scripts/q"
    echo "INSTALLED: scripts/q -> $LOCAL_BIN/q"
  fi
else
  echo "SKIPPED: scripts/q (not found)"
fi

# qa -- agentic query loop script
if [ -f "$SCRIPT_DIR/scripts/qa" ]; then
  if [ "$DRY_RUN" = true ]; then
    echo "[DRY RUN] SYMLINK: scripts/qa -> $LOCAL_BIN/qa"
  else
    ln -sf "$SCRIPT_DIR/scripts/qa" "$LOCAL_BIN/qa"
    chmod +x "$SCRIPT_DIR/scripts/qa"
    echo "INSTALLED: scripts/qa -> $LOCAL_BIN/qa"
  fi
else
  echo "SKIPPED: scripts/qa (not found)"
fi

# claude-loop -- session supervisor with sentinel and task queue
if [ -f "$SCRIPT_DIR/scripts/claude-loop.sh" ]; then
  if [ "$DRY_RUN" = true ]; then
    echo "[DRY RUN] SYMLINK: scripts/claude-loop.sh -> $LOCAL_BIN/claude-loop"
  else
    ln -sf "$SCRIPT_DIR/scripts/claude-loop.sh" "$LOCAL_BIN/claude-loop"
    chmod +x "$SCRIPT_DIR/scripts/claude-loop.sh"
    echo "INSTALLED: scripts/claude-loop.sh -> $LOCAL_BIN/claude-loop"
  fi
else
  echo "SKIPPED: scripts/claude-loop.sh (not found)"
fi

# knowledge-consolidate -- LLM-powered knowledge deduplication
if [ -f "$SCRIPT_DIR/scripts/knowledge-consolidate.sh" ]; then
  if [ "$DRY_RUN" = true ]; then
    echo "[DRY RUN] SYMLINK: scripts/knowledge-consolidate.sh -> $LOCAL_BIN/knowledge-consolidate"
  else
    ln -sf "$SCRIPT_DIR/scripts/knowledge-consolidate.sh" "$LOCAL_BIN/knowledge-consolidate"
    chmod +x "$SCRIPT_DIR/scripts/knowledge-consolidate.sh"
    echo "INSTALLED: scripts/knowledge-consolidate.sh -> $LOCAL_BIN/knowledge-consolidate"
  fi
else
  echo "SKIPPED: scripts/knowledge-consolidate.sh (not found)"
fi

# Skill helper scripts (used by SKILL.md files)
echo ""
echo "--- Installing skill helper scripts ---"
SKILLS_SCRIPTS_DIR="$SCRIPT_DIR/scripts/skills"
DEST_SKILLS_DIR="$CLAUDE_DIR/scripts/skills"
if [ -d "$SKILLS_SCRIPTS_DIR" ]; then
  if [ "$DRY_RUN" = true ]; then
    echo "[DRY RUN] SYMLINK: scripts/skills/ -> $DEST_SKILLS_DIR/"
  else
    mkdir -p "$CLAUDE_DIR/scripts"
    # Remove existing symlink or directory to avoid nesting
    rm -rf "$DEST_SKILLS_DIR"
    ln -sf "$SKILLS_SCRIPTS_DIR" "$DEST_SKILLS_DIR"
    echo "INSTALLED: scripts/skills/ -> $DEST_SKILLS_DIR/"
  fi
else
  echo "SKIPPED: scripts/skills/ (not found)"
fi

# Warn if ~/.local/bin is not on PATH
if [[ ":$PATH:" != *":$LOCAL_BIN:"* ]]; then
  echo ""
  echo "WARNING: $LOCAL_BIN is not in your PATH."
  echo "  Add the following to your shell profile (~/.bashrc, ~/.zshrc, etc.):"
  echo "    export PATH=\"\$HOME/.local/bin:\$PATH\""
fi

# --- Extras: fleet index, MCP registry, managed repos (--extras only) ---

if [[ "$EXTRAS" == true ]]; then

echo ""
echo "--- Installing fleet index ---"

# Create fleet directory scaffolding
if [ "$DRY_RUN" = true ]; then
  echo "[DRY RUN] MKDIR: $GLOBAL_CLAUDE_DIR/repos/"
  echo "[DRY RUN] MKDIR: $GLOBAL_CLAUDE_DIR/fleet/manifests/"
else
  mkdir -p "$GLOBAL_CLAUDE_DIR/repos"
  mkdir -p "$GLOBAL_CLAUDE_DIR/fleet/manifests"
  echo "CREATED: $GLOBAL_CLAUDE_DIR/repos/"
  echo "CREATED: $GLOBAL_CLAUDE_DIR/fleet/manifests/"
fi

# Fleet indexer engine
if [ -f "$SCRIPT_DIR/templates/fleet/fleet-index.js" ]; then
  if [ "$DRY_RUN" != true ]; then
    mkdir -p "$CLAUDE_DIR/fleet"
  fi
  install_file "$SCRIPT_DIR/templates/fleet/fleet-index.js" "$CLAUDE_DIR/fleet/fleet-index.js" "fleet indexer: fleet-index.js"
fi

# Fleet MCP server
if [ -f "$SCRIPT_DIR/templates/mcp/fleet-index-server.js" ]; then
  if [ "$DRY_RUN" != true ]; then
    mkdir -p "$CLAUDE_DIR/mcp"
  fi
  install_file "$SCRIPT_DIR/templates/mcp/fleet-index-server.js" "$CLAUDE_DIR/mcp/fleet-index-server.js" "fleet MCP server: fleet-index-server.js"
fi

# repo-fleet-index CLI script
if [ -f "$SCRIPT_DIR/scripts/repo-fleet-index.sh" ]; then
  if [ "$DRY_RUN" = true ]; then
    echo "[DRY RUN] SYMLINK: scripts/repo-fleet-index.sh -> $LOCAL_BIN/repo-fleet-index"
  else
    ln -sf "$SCRIPT_DIR/scripts/repo-fleet-index.sh" "$LOCAL_BIN/repo-fleet-index"
    chmod +x "$SCRIPT_DIR/scripts/repo-fleet-index.sh"
    echo "INSTALLED: scripts/repo-fleet-index.sh -> $LOCAL_BIN/repo-fleet-index"
  fi
else
  echo "SKIPPED: scripts/repo-fleet-index.sh (not found)"
fi

# --- MCP Server Registry ---

echo ""
echo "--- Configuring MCP server registry ---"

REGISTRY_FILE="$SCRIPT_DIR/templates/registry/mcp-servers.json"
SETTINGS_FILE="$CLAUDE_DIR/settings.json"

if [ ! -f "$REGISTRY_FILE" ]; then
  echo "SKIPPED: MCP server registry (file not found)"
else
  if [ "$DRY_RUN" = true ]; then
    echo "[DRY RUN] Would register MCP servers from registry"
  else
    if [ ! -f "$SETTINGS_FILE" ]; then
      echo "{}" > "$SETTINGS_FILE"
    fi
    node -e "
      const fs = require('fs');
      const registry = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
      const settingsPath = process.argv[2];
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (!settings.mcpServers) settings.mcpServers = {};
      let added = 0, skipped = 0;
      for (const [name, entry] of Object.entries(registry)) {
        if (settings.mcpServers[name]) {
          skipped++;
          continue;
        }
        settings.mcpServers[name] = entry.config;
        added++;
      }
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
      console.log('CONFIGURED: ' + added + ' MCP servers added, ' + skipped + ' already configured');
    " "$REGISTRY_FILE" "$SETTINGS_FILE"
  fi
fi

# --- Managed Repos ---

echo ""
echo "--- Managed repos ---"

RESOURCES_FILE="$CLAUDE_DIR/resources.json"
REPOS_DIR="$CLAUDE_DIR/repos"

install_repo_cron() {
  local repos_dir="$1"
  local cron_cmd="0 6 * * * find \"$repos_dir\" -maxdepth 1 -mindepth 1 -type d -exec git -C '{}' pull --ff-only \;"
  if ! command -v crontab &>/dev/null; then
    echo "  NOTE: crontab not available — skip daily pull cron"
    return
  fi
  if crontab -l 2>/dev/null | grep -qF "$repos_dir"; then
    echo "ALREADY CONFIGURED: daily pull cron for $repos_dir"
  else
    ( crontab -l 2>/dev/null; echo "$cron_cmd" ) | crontab -
    echo "CONFIGURED: daily pull cron (06:00) for $repos_dir"
  fi
}

if [ ! -f "$RESOURCES_FILE" ]; then
  echo "SKIPPED: No resources.json found (copy templates/registry/resources.example.json to $RESOURCES_FILE)"
else
  if [ "$DRY_RUN" = true ]; then
    echo "[DRY RUN] Would clone repos listed in $RESOURCES_FILE"
  else
    if ! command -v gh &>/dev/null; then
      echo "SKIPPED: Managed repos require GitHub CLI (gh). Install from https://cli.github.com/ and run 'gh auth login'"
    else
    node -e "
      const repos = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).repos || [];
      repos.forEach(r => console.log(r));
    " "$RESOURCES_FILE" | while IFS= read -r repo; do
      dir_name=$(echo "$repo" | tr '/' '_')
      target="$REPOS_DIR/$dir_name"
      if [ -d "$target/.git" ]; then
        echo "ALREADY CLONED: $repo"
      else
        mkdir -p "$REPOS_DIR"
        echo "Cloning $repo..."
        gh repo clone "$repo" "$target" -- --depth=1 2>/dev/null || \
          echo "  FAILED: could not clone $repo (check gh auth and repo access)"
      fi
    done

    install_repo_cron "$REPOS_DIR"

    # Run fleet index refresh after repo pull
    if [ -f "$LOCAL_BIN/repo-fleet-index" ]; then
      fleet_cron="5 6 * * * $LOCAL_BIN/repo-fleet-index --refresh --repos-dir $REPOS_DIR 2>/dev/null"
      if ! crontab -l 2>/dev/null | grep -qF "repo-fleet-index"; then
        ( crontab -l 2>/dev/null; echo "$fleet_cron" ) | crontab -
        echo "CONFIGURED: fleet index refresh cron (06:05) after repo pull"
      else
        echo "ALREADY CONFIGURED: fleet index refresh cron"
      fi
    fi
    fi
  fi

  # Register doc endpoints as MCP servers
  if [ "$DRY_RUN" = true ]; then
    echo "[DRY RUN] Would register doc endpoints from $RESOURCES_FILE"
  else
    node -e "
      const fs = require('fs');
      const res = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
      const docs = res.docs || [];
      if (docs.length === 0) { process.exit(0); }
      const settingsPath = process.argv[2];
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (!settings.mcpServers) settings.mcpServers = {};
      let added = 0, skipped = 0;
      for (const doc of docs) {
        if (!doc.name || !doc.url) continue;
        if (settings.mcpServers[doc.name]) { skipped++; continue; }
        settings.mcpServers[doc.name] = { type: 'http', url: doc.url, disabled: false };
        added++;
      }
      if (added > 0) {
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
      }
      console.log('CONFIGURED: ' + added + ' doc endpoints added, ' + skipped + ' already configured');
    " "$RESOURCES_FILE" "$SETTINGS_FILE"
  fi
fi

fi  # end --extras

# Knowledge base templates
if [ -d "$SCRIPT_DIR/templates/knowledge" ]; then
  echo ""
  echo "--- Installing knowledge base templates ---"
  if [ "$DRY_RUN" != true ]; then
    mkdir -p "$CLAUDE_DIR/templates/knowledge"
  fi
  for kb_file in "$SCRIPT_DIR/templates/knowledge"/*; do
    [ -f "$kb_file" ] || continue
    kb_name=$(basename "$kb_file")
    install_file "$kb_file" "$CLAUDE_DIR/templates/knowledge/$kb_name" "knowledge template: $kb_name"
  done
fi

# Investigation templates and infrastructure
echo ""
echo "--- Installing investigation templates ---"
if [ "$DRY_RUN" != true ]; then
  mkdir -p "$CLAUDE_DIR/templates/investigation/hooks"
  mkdir -p "$CLAUDE_DIR/investigations/_patterns"
fi

if [ -d "$SCRIPT_DIR/templates/investigation" ]; then
  for inv_file in "$SCRIPT_DIR/templates/investigation"/*; do
    [ -f "$inv_file" ] || continue
    inv_name=$(basename "$inv_file")
    install_file "$inv_file" "$CLAUDE_DIR/templates/investigation/$inv_name" "investigation template: $inv_name"
  done
  for inv_file in "$SCRIPT_DIR/templates/investigation/hooks"/*; do
    [ -f "$inv_file" ] || continue
    inv_name=$(basename "$inv_file")
    install_file "$inv_file" "$CLAUDE_DIR/templates/investigation/hooks/$inv_name" "investigation hook: $inv_name"
    if [ "$DRY_RUN" != true ] && [ -f "$CLAUDE_DIR/templates/investigation/hooks/$inv_name" ]; then
      chmod +x "$CLAUDE_DIR/templates/investigation/hooks/$inv_name"
    fi
  done
fi

if [ "$DRY_RUN" = true ]; then
  echo "[DRY RUN] MKDIR: $CLAUDE_DIR/investigations/_patterns/"
else
  echo "CREATED: $CLAUDE_DIR/investigations/_patterns/"
fi

# sanitize.sh script (used by /investigate close for PHI sanitization)
if [ -f "$SCRIPT_DIR/scripts/sanitize.sh" ]; then
  if [ "$DRY_RUN" != true ]; then
    mkdir -p "$CLAUDE_DIR/scripts"
  fi
  install_file "$SCRIPT_DIR/scripts/sanitize.sh" "$CLAUDE_DIR/scripts/sanitize.sh" "sanitize script: sanitize.sh"
  if [ "$DRY_RUN" != true ] && [ -f "$CLAUDE_DIR/scripts/sanitize.sh" ]; then
    chmod +x "$CLAUDE_DIR/scripts/sanitize.sh"
  fi
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
    git clone --depth=1 "$KNOWLEDGE_REPO" "$KNOWLEDGE_DIR"
    echo "INSTALLED: knowledge repo -> $KNOWLEDGE_DIR"
  fi
  # Ensure entries directory exists
  if [ "$DRY_RUN" != true ]; then
    mkdir -p "$KNOWLEDGE_DIR/entries"
  fi
fi

# --- Summary ---

echo ""
echo "=== Installation complete ==="
echo "Install root: $INSTALL_ROOT"
echo ""
echo "What was installed:"
echo "  CLAUDE.md        -> $GLOBAL_CLAUDE_DIR/CLAUDE.md (global, loads for all sessions)"
for skill_dir in "$PROFILE_DIR/skills"/*/; do
  [ -d "$skill_dir" ] || continue
  echo "  /$(basename "$skill_dir") skill  -> $CLAUDE_DIR/skills/$(basename "$skill_dir")/"
done
echo "  CLI scripts      -> $LOCAL_BIN/ (q, qa, claude-loop, knowledge-consolidate)"
echo "  Session hooks    -> $CLAUDE_DIR/hooks/ (auto-run on session start/end)"
echo "  Rules            -> $CLAUDE_DIR/rules/ (path-specific coding conventions)"
echo "  Templates        -> $CLAUDE_DIR/templates/"
if [[ "$EXTRAS" == true ]]; then
  REGISTRY_FILE="$SCRIPT_DIR/templates/registry/mcp-servers.json"
  SERVER_COUNT=$(node -e "const r=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log(Object.keys(r).length)" "$REGISTRY_FILE" 2>/dev/null || echo "?")
  echo "  MCP registry     -> settings.json mcpServers ($SERVER_COUNT servers)"
  echo "  Managed repos    -> ~/.claude/repos/ (from resources.json, if present)"
  echo "  Fleet index      -> $CLAUDE_DIR/fleet/ (repo manifests and digest)"
  echo "  Fleet MCP        -> $CLAUDE_DIR/mcp/ (fleet-index MCP server)"
fi
echo "    project-CLAUDE.md   (copy to new project roots)"
echo "    hooks/pre-commit    (copy to .git/hooks/ in each project)"
echo "      Note: If core.hooksPath is set globally, install the hook there instead of .git/hooks/"
echo "    knowledge/          (entry format, CI, pre-commit for knowledge repos)"
echo ""
echo "Directory structure:"
echo "  ~/.claude/               <- playbook config (skills, hooks, templates)"
echo "  $INSTALL_ROOT/"
echo "    research/              <- investigations and research"
echo "    <your-projects>/       <- dev projects"
echo ""
echo "Next steps:"
echo "  1. Review $GLOBAL_CLAUDE_DIR/CLAUDE.md and customize for your workflow"
echo "  2. cd $INSTALL_ROOT && claude     # start a session"
echo "  3. Run /playbook to configure for your environment"
echo "  4. Use /checkpoint at natural session breakpoints to save state"
echo "  5. Use /create-project <name> to scaffold new projects"
echo "  6. Use /investigate <id> new to start research investigations"
echo ""
echo "Docs: docs/best-practices.md"
