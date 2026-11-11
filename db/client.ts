/**
 * Database client + the RLS session wrapper (ADR-0002 / ADR-0004).
 *
 * The app connects as the non-privileged `ai_hr_app` role. Every unit of work runs
 * inside `withTenant(...)`, which opens a transaction and sets the request's
 * tenant/user/roles as transaction-local GUCs. RLS policies read those GUCs, so
 * isolation and ABAC are enforced by the database, not by app code.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql, type SQL } from 'drizzle-orm';
import postgres from 'postgres';
import {createDatabaseAdmission,type DatabaseWorkload} from './admission';
import {createBackgroundReadAdmission} from './background-read-admission';
import {createTenantWriteAdmission} from './tenant-write-admission';
import {AsyncLocalStorage} from 'node:async_hooks';
import {cancelStatementsAtDeadline,currentDatabaseReadDeadline,currentDatabaseWorkload,databaseReadSignal,inIdempotentDatabaseRead,withBackgroundDatabaseWork} from './workload';
import {applicationDatabaseBudget,databaseAdmissionShares} from './capacity';
import {applicationDatabaseUrl} from './pooling';
import {markDatabaseCapacityFailure,retryAdmissionRefusal,retryIdempotentRead} from './read-retry';
import {SharedReadSession,currentSharedRead,independentTransactionsRequired,markSharedCarrierTransaction,runInSharedRead,scopePreamble,sharedReadDriver,type SharedReadCarrierControl,type SharedReadPreambleRead,type SharedReadStats} from './shared-read';
export {declareSharedReadWindow,declareSharedReadPreamble,withOwnerPreambleReads} from './shared-read';
export {withIndependentTransactions} from './shared-read';
const applicationBudget = applicationDatabaseBudget(process.env);
/** The tenant whose transaction this code runs inside; a nested acquire must not wait on that tenant's own share. */
const transactionTenant = new AsyncLocalStorage<string>();
/** The tenant whose shared read snapshot (db/shared-read.ts) this request runs inside, and whether one of its carrier
 * transactions holds a permit now. An owner that keeps its own transaction while a carrier is open is nested in that
 * carrier exactly as above: the request already holds this tenant's permit, so it must not wait on the tenant's share. */
const sharedReadTenant = new AsyncLocalStorage<{ tenantId: string; carrierHeld: () => boolean }>();
function nestedInTenant(tenantId: string): { ignoreTenantCap: true } | undefined {
  if (transactionTenant.getStore() === tenantId) return { ignoreTenantCap: true };
  const shared = sharedReadTenant.getStore();
  return shared?.tenantId === tenantId && shared.carrierHeld() ? { ignoreTenantCap: true } : undefined;
}
/** Set while raw pool work (withPoolWork) runs: that work holds a permit. */
const poolWorkHeld = new AsyncLocalStorage<true>();
/** Does this code already hold a permit: inside a tenant transaction, raw pool work, or a shared read carrier? */
function holdsPermit(): boolean {
  return transactionTenant.getStore() !== undefined || poolWorkHeld.getStore() === true || sharedReadTenant.getStore()?.carrierHeld() === true;
}
/** Whether a refused admission is asked for again (db/read-retry.ts retryAdmissionRefusal). A refusal means the work
 * never started, so pages, commands such as clock-in, and login retry it invisibly. Background work keeps its
 * deferral (an import yields and resumes from its checkpoints), and code that already holds a permit keeps its single
 * wait, so a held connection is never kept through a retry. */
