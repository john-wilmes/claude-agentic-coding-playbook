#!/usr/bin/env bash
# tests/scripts/mcp-registry.test.sh — Tests for MCP server registry install
#
# Tests the registry merge logic from install.sh using temp files.
# Does NOT run the full installer — extracts and tests the node merge script.
#
# Run: bash tests/scripts/mcp-registry.test.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REGISTRY_FILE="${REPO_ROOT}/templates/registry/mcp-servers.json"

# ─── Minimal test runner ──────────────────────────────────────────────────────

PASSED=0
FAILED=0
FAILURES=()

pass() { PASSED=$(( PASSED + 1 )); printf '  ✓ %s\n' "$1"; }
fail() {
  FAILED=$(( FAILED + 1 ))
  FAILURES+=("$1: $2")
  printf '  ✗ %s\n' "$1"
  printf '    %s\n' "$2"
}

run_test() {
  local name="$1"
  local fn="$2"
  local output
  local rc=0
  output="$("${fn}" 2>&1)" || rc=$?
  if [[ ${rc} -eq 0 ]]; then
    pass "${name}"
  else
    fail "${name}" "${output}"
  fi
}

# ─── Helper: run the merge script against temp files ──────────────────────────

merge_registry() {
  local registry="$1"
  local settings="$2"
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
    console.log(added + ':' + skipped);
  " "$registry" "$settings"
}

# ─── Test 1: Registry JSON is valid ──────────────────────────────────────────

test_registry_valid_json() {
  node -e "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'))" "$REGISTRY_FILE"
}
run_test "Registry file is valid JSON" test_registry_valid_json

# ─── Test 2: Registry has expected server count ──────────────────────────────

