/**
 * ADR-0077 slice 2 — the enforcement primitive's semantics.
 *
 * Every branch of `isModuleEnabled` is fail-closed, and each one is asserted here against a REAL
 * snapshot resolved from the database rather than a hand-built object literal — otherwise the tests
 * would be checking my mental model of the query rather than the query.
 *
 * TWO RESOLVERS, AND THE DISTINCTION IS LOAD-BEARING (round 1's test-validity finding).
 *
 *   `ctxFor`        resolves as the OWNER (test/harness.ts), which BYPASSES RLS. Right for asserting
 *                   the SEMANTICS of the fold — expiry, status, scoping, the dependency closure —
 *                   because those are properties of the query and the resolver, not of the policies.
 *   `sessionCtxFor` resolves through `withEntitlements`, the EXACT function getSession calls, on the
 *                   `ai_hr_app` pool the app really uses. That is the only path production runs, and
 *                   it was the one with no coverage at all: the first version of this slice read the
 *                   snapshot outside any transaction, so `app.current_tenant_id()` was NULL, so every
 *                   real session got an empty snapshot while all 19 owner-based tests stayed green.
 *
 * So the owner tests are kept for what they genuinely prove, and the app-role describe block below is
 * the regression fence — it fails outright if the read stops happening under a tenant-scoped
 * transaction, and it is what actually exercises `tenant_module_read` / `tenant_setting_read`.
 *
 * WHAT ROUND 2 ADDED, and why each one is here rather than in prose:
 *   - the exemption list now names the FILES that carry each marker, and a test READS them. The old
 *     pinning test asserted five key names and a minimum reason length — it passed identically whether
 *     or not a single line of code consumed a marker, and none did.
 *   - the forged-marker check moved ahead of the kill/core/catalog branches, so a garbage context can
 *     no longer answer cleanly on core-only paths.
 *   - a CLOSED tenant keeping its core WRITE surfaces is pinned as today's behaviour, so slice 9 has a
 *     fixture to flip instead of a surprise to find.
 *   - the company-scoped DEPENDENCY case (a tenant-wide module closed by a scoped dependency under an
 *     unscoped ask) is pinned, because it is the branch every slice-3 gate site will hit first.
 *   - the GUC-leak assertion runs on a RESERVED connection, so it can no longer pass by sampling a
 *     backend that never ran the transaction.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import {
  adminCtx,
  closeAll,
  entitledCtx,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  setModule,
  setSetting,
  setTenantStatus,
  type Base,
} from './harness';
import {
  ENTITLEMENTS_EXEMPT_REASONS,
  EntitlementError,
  EntitlementsContextMalformedError,
  EntitlementsResolutionFailedError,
  EntitlementsTenantMismatchError,
  EntitlementsExemptForBillableError,
  EntitlementsUnresolvedError,
  ModuleNotEnabledError,
  TENANT_STATUS_UNRESOLVED,
  assertModuleEnabled,
  getSetting,
  isModuleEnabled,
  resolveEntitlementsInTenantTx,
  resolveEntitlementsRaw,
  resolveEntitlementsTx,
  type EntitledContext,
} from '../core/entitlements';
import { withEntitlements } from '../lib/session';
// The app-role pool itself — the same singleton lib/session.ts resolves through.
import { client as appClient } from '../db/client';

/** Resolve a REAL snapshot for a tenant and hand back a context shaped like getSession's output. */
async function ctxFor(tenantId: string): Promise<EntitledContext> {
  const snap = await owner.db.transaction((tx) => resolveEntitlementsTx(tx, tenantId));
  return { tenantId, userId: undefined, roles: ['hr_admin'], entitlements: snap };
}

/**
 * Resolve the way PRODUCTION does: through `withEntitlements` on the `ai_hr_app` pool, under RLS.
 * `db/client`'s singleton points at this worker's test database (test/env.ts), and TEST_DATABASE_URL
 * connects as `ai_hr_app` — the NOBYPASSRLS role — so the policies really apply here.
 */
async function sessionCtxFor(tenantId: string): Promise<EntitledContext> {
  return withEntitlements({ tenantId, userId: undefined, roles: ['hr_admin'] });
}