function retriesAdmission(workload: DatabaseWorkload): boolean {
  return workload !== 'background' && !holdsPermit();
}
import { chainArmingDecision } from '../core/audit-chain-arming';
import type { EntitlementSnapshot, EntitlementsExemptReason } from '../core/entitlement-types';
// Value import, and safe: core/entitlement-types.ts imports NOTHING, so there is no cycle back here.
import { TENANT_STATUS_GOOD_STANDING } from '../core/entitlement-types';

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
  /**
   * ADR-0077 slice 9 — the ONLY way to write inside a suspended tenant, and it is deliberately narrow.
   *
   * A suspended tenant is read-only (see withTenant). That rule cannot be absolute on a payroll system:
   * EPF, SOCSO and PCB deadlines do not pause because an invoice is disputed, and a half-finished
   * statutory month is worse for the employee than for the customer who stopped paying. A caller that
   * genuinely needs to finish such an obligation sets this, and says WHY — the string is recorded, not
   * a boolean, so an override is attributable in review rather than anonymous.
   *
   * It is not a general escape hatch. Anything that is not a statutory obligation should simply fail
   * while the tenant is suspended, which is the point of suspending it.
   */
  statutoryOverride?: string;
  /**
   * ADR-0151 §4.5 — the tenant's named agent principal, for unattended Automatic-tier work only. Never a
   * login: a context carrying it must have no userId and no grant (withTenant refuses otherwise), so every
   * administrator and person branch of RLS is false for it and only its own policies (0672) apply.
   * `enablements` names, per specialist, the administrator and the switch-on event it runs under.
   */
  agent?: { principalId: string; enablements: readonly AgentEnablement[] };
};

/** One switched-on specialist and who switched it on (the actor of that `tenant-setting.changed` event). */
export type AgentEnablement = { feature: 'readiness_reminders' | 'claims_triage' | 'approval_chasers' | 'review_chasers' | 'clock_reminders' | 'document_reminders' | 'lifecycle_chasers'; userId: string; eventId: string };

// Reuse pools across hot-reloads (dev) so HMR doesn't leak Postgres connections.
const globalForPg = globalThis as unknown as {
  __aihrPgPools?: Map<string, ReturnType<typeof postgres>>;
  __aihrDbAdmission?: WeakMap<ReturnType<typeof postgres>, ReturnType<typeof createDatabaseAdmission>>;
  __aihrBackgroundReadAdmission?: WeakMap<ReturnType<typeof postgres>, ReturnType<typeof createBackgroundReadAdmission>>;
  __aihrTenantWriteAdmission?: WeakMap<ReturnType<typeof postgres>, ReturnType<typeof createTenantWriteAdmission>>;
  __aihrPerfBeginTransaction?: (poolMax: number) => { acquired: () => void; finished: () => void };
  __aihrPerfBeginPoolWork?: (poolMax: number) => { acquired: () => void; finished: () => void };
  __aihrPerfSharedRead?: (stats: SharedReadStats) => void;
};
const pgPools = (globalForPg.__aihrPgPools ??= new Map<string, ReturnType<typeof postgres>>());
const admissionByPool = (globalForPg.__aihrDbAdmission ??= new WeakMap());
const backgroundReadsByPool = (globalForPg.__aihrBackgroundReadAdmission ??= new WeakMap());
const tenantWritesByPool = (globalForPg.__aihrTenantWriteAdmission ??= new WeakMap());

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
/**
 * ADR-0077 slice 8 — the three helpers the arming decision needs, kept HERE rather than in
 * core/entitlements.ts because `withTenant` is what they serve and core/ imports db/, not the reverse.
 *
 * `tenantHasChainedHistory` is a PROCESS CACHE of a one-way fact. `domain_event` is append-only, so a
 * tenant that has chained rows can never stop having them — caching `true` forever is sound, and it is
 * the only value cached. An unknown tenant answers `false` and is corrected the moment it arms, which
 * is why `markTenantChained` runs inside the arming branch rather than after a query.
 *
 * DELIBERATELY NO DATABASE LOOKUP HERE. `withTenant` opens every transaction in the product; adding a
 * query to it to answer "does this tenant have chained events" would put a round-trip in front of every
 * request to protect a state that is false on every existing deployment. The cache is seeded by arming
 * instead, and `scripts/check-audit-chain-gate.ts` remains the out-of-band check that compares the
 * configured gate against what the database actually holds.
 */
const chainedTenants = new Set<string>();
function tenantHasChainedHistory(tenantId: string): boolean {
  return chainedTenants.has(tenantId);
}
function markTenantChained(tenantId: string): void {
  chainedTenants.add(tenantId);
}

/** The tenant's own `audit.hash_chain_enabled`, or null when no snapshot could be resolved (a sweep
 *  context carries none — r108). Null is NOT "off": the decision falls back rather than disarming. */
function readChainSetting(ctx: SessionContext): boolean | null {
  const v = ctx.entitlements?.settings?.['audit.hash_chain_enabled'];
  return typeof v === 'boolean' ? v : null;
}

