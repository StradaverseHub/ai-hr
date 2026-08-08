/**
 * b7b886e2 — "Attendance Calculation Based on Shift Time-In / Time-Out Settings".
 *
 * The reporter's model, stated exactly: on a 09:00–18:00 shift with a 13:00–14:00 break,
 *   • in/out inside the shift ⇒ 8 normal hours, no OT (break excluded);
 *   • clocking out AFTER the shift end ⇒ the excess past 18:00 is OT, never normal hours;
 *   • the break is excluded only when the clocking actually spans it.
 *
 * Two engine faults are pinned here (both reproduced against the pre-fix engine):
 *   A. OT was `worked − scheduledMinutes` — a DURATION comparison that ignores WHERE the minutes fell. A
 *      late arrival who stayed an hour past 18:00 accrued ZERO OT (worked still totalled 8h), while an
 *      early arrival who left exactly at 18:00 accrued an hour of OT they never worked past the shift end.
 *   B. The break came off on a flat 6-hour cliff (workedFromSpan), so a shift whose clocking never touched
 *      the 13:00–14:00 window still lost an hour, and one that half-covered it lost the full hour.
 *
 * Both fixes apply ONLY where a real shift resolved (roster / default shift). The company-policy branch —
 * "a day with no assigned shift at all" — is deliberately left on the legacy duration math; the regression
 * guard at the bottom pins that.
 *
 * Dates: 2026-07-01 = Wednesday. Default policy: 09:00–18:00, 60m break, Mon–Fri.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { checkIn, checkOut } from '../core/attendance';
import { createAttendanceRule } from '../core/attendance-rule';
import { assignDefaultShift, createShift } from '../core/roster';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;

const WED = '2026-07-01';

async function makeEmp() {
  const [p] = await owner.db
    .insert(schema.person)
    .values({ tenantId: b.tenantId, fullName: 'Shift Window', primaryEmail: `sw_${randomUUID()}@t.local` })
    .returning({ id: schema.person.id });
  const [e] = await owner.db
    .insert(schema.employment)
    .values({ tenantId: b.tenantId, personId: p.id, companyId: b.companyId, hiredOn: '2020-01-01' })
    .returning({ id: schema.employment.id });
  return e.id;
}

/** The reporter's shift: 09:00–18:00 with an explicit 13:00–14:00 break window. */
async function reporterShift(code: string, over: Record<string, unknown> = {}) {
  return createShift(adminCtx(b), {
    companyId: b.companyId,
    name: `Reporter ${code}`,
    code,
    startTime: '09:00:00',
    endTime: '18:00:00',
    breakMinutes: 60,
    breakPeriods: [{ start: '13:00:00', end: '14:00:00' }],
    weeklyPattern: [1, 2, 3, 4, 5],
    ...over,
  });
}

/** Clock a full day against `shiftId` and return the derived figures. */
async function day(shiftId: string, inAt: string, outAt: string) {
  const a = adminCtx(b);
  const empId = await makeEmp();
  await assignDefaultShift(a, { employmentId: empId, shiftId });
  await checkIn(a, { employmentId: empId, date: WED, time: inAt });
  const out = await checkOut(a, { employmentId: empId, date: WED, time: outAt });
  return { worked: out.workedMinutes, ot: out.otMinutes, normal: (out.workedMinutes ?? 0) - (out.otMinutes ?? 0) };
}

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

describe('b7b886e2 — OT is the time worked past the shift END, not a duration overshoot', () => {
  it("the reporter's two stated cases: on time ⇒ 8h normal / 0 OT; out at 19:00 ⇒ 8h normal + 1h OT", async () => {
    const s = await reporterShift('RPT1');
    expect(await day(s.id, '09:00:00', '18:00:00')).toMatchObject({ worked: 480, ot: 0, normal: 480 });
    expect(await day(s.id, '09:00:00', '19:00:00')).toMatchObject({ worked: 540, ot: 60, normal: 480 });
  });

  it('FAULT A (under-accrual): a LATE arrival who stays past 18:00 accrues that excess as OT', async () => {
    // Pre-fix: worked 480 and OT max(0, 480 − 480) = 0 — an hour of real overtime vanished because the
    // late start cancelled it out in the duration comparison.
    const s = await reporterShift('RPT2');
    expect(await day(s.id, '10:00:00', '19:00:00')).toMatchObject({ worked: 480, ot: 60, normal: 420 });
  });

  it('FAULT A (over-accrual): an EARLY arrival who leaves at the shift end accrues NO OT', async () => {
    // Pre-fix: worked 540 and OT 60 — an hour of overtime pay for time worked before the shift started,
    // which the reporter's rule ("beyond the shift end time") does not recognise.
    const s = await reporterShift('RPT3');
    expect(await day(s.id, '08:00:00', '18:00:00')).toMatchObject({ worked: 540, ot: 0, normal: 540 });
  });

  it('leaving before the shift end is never OT, however long the day ran', async () => {
    const s = await reporterShift('RPT4');
    expect(await day(s.id, '07:00:00', '17:00:00')).toMatchObject({ ot: 0 });
  });

  it('a cross-midnight shift measures OT past its own end, not past midnight', async () => {
    const s = await createShift(adminCtx(b), {
      companyId: b.companyId,
      name: 'Night',
      code: 'NIGHT',
      startTime: '22:00:00',
      endTime: '06:00:00',
      breakMinutes: 30,
      breakPeriods: [{ start: '02:00:00', end: '02:30:00' }],
      weeklyPattern: [1, 2, 3, 4, 5],
    });
    // 22:00 → 06:00 is the whole shift: 480 span − 30 break = 450 normal, no OT.
    expect(await day(s.id, '22:00:00', '06:00:00')).toMatchObject({ worked: 450, ot: 0 });
    // 22:00 → 07:00 runs an hour past the 06:00 end.
    expect(await day(s.id, '22:00:00', '07:00:00')).toMatchObject({ worked: 510, ot: 60 });
    // A LATE start (00:30, i.e. after midnight) that still ends at 06:00 is inside the shift — no OT, and
    // the after-midnight punch must not be read as a 22-hour-early arrival.
    expect(await day(s.id, '00:30:00', '06:00:00')).toMatchObject({ worked: 300, ot: 0 });
  });
});

