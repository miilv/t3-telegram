import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperatorStore } from "../packages/storage/src/index.js";

export function tempDirectory(prefix = "operator-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function tempStore(): OperatorStore {
  const store = new OperatorStore(join(tempDirectory(), "operator.db"));
  store.migrate();
  return store;
}
