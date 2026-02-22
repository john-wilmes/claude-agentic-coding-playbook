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
            Copy-Item $existing $backup
            Write-Host "  -> Backed up to $backup" -ForegroundColor Green
            $Force = $true  # Force the CLAUDE.md install
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
if (-not (Test-Path $templatesDir)) { New-Item -ItemType Directory -Path $templatesDir -Force | Out-Null }
Get-ChildItem (Join-Path $ScriptDir "templates") -File | ForEach-Object {
    Install-ConfigFile $_.FullName (Join-Path $templatesDir $_.Name) "template: $($_.Name)"
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
Write-Host "Next steps:" -ForegroundColor White
Write-Host "  1. Review $ClaudeDir\CLAUDE.md and customize for your workflow"
Write-Host "  2. Start a Claude Code session: claude"
Write-Host "  3. Try /resume to see session continuity in action"
Write-Host "  4. Use /checkpoint at natural breakpoints"
Write-Host ""
Write-Host "Documentation: see docs\best-practices.md in this repo"
