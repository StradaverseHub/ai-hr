/**
 * cf21e554 STAGE 2 — the shift's own Overtime Schedule (table shift_ot_window, migration 0418).
 *
 * The reporter's reference screen states overtime BY CLOCK TIME: one window before the shift
 * (05:00–08:00) and one after it (17:00–23:59), each with its shortest and longest countable length, plus
 * the adjustment their shift name spells out — "WITH 0.5 OT HOUR ADJ", read as "once overtime reaches
 * 1h30, deduct 30 minutes".
 *
 * Four things are held here:
 *   A. the pure arithmetic (core/shift-ot-window.ts): overlap, minimum, maximum, adjustment, ordering;
 *   B. the engine really reads the windows (checkIn/checkOut, so it is the REAL path, not a helper call);
 *   C. the ordering the plan is explicit about — the windows decide WHICH minutes count, and the
 *      attendance rule's band rounding still runs AFTER them and still owns rounding;
 *   D. the write path: validation, the no-overlap rule, and the RLS/GRANT reality of a brand-new table.
 *
 * A shift with NO windows must be byte-identical to before, and that is asserted too — it is the state
 * every one of the 11 production shift rows is in.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { checkIn, checkOut } from '../core/attendance';
import { createAttendanceRule } from '../core/attendance-rule';
import { otMinutesFromWindows } from '../core/shift-ot-window';
import { assignDefaultShift, createShift, listShiftOtWindows, replaceShiftOtWindows } from '../core/roster';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { withTenant, type SessionContext } from '../db/client';

let b: Base;

const WED = '2026-07-01'; // ISO weekday 3

async function makeEmp() {
  const [p] = await owner.db
    .insert(schema.person)
    .values({ tenantId: b.tenantId, fullName: 'OT Window', primaryEmail: `otw_${randomUUID()}@t.local` })
    .returning({ id: schema.person.id });
  const [e] = await owner.db
    .insert(schema.employment)
    .values({ tenantId: b.tenantId, personId: p.id, companyId: b.companyId, hiredOn: '2020-01-01' })
    .returning({ id: schema.employment.id });
  return e.id;
}

/** The reporter's MB28: 08:00–17:00, one hour of break. */
async function mb28(code: string, over: Record<string, unknown> = {}) {
  return createShift(adminCtx(b), {
    companyId: b.companyId,
    name: `MB28 ${code}`,
    code,
    startTime: '08:00:00',
    endTime: '17:00:00',
    breakMinutes: 60,
    weeklyPattern: [1, 2, 3, 4, 5],
    ...over,
  });
}

