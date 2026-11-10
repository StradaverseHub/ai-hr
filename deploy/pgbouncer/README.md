# PgBouncer transaction pooling

PgBouncer sits between the web application and PostgreSQL and lets many application connections share a few real database connections. It is optional and off by default. Nothing changes until `DATABASE_POOLED_URL` is set and the web service restarts.

Decision and compatibility audit: [ADR 2026-11-10](../../docs/adr/2026-11-10-pgbouncer-transaction-pooling.md).

## What goes through the pooler

| Connection | Route | Why |
| --- | --- | --- |
| Web application (`db/client.ts`) | Pooler, when `DATABASE_POOLED_URL` is set | Holds no session state: every tenant setting is transaction-local |
| Migrations, `MIGRATION_DATABASE_URL` | Direct | Need session state and run DDL; the pooler refuses this role |
| Import worker, timers, Entra worker, report renderer | Direct | Hold session advisory locks or are not protected against a pooler timeout (see below) |
| Platform control plane, `PLATFORM_DATABASE_URL` | Direct | A separate privileged role that must not share a route with the application |
| Backups and operator sessions | Direct | `pg_dump` and interactive sessions need a real session |

`AIHR_DB_PROCESS_ROLE=worker`, which every non-web unit already sets, forces the direct URL even if the process inherits `DATABASE_POOLED_URL`. Workers own session advisory locks and long single-tenant jobs, and they are already counted in the direct background budget.

postgres.js fetches array types as the first query of each new connection. `patches/postgres@3.4.9.patch` makes a pooler refusal of that query an ordinary, handled capacity failure instead of an unhandled rejection.

## Where it runs

On the application host, listening on loopback only. In the customer layout (one application host, one database host) this keeps the application-to-pooler leg on the local machine. The listener address is checked by `render-config.mjs`, which refuses anything but `127.0.0.1`.

## Sizing

`render-config.mjs` computes everything below from the database's CPU cores and the connection budget in `db/capacity.ts`, so the install, this document and the tests agree. It prints the result, including the value for `AIHR_DB_POOLER_SERVER_CONNECTIONS`.

```
budget   = max_connections - superuser_reserved - background - reserved - platform
default  = clamp(2 x cores + 2, 4, floor(7/8 x budget))          default_pool_size
reserve  = max(1, ceil(default / 8)), within the budget          reserve_pool_size
server   = default + reserve                                     max_db_connections
clients  = max(2000, 2 x web workers x pool per worker + 64)     max_client_conn
minimum  = ceil(default / 4)                                     min_pool_size
```

- `background` is `AIHR_DB_BACKGROUND_CONNECTIONS`, `reserved` is `AIHR_DB_RESERVED_CONNECTIONS`, and `platform` is two connections per web worker when the control plane is on. All of them stay direct, so they come out of the budget first.
- `2 x cores + 2` keeps enough connections busy to use the CPUs, with a small allowance for connections waiting on locks. More connections than this add contention rather than throughput.

| Setting | Value | Effect |
| --- | --- | --- |
| `pool_mode` | `transaction` | A server connection belongs to a client only for one transaction |
| `default_pool_size` | formula | Working server connections |
| `reserve_pool_size` / `reserve_pool_timeout` | formula / 3 s | Extra connections granted once a client has waited 3 seconds |
| `max_db_connections` | formula | Hard ceiling on server connections; the deploy check compares this with `max_connections` |
| `max_client_conn` | formula | Client connections PgBouncer accepts. Needs file descriptors, so the unit sets `LimitNOFILE=65536` |
| `min_pool_size` | formula | Server connections kept open and ready |
| `server_idle_timeout` | 300 s | Closes server connections idle this long, returning them to PostgreSQL after a burst |
| `server_lifetime` | 3600 s | Recycles server connections hourly |
| `query_wait_timeout` | 30 s | A client waiting this long for a server connection is refused. The application treats this as capacity: reads retry, then the page shows its degraded state |
| `max_prepared_statements` | 200 | PgBouncer tracks named prepared statements per server connection. Requires 1.21 or later |

Example for a 4-core database, `max_connections` 100, four web workers with eight connections each: budget 76, `default_pool_size` 10, `reserve_pool_size` 2, `max_db_connections` 12, `max_client_conn` 2000. The deployment environment then declares `AIHR_DB_POOLER_SERVER_CONNECTIONS=12`.

Keep the web fleet (`AIHR_APP_WORKERS` x `AIHR_DB_POOL_MAX`) within about three times `max_db_connections`. Admission control shares connections fairly between tenants within each process; demand well beyond the server pool queues inside PgBouncer, where tenants are not told apart.

## Roles and row-level security

PgBouncer keeps a separate server pool for each database and user, and logs in to PostgreSQL as the connecting user. The `[databases]` entry deliberately has no `user=`, which would force every client onto a single role. The HBA file admits only `ai_hr_app`, on loopback, so the owner and platform roles cannot use the pooler at all.

Row-level security is unaffected. `withTenant` sets the tenant, user, roles and grants with `set_config(..., true)`, which PostgreSQL clears at the end of the transaction, before the server connection returns to the pool.

## Authentication

`userlist.txt` holds SCRAM verifiers, never passwords. PgBouncer authenticates the client against the verifier and reuses the client's SCRAM exchange to log in to PostgreSQL, so nothing plaintext is stored. `refresh-userlist.sh` reads the verifier from the database and prints it. Rerun it and reload the service after every `ALTER ROLE ... PASSWORD`.

`auth_query` is the alternative when many roles are pooled, at the cost of a dedicated role and a `SECURITY DEFINER` lookup function in the database. With one pooled role, the userlist needs no database objects.

