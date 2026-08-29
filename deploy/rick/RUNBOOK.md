# RUNBOOK — установка T3 Telegram Operator на бокс Рика

Бокс: `150.241.123.80`, Ubuntu, вход `ssh scout@150.241.123.80`.
Бот едет **под root**: `/root/t3-telegram`, env в `/root/.operator/operator.env`,
системные юниты в `/etc/systemd/system/`.

Что уже решено и не обсуждается по ходу установки:

* Claude CLI на боксе уже стоит (`/usr/bin/claude`, залогинен под подпиской Рика).
  Обёртки/локи не используем — бот зовёт бинарник напрямую.
* Node на боксе может быть старым. Ставим **свою** копию Node 24 в
  `/root/.local/toolchain`, системную не трогаем: от неё зависят чужие сервисы.
* Старый бот Рика — **`rick-bot` под pm2** (не systemd!): `PM2_HOME=/root/.pm2`,
  script `/root/run-bot.sh`, cwd `/root`, аптайм 16 дней на 27.08. Он держит тот
  же Telegram-токен. Два поллера на один токен дают 409 и отбирают апдейты друг у
  друга — переключение делается как один осознанный шаг (шаг 10), а не «оно само
  поднялось после установки». Юнита `takopi` в systemd на боксе **нет**; токен и
  состояние лежат в `/root/.takopi/`.
* `install.sh` **ничего не запускает**. Только собирает, раскладывает и `enable`.

Файлы пакета (все в `deploy/rick/`):

| Файл | Где выполняется |
| --- | --- |
| `sync-to-box.sh` | на нашем сервере |
| `install.sh` | на боксе, под root |
| `t3-telegram-operator.service`, `t3code-server.service` | ставит `install.sh` |
| `env` | шаблон, заполняется на шаге 6 |

**Порядок шагов и почему он именно такой.** Здесь есть естественная ловушка:
bearer-токен нужен для `env`, `env` нужен полному `install.sh`, но выпустить
bearer можно только собранным t3code, а собрать t3code — только Node 24, который
ставит тот же `install.sh`. Цикл разрывается флагом `--toolchain-only`:

```
3. sync-to-box.sh                 → исходники на боксе
4. install.sh --toolchain-only    → Node 24 + pnpm + vp        (env НЕ нужен)
5. vp i && vp build, auth session issue → bearer               (нужен только шаг 4)
6. заполнить operator.env                                       (нужен шаг 2 и 5)
7. install.sh (полный)            → сборка бота, юниты, enable  (нужен шаг 6)
```

Каждый следующий шаг опирается только на предыдущие; возвратных зависимостей нет.

## 🚨 Чужие процессы на том же pm2 — не трогать

На том же pm2 (`PM2_HOME=/root/.pm2`, под root) живут процессы **клиента Маши**:

```
masha-bot   masha-reply-watch   masha-vault-sync   potato-watch
```

Они не имеют отношения к этой установке. Остановка любого из них — инцидент у
клиента. Отсюда жёсткие правила на весь раннбук, включая откат и аварийные
действия:

* **Запрещены** `pm2 stop all`, `pm2 restart all`, `pm2 delete all`, `pm2 kill`,
  `pm2 update`, а также `systemctl stop/disable pm2-root` — pm2-демон общий, он
  нужен Машиным процессам.
* Любая команда pm2 — **только с явным именем процесса**: `pm2 stop rick-bot`,
  и никак иначе.
* `pm2 save` перезаписывает общий dump со списком автозапуска: делать его
  только сразу после осознанного `stop`/`start` конкретного процесса и только
  убедившись, что `pm2 list` показывает Машины процессы **online**.

⚠️ Бот будет работать под root с `OPERATOR_FULL_ACCESS=true` и
`T3_RUNTIME_MODE=full-access`. Всё, что прилетит боту в личку, попадает в shell
на боксе с правами root. Перед стартом убедиться, что `TELEGRAM_ALLOWED_USER_ID`
— это ровно Рик, и что владелец бокса понимает, что даёт.

---

## Шаг 1. Разведка бокса

Проведена 27.08.2026 под `scout`. Результаты вписаны ниже как «✓ проверено» —
перепроверять их целиком не нужно, но перед установкой стоит убедиться, что
картина не изменилась (особенно состав pm2).

```bash
ssh scout@150.241.123.80
. /etc/os-release && echo "$PRETTY_NAME $(uname -m)"; nproc; free -h; df -h /root /home
sudo -n true && echo "sudo: passwordless" || echo "sudo: нужен пароль"   # ✓ passwordless

# Старый бот — pm2, НЕ systemd. Смотреть весь список и запомнить чужие процессы.
sudo env PM2_HOME=/root/.pm2 pm2 list
sudo env PM2_HOME=/root/.pm2 pm2 describe rick-bot | grep -Ei 'script|exec cwd|uptime|status'
# pm2 обычно прописан в systemd через `pm2 startup`. Проверить — да; трогать — НЕТ:
# демон общий с процессами Маши.
systemctl list-units | grep -i pm2
# systemd-юнита старого бота нет, но убедиться, что не появился:
systemctl list-units --type=service --state=running | grep -Ei 'takopi|telegram|t3|bot'
systemctl --user list-units 2>/dev/null | grep -Ei 'takopi|telegram|bot'

# бинарники, на которые ссылается env
for b in /usr/bin/claude /usr/bin/ffmpeg /usr/bin/ffprobe /usr/bin/tesseract \
         /usr/bin/pdftotext /usr/bin/pdftoppm; do
  [ -x "$b" ] && echo "OK   $b" || echo "НЕТ  $b"
done
node -v 2>/dev/null || echo "системного node нет"    # ✓ v20.20.2 — пинованный 24 обязателен
ss -lntp | grep -E ':3773|:8081' || echo "3773/8081 свободны"

# git нужен на боксе: sync-to-box.sh разворачивает бандл через git clone
command -v git || echo "НЕТ git — sync-to-box.sh упадёт на промоуте в /root"
# node-pty (зависимость t3code) не имеет linux-prebuild и собирается node-gyp
for t in cc make python3; do command -v $t >/dev/null || echo "НЕТ $t"; done
# сеть: install.sh тянет Node с nodejs.org, pnpm/vp — с реестра npm
curl -sS -o /dev/null -w 'nodejs.org %{http_code}\n' https://nodejs.org/dist/index.json
curl -sS -o /dev/null -w 'registry.npmjs.org %{http_code}\n' https://registry.npmjs.org/pnpm
```

**Что показала разведка 27.08 (✓ — можно не перепроверять):**

