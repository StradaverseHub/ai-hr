/**
 * ADR-0032 C6 — biometric / terminal punch import. The pure CSV parser reads header-named or positional
 * columns; the reconcile is roster-aware: a rostered night shift (22:00→06:00) pairs the two punches that
 * straddle midnight into ONE row on the shift's start date, while an unrostered employee falls back to
 * calendar-day grouping. Unmatched refs are reported; dry-run writes nothing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { importAttendancePunches } from '../core/attendance';
import { assignShift, createShift } from '../core/roster';
import { parseAttendanceCsv } from '../lib/attendance-csv';

let b: Base;

/** Insert a person + employment with a known employee code + IC so the importer can match against them. */
async function makeEmp(code: string, ic: string) {
  const [p] = await owner.db
    .insert(schema.person)
    .values({ tenantId: b.tenantId, fullName: `W ${code}`, primaryEmail: `w_${randomUUID()}@t.local` })
    .returning({ id: schema.person.id });
  const [e] = await owner.db
    .insert(schema.employment)
    .values({ tenantId: b.tenantId, personId: p.id, companyId: b.companyId, hiredOn: '2020-01-01', employeeCode: code })
    .returning({ id: schema.employment.id });
  await owner.db.insert(schema.employeeStatutoryMy).values({ tenantId: b.tenantId, personId: p.id, icNumber: ic });
  return e.id;
}

async function attendanceRow(employmentId: string, date: string) {
  const [row] = await owner.db
    .select()
    .from(schema.attendance)
    .where(and(eq(schema.attendance.employmentId, employmentId), eq(schema.attendance.attendanceDate, date)));
  return row;
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

describe('punch CSV parser (ADR-0032 C6)', () => {
  it('reads named header columns and zero-pads the time', () => {
    const r = parseAttendanceCsv('Staff ID,Timestamp\nE001,2026-07-01 8:05\nE001,2026-07-01 17:30:00');
    expect(r.errors).toHaveLength(0);
    expect(r.punches).toEqual([
      { employeeRef: 'E001', date: '2026-07-01', time: '08:05:00', row: 2 },
      { employeeRef: 'E001', date: '2026-07-01', time: '17:30:00', row: 3 },
    ]);
  });

  it('falls back to positional columns when there is no recognizable header', () => {
    const r = parseAttendanceCsv('E001,2026-07-01T22:00:00\nE002,2026-07-02T06:00');
    expect(r.punches.map((p) => p.employeeRef)).toEqual(['E001', 'E002']);
    expect(r.punches[1].time).toBe('06:00:00');
  });

  it('reports unparseable rows without dropping the good ones', () => {
    const r = parseAttendanceCsv('staff,time\nE001,2026-07-01 09:00\nE001,not-a-date\nE001,\n');
    expect(r.punches).toHaveLength(1);
    expect(r.errors).toHaveLength(2);
  });
});

describe('punch reconcile (ADR-0032 C6)', () => {
  it('a day-shift pair becomes one row with worked minutes; matches by employee code', async () => {
    const ctx = adminCtx(b);
    const emp = await makeEmp('E100', '900101011234');
    const csv = 'staff,time\nE100,2026-07-01 08:00:00\nE100,2026-07-01 17:00:00';
    const r = await importAttendancePunches(ctx, { csvText: csv, dryRun: false });
    expect(r.imported).toBe(1);
    expect(r.unmatchedRefs).toHaveLength(0);
    const row = await attendanceRow(emp, '2026-07-01');
    expect(row.checkInAt).toBe('08:00:00');
    expect(row.checkOutAt).toBe('17:00:00');
    expect(row.workedMinutes).toBe(480); // 9h span − 60m break
  });

  it('a rostered night shift pairs the cross-midnight punches into one row on the start date', async () => {
    const ctx = adminCtx(b);
    const emp = await makeEmp('N200', '880202022345');
    // Night shift 22:00 → 06:00 (crosses midnight), break 60 ⇒ 480 scheduled.
    const shiftId = (
      await createShift(ctx, { companyId: b.companyId, name: 'Night', code: 'NIGHT', startTime: '22:00:00', endTime: '06:00:00', breakMinutes: 60 })
    ).id;
    expect((await owner.db.select().from(schema.shift).where(eq(schema.shift.id, shiftId)))[0].crossesMidnight).toBe(true);
    await assignShift(ctx, { employmentId: emp, shiftDate: '2026-07-01', shiftId });
    // Punches straddle midnight: clock-in 22:00 on the 1st, clock-out 06:00 on the 2nd.
    const csv = 'staff,time\nN200,2026-07-01 22:00:00\nN200,2026-07-02 06:00:00';
    const r = await importAttendancePunches(ctx, { csvText: csv, dryRun: false });
    expect(r.imported).toBe(1); // ONE business day, not two
    const d1 = await attendanceRow(emp, '2026-07-01');
    expect(d1.checkInAt).toBe('22:00:00');
    expect(d1.checkOutAt).toBe('06:00:00');
    expect(d1.workedMinutes).toBe(420); // 22:00→06:00 = 480m span − 60m break
    expect(await attendanceRow(emp, '2026-07-02')).toBeUndefined();
  });

  it('reports unmatched references and imports nothing for them', async () => {
    const ctx = adminCtx(b);
    await makeEmp('E100', '900101011234');
    const r = await importAttendancePunches(ctx, { csvText: 'staff,time\nGHOST,2026-07-01 08:00:00', dryRun: false });
    expect(r.imported).toBe(0);
    expect(r.unmatchedRefs).toEqual(['GHOST']);
  });

  it('dry-run previews the same rows but writes nothing', async () => {
    const ctx = adminCtx(b);
    const emp = await makeEmp('E100', '900101011234');
    const csv = 'staff,time\nE100,2026-07-01 08:00:00\nE100,2026-07-01 17:00:00';
    const r = await importAttendancePunches(ctx, { csvText: csv, dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.imported).toBe(0);
    expect(r.preview).toHaveLength(1);
    expect(r.preview[0].workedMinutes).toBe(480);
    expect(await attendanceRow(emp, '2026-07-01')).toBeUndefined();
  });
});
