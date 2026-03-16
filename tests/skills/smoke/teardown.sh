#!/usr/bin/env bash
# tests/skills/smoke/teardown.sh — Cleanup test environment

if [ -n "${TEST_DIR:-}" ] && [ -d "$TEST_DIR" ]; then
  rm -rf "$TEST_DIR"
fi
