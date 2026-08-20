import { renderStreamPhase } from "./rendering.js";
import type {
  SentMessage,
  StreamDraft,
  StreamPhase,
  TelegramSendOptions,
  TelegramTransport,
} from "./types.js";

/** Debounced, serialized writer for one Telegram draft slot. */
export class DraftWriter {
  private buffer = "";
  private timer: NodeJS.Timeout | undefined;
  private chain = Promise.resolve();
  private closed = false;

  constructor(
    private readonly transport: TelegramTransport,
    readonly draft: StreamDraft,
    private readonly debounceMs = 300,
  ) {}

  append(text: string): void {
    if (this.closed) throw new Error("Cannot append to a finalized Telegram draft");
    this.buffer += text;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
  }

  replace(text: string): void {
    if (this.closed) throw new Error("Cannot replace a finalized Telegram draft");
    this.buffer = text;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
  }

  flush(): void {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const text = this.buffer;
    // Draft previews are best-effort. Never let a transient preview error prevent
    // the persistent final message from being attempted.
    this.chain = this.chain
      .then(() => this.transport.updateDraft(this.draft, text))
      .catch(() => undefined);
  }

  async finalize(fallbackText: string): Promise<SentMessage[]> {
    if (this.closed) throw new Error("Telegram draft was already finalized");
    this.flush();
    this.closed = true;
    await this.chain;
    return this.transport.finalizeDraft(this.draft, this.buffer || fallbackText);
  }

  get text(): string {
    return this.buffer;
  }
}

/**
 * Multi-phase stream coordinator. Each transition persists the previous phase
 * and allocates a fresh non-zero draft id, matching Telegram's animation model.
 */
export class RichStreamSession {
  private writer: DraftWriter | undefined;
  private phase: StreamPhase | undefined;
  private transition = Promise.resolve();
  private finished = false;

  constructor(
    private readonly transport: TelegramTransport,
    private readonly chatId: number,
    private readonly options: TelegramSendOptions = {},
  ) {}

  append(phase: StreamPhase, delta: string): Promise<void> {
    if (this.finished) return Promise.reject(new Error("Telegram stream is already finalized"));
    this.transition = this.transition.then(async () => {
      if (!this.writer || this.phase !== phase) await this.switchPhase(phase);
      this.writer!.append(delta);
    });
    return this.transition;
  }

  async finalize(finalText: string): Promise<SentMessage[]> {
    if (this.finished) throw new Error("Telegram stream is already finalized");
    this.finished = true;
    await this.transition;
    if (this.writer && this.phase === "text") return this.writer.finalize(finalText);
    if (this.writer && this.writer.text) {
      await this.writer.finalize(renderStreamPhase(this.phase!, this.writer.text));
    }
    return this.transport.sendRich(this.chatId, finalText, this.options);
  }

  private async switchPhase(next: StreamPhase): Promise<void> {
    if (this.writer && this.writer.text) {
      await this.writer.finalize(renderStreamPhase(this.phase!, this.writer.text));
    }
    const draft = await this.transport.startDraft(this.chatId, { ...this.options, phase: next });
    this.writer = new DraftWriter(this.transport, draft);
    this.phase = next;
  }
}
