/**
 * ADR-0032 C2 — the roster drives the time engine. Asserts: NO roster ⇒ byte-identical to the pre-Phase-C
 * policy engine (compat); a rostered shift's scheduled hours drive workday OT (not the company policy);
 * cross-midnight night shifts compute worked minutes across midnight without the "check-out after check-in"
 * error; a rostered rest day classifies all work as rest-day OT; a shift on a company rest day is a workday;
 * and a NON-rostered day still rejects a check-out before check-in.
 *
 * Dates: 2026-07-01 = Wednesday (default workday), 2026-07-05 = Sunday (default rest day). No holidays seeded.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as schema from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { checkIn, checkOut } from '../core/attendance';
import { assignShift, createShift, setRestDay } from '../core/roster';

let b: Base;
let empId: string;

async function makeEmp() {
  const [p] = await owner.db
    .insert(schema.person)
    .values({ tenantId: b.tenantId, fullName: 'W', primaryEmail: `w_${randomUUID()}@t.local` })
    .returning({ id: schema.person.id });
  const [e] = await owner.db
    .insert(schema.employment)
    .values({ tenantId: b.tenantId, personId: p.id, companyId: b.companyId, hiredOn: '2020-01-01' })
    .returning({ id: schema.employment.id });
  return e.id;
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
  empId = await makeEmp();
});

describe('attendance × roster (ADR-0032 C2)', () => {
  it('NO roster = byte-identical to the policy engine (present, no OT)', async () => {
    const ctx = adminCtx(b);
    await checkIn(ctx, { employmentId: empId, date: '2026-07-01', time: '09:00:00' });
    const out = await checkOut(ctx, { employmentId: empId, date: '2026-07-01', time: '18:00:00' });
    // policy default 09:00–18:00 break 60 → scheduled 480; worked 540−60=480; OT 0
    expect(out).toMatchObject({ status: 'present', dayType: 'workday', workedMinutes: 480, otMinutes: 0 });
  });

  it('NO roster: late check-in + overtime (compat)', async () => {
    const ctx = adminCtx(b);
    await checkIn(ctx, { employmentId: empId, date: '2026-07-01', time: '09:30:00' }); // > 09:15 ⇒ late
    const out = await checkOut(ctx, { employmentId: empId, date: '2026-07-01', time: '20:00:00' });
    // worked 630−60=570; OT 570−480=90
    expect(out).toMatchObject({ status: 'late', workedMinutes: 570, otMinutes: 90 });
  });

  it("a rostered shift's scheduled hours drive OT (not the company policy)", async () => {
    const ctx = adminCtx(b);
    const s = await createShift(ctx, { companyId: b.companyId, name: 'Long', code: 'LONG', startTime: '06:00:00', endTime: '18:00:00', breakMinutes: 60 });
    await assignShift(ctx, { employmentId: empId, shiftDate: '2026-07-01', shiftId: s.id });
    await checkIn(ctx, { employmentId: empId, date: '2026-07-01', time: '06:00:00' });
    const out = await checkOut(ctx, { employmentId: empId, date: '2026-07-01', time: '19:00:00' });
    // shift scheduled 720−60=660; worked 780−60=720; OT 720−660=60 (policy would give 720−480=240)
    expect(out).toMatchObject({ dayType: 'workday', workedMinutes: 720, otMinutes: 60 });
  });

  it('cross-midnight night shift: worked spans midnight, no error', async () => {
    const ctx = adminCtx(b);
    const s = await createShift(ctx, { companyId: b.companyId, name: 'Night', code: 'NIGHT', startTime: '22:00:00', endTime: '06:00:00', breakMinutes: 60 });
    await assignShift(ctx, { employmentId: empId, shiftDate: '2026-07-01', shiftId: s.id });
    await checkIn(ctx, { employmentId: empId, date: '2026-07-01', time: '22:00:00' });
    const out = await checkOut(ctx, { employmentId: empId, date: '2026-07-01', time: '06:00:00' }); // next day
    // span 480 (22:00→06:00); worked 420; shift scheduled 480−60=420; OT 0
    expect(out).toMatchObject({ dayType: 'workday', workedMinutes: 420, otMinutes: 0 });
  });

  it('cross-midnight night shift: OT past the shift end', async () => {
    const ctx = adminCtx(b);
    const s = await createShift(ctx, { companyId: b.companyId, name: 'Night', code: 'NIGHT', startTime: '22:00:00', endTime: '06:00:00', breakMinutes: 60 });
    await assignShift(ctx, { employmentId: empId, shiftDate: '2026-07-02', shiftId: s.id });
    await checkIn(ctx, { employmentId: empId, date: '2026-07-02', time: '22:00:00' });
    const out = await checkOut(ctx, { employmentId: empId, date: '2026-07-02', time: '07:00:00' });
    // span 540; worked 480; scheduled 420; OT 60
    expect(out).toMatchObject({ workedMinutes: 480, otMinutes: 60 });
  });

  it('rostered rest day ⇒ all work is rest-day OT', async () => {
    const ctx = adminCtx(b);
    await setRestDay(ctx, { employmentId: empId, shiftDate: '2026-07-01' });
    await checkIn(ctx, { employmentId: empId, date: '2026-07-01', time: '09:00:00' });
    const out = await checkOut(ctx, { employmentId: empId, date: '2026-07-01', time: '13:00:00' });
    // span 240 (<360 ⇒ no break deduction); rest_day ⇒ OT = all 240
    expect(out).toMatchObject({ dayType: 'rest_day', workedMinutes: 240, otMinutes: 240 });
  });

  it('a rostered shift on a company rest day (Sunday) is a workday', async () => {
    const ctx = adminCtx(b);
    const s = await createShift(ctx, { companyId: b.companyId, name: 'Day', code: 'DAY', startTime: '08:00:00', endTime: '17:00:00', breakMinutes: 60 });
    await assignShift(ctx, { employmentId: empId, shiftDate: '2026-07-05', shiftId: s.id }); // Sunday
    await checkIn(ctx, { employmentId: empId, date: '2026-07-05', time: '08:00:00' });
    const out = await checkOut(ctx, { employmentId: empId, date: '2026-07-05', time: '17:00:00' });
    // workday (not the default Sunday rest_day) ⇒ OT 0 against the shift's 480 scheduled
    expect(out).toMatchObject({ dayType: 'workday', otMinutes: 0 });
  });

  it('NON-rostered day still rejects a check-out before check-in (no spurious midnight wrap)', async () => {
    const ctx = adminCtx(b);
    await checkIn(ctx, { employmentId: empId, date: '2026-07-01', time: '22:00:00' });
    await expect(checkOut(ctx, { employmentId: empId, date: '2026-07-01', time: '06:00:00' })).rejects.toThrow(/after check-in/i);
  });
});
