#!/usr/bin/env bash
# End-to-end dogfood test using claude -p (headless mode).
# Must be run OUTSIDE of Claude Code (from a normal terminal).
#
# Simulates a real investigation workspace modeled on Novu (open-source
# notification infrastructure, 38K stars). A customer reports duplicate
# entries in digest emails. Claude must trace the issue across three
# services — API, worker, and provider — to find the bug in the worker's
# digest aggregation logic.
#
# Directory layout:
#   $WORKSPACE/
#     workspace.json      ← declares repos + resources (extensible)
#     TICKET-2847.md      ← the trouble ticket
#     REPOS/
#       novu-api/         ← trigger endpoint, creates jobs (not the bug)
#       novu-worker/      ← digest engine, BullMQ jobs (BUG IS HERE)
#       novu-providers/   ← email rendering + Sendgrid (not the bug)
#
# Usage: bash scripts/dogfood-e2e.sh
#
# Prerequisites:
#   - claude CLI on PATH and authenticated
#   - node 18+ on PATH
#   - git configured

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMP_HOME="$(mktemp -d)"
LOG="$TEMP_HOME/dogfood.log"
PASS=0
FAIL=0

cleanup() {
  rm -rf "$TEMP_HOME"
}
trap cleanup EXIT

say() {
  echo "$1" | tee -a "$LOG"
}

check() {
  local label="$1"
  shift
  if "$@" > /dev/null 2>&1; then
    say "  OK: $label"
    PASS=$((PASS + 1))
  else
    say "  FAIL: $label"
    FAIL=$((FAIL + 1))
  fi
}

check_content() {
  local label="$1"
  local file="$2"
  local pattern="$3"
  if [ -f "$file" ] && grep -qiE "$pattern" "$file"; then
    say "  OK: $label"
    PASS=$((PASS + 1))
  else
    say "  FAIL: $label"
    FAIL=$((FAIL + 1))
  fi
}

run_claude() {
  local prompt="$1"
  local cwd="${2:-$WORKSPACE}"
  local tools="${3:-Read,Glob,Grep,Write,Edit,Bash}"
  local model="${4:-sonnet}"

  # Strip ALL Claude Code env vars to avoid nesting issues.
  # CLAUDE_CODE_SSE_PORT is the critical one — it makes the child
  # connect to the parent's SSE server and hang forever.
  env -u CLAUDECODE \
      -u CLAUDE_CODE_ENTRYPOINT \
      -u CLAUDE_CODE_SSE_PORT \
      -u CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS \
    HOME="$TEMP_HOME" \
    USERPROFILE="$TEMP_HOME" \
    claude -p "$prompt" \
      --cwd "$cwd" \
      --model "$model" \
      --allowedTools "$tools" \
      2>/dev/null
}

say "============================================================"
say "DOGFOOD E2E TEST — Multi-Repo Investigation (Novu-style)"
say "START: $(date)"
say "REPO: $REPO_ROOT"
say "TEMP HOME: $TEMP_HOME"
say ""

# ── Test 1: Install research profile ─────────────────────────
say "--- Test 1: Install research profile ---"
HOME="$TEMP_HOME" bash "$REPO_ROOT/install.sh" --profile research --force > "$TEMP_HOME/install.log" 2>&1
check "install exit code" test $? -eq 0
check "CLAUDE.md exists" test -f "$TEMP_HOME/.claude/CLAUDE.md"
check "investigate skill exists" test -f "$TEMP_HOME/.claude/skills/investigate/SKILL.md"
check "investigations dir exists" test -d "$TEMP_HOME/.claude/investigations"
say ""

# ── Test 2: Scaffold multi-repo workspace ─────────────────────
# Modeled on Novu's real architecture: API server, background worker
# with digest engine, and provider integrations (Sendgrid, etc.).
# Three repos as siblings under REPOS/, workspace.json at root.
say "--- Test 2: Create Novu-style workspace ---"
WORKSPACE="$TEMP_HOME/workspace"
REPOS="$WORKSPACE/REPOS"

