/**
 * Vitest globalSetup — build ONE migrated template database, then hand every worker its own copy.
 *
 * WHY THIS EXISTS
 * ---------------
 * The suite used to run serially in a single worker against one shared database, and 247 of the 325 test
 * files called `migrateTestDb()` in `beforeAll` — each one re-reading and hashing all ~233 migration files
 * only to conclude there was nothing to apply. That is O(files x migrations) of pure overhead on one core,
 * and it grew with every round: more tests, more migrations, both multiplying.
 *
 * The fix is Postgres' own `CREATE DATABASE ... TEMPLATE`, which is a file-level copy of an existing
 * database. We migrate ONCE into a schema-only template (no seed data — `seedBase()` still runs per test),
 * then stamp out one database per vitest worker. Copying a schema-only database is far cheaper than
 * replaying the migration chain, so per-worker setup goes from "apply 233 migrations" to "copy some files".
 *
 * Per-worker databases also remove the reason the suite was pinned to one worker. Workers no longer share
 * tables, so `resetDb()`'s TRUNCATE can't deadlock against a sibling and `fileParallelism` can be turned on.
 *
 * TWO POSTGRES DETAILS THAT MATTER HERE
 * -------------------------------------
 * 1. A template must have NO open connections while it is being copied — so the migrator client is closed
 *    before any worker database is created, and nothing ever connects to the template afterwards.
 * 2. TEMPLATE copies the database CONTENTS (schemas, tables, and their ACLs) but NOT the `pg_database` row's
 *    own ACL. Database-level `GRANT CONNECT` therefore has to be re-issued on every copy, or the app role
 *    gets "permission denied for database" the moment a test tries to connect under RLS.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { seedCatalogs } from '../scripts/seed-catalogs';

/** Table stamped into the template recording what built it, so a later run can tell whether to reuse it. */
const FINGERPRINT_TABLE = '_test_template_fingerprint';

/**
 * A hash of everything that determines the template's SHAPE: the migration files, and packs/catalog.ts
 * because the catalogs are code-seeded into the template (C11) and a catalog edit changes its rows.
 *
 * This is what makes reuse safe. The original code rebuilt the template on every single invocation with
 * the note "a stale template that predates a new migration would hand every worker the wrong schema, and
 * the failure would look like a code bug" — a correct fear, and the reason the rebuild was unconditional.
 * A fingerprint answers that fear directly instead of by brute force: if the inputs are byte-identical
 * the template cannot be stale, and if anything changed the hash changes and the rebuild happens.
 */
function templateFingerprint(): string {
  const h = createHash('sha256');
  for (const f of readdirSync('db/migrations').sort()) {
    if (!f.endsWith('.sql')) continue;
    h.update(f).update(readFileSync(`db/migrations/${f}`));
  }
  h.update(readFileSync('packs/catalog.ts'));
  return h.digest('hex');
}

