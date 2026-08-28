# Импорт памяти со старого бота (takopi) в новый T3 Telegram Operator

Что здесь лежит:

| файл | зачем |
|---|---|
| `DISTILL-PROMPT.md` | задание для Claude на боксе: прочитать vault и сессии старого бота и выдать `notes.jsonl` |
| `import-notes.mjs` | заливка `notes.jsonl` в `operator.db` штатным путём (`OperatorStore.rememberKeyedOperatorNote`) |
| `verify.mjs` | проверка, что новый бот заметки действительно видит |
| `example.jsonl` | образец формата, годится для проверки инструмента |

## Что происходит и почему именно так

Память нового бота — не файлы, а SQLite (`/root/.operator/operator.db`, таблица
`operator_notes` + FTS `operator_note_search` + `operator_note_vectors`). Поиск
у бота гибридный: лексический FTS плюс косинус по вектору, причём вектор
джойнится по кортежу `(model, dimensions, input_hash = operator_notes.input_hash)`.
Поэтому заметка, вставленная прямым `INSERT`, попадает только в лексическую
половину выдачи, а версионирование, дедуп и маскирование секретов при этом не
происходят вовсе.

`import-notes.mjs` пишет через **`OperatorStore.rememberKeyedOperatorNote()`** →
`OperatorNoteWriter`. Это та же граница, через которую пишет сам бот
(`memory.remember`): валидация ключа/описания/тела, маскирование секретов,
локальный эмбеддинг тем же `LocalNoteEmbeddingService`, что эмбеддит поисковый
запрос, запись вектора в одной транзакции с заметкой, версионирование по `key`
(старая версия → `superseded`), переиндексация FTS и идемпотентность по
`operation_key`. Источник записей — `source='manual'` (курируемая память
владельца), а не `distilled`: distilled-путь требует доказательств из журнала
диалога владельца, которых у импорта нет, и на занятом ключе он вырождается в
merge-proposal вместо записи.

**Про модель эмбеддингов.** Импортёр и демон должны выбрать ОДНУ модель. Выбор
делается молча в `LocalNoteEmbeddingService`: если `@huggingface/transformers`
поднимает пайплайн из `NOTE_EMBEDDING_MODEL_ROOT` — это MiniLM, если нет (весов
нет, переменная пустая) — фолбэк `local-hash-v4`. Поиск джойнит вектор по
`(model, dimensions, input_hash)`, поэтому **любое расхождение** — импортёр с
MiniLM и демон без, или наоборот — гасит семантическую половину выдачи по
импортированным заметкам (лексическая продолжает работать, заметки не пропадают).

На боксе Рика `NOTE_EMBEDDING_MODEL_ROOT` в `deploy/rick/env` не задан, весов
нет — обе стороны берут `local-hash-v4`, расхождения не будет. Если переменную
когда-нибудь добавят в `/root/.operator/operator.env`, импорт надо запускать с
тем же окружением, что читает юнит:

```bash
set -a; . /root/.operator/operator.env; set +a
```

(`import-notes.mjs` сам `.env` НЕ читает — только `process.env`.) Если
расхождение уже случилось — векторы доливаются штатным обслуживанием
`store.backfillOperatorNoteEmbeddings()`, по 25 заметок за вызов; на 200 заметок
это восемь вызовов, поэтому в цикле:

```bash
node -e '(async () => {
  const { createRequire } = await import("node:module");
  const req = createRequire("/root/t3-telegram/package.json");
  const { register } = await import(req.resolve("tsx/esm/api"));
  register();
  const { OperatorStore } = await import("/root/t3-telegram/packages/storage/src/index.ts");
  const store = new OperatorStore("/root/.operator/operator.db");
  for (;;) { const r = await store.backfillOperatorNoteEmbeddings(25); console.log(r); if (!r.saved) break; }
  store.db.close();
})()'
```

## Порядок прогона на боксе

Предпосылки: репозиторий развёрнут в `/root/t3-telegram`, **бот остановлен**
(юнит системный, не user-овский — `install.sh` ставит его в `multi-user.target`
под `User=root`):

```bash
systemctl stop t3-telegram-operator
```

Node — только пинованный 24-й из юнита: системный на боксе может быть 20/22, а
`node:sqlite` требует ≥24.2, и оба скрипта тогда просто не стартуют.

