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
 * sites, the overwhelming majority of which never ask an entitlement question. Session scope charges
 * one short transaction to `getSession()` instead — see the COST note below, which round 1 corrected.
 *
 * THE TRADE, STATED: revocation takes effect on the next session resolution rather than the next
 * transaction. For a commercial entitlement — modules bought and sold, changed by a Stradaverse
 * operator — that is the right granularity. It would NOT be acceptable for a security boundary, and
 * this is deliberately not one: RLS remains the tenant boundary (the snapshot query is now READ UNDER
 * RLS, see below), and slice 9's suspension check reads `tenant.status` through the same snapshot but
 * is backed by `SET TRANSACTION READ ONLY` at the transaction level.
 *
 * READ UNDER RLS — THE ROUND-1 CRITICAL FIX
 * -----------------------------------------
 * The first version resolved the snapshot on the raw `ai_hr_app` pool with NO transaction, therefore
 * with `app.tenant_id` unset. `tenant_module_read` / `tenant_setting_read` (0313) and `tenant`'s
 * `tenant_isolation` (0001) are all `USING (… = app.current_tenant_id())`, and `x = NULL` is NULL, not
 * true — so the app role saw ZERO rows and EVERY production session resolved to an empty snapshot.
 * Proven against a live database: the same statement returns `[] | {} | NULL` with no GUC and the real
 * rows inside a transaction that has set one. Slice 3 would have switched every billable module off
 * for every customer at once, and the suspended-tenant check would have been dead code.
 *
 * `resolveEntitlementsInTenantTx` therefore sets the SAME transaction-local GUC `withTenant` sets,
 * before the SELECT. Two consequences worth stating: the tenant boundary on this read is now the RLS
 * policy AND the `tenant_id` predicate rather than the predicate alone, and — deliberately — this is
 * NOT solved with a SECURITY DEFINER function or a BYPASSRLS role, either of which would have made a
 * parameterised WHERE clause the only thing standing between two tenants.
 *
 * COST, HONESTLY. The original header claimed "ZERO extra queries" because getSession already
 * round-trips to `app.principal`. Round 1 was right that this is false in the way that matters: the
 * snapshot is a separate statement, and it runs inside a short transaction, which RESERVES one of the
 * pool's ten connections for its duration rather than pipelining onto a shared one. Round 2 measured
 * the multiplier that made this actually expensive: 61 of 105 `page.tsx` files resolve a session, the
 * root layout resolves another, and every server action resolves one more — all unmemoised. So
 * `getSession` is now wrapped in React `cache()`, which collapses those to ONE resolution per request
 * and, just as importantly, makes the snapshot request-CONSISTENT: two components in the same render
 * could previously observe different snapshots, which is not what "session-scoped" promises. The
 * remaining price is one BEGIN + set_config + SELECT + COMMIT per request. Still not free, still far
 * cheaper than +1 on all 664 `withTenant` sites.
 *
 * FAIL-CLOSED (C7). A missing entitlement row means DISABLED, never "unknown so allow". A tenant row
 * that could not be READ is `TENANT_STATUS_UNRESOLVED`, which is not in good standing and therefore
 * also disabled — round 1 found the original `?? 'active'` made an unreadable tenant indistinguishable
 * from a healthy one. The one place fail-closed does not apply is a context with NO snapshot at all —
 * provisioning, sweeps, the seeder, the test harness — which throws rather than guessing in either
 * direction, and throws one of TWO errors so an outage is never reported as a wiring bug:
 * `EntitlementsResolutionFailedError` when resolution was tried and failed, `EntitlementsUnresolvedError`
 * when it was never tried at all. A caller that legitimately predates entitlements marks itself exempt
 * with one of the `ENTITLEMENTS_EXEMPT_REASONS` markers; that marker is checked for MEMBERSHIP at
 * runtime rather than truthiness, and it is checked BEFORE the kill/core/catalog branches so a forged
 * one cannot hide on core-only paths (round 2). Each exemption names the files that carry it and a
 * test reads them, so the list can no longer describe call sites that do not exist. The marker is a
 * FALLBACK, not an override: a context that carries both a marker and a snapshot is refused outright
 * rather than having its snapshot silently discarded (round 3 — see `assertContextWellFormed`).
 *
 * EVERYTHING THIS FILE THROWS EXTENDS `EntitlementError`, with one stated exception (`getSetting`'s
 * unknown-key check, a typo rather than an entitlement outcome). Round 2 established that rule for the
 * not-entitled / not-resolved pair; round 3 found the CONTEXT faults — a forged marker, a mangled
 * snapshot — still throwing bare `Error`s outside the family a slice-3 gate catches.
 */
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SessionContext, Tx } from '../db/client';
import { CORE_MODULE_CODES, MODULE_CATALOG, SETTING_CATALOG } from '../packs/catalog';
import {
  ENTITLEMENTS_EXEMPT_REASONS,
  TENANT_STATUS_GOOD_STANDING,
  TENANT_STATUS_UNRESOLVED,
  isEntitlementSnapshot,
  isExemptReason,
  type EntitlementSnapshot,
} from './entitlement-types';

export { ENTITLEMENTS_EXEMPT_REASONS, TENANT_STATUS_GOOD_STANDING, TENANT_STATUS_UNRESOLVED, isExemptReason };
export type { EntitlementSnapshot, EntitlementsExemptReason } from './entitlement-types';

/**
 * The supertype every entitlement failure extends, so ONE catch clause covers the whole family.
 *
 * Round 2's finding: `assertModuleEnabled` calls `isModuleEnabled` first, so on the degraded path
 * (withEntitlements swallowed a resolution failure) it threw `EntitlementsUnresolvedError`, not
 * `ModuleNotEnabledError`. A slice-3 caller that catches the typed error to render "this module is not
 * on your plan" would have surfaced an unhandled exception instead.
 *
 * The fix is a shared supertype, NOT collapsing the two into one error. They are different facts —
 * "you did not buy this" versus "I could not find out what you bought" — and a caller that reports the
 * first when the second is true turns an outage into a false billing message. `catch (e) { if (e
 * instanceof EntitlementError) … }` handles both; the subtype still says which happened.
 */