/** Swap the database name on a postgres:// URL, preserving credentials, host, port and params. */
export function withDatabase(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

// Names now come from test/db-names.ts so a namespaced run can go side by side with another one.
// Re-exported as functions rather than constants deliberately — see that file's header for why a
// module-level constant would resolve BEFORE .env.local is loaded, and could differ between this
// module and test/env.ts.
import { templateDb, workerDbPrefix } from './db-names';
export { templateDb, workerDbPrefix };

/** Role the tests connect as (RLS applies to it); the migrator connects as the owner instead. */
const APP_ROLE = 'ai_hr_app';

/**
 * True only if the template AND every worker database already exist and were built from these exact
 * inputs. Any doubt returns false and the caller does the full rebuild — the cheap answer is the safe
 * one here, since a wrong `true` hands every worker a stale schema.
 */
async function templateIsReusable(
  adminUrl: string,
  templateDbName: string,
  fingerprint: string,
  workerPrefix: string,
  workers: number,
): Promise<boolean> {
  try {
    const expected = [templateDbName, ...Array.from({ length: workers }, (_, i) => `${workerPrefix}${i + 1}`)];
    const present = await adminSql(adminUrl, (sql) =>
      sql.unsafe(`SELECT datname FROM pg_database WHERE datname = ANY('{${expected.join(',')}}')`),
    );
    // A partially-present set (someone dropped one by hand, or a previous run died mid-loop) is NOT
    // reusable: reusing it would leave that worker pointed at a database that does not exist, and the
    // failure would land in whichever test file happened to get that pool id.
    if ((present as unknown as unknown[]).length !== expected.length) return false;

    const rows = (await adminSql(withDatabase(adminUrl, templateDbName), (sql) =>
      sql.unsafe(`SELECT fingerprint FROM ${FINGERPRINT_TABLE} LIMIT 1`),
    )) as unknown as { fingerprint: string }[];
    return rows[0]?.fingerprint === fingerprint;
  } catch {
    // Missing database, missing table (a template built before this mechanism existed), no permission —
    // every one of them means "cannot prove it is current", which is the same answer as "rebuild".
    return false;
  }
}

/**
 * Empty every table in `public` on the given database, without dropping it.
 *
 * Enumerated from the catalog rather than from test/harness.ts's ALL_TABLES: that list is maintained by
 * hand for `resetDb()`, and a table added to the schema but forgotten there would silently keep its rows
 * across runs — precisely the leak this function exists to prevent. Asking Postgres what tables exist
 * cannot drift from the schema.
 */
async function wipeAllTables(url: string): Promise<void> {
  await adminSql(url, async (sql) => {
    const rows = (await sql.unsafe(
      // `module` and `setting_definition` survive, matching resetDb's ALL_TABLES, which omits them
      // deliberately: they are installation-wide CATALOGS seeded into the template by scripts/
      // seed-catalogs.ts (ADR-0077 C11), not per-test data. Truncating them here would delete the rows
      // every tenant_module / tenant_setting foreign key points at, and all 301 seedBase importers
      // would fail on insert — the schemaname filter alone would have done exactly that.
      `SELECT tablename FROM pg_tables
       WHERE schemaname = 'public' AND tablename NOT IN ('module', 'setting_definition')`,
    )) as unknown as { tablename: string }[];
    if (rows.length === 0) return;
    const list = rows.map((r) => `"public"."${r.tablename}"`).join(', ');
    // One statement: TRUNCATE takes an AccessExclusiveLock per table, and issuing them separately is
    // how you get the lock-ordering deadlock this suite already sees between resetDb and concurrent
    // readers. A single statement takes all the locks at once, in a consistent order.
    await sql.unsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
    // Re-seed the reserved system tenant, exactly as resetDb does after its own TRUNCATE: pre-auth auth
    // events (app.append_auth_event stamps tenant 0…0 for login-failed / reset-request) carry a foreign
    // key to it. A freshly-cloned worker database inherited it from the template; a wiped one would not,
    // and the 142 files that never call resetDb would be the ones to discover that.
    await sql.unsafe(
      `INSERT INTO tenant (id, workos_org_id, name)
       VALUES ('00000000-0000-0000-0000-000000000000'::uuid, 'org_system_auth_audit', 'System (auth audit)')
       ON CONFLICT (id) DO NOTHING`,
    );
  });
}

async function adminSql<T>(adminUrl: string, fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  // `onnotice: noop` — DROP DATABASE IF EXISTS emits a NOTICE per missing database, which at one per worker
  // buries the actual setup output.
  const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Grants the app role needs on a freshly created database. Table-level ACLs arrive with the copy. */
async function grantAppRole(adminUrl: string, dbName: string): Promise<void> {
  await adminSql(withDatabase(adminUrl, dbName), async (sql) => {
    await sql.unsafe(`GRANT CONNECT ON DATABASE "${dbName}" TO ${APP_ROLE}`);
    await sql.unsafe(`GRANT USAGE, CREATE ON SCHEMA public TO ${APP_ROLE}`);
    await sql.unsafe(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${APP_ROLE}`,
    );
    await sql.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${APP_ROLE}`);
  });
}

export default async function setup({ provide }: { provide?: (k: string, v: unknown) => void } = {}) {
  try {
    process.loadEnvFile('.env.local');
  } catch {
    // env provided directly (CI / clean-room)
  }

  const migrationUrl = process.env.TEST_MIGRATION_DATABASE_URL;
  if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL must be set for tests');

  // How many worker databases to stamp out. Vitest hands workers 1-based VITEST_POOL_IDs, so we need one
  // database per possible worker. Kept in sync with `maxWorkers` in vitest.config.ts.
  const workers = Number(process.env.VITEST_MAX_WORKERS ?? 0) || 8;
  const adminUrl = withDatabase(migrationUrl, 'postgres');

  const t0 = Date.now();

  // Resolved HERE, not at module scope: `process.loadEnvFile` above has just run, so a namespace set in
  // .env.local is now visible. Bound to locals so every statement below uses one consistent value.
  const TEMPLATE_DB = templateDb();
  const WORKER_DB_PREFIX = workerDbPrefix();

  // 0. CAN WE SKIP THE REBUILD ENTIRELY?
  //
  // Steps 1-3 below drop and recreate the template AND all ten worker databases on every invocation.
  // Correct, but expensive in a way that is invisible until you look: each DROP/CREATE DATABASE forces a
  // Postgres CHECKPOINT, and checkpoints do not run concurrently — so 22 of them per run is why two
  // suites started at the same moment both sit in `IPC/CheckpointStart` instead of actually testing.
  //
  // The rebuild exists to guarantee the schema matches the migrations. `templateFingerprint()` answers
  // that question directly, so when it matches we keep the databases and only WIPE them.
  const fingerprint = templateFingerprint();
  const reusable = await templateIsReusable(adminUrl, TEMPLATE_DB, fingerprint, WORKER_DB_PREFIX, workers);
  if (reusable) {
    // WIPED, not merely reused — and this is the load-bearing half. Only 301 of the 443 test files call
    // `resetDb()` in a beforeEach; the other 142 rely on arriving at a database that is already empty,
    // which a freshly-CREATEd one always was. Handing those files a database still holding the previous
    // run's rows is the textbook "passes for the wrong reason" setup, and it would surface as a failure
    // in a file nobody touched. TRUNCATE gives the same clean slate without forcing a checkpoint.
    for (let i = 1; i <= workers; i++) {
      await wipeAllTables(withDatabase(migrationUrl, `${WORKER_DB_PREFIX}${i}`));
    }
    console.log(
      `[global-setup] template ${TEMPLATE_DB} reused (fingerprint match), ${workers} worker DBs wiped in ${Date.now() - t0}ms`,
    );
    provide?.('workerDbPrefix', WORKER_DB_PREFIX);
    return;
  }

  // 1. Rebuild the template from scratch — the fingerprint changed (or there was nothing to reuse).
  await adminSql(adminUrl, async (sql) => {
    await sql.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = '${TEMPLATE_DB}' AND pid <> pg_backend_pid()`,
    );
    await sql.unsafe(`DROP DATABASE IF EXISTS "${TEMPLATE_DB}" WITH (FORCE)`);
    await sql.unsafe(`CREATE DATABASE "${TEMPLATE_DB}"`);
  });
  await grantAppRole(adminUrl, TEMPLATE_DB);

  // 2. Migrate the template ONCE — the whole point of the exercise. This connection must be closed before
  //    any copy is taken (Postgres refuses to copy a database that has connections).
  const templateUrl = withDatabase(migrationUrl, TEMPLATE_DB);
  const migrator = postgres(templateUrl, { max: 1 });
  try {
    await migrate(drizzle(migrator), { migrationsFolder: 'db/migrations' });
    // ADR-0077 C11: the module + setting catalogs are code-seeded (migrations are pure SQL and cannot
    // read packs/catalog.ts), and every worker DB is CLONED from this template — so the rows must land
    // here, before the clone, or all 299 seedBase importers hit a foreign-key violation the moment
    // anything references a module code. Reuses `migrator` deliberately: the template must have no
    // open connections when CREATE DATABASE ... TEMPLATE runs (see this file's header).
    await seedCatalogs(drizzle(migrator));
    // Stamp what built this template, so the NEXT run can skip all of the above when nothing changed.
    // Written on the migrator connection, inside the template, so it is cloned into every worker
    // database too — harmless there, and it means a stray worker DB can also be identified later.
    await migrator.unsafe(
      `CREATE TABLE IF NOT EXISTS ${FINGERPRINT_TABLE} (fingerprint text NOT NULL, built_at timestamptz NOT NULL DEFAULT now())`,
    );
    await migrator.unsafe(`DELETE FROM ${FINGERPRINT_TABLE}`);
    await migrator.unsafe(`INSERT INTO ${FINGERPRINT_TABLE} (fingerprint) VALUES ($1)`, [fingerprint]);
  } finally {
    await migrator.end({ timeout: 10 });
  }
  const migratedMs = Date.now() - t0;

  // 3. Stamp out one database per worker. Sequential on purpose: concurrent copies of the same template can
  //    trip "source database is being accessed by other users", and a copy is fast enough that the loop
  //    costs less than debugging that race.
  for (let i = 1; i <= workers; i++) {
    const dbName = `${WORKER_DB_PREFIX}${i}`;
    await adminSql(adminUrl, async (sql) => {
      await sql.unsafe(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
         WHERE datname = '${dbName}' AND pid <> pg_backend_pid()`,
      );
      await sql.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await sql.unsafe(`CREATE DATABASE "${dbName}" TEMPLATE "${TEMPLATE_DB}"`);
    });
    await grantAppRole(adminUrl, dbName);
  }

  provide?.('workerDbPrefix', WORKER_DB_PREFIX);
  console.log(
    `[global-setup] template migrated in ${(migratedMs / 1000).toFixed(1)}s, ` +
      `${workers} worker DBs ready in ${((Date.now() - t0) / 1000).toFixed(1)}s total`,
  );
}
