#!/usr/bin/env bash
# Shared plumbing for scripts/backup-db.sh and scripts/restore-rehearsal.sh. SOURCED, never executed.
#
# WHY A SHARED FILE AND NOT TWO COPIES
# ------------------------------------
# One thing in here is load-bearing enough to justify the indirection: WHICH postgres client binary
# runs. A dump is written by pg_dump and read by pg_restore, and those two programs are usually not
# the same install — the dump is taken on the server (Ubuntu, /usr/lib/postgresql/16/bin) and the
# rehearsal may be run on a laptop, where `pg_dump` on PATH is whatever Homebrew linked last. On THIS
# machine that is PostgreSQL 14.17, while the cluster it has to read is 16.14 and the production
# server is 16.15. pg_dump refuses a newer server outright; pg_restore 14 cannot parse an archive
# written by pg_dump 16 at all ("unsupported version in file header"). Either way the failure lands at
# RESTORE time, which is the one moment you cannot afford to discover it. So version selection happens
# once, here, explicitly, and the version that wrote each archive is recorded in its manifest.
#
# Every function is prefixed `blib_`.

# ── small portability helpers ────────────────────────────────────────────────────────────────────
blib_have() { command -v "$1" >/dev/null 2>&1; }

# macOS has shasum, Linux has sha256sum, and the dump's checksum is how both scripts tell "the file
# arrived intact" from "the file arrived".
blib_sha256() {
  if blib_have sha256sum; then sha256sum "$1" | cut -d' ' -f1
  elif blib_have shasum; then shasum -a 256 "$1" | awk '{print $1}'
  else echo 'sha256-unavailable'; fi
}

# `wc -c` rather than stat: GNU stat is -c%s and BSD stat is -f%z, and this runs on both.
blib_bytes() { wc -c < "$1" | tr -d ' '; }

# UTC, to the second, sortable as a string. The backup filename carries this stamp and retention reads
# the AGE OUT OF THE NAME rather than out of the filesystem — see blib_cutoff_stamp.
blib_stamp() { date -u +%Y%m%dT%H%M%SZ; }

# "now minus N days", in the same format, so retention is a pure string comparison. GNU date and BSD
# date disagree on how to say it and there is no portable third way; try both, fail loudly if neither
# works rather than silently returning an empty cutoff (which would compare as "older than everything"
# and delete the lot).
blib_cutoff_stamp() {
  local days="$1" out
  out=$(date -u -d "${days} days ago" +%Y%m%dT%H%M%SZ 2>/dev/null) && { printf '%s\n' "$out"; return 0; }
  out=$(date -u -v-"${days}"d +%Y%m%dT%H%M%SZ 2>/dev/null) && { printf '%s\n' "$out"; return 0; }
  return 1
}

# ── connection-string parsing ────────────────────────────────────────────────────────────────────
# Deliberately small: the database name and the role are all either script needs, and both are read
# for REPORTING and for guards, never to rebuild a URL.
blib_url_db() {
  printf '%s\n' "$1" | sed -E 's#\?.*$##; s#^.*/([^/]*)$#\1#'
}
blib_url_user() {
  printf '%s\n' "$1" | sed -E 's#^[a-zA-Z0-9+.-]+://##; s#@.*$##; s#:.*$##'
}

# ── postgres client selection ────────────────────────────────────────────────────────────────────
# Candidate bin directories, one per line, in no particular order; blib_pg_bin_for_major sorts them.
blib_candidate_bins() {
  local d
  for d in /usr/lib/postgresql/*/bin /opt/homebrew/opt/postgresql@*/bin \
           /usr/local/opt/postgresql@*/bin /usr/pgsql-*/bin; do
    [ -x "$d/pg_dump" ] && printf '%s\n' "$d"
  done
  if blib_have pg_dump; then
    d=$(dirname "$(command -v pg_dump)")
    [ -x "$d/pg_dump" ] && printf '%s\n' "$d"
  fi
}