describe('b7b886e2 — pre-shift minutes reach OT only through the rule that opts into them', () => {
  /** A rule identical to Standard except for the early-OT opt-in. */
  const ruleInput = (name: string, applyToEarlyOt: boolean) => ({
    name,
    status: 'active' as const,
    lateGracePeriodMinutes: 60, // keep every case 'present' so status never clouds the OT figure
    lateAfterMinutes: 0,
    lateDeductMinutes: 0,
    includeGraceInLateness: false,
    earlyGracePeriodMinutes: 0,
    earlyAfterMinutes: 0,
    earlyDeductMinutes: 0,
    includeGraceInEarlyOut: false,
    applyToEarlyOt,
    otRows: [],
  });

  it('an early start counts as OT when the rule applies to early OT, and not when it does not', async () => {
    const a = adminCtx(b);
    // Until b7b886e2 the engine passed a hardcoded 0 for early minutes, so this rule flag could not change
    // any figure — it is wired to real pre-shift minutes for the first time here.
    const early = await createAttendanceRule(a, ruleInput('EarlyOT', true));
    const plain = await createAttendanceRule(a, ruleInput('NoEarlyOT', false));
    const sEarly = await reporterShift('EOT1', { ruleId: early.id });
    const sPlain = await reporterShift('EOT2', { ruleId: plain.id });
    // 08:00 → 18:00 = one hour before the shift start, none past its end.
    expect(await day(sEarly.id, '08:00:00', '18:00:00')).toMatchObject({ worked: 540, ot: 60 });
    expect(await day(sPlain.id, '08:00:00', '18:00:00')).toMatchObject({ worked: 540, ot: 0 });
  });

  it('an ineligible shift accrues nothing even when the rule opts into early OT', async () => {
    const early = await createAttendanceRule(adminCtx(b), ruleInput('EarlyOT2', true));
    const s = await reporterShift('EOT3', { ruleId: early.id, otRule: { eligible: false } });
    // The early minutes are folded in BEFORE the per-shift OT shape, so eligibility still zeroes the day.
    expect(await day(s.id, '08:00:00', '19:00:00')).toMatchObject({ ot: 0 });
  });
});

describe('b7b886e2 — the break is excluded only when the clocking spans the break window', () => {
  it('FAULT B (wrongly deducted): a clocking that never reaches 13:00 keeps its full hours', async () => {
    // Pre-fix: the span reached the flat 6h cliff, so the full 60m came off even though the employee
    // never touched the 13:00–14:00 window. 14:00 → 20:00 is a plain 6 worked hours.
    const s = await reporterShift('BRK1');
    expect(await day(s.id, '14:00:00', '20:00:00')).toMatchObject({ worked: 360 });
  });

  it('FAULT B (over-deducted): a clocking that half-covers the break loses only the overlap', async () => {
    // 09:00 → 13:30 overlaps the break by 30m, so 270 span − 30 = 240 worked. Pre-fix: 270 (under the
    // 6h cliff nothing came off at all).
    const s = await reporterShift('BRK2');
    expect(await day(s.id, '09:00:00', '13:30:00')).toMatchObject({ worked: 240 });
  });

  it('a clocking that fully spans the break loses the whole break', async () => {
    const s = await reporterShift('BRK3');
    expect(await day(s.id, '09:00:00', '15:00:00')).toMatchObject({ worked: 300 }); // 360 − 60
  });

  it('a shift with a break SCALAR but no windows keeps the legacy 6-hour-cliff deduction', async () => {
    const s = await createShift(adminCtx(b), {
      companyId: b.companyId,
      name: 'Scalar',
      code: 'SCALAR',
      startTime: '09:00:00',
      endTime: '18:00:00',
      breakMinutes: 60,
      weeklyPattern: [1, 2, 3, 4, 5],
    });
    expect(await day(s.id, '09:00:00', '18:00:00')).toMatchObject({ worked: 480 }); // 540 − 60 (≥ 6h)
    expect(await day(s.id, '09:00:00', '13:00:00')).toMatchObject({ worked: 240 }); // < 6h ⇒ nothing off
  });
});