| Факт | Значение |
| --- | --- |
| Старый бот | pm2-процесс `rick-bot`, `PM2_HOME=/root/.pm2`, script `/root/run-bot.sh`, cwd `/root`, uptime 16 дней |
| systemd-юнит старого бота | ✓ отсутствует (никакого `takopi.service`) |
| Чужое на том же pm2 | `masha-bot`, `masha-reply-watch`, `masha-vault-sync`, `potato-watch` — **не трогать** (см. врезку выше) |
| Спорное на том же pm2 | `brain-monitor`, `session-watchdog` — часть старого стека Рика, разбираемся на шаге 10 |
| sudo у `scout` | ✓ passwordless |
| `git`, `cc`, `make`, `python3` | ✓ есть |
| `docker`, `ffmpeg`, `/usr/bin/claude` | ✓ есть |
| `tesseract` | ✗ **нет** — см. ниже |
| Системный node | v20.20.2 → пинованный Node 24 обязателен |
| Токен и стейт старого бота | `/root/.takopi/takopi.toml`, `takopi.lock`, state-json |

**Осталось проверить руками:** (а) состав `pm2 list` не изменился с 27.08,
(б) свободен ли порт 3773, (в) >= 10 ГБ свободных на `/root` (одни только
`node_modules` t3code — 3.1 ГБ, дерево — 375 МБ, Node — 380 МБ), (г) выход на
nodejs.org и registry.npmjs.org.

> Нет выхода на nodejs.org или registry.npmjs.org: везти тулчейн офлайн —
> `sync-to-box.sh --with-node` на шаге 3, подхватывается на шаге 4 вместе с
> `pnpm` и `vp`. Выход на registry.npmjs.org остаётся нужен для `pnpm install`
> самого бота и `vp i` в t3code — офлайн-режим закрывает только тулчейн.

**Предусловие, которое надо закрыть до шага 7** (tesseract на боксе нет, а
`install.sh` ругнётся на отсутствующий `/usr/bin/tesseract`):

```bash
sudo apt-get install -y tesseract-ocr tesseract-ocr-rus
```

либо сознательно поставить `OCR_ENABLED=false` в `env` на шаге 6 — тогда бот не
распознаёт текст на картинках, остальное работает. `ffmpeg`/`poppler-utils` уже
есть, доустанавливать нечего.

**Откат:** нечего откатывать, ничего не менялось (кроме `apt-get install`
tesseract — он ничего не ломает).

---

## Шаг 2. Найти секреты старого бота (не выписывая их)

Токен у Рика уже есть — это тот же бот, которого сейчас крутит `rick-bot`.
Он лежит на боксе, в `/root/.takopi/takopi.toml`, в секции
`[transports.telegram]` (поле со словом `token`). Забирать его «на руки» не надо
и не нужно: на шаге 6 он **копируется прямо на боксе** из toml в
`operator.env`, минуя терминал, историю команд и любые логи.

Здесь достаточно убедиться, что источник на месте и читается:

```bash
ssh scout@150.241.123.80
sudo test -f /root/.takopi/takopi.toml && echo "takopi.toml на месте"
# только имя ключа и длина значения — само значение НЕ печатаем
sudo grep -nE '^[[:space:]]*[a-z_]*token' /root/.takopi/takopi.toml | sed 's/=.*/= <скрыто>/'
sudo ls -la /root/.takopi/          # takopi.lock, state-json — входы для шага 9
```

`TELEGRAM_ALLOWED_USER_ID` искать не нужно: chat_id Рика **236366316** уже
вписан в локальный шаблон `deploy/rick/env`. На шаге 6 останется только сверить
это число глазами.

**Проверка успеха:** `takopi.toml` существует, `grep` нашёл строку с `token`
(значение при этом нигде не отображено).

⚠️ Не выводить содержимое `takopi.toml` целиком в терминал: сессия
записывается, а токен даёт полный контроль над ботом Рика.

**Откат:** ничего не меняли — шаг чисто читающий.

---

## Шаг 3. Синхронизация кода с нашего сервера

Выполняется **у нас**, не на боксе.

```bash
cd /home/agent/t3-telegram
git status --porcelain                 # всё нужное закоммичено? bundle везёт только main
./deploy/rick/sync-to-box.sh --dry-run # прогон без записи; sudo на боксе не нужен вообще
./deploy/rick/sync-to-box.sh           # добавить --with-node, если бокс не ходит на nodejs.org
```

Перед передачей данных скрипт проверяет на боксе наличие `git` (бандл
разворачивается через `git clone`) и `cc`/`make`/`python3` (node-pty собирается
node-gyp во время сборки t3code). Если чего-то нет — падает **до** заливки с
подсказкой `sudo apt-get install -y git build-essential python3`.

Если у `scout` нет passwordless sudo, промоут в `/root` невозможен. Тогда:

```bash
./deploy/rick/sync-to-box.sh --stage-only   # заливает только в /home/scout/t3-stage
```

`--stage-only` не требует sudo вообще и печатает готовую последовательность
ручного промоута — её же см. в разделе «Ручной промоут стейджа» в конце файла.
Владелец бокса выполняет её под root, после чего идём на шаг 4.

Что уезжает и почему именно так:

* **t3-telegram** — `git bundle` только ветки `main`. В нашем `.git` 236 рефов,
  из них ~230 `refs/t3/checkpoints/*` (потурновые снапшоты агента) — на боксе
  они бесполезны и утаскивают рабочую историю. Бандл везёт ровно один реф, по
  построению не может утянуть `.env`, `*.db`, `node_modules`, `.claude/`, а на
  боксе разворачивается в настоящий репозиторий: `git log` отвечает на вопрос
  «что задеплоено», следующее обновление — новый бандл и `git pull`.
  Плата: незакоммиченное не едет. Это и требовалось.
* **t3code-verf** — rsync рабочего дерева без `.git` (316 МБ, 1270 рефов чужой
  истории) и без `node_modules` (3.1 ГБ). Нам нужно только дерево, которое
  прожуёт `vp run --filter t3 build`; задеплоенный коммит пишется в
  `/root/t3code-verf/VERSION`.
* `deploy/rick/` едет отдельным rsync-ом (папка не в git), режим `0600` на `env`.
* `deploy/rick/memory-import/` едет по белому списку: только `*.mjs`, `*.md` и
  `example.jsonl`. Рабочие выгрузки агента импорта (`*.db`, реальные `*.jsonl`,
  дампы) на бокс не уезжают по построению, а не «если не забыли исключить».

При повторных заливках промоут сравнивает SHA бандла с тем, что развёрнуто в
`/root/t3-telegram`, и при расхождении удаляет `/root/t3-telegram/dist` (так же,
как удаляет `apps/server/dist` t3code при смене `VERSION`) — иначе `install.sh`
счёл бы старую сборку свежей. Подробности — в шпаргалке «Обновить код».

**Проверка успеха:** скрипт напечатал `bot at <sha>` и `t3code at <sha>`
(в режиме `--stage-only` этих строк нет — там успех = файлы в
`/home/scout/t3-stage` и выполненный вручную промоут); на боксе

