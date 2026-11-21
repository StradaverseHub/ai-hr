#!/usr/bin/env bash
# Shows pool saturation from the PgBouncer admin console. Exits 1 when clients are waiting too long, so it
# can run from a timer or through deploy/cron-alert.sh.
#
#   sudo -u aihr-pgbouncer /usr/local/sbin/aihr-pgbouncer-status            # one reading
#   sudo -u aihr-pgbouncer /usr/local/sbin/aihr-pgbouncer-status --watch    # every five seconds
set -euo pipefail
SOCKET_DIR="${AIHR_PGBOUNCER_SOCKET_DIR:-/run/aihr-pgbouncer}"
PORT="${AIHR_PGBOUNCER_LISTEN_PORT:-6432}"
CONSOLE_USER="${AIHR_PGBOUNCER_CONSOLE_USER:-aihr-pgbouncer}"
ALERT_WAIT_SECONDS="${AIHR_PGBOUNCER_ALERT_WAIT_SECONDS:-5}"

reading() {
  # --csv so columns are read by name: their position changes between PgBouncer versions.
  psql -X -q --csv -h "$SOCKET_DIR" -p "$PORT" -U "$CONSOLE_USER" pgbouncer -c 'SHOW POOLS;' | python3 -I -B -c '
import csv,sys,os
alert=int(os.environ["ALERT_WAIT_SECONDS"]); worst=0
print("database        user        clients  waiting  servers(active/idle/used)  longest wait")
for row in csv.DictReader(sys.stdin):
    if row["database"]=="pgbouncer": continue
    wait=int(row["maxwait"])+int(row["maxwait_us"])/1e6; worst=max(worst,wait)
    print("{:<15} {:<11} {:>7}  {:>7}  {:>26}  {:.3f}s".format(row["database"],row["user"],row["cl_active"],row["cl_waiting"],
          row["sv_active"]+"/"+row["sv_idle"]+"/"+row["sv_used"],wait))
if worst>=alert:
    print("SATURATED: a client has waited {:.1f}s for a server connection (alert at {}s).".format(worst,alert)); sys.exit(1)
' 
}
export ALERT_WAIT_SECONDS
if [ "${1:-}" = "--watch" ]; then
  while true; do date -u +%H:%M:%S; reading || true; sleep 5; done
fi
reading