/** Logged once per tenant per process: a refused disarm is a standing condition, not an event stream. */
const chainDisarmWarned = new Set<string>();
function warnChainDisarmRefused(tenantId: string, reason: string): void {
  if (chainDisarmWarned.has(tenantId)) return;
  chainDisarmWarned.add(tenantId);
  console.warn(`[audit-chain] refusing to disarm the chain for tenant ${tenantId}: ${reason}`);
}

/** Tests only — the caches are process-lifetime by design. */
export function __resetAuditChainCachesForTests(): void {
  chainedTenants.clear();
  chainDisarmWarned.clear();
}

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
        `Run 'scripts/check-audit-chain-gate.ts' against this database — with MIGRATION_DATABASE_URL, the ` +
        `OWNER role, because domain_event is RLS-bound for the app role and a filtered zero reads as "no ` +
        `chain" — to find out which case you are in. ` +
        `Set the value to the literal 'true' to keep the chain armed, or unset the variable to silence this.`,
    );
  }
  // Written out in full rather than `raw === 'true'` so the gate FORM is greppable: the drift test
  // asserts every DEFERRED_ENV_GATES entry is compared against the literal 'true', which is exactly
  // the check that would have caught the truthiness bug this function exists to fix.
  return process.env.AUDIT_HASH_CHAIN_ENABLED === 'true';
}

/** Every transaction-local identity setting withTenant derives from a context. Two contexts share a snapshot only
 * when all of them are identical; an agent principal never shares one. */
function sharedReadIdentity(ctx: SessionContext, grants: Grant[], roleNames: string[]): string {
  return JSON.stringify([ctx.tenantId, ctx.userId ?? '', ctx.personId ?? null, roleNames.join(','), JSON.stringify(grants), ctx.agent?.principalId ?? '']);
}

