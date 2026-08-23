# Telegram Operator for T3 Code

Always-on team AI Operator in Telegram. It answers quick questions itself through a persistent Claude or Codex session and delegates substantial work to persistent, project-scoped T3 Code threads without blocking the Telegram conversation.

## What is implemented

- Allowlisted private/group Telegram ingress with owner/admin/member/viewer roles,
  shared-project memberships, topic preservation, and idempotent long polling.
- Switchable Claude/Codex CLI Operator runtime with native resume/compact,
  provider handoff restoration, built-in web
  retrieval, and a process-scoped privileged MCP surface for T3, Telegram,
  memory, artifacts, time, search, calculator, and safe file metadata.
- Current T3 Code orchestration adapter:
  - project list/create/rename;
  - thread list/create/reuse plus server-side full-text RPC search;
  - turn dispatch, interrupt, approval and structured user-input responses;
  - thread detail/tail/artifact discovery;
  - native Effect RPC/WebSocket event subscriptions with ticket authentication,
    sequence resume/deduplication, streamed assistant assembly, approvals,
    progress and authoritative session completion;
  - server-advertised provider/model/reasoning catalog with per-turn switching;
  - explicit snapshot-polling compatibility mode for legacy/test servers.
- SQLite/WAL source of truth for projects, structured thread summaries, searchable/deduplicated Operator notes, FTS search, focus, Telegram mappings, artifacts, approvals, structured input, background jobs, a durable Telegram outbox, events, runtime state, and compactions.
- Agent-driven routing: every non-command message is one Operator turn. The daemon supplies mechanical facts in the envelope (Telegram reply→thread mapping, durable focus, forwarded-as-data separation, registered artifacts) and the Operator itself finds, continues, or creates T3 work threads through the per-turn `t3.*` tools, asking the owner in plain text when two threads are materially indistinguishable.
- Focus survives unrelated factual questions.
- Cross-project work moves through a structured handoff packet into a new target-project T3 thread; registered source artifacts are safely copied into the target workspace.
- Broad tasks can fan out to a few independent T3 workers at the Operator's discretion; each worker is monitored and delivers its own result, and `/status` lists every active scope.
- Every named inbound Telegram media kind is normalized and stored with safe names. Voice is transcribed through configured cloud/local STT while retaining its original artifact; video notes also yield a derived audio artifact and durable keyframes.
- Requested outbound worker documents/photos are resolved from T3 checkpoints, path-validated, and sent through Telegram.
- Agent-initiated spoken replies are synthesized and normalized to Telegram-native OGG/Opus. Arbitrary source video is cropped/scaled and transcoded to a square H.264/AAC video note capped at 60 seconds.
- Native rich draft/final methods are capability-detected, with HTML/edit/plain fallbacks, semantic message splitting, retry, and flood-control backoff.
- Telegram approval buttons (`Allow once`, `Allow session`, `Deny`) backed by an explicit eight-category risk policy.
- Sequential structured T3 questions in Telegram, including single-select, multi-select, and custom text answers.
- Provider-aware follow-ups: immediate live steering when supported, otherwise a durable queue dispatched after the current turn.
- Natural-language durable remember/recall plus `/status`, `/projects`, `/work`, `/focus`, `/memory`, `/stop`/`/cancel`, `/team`, `/share`, `/help`, and `/debug`.
- Minute maintenance ticks coalesce safely and enforce daily context compaction, bounded authoritative context restoration, T3 worker reconciliation, note expiry, and managed artifact retention cleanup.
- Restart recovery for running workers, pending routing clarifications/interactions, interrupted T3 dispatches and group synthesis, and terminal results that arrived while the daemon was down. T3 command receipts and anchored Telegram edits make retries idempotent.
- Secret-redacted structured logs, hashed chat identities, cross-component correlation IDs, owner diagnostics, classified errors and in-process latency/error/queue metrics.
- Durable timezone-aware one-shot/interval/daily automations, optional bounded
  Google Calendar/Gmail tools, hybrid lexical/vector memory, project aliases,
  provider cost/latency/reliability optimization, a live policy editor, and a
  capability-protected loopback operations dashboard.

## Requirements

- Node.js 24.2 or newer (the daemon uses built-in `node:sqlite`).
- T3 Code running locally or remotely.
- Claude Code CLI and/or Codex CLI installed and authenticated.
- A Telegram bot token from BotFather and the numeric Telegram user ID of the primary owner.
- `ffmpeg` and `ffprobe` with Opus, H.264, and AAC support.

