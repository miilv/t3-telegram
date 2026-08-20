export class AsyncInputQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private ended = false;

  push(value: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.values.push(value);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ done: false, value });
        if (this.ended) return Promise.resolve({ done: true, value: undefined });
        return new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

/** Serializes effects per chat while maintaining a conservative global cadence. */
export class TelegramOutboundQueue {
  private readonly chatTails = new Map<number, Promise<void>>();
  private globalTail = Promise.resolve();
  private lastGlobalStart = 0;

  constructor(private readonly minimumGlobalIntervalMs = 35) {}

  run<T>(chatId: number, effect: () => Promise<T>): Promise<T> {
    const previousChat = this.chatTails.get(chatId) ?? Promise.resolve();
    let resolveTail!: () => void;
    const tail = new Promise<void>((resolve) => {
      resolveTail = resolve;
    });
    this.chatTails.set(chatId, tail);

    return previousChat
      .catch(() => undefined)
      .then(() => this.reserveGlobalSlot())
      .then(effect)
      .finally(() => {
        resolveTail();
        if (this.chatTails.get(chatId) === tail) this.chatTails.delete(chatId);
      });
  }

  private reserveGlobalSlot(): Promise<void> {
    const reservation = this.globalTail
      .catch(() => undefined)
      .then(async () => {
        const wait = Math.max(0, this.lastGlobalStart + this.minimumGlobalIntervalMs - Date.now());
        if (wait) await delay(wait);
        this.lastGlobalStart = Date.now();
      });
    this.globalTail = reservation;
    return reservation;
  }
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}
