import {
  validateOperatorNoteDraft,
  type NoteDraftValidation,
} from "../../policy/src/operator-notes.js";
import type { OperatorNote, OperatorNoteSource, PreparedNoteVector } from "../../shared/src/index.js";
import {
  MINILM_NOTE_EMBEDDING_MODEL,
  NOTE_EMBEDDING_DIMENSIONS,
} from "./note-embeddings.js";
import {
  OperatorNoteRepository,
  type OperatorNoteWriteResult,
  type StoredNoteVector,
} from "./operator-notes.js";

export const MINILM_MERGE_PROPOSAL_THRESHOLD = 0.85;
export const MINILM_CROSS_LINK_THRESHOLD = 0.70;

export interface NoteEmbeddingPort {
  isSemanticDedupeAvailable(): boolean;
  embed(input: {
    key?: string;
    description?: string;
    category: string;
    content: string;
  }): Promise<PreparedNoteVector>;
}

export interface KeyedOperatorNoteDraft {
  key: string;
  description: string;
  category?: string;
  content: string;
  source: OperatorNoteSource;
  verifiedAt?: string;
  validUntil?: string;
  operationKey: string;
}

export type KeyedOperatorNoteWriteResult =
  | { ok: false; hint: string }
  | {
      ok: true;
      kind: "merge-proposal";
      mergeProposal: NoteSimilarity;
    }
  | {
      ok: true;
      kind: "written";
      write: OperatorNoteWriteResult;
      crossLinks: NoteSimilarity[];
    };

export interface NoteSimilarity {
  note: OperatorNote;
  score: number;
}

/**
 * The only keyed-write boundary: validation, local embedding, semantic advice,
 * exact-key version transaction and structured result stay inseparable.
 */
export class OperatorNoteWriter {
  constructor(
    private readonly repository: OperatorNoteRepository,
    private readonly embeddings: NoteEmbeddingPort,
  ) {}

  async write(draft: KeyedOperatorNoteDraft): Promise<KeyedOperatorNoteWriteResult> {
    const validated = validateOperatorNoteDraft(draft);
    if (!validated.ok) return validated;
    if (!draft.operationKey.trim()) return { ok: false, hint: "A durable operation key is required." };

    const input = {
      key: validated.key,
      description: validated.description,
      category: validated.category,
      content: validated.content,
    };
    const vector = await this.embeddings.embed(input);
    const semantic = this.embeddings.isSemanticDedupeAvailable() &&
      vector.model === MINILM_NOTE_EMBEDDING_MODEL &&
      vector.dimensions === NOTE_EMBEDDING_DIMENSIONS;
    const matches = semantic ? this.findSemanticMatches(vector) : [];
    const mergeProposal = matches.find((match) => match.score >= MINILM_MERGE_PROPOSAL_THRESHOLD);
    // Curated notes (and every other source) are never silently merged.
    if (mergeProposal) return { ok: true, kind: "merge-proposal", mergeProposal };

    const write = this.repository.writeVersion({
      ...input,
      source: draft.source,
      ...(draft.verifiedAt ? { verifiedAt: draft.verifiedAt } : {}),
      ...(draft.validUntil ? { validUntil: draft.validUntil } : {}),
      operationKey: draft.operationKey,
      vectors: [vector],
    });
    return {
      ok: true,
      kind: "written",
      write,
      crossLinks: matches.filter((match) => match.score >= MINILM_CROSS_LINK_THRESHOLD),
    };
  }

  private findSemanticMatches(vector: PreparedNoteVector): NoteSimilarity[] {
    return this.repository
      .comparableVectors(vector.model, vector.dimensions)
      .map((candidate) => ({ note: candidate.note, score: cosineSimilarity(vector.values, candidate.values) }))
      .filter((candidate) => Number.isFinite(candidate.score))
      .sort((left, right) => right.score - left.score || left.note.id.localeCompare(right.note.id));
  }
}

function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length || left.length === 0) return Number.NEGATIVE_INFINITY;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
    leftNorm += left[index]! * left[index]!;
    rightNorm += right[index]! * right[index]!;
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : Number.NEGATIVE_INFINITY;
}
