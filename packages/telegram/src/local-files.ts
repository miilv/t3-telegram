import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * A local Bot API server writes every downloaded file into its working
 * directory and never removes it, so the daemon prunes the directory itself.
 *
 * The server keeps its own state there too (`*.binlog`, `*.sqlite`, temporary
 * upload state). Those files sit directly in the working root or alongside it
 * and must survive: deleting a binlog loses the server's update queue. Only
 * regular files nested at least two levels deep — the `<token>/<kind>/file_N`
 * layout the server uses for media — are eligible, and only once they are
 * older than the retention window.
 */
export async function pruneLocalBotApiFiles(input: {
  root: string;
  olderThanMs: number;
  now?: number;
}): Promise<{ removedFiles: number; freedBytes: number }> {
  const now = input.now ?? Date.now();
  const cutoff = now - input.olderThanMs;
  let removedFiles = 0;
  let freedBytes = 0;

  const walk = async (directory: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      // Server state lives at the top of the tree; media is nested deeper.
      if (depth < 2) continue;
      if (isServerState(entry.name)) continue;
      try {
        const metadata = await stat(path);
        if (metadata.mtimeMs > cutoff) continue;
        await rm(path, { force: true });
        removedFiles += 1;
        freedBytes += metadata.size;
      } catch {
        // A file the daemon may not delete is left for the next pass.
      }
    }
  };

  await walk(input.root, 0);
  return { removedFiles, freedBytes };
}

function isServerState(name: string): boolean {
  return /\.(binlog|sqlite|sqlite-journal|conf|pid)$/i.test(name);
}
