// PostToolUse hook: auto-runs tests after Edit/Write on code files.
// Reads test command from project CLAUDE.md. Debounces to avoid spam.

const crypto = require("crypto");
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

// Per-session debounce files live in /tmp to avoid cross-session collisions.
// The global ~/.claude/.verify-last-run is kept only for state (lastPassed,
// lastFailOutput) which is intentionally shared across sessions for the same cwd.
const STATE_FILE = path.join(os.homedir(), ".claude", ".verify-last-run");
const DEBOUNCE_DIR = path.join(os.tmpdir(), "claude-post-tool-verify");
const DEBOUNCE_MS = 10000;
const TEST_TIMEOUT_MS = 30000;
const MAX_OUTPUT_LINES = 20;

function getDebounceFile(sessionId) {
  try { fs.mkdirSync(DEBOUNCE_DIR, { mode: 0o700, recursive: true }); } catch {}
  // Hash the sessionId so a crafted session ID cannot escape DEBOUNCE_DIR via path traversal.
  const safeKey = crypto.createHash("sha256").update(sessionId || "unknown").digest("hex").slice(0, 16);
  return path.join(DEBOUNCE_DIR, `${safeKey}.json`);
}

/**
 * Return true if the file should be skipped (non-code file).
 * @param {string} filePath
 * @returns {boolean}
 */
function shouldSkipFile(filePath) {
  // Skip dotfiles (e.g. .wslconfig, .gitignore) — not project code
  if (path.basename(filePath).startsWith(".")) return true;
  const ext = path.extname(filePath).toLowerCase();
  return SKIP_EXTENSIONS.has(ext);
}

/**
 * Return true if the file is outside the project working directory.
 * @param {string} filePath
 * @param {string} cwd
 * @returns {boolean}
 */
function isOutOfProject(filePath, cwd) {
  if (!filePath || !cwd) return false;
  const resolvedCwd = path.resolve(cwd);
  const resolved = path.resolve(resolvedCwd, filePath);
  return !resolved.startsWith(resolvedCwd + path.sep) && resolved !== resolvedCwd;
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
 * Check whether a run for the given cwd+session is within the debounce window.
 * Uses a per-session file in /tmp to avoid cross-session write contention.
 * @param {string} cwd
 * @param {string} sessionId
 * @returns {boolean} true if we should skip (too soon)
 */
function isDebounced(cwd, sessionId) {
  try {
    const raw = fs.readFileSync(getDebounceFile(sessionId), "utf8");
    const state = JSON.parse(raw);
    const entry = state[cwd];
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
 * Return the last persisted cross-session state for a given cwd, or null.
 * Reads from the shared STATE_FILE which records test pass/fail outcomes.
 * @param {string} cwd
 * @returns {{ ts: number, lastPassed: boolean, lastFailOutput: string }|null}
 */
function getLastState(cwd) {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
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
 * Update debounce (per-session) and shared state (cross-session) for cwd.
 * @param {string} cwd
 * @param {string} sessionId
 * @param {boolean} passed
 * @param {string} failOutput
 */
function updateDebounce(cwd, sessionId, passed, failOutput) {
  const entry = {
    ts: Date.now(),
    lastPassed: passed,
    lastFailOutput: (failOutput || "").slice(0, 500),
  };

  // Update per-session debounce file (no contention risk)
  try {
    const debounceFile = getDebounceFile(sessionId);
    let dstate = {};
    try { dstate = JSON.parse(fs.readFileSync(debounceFile, "utf8")); } catch {}
    dstate[cwd] = entry;
    fs.writeFileSync(debounceFile, JSON.stringify(dstate));
  } catch {}

  // Update shared state file (cross-session test outcomes)
  try {
    let sstate = {};
    try { sstate = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch {}
    sstate[cwd] = entry;
    const dir = path.dirname(STATE_FILE);
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    fs.writeFileSync(STATE_FILE, JSON.stringify(sstate));
  } catch {}
}

/**
 * Return true if cmd starts with a known safe test runner prefix.
 * The prefix must be followed by a space or be the entire string (word boundary).
 * @param {string} cmd
 * @returns {boolean}
 */
// Shell prefixes that need extra validation (only allow literal file path after them)
const SHELL_PREFIXES = new Set(["bash", "sh", "zsh", "for", "python", "python3", "ruby", "node"]);

// Dangerous patterns — applied to ALL commands (not just shell prefixes) to prevent
// chaining attacks like "npm test; curl evil.com" or "jest && rm -rf /"
const SHELL_DANGER_PATTERNS = /[|;]|&&|\|\||[`]|\$\(|[><]|\bcurl\b|\bwget\b|\bnc\b|\bncat\b/;

// Additional danger patterns for interpreted languages with inline execution.
// When python/ruby/node use -c/-e flags, also check for dangerous operations.
const INLINE_EXEC_DANGER = /\b(?:python3?|ruby|node)\s+-(c|e)\s+.*(?:\bimport\s+os\b|\bos\.system\b|\bsubprocess\b|\beval\b|\bexec\b|\bsystem\b|\b`[^`]+`)/i;

function isAllowedTestCommand(cmd) {
  if (!cmd || typeof cmd !== "string") return false;
  const trimmed = cmd.trim();
  if (!trimmed) return false;

  const ALLOWED_PREFIXES = [
    "npm", "npx", "node", "jest", "mocha",
    "pytest", "python", "cargo", "go", "make",
    "bash", "sh", "for",
    "ruby", "bundle", "dotnet", "gradle", "mvn", "ant",
  ];

  const matched = ALLOWED_PREFIXES.some((prefix) => {
    if (!trimmed.startsWith(prefix)) return false;
    // Word boundary: prefix must be entire string or followed by a space
    return trimmed.length === prefix.length || trimmed[prefix.length] === " ";
  });

  if (!matched) return false;

  // Reject commands with dangerous shell chaining/exfiltration patterns.
  // Applied to ALL commands (not just shell prefixes) to prevent attacks like
  // "npm test; curl evil.com" or "jest && rm -rf /".
  if (SHELL_DANGER_PATTERNS.test(trimmed)) return false;

  // Reject dangerous inline code execution via python/ruby/node -c/-e flags
  if (INLINE_EXEC_DANGER.test(trimmed)) return false;

  return true;
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
    const sessionId = hookInput.session_id || "unknown";

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

    // Skip files outside the project directory (e.g. ~/.wslconfig)
    if (isOutOfProject(filePath, cwd)) {
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

    // Debounce: skip if run too recently for this cwd+session
    if (isDebounced(cwd, sessionId)) {
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    // Capture previous state before overwriting it
    const previousState = getLastState(cwd);

    // Validate test command against allowlist before executing
    if (!isAllowedTestCommand(testCommand)) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          additionalContext: `⚠ post-tool-verify: blocked untrusted test command "${testCommand.trim().split(/\s+/)[0]}". Only standard test runners are allowed.`
        }
      }));
      process.exit(0);
    }

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
    updateDebounce(cwd, sessionId, testPassed, failOutput);

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
  module.exports = { extractTestCommand, shouldSkipFile, isOutOfProject, getLastState, isAllowedTestCommand };
}
