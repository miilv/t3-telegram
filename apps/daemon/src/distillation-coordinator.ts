import { createHash } from "node:crypto";
import {
  DISTILLATION_BATCH_MAX_CODE_POINTS,
  DISTILLATION_BATCH_MAX_ROWS,
  buildDistillationPrompt,
  parseDistillationResponse,
} from "../../../packages/policy/src/index.js";
import type { DistilledNoteCandidate } from "../../../packages/policy/src/index.js";
import type { OperatorStore } from "../../../packages/storage/src/index.js";

export const DISTILLATION_CONSUMER = "night-scribe-distillation";
export const DISTILLATION_MAX_BATCHES_PER_RUN = 3;

export interface DistillationRunOutcome {
  status: "idle" | "completed" | "degraded" | "failed" | "raced";
  llmCalls: number;
  batches: number;
  written: number;
  proposals: number;
  crossLinks: number;
  hasMore: boolean;
  detail?: string;
  providerUnavailable?: boolean;
}

export interface ConversationDistillationDeps {
  store: OperatorStore;
  oneShot: (prompt: string) => Promise<string>;
}

/** Bounded reconciliation from a frozen logical-ledger range into Notes v2. */
export class ConversationDistillationCoordinator {
  constructor(private readonly deps: ConversationDistillationDeps) {}

  async run(ownerId: string): Promise<DistillationRunOutcome> {
    let afterSeq = this.deps.store.conversation.cursor(DISTILLATION_CONSUMER, ownerId);
    let batch = this.deps.store.conversation.selectBatch({
      ownerId,
      afterSeq,
      limit: DISTILLATION_BATCH_MAX_ROWS,
      characterLimit: DISTILLATION_BATCH_MAX_CODE_POINTS,
    });
    if (!batch.entries.length) return emptyOutcome("idle");
    const frozenHighWater = batch.highWaterSeq;
    let llmCalls = 0;
    let batches = 0;
    let written = 0;
    let proposals = 0;
    let crossLinks = 0;
    for (let page = 0; page < DISTILLATION_MAX_BATCHES_PER_RUN; page += 1) {
      if (page > 0) {
        batch = this.deps.store.conversation.selectBatch({
          ownerId,
          afterSeq,
          throughSeq: frozenHighWater,
          limit: DISTILLATION_BATCH_MAX_ROWS,
          characterLimit: DISTILLATION_BATCH_MAX_CODE_POINTS,
        });
        if (!batch.entries.length) break;
      }
      const built = buildDistillationPrompt({
        ownerId,
        afterSeq,
        highWaterSeq: frozenHighWater,
        throughSeq: batch.throughSeq,
        entries: batch.entries,
      });
      let response: string;
      try {
        response = await this.deps.oneShot(built.prompt);
      } catch (error) {
        return {
          status: llmCalls > 0 ? "degraded" : "failed",
          llmCalls,
          batches,
          written,
          proposals,
          crossLinks,
          hasMore: true,
          providerUnavailable: true,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
      // The provider completed a billed call even if the strict grammar below
      // rejects its response. Provider throws never reach this increment.
      llmCalls += 1;
      const parsed = parseDistillationResponse(response, built.ownerEvidence);
      if (!parsed.ok) {
        return {
          status: batches > 0 ? "degraded" : "failed",
          llmCalls,
          batches,
          written,
          proposals,
          crossLinks,
          hasMore: true,
          detail: parsed.error,
        };
      }
      if (parsed.kind === "candidates") {
        try {
          const applied = await this.applyCandidates({
            ownerId,
            afterSeq,
            throughSeq: batch.throughSeq,
            highWaterSeq: frozenHighWater,
            candidates: parsed.candidates,
          });
          written += applied.written;
          proposals += applied.proposals;
          crossLinks += applied.crossLinks;
        } catch (error) {
          return {
            status: "degraded",
            llmCalls,
            batches,
            written,
            proposals,
            crossLinks,
            hasMore: true,
            detail: error instanceof Error ? error.message : String(error),
          };
        }
      }
      const advanced = this.deps.store.conversation.advanceCursor(
        DISTILLATION_CONSUMER,
        ownerId,
        afterSeq,
        batch.throughSeq,
      );
      if (!advanced) {
        return {
          status: "raced",
          llmCalls,
          batches,
          written,
          proposals,
          crossLinks,
          hasMore: true,
        };
      }
      batches += 1;
      afterSeq = batch.throughSeq;
      if (afterSeq >= frozenHighWater) break;
    }
    return {
      status: "completed",
      llmCalls,
      batches,
      written,
      proposals,
      crossLinks,
      hasMore: this.deps.store.conversation.countEligibleAfter(ownerId, afterSeq) > 0,
    };
  }

  private async applyCandidates(input: {
    ownerId: string;
    afterSeq: number;
    throughSeq: number;
    highWaterSeq: number;
    candidates: readonly DistilledNoteCandidate[];
  }): Promise<{ written: number; proposals: number; crossLinks: number }> {
    let written = 0;
    let proposals = 0;
    let crossLinks = 0;
    for (const candidate of input.candidates) {
      const replayKey = distillationCandidateReplayKey({ ...input, candidate });
      if (this.deps.store.distillationProposals.getByReplayKey(replayKey)) {
        proposals += 1;
        continue;
      }
      const result = await this.deps.store.noteWriter.write({
        key: candidate.key,
        description: candidate.description,
        content: candidate.content,
        category: candidate.category,
        source: "distilled",
        ...(candidate.validUntil ? { validUntil: candidate.validUntil } : {}),
        operationKey: replayKey,
        evidence: { ownerId: input.ownerId, sequences: candidate.evidenceSeqs },
      });
      if (!result.ok) throw new Error(result.hint);
      if (result.kind === "merge-proposal") {
        this.deps.store.distillationProposals.put({
          replayKey,
          ownerId: input.ownerId,
          candidateKey: candidate.key,
          description: candidate.description,
          content: candidate.content,
          category: candidate.category,
          validUntil: candidate.validUntil,
          evidenceSeqs: candidate.evidenceSeqs,
          matchingNoteId: result.mergeProposal.note.id,
          reason: result.mergeProposal.note.key === candidate.key ? "exact-key" : "semantic",
          score: result.mergeProposal.score,
        });
        proposals += 1;
      } else {
        written += 1;
        crossLinks += result.crossLinks.length;
      }
    }
    return { written, proposals, crossLinks };
  }
}

export function distillationCandidateReplayKey(input: {
  ownerId: string;
  afterSeq: number;
  throughSeq: number;
  highWaterSeq: number;
  candidate: Pick<DistilledNoteCandidate, "key" | "evidenceSeqs">;
  consumer?: string;
}): string {
  const payload = JSON.stringify({
    consumer: input.consumer ?? DISTILLATION_CONSUMER,
    ownerId: input.ownerId,
    afterSeq: input.afterSeq,
    throughSeq: input.throughSeq,
    highWaterSeq: input.highWaterSeq,
    candidateKey: input.candidate.key,
    evidenceSeqs: [...input.candidate.evidenceSeqs].sort((left, right) => left - right),
  });
  return `distilled:${createHash("sha256").update(payload).digest("hex")}`;
}

function emptyOutcome(status: DistillationRunOutcome["status"]): DistillationRunOutcome {
  return {
    status,
    llmCalls: 0,
    batches: 0,
    written: 0,
    proposals: 0,
    crossLinks: 0,
    hasMore: false,
  };
}
