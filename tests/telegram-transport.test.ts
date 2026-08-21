import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mergeTelegramAlbum,
  normalizeTelegramUpdate,
  TelegramBotTransport,
} from "../packages/telegram/src/index.js";
import type { TelegramMessageInbound } from "../packages/telegram/src/index.js";

const logger = pino({ level: "silent" });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("grammY Telegram transport", () => {
  it("uses the Bot API 10.x rich_message argument and reply/topic parameters", async () => {
    const calls: ApiCall[] = [];
    vi.stubGlobal("fetch", successfulTelegramFetch(calls));
    const transport = new TelegramBotTransport("test-token", 42, 1, logger);

    const sent = await transport.sendRich(7, "# Result\n\n**Done**", {
      replyToMessageId: 11,
      messageThreadId: 22,
    });

    expect(sent).toEqual([{ chatId: 7, messageId: 100, messageThreadId: 22 }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("sendRichMessage");
    expect(calls[0]?.body).toMatchObject({
      chat_id: 7,
      rich_message: { markdown: "# Result\n\n**Done**" },
      message_thread_id: 22,
      reply_parameters: { message_id: 11 },
    });
    expect(calls[0]?.body).not.toHaveProperty("text");
  });

  it("streams with a stable non-zero rich draft id and persists a rich final", async () => {
    const calls: ApiCall[] = [];
    vi.stubGlobal("fetch", successfulTelegramFetch(calls));
    const transport = new TelegramBotTransport("test-token", 42, 1, logger);

    const draft = await transport.startDraft(7, { replyToMessageId: 11 });
    await transport.updateDraft(draft, "partial");
    await transport.finalizeDraft(draft, "complete");

    expect(draft.mode).toBe("rich-draft");
    expect(draft.draftId).toBeGreaterThan(0);
    expect(calls.map((call) => call.method)).toEqual([
      "sendRichMessageDraft",
      "sendRichMessageDraft",
      "sendRichMessage",
    ]);
    expect(calls[0]?.body).toMatchObject({
      draft_id: draft.draftId,
      rich_message: { markdown: "…" },
    });
    expect(calls[1]?.body).toMatchObject({
      draft_id: draft.draftId,
      rich_message: { markdown: "partial" },
    });
    expect(calls[2]?.body).toMatchObject({
      rich_message: { markdown: "complete" },
      reply_parameters: { message_id: 11 },
    });
  });

  it("falls back for a rejected rich payload but not for an ambiguous network failure", async () => {
    const rejectedCalls: ApiCall[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const call = parseApiCall(input, init);
        rejectedCalls.push(call);
        if (call.method === "sendRichMessage") {
          return telegramResponse(
            { ok: false, error_code: 400, description: "Bad Request: can't parse rich message" },
            400,
          );
        }
        return telegramResponse(messageResult(101));
      }),
    );
    const transport = new TelegramBotTransport("test-token", 42, 1, logger);
    await expect(transport.sendRich(7, "broken <details>")).resolves.toEqual([
      { chatId: 7, messageId: 101 },
    ]);
    expect(rejectedCalls.map((call) => call.method)).toEqual(["sendRichMessage", "sendMessage"]);

    const ambiguousCalls: ApiCall[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        ambiguousCalls.push(parseApiCall(input, init));
        throw new TypeError("connection reset after upload");
      }),
    );
    const ambiguous = new TelegramBotTransport("test-token", 42, 1, logger);
    await expect(ambiguous.sendRich(7, "do not duplicate")).rejects.toThrow();
    expect(ambiguousCalls.map((call) => call.method)).toEqual(["sendRichMessage"]);
  });

  it("renders persistent structured user-input buttons and clears them after submission", async () => {
    const calls: ApiCall[] = [];
    vi.stubGlobal("fetch", successfulTelegramFetch(calls));
    const transport = new TelegramBotTransport("test-token", 42, 1, logger);

    const sent = await transport.sendUserInput(
      7,
      "**Choose regions**",
      "input_123",
      0,
      [{ label: "EU" }, { label: "US" }],
      true,
      { replyToMessageId: 11, messageThreadId: 22 },
    );
    await transport.editUserInput(
      7,
      sent.messageId,
      "**Choose regions**",
      "input_123",
      0,
      [{ label: "EU", selected: true }, { label: "US" }],
      true,
    );
    await transport.clearInlineKeyboard(7, sent.messageId);

    expect(calls.map((call) => call.method)).toEqual([
      "sendMessage",
      "editMessageText",
      "editMessageReplyMarkup",
    ]);
    expect(calls[0]?.body).toMatchObject({
      chat_id: 7,
      message_thread_id: 22,
      reply_parameters: { message_id: 11 },
      reply_markup: {
        inline_keyboard: [
          [{ text: "EU", callback_data: "ui:input_123:0:o0" }],
          [{ text: "US", callback_data: "ui:input_123:0:o1" }],
          [{ text: "Write another answer", callback_data: "ui:input_123:0:c" }],
          [{ text: "Submit selected", callback_data: "ui:input_123:0:s" }],
        ],
      },
    });
    expect(
      ((calls[1]?.body.reply_markup as { inline_keyboard: unknown[][] }).inline_keyboard[0] as unknown[])[0],
    ).toEqual({ text: "✓ EU", callback_data: "ui:input_123:0:o0" });
    expect(calls[2]?.body).toMatchObject({ reply_markup: { inline_keyboard: [] } });
  });
});

