import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Logger } from "pino";

export interface TelegramAttachment {
  type: "photo" | "document";
  fileId: string;
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
}

export type TelegramInbound =
  | {
      type: "message";
      updateId: number;
      chatId: number;
      userId: number;
      messageId: number;
      messageThreadId?: number;
      replyToMessageId?: number;
      text: string;
      attachments: TelegramAttachment[];
    }
  | {
      type: "callback";
      updateId: number;
      callbackId: string;
      chatId: number;
      userId: number;
      messageId: number;
      data: string;
    };

export interface SentMessage {
  chatId: number;
  messageId: number;
}

export interface StreamDraft {
  mode: "rich-draft" | "draft" | "edit";
  chatId: number;
  draftId: number;
  messageId?: number;
  replyToMessageId?: number;
  text: string;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

interface RawMessage {
  message_id: number;
  message_thread_id?: number;
  chat: { id: number; type: string };
  from?: { id: number };
  text?: string;
  caption?: string;
  reply_to_message?: { message_id: number };
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  photo?: Array<{ file_id: string; file_size?: number; width: number; height: number }>;
}

interface RawUpdate {
  update_id: number;
  message?: RawMessage;
  callback_query?: {
    id: string;
    from: { id: number };
    data?: string;
    message?: RawMessage;
  };
}

export interface TelegramTransport {
  updates(signal?: AbortSignal): AsyncIterable<TelegramInbound>;
  sendRich(chatId: number, text: string, options?: { replyToMessageId?: number }): Promise<SentMessage[]>;
  startDraft(chatId: number, options?: { replyToMessageId?: number }): Promise<StreamDraft>;
  updateDraft(draft: StreamDraft, text: string): Promise<void>;
  finalizeDraft(draft: StreamDraft, text: string): Promise<SentMessage[]>;
  sendDocument(chatId: number, path: string, caption?: string): Promise<SentMessage>;
  sendPhoto(chatId: number, path: string, caption?: string): Promise<SentMessage>;
  sendApproval(
    chatId: number,
    text: string,
    approvalId: string,
    options?: { replyToMessageId?: number },
  ): Promise<SentMessage>;
  answerCallback(callbackId: string, text?: string): Promise<void>;
  downloadFile(fileId: string): Promise<Uint8Array>;
  react(chatId: number, messageId: number, emoji: string): Promise<void>;
  health(): Promise<{ healthy: boolean; username?: string; detail?: string }>;
}

export class TelegramBotTransport implements TelegramTransport {
  private offset = 0;
  private nextDraftId = 1;
  private richDraftAvailable: boolean | undefined;
  private draftAvailable: boolean | undefined;
  private richFinalAvailable: boolean | undefined;

  constructor(
    private readonly token: string,
    private readonly allowedUserId: number,
    private readonly pollTimeoutSeconds: number,
    private readonly logger: Logger,
    private readonly apiBase = "https://api.telegram.org",
  ) {}

  async *updates(signal?: AbortSignal): AsyncIterable<TelegramInbound> {
    while (!signal?.aborted) {
      try {
        const updates = await this.call<RawUpdate[]>("getUpdates", {
          offset: this.offset,
          timeout: this.pollTimeoutSeconds,
          allowed_updates: ["message", "callback_query"],
        }, signal);
        for (const update of updates) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          const inbound = this.normalizeUpdate(update);
          if (inbound) yield inbound;
        }
      } catch (error) {
        if (signal?.aborted) return;
        this.logger.error({ err: error }, "Telegram polling failed");
        await delay(1500, signal);
      }
    }
  }

