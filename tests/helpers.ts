import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";
import { OperatorStore } from "../packages/storage/src/index.js";

/**
 * A scratch directory for one test.
 *
 * Package 1.5: it is REMOVED when the test finishes. The suite creates a home,
 * an artifact tree and a SQLite database per test, and nothing used to clean
 * them up — a full run left gigabytes behind, and a machine whose /tmp filled
 * up produced a suite that failed in a dozen unrelated places at once.
 * `onTestFinished` throws outside a test body, which is why the registration is
 * guarded rather than assumed.
 */
export function tempDirectory(prefix = "operator-test-"): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  registerCleanup(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

export function tempStore(): OperatorStore {
  const directory = tempDirectory();
  const store = new OperatorStore(join(directory, "operator.db"));
  store.migrate();
  // Closing releases the file handles (a daemon test that ends with stop()
  // closes it itself; closing twice is harmless).
  registerCleanup(() => {
    try {
      store.close();
    } catch {
      // Already closed by the daemon's own shutdown.
    }
  });
  return store;
}

function registerCleanup(cleanup: () => void): void {
  try {
    onTestFinished(() => {
      try {
        cleanup();
      } catch {
        // Best effort: a leftover temp file must never fail a green test.
      }
    });
  } catch {
    // Called outside a test body (module scope in a fixture): nothing to hook.
  }
}
