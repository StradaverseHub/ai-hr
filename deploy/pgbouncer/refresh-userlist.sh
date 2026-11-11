#!/usr/bin/env bash
# Prints the pooler's userlist: one line per pooled role, with its SCRAM verifier from the database.
# Run it where a privileged PostgreSQL connection is available. Reading pg_authid needs superuser.
#
#   PGSERVICE=aihr_dba deploy/pgbouncer/refresh-userlist.sh ai_hr_app > /secure/userlist.txt
#
# Nothing is written to disk by this script and no secret is taken from argv. Then:
#   install -o root -g aihr-pgbouncer -m 0640 /secure/userlist.txt /etc/aihr-pgbouncer/userlist.txt
#   systemctl reload aihr-pgbouncer
# Re-run after every ALTER ROLE ... PASSWORD, or the pooler keeps offering the old verifier.
set -euo pipefail
[ "$#" -ge 1 ] || { echo 'Usage: refresh-userlist.sh ROLE [ROLE...]' >&2; exit 2; }
for role in "$@"; do
  [[ "$role" =~ ^[a-z_][a-z0-9_]*$ ]] || { echo 'Role names must be plain identifiers.' >&2; exit 2; }
done
# A role with an md5 or empty verifier cannot be logged in through SCRAM pass-through. Refuse it.
roles=$(IFS=,; printf '%s' "$*")
lines=$(psql -X -qAt -v ON_ERROR_STOP=1 -v roles="$roles" <<'SQL'
select format('"%s" "%s"', rolname, rolpassword) from pg_catalog.pg_authid
 where rolname = any (string_to_array(:'roles', ',')) and rolcanlogin and rolpassword like 'SCRAM-SHA-256$%' order by rolname;
SQL
)
expected=$#
actual=$(printf '%s\n' "$lines" | grep -c . || true)
[ "$actual" -eq "$expected" ] || { echo "Expected $expected SCRAM verifier(s), found $actual. Every pooled role needs a SCRAM-SHA-256 password." >&2; exit 1; }
printf '%s\n' "$lines"