# ── novu-api: trigger endpoint, creates notification jobs ──
API="$REPOS/novu-api"
mkdir -p "$API/.git" \
         "$API/src/controllers" \
         "$API/src/services" \
         "$API/src/models"

cat > "$API/package.json" << 'EOF'
{
  "name": "@novu/api",
  "version": "0.24.1",
  "dependencies": {
    "@nestjs/core": "^10", "@nestjs/bullmq": "^10",
    "@novu/shared": "^0.24", "@novu/dal": "^0.24",
    "uuid": "^9"
  }
}
EOF

cat > "$API/README.md" << 'EOF'
# @novu/api

REST API for the Novu notification platform. Accepts trigger requests
from client SDKs, validates payloads, and queues notification jobs for
the worker to process.

## Key endpoints

- `POST /v1/events/trigger` — trigger a notification workflow
- `GET /v1/notifications` — list notification history
- `GET /v1/subscribers/:id/preferences` — subscriber preferences

## Job creation

Each trigger creates a NotificationJob with a unique `transactionId`.
The transactionId is either provided by the caller (for idempotency)
or generated server-side as a UUIDv4. Jobs are queued to BullMQ for
the worker to pick up.
EOF

cat > "$API/src/controllers/events.controller.ts" << 'EOF'
import { Controller, Post, Body } from "@nestjs/common";
import { TriggerService } from "../services/trigger.service";

interface TriggerPayload {
  name: string;           // workflow template name
  to: string | string[];  // subscriber IDs
  payload: Record<string, unknown>;
  transactionId?: string; // optional idempotency key
}

@Controller("v1/events")
export class EventsController {
  constructor(private triggerService: TriggerService) {}

  @Post("trigger")
  async trigger(@Body() body: TriggerPayload) {
    const result = await this.triggerService.trigger({
      workflowName: body.name,
      subscriberIds: Array.isArray(body.to) ? body.to : [body.to],
      payload: body.payload,
      transactionId: body.transactionId,
    });

    return {
      data: { acknowledged: true, transactionId: result.transactionId },
    };
  }
}
EOF

cat > "$API/src/services/trigger.service.ts" << 'EOF'
import { Injectable } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { v4 as uuidv4 } from "uuid";
import { NotificationJob } from "../models/notification-job";

interface TriggerInput {
  workflowName: string;
  subscriberIds: string[];
  payload: Record<string, unknown>;
  transactionId?: string;
}

@Injectable()
export class TriggerService {
  constructor(
    @InjectQueue("notifications") private notificationQueue: Queue
  ) {}

  async trigger(input: TriggerInput) {
    const transactionId = input.transactionId || uuidv4();

    for (const subscriberId of input.subscriberIds) {
      const job: NotificationJob = {
        transactionId,
        subscriberId,
        workflowName: input.workflowName,
        payload: input.payload,
        createdAt: new Date().toISOString(),
      };

      // Each subscriber gets their own job in the queue.
      // The transactionId links retries of the same trigger.
      await this.notificationQueue.add("process-notification", job, {
        jobId: `${transactionId}-${subscriberId}`,
        removeOnComplete: true,
      });
    }

    return { transactionId };
  }
}
EOF

cat > "$API/src/models/notification-job.ts" << 'EOF'
export interface NotificationJob {
  transactionId: string;
  subscriberId: string;
  workflowName: string;
  payload: Record<string, unknown>;
  createdAt: string;
}
EOF

# ── novu-worker: digest engine + BullMQ job processing ──
# THE BUG IS HERE: digest step collects by subscriberId but
# doesn't deduplicate by transactionId before rendering.
WORKER="$REPOS/novu-worker"
mkdir -p "$WORKER/.git" \
         "$WORKER/src/processors" \
         "$WORKER/src/steps"

