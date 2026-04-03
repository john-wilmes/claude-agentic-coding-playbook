// PreToolUse:Bash + PostToolUse:Bash hook — enforces build/typecheck before git push.
//
// PostToolUse: After a successful build command, writes a marker file.
// PreToolUse: Before git push, checks for the marker. Blocks if missing/stale.
//
// Marker is per-repo, stored at /tmp/claude-build-pass-<hash>.
// Marker expires after 30 minutes.

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

const BUILD_PATTERNS = [
  /\bpnpm\s+run\s+build\b/,
  /\bnpm\s+run\s+build\b/,
  /\byarn\s+build\b/,
  /\btsc\b/,
  /\bnpx\s+tsc\b/,
  /\bpnpm\s+run\s+typecheck\b/,
  /\bnpm\s+run\s+typecheck\b/,
  /\bpnpm\s+run\s+type-check\b/,
  /\bnpm\s+run\s+type-check\b/,
];

const PUSH_PATTERN = /^git\s+push\b/;
const MARKER_MAX_AGE_MS = 30 * 60 * 1000;

function markerPath(repoRoot) {
  const hash = crypto.createHash("md5").update(repoRoot).digest("hex").slice(0, 12);
  return path.join(os.tmpdir(), `claude-build-pass-${hash}`);
}

function resolveDir(cmd, cwd) {
  const cdMatch = cmd.match(/^\s*cd\s+(\S+)\s*&&/);
  if (cdMatch) return cdMatch[1];
  const gitCMatch = cmd.match(/git\s+-C\s+["']?([^\s"']+)["']?\s/);
  if (gitCMatch) return gitCMatch[1];
  return cwd || process.cwd();
}

function getRepoRoot(dir) {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf8", timeout: 3000, cwd: dir,
    }).trim();
  } catch { return dir; }
}

function stripCdPrefix(cmd) {
  const m = cmd.match(/^\s*cd\s+\S+\s*&&\s*([\s\S]*)$/);
  return m ? m[1].trim() : cmd.trim();
}

function isBuildCommand(cmd) {
  return BUILD_PATTERNS.some((p) => p.test(cmd));
}

function respond(obj) {
  process.stdout.write(JSON.stringify(obj || {}), () => { process.exitCode = 0; });
}

let input = "";
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    const hookInput = JSON.parse(input);
    const toolName = hookInput.tool_name || "";
    const event = hookInput.event || "";
    const cmd = (hookInput.tool_input?.command || "").normalize("NFKD");

    if (toolName !== "Bash") return respond();

    const dir = resolveDir(cmd, hookInput.cwd);
    const effectiveCmd = stripCdPrefix(cmd);

    // --- PostToolUse: record successful builds ---
    if (event === "PostToolUse") {
      if (!isBuildCommand(effectiveCmd)) return respond();
      // Check exit code — only record on success
      const exitCode = hookInput.tool_result?.exitCode ?? hookInput.tool_result?.status;
      if (exitCode !== 0 && exitCode !== undefined && exitCode !== null) return respond();
      // Check for error indicators in output
      const stdout = hookInput.tool_result?.stdout || "";
      const stderr = hookInput.tool_result?.stderr || "";
      if (/error TS\d+/i.test(stdout) || /error TS\d+/i.test(stderr)) return respond();

      const repoRoot = getRepoRoot(dir);
      const marker = markerPath(repoRoot);
      try {
        fs.writeFileSync(marker, `${new Date().toISOString()}\n${repoRoot}\n`);
      } catch { /* ignore fs errors */ }
      return respond();
    }

    // --- PreToolUse: block push without recent build ---
    if (event !== "PreToolUse") return respond();
    if (!PUSH_PATTERN.test(effectiveCmd)) return respond();

    const repoRoot = getRepoRoot(dir);

    // Only enforce on repos with a build system
    const hasBuild = (
      fs.existsSync(path.join(repoRoot, "tsconfig.json")) ||
      fs.existsSync(path.join(repoRoot, "pnpm-lock.yaml")) ||
      fs.existsSync(path.join(repoRoot, "package-lock.json"))
    );
    if (!hasBuild) return respond();

    // Check for fresh build marker
    const marker = markerPath(repoRoot);
    try {
      if (fs.existsSync(marker)) {
        const stat = fs.statSync(marker);
        if (Date.now() - stat.mtimeMs < MARKER_MAX_AGE_MS) return respond();
      }
    } catch { return respond(); } // Don't block on fs errors

    return respond({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: [
          "No successful build/typecheck detected before push.",
          "Run the project's build command first (e.g., `pnpm run build` or `npx tsc`).",
          "This prevents shipping syntax errors and type failures.",
        ].join(" "),
      },
    });
  } catch {
    respond();
  }
});
