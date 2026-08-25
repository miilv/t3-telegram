# Operations

## Health and status

- `/status` — active workers, one aggregate card per fan-out group, pending approvals, pending structured questions, and current focus.
- `/focus` — current and recent work contexts; `/focus clear` resets them explicitly.
- `/memory` — active durable notes and the latest compaction. Subcommands: `remember [category:] text`, `search query`, `forget note_id`, and `compact`.
- `/stop` — interrupts the focused worker; when focus is a fan-out group, it interrupts every active member and suppresses a later duplicate synthesis.
- `/debug` — hashed owner identity, Operator session/context size, Telegram/T3/Claude health, Telegram capability states, subscriptions, SQLite integrity/size/event count, durable queue counts, recent classified errors, and metrics.
- `/operator` — current conversational provider and configured providers;
  `/operator switch <provider>` performs a durable summary/snapshot handoff.
- `/automation` — timezone-aware `once`, `every`, and `daily` proactive work.
- `/policy` — live approval, concurrency, progress, and routing controls.
- `/dashboard` — owner/admin-only link to the loopback operations cockpit.
- `/team` — owner/admin team roster; `/team set <id> <role>` changes a role for
  an ID already present in `TELEGRAM_ALLOWED_USERS` (only owner may appoint
  owner/admin).
- `/share <project> <id> <owner|editor|viewer>` — grant project access. Team
  viewers may receive viewer access only; callbacks and process-scoped tools
  re-check the same permissions instead of trusting Telegram UI visibility.
- Logs are structured JSON. Set `LOG_LEVEL=debug` for adapter diagnostics; message bodies and secrets are not logged.
- Set `OBSERVABILITY_HASH_SALT` to a random secret so the irreversible chat
  pseudonym remains stable across restarts. Without it, a process-random salt
  intentionally changes the pseudonym on every launch.

## Operator runtime and MCP isolation

The daemon starts one Streamable HTTP MCP endpoint on a random `127.0.0.1`
port. It is not placed in `~/.claude`, a project settings file, or a worker
provider configuration. Each direct Telegram turn gets a 256-bit capability
that fixes the user role, chat, topic, origin message, allowed inbound artifacts,
and Operator turn ID. Claude
receives that capability only in a mode-`0600` MCP config inside the mode-`0700`
Operator runtime directory; the config is removed when the subprocess exits.
The command line contains only that file's path. Claude never receives the
Telegram bot token or T3 bearer token. The lease is revoked after the turn and
all leases are cleared on shutdown. Codex receives the same endpoint through an
environment-variable bearer reference in an inline, isolated MCP config; the
token itself never appears in argv. Codex user/project rules and user config are
ignored, and its shell/edit/image tool paths are disabled.

