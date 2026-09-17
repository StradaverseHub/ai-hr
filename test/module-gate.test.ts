/**
 * r292 — COMMERCIAL MODULE GATING IS SERVICE-DEEP, NOT NAVIGATION-DEEP.
 *
 * WHAT WAS WRONG. Measured on main@c3ba27bf: 7 of 198 `page.tsx` files carried `requireModule`, and
 * `assertModuleEnabled` had FOUR call sites in `core/` (assistant-grant, replacement-request ×2,
 * schema-explorer) — none of them in the four optional packs. Per pack, pages in its route trees vs
 * pages carrying a module check: attendance 23/3, payroll 57/1, claims 6/1, performance 4/1. A customer
 * who declined Payroll could reach 56 of its 57 screens by typing the URL, and post to every server
 * action behind them, because nothing below the page refused.
 *
 * WHAT THIS FILE PINS, and the shape it deliberately avoids. A refusal test alone would pass against a
 * product that refuses EVERYONE — the hollow version of this change, and the worse outcome, because it
 * breaks paying customers rather than merely leaking. So every gate is pinned in BOTH directions:
 * refused without the module, and SUCCEEDING with it, against the same service on the same tenant.
 *
 * And the third arm, which is the regression this change could plausibly cause: a tenant with EVERY
 * optional module off must still run Personnel, Leave, the dashboard and the approvals inbox. Those are
 * core (`isCore: true` in packs/catalog.ts) and were never for sale.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import * as schema from '../db/schema';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ModuleNotEnabledError } from '../core/entitlements';
import { withModuleTenant, assertModuleGate } from '../core/module-gate';
import { CORE_MODULE_CODES, MODULE_CATALOG } from '../packs/catalog';
import { REPORT_CATEGORY_MODULE, assertReportCategoryEnabled } from '../core/report-registry';
import { listClaimTypes, createClaimType, listPendingClaims } from '../core/claims';
import { listCycles } from '../core/performance';
import { listAttendancePolicies, listAttendanceCorrections } from '../core/attendance';
import { listBatches } from '../core/payroll';
// r294 — the two files this round bound, and the four it audited and left. See the r294 block below.
import { listTp1DeclarationsForPersonYear, saveTp1DraftForPerson } from '../core/tax-relief';
import { BackPayNothingToCalculateError, calculateBackPay, detectArrears, listBackPayRuns } from '../core/back-pay';
import { listEmploymentPayComponents, listPayComponents } from '../core/pay-components';
import { listCp38 } from '../core/cp38';
import { listLoansForEmployment } from '../core/loans';
import { listPayrollCycles } from '../core/payroll-cycle';
import { hireEmployee } from '../core/org';
import { todayInKualaLumpur } from '../lib/hr-date';
import { listProcessedPayslipsAcross } from '../core/payroll-view';
import { dashboardStats, listLeaveTypes, myEmployment } from '../core/read';
import { pendingApprovalsCount } from '../core/approvals-inbox';
import { adminCtx, closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

const ROOT = path.resolve(__dirname, '..');

/** The four packs a customer can decline, and one service read from each that every screen depends on. */
const PACKS = ['attendance', 'claims', 'payroll', 'performance'] as const;

let b: Base;

/**
 * Delete EVERY non-core entitlement row for a tenant — "the customer declined all of it".
 *
 * One statement rather than a `setModule` per code, and that is not only tidiness: twenty-two sequential
 * owner-connection round-trips per test left the pool busy enough that the next `resetDb` TRUNCATE
 * deadlocked against them (reproduced twice, deterministically, before this was folded into one).
 *
 * The in-memory mirror `setModule` maintains is deliberately not updated, because nothing here reads it:
 * every assertion below runs on `entitledCtx`, which resolves the REAL rows through the resolver. A test
 * that used `adminCtx` would need the mirror and must use `setModule`.
 */
async function declineEverySellableModule(tenantId: string): Promise<void> {
  const sellable = MODULE_CATALOG.filter((m) => !m.isCore).map((m) => m.code);
  expect(sellable.length, 'the catalogue still has sellable modules to decline').toBeGreaterThan(0);
  await owner.db
    .delete(schema.tenantModule)
    .where(and(eq(schema.tenantModule.tenantId, tenantId), inArray(schema.tenantModule.moduleCode, sellable)));
}

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// The mechanism itself — static, no database.
// ────────────────────────────────────────────────────────────────────────────────────────────────

