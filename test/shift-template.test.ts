/**
 * R7 Multi-Shift — PHASE 1 (shift template). Covers: auto normal-hours from the SHARED core/attendance.ts
 * helpers (shiftSpan / netScheduledMinutes — proving the math is not forked into roster.ts); the manual
 * normal-hours override being REAL (it changes what counts as workday OVERTIME through deriveAttendance,
 * not just a displayed figure); per-company non-archived code uniqueness (archive frees the code); multi-
 * break persistence with the canonical breakMinutes scalar (= Σ durations, storage-only this phase);
 * the 0139 backfill leaving legacy shifts editable; and the byte-identical regression for a legacy
 * single-break shift resolved through scheduleFor. (R33 f21d6eee retired duplicateShift.)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, eventTypesFor, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { checkIn, checkOut, netScheduledMinutes, shiftSpan } from '../core/attendance';
import { archiveShift, assignShift, createShift, listShifts, updateShift } from '../core/roster';

let b: Base;
let employmentId: string;

async function makeEmployment() {
  const [p] = await owner.db
    .insert(schema.person)
    .values({ tenantId: b.tenantId, fullName: 'Worker', primaryEmail: `w_${randomUUID()}@t.local` })
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
  employmentId = await makeEmployment();
});

describe('shift template (R7 Multi-Shift Phase 1)', () => {
  it('auto normal-hours = span − breaks via the SHARED attendance helpers, cross-midnight aware', () => {
    expect(shiftSpan('09:00:00', '18:00:00', false)).toBe(540);
    expect(shiftSpan('22:00:00', '06:00:00', true)).toBe(480);
    expect(netScheduledMinutes('09:00:00', '18:00:00', false, 60)).toBe(480);
    expect(netScheduledMinutes('22:00:00', '06:00:00', true, 45)).toBe(435);
    expect(netScheduledMinutes('09:00:00', '10:00:00', false, 90)).toBe(0); // floored at 0
  });

  /** cf21e554 stage 1 — the reference General tab's "Normal Hours Rounding" box. The parameter is
   *  optional and every existing caller omits it, so the three assertions above are the proof that the
   *  default path is untouched; these are the new behaviour. */
  it('normal-hours rounding rounds the NET figure DOWN to a multiple, and null/0 is a strict no-op', () => {
    // 09:00–17:50 − 60 = 470 net. Down to the quarter hour ⇒ 465.
    expect(netScheduledMinutes('09:00:00', '17:50:00', false, 60, 15)).toBe(465);
    expect(netScheduledMinutes('09:00:00', '17:50:00', false, 60, 30)).toBe(450);
    // Already a multiple ⇒ unchanged.
    expect(netScheduledMinutes('09:00:00', '18:00:00', false, 60, 15)).toBe(480);
    // No rounding configured, in each of the three ways that can be expressed.
    expect(netScheduledMinutes('09:00:00', '17:50:00', false, 60)).toBe(470);
    expect(netScheduledMinutes('09:00:00', '17:50:00', false, 60, null)).toBe(470);
    expect(netScheduledMinutes('09:00:00', '17:50:00', false, 60, 0)).toBe(470);
    // A rounding unit larger than the shift floors it to zero — which is what "round down" means, and why
    // the column is bounded at 1440 rather than left open.
    expect(netScheduledMinutes('09:00:00', '12:00:00', false, 0, 240)).toBe(0);
    // Cross-midnight is rounded the same way (480 − 45 = 435 ⇒ 420 at the half hour).
    expect(netScheduledMinutes('22:00:00', '06:00:00', true, 45, 30)).toBe(420);
  });

  it('multiple break periods persist AND the canonical breakMinutes scalar = their sum', async () => {
    const ctx = adminCtx(b);
    const r = await createShift(ctx, {
      companyId: b.companyId,
      name: 'Split Day',
      code: 'SPLIT',
      startTime: '08:00:00',
      endTime: '18:00:00',
      breakPeriods: [
        { start: '12:00:00', end: '13:00:00' },
        { start: '15:30:00', end: '15:45:00' },
      ],
    });
    const [row] = await owner.db.select().from(schema.shift).where(eq(schema.shift.id, r.id));
    expect(row.code).toBe('SPLIT');
    expect(row.breakPeriods).toEqual([
      { start: '12:00:00', end: '13:00:00' },
      { start: '15:30:00', end: '15:45:00' },
    ]);
    expect(row.breakMinutes).toBe(75); // 60 + 15 — the scalar every existing consumer keeps reading
    expect(await eventTypesFor(b.tenantId, r.id)).toContain('shift.created');
  });

  it('rejects a break outside the span or crossing midnight; accepts one in a night shift’s morning segment', async () => {
    const ctx = adminCtx(b);
    await expect(
      createShift(ctx, {
        companyId: b.companyId,
        name: 'BadBreak',
        code: 'BB1',
        startTime: '08:00:00',
        endTime: '18:00:00',
        breakPeriods: [{ start: '07:00:00', end: '07:30:00' }],
      }),
    ).rejects.toThrow(/inside the shift/i);
    // A break spanning the night shift's midnight boundary cannot be expressed with start < end → rejected.
    await expect(
      createShift(ctx, {
        companyId: b.companyId,
        name: 'BadBreak2',
        code: 'BB2',
        startTime: '22:00:00',
        endTime: '06:00:00',
        breakPeriods: [{ start: '23:30:00', end: '00:30:00' }],
      }),
    ).rejects.toThrow(/cannot cross midnight/i);
    // Fully inside the morning segment of a cross-midnight shift is fine.
    const ok = await createShift(ctx, {
      companyId: b.companyId,
      name: 'Night Split',
      code: 'NSPLIT',
      startTime: '22:00:00',
      endTime: '06:00:00',
      breakPeriods: [{ start: '02:00:00', end: '02:30:00' }],
    });
    const [row] = await owner.db.select().from(schema.shift).where(eq(schema.shift.id, ok.id));
    expect(row.breakMinutes).toBe(30);
    expect(row.crossesMidnight).toBe(true);
  });

  it('override affects OVERTIME (not just display): 7h override + 8h worked ⇒ 1h OT via deriveAttendance', async () => {
    const ctx = adminCtx(b);
    // 09:00–17:00, no break, manual normal hours 7h (420m). 2026-07-01 is a Wednesday (default workday).
    const s = await createShift(ctx, {
      companyId: b.companyId,
      name: 'Std',
      code: 'STD',
      startTime: '09:00:00',
      endTime: '17:00:00',
      breakMinutes: 0,
      normalMinutesOverride: 420,
    });
    await assignShift(ctx, { employmentId, shiftDate: '2026-07-01', shiftId: s.id });
    await checkIn(ctx, { employmentId, date: '2026-07-01', time: '09:00:00' });
    const out = await checkOut(ctx, { employmentId, date: '2026-07-01', time: '17:00:00' });
    // worked 480 (span 480, break 0); OT = 480 − 420 (the OVERRIDE, not span−break=480) = 60
    expect(out).toMatchObject({ dayType: 'workday', workedMinutes: 480, otMinutes: 60 });
  });

  it('no override ⇒ workday OT measured against span − breaks (unchanged)', async () => {
    const ctx = adminCtx(b);
    const s = await createShift(ctx, {
      companyId: b.companyId,
      name: 'Std',
      code: 'STD',
      startTime: '09:00:00',
      endTime: '17:00:00',
      breakMinutes: 0,
    });
    await assignShift(ctx, { employmentId, shiftDate: '2026-07-01', shiftId: s.id });
    await checkIn(ctx, { employmentId, date: '2026-07-01', time: '09:00:00' });
    const out = await checkOut(ctx, { employmentId, date: '2026-07-01', time: '17:00:00' });
    expect(out).toMatchObject({ dayType: 'workday', workedMinutes: 480, otMinutes: 0 });
  });

  it('validates the override bounds (0..span) and requires a non-empty code', async () => {
    const ctx = adminCtx(b);
    await expect(
      createShift(ctx, { companyId: b.companyId, name: 'X', code: 'X1', startTime: '09:00:00', endTime: '17:00:00', normalMinutesOverride: 481 }),
    ).rejects.toThrow(/between 0 and the shift span/i);
    await expect(
      createShift(ctx, { companyId: b.companyId, name: 'X', code: '   ', startTime: '09:00:00', endTime: '17:00:00' }),
    ).rejects.toThrow(/code is required/i);
  });

  it('code is unique per company among NON-archived rows (case-insensitive); archiving frees it', async () => {
    const ctx = adminCtx(b);
    const first = await createShift(ctx, { companyId: b.companyId, name: 'Day A', code: 'DAY', startTime: '09:00:00', endTime: '18:00:00' });
    await expect(
      createShift(ctx, { companyId: b.companyId, name: 'Day B', code: 'day', startTime: '10:00:00', endTime: '19:00:00' }),
    ).rejects.toThrow(/code/i);
    await archiveShift(ctx, { shiftId: first.id });
    const again = await createShift(ctx, { companyId: b.companyId, name: 'Day B', code: 'DAY', startTime: '10:00:00', endTime: '19:00:00' });
    expect((await listShifts(ctx, b.companyId)).map((r) => r.id)).toEqual([again.id]);
  });

  it('a 0139-backfilled legacy shift (code was NULL) gets a code and stays editable through updateShift', async () => {
    const ctx = adminCtx(b);
    // Simulate a pre-0139 row (created before the code column was required by the service), then run the
    // exact backfill expression the migration applies.
    const [legacy] = await owner.db
      .insert(schema.shift)
      .values({ tenantId: b.tenantId, companyId: b.companyId, name: 'Legacy Day', startTime: '09:00:00', endTime: '18:00:00', breakMinutes: 60 })
      .returning({ id: schema.shift.id });
    await owner.db.execute(
      sql`UPDATE shift SET code = upper(left(regexp_replace(name, '[^A-Za-z0-9]', '', 'g'), 6)) || '-' || left(id::text, 4) WHERE code IS NULL`,
    );
    const [backfilled] = await owner.db.select().from(schema.shift).where(eq(schema.shift.id, legacy.id));
    expect(backfilled.code).toMatch(/^LEGACY-/);

    await updateShift(ctx, {
      shiftId: legacy.id,
      name: 'Legacy Day',
      code: backfilled.code!,
      startTime: '09:00:00',
      endTime: '17:30:00',
      breakMinutes: 45,
    });
    const [after] = await owner.db.select().from(schema.shift).where(eq(schema.shift.id, legacy.id));
    expect(after.endTime).toBe('17:30:00');
    expect(after.breakMinutes).toBe(45);
    expect(await eventTypesFor(b.tenantId, legacy.id)).toContain('shift.updated');
  });

  it('REGRESSION: a legacy single-break shift (no breakPeriods, no code) resolves byte-identically through scheduleFor', async () => {
    const ctx = adminCtx(b);
    // The exact pre-Phase-1 row shape: scalar break only, code/breakPeriods/override all NULL.
    const [legacy] = await owner.db
      .insert(schema.shift)
      .values({ tenantId: b.tenantId, companyId: b.companyId, name: 'Long', startTime: '06:00:00', endTime: '18:00:00', breakMinutes: 60 })
      .returning({ id: schema.shift.id });
    await assignShift(ctx, { employmentId, shiftDate: '2026-07-01', shiftId: legacy.id });
    await checkIn(ctx, { employmentId, date: '2026-07-01', time: '06:00:00' });
    const out = await checkOut(ctx, { employmentId, date: '2026-07-01', time: '19:00:00' });
    // Identical to the pre-change attendance-roster expectation: scheduled 720−60=660; worked 780−60=720; OT 60.
    expect(out).toMatchObject({ dayType: 'workday', workedMinutes: 720, otMinutes: 60 });
  });
});
