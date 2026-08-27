# Task 4 report — Package 3.2 durable distillation

## Status

Complete on `track/3.2-memory-v2`. The reviewed Notes-v2, privacy, and
conversation-ledger contracts are integrated; ledger-driven distillation and
the remaining Notes-v2 product wiring are implemented and verified.

## Commits and integration decisions

- `00756cd58e2c19c17a27cd9c8d1048fcb3eec2cb` — merged reviewed privacy head
  `cb7a947352ce59f41b20f7d364bee0faa7c90a0f` into reviewed Notes-v2 head
  `3ffb1ff7c896bf691d1e5faf3e6b920976389d33` with `--no-ff`.
  - Conflict: `packages/operator-tools/src/index.ts`.
  - Resolution retained the privacy branch's canonical structured/output
    redaction and privacy-masked tool boundary while retaining the Notes-v2
    keyed and legacy memory paths. The focused post-merge suite passed 57 tests.
- `64f4573a86509e29de567b53d27df1c3079da1c0` — merged reviewed ledger head
  `6e05ddb` with `--no-ff`.
  - Conflicts: `apps/daemon/src/operator-daemon.ts` and
    `packages/storage/src/index.ts`.
  - Resolution retained canonical storage/output masking and Notes-v2
    constructors/exports, added the ledger repository and daemon hooks, kept
    outbound text privacy-guarded, and preserved atomic safe-payload + ledger
    insertion. The post-merge focused suite passed 120 tests and typecheck.
- `b09dc94` — implemented durable ledger distillation, proposal/evidence
  persistence, Night Scribe integration, stale-fact/product wiring, bounded
  offline embeddings, migrations, documentation, and focused tests.

No merge from `main` was performed. The reviewed section commits remain in the
branch ancestry.

## RED → GREEN evidence

Tests were introduced and run in behavior-sized slices before their production
implementation. Representative RED failures and their GREEN closures were:

| Behavior | RED observed | GREEN implementation/test |
| --- | --- | --- |
| Strict response grammar | distillation parser/export absent; NOTHING/shape/evidence/date cases could not pass | exact `NOTHING` or unfenced 1–20 object array; exact fields/types, normalized duplicate-key rejection, strict RFC3339/calendar validation, valid Notes-v2 drafts, and owner-evidence-only citations (`distillation-policy`, 7 tests) |
| Prompt trust and bounds | no frozen ledger prompt boundary | seq/direction/evidence-role rows, canonical output redaction, owner evidence map, 200-row/64,000-code-point validation, frozen range/high water, one fence and hard prompt cap |
| Durable note reconciliation | coordinator absent | one call per page; source `distilled`; `verified_at` NULL; evidence rows stored transactionally; stable candidate replay key; note/proposal crash replay; cursor CAS after all outcomes |
| Backlog and failure semantics | no page cap/call accounting | explicit three-page cap; quiet `NOTHING` advances; completed invalid response counts one call; provider failure/invalid response does not advance; partial work is degraded; lost CAS is safe (`distillation-coordinator`, 8 tests) |
| Collision behavior | distilled exact-key writes could reach normal update behavior | any active exact key, including an existing distilled key, produces a proposal; transaction-boundary race guard; MiniLM ≥0.85 proposal and 0.70–0.85 cross-link; fallback hashes never use semantic thresholds (`operator-note-writer`, 13 tests) |
| Durable proposals | no proposal schema/repository | unique replay identity, privacy-masked candidate storage, pending/enqueued state, owner-filtered retry list, matching-note projection (`distillation-proposals-storage`) |
| Night Scribe collaboration | physical Telegram count was the correspondence gate and no distiller/proposal notifier existed | independent logical-ledger delta, focused coordinator, completed-call accounting, outage distinction, owner-scoped durable proposal turns and restart/no-owner/enqueue retry (`scribe-distillation`, 5 tests; Scribe suites) |
| Stale facts | old integration expected LLM maintenance and automatic obsolescence | past `valid_until` remains active in push/search/get/list with hypothesis warning; one bounded monthly owner question; scheduled maintenance cannot obsolete; explicit forget/restore remains (`operator-tools`, `memory-push`, `scribe-orchestration`, daemon integration) |
| Keyed product writes | new memory write lacked a per-turn durable identity | `TurnReplayKeys.nextMemoryWrite`, app-turn safe-list entry, and structured written/proposal/cross-link result; legacy unkeyed compatibility remains explicit |
| Embeddings | backfill accepted an unbounded request and local-root/offline order was not enforced | no runtime load at construction/startup, maximum 25 per explicit non-startup maintenance page, local root configured with remote models disabled before pipeline construction, deterministic fallback, opt-in real-model smoke |
| Integrated migration | no final three-schema upgrade-twice proof | exact `744c2d7` schema is created, legacy note/now/automation/journal rows seeded, current migration run twice, real owner ledger/cursor progress preserved (`operator-notes-migration`, 2 tests) |
| Privacy on new durable paths | raw candidate note/proposal values reached the new writer/storage seams | canonical storage mask runs before validation, embedding, note persistence and proposal persistence; provider prompts and owner-turn proposal prose use canonical output redaction; evidence/replay identifiers remain numeric/hash-stable |

