import { describe, expect, it } from "vitest";
import {
  logicalConversationKey,
  ownerIngressConversation,
  operatorOutboundConversation,
} from "../apps/daemon/src/conversation-ledger.js";
import type { TelegramMessageInbound } from "../packages/telegram/src/index.js";

describe("daemon logical conversation boundaries", () => {
  it("records one real owner batch with typed owner-only provenance", () => {
    const update = message({
      messageId: 11,
      messageIds: [10, 11],
      text: "первая строка\n\nвторая строка",
      ownText: "вторая строка",
      forwardedCount: 1,
      messageThreadId: 9,
    });
    expect(ownerIngressConversation({
      update,
      ingressJobId: "telegram-ingress:7:10,11",
      role: "owner",
      recordAcceptedBatch: true,
    })).toMatchObject({
      ownerId: "42",
      conversationKey: "7:42:9:0",
      text: "первая строка\n\nвторая строка",
      evidenceText: "вторая строка",
      sourceKey: "telegram-ingress:7:10,11",
      provenance: {
        ownText: "вторая строка",
        forwardedCount: 1,
        messageIds: [10, 11],
      },
    });

    expect(ownerIngressConversation({
      update: message({
        text: "пересланное утверждение третьего лица",
        ownText: "",
        forwardedCount: 1,
      }),
      ingressJobId: "telegram-ingress:7:12",
      role: "owner",
      recordAcceptedBatch: true,
    })).toMatchObject({
      text: "пересланное утверждение третьего лица",
      evidenceText: null,
    });
  });

  it("excludes internal remainders, edits, synthetic choices/apps/digests, and non-owner roles", () => {
    const ordinary = message();
    expect(ownerIngressConversation({
      update: ordinary,
      ingressJobId: "job",
      role: "owner",
      recordAcceptedBatch: false,
    })).toBeUndefined();
    expect(ownerIngressConversation({
      update: { ...ordinary, edited: true },
      ingressJobId: "job",
      role: "owner",
      recordAcceptedBatch: true,
    })).toBeUndefined();
    expect(ownerIngressConversation({
      update: { ...ordinary, synthetic: true },
      ingressJobId: "job",
      role: "owner",
      recordAcceptedBatch: true,
    })).toBeUndefined();
    expect(ownerIngressConversation({
      update: message({ text: "/status" }),
      ingressJobId: "job-command",
      role: "owner",
      recordAcceptedBatch: true,
    })).toBeUndefined();

    const mixedCommand = ownerIngressConversation({
      update: message({
        messageId: 13,
        messageIds: [10, 11, 13],
        text: "/status\n\nзапомни мой выбор\n\nпересланная справка",
        ownText: "/status\n\nзапомни мой выбор",
        forwardedCount: 1,
        parts: [
          { messageId: 10, text: "/status" },
          { messageId: 11, text: "запомни мой выбор" },
          { messageId: 13, text: "пересланная справка", forwarded: true },
        ],
      }),
      ingressJobId: "job-mixed-command",
      role: "owner",
      recordAcceptedBatch: true,
    });
    expect(mixedCommand?.text).not.toContain("/status");
    expect(mixedCommand).toMatchObject({ evidenceText: "запомни мой выбор" });
    expect(mixedCommand?.text).toContain("пересланная справка");
    for (const role of ["admin", "member", "viewer"] as const) {
      expect(ownerIngressConversation({
        update: ordinary,
        ingressJobId: "job",
        role,
        recordAcceptedBatch: true,
      })).toBeUndefined();
    }
  });

  it("marks only a real owner human turn as an outbound context row", () => {
    const update = message({ directMessagesTopicId: 33 });
    expect(operatorOutboundConversation({
      update,
      text: "готово",
      operatorTurnId: "opturn_1",
      turnOrigin: "human",
      role: "owner",
    })).toMatchObject({
      ownerId: "42",
      conversationKey: "7:42:0:33",
      text: "готово",
      operatorTurnId: "opturn_1",
      provenance: { turnOrigin: "human", source: "operator_final", memoryDerived: true },
    });

    for (const turnOrigin of ["digest", "app"] as const) {
      expect(operatorOutboundConversation({
        update,
        text: "same message type, wrong semantic origin",
        operatorTurnId: "opturn_1",
        turnOrigin,
        role: "owner",
      })).toBeUndefined();
    }
    expect(operatorOutboundConversation({
      update,
      text: "admin answer",
      operatorTurnId: "opturn_1",
      turnOrigin: "human",
      role: "admin",
    })).toBeUndefined();
  });

  it("keeps chat, actor and topic in the stable conversation key", () => {
    expect(logicalConversationKey({ chatId: 7, userId: 42 })).toBe("7:42:0:0");
    expect(logicalConversationKey({ chatId: 7, userId: 42, messageThreadId: 8 })).toBe("7:42:8:0");
    expect(logicalConversationKey({ chatId: 7, userId: 42, directMessagesTopicId: 9 })).toBe("7:42:0:9");
  });
});

function message(overrides: Partial<TelegramMessageInbound> = {}): TelegramMessageInbound {
  return {
    type: "message",
    updateId: 1,
    edited: false,
    chatId: 7,
    chatType: "private",
    userId: 42,
    messageId: 10,
    messageIds: [10],
    date: 1_777_000_000,
    text: "сообщение владельца",
    attachments: [],
    ...overrides,
  };
}
