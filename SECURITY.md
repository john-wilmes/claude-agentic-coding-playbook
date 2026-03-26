# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please report it responsibly.

Please report security vulnerabilities through GitHub's [Security Advisory](https://github.com/lumahealthhq/claude-agentic-coding-playbook/security/advisories/new) feature.

**Do not** open a public GitHub issue for security vulnerabilities.

## Response Timeline

- **Acknowledgment:** within 48 hours
- **Initial assessment:** within 1 week
- **Fix or mitigation:** within 30 days for confirmed vulnerabilities

## Scope

This policy covers:

- The install script (`install.sh`)
- Hook templates (`templates/hooks/`)
- Skill definitions (`profiles/*/skills/`)
- Any configuration that affects Claude Code's security posture (MCP settings, permission rules)

Out of scope:

- The documentation content itself (best-practices.md, etc.)
- Third-party tools referenced in the playbook (Claude Code, CodeRabbit, etc.)

## Security Best Practices

This playbook enforces several security measures by default:

- **Pre-commit hook** blocks secrets and large files from being committed
- **Prompt injection guard** detects high-confidence injection patterns in Bash commands
- **MCP server restrictions** (`enableAllProjectMcpServers: false`) prevent supply chain injection
- **Sandbox mode** recommendation for untrusted repositories
