#!/usr/bin/env node
// Импорт памяти со старого бота (takopi) в operator.db нового бота.
//
// Путь вставки — ШТАТНЫЙ: OperatorStore.rememberKeyedOperatorNote(), то есть
// OperatorNoteWriter из packages/storage/src/operator-note-writer.ts. Прямой
// INSERT в operator_notes запрещён: writer — единственная граница, где
// одновременно происходят
//   * валидация черновика (packages/policy/src/operator-notes.ts: key-слаг,
//     description в форме «триггер → суть», content ≤ 200 символов),
//   * маскирование секретов (maskSecretsForStorage),
//   * локальный эмбеддинг заметки тем же LocalNoteEmbeddingService, которым
//     демон эмбеддит ПОИСКОВЫЙ запрос (MiniLM при наличии весов, иначе
//     local-hash-v4) и запись вектора в operator_note_vectors в одной
//     транзакции с самой заметкой (vector.inputHash === notes.input_hash),
//   * семантический дедуп/кросс-ссылки,
//   * версионирование по key (старая версия → status='superseded') и
//     переиндексация FTS operator_note_search,
//   * идемпотентность по operation_key (operator_note_operations).
//
// Ручной INSERT ломает ровно vector-часть гибридного поиска: публичное чтение
// (searchPublicOperatorNotes → searchOperatorNotesEmbedded) джойнит вектора по
// кортежу (model, dimensions, input_hash === notes.input_hash), и заметка без
// такого вектора живёт только в лексической половине выдачи. Плюс legacy-путь
// store.rememberOperatorNote() пишет вектор модели 'local-hash-v2', которая с
// embedded-поиском не совпадает вовсе, — поэтому используем keyed-путь v2.
//
// Запуск: node deploy/rick/memory-import/import-notes.mjs --input notes.jsonl
// Node 24 (node:sqlite). Внешних зависимостей нет: TypeScript-исходники репо
// подгружаются через tsx из node_modules (dev-зависимость репо, ставится
// обычным `pnpm install --frozen-lockfile`).

import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");

/** Одна строка JSONL не может быть больше этого — защита от вставленного лога. */
const MAX_LINE_BYTES = 8 * 1024;
/** Сколько заметок максимум за прогон (перекрывается --limit). */
const DEFAULT_MAX_RECORDS = 2000;
/** Жёсткие потолки схемы; дублируем здесь, чтобы дать понятную ошибку раньше. */
const MAX_KEY_CHARS = 120;
const MAX_DESCRIPTION_CHARS = 120;
const MAX_CONTENT_CHARS = 200;
const MAX_CATEGORY_CHARS = 80;

const ALLOWED_SOURCES = new Set(["manual", "maintenance", "system"]);

function usage() {
  return `Использование:
  node import-notes.mjs --input <notes.jsonl> [опции]

Опции:
  --input <файл>    JSONL с заметками (обязателен)
  --db <файл>       путь к operator.db (по умолчанию $OPERATOR_HOME/operator.db
                    или /root/.operator/operator.db)
  --dry-run         прогон на ВРЕМЕННОЙ копии базы; продовый файл не трогается
  --limit <N>       максимум записей за прогон (по умолчанию ${DEFAULT_MAX_RECORDS})
  --source <s>      manual | maintenance | system (по умолчанию manual)
  --verbose         печатать строку про каждую заметку, а не только сводку
  --help

Формат строки JSONL (одна заметка — один факт):
  {"key":"rick-client-acme-billing","category":"client",
   "description":"когда речь про оплату Acme → условия и сроки",
   "content":"Acme платит по счёту в течение 10 рабочих дней, предоплата 50%."}
Поля: key, description, content (можно прислать как "text"), category,
      необязательный validUntil (RFC3339 instant, UTC).`;
}

function parseArgs(argv) {
  const options = {
    input: "",
    db: "",
    dryRun: false,
    limit: DEFAULT_MAX_RECORDS,
    source: "manual",
    verbose: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`Опция ${argument} требует значение`);
      index += 1;
      return value;
    };
    switch (argument) {
      case "--input": options.input = next(); break;
      case "--db": options.db = next(); break;
      case "--dry-run": options.dryRun = true; break;
      case "--limit": options.limit = Number.parseInt(next(), 10); break;
      case "--source": options.source = next(); break;
      case "--verbose": options.verbose = true; break;
      case "--help": case "-h": options.help = true; break;
      default: throw new Error(`Неизвестная опция: ${argument}`);
    }
  }
  return options;
}

