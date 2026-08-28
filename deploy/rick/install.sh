#!/usr/bin/env bash
# T3 Telegram Operator — installer for Rick's box (Ubuntu, runs as root).
#
# Copied to the box by sync-to-box.sh and run there:
#     sudo /root/t3-telegram/deploy/rick/install.sh [--toolchain-only]
#
# --toolchain-only installs just the Node 24 toolchain plus pnpm and vite-plus
# (vp) and stops. It exists to break the chicken-and-egg of the first install:
# the T3 bearer token goes into operator.env, but issuing it needs a built
# t3code, and building t3code needs the toolchain. So: toolchain-only run ->
# build t3code + issue bearer -> fill env -> full run. See RUNBOOK steps 4-7.
#
# Idempotent: safe to re-run after fixing whatever it complained about. It never
# starts the bot — starting is a separate, deliberate step in RUNBOOK.md, because
# two pollers on one Telegram token fight over updates (409) and the old bot
# (pm2 process `rick-bot`, PM2_HOME=/root/.pm2) must be stopped first. That pm2
# daemon also runs a client's processes (masha-*), so this script never touches
# pm2 at all — the switch is done by hand, by name, in RUNBOOK step 10.
set -euo pipefail

# ── Tunables ────────────────────────────────────────────────────────────────
NODE_VERSION="${NODE_VERSION:-24.13.1}"
NODE_DIST="node-v${NODE_VERSION}-linux-x64"
TOOLCHAIN_DIR="${TOOLCHAIN_DIR:-/root/.local/toolchain}"
NODE_HOME="${TOOLCHAIN_DIR}/${NODE_DIST}"
GLOBAL_PREFIX="${TOOLCHAIN_DIR}/global"

REPO_DIR="${REPO_DIR:-/root/t3-telegram}"
T3CODE_DIR="${T3CODE_DIR:-/root/t3code-verf}"
OPERATOR_HOME="${OPERATOR_HOME:-/root/.operator}"
ENV_FILE="${ENV_FILE:-${OPERATOR_HOME}/operator.env}"
STAGE_DIR="${STAGE_DIR:-/root/t3-stage}"
UNIT_DIR=/etc/systemd/system

# Optional integrity pin for the Node tarball. Leave empty to fall back to the
# SHASUMS256.txt published next to the tarball on nodejs.org; set it once the
# real digest is known (see RUNBOOK step 4) to make the download tamper-evident.
NODE_SHA256="${NODE_SHA256:-}"

# Build steps are the slow part (~2 min for the bot, ~6.5 min for t3code).
# Skip them when dist/ was already produced by a previous run.
BUILD_BOT="${BUILD_BOT:-auto}"      # auto | force | skip
BUILD_T3CODE="${BUILD_T3CODE:-auto}" # auto | force | skip

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

TOOLCHAIN_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --toolchain-only) TOOLCHAIN_ONLY=1 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg (see --help)" >&2; exit 2 ;;
  esac
done

# ── Output helpers ──────────────────────────────────────────────────────────
log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '    \033[32mok\033[0m   %s\n' "$*"; }
warn() { printf '    \033[33mwarn\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m!!\033[0m %s\n' "$*" >&2; exit 1; }

# ── 0. Preconditions ────────────────────────────────────────────────────────
log "0. Preconditions"
[ "$(id -u)" -eq 0 ] || die "run as root: sudo $0"
[ "$(uname -m)" = "x86_64" ] || die "this package pins a linux-x64 Node build; found $(uname -m)"
# systemctl/rsync/tar — install and unit handling; sha256sum+awk — Node tarball
# verification; cmp+install — the idempotent unit installer; git — the deployed
# SHA in the log and the bundle-based update path.
for tool in systemctl rsync tar sha256sum awk cmp install git; do
  command -v "$tool" >/dev/null 2>&1 || die "missing required tool: $tool (apt-get install -y coreutils diffutils git rsync tar)"
done
# curl is only needed on the online Node path; the offline path (--with-node)
# works without it, so this one is a warning rather than a hard stop. If it is
# missing and no staged tree exists, section 2 dies with an explicit message.
command -v curl >/dev/null 2>&1 || warn "curl missing — the online Node download will not work; stage the toolchain with sync-to-box.sh --with-node"
ok "root on $(. /etc/os-release && echo "$PRETTY_NAME"), x86_64"

