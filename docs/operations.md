# Operations

## Health and status

- `/status` — active workers, one aggregate card per fan-out group, pending approvals, and pending structured questions.
- `/memory` — active durable notes and the latest compaction. Subcommands: `remember [category:] text`, `search query`, `forget note_id`, and `compact`.

Stopping work is not a command (package 1.3 removed `/stop`, `/cancel` and
`/focus`). Ask for it in words — «останови сборку» — and the Operator interrupts
the thread itself. A bare cancel word («стоп», «отмена», «хватит», `stop`,
`cancel`) stays the deterministic emergency hatch that works even when the model
cannot answer: it interrupts the running turn, and, when it replies to a work
message, the work behind it (dialogue-flow §4).
- `/debug` — hashed owner identity, Operator session/context size, Telegram/T3/Claude health, Telegram capability states, subscriptions, SQLite integrity/size/event count, durable queue counts, recent classified errors, and metrics.
- `/operator` — current conversational provider and configured providers;
  `/operator switch <provider>` performs a durable summary/snapshot handoff.
- `/automation` — timezone-aware `once`, `every`, and `daily` proactive work.
- `/policy` — live approval, concurrency, progress, and routing controls.
- `/dashboard` — owner/admin-only link to the loopback operations cockpit. Its
  durable outbox row contains only a token-free discriminated delivery intent;
  dispatch late-binds the current process's capability through a dedicated
  Telegram send boundary. Generic messages/events/logs still redact it, replay
  dedupes by the inbound command, and an interrupted old-process intent is
  retried with the new link (same-process ambiguous remote sends remain quarantined).
- `/team` — owner/admin team roster; `/team set <id> <role>` changes a role for
  an ID already present in `TELEGRAM_ALLOWED_USERS` (only owner may appoint
  owner/admin).
- `/share <project> <id> <owner|editor|viewer>` — grant project access. Team
  viewers may receive viewer access only; callbacks and process-scoped tools
  re-check the same permissions instead of trusting Telegram UI visibility.
- `OPERATOR_MENU` decides how much of the command table Telegram is told about:
  `full` (default, the role-filtered list), `minimal` (`/help` and `/status`
  only) or `hidden` (an empty list in every scope, i.e. no «Меню» button). It is
  a publication filter, not a permission: every command still dispatches when
  typed by hand, and `/help` still lists them. The menu is republished on each
  boot, so changing the value and restarting is enough. `hidden` also empties
  the `all_private_chats` scope, where a list set once through BotFather would
  otherwise outlive an emptied default. Do not set the variable to an empty
  string — either leave it out or give it one of `full|minimal|hidden`; an empty
  value fails validation at start-up, as it does for the neighbouring enums.
