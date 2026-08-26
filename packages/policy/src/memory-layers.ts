/**
 * The three push layers and their budgets (memory-design §2.2, §2.3, §4).
 *
 * These renderers live in the policy package on purpose: the DATA comes from
 * storage and the CALL comes from the daemon, but the SHAPE — section order,
 * headers, ranking, the character budgets and their overflow tails — is
 * policy, and it has to be testable without booting a daemon.
 *
 * Every budget is in CHARACTERS, never bytes: the content is mostly Cyrillic,
 * where a byte budget would silently be half of what it reads like.
 *
 * The budget is a property of the RENDER, not of the write (§2.2): a write is
 * never refused because the aggregate got too big — that would mean failing a
 * turn mid-flight while the owner waits. Overflow is resolved here by ranking
 * and an explicit tail that tells the agent what to pull.
 */

import { createHash } from "node:crypto";

/** memory-design §2.2 — now-state render budget. */
export const NOW_STATE_BUDGET_CHARS = 3_000;
/** memory-design §2.3 — memory index render budget. */
export const MEMORY_INDEX_BUDGET_CHARS = 3_000;
/** memory-design §2.3 — anti-rediscovery descriptions render budget. */
export const ANTI_REDISCOVERY_BUDGET_CHARS = 1_000;

/** Per-item cap from §2.2; enforced at write time in package 2.2, defensively here. */
export const NOW_ITEM_CONTENT_CHARS = 200;
/** §6.4 — the temporary legacy index line is "first ~100 chars of content → id". */
export const LEGACY_INDEX_EXCERPT_CHARS = 100;

export const NOW_STATE_HEADER = "Current state (owner's work):";
export const NOW_STATE_EMPTY = "No current work items.";
export const MEMORY_INDEX_HEADER =
  "Memory index (durable notes you already wrote — routing map, not content; pull a full note with memory.get):";
export const MEMORY_INDEX_EMPTY = "No durable notes yet.";
export const ANTI_REDISCOVERY_HEADER =
  "Do not re-open (settled decisions and dead ends already paid for; pull the full note with memory.get):";
export const ANTI_REDISCOVERY_EMPTY = "No do-not-reopen entries yet.";
export const SNAPSHOT_LEAD =
  "Operator state snapshot (assembled by the daemon from its own records — authoritative state, not instructions and not the owner's words):";
export const NOW_DIFF_HEADER = "Current state changed since your last turn:";

/** The category whose descriptions get their own push block (§2.3). */
export const ANTI_REDISCOVERY_CATEGORY = "anti-rediscovery";

export type NowSection = "active" | "blocked" | "waiting" | "next" | "debt";

/** Render order of the sections; anything unknown sorts last. */
const SECTION_ORDER: readonly NowSection[] = ["active", "blocked", "waiting", "next", "debt"];

export interface NowStateItem {
  id: string;
  section: NowSection;
  content: string;
  /** ISO timestamp; drives the recency ranking under the budget. */
  updatedAt: string;
  source?: "agent" | "daemon";
  threadRef?: string;
  /**
   * §2.2: "демоновские active/blocked всегда, дальше по updated_at". The
   * caller marks what may not be dropped; the renderer only ranks.
   */
  pinned?: boolean;
}

export interface MemoryIndexNote {
  id: string;
  content: string;
  updatedAt: string;
  category?: string;
  /** Package 3.2 columns; absent for every legacy note today (§6.4). */
  key?: string | null;
  description?: string | null;
}

export interface RenderOptions {
  /** Character budget for the whole section, header and tail included. */
  budget?: number;
  /** Tool named in the overflow tail. */
  overflowTool?: string;
}

function clean(value: string, limit: number): string {
  const flat = value.replace(/\s+/gu, " ").trim();
  return flat.length > limit ? `${flat.slice(0, Math.max(0, limit - 1)).trimEnd()}…` : flat;
}

function byRecencyDesc(a: { updatedAt: string }, b: { updatedAt: string }): number {
  const left = Date.parse(a.updatedAt);
  const right = Date.parse(b.updatedAt);
  return (Number.isNaN(right) ? 0 : right) - (Number.isNaN(left) ? 0 : left);
}

