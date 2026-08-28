# Импорт памяти со старого бота (takopi) в новый T3 Telegram Operator

Что здесь лежит:

| файл | зачем |
|---|---|
| `DISTILL-PROMPT-v2.md` | **актуальное** задание для Claude на боксе: волновая дистилляция vault и файловой памяти в `notes-wave-<N>.jsonl` |
| `DISTILL-PROMPT.md` | v1, прогон 27.08.2026. Оставлен как история: по нему видно, из-за чего v2 переписан. Для работы не использовать |
| `import-notes.mjs` | заливка `notes-wave-<N>.jsonl` в `operator.db` штатным путём (`OperatorStore.rememberKeyedOperatorNote`) |
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

Процесс **волновой**: источники разбиты на волны (1, 2a, 2b, 3, 4 — таблица в
`DISTILL-PROMPT-v2.md`), и каждая волна проходит полный цикл целиком, прежде чем
начнётся следующая:

```
снять параметры волны (files-wave-N.txt + notes-existing.txt + копия базы)
  → прогон дистиллятора в /opt/distill  → notes-wave-N.jsonl + ведомость
  → просмотр файла глазами
  → dry-run по КОПИИ базы, пока «отклонено строк: 0 и ошибок записи: 0»
  → боевой импорт
  → verify.mjs по боевой базе
  → следующая волна
```

**Параллельно волны не гонять.** Список занятых заметок снимается заново после
боевого импорта предыдущей волны — иначе две волны не увидят ключей друг друга
и наплодят дубли (семантического дедупа на этом боксе нет, см. ниже).

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

### 1. Рабочий каталог дистиллятора — `/opt/distill`

Дистиллятор **не запускается из `/root`**: cwd под `/root` даёт ему на виду
`/root/CLAUDE.md`, `/root/.claude/` и весь репозиторий, а `/root/CLAUDE.md`
написан в форме инструкций чужому агенту и подхватывается как проектный промпт.
Каталог заводится один раз, владельцем:

```bash
mkdir -p /opt/distill
cp /root/t3-telegram/deploy/rick/memory-import/DISTILL-PROMPT-v2.md /opt/distill/
```

Туда же владелец кладёт параметры каждой волны (шаг 2), туда же дистиллятор
пишет `notes-wave-<N>.jsonl`. `import-notes.mjs` и `verify.mjs` вызываются
**по абсолютному пути** `/root/t3-telegram/deploy/rick/memory-import/…` —
копировать их в `/opt/distill` не надо.

### 2. Снять параметры волны

Три файла, все — руками владельца, до запуска.

**(а) Список файлов волны с размерами.** Дистиллятору не даётся `Bash`, поэтому
`find`/`wc` за него выполняет владелец; сырой вывод дистиллятор вставляет в
начало ведомости покрытия, и по нему же строится по-файловая таблица.

Формат строки — **один на все волны и на все файлы**: `размер_в_байтах TAB путь`,
отсортировано по пути (`-printf '%s\t%p\n' | sort -k2`). Никаких `ls -l` вперемешку:
дистиллятор берёт «всего байт» для ведомости из первой колонки, и она должна быть
одинаковой во всех строках файла.