- `OPERATOR_PREEMPTION` decides what the owner's next message does to the turn
  already answering them: `supersede` (default) interrupts it — single voice,
  the newest message is the conversation — while `off` finishes it and answers
  the messages that piled up behind it together, each as its own labelled block
  with its own attachments. Pick `off` for an owner who thinks in short bursts,
  where "answer only the current message" throws away most of what they said;
  keep the default where a stale half-answer is worse than a lost one. An
  envelope carries at most 20 queued messages, and at most 32 KiB of their text
  (older blocks past that are collapsed to their first 200 characters plus the
  message id, so an OCR'd scan cannot inflate one envelope to half a megabyte),
  before it stops waiting. A queue whose message never reaches the model — the
  next message was a command, a stop word, or failed outright — is answered by a
  synthetic drain turn rather than waiting for the owner to write again. As with
  the neighbouring enums, an empty value fails validation at start-up — leave
  the variable out or give it one of `supersede|off`. Restart to apply. Full
  mechanics: `docs/dialogue-flow.md` §4. Under `off`, a message that steps into
  the queue after the owner has already been waiting over 30 seconds draws one
  «⏳ Доделываю предыдущее — отвечу следом» — once per queue, not per message,
  and sent out of band so the acknowledgement cannot queue behind the jam it
  reports.
- `OPERATOR_BATCH_WINDOW_MS` (default `2000`) is the quiet period that closes an
  inbound batch: everything the owner sends within it becomes one envelope
  instead of one turn per line. The right value is a property of the person —
  someone who thinks in three short messages needs a wider window (5000 is a
  reasonable setting for that) than someone who writes in paragraphs. The 180 s
  ceiling on a batch that keeps re-arming is unchanged. Restart to apply.
- Every Operator envelope opens with one `Attached now: MCP …; skills …` line —
  the extra MCP servers and curated skill directories the daemon is attaching to
  *that* turn, read fresh through the same ownership gate the runtime uses. It
  is deliberately not part of the pushed memory state (it moves no diff
  baseline): the agent is told to take tool availability from that line and
  never from its own memory notes.
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

Servers beyond the built-in `operator` one are opt-in through
`OPERATOR_EXTRA_MCP_CONFIG`: a path to a JSON file in Claude Code's own
`--mcp-config` shape (`{"mcpServers": {"brain": {"command": …}}}`, stdio or
http/sse). Its entries are merged into the per-turn config and each attached
server gets an `mcp__<name>__*` entry in `--allowed-tools`, without which
`dontAsk` would refuse its tools. `--strict-mcp-config` stays on, so an ambient
`~/.mcp.json` still reaches nothing, and an entry named `operator` is ignored —
the built-in server carries the turn capability and always wins. The file is
re-read on every turn, so editing it needs no restart; an unreadable or
malformed one costs one `warn` line and the turn runs with `operator` alone.
Contents are never logged, only server names: the file holds tokens.

The file names executables, so it is refused unless it — and the directory
holding it — is owned by the daemon's own user and is not group- or
world-writable (`chown $USER`, `chmod 0644`/`0600`, directory `0755`/`0700`).
Otherwise anyone with write access there could add a `{"command": "/bin/sh"}`
server and have it start on the next turn. An entry that could not be launched
at all (no `command` for stdio, no `url` for http/sse) is dropped with a warn.
`/debug` prints the server names that would attach right now, or the reason the
file was refused.

The allowlist is also gated on the curated settings file below, and this pairing
is a money rule rather than a hygiene one: paid MCP tools arrive through
`OPERATOR_EXTRA_MCP_CONFIG`, the `PreToolUse` hook that gates them can arrive
only through `OPERATOR_CLAUDE_SETTINGS`, and the two are separate env lines. So
if the settings path is unset, unreadable, writable by anyone else or not valid
JSON, **no** extra server is attached at all — one `warn`, and `/debug` says
`blocked (Claude settings: …)`. Tools with a price and no hook in front of them
is the one combination nobody would configure on purpose.

### Curated settings and skills

`--setting-sources ""` is what keeps the owner's `~/.claude` — its
`settings.json`, its hooks, its skills, its `bypassPermissions` — out of every
turn. Two things the owner does want are handed to the CLI by name instead, and
neither loosens that.

`OPERATOR_CLAUDE_SETTINGS`: a path to a Claude Code settings JSON, passed as
`--settings`. It is read even with no setting sources, and hooks live nowhere
else — a `PreToolUse` hook is the only thing that can stand between the agent
and a paid MCP tool. Measured against CLI 2.1.233: `SessionStart`,
`UserPromptSubmit`, `PreToolUse` and `Stop` all fire from this file, a matcher
of `mcp__<server>__.*` matches MCP tools, and a `deny` verdict really does stop
the call before the server sees it.

`OPERATOR_SKILLS_DIR`: a path to a directory shaped like a Claude Code plugin —
its `skills/<name>/SKILL.md` files become the turn's skills — passed as
`--plugin-dir`. This is the only skill channel that survives the isolation:
skills cannot be named from a settings file (the `skillsDirs` key is team-store
only), and the user scope is exactly what is being excluded. Note that
`--disable-slash-commands` disables *all* skills, so it is dropped for the turn
once a skill directory is attached; put `"disableBundledSkills": true` in the
settings file to take the CLI's own bundled skills back out. The daemon warns
once if a skill directory is configured without a usable settings file.

Both paths are code-execution channels — a settings file is a list of commands
the CLI runs, and a plugin directory can carry a `hooks/hooks.json` of its own
(verified: it runs) — so both are held to the same ownership gate as
`OPERATOR_EXTRA_MCP_CONFIG`: owned by the daemon's user, not group- or
world-writable, in a directory that is the same. The settings file must parse as
JSON on top of that: one whose hooks will never load has to be as visible as one
that is missing. A path that fails is left off the command line with one `warn`
line, and the turn runs without it. Both are re-checked per turn, so a `chmod`
on the box needs no restart. `/debug` prints the verdict each would get right
now.

None of this bounds an agent that means it: on a box with
`OPERATOR_FULL_ACCESS=true` the daemon's user is also the agent's user, so the
hook, the settings file and the transcript a hook reads are all writable from
inside the turn. The gate stops an inattentive agent; a spending limit on the
paid account is the boundary that stops a determined one.

`--strict-mcp-config` still applies to a plugin: an `.mcp.json` inside the
plugin directory attaches nothing (verified). The MCP allowlist stays the only
way in.

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
restrictive security headers, and exposes no credentials or raw messages. A
pending `/dashboard` delivery stores no URL or token: restart recovery resolves
the link from the newly started dashboard, while a disabled dashboard leaves the
intent retryable instead of emitting or discarding a stale capability.

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
   than duplicated. A rich chunk that was on the wire when the process stopped
   is recognised by the `pendingChunkIndex` the payload records *before* the
   send: the retry counts it as delivered instead of putting a second copy in
   the chat, and says so once out of band («предыдущая отправка могла не
   дойти»). At-most-once for that one window is deliberate — a duplicate is
   silent, a loss is not, and it takes a double failure to lose anything;
8. removes a previous bot's persistent reply keyboard once, marked in
   `runtime_state` as `legacy_keyboard_cleared` so it is not repeated at every
   restart (a reply keyboard lives in the client and outlives the bot that
   installed it);
9. retries accepted T3 tasks with the original command ID, which T3 deduplicates
   through its transactional command receipt;
10. refreshes pending approval/question keyboards and resets an interrupted
   clarification so the owner's response can be retried;
11. resumes all-terminal fan-out groups whose synthesis was pending or interrupted;
12. resets interrupted automation claims and dispatches due unique runs;
13. delivers an undelivered completion for an Operator-owned thread.

## Memory and maintenance

The daemon runs a coalescing maintenance tick every minute. The tick does not compact every minute: SQLite's `last_compaction_at` is the durable gate, and compaction runs when it is at least 24 hours old. Restart at any hour therefore cannot skip the daily job. Maintenance also reconciles T3 worker subscriptions, refreshes stale structured thread summaries, advances at most one explicit 25-note embedding-backfill page outside startup, and removes only expired files physically contained in the managed artifact root. Notes are never automatically expired.

The **night secretary** is the last step of the same tick and runs between 02:00 and 04:00 in `OWNER_TIMEZONE`, once per logical day (`last_scribe_day`). It reconciles the event log against the journal and the now-state, files now items whose TTL ran out, writes the day's summary, builds the previous month's rollup, fills in missing note descriptions, and distils new logical correspondence. The distiller reads an independent per-owner ledger cursor with a frozen high water, at most 200 rows/64,000 code points per call and three calls per run. Only nonempty owner-assertion evidence may support a fact. `NOTHING` advances successfully; provider/parse failure leaves that page pending.

An oversized first ledger row is projected deterministically to the 64,000-code-point boundary with explicit truncation metadata; the durable source row is never rewritten. A provider-completed whitespace response is counted as one invalid call, leaves the cursor unchanged, and is degraded rather than recorded as a channel outage.

Its LLM passes go through the **Claude branch** of the runtime regardless of which provider the main session is on, and never through the main session itself. If that branch is unavailable the night is skipped with a journal entry, the next night catches up over a 48-hour window, and after three consecutive total skips the owner is told once — through an Operator turn, not a message from the daemon. A partially completed catch-up is `degraded` and does not increment the outage streak.

Narrative state lives in `runtime_state` under `last_scribe_at`, `last_scribe_recovery_at`, `last_scribe_day`, `scribe_consecutive_misses`, `scribe_miss_alert_day` and `last_scribe_rollup_month`; distillation progress lives separately in `conversation_ledger_cursors` under `(night-scribe-distillation, owner_id)`. Candidate collisions are persisted in `memory_merge_proposals` before notification. Owner-turn requests are first persisted under `scribe_pending_owner_turn:*` and removed only after durable enqueue is confirmed, so an unknown owner chat or queue error retries later without losing or duplicating a proposal.

One caveat worth knowing before an incident: the maintenance tick is coalescing and serial, so while a night pass is running (up to a few minutes when it makes several model calls) that tick is occupied. Delivery is unaffected — the reliability pump owns the outbox and the T3 drains on its own one-second loop — but steps that run *only* from the tick wait: due automations, bounded embedding backfill, artifact cleanup and worker-subscription recovery.

`journal_entries` has no retention — it is the durable narrative, and the monthly rollup is built from it precisely because `daemon_events` is pruned at 30 days. For an older query `memory.journal` adds a bounded journal selection for only the pruned part, prioritizes rollups, and reports the requested range, actual evidence range, and omissions separately. Bodies returned by `memory.journal`, `journal.read`, and `journal.note` are worker-fenced untrusted data; machine metadata stays structured.

Thread memory stores purpose, current state, important decisions, files, open issues, and next actions. Worker completion normalization updates it; handoff packets consume it. Full T3 transcripts and tool histories remain in T3. After Claude context compaction, the daemon injects a bounded, secret-redacted snapshot containing focus, project/thread references, active work, pending interactions, open loops, and active notes.

Natural-language forms such as “запомни, что …” / “remember that …” and “что ты помнишь про …?” / “what do you remember about …?” use the same durable active-only store. Keyed writes return structured written/merge-proposal/cross-link outcomes. A past `valid_until` stays visible in push/search/get/list but carries `[not verified … treat as hypothesis]`; accepted offsets are canonicalized to UTC and the monthly owner turn asks one bounded verification question without automatically obsoleting it. Search combines FTS with the complete compatible active set for the selected local vector model; both `/memory search` and natural recall use that async path. Successful public get/search reads increment usage, while misses and internal push/list/distillation scans do not. No note text leaves the process for embedding.

Keyed human-turn writes persist the complete original structured outcome, including proposals and cross-links, so replay is stable after later note mutations. Scheduled app turns cannot call the legacy unkeyed `memory.remember` path; their replay-safe capability fails closed with zero note side effects.

### Offline note model provisioning

The runtime is pinned to `@huggingface/transformers` 3.8.1 and the selected model id is `Xenova/paraphrase-multilingual-MiniLM-L12-v2` (384 dimensions). Weights are operator-supplied and must not be committed or downloaded by the daemon:

1. Resolve and record an immutable upstream model commit/revision in the deployment change.
2. Download/export that exact revision outside the daemon into a private local directory.
3. Generate a manifest such as `find MODEL_ROOT -type f -print0 | sort -z | xargs -0 sha256sum`, store the manifest/checksum in deployment records, and verify it before rollout.
4. Set `NOTE_EMBEDDING_MODEL_ROOT` to that directory. The daemon sets Transformers.js remote access to false before constructing the pipeline.
5. Run `NOTE_EMBEDDING_REAL_MODEL_SMOKE=1 pnpm vitest run tests/operator-note-real-model.smoke.test.ts`. The smoke is skipped when opt-in/root is absent; when enabled it requires a semantic normalized 384d result.

Missing/corrupt weights select the deterministic 384d hash fallback. Semantic merge thresholds are disabled on the fallback; exact-key protection still applies.

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

`APPROVAL_TTL_HOURS` (default `6`, range `0.25`–`168`) bounds how long an unanswered approval keyboard stays live. The 60 s maintenance tick actively sweeps expired requests: each one is declined to T3 with reason `approval expired`, its keyboard is removed, and its message is rewritten to «Запрос истёк без ответа (6 ч) — действие отклонено». The deadline is named in minutes below two hours («15 мин») and with one decimal above it («12,5 ч»), so the text never rounds a missed deadline into a different one. Expiry is deliberately measured in hours, not minutes — the owner may be asleep — and expired requests are never redrawn after a restart.

A chat keeps at most four pending approvals **across all threads**: a fifth request is shown and the oldest unanswered one is declined with reason `approval superseded`, so nothing is silently dropped. Eviction is a real decline for the worker, not a deferral.

Both paths claim the row (`pending` → `expiring`) before dispatching to T3, so a sweep and a button press can never send two different decisions for the same request; a claim whose owner died is released after a five-minute lease and retried on a later tick. The expiry dispatch is bounded by a 15 s timeout, and after five failed attempts the request is retired locally — the keyboard is removed and the card says the decline could not be delivered — instead of warning every minute forever.

`APPROVAL_AUTO_ALLOW` is an explicit comma-separated allowlist. Its default is only `safe-read`; dangerous, cross-project, secret-sensitive, process, package, and network actions continue to require Telegram confirmation unless the owner deliberately changes the policy.