test_registry_server_count() {
  local count
  count=$(node -e "
    const r = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    console.log(Object.keys(r).length);
  " "$REGISTRY_FILE")
  [[ "$count" -eq 21 ]] || { echo "Expected 21 servers, got $count"; return 1; }
}
run_test "Registry contains 21 servers" test_registry_server_count

# ─── Test 3: github is enabled, others disabled ─────────────────────────────

test_github_enabled() {
  node -e "
    const r = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    const ENABLED = new Set(['github', 'fleet-index', 'serena', 'mma']);
    for (const [name, entry] of Object.entries(r)) {
      const shouldBeEnabled = ENABLED.has(name);
      if (shouldBeEnabled && entry.config.disabled !== false) { console.error(name + ' should be enabled'); process.exit(1); }
      if (!shouldBeEnabled && entry.config.disabled !== true) { console.error(name + ' should be disabled'); process.exit(1); }
    }
  " "$REGISTRY_FILE"
}
run_test "enabled/disabled flags are correct" test_github_enabled

# ─── Test 4: Each entry has required fields ──────────────────────────────────

test_entry_fields() {
  node -e "
    const r = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    for (const [name, entry] of Object.entries(r)) {
      if (!entry.description) { console.error(name + ' missing description'); process.exit(1); }
      if (!entry.config) { console.error(name + ' missing config'); process.exit(1); }
      if (!entry.notes) { console.error(name + ' missing notes'); process.exit(1); }
      if (!Array.isArray(entry.env_required)) { console.error(name + ' missing env_required array'); process.exit(1); }
      const c = entry.config;
      const hasCommand = c.command && Array.isArray(c.args);
      const hasHttp = c.type === 'http' && c.url;
      if (!hasCommand && !hasHttp) { console.error(name + ' needs command+args or type+url'); process.exit(1); }
    }
  " "$REGISTRY_FILE"
}
run_test "All entries have required fields" test_entry_fields

# ─── Test 5: Fresh install adds all servers ──────────────────────────────────

test_fresh_install() {
  local tmpdir
  tmpdir=$(mktemp -d)
  trap "rm -rf '$tmpdir'" RETURN
  echo '{}' > "$tmpdir/settings.json"

  local result
  result=$(merge_registry "$REGISTRY_FILE" "$tmpdir/settings.json")
  local added=${result%%:*}
  local skipped=${result##*:}
  [[ "$added" -eq 21 ]] || { echo "Expected 21 added, got $added"; return 1; }
  [[ "$skipped" -eq 0 ]] || { echo "Expected 0 skipped, got $skipped"; return 1; }

  # Verify github is in the output
  node -e "
    const s = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    if (!s.mcpServers.github) { console.error('github missing from output'); process.exit(1); }
    if (s.mcpServers.github.disabled !== false) { console.error('github should be enabled'); process.exit(1); }
  " "$tmpdir/settings.json"
}
run_test "Fresh install adds all 15 servers" test_fresh_install

# ─── Test 6: Idempotent — running twice doesn't duplicate ───────────────────

test_idempotent() {
  local tmpdir
  tmpdir=$(mktemp -d)
  trap "rm -rf '$tmpdir'" RETURN
  echo '{}' > "$tmpdir/settings.json"

  merge_registry "$REGISTRY_FILE" "$tmpdir/settings.json" >/dev/null

  local result
  result=$(merge_registry "$REGISTRY_FILE" "$tmpdir/settings.json")
  local added=${result%%:*}
  local skipped=${result##*:}
  [[ "$added" -eq 0 ]] || { echo "Expected 0 added on second run, got $added"; return 1; }
  [[ "$skipped" -eq 21 ]] || { echo "Expected 21 skipped on second run, got $skipped"; return 1; }
}
run_test "Idempotent — second run adds nothing" test_idempotent

# ─── Test 7: Preserves user config ──────────────────────────────────────────

test_preserves_user_config() {
  local tmpdir
  tmpdir=$(mktemp -d)
  trap "rm -rf '$tmpdir'" RETURN

  # User has already enabled datadog with custom config
  cat > "$tmpdir/settings.json" <<'EOF'
{
  "mcpServers": {
    "datadog": {
      "command": "npx",
      "args": ["-y", "@winor30/mcp-server-datadog"],
      "disabled": false
    }
  }
}
EOF

  merge_registry "$REGISTRY_FILE" "$tmpdir/settings.json" >/dev/null

  # datadog should still be enabled (user's config preserved)
  node -e "
    const s = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    if (s.mcpServers.datadog.disabled !== false) {
      console.error('datadog should still be enabled (user config)');
      process.exit(1);
    }
  " "$tmpdir/settings.json"
}
run_test "Preserves user-modified config" test_preserves_user_config

# ─── Test 8: Preserves existing non-registry servers ────────────────────────

test_preserves_custom_servers() {
  local tmpdir
  tmpdir=$(mktemp -d)
  trap "rm -rf '$tmpdir'" RETURN

  cat > "$tmpdir/settings.json" <<'EOF'
{
  "mcpServers": {
    "my-custom-server": {
      "command": "node",
      "args": ["my-server.js"]
    }
  }
}
EOF

  merge_registry "$REGISTRY_FILE" "$tmpdir/settings.json" >/dev/null

  node -e "
    const s = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    if (!s.mcpServers['my-custom-server']) {
      console.error('custom server was removed');
      process.exit(1);
    }
    if (!s.mcpServers.github) {
      console.error('github was not added');
      process.exit(1);
    }
  " "$tmpdir/settings.json"
}
run_test "Preserves non-registry custom servers" test_preserves_custom_servers

# ─── Test 9: Preserves other settings keys ───────────────────────────────────

test_preserves_other_settings() {
  local tmpdir
  tmpdir=$(mktemp -d)
  trap "rm -rf '$tmpdir'" RETURN

  cat > "$tmpdir/settings.json" <<'EOF'
{
  "hooks": { "PreToolUse": [] },
  "enableAllProjectMcpServers": false
}
EOF

  merge_registry "$REGISTRY_FILE" "$tmpdir/settings.json" >/dev/null

  node -e "
    const s = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    if (!s.hooks) { console.error('hooks key was removed'); process.exit(1); }
    if (s.enableAllProjectMcpServers !== false) { console.error('enableAllProjectMcpServers changed'); process.exit(1); }
  " "$tmpdir/settings.json"
}
run_test "Preserves other settings keys" test_preserves_other_settings

# ─── Test 10: resources.example.json is valid ────────────────────────────────

test_resources_example_valid() {
  local example="${REPO_ROOT}/templates/registry/resources.example.json"
  node -e "
    const r = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    if (!Array.isArray(r.repos)) { console.error('repos should be an array'); process.exit(1); }
    if (r.repos.length === 0) { console.error('example should have sample repos'); process.exit(1); }
  " "$example"
}
run_test "resources.example.json is valid" test_resources_example_valid

# ─── Test 11: Doc endpoints register as MCP servers ──────────────────────────

test_doc_endpoints() {
  local tmpdir
  tmpdir=$(mktemp -d)
  trap "rm -rf '$tmpdir'" RETURN

  echo '{}' > "$tmpdir/settings.json"
  cat > "$tmpdir/resources.json" <<'EOF'
{
  "repos": [],
  "docs": [
    {"name": "internal-docs", "url": "https://docs.example.com/mcp", "description": "Test docs"}
  ]
}
EOF

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
    console.log(added + ':' + skipped);
  " "$tmpdir/resources.json" "$tmpdir/settings.json"

  node -e "
    const s = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    const srv = s.mcpServers['internal-docs'];
    if (!srv) { console.error('internal-docs not registered'); process.exit(1); }
    if (srv.type !== 'http') { console.error('expected type http, got ' + srv.type); process.exit(1); }
    if (srv.url !== 'https://docs.example.com/mcp') { console.error('wrong url: ' + srv.url); process.exit(1); }
    if (srv.disabled !== false) { console.error('should be enabled'); process.exit(1); }
  " "$tmpdir/settings.json"
}
run_test "Doc endpoints register as MCP servers" test_doc_endpoints

# ─── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo "Results: ${PASSED} passed, ${FAILED} failed"
if [[ ${FAILED} -gt 0 ]]; then
  echo ""
  echo "Failures:"
  for f in "${FAILURES[@]}"; do
    echo "  - $f"
  done
  exit 1
fi