export class EntitlementError extends Error {}

/** Thrown at a service entry point when the tenant is not entitled to the module (ADR-0077 D3). */
export class ModuleNotEnabledError extends EntitlementError {
  readonly moduleCode: string;
  constructor(moduleCode: string, msg?: string) {
    super(msg ?? `The ${moduleCode} module is not enabled for this account.`);
    this.name = 'ModuleNotEnabledError';
    this.moduleCode = moduleCode;
  }
}

/**
 * Thrown at a service entry point when a per-tenant SETTING is off — the risk-switch counterpart to
 * `ModuleNotEnabledError`.
 *
 * WHY IT IS NOT JUST `ModuleNotEnabledError` WITH A DIFFERENT MESSAGE. Slice 3 moved four gates onto
 * settings, and the two payroll risk switches (`payroll.reset_enabled`, `payroll.unlock_enabled`)
 * refused with `new ModuleNotEnabledError('payroll', …)`. `moduleCode` is a public readonly field that
 * exists precisely so a caller can render "this module is not on your plan" — so a customer who owns
 * Payroll outright, and merely has an operator-controlled escape hatch switched off, would be told
 * Payroll is not on their plan. That is a false billing statement produced by an internal safety
 * setting, and the two facts are as different as `ModuleNotEnabledError` and
 * `EntitlementsResolutionFailedError` are from each other — the same argument that kept those apart.
 *
 * Shares the `EntitlementError` supertype, so a single catch still covers the family, and the message
 * keeps the existing "… is not enabled." wording so nothing downstream changes shape.
 */
export class SettingNotEnabledError extends EntitlementError {
  readonly settingKey: string;
  constructor(settingKey: string, msg?: string) {
    super(msg ?? `The '${settingKey}' setting is not enabled for this account.`);
    this.name = 'SettingNotEnabledError';
    this.settingKey = settingKey;
  }
}

/**
 * Thrown when an entitlement question is asked of a context that carries no snapshot AND no record of
 * a failed attempt — i.e. a synthetic context that was never resolved at all. Never silently open and
 * never silently closed: that is a wiring bug, and the only safe answer is to say so loudly.
 *
 * Distinct from `EntitlementsResolutionFailedError` on purpose: see that class.
 */
export class EntitlementsUnresolvedError extends EntitlementError {
  constructor(what: string) {
    super(
      `Entitlements were not resolved for this context (asked about '${what}'). ` +
        `A synthetic SessionContext must be built with resolveEntitlements() or marked entitlementsExempt.`,
    );
    this.name = 'EntitlementsUnresolvedError';
  }
}

/**
 * Thrown when an `entitlementsExempt` context is asked about a BILLABLE module.
 *
 * Its own class rather than `EntitlementsUnresolvedError` because that error's message ends "…must be
 * built with resolveEntitlements() OR MARKED entitlementsExempt", which is the one instruction the
 * caller has already followed — it would send a reader to add the marker that caused the throw. The
 * distinction is real: unresolved means "nobody gave me data", this means "you told me the question
 * does not apply, and for a paid module that cannot be true".
 */
export class EntitlementsExemptForBillableError extends EntitlementError {
  readonly code: string;
  readonly marker: string;
  constructor(code: string, marker: string) {
    super(
      `Context marked entitlementsExempt: '${marker}' was asked whether the BILLABLE module '${code}' is ` +
        `enabled. An exemption means "entitlements do not apply to me", which is only true of core modules; ` +
        `answering yes for a paid one would grant it to every tenant regardless of what they bought. ` +
        `Resolve a real snapshot with resolveEntitlementsTx(tx, tenantId) and drop the marker.`,
    );
    this.name = 'EntitlementsExemptForBillableError';
    this.code = code;
    this.marker = marker;
  }
}

/**
 * Thrown when resolution was ATTEMPTED for this session and failed — a missing GRANT, a
 * code-ahead-of-migration deploy, pool exhaustion, a statement timeout.
 *
 * Round 2's finding: both states used to raise `EntitlementsUnresolvedError`, whose message tells the
 * reader to go fix a synthetic SessionContext. During a genuine production outage that message points
 * every on-call engineer at a nonexistent wiring bug while the real cause (say, the 0313 tables not
 * applied) goes unnamed. `withEntitlements` now records the cause on the session and this error
 * reports it, with the tenant id, so the two are never confused again.
 */
export class EntitlementsResolutionFailedError extends EntitlementError {
  readonly tenantId: string;
  constructor(tenantId: string, what: string, cause: string) {
    super(
      `Entitlement resolution FAILED for tenant ${tenantId} (asked about '${what}'): ${cause}. ` +
        `This is an infrastructure fault, not a synthetic-context wiring bug — the session reached ` +
        `getSession() and the snapshot query did not succeed.`,
    );
    this.name = 'EntitlementsResolutionFailedError';
    this.tenantId = tenantId;
  }
}

/**
 * Thrown when the CONTEXT ITSELF is broken: a forged/deserialised exemption marker, a snapshot that is
 * not snapshot-shaped, or a context claiming exemption while also carrying a snapshot.
 *
 * Round 3's finding: these all threw a BARE `Error`, which is exactly the argument round 2 used to
 * REJECT raising a TypeError for a malformed snapshot — "a TypeError is not something a caller's
 * `catch (e instanceof EntitlementError)` recognises, so the fail-closed contract did not apply to that
 * shape". A bare Error has the same defect. A slice-3 gate that catches `EntitlementError` to render
 * "not on your plan" / "temporarily unavailable" would have let this one escape as an unhandled 500.
 *
 * NOT merged with `EntitlementsUnresolvedError`, which it used to masquerade as for malformed snapshots:
 * "nobody resolved entitlements for this context" and "someone attached something that is not a
 * snapshot" are different bugs with different fixes, and the message has to say which.
 *
 * The one failure deliberately left as a bare `Error` is `getSetting`'s unknown-key check: that is a
 * TYPO in a string literal, caught the first time the line runs, and it is not an entitlement outcome
 * a caller could sensibly handle — a gate that swallowed it into "temporarily unavailable" would hide
 * a permanent bug behind a transient-sounding message.
 */