  async sendRich(
    chatId: number,
    text: string,
    options: { replyToMessageId?: number } = {},
  ): Promise<SentMessage[]> {
    const chunks = splitRichText(text);
    const sent: SentMessage[] = [];
    for (const [index, chunk] of chunks.entries()) {
      const reply = index === 0 ? options.replyToMessageId : undefined;
      let result: RawMessage;
      try {
        if (this.richFinalAvailable === false) throw new Error("Rich final unavailable");
        result = await this.call<RawMessage>("sendRichMessage", {
          chat_id: chatId,
          text: chunk,
          ...(reply ? { reply_parameters: { message_id: reply } } : {}),
        });
        this.richFinalAvailable = true;
      } catch {
        this.richFinalAvailable = false;
        try {
          result = await this.call<RawMessage>("sendMessage", {
            chat_id: chatId,
            text: markdownToTelegramHtml(chunk),
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
            ...(reply ? { reply_parameters: { message_id: reply } } : {}),
          });
        } catch {
          result = await this.call<RawMessage>("sendMessage", {
            chat_id: chatId,
            text: chunk,
            ...(reply ? { reply_parameters: { message_id: reply } } : {}),
          });
        }
      }
      sent.push({ chatId, messageId: result.message_id });
    }
    return sent;
  }

  async startDraft(chatId: number, options: { replyToMessageId?: number } = {}): Promise<StreamDraft> {
    const draftId = this.nextDraftId++;
    const base: StreamDraft = {
      mode: "rich-draft",
      chatId,
      draftId,
      ...(options.replyToMessageId ? { replyToMessageId: options.replyToMessageId } : {}),
      text: "…",
    };
    if (this.richDraftAvailable !== false) {
      try {
        await this.call("sendRichMessageDraft", {
          chat_id: chatId,
          draft_id: draftId,
          text: "…",
          ...(options.replyToMessageId ? { reply_parameters: { message_id: options.replyToMessageId } } : {}),
        });
        this.richDraftAvailable = true;
        return base;
      } catch {
        this.richDraftAvailable = false;
      }
    }
    if (this.draftAvailable !== false) {
      try {
        await this.call("sendMessageDraft", { chat_id: chatId, draft_id: draftId, text: "…" });
        this.draftAvailable = true;
        return { ...base, mode: "draft" };
      } catch {
        this.draftAvailable = false;
      }
    }
    const message = await this.call<RawMessage>("sendMessage", {
      chat_id: chatId,
      text: "…",
      ...(options.replyToMessageId ? { reply_parameters: { message_id: options.replyToMessageId } } : {}),
    });
    return { ...base, mode: "edit", messageId: message.message_id };
  }

  async updateDraft(draft: StreamDraft, text: string): Promise<void> {
    const safeText = text.slice(0, 3800) || "…";
    draft.text = safeText;
    if (draft.mode === "rich-draft") {
      await this.call("sendRichMessageDraft", {
        chat_id: draft.chatId,
        draft_id: draft.draftId,
        text: safeText,
      });
      return;
    }
    if (draft.mode === "draft") {
      await this.call("sendMessageDraft", {
        chat_id: draft.chatId,
        draft_id: draft.draftId,
        text: safeText,
        parse_mode: "HTML",
      });
      return;
    }
    await this.call("editMessageText", {
      chat_id: draft.chatId,
      message_id: draft.messageId,
      text: safeText,
    });
  }

  async finalizeDraft(draft: StreamDraft, text: string): Promise<SentMessage[]> {
    if (draft.mode === "edit" && splitRichText(text).length === 1) {
      try {
        await this.call("editMessageText", {
          chat_id: draft.chatId,
          message_id: draft.messageId,
          text: markdownToTelegramHtml(text),
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        });
        return [{ chatId: draft.chatId, messageId: draft.messageId! }];
      } catch {
        // The normal rich/plain fallback below preserves the answer.
      }
    }
    return this.sendRich(draft.chatId, text, {
      ...(draft.replyToMessageId ? { replyToMessageId: draft.replyToMessageId } : {}),
    });
  }

  async sendDocument(chatId: number, path: string, caption?: string): Promise<SentMessage> {
    const result = await this.upload("sendDocument", chatId, "document", path, caption);
    return { chatId, messageId: result.message_id };
  }

  async sendPhoto(chatId: number, path: string, caption?: string): Promise<SentMessage> {
    const result = await this.upload("sendPhoto", chatId, "photo", path, caption);
    return { chatId, messageId: result.message_id };
  }