```bash
ssh scout@150.241.123.80 'sudo ls -la /root/t3-telegram /root/t3code-verf | head'
ssh scout@150.241.123.80 'sudo git -C /root/t3-telegram log --oneline -1'
```

**Откат:** `sudo rm -rf /root/t3-telegram /root/t3code-verf /root/t3-stage
/root/t3-telegram.bundle /home/scout/t3-stage` — на этом шаге ещё ничего не
запущено и не установлено. (Если откатываешься не начисто, а к предыдущей
версии, стейдж и бандл лучше оставить: см. шаг 12.)

---

## Шаг 4. Тулчейн: первый прогон `install.sh --toolchain-only`

Ставит **только** Node 24, `pnpm` и `vp` в `/root/.local/toolchain`. Не смотрит на
`env`, ничего не собирает, юниты не трогает — поэтому запускается до того, как
появился bearer-токен. Системный Node не трогается ни в одном варианте: от него
зависят чужие сервисы.

```bash
sudo -i
/root/t3-telegram/deploy/rick/install.sh --toolchain-only
```

Откуда берётся Node:

1. **Онлайн (по умолчанию):** качается официальный тарболл
   `https://nodejs.org/dist/v24.13.1/node-v24.13.1-linux-x64.tar.xz`, sha256
   сверяется с `SHASUMS256.txt` оттуда же. Чтобы сделать проверку по-настоящему
   защищённой от подмены, один раз возьми полученный хеш из вывода и пропиши в
   `install.sh` (`NODE_SHA256=`) либо передай `NODE_SHA256=... ./install.sh`.
   `pnpm` и `vite-plus@0.2.2` в этом случае ставятся с registry.npmjs.org.
2. **Офлайн:** `./sync-to-box.sh --with-node` (шаг 3) кладёт нашу проверенную
   копию в `/root/t3-stage/toolchain/`: и рантайм `node-v24.13.1-linux-x64/`,
   и global-префикс `global/` с `pnpm` и `vp`. `install.sh` видит
   `/root/t3-stage/toolchain/global/bin/pnpm` и делает rsync в
   `/root/.local/toolchain/global` вместо `npm install -g` из сети. Сеть при
   этом не нужна ни на nodejs.org, ни на registry.npmjs.org.

**Проверка успеха:**

```bash
/root/.local/toolchain/node-v24.13.1-linux-x64/bin/node -v   # v24.13.1
/root/.local/toolchain/global/bin/pnpm --version
/root/.local/toolchain/global/bin/vp --version
```

Требование жёсткое: `node:sqlite` нужен >= 24.2, монорепо t3code пинует `^24.13.1`.

**Откат:** `sudo rm -rf /root/.local/toolchain`. Системный Node не менялся.

---

## Шаг 5. Сборка t3code и выпуск bearer-токена

Отдельно от полного `install.sh`, потому что токен нужен **до** заполнения env, а
сборка идёт ~6.5 минуты и её удобно смотреть глазами. Всё, что нужно этому шагу,
уже стоит после шага 4.

```bash
sudo -i
export PATH=/root/.local/toolchain/node-v24.13.1-linux-x64/bin:/root/.local/toolchain/global/bin:$PATH
export NPM_CONFIG_PREFIX=/root/.local/toolchain/global
vp --version                            # поставлен шагом 4

cd /root/t3code-verf
time vp i
time vp run --filter t3 build          # ~6.5 мин
ls -l apps/server/dist/bin.mjs

# bearer на год для бота
node /root/t3code-verf/apps/server/dist/bin.mjs auth session issue --ttl 365d
```

**Проверка успеха:** есть `apps/server/dist/bin.mjs`, команда `auth session issue`
напечатала токен. Токен — это доступ к запуску агентов на боксе; в буфер, в env,
больше никуда.

**Откат:** `rm -rf /root/t3code-verf/apps/server/dist /root/t3code-verf/node_modules`
и пересобрать. Выпущенные сессии смотрятся и отзываются:
`node .../bin.mjs auth session list` / `auth session revoke <id>`.

---

## Шаг 6. Заполнение env

```bash
sudo -i
install -d -m 0700 /root/.operator
install -m 0600 /root/t3-telegram/deploy/rick/env /root/.operator/operator.env
```

Сначала — **токен, не глядя на него**. Он переезжает из `takopi.toml` (шаг 2)
прямо в env: значение не попадает ни в терминал, ни в историю, ни в лог.

```bash
umask 077
TOKF=/root/.operator/.tok        # временный файл 0600, удаляется ниже

# 1. Достать значение поля *token из секции [transports.telegram].
#    sed 's/#.*//' — срезает инлайновый TOML-комментарий (token = "..."  # старый).
#    tr -d — кавычки, пробелы и \r (файл может быть в CRLF; \r в токене
#    проходит валидацию zod, демон стартует и молча не поллит).
sed -n '/^\[transports\.telegram\]/,/^\[/p' /root/.takopi/takopi.toml \
  | grep -m1 -E '^[[:space:]]*[a-z_]*token[[:space:]]*=' \
  | cut -d= -f2- | sed 's/#.*//' | tr -d ' "'"'"'\r\n' > "$TOKF"

tok=$(cat "$TOKF")

# 2. Жёсткая валидация ДО записи. Пустой/битый токен, записанный в env, — это
#    юнит, который стартует и падает по кругу ровно в окне простоя.
if [[ ! "$tok" =~ ^[0-9]{6,}:[A-Za-z0-9_-]{30,}$ ]]; then
  echo "токен не извлёкся (len=${#tok}) — СТОП: открыть takopi.toml и найти поле вручную"
  shred -u "$TOKF"; unset tok
  exit 1     # да, закрывает root-шелл: это и есть стоп, дальше по инерции нельзя
fi
echo "ok: len=${#tok} tail=...${tok: -4}"    # эталон длины ~46; само значение не печатаем

# 3. Записать в env, не пропуская значение через argv (ps/proc его не увидят:
#    awk читает токен из файла, а не из -v/командной строки).
awk 'NR==FNR { tok=$0; next }
     /^TELEGRAM_BOT_TOKEN=/ { print "TELEGRAM_BOT_TOKEN=" tok; next }
     { print }' "$TOKF" /root/.operator/operator.env > /root/.operator/operator.env.new
mv /root/.operator/operator.env.new /root/.operator/operator.env
chmod 0600 /root/.operator/operator.env

# 4. Убрать следы
shred -u "$TOKF"; unset tok TOKF; history -c 2>/dev/null || true
```

Остальное — руками:

```bash
"${EDITOR:-nano}" /root/.operator/operator.env
```

| Переменная | Откуда |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | шаг 2, подставлен командой выше — глазами не сверяем, проверяем `grep -c __FILL__` |
| `OWNER_TIMEZONE` | спросить Рика; IANA-зона, напр. `Europe/Moscow`. Пустая = UTC, и все «завтра в 9» уедут |
| `T3_BEARER_TOKEN` | шаг 5 |
| `OPENROUTER_API_KEY` | Илья выпускает отдельно под Рика |