cat > "$WORKER/package.json" << 'EOF'
{
  "name": "@novu/worker",
  "version": "0.24.1",
  "dependencies": {
    "@nestjs/core": "^10", "@nestjs/bullmq": "^10",
    "@novu/shared": "^0.24", "@novu/dal": "^0.24",
    "@novu/providers": "^0.24"
  }
}
EOF

cat > "$WORKER/README.md" << 'EOF'
# @novu/worker

Background job processor for the Novu notification platform. Consumes
jobs from BullMQ queues and executes workflow steps: channel routing,
delay, digest, and delivery.

## Workflow steps

1. **Trigger** — job enters the queue
2. **Digest** — batches multiple notifications for the same subscriber
   into a single message (e.g., "You have 5 new comments")
3. **Channel routing** — determines which channels to deliver on
4. **Render** — compiles the notification template with payload data
5. **Deliver** — sends via the configured provider (Sendgrid, Twilio, etc.)

## Digest engine

The digest step collects notifications for a subscriber within a time
window (configurable, default 5 minutes). When the window closes, all
collected notifications are batched into a single digest payload and
passed to the render step.
EOF

cat > "$WORKER/src/processors/notification.processor.ts" << 'EOF'
import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Job } from "bullmq";
import { DigestStep } from "../steps/digest.step";
import { RenderStep } from "../steps/render.step";
import { DeliverStep } from "../steps/deliver.step";

interface NotificationJob {
  transactionId: string;
  subscriberId: string;
  workflowName: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

@Processor("notifications")
export class NotificationProcessor extends WorkerHost {
  constructor(
    private digestStep: DigestStep,
    private renderStep: RenderStep,
    private deliverStep: DeliverStep
  ) {
    super();
  }

  async process(job: Job<NotificationJob>) {
    const { data } = job;

    // Step 1: Check if this workflow uses digest
    const workflow = await this.getWorkflow(data.workflowName);

    if (workflow.steps.includes("digest")) {
      // Add to digest batch, don't deliver yet
      await this.digestStep.addToDigest(data);
      return { status: "digested", transactionId: data.transactionId };
    }

    // Non-digest: render and deliver immediately
    const rendered = await this.renderStep.render(data);
    await this.deliverStep.deliver(rendered);
    return { status: "delivered", transactionId: data.transactionId };
  }

  private async getWorkflow(name: string) {
    // Simplified: in production this reads from the workflow template store
    return {
      name,
      steps: ["digest", "render", "deliver"],
      digestWindow: 5 * 60 * 1000, // 5 minutes
    };
  }
}
EOF

# THE BUG: collectDigest queries by subscriberId but does NOT
# deduplicate by transactionId. When the same trigger is retried
# (client timeout → retry), duplicate entries appear in the digest.
cat > "$WORKER/src/steps/digest.step.ts" << 'EOF'
import { Injectable } from "@nestjs/common";
import { Redis } from "ioredis";

interface DigestEntry {
  transactionId: string;
  subscriberId: string;
  workflowName: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

@Injectable()
export class DigestStep {
  constructor(private redis: Redis) {}

  /**
   * Add a notification to the subscriber's digest batch.
   * Entries are stored in a Redis list keyed by subscriber + workflow.
   */
  async addToDigest(entry: DigestEntry): Promise<void> {
    const key = `digest:${entry.subscriberId}:${entry.workflowName}`;

    // Store the entry in the digest batch
    await this.redis.rpush(key, JSON.stringify(entry));

    // Set TTL on first entry (digest window = 5 min)
    const len = await this.redis.llen(key);
    if (len === 1) {
      await this.redis.expire(key, 300);
      // Schedule digest flush after window closes
      await this.scheduleFlush(entry.subscriberId, entry.workflowName);
    }
  }

