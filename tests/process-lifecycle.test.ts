import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { OperatorStore } from "../packages/storage/src/index.js";
import {
  awaitShutdownSteps,
  createFatalErrorHandler,
  createShutdownController,
  resolveStartupProvider,
} from "../apps/daemon/src/lifecycle.js";

/** Minimal pino-shaped sink: records the level and the first (context) argument. */
function recordingLogger() {
  const lines: Array<{ level: string; context: Record<string, unknown>; message: string }> = [];
  const at = (level: string) => (context: unknown, message?: unknown) => {
    lines.push({
      level,
      context: (context ?? {}) as Record<string, unknown>,
      message: String(message ?? ""),
    });
  };
  return { lines, info: at("info"), warn: at("warn"), error: at("error"), fatal: at("fatal") };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("awaitShutdownSteps (package 0.1)", () => {
  it("runs the steps in order and reports nothing unfinished when they all settle", async () => {
    const order: string[] = [];
    const unfinished = await awaitShutdownSteps(
      [
        { name: "queue", wait: async () => void order.push("queue") },
        { name: "monitors", wait: async () => void order.push("monitors") },
      ],
      1_000,
    );
    expect(order).toEqual(["queue", "monitors"]);
    expect(unfinished).toEqual([]);
  });

  it("gives up on the deadline and names what never settled", async () => {
    const wedged = deferred();
    const started = Date.now();
    const unfinished = await awaitShutdownSteps(
      [
        { name: "queue", wait: async () => {} },
        { name: "reliabilityTask", wait: () => wedged.promise },
        { name: "monitors", wait: async () => {} },
      ],
      30,
    );
    // The wedged step and everything queued behind it are reported, and the
    // caller is released instead of hanging forever.
    expect(unfinished).toEqual(["reliabilityTask", "monitors"]);
    expect(Date.now() - started).toBeLessThan(2_000);
    wedged.resolve();
  });

  it("counts a throwing step as unfinished without aborting the rest", async () => {
    const failures: string[] = [];
    const reached: string[] = [];
    const unfinished = await awaitShutdownSteps(
      [
        { name: "dashboard", wait: async () => Promise.reject(new Error("port stuck")) },
        { name: "monitors", wait: async () => void reached.push("monitors") },
      ],
      1_000,
      (name, error) => failures.push(`${name}:${(error as Error).message}`),
    );
    expect(unfinished).toEqual(["dashboard"]);
    expect(reached).toEqual(["monitors"]);
    expect(failures).toEqual(["dashboard:port stuck"]);
  });
});

describe("resolveStartupProvider (package 0.1)", () => {
  it("keeps the remembered provider when it is still wired up", () => {
    expect(resolveStartupProvider("codex", ["claude", "codex"], "claude")).toBe("codex");
  });

  it("falls back to the configured default when the remembered one is gone", () => {
    expect(resolveStartupProvider("codex", ["claude"], "claude")).toBe("claude");
  });

  it("falls back to any available provider when the configured default is gone too", () => {
    expect(resolveStartupProvider("codex", ["claude"], "gemini")).toBe("claude");
  });

  it("leaves the request untouched when the runtime does not report providers", () => {
    expect(resolveStartupProvider("codex", [], "claude")).toBe("codex");
  });
});

describe("createShutdownController (package 0.1)", () => {
  it("stops gracefully on the first signal and exits zero", async () => {
    const logger = recordingLogger();
    const exits: number[] = [];
    const stopped = deferred();
    const outcomes: boolean[] = [];
    const onSignal = createShutdownController({
      logger,
      stop: () => stopped.promise,
      markShutdownOutcome: (clean) => outcomes.push(clean),
      exit: (code) => exits.push(code),
    });

    onSignal("SIGTERM");
    expect(exits).toEqual([]);
    stopped.resolve();
    await stopped.promise;
    await Promise.resolve();
    expect(exits).toEqual([0]);
    // stop() drained and wrote its own marker; the controller adds nothing.
    expect(outcomes).toEqual([]);
    expect(logger.lines[0]).toMatchObject({ level: "info", context: { signal: "SIGTERM" } });
  });

  it("forces the exit on a second signal instead of leaving Node to hard-kill", async () => {
    const logger = recordingLogger();
    const exits: number[] = [];
    const outcomes: boolean[] = [];
    const stopping = deferred();
    let stopCalls = 0;
    const onSignal = createShutdownController({
      logger,
      stop: () => {
        stopCalls += 1;
        return stopping.promise;
      },
      markShutdownOutcome: (clean) => outcomes.push(clean),
      exit: (code) => exits.push(code),
    });

    onSignal("SIGINT");
    onSignal("SIGINT");
    // Forcing abandons whatever was still draining, so the run is recorded as
    // unclean and the next boot recovers it instead of trusting a clean exit.
    expect(outcomes).toEqual([false]);
    expect(exits).toEqual([0]);
    expect(stopCalls).toBe(1);
    expect(logger.lines.some((line) => line.level === "warn")).toBe(true);

    // A third signal is inert: no second marker, no second exit.
    onSignal("SIGINT");
    expect(outcomes).toEqual([false]);
    expect(exits).toEqual([0]);
    stopping.resolve();
  });

  it("still writes the marker and exits when the graceful stop fails", async () => {
    const logger = recordingLogger();
    const exits: number[] = [];
    const outcomes: boolean[] = [];
    const onSignal = createShutdownController({
      logger,
      stop: () => Promise.reject(new Error("queue exploded")),
      markShutdownOutcome: (clean) => outcomes.push(clean),
      exit: (code) => exits.push(code),
    });

    onSignal("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 0));
    // A stop() that threw drained nothing it can vouch for: unclean.
    expect(outcomes).toEqual([false]);
    expect(exits).toEqual([1]);
    expect(logger.lines.some((line) => line.level === "error")).toBe(true);
  });
});

describe("createFatalErrorHandler (package 0.1)", () => {
  it("logs fatally, clears the graceful-exit marker and exits non-zero", () => {
    const logger = recordingLogger();
    const exits: number[] = [];
    let crashed = 0;
    const onFatal = createFatalErrorHandler({
      logger,
      markShutdownOutcome: () => (crashed += 1),
      exit: (code) => exits.push(code),
    });

    onFatal(new Error("stray rejection"), "unhandledRejection");
    expect(crashed).toBe(1);
    expect(exits).toEqual([1]);
    expect(logger.lines).toHaveLength(1);
    expect(logger.lines[0]).toMatchObject({
      level: "fatal",
      context: { origin: "unhandledRejection" },
    });
  });

  it("handles only the first fatal error", () => {
    const logger = recordingLogger();
    const exits: number[] = [];
    const onFatal = createFatalErrorHandler({
      logger,
      markShutdownOutcome: () => {},
      exit: (code) => exits.push(code),
    });

    onFatal(new Error("first"), "uncaughtException");
    onFatal(new Error("second"), "uncaughtException");
    expect(exits).toEqual([1]);
    expect(logger.lines).toHaveLength(1);
  });

  it("exits even when logging and the marker write both fail", () => {
    const exits: number[] = [];
    const onFatal = createFatalErrorHandler({
      logger: {
        fatal: () => {
          throw new Error("logger closed");
        },
      } as never,
      markShutdownOutcome: () => {
        throw new Error("database closed");
      },
      exit: (code) => exits.push(code),
    });

    onFatal(new Error("boom"), "uncaughtException");
    expect(exits).toEqual([1]);
  });
});

describe("installProcessGuards wiring (package 0.1)", () => {
  it("turns a floating rejection into a non-zero exit and a crashed marker", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const child = join(here, "fixtures", "floating-rejection-child.ts");
    const databasePath = join(mkdtempSync(join(tmpdir(), "lifecycle-child-")), "operator.db");

    const result = await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", child, databasePath],
      { cwd: join(here, ".."), timeout: 20_000 },
    ).then(
      () => ({ code: 0 }),
      (error: { code?: number }) => ({ code: error.code ?? -1 }),
    );

    expect(result.code).toBe(1);

    // The discriminating assertion: Node's own default also exits 1, but it
    // exits before anything can clear the marker, leaving "1" behind.
    const store = new OperatorStore(databasePath);
    expect(store.getRuntimeState("clean_shutdown")).toBe("");
    store.close();
  }, 30_000);
});
