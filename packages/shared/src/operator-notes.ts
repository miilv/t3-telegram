/** Durable memory-note vocabulary (memory-design §2.3, package 3.2). */

export const OPERATOR_NOTE_STATUSES = ["active", "obsolete", "superseded"] as const;
export type OperatorNoteStatus = (typeof OPERATOR_NOTE_STATUSES)[number];

export const OPERATOR_NOTE_SOURCES = [
  "manual",
  "maintenance",
  "system",
  "distilled",
] as const;
export type OperatorNoteSource = (typeof OPERATOR_NOTE_SOURCES)[number];

export interface OperatorNote {
  id: string;
  /** Stable routing key for versioned notes. Legacy notes remain addressable by id. */
  key?: string;
  category: string;
  content: string;
  status: OperatorNoteStatus;
  source: OperatorNoteSource;
  createdAt: string;
  updatedAt: string;
  description?: string;
  verifiedAt?: string;
  validUntil?: string;
  supersededBy?: string;
  /** Compatibility-only field. New writes use validUntil. */
  expiresAt?: string;
  accessCount?: number;
  lastAccessedAt?: string;
}

export interface PreparedNoteVector {
  model: string;
  dimensions: number;
  inputHash: string;
  values: number[];
}

export interface OperatorNoteWriteIdentity {
  originJob: string;
  createSeq: number;
}
