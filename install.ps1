# install.ps1 - Install agentic coding practices for Claude Code (Windows)
param(
    [ValidateSet("dev", "research")]
    [string]$Profile = "dev",
    [switch]$Wizard,
    [switch]$Force,
    [switch]$AutoExit,
    [switch]$DryRun,
    [switch]$Help
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ClaudeDir = Join-Path $env:USERPROFILE ".claude"

if ($Help) {
    Write-Host @"
Usage: .\install.ps1 [OPTIONS]

Install agentic coding practices for Claude Code.

Options:
  -Profile <name>    Installation profile: dev (default), research
  -Wizard            Interactive wizard to merge with existing configuration
  -Force             Overwrite existing files without prompting
  -AutoExit          Enable auto-exit after /checkpoint completes
  -DryRun            Show what would be installed without making changes
  -Help              Show this help message

Examples:
  .\install.ps1                              # Install dev profile
  .\install.ps1 -Wizard                      # Interactive merge with existing config
  .\install.ps1 -Force -AutoExit             # Overwrite everything, enable auto-exit
  .\install.ps1 -DryRun                      # Preview what would be installed
"@
    exit 0
}

# Validate profile
$ProfileDir = Join-Path $ScriptDir "profiles\$Profile"
if (-not (Test-Path $ProfileDir)) {
    Write-Error "Profile '$Profile' not found. Available: $(Get-ChildItem (Join-Path $ScriptDir 'profiles') -Directory | ForEach-Object { $_.Name })"
    exit 1
}

Write-Host "=== Agentic Coding Playbook Installer ===" -ForegroundColor Cyan
Write-Host "Profile: $Profile"
Write-Host "Target:  $ClaudeDir"
Write-Host ""

function Install-ConfigFile {
    param([string]$Source, [string]$Destination, [string]$Label)

    if ($DryRun) {
        if (Test-Path $Destination) {
            Write-Host "[DRY RUN] CONFLICT: $Label -> $Destination (exists)" -ForegroundColor Yellow
        } else {
            Write-Host "[DRY RUN] INSTALL:  $Label -> $Destination" -ForegroundColor Green
        }
        return
    }

    if ((Test-Path $Destination) -and -not $Force) {
        Write-Host "EXISTS: $Destination" -ForegroundColor Yellow
        $choice = Read-Host "  [s]kip, [o]verwrite, [b]ackup+overwrite?"
        switch ($choice.ToLower()) {
            "o" {
                Copy-Item $Source $Destination -Force
                Write-Host "  -> Overwritten." -ForegroundColor Green
            }
            "b" {
                $backup = "$Destination.backup.$(Get-Date -Format 'yyyyMMddHHmmss')"
                Copy-Item $Destination $backup
                Copy-Item $Source $Destination -Force
                Write-Host "  -> Backed up to $backup and overwritten." -ForegroundColor Green
            }
            default {
                Write-Host "  -> Skipped." -ForegroundColor Gray
            }
        }
    } else {
        $dir = Split-Path $Destination -Parent
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        Copy-Item $Source $Destination -Force
        Write-Host "INSTALLED: $Label -> $Destination" -ForegroundColor Green
    }
}

function Install-Skill {
    param([string]$SkillName)

    $src = Join-Path $ProfileDir "skills\$SkillName\SKILL.md"
    $destDir = Join-Path $ClaudeDir "skills\$SkillName"
    $dest = Join-Path $destDir "SKILL.md"

    if (-not (Test-Path $src)) { return }

    if ($DryRun) {
        if (Test-Path $destDir) {
            Write-Host "[DRY RUN] SKILL EXISTS: $SkillName (would skip)" -ForegroundColor Yellow
        } else {
            Write-Host "[DRY RUN] INSTALL SKILL: $SkillName" -ForegroundColor Green
        }
        return
    }

    if ((Test-Path $destDir) -and -not $Force) {
        Write-Host "SKILL EXISTS: $SkillName" -ForegroundColor Yellow
        $choice = Read-Host "  [s]kip, [o]verwrite, [b]ackup+overwrite?"
        switch ($choice.ToLower()) {
            "o" {
                Copy-Item $src $dest -Force
                Write-Host "  -> Overwritten." -ForegroundColor Green
            }
            "b" {
                if (Test-Path $dest) {
                    Copy-Item $dest "$dest.backup.$(Get-Date -Format 'yyyyMMddHHmmss')"
                }
                Copy-Item $src $dest -Force
                Write-Host "  -> Backed up and overwritten." -ForegroundColor Green
            }
            default {
                Write-Host "  -> Skipped." -ForegroundColor Gray
            }
        }
    } else {
        if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
        Copy-Item $src $dest -Force
        Write-Host "INSTALLED SKILL: $SkillName" -ForegroundColor Green
    }
}

# --- Wizard ---

$SkipClaude = $false
$ForceClaude = $false
if ($Wizard -and (Test-Path (Join-Path $ClaudeDir "CLAUDE.md"))) {
    Write-Host "=== Wizard: Analyzing existing configuration ===" -ForegroundColor Cyan
    $existing = Join-Path $ClaudeDir "CLAUDE.md"
    $lineCount = (Get-Content $existing | Measure-Object -Line).Lines
    Write-Host ""
    Write-Host "Found existing CLAUDE.md ($lineCount lines)."
    Write-Host ""
    Write-Host "Sections detected:"
    Get-Content $existing | Where-Object { $_ -match '^## ' } | ForEach-Object { Write-Host "  $_" }
    Write-Host ""
    Write-Host "Options:"
    Write-Host "  1. Replace CLAUDE.md with playbook version (backup kept)"
    Write-Host "  2. Skip CLAUDE.md, install only skills and templates"
    Write-Host "  3. Abort"
    $wizChoice = Read-Host "Choose [1/2/3]"
    switch ($wizChoice) {
        "1" {
            $backup = "$existing.backup.$(Get-Date -Format 'yyyyMMddHHmmss')"
            if ($DryRun) {
                Write-Host "  -> [DRY RUN] Would back up to $backup" -ForegroundColor Green
            } else {
                Copy-Item $existing $backup
                Write-Host "  -> Backed up to $backup" -ForegroundColor Green
            }
            $ForceClaude = $true
        }
        "2" {
            $SkipClaude = $true
            Write-Host "  -> Skipping CLAUDE.md." -ForegroundColor Gray
        }
        default {
            Write-Host "  -> Aborting." -ForegroundColor Gray
            exit 0
        }
    }
}

# --- Install ---

Write-Host ""
Write-Host "--- Installing CLAUDE.md ---" -ForegroundColor Cyan
if ($SkipClaude) {
    Write-Host "SKIPPED: CLAUDE.md (wizard choice)" -ForegroundColor Gray
} elseif ($ForceClaude) {
    $src = Join-Path $ProfileDir "CLAUDE.md"
    $dest = Join-Path $ClaudeDir "CLAUDE.md"
    if ($DryRun) {
        Write-Host "[DRY RUN] INSTALL: CLAUDE.md -> $dest (wizard backup+replace)" -ForegroundColor Green
    } else {
        Copy-Item $src $dest -Force
        Write-Host "INSTALLED: CLAUDE.md" -ForegroundColor Green
    }
} else {
    Install-ConfigFile (Join-Path $ProfileDir "CLAUDE.md") (Join-Path $ClaudeDir "CLAUDE.md") "CLAUDE.md"
}

Write-Host ""
Write-Host "--- Installing skills ---" -ForegroundColor Cyan
$skillsDir = Join-Path $ProfileDir "skills"
if (Test-Path $skillsDir) {
    Get-ChildItem $skillsDir -Directory | ForEach-Object {
        Install-Skill $_.Name
    }
}

Write-Host ""
Write-Host "--- Installing templates ---" -ForegroundColor Cyan
$templatesDir = Join-Path $ClaudeDir "templates"
if (-not $DryRun -and -not (Test-Path $templatesDir)) { New-Item -ItemType Directory -Path $templatesDir -Force | Out-Null }

# Project CLAUDE.md template
$projectTemplate = Join-Path $ScriptDir "templates\project-CLAUDE.md"
if (Test-Path $projectTemplate) {
    Install-ConfigFile $projectTemplate (Join-Path $templatesDir "project-CLAUDE.md") "template: project-CLAUDE.md"
}

# Investigation templates (research profile only)
if ($Profile -eq "research") {
    $invTmplSrc = Join-Path $ProfileDir "templates"
    if (Test-Path $invTmplSrc) {
        Write-Host ""
        Write-Host "--- Installing investigation templates ---" -ForegroundColor Cyan
        $invTmplDest = Join-Path $templatesDir "investigation"
        $invHooksDest = Join-Path $invTmplDest "hooks"
        if (-not $DryRun -and -not (Test-Path $invTmplDest)) { New-Item -ItemType Directory -Path $invTmplDest -Force | Out-Null }
        if (-not $DryRun -and -not (Test-Path $invHooksDest)) { New-Item -ItemType Directory -Path $invHooksDest -Force | Out-Null }
        Get-ChildItem $invTmplSrc -File -ErrorAction SilentlyContinue | ForEach-Object {
            Install-ConfigFile $_.FullName (Join-Path $invTmplDest $_.Name) "investigation template: $($_.Name)"
        }
        $invHooksSrc = Join-Path $invTmplSrc "hooks"
        if (Test-Path $invHooksSrc) {
            Get-ChildItem $invHooksSrc -File -ErrorAction SilentlyContinue | ForEach-Object {
                Install-ConfigFile $_.FullName (Join-Path $invHooksDest $_.Name) "investigation hook: $($_.Name)"
            }
        }
        # Create investigations directory structure
        $invDir = Join-Path $env:USERPROFILE ".claude\investigations\_patterns"
        if ($DryRun) {
            Write-Host "[DRY RUN] MKDIR: ~/.claude/investigations/_patterns/" -ForegroundColor Green
        } else {
            if (-not (Test-Path $invDir)) { New-Item -ItemType Directory -Path $invDir -Force | Out-Null }
            Write-Host "CREATED: ~/.claude/investigations/_patterns/" -ForegroundColor Green
        }
    }
}

# Cursor templates
$cursorSrc = Join-Path $ScriptDir "templates\cursor"
if (Test-Path $cursorSrc) {
    Write-Host ""
    Write-Host "--- Installing Cursor templates ---" -ForegroundColor Cyan
    $cursorRulesDir = Join-Path $templatesDir "cursor\rules"
    $cursorCmdsDir = Join-Path $templatesDir "cursor\commands"
    if (-not $DryRun -and -not (Test-Path $cursorRulesDir)) { New-Item -ItemType Directory -Path $cursorRulesDir -Force | Out-Null }
    if (-not $DryRun -and -not (Test-Path $cursorCmdsDir)) { New-Item -ItemType Directory -Path $cursorCmdsDir -Force | Out-Null }
    Get-ChildItem (Join-Path $cursorSrc "rules") -File -ErrorAction SilentlyContinue | ForEach-Object {
        Install-ConfigFile $_.FullName (Join-Path $cursorRulesDir $_.Name) "cursor rule: $($_.Name)"
    }
    Get-ChildItem (Join-Path $cursorSrc "commands") -File -ErrorAction SilentlyContinue | ForEach-Object {
        Install-ConfigFile $_.FullName (Join-Path $cursorCmdsDir $_.Name) "cursor command: $($_.Name)"
    }
}

# --- Cleanup old research skills ---

if ($Profile -eq "research") {
    $oldSkills = @("findings", "checkpoint")
    foreach ($oldSkill in $oldSkills) {
        $oldDir = Join-Path $ClaudeDir "skills\$oldSkill"
        if (Test-Path $oldDir) {
            if ($DryRun) {
                Write-Host "[DRY RUN] OLD SKILL: $oldSkill (would offer removal)" -ForegroundColor Yellow
            } else {
                Write-Host ""
                Write-Host "OLD SKILL: /$oldSkill is no longer part of the investigation profile." -ForegroundColor Yellow
                $removeChoice = Read-Host "  Remove $oldDir? [y/N]"
                if ($removeChoice -eq "y" -or $removeChoice -eq "Y") {
                    Remove-Item -Recurse -Force $oldDir
                    Write-Host "  -> Removed." -ForegroundColor Green
                } else {
                    Write-Host "  -> Kept." -ForegroundColor Gray
                }
            }
        }
    }
}

# --- Auto-exit ---

if ($AutoExit -and -not $DryRun) {
    $marker = Join-Path $ClaudeDir ".auto-exit-after-checkpoint"
    New-Item -ItemType File -Path $marker -Force | Out-Null
    Write-Host ""
    Write-Host "AUTO-EXIT: Enabled. /checkpoint will exit the session automatically." -ForegroundColor Green
    Write-Host "  To disable: Remove-Item $marker"
}

# --- Summary ---

Write-Host ""
Write-Host "=== Installation complete ===" -ForegroundColor Cyan
Write-Host "Profile: $Profile"
Write-Host ""
Write-Host "What was installed:" -ForegroundColor White
Write-Host "  CLAUDE.md        -> $ClaudeDir\CLAUDE.md (global, loads every session)"
Get-ChildItem (Join-Path $ProfileDir "skills") -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "  /$($_.Name) skill  -> $ClaudeDir\skills\$($_.Name)\"
}
Write-Host "  Templates        -> $ClaudeDir\templates\"
Write-Host "    project-CLAUDE.md   (copy to new project roots)"
Write-Host "    cursor\rules\       (copy to .cursor\rules\ in each project)"
Write-Host "    cursor\commands\    (copy to .cursor\commands\ in each project)"
Write-Host ""
Write-Host "Claude Code: ready to use globally (no per-project setup needed)." -ForegroundColor Green
Write-Host "Cursor:      copy templates into each project:" -ForegroundColor Yellow
Write-Host "  Copy-Item -Recurse $ClaudeDir\templates\cursor\rules\ .cursor\rules\"
Write-Host "  Copy-Item -Recurse $ClaudeDir\templates\cursor\commands\ .cursor\commands\"
Write-Host ""
Write-Host "Next steps:" -ForegroundColor White
Write-Host "  1. Review $ClaudeDir\CLAUDE.md and customize for your workflow"
Write-Host "  2. Start a Claude Code session: claude"
if ($Profile -eq "dev") {
    Write-Host "  3. Run /playbook to configure for your environment"
    Write-Host "  4. Use /resume at session start, /checkpoint at session end"
} else {
    Write-Host "  3. Run /investigate <id> new to start an investigation"
    Write-Host "  4. Use /resume at session start to see open investigations"
}
Write-Host ""
Write-Host "Docs: docs\best-practices.md (practices) and docs\tool-comparison.md (Claude vs Cursor)"
