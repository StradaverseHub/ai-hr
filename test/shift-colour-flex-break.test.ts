/**
 * 6340aecb — the two things the Shift Settings redesign added to the RECORD: a colour, and a flexible break.
 *
 * THE LOAD-BEARING TEST IN THIS FILE IS THE ONE THAT ASSERTS NOTHING CHANGED. Break handling feeds worked
 * minutes, worked minutes feed overtime and overtime is what payroll reads, so a switch installed "to
 * change nothing" has to be PROVED to change nothing — the same discipline 711adcd2's ORP flags needed and
 * for the same reason. The golden cases below punch real days on shifts that leave the switch OFF and read
 * the engine's own figures, including a ringgit off a prefilled payroll input.
 *
 * The second half then proves the switch DOES something when it is on, because a setting that is safe by
 * being inert is not a feature. The demonstrative case is the reporter's own point 12: a shift with a
 * fixed 13:00–14:00 break window, worked 09:00→12:00 — a clocking that never touches the window. Today
 * nothing comes off. With Flexible on, the allowance does, which is exactly what "the employee may take
 * their break whenever they like" has to mean.
 *
 * Figures are chosen so a ringgit is readable at a glance: basic RM2,080 ⇒ ORP 2080/26 = RM80 and hourly
 * RM10 (s.60I(1A)), so one hour of workday overtime at 1.5× is RM15.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { checkIn, checkOut } from '../core/attendance';
import { assignDefaultShift, copyShift, createShift, updateShift } from '../core/roster';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, prefillOvertimeFromAttendance } from '../core/payroll';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

/** 2026-05-05 is a TUESDAY (ISO 2) and sits inside the 2026-05 pay period. */
const TUE = '2026-05-05';
const PERIOD = '2026-05';
const BASIC = 2080;
/** One hour of workday overtime at 1.5× on an RM10 hourly rate. */
const ONE_HOUR_OT = 15;

let b: Base;

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  // The legacy comp + payroll_input earnings path is what carries the prefilled OT onto the slip. With
  // typed pay components enabled the money assertions below would silently read zero rather than fail.
  await setModule(b.tenantId, 'typed_pay_components', null);
});

let icSeq = 0;
const randomIc = () => `9201010${String(10000 + (icSeq += 1)).slice(-5)}`;

/** The 09:00–18:00 day shift with a fixed one-hour lunch, which is what most of this file punches. */
const dayShift = (over: Partial<Parameters<typeof createShift>[1]> = {}) =>
  createShift(adminCtx(b), {
    name: `Day_${randomUUID().slice(0, 6)}`,
    code: `D_${randomUUID().slice(0, 6)}`,
    startTime: '09:00:00',
    endTime: '18:00:00',
    breakMinutes: 60,
    breakPeriods: [{ start: '13:00:00', end: '14:00:00' }],
    weeklyPattern: [1, 2, 3, 4, 5],
    ...over,
  });