describe('r292 — the gate refuses to be pointed at a core module', () => {
  it('withModuleTenant throws at construction for every CORE code', () => {
    // This is the guard against the failure mode that would make the change worse than doing nothing:
    // gating a chokepoint a core screen depends on. A typo like withModuleTenant('leave') cannot ship.
    expect(CORE_MODULE_CODES.length).toBeGreaterThan(0);
    for (const code of CORE_MODULE_CODES) {
      expect(() => withModuleTenant(code), `${code} is core and must be unpurchasable`).toThrow(/CORE module/);
    }
    expect(() => withModuleTenant('not_a_module')).toThrow(/MODULE_CATALOG/);
    // …and the converse, so the constructor is discriminating rather than simply always throwing.
    for (const code of PACKS) expect(() => withModuleTenant(code)).not.toThrow();
  });

  it('the report-category map names only real, non-core modules', () => {
    // `claim` (the report category) and `claims` (the module code) are not the same word. A silent
    // mismatch would make assertReportCategoryEnabled a no-op for the claims datasets.
    const codes = new Set(MODULE_CATALOG.map((m) => m.code));
    const core = new Set<string>(CORE_MODULE_CODES);
    let gated = 0;
    for (const [category, code] of Object.entries(REPORT_CATEGORY_MODULE)) {
      if (code == null) continue;
      gated += 1;
      expect(codes.has(code), `${category} → ${code} is a catalog module`).toBe(true);
      expect(core.has(code), `${category} → ${code} is NOT core`).toBe(false);
    }
    expect(gated, 'attendance, payroll, claim and performance datasets are all gated').toBe(4);
    expect(REPORT_CATEGORY_MODULE.claim).toBe('claims');
  });

  it('a BOOTSTRAP context passes through, and is not a web-reachable state', () => {
    // db/seed.ts and db/provision.ts drive these services while the tenant is being created, before any
    // entitlement can exist. Gating them would break `pnpm db:seed`, the test template build and
    // provisioning. lib/session.ts never sets the marker, so no browser request can acquire one — the
    // assertion below is what keeps that claim honest.
    expect(() =>
      assertModuleGate({ tenantId: b.tenantId, entitlementsExempt: 'seeding' } as never, 'payroll'),
    ).not.toThrow();
    expect(fs.readFileSync(path.join(ROOT, 'lib/session.ts'), 'utf8')).not.toContain('entitlementsExempt');
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// BOTH ARMS, at the service, for each pack.
// ────────────────────────────────────────────────────────────────────────────────────────────────

describe('r292 — each optional pack refuses without the module and WORKS with it', () => {
  /** Every pack read used below, keyed by the module it belongs to. */
  const read = {
    attendance: (ctx: never) => listAttendancePolicies(ctx, [b.companyId]),
    claims: (ctx: never) => listClaimTypes(ctx),
    payroll: (ctx: never) => listBatches(ctx),
    performance: (ctx: never) => listCycles(ctx),
  } as const;

  for (const code of PACKS) {
    it(`${code}: the service refuses a tenant WITHOUT it, and answers for a tenant WITH it`, async () => {
      // ARM 1 — off. `setModule(..., null)` DELETES the row, which is how a declined module looks: a
      // missing row is disabled (C7), not an explicit 'disabled' status.
      await setModule(b.tenantId, code, null);
      const off = await entitledCtx(b);
      await expect(read[code](off as never)).rejects.toThrow(ModuleNotEnabledError);

      // ARM 2 — on. THE ARM THAT MATTERS: without it this file would pass against a product that
      // refuses every tenant, which is a worse outcome than the hole it closes.
      await setModule(b.tenantId, code, 'active');
      const on = await entitledCtx(b);
      await expect(read[code](on as never)).resolves.toBeDefined();
    });
  }

  it('payroll: the read MODELS are gated too, not only the engine', async () => {
    // core/payroll-view.ts is a separate file and a separate import line; /payroll/transaction-view and
    // /payroll/individual-payslip read it without touching core/payroll.ts at all.
    await setModule(b.tenantId, 'payroll', null);
    const off = await entitledCtx(b);
    await expect(listProcessedPayslipsAcross(off as never, { companyIds: [b.companyId] })).rejects.toThrow(
      ModuleNotEnabledError,
    );
    await setModule(b.tenantId, 'payroll', 'active');
    const on = await entitledCtx(b);
    await expect(listProcessedPayslipsAcross(on as never, { companyIds: [b.companyId] })).resolves.toBeDefined();
  });

  it('claims: WRITES are refused too, not only reads', async () => {
    // A layout.tsx guard cannot cover this: a server action is not a page render and passes through no
    // layout in the segment. If only reads were gated, a declined customer could still POST.
    await setModule(b.tenantId, 'claims', null);
    const off = await entitledCtx(b);
    await expect(
      createClaimType(off as never, { code: 'T1', name: 'Travel', defaultTaxable: false, requiresReceipt: true }),
    ).rejects.toThrow(ModuleNotEnabledError);

    await setModule(b.tenantId, 'claims', 'active');
    const on = await entitledCtx(b);
    await expect(
      createClaimType(on as never, { code: 'T1', name: 'Travel', defaultTaxable: false, requiresReceipt: true }),
    ).resolves.toBeDefined();
  });

  it('the report runner refuses a pack dataset the tenant does not hold, and allows one it does', async () => {
    await setModule(b.tenantId, 'payroll', null);
    await setModule(b.tenantId, 'claims', 'active');
    const ctx = await entitledCtx(b);
    expect(() => assertReportCategoryEnabled(ctx, 'payroll')).toThrow(ModuleNotEnabledError);
    expect(() => assertReportCategoryEnabled(ctx, 'claim')).not.toThrow();
    // A CORE category is never gated, whatever the tenant bought.
    expect(() => assertReportCategoryEnabled(ctx, 'master')).not.toThrow();
    expect(() => assertReportCategoryEnabled(ctx, 'leave')).not.toThrow();
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// THE REGRESSION THIS CHANGE COULD CAUSE.
// ────────────────────────────────────────────────────────────────────────────────────────────────

describe('r292 — a tenant that declined EVERY optional module still runs the core product', () => {
  it('the dashboard, Personnel, Leave and the approvals inbox all still answer', async () => {
    // Off means off: every sellable code deleted, not merely the four packs.
    await declineEverySellableModule(b.tenantId);
    const ctx = await entitledCtx(b);

    // The dashboard tile reads `payroll_batch` and attendance rows out of core/read.ts — the shared
    // kernel read module, which is exactly why core/read.ts is NOT bound to a module.
    await expect(dashboardStats(ctx, [b.companyId])).resolves.toBeDefined();
    // Leave is core and can never be switched off.
    await expect(listLeaveTypes(ctx, { locale: 'en' })).resolves.toBeDefined();
    // Personnel/ESS spine.
    await expect(myEmployment(ctx)).resolves.not.toBeUndefined();
    // The inbox fans out into claims and attendance. With both queues declared OFF it must answer a
    // number, not throw — that is the core-screen regression this change could cause.
    await expect(
      pendingApprovalsCount(ctx, [b.companyId], { attendance: false, claims: false }),
    ).resolves.toBeTypeOf('number');
    // …and the flag is LOAD-BEARING, not decoration: the two queues it switches off are the two the
    // service refuses for this tenant. Asserted on the queues DIRECTLY rather than by re-running the
    // inbox with the flags forced on, and that choice is worth recording — forcing them on made
    // `listPendingTasks`'s `Promise.all` reject on one member while its eight siblings were still open
    // transactions, which then deadlocked the next test's TRUNCATE (reproduced deterministically). The
    // fact being pinned is the same one either way, and the revert proof for the caller-side guard is
    // the test above: restore the unconditional calls and it fails with ModuleNotEnabledError.
    await expect(listAttendanceCorrections(ctx, { companyIds: [b.companyId], status: 'pending' })).rejects.toThrow(
      ModuleNotEnabledError,
    );
    await expect(listPendingClaims(ctx)).rejects.toThrow(ModuleNotEnabledError);
  });

  it('…and the packs are genuinely off in that same state, so the test above is not vacuous', async () => {
    await declineEverySellableModule(b.tenantId);
    const ctx = await entitledCtx(b);
    await expect(listClaimTypes(ctx)).rejects.toThrow(ModuleNotEnabledError);
    await expect(listBatches(ctx)).rejects.toThrow(ModuleNotEnabledError);
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// The route-level backstop — a filesystem guard, because a new segment is what gets forgotten.
// ────────────────────────────────────────────────────────────────────────────────────────────────

describe('r292 — every optional pack route segment carries a layout guard', () => {
  /** segment → the module code its layout must bind. Each is a route tree packs/<pack>/index.ts claims. */
  const SEGMENTS: Record<string, string> = {
    'app/attendance/clock': 'attendance',
    'app/attendance/daily': 'attendance',
    'app/attendance/import': 'attendance',
    'app/attendance/individual': 'attendance',
    'app/attendance/my-records': 'attendance',
    'app/attendance/plan-ot': 'attendance',
    'app/attendance/recompute': 'attendance',
    'app/attendance/request-status': 'attendance',
    'app/attendance/requests': 'attendance',
    'app/admin/attendance': 'attendance',
    'app/admin/attendance-policy': 'attendance',
    'app/admin/attendance-allowance': 'attendance',
    'app/claims': 'claims',
    'app/admin/claims': 'claims',
    'app/performance': 'performance',
    'app/me/performance': 'performance',
    'app/payroll': 'payroll',
    'app/admin/pay-components': 'payroll',
    'app/admin/payroll-config': 'payroll',
    'app/admin/payroll-cycle': 'payroll',
    'app/admin/payroll-policy': 'payroll',
    'app/admin/payroll-permissions': 'payroll',
    'app/admin/loans': 'payroll',
    'app/me/payslip': 'payroll',
    'app/me/tax-relief': 'payroll',
  };

  it('each segment has a layout.tsx bound to the right module code', () => {
    for (const [seg, code] of Object.entries(SEGMENTS)) {
      const f = path.join(ROOT, seg, 'layout.tsx');
      expect(fs.existsSync(f), `${seg}/layout.tsx exists`).toBe(true);
      expect(fs.readFileSync(f, 'utf8')).toContain(`moduleLayout('${code}')`);
    }
  });

  it('`/attendance/travel` is deliberately NOT gated — travel is spine, not the Attendance pack', () => {
    // packs/attendance/index.ts declares ten satellite tables and `travel_request` is not among them;
    // no pack declares it. The screen reads core/travel-request.ts only, and the approvals inbox lists
    // travel requests for every tenant. Gating the whole `app/attendance` segment would have taken the
    // filing screen away while leaving its approval queue live — the asymmetry is the bug, which is why
    // the guards are per child segment and this one is stated rather than merely absent.
    expect(fs.existsSync(path.join(ROOT, 'app/attendance/travel/layout.tsx'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'app/attendance/layout.tsx'))).toBe(false);
    const src = fs.readFileSync(path.join(ROOT, 'app/attendance/travel/page.tsx'), 'utf8');
    expect(src).toContain("from '@/core/travel-request'");
    expect(src).not.toContain("from '@/core/attendance'");
    for (const p of MODULE_CATALOG) {
      if (p.code !== 'attendance') continue;
      expect(p.isCore, 'attendance itself is still optional').toBe(false);
    }
  });

  it('the layouts are a courtesy, and say so — the control is the service gate', () => {
    // If this file's claim and lib/module-layout.tsx's claim ever diverge, the next author will trust
    // the wrong one. The binding in core/module-gate.ts is what a forgotten page still cannot bypass.
    // r294 appends tax-relief and back-pay. The list only GROWS here; a file leaves it only by an
    // audit that shows no core surface reaches it, which is the r294 block at the bottom of this file.
    const bound = [
      'core/claims.ts',
      'core/performance.ts',
      'core/attendance.ts',
      'core/payroll.ts',
      'core/payroll-view.ts',
      'core/tax-relief.ts',
      'core/back-pay.ts',
    ];
    for (const f of bound) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      expect(src, `${f} takes withTenant from the module gate`).toMatch(/Tenant as withTenant \} from '\.\/module-gate'/);
      expect(src, `${f} no longer takes withTenant straight from db/client`).not.toMatch(
        /import \{ withTenant.*from '\.\.\/db\/client'/,
      );
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// r294 — THE SIX PAYROLL SERVICE FILES r292 LEFT UNBOUND, AND WHY ONLY TWO OF THEM COULD BE BOUND.
//
// r292 bound five service files and stated the gap: `core/pay-components.ts`, `core/loans.ts`,
// `core/payroll-cycle.ts`, `core/tax-relief.ts`, `core/cp38.ts` and `core/back-pay.ts` were still on
// the bare `withTenant`. Their SCREENS are covered by the layout guards above; their SERVER ACTIONS
// are not, because a POST passes through no layout.
//
// The importer audit r292 asked for was done by parsing every import / export-from / dynamic import /
// require in app, components, core, db, lib, packs, scripts, i18n and localization — not by grep, which
// gets this wrong in both directions (it reports doc comments that quote a specifier as real edges, and
// it misses `core/admin.ts`, which reaches `core/payroll-cycle.ts` through `packs/payroll/service`).
//
//   BOUND  core/tax-relief.ts  — every consumer outside the payroll route trees takes only the PURE
//                                exports (TP1_COUNTABLE_COLUMNS, tp1CountForYear, TP1_FORM_CODE,
//                                TP1_ITEMS, TP1_REBATES), none of which opens a transaction.
//   BOUND  core/back-pay.ts    — no consumer at all outside app/payroll/back-pay/** and the facade.
//
//   LEFT   core/pay-components.ts  — app/admin/personnel/[employmentId] (PERSONNEL, core) reads it,
//                                    and the ATTENDANCE pack reaches it (see the attendance-allowance
//                                    case below, and core/module-gate.ts's r298 correction of WHERE).
//   LEFT   core/cp38.ts           — same Personnel page reads `listCp38`.
//   LEFT   core/loans.ts          — app/me/page.tsx (ESS, core) reads `listLoansForEmployment`.
//   LEFT   core/payroll-cycle.ts  — app/admin/organization/[companyId] (core, and the surface r292
//                                    named) reads `listPayrollCycles`; core/admin.ts seeds the cycle
//                                    catalogue on company creation.
//
// r294 left all four because those core screens read them UNCONDITIONALLY, so binding any of them took
// a core screen away from a tenant that declined NOTHING. r298 (board ceb1c560) removed that reason for
// the three screen reads: each screen now asks isModuleEnabledOrFalse(s, 'payroll') first and neither
// reads nor draws the section without Payroll (test/r298-payroll-sections-gate.test.ts, which also shows
// the three screens rendering with cp38/loans/payroll-cycle bound). Binding them is still a SEPARATE
// change with its own blast radius (company creation's seeder, the pack facade, every other consumer), so
// they stay unbound here and the tests below still pin BOTH halves: the two bindings refuse and work, and
// the four non-bindings still answer for a tenant with every optional module off.
// ────────────────────────────────────────────────────────────────────────────────────────────────

describe('r294 — tax-relief and back-pay are bound: refused without Payroll, working with it', () => {
  /** A real person to hang a TP1 declaration on. `hireEmployee` is core/org.ts — never gated. */
  async function hire(): Promise<{ employmentId: string; personId: string }> {
    return hireEmployee(adminCtx(b), {
      person: { fullName: 'Aisyah Binti Rahman', primaryEmail: `aisyah.${randomUUID()}@example.com` },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
  }

  /** Derived from the clock, never hardcoded: the assessment year a declaration would really be filed for. */
  const assessmentYear = Number(todayInKualaLumpur().slice(0, 4));

  it('tax-relief: the TP1 READ and the TP1 WRITE both refuse without Payroll, and both work with it', async () => {
    const { personId } = await hire();

    // ARM 1 — off. Both calls are made as hr_admin with valid input, so `requireAdminTarget` and
    // `resolveInput` (which run BEFORE the transaction opens) cannot be what refuses: the only thing
    // left to throw is the gate, and the assertion names its exact class rather than "throws".
    await setModule(b.tenantId, 'payroll', null);
    const off = await entitledCtx(b);
    await expect(listTp1DeclarationsForPersonYear(off, { personId, assessmentYear })).rejects.toThrow(
      ModuleNotEnabledError,
    );
    // THE WRITE IS THE POINT. /me/tax-relief and /payroll/transactions/tp1 both have a layout guard, but
    // `app/me/actions.ts` posts saveTp1Draft / submitTp1 from a CORE segment with no payroll layout
    // above it — a declined customer could declare and have HR approve tax relief until this line.
    await expect(
      saveTp1DraftForPerson(off, { personId, assessmentYear, tp1Amount: 1200 }),
    ).rejects.toThrow(ModuleNotEnabledError);

    // ARM 2 — on. Without this the file would pass against a product that refuses everyone.
    await setModule(b.tenantId, 'payroll', 'active');
    const on = await entitledCtx(b);
    await expect(listTp1DeclarationsForPersonYear(on, { personId, assessmentYear })).resolves.toEqual([]);
    const saved = await saveTp1DraftForPerson(on, { personId, assessmentYear, tp1Amount: 1200 });
    expect(saved.id).toBeTruthy();
    // …and the write really landed, so ARM 2 is a success and not merely a non-throw.
    await expect(listTp1DeclarationsForPersonYear(on, { personId, assessmentYear })).resolves.toHaveLength(1);
  });

  it('back-pay: the run list and the arrears ENGINE refuse without Payroll, and reach the engine with it', async () => {
    await setModule(b.tenantId, 'payroll', null);
    const off = await entitledCtx(b);
    await expect(listBackPayRuns(off, { companyIds: [b.companyId] })).rejects.toThrow(ModuleNotEnabledError);
    await expect(detectArrears(off, { companyId: b.companyId })).rejects.toThrow(ModuleNotEnabledError);
    // `approveAndPostBackPay` writes money into a draft batch; `calculateBackPay` is the step before it.
    await expect(
      calculateBackPay(off, { companyId: b.companyId, targetPayPeriod: '2026-03' }),
    ).rejects.toThrow(ModuleNotEnabledError);

    await setModule(b.tenantId, 'payroll', 'active');
    const on = await entitledCtx(b);
    await expect(listBackPayRuns(on, { companyIds: [b.companyId] })).resolves.toEqual([]);
    await expect(detectArrears(on, { companyId: b.companyId })).resolves.toEqual([]);
    // The DISCRIMINATING arm: with the module on, the same call gets PAST the gate and fails inside the
    // engine for the domain reason (this tenant has no arrears), not for an entitlement reason. A gate
    // that refused everyone could not produce this error.
    await expect(
      calculateBackPay(on, { companyId: b.companyId, targetPayPeriod: '2026-03' }),
    ).rejects.toThrow(BackPayNothingToCalculateError);
  });
});

describe('r294 — the four files left unbound still serve their CORE surfaces with every module off', () => {
  /**
   * THE REGRESSION THIS ROUND EXISTS TO AVOID, and the reason four of the six files keep the bare
   * `withTenant`. Each call below is made by a CORE screen — one a customer who bought no optional
   * module still has — and each reaches a payroll service file. Bind that file and this test goes red,
   * which is exactly the alarm the next author needs.
   */
  it('Personnel, /me and Organization all still answer, and each names the file it would break', async () => {
    const { employmentId } = await hireEmployee(adminCtx(b), {
      person: { fullName: 'Tan Wei Ming', primaryEmail: `tan.${randomUUID()}@example.com` },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    // A real cycle row, so the Organization read below is a genuine read and not an empty-table no-op.
    await owner.db
      .insert(schema.payrollCycle)
      .values({ tenantId: b.tenantId, companyId: b.companyId, name: 'Month End', runType: 'regular' });

    await declineEverySellableModule(b.tenantId);
    const ctx = await entitledCtx(b);

    // app/admin/personnel/[employmentId]/page.tsx — for any admin, gated on Payroll since r298.
    await expect(listPayComponents(ctx)).resolves.toBeDefined(); // core/pay-components.ts
    await expect(listEmploymentPayComponents(ctx, employmentId)).resolves.toBeDefined(); // core/pay-components.ts
    await expect(listCp38(ctx, { employmentId })).resolves.toBeDefined(); // core/cp38.ts
    // app/me/page.tsx — the ESS profile, gated on Payroll since r298.
    await expect(listLoansForEmployment(ctx, employmentId)).resolves.toBeDefined(); // core/loans.ts
    // app/admin/organization/[companyId]/page.tsx:82 — the surface r292 named by name.
    await expect(listPayrollCycles(ctx, b.companyId, { activeOnly: true })).resolves.toHaveLength(1); // core/payroll-cycle.ts
  });

  it('…and payroll really is off in that same state, so the test above is not vacuous', async () => {
    await declineEverySellableModule(b.tenantId);
    const ctx = await entitledCtx(b);
    // The two files this round DID bind, on the same tenant, in the same state, through the same ctx.
    await expect(listBackPayRuns(ctx, { companyIds: [b.companyId] })).rejects.toThrow(ModuleNotEnabledError);
    await expect(detectArrears(ctx, { companyId: b.companyId })).rejects.toThrow(ModuleNotEnabledError);
  });
});

describe('r294 — the audit is pinned in source, on both sides', () => {
  /** file → the CORE (or other-pack) consumer that forbids binding it, and the symbol it calls. */
  const LEFT_UNBOUND: Record<string, { consumer: string; symbol: string }> = {
    'core/pay-components.ts': { consumer: 'app/admin/personnel/[employmentId]/page.tsx', symbol: 'listPayComponents' },
    'core/cp38.ts': { consumer: 'app/admin/personnel/[employmentId]/page.tsx', symbol: 'listCp38' },
    'core/loans.ts': { consumer: 'app/me/page.tsx', symbol: 'listLoansForEmployment' },
    'core/payroll-cycle.ts': {
      consumer: 'app/admin/organization/[companyId]/page.tsx',
      symbol: 'listPayrollCycles',
    },
  };

  it('each unbound file still takes the bare withTenant, and its core consumer still exists', () => {
    for (const [file, { consumer, symbol }] of Object.entries(LEFT_UNBOUND)) {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
      expect(src, `${file} is deliberately NOT module-bound — ${consumer} would break`).not.toMatch(
        /Tenant as withTenant \} from '\.\/module-gate'/,
      );
      expect(src, `${file} still takes withTenant from db/client`).toMatch(
        /import \{ withTenant.*from '\.\.\/db\/client'/,
      );
      // The other half of the ratchet: if the core consumer is ever removed or stops calling the
      // symbol, this fails and the file becomes a candidate for binding — a re-audit, not a silence.
      const consumerSrc = fs.readFileSync(path.join(ROOT, consumer), 'utf8');
      expect(consumerSrc, `${consumer} still calls ${symbol}`).toContain(symbol);
    }
  });

  it('core/attendance-allowance.ts is a SECOND reason core/pay-components.ts cannot be payroll-bound', () => {
    // Not a core surface but a different PACK: a tenant holding Attendance and not Payroll transfers an
    // allowance into a draft run through `setPayrollBatchComponent`. Binding pay-components to `payroll`
    // would refuse that tenant a feature it actually bought — the cross-pack version of the same defect.
    const src = fs.readFileSync(path.join(ROOT, 'core/attendance-allowance.ts'), 'utf8');
    expect(src).toContain("from './pay-components'");
    expect(src).toContain('setPayrollBatchComponent');
    const attendance = MODULE_CATALOG.find((m) => m.code === 'attendance');
    const payroll = MODULE_CATALOG.find((m) => m.code === 'payroll');
    expect(attendance?.isCore).toBe(false);
    expect(payroll?.isCore).toBe(false);
  });

  it('core/admin.ts reaches core/payroll-cycle.ts through the FACADE — the edge a direct grep misses', () => {
    // r292 named `core/admin.ts` as a blocker and a specifier grep on './payroll-cycle' finds nothing in
    // it, because the import is `from '../packs/payroll/service'`. Pinning the real shape here so the
    // next audit does not "correct" r292 with a grep that cannot see this edge.
    const admin = fs.readFileSync(path.join(ROOT, 'core/admin.ts'), 'utf8');
    expect(admin).toContain("from '../packs/payroll/service'");
    expect(admin).toContain('seedPayrollCycleCatalog');
    expect(fs.readFileSync(path.join(ROOT, 'packs/payroll/service.ts'), 'utf8')).toContain(
      "export * from '../../core/payroll-cycle'",
    );
  });
});
