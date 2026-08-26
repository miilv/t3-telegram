import {
  validateOperatorNoteDraft,
} from "../../policy/src/operator-notes.js";
import { createHash } from "node:crypto";
import type { OperatorNote, OperatorNoteSource, PreparedNoteVector } from "../../shared/src/index.js";
import {
  MINILM_NOTE_EMBEDDING_MODEL,
  NOTE_EMBEDDING_DIMENSIONS,
} from "./note-embeddings.js";
import {
  OperatorNoteRepository,
  type OperatorNoteWriteResult,
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

export function automaticOperatorNoteOperationKey(
  draft: Omit<KeyedOperatorNoteDraft, "operationKey">,
): string {
  const validated = validateOperatorNoteDraft(draft);
  const payload = validated.ok
    ? {
        key: validated.key,
        description: validated.description,
        category: validated.category,
        content: validated.content,
        source: draft.source,
        verifiedAt: draft.verifiedAt ?? "",
        validUntil: draft.validUntil ?? "",
      }
    : draft;
  return `manual:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
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

    const replay = this.repository.operationReplay(draft.operationKey);
    if (replay) {
      return { ok: true, kind: "written", write: { note: replay, applied: false }, crossLinks: [] };
    }

    const input = {
      key: validated.key,
      description: validated.description,
      category: validated.category,
      content: validated.content,
    };
    const current = this.repository.getActive(input.key);
    // A distilled fact may never overwrite a curator's keyed fact, regardless
    // of whether the local semantic model is presently available.
    if (current?.source === "manual" && draft.source === "distilled") {
      return { ok: true, kind: "merge-proposal", mergeProposal: { note: current, score: 1 } };
    }
    const vector = await this.embeddings.embed(input);
    // Exact-key writes are authorized version changes. Semantic dedupe is only
    // for cross-key matches, never a way to block the key's current editor.
    if (current) {
      const write = this.repository.writeVersion({
        ...input,
        source: draft.source,
        ...(draft.verifiedAt ? { verifiedAt: draft.verifiedAt } : {}),
        ...(draft.validUntil ? { validUntil: draft.validUntil } : {}),
        operationKey: draft.operationKey,
        vectors: [vector],
      });
      return { ok: true, kind: "written", write, crossLinks: [] };
    }
    const semantic = this.embeddings.isSemanticDedupeAvailable() &&
      vector.model === MINILM_NOTE_EMBEDDING_MODEL &&
      vector.dimensions === NOTE_EMBEDDING_DIMENSIONS;
    const matches = semantic ? this.findSemanticMatches(vector, input.key) : [];
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

  private findSemanticMatches(vector: PreparedNoteVector, key: string): NoteSimilarity[] {
    return this.repository
      .comparableVectors(vector.model, vector.dimensions)
      .filter((candidate) => candidate.note.key !== key)
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