## TLS

- **Application to pooler:** loopback, no TLS. The application's `sslmode=verify-full` rule does not apply to loopback, and `check-customer-env.mjs` enforces it for any other pooler address.
- **Pooler to database:** `server_tls_sslmode = verify-full`, with `server_tls_ca_file` set to the database CA. The `[databases]` host must match the database certificate, which is the same host name `DATABASE_URL` uses.
- A remote pooler would need `client_tls_*` settings and a certificate of its own. That is a separate review, and `render-config.mjs` refuses a non-loopback listener.

## Install

Run as the approved server administrator on the application host. The running application is not affected at this stage. `apt-get` must be able to install PgBouncer 1.21 or later; `install.sh` refuses anything older.

1. On a host with superuser access to the database, produce the userlist and move it privately to the application host, mode 0600:

   ```bash
   PGSERVICE=aihr_dba deploy/pgbouncer/refresh-userlist.sh ai_hr_app > /secure/userlist.txt
   ```

2. Read the two inputs from the database: `SHOW max_connections;` and the CPU core count of the database VM.

3. Install. PLATFORM_DATABASE_URL must be exported here if the control plane is on, so the budget counts its pools.

   ```bash
   sudo env AIHR_DB_CPU_CORES=4 AIHR_DB_MAX_CONNECTIONS=100 \
     AIHR_PGBOUNCER_DATABASE_HOST=YOUR_DATABASE_DNS_NAME \
     AIHR_PGBOUNCER_SERVER_CA_FILE=/etc/ssl/certs/aihr-database-ca.pem \
     AIHR_APP_WORKERS=4 AIHR_DB_POOL_MAX=8 AIHR_DB_BACKGROUND_CONNECTIONS=16 AIHR_DB_RESERVED_CONNECTIONS=5 \
     AIHR_PGBOUNCER_USERLIST_FILE=/secure/userlist.txt \
     bash deploy/pgbouncer/install.sh
   ```

   The script prints `AIHR_DB_POOLER_SERVER_CONNECTIONS=<n>`; note it for the next section.

4. Test the pooler alone, before the application uses it:

   ```bash
   psql "postgresql://ai_hr_app@127.0.0.1:6432/ai_hr" -c 'select current_user, inet_server_addr()'
   sudo -u aihr-pgbouncer /usr/local/sbin/aihr-pgbouncer-status
   ```

To change a setting later, re-render with new inputs (`install.sh --render-only` into a private directory), install the files over `/etc/aihr-pgbouncer/` and run `sudo systemctl reload aihr-pgbouncer`.

## Enable

Set these in the environment the web service reads (`/etc/aihr/runtime.env` for the customer unit, `/opt/ai-hr/.env.production` for `aihr.service`), and in `.env.production` so the deploy preflight sees them. Keep `DATABASE_URL` as it is: the direct URL stays the fallback.

```bash
DATABASE_POOLED_URL=postgresql://ai_hr_app:PASSWORD@127.0.0.1:6432/ai_hr
AIHR_DB_POOLER_SERVER_CONNECTIONS=<the printed value>
```

Then, through the normal release path for that environment:

1. Run `node --env-file=.env.production --import tsx scripts/check-db-connection-budget.ts`. It checks the budget and that the pooler logs in as the application role.
2. Restart the web service and confirm `/health`, a real sign-in, and a denied cross-scope request.
3. Watch `aihr-pgbouncer-status` under normal use: `waiting` should stay at or near zero.

## Seeing saturation

`/usr/local/sbin/aihr-pgbouncer-status` (`deploy/pgbouncer/pool-status.sh`) reads `SHOW POOLS` and exits 1 once a client has waited `AIHR_PGBOUNCER_ALERT_WAIT_SECONDS` (default 5), so `deploy/cron-alert.sh` can run it. Run it as `aihr-pgbouncer`; the console uses peer authentication on `/run/aihr-pgbouncer`.

| `SHOW POOLS` column | Meaning | Action |
| --- | --- | --- |
| `cl_waiting`, `maxwait` | Clients with no server connection, and how long the oldest has waited | Rising and sustained means the pool is too small or a query is holding it |
| `sv_active`, `sv_idle`, `sv_used` | Server connections busy, idle and idle-but-recently-used | `sv_active` at `default_pool_size` with `cl_waiting` above zero is saturation |

`SHOW STATS` gives per-database totals: `avg_wait_time`, `total_xact_count` and query counts. `journalctl -u aihr-pgbouncer` records refusals such as `query_wait_timeout` and `max_client_conn`.

## Roll back

Nothing here changes the database, its roles or its data, so rollback is configuration only.

1. Remove `DATABASE_POOLED_URL` and `AIHR_DB_POOLER_SERVER_CONNECTIONS` from the environment files.
2. Check that `AIHR_DB_TOTAL_CONNECTIONS` still fits `max_connections` directly, then restart the web service. It connects with `DATABASE_URL` again.
3. Stop the pooler when convenient: `sudo systemctl disable --now aihr-pgbouncer`. `/etc/aihr-pgbouncer/` holds a verifier, so remove it with the secret-handling procedure if the pooler is being retired.

## Reproduce the proof

`test/pgbouncer-transaction-pool.test.ts` exercises the real application path through a real PgBouncer. Set `TEST_PGBOUNCER_HOSTPORT` to a running transaction-mode pooler in front of the test database. On GitHub's Linux runners the test starts its own container. `scripts/performance/pgbouncer-load-check.mjs` measures clients against server connections and latency on fictional rows; run it only against a disposable target, because it creates and drops the schema `pgb_load`.
