#!/usr/bin/env node
// fleet-index.js — Core indexer engine for the repo-fleet-index tool.
// Auto-generates per-repo manifests from code signals, builds a BM25 search
// index, and produces a compact fleet digest for session-start injection.
//
// Zero npm dependencies — Node stdlib only (fs, path, os, crypto, child_process).
// Exit 0 always — errors produce graceful fallbacks.
// JSON stdout for structured output.

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

// ─── BM25 import ─────────────────────────────────────────────────────────────

// At install time hooks live in ~/.claude/hooks/; during development they live
// at ../hooks/ relative to this file. Try both.
let bm25;
try {
  bm25 = require(path.join(os.homedir(), ".claude", "hooks", "bm25.js"));
} catch {
  try {
    bm25 = require(path.join(__dirname, "..", "hooks", "bm25.js"));
  } catch {
    // Provide stub so the module stays functional even without bm25
    bm25 = {
      tokenize: (t) => (t || "").toLowerCase().split(/\W+/).filter(Boolean),
      buildIndex: () => ({ docs: new Map(), df: new Map(), avgdl: 0, N: 0 }),
      query: () => [],
    };
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SCHEMA_VERSION = 1;

const QUALITY_FIELDS = [
  "kind", "name", "repo", "description", "language",
  "framework", "runtime", "owner", "lifecycle",
];

const FRAMEWORK_PATTERNS = {
  // npm/yarn
  express:    { lang: "javascript", fw: "express" },
  fastify:    { lang: "javascript", fw: "fastify" },
  koa:        { lang: "javascript", fw: "koa" },
  hapi:       { lang: "javascript", fw: "hapi" },
  next:       { lang: "typescript", fw: "next" },
  nuxt:       { lang: "javascript", fw: "nuxt" },
  react:      { lang: "javascript", fw: "react" },
  vue:        { lang: "javascript", fw: "vue" },
  nestjs:     { lang: "typescript", fw: "nestjs" },
  "@nestjs/core": { lang: "typescript", fw: "nestjs" },
  // python
  fastapi:    { lang: "python", fw: "fastapi" },
  flask:      { lang: "python", fw: "flask" },
  django:     { lang: "python", fw: "django" },
  starlette:  { lang: "python", fw: "starlette" },
  // go (go.mod module paths)
  "github.com/gin-gonic/gin":    { lang: "go", fw: "gin" },
  "github.com/labstack/echo":    { lang: "go", fw: "echo" },
  "github.com/gofiber/fiber":    { lang: "go", fw: "fiber" },
  // rust (Cargo.toml)
  actix:      { lang: "rust", fw: "actix" },
  "actix-web": { lang: "rust", fw: "actix" },
  rocket:     { lang: "rust", fw: "rocket" },
  axum:       { lang: "rust", fw: "axum" },
  warp:       { lang: "rust", fw: "warp" },
};

// ─── Minimal YAML parser ─────────────────────────────────────────────────────

/**
 * Parse a minimal .fleet.yaml file.
 * Handles flat key: value pairs, inline arrays [a, b], and
 * depends_on as a sequence of objects (- repo: ..., via: ..., confidence: ...).
 *
 * @param {string} text
 * @returns {object}
 */
function parseFleetYaml(text) {
  if (!text || typeof text !== "string") return {};
  const root = {};
  let currentKey = null;
  let currentArray = null;
  let currentArrayIndent = -1;
  let currentObj = null;

  function coerce(v) {
    if (v === "true") return true;
    if (v === "false") return false;
    const n = Number(v);
    if (!isNaN(n) && v.trim() !== "") return n;
    return v;
  }

  function stripQ(s) {
    if (!s) return s;
    if ((s.startsWith('"') && s.endsWith('"')) ||
        (s.startsWith("'") && s.endsWith("'"))) {
      return s.slice(1, -1);
    }
    return s;
  }

  for (const raw of text.split("\n")) {
    // Strip inline comments
    const ci = raw.indexOf(" #");
    const stripped = ci >= 0 ? raw.slice(0, ci) : raw;
    const line = stripped.trimEnd();
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const indent = line.length - line.trimStart().length;
    const trimmed = line.trimStart();

    if (trimmed.startsWith("- ")) {
      const item = trimmed.slice(2).trim();
      if (item.includes(": ")) {
        // Object item: - key: value
        const ci2 = item.indexOf(": ");
        const k = item.slice(0, ci2).trim();
        const v = stripQ(item.slice(ci2 + 2).trim());
        if (currentArray !== null) {
          if (k === "repo" || k === "external" || currentObj === null) {
            currentObj = {};
            currentArray.push(currentObj);
          }
          currentObj[k] = v;
        }
      } else {
        // String item
        const v = stripQ(item);
        if (currentArray !== null) {
          currentArray.push(v);
        }
      }
    } else if (trimmed.includes(": ")) {
      const ci2 = trimmed.indexOf(": ");
      const k = trimmed.slice(0, ci2).trim();
      const v = stripQ(trimmed.slice(ci2 + 2).trim());

      if (indent === 0) {
        if (v === "") {
          // Block mapping start
          root[k] = [];
          currentArray = root[k];
          currentArrayIndent = indent;
          currentKey = k;
          currentObj = null;
        } else {
          // Inline array: key: [a, b, c]
          if (v.startsWith("[") && v.endsWith("]")) {
            root[k] = v.slice(1, -1)
              .split(",")
              .map(s => stripQ(s.trim()))
              .filter(Boolean);
          } else {
            root[k] = coerce(v);
          }
          currentKey = k;
          currentArray = null;
          currentObj = null;
        }
      } else if (indent > 0 && currentObj !== null && indent > currentArrayIndent) {
        // Continuation key on current array object
        currentObj[k] = v;
      }
    } else if (trimmed.endsWith(":")) {
      const k = trimmed.slice(0, -1).trim();
      if (indent === 0) {
        root[k] = [];
        currentArray = root[k];
        currentArrayIndent = indent;
        currentKey = k;
        currentObj = null;
      }
    }
  }

  return root;
}

// ─── Signal extraction helpers ───────────────────────────────────────────────

/**
 * Safely read a file, returning null on any error.
 * @param {string} filePath
 * @returns {string|null}
 */
function safeRead(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

/**
 * Extract the first paragraph from a README (skip headings + blank lines).
 * A paragraph = consecutive non-blank lines.
 * @param {string} content
 * @returns {string}
 */
function extractReadmeDescription(content) {
  if (!content) return "";
  const lines = content.split("\n").slice(0, 100);
  const para = [];
  let inPara = false;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith("#")) continue;
    if (!t) {
      if (inPara) break; // End of first paragraph
      continue;
    }
    inPara = true;
    para.push(t);
  }
  return para.join(" ").trim();
}

/**
 * Parse package.json and extract name, language, framework, deps.
 * @param {string} content
 * @returns {{ name: string, language: string, framework: string, deps: string[] }}
 */
function parsePackageJson(content) {
  try {
    const pkg = JSON.parse(content);
    const allDeps = Object.keys({
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {}),
    });

    let language = "javascript";
    if (allDeps.includes("typescript") || allDeps.some(d => d.startsWith("@types/"))) {
      language = "typescript";
    }

    let framework = "";
    for (const dep of allDeps) {
      const match = FRAMEWORK_PATTERNS[dep];
      if (match) {
        framework = match.fw;
        language = match.lang;
        break;
      }
    }

    return { name: pkg.name || "", language, framework, deps: allDeps };
  } catch {
    return { name: "", language: "javascript", framework: "", deps: [] };
  }
}