```bash
# волна 1 — 13 непрочитанных файлов памяти (все infra_*, все skill_*,
# higgsfield_advanced_tools) + MEMORY.md для сверки хуков + /root/CLAUDE.md.
# MEMORY.md.bak.2026-07-17 под маски не попадает — и не должен.
{ find /root/.claude/projects/-root/memory -maxdepth 1 -type f \
    \( -name 'infra_*.md' -o -name 'skill_*.md' \
       -o -name 'higgsfield_advanced_tools.md' -o -name 'MEMORY.md' \) \
    -printf '%s\t%p\n'
  find /root/CLAUDE.md -type f -printf '%s\t%p\n'
} | sort -k2 > /opt/distill/files-wave-1.txt

# волна 2a — objects + decisions + reports + три файла в корне vault
{ find /root/vault/objects /root/vault/decisions /root/vault/reports -type f \
    -printf '%s\t%p\n'
  find /root/vault -maxdepth 1 -type f -name '*.md' -printf '%s\t%p\n'
} | sort -k2 > /opt/distill/files-wave-2a.txt

# волна 2b — knowledge + inbox, включая бинарники: они обязаны быть в ведомости
# со строкой «пропущен, бинарный файл», а не выпасть из неё молча
find /root/vault/knowledge /root/vault/inbox -type f \
  -printf '%s\t%p\n' | sort -k2 > /opt/distill/files-wave-2b.txt

# волна 3 — скиллы; trello-mcp без SKILL.md сюда не попадёт,
# его отсутствие дистиллятор отмечает в ведомости отдельной строкой
find /root/.claude/skills -maxdepth 2 -type f -name 'SKILL.md' \
  -printf '%s\t%p\n' | sort -k2 > /opt/distill/files-wave-3.txt

# волна 4 — conversations + audio
find /root/vault/conversations /root/vault/audio -type f \
  -printf '%s\t%p\n' | sort -k2 > /opt/distill/files-wave-4.txt
```

**(б) Занятые заметки — целиком.** Дистиллятору нужны не только `key+category`,
но `description` и `content`: без них он не может ни решить, покрывает ли его
формулировка старую, ни объяснить, чем новая версия лучше. На 85 заметок это
~28 КБ — влезает в контекст спокойно. Чтение строго read-only:

```bash
python3 -c "
import sqlite3
c=sqlite3.connect('file:/root/.operator/operator.db?mode=ro',uri=True)
q=\"SELECT key,category,description,content FROM operator_notes WHERE status='active' ORDER BY category,key\"
for k,g,d,t in c.execute(q): print(k,'|',g,'|',d,'|',t)
" > /opt/distill/notes-existing.txt
```

**(в) Копия базы для dry-run**, при остановленном демоне:

```bash
systemctl stop t3-telegram-operator
rm -f /root/.operator/operator.db.distill-copy
node -e 'const{DatabaseSync}=require("node:sqlite");
const [src,dst]=process.argv.slice(1);
const d=new DatabaseSync(src);d.prepare("VACUUM INTO ?").run(dst);d.close();
console.log("copy ->",dst)' /root/.operator/operator.db /root/.operator/operator.db.distill-copy
```

Все три снимаются **заново перед каждой волной**, после боевого импорта
предыдущей.

### 3. Запуск дистилляции

Дистиллятору выдаётся ровно четыре инструмента. `Write` нужен для
`notes-wave-<N>.jsonl`; `Bash` **не даётся** — не потому, что он бесполезен, а
потому, что вместе с ним у агента под root появляется возможность выполнить то,
что он вычитал в чужих файлах. Всё, ради чего нужен был `Bash` (`find`, `wc`,
`import-notes.mjs`), делает владелец на шагах 2 и 4.

```bash
cd /opt/distill
claude -p "$(cat /opt/distill/DISTILL-PROMPT-v2.md)

## ПАРАМЕТРЫ ПРОГОНА
ВОЛНА: 2a — vault: objects/decisions/reports/корень
ИСТОЧНИКИ: /root/vault/objects /root/vault/decisions /root/vault/reports /root/vault/dashboard.md /root/vault/_server-map.md /root/vault/_current-task.md
ФАЙЛЫ ВОЛНЫ: /opt/distill/files-wave-2a.txt
ВЫХОДНОЙ ФАЙЛ: /opt/distill/notes-wave-2a.jsonl
ЗАНЯТЫЕ ЗАМЕТКИ: /opt/distill/notes-existing.txt" \
  --model opus \
  --permission-mode default \
  --allowedTools "Read" "Glob" "Grep" "Write"
```

`--permission-mode default` оставлен сознательно: если агент всё-таки попросит
инструмент вне списка, запуск встанет на запросе, а не тихо расширит себе права.