`TELEGRAM_ALLOWED_USER_ID` в шаблоне уже стоит: **236366316** (chat_id Рика,
вписан у нас). Сверить число — и не трогать: именно оно решает, кого бот
слушает, а бот работает под root.

Разведка шага 1 добавляет одно решение: если `tesseract-ocr` так и не поставлен,
здесь же раскомментировать готовую строку `# OCR_ENABLED=false` в шаблоне —
иначе `install.sh` предупредит, а бот будет спотыкаться на картинках. Остальные пути медиа-бинарников (`ffmpeg`,
`poppler`) на боксе проверены и совпадают с шаблоном.

**Проверка успеха:**

```bash
# только реальные присваивания; в шапке шаблона слово __FILL__ есть в комментарии
grep -cE '^[^#]*__FILL__' /root/.operator/operator.env   # должно быть 0
grep -c '^TELEGRAM_ALLOWED_USER_ID=236366316$' /root/.operator/operator.env  # 1
stat -c '%a %U:%G' /root/.operator/operator.env   # 600 root:root

# токен: длина и отсутствие мусора, без показа значения.
# эталон — 45-46 символов вида <10 цифр>:<35 символов>; \r в конце быть не должно
awk -F= '/^TELEGRAM_BOT_TOKEN=/{print "len=" length($2)}' /root/.operator/operator.env
grep -c $'\r' /root/.operator/operator.env        # 0 — иначе строки поедут в systemd
```

**Откат:** `shred -u /root/.operator/operator.env` и заполнить заново из шаблона.

---

## Шаг 7. Полный прогон `install.sh`

```bash
sudo /root/t3-telegram/deploy/rick/install.sh
```

Скрипт идемпотентен, гоняется столько раз, сколько нужно. Он проверяет
предусловия (root, x86_64, наличие `claude`, обязательные утилиты, медиа-бинарники),
доводит тулчейн из шага 4 (если тот уже на месте — просто подтверждает),
создаёт `/root/.operator` (0700) и логи (0600), падает, если в env остались
`__FILL__`, делает `pnpm install --frozen-lockfile && pnpm build`, при
необходимости собирает t3code, проверяет, что `dist/main.mjs` реально появился,
кладёт юниты, делает `daemon-reload` и `enable`. **Бота не стартует.**

Секция 2 (тулчейн) выполняется и здесь, но повторно ничего не делает: Node уже
нужной версии узнаётся и пропускается, `pnpm`/`vp` уже в PATH.

Полезные переключатели: `BUILD_BOT=force|skip`, `BUILD_T3CODE=force|skip`
(любое другое значение — падение с внятным сообщением, а не тихий пропуск сборки).

**Проверка успеха:**

```bash
ls -l /root/t3-telegram/dist/main.mjs /root/t3-telegram/dist/001_initial.sql
systemctl cat t3-telegram-operator.service | head -5
systemctl is-enabled t3-telegram-operator t3code-server   # enabled enabled
systemctl is-active  t3-telegram-operator                 # inactive — так и надо
```

**Откат:**

```bash
sudo systemctl disable --now t3-telegram-operator t3code-server
sudo rm -f /etc/systemd/system/t3-telegram-operator.service \
           /etc/systemd/system/t3code-server.service
sudo systemctl daemon-reload
```

---

## Шаг 8. Запуск t3code-server

Поднимается до бота: бот при старте проверяет T3 и без него уходит в
деградированный режим (в логе `T3 unavailable`).

```bash
sudo systemctl start t3code-server
sleep 5
systemctl status t3code-server --no-pager
curl -sS --noproxy '*' -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3773/
ss -lntp | grep 3773
```

**Проверка успеха:** юнит `active (running)`, `curl` вернул 200/401 (не
`connection refused`), порт слушается **только на 127.0.0.1**. Наружу 3773
публиковать нельзя: это панель управления агентами без TLS.

**Откат:** `sudo systemctl stop t3code-server`. Бот переживёт: без T3 он остаётся
в прямом режиме Operator.

> В юните оператора у `t3code-server.service` только `After=`, без `Wants=`.
> Причина: юнит t3code ставится и включается лишь при наличии `/root/t3code-verf`,
> а `Wants=` на несуществующий юнит сыпал бы `Unit t3code-server.service not
> found` в журнал при каждом старте оператора. Автозапуск t3code обеспечивает его
> собственный `WantedBy=multi-user.target` (`enable` на шаге 7), порядок запуска
> — `After=`. Практическое следствие: `systemctl start t3-telegram-operator`
> вручную **не** поднимает t3code — его стартуют явно, как на этом шаге.

---

## Шаг 9. Импорт памяти — заглушка

Перенос памяти/истории старого бота выполняет **отдельный агент**, отдельной
процедурой. Здесь только точка встраивания: импорт делается **после** `install.sh`
и **до** первого старта оператора, пока БД в `/root/.operator` ещё пустая, —
иначе импортируемые записи придётся мержить с уже накопленными.

* Процедура и инструменты: `deploy/rick/memory-import/` — они едут на бокс
  вместе с `deploy/rick/` (шаг 3) и оказываются в
  `/root/t3-telegram/deploy/rick/memory-import/`. Владелец каталога — отдельный
  агент импорта; точный порядок команд смотреть в файлах оттуда, не выдумывать.
* Состояние живёт в `/root/.operator` (SQLite + артефакты).
* Перед импортом снять снапшот: `sudo tar czf /root/operator-preimport.tgz -C /root .operator`

**Входы на боксе (разведка 27.08) — читать, не менять:**

| Что | Путь | Объём |
| --- | --- | --- |
| Стейт старого бота | `/root/.takopi/` (`takopi.lock`, state-json) | мелочь |
| Сессии старого бота | `/root/.claude/projects/-root/` | 223 `*.jsonl`, 318 МБ |
| Vault Рика | `/root/vault/` | 1.4 ГБ |

Всё это принадлежит старому стеку и нужно старому боту, пока он жив (до шага 10):
импорт должен **только читать**. Пути пригодятся и как аргумент к тому, что шаг
12 (уборка) стейджа их не касается.

**Проверка успеха:** определяет процедура импорта.

**Откат:**

```bash
sudo systemctl stop t3-telegram-operator
# глоб раскрывает шелл вызывающего: под scout он не заглянет в 0700-каталог
# и rm получит несуществующий литерал. Раскрывать надо уже внутри root-шелла.
sudo bash -c 'rm -rf /root/.operator/*.db*'
sudo tar xzf /root/operator-preimport.tgz -C /root
```

---

## Шаг 10. Переключение `rick-bot` (pm2) → operator (systemd)

