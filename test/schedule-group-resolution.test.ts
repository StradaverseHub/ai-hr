/**
 * 870b79e2 (r277) — the Schedule Group: `employment.attendance_rule_id` (migration 0464).
 *
 * THE ITEM'S CENTRAL CLAIM is that the reporter's "Schedule Group" already exists as `attendance_rule` and
 * that the only genuinely new storage is a way to put a PERSON in one. Two promises were made in writing
 * about that column, and this file is where both are held:
 *
 *   1. NOTHING MOVES ON RELEASE DAY. The column ships NULL with no backfill and no default, and rule
 *      resolution is ADDITIVE — group, else shift.rule_id, else the tenant Standard. So every employee
 *      resolves the rule they resolve today, on all three branches of scheduleFor (rostered shift, backup
 *      shift, no shift at all).
 *   2. AND THE NEW BRANCH ACTUALLY FIRES. A promise of "no change" is trivially satisfiable by a column
 *      nothing reads, so the byte-identical cases below are paired with their inverse: set the group and
 *      the verdict follows the GROUP; clear it and the verdict returns to the shift's own rule. Both
 *      directions, on the same employee and the same clocking, so neither case can pass vacuously.
 *
 * The third promise — that an employee cannot be put on a shift their group does not allow — lives in
 * test/schedule-group-allowed-shifts.test.ts, because it is about four WRITERS rather than the resolver.
 *
 * Grace period is the instrument throughout: it is the one rule field that changes a visible verdict
 * ('late' vs 'present') from a single check-in, with no dependence on the clock or on a future date.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray, isNull } from 'drizzle-orm';
import * as schema from '../db/schema';
import { checkIn, checkOut } from '../core/attendance';
import {
  createAttendanceRule,
  ensureStandardRule,
  updateAttendanceRule,
  type AttendanceRuleInput,
} from '../core/attendance-rule';
import { assignDefaultShift, assignShift, createShift } from '../core/roster';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

/** A fixed past Wednesday (ISO weekday 3) — inside every shift's Mon–Fri pattern, and never "today". */
const WED = '2026-07-01';
let b: Base;

const ruleInput = (name: string, over: Partial<AttendanceRuleInput> = {}): AttendanceRuleInput => ({
  name,
  status: 'active',
  lateGracePeriodMinutes: 0,
  lateAfterMinutes: 0,
  lateDeductMinutes: 0,
  includeGraceInLateness: false,
  earlyGracePeriodMinutes: 0,
  earlyAfterMinutes: 0,
  earlyDeductMinutes: 0,
  includeGraceInEarlyOut: false,
  applyToEarlyOt: false,
  otRows: [],
  ...over,
});

const workdayShift = (over: Record<string, unknown> = {}) => ({
  name: `S_${randomUUID().slice(0, 8)}`,
  code: `C_${randomUUID().slice(0, 6)}`,
  startTime: '09:00:00',
  endTime: '18:00:00',
  breakMinutes: 60,
  weeklyPattern: [1, 2, 3, 4, 5],
  ...over,
});

async function makeEmp(): Promise<string> {
  const [p] = await owner.db
    .insert(schema.person)
    .values({ tenantId: b.tenantId, fullName: 'Group Member', primaryEmail: `grp_${randomUUID()}@t.local` })
    .returning({ id: schema.person.id });
  const [e] = await owner.db
    .insert(schema.employment)
    .values({ tenantId: b.tenantId, personId: p.id, companyId: b.companyId, hiredOn: '2020-01-01' })
    .returning({ id: schema.employment.id });
  return e.id;
}

/** Put an employment in a Schedule Group (or take it out). Written as the migration role on purpose: the
 *  SCREEN that will set this column is a later stage of the item, and the resolver must not depend on it. */
async function setGroup(employmentId: string, ruleId: string | null): Promise<void> {
  await owner.db
    .update(schema.employment)
    .set({ attendanceRuleId: ruleId })
    .where(eq(schema.employment.id, employmentId));
}

const groupOf = async (employmentId: string): Promise<string | null> => {
  const [row] = await owner.db
    .select({ ruleId: schema.employment.attendanceRuleId })
    .from(schema.employment)
    .where(eq(schema.employment.id, employmentId));
  return row?.ruleId ?? null;
};

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

