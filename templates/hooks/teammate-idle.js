// TeammateIdle hook: nudge idle teammates to check TaskList.
//
// When a teammate goes idle, this hook checks if they have uncompleted
// tasks by nudging them to check TaskList. Exit code 2 per the
// TeammateIdle protocol keeps the teammate working instead of going idle.
//
// Main agent idles are ignored (no agent_id).
// On any error, outputs {} and exits 0 — never blocks.

const NUDGE_MESSAGE =
  "You went idle but may have remaining tasks. Run TaskList to check for unfinished work before going idle.";

function processHookInput(hookInput) {
  if (hookInput && hookInput.agent_id) {
    return {
      exitCode: 2,
      output: {
        hookSpecificOutput: {
          hookEventName: "TeammateIdle",
          additionalContext: NUDGE_MESSAGE,
        },
      },
    };
  }
  return { exitCode: 0, output: {} };
}

let input = "";
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    const hookInput = JSON.parse(input);
    const { exitCode, output } = processHookInput(hookInput);
    process.stdout.write(JSON.stringify(output), () => process.exit(exitCode));
  } catch {
    process.stdout.write(JSON.stringify({}), () => process.exit(0));
  }
});

if (typeof module !== "undefined") {
  module.exports = { processHookInput };
}
