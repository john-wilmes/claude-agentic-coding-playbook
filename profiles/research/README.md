# Investigation Profile (Archived)

> **Note**: This profile has been merged into `profiles/combined/`, which is the active profile
> installed by `install.sh`. This directory is kept for reference only and is no longer maintained.
> See `profiles/combined/` for the current combined dev+research profile.

A structured profile for troubleshooting, root cause analysis, and building retrievable knowledge.

## How it differs from the dev profile

| Aspect | Dev Profile | Investigation Profile |
|--------|-------------|----------------------|
| Workflow | Explore, Plan, Code, Verify, Commit | Question, Collect, Synthesize, Close |
| Code review | Enforced before every commit | Not included (read-only focus) |
| Commit/push | Automated in /checkpoint | Not included |
| Quality gates | Type-check, lint, test | Not included |
| Memory focus | Code changes, lessons learned | Evidence trails, tagged findings |
| File discipline | Create and edit freely | Read-focused, confirm before editing |
| Storage | Project repos | `~/.claude/investigations/` |
| Skills | /checkpoint, /continue, /playbook | /investigate, /continue |

## What gets installed

```
~/.claude/
  CLAUDE.md                          # Investigation-focused global instructions
  skills/
    investigate/SKILL.md             # Full investigation lifecycle
    continue/SKILL.md                  # List open investigations, resume work
  templates/
    investigation/
      brief.md                       # Investigation brief template
      evidence.md                    # Evidence file template
      findings.md                    # Findings with YAML frontmatter tags
      status.md                      # Status/handoff log template
      presidio.yaml                  # PHI sanitization config (optional)
      hooks/pre-commit-sanitize      # Git hook for PII/PHI checks (optional)

~/.claude/investigations/            # Investigation storage (created on first use)
  _patterns/                         # Extracted reusable patterns
  <id>/                              # One directory per investigation
    BRIEF.md                         # Scoped question (10 lines max)
    FINDINGS.md                      # Answer with YAML frontmatter tags
    STATUS.md                        # History log + handoff state
    EVIDENCE/                        # Numbered evidence files
```

## Investigation lifecycle

```
/investigate <id> new         Create scaffold, write brief
/investigate <id> collect     Gather one piece of evidence
/investigate <id> synthesize  Condense evidence into findings
/investigate <id> close       Classify, tag, extract patterns, sanitize
/investigate <id> status      Show current state
/investigate <id>             Auto-detect next phase
/investigate list             Table of all investigations
/investigate search <query>   Search by text or tag (e.g., "domain:ehr")
```

## Tagging system

FINDINGS.md uses YAML frontmatter for faceted retrieval:

```yaml
tags:
  domain: [ehr, api]                    # Controlled: ehr, infrastructure, integration, auth, data-pipeline, ui, api
  type: [root-cause]                    # Controlled: root-cause, exploration, how-it-works, incident, performance, security
  severity: [high]                      # Controlled: critical, high, medium, low, informational
  components: [auth-service, jwt]       # Free-form: service names, libraries, tools
  symptoms: [token-expiry, 401-errors]  # Free-form: what was observed
  root_cause: [clock-skew]              # Free-form: what was actually wrong
```

Search by tag: `/investigate search domain:ehr` or `/investigate search type:root-cause`

## PII/PHI protection

- Presidio config available as template (optional dependency)
- At `/investigate close`: auto-sanitize if Presidio is installed, warn if not
- Pre-commit hook template available for git-versioned investigations
- During collection: use placeholders (`[PATIENT]`, `[MRN]`, `[SSN]`, `[DOB]`)

## When to use this profile

- Debugging production issues across multiple services
- Investigating unfamiliar codebases
- Researching libraries, APIs, or architectural patterns
- Root cause analysis
- Security audits and code review (read-only)
- Any task where the primary output is knowledge, not code changes
