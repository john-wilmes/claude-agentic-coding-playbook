#!/usr/bin/env bash
# statusline.sh - Claude Code status line script
# Reads JSON from stdin and outputs a single-line status display.
# Fields used: model.display_name, context_window.used_percentage,
#              cost.total_cost_usd, cost.total_duration_ms

# Graceful fallback if jq is missing
if ! command -v jq &>/dev/null; then
  echo "[status unavailable: jq not found]"
  exit 0
fi

# Read stdin
input=$(cat)

# Parse fields with fallbacks for null/missing values
model=$(echo "$input" | jq -r '.model.display_name // "Unknown"' 2>/dev/null)
ctx_pct=$(echo "$input" | jq -r '.context_window.used_percentage // empty' 2>/dev/null)
cost=$(echo "$input" | jq -r '.cost.total_cost_usd // empty' 2>/dev/null)
duration_ms=$(echo "$input" | jq -r '.cost.total_duration_ms // empty' 2>/dev/null)

# Format context percentage with color thresholds matching context-guard:
#   green  = < 57%
#   yellow = 57-74%
#   red    = >= 75%
if [ -n "$ctx_pct" ]; then
  ctx_int=$(echo "$ctx_pct" | awk '{printf "%d", $1}')
  ctx_fmt=$(printf "%.0f%%" "$ctx_pct" 2>/dev/null || echo "${ctx_int}%")
  if [ "$ctx_int" -ge 75 ]; then
    ctx_display="\033[31m${ctx_fmt}\033[0m"   # red
  elif [ "$ctx_int" -ge 57 ]; then
    ctx_display="\033[33m${ctx_fmt}\033[0m"   # yellow
  else
    ctx_display="\033[32m${ctx_fmt}\033[0m"   # green
  fi
else
  ctx_display="?%"
fi

# Format cost as $0.0000
if [ -n "$cost" ]; then
  cost_fmt=$(printf '$%.4f' "$cost" 2>/dev/null || echo "$cost")
else
  cost_fmt='$?.????'
fi

# Format duration as Xm Ys
if [ -n "$duration_ms" ]; then
  total_s=$(( duration_ms / 1000 ))
  minutes=$(( total_s / 60 ))
  seconds=$(( total_s % 60 ))
  duration_fmt="${minutes}m ${seconds}s"
else
  duration_fmt="?m ?s"
fi

# Output single line: [Model] ctx% | $cost | duration
printf "[%s] " "$model"
printf "%b" "$ctx_display"
printf " | %s | %s\n" "$cost_fmt" "$duration_fmt"
