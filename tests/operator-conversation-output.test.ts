import { describe, expect, it } from "vitest";
import { TurnConversationOutputs } from "../packages/operator-tools/src/conversation-output.js";
import { tempStore } from "./helpers.js";

describe("direct Operator Telegram output ledger", () => {
  it("uses a replay-stable per-turn ordinal and never duplicates a delivered logical send", () => {
    const store = tempStore();
    try {
      const firstAttempt = outputs(store);
      const first = firstAttempt.begin("send_message", "проверяю деплой")!;
      expect(first).toMatchObject({ alreadyDelivered: false });
      firstAttempt.delivered(first.sourceKey);

      const second = firstAttempt.begin("reply", "деплой готов")!;
      expect(second.sourceKey).not.toBe(first.sourceKey);

      // A crash replay creates a new capability, so its ordinal restarts and
      // resolves to the already-delivered first logical action.
      const replay = outputs(store).begin("send_message", "проверяю деплой")!;
      expect(replay).toEqual({ sourceKey: first.sourceKey, alreadyDelivered: true });
      expect(store.conversation.listAll()).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  it("leaves a pre-send row pending and settles it explicitly after remote success", () => {
    const store = tempStore();
    try {
      const ledger = outputs(store);
      const pending = ledger.begin("ask_choices", "Как продолжить?")!;
      expect(store.conversation.getBySource("operator_tool", pending.sourceKey)?.deliveredAt)
        .toBeUndefined();
      ledger.delivered(pending.sourceKey);
      expect(store.conversation.getBySource("operator_tool", pending.sourceKey)?.deliveredAt)
        .toEqual(expect.any(String));
    } finally {
      store.close();
    }
  });

  it("refreshes an unresolved replay ordinal to the text that will actually be sent", () => {
    const store = tempStore();
    try {
      const first = outputs(store).begin("send_message", "первая формулировка")!;
      const replay = outputs(store).begin("send_message", "уточнённая формулировка")!;

      expect(replay).toMatchObject({ sourceKey: first.sourceKey, alreadyDelivered: false });
      expect(store.conversation.getBySource("operator_tool", first.sourceKey)?.text)
        .toBe("уточнённая формулировка");
      expect(store.conversation.listAll()).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("excludes non-owner and non-human capabilities", () => {
    const store = tempStore();
    try {
      expect(outputs(store, { role: "admin" }).begin("send_message", "admin output"))
        .toBeUndefined();
      expect(outputs(store, { turnOrigin: "app" }).begin("send_message", "app output"))
        .toBeUndefined();
      expect(store.conversation.listAll()).toEqual([]);
    } finally {
      store.close();
    }
  });
});

function outputs(
  store: ReturnType<typeof tempStore>,
  overrides: Partial<ConstructorParameters<typeof TurnConversationOutputs>[1]> = {},
): TurnConversationOutputs {
  return new TurnConversationOutputs(store, {
    turnSeed: "telegram-ingress:7:10",
    ownerId: "42",
    role: "owner",
    turnOrigin: "human",
    chatId: 7,
    operatorTurnId: "opturn_1",
    ...overrides,
  });
}