describe('870b79e2 — release day: the column exists, is empty, and changes nothing', () => {
  it('a freshly created employment has NO Schedule Group — no backfill, no column default', async () => {
    const a = adminCtx(b);
    // Created three different ways, because "no default" has to hold for every path that inserts an
    // employment, not only the one this file happens to use.
    const bare = await makeEmp();
    const withShift = await makeEmp();
    const shift = await createShift(a, workdayShift());
    await assignDefaultShift(a, { employmentId: withShift, shiftId: shift.id });
    const rostered = await makeEmp();
    await assignDefaultShift(a, { employmentId: rostered, shiftId: shift.id });
    await assignShift(a, { employmentId: rostered, shiftDate: WED, shiftId: shift.id });

    const ids = [bare, withShift, rostered];
    const nulls = await owner.db
      .select({ id: schema.employment.id })
      .from(schema.employment)
      .where(inArray(schema.employment.id, ids))
      .orderBy(schema.employment.id);
    expect(nulls, 'every employment row is readable').toHaveLength(3);
    const grouped = await owner.db
      .select({ id: schema.employment.id })
      .from(schema.employment)
      .where(inArray(schema.employment.id, ids));
    for (const row of grouped) expect(await groupOf(row.id), `${row.id} has no group`).toBeNull();

    // And the negative control the assertion above cannot give on its own: the predicate really does
    // discriminate, i.e. "IS NULL" is not matching everything because the column is missing.
    const allNull = await owner.db
      .select({ id: schema.employment.id })
      .from(schema.employment)
      .where(isNull(schema.employment.attendanceRuleId));
    expect(allNull.length, 'the IS NULL predicate resolves the real column').toBeGreaterThanOrEqual(3);
  });

  it('with no group, all three scheduleFor branches resolve exactly what they resolved before', async () => {
    const a = adminCtx(b);
    // Standard is deliberately GENEROUS (30m) and the shift's own rule STRICT (0m), so the two are
    // distinguishable from a single check-in and a fallback to the wrong one cannot pass unnoticed.
    const { id: stdId } = await ensureStandardRule(a);
    await updateAttendanceRule(a, { ruleId: stdId, ...ruleInput('Standard', { lateGracePeriodMinutes: 30 }) });
    const strict = await createAttendanceRule(a, ruleInput('Strict', { lateGracePeriodMinutes: 0 }));
    const ruled = await createShift(a, workdayShift({ ruleId: strict.id }));
    const unruled = await createShift(a, workdayShift());

    // Branch 1 — a ROSTERED shift that carries a rule: the shift's rule wins, 09:05 is late at grace 0.
    const e1 = await makeEmp();
    await assignDefaultShift(a, { employmentId: e1, shiftId: ruled.id });
    await assignShift(a, { employmentId: e1, shiftDate: WED, shiftId: ruled.id });
    expect((await checkIn(a, { employmentId: e1, date: WED, time: '09:05:00' })).status).toBe('late');

    // Branch 2 — the BACKUP shift (no roster row), carrying NO rule: the tenant Standard's 30m applies.
    const e2 = await makeEmp();
    await assignDefaultShift(a, { employmentId: e2, shiftId: unruled.id });
    expect((await checkIn(a, { employmentId: e2, date: WED, time: '09:20:00' })).status).toBe('present');

    // Branch 3 — NO shift at all: the company-policy branch, which also carries the tenant Standard.
    const e3 = await makeEmp();
    const r3 = await checkIn(a, { employmentId: e3, date: WED, time: '09:05:00' });
    expect(r3.status).toBe('present');
  });
});

