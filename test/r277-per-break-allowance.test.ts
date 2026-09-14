/**
 * r277 (439565ff) — A PER-ROW FLEXIBLE BREAK DURATION: "a sixty-minute lunch and a fifteen-minute tea
 * break can finally have different allowances."
 *
 * ⚠️ THIS CHANGES MONEY. Break minutes come off worked hours, worked hours decide overtime, and overtime
 * ends up on a payslip. So the load-bearing half of this file is the half that asserts NOTHING MOVED:
 * every shift that carries no per-row figure — which is every shift in existence on the day this ships,
 * MB28 included — must derive the identical worked minutes, the identical overtime and the identical
 * ringgit it derives today. A source-grep would prove the branch is written, not that it is reached, so
 * every figure below is read back from the ENGINE after a real punch in and punch out.
 *
 * THE THREE-STEP PRECEDENCE THIS SLOTS INTO (core/attendance.ts): the shift-level flexible allowance
 * first, then the minutes the clocking spanned inside the declared windows, then workedFromSpan's
 * six-hour cliff. The per-row figure is a FOURTH case that only exists when a row actually carries one,
 * and `perRowBreakMinutes` returns null otherwise — which is why the other three cannot move.
 *
 * ABSENT IS NOT ZERO. A break row the operator never touched keeps being deducted the way it is today
 * (the overlap between the clocking and its window), even when a SIBLING row was given an allowance.
 * That is pinned in its own describe below, because it is the single easiest thing to get wrong.
 *
 * Figures are chosen so a ringgit is readable: basic RM2,080 ⇒ ORP 2080/26 = RM80 and hourly RM10
 * (s.60I(1A)), so one hour of workday overtime at 1.5× is RM15 — the same arithmetic
 * shift-colour-flex-break.test.ts uses, for the same reason.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { checkIn, checkOut } from '../core/attendance';
import { assignDefaultShift, copyShift, createShift } from '../core/roster';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, prefillOvertimeFromAttendance } from '../core/payroll';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

/** A TUESDAY (ISO 2) in the recent past, DERIVED FROM THE CLOCK — never a hardcoded future date. A full
 *  week back first, so the date under test is never today and never drifts into tomorrow. */
