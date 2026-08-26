/**
 * Now-state rules that are POLICY, not storage (memory-design §2.2, §5).
 *
 * Three things live here, and they share one property: none of them may need a
 * database to be tested.
 *
 *   - the per-item write linter, with its feedback texts FIXED IN CODE;
 *   - the render selection (what a layer may show, and what may never be
 *     dropped from it);
 *   - the derivation of `focus_state` from the daemon's own items.
 *
 * What is deliberately NOT here: any aggregate budget check on the write path.
 * §2.2 is explicit that the budget is a property of the RENDER — refusing a
 * write mid-turn costs extra iterations while the owner waits, and a turn that
 * gets preempted between the refusal and the retry loses the record entirely.
 * `renderNowState` resolves overflow by ranking and an explicit tail instead.
 */

import { NOW_ITEM_CONTENT_CHARS, type NowStateItem } from "./memory-layers.js";
import type { NowItem, NowSection } from "../../shared/src/index.js";

/**
 * The linter's verdict.
 *
 * A STRUCTURAL result, not a thrown error, and that is the whole point (§5):
 * Claude surfaces a thrown tool error as a red block, Codex swallows it into a
 * terse line, and a rule that only one of the two branches can read is a rule
 * that silently stops existing on provider switch. `{ok:false, hint}` renders
 * identically in both, and the hint text is frozen here rather than composed
 * per call, so the agent learns ONE sentence per defect instead of a family.
 */
export type NowLintResult = { ok: true } | { ok: false; hint: string };

export const NOW_HINT_EMPTY =
  "A now item needs content: one line naming the work, in the owner's language. Empty items are dropped.";

export const NOW_HINT_TOO_LONG =
  `A now item is one line of at most ${NOW_ITEM_CONTENT_CHARS} characters — a title for the work, not its description. ` +
  "Shorten it; put the detail in a note (memory.remember) or in the thread itself.";

export const NOW_HINT_CODE_BLOCK =
  "A now item is prose, not code: no fenced code blocks. Name what the work IS; the code belongs in the thread or in a note.";

export const NOW_HINT_DAEMON_CONTENT =
  "This item belongs to the daemon's own bookkeeping of a work thread — its text is regenerated from the thread, so an edit would be overwritten. " +
  "You may still move it (section) or mark it (status); to change what it SAYS, change the work.";

export const NOW_HINT_UNKNOWN_ITEM =
  "No open now item with that id. Call now.get for the current list and use an id exactly as printed there.";

export const NOW_HINT_CREATE_NEEDS_FIELDS =
  "Creating a now item needs both section and content. Pass an id instead to change an item that already exists.";

export const NOW_HINT_CLOSE_NEEDS_ID =
  "Closing archives an item into the journal, so it needs the id of the item you are closing. Call now.get for the current list.";

