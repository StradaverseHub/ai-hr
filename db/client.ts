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

export type Grant = { role: string; companyId: string | null };

export type SessionContext = {
  tenantId: string;
  userId?: string;
  /** The person this principal maps to (null for admins not tied to an employee). */
  personId?: string | null;
  roles?: string[];
  /** (role, company) grants; companyId null = group-wide. Drives company-scoped authz (ADR-0009). */
  grants?: Grant[];
  /**
   * ADR-0077 slice 2 — the tenant's resolved entitlement snapshot, attached by getSession(). Typed as
   * `unknown` here so db/client stays free of a core/ import (core/entitlements imports SessionContext
   * from this file; typing it concretely would be a cycle). core/entitlements narrows it.
   */
  entitlements?: unknown;
  /** Marks a synthetic context that legitimately predates entitlements. See ENTITLEMENTS_EXEMPT_REASONS. */
  entitlementsExempt?: string;
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
    // Fail fast with a clear, diagnosable error rather than a cryptic "reading 'grants'/'tenantId'"
    // TypeError if a caller ever passes an unresolved session (e.g. a swallowed getSession failure).
    if (!ctx || !ctx.tenantId) {
      throw new Error('withTenant was called without a valid session context (missing tenantId).');
    }
    // Backward-compat: a context with only `roles` becomes group-wide grants (companyId null).
    const grants = ctx.grants ?? (ctx.roles ?? []).map((role) => ({ role, companyId: null as string | null }));
    const roleNames = ctx.roles ?? Array.from(new Set(grants.map((g) => g.role)));
    return db.transaction(async (tx) => {
      // set_config(name, value, is_local=true) === SET LOCAL — cleared at COMMIT.
      await tx.execute(sql`select set_config('app.tenant_id', ${ctx.tenantId}, true)`);
      await tx.execute(sql`select set_config('app.user_id', ${ctx.userId ?? ''}, true)`);
      await tx.execute(sql`select set_config('app.roles', ${roleNames.join(',')}, true)`);
      await tx.execute(sql`select set_config('app.grants', ${JSON.stringify(grants)}, true)`);
      // ADR-0030 Layer 2 gate: the domain_event hash-chain trigger only fires when this GUC is 'on'.
      // Off by default → chain columns stay NULL → byte-identical behaviour (deployment flag).
      if (process.env.AUDIT_HASH_CHAIN_ENABLED) {
        await tx.execute(sql`select set_config('app.audit_hash_chain', 'on', true)`);
      }
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
