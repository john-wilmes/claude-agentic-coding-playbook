# Research Profile

A lighter-weight profile optimized for troubleshooting, investigation, and research tasks.

## How it differs from the dev profile

| Aspect | Dev Profile | Research Profile |
|--------|-------------|------------------|
| Workflow | Explore, Plan, Code, Verify, Commit | Explore, Analyze, Document |
| Code review | Enforced before every commit | Not included (read-only focus) |
| Commit/push | Automated in /checkpoint | Not included |
| Quality gates | Type-check, lint, test | Not included |
| Memory focus | Code changes, lessons learned | Findings, evidence trails |
| File discipline | Create and edit freely | Read-focused, confirm before editing |
| Skills | /checkpoint, /resume | /checkpoint, /resume, /findings |

## What gets installed

```
~/.claude/
  CLAUDE.md                          # Research-focused global instructions
  skills/
    checkpoint/SKILL.md              # Save state and end session
    resume/SKILL.md                  # Pick up where you left off
    findings/SKILL.md                # Record investigation findings to memory
```

## When to use this profile

- Debugging production issues across multiple services
- Investigating unfamiliar codebases
- Researching libraries, APIs, or architectural patterns
- Root cause analysis
- Security audits and code review (read-only)
- Any task where the primary output is knowledge, not code changes
