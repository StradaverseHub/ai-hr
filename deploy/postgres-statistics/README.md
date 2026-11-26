# Query statistics on an installation (ADR 0181, Phase 0)

`50-aihr-query-statistics.conf` turns on `pg_stat_statements` and sampled `auto_explain`, so slow statements are
ranked from the database's own counters rather than inferred from request timing.

## Authority

- **Staging:** owner-approved on 24 November 2026. Apply under the shared staging lease
  (`docs/STAGING-RELEASE-QUEUE.md`). It needs an administrator with sudo, because it writes `/etc/postgresql` and
  restarts Postgres.
- **Production:** not approved. It needs a separate explicit production permission and a planned window, shared with
  database memory sizing so there is one restart rather than two.

## Apply (administrator, staging)

1. Hold the staging lease. Confirm no release, gate or import is running.
2. Check that no other file sets `shared_preload_libraries`:
   `grep -rn shared_preload_libraries /etc/postgresql/16/main/`.
3. Install the file:
   `sudo install -o postgres -g postgres -m 0644 50-aihr-query-statistics.conf /etc/postgresql/16/main/conf.d/`.
4. Restart: `sudo systemctl restart postgresql@16-main`. Then confirm the web service is healthy.
5. As the database owner, run `create extension if not exists pg_stat_statements;` in `ai_hr`. This is an
   extension in the `public` schema, owned by the superuser. It is not an application migration and the application
   role needs no grant for it.
6. Confirm: `show shared_preload_libraries;` lists both libraries, and `select count(*) from pg_stat_statements;`
   returns a number.

## Read

Statement text in `pg_stat_statements` is normalised: constants become `$1`, `$2`. `auto_explain` writes plans to the
Postgres log in JSON with bind values suppressed (`log_parameter_max_length = 0`). A literal written directly into
SQL text still appears, so treat the log as private to the host. Report only aggregates (calls, total and mean time,
rows, buffers) by `queryid` and normalised text.

## Roll back

Remove the file and restart. Statistics are lost on restart, which is harmless.
