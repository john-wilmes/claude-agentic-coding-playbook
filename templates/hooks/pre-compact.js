// PreCompact hook: saves an emergency snapshot to MEMORY.md before compaction.
//
// Captures current git branch and modified files so that post-compaction
// /continue has concrete state to resume from.
//
// State file in /tmp/claude-pre-compact/ prevents duplicate snapshots within
// the same session (one snapshot per session_id is enough).
//
// On any error, outputs {} and exits 0 — never blocks compaction.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

function getStateDir() {
  const dir = path.join(os.tmpdir(), "claude-pre-compact");
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

function alreadySnapshotted(sessionId) {
  const stateFile = path.join(getStateDir(), `${sessionId}.done`);
  if (fs.existsSync(stateFile)) return true;
  try { fs.writeFileSync(stateFile, "1"); } catch {}
  return false;
}

function runGit(cmd, cwd) {
  try {
    return execSync(cmd, { cwd, encoding: "utf8", timeout: 5000 }).trim();
  } catch {
    return "";
  }
}

// Convert a cwd path to the ~/.claude/projects/ key format:
//   /home/user/Documents/myproject  ->  -home-user-Documents-myproject
function cwdToProjectKey(cwd) {
  return cwd.replace(/\//g, "-");
}

function findMemoryPath(cwd) {
  const home = os.homedir();
  const key = cwdToProjectKey(cwd);
  const memDir = path.join(home, ".claude", "projects", key, "memory");
  const memFile = path.join(memDir, "MEMORY.md");
  try { fs.mkdirSync(memDir, { recursive: true }); } catch {}
  return memFile;
}

function buildSnapshotSection(trigger, branch, modifiedFiles) {
  const ts = new Date().toISOString();
  const fileList = modifiedFiles.length > 0
    ? modifiedFiles.map((f) => `  - ${f}`).join("\n")
    : "  (none)";
  return [
    `## Pre-compact snapshot`,
    ``,
    `- **Timestamp**: ${ts}`,
    `- **Trigger**: ${trigger}`,
    `- **Branch**: ${branch || "(unknown)"}`,
    `- **Modified files**:`,
    fileList,
    ``,
  ].join("\n");
}

function upsertSnapshot(memFile, snapshotSection) {
  let existing = "";
  try { existing = fs.readFileSync(memFile, "utf8"); } catch {}

  // If a previous Pre-compact snapshot section exists, replace it.
  // Otherwise append at the end — avoids pushing Current Work past
  // the 200-line truncation boundary.
  const HEADER = "## Pre-compact snapshot";
  if (existing.includes(HEADER)) {
    // Replace from the header to the next ## section (or end of file)
    const replaced = existing.replace(
      /## Pre-compact snapshot[\s\S]*?(?=\n## |\n# |$)/,
      snapshotSection.trimEnd()
    );
    fs.writeFileSync(memFile, replaced + (replaced.endsWith("\n") ? "" : "\n"));
  } else {
    // Append at the end so it does not push existing content past truncation
    const sep = existing.endsWith("\n") ? "\n" : "\n\n";
    fs.writeFileSync(memFile, existing + sep + snapshotSection);
  }
}

let input = "";
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    const hookInput = JSON.parse(input);
    const sessionId = hookInput.session_id || "unknown";
    const cwd = hookInput.cwd || process.cwd();
    const trigger = hookInput.trigger || "manual";

    // Deduplicate: one snapshot per session is enough
    if (alreadySnapshotted(sessionId)) {
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    const branch = runGit("git rev-parse --abbrev-ref HEAD", cwd);
    const statusRaw = runGit("git status --porcelain", cwd);
    const modifiedFiles = statusRaw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    const memFile = findMemoryPath(cwd);
    const snapshotSection = buildSnapshotSection(trigger, branch, modifiedFiles);
    upsertSnapshot(memFile, snapshotSection);

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreCompact",
        additionalContext:
          "Pre-compact snapshot saved. Run /continue after compaction.",
      },
    }));
    process.exit(0);
  } catch {
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }
});