T3 Code itself may require a newer Node release than this daemon. Follow the requirements of the T3 version you run.

## Setup

```bash
pnpm install
cp .env.example .env
```

Fill at least:

```dotenv
TELEGRAM_BOT_TOKEN=123456:...
TELEGRAM_ALLOWED_USER_ID=123456789
T3_BASE_URL=http://127.0.0.1:3773
```

Optional team and group access is explicit:

```dotenv
TELEGRAM_ALLOWED_USERS=222222222:admin,333333333:member,444444444:viewer
TELEGRAM_ALLOW_GROUPS=true
```

Use `/share <project-id-or-name> <user-id> <owner|editor|viewer>` to grant a
member access to an existing project. Viewer roles remain read-only. `/team`
lists roles; the primary owner can persist role changes for already allowlisted
IDs with `/team set <user-id> <role>`.

For a locally trusted T3 environment, `T3_BEARER_TOKEN` may be unnecessary. For a paired/remote environment, provide an access token with `orchestration:read orchestration:operate` scopes.

### Large files: local Bot API server

The cloud Bot API refuses to hand a bot any file over 20 MB (`400: file is too
big`), which silently caps inbound meeting recordings. Running
[`telegram-bot-api`](https://github.com/tdlib/telegram-bot-api) locally lifts
that limit. It needs an `api_id`/`api_hash` from my.telegram.org, and the bot
must be logged out of the cloud server once (`POST /botTOKEN/logOut`) before it
can be used locally:

```bash
docker run -d --name telegram-bot-api --restart unless-stopped \
  -p 127.0.0.1:8081:8081 \
  -v ~/.operator/telegram-bot-api:/var/lib/telegram-bot-api \
  -e TELEGRAM_API_ID=... -e TELEGRAM_API_HASH=... -e TELEGRAM_LOCAL=1 \
  aiogram/telegram-bot-api:latest
```

```dotenv
TELEGRAM_API_BASE=http://127.0.0.1:8081
TELEGRAM_LOCAL_FILE_ROOT=/var/lib/telegram-bot-api
TELEGRAM_LOCAL_HOST_ROOT=/home/you/.operator/telegram-bot-api
MEDIA_MAX_INPUT_BYTES=524288000
TELEGRAM_MAX_UPLOAD_BYTES=2097152000
TELEGRAM_LOCAL_FILE_RETENTION_HOURS=24
ARTIFACT_RETENTION_DAYS=14
```

In local mode `getFile` returns an absolute path inside the server's working
directory instead of a URL, so the daemon reads the file straight off the
mounted host root (path-escape checked) rather than streaming it back over
HTTP. The server writes files as its own user, so the daemon's account needs
read access to that directory — e.g.
`setfacl -R -m u:you:rX -m d:u:you:rX ~/.operator/telegram-bot-api`.

The server never deletes what it downloads, so every file is stored twice: once
by the server and once in the artifact registry. The maintenance tick prunes the
server's copies older than `TELEGRAM_LOCAL_FILE_RETENTION_HOURS`, leaving its
`*.binlog`/`*.sqlite` state untouched, and `ARTIFACT_RETENTION_DAYS` bounds the
registry's own copies.

A local server also raises the *upload* ceiling from 50 MB to 2000 MB; set
`TELEGRAM_MAX_UPLOAD_BYTES` to match, since the daemon's own guards default to
the cloud limit.

Long recordings exceed the STT upload ceiling (~25 MB at OpenAI/OpenRouter), so
oversized audio is re-encoded to mono 16 kHz Opus and, when that is still too
large, transcribed in `MEDIA_STT_SEGMENT_SECONDS` segments whose transcripts are
stitched; a failed segment is marked inline instead of losing the recording.
`MEDIA_LONG_TIMEOUT_MS` covers recordings past five minutes.

For voice transcription, configure at least one STT adapter. OpenAI, Groq,
Deepgram, and a local Whisper CLI are supported and tried in that order. With
no adapter, the original is still retained and the Operator receives an
explicit transcription-unavailable marker:

```dotenv
OPENAI_API_KEY=...
# or GROQ_API_KEY / DEEPGRAM_API_KEY
# or WHISPER_BIN=/absolute/path/to/whisper-cli
#    WHISPER_MODEL=/absolute/path/to/ggml-model.bin
```

Outbound TTS uses ElevenLabs when configured and otherwise uses macOS `say`
(or an explicit `SAY_BIN`), followed by FFmpeg OGG/Opus normalization.

The provider instance and model are fallbacks and must match the configured T3 runtime. At runtime the daemon reads T3's provider catalog, applies the spec's task-complexity defaults, and honors explicit model/reasoning requests:

```dotenv
T3_PROVIDER_INSTANCE_ID=claude
T3_MODEL=claude-opus-4-1
T3_RUNTIME_MODE=approval-required
```

Claude is the default conversational runtime. Codex must be explicitly enabled;
`/operator switch claude|codex` snapshots durable context and restores it into
the new provider. Ambient settings/rules and shell/edit/image tools are disabled
for Codex user turns, and only the process-scoped Operator MCP allowlist is
injected:

```dotenv
OPERATOR_PROVIDER=claude
OPERATOR_CODEX_ENABLED=true
CODEX_MODEL=gpt-5.4
CODEX_EFFORT=high
```

Optional Phase 3 services are configured independently. A Google access token
must carry the Calendar/Gmail scopes required for the tools you enable and is
never passed to either Operator subprocess:

```dotenv
GOOGLE_WORKSPACE_ACCESS_TOKEN=...
DASHBOARD_ENABLED=true
DASHBOARD_PORT=0
PROVIDER_MODEL_COSTS_USD=anthropic/claude-opus-4-1=0.15,openai/gpt-5.4=0.08
```

Use `/automation` for scheduled proactive work, `/policy` for live controls,
`/alias` for durable project nicknames, and `/dashboard` for the local cockpit.

Start T3 Code if it is not already running:

```bash
npx t3@latest
```

Then run Operator:

```bash
set -a
source .env
set +a
pnpm dev
```

Production build:

```bash
pnpm check
pnpm start
```

`pnpm check` typechecks, runs tests, and creates `dist/main.mjs` plus the packaged SQLite migration.

## Runtime data and security

The default data root is `~/.operator`:

```text
~/.operator/
├── operator.db
├── runtime/          # infrastructure Operator provider cwd
├── artifacts/        # Telegram uploads
└── workspaces/       # auto-created non-repository projects
```

Workers and Operator subprocesses never receive the Telegram token, T3 bearer
token, Google bearer token, Operator database,
or cross-project broker. For a user-facing turn, Claude receives only a random,
expiring capability for a loopback MCP endpoint. Ambient Claude settings,
skills and global MCP configuration are disabled; the explicit turn MCP is
loaded with `--strict-mcp-config`. The capability is revoked when the turn
ends. Claude has no shell or unrestricted filesystem tool. Worker prompts
receive only the chosen project context and explicitly materialized files.

Outbound files are sent only after realpath/symlink resolution, allowed-root validation, regular-file and size checks, secret-like filename rejection, hashing, and audit logging.

## Architecture

```text
Telegram Bot API
      │
      ▼
Operator daemon ── SQLite / artifact registry / routing / scheduler
      │                         │
      │                         └── Claude/Codex Operator session
      │                              (conversation + per-turn MCP)
      ▼
T3 Code orchestration (HTTP snapshots/commands + Effect RPC/WebSocket events)
      ├── Project A / persistent thread(s)
      ├── Project B / persistent thread(s)
      └── Project C / persistent thread(s)
```

The Telegram conversation is not mapped one-to-one to a T3 thread. Messages may have no work binding, a project binding, one thread, or multiple related threads.

## Verification

```bash
pnpm typecheck
pnpm test
pnpm build
```

Tests cover routing/focus/path and git-aware selection, a quantitative routing corpus, durable ambiguity handling, handoff artifact transfer, concurrent fan-out/synthesis/group control, structured and hybrid memory/search/migration/compaction restoration, timezone-aware automation, Google connector contracts, dashboard/policy authorization, cost/latency-aware provider selection, local latency budgets, idempotent mappings and recovery, artifact security/provenance, real FFmpeg media conversion, Telegram rich rendering, structured interactions, Claude/Codex CLI isolation and resume, process-scoped MCP calls/revocation, T3 HTTP commands, RPC event projection and WebSocket ticket authentication.

## Full-spec implementation status

This feature branch is implementing the complete technical specification,
including its Phase 2/3 requirements. The conservative, evidence-based status
for every requirement is maintained in [`docs/spec-compliance.md`](docs/spec-compliance.md);
items there are not considered complete until they have direct test or runtime
evidence. Native rich Telegram methods vary by Bot API deployment, so the
transport retains edit/HTML/plain fallbacks.