  /**
   * Collect all entries in a subscriber's digest batch.
   * Called when the digest window closes.
   *
   * BUG: This collects ALL entries in the list without deduplicating
   * by transactionId. If the same trigger was retried (e.g., client
   * timeout), the same notification appears multiple times in the
   * digest. The API sets jobId to `${transactionId}-${subscriberId}`
   * for BullMQ dedup, but that only prevents duplicate *jobs* — if
   * the job runs twice (BullMQ retry on worker crash), the digest
   * list gets duplicate entries.
   */
  async collectDigest(
    subscriberId: string,
    workflowName: string
  ): Promise<DigestEntry[]> {
    const key = `digest:${subscriberId}:${workflowName}`;

    // Get all entries — NO deduplication by transactionId
    const raw = await this.redis.lrange(key, 0, -1);
    await this.redis.del(key);

    return raw.map((r) => JSON.parse(r));

    // FIX would be:
    // const entries = raw.map(r => JSON.parse(r));
    // const seen = new Set<string>();
    // return entries.filter(e => {
    //   if (seen.has(e.transactionId)) return false;
    //   seen.add(e.transactionId);
    //   return true;
    // });
  }

  private async scheduleFlush(
    subscriberId: string,
    workflowName: string
  ): Promise<void> {
    // In production: adds a delayed BullMQ job that calls collectDigest
    // after the digest window expires. Simplified here.
  }
}
EOF

cat > "$WORKER/src/steps/render.step.ts" << 'EOF'
import { Injectable } from "@nestjs/common";

interface RenderInput {
  subscriberId: string;
  workflowName: string;
  payload: Record<string, unknown>;
  digestEntries?: Array<{ payload: Record<string, unknown> }>;
}

interface RenderedNotification {
  subscriberId: string;
  channel: string;
  subject: string;
  body: string;
}

@Injectable()
export class RenderStep {
  /**
   * Render a notification template with payload data.
   * For digest notifications, the template receives an array of entries.
   * The render step does NOT filter or deduplicate — it renders whatever
   * it receives from the digest step.
   */
  async render(input: RenderInput): Promise<RenderedNotification> {
    const entryCount = input.digestEntries?.length || 1;

    return {
      subscriberId: input.subscriberId,
      channel: "email",
      subject: entryCount > 1
        ? `You have ${entryCount} new notifications`
        : "New notification",
      body: this.compileTemplate(input),
    };
  }

  private compileTemplate(input: RenderInput): string {
    // Simplified: in production uses Handlebars templates from the store
    if (input.digestEntries) {
      return input.digestEntries
        .map((e, i) => `${i + 1}. ${JSON.stringify(e.payload)}`)
        .join("\n");
    }
    return JSON.stringify(input.payload);
  }
}
EOF

cat > "$WORKER/src/steps/deliver.step.ts" << 'EOF'
import { Injectable } from "@nestjs/common";

interface RenderedNotification {
  subscriberId: string;
  channel: string;
  subject: string;
  body: string;
}

@Injectable()
export class DeliverStep {
  /**
   * Deliver a rendered notification via the configured provider.
   * Routes to the appropriate provider based on channel type.
   */
  async deliver(notification: RenderedNotification): Promise<void> {
    switch (notification.channel) {
      case "email":
        await this.sendEmail(notification);
        break;
      case "sms":
        await this.sendSms(notification);
        break;
      default:
        throw new Error(`Unknown channel: ${notification.channel}`);
    }
  }

  private async sendEmail(notification: RenderedNotification): Promise<void> {
    // Delegates to the provider package (Sendgrid, SES, etc.)
    // The provider is selected from the subscriber's integration settings
    console.log(`Sending email to ${notification.subscriberId}: ${notification.subject}`);
  }

