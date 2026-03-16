#!/usr/bin/env bash
# tests/skills/smoke/setup.sh — Common test environment for smoke tests
#
# Sourced by individual test scripts. Creates isolated git project with bare remote.
# Exports: TEST_DIR, TEST_PROJECT, TEST_REMOTE

# Allow nested claude invocation from within a Claude Code session
unset CLAUDECODE 2>/dev/null || true

export TEST_DIR="$(mktemp -d)"
export TEST_PROJECT="${TEST_DIR}/test-project"
export TEST_REMOTE="${TEST_DIR}/test-remote"

# Create test project
mkdir -p "$TEST_PROJECT"
cd "$TEST_PROJECT"
git init -q
git config user.email "smoke-test@test.com"
git config user.name "Smoke Test"

# Minimal project files
cat > CLAUDE.md <<'EOF'
# Smoke Test Project

## Quality Gates

No quality gates configured.
EOF

cat > .gitignore <<'EOF'
node_modules/
dist/
.env*
*.log
EOF

echo "test content" > test.txt

git add -A
git commit -q -m "Initial test commit"

# Create bare remote for push tests
git clone -q --bare "$TEST_PROJECT" "$TEST_REMOTE"
cd "$TEST_PROJECT"
git remote add origin "$TEST_REMOTE" 2>/dev/null || git remote set-url origin "$TEST_REMOTE"
git fetch -q origin
git -C "$TEST_REMOTE" symbolic-ref HEAD "refs/heads/$(git rev-parse --abbrev-ref HEAD)"

# Stage an uncommitted change so /checkpoint has something to commit
echo "uncommitted change" > pending.txt
git add pending.txt
