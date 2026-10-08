/**
 * r429 (f6819e19) · D6 — THE BREAK VALIDATION MATRIX, asserted against the SERVICE (core/roster.ts
 * createShift/updateShift), which is the authority; the client (components/shift-time-fields.tsx) mirrors
 * the same rules from the SAME leaf module (core/shift-break-rules.ts) for its live, per-row preview.
 *
 * Every case here is a refusal (never a silent drop) OR an acceptance, named for the rule it pins:
 *   · overlap, including two rows with IDENTICAL times, across ALL rows (paid included)
 *   · a half-filled row (one time typed, the other blank)
 *   · a break of zero minutes
 *   · a wrapped break (end < start) ACCEPTED on a shift that crosses midnight, and REFUSED on one that
 *     does not
 *   · a wrapped break that falls outside the shift span even though it IS a valid wrap
 *   · a flexible duration outside 1..length (zero, negative, longer than the window)
 *   · a flexible duration on a WRAPPED break, bounded by its wrap-aware length, not a negative one
 *
 * A blank row (neither time) is proven separately: it is accepted because it is DROPPED before
 * validation, which test/r277-per-break-allowance.test.ts and the others already rely on implicitly by
 * never including one — pinned explicitly here once.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { checkIn, checkOut } from '../core/attendance';
import { assignDefaultShift, createShift } from '../core/roster';
import { hireEmployee } from '../core/org';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

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
});

const dayShift = (over: Partial<Parameters<typeof createShift>[1]> = {}) =>
  createShift(adminCtx(b), {
    name: `V_${randomUUID().slice(0, 6)}`,
    code: `V_${randomUUID().slice(0, 6)}`,
    startTime: '09:00:00',
    endTime: '18:00:00',
    breakMinutes: 0,
    weeklyPattern: [1, 2, 3, 4, 5],
    ...over,
  });

const nightShift = (over: Partial<Parameters<typeof createShift>[1]> = {}) =>
  createShift(adminCtx(b), {
    name: `N_${randomUUID().slice(0, 6)}`,
    code: `N_${randomUUID().slice(0, 6)}`,
    startTime: '22:00:00',
    endTime: '06:00:00',
    breakMinutes: 0,
    weeklyPattern: [1, 2, 3, 4, 5, 6, 7],
    ...over,
  });

const shiftRow = async (id: string) => (await owner.db.select().from(schema.shift).where(eq(schema.shift.id, id)))[0];

describe('D6 — overlap, including duplicates, across ALL rows (paid included)', () => {
  it('refuses two overlapping unpaid rows', async () => {
    await expect(
      dayShift({ breakPeriods: [{ start: '12:00', end: '13:00' }, { start: '12:30', end: '13:30' }] }),
    ).rejects.toThrow(/overlap/i);
  });

  it('refuses two IDENTICAL rows as an overlap', async () => {
    await expect(
      dayShift({ breakPeriods: [{ start: '12:00', end: '13:00' }, { start: '12:00', end: '13:00' }] }),
    ).rejects.toThrow(/overlap/i);
  });

  it('refuses an overlap even when one of the pair is PAID', async () => {
    await expect(
      dayShift({ breakPeriods: [{ start: '12:00', end: '13:00', paid: true }, { start: '12:30', end: '13:00' }] }),
    ).rejects.toThrow(/overlap/i);
  });

  it('accepts two back-to-back rows that touch but do not overlap (13:00 end meets 13:00 start)', async () => {
    const sh = await dayShift({ breakPeriods: [{ start: '12:00', end: '13:00' }, { start: '13:00', end: '13:15' }] });
    expect((await shiftRow(sh.id)).breakPeriods).toHaveLength(2);
  });
});

describe('D6 — a half-filled row is REFUSED, never silently dropped', () => {
  it('refuses a row with a start and no end', async () => {
    await expect(dayShift({ breakPeriods: [{ start: '12:00', end: '' }] })).rejects.toThrow(/needs.*end time/i);
  });

  it('refuses a row with an end and no start', async () => {
    await expect(dayShift({ breakPeriods: [{ start: '', end: '13:00' }] })).rejects.toThrow(/needs.*start time/i);
  });

  it('a fully BLANK row (neither time) is dropped, not refused — it saves nothing', async () => {
    const sh = await dayShift({ breakPeriods: [{ start: '', end: '' }, { start: '12:00', end: '13:00' }] });
    expect((await shiftRow(sh.id)).breakPeriods).toEqual([{ start: '12:00:00', end: '13:00:00' }]);
  });
});

describe('D6 — a break cannot be zero minutes long', () => {
  it('refuses start === end', async () => {
    await expect(dayShift({ breakPeriods: [{ start: '12:00', end: '12:00' }] })).rejects.toThrow(/zero minutes/i);
  });
});

describe('D6 — a wrapped break is accepted ONLY on a shift that crosses midnight', () => {
  it('refuses end < start on a shift that does NOT cross midnight', async () => {
    await expect(dayShift({ breakPeriods: [{ start: '14:00', end: '13:00' }] })).rejects.toThrow(
      /ends before it starts.*does not cross midnight/i,
    );
  });

  it('accepts a wrapped break on a shift that crosses midnight, and the engine deducts the right minutes', async () => {
    const sh = await nightShift({ breakPeriods: [{ start: '23:45', end: '00:15' }] });
    const row = await shiftRow(sh.id);
    expect(row.breakPeriods).toEqual([{ start: '23:45:00', end: '00:15:00' }]);
    expect(row.breakMinutes, 'wrap-aware: 30 minutes, not a negative number').toBe(30);

    const a = adminCtx(b);
    const e = await hireEmployee(a, {
      person: { fullName: 'Wrap Break', primaryEmail: `wrap_${randomUUID()}@t.local` },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await assignDefaultShift(a, { employmentId: e.employmentId, shiftId: sh.id });
    // Same calling convention every other night-shift test in this suite uses (e.g.
    // test/shift-four-way-and-cutoff.test.ts "item 7"): ONE attendance date for both punches — the day the
    // shift STARTED — and the engine places the actual clock-out past midnight on its own.
    await checkIn(a, { employmentId: e.employmentId, date: '2026-05-05', time: '22:00:00' });
    const out = await checkOut(a, { employmentId: e.employmentId, date: '2026-05-05', time: '06:00:00' });
    // 480 span − 30 wrapped break = 450 worked.
    expect(out.workedMinutes).toBe(450);
  });

  it('refuses a wrapped break whose end sits AFTER the shift closes, even though the wrap itself is valid', async () => {
    // 22:00→06:00 shift; a break "23:45 to 07:00" wraps but its end (07:00) is past the shift's own end
    // (06:00) — a valid-shaped wrap that is still outside the span.
    await expect(nightShift({ breakPeriods: [{ start: '23:45', end: '07:00' }] })).rejects.toThrow(/must fall inside the shift/i);
  });

  it('refuses a wrapped break whose start sits BEFORE the shift opens', async () => {
    // "21:00 to 00:15" wraps, but 21:00 is before this shift's 22:00 start.
    await expect(nightShift({ breakPeriods: [{ start: '21:00', end: '00:15' }] })).rejects.toThrow(/must fall inside the shift/i);
  });
});

describe('D6 — flexible minutes, 1..length, wrap-aware', () => {
  it('refuses zero', async () => {
    await expect(
      dayShift({ breakPeriods: [{ start: '12:00', end: '13:00', flexible: true, flexibleMinutes: 0 }] }),
    ).rejects.toThrow(/needs a flexible duration/i);
  });

  it('refuses negative', async () => {
    await expect(
      dayShift({ breakPeriods: [{ start: '12:00', end: '13:00', flexible: true, flexibleMinutes: -5 }] }),
    ).rejects.toThrow(/needs a flexible duration/i);
  });

  it('refuses longer than the window', async () => {
    await expect(
      dayShift({ breakPeriods: [{ start: '12:00', end: '13:00', flexible: true, flexibleMinutes: 61 }] }),
    ).rejects.toThrow(/cannot be longer than the break itself/i);
  });

  it('accepts exactly the window length', async () => {
    const sh = await dayShift({ breakPeriods: [{ start: '12:00', end: '13:00', flexible: true, flexibleMinutes: 60 }] });
    expect((await shiftRow(sh.id)).breakPeriods![0]).toMatchObject({ flexibleMinutes: 60 });
  });

  it('on a WRAPPED break, the bound is the wrap-aware length (30), not a negative number', async () => {
    await expect(
      nightShift({ breakPeriods: [{ start: '23:45', end: '00:15', flexible: true, flexibleMinutes: 31 }] }),
    ).rejects.toThrow(/cannot be longer than the break itself/i);
    const sh = await nightShift({ breakPeriods: [{ start: '23:45', end: '00:15', flexible: true, flexibleMinutes: 30 }] });
    expect((await shiftRow(sh.id)).breakPeriods![0]).toMatchObject({ flexibleMinutes: 30 });
  });
});