# The bot shells out to the pinned, already-logged-in Claude CLI. No wrapper, no
# lock file — decision of 2026-08-27. Without it every turn fails, so this is fatal.
CLAUDE_BIN_EXPECTED="${CLAUDE_BIN_EXPECTED:-/usr/bin/claude}"
if [ "$TOOLCHAIN_ONLY" -eq 1 ]; then
  # The toolchain run happens before the box is fully prepared; claude is only
  # needed once the bot actually runs, so do not block the toolchain on it.
  [ -x "$CLAUDE_BIN_EXPECTED" ] && ok "claude present: $CLAUDE_BIN_EXPECTED" \
    || warn "Claude CLI not found at $CLAUDE_BIN_EXPECTED — must exist before the full install.sh run"
else
  [ -x "$CLAUDE_BIN_EXPECTED" ] || die "Claude CLI not found at $CLAUDE_BIN_EXPECTED (expected pre-installed and logged in)"
  ok "claude present: $CLAUDE_BIN_EXPECTED"
fi

# Media pipeline. Missing ffmpeg only degrades voice/video handling, so warn.
for bin in /usr/bin/ffmpeg /usr/bin/ffprobe /usr/bin/tesseract /usr/bin/pdftotext /usr/bin/pdftoppm; do
  if [ -x "$bin" ]; then ok "media: $bin"
  else warn "media binary missing: $bin — fix the path in operator.env or install the package (ffmpeg / tesseract-ocr tesseract-ocr-rus / poppler-utils)"; fi
done

# ── 1. Source trees (delivered by sync-to-box.sh, not by this script) ───────
log "1. Source trees"
[ -d "$REPO_DIR" ] || die "$REPO_DIR is missing — run sync-to-box.sh from the origin server first"
[ -f "$REPO_DIR/package.json" ] || die "$REPO_DIR has no package.json — incomplete sync"
[ -f "$REPO_DIR/pnpm-lock.yaml" ] || die "$REPO_DIR has no pnpm-lock.yaml — incomplete sync"
ok "bot sources: $REPO_DIR$( [ -d "$REPO_DIR/.git" ] && printf ' (git %s)' "$(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null || echo '?')" )"

if [ -d "$T3CODE_DIR" ]; then
  ok "t3code sources: $T3CODE_DIR$( [ -f "$T3CODE_DIR/VERSION" ] && printf ' (%s)' "$(cat "$T3CODE_DIR/VERSION")" )"
else
  warn "$T3CODE_DIR is missing — t3code-server.service will not be installed"
fi

# ── 2. Node 24 toolchain ────────────────────────────────────────────────────
# The box may ship Node 20/22; node:sqlite needs >=24.2 and the t3code monorepo
# pins ^24.13.1. We never touch the system Node — other services depend on it.
log "2. Node ${NODE_VERSION} toolchain"
install -d -m 0755 "$TOOLCHAIN_DIR"

node_ok() { [ -x "$NODE_HOME/bin/node" ] && [ "$("$NODE_HOME/bin/node" -v 2>/dev/null)" = "v${NODE_VERSION}" ]; }

if node_ok; then
  ok "already installed: $NODE_HOME ($("$NODE_HOME/bin/node" -v))"
else
  tarball="${STAGE_DIR}/${NODE_DIST}.tar.xz"
  staged_tree="${STAGE_DIR}/toolchain/${NODE_DIST}"

  if [ -d "$staged_tree/bin" ]; then
    # Offline path: sync-to-box.sh --with-node rsync'd our known-good extracted
    # copy. Preferred when the box cannot reach nodejs.org.
    log "   installing from staged tree $staged_tree"
    rsync -a --delete "$staged_tree/" "$NODE_HOME/"
  else
    if [ ! -f "$tarball" ]; then
      log "   downloading https://nodejs.org/dist/v${NODE_VERSION}/${NODE_DIST}.tar.xz"
      command -v curl >/dev/null 2>&1 || die "curl needed to fetch Node, or stage the tarball at $tarball"
      install -d -m 0755 "$STAGE_DIR"
      curl -fsSL --retry 3 -o "$tarball.part" \
        "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_DIST}.tar.xz"
      curl -fsSL --retry 3 -o "${STAGE_DIR}/SHASUMS256.txt" \
        "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"
      mv "$tarball.part" "$tarball"
    fi

    actual="$(sha256sum "$tarball" | awk '{print $1}')"
    if [ -n "$NODE_SHA256" ]; then
      [ "$actual" = "$NODE_SHA256" ] || die "Node tarball sha256 mismatch: got $actual, pinned $NODE_SHA256"
      ok "sha256 matches the pin"
    elif [ -f "${STAGE_DIR}/SHASUMS256.txt" ]; then
      expected="$(awk -v f="${NODE_DIST}.tar.xz" '$2 == f {print $1}' "${STAGE_DIR}/SHASUMS256.txt")"
      [ -n "$expected" ] || die "${NODE_DIST}.tar.xz not listed in SHASUMS256.txt"
      [ "$actual" = "$expected" ] || die "Node tarball sha256 mismatch: got $actual, expected $expected"
      ok "sha256 matches SHASUMS256.txt ($actual)"
    else
      die "no way to verify the Node tarball: set NODE_SHA256= or provide ${STAGE_DIR}/SHASUMS256.txt"
    fi

    rm -rf "${TOOLCHAIN_DIR}/.node-unpack"
    install -d -m 0755 "${TOOLCHAIN_DIR}/.node-unpack"
    tar -xJf "$tarball" -C "${TOOLCHAIN_DIR}/.node-unpack"
    rm -rf "$NODE_HOME"
    mv "${TOOLCHAIN_DIR}/.node-unpack/${NODE_DIST}" "$NODE_HOME"
    rm -rf "${TOOLCHAIN_DIR}/.node-unpack"
  fi

  node_ok || die "Node install failed: $NODE_HOME/bin/node is not v${NODE_VERSION}"
  ok "installed $("$NODE_HOME/bin/node" -v) at $NODE_HOME"