export class EntitlementsContextMalformedError extends EntitlementError {
  constructor(msg: string) {
    super(msg);
    this.name = 'EntitlementsContextMalformedError';
  }
}

/**
 * Thrown when a snapshot is attached to a context for a DIFFERENT tenant. Structurally impossible
 * today (one producer, which spreads the session it resolved for) and cheap to keep impossible: slice
 * 7's cross-tenant platform plane is exactly where a copied context stops being hypothetical.
 */
export class EntitlementsTenantMismatchError extends EntitlementError {
  constructor(ctxTenantId: string, snapTenantId: string) {
    super(
      `Entitlement snapshot belongs to tenant ${snapTenantId} but the context is tenant ` +
        `${ctxTenantId}. A snapshot is never transferable between contexts.`,
    );
    this.name = 'EntitlementsTenantMismatchError';
  }
}

/**
 * The type a gate takes. This is `SessionContext` — an ALIAS, not a narrowing; the name is here to
 * mark intent at a call site.
 *
 * It used to be a structural narrowing of SessionContext, on the theory that a caller then could not
 * "accidentally satisfy the type by spreading an object literal". Round 1 proved the guard ran exactly
 * backwards: every added field is optional, so an object literal satisfied it while the type
 * `getSession()` actually returns did NOT, because SessionContext typed `entitlements` as `unknown`.
 * The fix was to type the field concretely on SessionContext (core/entitlement-types.ts), which leaves
 * nothing for this alias to narrow — and no slice-3 gate needs a cast.
 */
export type EntitledContext = SessionContext;

const CORE = new Set(CORE_MODULE_CODES);
const CATALOG = new Map(MODULE_CATALOG.map((m) => [m.code, m]));
const SETTING_DEFAULTS = new Map(SETTING_CATALOG.map((s) => [s.key, s.defaultValue]));
/** Setting key → the module that owns it (null = installation-wide). Drives kill transitivity below. */
const SETTING_OWNER = new Map(SETTING_CATALOG.map((s) => [s.key, s.moduleCode]));

/**
 * Deployment-level kill switch (convention C8), the ONE thing that stays in the environment.
 *
 * Kill-only semantics, and the asymmetry is the whole point: it can force a module OFF platform-wide
 * without a database write, but it can never turn one ON. So it cannot be used to hand a customer
 * something they did not buy, while it remains available when a module has to be stopped NOW.
 *
 * IT BINDS CORE MODULES TOO, and that is intentional rather than an oversight (round 1 asked for the
 * decision to be stated). The catalog's "core modules are never disableable" is a statement about what
 * a customer can buy and what a `tenant_module` row can express — enforced by the 0313 trigger. This
 * is the incident lever: if Leave has to stop platform-wide at 3am, "except the core ones" would make
 * the lever useless for exactly the modules most likely to need it. It binds an EXEMPT context too.
 *
 * AND IT IS TRANSITIVE THROUGH CORE (round 3). The CORE branch used to return true BEFORE the dependsOn
 * closure ran, so `MODULE_KILL=employees` killed `employees` and left `leave` and `ess` — both of which
 * declare `dependsOn: ['employees']` — fully on, write surfaces included. "The incident lever has no
 * exceptions" was therefore false for the one case most likely to matter: an incident on the employee
 * spine, where Leave and ESS are the two modules reading it hardest. A core module now evaluates its
 * core dependencies. It skips a NON-core dependency (that would need the snapshot, and a core code must
 * stay answerable without one) — and `test/module-catalog-drift.test.ts` refuses a core module that
 * declares one, so the skip can never hide a real edge.
 *
 * IT FAILED OPEN ON A TYPO, AND THAT IS NOW FIXED (round 2). Every other branch in this file is
 * fail-closed; this one silently left the module ON for a mis-cased entry (`MODULE_KILL=Payroll`), a
 * wrong delimiter (`payroll;toil`), or a guessed wildcard (`*`, `ALL`), with no warning anywhere. For
 * a lever whose entire justification is "a module has to be stopped NOW at 3am", the failure mode of
 * "did nothing, said nothing" is the worst one available. Two changes, both narrow:
 *
 *   - comparison is case-INSENSITIVE and trimmed on both sides (catalog codes are all lower-case), so
 *     an operator typing what they see in the console gets what they meant;
 *   - every parsed entry is checked against MODULE_CATALOG and an unrecognised one is logged loudly,
 *     ONCE per distinct MODULE_KILL value rather than once per call. Deliberately a log and not a
 *     throw: this parses lazily on the first entitlement question of a process, and throwing there
 *     would turn a typo in an incident lever into a total outage — the opposite of the lever's job.
 *     A wildcard is therefore still not supported, but it now ANNOUNCES that it did nothing.
 *
 * Memoised on the raw string, so flipping the env var (tests, a redeploy) re-parses and re-warns.
 *
 * THERE IS A SECOND LEVER, `SETTING_KILL`, AND ROUND 3 IS WHY. MODULE_KILL was sold as "the ONE thing
 * that stays in the environment" and "the 3am lever", but it was consulted only by `moduleEnabled` —
 * and FIVE of the nine env flags slice 3 retires are SETTINGS, not modules (`PAYROLL_RESET_ENABLED`,
 * `PAYROLL_UNLOCK_ENABLED`, `INDIVIDUAL_TXN_PAY_ENABLED`, `AUDIT_HASH_CHAIN_ENABLED`,
 * `FEEDBACK_AI_PLANNING_ENABLED`; see LEGACY_SETTING_ENV_GATES). After the flip, reopening a finalised
 * payroll run and the audit hash chain would have been per-tenant database rows with NO platform-wide
 * off switch at all — and `audit.hash_chain_enabled` has `moduleCode: null`, so no module kill could
 * ever have reached it even indirectly. Slice 3 deletes those env vars; the replacement lever has to
 * exist in the same primitive that replaces them, not one slice later.
 *
 * SETTING_KILL forces the CATALOG DEFAULT, never a value. Same asymmetry as MODULE_KILL, for the same
 * reason: an operator must not be able to hand a tenant a behaviour they never configured. Every
 * catalogued default is `false` today, so today it reads as "off" — but the promise is "the value the
 * product ships with", which is the only one that stays honest when a future setting defaults true.
 *
 * MODULE_KILL is TRANSITIVE onto that module's settings (`SETTING_OWNER`): killing `payroll` forces
 * `payroll.*` back to their defaults, because a setting is a behaviour OF a module and leaving one
 * armed while its module is stopped is the contradiction the lever exists to prevent.
 */
