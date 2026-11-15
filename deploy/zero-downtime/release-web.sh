#!/usr/bin/env bash
# ADR-0181 — zero-downtime web release controller (app VM, as root).
#
#   release-web.sh status
#   release-web.sh stage   <extracted-package-dir>     copy into releases/<BUILD_ID>, publish static assets
#   release-web.sh mode    <build-id> [--accept file]   online | maintenance for active -> <build-id>
#   release-web.sh migrate <build-id> [--accept file]   online database sequence, previous release serving
#   release-web.sh start   <build-id>                   start it on the idle slot, health + identity + warm-up
#   release-web.sh switch  [--keep-previous]            Nginx to the idle slot, verify, drain and stop the old one
#   release-web.sh rollback                             previous slot back in front (code rollback; ADR-0181)
#   release-web.sh adopt   <legacy-port>                one-time: first slot from the in-place /opt/ai-hr tree
#   release-web.sh prune   [--keep N]                   delete old release trees, rebuild the static union
#
# The web never stops: traffic moves between two systemd instances (aihr-web@blue, aihr-web@green) by
# rewriting one Nginx upstream file and `nginx -s reload`, which starts new workers on the new file and
# lets the old workers finish their in-flight requests. The previous slot is stopped only after a drain
# period, with SIGTERM, which Next answers by finishing in-flight requests (self-hosting guide).
#
# Layout (root-owned, read-only to the aihr service user except .next/cache):
#   $ROOT/releases/<BUILD_ID>/   immutable release trees (source + Linux runtime packages extracted)
#   $ROOT/slots/{blue,green}     symlink -> releases/<BUILD_ID>   (systemd WorkingDirectory)
#   $ROOT/static/_next/static/   union of every kept release's static assets (old tabs keep loading)
#   $ROOT/current                symlink -> the release Nginx is serving
#   $ROOT/state.env, history.log controller state, append-only history
#
# Everything is configurable for the rehearsal through the environment (see defaults below).
set -euo pipefail
umask 022