  private async sendSms(notification: RenderedNotification): Promise<void> {
    console.log(`Sending SMS to ${notification.subscriberId}`);
  }
}
EOF

# ── novu-providers: Sendgrid email provider (red herring) ──
PROV="$REPOS/novu-providers"
mkdir -p "$PROV/.git" \
         "$PROV/src/sendgrid" \
         "$PROV/src/shared"

cat > "$PROV/package.json" << 'EOF'
{
  "name": "@novu/providers",
  "version": "0.24.1",
  "dependencies": {
    "@sendgrid/mail": "^7", "nodemailer": "^6"
  }
}
EOF

cat > "$PROV/README.md" << 'EOF'
# @novu/providers

Provider integrations for the Novu notification platform. Each provider
implements a standard interface for sending notifications on a specific
channel (email, SMS, push, chat).

## Email providers

- **Sendgrid** — primary email provider
- **SES** — AWS Simple Email Service
- **Postmark** — transactional email

## Interface

All providers implement `ISendProvider`:
```typescript
interface ISendProvider {
  sendMessage(options: IEmailOptions): Promise<ISendResult>;
}
```

The provider receives a fully rendered message (subject, body, recipient)
and sends it. Providers do NOT modify message content — they are pure
delivery mechanisms.
EOF

cat > "$PROV/src/shared/provider.interface.ts" << 'EOF'
export interface IEmailOptions {
  to: string;
  from: string;
  subject: string;
  html: string;
  text?: string;
}

export interface ISendResult {
  id: string;
  date: string;
}

export interface ISendProvider {
  sendMessage(options: IEmailOptions): Promise<ISendResult>;
}
EOF

cat > "$PROV/src/sendgrid/sendgrid.provider.ts" << 'EOF'
import sgMail from "@sendgrid/mail";
import { ISendProvider, IEmailOptions, ISendResult } from "../shared/provider.interface";

export class SendgridProvider implements ISendProvider {
  constructor(apiKey: string) {
    sgMail.setApiKey(apiKey);
  }

