#!/usr/bin/env bash
# rtk-rewrite.sh — PreToolUse hook that delegates to rtk for Bash command rewriting
# Installed by install.sh; requires rtk binary on PATH
exec rtk rewrite 2>/dev/null
