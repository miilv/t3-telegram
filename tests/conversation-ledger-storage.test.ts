import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OperatorStore } from "../packages/storage/src/index.js";
import { tempDirectory, tempStore } from "./helpers.js";

describe("logical conversation ledger storage", () => {
  it("creates a durable coverage marker and monotonic cursor on a fresh database", () => {
    const store = tempStore();
    try {
      const coverage = store.conversation.coverageStartedAt();
      expect(Date.parse(coverage)).not.toBeNaN();
      expect(store.conversation.cursor("distiller", "42")).toBe(0);

      // A cursor may never leap over sequence values that future delivered
      // rows will receive.
      expect(store.conversation.advanceCursor("distiller", "42", 0, 12)).toBe(false);
      const ready = store.conversation.appendOwnerIngress({
        ownerId: "42",
        conversationKey: "7:42:0:0",
        text: "first ready row",
        evidenceText: "first ready row",
        sourceKey: "telegram-ingress:7:1",
        ingressJobId: "telegram-ingress:7:1",
      });
      expect(store.conversation.advanceCursor("distiller", "42", 0, ready.seq!)).toBe(true);
      expect(store.conversation.advanceCursor("distiller", "42", 0, 4)).toBe(false);
      expect(store.conversation.cursor("distiller", "42")).toBe(ready.seq);
    } finally {
      store.close();
    }
  });

  it("partitions cursor compare-and-swap and high-water validation by owner", () => {
    const store = tempStore();
    try {
      const ownerA = store.conversation.appendOwnerIngress({
        ownerId: "owner-a",
        conversationKey: "7:owner-a:0:0",
        text: "owner A first",
        evidenceText: "owner A first",
        sourceKey: "owner-a-1",
        ingressJobId: "owner-a-1",
      });
      const ownerB = store.conversation.appendOwnerIngress({
        ownerId: "owner-b",
        conversationKey: "7:owner-b:0:0",
        text: "owner B first",
        evidenceText: "owner B first",
        sourceKey: "owner-b-1",
        ingressJobId: "owner-b-1",
      });

      expect(ownerB.seq).toBeGreaterThan(ownerA.seq!);
      expect(store.conversation.cursor("distiller", "owner-a")).toBe(0);
      expect(store.conversation.cursor("distiller", "owner-b")).toBe(0);
      // B's interleaved global sequence is not a valid A high-water.
      expect(store.conversation.advanceCursor("distiller", "owner-a", 0, ownerB.seq!)).toBe(false);
      expect(store.conversation.selectBatch({ ownerId: "owner-a", afterSeq: 0 }).entries)
        .toMatchObject([{ seq: ownerA.seq, text: "owner A first" }]);
      expect(store.conversation.selectBatch({ ownerId: "owner-b", afterSeq: 0 }).entries)
        .toMatchObject([{ seq: ownerB.seq, text: "owner B first" }]);
      expect(store.conversation.advanceCursor("distiller", "owner-a", 0, ownerA.seq!)).toBe(true);
      expect(store.conversation.cursor("distiller", "owner-a")).toBe(ownerA.seq);
      expect(store.conversation.cursor("distiller", "owner-b")).toBe(0);

      const ownerANext = store.conversation.appendOwnerIngress({
        ownerId: "owner-a",
        conversationKey: "7:owner-a:0:0",
        text: "owner A second",
        evidenceText: "owner A second",
        sourceKey: "owner-a-2",
        ingressJobId: "owner-a-2",
      });
      const ownerAPage = store.conversation.selectBatch({
        ownerId: "owner-a",
        afterSeq: store.conversation.cursor("distiller", "owner-a"),
      });
      expect(ownerAPage.entries).toMatchObject([{ seq: ownerANext.seq, text: "owner A second" }]);
      expect(store.conversation.advanceCursor(
        "distiller",
        "owner-a",
        ownerA.seq!,
        ownerAPage.throughSeq,
      )).toBe(true);
      expect(store.conversation.advanceCursor("distiller", "owner-b", 0, ownerB.seq!)).toBe(true);
      expect(store.conversation.cursor("distiller", "owner-b")).toBe(ownerB.seq);
    } finally {
      store.close();
    }
  });

  it("migrates a legacy global cursor into bounded owner partitions idempotently", () => {
    const path = join(tempDirectory("conversation-ledger-cursor-migration-"), "operator.db");
    let store = new OperatorStore(path);
    store.migrate();
    const ownerA = store.conversation.appendOwnerIngress({
      ownerId: "owner-a",
      conversationKey: "7:owner-a:0:0",
      text: "owner A first",
      evidenceText: "owner A first",
      sourceKey: "migration-owner-a",
      ingressJobId: "migration-owner-a",
    });
    const ownerB = store.conversation.appendOwnerIngress({
      ownerId: "owner-b",
      conversationKey: "7:owner-b:0:0",
      text: "owner B first",
      evidenceText: "owner B first",
      sourceKey: "migration-owner-b",
      ingressJobId: "migration-owner-b",
    });
    store.db.exec(`
      DROP TABLE conversation_ledger_cursors;
      CREATE TABLE conversation_ledger_cursors (
        consumer TEXT PRIMARY KEY,
        last_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
        updated_at TEXT NOT NULL
      );
    `);
    store.db.prepare(`
      INSERT INTO conversation_ledger_cursors(consumer,last_seq,updated_at)
      VALUES ('distiller',?,'2026-08-26T00:00:00.000Z')
    `).run(ownerB.seq!);
    store.close();

    store = new OperatorStore(path);
    store.migrate();
    expect(store.conversation.cursor("distiller", "owner-a")).toBe(ownerA.seq);
    expect(store.conversation.cursor("distiller", "owner-b")).toBe(ownerB.seq);
    expect((store.db.prepare("PRAGMA table_info(conversation_ledger_cursors)").all() as Array<{
      name: string;
    }>).map((column) => column.name)).toContain("owner_id");
    store.close();

    store = new OperatorStore(path);
    store.migrate();
    expect(store.conversation.cursor("distiller", "owner-a")).toBe(ownerA.seq);
    expect(store.conversation.cursor("distiller", "owner-b")).toBe(ownerB.seq);
    store.close();
  });

  it("rejects contradictory actor/evidence provenance at the schema boundary", () => {
    const store = tempStore();
    try {
      expect(() => store.db.prepare(`
        INSERT INTO conversation_ledger(
          owner_id,conversation_key,direction,actor,text,source_kind,source_key,
          ingress_job_id,operator_turn_id,evidence_role,provenance_json,delivered_at,created_at
        ) VALUES ('42','7:42:0:0','outbound','operator','invented owner fact',
          'unknown','bad-source',NULL,'turn_bad','owner_assertion','{}','2026-08-26','2026-08-26')
      `).run()).toThrow();
      expect(store.conversation.listAll()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("commits an owner ingress row atomically with its deduplicated background job", () => {
    const store = tempStore();
    try {
      const jobId = store.enqueueOwnerConversationIngressJob(
        { update: { text: "Даня теперь отвечает за склад" } },
        {
          ownerId: "42",
          conversationKey: "7:42:0:0",
          text: "Даня теперь отвечает за склад",
          evidenceText: "Даня теперь отвечает за склад",
          sourceKey: "telegram-ingress:7:10",
          ingressJobId: "telegram-ingress:7:10",
          provenance: { ownText: "Даня теперь отвечает за склад" },
        },
        { id: "telegram-ingress:7:10", dedupeKey: "telegram-ingress:7:10" },
      );
      expect(jobId).toBe("telegram-ingress:7:10");

      // Re-delivery of the same Telegram update is one job and one logical turn.
      store.enqueueOwnerConversationIngressJob(
        { update: { text: "Даня теперь отвечает за склад" } },
        {
          ownerId: "42",
          conversationKey: "7:42:0:0",
          text: "Даня теперь отвечает за склад",
          evidenceText: "Даня теперь отвечает за склад",
          sourceKey: "telegram-ingress:7:10",
          ingressJobId: "telegram-ingress:7:10",
        },
        { id: "telegram-ingress:7:10", dedupeKey: "telegram-ingress:7:10" },
      );

      expect(store.listBackgroundJobs("telegram_ingress")).toHaveLength(1);
      const rows = store.conversation.selectBatch({ ownerId: "42", afterSeq: 0, limit: 10 });
      expect(rows.entries).toHaveLength(1);
      expect(rows.entries[0]).toMatchObject({
        direction: "inbound",
        actor: "owner",
        evidenceRole: "owner_assertion",
        deliveredAt: expect.any(String),
        sourceKind: "telegram_ingress",
        sourceKey: "telegram-ingress:7:10",
      });
    } finally {
      store.close();
    }
  });

  it("rolls the background job back when the ledger insert fails", () => {
    const store = tempStore();
    try {
      store.db.exec(`
        CREATE TRIGGER fail_conversation_insert
        BEFORE INSERT ON conversation_ledger
        BEGIN SELECT RAISE(ABORT, 'ledger unavailable'); END;
      `);

      expect(() => store.enqueueOwnerConversationIngressJob(
        { update: { text: "never half commit" } },
        {
          ownerId: "42",
          conversationKey: "7:42:0:0",
          text: "never half commit",
          evidenceText: "never half commit",
          sourceKey: "telegram-ingress:7:11",
          ingressJobId: "telegram-ingress:7:11",
        },
        { id: "telegram-ingress:7:11", dedupeKey: "telegram-ingress:7:11" },
      )).toThrow(/ledger unavailable/u);

      expect(store.getBackgroundJob("telegram-ingress:7:11")).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("rolls the outbox insert back when its pending logical row cannot commit", () => {
    const store = tempStore();
    try {
      store.db.exec(`
        CREATE TRIGGER fail_outbound_conversation_insert
        BEFORE INSERT ON conversation_ledger
        WHEN NEW.source_kind='telegram_outbox'
        BEGIN SELECT RAISE(ABORT, 'outbound ledger unavailable'); END;
      `);
      expect(() => store.enqueueTelegramOutbox({
        dedupeKey: "telegram:operator:turn_crash:final",
        chatId: 7,
        operation: "rich",
        payload: { text: "never half enqueue" },
        conversation: {
          ownerId: "42",
          conversationKey: "7:42:0:0",
          text: "never half enqueue",
          operatorTurnId: "turn_crash",
        },
      })).toThrow(/outbound ledger unavailable/u);
      expect(store.getTelegramOutbox("telegram:operator:turn_crash:final")).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("stores one pending logical outbound per outbox dedupe key and exposes it only after delivery", () => {
    const store = tempStore();
    try {
      const first = store.enqueueTelegramOutbox({
        dedupeKey: "telegram:operator:turn_1:final",
        chatId: 7,
        operation: "rich",
        payload: { text: "Да, за склад теперь отвечает Даня." },
        conversation: {
          ownerId: "42",
          conversationKey: "7:42:0:0",
          text: "Да, за склад теперь отвечает Даня.",
          operatorTurnId: "turn_1",
          provenance: { turnOrigin: "human", memoryContext: "full" },
        },
      });
      store.enqueueTelegramOutbox({
        dedupeKey: "telegram:operator:turn_1:final",
        chatId: 7,
        operation: "rich",
        payload: { text: "Да, за склад теперь отвечает Даня." },
        conversation: {
          ownerId: "42",
          conversationKey: "7:42:0:0",
          text: "Да, за склад теперь отвечает Даня.",
          operatorTurnId: "turn_1",
        },
      });

      expect(store.conversation.countEligibleAfter("42", 0)).toBe(0);
      expect(store.conversation.listAll()).toHaveLength(1);
      expect(store.conversation.listAll()[0]).toMatchObject({
        direction: "outbound",
        actor: "operator",
        evidenceRole: "context_only",
        sourceKind: "telegram_outbox",
        sourceKey: "telegram:operator:turn_1:final",
      });
      expect(store.conversation.listAll()[0]?.deliveredAt).toBeUndefined();

      expect(store.claimNextTelegramOutbox()?.id).toBe(first.id);
      store.retryTelegramOutbox(first.id, "TELEGRAM_UNAVAILABLE", "definite pre-send failure", 0);
      store.db.prepare("UPDATE telegram_outbox SET next_attempt_at=? WHERE id=?")
        .run("2020-01-01", first.id);
      expect(store.claimNextTelegramOutbox()?.id).toBe(first.id);
      expect(store.conversation.listAll()).toHaveLength(1);

      store.db.exec(`
        CREATE TRIGGER fail_conversation_settlement
        BEFORE UPDATE OF delivered_at ON conversation_ledger
        BEGIN SELECT RAISE(ABORT, 'ledger settlement unavailable'); END;
      `);
      expect(() => store.markTelegramOutboxDelivered(first.id, [100, 101, 102]))
        .toThrow(/ledger settlement unavailable/u);
      expect(store.getTelegramOutbox(first.id)?.status).toBe("sending");
      expect(store.conversation.getBySource(
        "telegram_outbox",
        "telegram:operator:turn_1:final",
      )?.deliveredAt).toBeUndefined();
      store.db.exec("DROP TRIGGER fail_conversation_settlement");

      store.markTelegramOutboxDelivered(first.id, [100, 101, 102]);
      expect(store.conversation.countEligibleAfter("42", 0)).toBe(1);
      expect(store.conversation.selectBatch({ ownerId: "42", afterSeq: 0, limit: 10 }).entries)
        .toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("keeps a revived dead outbox's pending source text aligned with what is delivered", () => {
    const store = tempStore();
    try {
      const first = store.enqueueTelegramOutbox({
        dedupeKey: "telegram:operator:turn_revived:final",
        chatId: 7,
        operation: "rich",
        payload: { text: "первая попытка" },
        conversation: {
          ownerId: "42",
          conversationKey: "7:42:0:0",
          text: "первая попытка",
          operatorTurnId: "turn_revived",
        },
      });
      store.markTelegramOutboxFailed(first.id, "dead", "TELEGRAM_BAD_REQUEST", "rejected");

      const revived = store.enqueueTelegramOutbox({
        dedupeKey: "telegram:operator:turn_revived:final",
        chatId: 7,
        operation: "rich",
        payload: { text: "исправленная повторная попытка" },
        conversation: {
          ownerId: "42",
          conversationKey: "7:42:0:0",
          text: "исправленная повторная попытка",
          operatorTurnId: "turn_revived",
        },
      });
      store.markTelegramOutboxDelivered(revived.id, [300]);

      expect(store.conversation.selectBatch({ ownerId: "42", afterSeq: 0 }).entries)
        .toMatchObject([{ text: "исправленная повторная попытка" }]);
      expect(store.conversation.listAll()).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("bounds a batch by row and character limits without skipping its tail", () => {
    const store = tempStore();
    try {
      for (let index = 1; index <= 4; index += 1) {
        store.conversation.appendOwnerIngress({
          ownerId: "42",
          conversationKey: "7:42:0:0",
          text: `message-${index}`,
          evidenceText: `message-${index}`,
          sourceKey: `ingress-${index}`,
          ingressJobId: `ingress-${index}`,
        });
      }

      const first = store.conversation.selectBatch({ ownerId: "42", afterSeq: 0, limit: 2 });
      expect(first.entries.map((entry) => entry.text)).toEqual(["message-1", "message-2"]);
      expect(first.hasMore).toBe(true);
      expect(first.throughSeq).toBe(first.entries[1]!.seq);

      store.conversation.appendOwnerIngress({
        ownerId: "42",
        conversationKey: "7:42:0:0",
        text: "message-5",
        evidenceText: "message-5",
        sourceKey: "ingress-5",
        ingressJobId: "ingress-5",
      });

      const second = store.conversation.selectBatch({
        ownerId: "42",
        afterSeq: first.throughSeq,
        throughSeq: first.highWaterSeq,
        limit: 10,
        characterLimit: 10,
      });
      expect(second.entries.map((entry) => entry.text)).toEqual(["message-3"]);
      expect(second.hasMore).toBe(true);
      expect(second.highWaterSeq).toBe(first.highWaterSeq);

      const third = store.conversation.selectBatch({
        ownerId: "42",
        afterSeq: second.throughSeq,
        throughSeq: first.highWaterSeq,
      });
      expect(third.entries.map((entry) => entry.text)).toEqual(["message-4"]);
      expect(third.hasMore).toBe(false);

      const nextCycle = store.conversation.selectBatch({
        ownerId: "42",
        afterSeq: third.throughSeq,
      });
      expect(nextCycle.entries.map((entry) => entry.text)).toEqual(["message-5"]);
    } finally {
      store.close();
    }
  });

  it("pages later ready input without losing an outbound settled after restart", () => {
    const path = join(tempDirectory("conversation-ledger-restart-"), "operator.db");
    let store = new OperatorStore(path);
    store.migrate();
    try {
      const pending = store.enqueueTelegramOutbox({
        dedupeKey: "telegram:operator:turn_pending:final",
        chatId: 7,
        operation: "rich",
        payload: { text: "сначала этот ответ" },
        conversation: {
          ownerId: "42",
          conversationKey: "7:42:0:0",
          text: "сначала этот ответ",
          operatorTurnId: "turn_pending",
        },
      });
      store.conversation.appendOwnerIngress({
        ownerId: "42",
        conversationKey: "7:42:0:0",
        text: "потом новый вопрос",
        evidenceText: "потом новый вопрос",
        sourceKey: "telegram-ingress:7:20",
        ingressJobId: "telegram-ingress:7:20",
      });

      const beforeRestart = store.conversation.selectBatch({ ownerId: "42", afterSeq: 0 });
      expect(beforeRestart.entries.map((entry) => entry.text)).toEqual(["потом новый вопрос"]);
      expect(store.conversation.advanceCursor(
        "distiller",
        "42",
        0,
        beforeRestart.throughSeq,
      )).toBe(true);

      store.close();
      store = new OperatorStore(path);
      store.migrate();
      store.markTelegramOutboxDelivered(pending.id, [200, 201]);

      const replay = store.conversation.selectBatch({
        ownerId: "42",
        afterSeq: beforeRestart.throughSeq,
      });
      expect(replay.entries.map((entry) => entry.text)).toEqual(["сначала этот ответ"]);
      expect(store.conversation.advanceCursor(
        "distiller",
        "42",
        beforeRestart.throughSeq,
        replay.throughSeq,
      )).toBe(true);
    } finally {
      store.close();
    }
  });
});