  /**
   * Send an email via Sendgrid.
   * Receives a fully rendered message — does NOT modify content.
   * If the message contains duplicate entries in the body, that's
   * an upstream issue (digest step), not a provider issue.
   */
  async sendMessage(options: IEmailOptions): Promise<ISendResult> {
    const [response] = await sgMail.send({
      to: options.to,
      from: options.from,
      subject: options.subject,
      html: options.html,
      text: options.text,
    });

    return {
      id: response.headers["x-message-id"] as string,
      date: new Date().toISOString(),
    };
  }
}
EOF

# ── Workspace config with extensible resources ──
cat > "$WORKSPACE/workspace.json" << EOF
{
  "name": "novu-notifications",
  "description": "Novu open-source notification infrastructure",
  "repos": [
    {
      "name": "novu-api",
      "localPath": "REPOS/novu-api",
      "role": "api",
      "description": "REST API — trigger endpoint, job creation"
    },
    {
      "name": "novu-worker",
      "localPath": "REPOS/novu-worker",
      "role": "worker",
      "description": "Background processor — digest engine, BullMQ jobs"
    },
    {
      "name": "novu-providers",
      "localPath": "REPOS/novu-providers",
      "role": "providers",
      "description": "Email/SMS/push provider integrations (Sendgrid, etc.)"
    }
  ],
  "resources": [
    {
      "type": "repo",
      "name": "novu-dashboard",
      "status": "not-cloned",
      "note": "React frontend — not needed for this investigation"
    },
    {
      "type": "cli",
      "name": "gh",
      "status": "available",
      "note": "GitHub CLI for PR/issue access"
    },
    {
      "type": "mcp",
      "name": "datadog",
      "status": "not-configured",
      "note": "Would provide log search, APM traces, dashboards"
    },
    {
      "type": "mcp",
      "name": "clickup",
      "status": "not-configured",
      "note": "Would provide ticket lookup, status updates"
    },
    {
      "type": "mcp",
      "name": "coderabbit",
      "status": "not-configured",
      "note": "Would provide automated code review on PRs"
    }
  ]
}
EOF

# ── Trouble ticket at workspace root ──
cat > "$WORKSPACE/TICKET-2847.md" << 'EOF'
# TICKET-2847: Duplicate entries in digest emails

**Reporter**: DevOps team at Acme Corp (enterprise customer)
**Priority**: High
**Component**: Digest Engine
**Environment**: Production (SaaS)

## Description

Subscribers are receiving digest emails with duplicate notification
entries. For example, a subscriber who should see "You have 3 new
comments" is instead seeing "You have 5 new comments" with two of
the entries being exact duplicates of earlier ones.

## Reproduction

1. Send a trigger via the API: `POST /v1/events/trigger`
2. The client SDK retries the trigger due to a network timeout
   (same transactionId sent twice)
3. Wait for the digest window to close (5 minutes)
4. The resulting digest email contains the notification twice

## Expected behavior

The digest should deduplicate by transactionId. If the same trigger
is retried, the digest should contain the notification only once.

## Actual behavior

Both the original and retried trigger appear as separate entries in
the digest email. The count is inflated and the email body lists the
same notification payload twice.

## Customer impact

Acme Corp sends ~50K digests/day. Roughly 3% contain duplicates due
to SDK retries on flaky mobile networks. This makes the notification
counts unreliable and confuses their end users.

## Potentially relevant services

- `@novu/api` — trigger endpoint, creates notification jobs
- `@novu/worker` — digest engine, batches notifications
- `@novu/providers` — email delivery (Sendgrid)
EOF

check "novu-api created" test -f "$API/src/services/trigger.service.ts"
check "novu-worker created" test -f "$WORKER/src/steps/digest.step.ts"
check "novu-providers created" test -f "$PROV/src/sendgrid/sendgrid.provider.ts"
check "workspace.json created" test -f "$WORKSPACE/workspace.json"
check "ticket created" test -f "$WORKSPACE/TICKET-2847.md"
say ""

# ── Test 3: claude -p basic sanity ───────────────────────────
say "--- Test 3: claude -p sanity check ---"
PONG=$(run_claude "Reply with just the word PONG" "$WORKSPACE" "Read" "haiku")
check "claude responds" echo "$PONG" | grep -qi "PONG"
say ""

# ── Test 4: Scaffold investigation from ticket ────────────────
say "--- Test 4: Create investigation from ticket ---"
INV_DIR="$TEMP_HOME/.claude/investigations"

run_claude \
  "You are investigating a customer issue. Read TICKET-2847.md in the current directory.
Also read workspace.json to understand which repos and resources are in scope.

Create a new investigation with ID DIGEST-2847. Create these files:

1. $INV_DIR/DIGEST-2847/EVIDENCE/ (directory)

2. $INV_DIR/DIGEST-2847/BRIEF.md with:
   - # Investigation: DIGEST-2847
   - ## Question — a specific technical question about the duplicate digest entries
   - ## Scope — which repos and code areas to examine
   - ## Context — relevant background from the ticket

3. $INV_DIR/DIGEST-2847/STATUS.md with:
   - # Status: DIGEST-2847
   - ## Current Phase: new
   - ## History table with today's date
   - ## Handoff Notes

4. $INV_DIR/DIGEST-2847/FINDINGS.md with YAML frontmatter tags (domain, type, severity, components, symptoms, root_cause — all empty arrays) and empty findings body.

Keep the brief under 10 lines. Focus on the technical question." \
  "$WORKSPACE" "Read,Write,Bash" "sonnet" > /dev/null

check "BRIEF.md created" test -f "$INV_DIR/DIGEST-2847/BRIEF.md"
check "STATUS.md created" test -f "$INV_DIR/DIGEST-2847/STATUS.md"
check "FINDINGS.md created" test -f "$INV_DIR/DIGEST-2847/FINDINGS.md"
check "EVIDENCE dir created" test -d "$INV_DIR/DIGEST-2847/EVIDENCE"
check_content "BRIEF mentions digest or duplicate" "$INV_DIR/DIGEST-2847/BRIEF.md" "digest|duplicate|dedup|transactionId"
check_content "BRIEF mentions repos" "$INV_DIR/DIGEST-2847/BRIEF.md" "novu-api|novu-worker|novu-providers|repo"
check_content "FINDINGS has YAML frontmatter" "$INV_DIR/DIGEST-2847/FINDINGS.md" "^---"
say ""

# ── Test 5: Collect evidence across repos ─────────────────────
# Claude must trace the notification flow: API → Worker → Provider.
say "--- Test 5: Collect evidence (cross-repo trace) ---"
run_claude \
  "You are continuing investigation DIGEST-2847 (duplicate entries in digest emails).

Read TICKET-2847.md and workspace.json to refresh context. The repos are under REPOS/ in the current directory.

Trace how a trigger flows through the system by reading code across all three repos:
- REPOS/novu-api/ — how triggers create jobs and handle transactionId
- REPOS/novu-worker/ — how the digest step collects and batches notifications
- REPOS/novu-providers/ — how the email provider renders and sends

Create three evidence files:

1. $INV_DIR/DIGEST-2847/EVIDENCE/001-api-trigger-flow.md
   Examine how the API creates jobs. Does it handle transactionId deduplication?
   Format: # 001: api-trigger-flow, **Source**: file:line, **Relevance**: ..., 3-line observation.

2. $INV_DIR/DIGEST-2847/EVIDENCE/002-worker-digest-step.md
   Examine the digest step. How does it collect entries? Does it deduplicate?
   Format: # 002: worker-digest-step, **Source**: file:line, **Relevance**: ..., 3-line observation.

3. $INV_DIR/DIGEST-2847/EVIDENCE/003-provider-rendering.md
   Examine the Sendgrid provider and render step. Do they modify or filter content?
   Format: # 003: provider-rendering, **Source**: file:line, **Relevance**: ..., 3-line observation.

Update $INV_DIR/DIGEST-2847/STATUS.md to phase 'collecting' with history entries." \
  "$WORKSPACE" "Read,Glob,Grep,Write,Edit" "sonnet" > /dev/null

check "evidence 001 created" test -f "$INV_DIR/DIGEST-2847/EVIDENCE/001-api-trigger-flow.md"
check "evidence 002 created" test -f "$INV_DIR/DIGEST-2847/EVIDENCE/002-worker-digest-step.md"
check "evidence 003 created" test -f "$INV_DIR/DIGEST-2847/EVIDENCE/003-provider-rendering.md"
check_content "evidence 001 mentions transactionId or jobId" \
  "$INV_DIR/DIGEST-2847/EVIDENCE/001-api-trigger-flow.md" "transactionId|jobId|dedup|idempoten"
check_content "evidence 002 mentions digest collection or dedup gap" \
  "$INV_DIR/DIGEST-2847/EVIDENCE/002-worker-digest-step.md" "dedup|transactionId|rpush|lrange|collect"
check_content "evidence 003 mentions provider doesn't filter" \
  "$INV_DIR/DIGEST-2847/EVIDENCE/003-provider-rendering.md" "not.*modif|not.*filter|pure.*deliver|as.*received|upstream"
check_content "STATUS updated to collecting" "$INV_DIR/DIGEST-2847/STATUS.md" "collecting"
say ""

# ── Test 6: Synthesize findings ───────────────────────────────
# Claude must identify: the bug is in novu-worker's digest.step.ts
# (collectDigest doesn't deduplicate by transactionId), NOT in the
# API (which correctly sets BullMQ jobId for dedup) or the provider
# (which is a pure delivery mechanism).
say "--- Test 6: Synthesize findings ---"
SYNTHESIS=$(run_claude \
  "You are synthesizing investigation DIGEST-2847.

Read the brief at $INV_DIR/DIGEST-2847/BRIEF.md and all evidence files in $INV_DIR/DIGEST-2847/EVIDENCE/.

Update $INV_DIR/DIGEST-2847/FINDINGS.md:
- Keep the YAML frontmatter tags section, update the body:
- ## Answer: explain the root cause. Which repo and file has the bug? Cite evidence by number.
- ## Evidence Summary: table with one row per evidence file and which repo it came from.
- ## Implications: what to fix, in which repo, and the specific code change needed.

Also update STATUS.md to phase 'synthesizing'.

After writing the files, state your diagnosis: which repo, which file, what the bug is, and what the fix should be. One paragraph max." \
  "$WORKSPACE" "Read,Glob,Write,Edit" "sonnet")

check_content "FINDINGS has answer section" "$INV_DIR/DIGEST-2847/FINDINGS.md" "## Answer"
check_content "FINDINGS cites evidence" "$INV_DIR/DIGEST-2847/FINDINGS.md" "001|002|003|evidence"
check_content "FINDINGS identifies novu-worker" "$INV_DIR/DIGEST-2847/FINDINGS.md" "novu-worker|digest.step|worker"
check_content "FINDINGS mentions dedup fix" "$INV_DIR/DIGEST-2847/FINDINGS.md" "transactionId|dedup|Set|filter|seen"
check_content "STATUS updated to synthesizing" "$INV_DIR/DIGEST-2847/STATUS.md" "synthesiz"

# The real test: did Claude correctly blame novu-worker, not the API or provider?
IDENTIFIED_WORKER=false
IDENTIFIED_DEDUP=false
if echo "$SYNTHESIS" | grep -qiE "novu-worker|digest.step|worker.*digest|collectDigest"; then
  IDENTIFIED_WORKER=true
fi
if echo "$SYNTHESIS" | grep -qiE "transactionId|dedup|deduplic|unique|Set|filter.*duplicate"; then
  IDENTIFIED_DEDUP=true
fi

if $IDENTIFIED_WORKER && $IDENTIFIED_DEDUP; then
  say "  OK: Claude identified root cause in novu-worker digest step (missing transactionId dedup)"
  PASS=$((PASS + 1))
else
  say "  FAIL: Claude did not correctly identify the root cause"
  say "  Response: $SYNTHESIS"
  FAIL=$((FAIL + 1))
fi
say ""

# ── Test 7: Cross-profile preservation ────────────────────────
say "--- Test 7: Switch to dev profile, verify preservation ---"
HOME="$TEMP_HOME" bash "$REPO_ROOT/install.sh" --profile dev --force > "$TEMP_HOME/install-dev.log" 2>&1
check "dev install succeeds" test -f "$TEMP_HOME/.claude/skills/checkpoint/SKILL.md"
check "investigate skill removed" test ! -d "$TEMP_HOME/.claude/skills/investigate"
check "investigation data preserved" test -f "$INV_DIR/DIGEST-2847/FINDINGS.md"
check "all 3 evidence files preserved" \
  test -f "$INV_DIR/DIGEST-2847/EVIDENCE/001-api-trigger-flow.md" \
    -a -f "$INV_DIR/DIGEST-2847/EVIDENCE/002-worker-digest-step.md" \
    -a -f "$INV_DIR/DIGEST-2847/EVIDENCE/003-provider-rendering.md"
say ""

# ── Summary ──────────────────────────────────────────────────
say "============================================================"
say "RESULTS: $PASS passed, $FAIL failed"
say "END: $(date)"
say ""

# Dump investigation artifacts for review
say "Investigation artifacts:"
for f in "$INV_DIR"/DIGEST-2847/*.md "$INV_DIR"/DIGEST-2847/EVIDENCE/*.md; do
  if [ -f "$f" ]; then
    say ""
    say "── $(basename "$f") ──"
    cat "$f" >> "$LOG"
    cat "$f"
  fi
done

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