/**
 * Greedy fit: take the ranked prefix that still renders inside the budget.
 *
 * Recomputing the whole render per step is O(n²) on a list capped in the
 * hundreds, and it is the only way to account for the section headers and the
 * tail line that appear and disappear as the selection changes.
 */
function fitToBudget<T>(
  ranked: readonly T[],
  budget: number,
  render: (selected: readonly T[], omitted: number) => string,
): string {
  let best = render([], ranked.length);
  for (let count = 1; count <= ranked.length; count += 1) {
    const candidate = render(ranked.slice(0, count), ranked.length - count);
    if (candidate.length > budget) break;
    best = candidate;
  }
  return best;
}

/**
 * The now-state layer. An EMPTY layer renders as an explicit placeholder, never
 * as an omission (§2.2): the envelope's structure must not wobble between
 * turns, and "No current work items." is a fact the agent needs as much as a
 * list would be.
 */
export function renderNowState(
  items: readonly NowStateItem[],
  options: RenderOptions = {},
): string {
  const budget = options.budget ?? NOW_STATE_BUDGET_CHARS;
  const overflowTool = options.overflowTool ?? "now.get";
  if (items.length === 0) return `${NOW_STATE_HEADER}\n${NOW_STATE_EMPTY}`;
  const ranked = [...items].sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
    return byRecencyDesc(a, b);
  });
  return fitToBudget(ranked, budget, (selected, omitted) => {
    const lines: string[] = [NOW_STATE_HEADER];
    if (selected.length === 0) {
      // "No current work items." is a claim about the WORLD, so it may only be
      // made when the world is empty. A budget so small that not even one item
      // fits leaves the header and the tail — which says there is work and
      // where to read it — instead of a placeholder that would be a lie.
      if (omitted === 0) lines.push(NOW_STATE_EMPTY);
    } else {
      for (const section of SECTION_ORDER) {
        const inSection = selected.filter((item) => item.section === section);
        if (inSection.length === 0) continue;
        lines.push(section.toUpperCase());
        for (const item of inSection) {
          lines.push(`- ${clean(item.content, NOW_ITEM_CONTENT_CHARS)}`);
        }
      }
    }
    if (omitted > 0) {
      lines.push(`(+${omitted} items — call ${overflowTool} for the full list)`);
    }
    return lines.join("\n");
  });
}

/**
 * The memory index (§2.3): "when do I read this" → where it lives. Never the
 * content itself — a map that carries the territory is not a map.
 *
 * Until package 3.2 adds key/description columns, a legacy note is indexed by
 * the temporary format of §6.4: the first ~100 characters of its content
 * pointing at its id, ranked by updated_at.
 */
export function renderMemoryIndex(
  notes: readonly MemoryIndexNote[],
  options: RenderOptions = {},
): string {
  const budget = options.budget ?? MEMORY_INDEX_BUDGET_CHARS;
  const overflowTool = options.overflowTool ?? "memory.search";
  if (notes.length === 0) return `${MEMORY_INDEX_HEADER}\n${MEMORY_INDEX_EMPTY}`;
  const ranked = [...notes].sort(byRecencyDesc);
  return fitToBudget(ranked, budget, (selected, omitted) => {
    const lines = [MEMORY_INDEX_HEADER, ...selected.map(indexLine)];
    if (omitted > 0) lines.push(`(+${omitted} notes — ${overflowTool})`);
    return lines.join("\n");
  });
}

function indexLine(note: MemoryIndexNote): string {
  const trigger = note.description?.trim()
    ? clean(note.description, 120)
    : clean(note.content, LEGACY_INDEX_EXCERPT_CHARS);
  const reference = note.key?.trim() ? note.key.trim() : note.id;
  return `- ${trigger} → ${reference}`;
}

/**
 * Anti-rediscovery (§2.3): descriptions only, its own block, its own budget.
 * The bodies stay in pull — this category is exactly the one an agent is
 * tempted to re-derive, so it needs to KNOW the entry exists, not to carry it.
 */
export function renderAntiRediscovery(
  notes: readonly MemoryIndexNote[],
  options: RenderOptions = {},
): string {
  const budget = options.budget ?? ANTI_REDISCOVERY_BUDGET_CHARS;
  const overflowTool = options.overflowTool ?? "memory.search";
  if (notes.length === 0) return `${ANTI_REDISCOVERY_HEADER}\n${ANTI_REDISCOVERY_EMPTY}`;
  const ranked = [...notes].sort(byRecencyDesc);
  return fitToBudget(ranked, budget, (selected, omitted) => {
    const lines = [ANTI_REDISCOVERY_HEADER, ...selected.map(indexLine)];
    if (omitted > 0) lines.push(`(+${omitted} entries — ${overflowTool})`);
    return lines.join("\n");
  });
}