describe('slice 2 — isModuleEnabled', () => {
  let base: Base;

  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    delete process.env.MODULE_KILL;
    delete process.env.SETTING_KILL;
  });
  afterAll(() => {
    delete process.env.MODULE_KILL;
    delete process.env.SETTING_KILL;
  });

  it('reflects the seeded default set — enabled where a row exists, disabled where none does', async () => {
    // `notifications` USED TO BE IN THE ON LIST, AND THAT WAS A REAL DEFECT of exactly the shape this
    // slice keeps finding. seedBase seeds `legacyEnabledModulesIn(process.env)`, and `notifications` is
    // gated on NOTIFICATIONS_ENABLED — an env var a developer's untracked `.env.local` commonly sets and
    // CI never does. So this assertion passed on the machine slice 3 was written on and would have FAILED
    // in CI, for a reason nothing in the test stated. (test/env.ts deleted only five of the nine tracked
    // gates; it now deletes all nine, and test/module-catalog-drift.test.ts asserts the resulting
    // baseline, so the environment can no longer decide what this file means.)
    //
    // The ON list is now the four modules NO env var gates anywhere (F20) — the ones every tenant has by
    // construction — and the OFF list is everything the suite's env leaves without a row.
    const ctx = await ctxFor(base.tenantId);
    for (const on of ['payroll', 'attendance', 'claims', 'performance']) {
      expect(isModuleEnabled(ctx, on), `${on} should be enabled`).toBe(true);
    }
    for (const off of ['toil', 'multi_cycle_payroll', 'typed_pay_components', 'notifications']) {
      expect(isModuleEnabled(ctx, off), `${off} should be disabled (no row)`).toBe(false);
    }
    // …and the ON half is decided by a ROW, not by a default: granting one of the OFF codes flips it.
    // Without this the test could pass against a resolver that answered from the catalog.
    await setModule(base.tenantId, 'notifications', 'active');
    expect(isModuleEnabled(await ctxFor(base.tenantId), 'notifications')).toBe(true);
  });

  it('CORE modules are true without any row — a zero-row tenant keeps Leave and ESS', async () => {
    await owner.db.execute(sql`DELETE FROM tenant_module WHERE tenant_id = ${base.tenantId}`);
    const ctx = await ctxFor(base.tenantId);
    expect(ctx.entitlements!.enabledModules).toEqual([]);
    for (const core of ['leave', 'ess', 'employees', 'org', 'approvals', 'knowledge_base']) {
      expect(isModuleEnabled(ctx, core), `${core} is core and must stay on`).toBe(true);
    }
    // …and the billable ones are genuinely off, so the test above is not passing vacuously.
    expect(isModuleEnabled(ctx, 'payroll')).toBe(false);
  });

  it('an UNKNOWN module code is disabled, not enabled', async () => {
    const ctx = await ctxFor(base.tenantId);
    expect(isModuleEnabled(ctx, 'not_a_module')).toBe(false);
  });

  it('a DISABLED row is disabled, and so is a deleted one', async () => {
    await setModule(base.tenantId, 'payroll', 'disabled');
    expect(isModuleEnabled(await ctxFor(base.tenantId), 'payroll')).toBe(false);
    await setModule(base.tenantId, 'payroll', null);
    expect(isModuleEnabled(await ctxFor(base.tenantId), 'payroll')).toBe(false);
  });

  it("a TRIAL row is enabled — a trial is access, not a different kind of 'off'", async () => {
    await setModule(base.tenantId, 'toil', 'trial');
    // toil depends on leave (core, always on) + attendance (seeded active), so the closure is satisfied.
    expect(isModuleEnabled(await ctxFor(base.tenantId), 'toil')).toBe(true);
  });

  it('an EXPIRED row is disabled even while its status still says active — no immortal grants', async () => {
    await setModule(base.tenantId, 'payroll', 'active');
    await owner.db.execute(
      sql`UPDATE tenant_module SET expires_at = now() - interval '1 day'
          WHERE tenant_id = ${base.tenantId} AND module_code = 'payroll'`,
    );
    const ctx = await ctxFor(base.tenantId);
    expect(isModuleEnabled(ctx, 'payroll')).toBe(false);
    // A FUTURE expiry is still live — proving the check is the comparison, not the column's presence.
    await owner.db.execute(
      sql`UPDATE tenant_module SET expires_at = now() + interval '30 days'
          WHERE tenant_id = ${base.tenantId} AND module_code = 'payroll'`,
    );
    expect(isModuleEnabled(await ctxFor(base.tenantId), 'payroll')).toBe(true);
  });

  it('the harness MIRROR answers exactly what the resolver answers, over a status × expiry matrix', async () => {
    // WHY THIS IS HERE AND NOT IN A HARNESS TEST. `adminCtx` is synchronous (≈247 files call it inline),
    // so it cannot query — it carries a synthetic snapshot that RESTATES the resolver's predicate in
    // TypeScript. A restated predicate is a second implementation, and the first one had already
    // drifted: it asked "is the status null or 'disabled'?" and treated everything else as ENABLED,
    // while the resolver asks `status IN ('active','trial') AND (expires_at IS NULL OR expires_at >
    // now())`. So a 'suspended' or expired grant read ON through the fixture and OFF through a real
    // session — a fixture answering a different question than the application, which is the exact
    // defect ADR-0077 slice 3 exists to remove, reintroduced inside the thing 247 files trust.
    //
    // It was LATENT, not live, because the suite only ever writes 'active'/'trial'/'disabled'/null. A
    // comment saying "keep these in step" would not have caught it; this compares the two.
    const cases: { status: 'active' | 'trial' | 'disabled' | null; expiresAt: Date | null; label: string }[] = [
      { status: 'active', expiresAt: null, label: 'active, no expiry' },
      { status: 'trial', expiresAt: null, label: 'trial, no expiry' },
      { status: 'disabled', expiresAt: null, label: 'disabled' },
      { status: null, expiresAt: null, label: 'no row at all' },
      { status: 'active', expiresAt: new Date(Date.now() + 30 * 86_400_000), label: 'active, expires in 30d' },
      { status: 'active', expiresAt: new Date(Date.now() - 86_400_000), label: 'active but EXPIRED' },
      { status: 'trial', expiresAt: new Date(Date.now() - 3_600_000), label: 'trial but EXPIRED' },
    ];
    for (const { status, expiresAt, label } of cases) {
      await setModule(base.tenantId, 'notifications', status, null, expiresAt);
      const real = isModuleEnabled(await ctxFor(base.tenantId), 'notifications');
      const mirrored = isModuleEnabled(adminCtx(base), 'notifications');
      expect(mirrored, `adminCtx and the resolver disagree for '${label}'`).toBe(real);
    }
    // …and the matrix must actually exercise both answers, or an always-false mirror would pass it.
    await setModule(base.tenantId, 'notifications', 'active');
    expect(isModuleEnabled(adminCtx(base), 'notifications')).toBe(true);
    await setModule(base.tenantId, 'notifications', 'disabled');
    expect(isModuleEnabled(adminCtx(base), 'notifications')).toBe(false);
  });

  it('the harness MIRROR also matches on the COMPANY grain and on TENANT STANDING', async () => {
    // THE OTHER TWO AXES THE RESOLVER READS, and which the mirror modelled as constants until the
    // slice-3 review: `scopedModules` was the literal `{}` and `tenantStatus` the literal `'active'`.
    // The test above varied only `tenant_module.status` and `expires_at`, so it established equivalence
    // over a strictly narrower matrix than its name claimed — a suspended tenant read ON through
    // `adminCtx` and OFF through a real session, and a company-scoped grant read OFF through `adminCtx`
    // and ON through a real one for that company. Both are branches ~247 files could hit.

    // ── company grain (moduleEnabled step 6) ──────────────────────────────────────────────────────
    // `notifications` has no dependsOn, so this isolates the grain from the closure.
    await setModule(base.tenantId, 'notifications', null); // no tenant-wide row
    await setModule(base.tenantId, 'notifications', 'active', base.companyId);
    for (const [companyId, label] of [
      [base.companyId, 'the entitled company'],
      [null, 'no company named'],
      ['00000000-0000-0000-0000-0000000000ff', 'a different company'],
    ] as const) {
      const real = isModuleEnabled(await ctxFor(base.tenantId), 'notifications', companyId);
      const mirrored = isModuleEnabled(adminCtx(base), 'notifications', companyId);
      expect(mirrored, `adminCtx and the resolver disagree for a company-scoped grant asked with ${label}`).toBe(real);
    }
    // Both answers really occur, so the agreement above is not "always false".
    expect(isModuleEnabled(adminCtx(base), 'notifications', base.companyId), 'entitled company ⇒ ON').toBe(true);
    expect(isModuleEnabled(adminCtx(base), 'notifications'), 'asking without a company ⇒ OFF (step 6)').toBe(false);
    // Revoking the scoped grant must clear the mirror too, not merely stop adding to it.
    await setModule(base.tenantId, 'notifications', null, base.companyId);
    expect(isModuleEnabled(adminCtx(base), 'notifications', base.companyId)).toBe(
      isModuleEnabled(await ctxFor(base.tenantId), 'notifications', base.companyId),
    );

    // ── tenant standing (moduleEnabled step 5) ────────────────────────────────────────────────────
    for (const status of ['suspended', 'closed', 'trial', 'active'] as const) {
      await setTenantStatus(base.tenantId, status);
      const real = await ctxFor(base.tenantId);
      expect(real.entitlements!.tenantStatus, 'the real snapshot must carry the status we set').toBe(status);
      for (const code of ['payroll', 'leave']) {
        expect(
          isModuleEnabled(adminCtx(base), code),
          `adminCtx and the resolver disagree about '${code}' for a '${status}' tenant`,
        ).toBe(isModuleEnabled(real, code));
      }
    }
    // …and the standing axis really flips a billable module, so the loop is not vacuous.
    await setTenantStatus(base.tenantId, 'suspended');
    expect(isModuleEnabled(adminCtx(base), 'payroll'), 'suspended ⇒ billable OFF through the mirror too').toBe(false);
    expect(isModuleEnabled(adminCtx(base), 'leave'), 'core is decided before the status check').toBe(true);
    await setTenantStatus(base.tenantId, 'active');
    expect(isModuleEnabled(adminCtx(base), 'payroll')).toBe(true);
  });

  it('a lapsed DEPENDENCY disables its dependents', async () => {
    await setModule(base.tenantId, 'toil', 'active');
    expect(isModuleEnabled(await ctxFor(base.tenantId), 'toil'), 'baseline: toil on').toBe(true);
    // toil dependsOn [leave (core), attendance]. Removing attendance must take toil down with it.
    await setModule(base.tenantId, 'attendance', null);
    const ctx = await ctxFor(base.tenantId);
    expect(isModuleEnabled(ctx, 'attendance')).toBe(false);
    expect(isModuleEnabled(ctx, 'toil'), 'toil must follow its dependency down').toBe(false);
  });

  it('a SUSPENDED tenant loses every billable module but keeps core', async () => {
    await owner.db.execute(sql`UPDATE tenant SET status = 'suspended' WHERE id = ${base.tenantId}`);
    const ctx = await ctxFor(base.tenantId);
    // Pin the mechanism, not just the answer: the snapshot must genuinely carry 'suspended', or the
    // assertion below would also pass for a snapshot that simply has no rows.
    expect(ctx.entitlements!.tenantStatus).toBe('suspended');
    expect(ctx.entitlements!.enabledModules, 'the rows are still there — status is what closes it').toContain('payroll');
    expect(isModuleEnabled(ctx, 'payroll')).toBe(false);
    // Core is true because step 2 returns BEFORE the status check — it needs no snapshot to be
    // decided. Stated here so the pass is the documented mechanism rather than a coincidence.
    expect(isModuleEnabled(ctx, 'leave'), 'core needs no row, so status cannot qualify it').toBe(true);
  });

  it('a CLOSED tenant keeps every core module, INCLUDING its write surfaces — slice 9 flips this', async () => {
    // ROUND 2 was right that the justification previously written here ("payslip history must stay
    // readable") was wrong on the facts: payslips are under `payroll`, which is billable and does close.
    // The six core codes are the employee spine and they are WRITE surfaces — hire, terminate,
    // restructure the org, apply for and approve leave. So the honest statement of today's behaviour is:
    //
    //   THIS PRIMITIVE CANNOT RESTRICT A SUSPENDED OR CLOSED TENANT AT ALL.
    //
    // That is deliberate — a boolean "may I?" cannot express "read yes, write no", and answering false
    // would lock a suspended customer out of their own employee records rather than out of what they
    // stopped paying for. The whole suspension story therefore rests on slice 9's SET TRANSACTION READ
    // ONLY overlay. This test exists so slice 9 has a fixture to FLIP rather than a surprise to find.
    await owner.db.execute(sql`UPDATE tenant SET status = 'closed' WHERE id = ${base.tenantId}`);
    const ctx = await ctxFor(base.tenantId);
    expect(ctx.entitlements!.tenantStatus).toBe('closed');
    for (const core of ['employees', 'org', 'leave', 'ess', 'approvals', 'knowledge_base']) {
      expect(isModuleEnabled(ctx, core), `${core} stays open on a CLOSED tenant until slice 9`).toBe(true);
    }
    // …and the billable half really is shut, so the assertion above is a decision and not a no-op.
    expect(isModuleEnabled(ctx, 'payroll')).toBe(false);
  });

  it('a CLOSED tenant is closed too, and so is a status this code has never heard of', async () => {
    // The check is an ALLOW-list (TENANT_STATUS_GOOD_STANDING), so a status added to 0313's CHECK by
    // a later migration fails CLOSED here instead of quietly resolving open. 'closed' is the case that
    // exists today; the unresolved sentinel below is the case that has no row at all.
    await owner.db.execute(sql`UPDATE tenant SET status = 'closed' WHERE id = ${base.tenantId}`);
    expect(isModuleEnabled(await ctxFor(base.tenantId), 'payroll')).toBe(false);
    await owner.db.execute(sql`UPDATE tenant SET status = 'trial' WHERE id = ${base.tenantId}`);
    expect(isModuleEnabled(await ctxFor(base.tenantId), 'payroll'), 'a trial account is in good standing').toBe(true);
  });

  it('a tenant row that cannot be READ resolves UNRESOLVED, not active — the old fail-open branch', async () => {
    // Round 1's second finding: `tenantStatus: row?.tenant_status ?? 'active'` turned "I could not see
    // the tenant row" into "the tenant is in good standing" — and with the RLS defect live that was the
    // branch every production session took, so a SUSPENDED tenant read as active. Asserted against a
    // tenant id that resolves to no row at all, which is the same shape an invisible row produces.
    const ghost = '00000000-0000-0000-0000-0000000000ff';
    const snap = await owner.db.transaction((tx) => resolveEntitlementsTx(tx, ghost));
    expect(snap.tenantStatus).toBe(TENANT_STATUS_UNRESOLVED);
    expect(snap.tenantStatus).not.toBe('active');
    const ctx: EntitledContext = { tenantId: ghost, roles: ['hr_admin'], entitlements: snap };
    expect(isModuleEnabled(ctx, 'payroll'), 'an unresolvable tenant must not be entitled').toBe(false);
  });

  it('MODULE_KILL forces OFF and can never force ON', async () => {
    process.env.MODULE_KILL = 'payroll';
    expect(isModuleEnabled(await ctxFor(base.tenantId), 'payroll'), 'kill beats an active row').toBe(false);
    // The asymmetry: naming a module the tenant does NOT have must not grant it.
    process.env.MODULE_KILL = 'toil';
    expect(isModuleEnabled(await ctxFor(base.tenantId), 'toil')).toBe(false);
    delete process.env.MODULE_KILL;
  });

  it('MODULE_KILL binds CORE modules too — the incident lever has no exceptions', async () => {
    // Round 1 asked whether killing a core module was intended, since packs/catalog.ts says core is
    // "never disableable". It IS intended, and the two statements are about different things: the
    // catalog means no customer purchase and no tenant_module row can turn Leave off (the 0313 trigger
    // enforces that). MODULE_KILL is the 3am lever, and one that could not stop Leave would be useless
    // for exactly the modules most likely to need stopping. Pinned so it is a decision, not a drift.
    const ctx = await ctxFor(base.tenantId);
    expect(isModuleEnabled(ctx, 'leave'), 'baseline: core is on').toBe(true);
    process.env.MODULE_KILL = 'leave';
    expect(isModuleEnabled(ctx, 'leave')).toBe(false);
    // …and it takes the dependents down with it: toil dependsOn ['leave', 'attendance'].
    await setModule(base.tenantId, 'toil', 'active');
    expect(isModuleEnabled(await ctxFor(base.tenantId), 'toil')).toBe(false);
    delete process.env.MODULE_KILL;
  });

  it('MODULE_KILL is TRANSITIVE through core — killing the spine stops what reads it', async () => {
    // ROUND 3's finding, and the counter-example to the test above's title. The CORE branch returned
    // `true` BEFORE the dependsOn closure ran, so `MODULE_KILL=employees` killed `employees` and left
    // `leave` and `ess` — which both declare `dependsOn: ['employees']` — fully on, write surfaces
    // included. The lever that exists for "stop this NOW at 3am" therefore did NOT stop the two modules
    // that read the employee spine hardest, precisely when the incident is on the spine.
    const ctx = await ctxFor(base.tenantId);
    expect(isModuleEnabled(ctx, 'leave'), 'baseline: core is on').toBe(true);
    expect(isModuleEnabled(ctx, 'ess')).toBe(true);
    process.env.MODULE_KILL = 'employees';
    expect(isModuleEnabled(ctx, 'employees'), 'the named module itself').toBe(false);
    expect(isModuleEnabled(ctx, 'leave'), 'leave dependsOn employees').toBe(false);
    expect(isModuleEnabled(ctx, 'ess'), 'ess dependsOn employees').toBe(false);
    expect(isModuleEnabled(ctx, 'payroll'), 'the billable dependents follow it too').toBe(false);
    // …and a core module with NO dependency on the killed one is untouched, so this is a closure walk
    // and not "kill one core module, lose them all".
    expect(isModuleEnabled(ctx, 'approvals'), 'approvals dependsOn nothing').toBe(true);
    expect(isModuleEnabled(ctx, 'knowledge_base')).toBe(true);
    delete process.env.MODULE_KILL;
  });

  it('a core module still answers on a SNAPSHOT-LESS context after the closure walk', () => {
    // The core branch now walks dependsOn, which is only safe while a core module's dependencies are
    // themselves core — otherwise deciding `leave` would need the snapshot and the "core answers
    // without one" contract would break silently. test/module-catalog-drift.test.ts refuses a core
    // module that depends on a non-core one; this is the same guarantee asserted from the other side.
    const bare: EntitledContext = { tenantId: base.tenantId };
    expect(isModuleEnabled(bare, 'leave')).toBe(true);
    expect(isModuleEnabled(bare, 'ess')).toBe(true);
    expect(isModuleEnabled(bare, 'employees')).toBe(true);
  });

  it('MODULE_KILL is case- and whitespace-insensitive, and a typo ANNOUNCES that it did nothing', async () => {
    // ROUND 2's finding: the lever was the one fail-OPEN branch in the file. `MODULE_KILL=Payroll`,
    // `payroll;toil`, `*` and `ALL` all left the module ON, silently, with no warning anywhere — the
    // worst failure mode available to a switch whose entire justification is "stop this NOW at 3am".
    const ctx = await ctxFor(base.tenantId);
    for (const spelling of ['payroll', 'PAYROLL', 'Payroll', '  payroll  ', 'toil, payroll', 'payroll,']) {
      process.env.MODULE_KILL = spelling;
      expect(isModuleEnabled(ctx, 'payroll'), `MODULE_KILL=${JSON.stringify(spelling)} must kill payroll`).toBe(
        false,
      );
    }
    // An unrecognised entry still kills nothing — a wildcard is NOT silently invented — but it must be
    // impossible to miss, so it is logged. Deliberately a log and not a throw: this parses lazily on the
    // first entitlement question, and throwing would turn a typo in the incident lever into an outage.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      process.env.MODULE_KILL = '*';
      expect(isModuleEnabled(ctx, 'payroll'), 'a wildcard is not supported').toBe(true);
      expect(spy.mock.calls[0]?.[0], 'an unrecognised entry must be reported').toContain('MODULE_KILL');
      spy.mockClear();
      process.env.MODULE_KILL = 'payrol';
      expect(isModuleEnabled(ctx, 'payroll'), 'a misspelled code kills nothing').toBe(true);
      expect(spy.mock.calls[0]?.[0]).toContain('payrol');
      // …and it warns ONCE per distinct value, not once per call, or an outage log is unreadable.
      spy.mockClear();
      isModuleEnabled(ctx, 'payroll');
      isModuleEnabled(ctx, 'toil');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      delete process.env.MODULE_KILL;
    }
  });

  // ── company scoping ───────────────────────────────────────────────────────────────────────────

  it('a COMPANY-SCOPED grant answers true for that company and false for the tenant at large', async () => {
    await setModule(base.tenantId, 'payroll', null); // drop the tenant-wide row
    await setModule(base.tenantId, 'payroll', 'active', base.companyId);
    const ctx = await ctxFor(base.tenantId);

    expect(isModuleEnabled(ctx, 'payroll', base.companyId), 'the scoped company has it').toBe(true);
    // Asking without a company when only a scoped grant exists must be FALSE: the honest answer to
    // "may this tenant use payroll?" when they bought it for one entity is "for which company?".
    expect(isModuleEnabled(ctx, 'payroll'), 'unscoped ask must not inherit a scoped grant').toBe(false);

    const [other] = await owner.db
      .insert(schema.company)
      .values({ tenantId: base.tenantId, legalName: 'Sibling Sdn Bhd' })
      .returning({ id: schema.company.id });
    expect(isModuleEnabled(ctx, 'payroll', other.id), 'a sibling company must NOT inherit it').toBe(false);
  });

  it('a tenant-wide grant answers true for any company', async () => {
    const ctx = await ctxFor(base.tenantId);
    expect(isModuleEnabled(ctx, 'payroll', base.companyId)).toBe(true);
  });

  it('a company-scoped DEPENDENCY closes a tenant-wide module for an UNSCOPED ask', async () => {
    // ROUND 2 found this branch untested and called it the surprising one, correctly: `toil` is granted
    // TENANT-WIDE, yet resolves FALSE because its dependency `attendance` is scoped to one company and
    // the caller has no companyId in hand — which is exactly the shape of every slice-3 gate site
    // (core/toil.ts:404, core/payroll.ts:666, core/attendance-allowance.ts:513).
    //
    // KEPT DELIBERATELY. It is step 6's rule applied one level down, and the alternative on offer —
    // "a dependency scoped to ANY company satisfies the closure" — is the only fail-OPEN branch that
    // was proposed anywhere in this file: it would let an Attendance purchase for one subsidiary
    // silently entitle the entire group to TOIL. Nothing writes a company-scoped row today
    // (db/provision.ts always emits company_id NULL), so this is unreachable through any supported
    // flow; it is pinned so that when slice 7 gives operators a way to scope a module, the group-wide
    // consequence is a documented answer rather than a discovery.
    await setModule(base.tenantId, 'toil', 'active'); // tenant-wide
    await setModule(base.tenantId, 'attendance', null); // drop the tenant-wide attendance row
    await setModule(base.tenantId, 'attendance', 'active', base.companyId); // scope it to one company
    const ctx = await ctxFor(base.tenantId);

    expect(ctx.entitlements!.enabledModules, 'toil really is tenant-wide').toContain('toil');
    expect(ctx.entitlements!.scopedModules.attendance, 'attendance really is scoped').toEqual([base.companyId]);
    expect(isModuleEnabled(ctx, 'toil'), 'unscoped ask: the dependency is not satisfied group-wide').toBe(false);
    expect(isModuleEnabled(ctx, 'toil', base.companyId), 'the scoped company has both').toBe(true);
  });

  // ── the no-snapshot contract ───────────────────────────────────────────────────────────────────

  it('a context with NO snapshot THROWS — never silently open, never silently closed', () => {
    const bare: EntitledContext = { tenantId: base.tenantId };
    expect(() => isModuleEnabled(bare, 'payroll')).toThrow(EntitlementsUnresolvedError);
    expect(() => getSetting(bare, 'payroll.reset_enabled')).toThrow(EntitlementsUnresolvedError);
  });

  it('a CORE code answers on a snapshot-less context instead of throwing — stated, not incidental', () => {
    // Round 1 flagged this as an unpinned hole in the "never silently open" contract. It is deliberate:
    // a core module takes no rows by construction, so there is nothing in a snapshot that could change
    // the answer, and throwing would mean a wiring bug locks a user out of Leave and ESS rather than
    // out of the billable features. Pinned so the asymmetry with 'payroll' above is a decision.
    const bare: EntitledContext = { tenantId: base.tenantId };
    expect(isModuleEnabled(bare, 'leave')).toBe(true);
    expect(isModuleEnabled(bare, 'ess')).toBe(true);
    expect(() => isModuleEnabled(bare, 'payroll')).toThrow(EntitlementsUnresolvedError);
  });

  it('an EXEMPT context answers CORE modules open, and THROWS for a billable one', () => {
    const exempt: EntitledContext = { tenantId: base.tenantId, entitlementsExempt: 'provisioning' };

    // Core is answered from the registry with no snapshot — provisioning must be able to create a
    // tenant, and that is the whole job the marker exists to do.
    expect(isModuleEnabled(exempt, 'leave')).toBe(true);
    expect(isModuleEnabled(exempt, 'ess')).toBe(true);

    // AMENDED IN SLICE 3. This used to assert `isModuleEnabled(exempt, 'payroll') === true`, which meant
    // any marked caller silently received every PAID module for every tenant. scripts/review-sweep.ts
    // reached this branch and dispatched notifications to tenants that had not bought them; nothing
    // failed, because the failure mode is a customer being GIVEN something.
    //
    // Note the consistency argument, which is why this is a correction and not a new policy: the BARE
    // context two tests up ALREADY throws for 'payroll' and answers core true. "No entitlement data +
    // billable module" was always an error; the marker was the one path that answered "yes" instead.
    expect(() => isModuleEnabled(exempt, 'payroll')).toThrow(EntitlementsExemptForBillableError);

    // The message must name the offending module AND the marker, or the stack trace sends the reader
    // hunting through every exempt call site to find which one asked.
    try {
      isModuleEnabled(exempt, 'payroll');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain('payroll');
      expect((e as Error).message).toContain('provisioning');
    }

    // The kill lever still binds and still WINS over the throw — `killed()` is step 1, before any
    // snapshot question is asked. An incident lever that raised instead of forcing OFF would be useless
    // in the incident it exists for.
    process.env.MODULE_KILL = 'payroll';
    expect(isModuleEnabled(exempt, 'payroll')).toBe(false);
    delete process.env.MODULE_KILL;
  });

  it('an EXEMPT context reads the CATALOG DEFAULT for a setting, not the tenant\'s value', async () => {
    // ROUND 3: the exempt branch of getSetting had NO test at all, and it is the branch that decides
    // what the seven nightly crons read once slice 3 retires the five setting env flags. A reader of the
    // header would most plausibly assume "exempt = unrestricted = the tenant's value"; it is not, and it
    // cannot be — a marker means no snapshot exists, and the only answer available then is the default.
    // Written down here so slice 3 cannot discover it in production: a sweep that ends up behind a
    // setting must resolve a REAL snapshot and drop its marker (see ENTITLEMENTS_EXEMPT_REASONS).
    await setSetting(base.tenantId, 'payroll.individual_txn_pay_enabled', true);
    const resolved = await ctxFor(base.tenantId);
    expect(getSetting(resolved, 'payroll.individual_txn_pay_enabled'), 'the tenant really did set it').toBe(true);

    const exempt: EntitledContext = { tenantId: base.tenantId, entitlementsExempt: 'sweeps' };
    expect(getSetting(exempt, 'payroll.individual_txn_pay_enabled'), 'exempt reads the default').toBe(false);
  });

  it('a context that is BOTH exempt and entitled is refused — the marker is a fallback, not an override', async () => {
    // ROUND 3's finding. `snapshotOf` returned null on the marker BEFORE looking at ctx.entitlements, so
    // a real, correct snapshot attached alongside a marker was DISCARDED: every module answered true
    // (on a suspended tenant, for modules never purchased) and every setting fell back to the catalog
    // default, contradicting the snapshot in hand. That made the marker a blanket override rather than
    // the fallback its own documentation describes — and it is the shape slice 9 walks into the moment
    // a sweep starts resolving snapshots, since the natural change is "attach the snapshot" and the
    // marker would silently win. Refusing the combination means the migration cannot be half-done.
    const resolved = await ctxFor(base.tenantId);
    const both = {
      tenantId: base.tenantId,
      entitlements: resolved.entitlements,
      entitlementsExempt: 'sweeps',
    } as EntitledContext;
    expect(() => isModuleEnabled(both, 'payroll')).toThrow(EntitlementsContextMalformedError);
    expect(() => isModuleEnabled(both, 'payroll')).toThrow(/claims entitlementsExempt/);
    expect(() => getSetting(both, 'payroll.reset_enabled')).toThrow(EntitlementsContextMalformedError);
    // …and it is caught on core and unknown codes too, because it is a fault in the CONTEXT.
    expect(() => isModuleEnabled(both, 'leave')).toThrow(EntitlementsContextMalformedError);
    expect(() => isModuleEnabled(both, 'not_a_module')).toThrow(EntitlementsContextMalformedError);
    // The degraded-session field is the same contradiction and is refused the same way.
    const errAndExempt = {
      tenantId: base.tenantId,
      entitlementsError: 'boom',
      entitlementsExempt: 'sweeps',
    } as EntitledContext;
    expect(() => isModuleEnabled(errAndExempt, 'payroll')).toThrow(EntitlementsContextMalformedError);
  });

  it('an UNRECOGNISED exempt marker THROWS — the escape hatch is a membership test, not truthiness', () => {
    // Round 1's bypass: `if (ctx.entitlementsExempt) return null` opened EVERY module for ANY non-empty
    // string, so a typo (or an invented marker on a hand-built context) was a total bypass of the
    // primitive. The typed union alone could never be the gate — a context can be cast, hand-built, or
    // arrive across a serialisation boundary — so the check is at runtime. The `as unknown as` below
    // stands in for exactly those routes, and the @ts-expect-error asserts the compiler ALSO refuses
    // the plain literal: both layers, so neither is assumed.
    // @ts-expect-error — an invented exemption marker must not satisfy EntitledContext
    const typeRejected: EntitledContext = { tenantId: base.tenantId, entitlementsExempt: 'lol-not-in-the-list' };
    expect(typeRejected.tenantId).toBe(base.tenantId);
    const forged = { tenantId: base.tenantId, entitlementsExempt: 'lol-not-in-the-list' } as unknown as EntitledContext;
    expect(() => isModuleEnabled(forged, 'payroll')).toThrow(/Unrecognised entitlementsExempt marker/);
    expect(() => isModuleEnabled(forged, 'toil')).toThrow(/Unrecognised entitlementsExempt marker/);
    expect(() => getSetting(forged, 'payroll.reset_enabled')).toThrow(/Unrecognised entitlementsExempt marker/);
    // An empty string is a bug too, and must not fall through to "unresolved" and look like a wiring
    // problem somewhere else.
    const blank = { tenantId: base.tenantId, entitlementsExempt: '' } as unknown as EntitledContext;
    expect(() => isModuleEnabled(blank, 'payroll')).toThrow(/Unrecognised entitlementsExempt marker/);
    // ROUND 3: the TYPE matters as much as the message. This threw a bare `Error`, outside the
    // EntitlementError family the file's own contract promises — the same objection round 2 used to
    // reject a TypeError for a malformed snapshot ("a caller's catch (e instanceof EntitlementError)
    // does not recognise it"). A slice-3 gate catching EntitlementError to render "not on your plan" /
    // "temporarily unavailable" would have let this one escape as an unhandled 500.
    expect(() => isModuleEnabled(forged, 'payroll')).toThrow(EntitlementsContextMalformedError);
    expect(() => isModuleEnabled(forged, 'payroll')).toThrow(EntitlementError);
    expect(() => getSetting(forged, 'payroll.reset_enabled')).toThrow(EntitlementError);
  });

  it('a forged marker is caught for CORE and UNKNOWN codes too — the check is on the CONTEXT, not the code', () => {
    // ROUND 2's finding: the membership check lived in `snapshotOf`, which is only reached AFTER the
    // killed/CORE/CATALOG branches. So a context carrying a garbage marker answered cleanly for every
    // core module (`leave` → true) and for a typo (`not_a_module` → false), and only revealed itself
    // when someone happened to ask about a billable one. A mis-wired context could sit undetected on
    // core-only paths indefinitely. The marker describes the CONTEXT, so it is now validated at the
    // entry point before any code-specific branch can answer.
    const forged = { tenantId: base.tenantId, entitlementsExempt: 'i-made-this-up' } as unknown as EntitledContext;
    expect(() => isModuleEnabled(forged, 'leave')).toThrow(/Unrecognised entitlementsExempt marker/);
    expect(() => isModuleEnabled(forged, 'ess')).toThrow(/Unrecognised entitlementsExempt marker/);
    expect(() => isModuleEnabled(forged, 'not_a_module')).toThrow(/Unrecognised entitlementsExempt marker/);
    // …including when a kill switch would otherwise have answered false first.
    process.env.MODULE_KILL = 'leave';
    expect(() => isModuleEnabled(forged, 'leave')).toThrow(/Unrecognised entitlementsExempt marker/);
    delete process.env.MODULE_KILL;
    // Prototype keys must not satisfy a hasOwnProperty-based allow-list either.
    // 'harness' is in this list on purpose: it WAS a valid marker until slice 3 deleted the entry, and
    // a retired marker that stays in the vocabulary is a bootstrap exemption anyone can still forge.
    for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'PROVISIONING', 'harness']) {
      const proto = { tenantId: base.tenantId, entitlementsExempt: key } as unknown as EntitledContext;
      expect(() => isModuleEnabled(proto, 'leave'), `'${key}' must not be a valid marker`).toThrow(
        /Unrecognised entitlementsExempt marker/,
      );
    }
  });

  it('assertModuleEnabled on a SNAPSHOT-LESS context reports the wiring bug, not "not on your plan"', async () => {
    // ROUND 2's finding: `assertModuleEnabled` calls `isModuleEnabled` first, so on the degraded path it
    // throws EntitlementsUnresolvedError rather than ModuleNotEnabledError — and nothing covered it.
    // The behaviour is KEPT (telling a paying customer they were downgraded during an infrastructure
    // fault is worse than an unhandled error), but the two now share a supertype so one catch clause
    // covers the family. That is what this pins.
    const bare: EntitledContext = { tenantId: base.tenantId };
    expect(() => assertModuleEnabled(bare, 'payroll')).toThrow(EntitlementsUnresolvedError);
    expect(() => assertModuleEnabled(bare, 'payroll')).toThrow(EntitlementError);
    // …and the "you did not buy it" case is the SAME family with a different subtype, so a slice-3
    // caller can catch EntitlementError once and still tell the two apart.
    const ctx = await ctxFor(base.tenantId);
    expect(() => assertModuleEnabled(ctx, 'toil')).toThrow(ModuleNotEnabledError);
    expect(() => assertModuleEnabled(ctx, 'toil')).toThrow(EntitlementError);
    expect(new ModuleNotEnabledError('toil')).not.toBeInstanceOf(EntitlementsUnresolvedError);
  });

  it('a session whose resolution FAILED reports the CAUSE — not a nonexistent synthetic context', () => {
    // ROUND 2: withEntitlements swallows every failure so /login stays reachable, but the resulting
    // gate error was EntitlementsUnresolvedError, whose message says "a synthetic SessionContext must
    // be built with resolveEntitlements()". During a real outage that sends the on-call engineer after
    // a wiring bug that does not exist while the actual fault goes unnamed.
    const failed: EntitledContext = {
      tenantId: base.tenantId,
      entitlementsError: 'relation "tenant_module" does not exist',
    };
    expect(() => isModuleEnabled(failed, 'payroll')).toThrow(EntitlementsResolutionFailedError);
    expect(() => isModuleEnabled(failed, 'payroll')).toThrow(/relation "tenant_module" does not exist/);
    expect(() => isModuleEnabled(failed, 'payroll')).toThrow(new RegExp(base.tenantId));
    // It must NOT be mistaken for the wiring-bug error…
    try {
      isModuleEnabled(failed, 'payroll');
    } catch (e) {
      expect(e).not.toBeInstanceOf(EntitlementsUnresolvedError);
      expect(e).toBeInstanceOf(EntitlementError);
    }
    // …and core modules still answer, so the app stays navigable during the outage.
    expect(isModuleEnabled(failed, 'leave')).toBe(true);
  });

  it('a snapshot belonging to ANOTHER tenant is refused', async () => {
    // The one bypass shape session scope leaves structurally open: a snapshot is a detachable object,
    // and without an identity on it a context copied across tenants (slice 7's platform plane, a future
    // "act as tenant") answers another tenant's commercial questions with nothing to catch it.
    const other = await seedBase();
    await setModule(other.tenantId, 'toil', 'active');
    const theirs = await ctxFor(other.tenantId);
    expect(isModuleEnabled(theirs, 'toil'), 'baseline: they really do have it').toBe(true);

    const smuggled: EntitledContext = { tenantId: base.tenantId, entitlements: theirs.entitlements };
    expect(() => isModuleEnabled(smuggled, 'toil')).toThrow(EntitlementsTenantMismatchError);
    expect(() => getSetting(smuggled, 'payroll.reset_enabled')).toThrow(EntitlementsTenantMismatchError);
    // ROUND 3: the attribution check lived in `snapshotOf`, i.e. AFTER the killed/CORE/CATALOG branches
    // — the exact ordering defect round 2 hoisted the exempt marker out of. So a context copied across
    // tenants answered cleanly (`leave` → true, `not_a_module` → false) and could sit undetected on
    // core-only paths indefinitely. Whose snapshot this is describes the CONTEXT, not the code being
    // asked about, so it is now validated at the entry point like the marker.
    expect(() => isModuleEnabled(smuggled, 'leave')).toThrow(EntitlementsTenantMismatchError);
    expect(() => isModuleEnabled(smuggled, 'not_a_module')).toThrow(EntitlementsTenantMismatchError);
    process.env.MODULE_KILL = 'leave';
    expect(() => isModuleEnabled(smuggled, 'leave')).toThrow(EntitlementsTenantMismatchError);
    delete process.env.MODULE_KILL;
  });

  it('a MALFORMED snapshot fails closed with a typed error, not a TypeError', () => {
    // ROUND 2: the guard was a truthiness test, so a snapshot that crossed a serialisation boundary and
    // lost a field passed it and then crashed on `undefined.includes(...)`. A TypeError is not something
    // a caller's `catch (e instanceof EntitlementError)` recognises, so the fail-closed contract simply
    // did not apply to that shape.
    //
    // THE ERROR TYPE CHANGED IN ROUND 3, and the test asserts the new one deliberately rather than being
    // relaxed to fit. `EntitlementsUnresolvedError` says "nobody resolved entitlements for this
    // context", and its message tells the reader to go build the context with resolveEntitlements() —
    // wrong advice when the truth is "someone attached something that is not a snapshot". Both are
    // EntitlementError, which is what a caller catches; the subtype is what an engineer reads.
    //
    // THE LAST TWO SHAPES ARE ROUND 3's ACTUAL BYPASS, and they are why the container-level guard was
    // not enough. `scopedModules: {payroll: '…-2222-…'}` is a STRING, so the resolver's
    // `(snap.scopedModules[code] ?? []).includes(companyId)` ran String.includes and answered TRUE for
    // any company id the string CONTAINED — including a 4-character substring of one. That was the only
    // branch in the file that could answer true by coincidence, and it sat inside the guard written to
    // close exactly this threat model.
    const shapes = [
      {},
      { tenantId: base.tenantId },
      { tenantId: base.tenantId, tenantStatus: 'active' },
      { tenantId: base.tenantId, enabledModules: ['payroll'], scopedModules: {}, tenantStatus: 'active' },
      { tenantId: base.tenantId, enabledModules: 'payroll', scopedModules: {}, settings: {}, tenantStatus: 'active' },
      { tenantId: base.tenantId, enabledModules: [7], scopedModules: {}, settings: {}, tenantStatus: 'active' },
      {
        tenantId: base.tenantId,
        enabledModules: [],
        scopedModules: { payroll: `prefix-${base.companyId}-suffix` },
        settings: {},
        tenantStatus: 'active',
      },
      {
        tenantId: base.tenantId,
        enabledModules: [],
        scopedModules: { payroll: [{ id: base.companyId }] },
        settings: {},
        tenantStatus: 'active',
      },
    ];
    for (const entitlements of shapes) {
      const ctx = { tenantId: base.tenantId, entitlements } as unknown as EntitledContext;
      expect(() => isModuleEnabled(ctx, 'payroll'), JSON.stringify(entitlements)).toThrow(
        EntitlementsContextMalformedError,
      );
      expect(() => isModuleEnabled(ctx, 'payroll'), JSON.stringify(entitlements)).toThrow(EntitlementError);
      // The company-scoped ask is the one that used to answer TRUE, so it is asserted explicitly.
      expect(() => isModuleEnabled(ctx, 'payroll', base.companyId), JSON.stringify(entitlements)).toThrow(
        EntitlementsContextMalformedError,
      );
      // …and a bare SUBSTRING of the company id must not answer either — String.includes matched it.
      expect(() => isModuleEnabled(ctx, 'payroll', base.companyId.slice(0, 4)), JSON.stringify(entitlements)).toThrow(
        EntitlementsContextMalformedError,
      );
      expect(() => getSetting(ctx, 'payroll.reset_enabled'), JSON.stringify(entitlements)).toThrow(
        EntitlementsContextMalformedError,
      );
    }
  });

  it('an exempt context is still FALSE for a module code that does not exist', () => {
    // The unknown-code check was ordered AFTER the exempt branch, so an exempt context answered TRUE
    // for a typo — inverting the documented "a typo disables rather than enables". Now step 3.
    const exempt: EntitledContext = { tenantId: base.tenantId, entitlementsExempt: 'provisioning' };
    expect(isModuleEnabled(exempt, 'not_a_module')).toBe(false);
  });

  it('the exemption list is PINNED — a sixth exemption must be a reviewed diff', () => {
    // The file's header used to claim a drift test pinned this list. It did not exist, so the
    // "reviewable rather than ambient" property the design rests on was documentation only. Each key
    // must also carry a reason: an exemption without a stated justification is the thing this prevents.
    // `harness` was DELETED in slice 3: adminCtx was its only consumer and now carries a real
    // snapshot. Removing the key (rather than leaving it as vocabulary with no owner) is what stops a
    // hand-built context forging `entitlementsExempt: 'harness'` and being treated as a bootstrap path.
    expect(Object.keys(ENTITLEMENTS_EXEMPT_REASONS).sort()).toEqual(
      ['platform', 'provisioning', 'seeding', 'sweeps'],
    );
    for (const [key, entry] of Object.entries(ENTITLEMENTS_EXEMPT_REASONS)) {
      expect(entry.why.length, `exemption '${key}' needs a real reason`).toBeGreaterThan(30);
    }
  });

  it('every exemption names FILES THAT CARRY THE MARKER — the list cannot describe code that does not exist', () => {
    // ROUND 2's finding, and the reason the constant grew an `owners` array. The version above passed
    // identically whether or not one line of code consumed a marker — and none did: `entitlementsExempt`
    // appeared nowhere outside the type, the resolver and this test, while every path the reasons named
    // built a snapshot-less context by hand. So slice 2's "no legitimate path throws today" was true
    // only because slice 2 installs no gates; the first gate slice 3 puts inside a nightly sweep would
    // have taken every cron down with EntitlementsUnresolvedError at 3am.
    //
    // This reads each named file off disk and requires the literal marker. It fails if a sweep loses
    // its marker, if a new exemption is declared without wiring, or if a file is renamed.
    //
    // COMMENTS ARE STRIPPED FIRST, and round 1 of the slice-3 review is why. Slice 3 removed the marker
    // from test/harness.ts's `adminCtx` and left a docblock headed "WHY THIS CARRIES A REAL SNAPSHOT AND
    // NOT `entitlementsExempt: 'harness'`" — which the raw-text version of this assertion matched. The
    // guard written to stop an exemption naming a call site that does not carry it was passing on prose
    // saying the call site does not carry it, and would have excused db/provision.ts or db/seed.ts
    // losing their markers the same way. Same `stripComments` shape as test/module-catalog-drift.ts,
    // which had already been hardened against exactly this in the sibling ratchet.
    const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    let wired = 0;
    for (const [key, entry] of Object.entries(ENTITLEMENTS_EXEMPT_REASONS)) {
      for (const owner_ of entry.owners) {
        const src = stripComments(readFileSync(new URL(`../${owner_}`, import.meta.url), 'utf8'));
        expect(src, `${owner_} is declared as an owner of exemption '${key}' but does not carry the marker`)
          .toContain(`entitlementsExempt: '${key}'`);
        wired += 1;
      }
    }
    // Not vacuous: if `owners` were emptied everywhere the loop above would assert nothing at all.
    //
    // Stated as "each bootstrap category keeps at least one wired owner" rather than a total count.
    // It was `>= 10`, pinned to the then-current tally, which made the ratchet fight the direction we
    // actually want: slice 3 REMOVED two exemptions (review-sweep and feedback-plan both resolve real
    // snapshots now) and a floor on the total turned that improvement into a failure. A count cannot
    // tell shrinking-because-fixed from gutting; naming the categories can, and it still fails loudly
    // if provisioning or the seeder ever quietly loses its marker.
    expect(wired, 'the loop must have asserted something').toBeGreaterThan(0);
    for (const key of ['provisioning', 'seeding', 'sweeps'] as const) {
      expect(
        ENTITLEMENTS_EXEMPT_REASONS[key].owners.length,
        `exemption '${key}' has no wired owner — bootstrap paths cannot resolve entitlements and must keep one`,
      ).toBeGreaterThan(0);
    }
    // `platform` is the ONE deliberately unwired entry (slice 7 builds that plane). Pinned so it cannot
    // become a second unwired exemption by accident, and so slice 7 has to change this line on purpose.
    expect(ENTITLEMENTS_EXEMPT_REASONS.platform.owners, 'slice 7 wires the platform plane').toEqual([]);
  });

  it('all web and mobile identity paths go through withEntitlements — the "one seam" claim, ratcheted', () => {
    // ROUND 3: every snapshot assertion in this file goes through the exported `withEntitlements`, which
    // the test calls directly. `resolveSession` — the function that actually wires it into the dev/demo
    // switcher branch AND the WorkOS branch — had no coverage at all, and neither did `cache()`. Delete
    // `withEntitlements(...)` from the WorkOS line (the production path, the one whose absence the
    // header says would be "silently absent on the deployment we actually ship") and the entire suite
    // stays green while every session in production carries no snapshot.
    //
    // A source-level ratchet rather than a behavioural test, deliberately: `resolveSession` reads
    // `next/headers` cookies and lazily imports the WorkOS SDK, so exercising it would mean faking a
    // request scope — and the property at stake is structural ("no path returns unwrapped"), which is
    // exactly what a source assertion states. Same instrument as the exemption-owners test above.
    // Comments stripped first: a docblock quoting `withEntitlements(await resolveWorkosPrincipal(` would
    // otherwise count as a wrapped call and turn this ratchet green on prose.
    const src = readFileSync(new URL('../lib/session.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*$/gm, '$1');
    const start = src.indexOf('async function resolveSession(');
    expect(start, 'resolveSession was renamed — this ratchet must be renamed with it').toBeGreaterThan(-1);
    const body = src.slice(start);

    // Every call to a principal resolver inside resolveSession must be an argument to withEntitlements.
    const wrapped = [...body.matchAll(/(\w+)\(\s*await\s+(resolve(?:Dev|Workos)Principal)\(/g)];
    const all = [...body.matchAll(/resolve(?:Dev|Workos)Principal\(/g)];
    // FIVE since deployment-owned identity: dev/demo, WorkOS web/mobile, and Keycloak web/mobile.
    // The provider-neutral principal shaping helper retains its historical WorkOS name; all four
    // verified provider paths must still attach the same authoritative tenant entitlement snapshot.
    expect(all.length, 'dev/demo and both web/mobile paths for each provider must be covered').toBe(5);
    expect(wrapped.length, 'a principal is resolved somewhere that is not wrapped at all').toBe(5);
    for (const [, wrapper, resolver] of wrapped) {
      expect(wrapper, `${resolver} must be wrapped in withEntitlements, not ${wrapper}`).toBe('withEntitlements');
    }
    // …and the memoisation the "session-scoped means request-CONSISTENT" argument rests on.
    expect(src, 'getSession must stay memoised per request').toContain('export const getSession = cache(resolveSession)');
  });

  it('the harness can build a context that makes a gate CLOSE — enforcement is testable at all', async () => {
    // ROUND 3 wrote this when `adminCtx` was entitlementsExempt: 'harness' and therefore answered TRUE
    // for every catalogued module — which meant the 247 files that test a feature BEHIND a gate
    // structurally could not show that gate REFUSING, and an enforcement primitive shipping with 4,800
    // green tests and no coverage of enforcement has not been tested.
    //
    // Slice 3 removed that marker: `adminCtx` now carries a SYNTHETIC snapshot derived from
    // `legacyEnabledModulesIn(process.env)`, so a gate can close through it too. `entitledCtx` remains
    // the stricter half — it resolves the tenant's REAL rows rather than a mirror of the writes a test
    // made — and slice 3's acceptance criterion is unchanged: every gate it installs has at least one
    // test driven through a resolved snapshot.
    const gateable = await entitledCtx(base);
    expect(gateable.entitlementsExempt, 'it must NOT be exempt, or it proves nothing').toBeUndefined();
    expect(gateable.entitlements, 'and it must carry a real, resolved snapshot').toBeDefined();
    expect(isModuleEnabled(gateable, 'payroll'), 'a purchased module is open').toBe(true);
    expect(isModuleEnabled(gateable, 'toil'), 'an unpurchased one CLOSES — this is the point').toBe(false);
    expect(() => assertModuleEnabled(gateable, 'toil')).toThrow(ModuleNotEnabledError);
    // …and a fixture setting is actually read, which through adminCtx it would not be.
    await setSetting(base.tenantId, 'payroll.individual_txn_pay_enabled', true);
    const after = await entitledCtx(base);
    expect(getSetting(after, 'payroll.individual_txn_pay_enabled')).toBe(true);
  });

  it('assertModuleEnabled throws a typed, named error carrying the module code', async () => {
    const ctx = await ctxFor(base.tenantId);
    expect(() => assertModuleEnabled(ctx, 'toil')).toThrow(ModuleNotEnabledError);
    try {
      assertModuleEnabled(ctx, 'toil');
    } catch (e) {
      expect((e as ModuleNotEnabledError).name).toBe('ModuleNotEnabledError');
      expect((e as ModuleNotEnabledError).moduleCode).toBe('toil');
    }
    expect(() => assertModuleEnabled(ctx, 'payroll')).not.toThrow();
  });

  it('the snapshot query\'s tenant predicate excludes another tenant\'s rows', async () => {
    // RENAMED from "a tenant never sees another tenant's entitlements". This runs as the OWNER, which
    // bypasses RLS entirely, so the only thing separating the two tenants here is the `tenant_id`
    // parameter in the query — that is what this asserts, and calling it tenant isolation was
    // misleading (round 1). The RLS boundary is asserted in the app-role block below, where it applies.
    const other = await seedBase();
    await setModule(other.tenantId, 'toil', 'active');
    const ctx = await ctxFor(base.tenantId);
    expect(isModuleEnabled(ctx, 'toil'), 'the other tenant\'s grant must not leak').toBe(false);
  });
});

/**
 * THE PRODUCTION PATH — resolved through `withEntitlements` on the RLS-governed `ai_hr_app` pool.
 *
 * This block is the regression fence for round 1's critical finding. The first version of the slice
 * read the snapshot on a bare pool connection, so `app.tenant_id` was never set, so
 * `app.current_tenant_id()` was NULL, so `USING (tenant_id = app.current_tenant_id())` matched nothing
 * and every real session resolved to `{[], {}, {}, 'active'}` — no modules, no settings, and a
 * suspended tenant reading as healthy. Every one of the owner-role tests above stayed green throughout,
 * because the owner bypasses the policies that were doing the blocking.
 *
 * These tests fail against that version and pass against this one.
 */
describe('slice 2 — the session path, under RLS as ai_hr_app', () => {
  let base: Base;

  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    delete process.env.MODULE_KILL;
  });

  it('resolves a NON-EMPTY snapshot — modules, settings and status all come back', async () => {
    await setSetting(base.tenantId, 'payroll.reset_enabled', true);
    const ctx = await sessionCtxFor(base.tenantId);

    expect(ctx.entitlements, 'getSession must attach a snapshot').toBeDefined();
    // The assertions that fail without the tenant-scoped transaction: each of the three subselects.
    expect(ctx.entitlements!.enabledModules).toContain('payroll');
    expect(ctx.entitlements!.settings['payroll.reset_enabled']).toBe(true);
    expect(ctx.entitlements!.tenantStatus, 'the tenant row must be READABLE, not defaulted').toBe('active');

    expect(isModuleEnabled(ctx, 'payroll')).toBe(true);
    expect(getSetting(ctx, 'payroll.reset_enabled')).toBe(true);
    // …and it is not vacuously true: a module with no row is still off on this path.
    expect(isModuleEnabled(ctx, 'toil')).toBe(false);
  });

  it('a SUSPENDED tenant reads as suspended, not as active', async () => {
    // The specific consequence of the old `?? 'active'` default combined with the RLS defect: the
    // tenant row was invisible, so 'suspended' and 'active' were indistinguishable on the real path.
    await owner.db.execute(sql`UPDATE tenant SET status = 'suspended' WHERE id = ${base.tenantId}`);
    const ctx = await sessionCtxFor(base.tenantId);
    expect(ctx.entitlements!.tenantStatus).toBe('suspended');
    expect(isModuleEnabled(ctx, 'payroll')).toBe(false);
    expect(isModuleEnabled(ctx, 'leave'), 'core still answers').toBe(true);
  });

  it('a session resolves its OWN tenant\'s rows under RLS — the GUC is set before the SELECT', async () => {
    // RENAMED IN ROUND 3, because the old title ("RLS is the boundary") claimed something this cannot
    // fail on. Both the GUC and the query predicate carry the SAME tenant id, so
    // `USING (tenant_id = app.current_tenant_id())` never excludes a row the predicate would have
    // included: regress the policy to `USING (true)` and both assertions below still pass, because
    // `tm.tenant_id = $1` does all the filtering. What this genuinely fences is round 1's defect — no
    // transaction ⇒ no GUC ⇒ the policy blocks everything ⇒ an empty snapshot — which is real and
    // valuable, and is what the name now says. The isolation direction is the test below.
    const other = await seedBase();
    await setModule(other.tenantId, 'toil', 'active');
    await setModule(base.tenantId, 'toil', null);

    const mine = await sessionCtxFor(base.tenantId);
    const theirs = await sessionCtxFor(other.tenantId);
    expect(isModuleEnabled(mine, 'toil'), 'the other tenant\'s grant must not leak').toBe(false);
    expect(isModuleEnabled(theirs, 'toil'), 'and the owning tenant really does have it').toBe(true);
  });

  it('RLS refuses a cross-tenant read: scoped to A, asking for B resolves EMPTY', async () => {
    // THE ONLY ASSERTION IN THIS FILE THAT AN RLS REGRESSION CAN FAIL (round 3). It runs the case the
    // policy alone can refuse and the predicate cannot: a transaction whose `app.tenant_id` GUC is
    // tenant A, running the snapshot query for tenant B's id as `ai_hr_app`. The predicate happily
    // selects B's rows; `tenant_module_read` / `tenant_setting_read` / `tenant_isolation` are what
    // return nothing. Widen any of them to `USING (true)` and this test goes red while every other test
    // in the file stays green.
    //
    // It also pins the failure mode of MISUSING the exported resolver: `resolveEntitlementsTx` is
    // documented as "the only way to resolve a snapshot for a tenant OTHER than the session's", so
    // calling it under the wrong tenant scope is a reachable mistake. It fails CLOSED —
    // TENANT_STATUS_UNRESOLVED, no modules — rather than returning the other tenant's commercial state.
    const other = await seedBase();
    await setModule(other.tenantId, 'toil', 'active');

    const reserved = await appClient.reserve();
    try {
      await reserved.unsafe('begin');
      try {
        // Scope the transaction to OUR tenant…
        await reserved.unsafe(`select set_config('app.tenant_id', $1, true)`, [base.tenantId] as never[]);
        // …then ask for THEIRS. Only the policies stand between the two.
        const snap = await resolveEntitlementsRaw(
          (q, params) => reserved.unsafe(q, params as never[]),
          other.tenantId,
        );
        expect(snap.enabledModules, 'another tenant\'s modules must not be readable').toEqual([]);
        expect(snap.scopedModules).toEqual({});
        expect(snap.settings).toEqual({});
        expect(snap.tenantStatus, 'their tenant row must be invisible too').toBe(TENANT_STATUS_UNRESOLVED);
        // Not vacuous: the SAME statement on the SAME connection returns real rows for the scoped tenant.
        const ours = await resolveEntitlementsRaw(
          (q, params) => reserved.unsafe(q, params as never[]),
          base.tenantId,
        );
        expect(ours.enabledModules, 'the read itself works — it is the tenant that is refused').toContain('payroll');
        expect(ours.tenantStatus).toBe('active');
      } finally {
        await reserved.unsafe('rollback');
      }
    } finally {
      await reserved.release();
    }
  });

  it('the tenant GUC does NOT leak onto the connection that ran the transaction', async () => {
    // `set_config(…, true)` is SET LOCAL, discarded at COMMIT. If it were session-level it would ride
    // the pooled connection into the next checkout and make a later query read as some other tenant —
    // strictly worse than the bug it fixes.
    //
    // ASSERTED ON THE EXACT CONNECTION THAT RAN IT (round 2). The previous version resolved through the
    // pool and then probed it five times, on the theory that "one sample could miss the connection that
    // ran the transaction". Five cannot fix that in general — it worked only because this file uses the
    // app pool strictly sequentially, so postgres.js kept handing back the same backend. Round 2 warmed
    // eight connections first and reproduced a genuinely leaking `set_config(…, false)` that the
    // five-probe loop declared clean. `reserve()` pins one connection, so the probe cannot miss.
    const reserved = await appClient.reserve();
    try {
      const [before] = await reserved<{ pid: number }[]>`select pg_backend_pid() as pid`;
      // BEGIN/COMMIT issued explicitly rather than via `.begin()`: a reserved postgres.js handle has no
      // `.begin` (3.4.9). Same thing on the wire, and it keeps the resolver under test the exact
      // function production calls.
      await reserved.unsafe('begin');
      let snap;
      try {
        snap = await resolveEntitlementsInTenantTx(
          (q, params) => reserved.unsafe(q, params as never[]),
          base.tenantId,
        );
        await reserved.unsafe('commit');
      } catch (e) {
        await reserved.unsafe('rollback');
        throw e;
      }
      // The read really happened under the GUC — otherwise "no leak" would be trivially true.
      expect(snap.enabledModules, 'the snapshot must be real, or the leak check proves nothing').toContain(
        'payroll',
      );
      const [row] = await reserved<
        { tid: string | null; pid: number }[]
      >`select app.current_tenant_id()::text as tid, pg_backend_pid() as pid`;
      expect(row.pid, 'the probe must run on the SAME backend the transaction used').toBe(before.pid);
      expect(row.tid, 'the connection must carry no tenant scope between transactions').toBeNull();
    } finally {
      await reserved.release();
    }
  });
});

describe('slice 2 — getSetting', () => {
  let base: Base;

  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    delete process.env.MODULE_KILL;
    delete process.env.SETTING_KILL;
  });
  afterAll(() => {
    delete process.env.MODULE_KILL;
    delete process.env.SETTING_KILL;
  });

  it('SETTING_KILL forces the catalog default, and MODULE_KILL reaches its module\'s settings', async () => {
    // ROUND 3: MODULE_KILL was sold as "the ONE thing that stays in the environment" and "the 3am
    // lever", and getSetting never consulted it. But FIVE of the nine env flags slice 3 retires are
    // SETTINGS (LEGACY_SETTING_ENV_GATES) — payroll reset, payroll unlock, individual-transaction pay,
    // the audit hash chain and AI planning. After the flip those would have been per-tenant database
    // rows with no platform-wide off switch at all, and `audit.hash_chain_enabled` has moduleCode null
    // so no module kill could ever have reached it even indirectly. Reopening a finalised payroll run
    // and the tamper-evidence itself are the two this protects.
    await setSetting(base.tenantId, 'payroll.reset_enabled', true);
    await setSetting(base.tenantId, 'audit.hash_chain_enabled', true);
    const ctx = await ctxFor(base.tenantId);
    expect(getSetting(ctx, 'payroll.reset_enabled'), 'baseline: the tenant has it on').toBe(true);
    expect(getSetting(ctx, 'audit.hash_chain_enabled')).toBe(true);

    // Named directly — including the module-less key, which is the one nothing else could reach.
    process.env.SETTING_KILL = 'audit.hash_chain_enabled';
    expect(getSetting(ctx, 'audit.hash_chain_enabled')).toBe(false);
    expect(getSetting(ctx, 'payroll.reset_enabled'), 'and it kills only what it names').toBe(true);

    // Case- and whitespace-insensitive, same as MODULE_KILL (one parser, so a fix cannot reach one lever
    // and not the other).
    process.env.SETTING_KILL = '  PAYROLL.RESET_ENABLED , audit.hash_chain_enabled ';
    expect(getSetting(ctx, 'payroll.reset_enabled')).toBe(false);
    expect(getSetting(ctx, 'audit.hash_chain_enabled')).toBe(false);
    delete process.env.SETTING_KILL;

    // Transitive from the module axis: a setting is a behaviour OF a module, so stopping the module
    // must not leave its behaviours armed.
    process.env.MODULE_KILL = 'payroll';
    expect(getSetting(ctx, 'payroll.reset_enabled'), 'payroll.* follows its module down').toBe(false);
    expect(getSetting(ctx, 'audit.hash_chain_enabled'), 'a module-less setting does NOT').toBe(true);
    delete process.env.MODULE_KILL;
    expect(getSetting(ctx, 'payroll.reset_enabled'), 'and it comes back when the lever is released').toBe(true);
  });

  it('an unrecognised SETTING_KILL entry kills nothing and ANNOUNCES it', async () => {
    // Same failure mode round 2 fixed on MODULE_KILL: for a lever whose justification is "stop this NOW",
    // "did nothing, said nothing" is the worst available outcome. A log rather than a throw, for the
    // same reason — this parses lazily on the first setting read of a process.
    await setSetting(base.tenantId, 'payroll.reset_enabled', true);
    const ctx = await ctxFor(base.tenantId);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      process.env.SETTING_KILL = 'payroll.reset_enabld';
      expect(getSetting(ctx, 'payroll.reset_enabled'), 'a misspelled key kills nothing').toBe(true);
      expect(spy.mock.calls[0]?.[0]).toContain('SETTING_KILL');
      expect(spy.mock.calls[0]?.[0]).toContain('payroll.reset_enabld');
      // …once per distinct value, not once per call.
      spy.mockClear();
      getSetting(ctx, 'payroll.reset_enabled');
      getSetting(ctx, 'audit.hash_chain_enabled');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      delete process.env.SETTING_KILL;
    }
  });

  it('a SUSPENDED tenant keeps its configured settings — stated, not incidental', async () => {
    // ROUND 3 asked for this decision explicitly. It is the same one core modules make, one table over:
    // a setting is not a purchase, it is HOW a feature the tenant still reaches behaves, and forcing
    // defaults on suspension would change payroll arithmetic for an account that is merely in arrears.
    // Suspension is slice 9's SET TRANSACTION READ ONLY overlay, which can say "read yes, write no" —
    // a distinction a value here cannot express. Pinned so slice 9 has a fixture to flip.
    await setSetting(base.tenantId, 'payroll.individual_txn_pay_enabled', true);
    await owner.db.execute(sql`UPDATE tenant SET status = 'suspended' WHERE id = ${base.tenantId}`);
    const ctx = await ctxFor(base.tenantId);
    expect(ctx.entitlements!.tenantStatus).toBe('suspended');
    expect(getSetting(ctx, 'payroll.individual_txn_pay_enabled')).toBe(true);
    // …while the module the setting belongs to really is shut, so this is a decision and not an oversight.
    expect(isModuleEnabled(ctx, 'payroll')).toBe(false);
  });

  it('falls back to the catalog default when the tenant has no row', async () => {
    const ctx = await ctxFor(base.tenantId);
    expect(getSetting(ctx, 'payroll.reset_enabled')).toBe(false);
  });

  it('returns the tenant\'s value when a row exists', async () => {
    await setSetting(base.tenantId, 'payroll.reset_enabled', true);
    expect(getSetting(await ctxFor(base.tenantId), 'payroll.reset_enabled')).toBe(true);
  });

  it('an UNKNOWN key throws rather than returning undefined', async () => {
    // undefined would be read as "off" by any truthiness check at the call site — a typo would
    // silently disable a feature and nobody would learn about it.
    const ctx = await ctxFor(base.tenantId);
    expect(() => getSetting(ctx, 'payroll.reset_enabld')).toThrow(/Unknown setting key/);
  });

  it('a per-tenant value overrides the default in ONE direction only', async () => {
    await setSetting(base.tenantId, 'payroll.reset_enabled', true);
    const mine = await ctxFor(base.tenantId);
    const other = await ctxFor((await seedBase()).tenantId);
    expect(getSetting(mine, 'payroll.reset_enabled')).toBe(true);
    expect(getSetting(other, 'payroll.reset_enabled'), 'another tenant keeps the default').toBe(false);
  });

  it('a row holding JSON null falls back to the catalog default, not to null', async () => {
    // ROUND 2: the presence test was `key in snap.settings`, so a jsonb `null` was present-but-null and
    // short-circuited the default — contradicting getSetting's own contract that a missing value is
    // never silently undefined. Harmless while every catalogued setting is a boolean compared with
    // `=== true`; the first `number` or `json` setting inherits it outright. The customer write path
    // cannot produce this (0313's WITH CHECK requires jsonb_typeof(value) = value_type) but the platform
    // plane writes as the OWNER and bypasses that policy by design, which is the route used here.
    await owner.db.execute(
      sql`INSERT INTO tenant_setting (tenant_id, key, value, source)
          VALUES (${base.tenantId}, 'payroll.reset_enabled', 'null'::jsonb, 'platform')`,
    );
    const ctx = await ctxFor(base.tenantId);
    expect(ctx.entitlements!.settings['payroll.reset_enabled'], 'the null really is in the snapshot').toBeNull();
    expect(getSetting(ctx, 'payroll.reset_enabled'), 'null is ABSENT, so the default applies').toBe(false);
  });

  it('a CUSTOMER-written value on a PLATFORM-scoped key is ignored at read time', async () => {
    // ROUND 2: 0313's tenant_setting_write comment justifies constraining `source` on the grounds that
    // it is "the provenance the settings screen renders and slice 2's resolver reasons about" — and the
    // resolver selected neither `source` nor `scope`. It folded key→value, so a customer-written value
    // was indistinguishable from a platform-written one and the whole boundary was one WITH CHECK
    // predicate on a table ai_hr_app holds full CRUD over by design. The fold now drops that row.
    //
    // Defence in DEPTH, not a replacement: the write policy is still the control. This is what makes a
    // policy regression visible instead of silently effective — payroll.reset_enabled reopens a
    // finalised payroll run.
    await owner.db.execute(
      sql`INSERT INTO tenant_setting (tenant_id, key, value, source)
          VALUES (${base.tenantId}, 'payroll.reset_enabled', 'true'::jsonb, 'customer')`,
    );
    const ctx = await ctxFor(base.tenantId);
    expect(ctx.entitlements!.settings, 'the row must not reach the snapshot at all').not.toHaveProperty(
      'payroll.reset_enabled',
    );
    expect(getSetting(ctx, 'payroll.reset_enabled'), 'a customer cannot self-grant a platform switch').toBe(false);

    // …and the two legitimate cases still work, so the filter is a provenance check and not a blanket ban:
    // a PLATFORM-written value on a platform-scoped key, and a CUSTOMER-written value on a tenant-scoped one.
    await owner.db.execute(
      sql`UPDATE tenant_setting SET source = 'platform' WHERE tenant_id = ${base.tenantId} AND key = 'payroll.reset_enabled'`,
    );
    await owner.db.execute(
      sql`INSERT INTO tenant_setting (tenant_id, key, value, source)
          VALUES (${base.tenantId}, 'payroll.individual_txn_pay_enabled', 'true'::jsonb, 'customer')`,
    );
    const after = await ctxFor(base.tenantId);
    expect(getSetting(after, 'payroll.reset_enabled'), 'Stradaverse may set it').toBe(true);
    expect(getSetting(after, 'payroll.individual_txn_pay_enabled'), 'a tenant-scoped key IS customer-writable').toBe(
      true,
    );
  });
});

// ONE file-level close. A per-describe afterAll(closeAll) closes the shared connection when the FIRST
// describe finishes, and every later block then fails with CONNECTION_ENDED — which is what happened.
afterAll(async () => {
  await closeAll();
});