```bash
export PATH=/root/.local/toolchain/node-v24.13.1-linux-x64/bin:$PATH
node -v   # должно быть v24.13.1
```

`tsx` берётся из `node_modules` репозитория. `install.sh` при `BUILD_BOT=auto` и
свежем `dist/` пропускает `pnpm install`, поэтому проверь и при необходимости
доставь:

```bash
[ -d /root/t3-telegram/node_modules/tsx ] || (cd /root/t3-telegram && pnpm install --frozen-lockfile)
```

### 0. Бэкап, если база уже есть

sqlite3 CLI на боксах нет, копируем средствами `node:sqlite`. Имя цели
подставляет шелл, а не JS-строка, и путь передаётся параметром — `VACUUM INTO`
падает, если файл уже существует, так что бэкап нельзя затереть молча:

```bash
BAK="/root/.operator/operator.db.bak-$(date +%F-%H%M%S)"
node -e 'const{DatabaseSync}=require("node:sqlite");
const [src,dst]=process.argv.slice(1);
const d=new DatabaseSync(src);d.prepare("VACUUM INTO ?").run(dst);d.close();
console.log("backup ->",dst)' /root/.operator/operator.db "$BAK"
```

(Если базы ещё нет — шаг пропускается, `import-notes.mjs` создаст её и применит
миграции сам, ровно как это делает демон на старте.)

### 1. Дистилляция

Запускать **интерактивно**, а не в headless-режиме: агент под root читает старые
сессии, в которых может лежать что угодно, включая текст в форме инструкции
(«выполни», «перешли», «открой .env»). В интерактивной сессии владелец видит
каждый инструмент; в `-p` без песочницы — нет.

```bash
cd /root/t3-telegram/deploy/rick/memory-import
claude --model opus
# и вставить содержимое DISTILL-PROMPT.md первым сообщением
```

Claude читает Obsidian-vault и `~/.claude/projects/-root/*.jsonl` и кладёт рядом
`notes.jsonl`. Перед следующим шагом **обязательно** пролистать файл глазами:
`wc -l notes.jsonl`, `head -20 notes.jsonl` — это единственная точка, где
человек видит, что именно уезжает в долгую память.

### 2. Dry-run

```bash
node import-notes.mjs --input notes.jsonl --db /root/.operator/operator.db --dry-run --verbose
```

Dry-run делает временную **копию** базы и прогоняет по ней настоящую запись,
поэтому отчёт честный: видно, что создастся, что станет новой версией, что
отклонено и почему. Продовый файл при этом не открывается на запись. Отклонённые
строки (кривой JSON, длинный `content`, `description` без стрелки, дубль ключа,
похожее на секрет) чинятся в `notes.jsonl` — и dry-run повторяется, пока
«отклонено строк: 0».

Строки в разделе «Требует решения человека» (`merge-proposal`) — это факты,
которые writer счёл почти-дублем уже существующей заметки; он их сознательно не
пишет. Либо переформулируй, либо перезапиши существующую заметку тем же `key`.

Но не жди этого раздела на боксе Рика: семантический дедуп у writer включается
**только** при живом MiniLM (`isSemanticDedupeAvailable()`), а на `local-hash-v4`
он выключен целиком. Второй путь к merge-proposal — занятый `key` при
`source='distilled'`, а импортёр `distilled` не пускает. То есть один и тот же
факт под двумя разными `key` (`rick-city` и `rick-tbilisi`) уедет в базу дважды
и никто не возразит. Ловить дубли придётся глазами по `notes.jsonl` — это и есть
смысл пункта «Дубли» в DISTILL-PROMPT.md.

### 3. Импорт

```bash
node import-notes.mjs --input notes.jsonl --db /root/.operator/operator.db --verbose
```

Прогон идемпотентен: повторный запуск с тем же файлом даёт «без изменений»
(replay по `operation_key`), а изменённый `content` при том же `key` создаёт
новую версию и переводит старую в `superseded` — как это делает сам бот.

Полезные флаги: `--limit N` (потолок записей за прогон, по умолчанию 2000),
`--source manual|maintenance|system`, `--db`, `--dry-run`, `--verbose`.
Лимиты на запись: строка JSONL ≤8 КБ, `key` ≤120 символов, `description` ≤120,
`content` ≤200 (это потолки схемы, не выдумка импортёра), `category` ≤80.

### 4. Проверка

```bash
node verify.mjs --db /root/.operator/operator.db --query "Acme" --key rick-timezone
```