async function day(shiftId: string, inAt: string, outAt: string) {
  const a = adminCtx(b);
  const empId = await makeEmp();
  await assignDefaultShift(a, { employmentId: empId, shiftId });
  await checkIn(a, { employmentId: empId, date: WED, time: inAt });
  const out = await checkOut(a, { employmentId: empId, date: WED, time: outAt });
  return { worked: out.workedMinutes, ot: out.otMinutes };
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

// ── A. the pure arithmetic ────────────────────────────────────────────────────────────────────────────

describe('cf21e554 A — otMinutesFromWindows', () => {
  // MB28's two windows, on an 08:00 shift (start = 480 minutes past midnight).
  const MB28_WINDOWS = [
    { label: 'Before', startTime: '05:00:00', endTime: '08:00:00' },
    { label: 'Evening', startTime: '17:00:00', endTime: '23:59:00' },
  ];

  it('counts only the minutes that fell inside a declared window', () => {
    // Clocked 07:00 → 19:00 on an 08:00–17:00 shift: 60m in the morning window, 120m in the evening one.
    const r = otMinutesFromWindows(MB28_WINDOWS, { inAbs: 420, outAbs: 1140 }, 480);
    expect(r.rows.map((x) => x.minutes)).toEqual([60, 120]);
    expect(r.total).toBe(180);
  });

  it('a punch entirely inside the shift earns nothing — the windows sit outside it', () => {
    expect(otMinutesFromWindows(MB28_WINDOWS, { inAbs: 480, outAbs: 1020 }, 480).total).toBe(0);
  });

  it('the MINIMUM zeroes a window outright rather than flooring it', () => {
    // 20 minutes into the evening window, minimum 27 (the reporter's figure) ⇒ nothing, not 27.
    const w = [{ ...MB28_WINDOWS[1], minMinutes: 27 }];
    expect(otMinutesFromWindows(w, { inAbs: 480, outAbs: 1040 }, 480).total).toBe(0);
    // 30 minutes clears it and counts in full.
    expect(otMinutesFromWindows(w, { inAbs: 480, outAbs: 1050 }, 480).total).toBe(30);
  });

  it('the MAXIMUM clamps', () => {
    const w = [{ ...MB28_WINDOWS[1], maxMinutes: 60 }];
    expect(otMinutesFromWindows(w, { inAbs: 480, outAbs: 1200 }, 480).total).toBe(60);
  });

  it("the reporter's adjustment: at 1h30, deduct 30 minutes", () => {
    const w = [{ ...MB28_WINDOWS[1], adjustAfterMinutes: 90, adjustDeltaMinutes: -30 }];
    // 89 minutes — one minute short of the threshold, so nothing is taken off.
    expect(otMinutesFromWindows(w, { inAbs: 480, outAbs: 1109 }, 480).total).toBe(89);
    // 90 minutes — the threshold is REACHED (>=, not >), so 30 comes off.
    expect(otMinutesFromWindows(w, { inAbs: 480, outAbs: 1110 }, 480).total).toBe(60);
    // 120 minutes ⇒ 90.
    expect(otMinutesFromWindows(w, { inAbs: 480, outAbs: 1140 }, 480).total).toBe(90);
  });

  it('a positive delta is an uplift, and the result never goes below zero', () => {
    expect(
      otMinutesFromWindows([{ ...MB28_WINDOWS[1], adjustAfterMinutes: 60, adjustDeltaMinutes: 15 }], { inAbs: 480, outAbs: 1140 }, 480).total,
    ).toBe(135);
    expect(
      otMinutesFromWindows([{ ...MB28_WINDOWS[1], adjustAfterMinutes: 10, adjustDeltaMinutes: -600 }], { inAbs: 480, outAbs: 1080 }, 480).total,
    ).toBe(0);
  });

  it('the order is minimum → maximum → adjustment, and each step is visible in the rows', () => {
    // 180 raw minutes; max 120 clamps it; the adjustment then takes 30 off the CLAMPED figure ⇒ 90.
    const r = otMinutesFromWindows(
      [{ ...MB28_WINDOWS[1], maxMinutes: 120, adjustAfterMinutes: 90, adjustDeltaMinutes: -30 }],
      { inAbs: 480, outAbs: 1200 },
      480,
    );
    expect(r.rows[0]).toEqual({ label: 'Evening', rawMinutes: 180, minutes: 90 });
  });

  it('a next-day window on a night shift is placed on the shift’s own timeline', () => {
    // 22:00–06:00 shift (start 1320). A 06:00–08:00 window ends after midnight, so it must land at
    // 1800–1920 on the shift timeline, not at 360–480 the morning BEFORE the shift started.
    const w = [{ label: 'After', startTime: '06:00:00', endTime: '08:00:00' }];
    const r = otMinutesFromWindows(w, { inAbs: 1320, outAbs: 1860 }, 1320); // 22:00 → 07:00
    expect(r.total).toBe(60);
  });
});

// ── B + C. the engine reads them, and rounding still runs afterwards ─────────────────────────────────

describe('cf21e554 B — the engine derives workday OT from the shift’s own windows', () => {
  it('a shift with NO windows is byte-identical: OT is still the time past the shift end', async () => {
    // The state every production shift is in. 08:00 → 19:00 ⇒ 2h past the 17:00 end.
    const s = await mb28('NOWIN');
    expect(await day(s.id, '08:00:00', '19:00:00')).toMatchObject({ ot: 120 });
  });

  it('with windows, only the minutes inside them count — including the pre-shift window', async () => {
    const a = adminCtx(b);
    const s = await mb28('WIN1');
    await replaceShiftOtWindows(a, {
      shiftId: s.id,
      windows: [
        { label: 'Before', startTime: '05:00', endTime: '08:00' },
        { label: 'Evening', startTime: '17:00', endTime: '23:59' },
      ],
    });
    // 07:00 → 19:00: an hour before the shift + two hours after it. Without the windows the pre-shift
    // hour would earn NOTHING (the rule's applyToEarlyOt is off by default), so this figure could not be
    // produced by the old path — which is what makes it proof the windows ran.
    expect(await day(s.id, '07:00:00', '19:00:00')).toMatchObject({ ot: 180 });
  });

  it('the window minimum and the adjustment both reach the stored ot_minutes', async () => {
    const a = adminCtx(b);
    const s = await mb28('WIN2');
    await replaceShiftOtWindows(a, {
      shiftId: s.id,
      windows: [{ label: 'Evening', startTime: '17:00', endTime: '23:59', minMinutes: 27, adjustAfterMinutes: 90, adjustDeltaMinutes: -30 }],
    });
    expect(await day(s.id, '08:00:00', '17:20:00')).toMatchObject({ ot: 0 }); // 20m < the 27m minimum
    expect(await day(s.id, '08:00:00', '18:00:00')).toMatchObject({ ot: 60 }); // 60m, under the threshold
    expect(await day(s.id, '08:00:00', '19:00:00')).toMatchObject({ ot: 90 }); // 120m − 30m adjustment
  });

  it('C. the attendance rule’s band ROUNDING still runs after the windows and still owns rounding', async () => {
    const a = adminCtx(b);
    // A rule that rounds any OT in the 1–600 band to the nearest 30 minutes.
    const rule = await createAttendanceRule(a, {
      name: `Rounder ${randomUUID().slice(0, 6)}`,
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
      otRows: [{ fromMinutes: 1, toMinutes: 600, ratePattern: 'flat', rate: 1.5, roundingMode: 'down', roundToMinutes: 30 }],
    });
    const s = await mb28('WIN3', { ruleId: rule.id });
    await replaceShiftOtWindows(a, {
      shiftId: s.id,
      windows: [{ label: 'Evening', startTime: '17:00', endTime: '23:59', adjustAfterMinutes: 90, adjustDeltaMinutes: -30 }],
    });
    // 17:00 → 18:40 = 100 window minutes. The adjustment fires (≥90) ⇒ 70. THEN the band rounds 70 to the
    // nearest 30 ⇒ 60. If the windows had rounded, or had run after the band, the answer would be 90 or 70.
    expect(await day(s.id, '08:00:00', '18:40:00')).toMatchObject({ ot: 60 });
  });

  it('a REST DAY is untouched by the windows — statutory premium days are not shift-shaped', async () => {
    const a = adminCtx(b);
    // Sunday 2026-07-05 is outside the Mon–Fri pattern ⇒ the rest-day branch, where every worked minute
    // is overtime. The windows must not reach it.
    const s = await mb28('WIN4');
    await replaceShiftOtWindows(a, { shiftId: s.id, windows: [{ startTime: '17:00', endTime: '23:59' }] });
    const empId = await makeEmp();
    await assignDefaultShift(a, { employmentId: empId, shiftId: s.id });
    await checkIn(a, { employmentId: empId, date: '2026-07-05', time: '09:00:00' });
    const out = await checkOut(a, { employmentId: empId, date: '2026-07-05', time: '13:00:00' });
    expect(out.otMinutes).toBe(240);
  });
});

// ── D. the write path ─────────────────────────────────────────────────────────────────────────────────

describe('cf21e554 D — replaceShiftOtWindows', () => {
  it('stores the grid in order and replaces it wholesale; an empty array clears it', async () => {
    const a = adminCtx(b);
    const s = await mb28('WR1');
    await replaceShiftOtWindows(a, {
      shiftId: s.id,
      windows: [
        { label: 'Before', startTime: '05:00', endTime: '08:00', minMinutes: 27 },
        { label: 'Evening', startTime: '17:00', endTime: '23:59', adjustAfterMinutes: 90, adjustDeltaMinutes: -30 },
      ],
    });
    const rows = await listShiftOtWindows(a, s.id);
    expect(rows.map((r) => [r.sortOrder, r.label, r.startTime, r.endTime])).toEqual([
      [0, 'Before', '05:00:00', '08:00:00'],
      [1, 'Evening', '17:00:00', '23:59:00'],
    ]);
    expect(rows[0].minMinutes).toBe(27);
    expect(rows[1].adjustAfterMinutes).toBe(90);
    expect(rows[1].adjustDeltaMinutes).toBe(-30);

    await replaceShiftOtWindows(a, { shiftId: s.id, windows: [] });
    expect(await listShiftOtWindows(a, s.id)).toHaveLength(0);
  });

  it('refuses a window that ends before it starts unless the next-day marker is ticked', async () => {
    const a = adminCtx(b);
    const s = await mb28('WR2');
    await expect(
      replaceShiftOtWindows(a, { shiftId: s.id, windows: [{ startTime: '22:00', endTime: '02:00' }] }),
    ).rejects.toThrow(/must start before it ends/i);
    // With the marker it is a legitimate four-hour overnight window.
    await replaceShiftOtWindows(a, { shiftId: s.id, windows: [{ startTime: '22:00', endTime: '02:00', endNextDay: true }] });
    expect(await listShiftOtWindows(a, s.id)).toHaveLength(1);
  });

  it('refuses OVERLAPPING windows — the engine sums them, so an overlap would pay twice', async () => {
    const a = adminCtx(b);
    const s = await mb28('WR3');
    await expect(
      replaceShiftOtWindows(a, {
        shiftId: s.id,
        windows: [
          { startTime: '17:00', endTime: '20:00' },
          { startTime: '19:00', endTime: '22:00' },
        ],
      }),
    ).rejects.toThrow(/must not overlap/i);
    // Touching end-to-start is NOT an overlap — a refusal test that also refuses the legal case proves
    // nothing about the boundary.
    await replaceShiftOtWindows(a, {
      shiftId: s.id,
      windows: [
        { startTime: '17:00', endTime: '20:00' },
        { startTime: '20:00', endTime: '22:00' },
      ],
    });
    expect(await listShiftOtWindows(a, s.id)).toHaveLength(2);
  });

  it('refuses a half-set adjustment, and a minimum above the maximum', async () => {
    const a = adminCtx(b);
    const s = await mb28('WR4');
    await expect(
      replaceShiftOtWindows(a, { shiftId: s.id, windows: [{ startTime: '17:00', endTime: '20:00', adjustAfterMinutes: 90 }] }),
    ).rejects.toThrow(/both a threshold and an amount/i);
    await expect(
      replaceShiftOtWindows(a, { shiftId: s.id, windows: [{ startTime: '17:00', endTime: '20:00', adjustDeltaMinutes: -30 }] }),
    ).rejects.toThrow(/both a threshold and an amount/i);
    await expect(
      replaceShiftOtWindows(a, { shiftId: s.id, windows: [{ startTime: '17:00', endTime: '20:00', minMinutes: 120, maxMinutes: 60 }] }),
    ).rejects.toThrow(/minimum must not exceed its maximum/i);
  });

  it('RLS + GRANT: a non-admin cannot write a window but can read the shared library’s', async () => {
    // A brand-new table's GRANT is the thing production's ALTER DEFAULT PRIVILEGES hides. This asserts
    // BOTH halves: the admin write works at all (proving the GRANT reached ai_hr_app) and the employee
    // write is refused (proving the RLS policy is the tenant-admin one migration 0197 uses for `shift`).
    const a = adminCtx(b);
    const s = await mb28('WR5');
    await replaceShiftOtWindows(a, { shiftId: s.id, windows: [{ startTime: '17:00', endTime: '20:00' }] });

    const [p] = await owner.db
      .insert(schema.person)
      .values({ tenantId: b.tenantId, fullName: 'Nosy', primaryEmail: `nosy_${randomUUID()}@t.local` })
      .returning({ id: schema.person.id });
    await owner.db
      .insert(schema.employment)
      .values({ tenantId: b.tenantId, personId: p.id, companyId: b.companyId, hiredOn: '2020-01-01' });
    const uE = await createAppUser(b.tenantId, p.id, 'employee');
    const empCtx: SessionContext = { tenantId: b.tenantId, userId: uE, roles: ['employee'] };

    await expect(
      withTenant(empCtx, (tx) =>
        tx.update(schema.shiftOtWindow).set({ minMinutes: 999 }).where(eq(schema.shiftOtWindow.shiftId, s.id)),
      ),
    ).rejects.toThrow();
    // …but the read is tenant-wide, exactly like `shift` itself (the engine resolves for any employee).
    expect(await listShiftOtWindows(empCtx, s.id)).toHaveLength(1);
  });
});
