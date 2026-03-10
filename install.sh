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

usage() {
  cat <<EOF
Usage: install.sh [OPTIONS]

Install agentic coding practices for Claude Code.

Options:
  --root <path>              Install root directory (default: ~/Documents)
                             The .claude/ config goes here, projects are siblings
  --wizard                   Interactive wizard to merge with existing configuration
  --force                    Overwrite existing files without prompting
  --dry-run                  Show what would be installed without making changes
  --knowledge-repo <url>     Clone (or pull) a git repo into <root>/.claude/knowledge
  -h, --help                 Show this help message

Examples:
  ./install.sh                          # Install to ~/Documents/.claude/
  ./install.sh --root ~/projects        # Install to ~/projects/.claude/
  ./install.sh --wizard                 # Interactive merge with existing config
  ./install.sh --force                  # Overwrite everything
  ./install.sh --dry-run                # Preview what would be installed
  ./install.sh --knowledge-repo https://github.com/org/knowledge
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

# Expand ~ and resolve to absolute path
INSTALL_ROOT="$(eval echo "$INSTALL_ROOT")"
INSTALL_ROOT="$(cd "$INSTALL_ROOT" 2>/dev/null && pwd || echo "$INSTALL_ROOT")"
CLAUDE_DIR="$INSTALL_ROOT/.claude"

PROFILE_DIR="$SCRIPT_DIR/profiles/combined"
if [ ! -d "$PROFILE_DIR" ]; then
  echo "ERROR: Combined profile directory not found at $PROFILE_DIR."
  exit 1
fi

# --- Pre-install validation ---

check_command() {
  if ! command -v "$1" &>/dev/null; then
    echo "ERROR: '$1' is required but not found on PATH."
    echo "  Install with: $2"
    return 1
  fi
}

missing=0
check_command git "sudo apt install git  (Linux) / brew install git (macOS)" || missing=1
check_command node "sudo apt install nodejs  (Linux) / brew install node (macOS)" || missing=1

if [ "$missing" -eq 1 ]; then
  echo ""
  echo "Required: git, node (v18+). Install the missing tools and re-run."
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
    mkdir -p "$CLAUDE_DIR"
    cp "$PROFILE_DIR/CLAUDE.md" "$CLAUDE_DIR/CLAUDE.md"
    echo "INSTALLED: CLAUDE.md"
  fi
else
  install_file "$PROFILE_DIR/CLAUDE.md" "$CLAUDE_DIR/CLAUDE.md" "CLAUDE.md"
fi

echo ""
echo "--- Installing skills ---"
for skill_dir in "$PROFILE_DIR/skills"/*/; do
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

# Investigation templates
if [ -d "$SCRIPT_DIR/profiles/research/templates" ]; then
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
    echo "[DRY RUN] MKDIR: $CLAUDE_DIR/../research/ and $INSTALL_ROOT/.claude/investigations/_patterns/"
  else
    mkdir -p "$CLAUDE_DIR/investigations/_patterns"
    echo "CREATED: $CLAUDE_DIR/investigations/_patterns/"
  fi

  # Install investigation scripts
  echo ""
  echo "--- Installing investigation scripts ---"
  if [ -f "$SCRIPT_DIR/profiles/research/scripts/sanitize.sh" ]; then
    if [ "$DRY_RUN" = true ]; then
      echo "[DRY RUN] INSTALL: sanitize.sh -> $CLAUDE_DIR/scripts/sanitize.sh"
    else
      mkdir -p "$CLAUDE_DIR/scripts"
      cp "$SCRIPT_DIR/profiles/research/scripts/sanitize.sh" "$CLAUDE_DIR/scripts/sanitize.sh"
      chmod +x "$CLAUDE_DIR/scripts/sanitize.sh"
      echo "INSTALLED: sanitize.sh -> $CLAUDE_DIR/scripts/sanitize.sh"
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
for hook_file in "$SCRIPT_DIR/templates/hooks"/session-*.js; do
  [ -f "$hook_file" ] || continue
  hook_name=$(basename "$hook_file")
  install_file "$hook_file" "$CLAUDE_DIR/hooks/$hook_name" "session hook: $hook_name"
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

# Context guard hook (PostToolUse -- tracks cumulative context size, blocks at 70%)
if [ -f "$SCRIPT_DIR/templates/hooks/context-guard.js" ]; then
  install_file "$SCRIPT_DIR/templates/hooks/context-guard.js" "$CLAUDE_DIR/hooks/context-guard.js" "context guard: context-guard.js"

  echo ""
  echo "--- Configuring context-guard in settings.json ---"
  SETTINGS_FILE="$CLAUDE_DIR/settings.json"
  CTXGUARD_CMD="node $CLAUDE_DIR/hooks/context-guard.js"

  if [ "$DRY_RUN" = true ]; then
    echo "[DRY RUN] Would add PostToolUse hook to $SETTINGS_FILE"
  else
    if [ ! -f "$SETTINGS_FILE" ]; then
      echo "{}" > "$SETTINGS_FILE"
    fi

    if grep -q "context-guard" "$SETTINGS_FILE" 2>/dev/null; then
      echo "ALREADY CONFIGURED: context-guard hook in settings.json"
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
          hooks: [{ type: 'command', command: hookCmd }]
        });
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
      " "$SETTINGS_FILE" "$CTXGUARD_CMD"
      echo "CONFIGURED: context-guard hook in settings.json"
    fi
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

# --- Summary ---

echo ""
echo "=== Installation complete ==="
echo "Install root: $INSTALL_ROOT"
echo ""
echo "What was installed:"
echo "  CLAUDE.md        -> $CLAUDE_DIR/CLAUDE.md (loads for all sessions under $INSTALL_ROOT)"
for skill_dir in "$PROFILE_DIR/skills"/*/; do
  [ -d "$skill_dir" ] || continue
  echo "  /$(basename "$skill_dir") skill  -> $CLAUDE_DIR/skills/$(basename "$skill_dir")/"
done
echo "  Session hooks    -> $CLAUDE_DIR/hooks/ (auto-run on session start/end)"
echo "  Templates        -> $CLAUDE_DIR/templates/"
echo "    project-CLAUDE.md   (copy to new project roots)"
echo "    hooks/pre-commit    (copy to .git/hooks/ in each project)"
echo "      Note: If core.hooksPath is set globally, install the hook there instead of .git/hooks/"
echo "    knowledge/          (entry format, CI, pre-commit for knowledge repos)"
echo ""
echo "Directory structure:"
echo "  $INSTALL_ROOT/"
echo "    .claude/             <- playbook config (CLAUDE.md, skills, hooks, templates)"
echo "    research/            <- investigations and research"
echo "    <your-projects>/     <- dev projects (siblings to .claude/)"
echo ""
echo "Next steps:"
echo "  1. Review $CLAUDE_DIR/CLAUDE.md and customize for your workflow"
echo "  2. cd $INSTALL_ROOT && claude     # start a session"
echo "  3. Run /playbook to configure for your environment"
echo "  4. Use /continue at session start, /checkpoint at session end"
echo "  5. Use /create-project <name> to scaffold new projects"
echo "  6. Use /investigate <id> new to start research investigations"
echo ""
echo "Docs: docs/best-practices.md"