During the first full repository gate, two daemon integration assertions were
RED because they still required mechanisms the task explicitly removes:
`Prepare durable memory maintenance` and automatic system-note obsolescence.
They were replaced with assertions for bounded push-only compaction, no
scheduled note mutation, and explicit owner forget/restore. Both focused cases
then passed, and the obsolete fake maintenance runtime was removed.

## Verification commands and exact results

### Focused Package 3.2 suite

```sh
pnpm vitest run tests/distillation-policy.test.ts tests/distillation-coordinator.test.ts tests/distillation-proposals-storage.test.ts tests/scribe-distillation.test.ts tests/scribe-policy.test.ts tests/scribe-orchestration.test.ts tests/scribe-failure.test.ts tests/operator-note-writer.test.ts tests/operator-notes-storage.test.ts tests/operator-notes-migration.test.ts tests/operator-note-embeddings.test.ts tests/operator-note-retrieval.test.ts tests/operator-notes-policy.test.ts tests/operator-replay.test.ts tests/operator-tools.test.ts tests/memory-push.test.ts tests/storage.test.ts tests/conversation-ledger-storage.test.ts tests/conversation-ledger-daemon.test.ts tests/redaction.test.ts tests/journal-tools-security.test.ts tests/migrations.test.ts
```

Result: PASS — 20 test files, 221 tests.

### Exact base migration twice

```sh
pnpm vitest run tests/operator-notes-migration.test.ts
```

Result: PASS — 1 file, 2 tests. The test reads
`744c2d7204be01a8067f33e4d4d456fe496e094e:migrations/001_initial.sql`
with `git show`, preserves all four seeded legacy domains and advances/preserves
a real `(night-scribe-distillation, owner-1)` cursor across the second migrate.

### Offline/no-network fallback

```sh
NOTE_EMBEDDING_MODEL_ROOT=/tmp/operator-missing-minilm-model HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 pnpm vitest run tests/operator-note-embeddings.test.ts tests/operator-note-retrieval.test.ts
```

Result: PASS — 2 files, 6 tests. This covers remote-disabled/local-only setup
before pipeline construction, missing-weight fallback, 384 dimensions,
determinism, semantic-threshold disablement on hashes, no construction-time
runtime load, and 25+5 bounded backfill.

### Opt-in real-model smoke

```sh
NOTE_EMBEDDING_REAL_MODEL_SMOKE=1 NOTE_EMBEDDING_MODEL_ROOT=/tmp/operator-missing-minilm-model pnpm vitest run tests/operator-note-real-model.smoke.test.ts
```

Result: honest SKIP — 1 file, 1 test skipped because no operator-provisioned
model root/weights exist on this runner. When weights are provisioned, the test
requires the pinned MiniLM model and a normalized semantic 384d vector.

### Exact implementation-head repository gate

Run at commit `b09dc94`:

```sh
pnpm check
```

Result: PASS.

- TypeScript: `tsc --noEmit` passed.
- Vitest: 48 files passed, 1 file skipped; 1193 tests passed, 2 skipped.
- Build: `tsup` succeeded for Node 24 and copied the integrated migration;
  `dist/main.mjs` and source map built successfully.

### Diff and structure

```sh
git diff --check
rg -n "maintainStructuredMemory|Prepare durable memory maintenance" apps packages
wc -l apps/daemon/src/distillation-coordinator.ts packages/policy/src/distillation.ts packages/storage/src/distillation-proposals.ts tests/distillation-coordinator.test.ts tests/distillation-policy.test.ts tests/distillation-proposals-storage.test.ts tests/operator-note-real-model.smoke.test.ts tests/scribe-distillation.test.ts
```

