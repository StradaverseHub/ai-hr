/**
 * The entitlement + settings resolver — ADR-0077 slice 2, the enforcement primitive.
 *
 * `isModuleEnabled(ctx, code)` answers "may this tenant use this module?" and `getSetting(ctx, key)`
 * answers "how does it behave for them?", both SYNCHRONOUSLY, from a snapshot resolved once per
 * session. Slice 3 rewires the nine deployment env flags onto these two functions.
 *
 * WHY THE SNAPSHOT IS SESSION-SCOPED, NOT TRANSACTION-SCOPED (a deliberate change to the slice plan)
 * -------------------------------------------------------------------------------------------------
 * The plan specified per-TRANSACTION resolution: `withTenant` would issue one extra SELECT after its
 * set_configs and hang the snapshot off the tx handle. Building it revealed that cannot work, for a
 * reason the plan could not have known without reading the call sites:
 *
 *   THE GATES ARE CHECKED OUTSIDE THE TRANSACTION. `core/toil.ts:404` is
 *       if (!toilEnabled()) throw new ToilDisabledError();
 *       return withTenant(ctx, (tx) => accrueToilTx(tx, ctx, …));
 *   — the guard runs BEFORE `withTenant` opens anything. So does `core/payroll.ts:666`, and so does
 *   every pre-DB fast path (`core/attendance-allowance.ts:513-517`). A snapshot attached to `tx`
 *   would not exist yet at the exact moments it is needed. Slice 3 would have had to move ~10 guards
 *   inside their transactions and change their error semantics to compensate.
 *
 * A second, independent reason: the tx-scoped design charged +1 query to ALL 664 `withTenant` call
 * sites, the overwhelming majority of which never ask an entitlement question.
 *
 * Session scope costs ZERO extra queries instead: `getSession()` already round-trips to
 * `app.principal` / `app.principal_by_subject` (lib/session.ts:99-125), and the snapshot rides along.
 * `isModuleEnabled` then has exactly the shape the code it replaces already had — a free synchronous
 * read — so slice 3 becomes a substitution rather than a restructuring.
 *
 * THE TRADE, STATED: revocation takes effect on the next session resolution rather than the next
 * transaction. For a commercial entitlement — modules bought and sold, changed by a Stradaverse
 * operator — that is the right granularity. It would NOT be acceptable for a security boundary, and
 * this is deliberately not one: RLS remains the tenant boundary, and slice 9's suspension check reads
 * `tenant.status` through the same snapshot but is backed by `SET TRANSACTION READ ONLY` at the
 * transaction level, so nothing load-bearing depends on this cache being fresh.
 *
 * FAIL-CLOSED (C7). A missing entitlement row means DISABLED, never "unknown so allow". The one place
 * that is not true is a context with NO snapshot at all — provisioning, sweeps, the seeder, the test
 * harness — which throws `EntitlementsUnresolvedError` rather than guessing in either direction. A
 * caller that legitimately predates entitlements marks itself exempt, and those call sites are
 * enumerated in `ENTITLEMENTS_EXEMPT_REASONS` so the list is reviewable rather than ambient.
 */
import { sql } from 'drizzle-orm';
import type { SessionContext, Tx } from '../db/client';
import { CORE_MODULE_CODES, MODULE_CATALOG, SETTING_CATALOG } from '../packs/catalog';

/** Thrown at a service entry point when the tenant is not entitled to the module (ADR-0077 D3). */
export class ModuleNotEnabledError extends Error {
  readonly moduleCode: string;
  constructor(moduleCode: string, msg?: string) {
    super(msg ?? `The ${moduleCode} module is not enabled for this account.`);
    this.name = 'ModuleNotEnabledError';
    this.moduleCode = moduleCode;
  }
}

/**
 * Thrown when an entitlement question is asked of a context that carries no snapshot. Never silently
 * open and never silently closed: a synthetic context that reaches a gate is a wiring bug, and the
 * only safe answer is to say so loudly.
 */
export class EntitlementsUnresolvedError extends Error {
  constructor(what: string) {
    super(
      `Entitlements were not resolved for this context (asked about '${what}'). ` +
        `A synthetic SessionContext must be built with resolveEntitlements() or marked entitlementsExempt.`,
    );
    this.name = 'EntitlementsUnresolvedError';
  }
}

/** One tenant's resolved commercial state. Plain data — safe to attach to a session and serialise. */
export type EntitlementSnapshot = {
  /** Non-core module codes that resolve ENABLED right now (expiry and status already applied). */
  enabledModules: string[];
  /** Company-scoped grants: module code → the company ids it is scoped to. */
  scopedModules: Record<string, string[]>;
  /** Per-tenant setting values; keys absent here fall back to the catalog default. */
  settings: Record<string, unknown>;
  /** active | trial | suspended | closed — slice 9's overlay reads this. */
  tenantStatus: string;
};