type KillMemo = { raw?: string; set: ReadonlySet<string> };
const moduleKill: KillMemo = { set: new Set() };
const settingKill: KillMemo = { set: new Set() };

/**
 * Parse one kill list. Kept generic over the two levers so a fix to the parsing (case, whitespace, the
 * loud unknown-entry warning) can never apply to one and not the other.
 */
function parseKillList(
  memo: KillMemo,
  envName: string,
  known: (v: string) => boolean,
  where: string,
): ReadonlySet<string> {
  const raw = process.env[envName] ?? '';
  if (raw === memo.raw) return memo.set;
  memo.raw = raw;
  const entries = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const unknown = entries.filter((e) => !known(e));
  if (unknown.length > 0) {
    console.error(
      `[entitlements] ${envName} contains ${unknown.length} entry/entries that are not ${where}: ` +
        `${unknown.join(', ')}. They kill NOTHING. Valid entries are comma-separated and listed in ` +
        `packs/catalog.ts.`,
    );
  }
  memo.set = new Set(entries);
  return memo.set;
}

function killSet(): ReadonlySet<string> {
  return parseKillList(moduleKill, 'MODULE_KILL', (c) => CATALOG.has(c), 'module codes (MODULE_CATALOG)');
}

function killed(code: string): boolean {
  return killSet().has(code.toLowerCase());
}

/** A setting is killed by its own name, or by a kill on the module that owns it. */
function settingKilled(key: string): boolean {
  const killedKeys = parseKillList(
    settingKill,
    'SETTING_KILL',
    (k) => SETTING_DEFAULTS.has(k),
    'setting keys (SETTING_CATALOG)',
  );
  if (killedKeys.has(key.toLowerCase())) return true;
  const owner = SETTING_OWNER.get(key);
  return owner != null && killed(owner);
}

/**
 * The ONE query behind every snapshot, built as a drizzle `sql` fragment so BOTH runtimes get it from
 * a single source AND both parameterise it.
 *
 * The first version kept the statement as raw text with `$1` and, because drizzle's `execute` wants a
 * prepared fragment, spliced the id in with `sql.raw(TEXT.replaceAll('$1', "'…'::uuid"))` behind a
 * UUID shape check. Round 1 could not defeat that guard (JS `$` without /m does not match before a
 * trailing newline, and the character class admits only hex and dashes) — but it was right that the
 * "this path has to splice" premise was false, and that `replaceAll('$1', …)` corrupts the statement
 * silently the day it grows a `$10`. A fragment hands the tx path a bound parameter directly, and
 * `PgDialect.sqlToQuery` hands the raw path the same statement as `{ sql, params }`. No concatenation
 * on either runtime, and no shape check left load-bearing.
 *
 * Three subselects folded into a single row: deliberately not three round trips, since this rides the
 * session path every request already pays for.
 *
 * THE SETTINGS SUBSELECT JOINS `setting_definition` AND FILTERS ON PROVENANCE (round 2's finding).
 * 0313's `tenant_setting_write` comment justifies constraining `source` on the grounds that it is
 * "the provenance the settings screen renders and slice 2's resolver reasons about" — and the resolver
 * did not select `source` or `scope` at all. It folded key→value and nothing else, so at READ time a
 * customer-written value was indistinguishable from a platform-written one and the entire boundary was
 * one `WITH CHECK` predicate on a table `ai_hr_app` holds full CRUD over by design.
 *
 * So the fold now DROPS a `source='customer'` row on a `platform`-scoped key, and the key falls back to
 * the catalog default (or to a platform-written row, which is not dropped). That is defence in depth,
 * not a replacement: the write policy remains the control, and this is the read-side check that makes
 * a policy regression visible instead of silently effective. `payroll.reset_enabled`,
 * `payroll.unlock_enabled` and `audit.hash_chain_enabled` are the keys it protects — reopening a
 * finalised payroll run and the tamper-evidence itself.
 *
 * `setting_definition` is readable by `ai_hr_app` under `setting_definition_read USING (true)` (0313),
 * and `tenant_setting.key` is a FK onto it, so the INNER join can never drop a legitimate row.
 */
function snapshotQuery(tenantId: string) {
  return sql`
    SELECT
      (SELECT coalesce(json_agg(json_build_object('code', tm.module_code, 'company', tm.company_id)), '[]'::json)
         FROM tenant_module tm
        WHERE tm.tenant_id = ${tenantId}::uuid
          AND tm.status IN ('active', 'trial')
          AND (tm.expires_at IS NULL OR tm.expires_at > now())) AS modules,
      (SELECT coalesce(json_object_agg(ts.key, ts.value), '{}'::json)
         FROM tenant_setting ts
         JOIN setting_definition sd ON sd.key = ts.key
        WHERE ts.tenant_id = ${tenantId}::uuid
          AND (sd.scope = 'tenant' OR ts.source <> 'customer')) AS settings,
      (SELECT t.status FROM tenant t WHERE t.id = ${tenantId}::uuid) AS tenant_status`;
}

const DIALECT = new PgDialect();

type RawSnapshotRow = {
  modules: { code: string; company: string | null }[] | null;
  settings: Record<string, unknown> | null;
  tenant_status: string | null;
};

/**
 * Fold the query's single row into the snapshot shape.
 *
 * `tenantId` is taken as a parameter rather than read back out of the row because a row may not EXIST
 * (the unresolved case below) — the snapshot must still record whose question it failed to answer, or
 * `snapshotOf`'s attribution check would have a hole exactly where the data is least trustworthy.
 */
