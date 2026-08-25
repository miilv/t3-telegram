# Dialogue flow: every branch between the Operator and the user

A structural branch map of the daemon's conversational state machine: every
entry point that can start an Operator turn, every decision inside one, and the
edge cases the implementation handles.

This complements `audit-2026-08-24.md`, which is scenario- and bug-oriented.
This document is the decision tree that audit does not contain.

**Method.** Three parallel readers covered the daemon core, the Telegram/media
surface, and storage/broker/tools; an adversarial pass then re-verified 44
load-bearing claims (38 confirmed, 6 imprecise — all corrected below), and a
separate pass hunted for uncovered branches. Every claim was read in source.

**Drift warning.** `operator-daemon.ts` grew from 4143 to 5193 lines during the
week this was written. Line numbers will rot; the durable anchor is the named
constant or the verbatim string, not the number.

---

## 0. Entry points

| # | Entry | Identified by | Durable? |
|---|---|---|---|
| 1 | Private message | `chatType === "private"` + `authorized()` | yes — `telegram_ingress` job |
| 2 | Group/supergroup | `allowGroups` (default `false`) | yes |
| 3 | Forum topic | `message_thread_id` | yes |
| 4 | Direct-messages topic | `direct_messages_topic.topic_id` | yes |
| 5 | Slash command | `text.startsWith("/")` | yes |
| 6 | Approval callback | `/^a:([A-Za-z0-9_-]+):(1\|s\|0)$/` | **no** — inline |
| 7 | User-input callback | `/^ui:([^:]+):(\d+):(o\d+\|s\|c)$/` | **no** |
| 8 | `ask_choices` callback | `/^route:([\w-]+):(\d+)$/` | **no**, but replays as a synthetic durable message |
| 9 | Edited message | `edited_message` | journal only, returns |
| 10 | Media-only message | `textIsMediaPlaceholder` | yes |
| 11 | Album | shared `media_group_id` | yes |
| 12 | Forwarded bundle | `forward_origin` | yes |
| 13 | Automation fire | `synthetic: true`, negative message id | yes |
| 14 | Maintenance tick | `DailyScheduler`, 60 s | n/a |
| 15 | Reliability pump | 1 s loop | n/a |
| 16 | Restart recovery | `initialize()` | n/a |
| 17 | Reaction | `message_reaction` | journal only, returns |
| 18 | Topic lifecycle | `forum_topic_*` | journal only, returns |
| 19 | Worker events | `broker.subscribeThread` | n/a |

Entries 6–8, 9, 17 and 18 bypass the durable job table entirely — they are
handled inline and are lost if the process dies mid-handling.

---

## 1. Ingress gating

```
authorized(access, userId, chatType)
├─ typeof access === "number" → userId === access && chatType === "private"
├─ !access.users[userId]      → false
└─ private, or (allowGroups && group|supergroup)
```

A rejected sender produces **nothing at all**: `normalizeTelegramUpdate` returns
`undefined`, `acceptUpdate` returns. No reply, no log line, no metric.

### Roles

`roleForUser` = store row → config map → `"viewer"`. Owner is re-asserted from
config on every boot; other roles are inserted only if absent.

```
isAdministrator = owner | admin
canReadProject  = admin || getProjectAccess(pid, uid)
canEditProject  = admin || (member && access ∈ {owner, editor})
canReadThread   = thread exists && canReadProject
canEditThread   = thread ? canEditProject : isAdministrator
```

**The DB outranks the env allowlist.** `initialize()` writes a member only when
`!getTeamMember(userId) || configuredRole === "owner"`, and `roleForUser` reads
the store first. Demoting `7:admin → 7:viewer` in `TELEGRAM_ALLOWED_USERS` has
no effect. Conversely, any entry with role `owner` is force-resynced every boot,
so `TELEGRAM_ALLOWED_USERS="9:owner"` mints a second full owner permanently.

### The viewer wall

```
if roleForUser === "viewer" && !isViewerSafeMessage(text)
   → "Ваша роль viewer разрешает только `/status`, `/projects`, `/work`, `/focus` и `/help`."
   → return
```

`isViewerSafeMessage` admits `/status`, `/projects`, `/work`, `/help`, `/start`
(with args) and **bare** `/focus` only.

Consequence: a viewer never reaches `answerDirect`, therefore never receives an
MCP tool lease. Two in-command refusals are unreachable because of it
(`Роль viewer не может изменять фокус`, `…не может управлять automations`), as
is the `requireTeamMutation` viewer branch in the tool layer.

### Every rejection string