  async sendApproval(
    chatId: number,
    text: string,
    approvalId: string,
    options: { replyToMessageId?: number } = {},
  ): Promise<SentMessage> {
    const message = await this.call<RawMessage>("sendMessage", {
      chat_id: chatId,
      text: markdownToTelegramHtml(text),
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Allow once", callback_data: `approval:${approvalId}:accept` },
            { text: "Allow session", callback_data: `approval:${approvalId}:acceptForSession` },
          ],
          [{ text: "Deny", callback_data: `approval:${approvalId}:decline` }],
        ],
      },
      ...(options.replyToMessageId ? { reply_parameters: { message_id: options.replyToMessageId } } : {}),
    });
    return { chatId, messageId: message.message_id };
  }

  async answerCallback(callbackId: string, text?: string): Promise<void> {
    await this.call("answerCallbackQuery", { callback_query_id: callbackId, ...(text ? { text } : {}) });
  }

  async downloadFile(fileId: string): Promise<Uint8Array> {
    const file = await this.call<{ file_path?: string }>("getFile", { file_id: fileId });
    if (!file.file_path) throw new Error("Telegram did not return a file path");
    const response = await fetch(`${this.apiBase}/file/bot${this.token}/${file.file_path}`);
    if (!response.ok) throw new Error(`Telegram file download failed: ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async react(chatId: number, messageId: number, emoji: string): Promise<void> {
    await this.call("setMessageReaction", {
      chat_id: chatId,
      message_id: messageId,
      reaction: [{ type: "emoji", emoji }],
      is_big: false,
    });
  }

  async health(): Promise<{ healthy: boolean; username?: string; detail?: string }> {
    try {
      const me = await this.call<{ username?: string }>("getMe", {});
      return { healthy: true, ...(me.username ? { username: me.username } : {}) };
    } catch (error) {
      return { healthy: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  private normalizeUpdate(update: RawUpdate): TelegramInbound | undefined {
    if (update.callback_query?.message && update.callback_query.data) {
      if (update.callback_query.from.id !== this.allowedUserId) return undefined;
      return {
        type: "callback",
        updateId: update.update_id,
        callbackId: update.callback_query.id,
        chatId: update.callback_query.message.chat.id,
        userId: update.callback_query.from.id,
        messageId: update.callback_query.message.message_id,
        data: update.callback_query.data,
      };
    }
    const message = update.message;
    if (!message?.from || message.from.id !== this.allowedUserId || message.chat.type !== "private") return undefined;
    const attachments: TelegramAttachment[] = [];
    if (message.document) {
      attachments.push({
        type: "document",
        fileId: message.document.file_id,
        ...(message.document.file_name ? { filename: message.document.file_name } : {}),
        ...(message.document.mime_type ? { mimeType: message.document.mime_type } : {}),
        ...(message.document.file_size ? { sizeBytes: message.document.file_size } : {}),
      });
    }
    const photo = message.photo?.at(-1);
    if (photo) {
      attachments.push({
        type: "photo",
        fileId: photo.file_id,
        filename: `photo-${message.message_id}.jpg`,
        mimeType: "image/jpeg",
        ...(photo.file_size ? { sizeBytes: photo.file_size } : {}),
      });
    }
    return {
      type: "message",
      updateId: update.update_id,
      chatId: message.chat.id,
      userId: message.from.id,
      messageId: message.message_id,
      ...(message.message_thread_id ? { messageThreadId: message.message_thread_id } : {}),
      ...(message.reply_to_message?.message_id
        ? { replyToMessageId: message.reply_to_message.message_id }
        : {}),
      text: message.text ?? message.caption ?? "",
      attachments,
    };
  }

  private async upload(
    method: string,
    chatId: number,
    field: string,
    path: string,
    caption?: string,
  ): Promise<RawMessage> {
    const form = new FormData();
    form.set("chat_id", String(chatId));
    if (caption) form.set("caption", caption.slice(0, 900));
    const bytes = await readFile(path);
    form.set(field, new Blob([bytes]), basename(path));
    const response = await fetch(`${this.apiBase}/bot${this.token}/${method}`, { method: "POST", body: form });
    const payload = (await response.json()) as TelegramApiResponse<RawMessage>;
    if (!payload.ok || !payload.result) throw new Error(payload.description ?? `${method} failed`);
    return payload.result;
  }

  private async call<T>(method: string, body: unknown, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await fetch(`${this.apiBase}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
      const payload = (await response.json()) as TelegramApiResponse<T>;
      if (payload.ok && payload.result !== undefined) return payload.result;
      const retryAfter = payload.parameters?.retry_after;
      if ((response.status === 429 || response.status >= 500) && attempt < 3) {
        await delay((retryAfter ? retryAfter * 1000 : 400 * 2 ** attempt), signal);
        continue;
      }
      throw new Error(`Telegram ${method}: ${payload.description ?? response.statusText}`);
    }
    throw new Error(`Telegram ${method} exhausted retries`);
  }
}