Единственный шаг с простоем. Делать целиком, не расходясь: пока оба бота
выключены, апдейты Telegram копятся, но не теряются.

🚨 **Читать перед любой командой pm2.** Демон pm2 общий: на нём висят
`masha-bot`, `masha-reply-watch`, `masha-vault-sync`, `potato-watch` — процессы
клиента, остановка которых равна инциденту. Здесь **нет** ни одной команды вида
`pm2 stop all` / `pm2 restart all` / `pm2 delete all` / `pm2 kill`, и добавлять
их нельзя — даже «чтобы наверняка». Каждая команда адресует процесс по имени.
`pm2-root.service` в systemd (если он есть) тоже не трогаем — он поднимает
Машины процессы после ребута.

### 10.0 Разобраться со спутниками

`brain-monitor` и `session-watchdog` — тоже root, тот же pm2, но это остатки
стека Рика, а не Машины. Решение принимается **до** остановки бота:

```bash
sudo env PM2_HOME=/root/.pm2 pm2 describe brain-monitor
sudo env PM2_HOME=/root/.pm2 pm2 describe session-watchdog
# смотреть script path и cwd; при необходимости прочитать сам скрипт
```

* обслуживают **только** `rick-bot` и его сессии → гасим вместе с ним (команды в
  10.2, они закомментированы — раскомментировать осознанно);
* есть хоть какое-то сомнение (трогают `/root/vault`, Машины пути, общий
  мониторинг) → **оставляем работать** и записываем в «Известные хвосты» внизу
  этого шага. Лишний живой вотчдог безобиднее, чем сломанный чужой сервис.

### 10.1 Зафиксировать откат

```bash
sudo -i
export PM2_HOME=/root/.pm2

# Снимок ДО в формате «имя + статус» — именно с ним сравнивает шаг 11.
# jq на боксе не проверен; fallback — node (он там точно есть, на нём же
# крутится сам pm2). Голым grep по jlist парсить нельзя: поле "name" есть и
# на верхнем уровне, и внутри pm2_env, пары разъезжаются.
pm2_snapshot() {
  if command -v jq >/dev/null 2>&1; then
    pm2 jlist | jq -r '.[] | "\(.name) \(.pm2_env.status)"' | sort
  else
    pm2 jlist | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));
      for (const p of j) console.log(p.name, p.pm2_env.status)' | sort
  fi
}

pm2_snapshot > /root/.operator/pm2-before.txt
cat /root/.operator/pm2-before.txt      # доказательство, что Машины процессы были online
pm2 describe rick-bot > /root/.operator/rick-bot-before.txt

# Дамп автозапуска. Его может не быть вовсе (если `pm2 startup`/`pm2 save`
# никогда не делали) — тогда бэкапить нечего, а первый же `pm2 save` в 10.2
# СОЗДАСТ автозапуск, которого раньше не было, и после ребута pm2 начнёт
# поднимать Машины процессы сам. Это изменение чужого поведения — записать
# в «Известные хвосты» и предупредить владельца бокса.
if [ -f /root/.pm2/dump.pm2 ]; then
  cp -a /root/.pm2/dump.pm2 /root/.operator/dump.pm2.bak
  echo "дамп сохранён в /root/.operator/dump.pm2.bak"
else
  echo "ВНИМАНИЕ: /root/.pm2/dump.pm2 нет — pm2 save в 10.2 создаст его впервые;"
  echo "записать в известные хвосты, что автозапуск pm2 появился в этой установке"
fi
```

### 10.2 Погасить старого

```bash
pm2 stop rick-bot                 # именно stop, не delete: конфиг остаётся
pm2 save                          # иначе rick-bot воскреснет через pm2 resurrect после ребута

# спутники — только если 10.0 показал, что они исключительно про rick-bot:
# pm2 stop brain-monitor && pm2 save
# pm2 stop session-watchdog && pm2 save

pm2 list                          # rick-bot stopped; masha-* и potato-watch — online
# что реально попало в автозапуск после save — Машины процессы должны остаться
grep -o '"name":"[^"]*"' /root/.pm2/dump.pm2
pgrep -af 'run-bot.sh|takopi' || echo "процессов старого бота нет"
```

Если `pm2 list` показывает Машины процессы не `online` — **остановиться и
разбираться**, дальше не идти.

### 10.3 Поднять нового

В новом шелле сначала: `sudo -i` и `export PM2_HOME=/root/.pm2` (переменная из
10.1 живёт только в том сеансе).

```bash
systemctl start t3-telegram-operator
sleep 10
journalctl -u t3-telegram-operator -n 20 --no-pager
```

**Проверка успеха:**

* `pm2 list`: `rick-bot` — `stopped`, `masha-bot`, `masha-reply-watch`,
  `masha-vault-sync`, `potato-watch` — `online` (сверить с `pm2-before.txt`);
* процессов `/root/run-bot.sh` нет;
* в логе оператора нет `409` и нет `Telegram polling conflict persists`.

**Откат (полный, за 30 секунд).** В новом шелле сначала `sudo -i` и
`export PM2_HOME=/root/.pm2` — без этой переменной pm2 полезет в `~/.pm2`
вызывающего и «не увидит» ни одного процесса:

```bash
sudo -i
export PM2_HOME=/root/.pm2

systemctl stop t3-telegram-operator     # сначала отпустить токен
pm2 start rick-bot
# и спутники, если гасили их в 10.2:
# pm2 start brain-monitor
# pm2 start session-watchdog
pm2 save
pm2 list                                # rick-bot online, Машины процессы online
```

Токен возвращается старому боту, оператор остаётся установленным и выключенным.
Если что-то пошло совсем не так, список автозапуска восстанавливается из
`/root/.operator/dump.pm2.bak` (`cp -a` обратно в `/root/.pm2/dump.pm2`) — но и
это **не** повод для `pm2 resurrect` при живых Машиных процессах: resurrect
поднимает всё из дампа скопом.

**Известные хвосты** (заполнить по итогам шага):

* `brain-monitor` / `session-watchdog` — оставлены работать / остановлены, дата и
  причина (итог 10.0);
* был ли `/root/.pm2/dump.pm2` до нас (итог 10.1). Если его не было, `pm2 save`
  создал автозапуск впервые: теперь после ребута pm2 сам поднимет процессы из
  дампа, включая Машины. Поведение чужих сервисов изменилось — предупредить
  владельца бокса и записать сюда.

> Пока не сделан шаг 12, на боксе ещё лежат `/home/scout/t3-stage`,
> `/root/t3-stage` и `/root/t3-telegram.bundle` — это полная копия того, что
> приехало. Из них можно переразвернуть или сравнить дерево, не гоняя sync
> заново (`git clone -b main /root/t3-telegram.bundle …`). Поэтому уборка идёт
> последним шагом, а не сразу после установки.

---

## Шаг 11. Smoke-проверки