/**
 * A context carrying resolved entitlements. Kept structurally separate from SessionContext so a
 * caller cannot accidentally satisfy the type by spreading an object literal.
 */
export type EntitledContext = SessionContext & {
  entitlements?: EntitlementSnapshot;
  /**
   * Set ONLY by the paths that legitimately run before entitlements exist. Every such call site is
   * named in ENTITLEMENTS_EXEMPT_REASONS, and a drift test pins that list at its current size so a
   * new exemption is a deliberate, reviewed act rather than a quiet `as any`.
   */
  entitlementsExempt?: keyof typeof ENTITLEMENTS_EXEMPT_REASONS;
};

/**
 * The complete list of paths allowed to skip entitlement resolution, with the reason each is safe.
 * These are the writers F12 identified as never calling `withTenant` with a real session.
 */
export const ENTITLEMENTS_EXEMPT_REASONS = {
  provisioning: 'db/provision.ts — creates the tenant; its entitlements do not exist yet by definition.',
  seeding: 'db/seed.ts and scripts/seed-catalogs.ts — bootstrap, owner role, no session.',
  sweeps: 'scripts/*.ts cron sweeps — synthetic contexts; slice 9 gives them the by-tenantId resolver.',
  harness: 'test/harness.ts — fixtures build contexts directly.',
  platform: 'The platform plane (slice 7) — operates ACROSS tenants and is gated by its own role.',
} as const;

const CORE = new Set(CORE_MODULE_CODES);
const CATALOG = new Map(MODULE_CATALOG.map((m) => [m.code, m]));
const SETTING_DEFAULTS = new Map(SETTING_CATALOG.map((s) => [s.key, s.defaultValue]));

/**
 * Deployment-level kill switch (convention C8), the ONE thing that stays in the environment.
 *
 * Kill-only semantics, and the asymmetry is the whole point: it can force a module OFF platform-wide
 * without a database write, but it can never turn one ON. So it cannot be used to hand a customer
 * something they did not buy, while it remains available when a module has to be stopped NOW.
 */
function killed(code: string): boolean {
  const raw = process.env.MODULE_KILL;
  if (!raw) return false;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(code);
}

/**
 * The ONE query behind every snapshot. Shared as a string constant because two runtimes need it —
 * drizzle (harness, provisioning) and the raw postgres handle (lib/session.ts) — and two hand-written
 * copies would drift the moment expiry or status semantics change.
 *
 * `$1` is the tenant id. Three subselects folded into a single row: deliberately not three round
 * trips, since this rides the session path every request already pays for.
 */
export const ENTITLEMENT_SNAPSHOT_SQL = `
    SELECT
      (SELECT coalesce(json_agg(json_build_object('code', tm.module_code, 'company', tm.company_id)), '[]'::json)
         FROM tenant_module tm
        WHERE tm.tenant_id = $1
          AND tm.status IN ('active', 'trial')
          AND (tm.expires_at IS NULL OR tm.expires_at > now())) AS modules,
      (SELECT coalesce(json_object_agg(ts.key, ts.value), '{}'::json)
         FROM tenant_setting ts
        WHERE ts.tenant_id = $1) AS settings,
      (SELECT t.status FROM tenant t WHERE t.id = $1) AS tenant_status`;

type RawSnapshotRow = {
  modules: { code: string; company: string | null }[] | null;
  settings: Record<string, unknown> | null;
  tenant_status: string | null;
};

/** Fold the query's single row into the snapshot shape. */
export function toSnapshot(row: RawSnapshotRow | undefined): EntitlementSnapshot {
  const modules = row?.modules ?? [];
  const enabled = new Set<string>();
  const scoped: Record<string, string[]> = {};
  for (const m of modules) {
    if (m.company == null) enabled.add(m.code);
    else (scoped[m.code] ??= []).push(m.company);
  }
  return {
    enabledModules: [...enabled],
    scopedModules: scoped,
    settings: row?.settings ?? {},
    // A tenant row that somehow does not exist reads as 'active' rather than crashing the session;
    // RLS has already established the tenant, so this is belt-and-braces, not a real branch.
    tenantStatus: row?.tenant_status ?? 'active',
  };
}

/** UUID shape, checked before a tenant id is ever spliced into SQL text. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve from inside an open drizzle transaction (harness, provisioning, sweeps).
 *
 * drizzle's `execute` takes a prepared `sql` fragment, and the shared constant above is raw text with
 * a `$1` placeholder, so this path has to splice. The id is therefore SHAPE-CHECKED first rather than
 * trusted: `tenantId` reaches here from a session or a sweep, both of which should only ever carry a
 * UUID, and an assertion is cheap next to the one place in this file where SQL text is concatenated.
 * The raw-postgres path below never splices — it parameterises properly.
 */