describe("Telegram inbound normalization", () => {
  it("preserves voice, reply, forward and forum-topic context", () => {
    const inbound = normalizeTelegramUpdate(
      {
        update_id: 9,
        message: {
          message_id: 50,
          message_thread_id: 77,
          chat: { id: -100, type: "supergroup", title: "Work" },
          from: { id: 42, first_name: "M", username: "miilg" },
          date: 1_700_000_000,
          voice: {
            file_id: "voice-file",
            file_unique_id: "voice-unique",
            file_size: 1234,
            mime_type: "audio/ogg",
            duration: 8,
          },
          forward_origin: {
            type: "channel",
            date: 1_699_999_000,
            chat: { id: -200, type: "channel", title: "News", username: "news" },
            message_id: 3,
          },
          reply_to_message: {
            message_id: 49,
            chat: { id: -100, type: "supergroup", title: "Work" },
            from: { id: 7, first_name: "Bot", username: "operator" },
            date: 1_699_999_999,
            text: "Earlier answer",
          },
        },
      } as never,
      42,
    );

    expect(inbound).toMatchObject({
      type: "message",
      chatId: -100,
      chatType: "supergroup",
      messageThreadId: 77,
      replyToMessageId: 49,
      reply: { messageId: 49, text: "Earlier answer" },
      forwardOrigin: { type: "channel", chatId: -200, messageId: 3 },
      attachments: [
        {
          type: "voice",
          fileId: "voice-file",
          fileUniqueId: "voice-unique",
          mimeType: "audio/ogg",
          sizeBytes: 1234,
          durationSeconds: 8,
        },
      ],
    });
  });

  it("normalizes reaction changes and topic service messages", () => {
    const reaction = normalizeTelegramUpdate(
      {
        update_id: 10,
        message_reaction: {
          chat: { id: 7, type: "private" },
          message_id: 20,
          user: { id: 42, first_name: "M" },
          date: 100,
          old_reaction: [{ type: "emoji", emoji: "👍" }],
          new_reaction: [{ type: "emoji", emoji: "🔥" }],
        },
      } as never,
      42,
    );
    expect(reaction).toMatchObject({ type: "reaction", added: ["🔥"], removed: ["👍"] });

    const topic = normalizeTelegramUpdate(
      {
        update_id: 11,
        message: {
          message_id: 21,
          message_thread_id: 88,
          chat: { id: -100, type: "supergroup", title: "Work" },
          from: { id: 42, first_name: "M" },
          date: 101,
          forum_topic_created: { name: "Backend", icon_color: 123 },
        },
      } as never,
      42,
    );
    expect(topic).toMatchObject({
      type: "topic",
      action: "created",
      messageThreadId: 88,
      name: "Backend",
    });
  });

  it("merges an album into one ordered envelope", () => {
    const base: TelegramMessageInbound = {
      type: "message",
      updateId: 1,
      edited: false,
      chatId: 7,
      chatType: "private",
      userId: 42,
      messageId: 2,
      messageIds: [2],
      date: 100,
      mediaGroupId: "album",
      text: "",
      attachments: [{ type: "photo", fileId: "b" }],
    };
    const merged = mergeTelegramAlbum([
      base,
      {
        ...base,
        updateId: 2,
        messageId: 1,
        messageIds: [1],
        text: "caption",
        attachments: [{ type: "photo", fileId: "a" }],
      },
    ]);
    expect(merged.messageId).toBe(2);
    expect(merged.messageIds).toEqual([1, 2]);
    expect(merged.text).toBe("caption");
    expect(merged.attachments.map((attachment) => attachment.fileId)).toEqual(["a", "b"]);
  });
});

interface ApiCall {
  method: string;
  body: Record<string, unknown>;
}

function successfulTelegramFetch(calls: ApiCall[]) {
  let id = 100;
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call = parseApiCall(input, init);
    calls.push(call);
    if (call.method === "sendRichMessageDraft" || call.method === "sendMessageDraft") {
      return telegramResponse({ ok: true, result: true });
    }
    return telegramResponse(messageResult(id++));
  });
}

function parseApiCall(input: string | URL | Request, init?: RequestInit): ApiCall {
  const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
  const method = url.split("/").at(-1)!;
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  return { method, body };
}

function messageResult(messageId: number) {
  return {
    ok: true,
    result: {
      message_id: messageId,
      date: 1_700_000_000,
      chat: { id: 7, type: "private", first_name: "M" },
      rich_message: { blocks: [] },
    },
  };
}

function telegramResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
