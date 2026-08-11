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
import { assignDefaultShift, assignShift, createShift, updateShift } from '../core/roster';
import { todayInKualaLumpur } from '../lib/hr-date';
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
/** Date-only arithmetic stays UTC; the tenant timezone was already applied when `today` was resolved. */
const addDaysIso = (iso: string, n: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
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
    // 7c834696 — the deduction half of the rule, resolved for the first time in this release.
    lateAfterMinutes: 0,
    lateDeductMinutes: 0,
    includeGraceInLateness: false,
    earlyAfterMinutes: 0,
    earlyDeductMinutes: 0,
    includeGraceInEarlyOut: false,
    applyDeductions: false,
    deductionsEffectiveFrom: null,
    otRows: [],
    ...over,
  });

  it('no rule / no rows leaves OT unchanged', () => {
    expect(applyOtRuleRows(70, 0, null)).toBe(70);
    expect(applyOtRuleRows(70, 0, ruleWith())).toBe(70);
  });

  it('rounds OT DOWN to the matching band round-to value (7c834696 rev 3 — never above what was worked)', () => {
    const rule = ruleWith({ otRows: [{ fromMinutes: 0, toMinutes: 0, ratePattern: 'flat', rate: 1.5, phRate: null, rounding: true, roundToMinutes: 30 }] });
    expect(applyOtRuleRows(70, 0, rule)).toBe(60); // 70 → floor to 30s = 60 (nearest gave 60 too)
    expect(applyOtRuleRows(80, 0, rule)).toBe(60); // 80 → floor to 30s = 60; nearest USED TO give 90
  });

  it('folds early-OT in only when applyToEarlyOt is set', () => {
    const band = [{ fromMinutes: 0, toMinutes: 0, ratePattern: 'flat' as const, rate: 1.5, phRate: null, rounding: false, roundToMinutes: null }];
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
    // With the rounding rule: 550 worked − 480 normal = 70 OT → floored to a multiple of 30 = 60.
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


// ─────────────────────── 7c834696 stage 1 ───────────────────────

/** A complete rule input with everything off — the shape every rule in the product has today. */
const inertRule = (over: Partial<Parameters<typeof createAttendanceRule>[1]> = {}) => ({
  name: `R_${randomUUID().slice(0, 8)}`,
  status: 'active' as const,
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
const vband = (fromMinutes: number, toMinutes: number, rate: number) => ({
  fromMinutes,
  toMinutes,
  ratePattern: 'variable' as const,
  rate,
  rounding: false,
  roundToMinutes: null,
});

describe('7c834696 — the OT band ladder is validated on save', () => {
  it('refuses OVERLAPPING bands and names both rows', async () => {
    const a = adminCtx(b);
    // Validation runs in normalizeInput, i.e. SYNCHRONOUSLY, before the transaction opens — so this is a
    // plain throw, not a rejected promise, and a bad table never reaches the database at all.
    expect(() =>
      createAttendanceRule(a, inertRule({ otRows: [vband(0, 120, 1.5), vband(100, 180, 2)] })),
    ).toThrow(/Overtime row 2 overlaps row 1/);
  });

  it('refuses a GAP between bands and names both rows', async () => {
    const a = adminCtx(b);
    expect(() =>
      createAttendanceRule(a, inertRule({ otRows: [vband(0, 120, 1.5), vband(150, 180, 2)] })),
    ).toThrow(/Overtime row 2 leaves a gap after row 1/);
  });

  it('refuses an open-ended band that is not the last row', async () => {
    const a = adminCtx(b);
    expect(() =>
      createAttendanceRule(a, inertRule({ otRows: [vband(0, 0, 1.5), vband(121, 180, 2)] })),
    ).toThrow(/row 1 has no upper limit/);
  });

  it('ACCEPTS a contiguous ladder ending open-ended, and a rate of 0', async () => {
    const a = adminCtx(b);
    const r = await createAttendanceRule(
      a,
      inertRule({ otRows: [vband(0, 60, 0), vband(61, 120, 1.5), vband(121, 0, 2)] }),
    );
    const saved = await getAttendanceRule(a, r.id);
    expect(saved!.otRows).toHaveLength(3);
    expect(Number(saved!.otRows[0].rate)).toBe(0);
  });

  it('refuses a lateness pair whose interval exceeds its deduction (the request’s X ≤ Y rule)', async () => {
    const a = adminCtx(b);
    expect(() =>
      createAttendanceRule(a, inertRule({ lateAfterMinutes: 30, lateDeductMinutes: 10 })),
    ).toThrow(/Lateness: .after 30 minutes. cannot be larger than .deduct 10 minutes./);
    expect(() =>
      createAttendanceRule(a, inertRule({ earlyAfterMinutes: 30, earlyDeductMinutes: 10 })),
    ).toThrow(/Early out: .after 30 minutes. cannot be larger than .deduct 10 minutes./);
  });

  it('stores the per-band public-holiday rate, and null when none is given', async () => {
    const a = adminCtx(b);
    const r = await createAttendanceRule(
      a,
      inertRule({ otRows: [{ ...vband(0, 120, 1.5), phRate: 3 }, vband(121, 0, 2)] }),
    );
    const saved = await getAttendanceRule(a, r.id);
    expect(Number(saved!.otRows[0].phRate)).toBe(3);
    expect(saved!.otRows[1].phRate).toBeNull();
  });
});

describe('7c834696 — bands CATEGORISE, and ot_minutes stays the total', () => {
  it('a 3-hour overtime day under 0–2h@1.5 / 2–3h@2.0 stores 2h + 1h, summing to ot_minutes', async () => {
    const a = adminCtx(b);
    const rule = await createAttendanceRule(
      a,
      inertRule({ otRows: [vband(0, 120, 1.5), vband(121, 180, 2)] }),
    );
    const sh = await createShift(a, workdayShift({ ruleId: rule.id }));
    const emp = await makeEmp();
    await assignDefaultShift(a, { employmentId: emp, shiftId: sh.id });
    await checkIn(a, { employmentId: emp, date: WED, time: '09:00:00' });
    const out = await checkOut(a, { employmentId: emp, date: WED, time: '21:00:00' });
    expect(out.otMinutes).toBe(180); // 09:00–21:00 is 3h past an 18:00 shift end

    const [row] = await owner.db
      .select()
      .from(schema.attendance)
      .where(eq(schema.attendance.employmentId, emp));
    expect(row.ot15Minutes).toBe(120);
    expect(row.ot20Minutes).toBe(60);
    expect(row.otFlatMinutes).toBe(0);
    expect(row.ot00Minutes).toBe(0);
    expect(row.ot10Minutes).toBe(0);
    expect(row.ot30Minutes).toBe(0);
    // THE INVARIANT: categorising moves minutes between columns, it never changes the total payroll reads.
    const sum =
      row.otFlatMinutes! + row.ot00Minutes! + row.ot10Minutes! + row.ot15Minutes! + row.ot20Minutes! + row.ot30Minutes!;
    expect(sum).toBe(row.otMinutes);
    // ...and worked_minutes is untouched by any of it.
    expect(row.workedMinutes).toBe(660);
  });

  it('a rule with NO bands stores the split the Records screens already showed', async () => {
    const a = adminCtx(b);
    const sh = await createShift(a, workdayShift()); // no rule ⇒ tenant Standard, no bands
    const emp = await makeEmp();
    await assignDefaultShift(a, { employmentId: emp, shiftId: sh.id });
    await checkIn(a, { employmentId: emp, date: WED, time: '09:00:00' });
    await checkOut(a, { employmentId: emp, date: WED, time: '19:00:00' });

    const [row] = await owner.db
      .select()
      .from(schema.attendance)
      .where(eq(schema.attendance.employmentId, emp));
    expect(row.otMinutes).toBe(60);
    expect(row.ot15Minutes).toBe(60); // workday → 1.5, exactly as otByRate always derived it
    expect(row.otFlatMinutes).toBe(0);
    expect(row.ot20Minutes).toBe(0);
    expect(row.ot30Minutes).toBe(0);
  });
});

describe('7c834696 — lateness / early-out are measured, and deductions are forward-dated only', () => {
  const shiftWithGrace = (ruleId: string) => workdayShift({ ruleId });

  it('measures lateness and short hours, and deducts NOTHING while the switch is off', async () => {
    const a = adminCtx(b);
    const rule = await createAttendanceRule(
      a,
      // A rule that WOULD deduct heavily if anyone turned it on.
      inertRule({ lateGracePeriodMinutes: 15, lateAfterMinutes: 15, lateDeductMinutes: 30 }),
    );
    const sh = await createShift(a, shiftWithGrace(rule.id));
    const emp = await makeEmp();
    await assignDefaultShift(a, { employmentId: emp, shiftId: sh.id });
    await checkIn(a, { employmentId: emp, date: WED, time: '09:40:00' });
    await checkOut(a, { employmentId: emp, date: WED, time: '17:00:00' });

    const [row] = await owner.db
      .select()
      .from(schema.attendance)
      .where(eq(schema.attendance.employmentId, emp));
    expect(row.lateMinutes).toBe(25); // 09:40 against a 09:15 threshold (grace not included)
    expect(row.earlyOutMinutes).toBe(60); // 17:00 against an 18:00 end
    // 09:40→17:00 = 440-minute span; the shift has a 60-minute break scalar and no break windows, so the
    // engine's 6h cliff deducts the whole break → 380 worked, 100 short of the 480 scheduled.
    expect(row.workedMinutes).toBe(380);
    expect(row.underMinutes).toBe(100);
    // The whole point: the figures exist, and the money figure is still zero.
    expect(row.lateDeductMinutes).toBe(0);
    expect(row.earlyOutDeductMinutes).toBe(0);
  });

  it('honours "include grace in lateness"', async () => {
    const a = adminCtx(b);
    const rule = await createAttendanceRule(
      a,
      inertRule({ lateGracePeriodMinutes: 15, includeGraceInLateness: true }),
    );
    const sh = await createShift(a, shiftWithGrace(rule.id));
    const emp = await makeEmp();
    await assignDefaultShift(a, { employmentId: emp, shiftId: sh.id });
    await checkIn(a, { employmentId: emp, date: WED, time: '09:40:00' });
    await checkOut(a, { employmentId: emp, date: WED, time: '18:00:00' });
    const [row] = await owner.db
      .select()
      .from(schema.attendance)
      .where(eq(schema.attendance.employmentId, emp));
    expect(row.lateMinutes).toBe(40); // counted from 09:00, not from 09:15
  });

  it('switching deductions ON stamps TODAY and leaves every earlier day at zero', async () => {
    const a = adminCtx(b);
    const rule = await createAttendanceRule(
      a,
      inertRule({
        lateGracePeriodMinutes: 15,
        lateAfterMinutes: 15,
        lateDeductMinutes: 30,
        applyDeductions: true,
      }),
    );
    const today = todayInKualaLumpur();
    const saved = await getAttendanceRule(a, rule.id);
    expect(saved!.applyDeductions).toBe(true);
    // Server-stamped, never supplied by the caller — so it cannot be back-dated.
    expect(saved!.deductionsEffectiveFrom).toBe(today);

    const sh = await createShift(a, shiftWithGrace(rule.id));
    // A PAST day (WED is 2026-07-01, well before any run of this suite): measured, never deducted.
    const past = await makeEmp();
    await assignDefaultShift(a, { employmentId: past, shiftId: sh.id });
    await checkIn(a, { employmentId: past, date: WED, time: '09:40:00' });
    await checkOut(a, { employmentId: past, date: WED, time: '18:00:00' });
    const [pastRow] = await owner.db
      .select()
      .from(schema.attendance)
      .where(eq(schema.attendance.employmentId, past));
    expect(pastRow.lateMinutes).toBe(25);
    expect(pastRow.lateDeductMinutes).toBe(0); // BEFORE the switch-on date ⇒ no money moves

    // A day on/after the switch-on date does deduct. Rostered explicitly so the assertion does not depend
    // on which weekday the suite happens to run on.
    const future = addDaysIso(today, 30);
    const later = await makeEmp();
    await assignShift(a, { employmentId: later, shiftDate: future, shiftId: sh.id });
    await checkIn(a, { employmentId: later, date: future, time: '09:40:00' });
    await checkOut(a, { employmentId: later, date: future, time: '18:00:00' });
    const [futureRow] = await owner.db
      .select()
      .from(schema.attendance)
      .where(eq(schema.attendance.employmentId, later));
    expect(futureRow.lateMinutes).toBe(25);
    expect(futureRow.lateDeductMinutes).toBe(30); // floor(25 / 15) = 1 block × 30
  });
});