fi

export PATH="${GLOBAL_PREFIX}/bin:${NODE_HOME}/bin:${PATH}"
export NPM_CONFIG_PREFIX="$GLOBAL_PREFIX"
export HOME=/root

# pnpm (and vp for t3code) come from the synced global prefix when available;
# otherwise install them into it with the pinned npm. Never into the system tree.
install -d -m 0755 "$GLOBAL_PREFIX"

# Offline path: sync-to-box.sh --with-node staged the whole npm global prefix
# (pnpm + vite-plus, the exact versions the builds were tested with) at
# $STAGE_DIR/toolchain/global. Copy it in instead of hitting registry.npmjs.org.
# Path contract with sync-to-box.sh: STAGE_DIR here == ROOT_STAGE there.
STAGED_GLOBAL="${STAGE_DIR}/toolchain/global"
if [ ! -x "${GLOBAL_PREFIX}/bin/pnpm" ] && [ -x "${STAGED_GLOBAL}/bin/pnpm" ]; then
  log "   installing global prefix from staged tree $STAGED_GLOBAL"
  rsync -a "${STAGED_GLOBAL}/" "${GLOBAL_PREFIX}/"
  ok "global prefix synced (pnpm$( [ -x "${GLOBAL_PREFIX}/bin/vp" ] && printf ' + vp' ))"
fi

if command -v pnpm >/dev/null 2>&1; then
  ok "pnpm $(pnpm --version)"
else
  log "   installing pnpm into $GLOBAL_PREFIX"
  command -v npm >/dev/null 2>&1 || die "npm is missing and no staged global prefix at ${STAGED_GLOBAL} — re-run sync-to-box.sh --with-node"
  npm install -g --silent pnpm@10.30.3
  ok "pnpm $(pnpm --version)"
fi

# vp (vite-plus) is the build tool of the t3code monorepo. Installed here, not in
# section 6, because RUNBOOK step 5 builds t3code by hand — before env exists —
# using nothing but this toolchain. Pinned: pnpm-workspace.yaml puts vite-plus in
# the catalog at 0.2.2 and the repo's tasks run under it; floating latest is a
# different build tool.
if [ -d "$T3CODE_DIR" ] || [ "$TOOLCHAIN_ONLY" -eq 1 ]; then
  if command -v vp >/dev/null 2>&1; then
    ok "vp $(vp --version 2>/dev/null || echo present)"
  else
    log "   installing vite-plus@0.2.2 into $GLOBAL_PREFIX"
    command -v npm >/dev/null 2>&1 || die "npm is missing and the staged global prefix has no vp — re-run sync-to-box.sh --with-node"
    npm install -g --silent vite-plus@0.2.2
    ok "vp installed"
  fi
fi

if [ "$TOOLCHAIN_ONLY" -eq 1 ]; then
  cat <<EOF

Toolchain only: Node ${NODE_VERSION}, pnpm and vp are in place. Nothing else was
touched — no env check, no build, no units.

  export PATH=${NODE_HOME}/bin:${GLOBAL_PREFIX}/bin:\$PATH
  export NPM_CONFIG_PREFIX=${GLOBAL_PREFIX}

