import type { Logger } from "pino";

export class DailyScheduler {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly task: () => Promise<void>,
    private readonly logger: Logger,
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      const now = new Date();
      if (now.getHours() === 3) {
        void this.task().catch((error) => this.logger.error({ err: error }, "Daily maintenance failed"));
      }
    }, 60 * 60 * 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
