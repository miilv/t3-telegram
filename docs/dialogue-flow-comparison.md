# Coverage comparison: T3 Operator vs Grok Bot 0.18

Both systems are always-on AI agents with a chat surface, durable state and an
approval mechanism. They answer the same design questions differently. This
compares them branch-for-branch on eight axes, from two structural maps built
the same way — parallel readers, an adversarial verification pass, then a gap
hunt, with every load-bearing claim re-read in source.

- T3 Operator: `docs/dialogue-flow.md` (this repository), ~15.5k lines of TS.
- Grok Bot 0.18: a reconstruction of the shipped Cursor "Sand" desktop app,
  ~440k lines. Referenced here only as the point of comparison.

The size gap is the headline number, and it is misleading. T3 buys its UI
(Telegram) and its agent runtime (Claude/Codex CLI) off the shelf and spends its
own code on routing, durability and media. Grok Bot writes all three itself.

---

## The one-line difference

**Grok Bot gives one agent a computer.** Its main asset is a persistent Linux
box with a desktop and a logged-in browser; the agent does the work itself and
delegates only sub-tasks.

**T3 gives one dispatcher a workforce.** The Operator holds a light
cross-project context and almost no capability; real work goes to persistent T3
threads scoped to a project. The system prompt states it outright: full
repository and tool histories belong to workers, not the Operator's context.

Everything below follows from that.

---

## 1. Untrusted content isolation — T3 is stronger

| | Grok Bot | T3 |
|---|---|---|
| Mechanism | `<spotlight source="…">` fence around tool results | `<<<inbound:xxxxxxxx>>>` fence with a per-turn random marker |
| Coverage | tool results **only when `result.content` is an array** | inbound user text and raw worker output |
| Forgeable? | fixed tag, but prompt warns against forged fences | random 4-byte suffix per turn — not forgeable |

Grok Bot's fencing has a hole: `withSpotlightedToolResult` fences only when
`result.content` is an array. `Computer` and `Screenshot` return
`{content: <string>}`, and browser tools return `{kind, text, imageB64}` with no
`content` key at all — so web-page and desktop text, the surfaces most exposed
to injection, reach the model unfenced.

T3 has no equivalent hole in what it fences, and the random marker is a genuine
improvement over a fixed tag. What T3 lacks is breadth: MCP tool results, web
search results and connector payloads are **not** fenced — only the two sites
above. That is a smaller surface than Grok Bot's, so the gap matters less, but
it is the obvious place to extend.

---

## 2. Default agent capability — T3 is far more restrictive

| | Grok Bot | T3 |
|---|---|---|
| Own machine | full shell, filesystem, desktop, browser | none by default |
| User's machine | `ExternalShell`/`ExternalRead`, permission-gated | none |
| Default tools | ~30, including shell and computer use | `WebSearch`, `WebFetch`, one process-scoped MCP |
| Escalation | Auto-review approval card | delegate to a T3 thread |

Without `OPERATOR_FULL_ACCESS=true` the Operator's CLI runs with
`--permission-mode dontAsk`, `--tools WebSearch,WebFetch`, `--setting-sources ""`
and `--strict-mcp-config`. It cannot touch a filesystem. Grok Bot's agent
starts with a shell on its own box as the *default* surface.

Two caveats on T3's side, both in `docs/dialogue-flow.md`:

- `--disable-slash-commands` is conditional, and the `/compact` turn
  deliberately runs with slash commands enabled.
- The environment filter is name-based, so `DATABASE_URL`, `SSH_AUTH_SOCK`,
  `SENTRY_DSN` and `*_WEBHOOK_URL` pass into the child, while `OPENAI_API_KEY`
  is stripped by accident.

---

## 3. Deduplication and idempotency — comparable, different shape

| | Grok Bot | T3 |
|---|---|---|
| Primitive | acceptance ledger keyed by client nonce | dedupe keys on durable rows |
| Outcomes | 4 (dispatch / digest-mismatch / rejected / duplicate) | insert-or-ignore per layer |
| Coverage | the send path | ingress, outbox, callbacks, approvals, automations, progress, terminals |
| Known hole | in-flight coalescing returns before the digest is computed | `enqueueBackgroundJob` drops a colliding payload with no signal |

Grok Bot concentrates its idempotency in one ledger with explicit failure modes
and a self-healing store. T3 spreads it across layers, each with its own key,
and adds something Grok Bot has no analogue for: the polling offset is withheld
while any update sits in a buffer, so a crash makes Telegram re-serve rather
than lose.

---

## 4. Interruption and preemption — Grok Bot is more sophisticated

| | Grok Bot | T3 |
|---|---|---|
| Trigger | any new user message | only a bare cancel word |
| Mechanism | conditional interrupt + turn-epoch invalidation | `runtime.interrupt()` before queueing |
| Undispatched run | new message folded in, no duplicate turn | n/a — queued serially |
| Stale work | epoch bump voids delivery checks, nudges, approvals, recovery | queue order |
| Wedged run | watchdog trips, then declares a zombie and lets the user through | none |

Grok Bot's turn epoch is a single invalidation point: one increment voids the
delivery check, the nudge loop, pending approvals and the recovery chain at
once. Its scheduler will also abandon a wedged run after a grace period so the
user is never blocked.

T3 has no equivalent. `operatorInputQueue` is serial, so a message arriving
mid-turn waits — and the user is told nothing about the wait. A genuinely hung
turn blocks everything behind it up to the 600 s turn timeout. This is the axis
with the widest gap.

---

