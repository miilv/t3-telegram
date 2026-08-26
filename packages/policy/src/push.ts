/**
 * The snapshot/diff state machine (memory-design §1).
 *
 * Ours is a persistent session, not a fresh session per task, so the envelope
 * of every turn becomes new tokens in one long history. Pushing the full state
 * each turn would pile up dozens of ~6 KB copies and drag the compaction
 * threshold forward — hence: a FULL snapshot in exactly four situations, a
 * now-state diff inside an episode, and nothing at all when the diff is empty.
 *
 * The four full-push situations:
 *   (a) the first turn of a new or recreated session   → `session_changed` / `no_baseline`
 *   (b) the first turn after a compaction              → the restore prompt IS that snapshot (`forced`),
 *                                                        and it moves the epoch
 *   (c) the first turn after a significant/cold pause  → `cold_resume` / `significant_change`
 *   (d) the fresh-session replay inside `askOperator`  → `forced` (rebuilt, not replayed)
 *
 * The baseline is PERSISTENT (runtime_state), because a daemon that crashed
 * mid-episode otherwise has no idea what the session already knows.
 */

import type { NowItemFingerprints } from "./memory-layers.js";
import type { PauseAssessment } from "./pauses.js";

export interface PushBaseline {
  /** The session the snapshot was pushed INTO; a different one knows nothing. */
  sessionId: string;
  /** Compaction epoch — the history before it no longer exists verbatim. */
  epoch: string;
  /** Hash of the rendered now layer of the last ACCEPTED prompt (§1). */
  nowHash: string;
  /** Hash of the whole snapshot; answers "did anything change" for a significant pause. */
  snapshotHash: string;
  /** Per-item fingerprints, so the diff needs no second source of truth. */
  items: NowItemFingerprints;
  sentAt: string;
}

export type PushMode = "full" | "diff";

export type PushReason =
  | "forced"
  | "no_baseline"
  | "session_changed"
  | "epoch_changed"
  | "cold_resume"
  | "significant_change"
  | "in_episode";

export interface PushDecisionInput {
  baseline?: PushBaseline | undefined;
  sessionId: string;
  epoch: string;
  pause: PauseAssessment;
  snapshotHash: string;
  /** Compaction recovery, provider switch and fresh-session replay set this. */
  force?: boolean;
}

export interface PushDecision {
  mode: PushMode;
  reason: PushReason;
}

export function decidePushMode(input: PushDecisionInput): PushDecision {
  if (input.force) return { mode: "full", reason: "forced" };
  if (!input.baseline) return { mode: "full", reason: "no_baseline" };
  // A session id we never pushed into is a session that never saw the state:
  // recreation after a crash, a provider switch, a resume that failed over.
  if (input.baseline.sessionId !== input.sessionId) {
    return { mode: "full", reason: "session_changed" };
  }
  if (input.baseline.epoch !== input.epoch) return { mode: "full", reason: "epoch_changed" };
  if (input.pause.wantsFullSnapshot) {
    if (!input.pause.onlyWhenChanged) return { mode: "full", reason: "cold_resume" };
    // A `significant` pause where nothing moved does not deserve 6 KB: the
    // agent gets the gap line and, if anything did move, the diff.
    if (input.baseline.snapshotHash !== input.snapshotHash) {
      return { mode: "full", reason: "significant_change" };
    }
  }
  return { mode: "diff", reason: "in_episode" };
}

export function serializePushBaseline(baseline: PushBaseline): string {
  return JSON.stringify(baseline);
}

/** Tolerant by design: a malformed or pre-upgrade baseline means "push a full snapshot". */
export function parsePushBaseline(raw: string | undefined): PushBaseline | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<PushBaseline>;
    if (
      typeof parsed?.sessionId !== "string" ||
      typeof parsed.epoch !== "string" ||
      typeof parsed.nowHash !== "string" ||
      typeof parsed.snapshotHash !== "string"
    ) {
      return undefined;
    }
    return {
      sessionId: parsed.sessionId,
      epoch: parsed.epoch,
      nowHash: parsed.nowHash,
      snapshotHash: parsed.snapshotHash,
      items: (parsed.items ?? {}) as NowItemFingerprints,
      sentAt: typeof parsed.sentAt === "string" ? parsed.sentAt : "",
    };
  } catch {
    return undefined;
  }
}