/**
 * Parse pyproject.toml for name, deps, framework.
 * @param {string} content
 * @returns {{ name: string, language: string, framework: string, deps: string[] }}
 */
function parsePyprojectToml(content) {
  if (!content) return { name: "", language: "python", framework: "", deps: [] };
  const nameMatch = content.match(/^name\s*=\s*["']([^"']+)["']/m);
  const name = nameMatch ? nameMatch[1] : "";
  // Gather deps from dependencies = [...] or install_requires = [...]
  const deps = [];
  const depMatches = content.matchAll(/["']([a-zA-Z0-9_-]+)/g);
  for (const m of depMatches) deps.push(m[1].toLowerCase());

  let framework = "";
  for (const dep of deps) {
    const match = FRAMEWORK_PATTERNS[dep];
    if (match) { framework = match.fw; break; }
  }
  return { name, language: "python", framework, deps };
}

/**
 * Parse go.mod for module name, deps.
 * @param {string} content
 * @returns {{ name: string, language: string, framework: string, deps: string[] }}
 */
function parseGoMod(content) {
  if (!content) return { name: "", language: "go", framework: "", deps: [] };
  const moduleMatch = content.match(/^module\s+(\S+)/m);
  const name = moduleMatch ? moduleMatch[1].split("/").pop() : "";
  const deps = [];
  const reqSection = content.match(/require\s*\(([\s\S]*?)\)/);
  if (reqSection) {
    for (const line of reqSection[1].split("\n")) {
      const m = line.trim().match(/^(\S+)/);
      if (m) deps.push(m[1]);
    }
  }
  let framework = "";
  for (const dep of deps) {
    const match = FRAMEWORK_PATTERNS[dep];
    if (match) { framework = match.fw; break; }
  }
  return { name, language: "go", framework, deps };
}

/**
 * Parse Cargo.toml for name, deps.
 * @param {string} content
 * @returns {{ name: string, language: string, framework: string, deps: string[] }}
 */
function parseCargoToml(content) {
  if (!content) return { name: "", language: "rust", framework: "", deps: [] };
  const nameMatch = content.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
  const name = nameMatch ? nameMatch[1] : "";
  const deps = [];
  const depMatches = content.matchAll(/^\s*([a-zA-Z0-9_-]+)\s*=/mg);
  for (const m of depMatches) deps.push(m[1].toLowerCase());
  let framework = "";
  for (const dep of deps) {
    const match = FRAMEWORK_PATTERNS[dep];
    if (match) { framework = match.fw; break; }
  }
  return { name, language: "rust", framework, deps };
}

/**
 * Infer repo kind from directory layout.
 * @param {string} repoPath
 * @param {boolean} hasDockerfile
 * @param {boolean} hasDockerCompose
 * @returns {string}
 */
function inferKind(repoPath, hasDockerfile, hasDockerCompose) {
  try {
    // Infra: has terraform/ or infra/ directory
    if (
      fs.existsSync(path.join(repoPath, "terraform")) ||
      fs.existsSync(path.join(repoPath, "infra"))
    ) {
      return "infra";
    }
    // Service: has Dockerfile or docker-compose
    if (hasDockerfile || hasDockerCompose) {
      return "service";
    }
    // Library: has a package manifest but no obvious app entry point
    const entries = fs.readdirSync(repoPath);
    const hasManifest =
      entries.includes("package.json") ||
      entries.includes("pyproject.toml") ||
      entries.includes("go.mod") ||
      entries.includes("Cargo.toml");
    const hasServerEntry =
      entries.some(e => /^(server|app|main|index)\.(js|ts|py|go|rs)$/.test(e)) ||
      fs.existsSync(path.join(repoPath, "src", "main.rs")) ||
      fs.existsSync(path.join(repoPath, "cmd")) ||
      fs.existsSync(path.join(repoPath, "bin"));
    if (hasManifest && !hasServerEntry) {
      return "library";
    }
  } catch {}
  return "tool";
}

/**
 * Extract EXPOSE and port mappings from a Dockerfile.
 * @param {string} content
 * @returns {number[]}
 */
function extractDockerfilePorts(content) {
  if (!content) return [];
  const ports = [];
  for (const m of content.matchAll(/^EXPOSE\s+(\d+)/gm)) {
    const p = parseInt(m[1], 10);
    if (!isNaN(p)) ports.push(p);
  }
  return ports;
}

/**
 * Extract port mappings from docker-compose.yml content.
 * @param {string} content
 * @returns {number[]}
 */
function extractDockerComposePorts(content) {
  if (!content) return [];
  const ports = [];
  // Match: "- 3000:3000" or "- '3000:3000'" or "- 3000"
  for (const m of content.matchAll(/["']?(\d+):\d+["']?/g)) {
    const p = parseInt(m[1], 10);
    if (!isNaN(p)) ports.push(p);
  }
  return [...new Set(ports)];
}

/**
 * Extract deploy targets and environments from CI YAML files.
 * @param {string} ciDir  — path to .github/workflows/
 * @returns {{ deployTargets: string[], environments: string[] }}
 */
function extractCiSignals(ciDir) {
  const deployTargets = new Set();
  const environments = new Set();
  try {
    if (!fs.existsSync(ciDir)) return { deployTargets: [], environments: [] };
    for (const f of fs.readdirSync(ciDir)) {
      if (!f.endsWith(".yml") && !f.endsWith(".yaml")) continue;
      const content = safeRead(path.join(ciDir, f)) || "";
      // Common deploy target patterns
      for (const m of content.matchAll(
        /(?:deploy[-_]to|environment|env):\s*["']?([a-zA-Z0-9_-]+)/gi
      )) {
        environments.add(m[1]);
      }
      // AWS, GCP, Heroku, Fly, Vercel, Netlify keywords
      if (/aws|eks|ecs|lambda/i.test(content)) deployTargets.add("aws");
      if (/gcp|gke|cloud.run/i.test(content)) deployTargets.add("gcp");
      if (/heroku/i.test(content)) deployTargets.add("heroku");
      if (/fly\.io|flyctl/i.test(content)) deployTargets.add("fly");
      if (/vercel/i.test(content)) deployTargets.add("vercel");
      if (/netlify/i.test(content)) deployTargets.add("netlify");
    }
  } catch {}
  return { deployTargets: [...deployTargets], environments: [...environments] };
}

/**
 * Extract owner from CODEOWNERS file.
 * Returns the first non-comment, non-blank owner token.
 * @param {string} content
 * @returns {string}
 */
function extractCodeOwner(content) {
  if (!content) return "";
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const parts = t.split(/\s+/);
    // Parts: pattern owner1 owner2 ...
    if (parts.length >= 2) return parts[1];
    if (parts.length === 1 && parts[0].startsWith("@")) return parts[0];
  }
  return "";
}

/**
 * Extract env var names (not values) from .env.example.
 * @param {string} content
 * @returns {string[]}
 */
function extractEnvVarNames(content) {
  if (!content) return [];
  const names = [];
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const m = t.match(/^([A-Z_][A-Z0-9_]*)(?:\s*=|$)/);
    if (m) names.push(m[1]);
  }
  return names;
}

/**
 * Extract API surface from OpenAPI/Swagger spec (JSON or YAML).
 * Returns array of { path, method } objects.
 * @param {string} content
 * @param {string} specFile — filename for the spec reference
 * @returns {{ path: string, spec: string }[]}
 */
function extractOpenApiPaths(content, specFile) {
  if (!content) return [];
  try {
    // Try JSON parse first
    let spec;
    if (content.trimStart().startsWith("{")) {
      spec = JSON.parse(content);
    } else {
      // Minimal YAML path extraction — find "  /path:" patterns under "paths:"
      const pathMatches = [...content.matchAll(/^\s{2}(\/[^\s:]+)\s*:/gm)];
      const inPathsSection = [];
      let inPaths = false;
      for (const line of content.split("\n")) {
        if (/^paths\s*:/.test(line)) { inPaths = true; continue; }
        if (inPaths && /^\S/.test(line) && !/^paths/.test(line)) inPaths = false;
        if (inPaths) {
          const m = line.match(/^\s{2}(\/[^\s:]+)\s*:/);
          if (m) inPathsSection.push(m[1]);
        }
      }
      return inPathsSection.slice(0, 20).map(p => ({ path: p, spec: specFile }));
    }
    const paths = spec.paths || {};
    return Object.keys(paths).slice(0, 20).map(p => ({ path: p, spec: specFile }));
  } catch {
    return [];
  }
}

/**
 * Get current HEAD commit hash for a repo directory.
 * @param {string} repoPath
 * @returns {string}
 */
function getHeadHash(repoPath) {
  try {
    const result = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repoPath,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 3000,
    });
    if (result.status === 0) return (result.stdout || "").trim();
  } catch {}
  return "";
}

/**
 * Convert underscore-separated dir name (owner_repo) to slash-separated (owner/repo).
 * If there is no underscore, use the name as-is (single-component).
 * @param {string} dirName
 * @returns {string}
 */
function dirNameToRepo(dirName) {
  const firstUnderscore = dirName.indexOf("_");
  if (firstUnderscore === -1) return dirName;
  return dirName.slice(0, firstUnderscore) + "/" + dirName.slice(firstUnderscore + 1);
}

// ─── Core: extractSignals ─────────────────────────────────────────────────────

/**
 * Scan a single repo directory and extract all available signals.
 *
 * @param {string} repoPath — absolute path to the repo
 * @returns {object} signals
 */
function extractSignals(repoPath) {
  const signals = {
    name: "",
    language: "",
    framework: "",
    description: "",
    owner: "",
    runtime: "",
    ports: [],
    envVars: [],
    dependsOnRaw: [],   // package-level dep names (for cross-fleet matching)
    provides_apis: [],
    tags: [],
    lifecycle: "",
    deployTargets: [],
    environments: [],
    hasDockerfile: false,
    hasDockerCompose: false,
    fleetYaml: null,
  };

  try {
    // README
    const readmePath =
      ["README.md", "README.rst", "README.txt", "readme.md"].find(n =>
        fs.existsSync(path.join(repoPath, n))
      );
    if (readmePath) {
      const content = safeRead(path.join(repoPath, readmePath));
      signals.description = extractReadmeDescription(content);
    }

    // package.json
    const pkgContent = safeRead(path.join(repoPath, "package.json"));
    if (pkgContent) {
      const pkg = parsePackageJson(pkgContent);
      signals.name = signals.name || pkg.name;
      signals.language = signals.language || pkg.language;
      signals.framework = signals.framework || pkg.framework;
      signals.dependsOnRaw = [...signals.dependsOnRaw, ...pkg.deps];
    }

    // pyproject.toml
    const pyContent = safeRead(path.join(repoPath, "pyproject.toml"));
    if (pyContent) {
      const py = parsePyprojectToml(pyContent);
      signals.name = signals.name || py.name;
      signals.language = signals.language || py.language;
      signals.framework = signals.framework || py.framework;
      signals.dependsOnRaw = [...signals.dependsOnRaw, ...py.deps];
    }

    // requirements.txt — just mark as python
    if (!signals.language && fs.existsSync(path.join(repoPath, "requirements.txt"))) {
      signals.language = "python";
    }

    // go.mod
    const goContent = safeRead(path.join(repoPath, "go.mod"));
    if (goContent) {
      const go = parseGoMod(goContent);
      signals.name = signals.name || go.name;
      signals.language = signals.language || go.language;
      signals.framework = signals.framework || go.framework;
      signals.dependsOnRaw = [...signals.dependsOnRaw, ...go.deps];
    }

    // Cargo.toml
    const cargoContent = safeRead(path.join(repoPath, "Cargo.toml"));
    if (cargoContent) {
      const cargo = parseCargoToml(cargoContent);
      signals.name = signals.name || cargo.name;
      signals.language = signals.language || cargo.language;
      signals.framework = signals.framework || cargo.framework;
      signals.dependsOnRaw = [...signals.dependsOnRaw, ...cargo.deps];
    }

    // Dockerfile
    const dockerfileContent = safeRead(path.join(repoPath, "Dockerfile"));
    if (dockerfileContent) {
      signals.hasDockerfile = true;
      signals.runtime = "docker";
      signals.ports = [...signals.ports, ...extractDockerfilePorts(dockerfileContent)];
    }

    // docker-compose.yml / docker-compose.yaml
    const dcFile =
      fs.existsSync(path.join(repoPath, "docker-compose.yml"))
        ? "docker-compose.yml"
        : fs.existsSync(path.join(repoPath, "docker-compose.yaml"))
          ? "docker-compose.yaml"
          : null;
    if (dcFile) {
      signals.hasDockerCompose = true;
      if (!signals.runtime) signals.runtime = "docker";
      const dcContent = safeRead(path.join(repoPath, dcFile));
      signals.ports = [...signals.ports, ...extractDockerComposePorts(dcContent)];
    }

    // CI signals
    const ciDir = path.join(repoPath, ".github", "workflows");
    const ci = extractCiSignals(ciDir);
    signals.deployTargets = ci.deployTargets;
    signals.environments = ci.environments;

    // Derive lifecycle from environment names
    if (signals.environments.some(e => /prod/i.test(e))) {
      signals.lifecycle = "production";
    } else if (signals.environments.some(e => /stag/i.test(e))) {
      signals.lifecycle = "staging";
    } else if (signals.environments.some(e => /dev|local/i.test(e))) {
      signals.lifecycle = "development";
    }

    // CODEOWNERS
    const coFile =
      fs.existsSync(path.join(repoPath, "CODEOWNERS"))
        ? path.join(repoPath, "CODEOWNERS")
        : fs.existsSync(path.join(repoPath, ".github", "CODEOWNERS"))
          ? path.join(repoPath, ".github", "CODEOWNERS")
          : null;
    if (coFile) {
      signals.owner = extractCodeOwner(safeRead(coFile));
    }

    // .env.example
    const envExampleContent = safeRead(path.join(repoPath, ".env.example"));
    if (envExampleContent) {
      signals.envVars = extractEnvVarNames(envExampleContent);
    }

    // OpenAPI / Swagger specs
    const specCandidates = [
      "openapi.yaml", "openapi.json", "swagger.yaml", "swagger.json",
      "docs/openapi.yaml", "docs/openapi.json", "docs/swagger.yaml",
      "api/openapi.yaml", "api/openapi.json",
    ];
    for (const specRel of specCandidates) {
      const specPath = path.join(repoPath, specRel);
      if (fs.existsSync(specPath)) {
        const specContent = safeRead(specPath);
        const apis = extractOpenApiPaths(specContent, specRel);
        signals.provides_apis = [...signals.provides_apis, ...apis];
      }
    }

    // Terraform / infra
    if (
      fs.existsSync(path.join(repoPath, "terraform")) ||
      fs.existsSync(path.join(repoPath, "infra"))
    ) {
      signals.tags.push("tier:platform");
    }

    // .fleet.yaml manual override
    const fleetYamlContent = safeRead(path.join(repoPath, ".fleet.yaml"));
    if (fleetYamlContent) {
      signals.fleetYaml = parseFleetYaml(fleetYamlContent);
    }

    // Deduplicate ports
    signals.ports = [...new Set(signals.ports)];

  } catch {
    // Graceful fallback — return whatever was collected
  }

  return signals;
}

// ─── Core: generateManifest ──────────────────────────────────────────────────

/**
 * Build a manifest object from a repo name and its extracted signals.
 * Also needs the full list of known repo names for cross-fleet dep matching.
 *
 * @param {string} repoName — "owner/repo" format
 * @param {object} signals  — from extractSignals()
 * @param {string[]} allRepoNames — all repo names in the fleet (for dep matching)
 * @returns {object} manifest
 */
function generateManifest(repoName, signals, allRepoNames = []) {
  const repoPath = repoName; // caller is responsible for resolving path

  // Apply .fleet.yaml overrides (highest trust)
  const fy = signals.fleetYaml || {};

  // Determine depends_on
  const dependsOn = [];

  // Cross-fleet deps: check if any package dep matches a known fleet repo name
  const repoShortNames = allRepoNames.map(r => r.split("/").pop());
  const repoFullMap = {};
  allRepoNames.forEach(r => { repoFullMap[r.split("/").pop()] = r; });

  const rawDeps = new Set((signals.dependsOnRaw || []).map(d => d.toLowerCase()));
  for (const short of repoShortNames) {
    if (rawDeps.has(short.toLowerCase())) {
      dependsOn.push({
        repo: repoFullMap[short],
        via: signals.language === "python" ? "pip" :
             signals.language === "go" ? "go.mod" :
             signals.language === "rust" ? "cargo" : "npm",
        confidence: "high",
      });
    }
  }

  // Env-var-based external deps (e.g. DATABASE_URL → postgres, REDIS_URL → redis)
  const envVarDepPatterns = [
    { pattern: /POSTGRES|DATABASE_URL/i, external: "postgres" },
    { pattern: /MYSQL/i,                 external: "mysql" },
    { pattern: /MONGO/i,                 external: "mongodb" },
    { pattern: /REDIS/i,                 external: "redis" },
    { pattern: /ELASTIC/i,               external: "elasticsearch" },
    { pattern: /KAFKA/i,                 external: "kafka" },
    { pattern: /RABBIT/i,                external: "rabbitmq" },
    { pattern: /S3|AWS_BUCKET/i,         external: "s3" },
    { pattern: /SQS/i,                   external: "sqs" },
    { pattern: /SNS/i,                   external: "sns" },
    { pattern: /SENDGRID|SMTP/i,         external: "smtp" },
  ];
  const seenExternals = new Set();
  for (const envVar of (signals.envVars || [])) {
    for (const { pattern, external } of envVarDepPatterns) {
      if (pattern.test(envVar) && !seenExternals.has(external)) {
        seenExternals.add(external);
        dependsOn.push({ external, env_var: envVar, confidence: "medium" });
      }
    }
  }
  // Also check for SERVICE_URL patterns that might reference fleet services
  for (const envVar of (signals.envVars || [])) {
    if (/_URL$/.test(envVar)) {
      const svcName = envVar.replace(/_URL$/, "").toLowerCase().replace(/_/g, "-");
      const fleetMatch = repoShortNames.find(
        s => s.toLowerCase() === svcName || s.toLowerCase().includes(svcName)
      );
      if (fleetMatch && !dependsOn.some(d => d.repo === repoFullMap[fleetMatch])) {
        dependsOn.push({
          repo: repoFullMap[fleetMatch],
          via: "env",
          env_var: envVar,
          confidence: "medium",
        });
      }
    }
  }

  // .fleet.yaml declared deps get highest confidence
  const declaredDeps = (fy.depends_on || []).map(d => ({ ...d, confidence: "declared" }));

  // Build tags — combine auto-detected with fleet.yaml overrides
  const tags = [...(signals.tags || [])];
  if (fy.tags) {
    const fyTags = Array.isArray(fy.tags) ? fy.tags : [fy.tags];
    for (const t of fyTags) {
      if (!tags.includes(t)) tags.push(t);
    }
  }

  const kind =
    fy.kind ||
    inferKind(
      repoName,
      signals.hasDockerfile,
      signals.hasDockerCompose
    );

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    kind,
    name: fy.name || signals.name || repoName.split("/").pop(),
    repo: repoName,
    description: fy.description || signals.description || "",
    language: fy.language || signals.language || "",
    framework: fy.framework || signals.framework || "",
    runtime: fy.runtime || signals.runtime || "",
    ports: fy.ports || signals.ports || [],
    depends_on: [...declaredDeps, ...dependsOn],
    provides_apis: signals.provides_apis || [],
    tags,
    owner: fy.owner || signals.owner || "",
    env_vars: signals.envVars || [],
    lifecycle: fy.lifecycle || signals.lifecycle || "",
    quality: 0,          // filled in below
    lastIndexed: new Date().toISOString(),
    sourceHash: "",      // filled in by buildIndex / refreshIndex
  };

  manifest.quality = computeQuality(manifest);
  if (manifest.quality < 50) manifest.stub = true;

  return manifest;
}

