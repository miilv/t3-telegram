import { defineConfig } from "tsup";

export default defineConfig({
  entry: { main: "apps/daemon/src/main.ts" },
  format: ["esm"],
  platform: "node",
  target: "node24",
  // tsup v8 strips the `node:` prefix by default, which breaks `node:sqlite`.
  removeNodeProtocol: false,
  outDir: "dist",
  sourcemap: true,
  clean: true,
  outExtension: () => ({ js: ".mjs" }),
});
