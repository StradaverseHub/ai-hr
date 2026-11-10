# PgBouncer transaction pooling for the web application

Status: candidate, disabled by default. Not installed on any staging or production server. Production deployment is held.

## Decision

The web application may reach PostgreSQL through PgBouncer in transaction mode, so that many application connections share a few real database connections. It is enabled per environment by `DATABASE_POOLED_URL`. When that is unset, the application uses `DATABASE_URL` exactly as before.

Only the application singleton in `db/client.ts` follows the pooled URL (`db/pooling.ts`). Every connection that names its own URL stays direct, and non-web processes (`AIHR_DB_PROCESS_ROLE=worker`) ignore the pooled URL even if they inherit it.

PgBouncer runs on the application host on loopback, with TLS and certificate verification to PostgreSQL, and pools only `ai_hr_app`. Configuration, sizing and operations are in [deploy/pgbouncer/README.md](../../deploy/pgbouncer/README.md).

## Why this is safe for tenant isolation

`withTenant` sets the tenant, user, roles and grants with `set_config(name, value, true)` inside the transaction. PostgreSQL clears them when that transaction ends, so a server connection returned to the pool carries nothing of the previous tenant. PgBouncer logs in as the connecting role and pools per role, so `current_user` stays `ai_hr_app` and row-level security applies unchanged.

## Compatibility audit

Transaction pooling breaks anything that needs one connection to last beyond a transaction. Line numbers are at the base commit `512b168d7`.

| Feature | Where | Decision |
| --- | --- | --- |
| Session `set_config(..., false)` | Tests only (`test/marriage-leave.test.ts:592`, `test/bank-import-point-read.test.ts:31`, `test/employee-choice-unicode-scale.test.ts:610`, `test/performance/module-read-jit-probe.ts:62`). No production code or migration | Compatible; tests connect directly |
| Session `SET` | Tests only (`test/bank-import-point-read-upgrade.test.ts:165`, `test/ai-centre-current-prefix-upgrade.test.ts:56`) | Compatible; tests connect directly |
| `SET LOCAL`, `set_config(..., true)` | `db/client.ts:293`, `core/notifications.ts:570` (`SET LOCAL ROLE`), `core/read.ts:847`, `core/payroll-audit/capture.ts:66`, `lib/internal-auth/report-broker.ts:46` and others | Compatible; transaction-scoped |
| Session advisory locks | `core/bank-import-worker.ts:123,137`, `core/individual-import-worker.ts:24,66`, `core/leave-import-worker.ts:98,112`, `core/loops/tick.ts:42,45`; dev fixtures in `scripts/dev-fixture-*` | Direct. All use the owner connection from `MIGRATION_DATABASE_URL`, which the pooler does not admit |
| Transaction advisory locks | 352 files, e.g. `lib/internal-auth/store.ts:29` | Compatible; verified through the pooler |
| LISTEN / NOTIFY, `pg_notify` | None | Nothing to do |
| Temporary tables | `scripts/improve/remote.ts:79`, migrations `0642`, `0651`, `0655`, `2503`, `3500`, `3501` | Direct; none on the web path |
| Cursors | `core/analytics.ts:1123`, `core/system-labels.ts:233`, `core/employee-choice.ts:182`, all without `WITH HOLD` inside a transaction. `WITH HOLD`: none | Compatible |
| Prepared statements | postgres.js defaults to named statements; `deploy/identity-email/report-auth-broker.ts:23` sets `prepare: false` | Compatible, using PgBouncer 1.21+ `max_prepared_statements`. Keeping the driver default avoids the extra describe round trip that `prepare: false` adds to every parameterized query |
| COPY | None in application code; `scripts/backup-db.sh` and `scripts/restore-rehearsal.sh` use `pg_dump` / `pg_restore` | Direct |
| `reserve()` | `core/bank-import-worker.ts:119`, `core/individual-import-worker.ts:22`, `core/leave-import-worker.ts:96`, `core/loops/tick.ts:40` | Direct, as for advisory locks |
| `reserve()` on the web path | `lib/internal-auth/store.ts:22` | Compatible. It only serializes autocommit reads, with no BEGIN and no session state (`lib/internal-auth/service.ts:305`, `lib/entra/sessions.ts:74`) |
| `pg_backend_pid` in production | `packs/attendance/overtime-calculation.ts:86`, migrations `0548` and `0949` | Compatible; used only within one transaction |
| `pg_backend_pid` and `pg_stat_activity` in tooling | `scripts/performance/measured-lock-observer.mjs:15`, `scripts/performance/lock-sample-attribution.mjs:129`, `scripts/performance/system-load-owner.mjs:348`, and tests | Direct. Behind a pooler a backend serves many clients, so the sampler still attributes each transaction correctly, but a backend count is no longer a client count |
| Migrations | `scripts/migrate-with-focused-prerequisites.ts` via `MIGRATION_DATABASE_URL` | Direct. `check-customer-env.mjs` refuses a migration URL pointing at the pooler |
| Import, timer and Entra workers, report renderer | `scripts/bank-import-runner.ts:10`, `scripts/leave-import-runner.ts:10`, `scripts/*-sweep.ts`, `lib/entra/worker.ts:9`, `deploy/identity-email/renderer-peer.py:29` | Direct, enforced by `AIHR_DB_PROCESS_ROLE=worker` |
| Startup parameters | `deploy/identity-email/internal-report-agent.ts:10`, `scripts/account-email-retention.ts:5` | Direct. `db/client.ts` sends only what PgBouncer tracks |

## Consequences

The connection budget changes meaning when pooling is on: the web fleet costs PostgreSQL only the pooler's `max_db_connections`. `db/pooling.ts` translates the environment for the existing check, leaving the formula in `db/capacity.ts` unchanged.

`query_wait_timeout` and `max_client_conn` refusals (SQLSTATE `08P01`) count as capacity failures, so reads retry and users see the degraded state rather than an error page.

Fair admission holds per process and PgBouncer queues first come, first served, so a web fleet far larger than the server pool would queue where tenants are not told apart. The operating guidance is a fleet within about three times `max_db_connections`.

postgres.js fetches array types when a connection opens, in a promise with no rejection handler. If that query times out in the pooler, the rejection is unhandled. Next.js logs it and continues; a plain Node process would exit, which is why workers stay direct. Removing the risk needs a fix in postgres.js or in how it is patched here.