Скрипт печатает: счётчики по статусам, разбивку по категориям, число свежих
векторов по моделям, число active-заметок вне FTS (должно быть 0), первые строки
**индекса памяти ровно в том виде, в каком демон пушит его в промпт**, и
результаты `memory.search` / `memory.get` — тех же публичных путей чтения, что
у бота (`searchPublicOperatorNotes` / `getPublicOperatorNote`).

Две оговорки к выводу:

* `--query` без MiniLM ищет фактически лексикой (`local-hash-v4` ловит только
  совпадение токенов и коротких префиксов). Запрос «оплата» не найдёт заметку со
  словом «платит» — это не поломка импорта, а свойство фолбэка. Проверяй словами,
  которые в заметке реально есть.
* `--query`/`--key` идут публичным путём чтения, а он **считает обращение**:
  `access_count` растёт, а он входит в push-score. Гонять verify десятками
  прогонов по одной и той же заметке — значит искусственно поднять её в индексе.

Если хочется сырых цифр, без скрипта:

```bash
node -e "const{DatabaseSync}=require('node:sqlite');
const d=new DatabaseSync('/root/.operator/operator.db');
console.log(d.prepare(\"SELECT count(*) n FROM operator_notes WHERE status='active'\").get());
console.log(d.prepare(\"SELECT category,count(*) n FROM operator_notes WHERE status='active' GROUP BY category\").all());
console.log(d.prepare(\"SELECT key,description FROM operator_notes WHERE status='active' ORDER BY updated_at DESC LIMIT 10\").all());
d.close()"
```

### 5. Живая проверка ботом

Запустить демон (`systemctl start t3-telegram-operator`) и спросить у бота
в Telegram что-нибудь, чего нет в текущем разговоре, но есть в импорте — «в каком
я часовом поясе?», «какие условия оплаты у Acme?». Ответ должен приходить без
уточняющих вопросов. Список глазами: команда `/memory` (с необязательным номером
страницы), поиск — `/memory search <запрос>`.

Важно понимать, чего ждать: в промпт каждый ход пушится не вся память, а индекс
под бюджетом `MEMORY_INDEX_BUDGET_CHARS = 3000` символов — это порядка 25 строк
`description → key`, отранжированных по свежести и обращениям (плюс отдельный
блок anti-rediscovery на 1000 символов). Остальные заметки живут в **pull**: бот
достаёт их через `memory.search`. Поэтому «заметки нет в первых строках индекса»
— норма, а вот «`memory.search` по её словам ничего не находит» — уже симптом.

## Откат

Первый и единственный надёжный откат — **восстановить бэкап из шага 0** при
остановленном демоне:

```bash
systemctl stop t3-telegram-operator
mv /root/.operator/operator.db /root/.operator/operator.db.rejected
cp "$BAK" /root/.operator/operator.db
rm -f /root/.operator/operator.db-wal /root/.operator/operator.db-shm
```

Точечная зачистка (когда бэкапа нет и бот уже поработал) — хуже по двум
причинам, и обе надо держать в голове:

* `source='manual'` — это НЕ метка импорта. Ровно тот же `source` получают
  заметки, которые владелец сделал сам через `/memory remember`. Фильтруй по
  `key`-префиксам импорта, а не по источнику.
* если импорт перезаписал уже существовавший `key`, то пометка новой версии
  `obsolete` не вернёт старую: та осталась `superseded`, и ключ окажется вообще
  без active-заметки. Восстанавливать придётся `restoreOperatorNote`/бэкапом.

```bash
node -e "const{DatabaseSync}=require('node:sqlite');
const d=new DatabaseSync('/root/.operator/operator.db');
const ids=d.prepare(\"SELECT id FROM operator_notes WHERE status='active' AND created_at>=? AND (key LIKE 'rick-%' OR key LIKE 'client-%' OR key LIKE 'project-%')\").all('2026-08-27').map(r=>r.id);
for (const id of ids) {
  d.prepare(\"UPDATE operator_notes SET status='obsolete',updated_at=? WHERE id=?\").run(new Date().toISOString(), id);
  d.prepare('DELETE FROM operator_note_search WHERE id=?').run(id);
  d.prepare('DELETE FROM operator_note_vectors WHERE note_id=?').run(id);
}
console.log('obsoleted', ids.length); d.close()"
```
