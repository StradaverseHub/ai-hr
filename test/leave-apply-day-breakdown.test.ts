/**
 * Employee Request-Leave popup enhancement — the day-by-day breakdown + the Pending/Taken/Balance summary.
 *
 * Two new read-only surfaces, both fed from the SAME computation the deduction line already uses:
 *   - previewLeaveDeduction(..., { includeDayRows: true }) folds the per-date detail into the call that
 *     already resolves the holiday set, the schedule and the weighted total — so the panel's "Leave applied"
 *     column can never contradict the "this will deduct N day(s)" figure printed above it. The LOAD-BEARING
 *     assertion here is Σ rows.days === days, run with company.leaveHalfDayFullDeduction both OFF and ON
 *     (the toggle flips a half day from 0.5 to 1.0 and is the likeliest place the two would drift apart).
 *   - leaveTypeApplySummary aggregates over ONE (employment, leave type) pair, so a selectable type with no
 *     ledger and no pending rows returns 0/0/0 rather than nothing (core/read.ts leaveBalances would have
 *     dropped it).
 *
 * Fixture week mirrors the reporter's own example: Tue 2026-07-21 … Mon 2026-07-27.
 *
 * Module mocks (for the leaveApplySummaryAction ESS-gating cases) mirror test/leave-rounding-persistence.ts,
 * the established precedent for driving a server action from the harness.
 */
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let actionCtx: import('../db/client').SessionContext | null = null;
vi.mock('../lib/session', () => ({ getSession: vi.fn(async () => actionCtx) }));
vi.mock('next/navigation', () => ({ redirect: vi.fn(() => undefined), notFound: vi.fn(() => undefined) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(() => undefined), revalidateTag: vi.fn(() => undefined) }));
vi.mock('next-intl/server', () => ({
  getLocale: async () => 'en',
  getTranslations: async () => (k: string) => k,
}));