Next (RUNBOOK step 5): build t3code and issue the T3 bearer token, then fill
${ENV_FILE} and re-run this script without --toolchain-only.
EOF
  exit 0
fi

# ── 3. Runtime directories ──────────────────────────────────────────────────
# 0700: operator.env holds the Telegram token, the T3 bearer and the OpenRouter
# key, and OPERATOR_HOME holds the SQLite state and artifacts of every chat.
log "3. Runtime directories"
install -d -m 0700 -o root -g root "$OPERATOR_HOME"
install -d -m 0700 -o root -g root "$OPERATOR_HOME/artifacts"
chmod 0700 "$OPERATOR_HOME"
: >>"$OPERATOR_HOME/operator.log"; chmod 0600 "$OPERATOR_HOME/operator.log"
: >>"$OPERATOR_HOME/t3code.log";   chmod 0600 "$OPERATOR_HOME/t3code.log"
ok "$OPERATOR_HOME (0700) + logs (0600)"

# ── 4. Environment file ─────────────────────────────────────────────────────
log "4. Environment file"
if [ ! -f "$ENV_FILE" ]; then
  if [ -f "$SCRIPT_DIR/env" ]; then
    install -m 0600 -o root -g root "$SCRIPT_DIR/env" "$ENV_FILE"
    warn "installed the template to $ENV_FILE — fill the __FILL__ lines and re-run"
  else
    die "$ENV_FILE is missing and no template next to this script"
  fi
fi
chmod 0600 "$ENV_FILE"; chown root:root "$ENV_FILE"

# Only real assignments count: the template's own header comment mentions
# __FILL__, and matching it would make this check unsatisfiable forever.
if grep -nE '^[^#]*__FILL__' "$ENV_FILE" >/dev/null 2>&1; then
  printf '\n' >&2
  grep -nE '^[^#]*__FILL__' "$ENV_FILE" >&2
  die "$ENV_FILE still has __FILL__ placeholders (listed above) — fill them and re-run"
fi
# Cross-check the few values the units and this script hard-code paths for.
env_get() { sed -n "s/^${1}=//p" "$ENV_FILE" | tail -n1; }
[ "$(env_get OPERATOR_HOME)" = "$OPERATOR_HOME" ] || die "OPERATOR_HOME in $ENV_FILE must be $OPERATOR_HOME"
[ "$(env_get CLAUDE_BIN)" = "$CLAUDE_BIN_EXPECTED" ] || warn "CLAUDE_BIN in $ENV_FILE is not $CLAUDE_BIN_EXPECTED"
tz="$(env_get OWNER_TIMEZONE)"
if [ -z "$tz" ] || [ ! -f "/usr/share/zoneinfo/$tz" ]; then
  warn "OWNER_TIMEZONE='$tz' is empty or unknown to this box — reminders and the 03:00 day boundary drift to UTC"
fi
ok "$ENV_FILE clean, 0600"

# ── 5. Build the bot ────────────────────────────────────────────────────────
log "5. Build: t3-telegram"
bot_built() { [ -f "$REPO_DIR/dist/main.mjs" ] && [ -f "$REPO_DIR/dist/001_initial.sql" ]; }
case "$BUILD_BOT" in
  skip)  bot_built || die "BUILD_BOT=skip but $REPO_DIR/dist is incomplete"; ok "skipped (dist present)" ;;
  auto)  if bot_built && [ "$REPO_DIR/dist/main.mjs" -nt "$REPO_DIR/pnpm-lock.yaml" ]; then
           ok "dist is up to date (BUILD_BOT=force to rebuild)"
         else BUILD_BOT=force; fi ;;
  force) ;;
  *)     die "unknown BUILD_BOT value '$BUILD_BOT' (auto | force | skip)" ;;
esac
if [ "$BUILD_BOT" = force ]; then
  ( cd "$REPO_DIR"
    pnpm install --frozen-lockfile
    pnpm build )
  bot_built || die "build finished but dist/main.mjs or dist/001_initial.sql is missing"
  ok "built $REPO_DIR/dist/main.mjs"
fi
# Fail loudly here rather than in a restart loop at 3 a.m.
"$NODE_HOME/bin/node" --input-type=module -e 'process.exit(0)' >/dev/null || die "pinned node cannot run ESM"