describe('b7b886e2 — a day with no assigned shift is unchanged (company-policy branch)', () => {
  it('policy-only employees keep the legacy duration OT and 6-hour-cliff break', async () => {
    const a = adminCtx(b);
    const empId = await makeEmp();
    await checkIn(a, { employmentId: empId, date: WED, time: '09:00:00' });
    const out = await checkOut(a, { employmentId: empId, date: WED, time: '19:00:00' });
    expect(out).toMatchObject({ workedMinutes: 540, otMinutes: 60 }); // 600 − 60 break; 540 − 480 scheduled

    const emp2 = await makeEmp();
    await checkIn(a, { employmentId: emp2, date: WED, time: '10:00:00' });
    const out2 = await checkOut(a, { employmentId: emp2, date: WED, time: '19:00:00' });
    expect(out2).toMatchObject({ workedMinutes: 480, otMinutes: 0 }); // legacy: duration, not window
  });
});

// ── cf21e554 stage 1 — paid breaks, normal-hours rounding, and the per-shift half-day cut-off ─────────

describe('cf21e554 — a PAID break is not deducted from the shift’s hours', () => {
  /**
   * THE ONE BEHAVIOUR CHANGE ON STORED DATA IN STAGE 1, and it is a no-op today: `paid` is a new optional
   * key on BreakPeriod and ABSENT MEANS UNPAID, so not one of the 2 production shifts that carry break
   * windows has it. core/roster.ts now persists break_minutes as Σ of the UNPAID windows.
   */
  it('the legacy, untouched shift derives BYTE-IDENTICAL scheduled minutes and worked hours', async () => {
    // The reporter's shift exactly as it is stored today: one 13:00–14:00 window, no `paid` key anywhere.
    const s = await reporterShift('LEGACY');
    const [row] = await owner.db.select().from(schema.shift).where(eq(schema.shift.id, s.id));
    // The stored JSON is unchanged — no `paid` key was invented on the way through the service.
    expect(row.breakPeriods).toEqual([{ start: '13:00:00', end: '14:00:00' }]);
    expect(row.breakMinutes).toBe(60); // Σ unpaid == Σ all, because nothing is paid
    // …and the engine's figures are the ones the b7b886e2 suite above already pins: 09:00→18:00 spans the
    // break, so 540 − 60 = 480 worked, no overtime.
    expect(await day(s.id, '09:00:00', '18:00:00')).toMatchObject({ worked: 480, ot: 0 });
  });

  it('marking the break PAID stops it coming off the hours', async () => {
    const a = adminCtx(b);
    const s = await createShift(a, {
      companyId: b.companyId,
      name: 'Paid break',
      code: 'PAIDBRK',
      startTime: '09:00:00',
      endTime: '18:00:00',
      breakMinutes: 60,
      breakPeriods: [{ start: '13:00:00', end: '14:00:00', paid: true }],
      weeklyPattern: [1, 2, 3, 4, 5],
    });
    const [row] = await owner.db.select().from(schema.shift).where(eq(schema.shift.id, s.id));
    // break_minutes is Σ of the UNPAID windows — there are none, so it is zero even though a 60-minute
    // window exists and even though the caller passed breakMinutes: 60.
    expect(row.breakMinutes).toBe(0);
    expect(row.breakPeriods).toEqual([{ start: '13:00:00', end: '14:00:00', paid: true }]);
    // A full 09:00→18:00 day is now 9 paid hours, not 8.
    expect(await day(s.id, '09:00:00', '18:00:00')).toMatchObject({ worked: 540, ot: 0 });
  });

  it('mixed paid + unpaid windows: only the unpaid one is deducted', async () => {
    const a = adminCtx(b);
    const s = await createShift(a, {
      companyId: b.companyId,
      name: 'Mixed breaks',
      code: 'MIXBRK',
      startTime: '09:00:00',
      endTime: '18:00:00',
      breakMinutes: 0,
      breakPeriods: [
        { start: '10:30:00', end: '10:45:00', paid: true }, // paid tea break
        { start: '13:00:00', end: '14:00:00' }, // unpaid lunch
      ],
      weeklyPattern: [1, 2, 3, 4, 5],
    });
    const [row] = await owner.db.select().from(schema.shift).where(eq(schema.shift.id, s.id));
    expect(row.breakMinutes).toBe(60);
    // The clocking spans BOTH windows, but only 60 minutes comes off (b7b886e2 caps the spanned deduction
    // at the canonical scalar, which is now the unpaid sum).
    expect(await day(s.id, '09:00:00', '18:00:00')).toMatchObject({ worked: 480 });

    // …and a PARTIAL day is where the paid window actually has to be excluded from the SUM, not merely
    // masked by the cap. 09:00→12:00 spans only the PAID 10:30–10:45 tea break; the unpaid lunch is never
    // reached. Before the fix spannedBreakMinutes summed the overlap across ALL windows and returned
    // min(15, 60) = 15, so a 3-hour morning was paid as 165 minutes. It must be the full 180.
    expect(await day(s.id, '09:00:00', '12:00:00')).toMatchObject({ worked: 180 });
  });
});