export function toSnapshot(tenantId: string, row: RawSnapshotRow | undefined): EntitlementSnapshot {
  const modules = row?.modules ?? [];
  const enabled = new Set<string>();
  const scoped: Record<string, string[]> = {};
  for (const m of modules) {
    if (m.company == null) enabled.add(m.code);
    else (scoped[m.code] ??= []).push(m.company);
  }
  return {
    tenantId,
    enabledModules: [...enabled],
    scopedModules: scoped,
    settings: row?.settings ?? {},
    // NOT `?? 'active'`. A tenant row we could not READ is a different fact from a tenant row that
    // SAYS active, and collapsing the two was the one fail-OPEN branch in this file — with the RLS
    // defect above live, every session took it, so a suspended tenant read as in good standing.
    // TENANT_STATUS_UNRESOLVED is not in TENANT_STATUS_GOOD_STANDING, so every billable module closes.
    tenantStatus: row?.tenant_status ?? TENANT_STATUS_UNRESOLVED,
  };
}

/**
 * Resolve from inside an ALREADY tenant-scoped drizzle transaction — i.e. inside `withTenant`, which
 * has issued the `app.tenant_id` set_config the RLS policies read.
 *
 * CALLERS TODAY: `test/entitlement-resolver.test.ts` and `test/harness.ts`'s `entitledCtx` (round 3 —
 * the fixture that lets a test prove a gate CLOSES, which the exempt `adminCtx` structurally cannot).
 * The original comment said "used by the harness, provisioning and the sweeps", and round 2 was right
 * that none of them called it — those paths carry an `entitlementsExempt` marker instead, which is the
 * cheaper answer while they run as the owner with no session. This stays exported because slice 9's
 * by-tenantId resolver is the shape a
 * sweep will need once suspension has to bind it, and because it is the only way to resolve a snapshot
 * for a tenant OTHER than the session's — but "who uses it" is now stated accurately.
 *
 * Deliberately does NOT set the GUC itself: inside `withTenant` that would be a redundant write, and
 * making it unconditional here would mask a caller that has no tenant scope at all.
 */
export async function resolveEntitlementsTx(tx: Tx, tenantId: string): Promise<EntitlementSnapshot> {
  const rows = (await tx.execute(snapshotQuery(tenantId))) as unknown as RawSnapshotRow[];
  return toSnapshot(tenantId, rows[0]);
}

/** The minimal handle these resolvers need: run a parameterised statement, get rows back. */
export type SqlExec = (q: string, params: unknown[]) => Promise<unknown[]>;

/**
 * Resolve using a raw `postgres` handle. Parameterised via `PgDialect.sqlToQuery`, so the tenant id is
 * never interpolated into SQL text on any path.
 *
 * Assumes the handle is ALREADY tenant-scoped. On a bare pool connection RLS returns nothing (see the
 * header), which is why the session path calls `resolveEntitlementsInTenantTx` instead.
 */
export async function resolveEntitlementsRaw(exec: SqlExec, tenantId: string): Promise<EntitlementSnapshot> {
  const { sql: text, params } = DIALECT.sqlToQuery(snapshotQuery(tenantId));
  const rows = (await exec(text, params)) as RawSnapshotRow[];
  return toSnapshot(tenantId, rows[0]);
}

/**
 * Resolve on a raw handle that is inside an OPEN TRANSACTION but has no tenant scope yet — the session
 * path (lib/session.ts). Sets the same transaction-local GUC `withTenant` sets, so the read happens
 * UNDER RLS rather than around it, then runs the snapshot query on the same connection.
 *
 * `set_config(…, true)` is SET LOCAL: discarded at COMMIT, so nothing leaks onto the next checkout of
 * a pooled connection. That matters more than it looks — a session-level GUC left behind would make a
 * later non-transactional query on the same connection read as SOME tenant.
 *
 * MUST be given a TRANSACTION-bound exec. On a bare pool handle `set_config(…, true)` applies only to
 * its own implicit transaction and the following SELECT sees nothing — the exact bug this replaces —
 * so lib/session.ts opens the transaction and the test asserts the composed behaviour end to end.
 */