import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setLeaveHalfDayFullDeduction } from '../core/admin';
import { setAttendancePolicy } from '../core/attendance';
import { previewLeaveDeduction, leaveTypeApplySummary, requestLeave } from '../core/leave';
import { leaveApplySummaryAction, previewLeaveDeductionAction } from '../app/leave/actions';
import type { SessionContext } from '../db/client';
import {
  adminCtx,
  closeAll,
  createAppUser,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

let b: Base;
let annualId: string;

const TUE = '2026-07-21';
const WED = '2026-07-22';
const THU = '2026-07-23';
const FRI = '2026-07-24';
const SAT = '2026-07-25';
const SUN = '2026-07-26';
const MON = '2026-07-27';

const hire = (name: string) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `apd_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });

/** Mon–Fri Full working days, nothing half. */
const setMonFri = () =>
  setAttendancePolicy(adminCtx(b), {
    companyId: b.companyId,
    workStart: '09:00',
    workEnd: '18:00',
    breakMinutes: 60,
    lateAfter: '09:15',
    halfDayBefore: '13:00',
    workingDays: [1, 2, 3, 4, 5],
    halfWorkingDays: [],
  });

/** Mon–Fri Full, Saturday Half. */
const setSaturdayHalf = () =>
  setAttendancePolicy(adminCtx(b), {
    companyId: b.companyId,
    workStart: '09:00',
    workEnd: '18:00',
    breakMinutes: 60,
    lateAfter: '09:15',
    halfDayBefore: '13:00',
    workingDays: [1, 2, 3, 4, 5],
    halfWorkingDays: [6],
  });

const seedHoliday = (date: string, name: string) =>
  owner.db.insert(schema.holiday).values({
    tenantId: b.tenantId,
    country: 'MY',
    state: null,
    companyId: b.companyId,
    holidayDate: date,
    name,
  });

const grantLedger = (employmentId: string, leaveTypeId: string, days: string) =>
  owner.db.insert(schema.leaveLedger).values({
    tenantId: b.tenantId,
    employmentId,
    leaveTypeId,
    entryType: 'accrual',
    days,
    effectiveOn: '2026-01-01',
  });

const rowsOf = async (ctx: SessionContext, employmentId: string, start: string, end: string) =>
  previewLeaveDeduction(ctx, {
    employmentId,
    leaveTypeId: annualId,
    startDate: start,
    endDate: end,
    durationType: 'full_day',
    includeDayRows: true,
  });

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  actionCtx = null;
  b = await seedBase();
  annualId = b.annualLeaveTypeId;
  await owner.db
    .update(schema.leaveType)
    .set({ counting: 'working_days' })
    .where(eq(schema.leaveType.id, annualId));
});
afterAll(async () => {
  await closeAll();
});

describe('day-by-day rows: schedule classification', () => {
  it('a Mon-Fri policy classifies Sat and Sun as rest_day and weekdays as working_day', async () => {
    await setMonFri();
    const e = await hire('Classify');
    const r = await rowsOf(adminCtx(b), e.employmentId, TUE, MON);
    expect(r.dayRows).toBeDefined();
    // Chronological order, one row per date in the span.
    expect(r.dayRows!.map((x) => x.date)).toEqual([TUE, WED, THU, FRI, SAT, SUN, MON]);
    const byDate = Object.fromEntries(r.dayRows!.map((x) => [x.date, x.status]));
    expect(byDate[TUE]).toBe('working_day');
    expect(byDate[FRI]).toBe('working_day');
    expect(byDate[MON]).toBe('working_day');
    // Rest and Off day are ONE bucket (dayWeight's Phase-A collapse) — both weekend days read rest_day.
    expect(byDate[SAT]).toBe('rest_day');
    expect(byDate[SUN]).toBe('rest_day');
    // A rest day deducts nothing; a full working day deducts 1.
    const w = Object.fromEntries(r.dayRows!.map((x) => [x.date, x.days]));
    expect(w[SAT]).toBe(0);
    expect(w[SUN]).toBe(0);
    expect(w[TUE]).toBe(1);
  });

  it('a half working day classifies as half_working_day and carries its 0.5 weight', async () => {
    await setSaturdayHalf();
    const e = await hire('HalfSat');
    const r = await rowsOf(adminCtx(b), e.employmentId, TUE, MON);
    const sat = r.dayRows!.find((x) => x.date === SAT)!;
    expect(sat.status).toBe('half_working_day');
    expect(sat.days).toBe(0.5);
    // Sunday is still a rest day — only Saturday carries the half marker.
    expect(r.dayRows!.find((x) => x.date === SUN)!.status).toBe('rest_day');
  });

  it('a gazetted holiday classifies as public_holiday and OUTRANKS the schedule', async () => {
    await setMonFri();
    await seedHoliday(WED, 'Test Gazette Day');
    const e = await hire('Holiday');
    const r = await rowsOf(adminCtx(b), e.employmentId, TUE, MON);
    const wed = r.dayRows!.find((x) => x.date === WED)!;
    // Wednesday IS on the Mon-Fri roster — the holiday classification must win.
    expect(wed.status).toBe('public_holiday');
    expect(wed.days).toBe(0);
  });
});

describe('LOAD-BEARING: the rows always sum to the reported deducted days', () => {
  it('Mon-Fri, no half markers: Σ rows.days === days', async () => {
    await setMonFri();
    const e = await hire('SumPlain');
    const r = await rowsOf(adminCtx(b), e.employmentId, TUE, MON);
    const sum = r.dayRows!.reduce((a, x) => a + x.days, 0);
    expect(Math.round(sum * 100) / 100).toBe(r.days);
    expect(r.days).toBe(5); // Tue-Fri + Mon
  });

  it('half-day toggle OFF (0.5) and ON (1.0): Σ rows.days === days in BOTH states', async () => {
    await setSaturdayHalf();
    const e = await hire('SumHalfOff');
    const off = await rowsOf(adminCtx(b), e.employmentId, TUE, MON);
    expect(Math.round(off.dayRows!.reduce((a, x) => a + x.days, 0) * 100) / 100).toBe(off.days);
    expect(off.days).toBe(5.5); // Tue-Fri + Mon = 5, Sat = 0.5
    expect(off.dayRows!.find((x) => x.date === SAT)!.days).toBe(0.5);

    await setLeaveHalfDayFullDeduction(adminCtx(b), { companyId: b.companyId, enabled: true });
    const e2 = await hire('SumHalfOn');
    const on = await rowsOf(adminCtx(b), e2.employmentId, TUE, MON);
    expect(Math.round(on.dayRows!.reduce((a, x) => a + x.days, 0) * 100) / 100).toBe(on.days);
    expect(on.days).toBe(6); // the toggle promotes the half Saturday to a whole day
    // The row's own weight moved with the toggle — the panel total tracks the deduction line.
    expect(on.dayRows!.find((x) => x.date === SAT)!.days).toBe(1);
    // …but the LABEL still says half working day (it describes the schedule, not the deduction).
    expect(on.dayRows!.find((x) => x.date === SAT)!.status).toBe('half_working_day');
  });

  it('a holiday inside the span keeps the rows and the total in agreement', async () => {
    await setMonFri();
    await seedHoliday(WED, 'Test Gazette Day');
    const e = await hire('SumHoliday');
    const r = await rowsOf(adminCtx(b), e.employmentId, TUE, MON);
    expect(Math.round(r.dayRows!.reduce((a, x) => a + x.days, 0) * 100) / 100).toBe(r.days);
    expect(r.days).toBe(4);
  });
});

describe('day-by-day rows: guards', () => {
  it('end < start yields NO rows', async () => {
    await setMonFri();
    const e = await hire('Backwards');
    const r = await rowsOf(adminCtx(b), e.employmentId, MON, TUE);
    expect(r.dayRows).toBeUndefined();
  });

  it('a span over 400 dates yields NO rows (the link simply does not appear)', async () => {
    await setMonFri();
    const e = await hire('Huge');
    const r = await rowsOf(adminCtx(b), e.employmentId, '2026-01-01', '2027-03-01'); // 425 dates
    expect(r.dayRows).toBeUndefined();
    // …while a span at the limit still renders.
    const ok = await rowsOf(adminCtx(b), e.employmentId, '2026-01-01', '2027-02-04'); // 400 dates
    expect(ok.dayRows).toHaveLength(400);
  });

  it('omitting includeDayRows leaves the call byte-identical (no dayRows key)', async () => {
    await setMonFri();
    const e = await hire('NoFlag');
    const r = await previewLeaveDeduction(adminCtx(b), {
      employmentId: e.employmentId,
      leaveTypeId: annualId,
      startDate: TUE,
      endDate: MON,
      durationType: 'full_day',
    });
    expect('dayRows' in r).toBe(false);
    expect(r.days).toBe(5);
  });

  it('an employment the caller cannot see yields NO rows, not a fabricated Mon-Fri calendar', async () => {
    await setMonFri();
    const subject = await hire('Subject');
    const peer = await hire('Peer');
    const uPeer = await createAppUser(b.tenantId, peer.personId, 'employee');
    const peerCtx: SessionContext = {
      tenantId: b.tenantId,
      userId: uPeer,
      personId: peer.personId,
      roles: ['employee'],
    };
    // resolveSchedule falls back to Mon-Fri when its employment join is RLS-empty, so without the explicit
    // employment guard this would have rendered a confident invented schedule for someone else's dates.
    const r = await rowsOf(peerCtx, subject.employmentId, TUE, MON);
    expect(r.dayRows).toBeUndefined();
    // The peer CAN still see their own.
    const own = await rowsOf(peerCtx, peer.employmentId, TUE, MON);
    expect(own.dayRows).toHaveLength(7);
  });
});

describe('leaveTypeApplySummary: Pending / Taken / Balance', () => {
  it('a type with no ledger and no pending rows yields 0 / 0 / 0 rather than nothing', async () => {
    const e = await hire('Empty');
    const s = await leaveTypeApplySummary(adminCtx(b), {
      employmentId: e.employmentId,
      leaveTypeId: annualId,
    });
    expect(s).toMatchObject({ pending: 0, taken: 0, balance: 0 });
  });

  it('Pending reflects other PENDING requests; Balance is the raw ledger balance the preview also shows', async () => {
    await setMonFri();
    const e = await hire('Figures');
    await grantLedger(e.employmentId, annualId, '10.00');
    await requestLeave(adminCtx(b), {
      employmentId: e.employmentId,
      leaveTypeId: annualId,
      startDate: TUE,
      endDate: WED,
    });
    const s = await leaveTypeApplySummary(adminCtx(b), {
      employmentId: e.employmentId,
      leaveTypeId: annualId,
    });
    expect(s.pending).toBe(2);
    expect(s.taken).toBe(0);
    expect(s.balance).toBe(10);
    // 082fa566: Available is the balance NET of that 2-day reservation — the figure the leave type's own
    // Leave Summary shows, and the one the submit-time guard measures against.
    expect(s.available).toBe(8);
    // Balance (gross) IS the preview line's "balance before" — one number by construction.
    const p = await rowsOf(adminCtx(b), e.employmentId, THU, FRI);
    expect(p.balanceAvailable).toBe(s.balance);
  });

  it('Taken counts approved debits', async () => {
    const e = await hire('Taken');
    await grantLedger(e.employmentId, annualId, '10.00');
    await owner.db.insert(schema.leaveLedger).values({
      tenantId: b.tenantId,
      employmentId: e.employmentId,
      leaveTypeId: annualId,
      entryType: 'debit',
      days: '-3.00',
      effectiveOn: '2026-02-01',
    });
    const s = await leaveTypeApplySummary(adminCtx(b), {
      employmentId: e.employmentId,
      leaveTypeId: annualId,
    });
    expect(s.taken).toBe(3);
    expect(s.balance).toBe(7);
  });
});

describe('leaveApplySummaryAction: ESS gating vs the on-behalf escape hatch', () => {
  it('a self-service employee gets their OWN figures, gated by ess_view_config', async () => {
    const e = await hire('Self');
    await grantLedger(e.employmentId, annualId, '10.00');
    // HR hid "Pending approval" from the employee view; Available and Taken stay visible, so Balance — which
    // 082fa566 made the row Available is derived from — stays visible with them.
    await owner.db
      .update(schema.leaveType)
      .set({ essViewConfig: { pendingApproval: false } })
      .where(eq(schema.leaveType.id, annualId));
    const uid = await createAppUser(b.tenantId, e.personId, 'employee');
    actionCtx = { tenantId: b.tenantId, userId: uid, personId: e.personId, roles: ['employee'] };

    // No employmentId posted — the self-service form does not render the Employee selector.
    const s = await leaveApplySummaryAction({ employmentId: '', leaveTypeId: annualId });
    expect(s).not.toBeNull();
    expect(s!.pending).toBeNull(); // gated out ⇒ renders as a dash
    expect(s!.taken).toBe(0);
    expect(s!.balance).toBe(10);
    expect(s!.available).toBe(10);
  });

  it('hiding Available hides the gross Balance with it (082fa566: no leak through the derivation)', async () => {
    const e = await hire('GatedAvail');
    await grantLedger(e.employmentId, annualId, '10.00');
    // Balance carries no ess-view key of its own, but it is now the figure Available is visibly derived FROM.
    // Handing it back while Available is hidden would show HR's hidden number in the next column along — the
    // same leak deriveBalanceRow closes on the balance table with the same two-key test.
    await owner.db
      .update(schema.leaveType)
      .set({ essViewConfig: { available: false } })
      .where(eq(schema.leaveType.id, annualId));
    const uid = await createAppUser(b.tenantId, e.personId, 'employee');
    actionCtx = { tenantId: b.tenantId, userId: uid, personId: e.personId, roles: ['employee'] };

    const s = await leaveApplySummaryAction({ employmentId: '', leaveTypeId: annualId });
    expect(s!.available).toBeNull();
    expect(s!.balance).toBeNull();
    expect(s!.taken).toBe(0); // its own key is untouched
  });

  it('an admin applying ON BEHALF gets that employee\'s figures UNGATED', async () => {
    const e = await hire('Behalf');
    await grantLedger(e.employmentId, annualId, '10.00');
    await owner.db
      .update(schema.leaveType)
      .set({ essViewConfig: { pendingApproval: false, taken: false } })
      .where(eq(schema.leaveType.id, annualId));
    actionCtx = adminCtx(b); // hr_admin, personId absent ⇒ not the caller's own employment

    const s = await leaveApplySummaryAction({ employmentId: e.employmentId, leaveTypeId: annualId });
    // 082fa566: Available rides along with the other three, and on the on-behalf path none of them is gated.
    expect(s).toEqual({ pending: 0, taken: 0, balance: 10, available: 10 });
  });

  it('returns null (never throws) with no leave type', async () => {
    actionCtx = adminCtx(b);
    expect(await leaveApplySummaryAction({ employmentId: '', leaveTypeId: '' })).toBeNull();
  });
});

describe('previewLeaveDeductionAction: the dead self-service preview is alive', () => {
  it('resolves the caller\'s own employment when none is posted, and returns day rows', async () => {
    await setMonFri();
    const e = await hire('SelfPreview');
    await grantLedger(e.employmentId, annualId, '10.00');
    const uid = await createAppUser(b.tenantId, e.personId, 'employee');
    actionCtx = { tenantId: b.tenantId, userId: uid, personId: e.personId, roles: ['employee'] };

    // Before the fix this returned null for every plain employee (empty employmentId short-circuit).
    const r = await previewLeaveDeductionAction({
      employmentId: '',
      leaveTypeId: annualId,
      startDate: TUE,
      endDate: MON,
      durationType: 'full_day',
    });
    expect(r).not.toBeNull();
    expect(r!.days).toBe(5);
    expect(r!.balanceAvailable).toBe(10);
    expect(r!.dayRows).toHaveLength(7);
    expect(Math.round(r!.dayRows!.reduce((a, x) => a + x.days, 0) * 100) / 100).toBe(r!.days);
  });
});
