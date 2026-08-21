import type { Logger } from "pino";

export class DailyScheduler {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;

  constructor(
    private readonly task: () => Promise<void>,
    private readonly logger: Logger,
    private readonly intervalMs = 60_000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.trigger(), this.intervalMs);
    this.timer.unref();
  }

  trigger(): Promise<void> {
    if (this.running) return this.running;
    let execution: Promise<void>;
    try {
      execution = Promise.resolve(this.task()).catch((error) => {
        this.logger.error({ err: error }, "Scheduled maintenance failed");
      });
    } catch (error) {
      this.logger.error({ err: error }, "Scheduled maintenance failed");
      execution = Promise.resolve();
    }
    const tracked = execution.finally(() => {
      if (this.running === tracked) this.running = undefined;
    });
    this.running = tracked;
    return tracked;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async idle(): Promise<void> {
    await this.running;
  }
}