export async function resolveEntitlementsInTenantTx(
  exec: SqlExec,
  tenantId: string,
): Promise<EntitlementSnapshot> {
  await exec(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
  return resolveEntitlementsRaw(exec, tenantId);
}

/**
 * Validate the CONTEXT ITSELF, before any question about a particular code is answered.
 *
 * Hoisted out of `snapshotOf` because of round 2's ordering finding. `snapshotOf` is only reached
 * AFTER the killed/CORE/CATALOG branches, so a context carrying a garbage `entitlementsExempt` marker
 * answered cleanly — `true` — for every core module and only revealed itself when someone happened to
 * ask about a billable one. A mis-wired or forged context could therefore sit undetected on core-only
 * paths indefinitely. The marker is a property of the CONTEXT, not of the code being asked about, so
 * it is checked first and every entry point calls this.
 *
 * MEMBERSHIP, not truthiness. The typed union cannot be the gate on its own: a context can be
 * hand-built, cast, or arrive across a serialisation boundary. Round 1 showed the truthiness test let
 * any non-empty string ('lol-not-in-the-list') open every module for every tenant.
 *
 * ROUND 3 FINISHED THE HOIST. Two more facts about the context were still being checked late, inside
 * `snapshotOf`, and both had the property round 2 hoisted the marker to eliminate:
 *
 *   - a snapshot belonging to ANOTHER TENANT. Reachable only after killed/CORE/CATALOG, so a context
 *     copied across tenants (slice 7's platform plane, a future "act as tenant") answered `true` for
 *     every core module with nothing raised. A snapshot's owner is a property of the context.
 *   - a MALFORMED snapshot, same ordering, and it also validated only the containers — see
 *     `isEntitlementSnapshot`, which now validates elements and closes the substring bypass.
 *
 * `entitlementsError` deliberately stays LATE. That one is not a fault in the context, it is a
 * production incident recorded on a healthy context, and the documented behaviour is that core modules
 * keep answering so the app stays navigable while the snapshot query is failing. The line is: A FAULT
 * IN THE CONTEXT IS LOUD EVERYWHERE; AN INFRASTRUCTURE FAULT DEGRADES AND LEAVES CORE ANSWERING.
 *
 * EXEMPT AND ENTITLED ARE MUTUALLY EXCLUSIVE. The marker asserts "no snapshot can exist for me"; a
 * context that carries one anyway is contradicting itself, and the resolver used to resolve that
 * contradiction silently in the marker's favour — `snapshotOf` returned null on the marker BEFORE
 * looking at `ctx.entitlements`, so a real, correct snapshot was DISCARDED: every module answered true
 * (including on a suspended tenant, for modules never purchased) and every setting read the catalog
 * default instead of the tenant's configured value. That made the marker a blanket OVERRIDE rather than
 * the fallback its own documentation describes, and it is the shape slice 9 walks into the moment a
 * sweep starts resolving real snapshots. Refusing the combination outright means that migration cannot
 * be left half-done: attach the snapshot AND drop the marker, or the context fails loudly.
 */
function assertContextWellFormed(ctx: EntitledContext, what: string): void {
  const exempt = ctx.entitlementsExempt;
  if (exempt !== undefined) {
    if (!isExemptReason(exempt)) {
      throw new EntitlementsContextMalformedError(
        `Unrecognised entitlementsExempt marker '${exempt}' — it must be one of ` +
          `${Object.keys(ENTITLEMENTS_EXEMPT_REASONS).join(', ')} (core/entitlement-types.ts).`,
      );
    }
    if (ctx.entitlements !== undefined || ctx.entitlementsError !== undefined) {
      throw new EntitlementsContextMalformedError(
        `Context for tenant ${ctx.tenantId} claims entitlementsExempt: '${exempt}' AND carries a ` +
          `resolved snapshot (asked about '${what}'). The marker means "entitlements cannot exist for ` +
          `me"; a context that has them must drop the marker, or the snapshot is silently discarded.`,
      );
    }
  }
  if (ctx.entitlements !== undefined) {
    if (!isEntitlementSnapshot(ctx.entitlements)) {
      throw new EntitlementsContextMalformedError(
        `The entitlement snapshot on tenant ${ctx.tenantId}'s context is not snapshot-shaped ` +
          `(asked about '${what}') — most likely it lost fields across a serialisation boundary. ` +
          `See EntitlementSnapshot / isEntitlementSnapshot in core/entitlement-types.ts.`,
      );
    }
    // Attribution. See EntitlementSnapshot.tenantId — a snapshot is not transferable between contexts.
    if (ctx.entitlements.tenantId !== ctx.tenantId) {
      throw new EntitlementsTenantMismatchError(ctx.tenantId, ctx.entitlements.tenantId);
    }
  }
}

/** The snapshot to reason about, or null for an exempt context. Shape and owner are already checked. */
function snapshotOf(ctx: EntitledContext, what: string): EntitlementSnapshot | null {
  if (ctx.entitlementsExempt !== undefined) return null; // already validated by assertContextWellFormed
  // Resolution was ATTEMPTED and failed — a different fact from "never resolved", and the message the
  // on-call engineer reads has to say which. See EntitlementsResolutionFailedError.
  if (ctx.entitlementsError) {
    throw new EntitlementsResolutionFailedError(ctx.tenantId, what, ctx.entitlementsError);
  }
  if (!ctx.entitlements) throw new EntitlementsUnresolvedError(what);
  return ctx.entitlements;
}

/**
 * Is `code` enabled? Cycle-safe because `seen` is threaded THROUGH the recursion.
 *
 * The first version allocated `seen` inside each frame and recursed via the public `isModuleEnabled`,
 * which starts a fresh set — so the visited set never crossed a frame boundary and a catalog cycle
 * a→b→a recursed until the stack blew (round 1 reproduced the RangeError). The comment claimed the
 * opposite and deferred to a drift test that did not exist. Both are true now: the set is shared, and
 * `test/module-catalog-drift.test.ts` asserts the dependsOn graph is acyclic.
 *
 * Order of evaluation, each step fail-closed. (Step 0 — the context's own well-formedness — runs in the
 * public entry points, BEFORE any of this; see `assertContextWellFormed`.)
 *   1. MODULE_KILL forces OFF regardless of anything else, INCLUDING core and exempt (C8).
 *   2. CORE modules are TRUE without touching the snapshot — they take no rows by construction, so a
 *      tenant with an empty tenant_module table still has Leave and ESS. This is also why a core code
 *      answers on a snapshot-less context instead of throwing: it needs no snapshot to be decided.
 *      Their CORE dependencies are still walked, so MODULE_KILL reaches `leave` through `employees`.
 *   3. Unknown code ⇒ FALSE. A typo disables rather than enables. Checked BEFORE the exempt branch —
 *      otherwise an exempt context answers TRUE for a module that does not exist (round 1).
 *   4. An exempt context is TRUE: provisioning and the seeder run before entitlements exist, and
 *      failing them closed would make a tenant impossible to create.
 *   5. The tenant must be in GOOD STANDING — an ALLOW-list, so 'suspended', 'closed', a row that could
 *      not be read, and any status a future migration adds all resolve closed.
 *   6. Tenant-wide row ⇒ true. Otherwise a company-scoped row for `companyId` ⇒ true, and asking
 *      WITHOUT a company when only company-scoped rows exist ⇒ FALSE, because the honest answer to
 *      "may this tenant use payroll?" when they bought it for one company is "for which company?".
 *   7. Every dependsOn must ALSO be enabled — a lapsed dependency disables its dependents.
 *
 * STEP 2 RUNS BEFORE STEP 5, SO A SUSPENDED OR CLOSED TENANT KEEPS THE SIX CORE MODULES — INCLUDING
 * THEIR WRITE SURFACES. Round 2 was right that the justification previously given for this ("payslip
 * history must stay readable") was wrong on the facts: payslips live under `payroll`, which is billable
 * and does close. The six core codes are `employees`, `org`, `leave`, `ess`, `approvals` and
 * `knowledge_base`, and hiring, terminating, restructuring the org and approving leave all sit inside
 * them. So the decision, stated properly:
 *
 *   THIS PRIMITIVE CANNOT RESTRICT A SUSPENDED OR CLOSED TENANT AT ALL. A commercial entitlement
 *   answers "did you buy this?", and a core module is not bought — there is no row for the status
 *   check to qualify, and making a boolean "may I?" return false for Leave would lock a suspended
 *   customer out of their own employee records rather than out of what they stopped paying for. The
 *   whole suspension story therefore rests on slice 9's `SET TRANSACTION READ ONLY` overlay, which
 *   operates at transaction level where a READ can be allowed and a WRITE refused — a distinction a
 *   boolean here cannot express. Until slice 9 lands, a closed tenant retains write access to core.
 *   `test/entitlement-resolver.test.ts` pins that as today's behaviour, so slice 9 has a fixture to
 *   flip rather than a surprise to discover.
 *
 * STEP 7 PASSES `companyId` DOWN UNCHANGED, WHICH HAS A CONSEQUENCE WORTH NAMING (round 2). A module
 * the tenant owns TENANT-WIDE resolves FALSE when any transitive dependency is company-scoped and the
 * caller has no companyId — e.g. `toil` granted tenant-wide over an `attendance` scoped to one
 * subsidiary, asked at `core/toil.ts:404` where no company is in hand. That is the SAME rule as step 6
 * applied one level down, and it is deliberately kept: the alternative ("a dependency scoped to ANY
 * company satisfies the closure") is the only fail-OPEN branch that was on offer, and it would let a
 * subsidiary-scoped Attendance purchase silently entitle the whole group to TOIL. Nothing writes a
 * company-scoped row today — `db/provision.ts` always emits `company_id NULL` — so the branch is
 * unreachable through any supported flow; it is pinned by a test so that when slice 7 gives operators
 * a way to scope a module, the group-wide consequence is a documented answer and not a discovery.
 */
type Walk = {
  /** Codes on the CURRENT recursion path. Re-entering one is a cycle. */
  stack: Set<string>;
  /** Codes already decided TRUE on this traversal. Re-entering one is a diamond, not a cycle. */
  done: Set<string>;
};

/**
 * Walk `code`'s dependsOn closure. Two marks, not one, and round 3 is why.
 *
 * The single `seen` set conflated "currently being decided further up the stack" with "already decided
 * true", and skipped both — so a catalog cycle a→b→a answered TRUE for every module in it: asking about
 * `a` seeded seen={a}, walked b, found `a` already in seen, skipped it, and both returned true. The
 * comment ("either way, re-entering it is what a cycle would do forever") described TERMINATION, which
 * was correct, and said nothing about the ANSWER — which was the one place in this file where
 * undecidable data resolved OPEN. `test/module-catalog-drift.test.ts` refuses a cyclic catalog and
 * distinguishes VISITING from DONE for exactly this reason; the resolver now does too, so it no longer
 * depends on a test over static data to be fail-closed. A node re-entered while VISITING answers FALSE.
 *
 * `coreOnly` is the core branch's walk: a core module's dependencies are all core (pinned by the drift
 * test), and restricting to core keeps the promise that a core code is answerable with NO snapshot.
 */
function depsSatisfied(
  ctx: EntitledContext,
  code: string,
  companyId: string | null | undefined,
  walk: Walk,
  coreOnly: boolean,
): boolean {
  for (const dep of CATALOG.get(code)?.dependsOn ?? []) {
    if (coreOnly && !CORE.has(dep)) continue;
    if (walk.done.has(dep)) continue; // already decided TRUE on this traversal
    if (walk.stack.has(dep)) return false; // cycle — fail closed like everything else
    walk.stack.add(dep);
    const ok = moduleEnabled(ctx, dep, companyId, walk);
    walk.stack.delete(dep);
    if (!ok) return false;
    walk.done.add(dep);
  }
  return true;
}

function moduleEnabled(
  ctx: EntitledContext,
  code: string,
  companyId: string | null | undefined,
  walk: Walk,
): boolean {
  if (killed(code)) return false;
  // Step 2. The closure still runs, restricted to core, so the kill lever is transitive through core.
  if (CORE.has(code)) return depsSatisfied(ctx, code, companyId, walk, true);
  if (!CATALOG.has(code)) return false;

  const snap = snapshotOf(ctx, code);
  if (snap === null) {
    // EXEMPT CONTEXT, BILLABLE MODULE ⇒ THROW. Amended in slice 3, after this branch produced three
    // real defects in one slice.
    //
    // It used to `return true`, on the reasoning that "a module is a gate, and an exempt caller is not
    // gated". That holds for CORE modules — and they never reach here, because step 2 answers them
    // without a snapshot. Everything that gets this far is non-core and catalogued, which by
    // construction means BILLABLE (the drift test pins core ∪ billable = the whole catalog). So the old
    // answer meant: any caller carrying a marker silently receives every paid module, for every tenant,
    // whether or not they bought it — the exact enforcement bypass this slice exists to close.
    //
    // It was not hypothetical. `scripts/review-sweep.ts` dispatched notifications for every tenant on
    // the box via this branch, and nothing failed, because the failure mode is a customer being GIVEN
    // something. A silent grant is the one outcome no test notices.
    //
    // Throwing is the same fail-loud rule the no-snapshot case already follows: the honest answer for a
    // caller with no entitlement data is "I cannot know", never "yes". A sweep that legitimately needs
    // the answer resolves a real snapshot (resolveEntitlementsTx) and drops its marker; one that has no
    // business asking gets a stack trace pointing at the line that asked, on its first run, instead of
    // shipping unpurchased features quietly for a year.
    throw new EntitlementsExemptForBillableError(code, ctx.entitlementsExempt as string);
  }

  if (!TENANT_STATUS_GOOD_STANDING.has(snap.tenantStatus)) return false;

  const direct =
    snap.enabledModules.includes(code) ||
    (companyId != null && (snap.scopedModules[code] ?? []).includes(companyId));
  if (!direct) return false;

  return depsSatisfied(ctx, code, companyId, walk, false);
}

/** Is `code` enabled for this context? See `moduleEnabled` for the full evaluation order. */
export function isModuleEnabled(ctx: EntitledContext, code: string, companyId?: string | null): boolean {
  assertContextWellFormed(ctx, code); // step 0 — before killed/CORE/CATALOG can answer for a broken context
  return moduleEnabled(ctx, code, companyId, { stack: new Set<string>([code]), done: new Set<string>() });
}

/**
 * Throw `ModuleNotEnabledError` unless the module is enabled — the D3 service-boundary guard.
 *
 * Note what it does NOT do: it does not convert `EntitlementsUnresolvedError` or
 * `EntitlementsResolutionFailedError` from the inner call into `ModuleNotEnabledError`. Reporting "not
 * on your plan" when the truth is "the snapshot query failed" would tell a paying customer they had
 * been downgraded during what is actually an infrastructure incident. Both errors share the
 * `EntitlementError` supertype so one catch clause still covers the family — see that class.
 */
export function assertModuleEnabled(ctx: EntitledContext, code: string, companyId?: string | null): void {
  if (!isModuleEnabled(ctx, code, companyId)) throw new ModuleNotEnabledError(code);
}

/**
 * A setting's effective value: the tenant's row if present, otherwise the catalog default.
 *
 * One resolver, so a missing row is never a silent `false` — an unknown key throws rather than
 * returning undefined and being read as "off" by a truthiness check at the call site.
 *
 * A row holding JSON `null` counts as ABSENT and falls back to the default (round 2). The presence test
 * used to be `key in snap.settings`, so a `null` value short-circuited the catalog default and the
 * caller got `null` where the contract above promises a value of the declared type. Harmless while
 * every catalogued setting is a boolean compared with `=== true`; the first `number` or `json` setting
 * would inherit it outright. The customer write path cannot produce this (0313's WITH CHECK requires
 * `jsonb_typeof(value) = value_type`), but the platform plane writes as the OWNER and bypasses that
 * policy by design, so the operator side can reach it.
 *
 * IT HAS A KILL LEVER NOW (round 3) — `SETTING_KILL`, plus MODULE_KILL transitively through the owning
 * module. See `parseKillList`: five of the nine env flags slice 3 retires are settings, and without
 * this they would have had no deployment-level off switch at all after the flip.
 *
 * IT DELIBERATELY IGNORES TENANT STANDING, and that is the same decision as core modules, one table
 * over. A suspended tenant keeps its configured setting values. A setting is not a purchase; it is HOW
 * a feature the tenant still reaches behaves, and forcing defaults on suspension would change payroll
 * arithmetic for an account that is merely in arrears. Suspension is slice 9's `SET TRANSACTION READ
 * ONLY` overlay, which can say "read yes, write no" — a distinction a value here cannot express.
 *
 * AN EXEMPT CONTEXT READS THE CATALOG DEFAULT, NOT THE TENANT'S VALUE. That is the only answer
 * available without a snapshot, and it is a trap for a sweep that ends up behind a setting — see
 * ENTITLEMENTS_EXEMPT_REASONS, which states it and names the concrete case.
 */
export function getSetting<T = unknown>(ctx: EntitledContext, key: string): T {
  if (!SETTING_DEFAULTS.has(key)) {
    // Deliberately a bare Error, not an EntitlementError: this is a typo in a string literal, not an
    // entitlement outcome. See EntitlementsContextMalformedError for why that line is drawn here.
    throw new Error(`Unknown setting key '${key}' — add it to SETTING_CATALOG in packs/catalog.ts.`);
  }
  assertContextWellFormed(ctx, key);
  if (settingKilled(key)) return SETTING_DEFAULTS.get(key) as T;
  const snap = snapshotOf(ctx, key);
  if (snap === null) return SETTING_DEFAULTS.get(key) as T;
  return (snap.settings[key] ?? SETTING_DEFAULTS.get(key)) as T;
}

/** Boolean convenience — the shape the env-flag reads it replaces already had. */
export const settingEnabled = (ctx: EntitledContext, key: string): boolean => getSetting(ctx, key) === true;

/**
 * `isModuleEnabled`, but an INFRASTRUCTURE failure answers FALSE instead of throwing. For CHROME —
 * the shell every authenticated page renders — and nothing else.
 *
 * WHY THIS EXISTS. lib/session.ts's `withEntitlements` deliberately swallows a resolution failure and
 * returns the session carrying `entitlementsError`, on the stated grounds that getSession is the entry
 * point for every page and throwing there "would take down authentication itself"; gates are then
 * supposed to "refuse AT THE POINT OF USE (fail-closed)". That contract silently breaks when the point
 * of use IS the root layout: `app/layout.tsx` gates the notification bell on the billable
 * `notifications` module, sits outside the only try/catch there (which converts AuthRequiredError to a
 * redirect), and there is no app/error.tsx — so a pool blip, a statement timeout or a
 * code-ahead-of-migration deploy would 500 EVERY authenticated route rather than degrade one feature.
 * Before slice 3 that line was `process.env.NOTIFICATIONS_ENABLED === 'true'` and could not throw.
 *
 * WHAT IT DOES NOT SWALLOW, which is the whole reason it is not a bare try/catch at the call site:
 * only `EntitlementsResolutionFailedError` — the one state that means "we tried to read the tenant's
 * commercial data and the infrastructure said no". A malformed context, a snapshot attributed to
 * another tenant, an exempt context asking about a billable module and a never-resolved synthetic
 * context are all WIRING BUGS; converting those to a quiet `false` would hide exactly the class of
 * defect slice 2's guards exist to surface, so they still throw.
 *
 * FALSE, not true: an unreadable snapshot must never open a billable feature. The customer loses the
 * bell for the duration of the incident and keeps the rest of the application.
 */
export function isModuleEnabledOrFalse(ctx: EntitledContext, code: string, companyId?: string | null): boolean {
  try {
    return isModuleEnabled(ctx, code, companyId);
  } catch (e) {
    if (e instanceof EntitlementsResolutionFailedError) return false;
    throw e;
  }
}