# ── 6. Build t3code ─────────────────────────────────────────────────────────
if [ -d "$T3CODE_DIR" ]; then
  log "6. Build: t3code-verf (~6.5 min on first run)"
  t3_built() { [ -f "$T3CODE_DIR/apps/server/dist/bin.mjs" ]; }
  case "$BUILD_T3CODE" in
    skip) t3_built || die "BUILD_T3CODE=skip but $T3CODE_DIR/apps/server/dist/bin.mjs is missing"; ok "skipped (dist present)" ;;
    auto) if t3_built; then ok "bin.mjs present (BUILD_T3CODE=force to rebuild)"; else BUILD_T3CODE=force; fi ;;
    force) ;;
    *)    die "unknown BUILD_T3CODE value '$BUILD_T3CODE' (auto | force | skip)" ;;
  esac
  if [ "$BUILD_T3CODE" = force ]; then
    command -v vp >/dev/null 2>&1 || die "vp is missing — section 2 should have installed vite-plus@0.2.2"
    # node-pty has no linux prebuild and allowBuilds lets it compile, so `vp i`
    # shells out to node-gyp. Without a C toolchain the install dies mid-way, so
    # stop before spending six minutes on a build that cannot finish.
    for t in cc make python3; do
      command -v "$t" >/dev/null 2>&1 || die "missing $t — node-pty compiles from source during 'vp i' (apt-get install -y build-essential python3)"
    done
    ( cd "$T3CODE_DIR"
      vp i
      vp run --filter t3 build )
    t3_built || die "t3code build finished but apps/server/dist/bin.mjs is missing"
    ok "built $T3CODE_DIR/apps/server/dist/bin.mjs"
  fi
else
  log "6. Build: t3code-verf — skipped, tree absent"
fi

# ── 7. systemd units ────────────────────────────────────────────────────────
# install(1) is idempotent and only touches the file when the content differs
# in mode/owner; we compare content explicitly to keep the log honest.
log "7. systemd units"
# The unit's ExecStart points straight at dist/main.mjs. Enabling a unit whose
# target does not exist buys a restart loop at the next boot, so re-check here:
# BUILD_BOT=skip, an interrupted build or a dropped dist/ all land in this trap.
bot_built || die "$REPO_DIR/dist/main.mjs is missing — refusing to install and enable the unit; re-run with BUILD_BOT=force"
ok "ExecStart target present: $REPO_DIR/dist/main.mjs"

install_unit() {
  local src="$SCRIPT_DIR/$1" dst="$UNIT_DIR/$1"
  [ -f "$src" ] || die "unit not found: $src"
  if [ -f "$dst" ] && cmp -s "$src" "$dst"; then ok "$1 unchanged"; return; fi
  install -m 0644 -o root -g root "$src" "$dst"
  ok "$1 installed"
}
install_unit t3-telegram-operator.service
if [ -d "$T3CODE_DIR" ]; then install_unit t3code-server.service; fi

systemctl daemon-reload
ok "daemon-reload"

# enable, NOT start: the Telegram token is still held by the pm2 process
# `rick-bot`. Switching is a separate step so that the stop/start pair happens
# under a human's eyes — and because the same pm2 daemon carries a client's
# processes that must not be disturbed (RUNBOOK step 10).
if [ -d "$T3CODE_DIR" ]; then
  systemctl enable t3code-server.service >/dev/null 2>&1 && ok "t3code-server enabled" \
    || warn "systemctl enable t3code-server.service failed — the operator will run without T3"
fi
if systemctl enable t3-telegram-operator.service >/dev/null 2>&1; then
  ok "t3-telegram-operator enabled"
else
  die "systemctl enable t3-telegram-operator.service failed — check 'systemctl status t3-telegram-operator'"
fi

cat <<'EOF'

Install complete. Nothing was started.

Next (see RUNBOOK.md, steps 8-12):
  1. systemctl start t3code-server && curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3773/
  2. memory import, if any (step 9) — before the first operator start
  3. stop the old bot BY NAME (two pollers on one token => 409):
       sudo env PM2_HOME=/root/.pm2 pm2 stop rick-bot && ... pm2 save
     NEVER `pm2 stop/delete all` or `pm2 kill`: the same pm2 daemon runs a
     client's processes (masha-bot, masha-reply-watch, masha-vault-sync,
     potato-watch). See RUNBOOK step 10.
  4. systemctl start t3-telegram-operator
  5. tail -f /root/.operator/operator.log   # expect "Operator initialized" + "Telegram polling started"
  6. once smoke tests pass, wipe the staging copies (step 12): they contain the
     filled env, i.e. live tokens:
       rm -rf /root/t3-stage /root/t3-telegram.bundle /home/scout/t3-stage
EOF