// ─── Core: computeQuality ────────────────────────────────────────────────────

/**
 * Compute a quality score 0-100: fraction of key fields that are non-empty.
 * @param {object} manifest
 * @returns {number}
 */
function computeQuality(manifest) {
  let present = 0;
  for (const field of QUALITY_FIELDS) {
    const v = manifest[field];
    if (v !== undefined && v !== null && v !== "") present++;
  }
  return Math.round((present / QUALITY_FIELDS.length) * 100);
}

// ─── Core: generateDigest ────────────────────────────────────────────────────

/**
 * Generate a compact one-liner-per-repo fleet digest string.
 * @param {object[]} manifests
 * @returns {string}
 */
function generateDigest(manifests) {
  if (!manifests || manifests.length === 0) return "";
  const timestamp = new Date().toISOString();
  const header = `# Fleet Index (${manifests.length} repos, indexed ${timestamp})`;
  const lines = manifests.map(m => {
    const langFw = m.framework ? `${m.language}/${m.framework}` : (m.language || "unknown");
    const primaryTag = (m.tags || []).find(t => t.startsWith("domain:")) ||
                       (m.tags || [])[0] || "";
    const qualStr = `Q:${m.quality}`;
    const stubMark = m.stub ? " warning stub" : "";
    const repoCol = m.repo.padEnd(30);
    const kindCol = (m.kind || "tool").padEnd(8);
    const langCol = langFw.padEnd(20);
    const tagCol = primaryTag.padEnd(20);
    return `${repoCol} | ${kindCol} | ${langCol} | ${tagCol} | ${qualStr}${stubMark}`;
  });
  return [header, ...lines].join("\n");
}