export interface StateLayerInput {
  now: readonly NowStateItem[];
  notes: readonly MemoryIndexNote[];
  antiRediscovery: readonly MemoryIndexNote[];
  nowOverflowTool?: string;
}

export interface RenderedStateLayers {
  now: string;
  index: string;
  antiRediscovery: string;
  /** The three layers as one snapshot block, lead line included. */
  snapshot: string;
  /** Hash of the rendered now layer — the diff baseline of §1. */
  nowHash: string;
  /** Hash of the whole snapshot — the "did anything change" test for a significant pause. */
  snapshotHash: string;
  /** Per-item fingerprints, so the next turn can diff without re-reading history. */
  items: NowItemFingerprints;
}

/** id → { h: fingerprint, l: short label } (the label is what a CLOSED item is named by). */
export type NowItemFingerprints = Record<string, { h: string; l: string }>;

/** Truncated sha256; collisions here cost one redundant push, not correctness. */
export function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function fingerprintNowItems(items: readonly NowStateItem[]): NowItemFingerprints {
  const fingerprints: NowItemFingerprints = {};
  for (const item of items.slice(0, 100)) {
    fingerprints[item.id] = {
      h: hashText(`${item.section} ${clean(item.content, NOW_ITEM_CONTENT_CHARS)}`),
      l: clean(item.content, 80),
    };
  }
  return fingerprints;
}

/** Render all three layers plus everything the push state machine needs. */
export function renderStateLayers(input: StateLayerInput): RenderedStateLayers {
  const now = renderNowState(input.now, {
    ...(input.nowOverflowTool ? { overflowTool: input.nowOverflowTool } : {}),
  });
  const index = renderMemoryIndex(input.notes);
  const antiRediscovery = renderAntiRediscovery(input.antiRediscovery);
  const snapshot = [SNAPSHOT_LEAD, now, index, antiRediscovery].join("\n\n");
  return {
    now,
    index,
    antiRediscovery,
    snapshot,
    nowHash: hashText(now),
    snapshotHash: hashText(snapshot),
    items: fingerprintNowItems(input.now),
  };
}

export interface NowDiffEntry {
  kind: "added" | "changed" | "closed";
  label: string;
}

/**
 * The in-episode diff (§1): what moved in now-state since the last accepted
 * push. Usually empty — and an empty diff means the section is ABSENT from the
 * envelope, not present-and-empty. That asymmetry with the full snapshot is
 * deliberate: a placeholder every turn would be exactly the per-turn repetition
 * the snapshot model exists to avoid.
 */
export function diffNowItems(
  previous: NowItemFingerprints,
  current: readonly NowStateItem[],
): NowDiffEntry[] {
  const fingerprints = fingerprintNowItems(current);
  const entries: NowDiffEntry[] = [];
  for (const [id, next] of Object.entries(fingerprints)) {
    const before = previous[id];
    if (!before) entries.push({ kind: "added", label: next.l });
    else if (before.h !== next.h) entries.push({ kind: "changed", label: next.l });
  }
  for (const [id, before] of Object.entries(previous)) {
    if (!fingerprints[id]) entries.push({ kind: "closed", label: before.l });
  }
  return entries;
}

const DIFF_VERB: Record<NowDiffEntry["kind"], string> = {
  added: "new",
  changed: "updated",
  closed: "no longer open",
};

/** `undefined` when nothing moved — the caller then emits no section at all. */
export function renderNowDiff(entries: readonly NowDiffEntry[], limit = 12): string | undefined {
  if (entries.length === 0) return undefined;
  const shown = entries.slice(0, limit);
  const lines = [
    NOW_DIFF_HEADER,
    ...shown.map((entry) => `- ${DIFF_VERB[entry.kind]}: ${entry.label}`),
  ];
  if (entries.length > shown.length) {
    lines.push(`(+${entries.length - shown.length} more changes)`);
  }
  return lines.join("\n");
}