async function employeeOn(shiftId: string, email: string) {
  const a = adminCtx(b);
  const e = await hireEmployee(a, {
    person: { fullName: 'Break Case', primaryEmail: email },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  await setCompensation(a, { employmentId: e.employmentId, basicSalary: BASIC, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
  await setStatutoryProfileMY(a, { personId: e.personId, icNumber: randomIc() });
  await assignDefaultShift(a, { employmentId: e.employmentId, shiftId });
  return { a, employmentId: e.employmentId };
}

/** Punch one day on a shift and read what the ENGINE made of it. */
async function punchDay(shiftId: string, inAt: string, outAt: string, date = TUE) {
  const { a, employmentId } = await employeeOn(shiftId, `flex_${randomUUID()}@t.local`);
  await checkIn(a, { employmentId, date, time: inAt });
  const out = await checkOut(a, { employmentId, date, time: outAt });
  return { a, employmentId, out };
}

const shiftRow = async (id: string) => (await owner.db.select().from(schema.shift).where(eq(schema.shift.id, id)))[0];

/** The prefilled overtime amount for ONE employment, in ringgit. No row = no overtime = RM0. */
const otAmountOf = async (batchId: string, employmentId: string) => {
  const [row] = await owner.db
    .select()
    .from(schema.payrollInput)
    .where(and(eq(schema.payrollInput.batchId, batchId), eq(schema.payrollInput.employmentId, employmentId)));
  return row ? Number(row.overtimeAmount) : 0;
};

// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe('6340aecb — THE GOLDEN CASE: a shift without a flexible break computes exactly as it did', () => {
  it('ships OFF: every shift created without the switch stores flexible_break_enabled = false, no allowance', async () => {
    const sh = await dayShift();
    const row = await shiftRow(sh.id);
    expect(row.flexibleBreakEnabled).toBe(false);
    expect(row.flexibleBreakMinutes).toBeNull();
    // …and the break the rest of the system reads is still Σ of the unpaid windows, untouched.
    expect(row.breakMinutes).toBe(60);
  });

  it('a full day still loses exactly its spanned break: 09:00→18:00 = 480 worked, no overtime', async () => {
    const sh = await dayShift();
    const { out } = await punchDay(sh.id, '09:00:00', '18:00:00');
    expect(out.workedMinutes).toBe(480);
    expect(out.otMinutes).toBe(0);
  });

  it('an hour past the shift end is still one hour of overtime — RM15 on the payroll input', async () => {
    const sh = await dayShift();
    const { a, employmentId, out } = await punchDay(sh.id, '09:00:00', '19:00:00');
    expect(out.workedMinutes).toBe(540);
    expect(out.otMinutes).toBe(60);
    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: PERIOD });
    await prefillOvertimeFromAttendance(a, { batchId });
    expect(await otAmountOf(batchId, employmentId)).toBeCloseTo(ONE_HOUR_OT, 2);
  });

  it('a short day that never touched the break window still loses nothing: 09:00→12:00 = 180 worked', async () => {
    // THIS is the case the flexible break changes, so it is the case that pins today's behaviour hardest.
    const sh = await dayShift();
    const { out } = await punchDay(sh.id, '09:00:00', '12:00:00');
    expect(out.workedMinutes).toBe(180);
  });

  it('a shift with only a break SCALAR keeps the 6-hour cliff: a 4-hour day loses nothing', async () => {
    const sh = await dayShift({ breakPeriods: null, breakMinutes: 60 });
    const { out } = await punchDay(sh.id, '09:00:00', '13:00:00');
    expect(out.workedMinutes).toBe(240);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe('6340aecb — the flexible break, once it is switched on', () => {
  it('the allowance applies EVEN WHEN a break window is configured (the reporter’s point 12)', async () => {
    const sh = await dayShift({ flexibleBreakEnabled: true, flexibleBreakMinutes: 45 });
    // The windows are still stored — Flexible does not delete the operator's intended break times. Their
    // own `flexible` flag is normalised to TRUE to agree with the shift-level switch (the dedicated
    // describe below is where that rule is pinned); what must survive untouched are the TIMES.
    const row = await shiftRow(sh.id);
    expect(row.breakPeriods).toEqual([{ start: '13:00:00', end: '14:00:00', flexible: true }]);
    expect(row.flexibleBreakEnabled).toBe(true);
    expect(row.flexibleBreakMinutes).toBe(45);
    // A clocking that never overlaps 13:00–14:00 now loses the allowance, where it lost nothing before.
    const { out } = await punchDay(sh.id, '09:00:00', '12:00:00');
    expect(out.workedMinutes).toBe(135);
  });

  it('it is not the 6-hour cliff: a 4-hour day loses the allowance too', async () => {
    const sh = await dayShift({ breakPeriods: null, breakMinutes: 60, flexibleBreakEnabled: true, flexibleBreakMinutes: 45 });
    const { out } = await punchDay(sh.id, '09:00:00', '13:00:00');
    expect(out.workedMinutes).toBe(195);
  });

  it('the allowance BECOMES the shift’s break minutes, so scheduled hours and the deduction agree', async () => {
    const sh = await dayShift({ flexibleBreakEnabled: true, flexibleBreakMinutes: 45 });
    const row = await shiftRow(sh.id);
    // Σ of the unpaid windows is 60, but the shift's break IS the allowance once Flexible is on.
    expect(row.breakMinutes).toBe(45);
    // …and a full day is therefore 540 − 45 = 495 worked against a 495-minute normal day: no overtime.
    const { out } = await punchDay(sh.id, '09:00:00', '18:00:00');
    expect(out.workedMinutes).toBe(495);
    expect(out.otMinutes).toBe(0);
  });

  it('switching it back OFF restores the shift exactly: the allowance is dropped and the windows rule again', async () => {
    const sh = await dayShift({ flexibleBreakEnabled: true, flexibleBreakMinutes: 45 });
    await updateShift(adminCtx(b), {
      shiftId: sh.id,
      name: (await shiftRow(sh.id)).name,
      code: (await shiftRow(sh.id)).code!,
      startTime: '09:00:00',
      endTime: '18:00:00',
      breakMinutes: 60,
      breakPeriods: [{ start: '13:00:00', end: '14:00:00' }],
      weeklyPattern: [1, 2, 3, 4, 5],
    });
    const row = await shiftRow(sh.id);
    expect(row.flexibleBreakEnabled).toBe(false);
    // An allowance nothing reads is not left lying in the column — off has ONE representation.
    expect(row.flexibleBreakMinutes).toBeNull();
    expect(row.breakMinutes).toBe(60);
    const { out } = await punchDay(sh.id, '09:00:00', '12:00:00');
    expect(out.workedMinutes).toBe(180);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * "FLEXIBLE" NOW EXISTS AT TWO SCALES, AND THEY MUST NOT BE ABLE TO SAY OPPOSITE THINGS.
 *
 * f3321963 gave every break WINDOW its own `flexible` flag (BreakPeriod, db/schema.ts) months before
 * migration 0457 added the SHIFT-level switch, so a row can carry both. Only one of them has a reader:
 * core/attendance.ts computes `spannedBreak = flexibleBreak ?? spannedBreakMinutes(…)`, and
 * spannedBreakMinutes filters on `paid` and never looks at `bp.flexible` at all. So the shift-level switch
 * WINS — its allowance replaces the entire window computation — and core/roster.ts normalises the window
 * flag to agree with it rather than leaving the record asserting "this break is fixed" about a window
 * nothing will ever be checked against. It is the same rule, and the same line, Semi Flexi already used.
 */
describe('6340aecb — the shift-level switch and the per-window flag cannot disagree', () => {
  it('a window posted as FIXED is stored flexible once the shift-level allowance is on', async () => {
    const sh = await dayShift({
      breakPeriods: [{ start: '13:00:00', end: '14:00:00', flexible: false, clockingRequired: true }],
      flexibleBreakEnabled: true,
      flexibleBreakMinutes: 45,
    });
    expect((await shiftRow(sh.id)).breakPeriods).toEqual([
      { start: '13:00:00', end: '14:00:00', flexible: true, clockingRequired: true },
    ]);
  });

  it('…and with the switch OFF the window keeps exactly the flag it was given', async () => {
    // The normalisation is reachable ONLY through the switch. Every shift that exists today leaves it off,
    // so this is the case that says the rule above cannot touch them.
    const sh = await dayShift({ breakPeriods: [{ start: '13:00:00', end: '14:00:00', flexible: false }] });
    const row = await shiftRow(sh.id);
    expect(row.flexibleBreakEnabled).toBe(false);
    expect(row.breakPeriods).toEqual([{ start: '13:00:00', end: '14:00:00', flexible: false }]);
  });

  it('the ALLOWANCE is what comes off the day — the window flag moves no minutes either way', async () => {
    // Same shift, same punch, opposite window flags. Identical worked minutes is what "the shift-level
    // switch wins" means in the only currency that matters here.
    const asFixed = await dayShift({
      breakPeriods: [{ start: '13:00:00', end: '14:00:00', flexible: false }],
      flexibleBreakEnabled: true,
      flexibleBreakMinutes: 45,
    });
    const asFlexible = await dayShift({
      breakPeriods: [{ start: '13:00:00', end: '14:00:00', flexible: true }],
      flexibleBreakEnabled: true,
      flexibleBreakMinutes: 45,
    });
    expect((await punchDay(asFixed.id, '09:00:00', '12:00:00')).out.workedMinutes).toBe(135);
    expect((await punchDay(asFlexible.id, '09:00:00', '12:00:00')).out.workedMinutes).toBe(135);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe('6340aecb — the shift colour', () => {
  it('stores a palette token, and defaults to none', async () => {
    const plain = await dayShift();
    expect((await shiftRow(plain.id)).color).toBeNull();
    const coloured = await dayShift({ color: 'blue' });
    expect((await shiftRow(coloured.id)).color).toBe('blue');
  });

  it('refuses a colour outside the closed palette rather than storing it', async () => {
    await expect(dayShift({ color: '#ff0000' })).rejects.toThrow(/Invalid shift colour/);
  });

  it('a blank colour clears back to none (the “No colour” option is a real choice)', async () => {
    const sh = await dayShift({ color: 'red' });
    const before = await shiftRow(sh.id);
    await updateShift(adminCtx(b), {
      shiftId: sh.id,
      name: before.name,
      code: before.code!,
      startTime: '09:00:00',
      endTime: '18:00:00',
      breakMinutes: 60,
      color: '',
    });
    expect((await shiftRow(sh.id)).color).toBeNull();
  });

  it('a copy carries the colour and the flexible break with it', async () => {
    const sh = await dayShift({ color: 'teal', flexibleBreakEnabled: true, flexibleBreakMinutes: 30 });
    const copy = await copyShift(adminCtx(b), { shiftId: sh.id });
    const row = await shiftRow(copy.id);
    expect(row.color).toBe('teal');
    expect(row.flexibleBreakEnabled).toBe(true);
    expect(row.flexibleBreakMinutes).toBe(30);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe('6340aecb — request point 14: an existing shift round-trips through the new screen unchanged', () => {
  it('re-saving every box the form carries leaves the row byte-identical', async () => {
    // A shift configured the way the reference row MB28 is: description, category, the clock window, the
    // half-day pair, rounding, the recorded-only figures and a premium.
    const sh = await dayShift({
      description: 'WITH 0.5 OT HOUR ADJ - MORNING FULL',
      category: 'MORNING',
      dayType: 'workday',
      earlyIn: '07:30:00',
      lateOut: '20:00:00',
      lateOutNextDay: false,
      halfDayFirstOut: '13:00:00',
      halfDaySecondIn: '14:00:00',
      normalHoursRoundingMinutes: 15,
      fullDayLeaveMinutes: 480,
      fullDayOtMinutes: 120,
      differential: { kind: 'percent', value: 10 },
      halfPattern: [6],
      offPattern: [],
    });
    const before = await shiftRow(sh.id);

    // FIRST assert the row actually HOLDS what was configured. Without this the round-trip below compares
    // two nulls and passes: a column dropped from the shared write set is dropped on create AND on update,
    // so the symmetric bug is invisible to an equality check alone.
    expect(before.description).toBe('WITH 0.5 OT HOUR ADJ - MORNING FULL');
    expect(before.category).toBe('MORNING');
    expect(before.earlyIn).toBe('07:30:00');
    expect(before.lateOut).toBe('20:00:00');
    expect(before.halfDayFirstOut).toBe('13:00:00');
    expect(before.halfDaySecondIn).toBe('14:00:00');
    expect(before.normalHoursRoundingMinutes).toBe(15);
    expect(before.fullDayLeaveMinutes).toBe(480);
    expect(before.fullDayOtMinutes).toBe(120);
    expect(before.differential).toEqual({ kind: 'percent', value: 10 });
    expect(before.halfPattern).toEqual([6]);

    // Exactly what shift-actions.ts posts back when the operator opens the form and presses Save without
    // touching anything — including the two NEW keys, whose absent state must not disturb the row.
    await updateShift(adminCtx(b), {
      shiftId: sh.id,
      name: before.name,
      code: before.code!,
      type: before.type,
      startTime: before.startTime,
      endTime: before.endTime,
      breakMinutes: before.breakMinutes,
      breakPeriods: before.breakPeriods,
      normalMinutesOverride: before.normalMinutesOverride,
      ruleId: before.ruleId,
      weeklyPattern: before.weeklyPattern,
      halfPattern: before.halfPattern,
      offPattern: before.offPattern,
      dailyCutoffEnabled: before.dailyCutoffEnabled,
      dailyCutoffTime: before.dailyCutoffTime,
      differential: before.differential,
      description: before.description,
      dayType: before.dayType,
      category: before.category,
      earlyIn: before.earlyIn,
      lateOut: before.lateOut,
      lateOutNextDay: before.lateOutNextDay,
      fullDayLeaveMinutes: before.fullDayLeaveMinutes,
      normalHoursRoundingMinutes: before.normalHoursRoundingMinutes,
      fullDayOtMinutes: before.fullDayOtMinutes,
      halfDayFirstOut: before.halfDayFirstOut,
      halfDaySecondIn: before.halfDaySecondIn,
      color: before.color,
      flexibleBreakEnabled: before.flexibleBreakEnabled,
      flexibleBreakMinutes: before.flexibleBreakMinutes,
    });

    const after = await shiftRow(sh.id);
    // updated_at is the one column a save is SUPPOSED to move; everything else must be identical.
    const strip = (r: typeof before) => ({ ...r, updatedAt: null });
    expect(strip(after)).toEqual(strip(before));
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe('6340aecb — request point 13: the time sequence is validated, not stored and discovered later', () => {
  it('refuses an earliest clock-in after the shift starts', async () => {
    await expect(dayShift({ earlyIn: '09:30:00' })).rejects.toThrow(/at or before the shift start/i);
  });

  it('refuses a latest clock-out before the shift ends', async () => {
    await expect(dayShift({ lateOut: '17:00:00' })).rejects.toThrow(/at or after the shift end/i);
  });

  it('refuses a 1st half end time that is not before the 2nd half start time', async () => {
    await expect(dayShift({ halfDayFirstOut: '14:00:00', halfDaySecondIn: '13:00:00' })).rejects.toThrow(
      /first half-day clock-out must be before/i,
    );
  });

  it('refuses a break that ends before it starts', async () => {
    await expect(dayShift({ breakPeriods: [{ start: '14:00:00', end: '13:00:00' }] })).rejects.toThrow(
      /must start before it ends/i,
    );
  });

  it('refuses Flexible with no allowance, and an allowance that is not shorter than the shift', async () => {
    await expect(dayShift({ flexibleBreakEnabled: true })).rejects.toThrow(/needs an allowed duration/i);
    await expect(dayShift({ flexibleBreakEnabled: true, flexibleBreakMinutes: 540 })).rejects.toThrow(
      /shorter than the shift span/i,
    );
  });
});
