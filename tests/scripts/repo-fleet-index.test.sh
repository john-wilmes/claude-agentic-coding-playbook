#!/usr/bin/env bash
# tests/scripts/repo-fleet-index.test.sh — Integration tests for scripts/repo-fleet-index.sh
#
# Run: bash tests/scripts/repo-fleet-index.test.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="${REPO_ROOT}/scripts/repo-fleet-index.sh"
FLEET_INDEX="${REPO_ROOT}/templates/fleet/fleet-index.js"

# ─── Minimal test runner ──────────────────────────────────────────────────────

PASSED=0
FAILED=0
FAILURES=()

pass() { PASSED=$(( PASSED + 1 )); printf '  \u2713 %s\n' "$1"; }
fail() {
  FAILED=$(( FAILED + 1 ))
  FAILURES+=("$1: $2")
  printf '  \u2717 %s\n' "$1"
  printf '    %s\n' "$2"
}

run_test() {
  local name="$1"
  local fn="$2"
  local output rc=0
  output="$("${fn}" 2>&1)" || rc=$?
  if [[ ${rc} -eq 0 ]]; then
    pass "${name}"
  else
    fail "${name}" "${output}"
  fi
}

# ─── Test helpers ─────────────────────────────────────────────────────────────

# Create a fake git repo in PARENT_DIR/NAME with an initial commit.
# Usage: create_fake_repo <parent_dir> <name> [file:content ...]
# Extra args are colon-separated file:content pairs written before committing.
create_fake_repo() {
  local parent="$1"
  local name="$2"
  shift 2
  local repo_dir="${parent}/${name}"
  mkdir -p "${repo_dir}"

  # Write any provided files
  for pair in "$@"; do
    local file="${pair%%:*}"
    local content="${pair#*:}"
    local fdir
    fdir="$(dirname "${repo_dir}/${file}")"
    mkdir -p "${fdir}"
    printf '%s\n' "${content}" > "${repo_dir}/${file}"
  done

  # Ensure at least one file exists so git commit works
  if [[ ! "$(ls -A "${repo_dir}")" ]]; then
    touch "${repo_dir}/.gitkeep"
  fi

  git -C "${repo_dir}" init -q
  git -C "${repo_dir}" config user.email "test@test.com"
  git -C "${repo_dir}" config user.name "Test"
  git -C "${repo_dir}" add .
  git -C "${repo_dir}" commit -q -m "initial commit"
}

# ─── Test 1: --help exits 0 and output contains "Usage" ──────────────────────

t_help() {
  local out rc=0
  out="$(bash "${SCRIPT}" --help 2>&1)" || rc=$?
  [[ ${rc} -eq 0 ]] \
    || { echo "--help exit code was ${rc}, expected 0"; return 1; }
  echo "${out}" | grep -q "Usage" \
    || { echo "--help output did not contain 'Usage'; got: ${out}"; return 1; }
}
run_test "--help exits 0 and output contains 'Usage'" t_help

# ─── Test 2: -h also exits 0 and prints usage ────────────────────────────────

t_help_short() {
  local out rc=0
  out="$(bash "${SCRIPT}" -h 2>&1)" || rc=$?
  [[ ${rc} -eq 0 ]] \
    || { echo "-h exit code was ${rc}, expected 0"; return 1; }
  echo "${out}" | grep -q "Usage" \
    || { echo "-h output did not contain 'Usage'; got: ${out}"; return 1; }
}
run_test "-h exits 0 and prints usage" t_help_short

# ─── Test 3: No arguments exits 0 and prints usage ───────────────────────────

t_no_args() {
  local out rc=0
  out="$(bash "${SCRIPT}" 2>&1)" || rc=$?
  [[ ${rc} -eq 0 ]] \
    || { echo "no-args exit code was ${rc}, expected 0"; return 1; }
  echo "${out}" | grep -q "Usage" \
    || { echo "no-args output did not contain 'Usage'; got: ${out}"; return 1; }
}
run_test "no arguments exits 0 and prints usage" t_no_args

# ─── Test 4: --build with missing repos-dir exits non-zero ───────────────────

