/**
 * Child entry point for the package 0.1 wiring test. It installs exactly the
 * guards main.ts installs, against a real process and a real store, then lets a
 * floating rejection escape. The parent asserts the exit code and the marker.
 *
 * Not a *.test.ts file on purpose: vitest must not collect it.
 */
import pino from "pino";
import { installProcessGuards } from "../../apps/daemon/src/lifecycle.js";
import { OperatorStore } from "../../packages/storage/src/index.js";

const databasePath = process.argv[2]!;
const store = new OperatorStore(databasePath);
store.migrate();
// Start from the state a running daemon leaves behind, so the assertion proves
// the handler cleared it rather than merely finding it absent.
store.setRuntimeState("clean_shutdown", "1");

installProcessGuards({
  logger: pino({ level: "silent" }),
  stop: async () => {},
  markShutdownOutcome: (clean) => {
    store.setRuntimeState("clean_shutdown", clean ? "1" : "");
  },
});

// The exact shape that used to kill the daemon without a trace.
void Promise.reject(new Error("stray rejection from a forgotten void"));

// Nothing else holds the loop; if the guard never fires this is what ends the
// run, and the parent sees exit 0 with the marker untouched.
setTimeout(() => process.exit(0), 5_000);
