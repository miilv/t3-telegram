# Operations

## Health and status

- `/status` — active workers, approvals, and current focus.
- `/debug` — connectivity for Telegram, Claude CLI, T3, and subscription count.
- Logs are structured JSON. Set `LOG_LEVEL=debug` for adapter diagnostics; message bodies and secrets are not logged.

## Restart behavior

SQLite uses WAL mode. On startup the daemon:

1. migrates/reopens durable state;
2. resumes the infrastructure Claude session;
3. checks Telegram, Claude, and T3 health;
4. reconciles T3 thread state;
5. restores monitors for running/waiting workers;
6. delivers an undelivered completion for an Operator-owned thread.

Telegram updates are deduplicated by `(chat_id, message_id)`. Approval callbacks and T3 approval events have separate durable dedupe keys.

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

It sends the upstream command discriminators (`project.create`, `project.meta.update`, `thread.create`, `thread.turn.start`, `thread.turn.interrupt`, and `thread.approval.respond`). Snapshot polling is intentionally behind `T3Broker.subscribeThread`, so it can be replaced with the upstream WebSocket subscription without changing daemon behavior.