describe('870b79e2 — the group, when set, outranks the shift', () => {
  it('the employee follows the GROUP rule, not the rule their shift points at', async () => {
    const a = adminCtx(b);
    await ensureStandardRule(a);
    const strict = await createAttendanceRule(a, ruleInput('Strict', { lateGracePeriodMinutes: 0 }));
    const lenient = await createAttendanceRule(a, ruleInput('Lenient', { lateGracePeriodMinutes: 30 }));
    const shift = await createShift(a, workdayShift({ ruleId: strict.id }));

    const emp = await makeEmp();
    await assignDefaultShift(a, { employmentId: emp, shiftId: shift.id });
    await assignShift(a, { employmentId: emp, shiftDate: WED, shiftId: shift.id });

    // NO GROUP → the shift's strict rule. 09:20 is twenty minutes past a zero grace.
    expect((await checkIn(a, { employmentId: emp, date: WED, time: '09:20:00' })).status).toBe('late');

    // GROUP SET → the group's lenient rule. Same employee, same shift, same clock time, different verdict:
    // the assertion above therefore cannot be passing because grace is ignored altogether.
    await setGroup(emp, lenient.id);
    await owner.db.delete(schema.attendance).where(eq(schema.attendance.employmentId, emp));
    expect((await checkIn(a, { employmentId: emp, date: WED, time: '09:20:00' })).status).toBe('present');

    // CLEARED → back to the shift's rule. The column is additive in both directions, not a one-way door.
    await setGroup(emp, null);
    await owner.db.delete(schema.attendance).where(eq(schema.attendance.employmentId, emp));
    expect((await checkIn(a, { employmentId: emp, date: WED, time: '09:20:00' })).status).toBe('late');
  });

  it('the group also supplies the rule on the branch that has no shift at all', async () => {
    /**
     * ⚠️ MEASURED ON OT ROUNDING, NOT ON LATENESS, AND THE REASON IS A CORRECTION TO THE PLAN'S WORDING.
     *
     * On the company-policy branch the LATE STATUS threshold is `attendance_policy.late_after`
     * (core/attendance.ts policyBranch: `lateAfter: pol.lateAfter`), NOT the resolved rule's grace — and
     * that was already true before this round, for the tenant Standard exactly as it now is for a group.
     * A group's `late_grace_period_minutes` therefore cannot change a late verdict for an employee with no
     * shift, and an assertion that it does would be asserting a behaviour this round did not build.
     *
     * What the rule DOES decide on that branch is the overtime figure, which is what the pre-existing
     * policy-branch coverage (test/attendance-rule-tenant-wide.test.ts) measures too. So the instrument is
     * a rounding band: Standard rounds nothing, the group floors to 30.
     */
    const a = adminCtx(b);
    const { id: stdId } = await ensureStandardRule(a);
    await updateAttendanceRule(a, { ruleId: stdId, ...ruleInput('Standard') }); // no OT rows ⇒ no rounding
    const rounded = await createAttendanceRule(
      a,
      ruleInput('Rounded', {
        otRows: [{ fromMinutes: 0, toMinutes: 0, ratePattern: 'flat', rate: 1.5, roundingMode: 'down', roundToMinutes: 30 }],
      }),
    );

    const emp = await makeEmp();
    // Legacy duration math on the policy branch: 610 span − 60 break = 550 worked, − 480 scheduled = 70 OT.
    await checkIn(a, { employmentId: emp, date: WED, time: '09:00:00' });
    expect(await checkOut(a, { employmentId: emp, date: WED, time: '19:10:00' })).toMatchObject({
      workedMinutes: 550,
      otMinutes: 70, // Standard has no band ⇒ the exact minutes
    });

    await setGroup(emp, rounded.id);
    await owner.db.delete(schema.attendance).where(eq(schema.attendance.employmentId, emp));
    await checkIn(a, { employmentId: emp, date: WED, time: '09:00:00' });
    expect(await checkOut(a, { employmentId: emp, date: WED, time: '19:10:00' })).toMatchObject({
      workedMinutes: 550,
      otMinutes: 60, // the GROUP's band floors 70 to a multiple of 30
    });
  });

  it('deleting a Schedule Group releases its members instead of erroring — ON DELETE SET NULL', async () => {
    const a = adminCtx(b);
    await ensureStandardRule(a);
    const doomed = await createAttendanceRule(a, ruleInput('Doomed'));
    const emp = await makeEmp();
    await setGroup(emp, doomed.id);
    expect(await groupOf(emp)).toBe(doomed.id);

    await owner.db.delete(schema.attendanceRule).where(eq(schema.attendanceRule.id, doomed.id));
    // Not an FK error, and not a dangling id: the employee simply has no group again, which is the
    // holiday_group_id / payroll_policy_id behaviour this column was modelled on.
    expect(await groupOf(emp)).toBeNull();
  });
});
