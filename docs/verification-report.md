# Verification report

This report records the reproducible, credential-free acceptance gates. The
authoritative executable evidence is the named test; percentages are derived
from its checked-in scenario corpus.

## Routing quality (§89 — superseded)

Routing is now performed by the Operator agent through the per-turn `t3.*`
tools; the deterministic cascade and its 80-scenario corpus were removed with
it. Mechanical guarantees that stayed in code (Telegram reply continuation,
forwarded-as-data, cancel intent, follow-up queueing) are asserted in
`tests/daemon.integration.test.ts`. Historical corpus results:

| Gate | Result | Required |
|---|---:|---:|
| Explicit Telegram reply routing | 20/20 (100%) | >95% |
| Path/project name/alias routing | 20/20 (100%) | >95% |
| Follow-up with one obvious focus | 20/20 (100%) | >90% |
| Material ambiguity asks instead of mutating | 10/10 (100%) | always |
| Unrelated fact preserves focus | 10/10 (100%) | always |

## Latency and reliability (§90)

`tests/daemon.integration.test.ts` measures ingress-to-first-draft for a direct
answer and ingress-to-durable-start-card for worker dispatch. The executable
budgets are `<3000 ms` and `<2000 ms` respectively at a local fake-provider
boundary. Production provider/network latency remains visible through
`operator_first_token_latency_ms`, `telegram_draft_update_latency_ms`,
`telegram_update_latency_ms`, and `t3_rpc_latency_ms` diagnostics.

The same suite crash-tests the three reliability requirements: durable mapping
survives process reopen; duplicate Telegram updates do not create duplicate T3
turns; terminal worker delivery uses one anchored, idempotent outbox effect.

## Runtime checks

- Local Codex CLI contract: `codex-cli 0.148.0`.
- Local Claude CLI contract: `2.1.237`.
- Real FFmpeg/ffprobe codec and media-conversion tests run in the normal suite.
- `pnpm check` is the release gate: typecheck, all tests, and production bundle.
- `docs/mvp-readiness.md` maps all 18 readiness criteria to exact source/test
  boundaries; `tests/readiness.test.ts` prevents missing or duplicate rows.
- `pnpm e2e:preflight` safely checks configured Telegram/T3 health without
  printing credentials before the manual 12-scenario acceptance run.

Real Telegram, Google Workspace, and authenticated T3 smoke tests require
deployment credentials and are intentionally not simulated by this report.
