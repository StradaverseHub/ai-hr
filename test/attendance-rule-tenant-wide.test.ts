/**
 * 6da67ab7 — "Remove Company-Level Segregation from Attendance Policy (Bind Directly to Shift Setting)".
 *
 * The reporter's model: an attendance rule is not a property of a company, it is a property of the SHIFT, and
 * whichever shift an employee is assigned to decides the rules that apply "regardless of company".
 *
 * Migration 0319 made attendance_rule tenant-wide (the same treatment shift templates got in 0197). What is
 * pinned here:
 *   1. A rule created with no company at all applies to an employee of ANY company through the shift.
 *      Before this change the rule carried a NOT NULL company_id and the shift-form picker filtered by the
 *      admin's company scope, so a shared shift could only ever offer one company's rules.
 *   2. There is exactly ONE Standard (is_default) rule per tenant, and rule names are unique tenant-wide.
 *   3. The Standard fallback for a shift with no rule_id is now the TENANT Standard, resolved without any
 *      reference to the employee's company.
 *
 * NOT changed, and re-pinned here on purpose: attendance_policy stays per company, because it is the
 * schedule for a day with NO shift — see test/attendance-shift-window.test.ts, which holds the legacy
 * duration/6h-cliff math on that branch.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { checkIn, checkOut } from '../core/attendance';
import {
  createAttendanceRule,
  ensureStandardRule,
  listAttendanceRules,
  updateAttendanceRule,
  type AttendanceRuleInput,
} from '../core/attendance-rule';
import { assignDefaultShift, createShift } from '../core/roster';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const WED = '2026-07-01'; // ISO weekday 3
let b: Base;

/** A second company in the SAME tenant — the axis the item removes. */
async function otherCompany(): Promise<string> {
  const [c] = await owner.db
    .insert(schema.company)
    .values({ tenantId: b.tenantId, legalName: `Other ${randomUUID().slice(0, 8)} Sdn Bhd` })
    .returning({ id: schema.company.id });
  return c.id;
}

async function makeEmp(companyId: string) {
  const [p] = await owner.db
    .insert(schema.person)
    .values({ tenantId: b.tenantId, fullName: 'Cross Co', primaryEmail: `xco_${randomUUID()}@t.local` })
    .returning({ id: schema.person.id });
  const [e] = await owner.db
    .insert(schema.employment)
    .values({ tenantId: b.tenantId, personId: p.id, companyId, hiredOn: '2020-01-01' })
    .returning({ id: schema.employment.id });
  return e.id;
}

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

describe('6da67ab7 — the rule reaches the employee through the SHIFT, not through their company', () => {
  it('one tenant-wide rule on one shared shift governs employees of two different companies', async () => {
    const a = adminCtx(b);
    const second = await otherCompany();
    // A single strict rule (no grace) and a single shift carrying it — authored once, no company anywhere.
    const strict = await createAttendanceRule(a, ruleInput('Strict', { lateGracePeriodMinutes: 0 }));
    const shift = await createShift(a, workdayShift({ ruleId: strict.id }));

    for (const companyId of [b.companyId, second]) {
      const emp = await makeEmp(companyId);
      await assignDefaultShift(a, { employmentId: emp, shiftId: shift.id });
      const r = await checkIn(a, { employmentId: emp, date: WED, time: '09:05:00' });
      expect(r.status).toBe('late'); // grace 0 — the same verdict on both sides of the company line
    }
  });

  it('the rule, not the employee’s company, decides the OT figure', async () => {
    const a = adminCtx(b);
    const second = await otherCompany();
    const rounded = await createAttendanceRule(
      a,
      ruleInput('Round30', {
        lateGracePeriodMinutes: 60, // keep both days 'present' so status never clouds the OT figure
        otRows: [{ fromMinutes: 0, toMinutes: 0, ratePattern: 'flat', rate: 1.5, rounding: true, roundToMinutes: 30 }],
      }),
    );
    const shift = await createShift(a, workdayShift({ ruleId: rounded.id }));

    for (const companyId of [b.companyId, second]) {
      const emp = await makeEmp(companyId);
      await assignDefaultShift(a, { employmentId: emp, shiftId: shift.id });
      await checkIn(a, { employmentId: emp, date: WED, time: '09:00:00' });
      // 70 minutes past the 18:00 shift end → the band floors it to a multiple of 30.
      const out = await checkOut(a, { employmentId: emp, date: WED, time: '19:10:00' });
      expect(out.otMinutes).toBe(60);
    }
  });
});

