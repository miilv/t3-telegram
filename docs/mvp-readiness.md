# MVP readiness evidence matrix (§88)

This matrix is the local 18/18 gate. “PROVED” here means the current source and
credential-free executable evidence cover the product behavior; the separate
real Telegram + T3 gate remains tracked in `spec-compliance.md` and
`e2e-runbook.md`.

| # | Readiness criterion | Source boundary | Executable evidence | Local status |
|---:|---|---|---|---|
| 1 | One Telegram conversation with Operator | `telegram/transport.ts`, `operator-daemon.ts` | daemon product flow | PROVED |
| 2 | Operator self-answers simple questions | `answerDirect` | “answers directly…” daemon test | PROVED |
| 3 | Complex work creates/continues T3 thread | `delegate`, T3 broker | daemon product flow; broker commands | PROVED |
| 4 | Long worker does not block new messages | independent ingress/operator/worker queues | blocked-turn approval and product-flow tests | PROVED |
| 5 | At least three concurrent workers | `delegateParallel`, worker groups | three-worker synthesis test | PROVED |
| 6 | Context/focus attaches typical follow-up | router focus cascade | routing corpus; daemon product flow | PROVED |
| 7 | Telegram Reply continues mapped thread | reply mapping + deterministic reply signal | exact daemon reply-boundary test | PROVED |
| 8 | File path selects existing project | canonical realpath/git identity | exact daemon path-boundary test; routing corpus | PROVED |
| 9 | Missing project gets meaningful project | `semanticProjectName`, durable workspace | daemon product flow | PROVED |
| 10 | Telegram file reaches worker | artifact ingestion/materialization | exact daemon inbound-document test | PROVED |
| 11 | Worker file returns to Telegram | checkpoint discovery + artifact validation/outbox | exact daemon outbound-document test | PROVED |
| 12 | Native Rich draft streaming | grammY RichMessage transport + `DraftWriter` | Telegram draft/final transport test | PROVED |
| 13 | Restart retains running workers | durable thread state/subscription recovery | daemon restart/synthesis tests | PROVED |
| 14 | Operator tools unavailable to workers | expiring loopback MCP lease | MCP/runtime/daemon isolation tests | PROVED |
| 15 | Internal Operator session stays outside projects | dedicated mode-0700 runtime cwd | config/runtime tests; source invariant | PROVED |
| 16 | Status reports all active work | `/status` aggregate renderer | daemon group status test | PROVED |
| 17 | Completion arrives after original turn | monitor + durable anchored outbox | product flow and terminal replay tests | PROVED |
| 18 | Daily compact preserves old work continuity | durable compaction gate + bounded snapshot restore | daemon memory/compaction and provider-switch tests | PROVED |

`tests/readiness.test.ts` guards this matrix against missing/duplicate criteria
and stale source/test references. Semantic behavior remains proven by the named
component and integration tests, not by the matrix parser itself.