Перед следующим шагом **обязательно** пролистать результат глазами:
`wc -l /opt/distill/notes-wave-2a.jsonl` и весь файл целиком — это единственная
точка, где человек видит, что именно уезжает в долгую память. Плюс прочитать
ведомость покрытия из финального ответа: файл без ведомости не принимается.

### 4. Dry-run — по КОПИИ, не по боевой базе

Скрипты вызываются **по абсолютному пути и не зависят от cwd** — `cd` в каталог
репозитория не нужен ни здесь, ни на шагах 5 и 6.

```bash
node /root/t3-telegram/deploy/rick/memory-import/import-notes.mjs \
  --input /opt/distill/notes-wave-2a.jsonl \
  --db /root/.operator/operator.db.distill-copy --dry-run --verbose
```

`--dry-run` и сам работает на временной копии переданного файла, так что копия
из шага 2в остаётся нетронутой — двойная защита. Боевая база на этом шаге
не фигурирует ни одной командой.

Критерий сдачи волны: **«отклонено строк: 0» И «ошибок записи: 0»**. Отклонённые
строки (кривой JSON, длинный `content`, `description` без стрелки, дубль ключа,
похожее на секрет) чинятся в `notes-wave-<N>.jsonl`, и dry-run повторяется.

Про раздел «Требует решения человека» (`merge-proposal`): в общем случае это
почти-дубли, которые writer сознательно не пишет. Но на боксе Рика семантический
дедуп у writer включается **только** при живом MiniLM
(`isSemanticDedupeAvailable()`), а на `local-hash-v4` он выключен целиком;
второй путь к merge-proposal — занятый `key` при `source='distilled'`, а
импортёр `distilled` не пускает. Значит, всё, что здесь окажется, — **ошибки
записи**, и чинить их обязательно. Следствие: один и тот же факт под двумя
разными `key` (`rick-city` и `rick-tbilisi`) уедет в базу дважды и никто не
возразит. Ловить дубли придётся глазами по `notes-wave-<N>.jsonl` и по
`notes-existing.txt` — это и есть смысл пункта «Дубли» в `DISTILL-PROMPT-v2.md`.

### 5. Импорт

```bash
node /root/t3-telegram/deploy/rick/memory-import/import-notes.mjs \
  --input /opt/distill/notes-wave-2a.jsonl \
  --db /root/.operator/operator.db --verbose
```

Прогон идемпотентен: повторный запуск с тем же файлом даёт «без изменений»
(replay по `operation_key`), а изменённый `content` при том же `key` создаёт
новую версию и переводит старую в `superseded` — как это делает сам бот.

Полезные флаги: `--limit N` (потолок записей за прогон, по умолчанию 2000),
`--source manual|maintenance|system`, `--db`, `--dry-run`, `--verbose`.
Лимиты на запись: строка JSONL ≤8 КБ, `key` ≤120 символов, `description` ≤120,
`content` ≤200 (это потолки схемы, не выдумка импортёра), `category` ≤80.

### 6. Проверка — после каждого боевого импорта

Прогоняется **не в конце всего процесса, а после импорта каждой волны**:
дешевле поймать пустую волну сразу, чем разбирать пять волн задним числом.
`--query` берётся из приёмочных вопросов этой волны (2–3 штуки, раздел
«Приёмочные вопросы» в `DISTILL-PROMPT-v2.md`):

```bash
# волна 2a
V=/root/t3-telegram/deploy/rick/memory-import/verify.mjs
node "$V" --db /root/.operator/operator.db --query "Чепурнов"
node "$V" --db /root/.operator/operator.db --query "Молочный"
node "$V" --db /root/.operator/operator.db --query "Маша" --key client-masha-bot-live
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

Если verify по вопросам волны ничего не находит — волна прочитала источники
поверхностно; разбираться **до** запуска следующей. Когда волна принята,
цикл возвращается на шаг 2: параметры (список файлов, `notes-existing.txt`,
копия базы) снимаются заново, уже с учётом только что импортированного.

### 7. Живая проверка ботом (после последней волны)

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
