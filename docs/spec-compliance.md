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
| 1–3 | One always-on Operator; many persistent T3 work streams; Operator remains responsive; delegation is the default for substantive work; T3 is execution fabric and Operator state is process-scoped. Evidence: daemon recovery/concurrency/integration tests. | PARTIAL |
| 4 | Target architecture boundaries and event flow. Evidence: package-level contracts plus integration tests covering the whole flow. | PARTIAL |
| 5.1 | Agent daemon owns polling/webhook loop, dispatch, queues, recovery, scheduler and health. | PARTIAL |
| 5.2 | Persistent abstract Operator runtime, resumable/compactable and isolated from worker capabilities. | PARTIAL |
| 5.3 | Cross-project T3 broker uses official server/RPC contracts for projects, threads, turns, events, approvals, artifacts and provider capabilities. | PARTIAL |
| 5.4 | Production Telegram transport: Bot API 10.x RichMessage, full media, replies, topics, reactions, retry/flood control and fallback. | PARTIAL |
| 5.5 | Routing engine implements the complete deterministic/semantic/LLM cascade and ambiguity policy. | PARTIAL |
| 5.6 | Structured thread summaries, secret-redacted searchable/deduplicated durable notes, explicit focus and bounded compaction restoration are implemented; provider context-threshold telemetry and real-runtime recovery evidence remain. | PARTIAL |
| 5.7 | Artifact registry owns provenance, hashes, bindings, safe materialization/delivery, retention and root-contained cleanup. | PARTIAL |
| 6 | Operator policy distinguishes direct work from delegated work and remains available during workers. | PARTIAL |
| 7 | Existing/new/no-project decisions, sensible default workspace, and later affiliation correction. | PARTIAL |
| 8 | Cross-project handoff packet and continuation thread without pretending provider-native rehome. Unit/integration evidence covers packet shape and safe source-artifact materialization; delivery crash reconciliation remains incomplete. | PARTIAL |
| 9 | Durable WorkThread metadata, lifecycle, structured purpose/state/decision/file/open-loop/next-action summaries and bindings. | PARTIAL |
| 10.1–10.2 | Messages may be unbound; focus is a ranked set and survives side questions. | PARTIAL |
| 10.3 signals 1–4 | Explicit binding, reply, artifact and focus signals. | PARTIAL |
| 10.3 signals 5–8 | Filesystem/git identity, entities, status/recency and semantic retrieval. | PARTIAL |
| 10.3 signals 9–10 | LLM arbitration over a limited shortlist followed by a durable user clarification when ambiguity is material. | PARTIAL |
| 10.4 | Confidence thresholds and no silent destructive misrouting. | PARTIAL |
| 11 | Bidirectional Telegram-message mapping to turns, threads and artifacts. | PARTIAL |
| 12 | Concurrent 2–4 worker fan-out, independent scopes, durable result aggregation, group control and one Operator synthesis. Real T3/Telegram evidence and synthesis-send crash reconciliation remain. | PARTIAL |
| 13 | Event-driven background execution and complete normalized worker-event handling. | PARTIAL |
| 13.3–14 | Do not leak raw worker stream; apply meaningful progress throttling/policy. | PARTIAL |
| 15 | Operator context excludes full T3 history; SQLite summaries/notes/focus are authoritative, daily compaction is restart-safe, and bounded state is restored afterward. Real Claude context-threshold/runtime evidence remains. | PARTIAL |
| 16 | Native RichMessage draft-to-final lifecycle, rich formatting, phase changes, debouncing and safe fallback. | PARTIAL |
| 17 | Inbound text, photo, document/arbitrary file, audio, voice, video, video note, GIF, sticker, media group, forwarded message and reply. | PARTIAL |
| 18–19 | Safe Telegram file ingestion and explicit artifact transfer/materialization into a worker workspace. | PARTIAL |
| 20–21 | Agent-initiated document/image/gallery and appropriate Telegram-native outbound media. | PARTIAL |
| 22 | Preserve inbound voice, STT, include transcript and original artifact, plus outbound TTS voice with fallback. | MISSING |
| 23 | Video-note download, audio extraction/STT, keyframes/vision and outbound square video-note transcoding. | MISSING |
| 24 | Replies use `reply_parameters`; reply context participates in routing and output. | PARTIAL |
| 25 | Forum topics are preserved as Telegram context but never assumed to map 1:1 to T3 threads. | PARTIAL |
| 26 | Inbound/outbound reactions with allowlist and durable event context. | PARTIAL |
| 27–28 | Approval UI, normalized decisions, risk categories, safe auto-approval and explicit dangerous approval. | PARTIAL |
| 29–30 | Process-scoped privileged Operator tools use a loopback MCP endpoint with random expiring per-turn capabilities, empty ambient settings sources and a strict per-run config. Telegram/T3 credentials stay in the daemon and workers are launched only through ordinary T3 provider configuration. MCP protocol, daemon lifecycle, CLI argv and live Claude invocation evidence pass. | PROVED |
| 31–32 | Filesystem isolation and secure outbound files: realpath, roots, symlinks, secret/content checks, ownership, MIME, size, audit and hash. | PARTIAL |
| 33–34 | Project detection by path/git root/remote/aliases plus stable auto-naming. | PARTIAL |
| 35–36 | Thread reuse/search with metadata, FTS/semantic retrieval, recency and LLM reranking. | PARTIAL |
| 37 | Human-friendly clarification only for material ambiguity. | PARTIAL |
| 38 | Operator-to-worker prompt contract contains task, project, artifacts, constraints and result contract without privileged leakage. | PARTIAL |
| 39 | Worker result is normalized to validated `WorkerResult`, with safe fallback, persisted group evidence and Operator synthesis. | PARTIAL |
| 40–41 | Completion policy and rich status card with useful links/artifacts/state. | PARTIAL |
| 42–43 | Cancel/interrupt plus provider-aware live input or queued follow-up while a turn runs. | PARTIAL |
| 44–45 | Provider abstraction, capabilities, model/reasoning defaults, user overrides and Operator provider switching. | PARTIAL |
| 46 | Complete Telegram-to-Operator input envelope including topic/reply/forward/media/reaction metadata. | PARTIAL |
| 47–48 | All named T3, Telegram, memory, artifact and time/web tools are Zod-validated, audited and bounded to compact JSON; thread reads exclude raw transcripts. MCP discovery/call tests cover the complete list and representative mutation/security paths. | PROVED |
| 49–50 | Required durable schema and append-only event log with correlation/idempotency fields. | PARTIAL |
| 51–52 | Crash recovery and transactional/exactly-once effects across Telegram/T3 boundaries. | PARTIAL |
| 53–55 | Separate ingress/operator/worker/outbound queues, bounded concurrency and interrupt policy. | PARTIAL |
| 56–59 | Correct draft strategy, UTF-8/UTF-16 limits, flood control and per-capability/per-message fallback. | PARTIAL |
| 60 | Operator-only time, web search/retrieval (MCP plus built-in WebSearch/WebFetch), calculator, safe file metadata and memory search are process-scoped and protocol-tested. | PROVED |
| 61–64 | Coalescing minute scheduler, daily durable compaction gate, T3 reconciliation, note/artifact cleanup, structured thread summaries and post-compact state restoration. Long-term automation and context-size trigger remain. | PARTIAL |
| 65–69 | `/status`, `/projects`, `/work`, `/focus`, `/stop`/`/cancel`, `/memory`, `/help` and redacted admin diagnostics exist; full debug metrics/capability detail remains. | PARTIAL |
| 70–71 | Single-user authorization at every ingress/action and secrets never logged/persisted in plaintext artifacts. | PARTIAL |
| 72–74 | Structured logs, metrics and cross-component tracing/correlation. | PARTIAL |
| 75–78 | Classified errors; durable T3 retry and Telegram outbox; worker failure and recovery UX. | MISSING |
| 79 | Unit, integration and real E2E strategy with fixtures/fakes only where scope-appropriate. | PARTIAL |
| 80 E2E-1 | Simple direct question without worker. | PARTIAL |
| 80 E2E-2 | New project and worker. | PARTIAL |
| 80 E2E-3 | Existing project selected by canonical path/git identity. Router tests exist; a real end-to-end T3 project exercise remains. | PARTIAL |
| 80 E2E-4 | Focus survives a side question. | PARTIAL |
| 80 E2E-5 | Reply routes to the correct work thread. | PARTIAL |
| 80 E2E-6 | Three concurrent workers and a single synthesized answer. Fake-boundary integration and restart/group-control tests pass; real T3/Telegram E2E remains. | PARTIAL |
| 80 E2E-7 | Inbound file reaches the correct worker safely. | PARTIAL |
| 80 E2E-8 | Worker artifact is sent back safely. | PARTIAL |
| 80 E2E-9 | Voice is transcribed and original audio remains available. | MISSING |
| 80 E2E-10 | Video note yields transcript/keyframes and reaches reasoning. | MISSING |
| 80 E2E-11 | Dangerous action pauses, renders approval, resumes once. | PARTIAL |
| 80 E2E-12 | Restart recovers active work and delivers completion exactly once. | PARTIAL |
| 81–84 | All MVP requirements plus Phase 2 and Phase 3 requested by the user are implemented; deferred lists are not treated as exclusions. | MISSING |
| 85–87 | Maintainable repository structure; donor attribution; no bespoke Telegram protocol client; no UI/thread/project conflation. | PARTIAL |
| 88 | Every MVP readiness criterion (18/18) has direct evidence. | MISSING |
| 89 | Routing behavior has deterministic path/focus/handoff and daemon-level arbitration/clarification cases; the required representative quality corpus and percentage report remain. | PARTIAL |
| 90 | Latency, reliability and maintainability requirements are measured and documented. | MISSING |
| 91–92 | Named architecture risks and open questions have explicit decisions, mitigations and tests. | PARTIAL |
| 93 | The complete target model works as one coherent system. | MISSING |

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
  the group, and `/stop` cancels all active members. A Telegram-send/SQLite
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
- These checks prove only their slices; all remaining `PARTIAL`/`MISSING` rows
  still block completion.
