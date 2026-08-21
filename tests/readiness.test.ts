import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("MVP readiness evidence matrix", () => {
  it("tracks all 18 distinct local readiness criteria as proved", () => {
    const path = resolve("docs/mvp-readiness.md");
    const document = readFileSync(path, "utf8");
    const rows = document.split("\n").filter((line) => /^\| \d+ \|/.test(line));
    expect(rows).toHaveLength(18);
    const numbers = rows.map((line) => Number(line.split("|")[1]?.trim()));
    expect(numbers).toEqual(Array.from({ length: 18 }, (_, index) => index + 1));
    expect(rows.every((line) => line.endsWith("| PROVED |"))).toBe(true);
    for (const referenced of [
      "apps/daemon/src/operator-daemon.ts",
      "packages/telegram/src/transport.ts",
      "packages/t3-broker/src/index.ts",
      "tests/daemon.integration.test.ts",
      "tests/operator-runtime.test.ts",
      "tests/operator-tools.test.ts",
      "tests/routing-quality.test.ts",
      "tests/telegram-transport.test.ts",
    ]) {
      expect(existsSync(resolve(referenced)), referenced).toBe(true);
    }
  });
});