# Major version of a pg_dump/pg_restore/psql binary, or empty if it will not run.
blib_bin_major() {
  local v
  v=$("$1" --version 2>/dev/null | sed -E 's/.*\(PostgreSQL\) ([0-9]+).*/\1/') || return 1
  case "$v" in ''|*[!0-9]*) return 1 ;; esac
  printf '%s\n' "$v"
}

# Any psql at all, for the one query that every client version can answer. libpq is
# forwards-compatible for plain queries, so a 14 psql reading `server_version_num` off a 16 server is
# fine — it is pg_dump and pg_restore that care, and they are chosen separately below.
blib_any_psql() {
  local d
  if [ -n "${PG_BIN:-}" ] && [ -x "$PG_BIN/psql" ]; then printf '%s\n' "$PG_BIN/psql"; return 0; fi
  while read -r d; do [ -x "$d/psql" ] && { printf '%s\n' "$d/psql"; return 0; }; done < <(blib_candidate_bins)
  blib_have psql && { command -v psql; return 0; }
  return 1
}

blib_server_version_num() {
  local psql_bin
  psql_bin=$(blib_any_psql) || return 1
  "$psql_bin" -X -q -At -d "$1" -c 'show server_version_num' 2>/dev/null | tr -d ' '
}

# The bin directory whose client major is >= $1, choosing the LOWEST that qualifies.
#
# Lowest, not highest, and that is a decision rather than an accident. pg_dump's custom-format archive
# carries a format version that only an equal-or-newer pg_restore can read, so every extra major
# version on the WRITING side is one more machine that cannot read the backup. Dumping a 16 server
# with a 17 client would work and would produce an archive this box's own pg_restore 16 could not
# open. The rule is therefore: new enough for the server, and no newer.
#
# PG_BIN, when set, overrides the search entirely and is NOT version-checked here — the caller checks
# it and reports, so an operator who points at a specific install gets a clear message rather than
# having their choice silently discarded.
blib_pg_bin_for_major() {
  local need="$1" d major best_major='' best=''
  while read -r d; do
    major=$(blib_bin_major "$d/pg_dump") || continue
    [ "$major" -ge "$need" ] || continue
    if [ -z "$best_major" ] || [ "$major" -lt "$best_major" ]; then best_major="$major"; best="$d"; fi
  done < <(blib_candidate_bins)
  [ -n "$best" ] || return 1
  printf '%s\n' "$best"
}

# Everything this machine has, for an error message that tells the operator what to do next rather
# than only what went wrong.
blib_describe_clients() {
  local d major
  while read -r d; do
    major=$(blib_bin_major "$d/pg_dump" || echo '?')
    printf '    %s  (pg_dump %s)\n' "$d" "$major"
  done < <(blib_candidate_bins)
}

# ── the measurements, written ONCE and used by both scripts ──────────────────────────────────────
#
# scripts/backup-db.sh runs these against the live database inside the dump's own snapshot;
# scripts/restore-rehearsal.sh runs the IDENTICAL text against the restored database and diffs the two
# outputs. That is why they live here rather than in either script: two copies of "how a database is
# measured" would drift, and the first symptom of the drift would be a rehearsal that passes because
# it is comparing two things it measured differently.
#
# Every line is `<kind> TAB <fields…>`, single-column so `psql -At` cannot reformat it, and sorted
# before comparison so row order never matters. Comparing by DIFF rather than by a list of hand-written
# assertions is deliberate: a diff notices a table that appeared, a table that vanished, an RLS flag
# that flipped and a policy that was dropped, none of which anyone thought to assert.