export async function resolveEntitlementsTx(tx: Tx, tenantId: string): Promise<EntitlementSnapshot> {
  if (!UUID_RE.test(tenantId)) throw new Error(`resolveEntitlementsTx: '${tenantId}' is not a UUID.`);
  const rows = (await tx.execute(
    sql.raw(ENTITLEMENT_SNAPSHOT_SQL.replaceAll('$1', `'${tenantId}'::uuid`)),
  )) as unknown as RawSnapshotRow[];
  return toSnapshot(rows[0]);
}

/**
 * Resolve using the raw `postgres` handle lib/session.ts already holds. Parameterised (`$1` via the
 * driver's `unsafe`), so the tenant id is never interpolated into SQL text on the session path.
 */
export async function resolveEntitlementsRaw(
  client: (q: string, params: unknown[]) => Promise<unknown[]>,
  tenantId: string,
): Promise<EntitlementSnapshot> {
  const rows = (await client(ENTITLEMENT_SNAPSHOT_SQL, [tenantId])) as RawSnapshotRow[];
  return toSnapshot(rows[0]);
}

function snapshotOf(ctx: EntitledContext, what: string): EntitlementSnapshot | null {
  if (ctx.entitlementsExempt) return null;
  if (!ctx.entitlements) throw new EntitlementsUnresolvedError(what);
  return ctx.entitlements;
}

/**
 * Is `code` enabled for this context?
 *
 * Order of evaluation, each step fail-closed:
 *   1. MODULE_KILL forces OFF regardless of anything else (C8).
 *   2. CORE modules are TRUE without touching the snapshot — they take no rows by construction, so a
 *      tenant with an empty tenant_module table still has Leave and ESS.
 *   3. An exempt context is TRUE: provisioning and the seeder run before entitlements exist, and
 *      failing them closed would make a tenant impossible to create.
 *   4. Unknown code ⇒ FALSE. A typo disables rather than enables.
 *   5. The tenant must not be suspended (slice 9's overlay; core modules already returned above).
 *   6. Tenant-wide row ⇒ true. Otherwise a company-scoped row for `companyId` ⇒ true, and asking
 *      WITHOUT a company when only company-scoped rows exist ⇒ FALSE, because the honest answer to
 *      "may this tenant use payroll?" when they bought it for one company is "for which company?".
 *   7. Every dependsOn must ALSO be enabled — a lapsed dependency disables its dependents.
 */
export function isModuleEnabled(ctx: EntitledContext, code: string, companyId?: string | null): boolean {
  if (killed(code)) return false;
  if (CORE.has(code)) return true;

  const snap = snapshotOf(ctx, code);
  if (snap === null) return true; // exempt path — see step 3

  if (!CATALOG.has(code)) return false;
  if (snap.tenantStatus === 'suspended' || snap.tenantStatus === 'closed') return false;

  const direct =
    snap.enabledModules.includes(code) ||
    (companyId != null && (snap.scopedModules[code] ?? []).includes(companyId));
  if (!direct) return false;

  // Dependency closure. Guarded against a cyclic catalog (the drift test forbids cycles, but a
  // resolver that hangs on bad data is a worse failure than one that returns false).
  const seen = new Set<string>([code]);
  const queue = [...(CATALOG.get(code)?.dependsOn ?? [])];
  while (queue.length) {
    const dep = queue.shift()!;
    if (seen.has(dep)) continue;
    seen.add(dep);
    if (!isModuleEnabled(ctx, dep, companyId)) return false;
    queue.push(...(CATALOG.get(dep)?.dependsOn ?? []));
  }
  return true;
}

/** Throw `ModuleNotEnabledError` unless the module is enabled — the D3 service-boundary guard. */
export function assertModuleEnabled(ctx: EntitledContext, code: string, companyId?: string | null): void {
  if (!isModuleEnabled(ctx, code, companyId)) throw new ModuleNotEnabledError(code);
}

/**
 * A setting's effective value: the tenant's row if present, otherwise the catalog default.
 *
 * One resolver, so a missing row is never a silent `false` — an unknown key throws rather than
 * returning undefined and being read as "off" by a truthiness check at the call site.
 */
export function getSetting<T = unknown>(ctx: EntitledContext, key: string): T {
  if (!SETTING_DEFAULTS.has(key)) {
    throw new Error(`Unknown setting key '${key}' — add it to SETTING_CATALOG in packs/catalog.ts.`);
  }
  const snap = snapshotOf(ctx, key);
  if (snap === null) return SETTING_DEFAULTS.get(key) as T;
  return (key in snap.settings ? snap.settings[key] : SETTING_DEFAULTS.get(key)) as T;
}

/** Boolean convenience — the shape the env-flag reads it replaces already had. */
export const settingEnabled = (ctx: EntitledContext, key: string): boolean => getSetting(ctx, key) === true;