function defaultDatabasePath() {
  const home = process.env.OPERATOR_HOME?.trim();
  if (home) return resolve(home, "operator.db");
  return "/root/.operator/operator.db";
}

/** Загрузка TypeScript-исходников репо без сборки. */
async function loadRepoModules() {
  const require = createRequire(join(REPO_ROOT, "package.json"));
  let register;
  try {
    ({ register } = await import(require.resolve("tsx/esm/api")));
  } catch {
    throw new Error(
      "Не найден tsx в node_modules репозитория. Выполните в " +
        `${REPO_ROOT}: pnpm install --frozen-lockfile`,
    );
  }
  const unregister = register();
  try {
    const storage = await import(
      new URL(`file://${join(REPO_ROOT, "packages/storage/src/index.ts")}`).href
    );
    const policy = await import(
      new URL(`file://${join(REPO_ROOT, "packages/policy/src/operator-notes.ts")}`).href
    );
    const shared = await import(
      new URL(`file://${join(REPO_ROOT, "packages/shared/src/index.ts")}`).href
    );
    return { storage, policy, shared, unregister };
  } catch (error) {
    unregister();
    throw error;
  }
}

/**
 * Разбор и предвалидация одной строки. Возвращает либо запись, готовую к
 * штатной записи, либо причину отказа — прогон не должен падать на одной
 * кривой строке, отчёт важнее.
 */
function parseRecord(rawLine, lineNumber, tools, source) {
  const { validateOperatorNoteDraft, maskSecretsForStorage } = tools;
  const bytes = Buffer.byteLength(rawLine, "utf8");
  if (bytes > MAX_LINE_BYTES) {
    return { ok: false, lineNumber, reason: `строка ${bytes} байт > лимита ${MAX_LINE_BYTES}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(rawLine);
  } catch (error) {
    return { ok: false, lineNumber, reason: `не JSON: ${error.message}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, lineNumber, reason: "строка не является JSON-объектом" };
  }
  const content = typeof parsed.content === "string"
    ? parsed.content
    : typeof parsed.text === "string" ? parsed.text : "";
  const key = typeof parsed.key === "string" ? parsed.key : "";
  const description = typeof parsed.description === "string" ? parsed.description : "";
  const category = typeof parsed.category === "string" ? parsed.category : "general";
  const validUntil = typeof parsed.validUntil === "string" ? parsed.validUntil.trim() : "";

  if (!key.trim()) return { ok: false, lineNumber, reason: "нет key" };
  if (!description.trim()) return { ok: false, lineNumber, reason: "нет description" };
  if (!content.trim()) return { ok: false, lineNumber, reason: "нет content/text" };
  if ([...key].length > MAX_KEY_CHARS) {
    return { ok: false, lineNumber, reason: `key длиннее ${MAX_KEY_CHARS} символов` };
  }
  if ([...description.trim()].length > MAX_DESCRIPTION_CHARS) {
    return { ok: false, lineNumber, reason: `description длиннее ${MAX_DESCRIPTION_CHARS} символов` };
  }
  if ([...content.trim()].length > MAX_CONTENT_CHARS) {
    return { ok: false, lineNumber, reason: `content длиннее ${MAX_CONTENT_CHARS} символов` };
  }
  if ([...category.trim()].length > MAX_CATEGORY_CHARS) {
    return { ok: false, lineNumber, reason: `category длиннее ${MAX_CATEGORY_CHARS} символов` };
  }
  if (validUntil && !tools.isStrictRfc3339Instant(validUntil)) {
    return { ok: false, lineNumber, reason: "validUntil не RFC3339 instant" };
  }

  // Заметка, в которой сработал детектор секретов, не импортируется вовсе:
  // writer её замаскирует, но в памяти нового бота такому факту не место.
  for (const [field, value] of [["content", content], ["description", description]]) {
    if (maskSecretsForStorage(value) !== value) {
      return { ok: false, lineNumber, reason: `в поле ${field} похоже на секрет — отфильтровано` };
    }
  }

  const validated = validateOperatorNoteDraft({ key, description, content, category });
  if (!validated.ok) return { ok: false, lineNumber, reason: validated.hint };

  return {
    ok: true,
    lineNumber,
    draft: {
      key: validated.key,
      description: validated.description,
      content: validated.content,
      category: validated.category,
      source,
      ...(validUntil ? { validUntil } : {}),
    },
  };
}

