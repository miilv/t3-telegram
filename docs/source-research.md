# Source-first implementation notes

The technical specification requires implementation decisions to be based on
current source code, not README summaries. The checked revisions below are the
references used for the first audit and Telegram transport block.

| Reference | Inspected revision | Source used |
|---|---|---|
| `Mark-Life/telegram-claude-codex` (MIT) | `8e5a5c664fc3441b9d6c22c2b9c02bcdda4d8a53` | `src/telegram.ts`: native rich draft/final, phase changes, debounce, typing timer, overflow and capability fallback. |
| `pavel-molyanov/telegram-ai-agent` (MIT) | `eff046f5c2eb363c838fd8aa8165e34a742a445f` | `mcp-servers/bot/server.py`: context-locked agent actions, document/photo/gallery validation, captions, photo-to-document fallback and flood waits; `core/services/content.py`, `rich_content.py`, `forward_batcher.py`: topics and inbound media. |
| `k1p1l0/claude-telegram-supercharged` (Apache-2.0) | `9990af03dad9bb8235ad6f4eec6a2d9f5bfd2c01` | `server.ts`: reply/thread context, forwarded messages, reaction events, voice transcription chain, TTS, stickers/GIF frame collages, batching and restart replay. |
| `anthropics/claude-plugins-official` (Apache-2.0) | `67a666efc8524ff7abaa266f84e514aa77aee48f` | `external_plugins/telegram/server.ts`: official channel tool surface, safe attachment metadata, media handlers, permission callbacks, reaction acknowledgement and polling recovery. |
| `NousResearch/hermes-agent` (MIT) | `ee000768cef4dc9399f32c88b507104ce15400dd` | `plugins/platforms/telegram/adapter.py`: RichMessage limits and client crash guards, capability latching, no duplicate resend after ambiguous transport errors, draft preview/final behavior and thread/direct-message routing. |
| fork `miilv/t3code` from `pingdotgg/t3code` | `7107a98a225be85b58ddcd4de02c343af7d4707a` | `packages/contracts/src/orchestration.ts`, `rpc.ts`, client-runtime RPC client and operation reducers are the source of truth for the broker block. |

## Telegram API/type evidence

- Telegram Bot API 10.1 introduced Rich Messages; current Bot API 10.2 extends
  rich media/blocks.
- The implementation uses `grammy@1.45.1` and its bundled
  `@grammyjs/types@4.0.0`, whose signatures require:
  `sendRichMessage(chatId, { markdown })` and
  `sendRichMessageDraft(chatId, draftId, { markdown })`.
- A rich draft is an ephemeral preview. A persistent final must be sent with
  `sendRichMessage`, or the preview may be finalized in place with
  `editMessageText(..., InputRichMessage)` when a real message exists.
- `reply_parameters` is the non-deprecated reply mechanism.

## Adopted transport invariants

1. Rich drafts and final messages always use an `InputRichMessage`; raw
   `text` in the JSON body is invalid for these methods.
2. Rich capability is latched off only for a clear missing-method/capability
   error. A content/parser error falls back for that message only.
3. Do not retry by sending a second legacy message after an ambiguous timeout or
   unknown transport error; the first request may already have reached Telegram.
4. Draft updates are debounced and serialized per stream. Progressive overflow
   is truncated as a preview; only final output is split.
5. Phase transitions finalize the previous phase and use a new non-zero draft
   ID. Typing/draft timers are always cleared.
6. Legacy text limits are measured in UTF-16 code units; rich content is bounded
   by the documented rich limits. Final splitting preserves fenced code blocks.
7. Chat/topic/reply/direct-message routing is carried by an explicit destination
   object rather than reconstructed by an agent-provided ID.
8. Outbound actions are serialized per chat and globally rate-limited, honoring
   Telegram `retry_after` without blocking unrelated inbound processing.
9. Upload actions validate real paths, size and type before opening the network
   request; image-specific failures fall back to documents.
10. Polling catches handler errors and restarts with bounded exponential backoff.

## T3 broker source gate

Before the RPC broker implementation, the current T3 fork was reread at
`7107a98a225be85b58ddcd4de02c343af7d4707a`:

- `packages/contracts/src/rpc.ts` and `orchestration.ts` supplied the exact
  `orchestration.searchThreads`, `orchestration.subscribeShell` and
  `orchestration.subscribeThread` method names, input fields, stream-item
  unions and sequence-resume semantics.
- `packages/contracts/src/environmentHttp.ts` supplied the snapshot and
  dispatch HTTP routes used to establish a thread-scoped resume watermark.
- `packages/client-runtime/src/rpc/session.ts` and `protocol.ts` established
  Effect RPC JSON serialization over WebSocket, scoped client lifetime and the
  bearer-token-to-one-time-ticket handshake.
- `packages/client-runtime/src/state/threadReducer.ts` established that
  streaming `thread.message-sent` payloads are deltas, non-streaming messages
  finalize message state, and `thread.session-set` is the authoritative turn
  boundary.
- Provider ingestion source established the normalized approval, user-input,
  plan, task, tool-progress and runtime-error activity kinds.

The local client therefore uses the same `effect@4.0.0-beta.103` protocol
instead of defining a second JSON-RPC dialect. Its deliberately narrow schema
group keeps the private full T3 contracts out of this repository; unknown RPC
payloads are structurally checked at the broker boundary.

## Remaining source gates

Before each media block, reread the corresponding donor implementation and the
current Telegram method/type declarations. These notes are not a substitute for
that per-block source gate.