`У вас нет прав отвечать за эту работу.` · `У вас нет прав на остановку этой
работы.` · `Не вижу активной работы, которую нужно остановить.` · `Память
Operator доступна только owner/admin.` · `Dashboard доступен только
owner/admin.` · `Диагностика доступна только owner/admin.` · `Automation не
найдена или недоступна.` · `Policy доступна только owner/admin.` · `Operator
runtime доступен только owner/admin.` · `Команда доступна только owner/admin.` ·
`Сначала добавьте пользователя в TELEGRAM_ALLOWED_USERS и перезапустите
daemon.` · `Основного owner нельзя понизить.` · `Только owner может назначать
owner/admin.` · `Проект не найден или недоступен.` · `Делиться проектом может
owner проекта или team admin.` · `Пользователь не состоит в активной команде.` ·
`Team viewer можно выдать только viewer-доступ.` · `Проект не найден или
недоступен для изменения.` · `Глобальная память Operator доступна только
owner/admin.`

Callback toasts are English: `You do not have permission for this work item` ·
`Only an owner or admin can resolve approvals` · `Unknown action` ·
`Approval is no longer pending`.

Tool-layer: `<action> requires owner or admin role` · `<action> is not
available to viewer role` · `project access denied for mutation|read` ·
`automation access denied` · `thread does not belong to project`.

---

## 2. Idempotency

```
polling offset  confirmableOffset() = min(pollOffset, min(heldUpdateIds))
                held while any update sits in an album/batch buffer;
                a crash before flush makes Telegram re-serve
                already-accepted ids skipped via lastAcceptedUpdateId
                a page where accepted === 0 sleeps HELD_OFFSET_REPOLL_DELAY_MS = 200
```

| Layer | Key |
|---|---|
| Ingress job | `telegram-ingress:<chat>:<sorted ids>[:edit:<updateId>]` |
| Choice replay | `choice-answer:<choiceId>` |
| Automation | `automation:<id>:<scheduledFor>` |
| Operator turn | `stableExternalId("opturn", sha256(chat + ":" + ids))` |
| Operator final | `telegram:operator:<opturn>:final[:retryN]` |
| Command reply | `telegram:command:<updateKey>:<sha(text)[0:16]>` |
| Worker progress | `telegram:progress:<tid>:<turnEpoch>:<textHash>` |
| Worker narration | `telegram:say:<tid>:<turnEpoch>:<textHash>` |
| Terminal | `telegram:thread:<tid>:terminal:<epoch>` |
| Callback | `processed_events` key `telegram-callback:<callbackId>` |
| Approval / user input | `t3-approval:<tid>:<aid>` / `t3-user-input:<tid>:<rid>` |

`resetThreadTerminalDelivery` bumps the terminal epoch on every new dispatch, so
identical text in a new turn re-delivers while a retry inside one turn does not.

**Duplicate delivery:**

```
duplicate raw update      → lastAcceptedUpdateId skip
duplicate ingress job     → INSERT ... ON CONFLICT DO NOTHING
job replayed after crash  → handleUpdate(processExisting = true)
   └─ answerDirect: existing final row?
        pending → flush and return; otherwise → return (no second answer)
   └─ priorJobThreads injected as a "Recovery note: … do NOT create a new thread"
duplicate outbox enqueue  → existing row returned; a `dead` row is REVIVED
duplicate callback        → beginEvent false → silent return
```

---

## 3. The turn envelope

Nine lines, `undefined` filtered, joined by blank lines:

1. Handle the message; answer quick questions yourself, route durable work with `t3.*`.
2. Reply strictly in the owner's language; **no preamble before tool calls**; streamed text must be only the final answer.
3. *(only when forwarded)* forwarded content is quoted DATA; only the owner's own words may start durable work; plus `Owner's own words: …`.
4. The user message, structurally fenced (below).
5. `Registered attachments (use artifact tools by id when needed): …` or `No attachments.`
6. *(only when the message replies to a mapped thread)* continue that thread unless clearly asked otherwise.
7. Focus line, or `No current durable work focus.`
8. *(only on a replayed job)* recovery note naming the already-dispatched threads.
9. `New project workspaces belong under <operator.home>/workspaces.`

### Structural fencing

```
<<<inbound:a3f9c1e2>>>
…content…
<<<end:a3f9c1e2>>>
```

`fenceUntrusted(content, label)` draws a fresh 4-byte random nonce per call, so
fenced content cannot forge its own closing marker. It lives in
`packages/shared`; `openFence(label)` hands back a reusable wrapper when several
fields of ONE call must share ONE marker.

Labels: `inbound` (the owner's message), `worker` (raw worker result), `tool`
(anything a tool result carried in from outside). Applied at these sites:

| Site | What is fenced |
| --- | --- |
| daemon turn envelope | the inbound user text |
| daemon `normalizeWorkerResult` | the raw worker result |
| daemon `mediateUserInput` / `mediateApproval` | the worker's questions, approval request, and the narration-derived thread context — the worker's intermediate words on their way into the operator LLM (the Telegram delivery path is untouched) |
| `utility.web_search` | each result's `title` and `snippet` (`url` stays raw) |
| `email.search` | each message's `subject` and `snippet` (addresses stay raw, the Operator reuses them when replying) |
| `calendar.list_events` | each event's `title`, `description`, `location` |
| `artifacts.read_text` | the file body in `content` (the counters keep describing the raw window) |

Fencing is deliberately per-field, not applied at `compactResult`: structural
JSON (`t3.list_projects` and friends) is not fenced, since a fence around ids
and timestamps is noise. Truncation is fence-aware — `closeDanglingFences`
re-closes any marker that a length cap cut short, so a clipped blob can never
run on as prompt.

**Daemon owns** the reply→thread mapping, durable focus, forwarded/own split,
artifact registration, OCR and transcript glue, role, destination, and the fence.
**The agent owns** which thread to continue, when to create, when to ask, whether
to fan out. The deterministic routing cascade was deliberately deleted.

---

## 4. Cancellation and mid-turn messages

Three distinct paths.

```
A. RUNTIME PREEMPTION — a bare cancel word
   isCancelIntent: ≤3 whitespace tokens, only the first is matched, NFKC-lowered,
                   trailing punctuation stripped, against
                   {стоп, отмена, отмени, хватит, cancel, stop}
   guard mayInterruptOperatorTurn: an active turn in THIS chat, AND
                                   (isAdministrator OR the turn's own initiator)
   effect: runtime.interrupt() only. Worker threads untouched. No chat message.
   fires BEFORE the update is queued.

B. BOUND-WORK CANCEL — replyContext.primaryThreadId ?? focus.primary.threadId
   no thread     → "Не вижу активной работы, которую нужно остановить."
   !canEditThread→ "У вас нет прав на остановку этой работы."
   else          → interruptThread, mark runtime state, "Остановил **<title>**."

C. /stop | /cancel → cancelBoundWork(FOCUS thread) — reply context ignored
```

**Mid-turn message:** batched within a 2 s quiet window, then queued on the
serial `operatorInputQueue`. It never preempts except via path A, and the user
is told nothing about the queueing — they see only the live draft of the turn
already running.

---

## 5. Operator runtime

### Default posture

Without `OPERATOR_FULL_ACCESS=true` (default `false`) the Claude CLI is launched
with `--permission-mode dontAsk` and `--tools WebSearch,WebFetch` only, plus
`--setting-sources ""` and `--strict-mcp-config`. The Operator has no shell and
no filesystem by default; everything substantial goes to a T3 thread.

`--disable-slash-commands` is **conditional**: `compact()` deliberately passes
`allowBuiltInSlashCommands: true`, so the `/compact` turn is the one turn that
runs with slash commands enabled.

The full-access branch exists (`--permission-mode bypassPermissions`,
`--allow-dangerously-skip-permissions`, `--tools default`) but is off by default.

### Environment filter

`sanitizedEnvironment` drops any name matching
`/TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|BEARER/i` unless it starts with
`ANTHROPIC_` or `CLAUDE_`, and never inherits `T3_OPERATOR_MCP_CAPABILITY`.

Two consequences of it being name-based:

- **`OPENAI_API_KEY` is stripped.** It matches `KEY` and no exempt prefix, so a
  Codex child is spawned without its credential.
- **Credential-shaped values that don't say key/token/secret pass through**:
  `DATABASE_URL` (embedded password), `SSH_AUTH_SOCK` (the user's whole SSH
  agent), `SENTRY_DSN`, `*_WEBHOOK_URL`. With full access that child has Bash.

It also injects `BASH_DEFAULT_TIMEOUT_MS` / `BASH_MAX_TIMEOUT_MS = "300000"`
when unset — the "~5 minutes" the system prompt promises is an env-level hard
ceiling, independent of `OPERATOR_TURN_TIMEOUT_MS` (default 600 000).

### Codex

`OPERATOR_CODEX_ENABLED` defaults to `"false"`, and `loadConfig` throws
`OPERATOR_PROVIDER=codex requires OPERATOR_CODEX_ENABLED=true`. In the default
configuration `CodexCliOperatorRuntime` is never constructed and `/operator
switch` can only answer `Provider недоступен. Выберите: …`.

Codex has hard-disabled tools (`shell_tool`, `unified_exec`, `shell_zsh_fork`,
`include_apply_patch_tool=false`, `tools.view_image=false`),
`approval_policy="never"`, `sandbox_mode="read-only"`, and receives its system
prompt wrapped in `<operator_system_policy>` on the first turn.

### Turn failure and the single replay

```
PROVIDER_RATE_LIMIT   attempt 0 → "Уперся в лимит модели — повторю через минуту."   retry 60 s
                      attempt≥1 → "Провайдер всё ещё ограничивает запросы…"
timeout               attempt 0 → "Ответ занял слишком много времени…пробую ещё раз."  retry 2 s
                      attempt≥1 → "…Попробуйте упростить запрос или повторить позже."
network / transient   attempt 0 → "Проблема с сетью до провайдера — пробую ещё раз."   retry 2 s
                      attempt≥1 → "Провайдер так и не ответил из-за проблем с сетью…"
default                         → "Не удалось ответить из-за ошибки Operator runtime…"
```

`askOperator` additionally catches `/session|resume|conversation.*not found/i`,
creates a fresh session and replays the same prompt once.

**A stale provider bricks startup.** If `/operator` switched to codex and
`OPERATOR_CODEX_ENABLED` later returns to `false`, `initialize()` resumes with
`operator_provider="codex"`, finds no such provider, and throws
`configured Operator provider is unavailable: codex`. The daemon will not boot
until `runtime_state` is edited by hand.

**A hung CLI hangs boot.** Runtime health is `spawn(binary, ["--version"])` with
no watchdog. A non-zero exit aborts boot with one unattributed line; a binary
that hangs makes `initialize()` hang forever with no output. Telegram and T3
being unreachable only log warnings — the CLI is the sole fatal dependency.

### Compaction

Forced when `now - last_compaction_at >= 24 h` **or**
`operator_context_usage_percent >= OPERATOR_COMPACT_THRESHOLD_PERCENT`
(default 80). The first-ever tick only stamps the timestamp. Usage counters are
written only on success, so a throw leaves the threshold armed.

If `telegram_ingress` jobs are pending and the owner chat is known, the user is
told: `Провожу плановое обслуживание памяти, отвечу через несколько минут.`

Claude compacts in place and keeps the session id; Codex summarizes and starts a
**new** session seeded from the stored system prompt.

---

## 6. Provider capabilities

`normalizeProviderCapabilities` computes seven fields. **Only `liveInput` is
read anywhere**, and `cwdSwitch` is hard-coded `false`. `interrupt`,
`approvals`, `resume`, `structuredEvents` and `toolEvents` have zero consumers.

`getProviders()` returns `[]` when there is no live client, and drops every
malformed entry — so a schema drift silently shrinks the catalog, and an empty
catalog makes `liveInput` resolve `false` for every thread.

---

## 7. Routing and follow-up steering

There is **no live steering of a running Operator turn** — only the cancel word.
Two independent queues exist below that.

```
continue  → t3.send_turn
create    → t3.create_project / t3.create_thread
ask-which → plain text, or telegram.ask_choices (2–6 options, ≤60 chars)
fan-out   → several create_thread + send_turn
```

```
t3.send_turn on a BUSY thread (queued|running|waiting_approval|waiting_user)
├─ getProviders().catch(() => [])          ← failure swallowed
├─ liveInput !== true → enqueue "thread_followup"
│    → { threadId, queued: true,
│        reason: "thread is busy; the follow-up dispatches after the current turn" }
└─ liveInput === true → direct dispatch (T3 steers)

idle thread, occupancy.count >= maxParallelWorkers, thread not already monitored
└─ throw "Parallel worker limit reached (N of N running). Wait for a running
          thread to finish, queue this task for later, or raise maxParallelWorkers
          via policy.update before dispatching."
```

Because the provider fetch is swallowed, a T3 config outage silently degrades
**every** busy-thread dispatch into a queued follow-up, and the agent is handed a
reason that is not the real one.

`dispatchNextFollowup` runs from the monitor's `finally` only when
`terminal === true`, and from `recoverWorkers`. A thread permanently stuck in
`running` from T3's point of view therefore never dispatches its follow-up and
never reports that.

---

## 8. T3 subscription

```
subscribeThread
├─ !liveClient → polling  ← engages ONLY when options.liveClient === false,
│                            which production never sets. A live-client failure
│                            does NOT fall back to it.
└─ live: GET thread snapshot → ThreadSubscriptionProjection → liveClient.subscribeThread
```

Ticket auth: `POST /api/auth/websocket-ticket` with the bearer, fresh per
reconnect; `?wsTicket=` is scrubbed from every log line. Failures:
`T3 WebSocket ticket request failed (<status>)` /
`T3 WebSocket ticket response did not contain a ticket`.

```
reconnect loop
├─ aborted → return
├─ isPermanentRpcError → RETHROW, no retry
│    permanent = /EnvironmentAuthorization|missing required scope/i, or a
│    structured _tag/code/name matching NotFound/InvalidThread in a 5-deep cause chain
│    free-text "not found" is DELIBERATELY not permanent
└─ else wait min(15 s, reconnectDelay × attempt), resubscribe with afterSequence
```

Client-side dedup: events with `sequence <= lastSequence` are dropped;
activities dedupe by id via `seenActivities`; a snapshot pairs `*.requested`
with `*.resolved` and suppresses the request entirely.

Polling mode, when it does run, emits only `started`, `progress` and
`approval_required` — no `agent_message`, no `user_input_required`, no
resolution events.

Monitor resubscribe: 10 attempts, 1 s base, 60 s cap. Exhaustion →
`Потерял связь с тредом **<title>** после нескольких попыток переподключения.
Восстановлю подписку при следующем maintenance.`

---

## 9. Approvals

Eight risk categories, evaluated in order: `secret-sensitive`, `cross-project`,
`safe-read`, `safe-write-in-project`, `destructive`, `package-install`,
`network`, `process-control`, with a trailing safe-read reclassification for
leading `pwd|ls|rg|grep|find|git status|diff|log|show|sed|head|tail|wc`, and a
default of `process-control` for commands and `destructive` otherwise.

`mayAutoApprove` is pure allowlist membership; `APPROVAL_AUTO_ALLOW` defaults to
`safe-read`. An auto-approved action sends **no Telegram message at all**. A
failed auto-approve warns and falls through to the buttons.

Buttons `Разрешить` / `Разрешить на сессию` / `Отклонить` →
`a:<sha256(id).base64url[0:24]>:1|s|0`.

**There is no expiry.** No TTL, no sweeper, no age check anywhere on
`pending_approvals`. A keyboard stays live indefinitely and is redrawn after
restart.

On the successful decision branch `answerCallback` runs *after* `completeEvent`,
so a throw there leaves the event complete and the user with a spinning button.
Every other callback branch answers first.

---

## 10. Structured questions

```
o<i>  single   → replace selection, advance or submit
o<i>  multi    → toggle, redraw, "Выбор обновлён"
s              → submit; nothing selected → "Выберите хотя бы один вариант"
c              → "Ответьте на это сообщение своим текстом" (no state change)
questionIndex ≠ currentQuestion → "Этот вопрос уже переключился дальше"
not pending / wrong chat / wrong message → "Этот вопрос уже не активен"
```

Custom text arrives only as a **reply** to the question message; empty →
`Нужен непустой текстовый ответ.`, over 4 000 chars →
`Ответ слишком длинный. Сократите его до 4000 символов.`

Sequencing: only questions with index **greater** than `currentQuestion` are
offered again. When no later unanswered question exists but answers are still
incomplete, the same prompt is redrawn with no explanation.

Mediation (translating a worker's raw prompt into human phrasing) is cached on
the record so redraw and recovery never re-call the LLM. Budget 15 s. On failure
the raw worker prompt is shown.

**Mediation is a wasted call under Codex.** `runMediation` guards on
`!this.runtime.oneShot`, but `this.runtime` is the `SwitchableOperatorRuntime`,
which *does* define `oneShot` — so the guard never fires. Every worker question
under Codex attempts mediation, throws `Operator provider codex has no one-shot
side channel` inside, is caught, and logs a warning.

---

## 11. Delivery

```
sendRich → split at RICH_SAFE_LIMIT = 30 000
├─ richFinalAvailable !== false → sendRichMessage
│   ├─ "fatal"      → THROW
│   ├─ "content"    → fall to legacy
│   └─ "capability" → latch false, fall to legacy
└─ sendLegacy → re-split at 4000 → HTML
    └─ formatting error → PLAIN, no parse_mode
```

Capability flags are three-state (`boolean | undefined`) and are set to `true`
on success; only `false` is sticky, and only a restart re-probes.

Semantic splitting keeps fenced blocks, `<details>` blocks and Markdown tables
atomic, re-emits a table header per chunk, and hard-cuts only as a last resort.

**Anchored edits** resolve at delivery time and are discarded if the anchor's
chat differs. `"message is not modified"` counts as delivered. On a
`TELEGRAM_BAD_REQUEST` that is not ambiguous, an edit falls back to a fresh
send; anything else is rethrown so nothing duplicates.

### Retry classification

| input | code | retryable | ambiguous |
|---|---|---|---|
| network `HttpError` | `TELEGRAM_AMBIGUOUS` | yes | **yes** |
| 429 | `TELEGRAM_RATE_LIMIT` | yes | no |
| ≥500 | `TELEGRAM_SERVER` | yes | no |
| 401/403 | `TELEGRAM_FORBIDDEN` | no | no |
| other 4xx | `TELEGRAM_BAD_REQUEST` | no | no |

Inline: 3 attempts, `max(retryAfterMs, 500 × 2^attempt)`, flood waits accepted
up to 30 s — **inside the per-chat lock**, so one rate-limited send stalls every
other message, draft edit and progress update to that chat for up to ~30 s.

Durable: `retryTelegramOutbox` has **no attempt ceiling**. A retryable item
retries forever. Only two exits exist — non-retryable → `dead`; ambiguous
non-idempotent → `uncertain`, requeued once with
`⚠️ _Повторная отправка — возможно, предыдущее сообщение уже дошло._`, then
`dead` plus `⚠️ Не смог доставить предыдущий ответ: Telegram дважды оборвал
отправку…`.

`claimNextTelegramOutbox` refuses any candidate with an earlier
`pending|sending` row in the same chat. Head-of-line blocking is by design and
is surfaced **only in the log** — the user sees silence.

Chunk-level resume: `sentChunkCount` is written back after every chunk, and a
retry skips what already went out.

---

## 12. Media

```
inbound size gate
├─ cloud Bot API: sizeBytes > 20 MiB → download SKIPPED
│    "[файл <name> (N.N MB) превышает лимит облачного Bot API 20 MB — недоступен]"
├─ batch memory budget 512 MiB
│    "[файл <name> пропущен: суммарный размер батча превышает лимит 512 MB]"
└─ ArtifactRegistry inbound ceiling = config.media.maxInputBytes, default 20 MiB
   (deliberate: raised past 50 MiB only with a local Bot API server)
```

Local Bot API path checks throw
`Local Bot API returned a file outside the configured root` and
`Local Bot API file path escaped the configured root`.

```
voice / audio / video_note / video
├─ video_note → ffmpeg audio extraction (failure → warn, continue on the original)
│               + 3–6 evenly spaced keyframes (failure → warn, frames = [])
├─ oversize for STT → re-encode mono 16 kHz Opus (failure → warn, use original)
├─ still oversize → segment at STT_SEGMENT_SECONDS (default 900)
│    per-segment failure → "[фрагмент N не расшифрован]"
│    all failed → throw
└─ provider chain openrouter → openai → groq → deepgram → local-whisper
   each failure warns and continues; all failed → throw
```

Forced language `STT_LANGUAGE` default `"ru"`; `"auto"` means unset. Transcripts
capped at 64 000 chars. The agent sees either
`[<label> transcript; original artifact <id>]` or
`[<label> transcription unavailable; original artifact <id>; reason: …]`.

Outbound: TTS is ElevenLabs, falling back to `sayBin` which is auto-populated
**only on darwin** — on a Linux deployment without `ELEVENLABS_API_KEY`,
`telegram.send_voice({text})` always throws
`TTS is not configured (set ELEVENLABS_API_KEY or SAY_BIN)`.

Video notes are cropped square, scaled 640×640, capped at 60 s, and re-probed;
a mismatch throws `Video note normalization did not produce Telegram-compatible
media`.

`MAX_PHOTO_BYTES = 10 MiB` is hardcoded and is *not* lifted by
`TELEGRAM_MAX_UPLOAD_BYTES`, so larger photos always degrade to document sends
even behind a local Bot API server.

**Caption truncation is silent.** Every send site slices to
`CAPTION_LIMIT = 1024`, while `telegram.send_{document,photo,audio,video}`
advertise `max(4_096)`. `send_voice` advertises `1_024` and matches;
`send_video_note` has no caption field.

---

## 13. Tools and the per-turn lease

The tool list is constant (47 names). Narrowing is entirely in the capability
context: fixed destination, `originMessageId` as the only reply target,
`allowedMessageIds` for reactions, `allowedArtifactIds` bypassing project ACLs,
`teamRole`, `ingressJobId`. TTL 2 h; expired → HTTP 401
`{"error":"invalid_or_expired_capability"}`. The server binds `127.0.0.1:0`
with host and origin validation.

**The lease is minted at exactly one call site** — `answerDirect`. Every
internal `askOperator` call (compaction restore, memory maintenance,
worker-result normalization, failure-recovery decision, provider-switch restore)
runs with **no MCP tools at all**.

Result shaping: `MAX_TOOL_RESULT_CHARS = 16 000`, over which the payload becomes
`{"truncated":true,"preview":…}`; any string over 8 000 chars is cut inside the
JSON; errors become `{"error": message.slice(0,2000)}`. Tool journaling records
only `{tool, durationMs}` — the failure message is lost from the durable record.

Refusal guards: `Operator tool capability is invalid or expired` ·
`<action> requires owner or admin role` · `<action> is not available to viewer
role` · `project access denied for mutation|read` · `automation not found` /
`automation access denied`.

---

## 14. Worker results

```
worker completes → askOperator normalizes into {status, summary, files, checks, …}
├─ parse succeeds → renderWorkerResult:
│     summary + **Изменённые файлы** / **Проверки** / **Осталось** / **Дальше**
│     ⚠ `status` is NEVER rendered — a `blocked` or `failed` normalized result
│       is byte-identical to a success in the chat
└─ parse fails or askOperator throws → fallbackWorkerResult:
      safeExcerpt(raw, 3_000) sent VERBATIM, status forced to "success",
      the thread stored as completed
      ⚠ this is the one path where raw worker tool chatter reaches the user
```

**Every worker failure is phrased as a provider failure.** `deliverFailure`
always classifies with subsystem `"provider"`, so a deterministic test or
compile failure produces `Работа **<title>** завершилась ошибкой. Worker
завершился ошибкой провайдера. Код: PROVIDER_FAILED.` The real error string
reaches neither the chat nor the thread summary. Relatedly,
`classifyOperationalError` has no branches for the `t3` subsystem at all — every
T3 error is `T3_UNAVAILABLE, retryable: true`.

---

## 15. Storage and retention

26 tables plus 2 FTS5 indexes, WAL, `foreign_keys = ON`, `busy_timeout = 5000`.

**Every boot re-runs the whole schema file and re-embeds every active note.**
`migrate()` has no version gate — `schema_migrations` is written with
`INSERT OR IGNORE` and never read. `001_initial.sql` ends by clearing and
rebuilding the notes FTS index, and `migrate()` then loops every active note
through `upsertNoteVector`. Startup is O(notes).

Silent write failures worth knowing:

- `enqueueBackgroundJob` uses `ON CONFLICT DO NOTHING` and returns the requested
  id — a dedupe collision drops the payload with no signal to the caller.
- `expireOperatorNotes` deletes the FTS row but **not** the vector row, so
  `operator_note_vectors` accumulates stale rows forever.
- `registerOutbound` artifacts get no `expiresAt` and are therefore never
  eligible for cleanup — those rows are immortal.
- `updateThreadStatus`, `resolveApproval`, `updateApprovalMessage` and
  `updateUserInput` on an unknown id are silent no-ops.
- `bindArtifacts` and `updateTelegramMessageBinding` are `COALESCE`-only, so an
  already-bound row silently keeps its old values.
- `runtime_state` has no expiry and no pruning anywhere. "Clearing" writes `""`,
  never `DELETE`. Per-thread keys accumulate indefinitely.

`pruneJournals` (once per 24 h) deletes `daemon_events` > 30 d — which is
exactly the corpus `memory.journal` reads — `processed_events` completed > 7 d,
`background_jobs` completed/failed > 7 d, `telegram_outbox` delivered/dead > 7 d,
`automation_runs` > 90 d.

`threads.project_id` has **no** `ON DELETE`, so deleting a project that still has
threads fails outright, while `operator_note_vectors` and `project_aliases`
cascade and `artifacts.derived_from_artifact_id` is `SET NULL`.

**Thread memory saturates at 50.** `persistThreadSummary` concatenates previous
and new `importantDecisions` / `files` / `openIssues` / `nextActions`, dedupes,
and takes the **first** 50. Past that, later files are silently dropped from
durable memory. Each entry is capped at 2 000 chars. Only the 200 most recently
active threads ever get their summaries refreshed.

**Secret redaction is destructive.** Notes, thread purpose/state/decisions/
files/open issues/next actions, and project aliases all pass through
`redactSecrets` **on write**. Its last two rules are
`\b[a-f0-9]{40,}\b → [REDACTED HEX]` and
`[A-Za-z0-9+]{48,} → [REDACTED BASE64]`. A remembered git SHA, checksum or any
48-character identifier is destroyed permanently, not masked on display.

---

## 16. Recovery

```
initialize()
 1 migrate
 2 team roles re-synced (owner overwritten)
 3 resetInterruptedTelegramOutbox   sending → pending | uncertain
 4 resetInterruptedBackgroundJobs   running → pending
 5 resetRunningAutomations          running → active
 6 artifacts, runtime dir 0o700, MCP server, dashboard
 7 Operator session resume, else create
 8 reportUncleanRestart
 9 daemon_started_at, clean_shutdown=""
10 health probes — runtime unhealthy THROWS; Telegram and T3 only warn
11 flush outbox → drain T3 dispatches → drain ingress
12 recoverPendingInteractions
13 recoverWorkers
14 maintain("startup")   ← performMaintenance skips recoverWorkers for this reason
15 scheduler + reliability loop
```

`recoverWorkers` has two arms: threads carrying a `thread_chat:<id>` runtime
state with a safe non-zero chat id, **and** threads reachable purely from
pending `thread_followup` jobs, where the chat comes from `followup.chatId`.
Any throw aborts the whole pass with a warning and the user is never told.

`recoverPendingInteractions` silently skips approvals and user inputs whose
`chatId` is undefined; per-item failures warn only.

**Not restored:** every in-memory queue, monitor map, active-turn set, the
streaming draft state, all partial Operator turn text, and the MCP capability
map. Telegram inbound buffers are effectively restored because the offset is
withheld and Telegram re-delivers.

**There is no group-synthesis subsystem to restore.** `worker_groups`,
`worker_group_members`, `thread_handoffs` and `routing_clarifications` are
DDL-only with zero readers or writers.

There are **no `uncaughtException` / `unhandledRejection` handlers anywhere**, so
a stray rejection kills the daemon. `stop()` writes `clean_shutdown = "1"` only
after awaiting eight queues, the reliability task and every monitor; if any never
settles, the marker is never written and the next boot posts a crash notice.
`SIGINT`/`SIGTERM` use `process.once`, so a second signal hard-kills mid-shutdown.

---

## 17. Automations

```
once     → runs at the ISO moment; nextRun undefined ⇒ status "completed"
interval → advances past missed fires (while next <= now: next += interval) — NO catch-up
daily    → next occurrence strictly after now, DST-converged by up to 3 iterations
resume   → once keeps its moment; interval/daily recompute from NOW
```

Exactly-once is enforced by `automation_runs UNIQUE(automation_id, scheduled_for)`
plus the ingress dedupe key. A still-`running` automation is never re-claimed;
a crash leaves it `running` until the next boot resets it.

Failure backoff: `min(2^(failures-1), 60)` minutes, paused at 5 consecutive
failures. The pause notice goes out via `telegram.sendRich` **directly, not the
durable outbox** — if that send fails, the owner never learns the automation
stopped.

---

## 18. Maintenance tick

60 s interval, coalescing (an overlapping tick returns the same promise), and
any failure is `logger.error("Scheduled maintenance failed")` and nothing more.

Twelve steps: dispatch due automations, flush outbox, drain T3 dispatches,
expire notes, stop idle Docling, clean expired artifacts, prune local Bot API
files, refresh thread summaries, the compaction gate, the journal-retention gate,
`recoverWorkers` (unless startup), and the completion event.

---

## 19. Dashboard, observability, connectors

- **The dashboard HTML is served without auth** — `GET /` returns the full page
  before the `authorized()` check; only `/api/*` requires the bearer. The CSP
  allows `script-src 'unsafe-inline'`. The listener binds `127.0.0.1` only.
- **Every open tab runs a full SQLite integrity scan every 15 s.** `/api/state`
  ends in `PRAGMA quick_check` over the whole database on the daemon's own
  synchronous handle, and also spawns `<claude|codex> --version` and calls
  `getMe`. `/debug` does the same once.
- **Every `/dashboard` link dies on restart** — the capability is
  `randomBytes(32)` per instance and `DASHBOARD_PORT` defaults to `0`.
- **Dashboard policy edits are invisible in Telegram.** `POST /api/policy`
  appends `policy.updated {source:"dashboard"}` and nothing reaches the chat, so
  adding `destructive` to `approvalAutoAllow` from a browser removes the
  confirmation step with no chat-visible trace.
- **`hashChatId` reads `OBSERVABILITY_HASH_SALT` straight from `process.env`** —
  it is not in the zod schema. Unset, the salt is per-process, so chat
  pseudonyms are not comparable across restarts.
- **`daemon_events.payload_json` is written with no redaction**, and outbound
  Telegram text is never redacted. Pino redacts `prompt`, `transcript`,
  `providerResponse`, `detail`, `payload.text`, `payload.prompt`, `*.token`,
  `*.apiKey`, and runs error message/stack/cause through `redactSecrets`.
- **Google connectors die roughly an hour after the token was minted** —
  `GOOGLE_WORKSPACE_ACCESS_TOKEN` is a single static bearer with no refresh path,
  and `availability()` only checks the string is non-empty. After expiry every
  call throws `Google Workspace request failed (401)` with no body, so neither
  the agent nor the user learns it is an expired token.
- **The agent can never read an email body** — `searchEmail` fetches
  `format=metadata` and returns only a 2 000-char `snippet`; there is no
  get-message call anywhere.
- **One malformed calendar event kills the whole listing** — the response is
  parsed with `z.array(calendarEventSchema)`, which requires `start` and `end`
  on every item.
- **Calendar creation validates after the write** — a differently-shaped
  response throws *after* the event exists, and a retry duplicates it.

---

## Dormant / unreachable

| What | Why |
|---|---|
| `RichStreamSession`, `renderStreamPhase`, `DraftWriter.replace` / `.finalize`, `TelegramTransport.finalizeDraft` | never constructed / no production caller; the daemon uses a bare `DraftWriter` and delivers finals through the outbox |
| `sendGallery`, `sendAnimation`, `sendSticker` | no production caller; no matching tool exists |
| `TelegramHealth.capabilities` | written on every `health()` call, read by nothing |
| Snapshot-polling compat mode, `subscribeShell` | only reachable with `liveClient === false`, which only tests set |
| 6 of 7 `ProviderCapabilities` fields | computed, never read; `cwdSwitch` also hard-coded false |
| `claimEvent`, `findProjectByAlias`, `getThreadTail` | superseded or never wired; aliases are written and listed but never used for routing |
| `worker_groups`, `worker_group_members`, `thread_handoffs`, `routing_clarifications` | DDL-only, zero readers or writers |
| `CodexCliOperatorRuntime` | `OPERATOR_CODEX_ENABLED` default `false` |
| Claude full-access branch | `OPERATOR_FULL_ACCESS` default `false` |
| Docling, vision OCR, ElevenLabs TTS | default-off or key-gated |
| `t3_dispatch` durable queue | pumped from four places; the only enqueue site is failure recovery, itself gated on a retry counter |
| Two viewer refusal strings, the tool-layer viewer branch | the outer viewer wall fires first |
| `operator_first_token_latency_ms`, `telegram_draft_update_latency_ms`, `routing_confidence`, `new_projects_total`, `thread_reuse_total` | declared metric names with no emit site |

---

## Three decisions worth keeping

1. **Structural fencing with a per-turn random marker.** Untrusted content
   cannot forge its own closing marker, and the rule covers both directions —
   inbound user text and raw worker output.
2. **A locked-down default runtime.** No shell, no filesystem, two web tools and
   one process-scoped MCP. Everything substantial is delegated to a T3 thread
   that has its own workspace and its own approval surface.
3. **Durability before work.** Every inbound message becomes a durable job
   before anything happens to it, the polling offset is withheld while buffers
   are in flight, and every outbound write carries a dedupe key.
