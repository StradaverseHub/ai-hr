/**
 * ADR-0032 C4 — roster vs actual. For each rostered shift the variance read classifies a no-show, late
 * check-in, short hours, or on-track; on-leave and future shifts are not no-shows; a worked rest day is
 * rest_worked. today is injected for a deterministic past/future cutoff.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as schema from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { checkIn, checkOut } from '../core/attendance';
import { assignShift, createShift, rosterVariance, setRestDay } from '../core/roster';

let b: Base;
let emp1: string;
let emp2: string;
let shiftId: string;

async function makeEmp() {
  const [p] = await owner.db
    .insert(schema.person)
    .values({ tenantId: b.tenantId, fullName: `W ${randomUUID().slice(0, 8)}`, primaryEmail: `w_${randomUUID()}@t.local` })
    .returning({ id: schema.person.id });
  const [e] = await owner.db
    .insert(schema.employment)
    .values({ tenantId: b.tenantId, personId: p.id, companyId: b.companyId, hiredOn: '2020-01-01' })
    .returning({ id: schema.employment.id });
  return e.id;
}

const TODAY = '2026-07-15';

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  emp1 = await makeEmp();
  emp2 = await makeEmp();
  // shift 08:00–17:00 break 60 ⇒ 480 scheduled minutes
  const ctx = adminCtx(b);
  shiftId = (await createShift(ctx, { companyId: b.companyId, name: 'Day', code: 'DAY', startTime: '08:00:00', endTime: '17:00:00', breakMinutes: 60 })).id;
});

const kindFor = (rows: { employmentId: string; shiftDate: string; kind: string }[], emp: string, date: string) =>
  rows.find((r) => r.employmentId === emp && r.shiftDate === date)?.kind;

describe('roster variance (ADR-0032 C4)', () => {
  it('classifies no-show / late / short / on-track, and skips on-leave + future', async () => {
    const ctx = adminCtx(b);
    // 2026-07-01 Wed no-show; 07-02 late; 07-03 short; 07-06 on-track; 07-07 on leave; 07-20 future
    for (const d of ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-06', '2026-07-07', '2026-07-20']) {
      await assignShift(ctx, { employmentId: emp1, shiftDate: d, shiftId });
    }
    await checkIn(ctx, { employmentId: emp1, date: '2026-07-02', time: '08:20:00' }); // > 08:15 ⇒ late
    await checkOut(ctx, { employmentId: emp1, date: '2026-07-02', time: '17:00:00' });
    await checkIn(ctx, { employmentId: emp1, date: '2026-07-03', time: '08:00:00' });
    await checkOut(ctx, { employmentId: emp1, date: '2026-07-03', time: '12:00:00' }); // worked 240 < 480 ⇒ short
    await checkIn(ctx, { employmentId: emp1, date: '2026-07-06', time: '08:00:00' });
    await checkOut(ctx, { employmentId: emp1, date: '2026-07-06', time: '17:00:00' }); // worked 480 ⇒ on-track
    await owner.db.insert(schema.leaveRequest).values({
      tenantId: b.tenantId,
      employmentId: emp1,
      leaveTypeId: b.annualLeaveTypeId,
      startDate: '2026-07-07',
      endDate: '2026-07-07',
      days: '1.00',
      status: 'approved',
    });

    const rows = await rosterVariance(ctx, { from: '2026-07-01', to: '2026-07-31', today: TODAY });
    expect(kindFor(rows, emp1, '2026-07-01')).toBe('no_show');
    expect(kindFor(rows, emp1, '2026-07-02')).toBe('late');
    expect(kindFor(rows, emp1, '2026-07-03')).toBe('short');
    expect(kindFor(rows, emp1, '2026-07-06')).toBe('on_track');
    expect(kindFor(rows, emp1, '2026-07-07')).toBeUndefined(); // on leave ⇒ not a no-show
    expect(kindFor(rows, emp1, '2026-07-20')).toBeUndefined(); // future ⇒ not yet due
  });

  it('a worked rostered rest day is rest_worked', async () => {
    const ctx = adminCtx(b);
    await setRestDay(ctx, { employmentId: emp2, shiftDate: '2026-07-01' });
    await checkIn(ctx, { employmentId: emp2, date: '2026-07-01', time: '09:00:00' });
    await checkOut(ctx, { employmentId: emp2, date: '2026-07-01', time: '13:00:00' });
    const rows = await rosterVariance(ctx, { from: '2026-07-01', to: '2026-07-31', today: TODAY });
    expect(kindFor(rows, emp2, '2026-07-01')).toBe('rest_worked');
  });

  it('an unworked rostered rest day produces no variance row', async () => {
    const ctx = adminCtx(b);
    await setRestDay(ctx, { employmentId: emp2, shiftDate: '2026-07-01' });
    const rows = await rosterVariance(ctx, { from: '2026-07-01', to: '2026-07-31', today: TODAY });
    expect(rows).toHaveLength(0);
  });

  /**
   * cf21e554 — the Roster screen must expect the SAME figure the engine schedules against.
   *
   * rosterVariance carried its own inlined span−break, and its select never fetched the shift's
   * Normal-Hours Rounding, so /roster computed the UNROUNDED net. A shift that rounds therefore had two
   * different "expected" figures: the engine's 465 (underMinutes 0, nothing owed) and the roster's 470,
   * which flagged a fully-worked day 'short'. The Roster screen contradicted the Attendance screen.
   */
  it('honours the shift’s normal-hours rounding, so a fully-worked rounded day is not flagged short', async () => {
    const ctx = adminCtx(b);
    // 09:00–17:50 less a 60-minute break = 470 net; rounded DOWN to a 15-minute multiple ⇒ 465 scheduled.
    const roundedShift = (
      await createShift(ctx, {
        companyId: b.companyId,
        name: 'Rounded',
        code: 'RND15',
        startTime: '09:00:00',
        endTime: '17:50:00',
        breakMinutes: 60,
        normalHoursRoundingMinutes: 15,
      })
    ).id;
    await assignShift(ctx, { employmentId: emp2, shiftDate: '2026-07-01', shiftId: roundedShift });
    await checkIn(ctx, { employmentId: emp2, date: '2026-07-01', time: '09:00:00' });
    // Out at 17:45 ⇒ span 525, less the 6h-cliff break 60 ⇒ 465 worked: exactly the rounded schedule.
    await checkOut(ctx, { employmentId: emp2, date: '2026-07-01', time: '17:45:00' });

    const rows = await rosterVariance(ctx, { from: '2026-07-01', to: '2026-07-31', today: TODAY });
    const row = rows.find((r) => r.employmentId === emp2 && r.shiftDate === '2026-07-01');
    expect(row?.workedMinutes).toBe(465);
    expect(row?.expectedMinutes).toBe(465); // the ROUNDED figure — 470 before the fix
    expect(row?.kind).toBe('on_track'); // 'short' before the fix
  });

  it('a shift with no rounding is unchanged — the unrounded net is still the expectation', async () => {
    const ctx = adminCtx(b);
    // The same 09:00–17:50 shift with rounding absent keeps expecting the full 470, so the rounding
    // parameter is a strict no-op for every shift whose column is NULL (all 11 rows on production).
    const plain = (
      await createShift(ctx, {
        companyId: b.companyId,
        name: 'Unrounded',
        code: 'RND0',
        startTime: '09:00:00',
        endTime: '17:50:00',
        breakMinutes: 60,
      })
    ).id;
    await assignShift(ctx, { employmentId: emp2, shiftDate: '2026-07-01', shiftId: plain });
    await checkIn(ctx, { employmentId: emp2, date: '2026-07-01', time: '09:00:00' });
    await checkOut(ctx, { employmentId: emp2, date: '2026-07-01', time: '17:45:00' });

    const rows = await rosterVariance(ctx, { from: '2026-07-01', to: '2026-07-31', today: TODAY });
    const row = rows.find((r) => r.employmentId === emp2 && r.shiftDate === '2026-07-01');
    expect(row?.expectedMinutes).toBe(470);
    expect(row?.kind).toBe('short'); // 465 worked < 470 expected
  });
});
