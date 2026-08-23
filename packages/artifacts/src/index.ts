import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { chmod, copyFile, mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import type { Artifact, ArtifactRef } from "../../shared/src/index.js";
import { newId, nowIso } from "../../shared/src/index.js";
import type { OperatorStore } from "../../storage/src/index.js";

const MAX_INBOUND_BYTES = 50 * 1024 * 1024;
const MAX_OUTBOUND_BYTES = 50 * 1024 * 1024;
const INBOUND_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const secretPattern = /(^|[._-])(env|secret|token|credential|id_rsa|id_ed25519)([._-]|$)/i;

export interface SafeFileMetadata {
  localPath: string;
  filename: string;
  sizeBytes: number;
  sha256: string;
}

export class ArtifactRegistry {
  constructor(
    private readonly root: string,
    private readonly store: OperatorStore,
    /** Inbound ceiling; raised past 50 MiB only with a local Bot API server. */
    private readonly maxInboundBytes: number = MAX_INBOUND_BYTES,
    /** Outbound ceiling; the cloud Bot API caps uploads at 50 MiB. */
    private readonly maxOutboundBytes: number = MAX_OUTBOUND_BYTES,
    private readonly retentionMs: number = INBOUND_RETENTION_MS,
  ) {}

  private outboundLimitError(kind: string): Error {
    return new Error(
      `${kind} exceeds the ${Math.round(this.maxOutboundBytes / (1024 * 1024))} MiB outbound limit`,
    );
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
  }

  async ingestTelegram(input: {
    bytes: Uint8Array;
    filename?: string;
    mimeType?: string;
    telegramFileId: string;
    chatId: number;
    messageId: number;
  }): Promise<Artifact> {
    if (input.bytes.byteLength > this.maxInboundBytes) {
      throw new Error(
        `Attachment exceeds the ${Math.round(this.maxInboundBytes / (1024 * 1024))} MiB inbound limit`,
      );
    }
    const existing = this.store.findTelegramArtifact(
      input.chatId,
      input.messageId,
      input.telegramFileId,
    );
    if (existing) return existing;
    const id = newId("art");
    const safeName = sanitizeFilename(input.filename ?? `telegram-${input.messageId}`);
    const directory = join(this.root, id);
    const localPath = join(directory, safeName);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(localPath, input.bytes, { mode: 0o600 });
    const artifact: Artifact = {
      id,
      localPath,
      filename: safeName,
      ...(input.mimeType ? { mimeType: input.mimeType } : {}),
      sizeBytes: input.bytes.byteLength,
      sha256: sha256(input.bytes),
      source: "telegram_upload",
      telegramFileId: input.telegramFileId,
      telegramChatId: input.chatId,
      telegramMessageId: input.messageId,
      createdAt: nowIso(),
      expiresAt: new Date(Date.now() + this.retentionMs).toISOString(),
    };
    this.store.saveArtifact(artifact);
    this.store.appendEvent("artifact.received", { payload: { artifactId: id, sizeBytes: artifact.sizeBytes } });
    return artifact;
  }

  resolve(id: string): Artifact {
    const artifact = this.store.getArtifact(id);
    if (!artifact) throw new Error(`Unknown artifact: ${id}`);
    return artifact;
  }

  async materializeForThread(artifactId: string, projectRoot: string): Promise<ArtifactRef> {
    const artifact = this.resolve(artifactId);
    const projectReal = await realpath(projectRoot);
    const inbox = join(projectReal, ".operator-inbox", artifact.id);
    await mkdir(inbox, { recursive: true, mode: 0o700 });
    const target = join(inbox, sanitizeFilename(artifact.filename ?? basename(artifact.localPath)));
    await copyFile(artifact.localPath, target);
    return {
      id: artifact.id,
      localPath: target,
      ...(artifact.filename ? { filename: artifact.filename } : {}),
      ...(artifact.mimeType ? { mimeType: artifact.mimeType } : {}),
      sizeBytes: artifact.sizeBytes,
      ...(artifact.sha256 ? { sha256: artifact.sha256 } : {}),
      ...(artifact.projectId ? { projectId: artifact.projectId } : {}),
      ...(artifact.threadId ? { threadId: artifact.threadId } : {}),
      ...(artifact.derivedFromArtifactId
        ? { derivedFromArtifactId: artifact.derivedFromArtifactId }
        : {}),
    };
  }

  async registerOutbound(
    path: string,
    allowedRoots: string[],
    input: {
      projectId?: string;
      threadId?: string;
      source?: Artifact["source"];
      mimeType?: string;
    } = {},
  ): Promise<Artifact> {
    const file = await this.inspectOutbound(path, allowedRoots);
    const id = newId("art");
    const artifact: Artifact = {
      id,
      localPath: file.localPath,
      filename: file.filename,
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
      source: input.source ?? "worker_generated",
      ...(input.mimeType ? { mimeType: input.mimeType } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      createdAt: nowIso(),
    };
    this.store.saveArtifact(artifact);
    return artifact;
  }

  async ingestDerivedFile(input: {
    path: string;
    filename: string;
    mimeType: string;
    derivedFromArtifactId: string;
    expiresAt?: string;
  }): Promise<Artifact> {
    const parent = this.resolve(input.derivedFromArtifactId);
    const safeName = sanitizeFilename(input.filename);
    const existing = this.store.findDerivedArtifact(parent.id, safeName, input.mimeType);
    if (existing) return existing;
    const metadata = await stat(input.path);
    if (!metadata.isFile()) throw new Error("Derived artifact must be a regular file");
    if (metadata.size > this.maxOutboundBytes) throw this.outboundLimitError("Derived artifact");
    const id = newId("art");
    const directory = join(this.root, id);
    const localPath = join(directory, safeName);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await copyFile(input.path, localPath);
    await chmod(localPath, 0o600);
    const artifact: Artifact = {
      id,
      localPath,
      filename: safeName,
      mimeType: input.mimeType,
      sizeBytes: metadata.size,
      sha256: await hashFile(localPath),
      source: "operator_generated",
      derivedFromArtifactId: parent.id,
      ...(parent.projectId ? { projectId: parent.projectId } : {}),
      ...(parent.threadId ? { threadId: parent.threadId } : {}),
      createdAt: nowIso(),
      ...(input.expiresAt ?? parent.expiresAt
        ? { expiresAt: input.expiresAt ?? parent.expiresAt }
        : {}),
    };
    this.store.saveArtifact(artifact);
    this.store.appendEvent("artifact.derived", {
      payload: {
        artifactId: artifact.id,
        derivedFromArtifactId: parent.id,
        mimeType: artifact.mimeType,
        sizeBytes: artifact.sizeBytes,
      },
    });
    return artifact;
  }

  async ingestGeneratedFile(input: {
    path: string;
    filename: string;
    mimeType: string;
    expiresAt?: string;
  }): Promise<Artifact> {
    const metadata = await stat(input.path);
    if (!metadata.isFile()) throw new Error("Generated artifact must be a regular file");
    if (metadata.size > this.maxOutboundBytes) throw this.outboundLimitError("Generated artifact");
    const id = newId("art");
    const safeName = sanitizeFilename(input.filename);
    const directory = join(this.root, id);
    const localPath = join(directory, safeName);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await copyFile(input.path, localPath);
    await chmod(localPath, 0o600);
    const artifact: Artifact = {
      id,
      localPath,
      filename: safeName,
      mimeType: input.mimeType,
      sizeBytes: metadata.size,
      sha256: await hashFile(localPath),
      source: "operator_generated",
      createdAt: nowIso(),
      expiresAt:
        input.expiresAt ?? new Date(Date.now() + this.retentionMs).toISOString(),
    };
    this.store.saveArtifact(artifact);
    this.store.appendEvent("artifact.generated", {
      payload: {
        artifactId: artifact.id,
        mimeType: artifact.mimeType,
        sizeBytes: artifact.sizeBytes,
      },
    });
    return artifact;
  }

  async inspectOutbound(path: string, allowedRoots: string[]): Promise<SafeFileMetadata> {
    if (!existsSync(path)) throw new Error("Outbound artifact does not exist");
    const resolvedPath = await realpath(path);
    const roots = await Promise.all(allowedRoots.map((root) => realpath(root)));
    if (!roots.some((root) => isInside(root, resolvedPath))) throw new Error("Outbound path is outside allowed roots");
    if (secretPattern.test(basename(resolvedPath))) throw new Error("Secret-like files cannot be sent");
    const metadata = await stat(resolvedPath);
    if (!metadata.isFile()) throw new Error("Outbound artifact must be a regular file");
    if (metadata.size > this.maxOutboundBytes) throw this.outboundLimitError("Outbound artifact");
    return {
      localPath: resolvedPath,
      filename: basename(resolvedPath),
      sizeBytes: metadata.size,
      sha256: await hashFile(resolvedPath),
    };
  }

  async cleanupExpired(at = nowIso()): Promise<number> {
    const rootReal = await realpath(this.root);
    let removed = 0;
    for (const artifact of this.store.listExpiredArtifacts(at)) {
      try {
        const resolvedPath = await realpath(artifact.localPath).catch(() => undefined);
        if (resolvedPath && isInside(rootReal, resolvedPath)) {
          const artifactDirectory = dirname(resolvedPath);
          if (dirname(artifactDirectory) === rootReal) {
            await rm(artifactDirectory, { recursive: true, force: true });
          } else {
            await rm(resolvedPath, { force: true });
          }
        }
        if (this.store.deleteArtifactRecord(artifact.id)) removed += 1;
      } catch {
        // Keep the record so a later maintenance pass can retry safely.
      }
    }
    return removed;
  }
}

export function sanitizeFilename(value: string): string {
  const extension = extname(value).slice(0, 16);
  const stem = basename(value, extname(value))
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 180);
  return `${stem || "attachment"}${extension}`;
}

function isInside(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
