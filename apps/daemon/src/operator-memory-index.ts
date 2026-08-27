import {
  ANTI_REDISCOVERY_CATEGORY,
  operatorNotePushScore,
  rankOperatorNotesForPush,
  staleOperatorNoteWarning,
  type MemoryIndexNote,
} from "../../../packages/policy/src/index.js";
import { defangMarkers } from "../../../packages/shared/src/index.js";
import type { OperatorStore } from "../../../packages/storage/src/index.js";

/** Build pull-only index rows after canonical ranking of the complete active set. */
export function currentMemoryNotesForPush(
  store: Pick<OperatorStore, "notes">,
  at = new Date(),
): { index: MemoryIndexNote[]; antiRediscovery: MemoryIndexNote[] } {
  const notes: MemoryIndexNote[] = rankOperatorNotesForPush(
    store.notes.listAllActiveForPush(),
    at,
  ).map((note) => {
    const warning = staleOperatorNoteWarning(note, at);
    return {
      id: note.id,
      // Content is retained only for the bounded legacy-keyless reference
      // fallback. Keyed Notes v2 render description/key, never full bodies.
      content: defangMarkers(note.content),
      updatedAt: note.updatedAt,
      category: note.category,
      pushScore: operatorNotePushScore(note, at),
      ...(note.key ? { key: note.key } : {}),
      ...(warning ? { warning } : {}),
      ...(note.description ? { description: defangMarkers(note.description) } : {}),
    };
  });
  return {
    index: notes.filter((note) => note.category !== ANTI_REDISCOVERY_CATEGORY),
    antiRediscovery: notes.filter((note) => note.category === ANTI_REDISCOVERY_CATEGORY),
  };
}
