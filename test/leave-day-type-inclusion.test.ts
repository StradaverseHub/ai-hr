/**
 * Leave Eligibility Rules — Day Type Inclusion (feedback ef6d7146).
 *
 * A working_days leave type gets five INDEPENDENT toggles deciding whether each day type is COUNTED when
 * calculating a leave's duration. This suite proves, end-to-end:
 *   (write) updateLeaveType folds the vector in as a tri-state (untouched-on-rename, before/after event,
 *           all-false → null normalisation).
 *   (count) requestLeave + previewLeaveDeduction + decideLeave honour the vector, and are byte-identical to
 *           today when the vector is null (the whole safety claim), and agree with each other (no drift).
 *   (cancel) partial cancellation gives back exactly the re-included weights it deducted.
 *
 * Fixture week (all working_days type, roster Mon–Fri, Sat/Sun rest):
 *   Mon 2026-07-27 · Tue 07-28 · Wed 07-29 (PUBLIC HOLIDAY) · Thu 07-30 · Fri 07-31 · Sat 08-01 · Sun 08-02
 *   Full span Mon..Sun. Legacy working-day count = Mon,Tue,Thu,Fri = 4 (Wed holiday + Sat/Sun rest skipped).
 */
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee, setReportingLine } from '../core/org';
import { updateLeaveType } from '../core/admin';
import { setAttendancePolicy } from '../core/attendance';
import {
  decideLeave,
  decideLeaveCancellation,
  requestLeave,
  requestLeaveCancellation,
  previewLeaveDeduction,
  normalizeDayTypeInclusion,
  type DayTypeInclusion,
} from '../core/leave';
import {
  adminCtx,
  closeAll,
  createAppUser,
  latestEventPayload,
  ledgerBalance,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

let b: Base;

const MON = '2026-07-27';
const WED = '2026-07-29'; // public holiday
const SUN = '2026-08-02';

const allOff: DayTypeInclusion = {
  offDay: false,
  restDay: false,
  publicHoliday: false,
  companyHoliday: false,
  shutdownDay: false,
};

async function monFriRoster() {
  await setAttendancePolicy(adminCtx(b), {
    companyId: b.companyId,
    workStart: '09:00',
    workEnd: '18:00',
    breakMinutes: 60,
    lateAfter: '09:15',
    halfDayBefore: '13:00',
    workingDays: [1, 2, 3, 4, 5],
    halfWorkingDays: [],
  });
}

async function seedPublicHoliday() {
  await owner.db.insert(schema.holiday).values({
    tenantId: b.tenantId,
    country: 'MY',
    state: null,
    companyId: null,
    holidayDate: WED,
    name: 'Test Public Holiday',
  });
}

const hire = () =>
  hireEmployee(adminCtx(b), {
    person: { fullName: 'DTI', primaryEmail: `dti_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });

/** A working_days leave type with a large granted balance so the balance gate never blocks. */
async function workingDaysType(dayTypeInclusion: Record<string, boolean> | null = null) {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: b.tenantId,
      code: `WD_${randomUUID().slice(0, 6).toUpperCase()}`,
      name: 'Working Days Leave',
      paid: true,
      counting: 'working_days',
      dayTypeInclusion,
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

async function grant(employmentId: string, leaveTypeId: string, days: string) {
  await owner.db.insert(schema.leaveLedger).values({
    tenantId: b.tenantId,
    employmentId,
    leaveTypeId,
    entryType: 'accrual',
    days,
    effectiveOn: '2026-01-01',
  });
}

const storedInclusion = async (id: string) => {
  const [row] = await owner.db
    .select({ v: schema.leaveType.dayTypeInclusion })
    .from(schema.leaveType)
    .where(eq(schema.leaveType.id, id));
  return row.v;
};

/** Full-span (Mon..Sun) count for a type via requestLeave — the headline "leave duration". */
async function spanDays(dayTypeInclusion: Record<string, boolean> | null) {
  const e = await hire();
  const t = await workingDaysType(dayTypeInclusion);
  await grant(e.employmentId, t, '30.00');
  const r = await requestLeave(adminCtx(b), {
    employmentId: e.employmentId,
    leaveTypeId: t,
    startDate: MON,
    endDate: SUN,
  });
  return r.days;
}

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  await monFriRoster();
  await seedPublicHoliday();
});
afterAll(async () => {
  await closeAll();
});

describe('normalizeDayTypeInclusion — the inert-vs-active guard', () => {
  it('null / non-object / all-false all normalise to undefined (byte-identical legacy path)', () => {
    expect(normalizeDayTypeInclusion(null)).toBeUndefined();
    expect(normalizeDayTypeInclusion(undefined)).toBeUndefined();
    expect(normalizeDayTypeInclusion('nope')).toBeUndefined();
    expect(normalizeDayTypeInclusion(allOff)).toBeUndefined();
  });
  it('any true flag yields a strict 5-key vector', () => {
    expect(normalizeDayTypeInclusion({ publicHoliday: true })).toEqual({
      offDay: false,
      restDay: false,
      publicHoliday: true,
      companyHoliday: false,
      shutdownDay: false,
    });
  });
});

describe('counting — the leave-duration calculation honours the vector', () => {
  it('GOLDEN: null vector counts working days only (Wed PH + Sat/Sun rest skipped) = 4', async () => {
    expect(await spanDays(null)).toBe(4);
  });
  it('publicHoliday only: also counts Wed = 5 (skip weekends, count PH)', async () => {
    expect(await spanDays({ ...allOff, publicHoliday: true })).toBe(5);
  });
  it('restDay only: also counts Sat + Sun = 6 (PH still skipped)', async () => {
    expect(await spanDays({ ...allOff, restDay: true })).toBe(6);
  });
  it('offDay only (Phase-A collapsed with restDay): also counts Sat + Sun = 6', async () => {
    expect(await spanDays({ ...allOff, offDay: true })).toBe(6);
  });
  it('ALL day types on: every calendar day counted = 7 (Example 2 behaviour)', async () => {
    expect(await spanDays({ offDay: true, restDay: true, publicHoliday: true, companyHoliday: true, shutdownDay: true })).toBe(7);
  });
});

describe('preview ⟷ submission ⟷ ledger consistency (no cross-site drift)', () => {
  it('previewLeaveDeduction, requestLeave.days and the debited ledger all agree under a set vector', async () => {
    const e = await hire();
    const t = await workingDaysType({ ...allOff, publicHoliday: true, restDay: true }); // PH + weekends re-included
    await grant(e.employmentId, t, '30.00');
    // preview
    const pv = await previewLeaveDeduction(adminCtx(b), {
      employmentId: e.employmentId,
      leaveTypeId: t,
      startDate: MON,
      endDate: SUN,
    });
    expect(pv.days).toBe(7); // 4 working + Wed PH + Sat + Sun
    // submit
    const r = await requestLeave(adminCtx(b), { employmentId: e.employmentId, leaveTypeId: t, startDate: MON, endDate: SUN });
    expect(r.days).toBe(pv.days);
    // approve → ledger debits exactly r.days
    await decideLeave(adminCtx(b), { leaveRequestId: r.leaveRequestId, decision: 'approved' });
    expect(await ledgerBalance(e.employmentId, t)).toBe(30 - 7);
  });
});

describe('partial cancellation gives back re-included weights (no over/under restore)', () => {
  it('cancelling a re-included public-holiday date restores exactly 1 day; survivors net zero', async () => {
    const e = await hire();
    // subject-only cancellation needs the employee's own session; the decide step needs a manager approver.
    const uSub = await createAppUser(b.tenantId, e.personId, 'employee');
    const subCtx = { tenantId: b.tenantId, userId: uSub, personId: e.personId, roles: ['employee'] };
    const mgr = await hire();
    const uMgr = await createAppUser(b.tenantId, mgr.personId, 'manager');
    await setReportingLine(adminCtx(b), {
      subordinateEmploymentId: e.employmentId,
      managerEmploymentId: mgr.employmentId,
      lineType: 'administrative',
      validFrom: '2024-01-01',
    });
    const mgrCtx = { tenantId: b.tenantId, userId: uMgr, personId: mgr.personId, roles: ['manager'] };

    const t = await workingDaysType({ ...allOff, publicHoliday: true }); // Wed PH counted (span = 5)
    await grant(e.employmentId, t, '30.00');
    const r = await requestLeave(adminCtx(b), { employmentId: e.employmentId, leaveTypeId: t, startDate: MON, endDate: SUN });
    expect(r.days).toBe(5);
    await decideLeave(adminCtx(b), { leaveRequestId: r.leaveRequestId, decision: 'approved' });
    expect(await ledgerBalance(e.employmentId, t)).toBe(25);
    // cancel the public holiday Wed (a strictly-future date vs the injected today)
    const cr = await requestLeaveCancellation(subCtx, {
      leaveRequestId: r.leaveRequestId,
      cancelDates: [WED],
      reason: 'test',
      today: '2026-07-01',
    });
    expect(Number(cr.requestedDays)).toBe(1); // the give-back preview weighs the re-included PH as 1
    await decideLeaveCancellation(mgrCtx, { cancellationRequestId: cr.cancellationRequestId, decision: 'approved' });
    // 5 deducted, Wed (weight 1) restored ⇒ balance back to 26 (net 4 consumed).
    expect(await ledgerBalance(e.employmentId, t)).toBe(26);
  });
});

describe('write path — tri-state + normalisation + before/after event', () => {
  it('setting a vector persists the strict object; an all-false vector normalises to null', async () => {
    const t = await workingDaysType(null);
    await updateLeaveType(adminCtx(b), { id: t, name: 'WD', dayTypeInclusion: { ...allOff, publicHoliday: true } });
    expect(await storedInclusion(t)).toEqual({ ...allOff, publicHoliday: true });
    // all-false collapses to null (inert)
    await updateLeaveType(adminCtx(b), { id: t, name: 'WD', dayTypeInclusion: { ...allOff } });
    expect(await storedInclusion(t)).toBeNull();
  });

  it('a rename that omits the marker leaves day_type_inclusion untouched (tri-state)', async () => {
    const t = await workingDaysType({ ...allOff, restDay: true });
    await updateLeaveType(adminCtx(b), { id: t, name: 'Renamed' }); // no dayTypeInclusion key
    expect(await storedInclusion(t)).toEqual({ ...allOff, restDay: true });
  });

  it('emits leave-type.updated with before/after dayTypeInclusion', async () => {
    const t = await workingDaysType(null);
    await updateLeaveType(adminCtx(b), { id: t, name: 'WD', dayTypeInclusion: { ...allOff, publicHoliday: true } });
    const payload = await latestEventPayload(b.tenantId, t, 'leave-type.updated');
    expect((payload?.before as Record<string, unknown>)?.dayTypeInclusion ?? null).toBeNull();
    expect((payload?.after as Record<string, unknown>)?.dayTypeInclusion).toEqual({
      ...allOff,
      publicHoliday: true,
    });
  });
});