function readRecords(inputPath, tools, source, limit) {
  // U+FEFF (BOM) в начале файла: `trim()` его съедает, а `JSON.parse` — нет,
  // поэтому без явного удаления ПЕРВАЯ заметка файла молча уезжала в «не JSON».
  const lines = readFileSync(inputPath, "utf8").replace(/^﻿/u, "").split(/\r?\n/);
  const accepted = [];
  const rejected = [];
  const seenKeys = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const lineNumber = index + 1;
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;
    const record = parseRecord(rawLine, lineNumber, tools, source);
    if (!record.ok) {
      rejected.push(record);
      continue;
    }
    const previous = seenKeys.get(record.draft.key);
    if (previous !== undefined) {
      // Два одинаковых key в одном файле — вторая строка молча превратила бы
      // первую в superseded-версию. Это ошибка дистилляции, а не история.
      rejected.push({
        ok: false,
        lineNumber,
        reason: `key "${record.draft.key}" уже встречался в строке ${previous}`,
      });
      continue;
    }
    seenKeys.set(record.draft.key, lineNumber);
    accepted.push(record);
    if (accepted.length > limit) {
      rejected.push({ ok: false, lineNumber, reason: `превышен лимит --limit ${limit}` });
      accepted.pop();
      break;
    }
  }
  return { accepted, rejected };
}

