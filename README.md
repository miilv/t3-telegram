# Telegram Operator for T3 Code

Always-on, single-user AI Operator in Telegram. It answers quick questions itself through a persistent Claude session and delegates substantial work to persistent, project-scoped T3 Code threads without blocking the Telegram conversation.

## What is implemented

- Authorized private Telegram chat with idempotent long polling.
- Persistent Claude CLI Operator runtime with resume/compact and a restricted tool surface (`WebSearch`, `WebFetch` only).
- Current T3 Code HTTP orchestration adapter:
  - project list/create/rename;
  - thread list/search/create/reuse;
  - turn dispatch, interrupt, approval responses;
  - thread detail/tail/artifact discovery;
  - asynchronous progress/completion subscription through version-tolerant snapshot polling.
- SQLite/WAL source of truth for projects, threads, FTS search, focus, Telegram mappings, artifacts, approvals, events, runtime state, and compactions.
- Routing cascade for explicit project names, Telegram replies, artifact provenance, filesystem paths, active focus, lexical thread summaries, and confidence policy.
- Focus survives unrelated factual questions.
- Multiple T3 workers can run concurrently while Operator messages remain queued and responsive.
- Inbound Telegram documents/photos are hashed, stored with safe names, and materialized into the selected project.
- Requested outbound worker documents/photos are resolved from T3 checkpoints, path-validated, and sent through Telegram.
- Native rich draft/final methods are capability-detected, with HTML/edit/plain fallbacks, semantic message splitting, retry, and flood-control backoff.
- Telegram approval buttons (`Allow once`, `Allow session`, `Deny`).
- `/status`, `/projects`, `/work`, `/stop`, `/debug`.
- Restart recovery for running workers and completions that arrived while the daemon was down.
- Secret-redacted structured logs and worker/Operator capability isolation.

## Requirements

- Node.js 24.2 or newer (the daemon uses built-in `node:sqlite`).
- T3 Code running locally or remotely.
- Claude Code CLI installed and authenticated.
- A Telegram bot token from BotFather and the numeric Telegram user ID of the single owner.

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

For a locally trusted T3 environment, `T3_BEARER_TOKEN` may be unnecessary. For a paired/remote environment, provide an access token with `orchestration:read orchestration:operate` scopes.

The provider instance and model must match the configured T3 runtime:

```dotenv
T3_PROVIDER_INSTANCE_ID=claude
T3_MODEL=claude-opus-4-1
T3_RUNTIME_MODE=approval-required
```

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
├── runtime/          # infrastructure Claude session cwd
├── artifacts/        # Telegram uploads
└── workspaces/       # auto-created non-repository projects
```

Workers never receive the Telegram token, T3 bearer token, Operator database, or cross-project broker. Claude Operator runs in `--safe-mode` with no shell/filesystem tools. Worker prompts receive only the chosen project context and explicitly materialized files.

Outbound files are sent only after realpath/symlink resolution, allowed-root validation, regular-file and size checks, secret-like filename rejection, hashing, and audit logging.

## Architecture

```text
Telegram Bot API
      │
      ▼
Operator daemon ── SQLite / artifact registry / routing / scheduler
      │                         │
      │                         └── Claude CLI Operator session
      │                              (conversation + web only)
      ▼
T3 Code HTTP orchestration
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

Tests cover routing/focus/path selection, FTS thread reuse, idempotent reply mappings, artifact security/materialization, Telegram rich rendering/splitting, Claude CLI streaming and secret isolation, and the current T3 HTTP command/snapshot shapes.

## Deliberate MVP boundaries

The specification’s Phase 2/3 items remain outside this implementation: voice/video-note transcription and generation, semantic embeddings, forum-topic modeling, multi-user/team roles, provider migration, advanced scheduling, and a policy-editor UI. Native rich Telegram methods vary by Bot API deployment, so the transport always retains edit/HTML/plain fallbacks.