/** ``` or ~~~ anywhere: the one shape that is unambiguously a code block. */
const CODE_FENCE = /(?:```|~~~)/u;

/**
 * The per-item write linter (§2.2, §5): `content` ≤200 characters, no code
 * blocks. Nothing else — every other constraint of §2.2 is enforced by the
 * schema (the section vocabulary) or by the render (the budget).
 */
export function lintNowContent(content: string): NowLintResult {
  const trimmed = content.trim();
  if (!trimmed) return { ok: false, hint: NOW_HINT_EMPTY };
  if (CODE_FENCE.test(trimmed)) return { ok: false, hint: NOW_HINT_CODE_BLOCK };
  // Counted in CHARACTERS, like every budget in this design: the content is
  // mostly Cyrillic, where a byte count would be half the limit it reads like.
  if ([...trimmed].length > NOW_ITEM_CONTENT_CHARS) {
    return { ok: false, hint: NOW_HINT_TOO_LONG };
  }
  return { ok: true };
}

/** §2.2: a daemon item's `section`/`status` are the agent's, its `content` is not. */
export function mayAgentEditContent(item: Pick<NowItem, "source">): boolean {
  return item.source !== "daemon";
}

/** The only two sections the daemon derives from a thread's runtime status. */
const DAEMON_DERIVED_SECTIONS: readonly NowSection[] = ["active", "waiting"];

/**
 * Which section a daemon item should carry after the daemon regenerates it.
 *
 * The two halves of §2.2 pull opposite ways here: the daemon owns a thread
 * item's content and keeps it current, and the agent may move that same item
 * ("перенеси в blocked"). A daemon that simply wrote its derived section back
 * would undo the move on the very next thread event.
 *
 * The line that resolves it: the daemon only ever derives `active` or
 * `waiting` — the two states it can observe. A section outside that pair can
 * only have been set by the agent, and it is a JUDGEMENT the daemon has no
 * observation to contradict, so it stands. Within the pair the daemon's
 * reading is the newer fact and wins.
 */
export function reconcileDaemonSection(current: NowSection, derived: NowSection): NowSection {
  return DAEMON_DERIVED_SECTIONS.includes(current) ? derived : current;
}

/** The daemon's own active work is what the render may never drop (§2.2). */
const PINNED_SECTIONS: readonly NowSection[] = ["active", "blocked"];

/**
 * What the now layer is allowed to show, given the ledger and the moment.
 *
 * Two exclusions, both immediate by §2.2:
 *   - a CLOSED item leaves the render at once (its archive is the journal
 *     entry written when it closed);
 *   - an item past its `valid_until` is hidden at once. Hiding is not
 *     archiving: moving it into the journal is the secretary's job in package
 *     3.1, and until then an expired item stays in the table, unrendered.
 *     Deleting it here would destroy the very row the secretary has to file.
 */
export function selectNowItemsForRender(
  items: readonly NowItem[],
  at: Date = new Date(),
): NowStateItem[] {
  const now = at.getTime();
  return items
    .filter((item) => item.status !== "closed")
    .filter((item) => {
      if (!item.validUntil) return true;
      const expiry = Date.parse(item.validUntil);
      return Number.isNaN(expiry) || expiry > now;
    })
    .map((item) => ({
      id: item.id,
      section: item.section,
      content: item.content,
      updatedAt: item.updatedAt,
      source: item.source,
      ...(item.threadRef ? { threadRef: item.threadRef } : {}),
      pinned: item.source === "daemon" && PINNED_SECTIONS.includes(item.section),
    }));
}

/**
 * `focus_state`'s primary thread, derived (§2.2 after package 1.3).
 *
 * Ranked by the item's CREATION instant — the moment its thread started — and
 * never by `updated_at`: the daemon regenerates a daemon item's content
 * whenever the thread moves, and a focus that followed that would jump to
 * whichever worker last emitted a progress event rather than staying on the
 * work most recently started.
 *
 * `blocked` items are excluded outright: §2.2 takes "перенеси в blocked" as the
 * agent saying this work is not what is happening now, and a blocked thread is
 * the worst possible target for an owner's unaddressed reply.
 */
export function deriveFocusThreadRef(items: readonly NowItem[]): string | undefined {
  const candidates = items.filter(
    (item) =>
      item.source === "daemon" &&
      item.section === "active" &&
      item.status !== "closed" &&
      Boolean(item.threadRef),
  );
  let best: NowItem | undefined;
  for (const item of candidates) {
    if (!best || createdOrder(item) > createdOrder(best)) best = item;
  }
  return best?.threadRef;
}

function createdOrder(item: NowItem): number {
  const parsed = Date.parse(item.createdAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * The body of the automatic journal entry written when an item closes (§2.2:
 * "при закрытии автоматически создаётся журнальная запись (архив)").
 *
 * Deliberately a plain archive line, not a narrative: the daemon knows WHAT
 * closed and when, and nothing about why. The narrative skeleton of §2.4
 * ("Сделано / Решения / …") is written by the agent and the secretary, who have
 * the story; a daemon inventing one would be exactly the fabrication persona
 * rule 5 forbids.
 */
export function renderClosedItemJournalBody(item: NowItem, closedAt: string): string {
  const origin = item.source === "daemon" ? "daemon bookkeeping" : "agent";
  return [
    `Closed (${origin}): ${item.content.trim()}`,
    `Section: ${item.section}. Status at close: ${item.status}.`,
    ...(item.threadRef ? [`Thread: ${item.threadRef}.`] : []),
    `Opened ${item.createdAt}, closed ${closedAt}.`,
  ].join("\n");
}

/**
 * A journal slug is a NAME, not an id (§2.2: `journal_ref` holds "слаг ... имя,
 * не id"), so it is built from the day and the item's own words and stays
 * readable in a render. Uniqueness is the store's problem — it is the only
 * layer that can see a collision.
 */
export function journalSlugBase(day: string, content: string): string {
  const words = content
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48)
    .replace(/-+$/u, "");
  return words ? `${day}-${words}` : day;
}
