/**
 * ADR-0032 Phase C slice C1 — shift templates + roster assignments. Shift CRUD (crossesMidnight derivation,
 * differential validation, archive), roster upsert/rest-day/clear/bulk, the (employee,date) uniqueness, and
 * the DB shift-xor-rest CHECK. Substrate events on every mutation.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, eventTypesFor, latestEventPayload, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import {
  archiveShift,
  assignRosterRow,
  assignShift,
  assignShiftBulk,
  assertRosterDatesWritable,
  canWriteRosterDate,
  clearRoster,
  createShift,
  listShifts,
  PastRosterDateError,
  rosterForRange,
  setRestDay,
  shiftCrossesMidnight,
} from '../core/roster';

let b: Base;
let employmentId: string;
let employmentId2: string;

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
  employmentId2 = await makeEmployment();
});

describe('shift rosters (ADR-0032 C1, Phase C)', () => {
  it('shiftCrossesMidnight: end ≤ start', () => {
    expect(shiftCrossesMidnight('22:00:00', '06:00:00')).toBe(true);
    expect(shiftCrossesMidnight('08:00:00', '17:00:00')).toBe(false);
    expect(shiftCrossesMidnight('00:00:00', '00:00:00')).toBe(true); // 24h
  });

  it('creates shifts, derives crossesMidnight, lists, archives', async () => {
    const ctx = adminCtx(b);
    const day = await createShift(ctx, { companyId: b.companyId, name: 'Morning', code: 'MORNING', startTime: '08:00:00', endTime: '17:00:00', breakMinutes: 60 });
    await createShift(ctx, { companyId: b.companyId, name: 'Night', code: 'NIGHT', startTime: '22:00:00', endTime: '06:00:00' });
    const rows = await listShifts(ctx, b.companyId);
    expect(rows.map((r) => r.name).sort()).toEqual(['Morning', 'Night']);
    expect(rows.find((r) => r.name === 'Night')!.crossesMidnight).toBe(true);
    expect(rows.find((r) => r.name === 'Morning')!.crossesMidnight).toBe(false);
    expect(await eventTypesFor(b.tenantId, day.id)).toContain('shift.created');

    await archiveShift(ctx, { shiftId: day.id });
    expect((await listShifts(ctx, b.companyId)).map((r) => r.name)).toEqual(['Night']);
    expect(await listShifts(ctx, b.companyId, { includeArchived: true })).toHaveLength(2);
  });

  it('validates the (non-statutory) differential', async () => {
    const ctx = adminCtx(b);
    await expect(
      createShift(ctx, { companyId: b.companyId, name: 'Bad', code: 'BAD', startTime: '22:00:00', endTime: '06:00:00', differential: { kind: 'nope' as never, value: 1 } }),
    ).rejects.toThrow(/differential kind/i);
    await expect(
      createShift(ctx, { companyId: b.companyId, name: 'Bad2', code: 'BAD2', startTime: '22:00:00', endTime: '06:00:00', differential: { kind: 'percent', value: -5 } }),
    ).rejects.toThrow(/non-negative/i);
    const ok = await createShift(ctx, { companyId: b.companyId, name: 'NightPrem', code: 'NIGHTPREM', startTime: '22:00:00', endTime: '06:00:00', differential: { kind: 'percent', value: 15 } });
    const [s] = await owner.db.select().from(schema.shift).where(eq(schema.shift.id, ok.id));
    expect(s.differential).toEqual({ kind: 'percent', value: 15 });
  });

  it('assigns a shift (upsert) + event; re-assign updates the same (employee,date) row', async () => {
    const ctx = adminCtx(b);
    const m = await createShift(ctx, { companyId: b.companyId, name: 'M', code: 'M', startTime: '08:00:00', endTime: '17:00:00' });
    const n = await createShift(ctx, { companyId: b.companyId, name: 'N', code: 'N', startTime: '22:00:00', endTime: '06:00:00' });
    const a1 = await assignShift(ctx, { employmentId, shiftDate: '2026-07-01', shiftId: m.id });
    const a2 = await assignShift(ctx, { employmentId, shiftDate: '2026-07-01', shiftId: n.id });
    expect(a2.id).toBe(a1.id);
    const grid = await rosterForRange(ctx, { employmentIds: [employmentId], from: '2026-07-01', to: '2026-07-31' });
    expect(grid).toHaveLength(1);
    expect(grid[0]).toMatchObject({ shiftId: n.id, isRestDay: false });
    expect(await eventTypesFor(b.tenantId, a1.id)).toContain('roster.shift.assigned');
  });

  it('rest day flips a shift assignment; clear removes it', async () => {
    const ctx = adminCtx(b);
    const m = await createShift(ctx, { companyId: b.companyId, name: 'M', code: 'M', startTime: '08:00:00', endTime: '17:00:00' });
    await assignShift(ctx, { employmentId, shiftDate: '2026-07-02', shiftId: m.id });
    await setRestDay(ctx, { employmentId, shiftDate: '2026-07-02' });
    const [row] = await owner.db
      .select()
      .from(schema.rosterAssignment)
      .where(and(eq(schema.rosterAssignment.employmentId, employmentId), eq(schema.rosterAssignment.shiftDate, '2026-07-02')));
    expect(row.isRestDay).toBe(true);
    expect(row.shiftId).toBeNull();
    await clearRoster(ctx, { employmentId, shiftDate: '2026-07-02' });
    expect(await rosterForRange(ctx, { employmentIds: [employmentId], from: '2026-07-01', to: '2026-07-31' })).toHaveLength(0);
  });

  it('bulk-assigns one shift to many employees across dates (one summary event)', async () => {
    const ctx = adminCtx(b);
    const m = await createShift(ctx, { companyId: b.companyId, name: 'M', code: 'M', startTime: '08:00:00', endTime: '17:00:00' });
    const r = await assignShiftBulk(ctx, { employmentIds: [employmentId, employmentId2], shiftDates: ['2026-07-01', '2026-07-02', '2026-07-03'], shiftId: m.id });
    expect(r.assigned).toBe(6);
    expect(await rosterForRange(ctx, { from: '2026-07-01', to: '2026-07-31' })).toHaveLength(6);
    expect(await eventTypesFor(b.tenantId, m.id)).toContain('roster.bulk.assigned');
  });

  // ── 23390097 · what the Audit Trail must be able to say about a roster change ──────────────────

  it('every per-date event carries the PREVIOUS shift, not just the new one', async () => {
    const ctx = adminCtx(b);
    const m = await createShift(ctx, { companyId: b.companyId, name: 'M', code: 'M', startTime: '08:00:00', endTime: '17:00:00' });
    const n = await createShift(ctx, { companyId: b.companyId, name: 'N', code: 'N', startTime: '22:00:00', endTime: '06:00:00' });

    // First write: nothing was there before, and nulls say so rather than pretending it was a working day.
    const a = await assignShift(ctx, { employmentId, shiftDate: '2026-07-01', shiftId: m.id });
    expect(await latestEventPayload(b.tenantId, a.id, 'roster.shift.assigned')).toMatchObject({
      shiftId: m.id,
      prevShiftId: null,
      prevIsRestDay: null,
    });

    // Re-assign: the before is the shift that was displaced.
    await assignShift(ctx, { employmentId, shiftDate: '2026-07-01', shiftId: n.id });
    expect(await latestEventPayload(b.tenantId, a.id, 'roster.shift.assigned')).toMatchObject({
      shiftId: n.id,
      prevShiftId: m.id,
      prevIsRestDay: false,
    });

    await setRestDay(ctx, { employmentId, shiftDate: '2026-07-01' });
    expect(await latestEventPayload(b.tenantId, a.id, 'roster.rest-day.set')).toMatchObject({
      prevShiftId: n.id,
      prevIsRestDay: false,
    });

    await clearRoster(ctx, { employmentId, shiftDate: '2026-07-01' });
    expect(await latestEventPayload(b.tenantId, a.id, 'roster.cleared')).toMatchObject({
      prevShiftId: null,
      prevIsRestDay: true,
    });
  });

  it('the row editor writes ONE event per date (not a single bulk summary)', async () => {
    const ctx = adminCtx(b);
    const m = await createShift(ctx, { companyId: b.companyId, name: 'M', code: 'M', startTime: '08:00:00', endTime: '17:00:00' });
    const dates = ['2026-07-06', '2026-07-07', '2026-07-08'];
    const r = await assignRosterRow(ctx, { employmentId, shiftDates: dates, brush: m.id });
    expect(r.applied).toBe(3);

    const rows = await rosterForRange(ctx, { employmentIds: [employmentId], from: '2026-07-01', to: '2026-07-31' });
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      // One reversible event per date, each anchored on its OWN assignment row — the property the bulk
      // primitives cannot give, because they write one summary keyed on the shift.
      expect(await eventTypesFor(b.tenantId, row.id)).toEqual(['roster.shift.assigned']);
    }
    expect(await eventTypesFor(b.tenantId, m.id)).not.toContain('roster.bulk.assigned');
  });

  it('a non-admin cannot write a date that is today or earlier; tomorrow onward is fine', async () => {
    const admin = adminCtx(b);
    const supervisor = { ...admin, roles: ['manager'] };
    const TODAY = '2026-08-09';

    expect(canWriteRosterDate(supervisor, '2026-08-08', TODAY)).toBe(false);
    expect(canWriteRosterDate(supervisor, TODAY, TODAY)).toBe(false);
    expect(canWriteRosterDate(supervisor, '2026-08-10', TODAY)).toBe(true);
    // An HR administrator may — the screen confirms first, the service does not refuse.
    expect(canWriteRosterDate(admin, '2026-08-08', TODAY)).toBe(true);

    expect(() => assertRosterDatesWritable(supervisor, ['2026-08-10', '2026-08-08'], TODAY)).toThrow(PastRosterDateError);
    expect(() => assertRosterDatesWritable(supervisor, ['2026-08-10', '2026-08-11'], TODAY)).not.toThrow();
    expect(() => assertRosterDatesWritable(admin, ['2026-08-08'], TODAY)).not.toThrow();
  });

  it('DB CHECK rejects a row that is neither a shift nor a rest day', async () => {
    await expect(
      owner.db.insert(schema.rosterAssignment).values({ tenantId: b.tenantId, employmentId, shiftDate: '2026-07-09', shiftId: null, isRestDay: false }),
    ).rejects.toThrow();
  });
});
