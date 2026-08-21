# Real Telegram + T3 acceptance run

This is the final release gate required by technical-spec sections 79–80. Use a
dedicated Telegram test bot and a disposable local T3 project portfolio. Never
commit `.env`; it is ignored by Git.

## Prerequisites

1. Put `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_ID`, `T3_BASE_URL`, and the
   local server's `T3_BEARER_TOKEN` in `.env`.
2. Ensure the T3 token has `orchestration:read orchestration:operate` scopes.
3. Create two disposable T3 projects with distinct paths/git identities and two
   similar thread titles for the ambiguity exercise.
4. Prepare a harmless document/photo, short voice note, short video note, and a
   worker task that creates a small text artifact.
5. Run `pnpm check`, then `pnpm start` with `.env` loaded.

## Evidence capture

Record UTC timestamps, Telegram message IDs, T3 project/thread IDs, and the
matching redacted daemon event types. Do not record tokens, raw authorization
headers, or private message bodies. Save the completed table below in a local
copy, then update `docs/spec-compliance.md` only after every result passes.

| E2E | Action and expected result | Result |
|---|---|---|
| 1 | Ask a simple fact; receive a direct rich answer and observe no T3 thread. | pending |
| 2 | Request substantial new work; semantic project/thread created, start card delivered, Operator answers another fact while worker runs. | pending |
| 3 | Reference a nested canonical path/separate same-remote checkout; correct existing project selected. | pending |
| 4 | Start work, ask an unrelated fact, then “готово?”; original thread remains focus. | pending |
| 5 | Reply “продолжай” to a thread result; mapped thread receives the turn. | pending |
| 6 | Request a three-scope investigation; three T3 threads run and Telegram receives one synthesis. | pending |
| 7 | Send a harmless file; registry hash/provenance exists and worker reads its materialized project-local path. | pending |
| 8 | Ask for the generated text artifact; Telegram receives one validated document. | pending |
| 9 | Send voice; transcript semantics route correctly and original audio remains registered. | pending |
| 10 | Send video note; transcript/audio/keyframes are registered and reach Operator reasoning. | pending |
| 11 | Trigger a harmless command classified as dangerous in the disposable worker; approval buttons pause it, Allow once resumes exactly once. | pending |
| 12 | While a worker runs, terminate the daemon, restart it, complete the worker, and observe one anchored completion only. | pending |

## Post-run checks

- `/debug` shows healthy Telegram, T3, Operator and SQLite with no raw chat ID.
- `/status` shows no orphaned running work after terminal delivery.
- Replaying one captured update does not create a second worker.
- `daemon_events` contains one correlation chain from ingress through T3 dispatch
  and terminal Telegram delivery for the representative delegated task.
- No project workspace contains Operator runtime/session files or credentials.
