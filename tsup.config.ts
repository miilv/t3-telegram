import { defineConfig } from "tsup";

export default defineConfig({
  entry: { main: "apps/daemon/src/main.ts" },
  format: ["esm"],
  platform: "node",
  target: "node24",
  outDir: "dist",
  sourcemap: true,
  clean: true,
  outExtension: () => ({ js: ".mjs" }),
});