## 5. Approvals — different philosophies, both coherent

| | Grok Bot | T3 |
|---|---|---|
| Classifier | 6 surfaces × 3 modes | 8 risk categories, ordered |
| Auto-allow | shadow mode per surface | explicit allowlist, default `safe-read` |
| Presentation | in-app card | inline keyboard, 3 buttons |
| TTL | 10 min, max 4 pending per agent | **none — no TTL, no sweeper, no age check** |
| Escalation | retry the same action with an approval flag | resolve or don't |
| Anti-workaround | a full prompt paragraph enumerating what is not adapting | none |

T3's classifier is the better piece of engineering — an ordered cascade with a
safe-read reclassification, versus Grok Bot's surface-based modes. What T3 is
missing is lifecycle: an approval keyboard lives forever, is redrawn after
restart, and nothing expires it. Grok Bot expires on six distinct causes and
caps pending approvals per agent.

Grok Bot also spends a prompt section teaching the model that base64-ing a
command or reading a credential file is not "finding a safer path". T3 has no
such text, which matters less given how little the Operator can do.

---

## 6. Delivery failure — opposite instincts

| | Grok Bot | T3 |
|---|---|---|
| Transport | own IPC + own renderer | Telegram Bot API |
| Failure classes | ~15 distinct user-visible strings | 5 codes, 4 humanised sentences |
| Retry ceiling | bounded | **none for retryable codes — retries forever** |
| Ambiguous send | n/a | requeued once with a duplicate warning, then dead + a notice |
| Blocked queue | n/a | head-of-line by design, **surfaced only in the log** |

Grok Bot prefers to tell the user and give up. T3 prefers to stay quiet and keep
trying. Both are defensible, but T3's version has a failure mode worth naming:
a flood wait on one message stalls every subsequent message, draft edit and
progress update to that chat, and the only trace is a log line every 60 s.

The chunk-level resume (`sentChunkCount` written back after every chunk) is
something Grok Bot has no equivalent for, because it never has to split a
message across a third-party API.

---

## 7. Multi-user — T3 only

Grok Bot is single-owner with multiple agents. T3 has owner/admin/member/viewer,
per-project memberships, `/share`, `/team`, groups and topics — a genuinely
different product shape.

The viewer wall is well built: a viewer is rejected before `answerDirect` and
therefore never receives a tool lease, which makes the whole tool surface
unreachable rather than merely guarded. Two side effects noted in the map: the
DB outranks the env allowlist (demoting in `TELEGRAM_ALLOWED_USERS` has no
effect), and any `:owner` entry mints a second full owner on every boot.

---

## 8. Recovery — T3 is stronger, with one gap

| | Grok Bot | T3 |
|---|---|---|
| Store | files on the box | SQLite/WAL, transactional |
| On boot | ack redrive, synthetic completions for lost work | reset interrupted outbox/jobs/automations, resume session, recover workers and interactions |
| Crash notice | tray card | a chat message, rate-limited to one per 10 min |
| Unrecoverable | context-overflow dead end | a stale provider id bricks startup entirely |

T3's recovery is the more serious engineering: statuses are reset by class,
non-idempotent in-flight sends are marked `uncertain` rather than replayed, and
workers are recovered from two independent arms.

The gap is process-level. There are **no `uncaughtException` or
`unhandledRejection` handlers anywhere**, so a stray rejection kills the daemon;
`clean_shutdown` is written only after eight queues settle, so a hung shutdown
always produces a crash notice on the next boot; and `SIGINT`/`SIGTERM` use
`process.once`, so a second signal hard-kills mid-shutdown.

---

## Scorecard

| Axis | Stronger |
|---|---|
| Untrusted isolation | **T3** (unforgeable marker; Grok Bot has an unfenced surface) |
| Default capability restraint | **T3** |
| Deduplication | comparable |
| Interruption / preemption | **Grok Bot**, by a wide margin |
| Approval classification | **T3** |
| Approval lifecycle | **Grok Bot** |
| Delivery failure reporting | **Grok Bot** |
| Delivery resilience | **T3** |
| Multi-user | **T3** (Grok Bot has no analogue) |
| Persistence and recovery | **T3** |
| Process-level robustness | **Grok Bot** |
| Agent reach (browser, desktop, connector catalogue) | **Grok Bot**, by a wide margin |

---

## What T3 would gain most from, in order

1. **A queue-position signal.** A message arriving mid-turn is silently queued.
   One line — "приму следующим" — closes the widest UX gap versus Grok Bot,
   whose entire prompt architecture is built around never leaving the user
   watching silence.
2. **Approval TTL and a pending cap.** Ten minutes and four pending per chat
   would match Grok Bot and remove a class of stale-button confusion.
3. **Process-level error handlers.** Two handlers turn "the daemon died" into
   "the daemon logged and died cleanly", which also fixes the spurious crash
   notice.
4. **Surfacing a blocked chat queue.** Head-of-line blocking is a sound design;
   staying silent about it for minutes is not.
5. **Rendering the worker status.** `blocked` and `failed` currently render
   byte-identically to a success, and the normalization fallback marks raw
   output as `success`.
6. **Extending the fence** to MCP results, web-search output and connector
   payloads. The mechanism already exists and is better than Grok Bot's.

## What Grok Bot would gain from T3

Transactional persistence, restart recovery of in-flight work, an ordered risk
classifier, and roles. Its own recovery relies on files and live processes, with
workarounds visible in the code — for example a router that re-publishes the
"thinking" state every 250 ms because a transcript refresh would otherwise erase
it.
