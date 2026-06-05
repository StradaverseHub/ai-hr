/**
 * Database client + the RLS session wrapper (ADR-0002 / ADR-0004).
 *
 * The app connects as the non-privileged `ai_hr_app` role. Every unit of work runs
 * inside `withTenant(...)`, which opens a transaction and sets the request's
 * tenant/user/roles as transaction-local GUCs. RLS policies read those GUCs, so
 * isolation and ABAC are enforced by the database, not by app code.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import * as schema from './schema';

export type SessionContext = {
  tenantId: string;
  userId?: string;
  roles?: string[];
};

// Reuse pools across hot-reloads (dev) so HMR doesn't leak Postgres connections.
const globalForPg = globalThis as unknown as {
  __aihrPgPools?: Map<string, ReturnType<typeof postgres>>;
};
const pgPools = (globalForPg.__aihrPgPools ??= new Map<string, ReturnType<typeof postgres>>());

export function createDb(connectionString: string, options?: { max?: number }) {
  let client = pgPools.get(connectionString);
  if (!client) {
    client = postgres(connectionString, { max: options?.max ?? 10 });
    pgPools.set(connectionString, client);
  }
  const db = drizzle(client, { schema });
  type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

  /** Run `fn` in a transaction scoped to the session's tenant/user/roles. */
  async function withTenant<T>(ctx: SessionContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return db.transaction(async (tx) => {
      // set_config(name, value, is_local=true) === SET LOCAL — cleared at COMMIT.
      await tx.execute(sql`select set_config('app.tenant_id', ${ctx.tenantId}, true)`);
      await tx.execute(sql`select set_config('app.user_id', ${ctx.userId ?? ''}, true)`);
      await tx.execute(sql`select set_config('app.roles', ${(ctx.roles ?? []).join(',')}, true)`);
      return fn(tx);
    });
  }

  return { db, client, withTenant };
}

export type Db = ReturnType<typeof createDb>['db'];
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

// App singleton (non-privileged role).
export const { db, client, withTenant } = createDb(url);
