/**
 * Decouple Earning Method from Eligibility tab configuration (feedback eee43966).
 *
 * The earning method (leave_policy.accrual.method) is chosen in ONE place — General → Earning Method,
 * alongside Leave Year Type. Nothing under the Eligibility tab may change it.
 *
 * Root cause fixed here (two doors on the Eligibility tab both rendered a `method` select):
 *  - ADD a dated entitlement (the reporter's bug). The add form defaulted the select to lump sum, and
 *    createLeavePolicy SUPERSEDES the running same-scope row — so bumping days from next year silently
 *    downgraded an earned_monthly setup to grant_on_hire_prorated. createLeavePolicy now INHERITS the
 *    method from the row it supersedes.
 *  - EDIT an entitlement row. Preserved today only because the select round-tripped the stored value;
 *    with the select removed, updateLeavePolicy now PRESERVES the row's stored method when the caller
 *    sends none (the serviceBands tri-state, mirrored). Read server-side from the row — not a hidden
 *    client field — so a method changed under General after the panel rendered can't be clobbered.
 *
 * Under test:
 *  (1) update preserve-guard — an Eligibility-shaped edit with method absent and annualDays HELD CONSTANT
 *      keeps the stored method AND recalculates nothing (proving method no longer drives the reproject);
 *      an explicit method still overrides (and, as a non-vacuity control, still does recalc); a lump
 *      policy edited without a method stays lump.
 *  (2) create supersede-inherit — a later-dated version with method absent inherits the superseded row's
 *      method and closes it; a brand-new scope still defaults to lump; an explicit method still wins.
 *  (3) panel structure — neither Eligibility form (edit / add) renders a name="method" select; the
 *      visible earning-method control lives only in the General earning sub-step.
 *  (4) Leave Year Type independence — an eligibility/days edit never touches leave_type.year_cycle_override
 *      or the cycle it resolves to (already decoupled; confirmation only).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { createLeavePolicy, updateLeavePolicy, updateLeaveType } from '../core/admin';
import { accrueEarnedLeave, resolveLeaveYearCycle } from '../core/leave';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const here = dirname(fileURLToPath(import.meta.url));
const panelSrc = readFileSync(resolve(here, '../components/leave-type-panel.tsx'), 'utf8');

let b: Base;
const uniqEmail = () => `emdecoup_${randomUUID().slice(0, 8)}@t.local`;
const ASOF = '2026-06-30';

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

/** The stored accrual for one policy row (owner read — bypasses RLS for assertions). */
const storedAccrual = async (policyId: string) => {
  const [row] = await owner.db
    .select({ accrual: schema.leavePolicy.accrual, validTo: schema.leavePolicy.validTo })
    .from(schema.leavePolicy)
    .where(eq(schema.leavePolicy.id, policyId));
  return {
    method: (row?.accrual as { method?: string } | null)?.method,
    annualDays: (row?.accrual as { annualDays?: number } | null)?.annualDays,
    validTo: row?.validTo ?? null,
  };
};

const policy = (p: { annualDays: number; method?: string; validFrom?: string; gradeId?: string | null }) =>
  createLeavePolicy(adminCtx(b), {
    leaveTypeId: b.annualLeaveTypeId,
    annualDays: p.annualDays,
    method: p.method,
    gradeId: p.gradeId ?? null,
    companyId: null,
    validFrom: p.validFrom ?? '2026-01-01',
  });

const hire = (hiredOn = '2026-01-01') =>
  hireEmployee(adminCtx(b), {
    person: { fullName: 'Method Emp', primaryEmail: uniqEmail() },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn,
    grantLeaveTypes: [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }],
  });

/** Exactly the fields an Eligibility-tab edit posts once the method select is gone (actions.ts maps an
 *  absent `method` form field to `undefined`). Days + validFrom are held at the stored values so the
 *  ONLY thing that could move the entitlement is the method. */
const eligibilityEdit = (p: { id: string; annualDays: number; validFrom: string; method?: string }) =>
  updateLeavePolicy(adminCtx(b), {
    id: p.id,
    annualDays: p.annualDays,
    method: p.method,
    gradeId: null,
    companyId: null,
    validFrom: p.validFrom,
    asOf: ASOF,
  });

