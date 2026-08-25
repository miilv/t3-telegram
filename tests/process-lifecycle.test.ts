import { describe, expect, it } from "vitest";
import {
  awaitShutdownSteps,
  createFatalErrorHandler,
  createShutdownController,
} from "../apps/daemon/src/operator-daemon.js";

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

describe("createShutdownController (package 0.1)", () => {
  it("stops gracefully on the first signal and exits zero", async () => {
    const logger = recordingLogger();
    const exits: number[] = [];
    const stopped = deferred();
    const markers: string[] = [];
    const onSignal = createShutdownController({
      logger,
      stop: () => stopped.promise,
      markCleanShutdown: () => markers.push("clean"),
      exit: (code) => exits.push(code),
    });

    onSignal("SIGTERM");
    expect(exits).toEqual([]);
    stopped.resolve();
    await stopped.promise;
    await Promise.resolve();
    expect(exits).toEqual([0]);
    // stop() wrote the marker itself, so the controller does not duplicate it.
    expect(markers).toEqual([]);
    expect(logger.lines[0]).toMatchObject({ level: "info", context: { signal: "SIGTERM" } });
  });

  it("forces the exit on a second signal instead of leaving Node to hard-kill", async () => {
    const logger = recordingLogger();
    const exits: number[] = [];
    const markers: string[] = [];
    const stopping = deferred();
    let stopCalls = 0;
    const onSignal = createShutdownController({
      logger,
      stop: () => {
        stopCalls += 1;
        return stopping.promise;
      },
      markCleanShutdown: () => markers.push("clean"),
      exit: (code) => exits.push(code),
    });

    onSignal("SIGINT");
    onSignal("SIGINT");
    // The forced path writes the marker itself, because stop() will never reach it.
    expect(markers).toEqual(["clean"]);
    expect(exits).toEqual([0]);
    expect(stopCalls).toBe(1);
    expect(logger.lines.some((line) => line.level === "warn")).toBe(true);

    // A third signal is inert: no second marker, no second exit.
    onSignal("SIGINT");
    expect(markers).toEqual(["clean"]);
    expect(exits).toEqual([0]);
    stopping.resolve();
  });

  it("still writes the marker and exits when the graceful stop fails", async () => {
    const logger = recordingLogger();
    const exits: number[] = [];
    const markers: string[] = [];
    const onSignal = createShutdownController({
      logger,
      stop: () => Promise.reject(new Error("queue exploded")),
      markCleanShutdown: () => markers.push("clean"),
      exit: (code) => exits.push(code),
    });

    onSignal("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(markers).toEqual(["clean"]);
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
      markCrashed: () => (crashed += 1),
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
      markCrashed: () => {},
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
      markCrashed: () => {
        throw new Error("database closed");
      },
      exit: (code) => exits.push(code),
    });

    onFatal(new Error("boom"), "uncaughtException");
    expect(exits).toEqual([1]);
  });
});