// ─── buildIndex ───────────────────────────────────────────────────────────────

/**
 * Full build: scan all repos in reposDir, generate manifests and digest.
 *
 * @param {string} reposDir  — directory where repos are checked out (owner_repo dirs)
 * @param {string} outputDir — directory to write manifests + digest
 * @param {object} opts      — { verbose: boolean }
 * @returns {{ manifests: object[], digest: string, stats: object }}
 */
function buildIndex(reposDir, outputDir, opts = {}) {
  const result = { manifests: [], digest: "", stats: { total: 0, indexed: 0, errors: 0 } };
  try {
    if (!fs.existsSync(reposDir)) {
      process.stderr.write(`fleet-index: repos dir not found: ${reposDir}\n`);
      return result;
    }

    fs.mkdirSync(outputDir, { recursive: true });

    const entries = fs.readdirSync(reposDir);
    const allRepoNames = entries
      .filter(e => {
        try { return fs.statSync(path.join(reposDir, e)).isDirectory(); } catch { return false; }
      })
      .map(dirNameToRepo);

    result.stats.total = allRepoNames.length;

    const manifests = [];
    for (const dirEntry of entries) {
      const repoPath = path.join(reposDir, dirEntry);
      try {
        if (!fs.statSync(repoPath).isDirectory()) continue;
      } catch { continue; }

      const repoName = dirNameToRepo(dirEntry);
      try {
        const signals = extractSignals(repoPath);
        const manifest = generateManifest(repoName, signals, allRepoNames);
        manifest.sourceHash = getHeadHash(repoPath);

        // Write manifest file
        const manifestFile = path.join(outputDir, `${dirEntry}.json`);
        fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), "utf8");

        manifests.push(manifest);
        result.stats.indexed++;
        if (opts.verbose) {
          process.stderr.write(`  indexed: ${repoName} (Q:${manifest.quality})\n`);
        }
      } catch (e) {
        result.stats.errors++;
        if (opts.verbose) {
          process.stderr.write(`  error indexing ${repoName}: ${e.message}\n`);
        }
      }
    }

    // Generate and write fleet digest
    const digest = generateDigest(manifests);
    fs.writeFileSync(path.join(outputDir, "fleet-digest.txt"), digest, "utf8");

    result.manifests = manifests;
    result.digest = digest;
  } catch (e) {
    process.stderr.write(`fleet-index buildIndex error: ${e.message}\n`);
  }
  return result;
}