Result: PASS — no whitespace errors; no production references to the removed
mechanism; new files are 28–359 lines each (all below 1,000). The already-hot
daemon shrank by removing the old inline maintenance path, while distillation
was extracted into focused policy/storage/coordinator modules.

## Files changed

- New focused production boundaries:
  - `packages/policy/src/distillation.ts`
  - `packages/storage/src/distillation-proposals.ts`
  - `apps/daemon/src/distillation-coordinator.ts`
- Distillation/Scribe wiring:
  - `apps/daemon/src/scribe.ts`
  - `apps/daemon/src/scribe-finalization.ts`
  - `packages/policy/src/scribe-schedule.ts`
  - `packages/policy/src/scribe-prompts.ts`
  - `packages/policy/src/index.ts`
- Notes-v2 storage/product wiring:
  - `packages/storage/src/operator-notes.ts`
  - `packages/storage/src/operator-note-writer.ts`
  - `packages/storage/src/note-embeddings.ts`
  - `packages/storage/src/migrations.ts`
  - `packages/storage/src/index.ts`
  - `packages/operator-tools/src/index.ts`
  - `packages/operator-tools/src/replay.ts`
  - `packages/policy/src/memory-layers.ts`
  - `apps/daemon/src/operator-daemon.ts`
  - `migrations/001_initial.sql`
- Configuration/documentation:
  - `.env.example`
  - `docs/memory-design.md`
  - `docs/dialogue-flow.md`
  - `docs/operations.md`
  - `docs/roadmap-2026-08-25.md`
- New focused tests:
  - `tests/distillation-policy.test.ts`
  - `tests/distillation-coordinator.test.ts`
  - `tests/distillation-proposals-storage.test.ts`
  - `tests/scribe-distillation.test.ts`
  - `tests/operator-note-real-model.smoke.test.ts`
- Updated tests:
  - `tests/daemon.integration.test.ts`
  - `tests/journal-tools-security.test.ts`
  - `tests/memory-push.test.ts`
  - `tests/operator-note-embeddings.test.ts`
  - `tests/operator-note-writer.test.ts`
  - `tests/operator-notes-migration.test.ts`
  - `tests/operator-notes-storage.test.ts`
  - `tests/operator-replay.test.ts`
  - `tests/operator-tools.test.ts`
  - `tests/scribe-failure.test.ts`
  - `tests/scribe-orchestration.test.ts`
  - `tests/scribe-policy.test.ts`
  - `tests/storage.test.ts`

## Design decisions

1. The distiller is a collaborator owned by Night Scribe, not inline daemon
   orchestration. Its cursor is exclusively `(night-scribe-distillation,
   owner_id)` and its frozen high water never shares narrative/day timestamps.
2. A page advances only after every candidate has a durable writer or proposal
   outcome. Candidate replay identity includes consumer, owner, frozen range,
   high water, normalized key and sorted evidence sequences.
3. The existing Notes-v2 writer/repository is the only keyed fact write path.
   Exact-key collision protection is enforced both before embedding and again
   at the transaction boundary to cover interleaving curator writes.
4. Merge decisions are deliberately deferred: exact-key and high-confidence
   semantic collisions persist candidate data/evidence first, then use the
   existing retryable owner-turn machinery. Cross-owner proposals are never
   offered by another owner's Scribe.
5. `valid_until` is freshness metadata. Stale notes remain active and routable,
   with canonical hypothesis warnings; the monthly turn asks one bounded
   verification question. Only explicit obsolete or supersede removes a note.
6. MiniLM is an optional local quality layer. Offline policy is mandatory
   before pipeline creation; missing/corrupt weights select the deterministic
   hash retriever. Backfill is an explicit non-startup page capped at 25.
7. Canonical privacy is applied before provider output, embedding and durable
   storage. Hash/numeric operation and evidence identities remain stable; raw
   prompt/provider text is not placed in proposal notifications.
8. Compaction/provider switch use only the bounded push snapshot. The removed
   `maintainStructuredMemory` path can no longer create or obsolete facts.

## Concerns

- The verification runner uses Node `22.22.3`, while `package.json` requests
  Node `>=24.2`; pnpm emitted the engine warning. Typecheck, all executed tests,
  and the Node-24-targeted build nevertheless passed.
- No operator-provisioned MiniLM weights are present, so the real-model smoke
  was correctly skipped. The offline/fallback behavior and injected 384d
  MiniLM semantic thresholds are verified, but deployment should provision the
  pinned revision/checksum and run the opt-in smoke before enabling semantic
  retrieval in production.

No remaining implementation blocker or known correctness defect was found in
self-review.