export function createDb(connectionString: string, options?: { max?: number; admissionWaitMs?: number }) {
  let client = pgPools.get(connectionString);
  if (!client) {
    client = postgres(connectionString, { max: options?.max ?? applicationBudget.poolMax });
    pgPools.set(connectionString, client);
  }
  // Direct table-based select/insert/update/delete retain their own schema and types. Registering
  // every table here eagerly rebuilds unused db.query helpers in every transaction.
  const db = drizzle(client);
  // A read-only snapshot names its isolation level and access mode in BEGIN itself: one statement where
  // drizzle's transaction config sends BEGIN and then a separate SET TRANSACTION. Every other property is
  // the pool's own (looked up at call time, so a test's spy on client.begin still sees each transaction).
  const snapshotClient = Object.create(client, {
    begin: {value: (...args: unknown[]) => (client.begin as (...a: unknown[]) => unknown)('isolation level repeatable read read only', ...args)},
  }) as typeof client;
  const snapshotDb = drizzle(snapshotClient);
  const configuredPoolMax = client.options.max;
  let admission = admissionByPool.get(client);
  if (!admission) {
    admission = createDatabaseAdmission({capacity: configuredPoolMax,
      backgroundCapacity: Math.max(1, Math.floor(configuredPoolMax / 4)), maxWaiting: applicationBudget.maxWaiting,
      maxBackgroundWaiting:Math.floor(applicationBudget.maxWaiting/4),waitMs: options?.admissionWaitMs ?? applicationBudget.waitMs,
      ...databaseAdmissionShares(configuredPoolMax,applicationBudget.maxWaiting,applicationBudget.role)});
    admissionByPool.set(client, admission);
  }
  const poolAdmission = admission;
  /** This pool's permit for one unit of work, asked for again after a refusal where retriesAdmission allows it. */
  function admit(tenant: string, workload: DatabaseWorkload, signal?: AbortSignal, options?: { ignoreTenantCap?: boolean }): Promise<() => void> {
    const acquire = () => poolAdmission.acquire(tenant, workload, signal, options);
    return retriesAdmission(workload) ? retryAdmissionRefusal(acquire, signal) : acquire();
  }
  let backgroundReads=backgroundReadsByPool.get(client);
  if(!backgroundReads){
    backgroundReads=createBackgroundReadAdmission({capacity:Math.max(1,Math.floor(configuredPoolMax/4)),
      maxWaiting:applicationBudget.maxWaiting,waitMs:applicationBudget.waitMs});
    backgroundReadsByPool.set(client,backgroundReads);
  }
  const withBackgroundReadWork=backgroundReads.run;
  let tenantWrites=tenantWritesByPool.get(client);
  if(!tenantWrites){
    tenantWrites=createTenantWriteAdmission({capacity:Math.max(1,Math.floor(configuredPoolMax/2)),
      maxWaiting:applicationBudget.maxWaiting,waitMs:applicationBudget.waitMs});
    tenantWritesByPool.set(client,tenantWrites);
  }
  const withTenantWriteWork=tenantWrites.run;
  type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
  /** Request-scoped shared read sessions of this client, keyed by the request's scope object and then by identity. A
   * scope object lives only as long as its request (React `cache` per server render), so nothing outlives a request. */
  const requestScopedSessions = new WeakMap<object, Map<string, SharedReadSession<Tx>>>();
  /** How many carriers of each shared read session hold an admission permit now (fair admission, db/admission.ts). */
  const carrierPermits = new WeakMap<SharedReadSession<Tx>, { held: number }>();

  /** For existing raw SQL owners only. This adds no transaction, GUC or authority.
   * The `authentication` pseudo-tenant runs in the authentication lane whatever the caller's workload.
   * Open queries inside work; do not pass an already-running promise or nest withTenant here.
   * `options.idempotent` retries capacity failures; pass it only for reads.
   */
  async function withPoolWork<T>(tenant: string, work: () => PromiseLike<T>, signal?: AbortSignal, options?: { idempotent?: boolean }): Promise<T> {
    signal = databaseReadSignal(signal);
    const workload = tenant === 'authentication' ? 'authentication' : currentDatabaseWorkload();
    const attempt = async () => {
      const timing=globalForPg.__aihrPerfBeginPoolWork?.(configuredPoolMax);let release:(()=>void)|undefined;
      try {
        release=await admit(tenant,workload,signal,nestedInTenant(tenant));timing?.acquired();
        signal?.throwIfAborted();return await poolWorkHeld.run(true,work);
      }catch(error){throw markDatabaseCapacityFailure(error);}
      finally{release?.();timing?.finished();}
    };
    return options?.idempotent ? retryIdempotentRead(attempt,signal) : attempt();
  }

  /** Raw work that belongs to no tenant and no login: mail delivery, public tokens, operator pages. */
  function withSystemWork<T>(work: () => PromiseLike<T>, signal?: AbortSignal, options?: { idempotent?: boolean }): Promise<T> {
    return withBackgroundDatabaseWork(() => withPoolWork('system', work, signal, options));
  }


  /** Run `fn` in a transaction scoped to the session's tenant/user/roles.
   * Explicit readOnlySnapshot starts REPEATABLE READ / READ ONLY in its BEGIN statement, before session GUCs.
   * Owner readers must receive this tx explicitly; nested withTenant calls never auto-join.
   */
  async function withTenant<T>(ctx: SessionContext, fn: (tx: Tx) => Promise<T>, options?: { readOnlySnapshot?: true; readSignal?: AbortSignal }): Promise<T> {
    const readSignal = databaseReadSignal(options?.readSignal);
    const readDeadline = currentDatabaseReadDeadline();
    // Fail fast with a clear, diagnosable error rather than a cryptic "reading 'grants'/'tenantId'"
    // TypeError if a caller ever passes an unresolved session (e.g. a swallowed getSession failure).
    if (!ctx || !ctx.tenantId) {
      throw new Error('withTenant was called without a valid session context (missing tenantId).');
    }
    if (ctx.agent && (ctx.userId || ctx.personId || (ctx.grants?.length ?? 0) > 0 || (ctx.roles?.length ?? 0) > 0)) {
      throw new Error('An agent context cannot also carry a login or a grant.');
    }
    // Backward-compat: a context with only `roles` becomes group-wide grants (companyId null).
    const grants = ctx.grants ?? (ctx.roles ?? []).map((role) => ({ role, companyId: null as string | null }));
    const roleNames = ctx.roles ?? Array.from(new Set(grants.map((g) => g.role)));
    readSignal?.throwIfAborted();
    const attempt = async (): Promise<T> => {
    const timing = globalForPg.__aihrPerfBeginTransaction?.(configuredPoolMax);
    let release: (() => void) | undefined;
    let stopDeadline: (() => void) | undefined;
    try {
      release = await admit(ctx.tenantId, currentDatabaseWorkload(), readSignal, nestedInTenant(ctx.tenantId));
      // readOnlySnapshot: REPEATABLE READ / READ ONLY from BEGIN, before the session settings below.
      return await (options?.readOnlySnapshot ? snapshotDb : db).transaction(async (tx) => {
      // A hard read deadline (Home cards) cancels this transaction's running statement; see db/workload.ts.
      if (readDeadline) stopDeadline = cancelStatementsAtDeadline((tx as unknown as { session: Parameters<typeof cancelStatementsAtDeadline>[0] }).session, readDeadline);
      timing?.acquired();
      // A queued read may have disconnected while waiting for a connection.
      readSignal?.throwIfAborted();
      await bootstrapTenantTx(tx, ctx, grants, roleNames);
      readSignal?.throwIfAborted();
      return transactionTenant.run(ctx.tenantId, () => fn(tx));
    });
    } catch (error) {
      throw markDatabaseCapacityFailure(error);
    } finally {
      stopDeadline?.();
      release?.();
      timing?.finished();
    }
    };
    // Only declared reads retry: a READ ONLY transaction, or an operation verified to write nothing.
    const ownTransaction = (): Promise<T> =>
      options?.readOnlySnapshot || inIdempotentDatabaseRead() ? retryIdempotentRead(attempt, readSignal) : attempt();
    // Inside one request's shared read snapshot, the same identity joins its single transaction. Any other
    // identity, client or incompatible statement keeps this owner's own transaction (db/shared-read.ts).
    // A shared carrier cancels its statements at its own hard read deadline, so only an owner under that same
    // deadline (or, for both, none) joins it; an owner under another deadline keeps its own cancellable transaction.
    const shared = currentSharedRead();
    if (shared?.admits(client!, sharedReadIdentity(ctx, grants, roleNames), readDeadline)) {
      return shared.join(fn as (tx: unknown) => Promise<T>, ownTransaction, readSignal);
    }
    return ownTransaction();
  }

  /** The identity bootstrap every tenant transaction runs before its first read (r394: one statement), shared by
   * withTenant and the shared read snapshot so both establish exactly the same transaction-local identity. */
  async function bootstrapTenantTx(tx: Tx, ctx: SessionContext, grants: Grant[], roleNames: string[], extra?: SQL): Promise<Record<string, unknown> | undefined> {
      // The existing sticky fact only moves from unknown to on. An already known chain can
      // share the identity bootstrap statement; first activation still decides after this await.
      const auditAlreadyArmed = tenantHasChainedHistory(ctx.tenantId);
      const auditBootstrap = auditAlreadyArmed ? sql`, set_config('app.audit_hash_chain', 'on', true)` : sql``;
      // set_config(name, value, is_local=true) === SET LOCAL — cleared at COMMIT.
      // r394: ONE round trip, not four. Every withTenant transaction paid four sequential statements
      // before its first real query (measured: 145 of 366 statements on one employee navigation to
      // My Leave). The four are independent and all evaluated in this one row, so the outcome is the
      // same; test/r394-with-tenant-one-round-trip.test.ts pins both the values and the single statement.
      // `extra` (a shared carrier's request preamble only, decision 12) adds columns after every setting; the
      // statement is otherwise unchanged.
      const columns = extra ?? sql``;
      const [identityRow] = (await tx.execute(
        sql`select set_config('app.tenant_id', ${ctx.tenantId}, true), set_config('app.user_id', ${ctx.userId ?? ''}, true), set_config('app.roles', ${roleNames.join(',')}, true), set_config('app.grants', ${JSON.stringify(grants)}, true), set_config('app.agent_principal_id', ${ctx.agent?.principalId ?? ''}, true), set_config('app.payroll_tax_basis_reader', '1', true)${auditBootstrap}${columns}`,
      )) as unknown as Record<string, unknown>[];
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
      //
      // ADR-0077 SLICE 8. The env gate is no longer the decision — `audit.hash_chain_enabled` on the
      // tenant's own snapshot is, and `chainArmingDecision` resolves the two against this tenant's
      // HISTORY. The env value survives only as the fallback for an unresolvable setting, so a
      // deployment mid-migration cannot silently lose a chain it already had.
      //
      // THE REFUSAL THIS ADDS. Disarming a chain that already has chained events appends events OUTSIDE
      // the chain — not a broken link, absent from it — and `verifyTenantChain()` keeps answering
      // `valid: true` because it only inspects `chain_seq IS NOT NULL`. Re-arming later links straight
      // across the hole. No backfill exists to heal it, so a tenant WITH history stays armed whatever
      // the setting says, and the override is logged once per tenant per process.
      //
      // INERT ON EVERY EXISTING DEPLOYMENT, verified on production before shipping: 5707 events, ZERO
      // chained, no tenant with a chain, `AUDIT_HASH_CHAIN_ENABLED` unset. `hasChainedHistory` is false
      // everywhere, so the decision returns exactly what the env gate returned — off.
      const chainDecision = chainArmingDecision({
        settingEnabled: readChainSetting(ctx),
        hasChainedHistory: tenantHasChainedHistory(ctx.tenantId),
        envArmed: auditHashChainArmed(),
      });
      if (chainDecision.refusedDisarm) warnChainDisarmRefused(ctx.tenantId, chainDecision.reason);
      if (chainDecision.armed) {
        if (!auditAlreadyArmed) await tx.execute(sql`select set_config('app.audit_hash_chain', 'on', true)`);
        // Remembered the moment we arm: the next transaction for this tenant must see that history now
        // exists, or a settings flip between the two could still open a one-transaction hole.
        markTenantChained(ctx.tenantId);
      }
      // ADR-0077 slice 9 — SUSPENSION IS A MECHANISM, NOT A DISCIPLINE.
      //
      // A tenant out of good standing gets a READ-ONLY transaction, and Postgres refuses every write
      // for us. Doing it per action would mean auditing several hundred call sites and re-auditing
      // every new one forever; one line here binds all of them, including code written next year.
      //
      // WHY THIS WAS NOT ALREADY TRUE. `isModuleEnabled` returns false for a non-good-standing tenant,
      // so BILLABLE modules already refused — but CORE modules (leave, ESS, employees, org) answer true
      // from the catalog without consulting the snapshot. A suspended tenant could still file leave and
      // edit employees. core/entitlements.ts said so against itself: "Until slice 9 lands, a closed
      // tenant retains write access to core."
      //
      // READS ARE UNTOUCHED, on purpose. ADR-0077 open decision 5: read-only + export, never a hard
      // lock-out on a payroll system. A customer in a billing dispute must still be able to see and
      // export their own payroll history.
      //
      // A context with NO snapshot is not affected: `tenantStatus` is undefined, not "bad". Suspension
      // must never be inferred from missing data — that would turn any resolver outage into a
      // tenant-wide outage. Unresolved is handled by the entitlement gates, which fail closed there.
      const tenantStatus = ctx.entitlements?.tenantStatus;
      if (tenantStatus != null && !TENANT_STATUS_GOOD_STANDING.has(tenantStatus) && !ctx.statutoryOverride) {
        // Verified to enforce, not merely to be accepted: reads still succeed, writes raise
        // "cannot execute ... in a read-only transaction". Issued AFTER the set_configs because those
        // are SELECTs, which do not close the window for SET TRANSACTION.
        await tx.execute(sql`SET TRANSACTION READ ONLY`);
      }
      return identityRow;
  }

  /** A carrier's request preamble as columns of its identity statement (db/shared-read.ts, decision 12). The
   * preamble's owner statements are evaluated only inside a sub-select whose one-time filter requires every identity
   * setting this statement sets to hold already: if PostgreSQL ever evaluated it before the settings, the column is
   * null and every owner reads as before. JIT, when every joining owner may plan without it, is set in the same row. */
  function preambleColumns(preamble: SharedReadPreambleRead, ctx: SessionContext, grants: Grant[], roleNames: string[]) {
    const identityHolds = sql`current_setting('app.tenant_id', true) = ${ctx.tenantId} and current_setting('app.user_id', true) = ${ctx.userId ?? ''}
      and current_setting('app.roles', true) = ${roleNames.join(',')} and current_setting('app.grants', true) = ${JSON.stringify(grants)}
      and current_setting('app.agent_principal_id', true) = ${ctx.agent?.principalId ?? ''} and current_setting('app.payroll_tax_basis_reader', true) = '1'`;
    return sql`${preamble.jitOff ? sql`, set_config('jit', 'off', true)` : sql``}, (select (${preamble.sql}) where ${identityHolds}) as request_preamble`;
  }

  /** One request's reads as ONE read-only snapshot (db/shared-read.ts). `work` is every read owner of that
   * request; each joins while the identity matches. BEGIN carries the isolation and access mode, so the whole
   * request pays BEGIN, one identity statement and COMMIT, instead of those per owner. Nothing outlives `work`. */
  async function withSharedReadSnapshot<T>(ctx: SessionContext, work: () => Promise<T>, signal?: AbortSignal, scope?: object): Promise<T> {
    if (!ctx?.tenantId || !ctx.userId || ctx.agent || independentTransactionsRequired()) return work();
    const grants = ctx.grants ?? (ctx.roles ?? []).map((role) => ({ role, companyId: null as string | null }));
    const roleNames = ctx.roles ?? Array.from(new Set(grants.map((g) => g.role)));
    const identity = sharedReadIdentity(ctx, grants, roleNames);
    // The hard read deadline (Home cards, db/workload.ts) in force where the snapshot is installed bounds its carrier.
    const readDeadline = currentDatabaseReadDeadline();
    // A read already inside this identity's snapshot stays in it rather than opening a second one.
    if (currentSharedRead()?.admits(client!, identity, readDeadline)) return work();
    // A request that is already inside this tenant's transaction or carrier holds the tenant's permit: neither this
    // snapshot's carriers nor an owner that keeps its own transaction inside it may wait on the tenant's own share.
    const nested = nestedInTenant(ctx.tenantId) !== undefined;
    const inTenant = <R>(session: SharedReadSession<Tx>, run: () => Promise<R>): Promise<R> => {
      const permits = carrierPermits.get(session)!;
      return sharedReadTenant.run({ tenantId: ctx.tenantId, carrierHeld: () => nested || permits.held > 0 }, run);
    };
    // One request's independent read compositions (the Today sections and the shell's approvals of one page render)
    // share one session per identity: overhead and identical statements are paid once while they overlap. A
    // composition under another hard read deadline than that session's keeps a snapshot of its own below, because
    // a carrier cancels its statements at exactly one deadline.
    if (scope) {
      let byIdentity = requestScopedSessions.get(scope);
      if (!byIdentity) requestScopedSessions.set(scope, byIdentity = new Map());
      let shared = byIdentity.get(identity);
      if (!shared) {
        byIdentity.set(identity, shared = newSession(ctx, grants, roleNames, identity, signal, readDeadline, true));
        // The render's own request preamble (lib/request-read-scope.ts), read by each carrier of this session.
        shared.preamble = scopePreamble();
      }
      if (shared.deadline === readDeadline) { const session = shared; return inTenant(session, () => session.track(work)); }
    }
    const session = newSession(ctx, grants, roleNames, identity, signal, readDeadline, false);
    try {
      return await inTenant(session, () => runInSharedRead(session as SharedReadSession<unknown>, work));
    } finally {
      await session.close();
      globalForPg.__aihrPerfSharedRead?.(session.stats);
    }
  }

  /** Diagnostics only: the request-scoped sessions of `scope` (their statistics), after their carriers settle. */
  async function requestScopedReadStats(scope: object): Promise<SharedReadStats[]> {
    const sessions = [...(requestScopedSessions.get(scope)?.values() ?? [])];
    await Promise.all(sessions.map((session) => session.settled()));
    return sessions.map((session) => session.stats);
  }

  function newSession(ctx: SessionContext, grants: Grant[], roleNames: string[], identity: string, signal: AbortSignal | undefined, readDeadline: AbortSignal | undefined, idleRelease: boolean): SharedReadSession<Tx> {
    const permits = { held: 0 };
    // The carrier factory runs only when the first owner joins, after `session` is assigned.
    const session: SharedReadSession<Tx> = new SharedReadSession<Tx>(client!, identity, () => {
      let finish: () => void = () => {};
      const finished = new Promise<void>((resolve) => { finish = resolve; });
      let resolveTx: (tx: Tx) => void = () => {};
      let rejectTx: (error: unknown) => void = () => {};
      const tx = new Promise<Tx>((resolve, reject) => { resolveTx = resolve; rejectTx = reject; });
      tx.catch(() => undefined);
      const readSignal = databaseReadSignal(signal);
      const done = (async () => {
        readSignal?.throwIfAborted();
        const timing = globalForPg.__aihrPerfBeginTransaction?.(configuredPoolMax);
        let release: (() => void) | undefined;
        let stopDeadline: (() => void) | undefined;
        let held = false;
        try {
          // The carrier is this tenant's ordinary capped work unless the request already holds the tenant's permit:
          // it was inside a transaction or carrier when the snapshot was installed, or a carrier of this session
          // holds one now (withSharedReadSnapshot installs that fact around every composition).
          release = await poolAdmission.acquire(ctx.tenantId, currentDatabaseWorkload(), readSignal, nestedInTenant(ctx.tenantId));
          held = true; permits.held++;
          const control: { current?: SharedReadCarrierControl } = {};
          const carrierClient = new Proxy(client!, { get(target, property, receiver) {
            if (property !== 'begin') return Reflect.get(target, property, receiver);
            return (fn: (sqlTx: postgres.TransactionSql) => Promise<unknown>) =>
              target.begin('isolation level repeatable read read only', (sqlTx) => {
                // As in withTenant's own transaction, the deadline cancels the carrier's running statement and
                // refuses later ones. It is armed on the driver's own client, beneath the shared statement guard.
                if (readDeadline) stopDeadline = cancelStatementsAtDeadline({ client: sqlTx } as unknown as Parameters<typeof cancelStatementsAtDeadline>[0], readDeadline);
                return fn(sharedReadDriver(sqlTx, session as SharedReadSession<unknown>, control));
              });
          } });
          await drizzle(carrierClient).transaction(async (carrierTx) => {
            timing?.acquired();
            readSignal?.throwIfAborted();
            // Decision 12: the request preamble rides this carrier's identity statement and answers its owner statements
            // ahead, before any owner can join. Without one (or switched off) the statement is the plain bootstrap.
            const preamble = session.openPreamble(ctx, carrierTx);
            const identityRow = await bootstrapTenantTx(carrierTx, ctx, grants, roleNames, preamble ? preambleColumns(preamble, ctx, grants, roleNames) : undefined);
            session.bootstrapping = false;
            if (preamble) {
              if (preamble.jitOff) control.current?.hold('jit', 'off');
              const value = identityRow?.request_preamble;
              if (value !== null && value !== undefined) {
                // A value of an unexpected shape answers nothing: every owner then reads its own statement.
                let seeds: ReturnType<SharedReadPreambleRead['decode']> = [];
                try { seeds = preamble.decode(value); } catch { seeds = []; }
                if (control.current?.seed(seeds)) session.stats.preambles++;
              }
            }
            markSharedCarrierTransaction(carrierTx);
            resolveTx(carrierTx);
            await finished;
          });
        } catch (error) {
          throw markDatabaseCapacityFailure(error);
        } finally {
          stopDeadline?.();
          if (held) permits.held--;
          release?.();
          timing?.finished();
        }
      })().catch((error) => { session.poison(); rejectTx(error); });
      return { tx, finish, done };
    }, readDeadline, idleRelease);
    carrierPermits.set(session, permits);
    return session;
  }

  return { db, client, withTenant, withSharedReadSnapshot, requestScopedReadStats, withPoolWork, withSystemWork, withBackgroundReadWork, withTenantWriteWork };
}

export type Db = ReturnType<typeof createDb>['db'];
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

// App singleton (non-privileged role). Keep the default for deployments that do
// not explicitly divide a connection budget among application workers.
export const { db, client, withTenant, withSharedReadSnapshot, requestScopedReadStats, withPoolWork, withSystemWork, withBackgroundReadWork, withTenantWriteWork } = createDb(applicationDatabaseUrl(process.env).url, {max: applicationBudget.poolMax});