ROOT=${AIHR_WEB_ROOT:-/opt/aihr-web}
UPSTREAM_CONF=${AIHR_WEB_UPSTREAM_CONF:-/etc/nginx/aihr-upstream.conf}
SYSTEMCTL=${AIHR_WEB_SYSTEMCTL:-systemctl}
NGINX=${AIHR_WEB_NGINX:-nginx}
NODE=${AIHR_WEB_NODE:-/opt/node24/bin/node}
SERVICE_GROUP=${AIHR_WEB_GROUP:-aihr}
PORT_blue=${AIHR_WEB_PORT_BLUE:-3101}
PORT_green=${AIHR_WEB_PORT_GREEN:-3102}
DRAIN_SECONDS=${AIHR_WEB_DRAIN_SECONDS:-45}
HEALTH_TIMEOUT=${AIHR_WEB_HEALTH_TIMEOUT:-180}
# Verification through Nginx itself, as a browser reaches it.
VERIFY_URL=${AIHR_WEB_VERIFY_URL:-https://127.0.0.1/login}
VERIFY_HOST=${AIHR_WEB_VERIFY_HOST:-}
WARM_PATHS=${AIHR_WEB_WARM_PATHS:-"/login /health /"}
IDENTITY_PATH=${AIHR_WEB_IDENTITY_PATH:-/login}
KEEP_RELEASES=${AIHR_WEB_KEEP_RELEASES:-5}

die() { echo "STOP: $*" >&2; exit 1; }
log() { echo "$(date -u +%FT%TZ) $*" | tee -a "$ROOT/history.log" >&2; }
other() { [ "$1" = blue ] && echo green || echo blue; }
port_of() { local v="PORT_$1"; echo "${!v}"; }
release_of() { local l="$ROOT/slots/$1"; [ -L "$l" ] && basename "$(readlink "$l")" || true; }
is_active() { [ "$($SYSTEMCTL is-active "aihr-web@$1" 2>/dev/null || true)" = active ]; }
http_code() { curl -s -o /dev/null -m "${3:-8}" -w '%{http_code}' ${2:+-H "Host: $2"} -k "$1" || true; }

# The deploymentId a page was rendered by (Next writes it on <html data-dpl-id=...>).
served_id() { curl -s -m 10 -k ${2:+-H "Host: $2"} "$1" | sed -n 's/.*<html[^>]*data-dpl-id="\([A-Za-z0-9_-]*\)".*/\1/p' | head -1; }

load_state() {
  ACTIVE_SLOT="" PREVIOUS_SLOT=""
  # shellcheck disable=SC1091
  [ -f "$ROOT/state.env" ] && . "$ROOT/state.env"
  return 0
}
save_state() {
  printf 'ACTIVE_SLOT=%s\nPREVIOUS_SLOT=%s\n' "$ACTIVE_SLOT" "$PREVIOUS_SLOT" > "$ROOT/state.env.tmp"
  mv -f "$ROOT/state.env.tmp" "$ROOT/state.env"
}

# Atomic symlink replacement: a reader sees the old target or the new one, never neither.
relink() { ln -sfn "$1" "$2.tmp.$$" && mv -Tf "$2.tmp.$$" "$2"; }

lock() {
  mkdir -p "$ROOT/releases" "$ROOT/slots" "$ROOT/static/_next/static"
  touch "$ROOT/history.log"
  exec 9>"$ROOT/.lock"
  flock -n 9 || die "another release-web.sh is running (lock $ROOT/.lock)"
}

wait_healthy() {
  local port=$1 deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    [ "$(http_code "http://127.0.0.1:$port/health" "" 5)" = 200 ] && return 0
    sleep 2
  done
  return 1
}

write_upstream() {
  local port=$1
  cat > "$UPSTREAM_CONF.tmp" <<EOF
# Managed by deploy/zero-downtime/release-web.sh (ADR-0181). Do not edit by hand: \`release-web.sh status\`.
upstream aihr_web {
    server 127.0.0.1:$port;
    keepalive 32;
}
EOF
  cp -p "$UPSTREAM_CONF" "$UPSTREAM_CONF.previous" 2>/dev/null || true
  mv -f "$UPSTREAM_CONF.tmp" "$UPSTREAM_CONF"
  if ! $NGINX -t >/dev/null 2>&1; then
    [ -f "$UPSTREAM_CONF.previous" ] && mv -f "$UPSTREAM_CONF.previous" "$UPSTREAM_CONF"
    die "nginx -t refused the new upstream; restored the previous file, traffic unchanged"
  fi
  $NGINX -s reload
}

upstream_port() { sed -n 's/^ *server 127\.0\.0\.1:\([0-9]*\);.*/\1/p' "$UPSTREAM_CONF" 2>/dev/null | head -1; }

publish_static() {
  # Content-hashed chunks: adding files never changes an existing one. No --delete: the previous
  # build's chunks must stay reachable for the tabs that still reference them.
  local rel=$1
  [ -d "$rel/.next/static" ] || return 0
  rsync -a "$rel/.next/static/" "$ROOT/static/_next/static/"
}

# Point Nginx at a slot that is already running and healthy, verify through Nginx, then drain/stop
# the slot it replaced unless asked to keep it.
cut_to() {
  local to=$1 keep=$2 from want got deadline
  load_state
  from=$ACTIVE_SLOT
  want=$(release_of "$to")
  [ -n "$want" ] || die "slot $to has no release"
  is_active "$to" || die "slot $to is not running"
  [ "$(http_code "http://127.0.0.1:$(port_of "$to")/health" "" 5)" = 200 ] || die "slot $to is not healthy; traffic unchanged"
  log "switch: nginx -> $to ($want) port $(port_of "$to"); was ${from:-legacy port $(upstream_port)}"
  write_upstream "$(port_of "$to")"
  relink "releases/$want" "$ROOT/current"
  ACTIVE_SLOT=$to PREVIOUS_SLOT=$from
  save_state
  # Boot brings back exactly the slot Nginx points at (the upstream file survives the reboot).
  $SYSTEMCTL enable "aihr-web@$to" >/dev/null 2>&1 || true
  [ -z "$from" ] || [ "$from" = "$to" ] || $SYSTEMCTL disable "aihr-web@$from" >/dev/null 2>&1 || true
  # Through Nginx, as a browser sees it. New Nginx workers serve new connections at once; this waits
  # for a rendered page that names the new build.
  if [ -f "$ROOT/releases/$want/.zd-identity" ]; then
    deadline=$(( $(date +%s) + 30 ))
    got=""
    while [ "$(date +%s)" -lt "$deadline" ]; do
      got=$(served_id "$VERIFY_URL" "$VERIFY_HOST")
      [ "$got" = "$want" ] && break
      sleep 1
    done
    [ "$got" = "$want" ] || die "Nginx still serves ${got:-nothing recognisable} instead of $want after 30 s. The old slot ($from) is still running: run 'release-web.sh rollback' or investigate."
    log "verified through nginx: $VERIFY_URL rendered by $got"
  else
    [ "$(http_code "$VERIFY_URL" "$VERIFY_HOST")" != 000 ] || die "Nginx does not answer $VERIFY_URL after the switch"
    log "verified through nginx: $VERIFY_URL answers (release predates build identity; not identity-checked)"
  fi
  if [ -n "$from" ] && [ "$from" != "$to" ] && [ "$keep" != 1 ]; then
    log "draining $from for ${DRAIN_SECONDS}s before stopping it"
    sleep "$DRAIN_SECONDS"
    $SYSTEMCTL stop "aihr-web@$from"
    log "stopped aihr-web@$from (kept at $(release_of "$from") for rollback)"
  fi
  echo "SWITCH_RESULT=pass active=$to release=$want"
}

cmd_status() {
  load_state
  echo "root=$ROOT upstream_port=$(upstream_port) active=${ACTIVE_SLOT:-none} previous=${PREVIOUS_SLOT:-none} current=$( [ -L "$ROOT/current" ] && basename "$(readlink "$ROOT/current")" )"
  for s in blue green; do
    echo "slot=$s port=$(port_of "$s") release=$(release_of "$s") service=$($SYSTEMCTL is-active "aihr-web@$s" 2>/dev/null || true) health=$(http_code "http://127.0.0.1:$(port_of "$s")/health" "" 4)"
  done
  echo "releases: $(ls -1t "$ROOT/releases" 2>/dev/null | tr '\n' ' ')"
}

cmd_stage() {
  local src=${1:?extracted package directory} id dest
  [ -f "$src/.next/BUILD_ID" ] || die "$src/.next/BUILD_ID missing"
  id=$(tr -d '[:space:]' < "$src/.next/BUILD_ID")
  [[ "$id" =~ ^[A-Za-z0-9_-]{8,64}$ ]] || die "unexpected BUILD_ID '$id'"
  dest="$ROOT/releases/$id"
  if [ -e "$dest" ]; then
    [ -z "$(rsync -rlpcni --delete --exclude=/.next/cache "$src/" "$dest/")" ] || die "$dest exists with different content; releases are immutable"
    log "stage: $id already staged, identical"
  else
    rsync -a --delete --exclude=/.next/cache "$src/" "$dest.partial/"
    chown -R root:"$SERVICE_GROUP" "$dest.partial"
    # The service group must read the tree (29 Oct: a stage with owner-only modes was refused by its
    # post-install check); nobody but root may write it.
    chmod -R go-w,g+rX "$dest.partial"
    mkdir -p "$dest.partial/.next/cache"
    chown "$SERVICE_GROUP:$SERVICE_GROUP" "$dest.partial/.next/cache"
    chmod 0700 "$dest.partial/.next/cache"
    # A build that carries skew protection (deploymentId === BUILD_ID, recorded in routes-manifest)
    # can be identity-checked through Nginx after the switch.
    if "$NODE" -e 'const m=require(process.argv[1]+"/.next/routes-manifest.json");process.exit(m.deploymentId===process.argv[2]?0:1)' "$dest.partial" "$id" 2>/dev/null; then
      touch "$dest.partial/.zd-identity"
    fi
    mv -T "$dest.partial" "$dest"
    log "stage: $id from $src$( [ -f "$dest/.zd-identity" ] && echo ' (skew-protected build)' )"
  fi
  publish_static "$dest"
  echo "STAGED=$id"
}

cmd_mode() {
  local id=${1:?build id}; shift
  load_state
  [ -n "$ACTIVE_SLOT" ] || die "no active slot: adopt first"
  "$NODE" "$ROOT/releases/$id/scripts/releases/migration-release-mode.mjs" --base "$ROOT/releases/$(release_of "$ACTIVE_SLOT")" --candidate "$ROOT/releases/$id" "$@"
}

cmd_migrate() {
  local id=${1:?build id}; shift
  local accept=() logs
  [ "${1:-}" = --accept ] && accept=(--accept "$2")
  load_state
  [ -n "$ACTIVE_SLOT" ] || die "no active slot: adopt first"
  [ -d "$ROOT/releases/$id" ] || die "release $id is not staged"
  logs="$ROOT/logs/$id-migrate-$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$logs"
  log "migrate: $id with $(release_of "$ACTIVE_SLOT") serving"
  AIHR_NODE_BIN=$(dirname "$NODE") "$ROOT/releases/$id/deploy/zero-downtime/migrate-online.sh" \
    --base "$ROOT/releases/$(release_of "$ACTIVE_SLOT")" --log-dir "$logs" "${accept[@]}"
  log "migrate: $id pass (logs $logs)"
}

cmd_start() {
  local id=${1:?build id} idle port path code got
  load_state
  [ -d "$ROOT/releases/$id" ] || die "release $id is not staged"
  idle=$( [ -n "$ACTIVE_SLOT" ] && other "$ACTIVE_SLOT" || echo blue )
  [ "$(upstream_port)" != "$(port_of "$idle")" ] || die "Nginx points at the idle slot $idle; state is inconsistent — run status"
  port=$(port_of "$idle")
  log "start: $id on $idle (port $port)"
  is_active "$idle" && $SYSTEMCTL stop "aihr-web@$idle"
  relink "../releases/$id" "$ROOT/slots/$idle"
  $SYSTEMCTL start "aihr-web@$idle"
  wait_healthy "$port" || die "aihr-web@$idle did not become healthy within ${HEALTH_TIMEOUT}s; traffic unchanged. journalctl -u aihr-web@$idle"
  if [ -f "$ROOT/releases/$id/.zd-identity" ]; then
    got=$(served_id "http://127.0.0.1:$port$IDENTITY_PATH")
    [ "$got" = "$id" ] || die "slot $idle renders build '${got:-?}', expected $id"
  fi
  for path in $WARM_PATHS; do
    code=$(http_code "http://127.0.0.1:$port$path" "" 30)
    case "$code" in 2??|3??|401) ;; *) die "warm-up $path answered $code on slot $idle; traffic unchanged" ;; esac
  done
  log "start: $id healthy and warm on $idle"
  echo "STARTED=$id slot=$idle port=$port"
}

cmd_switch() {
  local keep=0
  [ "${1:-}" = --keep-previous ] && keep=1
  load_state
  local to
  to=$( [ -n "$ACTIVE_SLOT" ] && other "$ACTIVE_SLOT" || echo blue )
  cut_to "$to" "$keep"
}

cmd_rollback() {
  load_state
  [ -n "$PREVIOUS_SLOT" ] || die "no previous slot recorded; nothing to roll back to"
  local back=$PREVIOUS_SLOT
  [ -n "$(release_of "$back")" ] || die "previous slot $back has no release"
  log "rollback: to $back ($(release_of "$back")) from $ACTIVE_SLOT ($(release_of "$ACTIVE_SLOT"))"
  if ! is_active "$back"; then
    $SYSTEMCTL start "aihr-web@$back"
    wait_healthy "$(port_of "$back")" || die "previous slot $back did not become healthy; traffic unchanged on $ACTIVE_SLOT"
  fi
  cut_to "$back" 0
}

# One time, from the legacy in-place layout. The legacy service keeps serving on its port while the
# first slot starts from a copy of the same tree; then Nginx moves to the slot. The legacy unit is
# stopped after the drain and disabled; /opt/ai-hr itself stays for timers, cron and the worker
# (ADR-0181: web first, worker next).
cmd_adopt() {
  local legacy_port=${1:?legacy web port} legacy=${AIHR_WEB_LEGACY_DIR:-/opt/ai-hr} id
  load_state
  [ -z "$ACTIVE_SLOT" ] || die "already adopted (active=$ACTIVE_SLOT)"
  [ "$(upstream_port)" = "$legacy_port" ] || die "upstream file $UPSTREAM_CONF must already route to the legacy port $legacy_port (convert the site to 'proxy_pass http://aihr_web' first; see README)"
  id=$(tr -d '[:space:]' < "$legacy/.next/BUILD_ID")
  log "adopt: legacy $legacy ($id) on port $legacy_port"
  local tmp
  tmp=$(mktemp -d)
  rsync -a --exclude=/.next/cache --exclude=/.env --exclude=/.env.local --exclude=/.env.production --exclude=/.env.production.local "$legacy/" "$tmp/"
  cmd_stage "$tmp"
  rm -rf "$tmp"
  cmd_start "$id"
  cut_to blue 1
  ACTIVE_SLOT=blue PREVIOUS_SLOT=""
  save_state
  log "adopt: blue serves; draining legacy for ${DRAIN_SECONDS}s"
  sleep "$DRAIN_SECONDS"
  $SYSTEMCTL stop "${AIHR_WEB_LEGACY_UNIT:-aihr}"
  $SYSTEMCTL disable "${AIHR_WEB_LEGACY_UNIT:-aihr}" >/dev/null 2>&1 || true
  log "adopt: legacy unit stopped and disabled"
}

cmd_prune() {
  local keep=$KEEP_RELEASES
  [ "${1:-}" = --keep ] && keep=$2
  load_state
  local protect=" $(release_of blue) $(release_of green) "
  local n=0 r
  for r in $(ls -1t "$ROOT/releases"); do
    n=$((n + 1))
    if [ "$n" -gt "$keep" ] && [[ "$protect" != *" $r "* ]]; then rm -rf "${ROOT:?}/releases/$r"; log "prune: removed release $r"; fi
  done
  rm -rf "$ROOT/static.next"
  mkdir -p "$ROOT/static.next/_next/static"
  for r in $(ls -1tr "$ROOT/releases"); do [ -d "$ROOT/releases/$r/.next/static" ] && rsync -a "$ROOT/releases/$r/.next/static/" "$ROOT/static.next/_next/static/"; done
  rm -rf "$ROOT/static.previous"
  mv -T "$ROOT/static" "$ROOT/static.previous" && mv -T "$ROOT/static.next" "$ROOT/static" && rm -rf "$ROOT/static.previous"
  log "prune: static union rebuilt from $(ls -1 "$ROOT/releases" | wc -l | tr -d ' ') releases"
}

main() {
  local c=${1:-status}; shift || true
  case "$c" in
    status) cmd_status ;;
    stage|mode|migrate|start|switch|rollback|adopt|prune) lock; "cmd_$c" "$@" ;;
    *) die "unknown command $c" ;;
  esac
}
main "$@"