Provider subprocesses inherit an environment allowlist, not a denylist: `PATH`,
`HOME`, `PWD`, `LANG`, `LC_*`, `TZ`, `TERM`, `USER`, `LOGNAME`, `SHELL`,
`TMPDIR`, `XDG_*`, `NODE_ENV`, `ANTHROPIC_*`, `CLAUDE_*`, `OPENAI_*` (the Codex
credential), the proxy and CA-bundle variables in both spellings (`HTTP_PROXY` /
`http_proxy`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`, `SSL_CERT_FILE`,
`SSL_CERT_DIR`, `NODE_EXTRA_CA_CERTS`, `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE`),
and `BASH_DEFAULT_TIMEOUT_MS` / `BASH_MAX_TIMEOUT_MS`, which are injected at
`300000` when unset so a single Bash command cannot eat the whole turn budget.
Everything else stays in the daemon — ambient credential carriers such as
`SSH_AUTH_SOCK`, `DATABASE_URL`, `SENTRY_DSN` and `*_WEBHOOK_URL` included.
`NODE_OPTIONS` is never inherited: it injects code into the child.
(`NODE_EXTRA_CA_CERTS` only adds a trust anchor and executes nothing, so it is
allowed.) The runtime logs one `info` line on its first turn listing the names
it filtered out — names only, no values — so "the variable is missing" and "the
filter ate it" stay distinguishable.

Extra names a workflow needs go into `OPERATOR_ENV_PASSTHROUGH` as a
comma-separated list, where a trailing `*` matches by prefix. Two limits are
worth knowing before you reach for a prefix. Secrets the daemon reads for itself
are derived from the config schema (`TELEGRAM_BOT_TOKEN`, `T3_BEARER_TOKEN`,
`OPENROUTER_API_KEY`, `GOOGLE_WORKSPACE_ACCESS_TOKEN`, and every other
`*_TOKEN` / `*_API_KEY` / `*_SECRET` / `*_SALT` in it) and are checked before
any passthrough match, so no pattern — `TELEGRAM_*` included — brings them back,
and a credential added to the schema later is denied the moment it is declared.
But a prefix stays a blunt instrument for everything the schema does not know
about: `WB_*` will hand over `WB_SELLER_SECRET` sitting in your shell just as
happily as `WB_REGION`. Prefer exact names; use a prefix only over a namespace
you own end to end. A bare `*` and an empty prefix are rejected at startup.
`T3_OPERATOR_MCP_CAPABILITY` is never passed down either — the per-turn
capability is injected explicitly, and an ambient value must not shadow it.

Provider identity and native session ID are stored together. A switch first
refreshes structured memory, compacts the current runtime, starts a new native
session, and restores a bounded daemon snapshot. A failed start rolls back to
the previous provider.

## Phase 3 controls and connectors

Automation claims and their unique run jobs are committed transactionally.
Restart resets an interrupted claim, while the unique run key prevents duplicate
triggers. Daily schedules compute the next local wall-clock occurrence in their
IANA timezone, including DST transitions.

Google Calendar and Gmail tools are absent unless
`GOOGLE_WORKSPACE_ACCESS_TOKEN` is configured. Calls have fixed official API
origins, bounded schemas/results, timeouts, encoded path/query values, and
header-injection checks. Calendar creation and email sending are admin-only.

The dashboard binds only `127.0.0.1`, puts its random capability in the URL
fragment, requires `Authorization: Bearer` on its APIs, sends `no-store` and
restrictive security headers, and exposes no credentials or raw messages.

Telegram message/reply/media tools cannot select another chat. Reactions may
target only the triggering envelope or a same-turn sent message, and edits may
target only a same-turn sent message. Paths supplied to media/file tools are
accepted only after project-root, realpath/symlink, secret-name, size and hash
validation. Tool audit events store tool name and duration, not arguments.

## Voice and video notes

Inbound voice/audio and video notes are retained as original, hashed artifacts
before media processing starts. Configured STT adapters are attempted in order:
OpenAI, Groq, Deepgram, then local Whisper. Provider responses, credentials, and
transcript text are not written to logs or audit payloads. A provider timeout,
size rejection, or total failure adds an explicit unavailable marker to the
Operator envelope and leaves the original usable.

Video notes additionally produce a registry-managed OGG/Opus audio derivative
and 3–6 evenly spaced JPEG keyframes. Their source artifact ID is persisted;
the direct Operator can inspect a keyframe only through the size/type-bounded
`artifacts.view_image` capability. Worker delegation receives the same
registered originals and derivatives through normal artifact materialization.

`telegram.send_voice` accepts either text for TTS or an existing artifact/path.
Every result is normalized to mono OGG/Opus before `sendVoice`.
`telegram.send_video_note` always crops/scales to 640×640, encodes H.264/AAC
MPEG-4, caps duration at 60 seconds, probes the result, registers it, and only
then calls `sendVideoNote`. Telegram's 50 MiB upload ceiling is enforced.

## Restart behavior

SQLite uses WAL mode. On startup the daemon:

1. migrates/reopens durable state;
2. resumes the persisted infrastructure provider and native session;
3. checks Telegram, Operator runtime, and T3 health;
4. restores unsent approval and structured-question prompts;
5. reconciles T3 thread state;
6. restores monitors for running/waiting workers and dispatches due queued follow-ups for idle threads;
7. replays interrupted idempotent Telegram edits/keyboard cleanup and resumes
   pending outbox work; an interrupted fresh send is marked `uncertain` rather
   than duplicated;
8. retries accepted T3 tasks with the original command ID, which T3 deduplicates
   through its transactional command receipt;
9. refreshes pending approval/question keyboards and resets an interrupted
   clarification so the owner's response can be retried;
10. resumes all-terminal fan-out groups whose synthesis was pending or interrupted;
11. resets interrupted automation claims and dispatches due unique runs;
12. delivers an undelivered completion for an Operator-owned thread.

## Memory and maintenance

The daemon runs a coalescing maintenance tick every minute. The tick does not compact every minute: SQLite's `last_compaction_at` is the durable gate, and compaction runs when it is at least 24 hours old. Restart at any hour therefore cannot skip the daily job. Maintenance also reconciles T3 worker subscriptions, refreshes stale structured thread summaries, expires notes, and removes only expired files physically contained in the managed artifact root.

Thread memory stores purpose, current state, important decisions, files, open issues, and next actions. Worker completion normalization updates it; handoff packets consume it. Full T3 transcripts and tool histories remain in T3. After Claude context compaction, the daemon injects a bounded, secret-redacted snapshot containing focus, project/thread references, active work, pending interactions, open loops, and active notes.

Natural-language forms such as “запомни, что …” / “remember that …” and “что ты помнишь про …?” / “what do you remember about …?” use the same durable note store. Duplicate notes are merged, expiring notes become obsolete, and note/thread-summary text is redacted before persistence. Search combines SQLite FTS with deterministic local semantic vectors; no note text leaves the process for embedding.

Telegram updates are deduplicated by `(chat_id, message_id)`. Approval callbacks, structured-input callbacks, and T3 interaction events have separate durable dedupe keys. Resolved interactions have their inline keyboards cleared even when they were resolved from another T3 client.

Routing clarifications store the original normalized update, candidate thread IDs, and artifact IDs. Reply with the displayed number, the exact thread ID, or an unambiguous title; invalid replies leave the clarification pending. Fan-out members are ordinary T3 threads and remain independently inspectable, but Telegram receives only the group start, meaningful throttled progress, and one final synthesis.

Worker starts, progress, terminal results, group syntheses, requested artifacts,
interaction cleanup, and direct Operator finals use the durable outbound queue.
Terminal results edit a recorded status anchor, so restart replay is idempotent
and the completion marker is committed only after delivery. Telegram exposes no
idempotency key for a brand-new send: if the process dies while such a request
is in flight, the row is deliberately quarantined as `uncertain` for owner
inspection instead of risking a duplicate.

T3 dispatch is persisted before the RPC call. A connection failure leaves it
pending with exponential backoff and the user sees a safe saved-task notice.
The command ID is stable across attempts; current T3 stores the command receipt
in the same transaction as orchestration events and returns the receipt on a
replay. Provider failures are classified without raw provider text, and the
Operator chooses one bounded recovery action: retry once, start a recovery
thread, switch to an advertised provider, or report.

## Running under systemd

The production deployment is a systemd user unit with `Restart=always`, so the
process itself comes back after a crash. Two additional layers make a failure
*visible* instead of silent (bug №7):

1. On startup the daemon detects an unclean previous exit (the durable
   `clean_shutdown` marker was never written) and sends the owner a short
   «перезапустился после сбоя, восстановлено задач: N» notice through the
   durable outbox.
2. An `OnFailure=` companion unit notifies the owner even when the daemon
   cannot start at all (crash loop, broken config, dead Node): systemd triggers
   it whenever the main unit enters the failed state.

Main unit additions (`~/.config/systemd/user/t3-telegram-operator.service`):

```ini
[Unit]
Description=T3 Telegram Operator
OnFailure=t3-telegram-operator-failed.service

[Service]
Restart=always
RestartSec=5
# StartLimitIntervalSec/StartLimitBurst turn a crash loop into a hard failed
# state, which is what actually fires OnFailure.
StartLimitIntervalSec=300
StartLimitBurst=5
```

Notifier unit (`~/.config/systemd/user/t3-telegram-operator-failed.service`) —
a one-shot `curl` straight to the Bot API, deliberately independent of the
daemon's own code and dependencies:

```ini
[Unit]
Description=Notify the owner that the T3 Telegram Operator failed

[Service]
Type=oneshot
# Mode-0600 file with TELEGRAM_BOT_TOKEN and OWNER_CHAT_ID; never inline tokens.
EnvironmentFile=%h/.operator/notify.env
ExecStart=/usr/bin/curl -sS -m 15 \
  --data-urlencode "chat_id=${OWNER_CHAT_ID}" \
  --data-urlencode "text=T3 Telegram Operator упал и не поднялся — нужен ручной разбор: systemctl --user status t3-telegram-operator" \
  "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage"
```

After editing units run `systemctl --user daemon-reload`. Test the wiring with
`systemctl --user start t3-telegram-operator-failed` (the message should
arrive) and by killing the daemon repeatedly to exhaust the start limit.

## Running under launchd

Create `~/Library/LaunchAgents/com.local.t3-telegram-operator.plist` with an explicit working directory and environment file wrapper. Do not place the Telegram/T3 tokens directly in a world-readable plist. A minimal wrapper can load a mode-`0600` env file and execute:

```bash
cd /absolute/path/to/t3-telegram
exec /opt/homebrew/bin/pnpm start
```

Set `KeepAlive` and `RunAtLoad` in the launch agent. The process handles `SIGTERM`/`SIGINT` and closes subscriptions and SQLite cleanly.

## T3 compatibility

The adapter targets the current upstream endpoints:

- `GET /api/orchestration/shell`
- `GET /api/orchestration/threads/:threadId`
- `POST /api/orchestration/dispatch`

It sends the upstream command discriminators (`project.create`, `project.meta.update`, `thread.create`, `thread.turn.start`, `thread.turn.interrupt`, `thread.approval.respond`, and `thread.user-input.respond`). The default subscription path uses T3's Effect RPC protocol over WebSocket with sequence resume. Snapshot polling remains an explicit compatibility mode for legacy/test servers.

`APPROVAL_AUTO_ALLOW` is an explicit comma-separated allowlist. Its default is only `safe-read`; dangerous, cross-project, secret-sensitive, process, package, and network actions continue to require Telegram confirmation unless the owner deliberately changes the policy.
