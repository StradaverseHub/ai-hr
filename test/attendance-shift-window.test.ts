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
    companyId: b.companyId,
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
