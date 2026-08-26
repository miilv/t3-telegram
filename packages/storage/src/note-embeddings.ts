import { createHash } from "node:crypto";
import type { PreparedNoteVector } from "../../shared/src/index.js";
import { operatorNoteInputHash, type OperatorNoteRepository } from "./operator-notes.js";

/** Operator-supplied local ONNX model; weights are deliberately not in git. */
export const MINILM_NOTE_EMBEDDING_MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
/** Current locality-sensitive 384d fallback. Earlier hash models stay distinct. */
export const HASH_NOTE_EMBEDDING_MODEL = "local-hash-v4";
export const NOTE_EMBEDDING_DIMENSIONS = 384;

type RuntimeEnvironment = {
  allowRemoteModels: boolean;
  allowLocalModels: boolean;
  localModelPath?: string;
};

type FeatureExtractor = (text: string, options: { pooling: "mean"; normalize: true }) => Promise<unknown>;
type TransformersRuntime = {
  env: RuntimeEnvironment;
  pipeline: (
    task: "feature-extraction",
    model: string,
    options: { local_files_only: true },
  ) => Promise<FeatureExtractor>;
};

export interface LocalNoteEmbeddingOptions {
  /** Test seam; production dynamically loads the pinned Transformers.js runtime. */
  loadRuntime?: () => Promise<TransformersRuntime>;
  configureRuntime?: (runtime: TransformersRuntime) => void;
}

export interface NoteEmbeddingBackfillResult {
  attempted: number;
  saved: number;
  semantic: boolean;
}

export interface NoteQueryVector {
  model: string;
  dimensions: number;
  values: number[];
}

/**
 * A small offline-only boundary. It never fetches model weights: missing or
 * corrupt local weights return deterministic retrieval vectors instead.
 */
export class LocalNoteEmbeddingService {
  private extractor: FeatureExtractor | undefined;
  private initialization: Promise<void> | undefined;
  private semantic = false;

  constructor(private readonly options: LocalNoteEmbeddingOptions = {}) {}

  isSemanticDedupeAvailable(): boolean {
    return this.semantic;
  }

  async embed(input: {
    key?: string;
    description?: string;
    category: string;
    content: string;
  }): Promise<PreparedNoteVector> {
    const inputHash = operatorNoteInputHash(input);
    const text = [input.key ?? "", input.description ?? "", input.category, input.content]
      .filter(Boolean)
      .join("\n");
    const query = await this.embedText(text);
    return { ...query, inputHash };
  }

  /** Embed a retrieval query with the same selected model and dimensions. */
  async embedQuery(query: string): Promise<NoteQueryVector> {
    return this.embedText(query);
  }

  private async embedText(text: string): Promise<NoteQueryVector> {
    await this.initialize();
    if (!this.extractor) {
      return {
        model: HASH_NOTE_EMBEDDING_MODEL,
        dimensions: NOTE_EMBEDDING_DIMENSIONS,
        values: featureHashVector(text),
      };
    }
    try {
      const values = vectorFromRuntimeResult(await this.extractor(text, { pooling: "mean", normalize: true }));
      if (values.length !== NOTE_EMBEDDING_DIMENSIONS) throw new Error("MiniLM returned an unexpected vector dimension");
      return { model: MINILM_NOTE_EMBEDDING_MODEL, dimensions: NOTE_EMBEDDING_DIMENSIONS, values };
    } catch {
      // A runtime becoming unusable after initialization must not block a note write.
      this.extractor = undefined;
      this.semantic = false;
      return {
        model: HASH_NOTE_EMBEDDING_MODEL,
        dimensions: NOTE_EMBEDDING_DIMENSIONS,
        values: featureHashVector(text),
      };
    }
  }

  /** Explicit maintenance work only; daemon startup must never call this. */
  async backfill(repository: OperatorNoteRepository, limit = 25): Promise<NoteEmbeddingBackfillResult> {
    await this.initialize();
    const model = this.semantic ? MINILM_NOTE_EMBEDDING_MODEL : HASH_NOTE_EMBEDDING_MODEL;
    const notes = repository.notesNeedingVector(model, NOTE_EMBEDDING_DIMENSIONS, limit);
    let saved = 0;
    for (const note of notes) {
      const vector = await this.embed(note);
      if (repository.savePreparedVector(note.id, vector)) saved += 1;
    }
    return { attempted: notes.length, saved, semantic: this.semantic };
  }

  private async initialize(): Promise<void> {
    if (!this.initialization) this.initialization = this.initializeOnce();
    await this.initialization;
  }

  private async initializeOnce(): Promise<void> {
    try {
      const runtime = await (this.options.loadRuntime ?? loadPinnedTransformersRuntime)();
      (this.options.configureRuntime ?? configureOfflineRuntime)(runtime);
      this.extractor = await runtime.pipeline("feature-extraction", MINILM_NOTE_EMBEDDING_MODEL, {
        local_files_only: true,
      });
      this.semantic = true;
    } catch {
      this.extractor = undefined;
      this.semantic = false;
    }
  }
}

async function loadPinnedTransformersRuntime(): Promise<TransformersRuntime> {
  const runtime = await import("@huggingface/transformers");
  return runtime as unknown as TransformersRuntime;
}

function configureOfflineRuntime(runtime: TransformersRuntime): void {
  runtime.env.allowRemoteModels = false;
  runtime.env.allowLocalModels = true;
}

function vectorFromRuntimeResult(result: unknown): number[] {
  const data = result && typeof result === "object" && "data" in result
    ? (result as { data: unknown }).data
    : result;
  if (!data || typeof data !== "object" || !(Symbol.iterator in data)) {
    throw new Error("MiniLM returned no vector data");
  }
  const values = Array.from(data as Iterable<unknown>);
  if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) {
    throw new Error("MiniLM returned an invalid vector");
  }
  return normalize(values as number[]);
}

/**
 * Feature hashing preserves token overlap (and short word stems) between a
 * stored fact and a query. It is deliberately a retriever only, never a
 * semantic-dedupe encoder.
 */
function featureHashVector(text: string): number[] {
  const values = new Array<number>(NOTE_EMBEDDING_DIMENSIONS).fill(0);
  const tokens = text.normalize("NFKC").toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  for (const token of tokens) {
    addFeature(values, `token:${token}`, 1);
    for (let width = 3; width <= Math.min(6, token.length); width += 1) {
      addFeature(values, `prefix:${token.slice(0, width)}`, 0.55);
    }
  }
  if (!tokens.length) addFeature(values, "empty", 1);
  return normalize(values);
}

function addFeature(values: number[], feature: string, weight: number): void {
  const digest = createHash("sha256").update(feature).digest();
  const first = digest.readUInt16BE(0) % NOTE_EMBEDDING_DIMENSIONS;
  const second = digest.readUInt16BE(2) % NOTE_EMBEDDING_DIMENSIONS;
  values[first] = (values[first] ?? 0) + weight;
  values[second] = (values[second] ?? 0) + weight * 0.5;
}

function normalize(values: number[]): number[] {
  const norm = Math.sqrt(values.reduce((total, value) => total + value * value, 0));
  if (!Number.isFinite(norm) || norm === 0) throw new Error("embedding has zero norm");
  return values.map((value) => value / norm);
}