/** Для --dry-run: временная копия базы (или пустая новая, если базы ещё нет). */
function prepareDryRunDatabase(databasePath) {
  const directory = mkdtempSync(join(tmpdir(), "operator-import-dry-"));
  const target = join(directory, "operator.db");
  if (existsSync(databasePath)) {
    copyFileSync(databasePath, target);
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(`${databasePath}${suffix}`)) {
        copyFileSync(`${databasePath}${suffix}`, `${target}${suffix}`);
      }
    }
  }
  return { directory, target };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.input) {
    process.stdout.write(`${usage()}\n`);
    process.exit(options.help ? 0 : 2);
  }
  if (!ALLOWED_SOURCES.has(options.source)) {
    throw new Error(`--source должен быть одним из: ${[...ALLOWED_SOURCES].join(", ")}`);
  }
  if (!Number.isSafeInteger(options.limit) || options.limit < 1) {
    throw new Error("--limit должен быть положительным целым");
  }
  const inputPath = resolve(process.cwd(), options.input);
  if (!existsSync(inputPath)) throw new Error(`Нет файла: ${inputPath}`);
  const databasePath = resolve(process.cwd(), options.db || defaultDatabasePath());

  const { storage, policy, shared, unregister } = await loadRepoModules();
  const tools = {
    validateOperatorNoteDraft: policy.validateOperatorNoteDraft,
    maskSecretsForStorage: shared.maskSecretsForStorage,
    isStrictRfc3339Instant: shared.isStrictRfc3339Instant,
  };

  const { accepted, rejected } = readRecords(inputPath, tools, options.source, options.limit);

  let workingPath = databasePath;
  let scratch;
  if (options.dryRun) {
    scratch = prepareDryRunDatabase(databasePath);
    workingPath = scratch.target;
  }

  const summary = {
    created: 0,
    updated: 0,
    unchanged: 0,
    mergeProposal: 0,
    failed: 0,
    rejected: rejected.length,
  };
  const attention = [];
  const store = new storage.OperatorStore(workingPath);
  try {
    // Ровно то же, что делает демон на старте: миграции идемпотентны, поэтому
    // импорт может идти и до первого запуска бота, и после него.
    store.migrate();
    for (const record of accepted) {
      // Ключ операции детерминирован по нормализованному черновику, поэтому
      // повторный прогон того же JSONL попадает в replay. Спрашиваем ДО записи:
      // сохранённый outcome возвращается дословно (в нём applied=true с первого
      // раза), и без этой проверки отчёт назвал бы повтор новой заметкой.
      const operationKey = storage.automaticOperatorNoteOperationKey(record.draft);
      const replayed = Boolean(
        store.notes.writerOperationReplay(operationKey) ?? store.notes.operationReplay(operationKey),
      );
      const result = await store.rememberKeyedOperatorNote({ ...record.draft, operationKey });
      let label;
      // Порядок веток важен: merge-proposal и ошибка обязаны попасть в отчёт и
      // на ПОВТОРНОМ прогоне тоже. Writer отдаёт сохранённый outcome дословно,
      // так что «уже спрашивали» — не повод молча написать «без изменений» и
      // спрятать от владельца единственную строку, которая ждёт его решения.
      if (!result.ok) {
        summary.failed += 1;
        label = `ОШИБКА: ${result.hint}`;
        attention.push(`строка ${record.lineNumber} (${record.draft.key}): ${result.hint}`);
      } else if (result.kind === "merge-proposal") {
        summary.mergeProposal += 1;
        label = `похоже на существующую "${result.mergeProposal.note.key ?? result.mergeProposal.note.id}" ` +
          `(score ${result.mergeProposal.score.toFixed(3)}) — НЕ записано`;
        attention.push(
          `строка ${record.lineNumber} (${record.draft.key}): дубль ` +
            `"${result.mergeProposal.note.key ?? result.mergeProposal.note.id}", ` +
            `score ${result.mergeProposal.score.toFixed(3)}`,
        );
      } else if (replayed) {
        // Сохранённый outcome возвращается дословно, в нём applied=true с
        // первого раза, поэтому без этой ветки повтор назвался бы «создана».
        summary.unchanged += 1;
        label = "без изменений (идемпотентный повтор)";
      } else if (result.write.applied && result.write.supersededId) {
        summary.updated += 1;
        label = `новая версия (старая ${result.write.supersededId} → superseded)`;
      } else if (result.write.applied) {
        summary.created += 1;
        label = `создана ${result.write.note.id}`;
      } else {
        summary.unchanged += 1;
        label = "без изменений (идемпотентный повтор)";
      }
      if (options.verbose || !result.ok || result.kind === "merge-proposal") {
        process.stdout.write(`  [${record.lineNumber}] ${record.draft.key} — ${label}\n`);
      }
    }

    const semantic = store.noteEmbeddings.isSemanticDedupeAvailable();
    const active = store.db
      .prepare("SELECT COUNT(*) AS n FROM operator_notes WHERE status='active'")
      .get();
    const vectors = store.db
      .prepare(`
        SELECT v.model AS model, COUNT(*) AS n
        FROM operator_note_vectors v JOIN operator_notes n ON n.id=v.note_id
        WHERE n.status='active' AND v.input_hash=n.input_hash
        GROUP BY v.model
      `)
      .all();

    process.stdout.write(
      `\n${options.dryRun ? "DRY-RUN (временная копия базы, продовый файл не тронут)" : "ИМПОРТ"}\n` +
        `  база:            ${databasePath}${options.dryRun ? ` → ${workingPath}` : ""}\n` +
        `  вход:            ${inputPath}\n` +
        `  принято строк:   ${accepted.length}\n` +
        `  отклонено строк: ${rejected.length}\n` +
        `  создано:         ${summary.created}\n` +
        `  новых версий:    ${summary.updated}\n` +
        `  без изменений:   ${summary.unchanged}\n` +
        `  merge-proposal:  ${summary.mergeProposal}\n` +
        `  ошибок записи:   ${summary.failed}\n` +
        `  эмбеддинги:      ${semantic ? "MiniLM (семантический дедуп включён)" : "local-hash-v4 (весов MiniLM нет)"}\n` +
        `  active-заметок в базе: ${Number(active?.n ?? 0)}\n` +
        `  векторов по моделям:   ${
          vectors.length
            ? vectors.map((row) => `${row.model}=${Number(row.n)}`).join(", ")
            : "нет"
        }\n`,
    );
    if (rejected.length) {
      process.stdout.write("\nОтклонённые строки:\n");
      for (const item of rejected) {
        process.stdout.write(`  [${item.lineNumber}] ${item.reason}\n`);
      }
    }
    if (attention.length) {
      process.stdout.write("\nТребует решения человека:\n");
      for (const line of attention) process.stdout.write(`  ${line}\n`);
    }
  } finally {
    store.db.close();
    unregister();
    if (scratch) rmSync(scratch.directory, { recursive: true, force: true });
  }

  // Ненулевой код — только при том, что чинится правкой JSONL.
  process.exitCode = summary.failed + summary.rejected > 0 ? 1 : 0;
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exit(1);
});