describe('eee43966 · Eligibility EDIT never resets the earning method', () => {
  it('an edit with method absent and days held constant preserves earned_monthly and recalculates nothing', async () => {
    const p = await policy({ annualDays: 12, method: 'earned_monthly' });
    await hire();
    await accrueEarnedLeave(adminCtx(b), { asOf: ASOF });

    const recalc = await eligibilityEdit({ id: p.id, annualDays: 12, validFrom: '2026-01-01' });

    expect((await storedAccrual(p.id)).method).toBe('earned_monthly');
    // before.method === after.method zeroes reprojectEntitlementForPolicy's method delta — the method
    // dimension no longer drives a recalculation from the Eligibility tab.
    expect(recalc).toEqual({ affected: 0, totalDelta: 0, packBlocked: [] });
  });

  it('non-vacuity control: an EXPLICIT method change with the same days still overrides and still recalculates', async () => {
    const p = await policy({ annualDays: 12, method: 'earned_monthly' });
    await hire();
    await accrueEarnedLeave(adminCtx(b), { asOf: ASOF });

    const recalc = await eligibilityEdit({
      id: p.id,
      annualDays: 12,
      validFrom: '2026-01-01',
      method: 'grant_on_hire_prorated',
    });

    expect((await storedAccrual(p.id)).method).toBe('grant_on_hire_prorated');
    // Same days, method-only move ⇒ the reproject DOES fire. Proves the affected-0 above is the guard
    // working, not an inert fixture.
    expect(recalc.affected).toBeGreaterThan(0);
  });

  it('a lump-sum policy edited without a method stays lump-sum (no accidental promotion)', async () => {
    const p = await policy({ annualDays: 14 });
    expect((await storedAccrual(p.id)).method).toBe('grant_on_hire_prorated');

    await eligibilityEdit({ id: p.id, annualDays: 16, validFrom: '2026-01-01' });

    const after = await storedAccrual(p.id);
    expect(after.method).toBe('grant_on_hire_prorated');
    expect(Number(after.annualDays)).toBe(16); // the days edit itself still lands
  });
});

describe('eee43966 · Eligibility ADD (a new dated entitlement) inherits the running earning method', () => {
  it('a later-dated version with method absent inherits earned_monthly and closes the superseded row', async () => {
    const prior = await policy({ annualDays: 12, method: 'earned_monthly', validFrom: '2026-01-01' });

    // Exactly what the add form posts now that its method select is gone.
    const next = await policy({ annualDays: 16, validFrom: '2027-01-01' });

    // Before this fix the new row stored grant_on_hire_prorated — the reporter's silent downgrade.
    const after = await storedAccrual(next.id);
    expect(after.method).toBe('earned_monthly');
    expect(Number(after.annualDays)).toBe(16);
    expect(after.validTo).toBeNull(); // the new version is the active one
    expect((await storedAccrual(prior.id)).validTo).toBe('2027-01-01'); // prior window closed
    expect((await storedAccrual(prior.id)).method).toBe('earned_monthly'); // history untouched
  });

  it('earned_quarterly is inherited the same way (any stored method, not just monthly)', async () => {
    await policy({ annualDays: 12, method: 'earned_quarterly', validFrom: '2026-01-01' });
    const next = await policy({ annualDays: 20, validFrom: '2027-01-01' });
    expect((await storedAccrual(next.id)).method).toBe('earned_quarterly');
  });

  it('a brand-new scope with no prior active row still defaults to lump sum', async () => {
    // An earned_monthly GROUP-default row exists, but this add targets a different (grade) scope, so it
    // has nothing of its own to inherit from — genuinely new setups are unchanged.
    await policy({ annualDays: 12, method: 'earned_monthly', validFrom: '2026-01-01' });
    const [g] = await owner.db
      .insert(schema.jobGrade)
      .values({ tenantId: b.tenantId, code: 'G9', name: 'Grade 9' })
      .returning({ id: schema.jobGrade.id });

    const scoped = await policy({ annualDays: 18, validFrom: '2026-06-01', gradeId: g.id });

    expect((await storedAccrual(scoped.id)).method).toBe('grant_on_hire_prorated');
  });

  it('an explicit method on the new version still wins over the inherited one', async () => {
    await policy({ annualDays: 12, method: 'earned_monthly', validFrom: '2026-01-01' });
    const next = await policy({ annualDays: 16, method: 'grant_on_hire_prorated', validFrom: '2027-01-01' });
    expect((await storedAccrual(next.id)).method).toBe('grant_on_hire_prorated');
  });
});