```bash
# 1. Юниты
systemctl status t3code-server t3-telegram-operator --no-pager | head -30
systemctl is-active t3code-server t3-telegram-operator     # active active

# 2. Лог инициализации: обе строки обязательны
sudo tail -n 200 /root/.operator/operator.log | grep -E 'Operator initialized|Telegram polling started'
```

Ожидаемое:

* `"Operator initialized"` — с полями `telegram: <username бота>`, `t3: true`,
  `runtime: ...`. `t3: false` означает, что шаг 8 не доехал.
* `"Telegram polling started"` — с `username` бота. Без неё апдейты не читаются.

```bash
# 3. Чего быть не должно
sudo grep -E '"level":50|"level":60|409|Conflict|ECONNREFUSED' /root/.operator/operator.log | tail -20

# 4. Живучесть
sudo systemctl restart t3-telegram-operator && sleep 15 && \
  sudo tail -n 50 /root/.operator/operator.log | grep 'Telegram polling started'

# 5. Переживёт ли перезагрузку
systemctl is-enabled t3code-server t3-telegram-operator    # enabled enabled

# 6. Чужие процессы целы — обязательный пункт, а не формальность.
# Сравниваем только имя+статус: `pm2 list` шумит uptime/cpu/mem и diff по нему
# всегда красный. Формат тот же, что снял pm2_snapshot в 10.1.
sudo -i
export PM2_HOME=/root/.pm2
if command -v jq >/dev/null 2>&1; then
  pm2 jlist | jq -r '.[] | "\(.name) \(.pm2_env.status)"' | sort > /root/.operator/pm2-after.txt
else
  pm2 jlist | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));
    for (const p of j) console.log(p.name, p.pm2_env.status)' | sort > /root/.operator/pm2-after.txt
fi
diff /root/.operator/pm2-before.txt /root/.operator/pm2-after.txt
# Ожидаемая разница — ТОЛЬКО строка rick-bot (online -> stopped) и, если гасили,
# спутники. masha-bot, masha-reply-watch, masha-vault-sync, potato-watch
# обязаны остаться online.
```

**7. Проверка из Telegram** (делает Рик со своего аккаунта):

* `/status` → бот отвечает карточкой активной и недавней работы;
* обычное сообщение («привет, что ты умеешь») → осмысленный ответ по-русски;
* сообщение с **чужого** аккаунта → бот молчит (сработал `TELEGRAM_ALLOWED_USER_ID`,
  он же 236366316);
* голосовое → расшифровка (если `OPENROUTER_API_KEY` заполнен).

**Проверка успеха:** все семь пунктов зелёные.

**Откат:** шаг 10, откат целиком.

---

## Шаг 12. Уборка стейджа

Делается **только** после зелёного шага 11. До этого момента стейдж — законный
материал для отката (см. врезку в шаге 10).

Что убираем и почему:

* `/home/scout/t3-stage` — здесь лежит копия `deploy-rick/env` в домашнем
  каталоге непривилегированного пользователя. Telegram-токен в него по нынешней
  процедуре не попадает (он копируется из `takopi.toml` прямо в
  `/root/.operator/operator.env` на шаге 6), но там уже есть chat_id Рика,
  `OBSERVABILITY_HASH_SALT` и всё, что заполнили в шаблоне до отправки —
  например `OPENROUTER_API_KEY`. Держать это в `/home/scout` дольше нужного
  незачем. Главная причина шага.
* `/root/t3-telegram.bundle` — копия репозитория, уже развёрнутая в
  `/root/t3-telegram`.
* `/root/t3-stage` — офлайновый тулчейн (~380 МБ), уже установленный в
  `/root/.local/toolchain`.

С нашего сервера:

```bash
cd /home/agent/t3-telegram
./deploy/rick/sync-to-box.sh --cleanup
```

Либо руками на боксе:

```bash
rm -rf /home/scout/t3-stage
sudo rm -rf /root/t3-stage /root/t3-telegram.bundle
```

**Проверка успеха:**

```bash
ssh scout@150.241.123.80 'ls -d /home/scout/t3-stage 2>/dev/null; sudo ls -d /root/t3-stage /root/t3-telegram.bundle 2>/dev/null'
# пусто
systemctl is-active t3code-server t3-telegram-operator   # active active — уборка ни на что не влияет
```

**Откат:** отката нет и не нужен: `/root/t3-telegram`, `/root/t3code-verf`,
`/root/.operator` и `/root/.local/toolchain` не тронуты. Если стейдж понадобится
снова — это просто новый `sync-to-box.sh`.

---

## Шаг 13. Скиллы и гейт расходов (и только потом — higgsfield)

Делается после зелёного шага 11; к установке не привязан и откатывается одной
строкой в env. Здесь важен **порядок**, и он не косметический.

**Почему сначала гейт.** `higgsfield` — это платная генерация. Правило бизнеса:
агент не тратит деньги владельца сам. Единственное, что может встать между
агентом и платным MCP-инструментом, — `PreToolUse`-хук, а хуки приезжают только
через `OPERATOR_CLAUDE_SETTINGS`. Если сначала включить MCP, а хук «потом», то
между «потом» и «сейчас» лежит окно, в котором агент может сгенерировать что
угодно на деньги Рика, и узнаем мы об этом из счёта.

**От чего этот гейт защищает, а от чего нет.** Он защищает от невнимательного
агента: тот, кто просто «увлёкся» и пошёл генерировать, упрётся в отказ. Он **не**
защищает от целенаправленного: бот работает под root с `OPERATOR_FULL_ACCESS=true`,
то есть агент в принципе может переписать сам хук, `claude-settings.json` или
расшифровку хода, которую хук читает. Гейт живёт внутри радиуса поражения и
радиус не ограничивает.

**Настоящая граница трат — на стороне аккаунта Higgsfield.** Владельцу
рекомендуется выставить там лимит (кредитный потолок/спенд-кап) — это
единственное ограничение, которое держится против агента, который *хочет* его
обойти. Опционально (рекомендация, `install.sh` этого не делает — иначе он сам
перестанет обновлять эти файлы):

```bash
chattr +i /root/.operator/claude-settings.json /root/.operator/hooks/higgsfield-spend-gate.py
# снять перед обновлением: chattr -i <файлы>
```

**Что кладёт `install.sh`** (шаг 3 внутри него, идемпотентно):

| Файл на боксе | Права | Что это |
| --- | --- | --- |
| `/root/.operator/claude-settings.json` | 0600 root | `disableBundledSkills` + `PreToolUse` на `mcp__higgsfield__.*` |
| `/root/.operator/hooks/higgsfield-spend-gate.py` | 0600 root | сам гейт |
| `/root/.operator/claude-plugin/skills/` | 0700 root | пустой каталог под скиллы |

