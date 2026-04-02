// PreToolUse:Bash hook — blocks git commit on main/master branch.
// Runs synchronously via execSync to check current branch before allowing commit.

const { execSync } = require("child_process");

let input = "";
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    const hookInput = JSON.parse(input);
    const cmd = (hookInput.tool_input?.command || "").normalize("NFKD");

    // Only care about git commit commands
    if (!/\bgit\s+commit\b/.test(cmd)) {
      return process.stdout.write(JSON.stringify({}), () => { process.exitCode = 0; });
    }

    // Check current branch
    let branch = "";
    try {
      branch = execSync("git branch --show-current", {
        encoding: "utf8",
        timeout: 3000,
        cwd: hookInput.cwd || process.cwd(),
      }).trim();
    } catch {
      // Can't determine branch — allow (don't block on git errors)
      return process.stdout.write(JSON.stringify({}), () => { process.exitCode = 0; });
    }

    if (branch === "main" || branch === "master") {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `Cannot commit directly to ${branch}. Create a feature branch first: git checkout -b feat/<name>`,
        },
      }));
    } else {
      process.stdout.write(JSON.stringify({}));
    }
  } catch {
    process.stdout.write(JSON.stringify({}));
  }
  process.exitCode = 0;
});
