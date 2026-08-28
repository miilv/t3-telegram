#!/usr/bin/env bash
# Ship the T3 Telegram Operator deploy package from THIS server to Rick's box.
#
#     deploy/rick/sync-to-box.sh [--with-node] [--dry-run] [--stage-only]
#                                [--t3code-only|--bot-only] [--cleanup]
#
# Runs as the local unprivileged user, pushes into scout@BOX:/home/scout/t3-stage,
# then uses scout's sudo to move everything into /root ("promote"). Nothing is
# started; the installer on the box is run by hand (RUNBOOK steps 4 and 7).
#
#   --dry-run    rsync in --dry-run, no promote, no sudo needed at all
#   --stage-only stop after staging into /home/scout/t3-stage; no sudo needed.
#                Prints the manual promote command for the box owner.
#   --cleanup    remove the stage (incl. env with tokens) and the bundle, then exit
#
# ── Why a git bundle for the bot and a plain rsync for t3code ────────────────
# t3-telegram ships as `git bundle` of main only:
#   * .git here carries 236 refs, ~230 of them refs/t3/checkpoints/* — per-turn
#     agent snapshots. They are useless on the box and they leak working history;
#     a bundle of `main` carries exactly one ref.
#   * a bundle cannot leak untracked/ignored files by construction — .env,
#     .claude/, *.db, node_modules simply are not in it. An rsync of the worktree
#     needs a correct --exclude list, and a wrong one ships the production token.
#   * the box ends up with a real repo pinned to a verifiable SHA, so `git log`
#     answers "what is deployed" and the next update is another bundle + `git pull`.
#   Cost: uncommitted local work does not ship. That is a feature — commit it.
# t3code-verf ships as an rsync of the worktree (--exclude .git, node_modules):
#   its .git is 316 MB / 1270 refs of vendor history that the box has no use for;
#   we only need a tree that `vp run --filter t3 build` can chew on. The deployed
#   commit is recorded in /root/t3code-verf/VERSION instead.
set -euo pipefail

# No default on purpose: a script that ssh-es somewhere must never pick the
# target itself. The box address is checked in below, once die() exists.
BOX_HOST="${BOX_HOST:-}"
BOX_USER="${BOX_USER:-scout}"
BOX="${BOX_USER}@${BOX_HOST}"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=15)

REPO_LOCAL="${REPO_LOCAL:-/home/agent/t3-telegram}"
T3CODE_LOCAL="${T3CODE_LOCAL:-/home/agent/t3code-verf}"
TOOLCHAIN_LOCAL="${TOOLCHAIN_LOCAL:-/home/agent/.local/toolchain}"
NODE_DIST="${NODE_DIST:-node-v24.13.1-linux-x64}"

STAGE="/home/${BOX_USER}/t3-stage"
# Mirrors STAGE_DIR in install.sh — the two scripts must agree on where the
# offline toolchain lands, or install.sh silently falls back to the network.
ROOT_STAGE="${ROOT_STAGE:-/root/t3-stage}"
BUNDLE_NAME="t3-telegram-main.bundle"

WITH_NODE=0; DRY=0; DO_BOT=1; DO_T3CODE=1; STAGE_ONLY=0; CLEANUP=0
for arg in "$@"; do
  case "$arg" in
    --with-node)  WITH_NODE=1 ;;
    --dry-run)    DRY=1 ;;
    --stage-only) STAGE_ONLY=1 ;;
    --cleanup)    CLEANUP=1 ;;
    --bot-only)   DO_T3CODE=0 ;;
    --t3code-only) DO_BOT=0 ;;
    -h|--help)    sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '    \033[32mok\033[0m   %s\n' "$*"; }
warn() { printf '    \033[33mwarn\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m!!\033[0m %s\n' "$*" >&2; exit 1; }

# Deliberate, every time: this script rsyncs a bundle and an env file onto a
# remote host, and "the host it went to last time" is not a safe default.
[[ -n "$BOX_HOST" ]] || die "BOX_HOST is required — name the box explicitly, e.g. BOX_HOST=<ip-or-name> $0 ${*:-}"

