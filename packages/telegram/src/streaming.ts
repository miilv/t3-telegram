import { renderStreamPhase } from "./rendering.js";
import { classifyTelegramDeliveryError } from "./transport.js";
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
  private lastWrittenText: string | undefined;
  private pendingText: string | undefined;
  private draining = false;

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
    await this.chain;
  }

  get text(): string {
    return this.buffer;
  }

  /**
   * Package 4.1, finding «латентность №1». Whether the last COMPLETED preview
   * write reached Telegram — a write still in flight does not change it, so
   * the answer is always about a frame the chat has actually been shown.
   *
   * The caller uses it to decide whether the chat really has a live preview to
   * look at, or whether it still owes the user a typing pulse: a draft Telegram
   * refuses (destroyed slot, unsupported destination) is invisible, and
   * treating those writes as a sign of life left the chat silent for whole
   * turns. Only a verdict Telegram will repeat counts — see `drain`.
   */
  get healthy(): boolean {
    return !this.lastWriteFailed;
  }

  private write(text: string): void {
    // Package 4.1 review, BLOCKER 2: the buffer is often unchanged since the
    // last edit — a heartbeat `refresh` between two tool calls re-sends it
    // verbatim — and Telegram answers such an edit with 400 "message is not
    // modified". Skipping it costs nothing and removes the whole error path.
    if (text === this.lastWrittenText) return;
    this.pendingText = text;
    if (this.draining) return;
    this.draining = true;
    this.chain = this.chain.then(() => this.drain());
  }

  /**
   * Package 4.1 review, BLOCKER 1 — backpressure.
   *
   * Every flush used to append a link to `chain` without ever asking whether
   * the previous `updateDraft` had returned. The timers fire on wall clock, so
   * against a slow transport the queue grew without bound — and `closePreview`
   * and `finalize`, which await that whole tail BEFORE the final answer may be
   * sent, paid for every edit the turn had ever queued (measured: 18.8 s to
   * close a 6 s stream at 3 s latency, against ~3 s before the max-wait
   * existed). The tail also held the per-chat lock the final answer needs, so
   * one flood wait mid-stream queued dozens of edits in front of the answer.
   *
   * Collapse instead: at most ONE update in flight and ONE pending text, always
   * the newest. Intermediate frames of a preview are worthless the moment a
   * newer one exists — showing the latest text is the entire purpose — so
   * dropping them costs nothing and bounds the close to a single round trip.
   */
  private async drain(): Promise<void> {
    try {
      while (this.pendingText !== undefined) {
        const text = this.pendingText;
        this.pendingText = undefined;
        // The queued text may have been written by the update that was in
        // flight when it was queued.
        if (text === this.lastWrittenText) continue;
        try {
          await this.transport.updateDraft(this.draft, text);
          this.lastWrittenText = text;
          this.lastWriteFailed = false;
        } catch (error) {
          // Draft previews are best-effort: a preview error must never stop the
          // persistent final message. But only a verdict Telegram will repeat
          // means the preview is GONE — a network blip, a 5xx or an ambiguous
          // transport error says nothing about what the chat currently shows,
          // and treating those as "no preview" would park a typing indicator
          // next to a live one for the rest of the turn (review finding 12).
          if (!classifyTelegramDeliveryError(error).retryable) this.lastWriteFailed = true;
        }
      }
    } finally {
      this.draining = false;
    }
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