`install.sh` при этом **падает**, если нет `/usr/bin/python3` (хук, который
нельзя запустить, — это не отказ, а пропуск: `exit 127`), и прогоняет
установочный смоук: подаёт хуку образцовое `PreToolUse`-событие платного вызова
без цены и согласия и требует `deny` + `exit 2`. Гейт, который не гейтит, до
бокса не доезжает.

Права — не формальность: демон **отказывается** подключать и настройки, и
каталог скиллов, если владелец не root или файл доступен на запись кому-то ещё.
Файл хуков — это список команд, которые запускает CLI, а бот работает с
`OPERATOR_FULL_ACCESS=true`; «это писал root» — единственное, что отличает
курируемый набор от того, который агент дописал себе сам в прошлом ходу.

### 13.1. Включить настройки и скиллы (без higgsfield)

```bash
# на боксе, под root
grep -nE 'OPERATOR_CLAUDE_SETTINGS|OPERATOR_SKILLS_DIR|OPERATOR_EXTRA_MCP_CONFIG' /root/.operator/operator.env
# ожидаем: первые две строки заданы, OPERATOR_EXTRA_MCP_CONFIG ещё НЕТ или пуст
ls -l /root/.operator/claude-settings.json /root/.operator/hooks/higgsfield-spend-gate.py
stat -c '%U %a %n' /root/.operator /root/.operator/hooks /root/.operator/claude-plugin
# root, 0700 / 0600 — иначе демон откажет и напишет warn
systemctl restart t3-telegram-operator
```

Скиллы кладутся в `/root/.operator/claude-plugin/skills/<имя>/SKILL.md` —
именно с промежуточным `skills/`, это формат плагина, который читает CLI.
После добавления скилла рестарт не нужен: каталог перечитывается каждый ход.

**Проверка успеха:**

```bash
sudo grep -E 'curated settings|OPERATOR_SKILLS_DIR|OPERATOR_CLAUDE_SETTINGS' /root/.operator/operator.log | tail -5
# ожидаем "Attaching curated settings and skills to the Operator turn", без warn
```

В Telegram: `/debug` → строка `Claude settings: ok; skills: ok`. Затем попросить
бота назвать доступные ему скиллы — в списке должны быть только положенные в
`claude-plugin/skills`, без встроенных (`init`, `security-review`, …) и без
чего-либо из `~/.claude` Рика.

**Откат:** убрать обе строки из `operator.env`, `systemctl restart`. Бот
возвращается ровно к нынешнему поведению.

### 13.2. И только теперь — higgsfield

Не раньше, чем 13.1 зелёный. **Непосредственно перед тем, как дописывать
`OPERATOR_EXTRA_MCP_CONFIG`, повторить `/debug` и убедиться, что там
`Claude settings: ok`** — между 13.1 и 13.2 могли пройти дни, а `chmod`,
редактирование файла с ошибкой в JSON или перенос каталога снимают гейт молча.
Если строка не `ok` — сначала чинить её, MCP не подключать.

```bash
# на боксе, под root
install -m 0600 -o root -g root /dev/null /root/.operator/extra-mcp.json
# заполнить {"mcpServers": {"higgsfield": {...}}}
echo 'OPERATOR_EXTRA_MCP_CONFIG=/root/.operator/extra-mcp.json' >> /root/.operator/operator.env
systemctl restart t3-telegram-operator
```

⚠ **Имя сервера в `mcpServers` — ровно `higgsfield`, дословно.** От него зависят
и matcher в `claude-settings.json` (`"mcp__higgsfield__.*"`), и `TOOL_PREFIX` в
самом хуке: CLI склеивает имя инструмента как `mcp__<имя сервера>__<тул>`.
Назовёшь сервер `higgsfield-mcp`, `hf` или `higgsfield2` — matcher не совпадёт,
хук не запустится, и платные вызовы пойдут **без гейта**, ничего при этом не
сломав внешне. Переименование сервера = правка трёх мест одновременно.

Демон при этом держит пару «настройки + MCP» как один выключатель: если
`OPERATOR_CLAUDE_SETTINGS` не задан, недоступен, доступен на запись кому-то ещё
или не парсится как JSON — **ни один** extra-MCP сервер не подключается вовсе,
в лог уходит warn, а `/debug` показывает `Extra MCP: blocked (Claude settings: …)`.
Это закрывает единственную комбинацию, которую никто не выбрал бы осознанно:
платные инструменты есть, хука перед ними нет.

**Проверка успеха — обязательно живыми вызовами, а не чтением конфига:**

1. `/debug` → `Extra MCP: higgsfield` и `Claude settings: ok`.
2. Попросить бота сгенерировать картинку **без** упоминания цены. Ожидаемое
   поведение: генерация **не** происходит, бот спрашивает подтверждение
   стоимости. Если картинка приехала — гейт не работает; немедленно убрать
   `OPERATOR_EXTRA_MCP_CONFIG` и рестартовать.
3. Ответить «да» → генерация проходит.
4. **Негативный тест, обязательный:** снова попросить генерацию, дождаться
   вопроса о цене и ответить **отказом** — «стоп», «не надо», «да нет, не
   сейчас». Генерации быть не должно ни в каком виде. Если она произошла —
   гейт читает согласие не там, где надо: убрать `OPERATOR_EXTRA_MCP_CONFIG`,
   рестартовать, чинить.

Гейт пропускает платный вызов только когда выполнены **все** условия:

- инструмент не из списка бесплатных (`get_cost`, `balance`, `job_status` —
  перечислены полными именами). **Всё остальное под `mcp__higgsfield__`
  считается платным**, включая незнакомые имена и невинно выглядящие
  `remove_bg`, `preset_recommendation`, `list_*`: «выглядит бесплатным» — это
  ровно то, как через прошлую версию гейта проходила половина сервера;
- ровно `mcp__higgsfield__get_cost` был вызван **в этом же ходу** (после
  последнего сообщения владельца). Цена, названная до последней реплики
  владельца, — цена от другого разговора. На практике это значит: получил «да»
  → перепроверил цену → запускай;
- в **самом новом** `<<<inbound:…>>>`-ограждении последнего сообщения владельца
  есть явное согласие и нет отказа. Только оно: память агента, цитаты, текст
  воркеров, OCR приложенной картинки и пересланные сообщения приезжают в том же
  сообщении и подделываются. «Хорошо» и «понял» согласием не считаются, а «стоп»,
  «не надо», «нет», «дорого», «передумал» — блокируют, даже если рядом стоит
  «да» («да нет, не сейчас» — это отказ). В очереди сообщений решает последнее:
  «[1] да [2] отмени» — блок.

Любая нештатная ситуация — блок: пустое или неразбираемое событие, недоступная
расшифровка, отсутствие ограждения, внутренняя ошибка. Отказ уходит и в JSON,
и в `exit 2` со stderr — CLI считает блокирующим именно код 2, и путь, на
котором stdout теряется, раньше был молчаливым пропуском.

