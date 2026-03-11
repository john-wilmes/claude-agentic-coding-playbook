// PostToolUse hook: auto-runs tests after Edit/Write on code files.
// Reads test command from project CLAUDE.md. Debounces to avoid spam.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

let capture;
try { capture = require("./knowledge-capture"); } catch { capture = null; }

let log;
try { log = require("./log"); } catch { log = { writeLog() {} }; }

const SKIP_EXTENSIONS = new Set([
  ".md", ".json", ".yaml", ".yml", ".txt", ".toml", ".cfg", ".ini", ".env",
]);

const DEBOUNCE_FILE = path.join(os.homedir(), ".claude", ".verify-last-run");
const DEBOUNCE_MS = 10000;
const TEST_TIMEOUT_MS = 30000;
const MAX_OUTPUT_LINES = 20;

/**
 * Return true if the file should be skipped (non-code file).
 * @param {string} filePath
 * @returns {boolean}
 */
function shouldSkipFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return SKIP_EXTENSIONS.has(ext);
}

/**
 * Extract the test command from CLAUDE.md content.
 * Matches lines like:  Test: `npm test`  or  test: `pytest`
 * @param {string} claudeMdContent
 * @returns {string|null}
 */
function extractTestCommand(claudeMdContent) {
  const match = claudeMdContent.match(/(?:Test|test):\s*`([^`]+)`/);
  return match ? match[1] : null;
}

/**
 * Check whether a run for the given cwd is within the debounce window.
 * @param {string} cwd
 * @returns {boolean} true if we should skip (too soon)
 */
function isDebounced(cwd) {
  try {
    const raw = fs.readFileSync(DEBOUNCE_FILE, "utf8");
    const state = JSON.parse(raw);
    const entry = state[cwd];
    // Support both legacy number entries and new object entries
    const ts = typeof entry === "number" ? entry : (entry && entry.ts);
    if (typeof ts === "number" && Date.now() - ts < DEBOUNCE_MS) {
      return true;
    }
  } catch {
    // File missing or malformed — not debounced
  }
  return false;
}

/**
 * Return the last persisted state for a given cwd, or null if none.
 * @param {string} cwd
 * @returns {{ ts: number, lastPassed: boolean, lastFailOutput: string }|null}
 */
function getLastState(cwd) {
  try {
    const raw = fs.readFileSync(DEBOUNCE_FILE, "utf8");
    const state = JSON.parse(raw);
    const entry = state[cwd];
    if (entry && typeof entry === "object" && "ts" in entry) {
      return entry;
    }
  } catch {
    // File missing or malformed
  }
  return null;
}

/**
 * Update the debounce file with the current run state for cwd.
 * @param {string} cwd
 * @param {boolean} passed
 * @param {string} failOutput
 */
function updateDebounce(cwd, passed, failOutput) {
  let state = {};
  try {
    const raw = fs.readFileSync(DEBOUNCE_FILE, "utf8");
    state = JSON.parse(raw);
  } catch {
    // Start fresh
  }
  state[cwd] = {
    ts: Date.now(),
    lastPassed: passed,
    lastFailOutput: (failOutput || "").slice(0, 500),
  };
  // Ensure parent directory exists
  const dir = path.dirname(DEBOUNCE_FILE);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  fs.writeFileSync(DEBOUNCE_FILE, JSON.stringify(state));
}

// Read hook input from stdin
let input = "";
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    const hookInput = JSON.parse(input);

    // Subagents have disposable context — skip verification.
    if (hookInput.agent_id) {
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    const toolName = hookInput.tool_name || "";
    const toolInput = hookInput.tool_input || {};
    const cwd = hookInput.cwd || process.cwd();

    // Only act on Edit or Write tool calls
    if (toolName !== "Edit" && toolName !== "Write") {
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    const filePath = toolInput.file_path || "";

    // Skip non-code files
    if (shouldSkipFile(filePath)) {
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    // Read CLAUDE.md and extract test command
    const claudeMdPath = path.join(cwd, "CLAUDE.md");
    let claudeMdContent = "";
    try {
      claudeMdContent = fs.readFileSync(claudeMdPath, "utf8");
    } catch {
      // No CLAUDE.md — can't verify
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    const testCommand = extractTestCommand(claudeMdContent);
    if (!testCommand) {
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    // Debounce: skip if run too recently for this cwd
    if (isDebounced(cwd)) {
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    // Capture previous state before overwriting it
    const previousState = getLastState(cwd);

    // Run tests
    const start = Date.now();
    let additionalContext;
    let testPassed = false;
    let failOutput = "";
    try {
      execSync(testCommand, {
        cwd,
        timeout: TEST_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const duration = Date.now() - start;
      additionalContext = `\u2713 Tests passed (${duration}ms)`;
      testPassed = true;
    } catch (err) {
      const rawOutput = [err.stdout, err.stderr]
        .filter(Boolean)
        .map((b) => (Buffer.isBuffer(b) ? b.toString("utf8") : String(b)))
        .join("\n")
        .trimEnd();
      const lines = rawOutput.split("\n").slice(0, MAX_OUTPUT_LINES).join("\n");
      additionalContext = `\u2717 Tests failed:\n${lines}`;
      failOutput = rawOutput;
    }

    // Update debounce state after run
    updateDebounce(cwd, testPassed, failOutput);

    // Detect fail→pass transition and stage a knowledge candidate
    if (testPassed && capture && previousState && previousState.lastPassed === false) {
      capture.stageCandidate({
        session_id: hookInput.session_id || "unknown",
        trigger: "test-fix",
        tool: toolName,
        category: "gotcha",
        confidence: "medium",
        summary: (previousState.lastFailOutput || "").split("\n")[0].slice(0, 200),
        context_snippet: (previousState.lastFailOutput || "").slice(0, 500),
        source_project: path.basename(cwd),
        cwd: cwd,
      });
      log.writeLog({
        hook: "post-tool-verify",
        event: "knowledge-staged",
        session_id: hookInput.session_id,
        details: "test-fix transition staged as knowledge candidate",
        project: cwd,
      });
    }

    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { additionalContext } })
    );
    process.exit(0);
  } catch {
    // Never block tool execution on hook errors
    process.stdout.write("{}");
    process.exit(0);
  }
});

// Export for testing
if (typeof module !== "undefined") {
  module.exports = { extractTestCommand, shouldSkipFile, getLastState };
}
