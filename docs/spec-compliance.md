# Technical-spec compliance ledger

This ledger is the completion gate for
`/Users/miilg/Downloads/t3_telegram_operator_technical_spec.md`. A green build is
not sufficient: every row must be `PROVED`, with the named source/runtime/test
evidence inspected, before the project can be called complete.

Status meanings:

- `PROVED` — current source plus an appropriate passing test or runtime check
  proves the complete requirement.
- `PARTIAL` — some required behavior exists, but the requirement is not proved
  end to end.
- `MISSING` — a required behavior is absent.
- `UNVERIFIED` — implementation may exist, but authoritative evidence has not
  been collected.

The status column is intentionally conservative. It describes the feature
branch, not an aspiration.

| Spec | Requirement / completion evidence | Status |
|---|---|---|
| 1–3 | One always-on Operator; many persistent T3 work streams; Operator remains responsive; delegation is the default for substantive work; T3 is execution fabric and Operator state is process-scoped. Evidence: `operator-daemon.ts`, daemon product/concurrency/recovery tests. | PROVED |
| 4 | Target architecture boundaries and event flow. Evidence: package contracts plus daemon and broker integration tests. | PROVED |
| 5.1 | Agent daemon owns polling, dispatch, independent queues, recovery, scheduler and health. Evidence: daemon/scheduler integration tests. | PROVED |
| 5.2 | Persistent provider-independent Operator runtime is resumable, compactable, switchable and isolated. Evidence: `operator-runtime.test.ts`, daemon provider-switch test. | PROVED |
| 5.3 | Cross-project T3 broker uses source-checked HTTP/Effect RPC contracts for projects, threads, turns, events, approvals, artifacts and provider capabilities. Evidence: `t3-broker.integration.test.ts`. | PROVED |
| 5.4 | Production grammY transport covers Bot API 10.x RichMessage, media, replies, topics, reactions, retry/flood control and fallback. Evidence: Telegram transport/rendering tests. | PROVED |
| 5.5 | Routing implements deterministic, retrieval, bounded Operator arbitration and clarification stages. Evidence: router, daemon arbitration and quantitative corpus tests. | PROVED |
| 5.6 | Structured summaries, redacted/deduplicated hybrid lexical-vector memory, focus, threshold telemetry and bounded compaction restoration. Evidence: storage and daemon memory tests. | PROVED |
| 5.7 | Artifact registry owns provenance, hashes, bindings, safe materialization/delivery, retention and root-contained cleanup. Evidence: artifact/media tests. | PROVED |
| 6 | Operator policy distinguishes direct/delegated work and remains responsive during workers. Evidence: daemon direct/delegation/concurrency tests. | PROVED |
| 7 | Existing/new/no-project decisions, semantic default workspace naming and later handoff correction. Evidence: router and daemon product/handoff tests. | PROVED |
| 8 | Cross-project handoff packet and continuation thread without pretending provider-native rehome, including safe artifact materialization and durable delivery. Evidence: daemon handoff/recovery tests. | PROVED |
| 9 | Durable WorkThread lifecycle, structured purpose/state/decision/file/open-loop/next-action summaries and bindings. Evidence: storage/daemon memory tests. | PROVED |
| 10.1–10.2 | Messages may be unbound; focus is ranked and survives side questions. Evidence: router/daemon product tests. | PROVED |
| 10.3 signals 1–4 | Explicit binding, reply, artifact and focus signals. Evidence: router, storage and artifact tests. | PROVED |
| 10.3 signals 5–8 | Filesystem/git identity, aliases/entities, status/recency and semantic retrieval. Evidence: router/storage corpus tests. | PROVED |
| 10.3 signals 9–10 | Bounded Operator arbitration followed by durable clarification for material ambiguity. Evidence: daemon arbitration/clarification tests. | PROVED |
| 10.4 | Confidence thresholds prevent silent expensive/destructive misrouting. Evidence: router ambiguity corpus. | PROVED |
| 11 | Bidirectional Telegram-message mapping to turns, threads and artifacts. Evidence: storage and daemon trace tests. | PROVED |
| 12 | Concurrent 2–4 worker fan-out, independent scopes, durable result aggregation/group control and one idempotent synthesis. Evidence: delegation, daemon group and restart tests. | PROVED |
| 13 | Event-driven background execution and normalized worker-event handling. Evidence: broker subscription and daemon lifecycle tests. | PROVED |
| 13.3–14 | Raw worker streams stay internal; meaningful progress is policy-throttled. Evidence: daemon/Telegram integration tests. | PROVED |
| 15 | Operator context excludes full T3 history; SQLite summaries/notes/focus are authoritative and restart-safe compaction restores bounded state. Evidence: storage, runtime and daemon compaction tests. | PROVED |
| 16 | Native RichMessage draft/final lifecycle, formatting, phases, debounce and fallback. Evidence: Telegram transport/rendering tests. | PROVED |
| 17 | All named inbound text/media/reply/forward/album/reaction envelopes are normalized. Evidence: Telegram transport and media tests. | PROVED |
| 18–19 | Safe Telegram ingestion and explicit artifact materialization into worker workspaces. Evidence: artifact, media and daemon tests. | PROVED |
| 20–21 | Agent-initiated document/image/gallery and Telegram-native outbound media are capability-bounded. Evidence: MCP and transport tests. | PROVED |
| 22 | Preserve inbound voice, bounded multi-provider/local STT, include transcript and original artifact, plus outbound TTS normalized to OGG/Opus. Evidence: real-FFmpeg media tests, provider/degradation tests, daemon routing test and MCP send test. | PROVED |
| 23 | Video-note download, durable source-linked audio extraction/STT, 3–6 keyframes viewable through bounded MCP image content, and probed square H.264/AAC outbound transcoding capped at 60 seconds. Evidence: real-FFmpeg media tests, daemon reasoning-envelope test and MCP image/send tests. | PROVED |
| 24 | Replies use `reply_parameters`; reply context reaches the Operator envelope and binds output. Evidence: Telegram tests, daemon reply-boundary test. | PROVED |
| 25 | Forum topics are preserved without 1:1 T3-thread conflation. Evidence: Telegram and daemon topic tests. | PROVED |
| 26 | Inbound/outbound reactions have allowlists, scope checks and durable context. Evidence: Telegram/MCP tests. | PROVED |
| 27–28 | Approval UI, decisions, eight risk categories, safe auto-approval and explicit dangerous approval. Evidence: daemon/transport tests. | PROVED |
| 29–30 | Process-scoped privileged Operator tools use a loopback MCP endpoint with random expiring per-turn capabilities, empty ambient settings sources and a strict per-run config. Telegram/T3 credentials stay in the daemon and workers are launched only through ordinary T3 provider configuration. MCP protocol, daemon lifecycle, CLI argv and live Claude invocation evidence pass. | PROVED |
| 31–32 | Filesystem isolation and outbound validation cover realpath, roots, symlinks, secret/content checks, ownership, MIME, size, audit and hash. Evidence: artifact/MCP tests. | PROVED |
| 33–34 | Project detection uses path/git root/remote/aliases plus stable auto-naming. Evidence: router corpus. | PROVED |
| 35–36 | Thread reuse/search combines metadata, FTS/semantic retrieval, recency and bounded Operator reranking. Evidence: storage/broker/daemon tests. | PROVED |
| 37 | Human clarification occurs only for material ambiguity. Evidence: router corpus and daemon clarification test. | PROVED |
| 38 | Worker prompts contain bounded task/project/artifact/constraint/result contracts without privileged leakage. Evidence: daemon delegation tests. | PROVED |
| 39 | Worker results normalize to validated `WorkerResult`, with safe fallback, persisted group evidence and synthesis. Evidence: daemon group tests. | PROVED |
| 40–41 | Completion policy and rich status cards include state and safe artifact/link handling. Evidence: daemon/Telegram tests. | PROVED |
| 42–43 | Cancel/interrupt plus capability-aware live input or durable queued follow-up. Evidence: daemon follow-up/group-control tests. | PROVED |
| 44–45 | Provider abstraction, capability catalog, optimized defaults, explicit overrides and compact/snapshot Operator switching. Evidence: provider/runtime/daemon tests. | PROVED |
| 46 | Complete Telegram-to-Operator envelope includes topic/reply/forward/media/reaction metadata. Evidence: Telegram normalization tests. | PROVED |
| 47–48 | All named T3, Telegram, memory, artifact and time/web tools are Zod-validated, audited and bounded to compact JSON; thread reads exclude raw transcripts. MCP discovery/call tests cover the complete list and representative mutation/security paths. | PROVED |
| 49–50 | Required durable schema and append-only event log include correlation/idempotency fields. Evidence: migration/storage/daemon trace tests. | PROVED |
| 51–52 | Startup restores SQLite/session/subscriptions/interactions/jobs; inbound events and terminal effects have durable dedupe state. T3 retries reuse a transactionally deduplicated command ID; Telegram terminal replay edits the same anchor and advances completion only after delivery. Interrupted non-idempotent sends are quarantined. Storage and daemon crash/restart tests cover each boundary. | PROVED |
| 53–55 | Short serialized ingress dispatch, one serialized Operator-input/runtime path, an 8-wide worker-event queue, per-chat/global Telegram delivery queues and serialized maintenance are independent. Approval callbacks proceed during a blocked Operator turn, later messages enqueue, and explicit cancel interrupts immediately. | PROVED |
| 56–59 | Correct draft strategy, UTF-8/UTF-16 limits, flood control and scoped fallback. Evidence: Telegram transport/rendering tests. | PROVED |
| 60 | Operator-only time, web search/retrieval (the CLI's built-in WebSearch/WebFetch; the Operator MCP carries no search tool of its own), calculator, safe file metadata and memory search are process-scoped and protocol-tested. | PROVED |
| 61–64 | Coalescing scheduler, durable daily/context compaction, T3 reconciliation, cleanup, summaries, restoration and timezone-aware proactive automation. Evidence: scheduler/automation/storage/daemon tests. | PROVED |
| 65–69 | Operational commands and redacted diagnostics expose health, capabilities, queues, storage and metrics. Evidence: daemon diagnostics/command tests. | PROVED |
| 70–71 | Team/RBAC authorization is rechecked at ingress/action boundaries; secrets never enter logs, artifacts or subprocesses. Evidence: daemon/MCP/runtime/observability tests. | PROVED |
| 72–74 | Secret-redacted structured logs use irreversible chat pseudonyms; all named latency/count/gauge metrics are instrumented and exposed in owner diagnostics. A root correlation ID is preserved across Telegram ingress, routing/artifact binding, T3 dispatch, worker events and durable Telegram delivery; integration tests assert the chain. | PROVED |
| 75–78 | Errors are classified into safe codes/messages. T3 outage persists the accepted dispatch and retries its stable receipt-backed command ID; Telegram outage retains finals in an outbox with safe retry/ambiguity rules; provider failure invokes one Operator-controlled retry/new-thread/provider-switch/report decision without exposing raw errors. Crash and failure integration tests pass. | PROVED |
| 79 | Unit, integration and real E2E strategy with fixtures/fakes only where scope-appropriate. | PARTIAL |
| 80 E2E-1 | Simple direct question without worker passes daemon integration; real test-bot/T3 run is not yet available. | UNVERIFIED |
| 80 E2E-2 | New semantic project and worker passes daemon integration; real test-bot/T3 run is not yet available. | UNVERIFIED |
| 80 E2E-3 | Canonical path/git identity passes router integration; real test-bot/T3 run is not yet available. | UNVERIFIED |
| 80 E2E-4 | Focus survives a side question in daemon integration; real test-bot/T3 run is not yet available. | UNVERIFIED |
| 80 E2E-5 | Reply mapping/routing passes storage/router integration; real test-bot/T3 run is not yet available. | UNVERIFIED |
| 80 E2E-6 | Three workers and one synthesis pass daemon/restart tests; real test-bot/T3 run is not yet available. | UNVERIFIED |
| 80 E2E-7 | Inbound artifact materialization passes artifact/daemon tests; real test-bot/T3 run is not yet available. | UNVERIFIED |
| 80 E2E-8 | Safe outbound worker artifact delivery passes MCP/daemon tests; real test-bot/T3 run is not yet available. | UNVERIFIED |
| 80 E2E-9 | Voice transcription/routing/original preservation passes daemon and real-FFmpeg tests; real test-bot/T3 run is not yet available. | UNVERIFIED |
| 80 E2E-10 | Video-note transcript/audio/keyframes/reasoning passes daemon and real-FFmpeg tests; real test-bot/T3 run is not yet available. | UNVERIFIED |
| 80 E2E-11 | Dangerous approval pause/button/resume passes integration; real test-bot/T3 run is not yet available. | UNVERIFIED |
| 80 E2E-12 | Crash/restart subscription and exactly-once completion pass integration; real test-bot/T3 run is not yet available. | UNVERIFIED |
| 81–84 | MVP plus Phase 2/3 are implemented: media/rich/hybrid memory/handoff/fan-out, teams/RBAC/groups, connectors/automations/dashboard/policy and optimized provider routing. Evidence: full 111-test suite. | PROVED |
| 85–87 | Repository is modular; donor/source decisions are attributed; grammY/Effect RPC are used; Operator, Telegram UI and T3 project/thread state remain separate. | PROVED |
| 88 | All 18 MVP readiness paths pass component/integration gates and are mapped in `mvp-readiness.md`; the required real test-bot/T3 acceptance run remains. | UNVERIFIED |
| 89 | Routing moved from a deterministic cascade to the Operator agent over `t3.*` tools; mechanical reply/cancel signals stay in code. The §89 accuracy corpus is retired with the cascade; behavior gates live in `daemon.integration.test.ts` (reply continuation, forwarded-as-data, follow-up queue, fan-out). | SUPERSEDED |
| 90 | Latency budgets, required metrics, restart/dedupe/idempotency and typed modular boundaries are measured/tested/documented. Evidence: daemon latency/recovery tests and verification report. | PROVED |
| 91–92 | Every named risk/open question has a source-checked decision, isolation/fallback mitigation and regression evidence. Evidence: source research plus broker/runtime/transport tests. | PROVED |
| 93 | All local boundaries operate coherently in daemon integration; the spec-required real Telegram+T3 system run remains unavailable. | UNVERIFIED |

## Final audit procedure

Before completion:

1. Reread all 3024 lines of the authoritative technical spec.
2. Re-evaluate every row above from the current worktree and runtime state.
3. Link each `PROVED` row to exact source and an appropriately scoped passing
   test/runtime check.
4. Run typecheck, unit, integration, recovery and E2E suites.
5. Exercise a real Telegram bot and real T3 server when credentials/runtime are
   available; absence of that evidence leaves affected rows `UNVERIFIED`.
6. Do not declare completion while any row is not `PROVED`.

## Evidence collected on the feature branch

- `packages/telegram/src/transport.ts` uses `grammy@1.45.1` and the typed
  `sendRichMessage(chatId, { markdown })` /
  `sendRichMessageDraft(chatId, draftId, { markdown })` calls.
- `packages/telegram/src/streaming.ts` serializes/debounces previews and supports
  distinct thinking/tool/text draft phases.
- `packages/telegram/src/types.ts` and normalization tests cover replies,
  forwarded origins, topics, reactions and all named media kinds; albums merge
  into one ordered envelope.
- Background notifications and recovered workers persist Telegram forum/direct
  topic destinations rather than conflating them with T3 work threads.
- `tests/telegram-transport.test.ts` proves the exact RichMessage payload shape,
  draft-to-final sequence, parser fallback, no fallback after ambiguous network
  failure, media metadata, reactions, topic events and album merge.
- `packages/t3-broker/src/rpc.ts` uses T3's own Effect RPC JSON/WebSocket
  protocol, bearer ticket exchange and thread/shell sequence resume. The broker
  projects message deltas, activity events and authoritative session state,
  uses the RPC full-text search method, and probes both HTTP and RPC health.
- `tests/t3-broker.integration.test.ts` proves HTTP command shapes, explicit
  legacy polling, thread-scoped resume/deduplication, assistant delta assembly,
  plan/approval projection, server-side search and ticket redaction. A live T3
  server exercise is still required before the complete broker row can be
  `PROVED`.
- T3's provider catalog is normalized at the broker boundary, including model
  option descriptors and the new-thread model-change constraint. Task policy
  selects Sonnet/high for mechanical, Opus/high for ordinary and Fable/medium
  for complex work when those advertised models exist; explicit provider,
  model and reasoning requests take priority.
- Structured T3 questions are durable and rendered sequentially with Telegram
  single-select, multi-select and custom-answer flows. Approval decisions use
  the spec's eight risk categories and only the configured allowlist may be
  accepted automatically.
- Active follow-ups are sent immediately only for source-proved live-input
  providers. Other follow-ups use a durable SQLite job and dispatch after the
  current terminal event or startup recovery. The retry scheduler and a real
  multi-client crash exercise are still required before the relevant rows can
  be `PROVED`.
- Canonical path/git-root/remote signals feed routing before lexical retrieval.
  Operator arbitration receives only a bounded candidate shortlist; an
  unresolved choice persists the original update and resumes it from the
  owner's numbered/title reply after restart.
- Cross-project transfer uses the exact `ThreadHandoff` contract and a new T3
  thread because current T3 has no safe rehome operation. Registered source
  artifacts are revalidated and materialized into the target workspace.
- Parallel planning is validated to 2–4 non-duplicate worker scopes. Group
  membership and normalized `WorkerResult` evidence are durable, synthesis is
  atomically claimed after every member becomes terminal, `/status` aggregates
  the group, and a stop asked for in words has the Operator interrupt the
  active members via `t3.interrupt_thread`. A Telegram-send/SQLite
  commit crash window still prevents an exactly-once claim.
- Structured thread memory is updated on delegation/completion/failure and
  consumed by handoff. Durable Operator notes are FTS-searchable, deduplicated,
  expirable and secret-redacted, with natural-language and `/memory` UX.
  Maintenance is coalesced, uses a durable 24-hour gate that survives restart,
  safely cleans only registry-owned expired files, and restores a bounded
  authoritative snapshot after Operator context compaction. Storage migration,
  scheduler, cleanup and daemon integration tests cover this slice.
- `packages/operator-tools/src/index.ts` implements all section 47 tools behind
  a loopback-only, expiring per-turn MCP capability. Telegram routing is fixed
  by daemon context; reactions and edits are restricted to the inbound or
  same-turn messages; file paths pass the artifact registry; tool calls are
  audited without persisting arguments; and results are capped at 16K.
- `tests/operator-tools.test.ts` uses the official MCP client to discover all
  tools, exercise compact T3/memory/Telegram/time/web/calculator paths, prove
  message-scope denial, and prove revocation. Runtime and daemon tests prove
  strict process injection and lease lifecycle. A live Claude CLI 2.1.237 run
  called an HTTP MCP tool successfully with no permission denials.
- `packages/media/src/index.ts` implements bounded OpenAI/Groq/Deepgram/local
  Whisper transcription, local/cloud TTS, FFmpeg extraction/keyframes, Opus
  voice normalization and probed square H.264/AAC video-note normalization.
  Original media is registered before processing and every derivative persists
  `derived_from_artifact_id`; failures retain the original and produce explicit
  context rather than dropping the message. Media, daemon, artifact migration,
  and official-MCP-client tests prove sections 22–23 and E2E-9/10.
- SQLite now stores durable T3 dispatch and Telegram outbox rows before the
  external side effect. The pinned T3 reducer proves accepted `commandId`
  replay is idempotent; Telegram replays only same-message edits/keyboard
  cleanup after an interrupted request and quarantines an in-flight fresh send.
  Direct Operator finals, worker starts/progress/terminal results, group
  synthesis and requested artifacts use the outbox. Tests crash between claim
  and delivery, restart twice, simulate T3 rejection/receipt retry, and exercise
  a provider rate limit with a single safe recovery.
- Ingress dispatch no longer waits for a long Operator turn. A dedicated test
  holds the Operator runtime open while an approval callback reaches T3 and its
  keyboard cleanup completes. The five named queues and their shutdown drains
  are explicit in the daemon.
- The diagnostics test proves hashed chat identity, session/context size,
  Telegram capability state, component health, SQLite integrity/size/events,
  subscriptions, pending queues, recent classified errors and the complete
  metric snapshot without exposing the raw chat ID.
- Phase 3 state is durable in `automations`, `automation_runs`, `operator_policy`,
  `provider_performance`, `operator_note_vectors`, team/project membership and
  project alias tables. Automation unit/daemon tests prove timezone calculation,
  transactional unique dispatch and restart reset. Google connector tests prove
  fixed official REST contracts, response bounds and header-injection rejection.
- The loopback dashboard test proves fragment capability handling, bearer-only
  APIs, security/no-cache headers and validated live policy writes. The cockpit
  deliberately visualizes the Telegram → Operator → T3 relay and contains no raw
  credentials or conversations.
- Claude and Codex runtimes share one typed provider-independent contract. Fake
  CLI tests prove native session capture/resume, isolated settings/rules, shell
  removal, argv-safe MCP bearer injection and secret-stripped environments. A
  daemon test proves compact + bounded snapshot restoration during `/operator
  switch` and durable provider/session persistence.
- The 18-row MVP matrix is guarded by `readiness.test.ts`; new daemon-boundary
  cases prove canonical-path project selection, mapped Telegram replies,
  inbound document materialization and requested outbound document delivery.
- The 80-scenario routing corpus passes every section 89 target at 100%. The
  daemon latency gate enforces direct first-visible under three seconds and
  worker acknowledgement under two seconds at the local provider boundary;
  production histograms remain exposed in `/debug`.
- These checks prove only their slices; all remaining `PARTIAL`/`MISSING` rows
  or `UNVERIFIED` rows still block completion.
