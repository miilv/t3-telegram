import type { OperatorNote } from "../../shared/src/index.js";
import type { NoteQueryVector } from "./note-embeddings.js";

export interface PublicOperatorNoteSource {
  notes: { touch(noteIds: readonly string[]): void };
  getOperatorNote(reference: string): OperatorNote | undefined;
  searchOperatorNotesEmbedded(
    query: string,
    embedQuery?: (query: string) => Promise<NoteQueryVector>,
    limit?: number,
  ): Promise<OperatorNote[]>;
}

/** One successful public pull is one access; misses and internal scans are not accesses. */
export function getPublicOperatorNote(
  source: PublicOperatorNoteSource,
  reference: string,
): OperatorNote | undefined {
  const note = source.getOperatorNote(reference);
  if (note) source.notes.touch([note.id]);
  return note;
}

/** Each invocation touches every distinct returned note once; explicit retries count as new reads. */
export async function searchPublicOperatorNotes(
  source: PublicOperatorNoteSource,
  query: string,
  limit: number,
  embedQuery?: (query: string) => Promise<NoteQueryVector>,
): Promise<OperatorNote[]> {
  const notes = await source.searchOperatorNotesEmbedded(query, embedQuery, limit);
  source.notes.touch(notes.map((note) => note.id));
  return notes;
}
