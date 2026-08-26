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
  private deadline: NodeJS.Timeout | undefined;
  private chain = Promise.resolve();
  private closed = false;
  private lastWriteFailed = false;

  constructor(
    private readonly transport: TelegramTransport,
    readonly draft: StreamDraft,
    private readonly debounceMs = 300,
    /**
     * Package 4.1, finding «латентность №2». A pure debounce never fires under
     * a continuous token stream: every delta pushed the 300 ms timer further
     * out, so the preview only moved on the 15 s heartbeat — in jumps, with the
     * chat frozen in between. The max-wait is a second, non-extendable timer:
     * the first append after a flush sets a hard deadline, later appends do not
     * touch it, so the preview advances at least this often no matter how dense
     * the stream is.
     */
    private readonly maxWaitMs = 800,
  ) {}

  append(text: string): void {
    if (this.closed) throw new Error("Cannot append to a finalized Telegram draft");
    this.buffer += text;
    this.arm();
  }

  replace(text: string): void {
    if (this.closed) throw new Error("Cannot replace a finalized Telegram draft");
    this.buffer = text;
    this.arm();
  }

  /**
   * Re-arm the quiet timer and — only if none is running — start the max-wait
   * deadline. The deadline is deliberately NOT rescheduled here: that is the
   * whole difference between "flushes when the stream pauses" and "flushes at
   * least every `maxWaitMs`".
   */
  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
    this.timer.unref?.();
    if (this.deadline) return;
    this.deadline = setTimeout(() => this.flush(), this.maxWaitMs);
    this.deadline.unref?.();
  }

  private disarm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.deadline) clearTimeout(this.deadline);
    this.deadline = undefined;
  }

  flush(): void {
    if (this.closed) return;
    this.disarm();
    const text = this.buffer;
    // Nothing streamed: pushing an empty preview would blank a placeholder the
    // heartbeat just wrote, and costs an API call for no content.
    if (!text) return;
    this.write(text);
  }

  /** Drop everything streamed so far and show a working placeholder. */
  reset(placeholder = "⏳"): void {
    if (this.closed) return;
    this.disarm();
    this.buffer = "";
    this.write(placeholder);
  }

  async finalize(fallbackText: string): Promise<SentMessage[]> {
    if (this.closed) throw new Error("Telegram draft was already finalized");
    this.flush();
    this.closed = true;
    this.disarm();
    await this.chain;
    return this.transport.finalizeDraft(this.draft, this.buffer || fallbackText);
  }

  /**
   * Re-send the current preview. Telegram drops a rich draft that stops being
   * updated, so a tool-heavy turn with no narration must still touch it.
   */
  refresh(placeholder: string): void {
    if (this.closed) return;
    this.write(this.buffer.trim() ? this.buffer : placeholder);
  }

  async closePreview(): Promise<void> {
    if (this.closed) return;
    this.flush();
    this.closed = true;
    this.disarm();
    await this.chain;
  }

  get text(): string {
    return this.buffer;
  }

  /**
   * Package 4.1, finding «латентность №1». Whether the last preview write
   * reached Telegram. The caller uses it to decide if the chat actually has a
   * live preview to look at, or whether it still owes the user a typing pulse:
   * a draft that Telegram refuses (destroyed slot, unsupported destination) is
   * invisible, and treating those writes as a sign of life left the chat silent
   * for the whole turn.
   */
  get healthy(): boolean {
    return !this.lastWriteFailed;
  }

  /**
   * Draft previews are best-effort. Never let a transient preview error prevent
   * the persistent final message from being attempted — but do remember it.
   */
  private write(text: string): void {
    this.chain = this.chain
      .then(() => this.transport.updateDraft(this.draft, text))
      .then(
        () => {
          this.lastWriteFailed = false;
        },
        () => {
          this.lastWriteFailed = true;
        },
      );
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
