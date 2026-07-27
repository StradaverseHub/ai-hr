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
import type { EntitlementSnapshot, EntitlementsExemptReason } from '../core/entitlement-types';

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
   * ADR-0077 slice 2 — the tenant's resolved entitlement snapshot, attached by getSession().
   *
   * Typed CONCRETELY, from a leaf module (core/entitlement-types.ts) that imports nothing. The first
   * attempt typed this `unknown` to keep db/client free of a core/ import, and round 1 review showed
   * that inverted the guard it was meant to provide: `unknown` is not assignable to
   * `EntitlementSnapshot | undefined`, so passing a real session to `isModuleEnabled` was a compile
   * error while a bare object literal type-checked. Every gate would have carried a cast.
   */
  entitlements?: EntitlementSnapshot;
  /** Marks a synthetic context that legitimately predates entitlements. See ENTITLEMENTS_EXEMPT_REASONS. */
  entitlementsExempt?: EntitlementsExemptReason;
  /**
   * Set when resolution was ATTEMPTED for this session and FAILED — carries the underlying cause.
   *
   * Round 2's finding: `withEntitlements` swallows every failure and returns a snapshot-less session so
   * that /login stays reachable, which is right — but the resulting gate error was
   * `EntitlementsUnresolvedError`, whose message tells the reader to go fix a synthetic SessionContext.
   * During a real outage (0313 not applied, pool exhausted, a revoked GRANT) that sends every on-call
   * engineer after a wiring bug that does not exist. This field keeps "never resolved" and "resolution
   * failed, here is why" distinguishable at the point of use.
   */
  entitlementsError?: string;
};

// Reuse pools across hot-reloads (dev) so HMR doesn't leak Postgres connections.
const globalForPg = globalThis as unknown as {
  __aihrPgPools?: Map<string, ReturnType<typeof postgres>>;
};
const pgPools = (globalForPg.__aihrPgPools ??= new Map<string, ReturnType<typeof postgres>>());

/**
 * Is the ADR-0030 hash chain armed for this process?
 *
 * Separate from the call site so the ONE-TIME warning below has somewhere to live. A deployment that
 * was running with a non-'true' value (`false`, `0`, `no`) had the chain ARMED under the old truthiness
 * test and loses it at this deploy. That is the correct end state — the value says off and every doc
 * agrees — but it MUST NOT happen silently, and the first version of this warning was wrong about why.
 *
 * IT CLAIMED `verifyTenantChain()` WOULD REPORT A BOUNDARY. IT WILL NOT. The verifier only inspects
 * rows with `chain_seq IS NOT NULL`, and an event appended with the gate off has no chain columns at
 * all — it is not a broken link, it is absent from the chain. The trigger likewise takes its head from
 * `max(chain_seq)` over chained rows, so re-arming links straight onto the last chained event: the
 * chain stays contiguous, every prev_hash matches, and the DPO surface renders a green "intact" over a
 * log with an unprotected hole in the middle. A silent failure with a green verdict is strictly worse
 * than a loud one, so the detection is now REAL rather than asserted:
 *   - `verifyTenantChain` counts and reports `unchained` (core/audit-chain.ts), and the privacy page
 *     renders it, so the hole is visible after the fact; and
 *   - `scripts/check-audit-chain-gate.ts` compares this gate against the database BEFORE the restart
 *     and exits non-zero, so `deploy/deploy.sh` cannot restart the service into the hole in the first
 *     place. That script — not this warning, and not a grep in a runbook — is the control.
 *
 * Logged once per process, not per transaction.
 */
let auditGateWarned = false;
function auditHashChainArmed(): boolean {
  const raw = process.env.AUDIT_HASH_CHAIN_ENABLED;
  if (raw !== undefined && raw !== 'true' && !auditGateWarned) {
    auditGateWarned = true;
    console.warn(
      `[audit-chain] AUDIT_HASH_CHAIN_ENABLED='${raw}' is NOT 'true', so the ADR-0030 hash chain is OFF. ` +
        `Before ADR-0077 slice 3 this gate was a truthiness test, so ANY non-empty value armed it — ` +
        `including the '=false' line .env.example shipped. If this deployment WAS chaining events, the ` +
        `events appended from now on carry no chain columns and verifyTenantChain() cannot see them: it ` +
        `will keep reporting the older rows as intact while the new ones sit outside the chain entirely. ` +
        `Run 'scripts/check-audit-chain-gate.ts' against this database to find out which case you are in. ` +
        `Set the value to the literal 'true' to keep the chain armed, or unset the variable to silence this.`,
    );
  }
  // Written out in full rather than `raw === 'true'` so the gate FORM is greppable: the drift test
  // asserts every DEFERRED_ENV_GATES entry is compared against the literal 'true', which is exactly
  // the check that would have caught the truthiness bug this function exists to fix.
  return process.env.AUDIT_HASH_CHAIN_ENABLED === 'true';
}

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
      //
      // `=== 'true'`, NOT a truthiness test, and this was a live defect until ADR-0077 slice 3.
      // `.env.example` shipped `AUDIT_HASH_CHAIN_ENABLED=false` as an ACTIVE line, and the string
      // 'false' is truthy — so every deployment that copied the template ARMED the chain while both the
      // template's own comment and packs/catalog.ts's parity note recorded it as OFF. It is the one gate
      // slice 3 defers rather than migrates (DEFERRED_ENV_GATES), so slice 8 would have inherited a
      // parity value that was simply wrong and disarmed a chain it believed had never run. Every other
      // gate in this migration uses `=== 'true'`; this one now does too, and the drift test asserts the
      // FORM as well as the presence so the next deferred entry cannot repeat it.
      if (auditHashChainArmed()) {
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