**Откат:** убрать `OPERATOR_EXTRA_MCP_CONFIG` из env, `systemctl restart`.
Настройки и скиллы (13.1) при этом остаются — они самостоятельны.

---

## Дежурная шпаргалка

| Задача | Команда |
| --- | --- |
| Логи бота | `sudo tail -f /root/.operator/operator.log` |
| Логи t3code | `sudo tail -f /root/.operator/t3code.log` |
| Рестарт | `sudo systemctl restart t3-telegram-operator` |
| Обновить код | см. «Обновить код» ниже |
| Что задеплоено | `sudo git -C /root/t3-telegram log --oneline -1`, `cat /root/t3code-verf/VERSION` |
| Отозвать доступ t3code | `node /root/t3code-verf/apps/server/dist/bin.mjs auth session list \| revoke <id>` |
| Полный откат на старого бота | `sudo systemctl stop t3-telegram-operator && sudo env PM2_HOME=/root/.pm2 pm2 start rick-bot && sudo env PM2_HOME=/root/.pm2 pm2 save` |
| Посмотреть pm2 | `sudo env PM2_HOME=/root/.pm2 pm2 list` — и **только по имени**: `pm2 stop rick-bot`. Никаких `all`/`kill`: там процессы Маши |

### Обновить код

```bash
# у нас
cd /home/agent/t3-telegram && git commit ...        # бандл везёт только коммиты main
./deploy/rick/sync-to-box.sh                        # или --bot-only / --t3code-only

# на боксе
sudo /root/t3-telegram/deploy/rick/install.sh
sudo systemctl restart t3code-server t3-telegram-operator
```

Про пересборку. `install.sh` с `BUILD_BOT=auto` считает `dist/` свежим, если
`dist/main.mjs` новее `pnpm-lock.yaml` — то есть чисто исходные правки он бы
проглядел. Поэтому **решение принимает промоут в `sync-to-box.sh`**: он помнит
SHA развёрнутого бандла и при его смене удаляет `/root/t3-telegram/dist`
(ровно так же, как удаляет `apps/server/dist` t3code при смене `VERSION`).
Следующий `install.sh` видит отсутствующий `dist` и пересобирает.

Следствия, которые надо держать в голове:

* обновление, доставленное **мимо** `sync-to-box.sh` (руками `git pull` на
  боксе), пересборку не вызовет — в этом случае явно: `BUILD_BOT=force install.sh`;
* `BUILD_BOT=skip` на пустом `dist` теперь падает не при старте юнита, а сразу:
  перед `enable` `install.sh` проверяет наличие `dist/main.mjs`;
* в выводе промоута ищи строки `bot sources changed … dist dropped` и
  `t3code sources changed … dist dropped` — это и есть команда на пересборку.

### Ручной промоут стейджа

Нужен, если у `scout` нет passwordless sudo и шаг 3 делался с `--stage-only`.
Выполняет владелец бокса под root; это ровно то, что иначе делает секция 6
`sync-to-box.sh`.

```bash
sudo -i
STAGE=/home/scout/t3-stage

install -d -m 0700 /root/.operator
install -d -m 0755 /root/.local /root/.local/toolchain

# 1. Бот: бандл -> /root/t3-telegram
old=$(git -C /root/t3-telegram rev-parse HEAD 2>/dev/null || echo none)
cp -f "$STAGE/t3-telegram-main.bundle" /root/t3-telegram.bundle
if [ -d /root/t3-telegram/.git ]; then
  git -C /root/t3-telegram fetch --update-head-ok /root/t3-telegram.bundle main:main
  git -C /root/t3-telegram checkout -f main && git -C /root/t3-telegram reset --hard main
else
  git clone -b main /root/t3-telegram.bundle /root/t3-telegram
fi
new=$(git -C /root/t3-telegram rev-parse HEAD)
[ "$old" != "$new" ] && rm -rf /root/t3-telegram/dist   # иначе install.sh не пересоберёт

# 2. deploy/rick поверх (он не в git)
install -d -m 0755 /root/t3-telegram/deploy
rsync -a "$STAGE/deploy-rick/" /root/t3-telegram/deploy/rick/
chmod 0700 /root/t3-telegram/deploy/rick
chmod 0600 /root/t3-telegram/deploy/rick/env
chmod 0755 /root/t3-telegram/deploy/rick/*.sh

# 3. t3code — только если он заливался (без --bot-only)
if [ -d "$STAGE/t3code-verf" ]; then
  oldv=$(cat /root/t3code-verf/VERSION 2>/dev/null || echo none)
  newv=$(cat "$STAGE/t3code-verf/VERSION" 2>/dev/null || echo unknown)
  rsync -a --delete --exclude=node_modules/ --exclude=apps/server/dist/ \
        "$STAGE/t3code-verf/" /root/t3code-verf/
  [ "$oldv" != "$newv" ] && rm -rf /root/t3code-verf/apps/server/dist
fi

# 4. офлайновый тулчейн — ТОЛЬКО если sync гонялся с --with-node
# (без него каталога нет, и rsync пустого источника снёс бы смысл проверки)
if [ -d "$STAGE/toolchain" ]; then
  install -d -m 0755 /root/t3-stage/toolchain
  rsync -a "$STAGE/toolchain/" /root/t3-stage/toolchain/
fi

chown -R root:root /root/t3-telegram /root/.operator
[ -d /root/t3code-verf ] && chown -R root:root /root/t3code-verf
chmod 0700 /root/.operator
```

Дальше — обычный шаг 4.

### Известные ограничения первой установки

* `DOCLING_ENABLED=false`. Docker на боксе, вопреки прежнему допущению, **есть**
  (разведка 27.08), так что ограничение снимаемо — но включать docling в первой
  установке не будем: это отдельный образ и отдельная проверка.
* `tesseract` на боксе изначально отсутствовал. Либо доставлен на шаге 1
  (`tesseract-ocr tesseract-ocr-rus`), либо в env стоит `OCR_ENABLED=false` —
  зафиксировать, что из двух.
* Старый `rick-bot` остаётся в pm2 в состоянии `stopped` (а не удалён): это цена
  тридцатисекундного отката. Удалять его конфиг можно только тогда, когда Рик
  подтвердит, что назад не хочет — и только `pm2 delete rick-bot`, по имени.
* `brain-monitor` / `session-watchdog` — если оставлены работать (шаг 10.0), они
  продолжают дёргать несуществующего `rick-bot` и могут писать ошибки в свои
  логи. Это известный хвост, а не поломка установки.
* Локальный Bot API (`TELEGRAM_API_BASE`) выключен: файлы больше 20 МБ Рику не
  приедут, пока не поднимем контейнер `telegram-bot-api --local`.
* `OBSERVABILITY_HASH_SALT` в `env` сгенерирован под этот бокс. Менять нельзя —
  поедут псевдонимы чатов в метриках.