t_build_missing_repos_dir() {
  local tmpout
  tmpout="$(mktemp -d)"
  local rc=0
  bash "${SCRIPT}" \
    --build \
    --repos-dir "/nonexistent/repos/dir/that/does/not/exist" \
    --output-dir "${tmpout}" \
    2>&1 || rc=$?
  rm -rf "${tmpout}"
  [[ ${rc} -ne 0 ]] \
    || { echo "Expected non-zero exit for missing repos-dir, got 0"; return 1; }
}
run_test "--build with missing repos-dir exits non-zero" t_build_missing_repos_dir

# ─── Test 5: --search without query exits non-zero ───────────────────────────

t_search_missing_query() {
  local rc=0
  bash "${SCRIPT}" --search 2>&1 || rc=$?
  [[ ${rc} -ne 0 ]] \
    || { echo "Expected non-zero exit when --search has no query, got 0"; return 1; }
}
run_test "--search without query argument exits non-zero" t_search_missing_query

# ─── Test 6: --build with valid repos creates output files ───────────────────

t_build_valid_repos() {
  local tmpbase tmpout
  tmpbase="$(mktemp -d)"
  tmpout="$(mktemp -d)"

  # Create two minimal repos
  create_fake_repo "${tmpbase}" "org_alpha" \
    "package.json:{\"name\":\"alpha\",\"dependencies\":{\"express\":\"^4\"}}" \
    "README.md:# Alpha\n\nThe alpha service."
  create_fake_repo "${tmpbase}" "org_beta" \
    "Dockerfile:FROM python:3.11\nEXPOSE 8080" \
    "README.md:# Beta\n\nThe beta service."

  local out rc=0
  out="$(bash "${SCRIPT}" \
    --build \
    --repos-dir "${tmpbase}" \
    --output-dir "${tmpout}" 2>&1)" || rc=$?

  rm -rf "${tmpbase}" "${tmpout}"

  [[ ${rc} -eq 0 ]] \
    || { echo "--build exit code was ${rc}, expected 0; output: ${out}"; return 1; }
  # The script itself removes the dirs, so check before cleanup via a subshell
  return 0
}

# Rewritten to check files before cleanup
t_build_creates_output_files() {
  local tmpbase tmpout
  tmpbase="$(mktemp -d)"
  tmpout="$(mktemp -d)"

  create_fake_repo "${tmpbase}" "org_alpha" \
    "README.md:# Alpha\n\nThe alpha service."
  create_fake_repo "${tmpbase}" "org_beta" \
    "README.md:# Beta\n\nThe beta service."

  local out rc=0
  out="$(bash "${SCRIPT}" \
    --build \
    --repos-dir "${tmpbase}" \
    --output-dir "${tmpout}" 2>&1)" || rc=$?

  local ok=0
  if [[ ${rc} -eq 0 ]] \
      && [[ -f "${tmpout}/fleet-digest.txt" ]] \
      && [[ -f "${tmpout}/org_alpha.json" ]] \
      && [[ -f "${tmpout}/org_beta.json" ]]; then
    ok=1
  fi

  rm -rf "${tmpbase}" "${tmpout}"

  [[ ${ok} -eq 1 ]] \
    || { echo "Expected output files not found; rc=${rc}; output: ${out}"; return 1; }
}
run_test "--build with valid repos creates manifest files and fleet-digest.txt" t_build_creates_output_files

# ─── Test 7: --list after build returns repo names ───────────────────────────

t_list_after_build() {
  local tmpbase tmpout
  tmpbase="$(mktemp -d)"
  tmpout="$(mktemp -d)"

  create_fake_repo "${tmpbase}" "org_gamma" \
    "README.md:# Gamma\n\nThe gamma service."

  # Build first
  bash "${SCRIPT}" \
    --build \
    --repos-dir "${tmpbase}" \
    --output-dir "${tmpout}" >/dev/null 2>&1

  # List
  local out rc=0
  out="$(bash "${SCRIPT}" \
    --list \
    --output-dir "${tmpout}" 2>&1)" || rc=$?

  rm -rf "${tmpbase}" "${tmpout}"

  [[ ${rc} -eq 0 ]] \
    || { echo "--list exit code was ${rc}, expected 0; output: ${out}"; return 1; }
  echo "${out}" | grep -q "gamma" \
    || { echo "--list output did not contain 'gamma'; got: ${out}"; return 1; }
}
run_test "--list after build returns repo names" t_list_after_build

# ─── Test 8: --search after build returns results ────────────────────────────