describe('eee43966 · panel structure — one edit surface for the earning method', () => {
  /** The card segment (its CardTitle to the next card's CardTitle) holding both the inline EDIT form and
   *  the add-a-dated-entitlement ADD form.
   *
   *  Integration r66: this used to be the Eligibility card (categoryEligibilityEntitlement). b8fcae73
   *  removed the Eligibility step from the workflow altogether and folded its forms into Entitlement —
   *  that key is now RETIRED (see leave-type-config-categories.test.ts's RETIRED_KEYS). The assertions
   *  below are unchanged and still bite: they are re-pointed at the card the two forms actually live in
   *  now, not relaxed. */
  const eligibilitySegment = () => {
    const start = panelSrc.indexOf("<CardTitle>{t('categoryEntitlement')}</CardTitle>");
    const end = panelSrc.indexOf("<CardTitle>{t('categoryEssPolicy')}</CardTitle>");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return panelSrc.slice(start, end);
  };

  it('neither Eligibility form renders a name="method" select', () => {
    const seg = eligibilitySegment();
    expect(seg).not.toMatch(/<select[^>]*name="method"/);
    // Nor a hidden method field — the two forms rely on the server-side preserve/inherit guards, so a
    // stale panel-render-time value can never be posted back over a method changed under General.
    expect(seg).not.toContain('name="method"');
    // The add form's lump-sum default — the exact reporter bug — is gone.
    expect(seg).not.toContain('defaultValue="grant_on_hire_prorated"');
  });

  it('the read-only earned badge stays on the policy row so HR still sees the method', () => {
    expect(eligibilitySegment()).toContain('isEarned(p.method)');
  });

  it('the visible earning-method control renders only in the General earning sub-step', () => {
    // The one <select> a user picks the method from is EarningMethodForm's, rendered by the General
    // sub-step 3 front door. (CarryPolicyForm and EarningMethodForm both legitimately post a HIDDEN
    // name="method" — that is preservation, not a second edit surface.)
    expect(panelSrc).toContain("{generalSubStep === 'earning' && (");
    const earningForm = panelSrc.slice(
      panelSrc.indexOf('function EarningMethodForm'),
      panelSrc.indexOf('function CarryPolicyForm'),
    );
    expect(earningForm).toContain("aria-label={t('subStep.earningMethodLabel')}");
    // Exactly one visible method picker in the whole panel.
    expect((panelSrc.match(/aria-label=\{t\('subStep\.earningMethodLabel'\)\}/g) ?? []).length).toBe(1);
  });

  it('core/admin.ts preserves the stored method on update and inherits it on supersede', () => {
    const adminSrc = readFileSync(resolve(here, '../core/admin.ts'), 'utf8');
    expect(adminSrc).toContain("method: p.method || currentMethod || 'grant_on_hire_prorated'");
    expect(adminSrc).toContain("method: p.method || inheritedMethod || 'grant_on_hire_prorated'");
  });
});

describe('eee43966 · Leave Year Type stays driven by General alone', () => {
  it('an Eligibility days edit leaves year_cycle_override and the resolved cycle untouched', async () => {
    await updateLeaveType(adminCtx(b), {
      id: b.annualLeaveTypeId,
      name: 'Annual Leave',
      yearCycleOverride: 'a2a',
    });
    const p = await policy({ annualDays: 12, method: 'earned_monthly' });

    await eligibilityEdit({ id: p.id, annualDays: 18, validFrom: '2026-01-01' });

    const [row] = await owner.db
      .select({ v: schema.leaveType.yearCycleOverride })
      .from(schema.leaveType)
      .where(eq(schema.leaveType.id, b.annualLeaveTypeId));
    expect(row?.v).toBe('a2a');
    // The company cycle is calendar; the type-level override still wins after the eligibility save.
    expect(resolveLeaveYearCycle(row?.v, 'calendar')).toBe('anniversary');
    // …and the method the cycle pairs with is still the one General set.
    expect((await storedAccrual(p.id)).method).toBe('earned_monthly');
  });

  it('adding a dated entitlement leaves year_cycle_override untouched too', async () => {
    await updateLeaveType(adminCtx(b), {
      id: b.annualLeaveTypeId,
      name: 'Annual Leave',
      yearCycleOverride: 'c2c',
    });
    await policy({ annualDays: 12, method: 'earned_monthly', validFrom: '2026-01-01' });

    await policy({ annualDays: 16, validFrom: '2027-01-01' });

    const [row] = await owner.db
      .select({ v: schema.leaveType.yearCycleOverride })
      .from(schema.leaveType)
      .where(eq(schema.leaveType.id, b.annualLeaveTypeId));
    expect(row?.v).toBe('c2c');
    expect(resolveLeaveYearCycle(row?.v, 'anniversary')).toBe('calendar');
  });
});
