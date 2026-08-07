/**
 * ec4cbf63 rev-6 — per-employee DEFAULT shift ("assigned to the staff in their profile").
 *
 * Service (core/roster.ts assignDefaultShift):
 *  - happy path persists employment.default_shift_id and emits employment.shift-arrangement.assigned with
 *    { before, after }; b8aa3466 — passing null is REFUSED (BackupShiftRequiredError), it no longer clears
 *  - R33 f21d6eee: a shift authored under another company is now assignable (shared library — the old
 *    ShiftCompanyMismatchError was dropped)
 *  - an archived shift is rejected (ArchivedShiftError)
 *
 * Engine (core/attendance.ts scheduleFor): precedence roster row → default shift → company policy —
 *  - a default shift's hours drive workday OT on a pattern working day with NO roster row
 *  - a default shift's pattern REST day wins over the company working-days list
 *  - a dated roster row (shift or rest day) beats the default shift
 *  - a calendar holiday overlays dayType 'holiday' while the DEFAULT shift's hours/break still define the
 *    schedule (proven via the shift's different break deduction)
 *  - no default shift ⇒ byte-identical company-policy behaviour (regression guard)
 *
 * Batch (payableHoursForCycle, toggle ON): the default shift IS an assigned shift — same resolution order
 * as scheduleFor, so batch payable-hours and single-day derivation can't diverge.
 *
 * Dates: 2026-07-01 = Wednesday, 2026-07-04 = Saturday, 2026-07-06 = Monday. Default company policy:
 * 09:00–18:00, 60m break, Mon–Fri working. No holidays seeded unless a test inserts one.
 */
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { withTenant } from '../db/client';
import { checkIn, checkOut, payableHoursForCycle } from '../core/attendance';
import {
  ArchivedShiftError,
  BackupShiftRequiredError,
  archiveShift,
  assignDefaultShift,
  assignShift,
  createShift,
  setRestDay,
} from '../core/roster';
import {
  adminCtx,
  closeAll,
  eventTypesFor,
  latestEventPayload,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

let b: Base;
let empId: string;

const WED = '2026-07-01';
const SAT = '2026-07-04';
const MON = '2026-07-06';

async function makeEmp() {
  const [p] = await owner.db
    .insert(schema.person)
    .values({ tenantId: b.tenantId, fullName: 'DS', primaryEmail: `ds_${randomUUID()}@t.local` })
    .returning({ id: schema.person.id });
  const [e] = await owner.db
    .insert(schema.employment)
    .values({ tenantId: b.tenantId, personId: p.id, companyId: b.companyId, hiredOn: '2020-01-01' })
    .returning({ id: schema.employment.id });
  return e.id;
}

const storedDefaultShift = async (employmentId: string) => {
  const [row] = await owner.db
    .select({ ds: schema.employment.defaultShiftId })
    .from(schema.employment)
    .where(eq(schema.employment.id, employmentId));
  return row.ds;
};

/** Mon–Fri 06:00–18:00 with a 60m break — net 660 scheduled (vs the policy's 480). */
const longShift = () =>
  createShift(adminCtx(b), {
    companyId: b.companyId,
    name: 'Long',
    code: 'LONG',
    startTime: '06:00:00',
    endTime: '18:00:00',
    breakMinutes: 60,
    weeklyPattern: [1, 2, 3, 4, 5],
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
  empId = await makeEmp();
});

describe('assignDefaultShift — service + substrate', () => {
  it('assigns, emits employment.shift-arrangement.assigned with { before, after }; null is now REFUSED', async () => {
    const a = adminCtx(b);
    const s = await longShift();

    await assignDefaultShift(a, { employmentId: empId, shiftId: s.id });
    expect(await storedDefaultShift(empId)).toBe(s.id);
    expect(await eventTypesFor(b.tenantId, empId)).toEqual(
      expect.arrayContaining(['employment.shift-arrangement.assigned']),
    );
    // 3e8350db: the payload now records the full arrangement transition — { shiftType, defaultShiftId }
    // objects on both sides. That payload IS the reversal instruction the b8aa3466 backfill relies on.
    expect(await latestEventPayload(b.tenantId, empId, 'employment.shift-arrangement.assigned')).toMatchObject({
      before: { defaultShiftId: null, shiftType: 'roster' },
      after: { defaultShiftId: s.id, shiftType: 'fixed' },
    });

    // b8aa3466 — clearing USED TO BE the same write path, and that is the hole this item closes: an
    // employee with no backup shift has every unrostered day calculated from the flat company schedule.
    // The refusal must also leave the stored value alone, or "you cannot clear it" would be cosmetic.
    await expect(assignDefaultShift(a, { employmentId: empId, shiftId: null })).rejects.toBeInstanceOf(
      BackupShiftRequiredError,
    );
    expect(await storedDefaultShift(empId)).toBe(s.id);
  });

  it('R33 f21d6eee — a shift authored under a DIFFERENT company is now assignable (shared library)', async () => {
    const a = adminCtx(b);
    const [c2] = await owner.db
      .insert(schema.company)
      .values({ tenantId: b.tenantId, legalName: 'Beta Sdn Bhd' })
      .returning({ id: schema.company.id });
    // A shift stamped with company c2 (or, going forward, a tenant-global one) is a shared-library template:
    // assigning it to an employee in the base company must SUCCEED — the old ShiftCompanyMismatchError is gone.
    const foreign = await createShift(a, {
      companyId: c2.id,
      name: 'Beta Day',
      code: 'BDAY',
      startTime: '09:00:00',
      endTime: '18:00:00',
      breakMinutes: 60,
    });
    await assignDefaultShift(a, { employmentId: empId, shiftId: foreign.id });
    expect(await storedDefaultShift(empId)).toBe(foreign.id);
  });

  it('rejects an archived shift', async () => {
    const a = adminCtx(b);
    const s = await longShift();
    await archiveShift(a, { shiftId: s.id });
    await expect(assignDefaultShift(a, { employmentId: empId, shiftId: s.id })).rejects.toBeInstanceOf(
      ArchivedShiftError,
    );
    expect(await storedDefaultShift(empId)).toBeNull();
  });
});

describe('scheduleFor precedence — roster row → default shift → company policy', () => {
  it("a default shift's hours drive workday OT on a pattern working day (no roster row)", async () => {
    const a = adminCtx(b);
    const s = await longShift();
    await assignDefaultShift(a, { employmentId: empId, shiftId: s.id });
    await checkIn(a, { employmentId: empId, date: WED, time: '06:00:00' });
    const out = await checkOut(a, { employmentId: empId, date: WED, time: '19:00:00' });
    // shift scheduled 720−60=660; worked 780−60=720; OT 720−660=60 (the policy would give 720−480=240)
    expect(out).toMatchObject({ dayType: 'workday', workedMinutes: 720, otMinutes: 60 });
  });

  it("the default shift's pattern REST day wins over the company working-days list", async () => {
    const a = adminCtx(b);
    const s = await createShift(a, {
      companyId: b.companyId,
      name: 'TueSat',
      code: 'TUESAT',
      startTime: '09:00:00',
      endTime: '18:00:00',
      breakMinutes: 60,
      weeklyPattern: [2, 3, 4, 5, 6], // Tue–Sat: Monday is the shift's rest day, but a policy WORKING day
    });
    await assignDefaultShift(a, { employmentId: empId, shiftId: s.id });
    await checkIn(a, { employmentId: empId, date: MON, time: '09:00:00' });
    const out = await checkOut(a, { employmentId: empId, date: MON, time: '13:00:00' });
    // span 240 (<360 ⇒ no break deduction); rest_day ⇒ all 240 is rest-day OT
    expect(out).toMatchObject({ dayType: 'rest_day', workedMinutes: 240, otMinutes: 240 });
  });

  it('a dated roster row (shift) beats the default shift', async () => {
    const a = adminCtx(b);
    const long = await longShift();
    const short = await createShift(a, {
      companyId: b.companyId,
      name: 'Short',
      code: 'SHORT',
      startTime: '08:00:00',
      endTime: '17:00:00',
      breakMinutes: 60,
    });
    await assignDefaultShift(a, { employmentId: empId, shiftId: long.id });
    await assignShift(a, { employmentId: empId, shiftDate: WED, shiftId: short.id });
    await checkIn(a, { employmentId: empId, date: WED, time: '08:00:00' });
    const out = await checkOut(a, { employmentId: empId, date: WED, time: '19:00:00' });
    // worked 660−60=600; OT vs the ROSTERED shift's 480 = 120 (the default shift's 660 would give 0)
    expect(out).toMatchObject({ dayType: 'workday', workedMinutes: 600, otMinutes: 120 });
  });

  it('a dated rostered REST day beats the default shift', async () => {
    const a = adminCtx(b);
    const long = await longShift();
    await assignDefaultShift(a, { employmentId: empId, shiftId: long.id });
    await setRestDay(a, { employmentId: empId, shiftDate: WED });
    await checkIn(a, { employmentId: empId, date: WED, time: '09:00:00' });
    const out = await checkOut(a, { employmentId: empId, date: WED, time: '13:00:00' });
    // rest_day ⇒ all 240 is OT (with the default shift winning it would be a workday with 0 OT)
    expect(out).toMatchObject({ dayType: 'rest_day', workedMinutes: 240, otMinutes: 240 });
  });

  it("a calendar holiday overlays dayType 'holiday' while the default shift's hours define the schedule", async () => {
    const a = adminCtx(b);
    // 120m break (vs the policy's 60) so the worked-minutes figure proves the SHIFT branch resolved the day.
    const s = await createShift(a, {
      companyId: b.companyId,
      name: 'LongBreak',
      code: 'LONGBRK',
      startTime: '06:00:00',
      endTime: '18:00:00',
      breakMinutes: 120,
      weeklyPattern: [1, 2, 3, 4, 5],
    });
    await assignDefaultShift(a, { employmentId: empId, shiftId: s.id });
    await owner.db.insert(schema.holiday).values({
      tenantId: b.tenantId,
      country: 'MY',
      state: null,
      companyId: b.companyId,
      holidayDate: WED,
      name: 'Group Founders Day',
    });
    await checkIn(a, { employmentId: empId, date: WED, time: '06:00:00' });
    const out = await checkOut(a, { employmentId: empId, date: WED, time: '18:00:00' });
    // span 720 − the SHIFT's 120 break = 600 worked (the policy branch would deduct 60 → 660); holiday ⇒
    // the whole worked span is premium-class OT.
    expect(out).toMatchObject({ dayType: 'holiday', workedMinutes: 600, otMinutes: 600 });
  });

  it('no default shift ⇒ unchanged company-policy behaviour (regression guard)', async () => {
    const a = adminCtx(b);
    await checkIn(a, { employmentId: empId, date: WED, time: '09:00:00' });
    const out = await checkOut(a, { employmentId: empId, date: WED, time: '20:00:00' });
    // policy 09:00–18:00 break 60 → scheduled 480; worked 660−60=600; OT 120 — byte-identical to before
    expect(out).toMatchObject({ status: 'present', dayType: 'workday', workedMinutes: 600, otMinutes: 120 });
  });
});

describe('payableHoursForCycle — the batch path applies the same default-shift fallback', () => {
  it('toggle ON clamps default-shift days, zeroes pattern rest + rostered rest days; toggle OFF sums all', async () => {
    const a = adminCtx(b);
    const s = await createShift(a, {
      companyId: b.companyId,
      name: 'Std',
      code: 'STD',
      startTime: '09:00:00',
      endTime: '18:00:00',
      breakMinutes: 60,
      weeklyPattern: [1, 2, 3, 4, 5], // Mon–Fri working, Sat/Sun rest
    });
    await assignDefaultShift(a, { employmentId: empId, shiftId: s.id });

    // Wed (pattern working day, no roster): 09:00–20:00 → 600 worked, clamps to the shift's 480.
    await checkIn(a, { employmentId: empId, date: WED, time: '09:00:00' });
    await checkOut(a, { employmentId: empId, date: WED, time: '20:00:00' });
    // Sat (pattern REST day, no roster): 240 worked → not an assigned shift → 0 payable when ON.
    await checkIn(a, { employmentId: empId, date: SAT, time: '09:00:00' });
    await checkOut(a, { employmentId: empId, date: SAT, time: '13:00:00' });
    // Mon (rostered REST day — the roster row wins over the default shift): 240 worked → 0 payable when ON.
    await setRestDay(a, { employmentId: empId, shiftDate: MON });
    await checkIn(a, { employmentId: empId, date: MON, time: '09:00:00' });
    await checkOut(a, { employmentId: empId, date: MON, time: '13:00:00' });

    const window = { from: WED, to: MON };
    const on = await withTenant(a, (tx) =>
      payableHoursForCycle(tx, empId, window, { onlyPullHoursWithinShiftSchedule: true }),
    );
    expect(on).toBe(8); // min(600, 480) + 0 + 0 = 480m
    const off = await withTenant(a, (tx) =>
      payableHoursForCycle(tx, empId, window, { onlyPullHoursWithinShiftSchedule: false }),
    );
    expect(off).toBe(18); // 600 + 240 + 240 = 1080m — toggle OFF is unchanged by the default shift
  });
});