const TUE = (() => {
  const d = new Date(`${todayInKualaLumpur()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 7);
  while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
})();
const PERIOD = TUE.slice(0, 7);
const HIRED = `${TUE.slice(0, 4)}-01-01`;
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
  // The legacy comp + payroll_input earnings path is what carries prefilled OT onto the slip; with typed
  // pay components enabled the money assertions would silently read zero rather than fail.
  await setModule(b.tenantId, 'typed_pay_components', null);
});

let icSeq = 0;
const randomIc = () => `9201010${String(10000 + (icSeq += 1)).slice(-5)}`;

const shift = (over: Partial<Parameters<typeof createShift>[1]> = {}) =>
  createShift(adminCtx(b), {
    name: `Brk_${randomUUID().slice(0, 6)}`,
    code: `B_${randomUUID().slice(0, 6)}`,
    startTime: '09:00:00',
    endTime: '18:00:00',
    breakMinutes: 60,
    breakPeriods: [{ start: '13:00:00', end: '14:00:00' }],
    weeklyPattern: [1, 2, 3, 4, 5],
    ...over,
  });

/**
 * MB28's EXACT SHAPE — 08:00–17:00, a flexible break of 60, half-day pair 12:00 / 13:00. It is the only
 * shift on production using a flexible break, so it is the row this round is judged on.
 */
const mb28 = (over: Partial<Parameters<typeof createShift>[1]> = {}) =>
  createShift(adminCtx(b), {
    name: `MB28_${randomUUID().slice(0, 6)}`,
    code: `MB28_${randomUUID().slice(0, 6)}`,
    startTime: '08:00:00',
    endTime: '17:00:00',
    breakMinutes: 60,
    breakPeriods: [{ start: '12:00:00', end: '13:00:00' }],
    halfDayFirstOut: '12:00:00',
    halfDaySecondIn: '13:00:00',
    flexibleBreakEnabled: true,
    flexibleBreakMinutes: 60,
    weeklyPattern: [1, 2, 3, 4, 5],
    ...over,
  });

async function employeeOn(shiftId: string, email: string) {
  const a = adminCtx(b);
  const e = await hireEmployee(a, {
    person: { fullName: 'Break Row', primaryEmail: email },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: HIRED,
  });
  await setCompensation(a, { employmentId: e.employmentId, basicSalary: BASIC, monthlyAllowance: 0, effectiveFrom: HIRED });
  await setStatutoryProfileMY(a, { personId: e.personId, icNumber: randomIc() });
  await assignDefaultShift(a, { employmentId: e.employmentId, shiftId });
  return { a, employmentId: e.employmentId };
}

/** Punch one day and read what the ENGINE made of it — not what the source says it should have. */
async function punchDay(shiftId: string, inAt: string, outAt: string, date = TUE) {
  const { a, employmentId } = await employeeOn(shiftId, `brk_${randomUUID()}@t.local`);
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
/**
 * THE MONEY GUARD. MB28 is the reporter's own shift and the only one on production with a flexible
 * break. Until a per-row figure is actually typed on it, every figure it produces is the figure it
 * produces today — and "today" here is not a claim: the same assertions run green against the engine as
 * it stands on main (verified by restoring main's core/attendance.ts + core/roster.ts into the worktree
 * and re-running this file), which is what makes them a BEFORE, not just an AFTER.
 */
describe('r277 — MB28 keeps every figure it has today until a per-row allowance is set', () => {
  it('stores exactly the break it stores today: the shift-level allowance is still the shift’s break', async () => {
    const sh = await mb28();
    const row = await shiftRow(sh.id);
    expect(row.breakMinutes).toBe(60);
    expect(row.flexibleBreakEnabled).toBe(true);
    expect(row.flexibleBreakMinutes).toBe(60);
    // The window survives untouched, its flag normalised to agree with the shift-level switch (6340aecb),
    // and carries NO per-row figure — absent, not zero.
    expect(row.breakPeriods).toEqual([{ start: '12:00:00', end: '13:00:00', flexible: true }]);
  });

  it('a full day is 480 worked and 0 overtime — 08:00→17:00, allowance 60 off a 540-minute span', async () => {
    const sh = await mb28();
    const { out } = await punchDay(sh.id, '08:00:00', '17:00:00');
    expect(out.workedMinutes).toBe(480);
    expect(out.otMinutes).toBe(0);
    expect(out.status).toBe('present');
  });

  it('an hour past the end is 540 worked, 60 overtime and RM15 on the payroll input', async () => {
    const sh = await mb28();
    const { a, employmentId, out } = await punchDay(sh.id, '08:00:00', '18:00:00');
    expect(out.workedMinutes).toBe(540);
    expect(out.otMinutes).toBe(60);
    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: PERIOD });
    await prefillOvertimeFromAttendance(a, { batchId });
    expect(await otAmountOf(batchId, employmentId)).toBeCloseTo(ONE_HOUR_OT, 2);
  });

  it('a half day still loses the whole allowance: 08:00→11:30 = 150 worked, marked half_day', async () => {
    const sh = await mb28();
    const { out } = await punchDay(sh.id, '08:00:00', '11:30:00');
    expect(out.workedMinutes).toBe(150);
    expect(out.otMinutes).toBe(0);
    expect(out.status).toBe('half_day');
  });

  it('a short day that never touched 12:00–13:00 still loses the allowance: 08:00→11:00 = 120 worked', async () => {
    // The flexible allowance is unconditional — that is what 6340aecb decided and this round does not
    // revisit it. Pinned here because it is the case a per-row figure would be most likely to disturb.
    const sh = await mb28();
    const { out } = await punchDay(sh.id, '08:00:00', '11:00:00');
    expect(out.workedMinutes).toBe(120);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────
/** The other two arms of the precedence, on ordinary shifts that carry no per-row figure either. */
describe('r277 — the shifts that carry no per-row figure compute exactly as they did', () => {
  it('spanned windows still rule: 09:00→18:00 over a 13:00–14:00 lunch = 480 worked', async () => {
    const sh = await shift();
    const { out } = await punchDay(sh.id, '09:00:00', '18:00:00');
    expect(out.workedMinutes).toBe(480);
    expect(out.otMinutes).toBe(0);
    expect((await shiftRow(sh.id)).breakMinutes).toBe(60);
  });

  it('…and a clocking that never reached the window still loses nothing: 09:00→12:00 = 180 worked', async () => {
    const sh = await shift();
    const { out } = await punchDay(sh.id, '09:00:00', '12:00:00');
    expect(out.workedMinutes).toBe(180);
  });

  it('the six-hour cliff still rules a shift with only a break SCALAR: a 4-hour day loses nothing', async () => {
    const sh = await shift({ breakPeriods: null, breakMinutes: 60 });
    const { out } = await punchDay(sh.id, '09:00:00', '13:00:00');
    expect(out.workedMinutes).toBe(240);
  });

  it('a break row stores the byte-identical { start, end } it always stored — no key appears', async () => {
    const sh = await shift();
    expect((await shiftRow(sh.id)).breakPeriods).toEqual([{ start: '13:00:00', end: '14:00:00' }]);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe('r277 — a break row with its own allowance', () => {
  it('deducts the ALLOWANCE, not the window: a 60-minute lunch worth 30 gives 510 worked on a full day', async () => {
    const sh = await shift({ breakPeriods: [{ start: '13:00:00', end: '14:00:00', flexible: true, flexibleMinutes: 30 }] });
    const { out } = await punchDay(sh.id, '09:00:00', '18:00:00');
    expect(out.workedMinutes).toBe(510);
  });

  it('the allowance BECOMES the shift’s break minutes, so scheduled hours agree with the deduction', async () => {
    const sh = await shift({ breakPeriods: [{ start: '13:00:00', end: '14:00:00', flexible: true, flexibleMinutes: 30 }] });
    // Σ of the unpaid WINDOWS is 60; the shift's break is 30, because 30 is what comes off a full day.
    expect((await shiftRow(sh.id)).breakMinutes).toBe(30);
  });

  it('is an allowance, not a window: a day that never reached 13:00–14:00 loses it anyway', async () => {
    const sh = await shift({ breakPeriods: [{ start: '13:00:00', end: '14:00:00', flexible: true, flexibleMinutes: 30 }] });
    const { out } = await punchDay(sh.id, '09:00:00', '12:00:00');
    expect(out.workedMinutes).toBe(150);
  });

  it('TWO BREAKS, TWO DIFFERENT ALLOWANCES — the reporter’s actual request', async () => {
    // A 60-minute lunch worth 45 and a 30-minute tea break worth 15: 60 off a full day, and the two
    // figures are genuinely independent, which one shift-level number could never express.
    const sh = await shift({
      breakPeriods: [
        { start: '13:00:00', end: '14:00:00', flexible: true, flexibleMinutes: 45 },
        { start: '16:00:00', end: '16:30:00', flexible: true, flexibleMinutes: 15 },
      ],
    });
    expect((await shiftRow(sh.id)).breakMinutes).toBe(60);
    const { out } = await punchDay(sh.id, '09:00:00', '18:00:00');
    expect(out.workedMinutes).toBe(480);
  });

  it('an allowance equal to its own window deducts exactly what that window deducts today', async () => {
    // The ordinary case — "my lunch is an hour, take it when you like" — and the one that proves the new
    // path is not a different arithmetic, only a different way of stating the same minutes.
    const same = await shift({ breakPeriods: [{ start: '13:00:00', end: '14:00:00', flexible: true, flexibleMinutes: 60 }] });
    const plain = await shift();
    expect((await shiftRow(same.id)).breakMinutes).toBe((await shiftRow(plain.id)).breakMinutes);
    expect((await punchDay(same.id, '09:00:00', '18:00:00')).out.workedMinutes).toBe(
      (await punchDay(plain.id, '09:00:00', '18:00:00')).out.workedMinutes,
    );
  });

  it('reaches OVERTIME and a payslip where overtime is measured by duration', async () => {
    // On the DURATION basis (a manual normal-hours figure) the break is subtracted from worked minutes
    // and worked minutes are compared against the normal day — so thirty minutes of break become thirty
    // minutes of overtime. This is the money path the reporter was warned about, stated as a number.
    const normalHours = await shift({ normalMinutesOverride: 480 });
    const { out: before } = await punchDay(normalHours.id, '09:00:00', '18:00:00');
    expect(before.workedMinutes).toBe(480);
    expect(before.otMinutes).toBe(0);

    const withAllowance = await shift({
      normalMinutesOverride: 480,
      breakPeriods: [{ start: '13:00:00', end: '14:00:00', flexible: true, flexibleMinutes: 30 }],
    });
    const { a, employmentId, out: after } = await punchDay(withAllowance.id, '09:00:00', '18:00:00');
    expect(after.workedMinutes).toBe(510);
    expect(after.otMinutes).toBe(30);
    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: PERIOD });
    await prefillOvertimeFromAttendance(a, { batchId });
    // Half an hour at 1.5× on an RM10 hourly rate.
    expect(await otAmountOf(batchId, employmentId)).toBeCloseTo(ONE_HOUR_OT / 2, 2);
  });

  it('stores the figure on the row, and only on the row that was given one', async () => {
    const sh = await shift({
      breakPeriods: [
        { start: '13:00:00', end: '14:00:00', flexible: true, flexibleMinutes: 30 },
        { start: '16:00:00', end: '16:15:00' },
      ],
    });
    expect((await shiftRow(sh.id)).breakPeriods).toEqual([
      { start: '13:00:00', end: '14:00:00', flexible: true, flexibleMinutes: 30 },
      { start: '16:00:00', end: '16:15:00' },
    ]);
  });

  it('a copy of the shift carries the per-row allowances with it', async () => {
    const sh = await shift({ breakPeriods: [{ start: '13:00:00', end: '14:00:00', flexible: true, flexibleMinutes: 30 }] });
    const copy = await copyShift(adminCtx(b), { shiftId: sh.id });
    const row = await shiftRow(copy.id);
    expect(row.breakPeriods).toEqual([{ start: '13:00:00', end: '14:00:00', flexible: true, flexibleMinutes: 30 }]);
    expect(row.breakMinutes).toBe(30);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * ABSENT MEANS TODAY'S BEHAVIOUR, NEVER ZERO. This is the single assertion the whole design rests on: a
 * row nobody touched must not start deducting nothing because the row above it was edited.
 */
describe('r277 — a row with NO allowance keeps being deducted exactly as it is today', () => {
  const mixed = () =>
    shift({
      breakPeriods: [
        { start: '13:00:00', end: '14:00:00', flexible: true, flexibleMinutes: 30 }, // touched
        { start: '16:00:00', end: '16:15:00' }, // untouched: a plain fixed 15-minute window
      ],
    });

  it('the untouched FIXED row still contributes its spanned minutes, not zero', async () => {
    const sh = await mixed();
    // break_minutes = 30 (the allowance) + 15 (the window's own length) = 45, not 30.
    expect((await shiftRow(sh.id)).breakMinutes).toBe(45);
    // A full day spans the 16:00–16:15 window, so 30 + 15 comes off: 540 − 45 = 495.
    expect((await punchDay(sh.id, '09:00:00', '18:00:00')).out.workedMinutes).toBe(495);
  });

  it('…and contributes NOTHING on a day that never reached it — which is also today’s behaviour', async () => {
    const sh = await mixed();
    // 09:00→12:00 touches neither window: the allowance still comes off, the fixed window does not.
    expect((await punchDay(sh.id, '09:00:00', '12:00:00')).out.workedMinutes).toBe(150);
  });

  it('a FLEXIBLE row left blank is deducted by its window too — blank is not an allowance of zero', async () => {
    const sh = await shift({
      breakPeriods: [
        { start: '13:00:00', end: '14:00:00', flexible: true, flexibleMinutes: 30 },
        { start: '16:00:00', end: '16:15:00', flexible: true },
      ],
    });
    expect((await shiftRow(sh.id)).breakMinutes).toBe(45);
    expect((await punchDay(sh.id, '09:00:00', '18:00:00')).out.workedMinutes).toBe(495);
  });

  it('a PAID row is not deducted at all, allowance or no allowance', async () => {
    const sh = await shift({
      breakPeriods: [
        { start: '13:00:00', end: '14:00:00', flexible: true, flexibleMinutes: 30 },
        { start: '16:00:00', end: '16:15:00', paid: true },
      ],
    });
    expect((await shiftRow(sh.id)).breakMinutes).toBe(30);
    expect((await punchDay(sh.id, '09:00:00', '18:00:00')).out.workedMinutes).toBe(510);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * The four ways the figure could be stored next to something that contradicts it. Each is REFUSED rather
 * than silently dropped, because this is money: an operator who typed thirty minutes and got a shift that
 * deducts sixty would find out on a payslip.
 */
describe('r277 — the contradictions are refused, not stored', () => {
  it('refuses an allowance on a FIXED break', async () => {
    await expect(shift({ breakPeriods: [{ start: '13:00:00', end: '14:00:00', flexible: false, flexibleMinutes: 30 }] })).rejects.toThrow(
      /Only a Flexible break/i,
    );
    // …and on a row that never said either way, which is what every legacy row looks like.
    await expect(shift({ breakPeriods: [{ start: '13:00:00', end: '14:00:00', flexibleMinutes: 30 }] })).rejects.toThrow(/Only a Flexible break/i);
  });

  it('refuses an allowance longer than its own window', async () => {
    await expect(shift({ breakPeriods: [{ start: '13:00:00', end: '14:00:00', flexible: true, flexibleMinutes: 61 }] })).rejects.toThrow(
      /longer than the break window/i,
    );
  });

  it('refuses an allowance beside the SHIFT-LEVEL allowance — one question, one answer', async () => {
    await expect(
      shift({
        breakPeriods: [{ start: '13:00:00', end: '14:00:00', flexible: true, flexibleMinutes: 30 }],
        flexibleBreakEnabled: true,
        flexibleBreakMinutes: 45,
      }),
    ).rejects.toThrow(/already has one flexible break allowance/i);
  });

  it('refuses an allowance on a PAID break, which is never deducted', async () => {
    await expect(
      shift({ breakPeriods: [{ start: '13:00:00', end: '14:00:00', flexible: true, paid: true, flexibleMinutes: 30 }] }),
    ).rejects.toThrow(/paid break is not deducted/i);
  });

  it('refuses zero and refuses a negative — an empty box is absent, and absent is not zero', async () => {
    await expect(shift({ breakPeriods: [{ start: '13:00:00', end: '14:00:00', flexible: true, flexibleMinutes: 0 }] })).rejects.toThrow(
      /needs an allowed duration/i,
    );
    await expect(shift({ breakPeriods: [{ start: '13:00:00', end: '14:00:00', flexible: true, flexibleMinutes: -5 }] })).rejects.toThrow(
      /needs an allowed duration/i,
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe('r277 — Semi Flexi, where every break is flexible by rule', () => {
  it('takes a per-row allowance without the row having to say it is flexible', async () => {
    // core/roster.ts forces flexible=true on every break of a Semi Flexi shift and the form shows the
    // Fixed tick off and disabled there, so every row is offered the box — the service must agree.
    const sh = await shift({
      type: 'semi_flexi',
      normalMinutesOverride: 480,
      breakPeriods: [{ start: '13:00:00', end: '14:00:00', flexibleMinutes: 30 }],
    });
    const row = await shiftRow(sh.id);
    expect(row.breakPeriods).toEqual([{ start: '13:00:00', end: '14:00:00', flexible: true, clockingRequired: false, flexibleMinutes: 30 }]);
    expect(row.breakMinutes).toBe(30);
  });
});
