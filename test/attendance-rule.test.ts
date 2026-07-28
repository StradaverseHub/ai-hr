/**
 * 88e94371 — "Lateness, Early Out & Overtime Settings" rule library. Golden tests:
 *   1. applyOtRuleRows (pure): OT-band rounding + early-OT inclusion; Standard/no-rows leaves OT untouched.
 *   2. Standard fallback — a shift with no rule_id resolves to the TENANT Standard rule's grace in the REAL
 *      engine (checkIn status), not a display figure. (6da67ab7 made the library tenant-wide; before that
 *      the fallback was the employee's-company Standard.)
 *   3. Per-shift rule override — a shift pointing at a custom rule uses ITS grace, beating the Standard.
 *   4. OT rows drive workday OT rounding through checkOut (deriveAttendance) — rule with a rounding band
 *      rounds ot_minutes; no rule leaves it raw.
 *   5. Existing-policy → Standard conversion preserves the late threshold (ensureStandardRule seeds late
 *      grace from the company policy = migration 0203's formula), and the Standard rule is un-deletable.
 *   6. Substrate — rule CRUD + shift-rule assignment append DomainEvents.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, eventTypesFor, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { checkIn, checkOut } from '../core/attendance';
import { assignDefaultShift, createShift, updateShift } from '../core/roster';
import {
  applyOtRuleRows,
  createAttendanceRule,
  deleteAttendanceRule,
  ensureStandardRule,
  getAttendanceRule,
  StandardRuleUndeletableError,
  type ResolvedAttendanceRule,
} from '../core/attendance-rule';

const WED = '2026-07-01'; // ISO weekday 3
let b: Base;

async function makeEmp() {
  const [p] = await owner.db
    .insert(schema.person)
    .values({ tenantId: b.tenantId, fullName: 'Rule', primaryEmail: `rule_${randomUUID()}@t.local` })
    .returning({ id: schema.person.id });
  const [e] = await owner.db
    .insert(schema.employment)
    .values({ tenantId: b.tenantId, personId: p.id, companyId: b.companyId, hiredOn: '2020-01-01' })
    .returning({ id: schema.employment.id });
  return e.id;
}

const workdayShift = (over: Record<string, unknown> = {}) => ({
  companyId: b.companyId,
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

describe('applyOtRuleRows (pure)', () => {
  const ruleWith = (over: Partial<ResolvedAttendanceRule> = {}): ResolvedAttendanceRule => ({
    id: 'r',
    isDefault: false,
    lateGracePeriodMinutes: 0,
    earlyGracePeriodMinutes: 0,
    applyToEarlyOt: false,
    otRows: [],
    ...over,
  });

  it('no rule / no rows leaves OT unchanged', () => {
    expect(applyOtRuleRows(70, 0, null)).toBe(70);
    expect(applyOtRuleRows(70, 0, ruleWith())).toBe(70);
  });

  it('rounds OT to the matching band round-to value (nearest)', () => {
    const rule = ruleWith({ otRows: [{ fromMinutes: 0, toMinutes: 0, ratePattern: 'flat', rate: 1.5, rounding: true, roundToMinutes: 30 }] });
    expect(applyOtRuleRows(70, 0, rule)).toBe(60); // 70 → nearest 30 = 60
    expect(applyOtRuleRows(80, 0, rule)).toBe(90); // 80 → nearest 30 = 90
  });

  it('folds early-OT in only when applyToEarlyOt is set', () => {
    const band = [{ fromMinutes: 0, toMinutes: 0, ratePattern: 'flat' as const, rate: 1.5, rounding: false, roundToMinutes: null }];
    expect(applyOtRuleRows(70, 20, ruleWith({ otRows: band, applyToEarlyOt: false }))).toBe(70);
    expect(applyOtRuleRows(70, 20, ruleWith({ otRows: band, applyToEarlyOt: true }))).toBe(90);
  });
});

describe('Standard fallback + per-shift override in the engine', () => {
  it('a shift with no rule uses the tenant Standard rule grace', async () => {
    const a = adminCtx(b);
    const { id: stdId } = await ensureStandardRule(a);
    // Widen the Standard grace to 20 minutes.
    const std = await getAttendanceRule(a, stdId);
    await import('../core/attendance-rule').then((m) =>
      m.updateAttendanceRule(a, {
        ruleId: stdId,
        name: std!.name,
        description: std!.description,
        status: 'active',
        lateGracePeriodMinutes: 20,
        lateAfterMinutes: 0,
        lateDeductMinutes: 0,
        includeGraceInLateness: false,
        earlyGracePeriodMinutes: 0,
        earlyAfterMinutes: 0,
        earlyDeductMinutes: 0,
        includeGraceInEarlyOut: false,
        applyToEarlyOt: false,
        otRows: [],
      }),
    );
    const shift = await createShift(a, workdayShift()); // no ruleId, no explicit lateGrace
    const emp = await makeEmp();
    await assignDefaultShift(a, { employmentId: emp, shiftId: shift.id });
    const within = await checkIn(a, { employmentId: emp, date: WED, time: '09:18:00' });
    expect(within.status).toBe('present'); // 09:18 < 09:00 + 20 grace

    const emp2 = await makeEmp();
    await assignDefaultShift(a, { employmentId: emp2, shiftId: shift.id });
    const beyond = await checkIn(a, { employmentId: emp2, date: WED, time: '09:25:00' });
    expect(beyond.status).toBe('late'); // 09:25 > 09:00 + 20 grace
  });

  it('a per-shift rule overrides the Standard grace', async () => {
    const a = adminCtx(b);
    const { id: stdId } = await ensureStandardRule(a);
    // Standard grace 60 (very lenient); the shift's own rule is strict (0).
    const std = await getAttendanceRule(a, stdId);
    const { updateAttendanceRule } = await import('../core/attendance-rule');
    await updateAttendanceRule(a, {
      ruleId: stdId,
      name: std!.name,
      description: null,
      status: 'active',
      lateGracePeriodMinutes: 60,
      lateAfterMinutes: 0,
      lateDeductMinutes: 0,
      includeGraceInLateness: false,
      earlyGracePeriodMinutes: 0,
      earlyAfterMinutes: 0,
      earlyDeductMinutes: 0,
      includeGraceInEarlyOut: false,
      applyToEarlyOt: false,
      otRows: [],
    });
    const strict = await createAttendanceRule(a, {
      name: 'Strict',
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
    });
    const shift = await createShift(a, workdayShift({ ruleId: strict.id }));
    const emp = await makeEmp();
    await assignDefaultShift(a, { employmentId: emp, shiftId: shift.id });
    const r = await checkIn(a, { employmentId: emp, date: WED, time: '09:05:00' });
    expect(r.status).toBe('late'); // strict rule grace 0 beats Standard's 60
  });
});

describe('OT rows drive workday OT rounding through checkOut', () => {
  it('rounds ot_minutes to the band round-to value; no rule leaves it raw', async () => {
    const a = adminCtx(b);
    const rounded = await createAttendanceRule(a, {
      name: 'Round30',
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
      otRows: [{ fromMinutes: 0, toMinutes: 0, ratePattern: 'flat', rate: 1.5, rounding: true, roundToMinutes: 30 }],
    });
    // With the rounding rule: 550 worked − 480 normal = 70 OT → nearest 30 = 60.
    const withRule = await createShift(a, workdayShift({ ruleId: rounded.id }));
    const emp = await makeEmp();
    await assignDefaultShift(a, { employmentId: emp, shiftId: withRule.id });
    await checkIn(a, { employmentId: emp, date: WED, time: '09:00:00' });
    const out = await checkOut(a, { employmentId: emp, date: WED, time: '19:10:00' });
    expect(out.otMinutes).toBe(60);

    // A separate shift/employee with NO rule leaves the raw 70.
    const noRule = await createShift(a, workdayShift());
    const emp2 = await makeEmp();
    await assignDefaultShift(a, { employmentId: emp2, shiftId: noRule.id });
    await checkIn(a, { employmentId: emp2, date: WED, time: '09:00:00' });
    const out2 = await checkOut(a, { employmentId: emp2, date: WED, time: '19:10:00' });
    expect(out2.otMinutes).toBe(70);
  });
});

describe('policy → Standard conversion + un-deletable + substrate', () => {
  it('ensureStandardRule seeds late grace from the company policy (migration 0203 formula)', async () => {
    const a = adminCtx(b);
    // A company policy with a 20-minute grace (late_after 09:20, work_start 09:00).
    await owner.db.insert(schema.attendancePolicy).values({
      tenantId: b.tenantId,
      companyId: b.companyId,
      lateAfter: '09:20:00',
      workStart: '09:00:00',
      workEnd: '18:00:00',
      breakMinutes: 60,
    });
    const { id } = await ensureStandardRule(a);
    const std = await getAttendanceRule(a, id);
    expect(std!.isDefault).toBe(true);
    expect(std!.lateGracePeriodMinutes).toBe(20);
  });

  it('the Standard rule is un-deletable; custom rules delete + all writes append events', async () => {
    const a = adminCtx(b);
    const { id: stdId } = await ensureStandardRule(a);
    await expect(deleteAttendanceRule(a, { ruleId: stdId })).rejects.toBeInstanceOf(StandardRuleUndeletableError);
    expect(await eventTypesFor(b.tenantId, stdId)).toContain('attendance-rule.created');

    const custom = await createAttendanceRule(a, {
      name: 'Temp',
      status: 'active',
      lateGracePeriodMinutes: 5,
      lateAfterMinutes: 0,
      lateDeductMinutes: 0,
      includeGraceInLateness: false,
      earlyGracePeriodMinutes: 0,
      earlyAfterMinutes: 0,
      earlyDeductMinutes: 0,
      includeGraceInEarlyOut: false,
      applyToEarlyOt: false,
      otRows: [],
    });
    await deleteAttendanceRule(a, { ruleId: custom.id });
    const types = await eventTypesFor(b.tenantId, custom.id);
    expect(types).toContain('attendance-rule.created');
    expect(types).toContain('attendance-rule.deleted');
  });

  it('assigning a rule to a shift appends shift.updated with the ruleId', async () => {
    const a = adminCtx(b);
    const rule = await createAttendanceRule(a, {
      name: 'Assignable',
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
    });
    const shift = await createShift(a, workdayShift());
    await updateShift(a, { shiftId: shift.id, name: 'X', code: 'X1', startTime: '09:00:00', endTime: '18:00:00', breakMinutes: 60, ruleId: rule.id });
    const [row] = await owner.db.select({ ruleId: schema.shift.ruleId }).from(schema.shift).where(eq(schema.shift.id, shift.id));
    expect(row.ruleId).toBe(rule.id);
    expect(await eventTypesFor(b.tenantId, shift.id)).toContain('shift.updated');
  });
});