// ─── refreshIndex ─────────────────────────────────────────────────────────────

/**
 * Incremental refresh: only re-index repos whose HEAD hash has changed.
 * If targetRepo is provided, only refresh that one repo.
 *
 * @param {string} reposDir
 * @param {string} outputDir
 * @param {object} opts — { targetRepo: string, verbose: boolean }
 * @returns {{ updated: string[], skipped: string[], stats: object }}
 */
function refreshIndex(reposDir, outputDir, opts = {}) {
  const result = { updated: [], skipped: [], stats: { total: 0, updated: 0, skipped: 0, errors: 0 } };
  try {
    if (!fs.existsSync(reposDir)) {
      process.stderr.write(`fleet-index: repos dir not found: ${reposDir}\n`);
      return result;
    }
    fs.mkdirSync(outputDir, { recursive: true });

    let entries = fs.readdirSync(reposDir).filter(e => {
      try { return fs.statSync(path.join(reposDir, e)).isDirectory(); } catch { return false; }
    });

    // Filter to single repo if targetRepo specified
    if (opts.targetRepo) {
      const target = opts.targetRepo.replace("/", "_");
      entries = entries.filter(e => e === target || dirNameToRepo(e) === opts.targetRepo);
      if (entries.length === 0) {
        process.stderr.write(`fleet-index: repo not found: ${opts.targetRepo}\n`);
        return result;
      }
    }

    const allRepoNames = fs.readdirSync(reposDir)
      .filter(e => { try { return fs.statSync(path.join(reposDir, e)).isDirectory(); } catch { return false; } })
      .map(dirNameToRepo);

    result.stats.total = entries.length;

    for (const dirEntry of entries) {
      const repoPath = path.join(reposDir, dirEntry);
      const repoName = dirNameToRepo(dirEntry);
      const manifestFile = path.join(outputDir, `${dirEntry}.json`);

      try {
        const currentHash = getHeadHash(repoPath);
        // Check existing manifest
        let existingManifest = null;
        try {
          existingManifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
        } catch {}

        if (existingManifest && existingManifest.sourceHash === currentHash && currentHash !== "") {
          result.skipped.push(repoName);
          result.stats.skipped++;
          if (opts.verbose) {
            process.stderr.write(`  skipped (unchanged): ${repoName}\n`);
          }
          continue;
        }

        const signals = extractSignals(repoPath);
        const manifest = generateManifest(repoName, signals, allRepoNames);
        manifest.sourceHash = currentHash;

        fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), "utf8");
        result.updated.push(repoName);
        result.stats.updated++;
        if (opts.verbose) {
          process.stderr.write(`  updated: ${repoName} (Q:${manifest.quality})\n`);
        }
      } catch (e) {
        result.stats.errors++;
        if (opts.verbose) {
          process.stderr.write(`  error refreshing ${repoName}: ${e.message}\n`);
        }
      }
    }

    // Regenerate digest from all existing manifests
    const allManifests = loadAllManifests(outputDir);
    const digest = generateDigest(allManifests);
    fs.writeFileSync(path.join(outputDir, "fleet-digest.txt"), digest, "utf8");
  } catch (e) {
    process.stderr.write(`fleet-index refreshIndex error: ${e.message}\n`);
  }
  return result;
}

