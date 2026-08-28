#!/usr/bin/env node
// Проверка, что импортированные заметки видны новому боту ТЕМИ ЖЕ путями,
// которыми их читает сам оператор: публичный поиск (memory.search),
// чтение по ключу (memory.get) и индекс памяти, который демон пушит в промпт.
//
// Запуск: node deploy/rick/memory-import/verify.mjs [--db <файл>] [--query "..."]
//         [--key <ключ>]

import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
const databasePath = resolve(
  option("--db", process.env.OPERATOR_HOME ? join(process.env.OPERATOR_HOME, "operator.db") : "/root/.operator/operator.db"),
);
const query = option("--query", "");
const key = option("--key", "");

const require = createRequire(join(REPO_ROOT, "package.json"));
const { register } = await import(require.resolve("tsx/esm/api"));
const unregister = register();
const storage = await import(new URL(`file://${join(REPO_ROOT, "packages/storage/src/index.ts")}`).href);
const { currentMemoryNotesForPush } = await import(
  new URL(`file://${join(REPO_ROOT, "apps/daemon/src/operator-memory-index.ts")}`).href
);

const store = new storage.OperatorStore(databasePath);
try {
  const counts = store.db
    .prepare("SELECT status, COUNT(*) AS n FROM operator_notes GROUP BY status")
    .all();
  const categories = store.db
    .prepare("SELECT category, COUNT(*) AS n FROM operator_notes WHERE status='active' GROUP BY category ORDER BY n DESC")
    .all();
  const vectors = store.db
    .prepare(`
      SELECT v.model AS model, COUNT(*) AS n FROM operator_note_vectors v
      JOIN operator_notes n ON n.id=v.note_id
      WHERE n.status='active' AND v.input_hash=n.input_hash GROUP BY v.model
    `)
    .all();
  const orphans = store.db
    .prepare(`
      SELECT COUNT(*) AS n FROM operator_notes n
      LEFT JOIN operator_note_search s ON s.id=n.id
      WHERE n.status='active' AND s.id IS NULL
    `)
    .get();

  process.stdout.write(`база: ${databasePath}\n`);
  process.stdout.write(`заметки по статусам: ${counts.map((r) => `${r.status}=${Number(r.n)}`).join(", ") || "нет"}\n`);
  process.stdout.write(`категории (active): ${categories.map((r) => `${r.category}=${Number(r.n)}`).join(", ") || "нет"}\n`);
  process.stdout.write(`вектора (свежие): ${vectors.map((r) => `${r.model}=${Number(r.n)}`).join(", ") || "нет"}\n`);
  process.stdout.write(`active-заметок вне FTS-индекса: ${Number(orphans?.n ?? 0)} (должно быть 0)\n`);

  const index = currentMemoryNotesForPush(store);
  process.stdout.write(`\nиндекс памяти в push (${index.index.length} строк, первые 10):\n`);
  for (const note of index.index.slice(0, 10)) {
    process.stdout.write(`  ${note.description ?? note.content} → ${note.key ?? note.id}\n`);
  }
  if (index.antiRediscovery.length) {
    process.stdout.write(`блок anti-rediscovery: ${index.antiRediscovery.length} строк\n`);
  }

  if (query) {
    const found = await storage.searchPublicOperatorNotes(store, query, 5);
    process.stdout.write(`\nmemory.search "${query}": ${found.length} совпадений\n`);
    for (const note of found) {
      process.stdout.write(`  [${note.category}] ${note.key ?? note.id} — ${note.content}\n`);
    }
  }
  if (key) {
    const note = storage.getPublicOperatorNote(store, key);
    process.stdout.write(
      note
        ? `\nmemory.get "${key}": [${note.category}] ${note.description ?? ""}\n  ${note.content}\n`
        : `\nmemory.get "${key}": не найдено\n`,
    );
  }
} finally {
  store.db.close();
  unregister();
}