t_search_after_build() {
  local tmpbase tmpout
  tmpbase="$(mktemp -d)"
  tmpout="$(mktemp -d)"

  create_fake_repo "${tmpbase}" "org_payments" \
    "package.json:{\"name\":\"payment-service\",\"dependencies\":{\"express\":\"^4\"}}" \
    "README.md:# Payment Service\n\nHandles payment processing with Stripe."
  create_fake_repo "${tmpbase}" "org_users" \
    "package.json:{\"name\":\"user-service\",\"dependencies\":{\"express\":\"^4\"}}" \
    "README.md:# User Service\n\nHandles user accounts."

  # Build first
  bash "${SCRIPT}" \
    --build \
    --repos-dir "${tmpbase}" \
    --output-dir "${tmpout}" >/dev/null 2>&1

  # Search
  local out rc=0
  out="$(bash "${SCRIPT}" \
    --search "payment stripe" \
    --output-dir "${tmpout}" 2>&1)" || rc=$?

  rm -rf "${tmpbase}" "${tmpout}"

  [[ ${rc} -eq 0 ]] \
    || { echo "--search exit code was ${rc}, expected 0; output: ${out}"; return 1; }
  # Output is JSON array — should contain payment repo
  echo "${out}" | grep -q "payment" \
    || { echo "--search output did not contain 'payment'; got: ${out}"; return 1; }
}
run_test "--search after build returns results" t_search_after_build

# ─── Test 9: --refresh only re-indexes changed repos ─────────────────────────

t_refresh_only_updates_changed() {
  local tmpbase tmpout
  tmpbase="$(mktemp -d)"
  tmpout="$(mktemp -d)"

  local alpha_dir="${tmpbase}/org_alpha"
  create_fake_repo "${tmpbase}" "org_alpha" \
    "README.md:# Alpha\n\nInitial version."
  create_fake_repo "${tmpbase}" "org_beta" \
    "README.md:# Beta\n\nInitial version."

  # Initial build
  bash "${SCRIPT}" \
    --build \
    --repos-dir "${tmpbase}" \
    --output-dir "${tmpout}" >/dev/null 2>&1

  # Capture beta's initial sourceHash
  local beta_hash_before
  beta_hash_before="$(node -e "const m=JSON.parse(require('fs').readFileSync('${tmpout}/org_beta.json','utf8')); process.stdout.write(m.sourceHash);")"

  # Add a new commit to alpha only
  printf 'New content\n' > "${alpha_dir}/NEWFILE.md"
  git -C "${alpha_dir}" add .
  git -C "${alpha_dir}" config user.email "test@test.com"
  git -C "${alpha_dir}" config user.name "Test"
  git -C "${alpha_dir}" commit -q -m "second commit"

  # Refresh
  local out rc=0
  out="$(bash "${SCRIPT}" \
    --refresh \
    --repos-dir "${tmpbase}" \
    --output-dir "${tmpout}" 2>&1)" || rc=$?

  # Capture beta's sourceHash after refresh
  local beta_hash_after
  beta_hash_after="$(node -e "const m=JSON.parse(require('fs').readFileSync('${tmpout}/org_beta.json','utf8')); process.stdout.write(m.sourceHash);")"

  rm -rf "${tmpbase}" "${tmpout}"

  [[ ${rc} -eq 0 ]] \
    || { echo "--refresh exit code was ${rc}, expected 0; output: ${out}"; return 1; }

  # Beta's sourceHash should be unchanged (it was skipped)
  [[ "${beta_hash_before}" == "${beta_hash_after}" ]] \
    || { echo "Beta sourceHash changed after refresh (should have been skipped); before=${beta_hash_before} after=${beta_hash_after}"; return 1; }
}
run_test "--refresh only re-indexes repos with changed HEAD" t_refresh_only_updates_changed

# ─── Test 10: unknown option exits non-zero ───────────────────────────────────

t_unknown_option() {
  local rc=0
  bash "${SCRIPT}" --not-a-real-flag 2>&1 || rc=$?
  [[ ${rc} -ne 0 ]] \
    || { echo "Expected non-zero exit for unknown option, got 0"; return 1; }
}
run_test "unknown option exits non-zero" t_unknown_option

# ─── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo "Results: ${PASSED} passed, ${FAILED} failed"

if [[ ${FAILED} -gt 0 ]]; then
  echo ""
  echo "Failures:"
  for f in "${FAILURES[@]}"; do
    echo "  - ${f}"
  done
  exit 1
fi

exit 0