export class DraftWriter {
  private buffer = "";
  private timer: NodeJS.Timeout | undefined;
  private chain = Promise.resolve();

  constructor(
    private readonly transport: TelegramTransport,
    readonly draft: StreamDraft,
    private readonly debounceMs = 350,
  ) {}

  append(text: string): void {
    this.buffer += text;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const text = this.buffer;
    this.chain = this.chain.then(() => this.transport.updateDraft(this.draft, text)).catch(() => undefined);
  }

  async finalize(fallbackText: string): Promise<SentMessage[]> {
    this.flush();
    await this.chain;
    return this.transport.finalizeDraft(this.draft, this.buffer || fallbackText);
  }

  get text(): string {
    return this.buffer;
  }
}

export function splitRichText(text: string, limit = 3800): string[] {
  if (text.length <= limit) return [text];
  const segments = tokenizeFencedBlocks(text);
  const chunks: string[] = [];
  let current = "";
  for (const segment of segments) {
    const separator = current && !current.endsWith("\n") && !segment.startsWith("\n") ? "\n\n" : "";
    if (current.length + separator.length + segment.length <= limit) {
      current += `${separator}${segment}`;
      continue;
    }
    if (current) chunks.push(current);
    current = "";
    if (segment.length <= limit) {
      current = segment;
      continue;
    }
    if (segment.trimStart().startsWith("```")) {
      chunks.push(...splitFencedBlock(segment.trim(), limit));
    } else {
      const plainChunks = splitPlainText(segment, limit);
      chunks.push(...plainChunks.slice(0, -1));
      current = plainChunks.at(-1) ?? "";
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function tokenizeFencedBlocks(text: string): string[] {
  const segments: string[] = [];
  const pattern = /```[^\n]*\n[\s\S]*?```/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index;
    if (index > cursor) segments.push(text.slice(cursor, index));
    segments.push(match[0]);
    cursor = index + match[0].length;
  }
  if (cursor < text.length) segments.push(text.slice(cursor));
  return segments.filter(Boolean);
}

function splitFencedBlock(block: string, limit: number): string[] {
  const firstNewline = block.indexOf("\n");
  const header = firstNewline >= 0 ? block.slice(0, firstNewline) : "```";
  const body = firstNewline >= 0 ? block.slice(firstNewline + 1, block.endsWith("```") ? -3 : undefined) : "";
  const allowance = Math.max(1, limit - header.length - 5);
  const pieces = splitPlainText(body, allowance);
  return pieces.map((piece) => `${header}\n${piece.trimEnd()}\n\`\`\``);
}

function splitPlainText(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit + 1);
    const newline = window.lastIndexOf("\n");
    const space = window.lastIndexOf(" ");
    const splitAt = Math.max(newline, space, 1);
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function markdownToTelegramHtml(markdown: string): string {
  const codeBlocks: string[] = [];
  let value = markdown.replace(/```(?:[\w+-]+)?\n?([\s\S]*?)```/g, (_match, code: string) => {
    const token = `@@CODEBLOCK${codeBlocks.length}@@`;
    codeBlocks.push(`<pre><code>${escapeHtml(code.trimEnd())}</code></pre>`);
    return token;
  });
  value = escapeHtml(value)
    .replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>")
    .replace(/^&gt;\s?(.+)$/gm, "<blockquote>$1</blockquote>")
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/__(.+?)__/g, "<b>$1</b>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  codeBlocks.forEach((block, index) => {
    value = value.replace(`@@CODEBLOCK${index}@@`, block);
  });
  return value;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}
