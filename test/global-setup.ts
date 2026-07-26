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
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { seedCatalogs } from '../scripts/seed-catalogs';

/** Swap the database name on a postgres:// URL, preserving credentials, host, port and params. */
export function withDatabase(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

export const TEMPLATE_DB = 'ai_hr_test_tpl';
/** Worker databases are `${WORKER_DB_PREFIX}${VITEST_POOL_ID}` — see test/env.ts. */
export const WORKER_DB_PREFIX = 'ai_hr_test_w';

/** Role the tests connect as (RLS applies to it); the migrator connects as the owner instead. */
const APP_ROLE = 'ai_hr_app';

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

  // 1. Rebuild the template from scratch. Always rebuilt rather than reused: a stale template that predates
  //    a new migration would hand every worker the wrong schema, and the failure would look like a code bug.
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
