// PostToolUse hook: warns when .skip is added to test files without a documenting comment.
// Enforces CLAUDE.md rule: "All .skip additions to tests require a code comment documenting the root cause."
// Advisory only — emits additionalContext warning, does not block.

function respond(payload = {}) {
  process.stdout.write(JSON.stringify(payload), () => process.exit(0));
}

let log;
try { log = require("./log"); } catch { log = { writeLog() {} }; }

// Detect .skip patterns common in JS/TS test frameworks
const SKIP_PATTERNS = [
  /\b(?:it|test|describe|suite)\.skip\s*\(/,
  /\bxit\s*\(/,
  /\bxdescribe\s*\(/,
  /\bxtest\s*\(/,
  /\.skip\(\)/,
];

// Check if a line has a comment explaining the skip
function hasDocumentingComment(line, prevLine, nextLine) {
  // Inline comment on the same line, but exclude :// (URLs)
  const lineNoUrls = line.replace(/https?:\/\/\S+/g, "");
  if (/\/\/\s*\S/.test(lineNoUrls) && lineNoUrls.indexOf("//") > line.search(/\.skip|^x(?:it|describe|test)/)) return true;
  // Block comment on the same line
  if (/\/\*.*\*\//.test(line)) return true;
  // Comment on preceding line
  if (prevLine && /^\s*\/\/\s*\S/.test(prevLine)) return true;
  if (prevLine && /^\s*\/\*/.test(prevLine)) return true;
  // Comment on following line (less common but acceptable)
  if (nextLine && /^\s*\/\/\s*\S/.test(nextLine)) return true;
  return false;
}

// Check if a file path looks like a test file
function isTestFile(filePath) {
  if (!filePath) return false;
  const base = filePath.replace(/\\/g, "/");
  return /\.(?:test|spec)\.[jt]sx?$/.test(base) || /\btests?\//.test(base) || /__tests__\//.test(base);
}

let input = "";
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    const hookInput = JSON.parse(input);
    const toolName = hookInput.tool_name || "";
    const toolInput = hookInput.tool_input || {};

    // Only check Edit and Write tool calls
    if (toolName !== "Edit" && toolName !== "Write") return respond();

    const filePath = toolInput.file_path || "";
    if (!isTestFile(filePath)) return respond();

    // Get the content being written
    const content = toolName === "Write"
      ? (toolInput.content || "")
      : (toolInput.new_string || "");

    if (!content) return respond();

    const lines = content.split("\n");
    const undocumentedSkips = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const hasSkip = SKIP_PATTERNS.some(p => p.test(line));
      if (!hasSkip) continue;

      const prevLine = i > 0 ? lines[i - 1] : "";
      const nextLine = i < lines.length - 1 ? lines[i + 1] : "";
      if (!hasDocumentingComment(line, prevLine, nextLine)) {
        undocumentedSkips.push({ lineIndex: i + 1, text: line.trim() });
      }
    }

    if (undocumentedSkips.length === 0) return respond();

    const details = undocumentedSkips
      .map(s => `  Line ${s.lineIndex}: ${s.text}`)
      .join("\n");

    log.writeLog({ hook: "skip-comment-guard", event: "warn", details: `${undocumentedSkips.length} undocumented .skip in ${filePath}` });
    return respond({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: `⚠ .skip without documenting comment detected in ${filePath}:\n${details}\nAll .skip additions require a code comment explaining the root cause (e.g., // skip: flaky on CI due to timing issue #123).`,
      },
    });
  } catch {
    return respond();
  }
});

if (typeof module !== "undefined") {
  module.exports = { SKIP_PATTERNS, hasDocumentingComment, isTestFile };
}