describe('6da67ab7 — one Standard, one library, no company axis', () => {
  it('ensureStandardRule is a tenant singleton however many companies exist', async () => {
    const a = adminCtx(b);
    await otherCompany();
    const first = await ensureStandardRule(a);
    const again = await ensureStandardRule(a);
    expect(again.id).toBe(first.id);
    expect(again.created).toBe(false);
    const defaults = await owner.db
      .select({ id: schema.attendanceRule.id })
      .from(schema.attendanceRule)
      .where(eq(schema.attendanceRule.isDefault, true));
    expect(defaults).toHaveLength(1);
  });

  it('rule names are unique tenant-wide and the library lists without a company argument', async () => {
    const a = adminCtx(b);
    await ensureStandardRule(a);
    await createAttendanceRule(a, ruleInput('Night Rules'));
    await expect(createAttendanceRule(a, ruleInput('night rules'))).rejects.toThrow(/already exists/);
    const names = (await listAttendanceRules(a)).map((r) => r.name);
    expect(names).toEqual(['Standard', 'Night Rules']); // Standard first, then by name
  });

  it('a shift with no rule falls back to the tenant Standard for an employee of any company', async () => {
    const a = adminCtx(b);
    const second = await otherCompany();
    const { id: stdId } = await ensureStandardRule(a);
    await updateAttendanceRule(a, { ruleId: stdId, ...ruleInput('Standard', { lateGracePeriodMinutes: 20 }) });
    const shift = await createShift(a, workdayShift()); // no ruleId

    const emp = await makeEmp(second);
    await assignDefaultShift(a, { employmentId: emp, shiftId: shift.id });
    expect((await checkIn(a, { employmentId: emp, date: WED, time: '09:18:00' })).status).toBe('present');

    const emp2 = await makeEmp(second);
    await assignDefaultShift(a, { employmentId: emp2, shiftId: shift.id });
    expect((await checkIn(a, { employmentId: emp2, date: WED, time: '09:25:00' })).status).toBe('late');
  });

  it('an employee with NO shift still resolves the tenant Standard on the policy branch', async () => {
    // The company-policy branch is the no-shift fallback 6da67ab7 deliberately kept: it still supplies the
    // company's SCHEDULE and the legacy duration OT (pinned in test/attendance-shift-window.test.ts). What
    // changed is only which Standard rule it carries — the tenant's, resolved without the employee's company.
    const a = adminCtx(b);
    const second = await otherCompany();
    const { id: stdId } = await ensureStandardRule(a);
    await updateAttendanceRule(a, {
      ruleId: stdId,
      ...ruleInput('Standard', {
        otRows: [{ fromMinutes: 0, toMinutes: 0, ratePattern: 'flat', rate: 1.5, rounding: true, roundToMinutes: 30 }],
      }),
    });

    const emp = await makeEmp(second);
    await checkIn(a, { employmentId: emp, date: WED, time: '09:00:00' });
    // Legacy duration math is untouched: 610 span − 60 break = 550 worked, 550 − 480 scheduled = 70 OT.
    // The tenant Standard's band then floors that 70 to a multiple of 30.
    const out = await checkOut(a, { employmentId: emp, date: WED, time: '19:10:00' });
    expect(out).toMatchObject({ workedMinutes: 550, otMinutes: 60 });
  });
});
