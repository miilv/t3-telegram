import { describe, expect, it } from "vitest";
import * as scribe from "../apps/daemon/src/scribe.js";
import { operatorNoteInputHash } from "../packages/storage/src/index.js";
import {
  MINILM_NOTE_EMBEDDING_MODEL,
  NOTE_EMBEDDING_DIMENSIONS,
} from "../packages/storage/src/note-embeddings.js";
import { OperatorNoteWriter } from "../packages/storage/src/operator-note-writer.js";
import { tempStore } from "./helpers.js";

function candidateResponse(input: {
  key: string;
  content: string;
  evidenceSeq: number;
  description?: string;
}): string {
  return JSON.stringify([{
    key: input.key,
    description: input.description ?? `when ${input.key} matters → read the owner fact`,
    content: input.content,
    category: "people",
    evidenceSeqs: [input.evidenceSeq],
    validUntil: null,
  }]);
}

function unit(first: number, second = Math.sqrt(1 - first * first)): number[] {
  return [first, second, ...new Array(NOTE_EMBEDDING_DIMENSIONS - 2).fill(0)];
}

describe("ledger-driven conversation distillation", () => {
  it("treats NOTHING as one successful call and advances the independent owner cursor", async () => {
    const store = tempStore();
    const row = store.conversation.appendOwnerIngress({
      ownerId: "42",
      conversationKey: "7:42:0:0",
      text: "hello without a durable fact",
      evidenceText: "hello without a durable fact",
      sourceKey: "ingress:nothing:1",
      ingressJobId: "ingress:nothing:1",
    });
    const Coordinator = (scribe as Record<string, unknown>).ConversationDistillationCoordinator;
    expect(typeof Coordinator).toBe("function");
    const prompts: string[] = [];
    const coordinator = new (Coordinator as new (deps: unknown) => {
      run(ownerId: string): Promise<Record<string, unknown>>;
    })({
      store,
      oneShot: async (prompt: string) => {
        prompts.push(prompt);
        return "NOTHING";
      },
    });

    await expect(coordinator.run("42")).resolves.toMatchObject({
      status: "completed",
      llmCalls: 1,
      batches: 1,
      written: 0,
      proposals: 0,
      hasMore: false,
    });
    expect(prompts).toHaveLength(1);
    expect(store.conversation.cursor("night-scribe-distillation", "42")).toBe(row.seq);
    store.close();
  });

  it("writes an accepted candidate once through Notes v2 with durable evidence provenance", async () => {
    const store = tempStore();
    const row = store.conversation.appendOwnerIngress({
      ownerId: "42",
      conversationKey: "7:42:0:0",
      text: "Даня отвечает за склад",
      evidenceText: "Даня отвечает за склад",
      sourceKey: "ingress:fact:1",
      ingressJobId: "ingress:fact:1",
    });
    const response = JSON.stringify([{
      key: "warehouse-owner",
      description: "when warehouse ownership matters → read the owner fact",
      content: "Даня отвечает за склад",
      category: "people",
      evidenceSeqs: [row.seq],
      validUntil: null,
    }]);
    const coordinator = new scribe.ConversationDistillationCoordinator({
      store,
      oneShot: async () => response,
    });

    await expect(coordinator.run("42")).resolves.toMatchObject({
      status: "completed",
      llmCalls: 1,
      written: 1,
      proposals: 0,
    });
    const note = store.notes.getActive("warehouse-owner")!;
    expect(note).toMatchObject({ source: "distilled", content: "Даня отвечает за склад" });
    expect(note.verifiedAt).toBeUndefined();
    expect(store.notes.evidenceForVersion(note.id)).toEqual({ ownerId: "42", sequences: [row.seq] });

    // Re-open only the consumer position to model a crash after the note write
    // but before cursor settlement. The stable operation must return the same version.
    store.db.prepare(`
      UPDATE conversation_ledger_cursors SET last_seq=0
      WHERE consumer='night-scribe-distillation' AND owner_id='42'
    `).run();
    const appended = store.conversation.appendOwnerIngress({
      ownerId: "42",
      conversationKey: "7:42:0:0",
      text: "This arrived after the durable note but before cursor recovery",
      evidenceText: "This arrived after the durable note but before cursor recovery",
      sourceKey: "ingress:fact:after-crash",
      ingressJobId: "ingress:fact:after-crash",
    });
    await expect(coordinator.run("42")).resolves.toMatchObject({ status: "completed" });
    expect(store.notes.listVersions()).toHaveLength(1);
    expect(store.notes.getActive("warehouse-owner")?.id).toBe(note.id);
    expect(store.distillationProposals.listPending()).toEqual([]);
    expect(store.conversation.cursor("night-scribe-distillation", "42")).toBe(appended.seq);
    expect(store.db.prepare("SELECT COUNT(*) AS count FROM operator_note_evidence").get())
      .toMatchObject({ count: 1 });
    store.close();
  });

  it("drains at most three 64,000-code-point pages and leaves bounded backlog visible", async () => {
    const store = tempStore();
    const rows = Array.from({ length: 4 }, (_, index) => store.conversation.appendOwnerIngress({
      ownerId: "42",
      conversationKey: "7:42:0:0",
      text: String(index).repeat(64_000),
      evidenceText: String(index).repeat(64_000),
      sourceKey: `ingress:bounded:${index}`,
      ingressJobId: `ingress:bounded:${index}`,
    }));
    let calls = 0;
    const coordinator = new scribe.ConversationDistillationCoordinator({
      store,
      oneShot: async () => {
        calls += 1;
        return "NOTHING";
      },
    });

    await expect(coordinator.run("42")).resolves.toMatchObject({
      status: "completed",
      llmCalls: 3,
      batches: 3,
      hasMore: true,
    });
    expect(calls).toBe(3);
    expect(store.conversation.cursor("night-scribe-distillation", "42")).toBe(rows[2]!.seq);
    expect(store.conversation.countEligibleAfter("42", rows[2]!.seq!)).toBe(1);
    store.close();
  });

  it("projects a 64,001-code-point first row explicitly and still settles its evidence", async () => {
    const store = tempStore();
    const sourceText = `${"x".repeat(64_000)}Z`;
    const row = store.conversation.appendOwnerIngress({
      ownerId: "42",
      conversationKey: "7:42:0:0",
      text: sourceText,
      evidenceText: sourceText,
      sourceKey: "ingress:oversized:1",
      ingressJobId: "ingress:oversized:1",
    });
    let prompt = "";
    const coordinator = new scribe.ConversationDistillationCoordinator({
      store,
      oneShot: async (value) => {
        prompt = value;
        return candidateResponse({
          key: "oversized-owner-fact",
          content: "The owner supplied an oversized durable fact",
          evidenceSeq: row.seq!,
        });
      },
    });

    await expect(coordinator.run("42")).resolves.toMatchObject({
      status: "completed",
      llmCalls: 1,
      written: 1,
    });
    expect(prompt).toContain('"truncated":true');
    expect(prompt).toContain("TRUNCATED: oversized ledger text omitted");
    expect(store.conversation.getBySource("telegram_ingress", "ingress:oversized:1")?.text)
      .toBe(sourceText);
    const note = store.notes.getActive("oversized-owner-fact")!;
    expect(store.notes.evidenceForVersion(note.id)).toEqual({ ownerId: "42", sequences: [row.seq] });
    expect(store.conversation.cursor("night-scribe-distillation", "42")).toBe(row.seq);
    store.close();
  });

  it("replays one durable proposal after a crash before cursor CAS", async () => {
    const store = tempStore();
    store.notes.writeVersion({
      key: "warehouse-owner",
      description: "when warehouse ownership matters → read the curated fact",
      content: "Dan owns the warehouse",
      category: "people",
      source: "manual",
      operationKey: "seed:curated",
    });
    const row = store.conversation.appendOwnerIngress({
      ownerId: "42",
      conversationKey: "7:42:0:0",
      text: "Ira now owns the warehouse",
      evidenceText: "Ira now owns the warehouse",
      sourceKey: "ingress:proposal:1",
      ingressJobId: "ingress:proposal:1",
    });
    const coordinator = new scribe.ConversationDistillationCoordinator({
      store,
      oneShot: async () => candidateResponse({
        key: "warehouse-owner",
        content: "Ira owns the warehouse",
        evidenceSeq: row.seq!,
      }),
    });
    const advance = store.conversation.advanceCursor.bind(store.conversation);
    store.conversation.advanceCursor = () => {
      throw new Error("simulated crash before cursor CAS");
    };

    await expect(coordinator.run("42")).rejects.toThrow("simulated crash");
    expect(store.distillationProposals.listPending()).toHaveLength(1);
    expect(store.conversation.cursor("night-scribe-distillation", "42")).toBe(0);

    const appended = store.conversation.appendOwnerIngress({
      ownerId: "42",
      conversationKey: "7:42:0:0",
      text: "New context appended while the cursor was unsettled",
      evidenceText: "New context appended while the cursor was unsettled",
      sourceKey: "ingress:proposal:after-crash",
      ingressJobId: "ingress:proposal:after-crash",
    });
    store.conversation.advanceCursor = advance;
    await expect(coordinator.run("42")).resolves.toMatchObject({
      status: "completed",
      proposals: 1,
    });
    expect(store.distillationProposals.listPending()).toHaveLength(1);
    expect(store.notes.getActive("warehouse-owner")?.content).toBe("Dan owns the warehouse");
    expect(store.conversation.cursor("night-scribe-distillation", "42")).toBe(appended.seq);
    store.close();
  });

  it("keeps durable outcomes when cursor CAS loses a race", async () => {
    const store = tempStore();
    const row = store.conversation.appendOwnerIngress({
      ownerId: "42",
      conversationKey: "7:42:0:0",
      text: "Dan owns the warehouse",
      evidenceText: "Dan owns the warehouse",
      sourceKey: "ingress:race:1",
      ingressJobId: "ingress:race:1",
    });
    const coordinator = new scribe.ConversationDistillationCoordinator({
      store,
      oneShot: async () => candidateResponse({
        key: "warehouse-owner",
        content: "Dan owns the warehouse",
        evidenceSeq: row.seq!,
      }),
    });
    const advance = store.conversation.advanceCursor.bind(store.conversation);
    store.conversation.advanceCursor = (consumer, ownerId, expected, through) => {
      expect(advance(consumer, ownerId, expected, through)).toBe(true);
      return false;
    };

    await expect(coordinator.run("42")).resolves.toMatchObject({
      status: "raced",
      llmCalls: 1,
      written: 1,
    });
    expect(store.notes.getActive("warehouse-owner")?.source).toBe("distilled");
    expect(store.conversation.cursor("night-scribe-distillation", "42")).toBe(row.seq);
    store.close();
  });

  it("reports partial provider failure as degraded and leaves only the failed page pending", async () => {
    const store = tempStore();
    const rows = [0, 1].map((index) => store.conversation.appendOwnerIngress({
      ownerId: "42",
      conversationKey: "7:42:0:0",
      text: String(index).repeat(64_000),
      evidenceText: String(index).repeat(64_000),
      sourceKey: `ingress:partial:${index}`,
      ingressJobId: `ingress:partial:${index}`,
    }));
    let calls = 0;
    const coordinator = new scribe.ConversationDistillationCoordinator({
      store,
      oneShot: async () => {
        calls += 1;
        if (calls === 2) throw new Error("provider unavailable");
        return "NOTHING";
      },
    });

    await expect(coordinator.run("42")).resolves.toMatchObject({
      status: "degraded",
      llmCalls: 1,
      batches: 1,
      providerUnavailable: true,
      hasMore: true,
    });
    expect(store.conversation.cursor("night-scribe-distillation", "42")).toBe(rows[0]!.seq);
    expect(store.conversation.countEligibleAfter("42", rows[0]!.seq!)).toBe(1);
    store.close();
  });

  it("counts a completed invalid response while leaving its page unadvanced", async () => {
    const store = tempStore();
    store.conversation.appendOwnerIngress({
      ownerId: "42",
      conversationKey: "7:42:0:0",
      text: "Dan owns the warehouse",
      evidenceText: "Dan owns the warehouse",
      sourceKey: "ingress:invalid-response:1",
      ingressJobId: "ingress:invalid-response:1",
    });
    const coordinator = new scribe.ConversationDistillationCoordinator({
      store,
      oneShot: async () => "```json\n[]\n```",
    });

    await expect(coordinator.run("42")).resolves.toMatchObject({
      status: "failed",
      llmCalls: 1,
      batches: 0,
      hasMore: true,
    });
    expect(store.conversation.cursor("night-scribe-distillation", "42")).toBe(0);
    store.close();
  });

  it("persists MiniLM semantic proposals while reporting 0.70 cross-links without merging", async () => {
    const store = tempStore();
    const seed = {
      key: "warehouse-owner",
      category: "people",
      description: "when warehouse ownership matters → read the curated fact",
      content: "Dan owns the warehouse",
    };
    store.notes.writeVersion({
      ...seed,
      source: "manual",
      operationKey: "seed:minilm",
      vectors: [{
        model: MINILM_NOTE_EMBEDDING_MODEL,
        dimensions: NOTE_EMBEDDING_DIMENSIONS,
        inputHash: operatorNoteInputHash(seed),
        values: unit(1, 0),
      }],
    });
    const rows = ["Ira is the warehouse contact", "Lee handles warehouse invoices"].map(
      (text, index) => store.conversation.appendOwnerIngress({
        ownerId: "42",
        conversationKey: "7:42:0:0",
        text,
        evidenceText: text,
        sourceKey: `ingress:minilm:${index}`,
        ingressJobId: `ingress:minilm:${index}`,
      }),
    );
    const writer = new OperatorNoteWriter(store.notes, {
      isSemanticDedupeAvailable: () => true,
      embed: async (input) => ({
        model: MINILM_NOTE_EMBEDDING_MODEL,
        dimensions: NOTE_EMBEDDING_DIMENSIONS,
        inputHash: operatorNoteInputHash(input),
        values: unit(input.key === "sk-abcdefghijklmnop" ? 0.90 : 0.75),
      }),
    });
    Object.defineProperty(store, "noteWriter", { value: writer });
    const coordinator = new scribe.ConversationDistillationCoordinator({
      store,
      oneShot: async () => JSON.stringify([
        {
          key: "sk-abcdefghijklmnop",
          description: "when warehouse contact matters → read the owner fact",
          content: "Ira is the warehouse contact",
          category: "people",
          evidenceSeqs: [rows[0]!.seq],
          validUntil: null,
        },
        {
          key: "warehouse-invoices",
          description: "when warehouse invoices matter → read the owner fact",
          content: "Lee handles warehouse invoices",
          category: "people",
          evidenceSeqs: [rows[1]!.seq],
          validUntil: null,
        },
      ]),
    });

    await expect(coordinator.run("42")).resolves.toMatchObject({
      status: "completed",
      proposals: 1,
      written: 1,
      crossLinks: 1,
    });
    expect(store.distillationProposals.listPending()).toMatchObject([{
      candidateKey: "sk-abcdefghijklmnop",
      matchingNote: { key: "warehouse-owner" },
      reason: "semantic",
    }]);
    expect(store.notes.getActive("sk-abcdefghijklmnop")).toBeUndefined();
    expect(store.notes.getActive("warehouse-invoices")?.content).toBe("Lee handles warehouse invoices");
    store.close();
  });
});