// ─── searchRepos ─────────────────────────────────────────────────────────────

/**
 * BM25 search over all manifests in outputDir.
 *
 * @param {string} outputDir
 * @param {string} queryText
 * @param {number} limit
 * @returns {{ repo: string, score: number, manifest: object }[]}
 */
function searchRepos(outputDir, queryText, limit = 10) {
  try {
    const manifests = loadAllManifests(outputDir);
    if (manifests.length === 0) return [];

    // Build a text corpus per manifest
    const docs = manifests.map(m => ({
      id: m.repo,
      text: [
        m.name,
        m.description,
        m.language,
        m.framework,
        m.kind,
        (m.tags || []).join(" "),
        (m.env_vars || []).join(" "),
        (m.provides_apis || []).map(a => a.path).join(" "),
        (m.depends_on || []).map(d => d.repo || d.external || "").join(" "),
        m.owner,
      ].filter(Boolean).join(" "),
    }));

    const index = bm25.buildIndex(docs);
    const hits = bm25.query(index, queryText, limit);

    const manifestMap = {};
    for (const m of manifests) manifestMap[m.repo] = m;

    return hits.map(h => ({ repo: h.id, score: h.score, manifest: manifestMap[h.id] || null }));
  } catch {
    return [];
  }
}

// ─── getManifest ─────────────────────────────────────────────────────────────

