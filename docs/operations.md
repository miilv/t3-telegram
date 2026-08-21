# Operations

## Health and status

- `/status` — active workers, pending approvals, pending structured questions, and current focus.
- `/debug` — connectivity for Telegram, Claude CLI, T3, and subscription count.
- Logs are structured JSON. Set `LOG_LEVEL=debug` for adapter diagnostics; message bodies and secrets are not logged.

## Restart behavior

SQLite uses WAL mode. On startup the daemon:

1. migrates/reopens durable state;
2. resumes the infrastructure Claude session;
3. checks Telegram, Claude, and T3 health;
4. restores unsent approval and structured-question prompts;
5. reconciles T3 thread state;
6. restores monitors for running/waiting workers and dispatches due queued follow-ups for idle threads;
7. delivers an undelivered completion for an Operator-owned thread.

Telegram updates are deduplicated by `(chat_id, message_id)`. Approval callbacks, structured-input callbacks, and T3 interaction events have separate durable dedupe keys. Resolved interactions have their inline keyboards cleared even when they were resolved from another T3 client.

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