describe('cf21e554 — normal-hours rounding is applied inside netScheduledMinutes', () => {
  it('rounds the shift’s normal hours DOWN to the configured multiple, in the real engine path', async () => {
    const a = adminCtx(b);
    // 09:00–17:50 with a 60-minute break = 470 net minutes. Rounded down to a 15-minute multiple ⇒ 465.
    // Proved through the DURATION branch (a manual normal-minutes override is absent, so the shift-window
    // branch owns OT) by asking for SHORT HOURS instead: `underMinutes` is measured against exactly the
    // same figure, so a shift that rounds has 5 fewer minutes to make up.
    const rounded = await createShift(a, {
      companyId: b.companyId,
      name: 'Rounded',
      code: 'ROUND15',
      startTime: '09:00:00',
      endTime: '17:50:00',
      breakMinutes: 60,
      weeklyPattern: [1, 2, 3, 4, 5],
      normalHoursRoundingMinutes: 15,
    });
    const plain = await createShift(a, {
      companyId: b.companyId,
      name: 'Unrounded',
      code: 'ROUND0',
      startTime: '09:00:00',
      endTime: '17:50:00',
      breakMinutes: 60,
      weeklyPattern: [1, 2, 3, 4, 5],
    });
    const under = async (shiftId: string) => {
      const empId = await makeEmp();
      await assignDefaultShift(a, { employmentId: empId, shiftId });
      await checkIn(a, { employmentId: empId, date: WED, time: '09:00:00' });
      // Out at 16:50 ⇒ span 470, minus the 6h-cliff break 60 ⇒ 410 worked.
      await checkOut(a, { employmentId: empId, date: WED, time: '16:50:00' });
      // `underMinutes` is a STORED column (migration 0394), not part of checkOut's return — read it back.
      const [row] = await owner.db
        .select({ under: schema.attendance.underMinutes, trace: schema.attendance.calcTrace })
        .from(schema.attendance)
        .where(eq(schema.attendance.employmentId, empId));
      return row;
    };
    // 470 normal − 410 worked; and the trace records the very figure the OT threshold used.
    expect(await under(plain.id)).toMatchObject({ under: 60 });
    expect((await under(plain.id)).trace).toMatchObject({ schedule: { scheduledMinutes: 470 } });
    expect(await under(rounded.id)).toMatchObject({ under: 55 }); // 465 normal − 410 worked
    expect((await under(rounded.id)).trace).toMatchObject({ schedule: { scheduledMinutes: 465 } });
  });
});

describe('cf21e554 — the shift’s own half-day clock-out wins over the company setting', () => {
  it('a shift with half_day_first_out set uses it; a blank shift is unchanged', async () => {
    const a = adminCtx(b);
    // Blank shift: the legacy threshold is the shift MIDPOINT, 09:00 + 270 = 13:30. A 14:00 checkout is
    // therefore NOT a half day today.
    const blank = await reporterShift('HDBLANK');
    const empA = await makeEmp();
    await assignDefaultShift(a, { employmentId: empA, shiftId: blank.id });
    await checkIn(a, { employmentId: empA, date: WED, time: '09:00:00' });
    expect((await checkOut(a, { employmentId: empA, date: WED, time: '14:00:00' })).status).not.toBe('half_day');

    // Same clocking on a shift whose own cut-off is 15:00 IS a half day — the per-shift box decided it.
    const own = await reporterShift('HDOWN', { halfDayFirstOut: '15:00', halfDaySecondIn: '15:30' });
    const empB = await makeEmp();
    await assignDefaultShift(a, { employmentId: empB, shiftId: own.id });
    await checkIn(a, { employmentId: empB, date: WED, time: '09:00:00' });
    expect((await checkOut(a, { employmentId: empB, date: WED, time: '14:00:00' })).status).toBe('half_day');
  });
});