/**
 * Load a single manifest by repo name.
 *
 * @param {string} outputDir
 * @param {string} repoName — "owner/repo"
 * @returns {object|null}
 */
function getManifest(outputDir, repoName) {
  try {
    const dirEntry = repoName.replace("/", "_");
    const filePath = path.join(outputDir, `${dirEntry}.json`);
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

// ─── listRepos ────────────────────────────────────────────────────────────────

/**
 * List all indexed repos with summary info.
 *
 * @param {string} outputDir
 * @returns {{ repo: string, kind: string, language: string, quality: number }[]}
 */
function listRepos(outputDir) {
  try {
    const manifests = loadAllManifests(outputDir);
    return manifests.map(m => ({
      repo: m.repo,
      kind: m.kind || "",
      language: m.language || "",
      quality: m.quality || 0,
    }));
  } catch {
    return [];
  }
}

// ─── Internal: loadAllManifests ──────────────────────────────────────────────

/**
 * Load all *.json manifest files from outputDir (excluding fleet-digest.txt etc.).
 * @param {string} outputDir
 * @returns {object[]}
 */
function loadAllManifests(outputDir) {
  const manifests = [];
  try {
    if (!fs.existsSync(outputDir)) return manifests;
    for (const f of fs.readdirSync(outputDir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const m = JSON.parse(fs.readFileSync(path.join(outputDir, f), "utf8"));
        if (m && m.repo) manifests.push(m);
      } catch {}
    }
  } catch {}
  return manifests;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);

  const DEFAULT_REPOS_DIR = path.join(os.homedir(), ".claude", "repos");
  const DEFAULT_OUTPUT_DIR = path.join(os.homedir(), ".claude", "fleet");

  let reposDir = DEFAULT_REPOS_DIR;
  let outputDir = DEFAULT_OUTPUT_DIR;
  let command = null;
  let commandArg = null;

  // Parse flags
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--repos-dir" && args[i + 1]) {
      reposDir = args[++i];
    } else if (a === "--output-dir" && args[i + 1]) {
      outputDir = args[++i];
    } else if (a === "--build") {
      command = "build";
    } else if (a === "--refresh") {
      command = "refresh";
      // Next arg may be a repo name (not a flag)
      if (args[i + 1] && !args[i + 1].startsWith("--")) {
        commandArg = args[++i];
      }
    } else if (a === "--search" && args[i + 1]) {
      command = "search";
      commandArg = args[++i];
    } else if (a === "--list") {
      command = "list";
    } else if (a === "--verbose" || a === "-v") {
      // handled below
    }
  }

  const verbose = args.includes("--verbose") || args.includes("-v");

  if (!command) {
    process.stderr.write(
      "Usage: fleet-index.js --build | --refresh [repo] | --search \"query\" | --list\n" +
      "  --repos-dir <path>   (default: ~/.claude/repos)\n" +
      "  --output-dir <path>  (default: ~/.claude/fleet)\n" +
      "  --verbose, -v\n"
    );
    process.exit(0);
  }

  try {
    switch (command) {
      case "build": {
        const result = buildIndex(reposDir, outputDir, { verbose });
        process.stdout.write(JSON.stringify({
          ok: true,
          indexed: result.stats.indexed,
          errors: result.stats.errors,
          total: result.stats.total,
        }) + "\n");
        break;
      }
      case "refresh": {
        const result = refreshIndex(reposDir, outputDir, {
          targetRepo: commandArg || null,
          verbose,
        });
        process.stdout.write(JSON.stringify({
          ok: true,
          updated: result.updated,
          skipped: result.stats.skipped,
          errors: result.stats.errors,
        }) + "\n");
        break;
      }
      case "search": {
        const hits = searchRepos(outputDir, commandArg, 10);
        process.stdout.write(JSON.stringify(hits) + "\n");
        break;
      }
      case "list": {
        const repos = listRepos(outputDir);
        process.stdout.write(JSON.stringify(repos) + "\n");
        break;
      }
    }
  } catch {
    process.stdout.write(JSON.stringify({ ok: false, error: "internal error" }) + "\n");
  }

  process.exit(0);
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  buildIndex,
  refreshIndex,
  searchRepos,
  getManifest,
  listRepos,
  // Internal helpers exported for testing:
  extractSignals,
  generateManifest,
  computeQuality,
  generateDigest,
  parseFleetYaml,
};
