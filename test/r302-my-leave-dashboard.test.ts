/**
 * r302 (board 6c9802c9) · MY LEAVE DASHBOARD — THE PAGE'S DATA READ, AGAINST THE OWNERS OF ITS FIGURES.
 *
 * The approved plan's promises, each an arm here:
 *   · "Every figure on the page follows the year chosen" — per-year figures ARE leaveEntitlementBreakdown for
 *     that year's cycle (a pick, never a recomputation), for the current year and an earlier one;
 *   · "You can apply for … is the Balance less what is already pending. It is the same figure the Apply Leave
 *     form checks against" — equal to availableLeaveBalance (the submit guard) and leaveTypeApplySummary (the
 *     popup) on a PART-UNPAID pending request, with approved leave later in the cycle;
 *   · the ring is for the Annual Leave type only (isEarnedAccrualType: role first, the ANNUAL code fallback);
 *   · Hidden types are absent, Primary before Secondary;
 *   · a type with no entitlement shows Taken only;
 *   · the year selector offers this year and earlier years with ledger rows, never a future year;
 *   · Upcoming Leave: approved + pending from today onwards, soonest first.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { accrueEarnedLeave, asOfForLeaveYear, availableLeaveBalance, decideLeave, isEarnedAccrualType, leaveTypeApplySummary, requestLeave } from '../core/leave';
import { leaveBalances, leaveEntitlementBreakdown } from '../core/read';
import { myLeaveDashboard, myUpcomingLeave, resolveSelectedLeaveYear } from '../core/my-leave';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, seedEntitlement, type Base } from './harness';

let b: Base;
const TODAY = todayInKualaLumpur();
const YEAR = Number(TODAY.slice(0, 4));
const addDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

async function hire(hiredOn: string) {
  const e = await hireEmployee(adminCtx(b), {
    person: { fullName: 'Dash Employee', primaryEmail: `r302d_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn,
  });
  const ctx: SessionContext = {
    tenantId: b.tenantId,
    userId: await createAppUser(b.tenantId, e.personId, 'employee'),
    personId: e.personId,
    roles: ['employee'],
  };
  return { ...e, ctx };
}

async function type(values: Partial<typeof schema.leaveType.$inferInsert> = {}): Promise<string> {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: b.tenantId,
      code: `R302_${randomUUID().slice(0, 8).toUpperCase().replace(/-/g, '')}`,
      name: `Type ${randomUUID().slice(0, 6)}`,
      paid: true,
      counting: 'calendar_days',
      visibleToEmployee: true,
      ...values,
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

const ledger = (employmentId: string, leaveTypeId: string, entryType: 'accrual' | 'debit' | 'adjustment', days: number, effectiveOn: string) =>
  owner.db.insert(schema.leaveLedger).values({
    tenantId: b.tenantId,
    employmentId,
    leaveTypeId,
    entryType,
    days: days.toFixed(2),
    effectiveOn,
  });

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

describe('"You can apply for" IS the figure the Apply form checks — and Balance − Pending reads to it', () => {
  it('approved leave later in the cycle + a part-unpaid pending request: page = popup = submit guard', async () => {
    // An anniversary cycle that opened on the 1st of THIS month, so there is always room later in the cycle
    // whatever today's date is (no hardcoded future date; CLAUDE.md §8).
    const month = TODAY.slice(5, 7);
    const emp = await hire(`${YEAR - 2}-${month}-01`);
    const T = await type({ name: 'Annual Leave (r302)', role: 'annual', yearCycleOverride: 'a2a', allowUnpaidLeave: true, allowNegativeBalance: false });
    const cycleStart = `${YEAR}-${month}-01`;
    await ledger(emp.employmentId, T, 'accrual', 10, cycleStart);

    // Approved: 3 calendar days starting a week from today (an admin files it, so no leave-year gate applies).
    const approvedStart = addDays(TODAY, 7);
    const approved = await requestLeave(adminCtx(b), {
      employmentId: emp.employmentId,
      leaveTypeId: T,
      startDate: approvedStart,
      endDate: addDays(approvedStart, 2),
      today: TODAY,
    });
    expect((await decideLeave(adminCtx(b), { leaveRequestId: approved.leaveRequestId, decision: 'approved' })).status).toBe('approved');

    // Pending: 9 days against 7 available → 7 paid + 2 unpaid (allow_unpaid_leave).
    const pendingStart = addDays(TODAY, 20);
    const pending = await requestLeave(adminCtx(b), {
      employmentId: emp.employmentId,
      leaveTypeId: T,
      startDate: pendingStart,
      endDate: addDays(pendingStart, 8),
      today: TODAY,
    });
    const [pr] = await owner.db
      .select({ days: schema.leaveRequest.days, unpaid: schema.leaveRequest.unpaidDays, status: schema.leaveRequest.status })
      .from(schema.leaveRequest)
      .where(eq(schema.leaveRequest.id, pending.leaveRequestId));
    expect(pr).toMatchObject({ days: '9.00', unpaid: '2.00', status: 'pending' });

    const guard = await withTenant(emp.ctx, (tx) => availableLeaveBalance(tx, emp.employmentId, T));
    const popup = await leaveTypeApplySummary(emp.ctx, { employmentId: emp.employmentId, leaveTypeId: T });
    const dash = await myLeaveDashboard(emp.ctx, emp.employmentId, { today: TODAY });
    const card = dash.cards.find((c) => c.leaveTypeId === T)!;

    expect(guard).toBe(0); // 10 − 3 approved − 7 reserved (the 2 unpaid days reserve nothing)
    expect(card.canApplyFor, 'the page prints the submit guard’s figure').toBe(guard);
    expect(card.canApplyFor, 'and the Apply popup’s').toBe(popup.available);
    expect(card.pending, 'Pending is the guard’s reservation, net of unpaid days').toBe(popup.pending);
    expect(card.pending).toBe(7);
    expect(card.taken, 'the approved leave later in the cycle is Taken').toBe(3);
    expect(card.balance).toBe(7);
    expect(card.balance! - card.pending!, 'Balance − Pending = You can apply for, on screen').toBe(card.canApplyFor);
    expect(card.isCurrentCycle).toBe(true);
    expect(card.cycleStart).toBe(cycleStart);

    // WHY THE CYCLE'S LAST DAY AND NOT TODAY (the build note's asOf): read at today, the booked days and the
    // pending request both fall outside the window and the page would contradict the form it sits beside.
    const atToday = await leaveEntitlementBreakdown(emp.ctx, emp.employmentId, T, TODAY);
    expect(atToday!.balance - atToday!.pendingApproval).not.toBe(guard);
    // …and the old all-time read counts the unpaid days as reserved, so it disagrees with the guard too.
    const allTime = (await leaveBalances(emp.ctx, emp.employmentId)).find((r) => r.leaveTypeId === T)!;
    expect(allTime.available).not.toBe(guard);
  });
});

describe('EARNED MONTHLY Annual Leave, mid-year: Earned so far is what is POSTED to today, never the year’s projection', () => {
  it('Entitlement = the full year; Earned so far = credits posted up to today; Taken/Pending/Balance/You can apply for agree with the form', async () => {
    // "Today" mid-year, derived from the clock: 15 June this year, or the real today if that is earlier. The
    // accrual engine is run at exactly the date the Earned Accrual screen and the monthly cron use for the
    // current year (asOfForLeaveYear → today), so the ledger holds credits up to this month and no later.
    const MID = TODAY < `${YEAR}-06-15` ? TODAY : `${YEAR}-06-15`;
    await seedEntitlement(adminCtx(b), { leaveTypeId: b.annualLeaveTypeId, annualDays: 14, validFrom: `${YEAR}-01-01` });
    await owner.db.update(schema.leaveType).set({ accrualMethod: 'earned_monthly' }).where(eq(schema.leaveType.id, b.annualLeaveTypeId));
    const [annual] = await owner.db
      .select({ code: schema.leaveType.code, role: schema.leaveType.role })
      .from(schema.leaveType)
      .where(eq(schema.leaveType.id, b.annualLeaveTypeId));
    expect(isEarnedAccrualType(annual), 'the seeded ANNUAL type is the Annual Leave type').toBe(true);
    const emp = await hire(`${YEAR - 2}-01-01`);
    const runAt = asOfForLeaveYear(YEAR, MID);
    expect(runAt).toBe(MID);
    await accrueEarnedLeave(adminCtx(b), { asOf: runAt, employmentIds: [emp.employmentId] });

    const posted = await owner.db
      .select({ days: schema.leaveLedger.days, effectiveOn: schema.leaveLedger.effectiveOn })
      .from(schema.leaveLedger)
      .where(eq(schema.leaveLedger.employmentId, emp.employmentId));
    const accrued = posted.reduce((n, r) => n + Number(r.days), 0);
    expect(accrued, 'the engine credited something by mid-year').toBeGreaterThan(0);
    expect(accrued, 'and not the whole year').toBeLessThan(14);
    expect(posted.every((r) => r.effectiveOn <= MID), 'no credit is dated after today').toBe(true);

    // Approved leave LATER in the year (2 days, the debit dated on its start, as finalizeLeaveApproval writes
    // it) and a pending request (1 day) — the booked days that made the build note's "asOf = today" wrong.
    const [approved] = await owner.db
      .insert(schema.leaveRequest)
      .values({ tenantId: b.tenantId, employmentId: emp.employmentId, leaveTypeId: b.annualLeaveTypeId, startDate: `${YEAR}-11-02`, endDate: `${YEAR}-11-03`, days: '2.00', status: 'approved' })
      .returning({ id: schema.leaveRequest.id });
    await owner.db.insert(schema.leaveLedger).values({
      tenantId: b.tenantId,
      employmentId: emp.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      entryType: 'debit',
      days: '-2.00',
      sourceRequestId: approved.id,
      effectiveOn: `${YEAR}-11-02`,
    });
    await owner.db
      .insert(schema.leaveRequest)
      .values({ tenantId: b.tenantId, employmentId: emp.employmentId, leaveTypeId: b.annualLeaveTypeId, startDate: `${YEAR}-11-20`, endDate: `${YEAR}-11-20`, days: '1.00', status: 'pending' });

    const card = (await myLeaveDashboard(emp.ctx, emp.employmentId, { today: MID })).cards.find((c) => c.leaveTypeId === b.annualLeaveTypeId)!;
    const atToday = await leaveEntitlementBreakdown(emp.ctx, emp.employmentId, b.annualLeaveTypeId, MID);
    const guard = await withTenant(emp.ctx, (tx) => availableLeaveBalance(tx, emp.employmentId, b.annualLeaveTypeId));

    expect(card.annualLeave, 'the ring card').toBe(true);
    expect(card.entitlement, 'Entitlement is the FULL-YEAR figure').toBe(14);
    expect(card.earnedSoFar, 'Earned so far = the credits posted up to today').toBe(accrued);
    expect(card.earnedSoFar, '…the same figure a read AT TODAY gives').toBe(atToday!.currentYearEntitlement);
    expect(card.earnedSoFar).not.toBe(card.entitlement);
    expect(card.taken, 'approved leave later this year is Taken').toBe(2);
    expect(card.pending).toBe(1);
    expect(card.balance).toBe(accrued - 2);
    expect(card.canApplyFor, 'You can apply for = the Apply form’s figure').toBe(guard);
    expect(card.balance! - card.pending!).toBe(card.canApplyFor);
  });
});

describe('every figure follows the year chosen — a pick off leaveEntitlementBreakdown for that year', () => {
  it('current year and an earlier year, each equal to the breakdown read at that cycle’s last day', async () => {
    const emp = await hire('2019-03-01');
    const T = await type({ name: 'Medical (r302)', code: 'SICK' });
    await ledger(emp.employmentId, T, 'accrual', 12, `${YEAR - 1}-01-01`);
    await ledger(emp.employmentId, T, 'debit', -2, `${YEAR - 1}-06-01`);
    await ledger(emp.employmentId, T, 'accrual', 14, `${YEAR}-01-01`);
    await ledger(emp.employmentId, T, 'debit', -1, `${YEAR}-01-02`);

    const current = await myLeaveDashboard(emp.ctx, emp.employmentId, { today: TODAY });
    expect(current.years).toEqual([YEAR, YEAR - 1]);
    expect(current.selectedYear).toBe(YEAR);
    const cur = current.cards.find((c) => c.leaveTypeId === T)!;
    const curBd = await leaveEntitlementBreakdown(emp.ctx, emp.employmentId, T, `${YEAR}-12-31`);
    expect(cur.asOf).toBe(`${YEAR}-12-31`);
    expect({ taken: cur.taken, balance: cur.balance, earned: cur.earnedSoFar }).toEqual({
      taken: curBd!.takenThisCycle,
      balance: curBd!.balance,
      earned: null, // no entitlement table for this type ⇒ no Earned so far line
    });
    expect(cur.taken).toBe(1);

    const past = await myLeaveDashboard(emp.ctx, emp.employmentId, { today: TODAY, year: String(YEAR - 1) });
    expect(past.selectedYear).toBe(YEAR - 1);
    const p = past.cards.find((c) => c.leaveTypeId === T)!;
    const pastBd = await leaveEntitlementBreakdown(emp.ctx, emp.employmentId, T, `${YEAR - 1}-12-31`);
    expect(p.cycleStart).toBe(`${YEAR - 1}-01-01`);
    expect(p.asOf).toBe(`${YEAR - 1}-12-31`);
    expect(p.taken).toBe(pastBd!.takenThisCycle);
    expect(p.balance).toBe(pastBd!.balance);
    expect(p.pending).toBe(pastBd!.pendingApproval);
    expect(p.taken).toBe(2);
    expect(p.balance).toBe(10);
    // "You can apply for" is a figure about applying NOW — never on an earlier year.
    expect(p.isCurrentCycle).toBe(false);
    expect(p.canApplyFor).toBeNull();
  });

  it('the selector offers no future year, and a tampered or unknown year falls back to the current one', async () => {
    const emp = await hire('2019-03-01');
    const T = await type();
    await ledger(emp.employmentId, T, 'accrual', 5, `${YEAR + 1}-01-01`); // a next-year grant generated early
    await ledger(emp.employmentId, T, 'accrual', 5, `${YEAR - 3}-01-01`);
    const d = await myLeaveDashboard(emp.ctx, emp.employmentId, { today: TODAY, year: String(YEAR + 1) });
    expect(d.years).toEqual([YEAR, YEAR - 3]);
    expect(d.selectedYear).toBe(YEAR);
    expect(resolveSelectedLeaveYear("2020' or 1=1", d.years, YEAR)).toBe(YEAR);
    expect(resolveSelectedLeaveYear(String(YEAR - 1), d.years, YEAR)).toBe(YEAR); // no rows that year
    expect(resolveSelectedLeaveYear(String(YEAR - 3), d.years, YEAR)).toBe(YEAR - 3);
  });

  it('an anniversary type shows its own cycle dates', async () => {
    // UPDATED BY the r302 fix pass (verifier defect 6), which REVERSES "the selector picks the year the cycle
    // STARTS in": year Y is (currentYear − Y) cycles before the cycle containing today. For an October type the
    // cycle containing today opened this October (from October on) or last October (before it); the year before
    // is the cycle before that one. test/r302fp-my-leave-fixpass.test.ts walks three selections.
    const emp = await hire('2019-10-01');
    const T = await type({ yearCycleOverride: 'a2a' });
    await ledger(emp.employmentId, T, 'accrual', 5, `${YEAR - 1}-10-01`);
    const d = await myLeaveDashboard(emp.ctx, emp.employmentId, { today: TODAY, year: String(YEAR - 1) });
    const c = d.cards.find((x) => x.leaveTypeId === T)!;
    const currentStartYear = TODAY >= `${YEAR}-10-01` ? YEAR : YEAR - 1;
    expect(c.cycleStart).toBe(`${currentStartYear - 1}-10-01`);
    expect(c.cycleEnd).toBe(`${currentStartYear}-09-30`);
  });
});

describe('the ring, the order, the hidden types, the Taken-only card', () => {
  it('the ring is for the Annual Leave type only — role first, the ANNUAL code as the fallback', async () => {
    const emp = await hire('2019-03-01');
    const byRole = await type({ code: 'AL', name: '*Annual Leave', role: 'annual' });
    const annualCodeOtherRole = await type({ code: 'ANNUAL2', name: 'Not annual', role: 'sick' });
    const sick = await type({ code: 'SICK', name: 'Medical Leave' });
    for (const t of [byRole, annualCodeOtherRole, sick]) await ledger(emp.employmentId, t, 'accrual', 1, `${YEAR}-01-01`);
    const d = await myLeaveDashboard(emp.ctx, emp.employmentId, { today: TODAY });
    const ring = (id: string) => d.cards.find((c) => c.leaveTypeId === id)!.annualLeave;
    expect(ring(b.annualLeaveTypeId), 'the seeded ANNUAL code, unclassified').toBe(true);
    expect(ring(byRole)).toBe(true);
    expect(ring(annualCodeOtherRole)).toBe(false);
    expect(ring(sick)).toBe(false);
    expect(d.cards.filter((c) => c.annualLeave).map((c) => c.leaveTypeId).sort()).toEqual([b.annualLeaveTypeId, byRole].sort());
  });

  it('Hidden types are absent; Primary types come before Secondary ones', async () => {
    const emp = await hire('2019-03-01');
    // Two ways a type resolves to Hidden: HR's switch (visible_to_employee = false — leaveBalances already drops
    // it) and a code-keyed DEFAULT with no HR choice (UNPAID_MEDICAL — leaveBalances keeps it with placement
    // 'hidden', and only the dashboard's own filter removes it). Both must be absent.
    const hidden = await type({ name: 'AAA Hidden', visibleToEmployee: false });
    const hiddenByDefault = await type({ name: 'AAA Unpaid medical', code: 'UNPAID_MEDICAL', visibleToEmployee: null });
    const secondary = await type({ name: 'AAA Secondary', essPlacement: 'secondary' });
    const primary = await type({ name: 'ZZZ Primary', essPlacement: 'primary' });
    for (const t of [hidden, hiddenByDefault, secondary, primary]) await ledger(emp.employmentId, t, 'accrual', 1, `${YEAR}-01-01`);
    const d = await myLeaveDashboard(emp.ctx, emp.employmentId, { today: TODAY });
    const ids = d.cards.map((c) => c.leaveTypeId);
    expect(ids).not.toContain(hidden);
    expect(ids).not.toContain(hiddenByDefault);
    // (sanity: the read under the dashboard does return it, marked hidden — so the absence above is the filter)
    expect((await leaveBalances(emp.ctx, emp.employmentId)).find((r) => r.leaveTypeId === hiddenByDefault)?.placement).toBe('hidden');
    expect(ids.indexOf(primary)).toBeGreaterThan(-1);
    expect(ids.indexOf(primary), 'Primary before Secondary, whatever the names say').toBeLessThan(ids.indexOf(secondary));
    const firstSecondary = d.cards.findIndex((c) => c.placement === 'secondary');
    expect(d.cards.slice(firstSecondary).every((c) => c.placement === 'secondary')).toBe(true);
  });

  it('a type with no entitlement shows Taken only — no Balance, no Pending, no Entitlement', async () => {
    const emp = await hire('2019-03-01');
    const unpaid = await type({ code: 'UNPAID', name: 'Unpaid Leave', paid: false, allowNegativeBalance: true });
    await ledger(emp.employmentId, unpaid, 'debit', -2, `${YEAR}-01-05`);
    const d = await myLeaveDashboard(emp.ctx, emp.employmentId, { today: TODAY });
    const c = d.cards.find((x) => x.leaveTypeId === unpaid)!;
    expect(c.takenOnly).toBe(true);
    expect(c.taken).toBe(2);
    expect([c.balance, c.pending, c.canApplyFor, c.entitlement, c.earnedSoFar]).toEqual([null, null, null, null, null]);
    // …while a type that HAS something on record in the cycle is not Taken-only.
    const credit = await type({ name: 'Credited' });
    await ledger(emp.employmentId, credit, 'accrual', 3, `${YEAR}-01-01`);
    const d2 = await myLeaveDashboard(emp.ctx, emp.employmentId, { today: TODAY });
    expect(d2.cards.find((x) => x.leaveTypeId === credit)!.takenOnly).toBe(false);
  });

  it('a figure HR hid from employees never crosses to the page', async () => {
    const emp = await hire('2019-03-01');
    const T = await type({ essViewConfig: { available: false, pendingApproval: false } });
    await ledger(emp.employmentId, T, 'accrual', 4, `${YEAR}-01-01`);
    const c = (await myLeaveDashboard(emp.ctx, emp.employmentId, { today: TODAY })).cards.find((x) => x.leaveTypeId === T)!;
    expect(c.balance).toBeNull();
    expect(c.canApplyFor).toBeNull();
    expect(c.pending).toBeNull();
    expect(c.taken).toBe(0);
  });
});

describe('Upcoming Leave — approved and pending from today onwards, soonest first', () => {
  it('includes approved + pending that have not ended; excludes past, rejected and cancelled; orders by start', async () => {
    const emp = await hire('2019-03-01');
    const T = await type();
    const insert = (start: string, end: string, status: 'pending' | 'approved' | 'rejected' | 'cancelled') =>
      owner.db
        .insert(schema.leaveRequest)
        .values({ tenantId: b.tenantId, employmentId: emp.employmentId, leaveTypeId: T, startDate: start, endDate: end, days: '1.00', status })
        .returning({ id: schema.leaveRequest.id })
        .then((r) => r[0].id);
    const later = await insert(addDays(TODAY, 30), addDays(TODAY, 31), 'pending');
    const soon = await insert(addDays(TODAY, 3), addDays(TODAY, 3), 'approved');
    const spanning = await insert(addDays(TODAY, -1), addDays(TODAY, 1), 'approved');
    const past = await insert(addDays(TODAY, -10), addDays(TODAY, -9), 'approved');
    const rejected = await insert(addDays(TODAY, 5), addDays(TODAY, 5), 'rejected');
    const cancelled = await insert(addDays(TODAY, 6), addDays(TODAY, 6), 'cancelled');
    const rows = await myUpcomingLeave(emp.ctx, [emp.employmentId], TODAY);
    expect(rows.map((r) => r.id)).toEqual([spanning, soon, later]);
    for (const gone of [past, rejected, cancelled]) expect(rows.map((r) => r.id)).not.toContain(gone);
    expect(await myUpcomingLeave(emp.ctx, [], TODAY)).toEqual([]);
  });
});
