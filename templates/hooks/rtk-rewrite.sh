#!/usr/bin/env bash
# rtk-rewrite.sh — PreToolUse hook that delegates to rtk for Bash command rewriting
# Installed by install.sh; requires rtk binary on PATH
command -v rtk &>/dev/null || exit 0
exec rtk rewrite
