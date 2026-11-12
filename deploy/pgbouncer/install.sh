#!/usr/bin/env bash
# Privileged, reviewable installation of the transaction pooler on the application host.
#
# This installs and starts PgBouncer. It does not touch the application: nothing uses the pooler until
# DATABASE_POOLED_URL is set and the web service restarts. Read README.md first.
#
#   sudo env AIHR_DB_CPU_CORES=4 AIHR_DB_MAX_CONNECTIONS=100 AIHR_PGBOUNCER_DATABASE_HOST=db.private.example \
#     AIHR_APP_WORKERS=4 AIHR_DB_POOL_MAX=8 AIHR_PGBOUNCER_USERLIST_FILE=/secure/userlist.txt \
#     bash deploy/pgbouncer/install.sh
#
# --render-only writes the rendered configuration to the directory named by AIHR_PGBOUNCER_RENDER_DIR and
# stops. It installs nothing and is safe on any host, including a rehearsal.
set -euo pipefail
umask 077
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="${AIHR_NODE_BIN:-/opt/node24/bin/node}"
[ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node)"
MIN_MAJOR=1 MIN_MINOR=21

if [ "${1:-}" = "--render-only" ]; then
  : "${AIHR_PGBOUNCER_RENDER_DIR:?Set AIHR_PGBOUNCER_RENDER_DIR to an empty directory.}"
  "$NODE_BIN" "$SCRIPT_DIR/render-config.mjs" "$AIHR_PGBOUNCER_RENDER_DIR"
  exit 0
fi

[ "$(id -u)" -eq 0 ] || { echo 'Run this script through the approved server administrator.' >&2; exit 1; }
: "${AIHR_PGBOUNCER_USERLIST_FILE:?Set AIHR_PGBOUNCER_USERLIST_FILE to the output of refresh-userlist.sh.}"
[ -f "$AIHR_PGBOUNCER_USERLIST_FILE" ] || { echo 'The userlist file does not exist.' >&2; exit 1; }
[ ! -e /etc/aihr-pgbouncer/pgbouncer.ini ] || { echo 'A pooler installation already exists. Change its inputs and re-render instead (README.md).' >&2; exit 1; }
if ss -ltnH "( sport = :${AIHR_PGBOUNCER_LISTEN_PORT:-6432} )" | grep -q .; then
  echo 'The pooler port is already in use. Inspect before proceeding.' >&2; exit 1
fi

export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l
apt-get update
apt-get install -y --no-install-recommends pgbouncer postgresql-client ca-certificates

# Named prepared statements through the pooler need PgBouncer 1.21 or later. Refuse anything older.
VERSION="$(/usr/sbin/pgbouncer --version | awk 'NR==1{print $2}')"
MAJOR="${VERSION%%.*}"; REST="${VERSION#*.}"; MINOR="${REST%%.*}"
if ! [ "$MAJOR" -gt "$MIN_MAJOR" ] && ! { [ "$MAJOR" -eq "$MIN_MAJOR" ] && [ "$MINOR" -ge "$MIN_MINOR" ]; }; then
  echo "PgBouncer $VERSION is older than the required $MIN_MAJOR.$MIN_MINOR. Install a newer package before continuing." >&2
  exit 1
fi

# The distribution starts its own instance with its own configuration; this service replaces it.
systemctl disable --now pgbouncer 2>/dev/null || true

id aihr-pgbouncer >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin aihr-pgbouncer
install -d -o root -g aihr-pgbouncer -m 0750 /etc/aihr-pgbouncer
INSTALL_TMP="$(mktemp -d)"
trap 'rm -rf -- "$INSTALL_TMP"' EXIT
"$NODE_BIN" "$SCRIPT_DIR/render-config.mjs" "$INSTALL_TMP" | tee /etc/aihr-pgbouncer/sizing.txt
# The admin console uses peer authentication on the private socket, so this entry carries no password.
{ cat "$AIHR_PGBOUNCER_USERLIST_FILE"; printf '"aihr-pgbouncer" ""\n'; } > "$INSTALL_TMP/userlist.txt"
install -o root -g aihr-pgbouncer -m 0640 "$INSTALL_TMP/pgbouncer.ini" /etc/aihr-pgbouncer/pgbouncer.ini
install -o root -g aihr-pgbouncer -m 0640 "$INSTALL_TMP/pgbouncer_hba.conf" /etc/aihr-pgbouncer/pgbouncer_hba.conf
install -o root -g aihr-pgbouncer -m 0640 "$INSTALL_TMP/userlist.txt" /etc/aihr-pgbouncer/userlist.txt
install -o root -g root -m 0644 "$SCRIPT_DIR/aihr-pgbouncer.service" /etc/systemd/system/aihr-pgbouncer.service
install -o root -g root -m 0755 "$SCRIPT_DIR/pool-status.sh" /usr/local/sbin/aihr-pgbouncer-status

systemd-analyze verify /etc/systemd/system/aihr-pgbouncer.service
systemctl daemon-reload
systemctl enable --now aihr-pgbouncer
systemctl --no-pager --full status aihr-pgbouncer | head -5
runuser -u aihr-pgbouncer -- /usr/local/sbin/aihr-pgbouncer-status || true
echo 'The pooler is running. The application still connects directly until DATABASE_POOLED_URL is set (README.md, "Enable").'