# Exact row counts for every ordinary and partitioned table. query_to_xml runs the count inside the
# current transaction — and therefore inside the dump's snapshot — which pg_class.reltuples (an
# estimate, updated by ANALYZE) could never do.
blib_tables_sql() {
cat <<'SQL'
SELECT 'table' || E'\t' || n.nspname || E'\t' || c.relname || E'\t'
    || (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text
    || E'\t' || CASE WHEN c.relrowsecurity THEN 't' ELSE 'f' END
    || E'\t' || (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::text
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind IN ('r','p')
   AND n.nspname NOT IN ('pg_catalog','information_schema')
   AND n.nspname NOT LIKE 'pg_toast%'
 ORDER BY 1;
SQL
}

# Every role named as a GRANTEE anywhere in the dumped schema.
#
# This is a PREFLIGHT list for the rehearsal, not part of the diff, and the distinction is load-bearing:
# pg_restore --no-owner rewrites ownership to whoever is restoring, so the owner's own ACL entry comes
# back under a different name and a diff would report a difference that is not one. What the rehearsal
# does with this list is check the roles EXIST before it starts — because a GRANT to a role the target
# cluster has never heard of aborts the restore halfway through with an error that reads like a dump
# corruption and is not.
blib_roles_sql() {
cat <<'SQL'
SELECT DISTINCT 'role' || E'\t' || CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END
  FROM (
    SELECT (aclexplode(c.relacl)).grantee AS grantee
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relacl IS NOT NULL AND c.relkind IN ('r','p','v','m','S')
       AND n.nspname NOT IN ('pg_catalog','information_schema')
    UNION
    SELECT (aclexplode(n.nspacl)).grantee
      FROM pg_namespace n
     WHERE n.nspacl IS NOT NULL AND n.nspname NOT IN ('pg_catalog','information_schema')
  ) x
 ORDER BY 1;
SQL
}

# The one-line facts that are not per-table. `migrations` is the drizzle watermark: a restore that
# comes back with a different count is a restore of a different schema than the manifest describes.
blib_head_sql() {
cat <<'SQL'
SELECT 'migrations' || E'\t' || coalesce((
  SELECT (xpath('/row/c/text()', query_to_xml('select count(*) as c from drizzle.__drizzle_migrations', false, true, '')))[1]::text
    FROM (SELECT 1) z WHERE to_regclass('drizzle.__drizzle_migrations') IS NOT NULL
), 'none');
SQL
}

# WHAT THE APPLICATION ROLE CAN SEE — the check that separates "restored" from "usable".
#
# Everything above is measured as the OWNER, and the owner is exactly the role whose answers cannot
# tell you whether the restore is usable: it holds every privilege by construction, and RLS here is
# ENABLED rather than FORCED, so the owner bypasses every policy. A database can pass all of it and
# still be unusable by the product, in two ways that have both happened in this repo's history:
#
#   • GRANTS LOST. CLAUDE.md §6 records it directly — "a dev restore has no default privileges" —
#     and migrations 0345 and 0354 shipped tables the app role could not read for exactly this
#     reason. pg_dump --no-privileges, or a restore into a database whose default privileges differ,
#     produces tables a superuser reads perfectly and the application cannot read at all.
#   • POLICIES LOST. Readiness 1.7 had just closed the last table with RLS disabled. A restore that
#     brings the data back without the policies is not a recovered system, it is a cross-tenant leak
#     with the customer's data already in it.
#
# So this runs as the APPLICATION role, twice: once with a tenant context, once without. The first
# must reproduce the counts recorded at backup time — proving grants and policies both survived and
# the rows are reachable the way the product reaches them. The second must be zero everywhere —
# proving the isolation came back with the data. A table the app role cannot SELECT drops out of the
# list entirely, so a lost grant shows up as a MISSING LINE rather than as a SQL error nobody reads.
blib_write_probe_sql() {
cat > "$1" <<'SQL'
\set ON_ERROR_STOP on
BEGIN ISOLATION LEVEL REPEATABLE READ;
SET TRANSACTION SNAPSHOT :'snap';
SELECT set_config('app.tenant_id', :'tenant', true) \gset ignore_
SELECT 'probe_ctx' || E'\t' || n.nspname || E'\t' || c.relname || E'\t'
    || (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind IN ('r','p') AND c.relrowsecurity
   AND n.nspname NOT IN ('pg_catalog','information_schema')
   AND has_table_privilege(current_user, c.oid, 'SELECT')
   AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND a.attnum > 0 AND NOT a.attisdropped)
 ORDER BY 1;
SELECT set_config('app.tenant_id', '', true) \gset ignore_
SELECT 'probe_noctx' || E'\t' || n.nspname || E'\t' || c.relname || E'\t'
    || (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind IN ('r','p') AND c.relrowsecurity
   AND n.nspname NOT IN ('pg_catalog','information_schema')
   AND has_table_privilege(current_user, c.oid, 'SELECT')
   AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND a.attnum > 0 AND NOT a.attisdropped)
 ORDER BY 1;
COMMIT;
SQL
}

# The same probe against a database that is NOT in a shared snapshot (the restored scratch database).
# Identical SELECTs, no SET TRANSACTION SNAPSHOT — which is the only line that can differ, because a
# snapshot cannot be imported into a database that did not export it.
blib_write_probe_sql_local() {
  blib_write_probe_sql "$1"
  # Drop the snapshot import; keep everything else byte-identical so the two sides cannot drift.
  sed -i.bak "/^SET TRANSACTION SNAPSHOT/d" "$1" && rm -f "$1.bak"
}

# ── retention, as a script run AT the destination ────────────────────────────────────────────────
# Emitted as text so the same code runs locally (`bash -s`) and remotely (`ssh … bash -s`). There is
# no second implementation, so a fix to one is a fix to both.
#
# Two rules, and the order matters: the newest KEEP files survive whatever their age, and only what is
# left is considered against the cutoff. Reversing that would let a box that has been off for a month
# delete every backup it has and report success.
blib_prune_script() {
  local dir="$1" prefix="$2" cutoff="$3" keep="$4"
cat <<PRUNE
set -u
dir='$dir'; prefix='$prefix'; cutoff='$cutoff'; keep=$keep
cd "\$dir" 2>/dev/null || exit 0
i=0
ls -1 2>/dev/null | grep -E "^\${prefix}-[0-9]{8}T[0-9]{6}Z\.dump\$" | sort -r | while read -r f; do
  i=\$((i+1))
  [ "\$i" -le "\$keep" ] && continue
  stamp=\${f#\${prefix}-}; stamp=\${stamp%.dump}
  # String comparison, because both sides are fixed-width UTC stamps: no date parsing at the far end,
  # which may be a machine with a different date(1) than this one.
  older=\$(printf '%s\n%s\n' "\$stamp" "\$cutoff" | sort | head -1)
  if [ "\$older" = "\$stamp" ] && [ "\$stamp" != "\$cutoff" ]; then
    rm -f "\$f" "\${prefix}-\${stamp}.manifest" && echo "\$f"
  fi
done
PRUNE
}

# Swap the database name on a postgres:// URL, keeping credentials, host, port and parameters. The
# rehearsal needs the operator's connection details pointed at a scratch database whose name it chose.
#
# NOT sed. The first version of this was `sed -E "s#...#...#"`, and a database name containing the
# delimiter — `#` — made sed fail and the function return an EMPTY STRING. psql handed an empty -d
# argument does not error: it falls back to the local socket and the invoking user's own database, so
# the rehearsal would have gone looking at a completely different server and said nothing. That is the
# same shape of defect as the whole readiness item — a failure that presents as success — so it is
# fixed here with parameter expansion, which has no delimiter, and the caller validates the name.
blib_url_with_db() {
  local url="$1" db="$2" query='' scheme rest hostpart
  case "$url" in *\?*) query="?${url#*\?}"; url="${url%%\?*}" ;; esac
  case "$url" in *://*) : ;; *) return 1 ;; esac
  scheme="${url%%://*}"
  rest="${url#*://}"
  hostpart="${rest%%/*}"
  [ -n "$hostpart" ] || return 1
  printf '%s://%s/%s%s\n' "$scheme" "$hostpart" "$db" "$query"
}

# Sub-second where perl is available (it is, on both Ubuntu and macOS), whole seconds otherwise. A
# restore time is a number the owner has to be able to quote; rounding a 40-second restore to "0" or
# "1" would make the recovery-time objective look like a formality.
blib_now() {
  perl -MTime::HiRes=time -e 'printf "%.3f\n", time' 2>/dev/null || date +%s
}
blib_elapsed() { awk -v a="$1" -v b="$2" 'BEGIN{printf "%.3f\n", b-a}'; }