manual_promote_hint() {
  cat >&2 <<EOF

    The files are (or will be) in $STAGE. Promoting them is a root job on the
    box, and there is exactly one authoritative copy of that sequence:

        RUNBOOK.md  →  section "Ручной промоут стейджа"

    It is also on the box after staging, at
        $STAGE/deploy-rick/RUNBOOK.md
    Follow it as written — the fiddly parts (chmod 0755 on the *.sh, which the
    stage deliberately ships as 0600; dropping dist/ when the SHA or VERSION
    changed; chown -R root:root at the end) are easy to miss when improvising.

    The short version, for orientation only:
        sudo -i
        cp -f $STAGE/$BUNDLE_NAME /root/t3-telegram.bundle
        git clone -b main /root/t3-telegram.bundle /root/t3-telegram   # first time
        rsync -a $STAGE/deploy-rick/ /root/t3-telegram/deploy/rick/
        chmod 0755 /root/t3-telegram/deploy/rick/*.sh                  # else: Permission denied
        install -d -m 0700 /root/.operator
        chown -R root:root /root/t3-telegram /root/.operator
EOF
}

RSYNC=(rsync -az --human-readable --info=stats1 -e "ssh ${SSH_OPTS[*]}")
if [ "$DRY" -eq 1 ]; then RSYNC+=(--dry-run); fi

# Promote (and only promote) needs root on the box. --dry-run and --stage-only
# never touch /root, so they must not demand sudo (written as one assignment:
# `[ ... ] && VAR=0` would abort the script under set -e when the test is false).
NEED_SUDO=1
if [ "$DRY" -eq 1 ] || [ "$STAGE_ONLY" -eq 1 ]; then NEED_SUDO=0; fi

# ── 0. Cleanup mode (standalone) ────────────────────────────────────────────
# Runs after a successful install: the stage holds a filled env, i.e. the
# Telegram token, the T3 bearer and the OpenRouter key in plaintext.
if [ "$CLEANUP" -eq 1 ]; then
  log "0. Cleanup on $BOX"
  ssh "${SSH_OPTS[@]}" "$BOX" true 2>/dev/null || die "cannot ssh to $BOX"
  ssh "${SSH_OPTS[@]}" "$BOX" "rm -rf '$STAGE'" && ok "removed $STAGE (stage env with tokens included)"
  if ssh "${SSH_OPTS[@]}" "$BOX" 'sudo -n true' 2>/dev/null; then
    ssh "${SSH_OPTS[@]}" "$BOX" "sudo -n rm -rf '$ROOT_STAGE' /root/t3-telegram.bundle"
    ok "removed $ROOT_STAGE and /root/t3-telegram.bundle"
  else
    warn "no passwordless sudo — ask the box owner to run:"
    printf '        sudo rm -rf %s /root/t3-telegram.bundle\n' "$ROOT_STAGE" >&2
  fi
  log "cleanup done. /root/t3-telegram, /root/t3code-verf and /root/.operator are untouched."
  exit 0
fi

# ── 1. Local preflight ──────────────────────────────────────────────────────
log "1. Local preflight"
[ -d "$REPO_LOCAL/.git" ] || die "$REPO_LOCAL is not a git checkout"
command -v rsync >/dev/null || die "rsync missing locally"

# The bundle carries committed state only; say out loud what will NOT travel.
dirty="$(git -C "$REPO_LOCAL" status --porcelain --untracked-files=normal | grep -v '^?? deploy/' || true)"
if [ -n "$dirty" ]; then
  warn "uncommitted changes in $REPO_LOCAL will NOT be in the bundle:"
  printf '%s\n' "$dirty" | sed 's/^/         /' >&2
fi
head_sha="$(git -C "$REPO_LOCAL" rev-parse main)"
ok "bot main = ${head_sha:0:12}"

if [ "$DO_T3CODE" -eq 1 ]; then
  [ -d "$T3CODE_LOCAL" ] || die "$T3CODE_LOCAL missing"
  t3_sha="$(git -C "$T3CODE_LOCAL" rev-parse HEAD 2>/dev/null || echo unknown)"
  ok "t3code HEAD = ${t3_sha:0:12}"
fi

# ── 2. Box preflight ────────────────────────────────────────────────────────
log "2. Box preflight ($BOX)"
ssh "${SSH_OPTS[@]}" "$BOX" true 2>/dev/null || die "cannot ssh to $BOX (key auth, BatchMode). Fix ssh first; this script never prompts."
box_os="$(ssh "${SSH_OPTS[@]}" "$BOX" '. /etc/os-release && echo "$PRETTY_NAME $(uname -m)"')"
ok "reachable: $box_os"

# Tools the box needs *after* this script finishes. Checked before we push
# hundreds of megabytes, so a missing compiler costs a second, not 20 minutes.
#   git      — the promote step does `git clone` / `git fetch` from the bundle
#   cc/make/python3 — node-pty has no linux prebuild; `vp i` shells out to
#                     node-gyp during the t3code build (install.sh step 6)
box_need=(git)
if [ "$DO_T3CODE" -eq 1 ]; then box_need+=(cc make python3); fi
missing_box="$(ssh "${SSH_OPTS[@]}" "$BOX" "for t in ${box_need[*]}; do command -v \$t >/dev/null 2>&1 || printf '%s ' \$t; done")"
if [ -n "${missing_box// /}" ]; then
  die "the box is missing required tools: ${missing_box% }
    Nothing was transferred. Ask the box owner to run:
        sudo apt-get install -y git build-essential python3
    (git is needed to unpack the bundle into /root/t3-telegram; cc/make/python3
     are needed to compile node-pty while building t3code.)"
fi
ok "box tools present: ${box_need[*]}"

if [ "$NEED_SUDO" -eq 1 ]; then
  if ! ssh "${SSH_OPTS[@]}" "$BOX" 'sudo -n true' 2>/dev/null; then
    warn "$BOX_USER has no passwordless sudo on the box, so the promote into /root cannot run."
    manual_promote_hint
    die "re-run with --stage-only to stage the files and let the box owner promote them by hand"
  fi
  ok "passwordless sudo available"
else
  ok "sudo not required in this mode"
fi

# --dry-run promises "nothing is written on the box", and that has to include the
# stage directory itself. rsync --dry-run does not need the target to exist.
if [ "$DRY" -eq 0 ]; then
  ssh "${SSH_OPTS[@]}" "$BOX" "mkdir -p '$STAGE' && chmod 0700 '$STAGE'"
else
  ssh "${SSH_OPTS[@]}" "$BOX" "[ -d '$STAGE' ]" 2>/dev/null \
    && ok "$STAGE exists" \
    || warn "$STAGE does not exist yet — a real run will create it (dry run creates nothing)"
fi

# ── 3. Bot: bundle + deploy scripts ─────────────────────────────────────────
if [ "$DO_BOT" -eq 1 ]; then
  log "3. Bot sources -> $STAGE"
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  git -C "$REPO_LOCAL" bundle create "$tmp/$BUNDLE_NAME" main >/dev/null
  git -C "$REPO_LOCAL" bundle verify "$tmp/$BUNDLE_NAME" >/dev/null
  printf '%s\n' "$head_sha" >"$tmp/t3-telegram.sha"
  ok "bundle: $(du -h "$tmp/$BUNDLE_NAME" | cut -f1), ref main only"

  "${RSYNC[@]}" "$tmp/$BUNDLE_NAME" "$tmp/t3-telegram.sha" "$BOX:$STAGE/"
  # deploy/rick is untracked on purpose (it holds the filled env template), so it
  # travels outside the bundle. env is 0600 and stays 0600 thanks to -a.
  # memory-import/ is synced separately with an allow-list (see below), because
  # that directory is a working area of the import agent and may accumulate
  # dumps and databases that must never leave this server.
  "${RSYNC[@]}" --delete --chmod=F0600 \
    --exclude='memory-import/' \
    "$REPO_LOCAL/deploy/rick/" "$BOX:$STAGE/deploy-rick/"

  # Allow-list, not deny-list: only the tools and docs, plus the one sample
  # fixture. Everything else (*.db, *.db-wal, real *.jsonl exports, tarballs)
  # is dropped by the trailing --exclude='*'.
  "${RSYNC[@]}" --delete --chmod=F0600 \
    --include='*/' \
    --include='*.mjs' \
    --include='*.md' \
    --include='example.jsonl' \
    --exclude='*' \
    "$REPO_LOCAL/deploy/rick/memory-import/" "$BOX:$STAGE/deploy-rick/memory-import/"
  ok "deploy/rick/ staged (memory-import: *.mjs, *.md, example.jsonl only)"
fi

# ── 4. t3code-verf worktree ─────────────────────────────────────────────────
if [ "$DO_T3CODE" -eq 1 ]; then
  log "4. t3code-verf -> $STAGE (375 MB tree, incremental after the first run)"
  "${RSYNC[@]}" --delete \
    --exclude='node_modules/' \
    --exclude='.git/' \
    --include='.env.example' --exclude='.env' --exclude='.env.*' \
    --exclude='apps/server/dist/' \
    --exclude='*.log' \
    --exclude='.turbo/' --exclude='.vite/' --exclude='.cache/' \
    "$T3CODE_LOCAL/" "$BOX:$STAGE/t3code-verf/"
  # In --dry-run the rsync above created nothing, so the redirect would fail on a
  # missing directory and abort the whole preflight.
  if [ "$DRY" -eq 0 ]; then
    ssh "${SSH_OPTS[@]}" "$BOX" "printf '%s\n' '$t3_sha' > '$STAGE/t3code-verf/VERSION'"
  fi
  ok "t3code-verf staged (VERSION=${t3_sha:0:12})"
fi

# ── 5. Optional offline Node toolchain ──────────────────────────────────────
# Use when the box cannot reach nodejs.org or registry.npmjs.org, or when you
# want the byte-identical copy we run here. Two pieces:
#   toolchain/$NODE_DIST — the Node runtime itself
#   toolchain/global     — the npm global prefix with pnpm and vite-plus (vp)
# install.sh looks for both under $STAGE_DIR (=/root/t3-stage) and installs them
# into /root/.local/toolchain/{$NODE_DIST,global} instead of hitting the network.
if [ "$WITH_NODE" -eq 1 ]; then
  log "5. Node toolchain -> $STAGE/toolchain (~380 MB)"
  [ -x "$TOOLCHAIN_LOCAL/$NODE_DIST/bin/node" ] || die "$TOOLCHAIN_LOCAL/$NODE_DIST is not a Node install"
  ssh "$BOX" "mkdir -p '$STAGE/toolchain'"
  [ -x "$TOOLCHAIN_LOCAL/global/bin/pnpm" ] || die "$TOOLCHAIN_LOCAL/global/bin/pnpm missing — the offline path also ships the global prefix (pnpm, vp)"
  "${RSYNC[@]}" --delete "$TOOLCHAIN_LOCAL/$NODE_DIST/" "$BOX:$STAGE/toolchain/$NODE_DIST/"
  # pnpm + vite-plus (vp) — saves a corepack/registry round trip and pins the
  # exact package manager versions the two builds were tested with.
  "${RSYNC[@]}" --delete "$TOOLCHAIN_LOCAL/global/" "$BOX:$STAGE/toolchain/global/"
  ok "toolchain staged (runtime + global prefix)"
else
  log "5. Node toolchain — skipped (install.sh will fetch it from nodejs.org; pass --with-node for the offline path)"
fi

if [ "$DRY" -eq 1 ]; then
  log "dry run: nothing was written on the box, nothing was moved into /root"
  exit 0
fi

if [ "$STAGE_ONLY" -eq 1 ]; then
  log "stage-only: everything is in $STAGE, nothing was moved into /root"
  manual_promote_hint
  exit 0
fi

# ── 6. Move into /root under sudo ───────────────────────────────────────────
# Everything below runs as root on the box. Kept in one heredoc so a half-applied
# move is visible in one place; each piece is individually idempotent.
log "6. Promote $STAGE -> /root (sudo on the box)"
ssh "${SSH_OPTS[@]}" "$BOX" "sudo -n bash -euo pipefail -s" <<REMOTE
STAGE='$STAGE'
ROOT_STAGE='$ROOT_STAGE'
DO_BOT=$DO_BOT
DO_T3CODE=$DO_T3CODE
WITH_NODE=$WITH_NODE
BUNDLE_NAME='$BUNDLE_NAME'
NODE_DIST='$NODE_DIST'
NEW_BOT_SHA='$head_sha'

install -d -m 0700 /root/.operator
install -d -m 0755 /root/.local /root/.local/toolchain

if [ "\$DO_BOT" = 1 ]; then
  old_bot_sha="\$(git -C /root/t3-telegram rev-parse HEAD 2>/dev/null || echo none)"
  cp -f "\$STAGE/\$BUNDLE_NAME" /root/t3-telegram.bundle
  if [ -d /root/t3-telegram/.git ]; then
    git -C /root/t3-telegram remote remove bundle 2>/dev/null || true
    git -C /root/t3-telegram remote add bundle /root/t3-telegram.bundle
    git -C /root/t3-telegram fetch --update-head-ok bundle main:main
    git -C /root/t3-telegram checkout -f main
    git -C /root/t3-telegram reset --hard main
  else
    rm -rf /root/t3-telegram
    git clone -b main /root/t3-telegram.bundle /root/t3-telegram
  fi
  # Same reasoning as t3code below: install.sh's BUILD_BOT=auto only compares
  # dist/main.mjs against pnpm-lock.yaml, so a source-only change would leave the
  # old bundle in place and the unit would keep running yesterday's code.
  # Dropping dist/ on any SHA change makes the next install.sh rebuild.
  if [ "\$old_bot_sha" != "\$NEW_BOT_SHA" ]; then
    rm -rf /root/t3-telegram/dist
    echo "bot sources changed \${old_bot_sha:0:12} -> \${NEW_BOT_SHA:0:12}; dist dropped, rebuild required"
  fi
  # deploy/rick is untracked upstream; overlay it (env + scripts + units).
  install -d -m 0755 /root/t3-telegram/deploy
  rsync -a "\$STAGE/deploy-rick/" /root/t3-telegram/deploy/rick/
  chmod 0700 /root/t3-telegram/deploy/rick
  chmod 0600 /root/t3-telegram/deploy/rick/env
  chmod 0755 /root/t3-telegram/deploy/rick/*.sh
  echo "bot at \$(git -C /root/t3-telegram rev-parse --short HEAD)"
fi

if [ "\$DO_T3CODE" = 1 ]; then
  old_ver="\$(cat /root/t3code-verf/VERSION 2>/dev/null || echo none)"
  new_ver="\$(cat "\$STAGE/t3code-verf/VERSION" 2>/dev/null || echo unknown)"
  # --delete keeps the tree an exact mirror, but node_modules and the built dist
  # live inside it, so they must survive a re-sync.
  rsync -a --delete \
    --exclude='node_modules/' \
    --exclude='apps/server/dist/' \
    "\$STAGE/t3code-verf/" /root/t3code-verf/
  # A dist left over from an older commit would make install.sh's BUILD_T3CODE=auto
  # skip the rebuild and silently keep serving stale code. Drop it on any change.
  if [ "\$old_ver" != "\$new_ver" ]; then
    rm -rf /root/t3code-verf/apps/server/dist
    echo "t3code sources changed \$old_ver -> \$new_ver; dist dropped, rebuild required"
  fi
  echo "t3code at \$new_ver"
fi

if [ "\$WITH_NODE" = 1 ]; then
  install -d -m 0755 "\$ROOT_STAGE" "\$ROOT_STAGE/toolchain"
  rsync -a "\$STAGE/toolchain/" "\$ROOT_STAGE/toolchain/"
  echo "toolchain staged at \$ROOT_STAGE/toolchain (install.sh picks it up)"
fi

chown -R root:root /root/t3-telegram /root/.operator
[ -d /root/t3code-verf ] && chown -R root:root /root/t3code-verf || true
chmod 0700 /root/.operator
REMOTE

ok "promoted into /root"

cat <<EOF

Synced to $BOX.

Next, on the box as root (RUNBOOK steps 4-8):
  sudo -i
  /root/t3-telegram/deploy/rick/install.sh --toolchain-only   # Node + pnpm + vp only
  # build t3code and issue the bearer token (RUNBOOK step 5)
  install -d -m 0700 /root/.operator
  install -m 0600 /root/t3-telegram/deploy/rick/env /root/.operator/operator.env
  # TELEGRAM_BOT_TOKEN is NOT typed by hand: RUNBOOK step 6 copies it on the box
  # from /root/.takopi/takopi.toml straight into operator.env (never through the
  # terminal, the shell history or argv). Follow that step verbatim, then edit
  # the remaining __FILL__ lines (timezone, T3 bearer, OpenRouter key):
  \$EDITOR /root/.operator/operator.env
  /root/t3-telegram/deploy/rick/install.sh    # full run

After the operator is up and smoke-tested, wipe the stage (RUNBOOK step 12 — it
still holds a copy of the env template and the box owner's chat id):
  ./deploy/rick/sync-to-box.sh --cleanup
EOF
