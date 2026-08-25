import type { Logger } from "pino";

/**
 * Package 0.1: how long stop() waits for queues, the reliability loop and the
 * monitors before it gives up. Without a deadline a single wedged task keeps
 * the shutdown marker unwritten and the next boot falsely reports a crash.
 */
export const SHUTDOWN_DEADLINE_MS = 15_000;

/** One awaited stage of a graceful shutdown. */
export interface ShutdownStep {
  name: string;
  wait: () => Promise<unknown>;
}

/**
 * Package 0.1: runs the shutdown steps in order but under a single wall-clock
 * deadline, and reports the ones that never completed. A step that throws is
 * logged through `onStepError`, counted as unfinished and does not abort the
 * rest — shutdown must always reach the marker.
 */
export async function awaitShutdownSteps(
  steps: readonly ShutdownStep[],
  deadlineMs: number,
  onStepError?: (name: string, error: unknown) => void,
): Promise<string[]> {
  const unfinished = new Set(steps.map((step) => step.name));
  let expired = false;
  const sequence = (async () => {
    for (const step of steps) {
      if (expired) return;
      try {
        await step.wait();
      } catch (error) {
        onStepError?.(step.name, error);
        continue;
      }
      unfinished.delete(step.name);
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    // Deliberately not unref'd: an unref'd deadline would let Node exit with
    // code 0 the moment nothing else holds the loop, before shutdown reaches
    // the marker. clearTimeout below releases it either way.
    timer = setTimeout(() => {
      expired = true;
      resolve();
    }, deadlineMs);
  });
  await Promise.race([sequence, deadline]);
  clearTimeout(timer);
  return [...unfinished];
}

/**
 * Package 0.1: the boot-time provider guard. A runtime_state pointing at a
 * provider that is no longer wired up (codex remembered, then disabled) used to
 * throw out of initialize() and could only be fixed by editing the database by
 * hand. Fall back instead: the preferred alternative when it is available, else
 * whatever the runtime does offer.
 */
export function resolveStartupProvider(
  requested: string,
  available: readonly string[],
  fallback: string,
): string {
  if (available.length === 0 || available.includes(requested)) return requested;
  if (available.includes(fallback)) return fallback;
  return available[0]!;
}

/** Everything the signal handler needs; injected so exit paths stay testable. */
export interface ShutdownControllerHooks {
  stop: () => Promise<void>;
  /**
   * Records how this run ended. `false` writes the crashed marker, so the next
   * boot recovers interrupted work and tells the owner; only a stop() that
   * actually drained may claim a clean exit.
   */
  markShutdownOutcome: (clean: boolean) => void;
  logger: Pick<Logger, "info" | "warn" | "error">;
  exit: (code: number) => void;
}

/**
 * Package 0.1: SIGINT/SIGTERM. The first signal asks for a graceful stop; a
 * second one, arriving while the first is still draining, forces the exit
 * itself — registered through `process.on`, so Node's default handler (an
 * abrupt kill that leaves no marker) never takes over. Both forcing paths
 * abandon in-flight work, so both record an unclean end.
 */
export function createShutdownController(hooks: ShutdownControllerHooks): (signal: string) => void {
  let stopping = false;
  let forced = false;
  return (signal: string) => {
    if (stopping) {
      if (forced) return;
      forced = true;
      hooks.logger.warn({ signal }, "Second shutdown signal; forcing exit mid-drain");
      hooks.markShutdownOutcome(false);
      hooks.exit(0);
      return;
    }
    stopping = true;
    hooks.logger.info({ signal }, "Shutting down Operator");
    void hooks.stop().then(
      () => hooks.exit(0),
      (error: unknown) => {
        hooks.logger.error({ err: error, signal }, "Graceful shutdown failed; exiting anyway");
        hooks.markShutdownOutcome(false);
        hooks.exit(1);
      },
    );
  };
}

/** Everything the fatal-error handler needs; injected so exit paths stay testable. */
export interface FatalErrorHandlerHooks {
  markShutdownOutcome: (clean: boolean) => void;
  logger: Pick<Logger, "fatal">;
  exit: (code: number) => void;
}

/**
 * Package 0.1: `uncaughtException` / `unhandledRejection`. Previously absent, so
 * a stray rejection killed the daemon without a log line and without clearing
 * the shutdown marker. Every side effect is best-effort: the process must reach
 * a non-zero exit even if logging or the database is already broken.
 *
 * The logger's destination must stay synchronous (plain pino, no transport and
 * no `pino.destination({ sync: false })`): `exit` runs on the next line, and an
 * async destination would drop the fatal record on the floor — exactly the
 * silence this handler exists to remove.
 */
export function createFatalErrorHandler(
  hooks: FatalErrorHandlerHooks,
): (error: unknown, origin: string) => void {
  let handled = false;
  return (error: unknown, origin: string) => {
    if (handled) return;
    handled = true;
    try {
      hooks.logger.fatal({ err: error, origin }, "Operator daemon is exiting on a fatal error");
    } catch {
      // A broken logger must not swallow the exit.
    }
    try {
      hooks.markShutdownOutcome(false);
    } catch {
      // Best effort: the next boot simply loses the crash notice.
    }
    hooks.exit(1);
  };
}

export interface ProcessGuardOptions {
  stop: () => Promise<void>;
  markShutdownOutcome: (clean: boolean) => void;
  logger: Pick<Logger, "info" | "warn" | "error" | "fatal">;
  exit?: (code: number) => void;
}

/**
 * Package 0.1: the whole process-level wiring in one testable call — fatal
 * handlers first, then the signal handlers. `process.on` throughout: `once`
 * would hand the second signal back to Node's default kill.
 */
export function installProcessGuards(options: ProcessGuardOptions): void {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const onFatal = createFatalErrorHandler({
    logger: options.logger,
    markShutdownOutcome: options.markShutdownOutcome,
    exit,
  });
  process.on("uncaughtException", (error) => onFatal(error, "uncaughtException"));
  process.on("unhandledRejection", (reason) => onFatal(reason, "unhandledRejection"));

  const onSignal = createShutdownController({
    logger: options.logger,
    stop: options.stop,
    markShutdownOutcome: options.markShutdownOutcome,
    exit,
  });
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));
}
