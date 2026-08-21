import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactRegistry, sanitizeFilename } from "../packages/artifacts/src/index.js";
import { tempDirectory, tempStore } from "./helpers.js";

describe("ArtifactRegistry", () => {
  it("stores Telegram files safely and materializes real worker paths", async () => {
    const store = tempStore();
    const root = tempDirectory("artifact-root-");
    const project = tempDirectory("project-root-");
    const registry = new ArtifactRegistry(root, store);
    await registry.initialize();
    const artifact = await registry.ingestTelegram({
      bytes: new TextEncoder().encode("hello"),
      filename: "../../unsafe report.txt",
      mimeType: "text/plain",
      telegramFileId: "file_1",
      chatId: 1,
      messageId: 2,
    });
    expect(artifact.filename).toBe("unsafe-report.txt");
    expect(artifact.sha256).toHaveLength(64);
    const materialized = await registry.materializeForThread(artifact.id, project);
    expect(materialized.localPath).toContain(`${project}/.operator-inbox/`);
    store.close();
  });

  it("rejects outbound files outside allowed roots and secret-like names", async () => {
    const store = tempStore();
    const registry = new ArtifactRegistry(tempDirectory(), store);
    await registry.initialize();
    const allowed = tempDirectory("allowed-");
    const outside = join(tempDirectory("outside-"), "report.txt");
    writeFileSync(outside, "outside");
    await expect(registry.registerOutbound(outside, [allowed])).rejects.toThrow("outside allowed roots");
    const secret = join(allowed, ".env");
    writeFileSync(secret, "TOKEN=nope");
    await expect(registry.registerOutbound(secret, [allowed])).rejects.toThrow("Secret-like");
    store.close();
  });

  it("normalizes traversal-heavy filenames", () => {
    expect(sanitizeFilename("../../foo bar.ts")).toBe("foo-bar.ts");
  });

  it("removes only expired files managed by the artifact registry", async () => {
    const store = tempStore();
    const root = tempDirectory("artifact-cleanup-");
    const registry = new ArtifactRegistry(root, store);
    await registry.initialize();
    const artifact = await registry.ingestTelegram({
      bytes: new TextEncoder().encode("temporary"),
      filename: "temporary.txt",
      telegramFileId: "file_expired",
      chatId: 1,
      messageId: 3,
    });
    store.db
      .prepare("UPDATE artifacts SET expires_at=? WHERE id=?")
      .run("2020-01-01T00:00:00.000Z", artifact.id);
    expect(await registry.cleanupExpired("2021-01-01T00:00:00.000Z")).toBe(1);
    expect(existsSync(artifact.localPath)).toBe(false);
    expect(store.getArtifact(artifact.id)).toBeUndefined();

    const externalRoot = tempDirectory("artifact-external-");
    const externalPath = join(externalRoot, "worker-report.txt");
    writeFileSync(externalPath, "keep the worker-owned file");
    const external = await registry.registerOutbound(externalPath, [externalRoot]);
    store.db
      .prepare("UPDATE artifacts SET expires_at=? WHERE id=?")
      .run("2020-01-01T00:00:00.000Z", external.id);
    expect(await registry.cleanupExpired("2021-01-01T00:00:00.000Z")).toBe(1);
    expect(existsSync(externalPath)).toBe(true);
    expect(store.getArtifact(external.id)).toBeUndefined();
    store.close();
  });
});
